import { describe, expect, it } from "vitest";
import type { SessionActivity, SessionInfo, SessionStatus } from "./api";
import { createSessionActivityResolver, sessionActivityIndicators } from "./sessionActivity";

const idleStatus = (sessionId: string, patch: Partial<SessionStatus> = {}): SessionStatus => ({
  sessionId,
  isStreaming: false,
  isCompacting: false,
  isBashRunning: false,
  pendingMessageCount: 0,
  queuedMessages: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
  ...patch,
});

const session = (id: string, patch: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  path: `/sessions/${id}.jsonl`,
  cwd: "/workspace",
  created: "2026-07-29T00:00:00.000Z",
  modified: "2026-07-29T00:00:00.000Z",
  messageCount: 1,
  firstMessage: id,
  ...patch,
});

const activity = (sessionId: string, patch: Partial<SessionActivity> = {}): SessionActivity => ({
  sessionId,
  phase: "idle",
  label: "idle",
  at: "2026-07-29T00:00:00.000Z",
  ...patch,
});

describe("sessionActivityIndicators", () => {
  it("shows a shaped descendant-work marker for recursively active child work", () => {
    const parent = session("parent");
    const child = session("child", { parentSessionPath: parent.path });
    const grandchild = session("grandchild", { parentSessionPath: child.path });

    expect(sessionActivityIndicators(parent, [parent, child, grandchild], {
      statuses: { [grandchild.id]: idleStatus(grandchild.id, { isStreaming: true }) },
    })).toEqual([
      { kind: "descendant", count: 1, label: "1 subsession working" },
    ]);
  });

  it("keeps direct work and descendant work distinct", () => {
    const parent = session("parent");
    const child = session("child", { parentSessionPath: parent.path });

    expect(sessionActivityIndicators(parent, [parent, child], {
      statuses: {
        [parent.id]: idleStatus(parent.id, { isStreaming: true }),
        [child.id]: idleStatus(child.id, { isBashRunning: true }),
      },
    })).toEqual([
      { kind: "session", label: "This session is working" },
      { kind: "descendant", count: 1, label: "1 subsession working" },
    ]);
  });

  it("surfaces attention from the session tree without pretending an idle tree is active", () => {
    const parent = session("parent");
    const child = session("child", { parentSessionPath: parent.path });

    expect(sessionActivityIndicators(parent, [parent, child], {
      activities: { [child.id]: activity(child.id, { phase: "error", label: "tool failed" }) },
    })).toEqual([
      { kind: "attention", count: 1, label: "1 subsession needs attention" },
    ]);
  });

  it("describes direct and descendant attention as separate sources", () => {
    const parent = session("parent");
    const child = session("child", { parentSessionPath: parent.path });

    expect(sessionActivityIndicators(parent, [parent, child], {
      activities: {
        [parent.id]: activity(parent.id, { phase: "error", label: "parent failed" }),
        [child.id]: activity(child.id, { phase: "error", label: "child failed" }),
      },
    })).toEqual([
      { kind: "attention", count: 2, label: "This session and 1 subsession need attention" },
    ]);
  });

  it("indexes the session collection once for multiple indicator lookups", () => {
    const parent = session("parent");
    const child = session("child", { parentSessionPath: parent.path });
    const sessions = new CountingSessionCollection(parent, child);

    const indicatorsFor = createSessionActivityResolver(sessions);
    indicatorsFor(parent);
    indicatorsFor(child);

    expect(sessions.iterations).toBe(1);
  });

  it("returns no marker for a read, idle session tree", () => {
    const parent = session("parent");
    const child = session("child", { parentSessionPath: parent.path });

    expect(sessionActivityIndicators(parent, [parent, child])).toEqual([]);
  });
});

class CountingSessionCollection extends Array<SessionInfo> {
  iterations = 0;

  override [Symbol.iterator](): ArrayIterator<SessionInfo> {
    this.iterations += 1;
    return super[Symbol.iterator]();
  }
}
