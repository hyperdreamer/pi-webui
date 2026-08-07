import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionEventHub, type RealtimeSocket } from "./sessionEventHub.js";

class FakeSocket extends EventEmitter implements RealtimeSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  send = vi.fn();
  terminate = vi.fn();
}

class FakeClock {
  now = 1_000;

  constructor() {
    vi.useFakeTimers();
    vi.setSystemTime(this.now);
  }

  readonly setTimeout = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => setTimeout(callback, delayMs);

  readonly clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
    clearTimeout(handle);
  };

  advanceBy(durationMs: number): void {
    this.now += durationMs;
    vi.advanceTimersByTime(durationMs);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

function status(messageCount: number) {
  return {
    sessionId: "s1",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    messageCount,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}

function activity(at: string, overrides: { phase?: "active" | "idle" | "error"; label?: string; detail?: string } = {}) {
  return {
    sessionId: "s1",
    phase: "active" as const,
    label: "receiving response",
    at,
    ...overrides,
  };
}

describe("SessionEventHub", () => {
  it("publishes session events only to sockets for that session", () => {
    const hub = new SessionEventHub();
    const sessionSocket = new FakeSocket();
    const otherSocket = new FakeSocket();
    hub.add("s1", sessionSocket);
    hub.add("s2", otherSocket);

    hub.publish("s1", { type: "assistant.delta", text: "hello" });

    expect(sessionSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: "assistant.delta", text: "hello", seq: 1 }));
    expect(otherSocket.send).not.toHaveBeenCalled();
  });

  it("keeps notification inbox events session-scoped and sequence-stamped", () => {
    const hub = new SessionEventHub();
    const sessionSocket = new FakeSocket();
    const otherSocket = new FakeSocket();
    hub.add("s1", sessionSocket);
    hub.add("s2", otherSocket);
    const notification = { id: "daemon-test:1", message: "notice", truncated: false, severity: "warning" as const, receivedAt: "2026-01-01T00:00:00.000Z", order: 1 };
    const summary = { sessionId: "s1", cwd: "/workspace", inboxRevision: 1, retainedCount: 1, discardedCount: 0, highestSeverity: "warning" as const };

    hub.publish("s1", {
      type: "notifications.inbox",
      daemonInstanceId: "daemon-test",
      catalogRevision: 1,
      summary,
      dismissThrough: { order: 1, overflowWatermark: 0 },
      delta: { kind: "added", notification },
    });

    expect(sessionSocket.send).toHaveBeenCalledWith(JSON.stringify({
      type: "notifications.inbox",
      daemonInstanceId: "daemon-test",
      catalogRevision: 1,
      summary,
      dismissThrough: { order: 1, overflowWatermark: 0 },
      delta: { kind: "added", notification },
      seq: 1,
    }));
    expect(otherSocket.send).not.toHaveBeenCalled();
  });

  it("omits thinking signatures from final-message payloads without mutating source events", () => {
    const hub = new SessionEventHub();
    const socket = new FakeSocket();
    hub.add("s1", socket);
    const thinkingBlock = { type: "thinking", thinking: "private chain", thinkingSignature: "opaque-provider-payload", redacted: true };
    const message = { role: "assistant", content: [thinkingBlock, { type: "text", text: "visible answer" }] };

    hub.publish("s1", { type: "message.end", message });

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({
      type: "message.end",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "private chain", redacted: true }, { type: "text", text: "visible answer" }] },
      seq: 1,
    }));
    expect(thinkingBlock.thinkingSignature).toBe("opaque-provider-payload");
  });

  it("removes session sockets on close and skips non-open sockets", () => {
    const hub = new SessionEventHub();
    const closed = new FakeSocket();
    const removed = new FakeSocket();
    closed.readyState = 3;
    hub.add("s1", closed);
    hub.add("s1", removed);
    removed.emit("close");

    hub.publish("s1", { type: "session.error", message: "boom" });

    expect(closed.send).not.toHaveBeenCalled();
    expect(removed.send).not.toHaveBeenCalled();
  });

  it("terminates a failed session socket without disrupting healthy delivery or sequence watermarks", () => {
    const hub = new SessionEventHub();
    const failed = new FakeSocket();
    const healthy = new FakeSocket();
    failed.send.mockImplementation(() => { throw new Error("socket closed"); });
    hub.add("s1", failed);
    hub.add("s1", healthy);

    hub.publish("s1", { type: "assistant.delta", text: "hello" });

    expect(failed.send).toHaveBeenCalledOnce();
    expect(failed.terminate).toHaveBeenCalledOnce();
    expect(healthy.send).toHaveBeenCalledWith(JSON.stringify({ type: "assistant.delta", text: "hello", seq: 1 }));
    expect(hub.currentSeq("s1")).toBe(1);

    failed.send.mockClear();
    hub.publish("s1", { type: "assistant.delta", text: "again" });

    expect(failed.send).not.toHaveBeenCalled();
    expect(failed.terminate).toHaveBeenCalledOnce();
    expect(healthy.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "assistant.delta", text: "again", seq: 2 }));
    expect(hub.currentSeq("s1")).toBe(2);
  });

  it("terminates a stalled global socket and removes it from fan-out while healthy sockets keep receiving", () => {
    const clock = new FakeClock();
    const hub = new SessionEventHub({
      slowConsumer: { softLimitBytes: 10, stallWindowMs: 0, now: () => clock.now },
    });
    const stalled = new FakeSocket();
    const healthy = new FakeSocket();
    stalled.bufferedAmount = 100;
    hub.addGlobal(stalled);
    hub.addGlobal(healthy);

    hub.publishGlobal({ type: "session.name", sessionId: "s1", name: "first" });
    clock.advanceBy(10);
    hub.publishGlobal({ type: "session.name", sessionId: "s1", name: "second" });

    expect(stalled.terminate).toHaveBeenCalledOnce();
    expect(stalled.send).toHaveBeenCalledTimes(1);
    expect(healthy.send).toHaveBeenNthCalledWith(1, JSON.stringify({ type: "session.name", sessionId: "s1", name: "first" }));
    expect(healthy.send).toHaveBeenNthCalledWith(2, JSON.stringify({ type: "session.name", sessionId: "s1", name: "second" }));
  });

  it("keeps per-session sequence numbering intact after dropping a stalled socket", () => {
    const clock = new FakeClock();
    const hub = new SessionEventHub({
      slowConsumer: { softLimitBytes: 10, stallWindowMs: 0, now: () => clock.now },
    });
    const stalled = new FakeSocket();
    const healthy = new FakeSocket();
    stalled.bufferedAmount = 100;
    hub.add("s1", stalled);
    hub.add("s1", healthy);

    hub.publish("s1", { type: "assistant.delta", text: "a" });
    clock.advanceBy(10);
    hub.publish("s1", { type: "assistant.delta", text: "b" });
    hub.publish("s1", { type: "assistant.delta", text: "c" });

    expect(hub.currentSeq("s1")).toBe(3);
    expect(stalled.terminate).toHaveBeenCalledOnce();
    expect(stalled.send).toHaveBeenCalledTimes(1);
    expect(healthy.send).toHaveBeenNthCalledWith(1, JSON.stringify({ type: "assistant.delta", text: "a", seq: 1 }));
    expect(healthy.send).toHaveBeenNthCalledWith(2, JSON.stringify({ type: "assistant.delta", text: "b", seq: 2 }));
    expect(healthy.send).toHaveBeenNthCalledWith(3, JSON.stringify({ type: "assistant.delta", text: "c", seq: 3 }));
  });

  it("shares one slow-consumer guard across a socket's session and global registration", () => {
    const clock = new FakeClock();
    const hub = new SessionEventHub({
      slowConsumer: { softLimitBytes: 10, stallWindowMs: 50, now: () => clock.now },
    });
    const socket = new FakeSocket();
    socket.bufferedAmount = 100;
    hub.add("s1", socket);
    hub.addGlobal(socket);

    // Session channel starts the stall clock at t=1000; the later global
    // publish inherits it, so 70 ms of stall is already enough to terminate.
    hub.publish("s1", { type: "assistant.delta", text: "a" });
    clock.advanceBy(10);
    hub.publish("s1", { type: "assistant.delta", text: "b" });
    clock.advanceBy(60);
    hub.publishGlobal({ type: "session.name", sessionId: "s1", name: "Renamed" });

    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(socket.send).toHaveBeenCalledTimes(3);
  });

  it("publishes global events only to global sockets", () => {
    const hub = new SessionEventHub();
    const globalSocket = new FakeSocket();
    const sessionSocket = new FakeSocket();
    hub.addGlobal(globalSocket);
    hub.add("s1", sessionSocket);

    const status = {
      sessionId: "s1",
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    };

    hub.publishGlobal({ type: "status.update", status });

    expect(globalSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: "status.update", status }));
    expect(sessionSocket.send).not.toHaveBeenCalled();
  });

  it("publishes authoritative unread deltas only to global sockets", () => {
    const hub = new SessionEventHub();
    const globalSocket = new FakeSocket();
    const sessionSocket = new FakeSocket();
    hub.addGlobal(globalSocket);
    hub.add("s1", sessionSocket);
    const event = {
      type: "sessions.unread" as const,
      catalogId: "catalog-test",
      catalogRevision: 3,
      sessionId: "s1",
      cwd: "/workspace",
      unread: { sessionId: "s1", cwd: "/workspace", completionOrder: 2, completedAt: "2026-07-20T00:00:00.000Z" },
    };

    hub.publishGlobal(event);

    expect(globalSocket.send).toHaveBeenCalledWith(JSON.stringify(event));
    expect(sessionSocket.send).not.toHaveBeenCalled();
  });

  it("publishes notification summaries only to global sockets", () => {
    const hub = new SessionEventHub();
    const globalSocket = new FakeSocket();
    const sessionSocket = new FakeSocket();
    hub.addGlobal(globalSocket);
    hub.add("s1", sessionSocket);
    const summary = { sessionId: "s1", cwd: "/workspace", inboxRevision: 1, retainedCount: 1, discardedCount: 0, highestSeverity: "warning" as const };

    hub.publishNotificationSummary({
      type: "notifications.summary",
      daemonInstanceId: "daemon-test",
      catalogRevision: 1,
      summary,
    });

    expect(globalSocket.send).toHaveBeenCalledWith(JSON.stringify({
      type: "notifications.summary",
      daemonInstanceId: "daemon-test",
      catalogRevision: 1,
      summary,
    }));
    expect(sessionSocket.send).not.toHaveBeenCalled();
  });

  it("contains termination failures while publishing unstamped global events", () => {
    const hub = new SessionEventHub();
    const failed = new FakeSocket();
    const healthy = new FakeSocket();
    failed.send.mockImplementation(() => { throw new Error("socket closed"); });
    failed.terminate.mockImplementation(() => { throw new Error("termination failed"); });
    hub.addGlobal(failed);
    hub.addGlobal(healthy);

    hub.publishGlobal({ type: "session.name", sessionId: "s1", name: "Renamed" });

    expect(failed.send).toHaveBeenCalledOnce();
    expect(failed.terminate).toHaveBeenCalledOnce();
    expect(healthy.send).toHaveBeenCalledWith(JSON.stringify({ type: "session.name", sessionId: "s1", name: "Renamed" }));

    failed.send.mockClear();
    hub.publishGlobal({ type: "session.name", sessionId: "s1", name: "Renamed again" });

    expect(failed.send).not.toHaveBeenCalled();
    expect(failed.terminate).toHaveBeenCalledOnce();
    expect(healthy.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "session.name", sessionId: "s1", name: "Renamed again" }));
  });

  it("stamps a monotonically increasing per-session seq on published events", () => {
    const hub = new SessionEventHub();
    const socket = new FakeSocket();
    hub.add("s1", socket);

    hub.publish("s1", { type: "assistant.delta", text: "a" });
    hub.publish("s1", { type: "assistant.delta", text: "b" });
    hub.publish("s1", { type: "assistant.delta", text: "c" });

    expect(socket.send).toHaveBeenNthCalledWith(1, JSON.stringify({ type: "assistant.delta", text: "a", seq: 1 }));
    expect(socket.send).toHaveBeenNthCalledWith(2, JSON.stringify({ type: "assistant.delta", text: "b", seq: 2 }));
    expect(socket.send).toHaveBeenNthCalledWith(3, JSON.stringify({ type: "assistant.delta", text: "c", seq: 3 }));
  });

  it("advances seq even when no sockets are attached so the watermark stays accurate", () => {
    const hub = new SessionEventHub();

    hub.publish("s1", { type: "assistant.delta", text: "a" });
    hub.publish("s1", { type: "assistant.delta", text: "b" });

    expect(hub.currentSeq("s1")).toBe(2);

    const socket = new FakeSocket();
    hub.add("s1", socket);
    hub.publish("s1", { type: "assistant.delta", text: "c" });

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "assistant.delta", text: "c", seq: 3 }));
  });

  it("tracks seq independently per session", () => {
    const hub = new SessionEventHub();
    const s1 = new FakeSocket();
    const s2 = new FakeSocket();
    hub.add("s1", s1);
    hub.add("s2", s2);

    hub.publish("s1", { type: "assistant.delta", text: "a" });
    hub.publish("s1", { type: "assistant.delta", text: "b" });
    hub.publish("s2", { type: "assistant.delta", text: "x" });

    expect(hub.currentSeq("s1")).toBe(2);
    expect(hub.currentSeq("s2")).toBe(1);
    expect(s1.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "assistant.delta", text: "b", seq: 2 }));
    expect(s2.send).toHaveBeenCalledWith(JSON.stringify({ type: "assistant.delta", text: "x", seq: 1 }));
  });

  it("reports zero seq for a session that has never published", () => {
    const hub = new SessionEventHub();
    expect(hub.currentSeq("never")).toBe(0);
  });

  it("does not stamp seq on global events", () => {
    const hub = new SessionEventHub();
    const globalSocket = new FakeSocket();
    hub.addGlobal(globalSocket);

    hub.publishGlobal({ type: "session.name", sessionId: "s1", name: "Renamed" });

    expect(globalSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: "session.name", sessionId: "s1", name: "Renamed" }));
  });

  it("gives a delayed status update its sequence only when its timer sends it", () => {
    const clock = new FakeClock();
    const hub = new SessionEventHub({
      intervalMs: 100,
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const socket = new FakeSocket();
    hub.add("s1", socket);

    hub.publish("s1", { type: "status.update", status: status(1) });
    clock.advanceBy(10);
    hub.publish("s1", { type: "status.update", status: status(2) });
    hub.publish("s1", { type: "assistant.delta", text: "after status" });

    expect(socket.send).toHaveBeenCalledTimes(2);
    expect(hub.currentSeq("s1")).toBe(2);
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "assistant.delta", text: "after status", seq: 2 }));

    clock.advanceBy(90);

    expect(hub.currentSeq("s1")).toBe(3);
    expect(socket.send).toHaveBeenNthCalledWith(3, JSON.stringify({ type: "status.update", status: status(2), seq: 3 }));
  });

  it("coalesces timestamp-only activity updates on the session channel", () => {
    const clock = new FakeClock();
    const hub = new SessionEventHub({
      intervalMs: 100,
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const socket = new FakeSocket();
    hub.add("s1", socket);

    hub.publish("s1", { type: "activity.update", activity: activity("2026-08-01T00:00:00.000Z") });
    clock.advanceBy(10);
    hub.publish("s1", { type: "activity.update", activity: activity("2026-08-01T00:00:01.000Z") });

    expect(socket.send).toHaveBeenCalledTimes(1);

    clock.advanceBy(90);

    expect(socket.send).toHaveBeenNthCalledWith(2, JSON.stringify({
      type: "activity.update",
      activity: activity("2026-08-01T00:00:01.000Z"),
      seq: 2,
    }));
  });

  it("keeps session and global coalescing state independent", () => {
    const clock = new FakeClock();
    const hub = new SessionEventHub({
      intervalMs: 100,
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const sessionSocket = new FakeSocket();
    const globalSocket = new FakeSocket();
    hub.add("s1", sessionSocket);
    hub.addGlobal(globalSocket);

    hub.publish("s1", { type: "status.update", status: status(1) });
    clock.advanceBy(10);
    hub.publishGlobal({ type: "status.update", status: status(1) });
    hub.publish("s1", { type: "status.update", status: status(2) });
    hub.publishGlobal({ type: "status.update", status: status(2) });

    expect(sessionSocket.send).toHaveBeenCalledTimes(1);
    expect(globalSocket.send).toHaveBeenCalledTimes(1);

    clock.advanceBy(90);

    expect(sessionSocket.send).toHaveBeenNthCalledWith(2, JSON.stringify({ type: "status.update", status: status(2), seq: 2 }));
    expect(globalSocket.send).toHaveBeenCalledTimes(1);

    clock.advanceBy(10);

    expect(globalSocket.send).toHaveBeenNthCalledWith(2, JSON.stringify({ type: "status.update", status: status(2) }));
  });

  it("never delays or coalesces transcript, error, name, or notification events", () => {
    const clock = new FakeClock();
    const hub = new SessionEventHub({
      intervalMs: 100,
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    const sessionSocket = new FakeSocket();
    const globalSocket = new FakeSocket();
    hub.add("s1", sessionSocket);
    hub.addGlobal(globalSocket);
    const notification = { id: "daemon-test:1", message: "notice", truncated: false, severity: "warning" as const, receivedAt: "2026-08-01T00:00:00.000Z", order: 1 };
    const summary = { sessionId: "s1", cwd: "/workspace", inboxRevision: 1, retainedCount: 1, discardedCount: 0, highestSeverity: "warning" as const };

    hub.publish("s1", { type: "status.update", status: status(1) });
    clock.advanceBy(10);
    hub.publish("s1", { type: "status.update", status: status(2) });
    hub.publish("s1", { type: "assistant.delta", text: "a" });
    hub.publish("s1", { type: "assistant.delta", text: "b" });
    hub.publish("s1", { type: "session.error", message: "first" });
    hub.publish("s1", { type: "session.error", message: "second" });
    hub.publish("s1", { type: "session.name", sessionId: "s1", name: "first" });
    hub.publish("s1", { type: "session.name", sessionId: "s1", name: "second" });
    hub.publish("s1", {
      type: "notifications.inbox",
      daemonInstanceId: "daemon-test",
      catalogRevision: 1,
      summary,
      dismissThrough: { order: 1, overflowWatermark: 0 },
      delta: { kind: "added", notification },
    });
    hub.publish("s1", {
      type: "notifications.inbox",
      daemonInstanceId: "daemon-test",
      catalogRevision: 2,
      summary: { ...summary, inboxRevision: 2 },
      dismissThrough: { order: 1, overflowWatermark: 0 },
      delta: { kind: "added", notification: { ...notification, id: "daemon-test:2", order: 2 } },
    });
    hub.publishGlobal({ type: "session.name", sessionId: "s1", name: "first" });
    hub.publishGlobal({ type: "session.name", sessionId: "s1", name: "second" });
    hub.publishNotificationSummary({ type: "notifications.summary", daemonInstanceId: "daemon-test", catalogRevision: 1, summary });
    hub.publishNotificationSummary({ type: "notifications.summary", daemonInstanceId: "daemon-test", catalogRevision: 2, summary: { ...summary, inboxRevision: 2 } });

    expect(sessionSocket.send).toHaveBeenCalledTimes(9);
    expect(hub.currentSeq("s1")).toBe(9);
    expect(globalSocket.send).toHaveBeenCalledTimes(4);
  });
});
