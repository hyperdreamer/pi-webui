import { describe, expect, it, vi } from "vitest";
import type { HostSpeechStatus, HostSpeechTerminalResult } from "../../../shared/apiTypes";
import { HttpRequestError } from "../api/http";
import { HostSpeechController, type HostSpeechClientApi } from "./hostSpeechController";

const AVAILABLE: HostSpeechStatus = {
  available: true,
  voices: [
    { name: "Ada", language: "en-US" },
    { name: "Marta", language: "de-DE", variant: "female" },
  ],
};

const TARGET = { machineId: "local", sessionId: "session-a", messageKey: "message-a", text: "Hello there" };

describe("HostSpeechController", () => {
  it("uses getRandomValues for a valid default run ID when randomUUID is unavailable", async () => {
    const expectedRunId = "r000102030405060708090a0b0c0d0e0f";
    const getRandomValues = vi.fn((values: Uint8Array) => {
      values.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      return values;
    });
    const speak = vi.fn<HostSpeechClientApi["speak"]>().mockResolvedValue({ runId: expectedRunId, outcome: "ended" });
    const api: HostSpeechClientApi = {
      status: vi.fn<HostSpeechClientApi["status"]>().mockResolvedValue(AVAILABLE),
      speak,
      stop: vi.fn<HostSpeechClientApi["stop"]>().mockResolvedValue({ runId: expectedRunId, stopped: true }),
    };
    let controller: HostSpeechController | undefined;
    vi.stubGlobal("crypto", { getRandomValues });

    try {
      controller = new HostSpeechController({ api });
      controller.select({ machineId: "local", sessionId: "session-a" });
      await controller.refreshStatus();
      await controller.startManual(TARGET);

      expect(getRandomValues).toHaveBeenCalledOnce();
      expect(speak.mock.calls[0]?.[0]?.runId).toBe(expectedRunId);
    } finally {
      controller?.dispose();
      vi.unstubAllGlobals();
    }
  });
  it("starts unavailable and ignores stale status refreshes", async () => {
    const first = deferred<HostSpeechStatus>();
    const second = deferred<HostSpeechStatus>();
    const harness = createHarness({ status: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) });

    expect(harness.controller.snapshot).toEqual({
      status: { available: false, reason: "Checking OS speech availability.", voices: [] },
      loadingStatus: false,
    });

    const older = harness.controller.refreshStatus();
    const newer = harness.controller.refreshStatus();
    expect(harness.controller.snapshot.loadingStatus).toBe(true);

    second.resolve(AVAILABLE);
    await newer;
    first.resolve({ available: false, reason: "Stale result", voices: [] });
    await older;

    expect(harness.controller.snapshot).toEqual({ status: AVAILABLE, loadingStatus: false });
  });

  it("compares captured source identity without exposing spoken text on the snapshot", async () => {
    const speaking = deferred<HostSpeechTerminalResult>();
    const harness = createHarness({ speak: vi.fn<HostSpeechClientApi["speak"]>(() => speaking.promise) });
    harness.controller.select({ machineId: "local", sessionId: "session-a" });
    await harness.controller.refreshStatus();
    const start = harness.controller.startManual(TARGET);

    expect(harness.controller.snapshot.active).toEqual({
      runId: "run-1",
      sessionId: "session-a",
      messageKey: "message-a",
    });
    expect(harness.controller.matchesActiveSource({
      sessionId: "session-a",
      messageKey: "message-a",
      text: "Hello there",
    })).toBe(true);
    expect(harness.controller.matchesActiveSource({
      sessionId: "session-a",
      messageKey: "message-a",
      text: "Changed",
    })).toBe(false);

    speaking.resolve({ runId: "run-1", outcome: "ended" });
    await start;
  });

  it("uses configured defaults and omits a configured voice that is not currently available", async () => {
    const firstSpeak = deferred<HostSpeechTerminalResult>();
    const secondSpeak = deferred<HostSpeechTerminalResult>();
    const speak = vi.fn<HostSpeechClientApi["speak"]>()
      .mockReturnValueOnce(firstSpeak.promise)
      .mockReturnValueOnce(secondSpeak.promise);
    const harness = createHarness({ speak });
    harness.controller.select({ machineId: "local", sessionId: "session-a" });
    await harness.controller.refreshStatus();

    harness.controller.configure({ voice: "Ada", rate: 25 });
    const first = harness.controller.startManual(TARGET);
    expect(harness.controller.snapshot.active).toEqual({ runId: "run-1", sessionId: "session-a", messageKey: "message-a" });
    expect(speak).toHaveBeenCalledWith({ runId: "run-1", text: "Hello there", voice: "Ada", rate: 25 }, expect.any(AbortSignal));

    harness.controller.configure({ voice: "Retired voice", rate: -10 });
    const second = harness.controller.startManual({ ...TARGET, messageKey: "message-b", text: `One\r\ntwo\u0000${"x".repeat(5_000)}` });
    expect(speak).toHaveBeenLastCalledWith({
      runId: "run-2",
      text: `One\ntwo${"x".repeat(3_993)}`,
      rate: -10,
    }, expect.any(AbortSignal));

    firstSpeak.resolve({ runId: "run-1", outcome: "canceled" });
    secondSpeak.resolve({ runId: "run-2", outcome: "ended" });
    await Promise.all([first, second]);
  });

  it("activates before speaking, aborts a replacement, and ignores stale terminals", async () => {
    const first = deferred<HostSpeechTerminalResult>();
    const second = deferred<HostSpeechTerminalResult>();
    const signals: AbortSignal[] = [];
    const speak = vi.fn<HostSpeechClientApi["speak"]>((_input, signal) => {
      if (signal === undefined) throw new Error("Expected speech signal");
      signals.push(signal);
      return signals.length === 1 ? first.promise : second.promise;
    });
    const harness = createHarness({ speak });
    harness.controller.select({ machineId: "local", sessionId: "session-a" });
    await harness.controller.refreshStatus();

    const firstStart = harness.controller.startManual(TARGET);
    expect(harness.controller.snapshot.active?.runId).toBe("run-1");

    const secondStart = harness.controller.startManual({ ...TARGET, messageKey: "message-b" });
    expect(signals[0]?.aborted).toBe(true);
    expect(harness.controller.snapshot.active).toEqual({ runId: "run-2", sessionId: "session-a", messageKey: "message-b" });

    first.resolve({ runId: "run-1", outcome: "canceled" });
    await firstStart;
    expect(harness.controller.snapshot.active?.runId).toBe("run-2");

    second.resolve({ runId: "run-2", outcome: "ended" });
    await secondStart;
    expect(harness.controller.snapshot.active).toBeUndefined();
    expect(harness.controller.snapshot.error).toBeUndefined();
  });

  it("does not start speech for remote or stale selections", async () => {
    const harness = createHarness();
    harness.controller.select({ machineId: "remote-a", sessionId: "session-a" });
    await harness.controller.startManual({ ...TARGET, machineId: "remote-a" });
    expect(harness.speak).not.toHaveBeenCalled();

    harness.controller.select({ machineId: "local", sessionId: "session-a" });
    await harness.controller.startManual({ ...TARGET, sessionId: "session-b" });
    expect(harness.speak).not.toHaveBeenCalled();
  });

  it("treats same selection as a no-op and stops the exact abandoned run after a selection change", async () => {
    const speaking = deferred<HostSpeechTerminalResult>();
    let signal: AbortSignal | undefined;
    const speak = vi.fn<HostSpeechClientApi["speak"]>((_input, inputSignal) => {
      signal = inputSignal;
      return speaking.promise;
    });
    const harness = createHarness({ speak });
    harness.controller.select({ machineId: "local", sessionId: "session-a" });
    await harness.controller.refreshStatus();
    const start = harness.controller.startManual(TARGET);
    const changesBeforeSameSelection = harness.onStateChange.mock.calls.length;

    harness.controller.select({ machineId: "local", sessionId: "session-a" });
    expect(harness.onStateChange).toHaveBeenCalledTimes(changesBeforeSameSelection);
    expect(signal?.aborted).toBe(false);

    harness.controller.select({ machineId: "local", sessionId: "session-b" });
    expect(harness.controller.snapshot.active).toBeUndefined();
    expect(signal?.aborted).toBe(true);
    await vi.waitFor(() => { expect(harness.stop).toHaveBeenCalledWith("run-1"); });

    speaking.resolve({ runId: "run-1", outcome: "canceled" });
    await start;
  });

  it("clears active state synchronously before stopping and remains idempotent", async () => {
    const speaking = deferred<HostSpeechTerminalResult>();
    let signal: AbortSignal | undefined;
    const harness = createHarness({
      speak: vi.fn<HostSpeechClientApi["speak"]>((_input, inputSignal) => {
        signal = inputSignal;
        return speaking.promise;
      }),
    });
    harness.controller.select({ machineId: "local", sessionId: "session-a" });
    await harness.controller.refreshStatus();
    const start = harness.controller.startManual(TARGET);

    const stopping = harness.controller.stop();
    expect(harness.controller.snapshot.active).toBeUndefined();
    expect(signal?.aborted).toBe(true);
    expect(harness.stop).toHaveBeenCalledWith("run-1");
    await stopping;
    await harness.controller.stop();
    expect(harness.stop).toHaveBeenCalledOnce();

    speaking.resolve({ runId: "run-1", outcome: "canceled" });
    await start;
  });

  it("keeps aborts and canceled outcomes out of user-facing errors", async () => {
    const harness = createHarness({
      speak: vi.fn<HostSpeechClientApi["speak"]>()
        .mockRejectedValueOnce(abortError())
        .mockResolvedValueOnce({ runId: "run-2", outcome: "canceled" }),
    });
    harness.controller.select({ machineId: "local", sessionId: "session-a" });
    await harness.controller.refreshStatus();

    await harness.controller.startManual(TARGET);
    expect(harness.controller.snapshot.active).toBeUndefined();
    expect(harness.controller.snapshot.error).toBeUndefined();

    await harness.controller.startManual({ ...TARGET, messageKey: "message-b" });

    expect(harness.controller.snapshot.active).toBeUndefined();
    expect(harness.controller.snapshot.error).toBeUndefined();
    expect(harness.errorClearDelays).toEqual([]);
  });

  it("keeps a 500 retryable, refreshes status, and clears its error after five seconds", async () => {
    const updatedStatus = { available: true, voices: [{ name: "Marta", language: "de-DE" }] } satisfies HostSpeechStatus;
    const harness = createHarness({
      status: vi.fn<HostSpeechClientApi["status"]>()
        .mockResolvedValueOnce(AVAILABLE)
        .mockResolvedValueOnce(updatedStatus),
      speak: vi.fn<HostSpeechClientApi["speak"]>()
        .mockRejectedValueOnce(new HttpRequestError("Host speech failed. Try again.", 500))
        .mockResolvedValueOnce({ runId: "run-2", outcome: "ended" }),
    });
    harness.controller.select({ machineId: "local", sessionId: "session-a" });
    await harness.controller.refreshStatus();

    await harness.controller.startManual(TARGET);
    await vi.waitFor(() => { expect(harness.controller.snapshot.status).toEqual(updatedStatus); });
    expect(harness.controller.snapshot.error).toBe("Host speech failed. Try again.");
    expect(harness.errorClearDelays).toEqual([5_000]);

    harness.fireLatestErrorClear();
    expect(harness.controller.snapshot.error).toBeUndefined();
    await harness.controller.startManual({ ...TARGET, messageKey: "message-b" });
    expect(harness.speak).toHaveBeenCalledTimes(2);
  });

  it("converts a 503 into unavailable status using the server reason", async () => {
    const harness = createHarness({
      speak: vi.fn<HostSpeechClientApi["speak"]>()
        .mockRejectedValue(new HttpRequestError("Speech Dispatcher is unavailable.", 503)),
    });
    harness.controller.select({ machineId: "local", sessionId: "session-a" });
    await harness.controller.refreshStatus();

    await harness.controller.startManual(TARGET);

    expect(harness.controller.snapshot).toEqual({
      status: { available: false, reason: "Speech Dispatcher is unavailable.", voices: [] },
      loadingStatus: false,
    });
    expect(harness.errorClearDelays).toEqual([]);
  });

  it("reports a stop failure only when the aborted request did not close", async () => {
    const speaking = deferred<HostSpeechTerminalResult>();
    const harness = createHarness({
      speak: vi.fn<HostSpeechClientApi["speak"]>(() => speaking.promise),
      stop: vi.fn<HostSpeechClientApi["stop"]>().mockRejectedValue(new Error("stop failed")),
    });
    harness.controller.select({ machineId: "local", sessionId: "session-a" });
    await harness.controller.refreshStatus();
    const start = harness.controller.startManual(TARGET);

    await harness.controller.stop();
    expect(harness.controller.snapshot.error).toBe("stop failed");
    expect(harness.errorClearDelays).toEqual([5_000]);

    speaking.resolve({ runId: "run-1", outcome: "canceled" });
    await start;
  });

  it("ignores a stop failure once abort has closed the pending speak request", async () => {
    let rejectSpeak: ((reason?: unknown) => void) | undefined;
    const harness = createHarness({
      speak: vi.fn<HostSpeechClientApi["speak"]>((_input, signal) => new Promise<HostSpeechTerminalResult>((_resolve, reject) => {
        rejectSpeak = reject;
        signal?.addEventListener("abort", () => { reject(abortError()); }, { once: true });
      })),
      stop: vi.fn<HostSpeechClientApi["stop"]>().mockImplementation(() => { throw new Error("stop failed"); }),
    });
    harness.controller.select({ machineId: "local", sessionId: "session-a" });
    await harness.controller.refreshStatus();
    const start = harness.controller.startManual(TARGET);

    await harness.controller.stop();
    await start;

    expect(rejectSpeak).toBeDefined();
    expect(harness.controller.snapshot.error).toBeUndefined();
    expect(harness.errorClearDelays).toEqual([]);
  });

  it("disposes idempotently, cancels pending work and timers, and suppresses later notifications", async () => {
    const speaking = deferred<HostSpeechTerminalResult>();
    const harness = createHarness({ speak: vi.fn<HostSpeechClientApi["speak"]>(() => speaking.promise) });
    harness.controller.select({ machineId: "local", sessionId: "session-a" });
    await harness.controller.refreshStatus();
    const start = harness.controller.startManual(TARGET);
    const notificationsBeforeDispose = harness.onStateChange.mock.calls.length;

    harness.controller.dispose();
    harness.controller.dispose();
    speaking.resolve({ runId: "run-1", outcome: "ended" });
    await start;

    expect(harness.stop).toHaveBeenCalledOnce();
    expect(harness.onStateChange).toHaveBeenCalledTimes(notificationsBeforeDispose);
  });

  it("cancels a scheduled retryable-error clear during disposal", async () => {
    const harness = createHarness({
      speak: vi.fn<HostSpeechClientApi["speak"]>().mockRejectedValue(new Error("speak failed")),
    });
    harness.controller.select({ machineId: "local", sessionId: "session-a" });
    await harness.controller.refreshStatus();
    await harness.controller.startManual(TARGET);

    harness.controller.dispose();

    expect(harness.cancellations).toHaveLength(1);
    expect(harness.cancellations[0]).toHaveBeenCalledOnce();
  });

  it("returns defensive snapshots", async () => {
    const harness = createHarness();
    harness.controller.select({ machineId: "local", sessionId: "session-a" });
    await harness.controller.refreshStatus();
    const snapshot = harness.controller.snapshot;
    const voice = snapshot.status.voices[0];
    if (voice === undefined) throw new Error("Expected available voice");
    voice.name = "Mutated";

    expect(harness.controller.snapshot.status.voices[0]?.name).toBe("Ada");
  });
});

function createHarness(overrides: Partial<HostSpeechClientApi> = {}) {
  const status = vi.fn<HostSpeechClientApi["status"]>().mockResolvedValue(AVAILABLE);
  const speak = vi.fn<HostSpeechClientApi["speak"]>().mockResolvedValue({ runId: "run-1", outcome: "ended" });
  const stop = vi.fn<HostSpeechClientApi["stop"]>().mockResolvedValue({ runId: "run-1", stopped: true });
  const api: HostSpeechClientApi = { status, speak, stop, ...overrides };
  const trackedStatus = vi.fn<HostSpeechClientApi["status"]>((...args) => api.status(...args));
  const trackedSpeak = vi.fn<HostSpeechClientApi["speak"]>((...args) => api.speak(...args));
  const trackedStop = vi.fn<HostSpeechClientApi["stop"]>((...args) => api.stop(...args));
  const trackedApi: HostSpeechClientApi = { status: trackedStatus, speak: trackedSpeak, stop: trackedStop };
  const onStateChange = vi.fn();
  const clearCallbacks: (() => void)[] = [];
  const errorClearDelays: number[] = [];
  const cancellations: (() => void)[] = [];
  const runIds = ["run-1", "run-2"];
  const controller = new HostSpeechController({
    api: trackedApi,
    createRunId: () => runIds.shift() ?? "run-extra",
    onStateChange,
    scheduleErrorClear: (callback, delayMs) => {
      errorClearDelays.push(delayMs);
      clearCallbacks.push(callback);
      const cancel = vi.fn();
      cancellations.push(cancel);
      return cancel;
    },
  });

  return {
    controller,
    status: trackedStatus,
    speak: trackedSpeak,
    stop: trackedStop,
    onStateChange,
    errorClearDelays,
    cancellations,
    fireLatestErrorClear: () => {
      const callback = clearCallbacks.at(-1);
      if (callback === undefined) throw new Error("Expected an error-clear callback");
      callback();
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
