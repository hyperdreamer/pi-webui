import type { SpeechInputAvailability, SpeechInputProviderId } from "./speechInputCore";

/**
 * Callbacks a provider adapter reports one run's progress through. Every
 * started run settles through exactly one terminal callback — `onComplete`,
 * `onError`, or a silent `cancel()` — and no callback fires after that.
 */
export interface SpeechInputProviderCallbacks {
  /** The provider has started listening/recording successfully. */
  onListening(): void;
  /** A provisional nonfinal transcript replaced the previous interim text. */
  onInterim(text: string): void;
  /** The provider entered an upload/processing phase; Browser never reports it. */
  onTranscribing(): void;
  /** The run produced a nonempty final transcript. */
  onComplete(text: string): void;
  /** The run failed with a normalized, user-presentable error. */
  onError(error: SpeechInputProviderError): void;
}

export interface SpeechInputProviderError {
  code:
    | "permission-denied"
    | "no-speech"
    | "microphone-unavailable"
    | "unsupported"
    | "recording-limit"
    | "network"
    | "provider";
  message: string;
}

/**
 * Handle for one active provider run. `stop()` finalizes usable speech and
 * may later produce a transcript; `cancel()` discards the run and must never
 * commit a transcript or emit an error.
 */
export interface SpeechInputProviderRun {
  stop(): void;
  cancel(): void;
}

export interface SpeechInputProviderAdapter {
  readonly id: SpeechInputProviderId;
  availability(): SpeechInputAvailability;
  start(input: { language?: string; callbacks: SpeechInputProviderCallbacks }): SpeechInputProviderRun;
}
