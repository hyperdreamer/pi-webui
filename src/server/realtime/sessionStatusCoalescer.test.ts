import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionActivity, SessionStatus } from "../../shared/apiTypes.js";
import {
  SessionStatusCoalescer,
  isImmediateActivityUpdate,
  isImmediateStatusUpdate,
} from "./sessionStatusCoalescer.js";

interface StatusUpdate {
  type: "status.update";
  status: SessionStatus;
}

interface ActivityUpdate {
  type: "activity.update";
  activity: SessionActivity;
}

const isImmediateStatusEvent = (previous: StatusUpdate, next: StatusUpdate): boolean => isImmediateStatusUpdate(previous.status, next.status);
const isImmediateActivityEvent = (previous: ActivityUpdate, next: ActivityUpdate): boolean => isImmediateActivityUpdate(previous.activity, next.activity);

class FakeClock {
  now = 1_000;
  private readonly timers = new Map<ReturnType<typeof setTimeout>, () => void>();

  constructor() {
    vi.useFakeTimers();
    vi.setSystemTime(this.now);
  }

  readonly setTimeout = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const handle = setTimeout(() => {
      this.timers.delete(handle);
      callback();
    }, delayMs);
    this.timers.set(handle, callback);
    return handle;
  };

  readonly clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(handle);
    clearTimeout(handle);
  };

  get timerCount(): number {
    return this.timers.size;
  }

  advanceBy(durationMs: number): void {
    this.now += durationMs;
    vi.advanceTimersByTime(durationMs);
  }

  fireNextTimerEarly(): void {
    const next = this.timers.entries().next().value;
    if (next === undefined) throw new Error("expected a scheduled timer");
    const [handle, callback] = next;
    this.clearTimeout(handle);
    callback();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

function status(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionId: "s1",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    ...overrides,
  };
}

function statusUpdate(messageCount: number, overrides: Partial<SessionStatus> = {}): StatusUpdate {
  return { type: "status.update", status: status({ messageCount, ...overrides }) };
}

function activity(overrides: Partial<SessionActivity> = {}): SessionActivity {
  return {
    sessionId: "s1",
    phase: "active",
    label: "receiving response",
    at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function activityUpdate(overrides: Partial<SessionActivity> = {}): ActivityUpdate {
  return { type: "activity.update", activity: activity(overrides) };
}

describe("status/activity urgency predicates", () => {
  it("treats only status control changes as immediate and compares nested controls structurally", () => {
    const previous = status({
      model: { provider: "anthropic", id: "claude", reasoning: { effort: "high" } },
      queuedMessages: [{ kind: "steer", text: "continue" }],
      warnings: [{ severity: "warning", message: "careful", dismiss: { id: "w1" } }],
    });
    const structurallyEquivalent = status({
      model: { reasoning: { effort: "high" }, id: "claude", provider: "anthropic" },
      queuedMessages: [{ text: "continue", kind: "steer" }],
      warnings: [{ dismiss: { id: "w1" }, message: "careful", severity: "warning" }],
    });

    expect(isImmediateStatusUpdate(previous, structurallyEquivalent)).toBe(false);
    expect(isImmediateStatusUpdate(previous, status({
      messageCount: 4,
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      cost: 0.25,
      generation: { outputTokens: 2, tokensPerSecond: 4 },
      contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
      model: { provider: "anthropic", id: "claude", reasoning: { effort: "high" } },
      queuedMessages: structurallyEquivalent.queuedMessages,
      warnings: [{ severity: "warning", message: "careful", dismiss: { id: "w1" } }],
    }))).toBe(false);

    const urgentUpdates = [
      status({ ...previous, isStreaming: true }),
      status({ ...previous, isCompacting: true }),
      status({ ...previous, isBashRunning: true }),
      status({ ...previous, pendingMessageCount: 1 }),
      status({ ...previous, queuedMessages: [{ kind: "followUp", text: "after this" }] }),
      status({ ...previous, model: { provider: "openai", id: "gpt" } }),
      status({ ...previous, thinkingLevel: "high" }),
      status({ ...previous, persisted: true }),
      status({ ...previous, warnings: [{ severity: "error", message: "broken" }] }),
    ];

    for (const next of urgentUpdates) expect(isImmediateStatusUpdate(previous, next)).toBe(true);
  });

  it("ignores activity timestamps but sends phase, label, and detail changes immediately", () => {
    const previous = activity({ detail: "tool-a" });

    expect(isImmediateActivityUpdate(previous, activity({ detail: "tool-a", at: "2026-08-01T00:00:01.000Z" }))).toBe(false);
    expect(isImmediateActivityUpdate(previous, activity({ detail: "tool-a", phase: "idle" }))).toBe(true);
    expect(isImmediateActivityUpdate(previous, activity({ detail: "tool-a", label: "tool complete" }))).toBe(true);
    expect(isImmediateActivityUpdate(previous, activity({ detail: "tool-b" }))).toBe(true);
  });
});

describe("SessionStatusCoalescer", () => {
  it("sends the first event for a key synchronously", () => {
    const clock = new FakeClock();
    const sent: number[] = [];
    const coalescer = new SessionStatusCoalescer<StatusUpdate>(isImmediateStatusEvent, {
      intervalMs: 100,
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    coalescer.publish("s1:status.update", statusUpdate(1), (event) => sent.push(event.status.messageCount ?? -1));

    expect(sent).toEqual([1]);
    expect(clock.timerCount).toBe(0);
  });

  it("retains only the newest non-urgent update and sends it at the trailing interval", () => {
    const clock = new FakeClock();
    const sent: number[] = [];
    const coalescer = new SessionStatusCoalescer<StatusUpdate>(isImmediateStatusEvent, {
      intervalMs: 100,
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const send = (event: StatusUpdate) => sent.push(event.status.messageCount ?? -1);

    coalescer.publish("s1:status.update", statusUpdate(1), send);
    clock.advanceBy(20);
    coalescer.publish("s1:status.update", statusUpdate(2), send);
    clock.advanceBy(40);
    coalescer.publish("s1:status.update", statusUpdate(3), send);

    expect(sent).toEqual([1]);
    expect(clock.timerCount).toBe(1);

    clock.advanceBy(39);
    expect(sent).toEqual([1]);

    clock.advanceBy(1);
    expect(sent).toEqual([1, 3]);
    expect(clock.timerCount).toBe(0);
  });

  it("sends an urgent status control transition immediately and cancels a stale pending update", () => {
    const clock = new FakeClock();
    const sent: number[] = [];
    const coalescer = new SessionStatusCoalescer<StatusUpdate>(isImmediateStatusEvent, {
      intervalMs: 100,
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const send = (event: StatusUpdate) => sent.push(event.status.messageCount ?? -1);

    coalescer.publish("s1:status.update", statusUpdate(1), send);
    clock.advanceBy(10);
    coalescer.publish("s1:status.update", statusUpdate(2), send);
    expect(clock.timerCount).toBe(1);

    clock.advanceBy(10);
    coalescer.publish("s1:status.update", statusUpdate(3, { isStreaming: true }), send);

    expect(sent).toEqual([1, 3]);
    expect(clock.timerCount).toBe(0);

    clock.advanceBy(100);
    expect(sent).toEqual([1, 3]);
  });

  it("trails timestamp-only activity updates and sends a phase, label, or detail change immediately", () => {
    const clock = new FakeClock();
    const sent: string[] = [];
    const coalescer = new SessionStatusCoalescer<ActivityUpdate>(isImmediateActivityEvent, {
      intervalMs: 100,
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const send = (event: ActivityUpdate) => sent.push(`${event.activity.phase}:${event.activity.label}:${event.activity.at}`);

    coalescer.publish("s1:activity.update", activityUpdate(), send);
    clock.advanceBy(10);
    coalescer.publish("s1:activity.update", activityUpdate({ at: "2026-08-01T00:00:01.000Z" }), send);

    expect(sent).toEqual(["active:receiving response:2026-08-01T00:00:00.000Z"]);

    clock.advanceBy(90);
    expect(sent).toEqual([
      "active:receiving response:2026-08-01T00:00:00.000Z",
      "active:receiving response:2026-08-01T00:00:01.000Z",
    ]);

    clock.advanceBy(10);
    coalescer.publish("s1:activity.update", activityUpdate({ phase: "idle", label: "idle" }), send);

    expect(sent).toEqual([
      "active:receiving response:2026-08-01T00:00:00.000Z",
      "active:receiving response:2026-08-01T00:00:01.000Z",
      "idle:idle:2026-08-01T00:00:00.000Z",
    ]);
  });

  it("tracks keys independently and clear/clearAll cancel trailing timers", () => {
    const clock = new FakeClock();
    const sent: number[] = [];
    const coalescer = new SessionStatusCoalescer<StatusUpdate>(isImmediateStatusEvent, {
      intervalMs: 100,
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const send = (event: StatusUpdate) => sent.push(event.status.messageCount ?? -1);

    coalescer.publish("s1:status.update", statusUpdate(1), send);
    coalescer.publish("s2:status.update", statusUpdate(10), send);
    clock.advanceBy(10);
    coalescer.publish("s1:status.update", statusUpdate(2), send);
    coalescer.publish("s2:status.update", statusUpdate(20), send);
    expect(clock.timerCount).toBe(2);

    coalescer.clear("s1:status.update");
    expect(clock.timerCount).toBe(1);
    coalescer.publish("s1:status.update", statusUpdate(3), send);
    expect(sent).toEqual([1, 10, 3]);

    coalescer.clearAll();
    expect(clock.timerCount).toBe(0);
    clock.advanceBy(100);
    expect(sent).toEqual([1, 10, 3]);
  });

  it("reschedules if a timer fires before the injected clock reaches its due time", () => {
    const clock = new FakeClock();
    const sent: number[] = [];
    const coalescer = new SessionStatusCoalescer<StatusUpdate>(isImmediateStatusEvent, {
      intervalMs: 100,
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const send = (event: StatusUpdate) => sent.push(event.status.messageCount ?? -1);

    coalescer.publish("s1:status.update", statusUpdate(1), send);
    clock.advanceBy(10);
    coalescer.publish("s1:status.update", statusUpdate(2), send);

    clock.fireNextTimerEarly();
    expect(sent).toEqual([1]);
    expect(clock.timerCount).toBe(1);

    clock.advanceBy(89);
    expect(sent).toEqual([1]);
    clock.advanceBy(1);
    expect(sent).toEqual([1, 2]);
  });
});
