import type { PiWebUiConfigMutationCoordinator } from "../../configMutationCoordinator.js";
import { effectiveSpeechInputSettings, speechInputCloudLanguage } from "../../shared/speechInput.js";
import {
  SPEECH_INPUT_MAX_AUDIO_BYTES,
  parseSpeechInputAudioMimeType,
  type SpeechInputAudioMimeType,
} from "../../shared/speechInputAudio.js";
import { resolvePiCompatibleCredentialSource, type ResolveCredentialOptions } from "./piCompatibleCredentialResolver.js";
import {
  OpenAiCompatibleTranscriptionProvider,
  SpeechInputTranscriptionAbortedError,
  type OpenAiCompatibleTranscriptionRequest,
} from "./openAiCompatibleTranscriptionProvider.js";

export interface SpeechInputTranscriptionRequest {
  audio: Buffer;
  mimeType: SpeechInputAudioMimeType;
  signal: AbortSignal;
}

export interface SpeechInputTranscriptionService {
  transcribe(request: SpeechInputTranscriptionRequest): Promise<string>;
}

export type SpeechInputCredentialResolver = (
  source: string | undefined,
  options: ResolveCredentialOptions,
) => Promise<string>;

export interface SpeechTranscriptionServiceDependencies {
  coordinator: PiWebUiConfigMutationCoordinator;
  provider?: Pick<OpenAiCompatibleTranscriptionProvider, "transcribe">;
  resolveCredential?: SpeechInputCredentialResolver;
  env?: NodeJS.ProcessEnv;
}

/** A malformed direct service call; routes validate this before service work. */
export class SpeechInputAudioValidationError extends Error {
  readonly code = "SPEECH_INPUT_AUDIO_VALIDATION";

  constructor() {
    super("Speech audio is invalid.");
    this.name = "SpeechInputAudioValidationError";
  }
}

/** A missing, unresolved, empty, or failed credential source. */
export class SpeechInputCredentialUnavailableError extends Error {
  readonly code = "SPEECH_INPUT_CREDENTIAL_UNAVAILABLE";

  constructor() {
    super("Speech transcription is unavailable.");
    this.name = "SpeechInputCredentialUnavailableError";
  }
}

export class SpeechTranscriptionService implements SpeechInputTranscriptionService {
  private readonly provider: Pick<OpenAiCompatibleTranscriptionProvider, "transcribe">;
  private readonly resolveCredential: SpeechInputCredentialResolver;

  constructor(private readonly dependencies: SpeechTranscriptionServiceDependencies) {
    this.provider = dependencies.provider ?? new OpenAiCompatibleTranscriptionProvider();
    this.resolveCredential = dependencies.resolveCredential ?? resolvePiCompatibleCredentialSource;
  }

  async transcribe(request: SpeechInputTranscriptionRequest): Promise<string> {
    throwIfAborted(request.signal);

    // `read` opens and closes its own coordinator transaction before resolving.
    // Copy every persisted value needed below before any potentially slow work.
    const snapshot = await raceWithAbort(this.dependencies.coordinator.read(), request.signal);
    const rawSource = snapshot.loaded.config.speechInput?.cloud?.apiKey;
    const effective = effectiveSpeechInputSettings(snapshot.loaded.config.speechInput);
    const captured = {
      source: rawSource,
      baseUrl: effective.cloud.baseUrl,
      model: effective.cloud.model,
      language: speechInputCloudLanguage(effective.language),
    };

    validateAudio(request);
    if (captured.source === undefined || captured.source.trim() === "") {
      throw new SpeechInputCredentialUnavailableError();
    }

    let apiKey: string;
    try {
      apiKey = await raceWithAbort(this.resolveCredential(captured.source, {
        ...(this.dependencies.env === undefined ? {} : { env: this.dependencies.env }),
        signal: request.signal,
      }), request.signal);
    } catch (error) {
      if (error instanceof SpeechInputTranscriptionAbortedError) throw error;
      if (request.signal.aborted) throw new SpeechInputTranscriptionAbortedError();
      throw new SpeechInputCredentialUnavailableError();
    }
    if (apiKey.trim() === "") throw new SpeechInputCredentialUnavailableError();
    throwIfAborted(request.signal);

    const providerRequest: OpenAiCompatibleTranscriptionRequest = {
      audio: request.audio,
      mimeType: request.mimeType,
      baseUrl: captured.baseUrl,
      model: captured.model,
      apiKey,
      ...(captured.language === undefined ? {} : { language: captured.language }),
      signal: request.signal,
    };
    return await raceWithAbort(this.provider.transcribe(providerRequest), request.signal);
  }
}

export function createSpeechTranscriptionService(
  dependencies: SpeechTranscriptionServiceDependencies,
): SpeechInputTranscriptionService {
  return new SpeechTranscriptionService(dependencies);
}

function validateAudio(request: SpeechInputTranscriptionRequest): void {
  if (!Buffer.isBuffer(request.audio)
    || request.audio.byteLength === 0
    || request.audio.byteLength > SPEECH_INPUT_MAX_AUDIO_BYTES
    || parseSpeechInputAudioMimeType(request.mimeType) !== request.mimeType) {
    throw new SpeechInputAudioValidationError();
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new SpeechInputTranscriptionAbortedError();
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new SpeechInputTranscriptionAbortedError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(error instanceof Error ? error : new Error("Speech transcription failed."));
    };
    const onAbort = () => {
      fail(new SpeechInputTranscriptionAbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { settle(resolve, value); },
      (error: unknown) => { fail(error); },
    );
    if (signal.aborted) onAbort();
  });
}
