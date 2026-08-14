import {
  SPEECH_INPUT_MAX_TRANSCRIPT_BYTES,
  SPEECH_INPUT_PROVIDER_TIMEOUT_MS,
  speechInputAudioFilename,
  type SpeechInputAudioMimeType,
} from "../../shared/speechInputAudio.js";
import { speechInputTranscriptionEndpoint } from "../../shared/speechInput.js";

export interface OpenAiCompatibleTranscriptionRequest {
  audio: Buffer;
  mimeType: SpeechInputAudioMimeType;
  baseUrl: string;
  model: string;
  apiKey: string;
  language?: string;
  signal: AbortSignal;
}

export interface SpeechInputResponseReader {
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel(): Promise<void>;
  releaseLock(): void;
}

export interface SpeechInputResponseBody {
  getReader(): SpeechInputResponseReader;
  cancel(): Promise<void>;
}

export interface SpeechInputFetchResponse {
  readonly status: number;
  readonly body: SpeechInputResponseBody | null;
}

export type SpeechInputFetch = (input: string | URL | Request, init?: RequestInit) => Promise<SpeechInputFetchResponse>;
export type SpeechInputDeadlineScheduler = (callback: () => void, delayMs: number) => () => void;

export interface OpenAiCompatibleTranscriptionProviderDependencies {
  fetch?: SpeechInputFetch;
  now?: () => number;
  scheduleDeadline?: SpeechInputDeadlineScheduler;
}

/** Stable provider failure; its message intentionally never includes upstream data. */
export class SpeechInputProviderError extends Error {
  readonly code = "SPEECH_INPUT_PROVIDER";

  constructor() {
    super("Speech transcription provider request failed.");
    this.name = "SpeechInputProviderError";
  }
}

/** The provider's one shared headers-and-body deadline expired. */
export class SpeechInputProviderTimeoutError extends Error {
  readonly code = "SPEECH_INPUT_PROVIDER_TIMEOUT";

  constructor() {
    super("Speech transcription provider timed out.");
    this.name = "SpeechInputProviderTimeoutError";
  }
}

/** Request ownership ended before transcription could produce a result. */
export class SpeechInputTranscriptionAbortedError extends Error {
  readonly code = "SPEECH_INPUT_TRANSCRIPTION_ABORTED";

  constructor() {
    super("Speech transcription was cancelled.");
    this.name = "SpeechInputTranscriptionAbortedError";
  }
}

interface ActiveReader {
  reader: SpeechInputResponseReader;
  cancelled: boolean;
  released: boolean;
}

type TerminalError = SpeechInputProviderTimeoutError | SpeechInputTranscriptionAbortedError;

interface TerminalState {
  promise: Promise<never>;
  currentError(): TerminalError | undefined;
  terminate(error: TerminalError): boolean;
}

const providerFailure = (): SpeechInputProviderError => new SpeechInputProviderError();

/**
 * OpenAI-compatible multipart transcription adapter. The explicit terminal
 * race keeps callers responsive even when a Fetch or stream implementation
 * observes its AbortSignal late (or not at all).
 */
export class OpenAiCompatibleTranscriptionProvider {
  private readonly fetch: SpeechInputFetch;
  private readonly now: () => number;
  private readonly scheduleDeadline: SpeechInputDeadlineScheduler;

  constructor(dependencies: OpenAiCompatibleTranscriptionProviderDependencies = {}) {
    this.fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = dependencies.now ?? (() => performance.now());
    this.scheduleDeadline = dependencies.scheduleDeadline ?? defaultScheduleDeadline;
  }

  async transcribe(request: OpenAiCompatibleTranscriptionRequest): Promise<string> {
    if (isAborted(request.signal)) throw new SpeechInputTranscriptionAbortedError();

    const controller = new AbortController();
    const terminal = createTerminalState();
    const cancelledResponseBodies = new WeakSet<SpeechInputResponseBody>();
    let reader: ActiveReader | undefined;
    let cancelDeadline: (() => void) | undefined;
    let callerAbortListener: (() => void) | undefined;

    const abortActiveReader = () => {
      if (reader === undefined) return;
      cancelReader(reader);
      releaseReader(reader);
    };
    const cancelResponse = (response: SpeechInputFetchResponse) => {
      cancelResponseBody(response, cancelledResponseBodies);
    };
    const terminate = (error: TerminalError) => {
      if (!terminal.terminate(error)) return;
      try {
        controller.abort();
      } catch {
        // Aborting only accelerates collaborator cleanup; terminal ownership is
        // already decided by the explicit rejection race below.
      }
      abortActiveReader();
    };

    try {
      const startedAt = this.now();
      const deadlineAt = startedAt + SPEECH_INPUT_PROVIDER_TIMEOUT_MS;
      cancelDeadline = this.scheduleDeadline(() => {
        terminate(new SpeechInputProviderTimeoutError());
      }, Math.max(0, deadlineAt - this.now()));
      callerAbortListener = () => {
        terminate(new SpeechInputTranscriptionAbortedError());
      };
      request.signal.addEventListener("abort", callerAbortListener, { once: true });
      if (isAborted(request.signal)) {
        terminate(new SpeechInputTranscriptionAbortedError());
        throw new SpeechInputTranscriptionAbortedError();
      }

      let endpoint: string;
      try {
        endpoint = speechInputTranscriptionEndpoint(request.baseUrl);
      } catch {
        throw providerFailure();
      }
      const form = new FormData();
      const audio = new Blob([copyBytesToArrayBuffer(request.audio)], { type: request.mimeType });
      form.append("file", audio, speechInputAudioFilename(request.mimeType));
      form.append("model", request.model);
      if (request.language !== undefined) form.append("language", request.language);

      // This continuation is intentionally attached before awaiting the fetch:
      // a late abort-ignoring response must not retain its body indefinitely.
      const fetchPromise = Promise.resolve().then(async () => {
        const terminalError = terminal.currentError();
        if (terminalError !== undefined) throw terminalError;
        if (isAborted(request.signal)) throw new SpeechInputTranscriptionAbortedError();
        return await this.fetch(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${request.apiKey}` },
          body: form,
          redirect: "manual",
          signal: controller.signal,
        });
      });
      void fetchPromise.then(
        (response) => {
          if (terminal.currentError() !== undefined) cancelResponse(response);
        },
        () => undefined,
      );

      let response: SpeechInputFetchResponse;
      try {
        response = await raceWithTerminal(fetchPromise, terminal);
      } catch (error) {
        throw normalizeTerminalOrProviderError(error, terminal, request.signal);
      }
      const afterFetchTerminalError = terminal.currentError();
      if (afterFetchTerminalError !== undefined) {
        cancelResponse(response);
        throw afterFetchTerminalError;
      }
      if (isAborted(request.signal)) {
        cancelResponse(response);
        throw new SpeechInputTranscriptionAbortedError();
      }

      if (response.status < 200 || response.status >= 300) {
        cancelResponse(response);
        throw providerFailure();
      }
      const body = response.body;
      if (body === null) throw providerFailure();

      let streamReader: SpeechInputResponseReader;
      try {
        streamReader = body.getReader();
      } catch {
        cancelResponse(response);
        throw providerFailure();
      }
      const activeReader: ActiveReader = { reader: streamReader, cancelled: false, released: false };
      reader = activeReader;
      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      try {
        for (;;) {
          const beforeReadTerminalError = terminal.currentError();
          if (beforeReadTerminalError !== undefined) throw beforeReadTerminalError;
          if (isAborted(request.signal)) throw new SpeechInputTranscriptionAbortedError();
          let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>>;
          try {
            pendingRead = streamReader.read();
          } catch {
            throw providerFailure();
          }
          // When terminal ownership wins the race, this continuation handles a
          // later ignored-abort read without letting it retain a reader lock.
          void pendingRead.then(
            () => {
              if (terminal.currentError() !== undefined || isAborted(request.signal)) {
                abortActiveReader();
              }
            },
            () => {
              if (terminal.currentError() !== undefined || isAborted(request.signal)) {
                abortActiveReader();
              }
            },
          );
          let result: ReadableStreamReadResult<Uint8Array>;
          try {
            result = await raceWithTerminal(pendingRead, terminal);
          } catch (error) {
            throw normalizeTerminalOrProviderError(error, terminal, request.signal);
          }
          const afterReadTerminalError = terminal.currentError();
          if (afterReadTerminalError !== undefined) throw afterReadTerminalError;
          if (isAborted(request.signal)) throw new SpeechInputTranscriptionAbortedError();
          if (result.done) break;
          const chunk = result.value;
          byteLength += chunk.byteLength;
          if (byteLength > SPEECH_INPUT_MAX_TRANSCRIPT_BYTES) {
            cancelReader(activeReader);
            throw providerFailure();
          }
          chunks.push(chunk);
        }
      } finally {
        releaseReader(activeReader);
      }

      const beforeResultTerminalError = terminal.currentError();
      if (beforeResultTerminalError !== undefined) throw beforeResultTerminalError;
      if (isAborted(request.signal)) throw new SpeechInputTranscriptionAbortedError();
      return parseTranscript(Buffer.concat(chunks, byteLength));
    } catch (error) {
      if (error instanceof SpeechInputProviderError
        || error instanceof SpeechInputProviderTimeoutError
        || error instanceof SpeechInputTranscriptionAbortedError) {
        throw error;
      }
      const terminalError = terminal.currentError();
      if (terminalError !== undefined) throw terminalError;
      if (isAborted(request.signal)) throw new SpeechInputTranscriptionAbortedError();
      throw providerFailure();
    } finally {
      if (reader !== undefined && (terminal.currentError() !== undefined || isAborted(request.signal))) {
        cancelReader(reader);
      }
      if (reader !== undefined) releaseReader(reader);
      try {
        cancelDeadline?.();
      } catch {
        // Timer cleanup cannot change a settled transcription outcome.
      }
      if (callerAbortListener !== undefined) request.signal.removeEventListener("abort", callerAbortListener);
    }
  }
}

function createTerminalState(): TerminalState {
  let error: TerminalError | undefined;
  let rejectPromise!: (error: TerminalError) => void;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectPromise = reject;
  });
  // A stale injected scheduler may invoke its callback after the operation has
  // already completed. Keep that terminal signal observed in that case while
  // preserving its rejection for the active Promise.race.
  void promise.catch(() => undefined);
  return {
    promise,
    currentError: () => error,
    terminate: (nextError) => {
      if (error !== undefined) return false;
      error = nextError;
      rejectPromise(nextError);
      return true;
    },
  };
}

async function raceWithTerminal<T>(promise: Promise<T>, terminal: TerminalState): Promise<T> {
  try {
    return await Promise.race([promise, terminal.promise]);
  } catch (error) {
    const terminalError = terminal.currentError();
    if (terminalError !== undefined) throw terminalError;
    throw error;
  }
}

function normalizeTerminalOrProviderError(
  error: unknown,
  terminal: TerminalState,
  signal: AbortSignal,
): SpeechInputProviderError | SpeechInputProviderTimeoutError | SpeechInputTranscriptionAbortedError {
  const terminalError = terminal.currentError();
  if (terminalError !== undefined) return terminalError;
  if (isAborted(signal)) return new SpeechInputTranscriptionAbortedError();
  if (error instanceof SpeechInputProviderError
    || error instanceof SpeechInputProviderTimeoutError
    || error instanceof SpeechInputTranscriptionAbortedError) {
    return error;
  }
  return providerFailure();
}

function parseTranscript(bytes: Buffer): string {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw providerFailure();
  }
  if (!isRecord(value)) throw providerFailure();
  const text = value["text"];
  if (typeof text !== "string") throw providerFailure();
  const normalized = text.trim();
  if (normalized === "" || Buffer.byteLength(normalized, "utf8") > SPEECH_INPUT_MAX_TRANSCRIPT_BYTES) {
    throw providerFailure();
  }
  return normalized;
}

function cancelResponseBody(
  response: SpeechInputFetchResponse,
  cancelledResponseBodies: WeakSet<SpeechInputResponseBody>,
): void {
  const body = response.body;
  if (body === null) return;
  if (cancelledResponseBodies.has(body)) return;
  cancelledResponseBodies.add(body);
  try {
    void body.cancel().catch(() => undefined);
  } catch {
    // A response body can already be locked or canceled; terminal cleanup is
    // still complete from this operation's perspective.
  }
}

function cancelReader(active: ActiveReader): void {
  if (active.cancelled) return;
  active.cancelled = true;
  try {
    void active.reader.cancel().catch(() => undefined);
  } catch {
    // Reader cancellation is best effort after terminal ownership is chosen.
  }
}

function releaseReader(active: ActiveReader): void {
  if (active.released) return;
  try {
    active.reader.releaseLock();
    active.released = true;
  } catch {
    // A pending read can temporarily retain the lock. Its late continuation
    // retries this function once the read settles.
  }
}

function copyBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function defaultScheduleDeadline(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => { clearTimeout(timer); };
}
