import type { SpeechInputAvailability, SpeechInputProviderId } from "./speechInputCore";
import type {
  SpeechInputProviderAdapter,
  SpeechInputProviderCallbacks,
  SpeechInputProviderError,
  SpeechInputProviderRun,
} from "./speechInputProvider";

/**
 * Project-owned structural types for the Web Speech recognition API. The
 * adapter never references experimental DOM typings, so it compiles even
 * when the TypeScript DOM library does not declare SpeechRecognition.
 */

export interface BrowserRecognitionResultItem {
  readonly transcript: string;
}

export interface BrowserRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: BrowserRecognitionResultItem;
}

export interface BrowserRecognitionResultsList {
  readonly length: number;
  readonly [index: number]: BrowserRecognitionResult;
}

export interface BrowserRecognitionEvent {
  readonly results: BrowserRecognitionResultsList;
}

export interface BrowserRecognitionErrorEvent {
  readonly error: string;
}

export interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onresult: ((event: BrowserRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: BrowserRecognitionErrorEvent) => void) | null;
}

export type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

/** Schedules a one-shot deadline callback and returns its canceler. */
export type SpeechDeadlineScheduler = (callback: () => void, delayMs: number) => () => void;

/** A Stop request waits this long for the recognition `end` event before settling the run itself. */
export const SPEECH_RECOGNITION_STOP_SETTLEMENT_MS = 2000;

export interface SpeechRecognitionAdapterDependencies {
  /** Whether the page is a secure context; injected so tests need no DOM. */
  isSecureContext: boolean;
  /** Locates the standard or prefixed recognition constructor; defaults to the globalThis lookup. */
  recognitionConstructorLookup?: () => BrowserSpeechRecognitionConstructor | undefined;
  /** Schedules the stop-settlement watchdog; defaults to real setTimeout. */
  scheduleDeadline?: SpeechDeadlineScheduler;
}

const INSECURE_CONTEXT_REASON = "Speech input requires a secure browser context";
const MISSING_CONSTRUCTOR_REASON = "Speech recognition is not supported in this browser";
const PERMISSION_DENIED_ERROR: SpeechInputProviderError = {
  code: "permission-denied",
  message: "Microphone permission denied",
};
const NO_SPEECH_ERROR: SpeechInputProviderError = { code: "no-speech", message: "No speech detected" };
const MICROPHONE_UNAVAILABLE_ERROR: SpeechInputProviderError = {
  code: "microphone-unavailable",
  message: "Microphone is unavailable",
};
const NETWORK_ERROR: SpeechInputProviderError = {
  code: "network",
  message: "Speech recognition network error",
};
const UNSUPPORTED_LANGUAGE_ERROR: SpeechInputProviderError = {
  code: "unsupported",
  message: "The selected language is not supported",
};
const PROVIDER_ERROR: SpeechInputProviderError = { code: "provider", message: "Speech recognition failed" };

function isRecognitionConstructor(value: unknown): value is BrowserSpeechRecognitionConstructor {
  return typeof value === "function";
}

/** Prefers the standard constructor and accepts the webkit-prefixed one. */
function defaultRecognitionConstructorLookup(): BrowserSpeechRecognitionConstructor | undefined {
  const standard: unknown = Reflect.get(globalThis, "SpeechRecognition");
  if (isRecognitionConstructor(standard)) return standard;
  const prefixed: unknown = Reflect.get(globalThis, "webkitSpeechRecognition");
  if (isRecognitionConstructor(prefixed)) return prefixed;
  return undefined;
}

function defaultScheduleDeadline(callback: () => void, delayMs: number): () => void {
  const timer = globalThis.setTimeout(callback, delayMs);
  return () => {
    globalThis.clearTimeout(timer);
  };
}

/** Normalizes vendor error codes to stable, safe user-facing failures. */
function normalizeRecognitionError(code: string): SpeechInputProviderError {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return PERMISSION_DENIED_ERROR;
    case "no-speech":
    case "no-match":
      return NO_SPEECH_ERROR;
    case "network":
      return NETWORK_ERROR;
    case "audio-capture":
      return MICROPHONE_UNAVAILABLE_ERROR;
    case "language-not-supported":
      return UNSUPPORTED_LANGUAGE_ERROR;
    default:
      return PROVIDER_ERROR;
  }
}

/** Returned when start fails synchronously; nothing left to stop or cancel. */
const SILENT_RUN: SpeechInputProviderRun = {
  stop: () => undefined,
  cancel: () => undefined,
};

/** All mutable state belongs to one run; a fresh object is created per start(). */
interface RecognitionRunState {
  recognition: BrowserSpeechRecognition;
  callbacks: SpeechInputProviderCallbacks;
  /** Finalized result segments concatenated in recognition order. */
  finalText: string;
  /** First not-yet-visited index in each event's accumulated results list. */
  resultIndex: number;
  /** Last interim aggregate handed to onInterim, used to detect changes. */
  publishedInterim: string;
  /** True once the run settled; every late event is then suppressed. */
  terminal: boolean;
  /** True while a Stop request waits for its settlement end event. */
  stopping: boolean;
  /** Canceler for the armed stop-settlement watchdog, if any. */
  deadlineCancel: (() => void) | undefined;
}

export class SpeechRecognitionAdapter implements SpeechInputProviderAdapter {
  readonly id: SpeechInputProviderId = "browser";

  private readonly isSecureContext: boolean;
  private readonly lookupConstructor: () => BrowserSpeechRecognitionConstructor | undefined;
  private readonly scheduleDeadline: SpeechDeadlineScheduler;

  constructor(deps: SpeechRecognitionAdapterDependencies) {
    this.isSecureContext = deps.isSecureContext;
    this.lookupConstructor = deps.recognitionConstructorLookup ?? defaultRecognitionConstructorLookup;
    this.scheduleDeadline = deps.scheduleDeadline ?? defaultScheduleDeadline;
  }

  availability(): SpeechInputAvailability {
    if (!this.isSecureContext) return { available: false, reason: INSECURE_CONTEXT_REASON };
    let Constructor: BrowserSpeechRecognitionConstructor | undefined;
    try {
      Constructor = this.lookupConstructor();
    } catch {
      Constructor = undefined;
    }
    return Constructor === undefined
      ? { available: false, reason: MISSING_CONSTRUCTOR_REASON }
      : { available: true };
  }

  start(input: { language?: string; callbacks: SpeechInputProviderCallbacks }): SpeechInputProviderRun {
    const callbacks = input.callbacks;

    let Constructor: BrowserSpeechRecognitionConstructor | undefined;
    try {
      Constructor = this.lookupConstructor();
    } catch {
      Constructor = undefined;
    }
    if (Constructor === undefined) {
      callbacks.onError({ code: "unsupported", message: MISSING_CONSTRUCTOR_REASON });
      return SILENT_RUN;
    }

    let recognition: BrowserSpeechRecognition;
    try {
      recognition = new Constructor();
    } catch {
      callbacks.onError({ code: "unsupported", message: MISSING_CONSTRUCTOR_REASON });
      return SILENT_RUN;
    }

    const state: RecognitionRunState = {
      recognition,
      callbacks,
      finalText: "",
      resultIndex: 0,
      publishedInterim: "",
      terminal: false,
      stopping: false,
      deadlineCancel: undefined,
    };

    const clearWatchdog = (): void => {
      state.deadlineCancel?.();
      state.deadlineCancel = undefined;
    };

    const settleError = (error: SpeechInputProviderError): void => {
      if (state.terminal) return;
      state.terminal = true;
      clearWatchdog();
      callbacks.onError(error);
    };

    const emitSettledOutcome = (): void => {
      const text = state.finalText.trim();
      if (text === "") {
        callbacks.onError(NO_SPEECH_ERROR);
      } else {
        callbacks.onComplete(text);
      }
    };

    const settleFromEnd = (): void => {
      if (state.terminal) return;
      state.terminal = true;
      clearWatchdog();
      emitSettledOutcome();
    };

    recognition.onstart = () => {
      if (!state.terminal) callbacks.onListening();
    };

    recognition.onresult = (event) => {
      if (state.terminal) return;
      const results = event.results;
      let interim = "";
      for (let i = state.resultIndex; i < results.length; i++) {
        const result = results[i];
        if (result === undefined) continue;
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          state.finalText += transcript;
          state.resultIndex = i + 1;
        } else {
          interim += transcript;
        }
      }
      // Publish the latest nonfinal aggregate whenever it changes, including
      // the empty string: when a provisional segment becomes final or is
      // retracted, consumers must clear their stale interim display.
      // Finalized segments never flow through the interim channel.
      if (interim !== state.publishedInterim) {
        state.publishedInterim = interim;
        callbacks.onInterim(interim);
      }
    };

    recognition.onend = () => {
      settleFromEnd();
    };

    recognition.onerror = (event) => {
      settleError(normalizeRecognitionError(event.error));
    };

    recognition.continuous = true;
    recognition.interimResults = true;
    if (input.language !== undefined && input.language !== "") recognition.lang = input.language;

    try {
      recognition.start();
    } catch {
      settleError(MICROPHONE_UNAVAILABLE_ERROR);
    }

    return {
      stop: () => {
        if (state.terminal || state.stopping) return;
        state.stopping = true;
        // A recognition instance may never emit `end` after stop(), so one
        // settlement watchdog finishes the run if the event does not arrive.
        // It is armed before stop() so a synchronously dispatched end also
        // releases it through the normal settlement path.
        state.deadlineCancel = this.scheduleDeadline(() => {
          state.deadlineCancel?.();
          state.deadlineCancel = undefined;
          if (state.terminal) return;
          // Settle before the best-effort abort so its late events are suppressed.
          state.terminal = true;
          try {
            state.recognition.abort();
          } catch {
            // The run settles regardless of abort behavior.
          }
          emitSettledOutcome();
        }, SPEECH_RECOGNITION_STOP_SETTLEMENT_MS);
        try {
          state.recognition.stop();
        } catch {
          settleError(MICROPHONE_UNAVAILABLE_ERROR);
        }
      },
      cancel: () => {
        if (state.terminal) return;
        // Cancellation settles before the best-effort abort and stays silent.
        state.terminal = true;
        clearWatchdog();
        try {
          state.recognition.abort();
        } catch {
          // Cancellation is silent: an abort failure is never surfaced.
        }
      },
    };
  }
}
