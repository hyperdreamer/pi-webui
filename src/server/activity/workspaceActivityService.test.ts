import { describe, expect, it } from "vitest";
import type { RealtimeEvent, SessionStatus } from "../../shared/apiTypes";
import { WorkspaceActivityService } from "./workspaceActivityService";

function status(patch: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionId: "s1",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    ...patch,
  };
}

describe("WorkspaceActivityService", () => {
  it("publishes and snapshots session activity by cwd", () => {
    const events: RealtimeEvent[] = [];
    const service = new WorkspaceActivityService({ publishRealtime: (event) => events.push(event) });

    service.applySessionStatus("/repo", status({ isStreaming: true }));

    expect(service.snapshot().workspaces).toMatchObject([{ cwd: "/repo", hasSessionActivity: true, hasTerminalActivity: false }]);
    expect(events.at(-1)).toMatchObject({ type: "workspace.activity", activity: { cwd: "/repo", hasSessionActivity: true, hasTerminalActivity: false } });

    service.applySessionStatus("/repo", status({ isStreaming: false }));

    expect(service.snapshot().workspaces).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "workspace.activity", activity: { cwd: "/repo", hasSessionActivity: false, hasTerminalActivity: false } });
  });

  it("clears stale active activity when an idle status arrives", () => {
    const events: RealtimeEvent[] = [];
    const service = new WorkspaceActivityService({ publishRealtime: (event) => events.push(event) });

    service.applySessionActivity("/repo", { sessionId: "s1", phase: "active", label: "running tool", detail: "read", at: "now" });
    service.applySessionStatus("/repo", status({ isStreaming: false }));

    expect(service.snapshot().workspaces).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "workspace.activity", activity: { cwd: "/repo", hasSessionActivity: false, hasTerminalActivity: false } });
  });

  it("publishes a clear event when removing an already-pruned session with a cwd", () => {
    const events: RealtimeEvent[] = [];
    const service = new WorkspaceActivityService({ publishRealtime: (event) => events.push(event) });

    service.removeSession("missing-session", "/repo");

    expect(events.at(-1)).toMatchObject({ type: "workspace.activity", activity: { cwd: "/repo", hasSessionActivity: false, hasTerminalActivity: false } });
  });

  it("reconciles stale session activity for a workspace", () => {
    const events: RealtimeEvent[] = [];
    const service = new WorkspaceActivityService({ publishRealtime: (event) => events.push(event) });

    service.applySessionActivity("/repo", { sessionId: "s1", phase: "active", label: "running tool", at: "now" });
    service.applySessionActivity("/repo", { sessionId: "s2", phase: "active", label: "running tool", at: "now" });
    service.applySessionActivity("/other", { sessionId: "s3", phase: "active", label: "running tool", at: "now" });

    service.reconcileSessionActivity("/repo", ["s2"]);

    expect(service.snapshot().workspaces).toMatchObject([
      { cwd: "/other", hasSessionActivity: true, hasTerminalActivity: false },
      { cwd: "/repo", hasSessionActivity: true, hasTerminalActivity: false },
    ]);

    service.reconcileSessionActivity("/repo", []);

    expect(service.snapshot().workspaces).toMatchObject([{ cwd: "/other", hasSessionActivity: true, hasTerminalActivity: false }]);
    expect(events.at(-1)).toMatchObject({ type: "workspace.activity", activity: { cwd: "/repo", hasSessionActivity: false, hasTerminalActivity: false } });
  });

  it("combines sessions and terminals and clears closed terminals", () => {
    const events: RealtimeEvent[] = [];
    const service = new WorkspaceActivityService({ publishRealtime: (event) => events.push(event) });

    service.applySessionActivity("/repo", { sessionId: "s1", phase: "active", label: "running tool", detail: "read", at: "now" });
    service.updateTerminal({ id: "t1", cwd: "/repo", exited: false });

    expect(service.snapshot().workspaces).toMatchObject([{ cwd: "/repo", hasSessionActivity: true, hasTerminalActivity: true }]);

    service.removeSession("s1");
    service.updateTerminal({ id: "t1", cwd: "/repo", exited: true });

    expect(service.snapshot().workspaces).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "workspace.activity", activity: { cwd: "/repo", hasSessionActivity: false, hasTerminalActivity: false } });
  });
});
