import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SPEECH_RECOGNITION_STOP_SETTLEMENT_MS,
  SpeechRecognitionAdapter,
  type BrowserRecognitionResult,
  type BrowserRecognitionResultsList,
  type BrowserSpeechRecognition,
  type BrowserSpeechRecognitionConstructor,
  type SpeechDeadlineScheduler,
} from "./speechRecognitionAdapter";
import type {
  SpeechInputProviderCallbacks,
  SpeechInputProviderError,
  SpeechInputProviderRun,
} from "./speechInputProvider";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A controllable recognition instance exposing event emission and spies. */
class FakeRecognition implements BrowserSpeechRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  onstart: (() => void) | null = null;
  onresult: ((event: { results: BrowserRecognitionResultsList }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();

  emitStart(): void {
    this.onstart?.();
  }

  emitResult(segments: { transcript: string; isFinal: boolean }[]): void {
    this.onresult?.({ results: fakeResults(segments) });
  }

  emitEnd(): void {
    this.onend?.();
  }

  emitError(error: string): void {
    this.onerror?.({ error });
  }
}

function fakeResults(segments: { transcript: string; isFinal: boolean }[]): BrowserRecognitionResultsList {
  const byIndex: Record<number, BrowserRecognitionResult> = {};
  for (const [index, segment] of segments.entries()) {
    byIndex[index] = { isFinal: segment.isFinal, length: 1, 0: { transcript: segment.transcript } };
  }
  return { length: segments.length, ...byIndex };
}

function fakeConstructor(
  constructorThrows?: boolean,
  startImpl?: () => void,
): {
  Constructor: BrowserSpeechRecognitionConstructor;
  instances: FakeRecognition[];
} {
  const instances: FakeRecognition[] = [];
  class TrackedRecognition extends FakeRecognition {
    constructor() {
      super();
      if (constructorThrows === true) throw new Error("constructor failed");
      instances.push(this);
      if (startImpl !== undefined) this.start = vi.fn(startImpl);
    }
  }
  return { Constructor: TrackedRecognition, instances };
}

/** Fires scheduled deadlines manually so tests never sleep or use real timers. */
class FakeDeadlineScheduler {
  scheduled: { callback: () => void; delayMs: number } | undefined;

  readonly schedule: SpeechDeadlineScheduler = (callback, delayMs) => {
    this.scheduled = { callback, delayMs };
    return () => {
      if (this.scheduled?.callback === callback) {
        this.scheduled = undefined;
      }
    };
  };

  fire(): void {
    const entry = this.scheduled;
    this.scheduled = undefined;
    entry?.callback();
  }
}

interface CallbackLog {
  listening: number;
  interim: string[];
  transcribing: number;
  completed: string[];
  errors: SpeechInputProviderError[];
}

function recordCallbacks(): { callbacks: SpeechInputProviderCallbacks; log: CallbackLog } {
  const log: CallbackLog = { listening: 0, interim: [], transcribing: 0, completed: [], errors: [] };
  const callbacks: SpeechInputProviderCallbacks = {
    onListening: () => {
      log.listening += 1;
    },
    onInterim: (text) => {
      log.interim.push(text);
    },
    onTranscribing: () => {
      log.transcribing += 1;
    },
    onComplete: (text) => {
      log.completed.push(text);
    },
    onError: (error) => {
      log.errors.push(error);
    },
  };
  return { callbacks, log };
}

interface Harness {
  adapter: SpeechRecognitionAdapter;
  instances: FakeRecognition[];
  scheduler: FakeDeadlineScheduler;
}

function createHarness(
  options: {
    isSecureContext?: boolean;
    lookup?: () => BrowserSpeechRecognitionConstructor | undefined;
    constructorThrows?: boolean;
    startImpl?: () => void;
  } = {},
): Harness {
  const { Constructor, instances } = fakeConstructor(options.constructorThrows, options.startImpl);
  const scheduler = new FakeDeadlineScheduler();
  const adapter = new SpeechRecognitionAdapter({
    isSecureContext: options.isSecureContext ?? true,
    recognitionConstructorLookup: options.lookup ?? (() => Constructor),
    scheduleDeadline: scheduler.schedule,
  });
  return { adapter, instances, scheduler };
}

function startRun(harness: Harness): { run: SpeechInputProviderRun; log: CallbackLog } {
  const { callbacks, log } = recordCallbacks();
  const run = harness.adapter.start({ callbacks });
  return { run, log };
}

function singleInstance(harness: Harness): FakeRecognition {
  const instance = harness.instances[0];
  if (instance === undefined) throw new Error("expected at least one recognition instance");
  return instance;
}

describe("SpeechRecognitionAdapter availability", () => {
  it("reports the secure-context reason in an insecure context even with a constructor", () => {
    const harness = createHarness({ isSecureContext: false });
    expect(harness.adapter.availability()).toEqual({
      available: false,
      reason: "Speech input requires a secure browser context",
    });
  });

  it("reports the missing-constructor reason when no standard or prefixed constructor exists", () => {
    const adapter = new SpeechRecognitionAdapter({ isSecureContext: true });
    expect(adapter.availability()).toEqual({
      available: false,
      reason: "Speech recognition is not supported in this browser",
    });
  });

  it("treats a throwing constructor lookup as unavailable", () => {
    const adapter = new SpeechRecognitionAdapter({
      isSecureContext: true,
      recognitionConstructorLookup: () => {
        throw new Error("lookup failed");
      },
    });
    expect(adapter.availability()).toEqual({
      available: false,
      reason: "Speech recognition is not supported in this browser",
    });
  });

  it("is available in a secure context with a constructor", () => {
    const harness = createHarness();
    expect(harness.adapter.availability()).toEqual({ available: true });
  });
});

describe("constructor selection", () => {
  it("prefers the standard constructor over the prefixed constructor", () => {
    const standard = fakeConstructor();
    const prefixed = fakeConstructor();
    vi.stubGlobal("SpeechRecognition", standard.Constructor);
    vi.stubGlobal("webkitSpeechRecognition", prefixed.Constructor);
    const adapter = new SpeechRecognitionAdapter({ isSecureContext: true });
    expect(adapter.availability()).toEqual({ available: true });
    const { callbacks } = recordCallbacks();
    adapter.start({ callbacks });
    expect(standard.instances).toHaveLength(1);
    expect(prefixed.instances).toHaveLength(0);
  });

  it("accepts the prefixed constructor when the standard one is missing", () => {
    const prefixed = fakeConstructor();
    vi.stubGlobal("webkitSpeechRecognition", prefixed.Constructor);
    const adapter = new SpeechRecognitionAdapter({ isSecureContext: true });
    expect(adapter.availability()).toEqual({ available: true });
    const { callbacks } = recordCallbacks();
    adapter.start({ callbacks });
    expect(prefixed.instances).toHaveLength(1);
  });
});

describe("start", () => {
  it("creates a fresh recognition instance for every run", () => {
    const harness = createHarness();
    startRun(harness);
    startRun(harness);
    expect(harness.instances).toHaveLength(2);
    expect(harness.instances[0]).not.toBe(harness.instances[1]);
  });

  it("enables continuous interim recognition and omits the language for Auto", () => {
    const harness = createHarness();
    startRun(harness);
    const instance = singleInstance(harness);
    expect(instance.continuous).toBe(true);
    expect(instance.interimResults).toBe(true);
    expect(instance.lang).toBe("");
  });

  it("applies an explicit language to the recognition instance", () => {
    const harness = createHarness();
    const { callbacks } = recordCallbacks();
    harness.adapter.start({ language: "en-US", callbacks });
    const instance = singleInstance(harness);
    expect(instance.lang).toBe("en-US");
  });

  it("emits Listening when recognition starts", () => {
    const harness = createHarness();
    const { log } = startRun(harness);
    singleInstance(harness).emitStart();
    expect(log.listening).toBe(1);
  });

  it("suppresses a late start event after settlement", () => {
    const harness = createHarness();
    const { log } = startRun(harness);
    const instance = singleInstance(harness);
    instance.emitEnd();
    instance.emitStart();
    expect(log.listening).toBe(0);
  });

  it("reports unsupported without throwing when no constructor exists at start", () => {
    const harness = createHarness({ lookup: () => undefined });
    const { callbacks, log } = recordCallbacks();
    expect(() => {
      harness.adapter.start({ callbacks });
    }).not.toThrow();
    expect(log.errors).toEqual([
      { code: "unsupported", message: "Speech recognition is not supported in this browser" },
    ]);
  });

  it("reports unsupported without throwing when the constructor throws", () => {
    const harness = createHarness({ constructorThrows: true });
    const { callbacks, log } = recordCallbacks();
    expect(() => {
      harness.adapter.start({ callbacks });
    }).not.toThrow();
    expect(log.errors).toEqual([
      { code: "unsupported", message: "Speech recognition is not supported in this browser" },
    ]);
  });

  it("settles microphone-unavailable exactly once when start throws synchronously", () => {
    const harness = createHarness({
      startImpl: () => {
        throw new Error("start failed");
      },
    });
    const { callbacks, log } = recordCallbacks();
    const run = harness.adapter.start({ callbacks });
    expect(log.errors).toEqual([{ code: "microphone-unavailable", message: "Microphone is unavailable" }]);
    const instance = singleInstance(harness);
    instance.emitError("network");
    instance.emitEnd();
    run.stop();
    run.cancel();
    expect(log.errors).toHaveLength(1);
    expect(log.completed).toEqual([]);
  });
});

describe("result accumulation", () => {
  it("accumulates final segments and replaces interim text across mixed batches", () => {
    const harness = createHarness();
    const { log } = startRun(harness);
    const instance = singleInstance(harness);
    instance.emitResult([
      { transcript: "Hello ", isFinal: true },
      { transcript: "wor", isFinal: false },
    ]);
    expect(log.interim).toEqual(["wor"]);
    expect(log.completed).toEqual([]);
    instance.emitResult([
      { transcript: "Hello ", isFinal: true },
      { transcript: "world", isFinal: true },
      { transcript: "how are you", isFinal: false },
    ]);
    expect(log.interim).toEqual(["wor", "how are you"]);
    instance.emitEnd();
    expect(log.completed).toEqual(["Hello world"]);
    // Browser never reports a transcribing phase.
    expect(log.transcribing).toBe(0);
  });

  it("publishes an empty interim update when a provisional segment becomes final", () => {
    const harness = createHarness();
    const { log } = startRun(harness);
    const instance = singleInstance(harness);
    instance.emitResult([{ transcript: "Hello", isFinal: false }]);
    expect(log.interim).toEqual(["Hello"]);
    // The provisional segment flips to final, so the aggregate becomes empty;
    // the adapter must publish that change so a stale interim display clears
    // before the run completes.
    instance.emitResult([{ transcript: "Hello ", isFinal: true }]);
    expect(log.interim).toEqual(["Hello", ""]);
    expect(log.completed).toEqual([]);
    instance.emitEnd();
    expect(log.completed).toEqual(["Hello"]);
  });

  it("publishes an empty interim update when the recognizer retracts the provisional segment", () => {
    const harness = createHarness();
    const { log } = startRun(harness);
    const instance = singleInstance(harness);
    instance.emitResult([{ transcript: "Hello", isFinal: false }]);
    expect(log.interim).toEqual(["Hello"]);
    instance.emitResult([{ transcript: "", isFinal: false }]);
    expect(log.interim).toEqual(["Hello", ""]);
    expect(log.completed).toEqual([]);
    instance.emitEnd();
    expect(log.completed).toEqual([]);
    expect(log.errors).toEqual([{ code: "no-speech", message: "No speech detected" }]);
  });

  it("finalizes a previously interim result exactly once when it becomes final", () => {
    const harness = createHarness();
    const { log } = startRun(harness);
    const instance = singleInstance(harness);
    instance.emitResult([{ transcript: "Hello", isFinal: false }]);
    expect(log.interim).toEqual(["Hello"]);
    instance.emitResult([
      { transcript: "Hello ", isFinal: true },
      { transcript: "world", isFinal: false },
    ]);
    expect(log.interim).toEqual(["Hello", "world"]);
    // The previously interim segment flips to final; it must land in the
    // accumulated final text exactly once.
    instance.emitResult([
      { transcript: "Hello ", isFinal: true },
      { transcript: "world", isFinal: true },
    ]);
    instance.emitEnd();
    expect(log.completed).toEqual(["Hello world"]);
  });

  it("suppresses result events after the run has settled", () => {
    const harness = createHarness();
    const { log } = startRun(harness);
    const instance = singleInstance(harness);
    instance.emitResult([{ transcript: "Hello ", isFinal: true }]);
    instance.emitEnd();
    instance.emitResult([{ transcript: "ignored", isFinal: false }]);
    expect(log.interim).toEqual([]);
    expect(log.completed).toEqual(["Hello"]);
  });
});

describe("natural end", () => {
  it("completes the accumulated final text on a natural end", () => {
    const harness = createHarness();
    const { log } = startRun(harness);
    const instance = singleInstance(harness);
    instance.emitResult([{ transcript: "Hello world", isFinal: true }]);
    instance.emitEnd();
    expect(log.completed).toEqual(["Hello world"]);
    expect(log.errors).toEqual([]);
  });

  it("reports no-speech exactly once when end arrives with no final speech", () => {
    const harness = createHarness();
    const { log } = startRun(harness);
    const instance = singleInstance(harness);
    instance.emitEnd();
    expect(log.errors).toEqual([{ code: "no-speech", message: "No speech detected" }]);
    instance.emitEnd();
    expect(log.errors).toHaveLength(1);
    expect(log.completed).toEqual([]);
  });

  it("treats whitespace-only final segments as no speech on end", () => {
    const harness = createHarness();
    const { log } = startRun(harness);
    const instance = singleInstance(harness);
    instance.emitResult([{ transcript: "   ", isFinal: true }]);
    instance.emitEnd();
    expect(log.completed).toEqual([]);
    expect(log.errors).toEqual([{ code: "no-speech", message: "No speech detected" }]);
  });
});

describe("stop settlement", () => {
  it("calls recognition stop, then completes when end arrives and releases the watchdog", () => {
    const harness = createHarness();
    const { run, log } = startRun(harness);
    const instance = singleInstance(harness);
    instance.emitResult([{ transcript: "Hello ", isFinal: true }]);
    run.stop();
    expect(instance.stop).toHaveBeenCalledTimes(1);
    expect(instance.abort).not.toHaveBeenCalled();
    // Stop itself never settles the run; only the end event or the watchdog does.
    expect(log.completed).toEqual([]);
    expect(log.errors).toEqual([]);
    expect(harness.scheduler.scheduled?.delayMs).toBe(SPEECH_RECOGNITION_STOP_SETTLEMENT_MS);
    instance.emitEnd();
    expect(log.completed).toEqual(["Hello"]);
    expect(log.errors).toEqual([]);
    expect(harness.scheduler.scheduled).toBeUndefined();
    // The released watchdog cannot settle the run again.
    harness.scheduler.fire();
    expect(instance.abort).not.toHaveBeenCalled();
    expect(log.completed).toEqual(["Hello"]);
  });

  it("settles microphone-unavailable exactly once when stop throws synchronously", () => {
    const harness = createHarness();
    const { run, log } = startRun(harness);
    const instance = singleInstance(harness);
    instance.stop.mockImplementation(() => {
      throw new Error("stop failed");
    });
    run.stop();
    expect(log.errors).toEqual([{ code: "microphone-unavailable", message: "Microphone is unavailable" }]);
    run.stop();
    instance.emitResult([{ transcript: "ignored", isFinal: true }]);
    instance.emitEnd();
    expect(log.errors).toHaveLength(1);
    expect(log.completed).toEqual([]);
    expect(harness.scheduler.scheduled).toBeUndefined();
  });

  it("aborts and completes accumulated text when end never arrives after stop", () => {
    const harness = createHarness();
    const { run, log } = startRun(harness);
    const instance = singleInstance(harness);
    instance.emitResult([{ transcript: "Hello ", isFinal: true }]);
    run.stop();
    expect(instance.stop).toHaveBeenCalledTimes(1);
    expect(harness.scheduler.scheduled?.delayMs).toBe(SPEECH_RECOGNITION_STOP_SETTLEMENT_MS);
    harness.scheduler.fire();
    expect(instance.abort).toHaveBeenCalledTimes(1);
    expect(log.completed).toEqual(["Hello"]);
    // Late end and result events after watchdog settlement are suppressed.
    instance.emitEnd();
    instance.emitResult([{ transcript: "ignored", isFinal: true }]);
    expect(log.completed).toEqual(["Hello"]);
    expect(log.errors).toEqual([]);
  });

  it("aborts and reports no-speech when the watchdog settles with no final speech", () => {
    const harness = createHarness();
    const { run, log } = startRun(harness);
    const instance = singleInstance(harness);
    run.stop();
    harness.scheduler.fire();
    expect(instance.abort).toHaveBeenCalledTimes(1);
    expect(log.completed).toEqual([]);
    expect(log.errors).toEqual([{ code: "no-speech", message: "No speech detected" }]);
  });

  it("keeps accumulating final segments between stop and settlement", () => {
    const harness = createHarness();
    const { run, log } = startRun(harness);
    const instance = singleInstance(harness);
    instance.emitResult([{ transcript: "Hello ", isFinal: true }]);
    run.stop();
    instance.emitResult([
      { transcript: "Hello ", isFinal: true },
      { transcript: "world", isFinal: true },
    ]);
    harness.scheduler.fire();
    expect(log.completed).toEqual(["Hello world"]);
  });

  it("arms the settlement watchdog only once across repeated stop requests", () => {
    const harness = createHarness();
    const { run, log } = startRun(harness);
    const instance = singleInstance(harness);
    run.stop();
    run.stop();
    expect(instance.stop).toHaveBeenCalledTimes(1);
    harness.scheduler.fire();
    expect(instance.abort).toHaveBeenCalledTimes(1);
    expect(log.errors).toEqual([{ code: "no-speech", message: "No speech detected" }]);
    harness.scheduler.fire();
    expect(log.errors).toHaveLength(1);
  });
});

describe("cancel", () => {
  it("calls abort and suppresses every late event without completing or failing", () => {
    const harness = createHarness();
    const { run, log } = startRun(harness);
    const instance = singleInstance(harness);
    run.cancel();
    expect(instance.abort).toHaveBeenCalledTimes(1);
    instance.emitStart();
    instance.emitResult([{ transcript: "Hello ", isFinal: true }]);
    instance.emitError("network");
    instance.emitEnd();
    expect(log.listening).toBe(0);
    expect(log.interim).toEqual([]);
    expect(log.completed).toEqual([]);
    expect(log.errors).toEqual([]);
  });

  it("swallows a synchronous abort throw during cancel", () => {
    const harness = createHarness();
    const { run, log } = startRun(harness);
    const instance = singleInstance(harness);
    instance.abort.mockImplementation(() => {
      throw new Error("abort failed");
    });
    expect(() => {
      run.cancel();
    }).not.toThrow();
    expect(log.completed).toEqual([]);
    expect(log.errors).toEqual([]);
  });

  it("canceling while a stop settlement is pending releases the watchdog", () => {
    const harness = createHarness();
    const { run, log } = startRun(harness);
    const instance = singleInstance(harness);
    instance.emitResult([{ transcript: "Hello ", isFinal: true }]);
    run.stop();
    expect(harness.scheduler.scheduled).toBeDefined();
    run.cancel();
    expect(instance.abort).toHaveBeenCalledTimes(1);
    expect(harness.scheduler.scheduled).toBeUndefined();
    harness.scheduler.fire();
    instance.emitEnd();
    expect(log.completed).toEqual([]);
    expect(log.errors).toEqual([]);
  });

  it("keeps runs independent: a canceled run cannot affect a later run", () => {
    const harness = createHarness();
    const { run: first, log: firstLog } = startRun(harness);
    const firstInstance = harness.instances[0];
    if (firstInstance === undefined) throw new Error("missing first instance");
    first.cancel();
    firstInstance.emitEnd();
    expect(firstLog.completed).toEqual([]);
    const { log: secondLog } = startRun(harness);
    const secondInstance = harness.instances[1];
    if (secondInstance === undefined) throw new Error("missing second instance");
    expect(secondInstance).not.toBe(firstInstance);
    secondInstance.emitResult([{ transcript: "Hi ", isFinal: true }]);
    secondInstance.emitEnd();
    expect(secondLog.completed).toEqual(["Hi"]);
    expect(firstLog.completed).toEqual([]);
    expect(firstLog.errors).toEqual([]);
  });
});

describe("error normalization", () => {
  it.each([
    ["not-allowed", "permission-denied", "Microphone permission denied"],
    ["service-not-allowed", "permission-denied", "Microphone permission denied"],
    ["no-speech", "no-speech", "No speech detected"],
    ["no-match", "no-speech", "No speech detected"],
    ["network", "network", "Speech recognition network error"],
    ["audio-capture", "microphone-unavailable", "Microphone is unavailable"],
    ["language-not-supported", "unsupported", "The selected language is not supported"],
    ["bad-grammar", "provider", "Speech recognition failed"],
    ["aborted", "provider", "Speech recognition failed"],
  ] as const)("maps the %s vendor error to the normalized %s code", (rawCode, code, message) => {
    const harness = createHarness();
    const { log } = startRun(harness);
    const instance = singleInstance(harness);
    instance.emitError(rawCode);
    expect(log.errors).toEqual([{ code, message }]);
    // The error settles the run: the trailing vendor end event is suppressed.
    instance.emitEnd();
    expect(log.errors).toHaveLength(1);
    expect(log.completed).toEqual([]);
  });

  it("maps unknown vendor failures to provider without leaking raw vendor text", () => {
    const harness = createHarness();
    const { log } = startRun(harness);
    singleInstance(harness).emitError("vendor-internal-session-error-42");
    expect(log.errors).toEqual([{ code: "provider", message: "Speech recognition failed" }]);
    expect(log.errors[0]?.message).not.toContain("vendor-internal-session-error-42");
  });
});
