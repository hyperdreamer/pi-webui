import {
  clampThinkingLevel,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SPEECH_INPUT_MAX_TRANSCRIPT_BYTES } from "../../shared/speechInputAudio.js";
import { SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS } from "../../shared/speechInputPolishing.js";
import type {
  ResolvedUtilityModel,
  UtilityModelResolver,
} from "../sessions/utilityModelResolver.js";

export const SPEECH_INPUT_POLISHING_MAX_OUTPUT_BYTES = SPEECH_INPUT_MAX_TRANSCRIPT_BYTES;
export const SPEECH_INPUT_POLISHING_SYSTEM_PROMPT =
  "Return only polished plain text. Preserve meaning, intent, technical tokens, and explicit requirements. Correct capitalization, punctuation, spacing, and unambiguous disfluencies only. Do not add, delete, or infer requirements. Do not include explanations, markdown, quotation wrappers, labels, or commentary.";

const UNAVAILABLE_MESSAGE = "Speech input polishing is unavailable.";
const ABORTED_MESSAGE = "Speech input polishing was cancelled.";

export interface SpeechInputPolishingServiceDependencies {
  modelRuntime: Pick<ModelRuntime, "completeSimple">;
  utilityModelResolver: UtilityModelResolver<Model<Api>>;
}

export class SpeechInputPolishingError extends Error {
  readonly code: string;

  constructor(code: string, message: string, name: string) {
    super(message);
    this.name = name;
    this.code = code;
  }
}

export class SpeechInputPolishingUnavailableError extends SpeechInputPolishingError {
  constructor() {
    super(
      "SPEECH_INPUT_POLISHING_UNAVAILABLE",
      UNAVAILABLE_MESSAGE,
      "SpeechInputPolishingUnavailableError",
    );
  }
}

export class SpeechInputPolishingAbortedError extends SpeechInputPolishingError {
  constructor() {
    super(
      "SPEECH_INPUT_POLISHING_ABORTED",
      ABORTED_MESSAGE,
      "SpeechInputPolishingAbortedError",
    );
  }
}

export class SpeechInputPolishingService {
  constructor(
    private readonly dependencies: SpeechInputPolishingServiceDependencies,
  ) {}

  async polish(text: string, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);

    let candidates: readonly ResolvedUtilityModel<Model<Api>>[];
    try {
      const candidatePromise = this.dependencies.utilityModelResolver.configuredCandidates("lightweight");
      candidates = signal === undefined
        ? await candidatePromise
        : await raceWithAbort(candidatePromise, signal);
    } catch (error) {
      if (error instanceof SpeechInputPolishingAbortedError || signal?.aborted === true) {
        throw new SpeechInputPolishingAbortedError();
      }
      throw new SpeechInputPolishingUnavailableError();
    }

    throwIfAborted(signal);
    const lightweightCandidates = candidates.filter((candidate) => candidate.slot === "lightweight");
    if (lightweightCandidates.length === 0) {
      throw new SpeechInputPolishingUnavailableError();
    }

    for (const candidate of lightweightCandidates) {
      throwIfAborted(signal);
      try {
        const context: Context = {
          systemPrompt: SPEECH_INPUT_POLISHING_SYSTEM_PROMPT,
          messages: [{ role: "user", content: text, timestamp: Date.now() }],
        };
        const polishingThinkingLevel = clampThinkingLevel(candidate.model, "off");
        const options: ModelsSimpleStreamOptions = {
          ...(polishingThinkingLevel === "off" ? {} : { reasoning: polishingThinkingLevel }),
          maxRetries: 0,
          cacheRetention: "none",
          timeoutMs: SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS,
          ...(signal === undefined ? {} : { signal }),
        };
        const completion = this.dependencies.modelRuntime.completeSimple(
          candidate.model,
          context,
          options,
        );
        const message = signal === undefined
          ? await completion
          : await raceWithAbort(completion, signal);
        throwIfAborted(signal);
        const polished = extractPolishedText(message);
        if (polished !== undefined) {
          throwIfAborted(signal);
          return polished;
        }
      } catch (error) {
        if (error instanceof SpeechInputPolishingAbortedError || signal?.aborted === true) {
          throw new SpeechInputPolishingAbortedError();
        }
        // Candidate and provider details stay inside the daemon runtime. The
        // route receives one stable, credential-blind failure after fallback.
      }
    }

    throwIfAborted(signal);
    throw new SpeechInputPolishingUnavailableError();
  }
}

export function createSpeechInputPolishingService(
  dependencies: SpeechInputPolishingServiceDependencies,
): SpeechInputPolishingService {
  return new SpeechInputPolishingService(dependencies);
}

function extractPolishedText(message: AssistantMessage): string | undefined {
  if (message.stopReason !== "stop") return undefined;

  let hasText = false;
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") {
      if (typeof block.text !== "string") return undefined;
      hasText = true;
      text += block.text;
      continue;
    }
    if (block.type === "thinking") continue;
    return undefined;
  }

  if (!hasText || text.trim() === "") return undefined;
  if (Buffer.byteLength(text, "utf8") > SPEECH_INPUT_POLISHING_MAX_OUTPUT_BYTES) {
    return undefined;
  }
  return text;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new SpeechInputPolishingAbortedError();
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (callback: (value: T) => void, value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        error instanceof SpeechInputPolishingAbortedError
          ? error
          : new Error("Speech input polishing failed."),
      );
    };
    const onAbort = (): void => {
      fail(new SpeechInputPolishingAbortedError());
    };

    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { settle(resolve, value); },
      (error: unknown) => { fail(error); },
    );
    if (signal.aborted) onAbort();
  });
}
