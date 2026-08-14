import { describe, expect, it } from "vitest";
import type { SpeechInputSettingsResponse } from "../../../shared/apiTypes";
import type {
  SpeechInputAvailability,
  SpeechInputProviderId,
  SpeechInputTargetSnapshot,
} from "../speechInput/speechInputCore";
import type {
  SpeechInputProviderAdapter,
  SpeechInputProviderCallbacks,
  SpeechInputProviderError,
  SpeechInputProviderRun,
} from "../speechInput/speechInputProvider";
import {
  createDefaultSpeechInputController,
  SpeechInputController,
  type SpeechInputControllerState,
} from "./speechInputController";

const TARGET: SpeechInputTargetSnapshot = {
  identity: { kind: "starter", machineId: "machine-a", projectId: "project-a", workspaceId: "workspace-a" },
  text: "Draft text",
  from: 5,
  to: 5,
};

const SETTINGS_LOADING_REASON = "Speech settings are still loading.";
const DRAFT_CHANGED_ERROR = "Dictation was canceled because the draft changed.";
const TRANSCRIPT_TOO_LARGE_ERROR = "Dictated speech is too large.";
const CONTROLLER_FAILURE_ERROR = "Speech input failed.";
const TRANSCRIPTION_TIMEOUT_ERROR = "Speech transcription timed out.";

class FakeRun implements SpeechInputProviderRun {
  stopCalls = 0;
  cancelCalls = 0;
  stopError: Error | undefined;
  cancelError: Error | undefined;
  onStop: (() => void) | undefined;
  onCancel: (() => void) | undefined;

  stop(): void {
    this.stopCalls += 1;
    this.onStop?.();
    if (this.stopError !== undefined) throw this.stopError;
  }

  cancel(): void {
    this.cancelCalls += 1;
    this.onCancel?.();
    if (this.cancelError !== undefined) throw this.cancelError;
  }
}

interface FakeStart {
  input: { language?: string; callbacks: SpeechInputProviderCallbacks };
  run: FakeRun;
}

class FakeAdapter implements SpeechInputProviderAdapter {
  readonly starts: FakeStart[] = [];
  availabilityValue: SpeechInputAvailability = { available: true };
  startError: Error | undefined;
  onStart: ((start: FakeStart) => void) | undefined;

  constructor(readonly id: SpeechInputProviderId) {}

  availability(): SpeechInputAvailability {
    return this.availabilityValue;
  }

  start(input: { language?: string; callbacks: SpeechInputProviderCallbacks }): SpeechInputProviderRun {
    if (this.startError !== undefined) throw this.startError;
    const start = { input, run: new FakeRun() };
    this.starts.push(start);
    this.onStart?.(start);
    return start.run;
  }

  latest(): FakeStart {
    const start = this.starts.at(-1);
    if (start === undefined) throw new Error("Expected a provider start");
    return start;
  }
}

interface ScheduledCallback {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
  cancelCalls: number;
}

class FakeTimers {
  readonly intervals: ScheduledCallback[] = [];
  readonly deadlines: ScheduledCallback[] = [];

  scheduleInterval = (callback: () => void, delayMs: number): (() => void) => {
    const scheduled: ScheduledCallback = { callback, delayMs, cancelled: false, cancelCalls: 0 };
    this.intervals.push(scheduled);
    return () => {
      scheduled.cancelled = true;
      scheduled.cancelCalls += 1;
    };
  };

  scheduleDeadline = (callback: () => void, delayMs: number): (() => void) => {
    const scheduled: ScheduledCallback = { callback, delayMs, cancelled: false, cancelCalls: 0 };
    this.deadlines.push(scheduled);
    return () => {
      scheduled.cancelled = true;
      scheduled.cancelCalls += 1;
    };
  };

  fireInterval(index = this.intervals.length - 1): void {
    const scheduled = this.intervals[index];
    if (scheduled === undefined) throw new Error("Expected an interval");
    scheduled.callback();
  }

  fireDeadline(index = this.deadlines.length - 1): void {
    const scheduled = this.deadlines[index];
    if (scheduled === undefined) throw new Error("Expected a deadline");
    scheduled.callback();
  }
}

interface Harness {
  controller: SpeechInputController;
  browser: FakeAdapter;
  cloud: FakeAdapter;
  timers: FakeTimers;
  states: SpeechInputControllerState[];
  interims: { target: SpeechInputTargetSnapshot; text: string }[];
  finals: { target: SpeechInputTargetSnapshot; text: string }[];
  clears: number;
  setFinalOutcome(outcome: "inserted" | "empty" | "changed" | "too-large"): void;
  setNow(value: number): void;
}

function createHarness(): Harness {
  const browser = new FakeAdapter("browser");
  const cloud = new FakeAdapter("cloud");
  const timers = new FakeTimers();
  const states: SpeechInputControllerState[] = [];
  const interims: { target: SpeechInputTargetSnapshot; text: string }[] = [];
  const finals: { target: SpeechInputTargetSnapshot; text: string }[] = [];
  let clears = 0;
  let finalOutcome: "inserted" | "empty" | "changed" | "too-large" = "inserted";
  let now = 0;
  const runIds = ["run-1", "run-2", "run-3"];
  const controller = new SpeechInputController({
    browser,
    cloud,
    createRunId: () => runIds.shift() ?? "run-extra",
    now: () => now,
    scheduleInterval: timers.scheduleInterval,
    scheduleDeadline: timers.scheduleDeadline,
    callbacks: {
      onStateChange: (state) => {
        states.push(state);
      },
      onInterim: (target, text) => {
        interims.push({ target, text });
      },
      onFinal: (target, text) => {
        finals.push({ target, text });
        return finalOutcome;
      },
      onClearInterim: () => {
        clears += 1;
      },
    },
  });

  return {
    controller,
    browser,
    cloud,
    timers,
    states,
    interims,
    finals,
    get clears() {
      return clears;
    },
    setFinalOutcome: (outcome) => {
      finalOutcome = outcome;
    },
    setNow: (value) => {
      now = value;
    },
  };
}

function settings(options: {
  provider?: "auto" | SpeechInputProviderId;
  language?: string;
  credential?: SpeechInputSettingsResponse["credential"];
} = {}): SpeechInputSettingsResponse {
  const provider = options.provider ?? "auto";
  const language = options.language;
  return {
    contractVersion: 1,
    revision: "3f80a0ba-60eb-4b8f-9f80-62a231cf5a0b",
    settings: {
      provider,
      ...(language === undefined ? {} : { language }),
      cloud: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe" },
    },
    credential: options.credential ?? { configured: true, source: "literal", resolution: "resolved" },
  };
}

function emitListening(adapter: FakeAdapter): void {
  adapter.latest().input.callbacks.onListening();
}

function emitInterim(adapter: FakeAdapter, text: string): void {
  adapter.latest().input.callbacks.onInterim(text);
}

function emitTranscribing(adapter: FakeAdapter): void {
  adapter.latest().input.callbacks.onTranscribing();
}

function emitComplete(adapter: FakeAdapter, text: string): void {
  adapter.latest().input.callbacks.onComplete(text);
}

function emitError(adapter: FakeAdapter, error: SpeechInputProviderError): void {
  adapter.latest().input.callbacks.onError(error);
}

describe("SpeechInputController", () => {
  it("creates the production browser and cloud adapter assembly without starting capture", () => {
    const controller = createDefaultSpeechInputController({
      onStateChange: () => undefined,
      onInterim: () => undefined,
      onFinal: () => "inserted",
      onClearInterim: () => undefined,
    });

    expect(controller).toBeInstanceOf(SpeechInputController);
    expect(controller.state).toEqual({ kind: "idle", unavailableReason: SETTINGS_LOADING_REASON });
    controller.dispose();
  });

  it("previews configured availability without starting capture and waits for the first settings snapshot", () => {
    const harness = createHarness();
    harness.browser.availabilityValue = { available: false, reason: "Browser speech is unavailable" };
    harness.cloud.availabilityValue = { available: false, reason: "No accepted recorder format" };

    expect(harness.controller.state).toEqual({ kind: "idle", unavailableReason: SETTINGS_LOADING_REASON });

    harness.controller.configure(settings({ provider: "browser" }));
    expect(harness.controller.state).toEqual({ kind: "idle", unavailableReason: "Browser speech is unavailable" });
    expect(harness.browser.starts).toHaveLength(0);
    expect(harness.cloud.starts).toHaveLength(0);

    harness.browser.availabilityValue = { available: true };
    harness.controller.configure(settings({ provider: "auto" }));
    expect(harness.controller.state).toEqual({ kind: "idle", provider: "browser" });

    harness.controller.configure(undefined);
    expect(harness.controller.state).toEqual({ kind: "idle", unavailableReason: SETTINGS_LOADING_REASON });
  });

  it("resolves Auto once, captures Browser language, and does not start a second run while active", () => {
    const harness = createHarness();
    harness.browser.availabilityValue = { available: false, reason: "Browser speech is unavailable" };
    harness.controller.configure(settings({ provider: "auto", language: "en-US" }));

    harness.controller.start(TARGET);
    expect(harness.controller.state).toEqual({ kind: "requesting-permission", runId: "run-1", provider: "cloud" });
    expect(harness.browser.starts).toHaveLength(0);
    expect(harness.cloud.starts).toHaveLength(1);
    expect("language" in harness.cloud.latest().input).toBe(false);

    harness.controller.start(TARGET);
    expect(harness.cloud.starts).toHaveLength(1);

    harness.controller.cancel();
    harness.browser.availabilityValue = { available: true };
    harness.controller.configure(settings({ provider: "browser", language: "de-DE" }));
    harness.controller.start(TARGET);
    expect(harness.browser.latest().input.language).toBe("de-DE");
  });

  it("does not fall back after Auto selects Browser and allows a fresh retry", () => {
    const harness = createHarness();
    harness.controller.configure(settings({ provider: "auto" }));

    harness.controller.start(TARGET);
    emitError(harness.browser, { code: "network", message: "Speech recognition network error" });

    expect(harness.cloud.starts).toHaveLength(0);
    expect(harness.controller.state).toEqual({
      kind: "idle",
      provider: "browser",
      error: "Speech recognition network error",
    });

    harness.controller.start(TARGET);
    expect(harness.browser.starts).toHaveLength(2);
    expect(harness.controller.state).toEqual({ kind: "requesting-permission", runId: "run-2", provider: "browser" });
  });

  it("uses the target snapshot captured before asynchronous completion", () => {
    const harness = createHarness();
    const target: SpeechInputTargetSnapshot = {
      identity: {
        kind: "session",
        machineId: "machine-a",
        projectId: "project-a",
        workspaceId: "workspace-a",
        sessionId: "session-a",
      },
      text: "Captured text",
      from: 2,
      to: 6,
    };
    harness.controller.configure(settings({ provider: "browser" }));
    harness.controller.start(target);
    target.identity = {
      kind: "session",
      machineId: "machine-b",
      projectId: "project-b",
      workspaceId: "workspace-b",
      sessionId: "session-b",
    };
    target.text = "Changed after capture";
    target.from = 0;
    target.to = 0;

    emitComplete(harness.browser, "final words");

    expect(harness.finals).toEqual([{
      target: {
        identity: {
          kind: "session",
          machineId: "machine-a",
          projectId: "project-a",
          workspaceId: "workspace-a",
          sessionId: "session-a",
        },
        text: "Captured text",
        from: 2,
        to: 6,
      },
      text: "final words",
    }]);
  });

  it("publishes requesting, listening, interim, and natural Browser completion transitions", () => {
    const harness = createHarness();
    harness.controller.configure(settings({ provider: "browser" }));

    harness.controller.start(TARGET);
    emitListening(harness.browser);
    expect(harness.controller.state).toEqual({
      kind: "listening",
      runId: "run-1",
      provider: "browser",
      elapsedMs: 0,
    });

    harness.setNow(1_500);
    harness.timers.fireInterval();
    expect(harness.controller.state).toMatchObject({ kind: "listening", elapsedMs: 1_500 });

    emitInterim(harness.browser, " provisional words");
    expect(harness.interims).toEqual([{ target: TARGET, text: " provisional words" }]);
    expect(harness.controller.state).toMatchObject({ kind: "listening", interimText: " provisional words" });

    emitComplete(harness.browser, "final words");
    expect(harness.finals).toEqual([{ target: TARGET, text: "final words" }]);
    expect(harness.clears).toBe(1);
    expect(harness.controller.state).toEqual({ kind: "idle", provider: "browser" });
  });

  it("stops Browser capture for a user Stop and waits for its terminal callback", () => {
    const harness = createHarness();
    harness.controller.configure(settings({ provider: "browser" }));
    harness.controller.start(TARGET);
    emitListening(harness.browser);

    harness.controller.stop();
    expect(harness.browser.latest().run.stopCalls).toBe(1);
    expect(harness.controller.state).toMatchObject({ kind: "listening", runId: "run-1" });

    emitComplete(harness.browser, "final words");
    expect(harness.controller.state).toEqual({ kind: "idle", provider: "browser" });
  });

  it("moves Cloud into transcribing synchronously after capture Stop and settles on success", () => {
    const harness = createHarness();
    harness.browser.availabilityValue = { available: false, reason: "Browser speech is unavailable" };
    harness.controller.configure(settings({ provider: "cloud" }));
    harness.controller.start(TARGET);
    emitListening(harness.cloud);
    harness.cloud.latest().run.onStop = () => {
      emitTranscribing(harness.cloud);
    };

    harness.controller.stop();
    expect(harness.cloud.latest().run.stopCalls).toBe(1);
    expect(harness.controller.state).toEqual({
      kind: "transcribing",
      runId: "run-1",
      provider: "cloud",
      elapsedMs: 0,
    });
    expect(harness.timers.deadlines.map((timer) => timer.delayMs)).toEqual([600_000, 130_000]);

    emitComplete(harness.cloud, "transcribed text");
    expect(harness.finals).toEqual([{ target: TARGET, text: "transcribed text" }]);
    expect(harness.controller.state).toEqual({ kind: "idle", provider: "cloud" });
  });

  it.each([
    ["empty", "No speech detected"],
    ["changed", DRAFT_CHANGED_ERROR],
    ["too-large", TRANSCRIPT_TOO_LARGE_ERROR],
  ] as const)("publishes the normalized final insertion error for %s", (outcome, error) => {
    const harness = createHarness();
    harness.controller.configure(settings({ provider: "browser" }));
    harness.setFinalOutcome(outcome);

    harness.controller.start(TARGET);
    emitComplete(harness.browser, "final words");

    expect(harness.controller.state).toEqual({ kind: "idle", provider: "browser", error });
  });

  it("uses adapter no-speech errors without fallback or automatic retry", () => {
    const harness = createHarness();
    harness.controller.configure(settings({ provider: "browser" }));
    harness.controller.start(TARGET);

    emitError(harness.browser, { code: "no-speech", message: "No speech detected" });

    expect(harness.controller.state).toEqual({ kind: "idle", provider: "browser", error: "No speech detected" });
    expect(harness.browser.starts).toHaveLength(1);
    expect(harness.cloud.starts).toHaveLength(0);
  });

  it("handles synchronous listening, completion, and error callbacks before start returns", () => {
    const listening = createHarness();
    listening.controller.configure(settings({ provider: "browser" }));
    listening.browser.onStart = ({ input }) => {
      input.callbacks.onListening();
    };

    listening.controller.start(TARGET);
    expect(listening.controller.state).toMatchObject({ kind: "listening", runId: "run-1", provider: "browser" });
    listening.controller.stop();
    expect(listening.browser.latest().run.stopCalls).toBe(1);

    const completion = createHarness();
    completion.controller.configure(settings({ provider: "browser" }));
    completion.browser.onStart = ({ input }) => {
      input.callbacks.onListening();
      input.callbacks.onComplete("synchronous final");
    };

    completion.controller.start(TARGET);
    expect(completion.browser.latest().run.cancelCalls).toBe(1);
    expect(completion.controller.state).toEqual({ kind: "idle", provider: "browser" });
    expect(completion.finals).toEqual([{ target: TARGET, text: "synchronous final" }]);

    const failure = createHarness();
    failure.controller.configure(settings({ provider: "browser" }));
    failure.browser.onStart = ({ input }) => {
      input.callbacks.onError({ code: "microphone-unavailable", message: "Microphone is unavailable" });
    };

    failure.controller.start(TARGET);
    expect(failure.browser.latest().run.cancelCalls).toBe(1);
    expect(failure.controller.state).toEqual({
      kind: "idle",
      provider: "browser",
      error: "Microphone is unavailable",
    });
    expect(failure.states.filter((state) => state.kind === "idle" && state.error !== undefined)).toHaveLength(1);
  });

  it("does not overwrite a new run started from a final callback with the prior run's idle state", () => {
    const browser = new FakeAdapter("browser");
    const controller = new SpeechInputController({
      browser,
      cloud: new FakeAdapter("cloud"),
      createRunId: (() => {
        const ids = ["run-1", "run-2"];
        return () => ids.shift() ?? "run-extra";
      })(),
      callbacks: {
        onStateChange: () => undefined,
        onInterim: () => undefined,
        onFinal: () => {
          controller.start(TARGET);
          return "inserted";
        },
        onClearInterim: () => undefined,
      },
    });
    controller.configure(settings({ provider: "browser" }));
    controller.start(TARGET);

    emitComplete(browser, "first final");

    expect(browser.starts).toHaveLength(2);
    expect(controller.state).toEqual({ kind: "requesting-permission", runId: "run-2", provider: "browser" });
  });

  it("normalizes synchronous start and stop failures without exposing thrown messages", () => {
    const startFailure = createHarness();
    startFailure.controller.configure(settings({ provider: "browser" }));
    startFailure.browser.startError = new Error("private provider failure");

    expect(() => {
      startFailure.controller.start(TARGET);
    }).not.toThrow();
    expect(startFailure.controller.state).toEqual({ kind: "idle", provider: "browser", error: CONTROLLER_FAILURE_ERROR });

    const stopFailure = createHarness();
    stopFailure.controller.configure(settings({ provider: "browser" }));
    stopFailure.controller.start(TARGET);
    emitListening(stopFailure.browser);
    stopFailure.browser.latest().run.stopError = new Error("private stop failure");

    expect(() => {
      stopFailure.controller.stop();
    }).not.toThrow();
    expect(stopFailure.browser.latest().run.cancelCalls).toBe(1);
    expect(stopFailure.controller.state).toEqual({ kind: "idle", provider: "browser", error: CONTROLLER_FAILURE_ERROR });
  });

  it("uses Cancel during permission and transcription, Stop while listening, and makes terminal repeat taps no-ops", () => {
    const permission = createHarness();
    permission.controller.configure(settings({ provider: "browser" }));
    permission.controller.start(TARGET);
    permission.controller.stop();
    expect(permission.browser.latest().run.cancelCalls).toBe(1);

    const listening = createHarness();
    listening.controller.configure(settings({ provider: "browser" }));
    listening.controller.start(TARGET);
    emitListening(listening.browser);
    listening.controller.stop();
    expect(listening.browser.latest().run.stopCalls).toBe(1);

    const transcribing = createHarness();
    transcribing.browser.availabilityValue = { available: false, reason: "Browser speech is unavailable" };
    transcribing.controller.configure(settings({ provider: "cloud" }));
    transcribing.controller.start(TARGET);
    emitListening(transcribing.cloud);
    emitTranscribing(transcribing.cloud);
    transcribing.controller.stop();
    expect(transcribing.cloud.latest().run.cancelCalls).toBe(1);
    expect(transcribing.controller.cancel()).toBe(false);
    transcribing.controller.stop();
    expect(transcribing.cloud.latest().run.stopCalls).toBe(0);
  });

  it("arms capture timing only after listening, reports monotonic elapsed time, and stops exactly once at ten minutes", () => {
    const harness = createHarness();
    harness.controller.configure(settings({ provider: "browser" }));
    harness.controller.start(TARGET);
    expect(harness.timers.intervals).toHaveLength(0);
    expect(harness.timers.deadlines).toHaveLength(0);

    emitListening(harness.browser);
    expect(harness.timers.intervals.map((timer) => timer.delayMs)).toEqual([1_000]);
    expect(harness.timers.deadlines.map((timer) => timer.delayMs)).toEqual([600_000]);

    harness.setNow(599_999);
    harness.timers.fireInterval();
    expect(harness.controller.state).toMatchObject({ kind: "listening", elapsedMs: 599_999 });

    harness.setNow(600_000);
    harness.timers.fireDeadline(0);
    harness.timers.fireDeadline(0);
    expect(harness.browser.latest().run.stopCalls).toBe(1);
  });

  it("stops a run whose capture deadline fires synchronously before start returns", () => {
    const browser = new FakeAdapter("browser");
    const controller = new SpeechInputController({
      browser,
      cloud: new FakeAdapter("cloud"),
      createRunId: () => "run-1",
      now: () => 0,
      scheduleInterval: () => () => undefined,
      scheduleDeadline: (callback, delayMs) => {
        if (delayMs === 600_000) callback();
        return () => undefined;
      },
      callbacks: {
        onStateChange: () => undefined,
        onInterim: () => undefined,
        onFinal: () => {
          return "inserted";
        },
        onClearInterim: () => undefined,
      },
    });
    controller.configure(settings({ provider: "browser" }));
    browser.onStart = ({ input }) => {
      input.callbacks.onListening();
    };

    controller.start(TARGET);

    expect(browser.latest().run.stopCalls).toBe(1);
  });

  it("times out a Cloud transcription synchronously, then aborts the adapter and ignores its late terminal callback", () => {
    const harness = createHarness();
    harness.browser.availabilityValue = { available: false, reason: "Browser speech is unavailable" };
    harness.controller.configure(settings({ provider: "cloud" }));
    harness.controller.start(TARGET);
    emitListening(harness.cloud);
    emitTranscribing(harness.cloud);
    const transcriptionTimer = harness.timers.deadlines[1];
    if (transcriptionTimer === undefined) throw new Error("Expected transcription watchdog");
    let stateWhenCanceled: SpeechInputControllerState | undefined;
    harness.cloud.latest().run.onCancel = () => {
      stateWhenCanceled = harness.controller.state;
    };

    harness.timers.fireDeadline(1);

    expect(stateWhenCanceled).toEqual({ kind: "idle", provider: "cloud", error: TRANSCRIPTION_TIMEOUT_ERROR });
    expect(harness.cloud.latest().run.cancelCalls).toBe(1);
    expect(harness.controller.state).toEqual({ kind: "idle", provider: "cloud", error: TRANSCRIPTION_TIMEOUT_ERROR });
    emitComplete(harness.cloud, "late text");
    expect(harness.finals).toEqual([]);
  });

  it("clears the Cloud watchdog on success, error, and user cancellation without resetting it", () => {
    const settle = (terminal: "complete" | "error" | "cancel") => {
      const harness = createHarness();
      harness.browser.availabilityValue = { available: false, reason: "Browser speech is unavailable" };
      harness.controller.configure(settings({ provider: "cloud" }));
      harness.controller.start(TARGET);
      emitListening(harness.cloud);
      emitTranscribing(harness.cloud);
      emitTranscribing(harness.cloud);
      const watchdog = harness.timers.deadlines[1];
      if (watchdog === undefined) throw new Error("Expected transcription watchdog");
      expect(harness.timers.deadlines).toHaveLength(2);

      if (terminal === "complete") emitComplete(harness.cloud, "done");
      if (terminal === "error") emitError(harness.cloud, { code: "network", message: "Speech transcription network error" });
      if (terminal === "cancel") harness.controller.cancel();

      expect(watchdog.cancelled).toBe(true);
      expect(watchdog.cancelCalls).toBe(1);
    };

    settle("complete");
    settle("error");
    settle("cancel");
  });

  it("keeps an active provider and language stable across reconfiguration, then previews the latest snapshot after terminal cleanup", () => {
    const browser = createHarness();
    browser.controller.configure(settings({ provider: "browser", language: "en-US" }));
    browser.controller.start(TARGET);
    emitListening(browser.browser);
    const activeState = browser.controller.state;
    const captureDeadline = browser.timers.deadlines[0];
    const interval = browser.timers.intervals[0];

    browser.controller.configure(settings({ provider: "cloud", language: "fr-FR" }));
    expect(browser.controller.state).toEqual(activeState);
    expect(browser.browser.latest().input.language).toBe("en-US");
    expect(browser.timers.deadlines[0]).toBe(captureDeadline);
    expect(browser.timers.intervals[0]).toBe(interval);
    emitComplete(browser.browser, "done");
    expect(browser.controller.state).toEqual({ kind: "idle", provider: "cloud" });

    const cloud = createHarness();
    cloud.browser.availabilityValue = { available: false, reason: "Browser speech is unavailable" };
    cloud.controller.configure(settings({ provider: "cloud", language: "en-US" }));
    cloud.controller.start(TARGET);
    emitListening(cloud.cloud);
    emitTranscribing(cloud.cloud);
    const cloudState = cloud.controller.state;
    cloud.browser.availabilityValue = { available: true };
    cloud.controller.configure(settings({ provider: "browser", language: "de-DE" }));
    expect(cloud.controller.state).toEqual(cloudState);
    expect("language" in cloud.cloud.latest().input).toBe(false);
    emitComplete(cloud.cloud, "done");
    expect(cloud.controller.state).toEqual({ kind: "idle", provider: "browser" });
  });

  it("cancels each active phase, clears interim/timers, and suppresses all late callbacks", () => {
    const phases: ("requesting" | "listening" | "transcribing")[] = ["requesting", "listening", "transcribing"];
    for (const phase of phases) {
      const harness = createHarness();
      if (phase === "transcribing") {
        harness.browser.availabilityValue = { available: false, reason: "Browser speech is unavailable" };
        harness.controller.configure(settings({ provider: "cloud" }));
        harness.controller.start(TARGET);
        emitListening(harness.cloud);
        emitTranscribing(harness.cloud);
        emitInterim(harness.cloud, "provisional");
        expect(harness.controller.cancel()).toBe(true);
        expect(harness.cloud.latest().run.cancelCalls).toBe(1);
        emitComplete(harness.cloud, "late final");
      } else {
        harness.controller.configure(settings({ provider: "browser" }));
        harness.controller.start(TARGET);
        if (phase === "listening") {
          emitListening(harness.browser);
          emitInterim(harness.browser, "provisional");
        }
        expect(harness.controller.cancel()).toBe(true);
        expect(harness.browser.latest().run.cancelCalls).toBe(1);
        emitComplete(harness.browser, "late final");
      }

      expect(harness.clears).toBe(1);
      expect(harness.finals).toEqual([]);
      expect(harness.controller.state.kind).toBe("idle");
      expect(harness.timers.intervals.every((timer) => timer.cancelled)).toBe(true);
      expect(harness.timers.deadlines.every((timer) => timer.cancelled)).toBe(true);
    }
  });

  it("ignores callbacks from a prior generation after a later run starts", () => {
    const harness = createHarness();
    harness.controller.configure(settings({ provider: "browser" }));
    harness.controller.start(TARGET);
    const first = harness.browser.latest();
    harness.controller.cancel();
    harness.controller.start(TARGET);
    const second = harness.browser.latest();

    first.input.callbacks.onListening();
    first.input.callbacks.onInterim("old provisional");
    first.input.callbacks.onComplete("old final");
    first.input.callbacks.onError({ code: "provider", message: "old error" });

    expect(harness.controller.state).toEqual({ kind: "requesting-permission", runId: "run-2", provider: "browser" });
    expect(harness.interims).toEqual([]);
    expect(harness.finals).toEqual([]);

    second.input.callbacks.onListening();
    expect(harness.controller.state).toMatchObject({ kind: "listening", runId: "run-2" });
  });

  it("suppresses callback work after idempotent disposal and does not allow later configuration or starts", () => {
    const harness = createHarness();
    harness.controller.configure(settings({ provider: "browser" }));
    harness.controller.start(TARGET);
    const first = harness.browser.latest();
    emitListening(harness.browser);
    const notificationsBeforeDispose = harness.states.length;

    harness.controller.dispose();
    harness.controller.dispose();
    expect(first.run.cancelCalls).toBe(1);
    expect(harness.clears).toBe(1);

    harness.controller.configure(settings({ provider: "cloud" }));
    harness.controller.start(TARGET);
    first.input.callbacks.onComplete("late final");
    first.input.callbacks.onError({ code: "provider", message: "late error" });

    expect(harness.browser.starts).toHaveLength(1);
    expect(harness.cloud.starts).toHaveLength(0);
    expect(harness.finals).toEqual([]);
    expect(harness.states).toHaveLength(notificationsBeforeDispose);
  });

  it("swallows a cancellation failure and keeps normal cancellation free of an error", () => {
    const harness = createHarness();
    harness.controller.configure(settings({ provider: "browser" }));
    harness.controller.start(TARGET);
    harness.browser.latest().run.cancelError = new Error("private cancellation failure");

    expect(() => harness.controller.cancel()).not.toThrow();
    expect(harness.controller.state).toEqual({ kind: "idle", provider: "browser" });
  });
});
