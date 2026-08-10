import { describe, expect, it, vi } from "vitest";
import type { AppState } from "../appState";
import { initialAppState } from "../appState";
import type { WorkspaceActivity, WorkspaceActivityResponse } from "../api";
import { ActivityController } from "./activityController";

function activity(cwd: string, patch: Partial<WorkspaceActivity> = {}): WorkspaceActivity {
  return { cwd, hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "now", ...patch };
}

function snapshot(...workspaces: WorkspaceActivity[]): WorkspaceActivityResponse {
  return { workspaces, generatedAt: "now" };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveDeferred: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolveDeferred = resolve; });
  if (resolveDeferred === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolveDeferred };
}

describe("ActivityController", () => {
  it("stores workspace activity under the requested machine", async () => {
    let state: AppState = { ...initialAppState(), selectedMachine: { id: "remote", name: "Remote", kind: "remote", createdAt: "now", updatedAt: "now" } };
    const controller = new ActivityController(() => state, (patch) => { state = { ...state, ...patch }; }, {
      api: { workspaceActivity: (machineId) => Promise.resolve(machineId === "remote" ? snapshot(activity("/remote")) : snapshot(activity("/local"))) },
    });

    await controller.refresh("remote");
    await controller.refresh("local");

    expect(state.workspaceActivities).toEqual({ "/remote": activity("/remote") });
    expect(state.machineActivities).toEqual({
      remote: { "/remote": activity("/remote") },
      local: { "/local": activity("/local") },
    });
  });

  it("shares duplicate requests and runs one trailing refresh requested during the active fetch", async () => {
    const firstSnapshot = deferred<WorkspaceActivityResponse>();
    const trailingSnapshot = deferred<WorkspaceActivityResponse>();
    const trailingStarted = deferred<undefined>();
    let calls = 0;
    let state: AppState = { ...initialAppState(), selectedMachine: { id: "local", name: "Local", kind: "local", createdAt: "now", updatedAt: "now" } };
    const controller = new ActivityController(() => state, (patch) => { state = { ...state, ...patch }; }, {
      api: {
        workspaceActivity: () => {
          calls += 1;
          if (calls === 2) trailingStarted.resolve(undefined);
          return calls === 1 ? firstSnapshot.promise : trailingSnapshot.promise;
        },
      },
    });

    const first = controller.refresh("local");
    const duplicate = controller.refresh("local");
    await Promise.resolve();

    expect(calls).toBe(1);

    const later = controller.refresh("local");
    const laterDuplicate = controller.refresh("local");
    firstSnapshot.resolve(snapshot(activity("/stale")));
    await trailingStarted.promise;

    expect(calls).toBe(2);

    trailingSnapshot.resolve(snapshot(activity("/fresh")));
    await Promise.all([first, duplicate, later, laterDuplicate]);

    expect(calls).toBe(2);
    expect(state.workspaceActivities).toEqual({ "/fresh": activity("/fresh") });
  });

  it("applies live activity updates to the owning machine only", () => {
    let state: AppState = { ...initialAppState(), selectedMachine: { id: "local", name: "Local", kind: "local", createdAt: "now", updatedAt: "now" } };
    const controller = new ActivityController(() => state, (patch) => { state = { ...state, ...patch }; });

    controller.applyWorkspaceActivity(activity("/remote"), "remote");
    controller.applyWorkspaceActivity(activity("/local"), "local");

    expect(state.workspaceActivities).toEqual({ "/local": activity("/local") });
    expect(state.machineActivities["remote"]).toEqual({ "/remote": activity("/remote") });
    expect(state.machineActivities["local"]).toEqual({ "/local": activity("/local") });
  });

  it("notifies ownership discovery after snapshots and live updates are applied", async () => {
    let state: AppState = { ...initialAppState(), selectedMachine: { id: "local", name: "Local", kind: "local", createdAt: "now", updatedAt: "now" } };
    const observedActivities: Record<string, WorkspaceActivity>[] = [];
    const onActivityApplied = vi.fn((machineId: string) => {
      expect(machineId).toBe("local");
      observedActivities.push(state.workspaceActivities);
    });
    const controller = new ActivityController(() => state, (patch) => { state = { ...state, ...patch }; }, {
      api: { workspaceActivity: () => Promise.resolve(snapshot(activity("/snapshot"))) },
      onActivityApplied,
    });

    await controller.refresh("local");
    controller.applyWorkspaceActivity(activity("/live"), "local");

    expect(onActivityApplied).toHaveBeenCalledTimes(2);
    expect(observedActivities).toEqual([
      { "/snapshot": activity("/snapshot") },
      { "/snapshot": activity("/snapshot"), "/live": activity("/live") },
    ]);
  });

  // A busy background session republishes workspace activity continuously, but
  // only the session/terminal flags are rendered. Applying a heartbeat whose
  // flags are unchanged rewrote both activity maps and rerendered the whole app
  // for no visible reason; measured on a live tab as 138 of 138 idle events.
  it("ignores a heartbeat whose visible activity flags did not change", () => {
    let state: AppState = { ...initialAppState(), selectedMachine: { id: "local", name: "Local", kind: "local", createdAt: "now", updatedAt: "now" } };
    let writes = 0;
    const onActivityApplied = vi.fn();
    const controller = new ActivityController(() => state, (patch) => { writes += 1; state = { ...state, ...patch }; }, { onActivityApplied });

    controller.applyWorkspaceActivity(activity("/repo"), "local");
    const afterFirstApply = writes;
    const publishedActivities = state.workspaceActivities;

    controller.applyWorkspaceActivity(activity("/repo", { updatedAt: "heartbeat-1" }), "local");
    controller.applyWorkspaceActivity(activity("/repo", { updatedAt: "heartbeat-2" }), "local");

    expect(writes).toBe(afterFirstApply);
    expect(state.workspaceActivities).toBe(publishedActivities);
    expect(onActivityApplied).toHaveBeenCalledTimes(1);
  });

  it("applies a heartbeat that turns terminal activity on for an already-active workspace", () => {
    let state: AppState = { ...initialAppState(), selectedMachine: { id: "local", name: "Local", kind: "local", createdAt: "now", updatedAt: "now" } };
    const controller = new ActivityController(() => state, (patch) => { state = { ...state, ...patch }; });

    controller.applyWorkspaceActivity(activity("/repo"), "local");
    controller.applyWorkspaceActivity(activity("/repo", { hasTerminalActivity: true }), "local");

    expect(state.workspaceActivities["/repo"]).toEqual(activity("/repo", { hasTerminalActivity: true }));
  });

  it("applies a heartbeat that ends activity so the indicator can clear", () => {
    let state: AppState = { ...initialAppState(), selectedMachine: { id: "local", name: "Local", kind: "local", createdAt: "now", updatedAt: "now" } };
    const controller = new ActivityController(() => state, (patch) => { state = { ...state, ...patch }; });

    controller.applyWorkspaceActivity(activity("/repo"), "local");
    controller.applyWorkspaceActivity(activity("/repo", { hasSessionActivity: false }), "local");

    expect(state.workspaceActivities).toEqual({});
  });

  // An inactive heartbeat for a workspace that is already absent is also a
  // no-op, and must not resurrect an entry or rewrite the maps.
  it("ignores an inactive heartbeat for a workspace that is not tracked", () => {
    let state: AppState = { ...initialAppState(), selectedMachine: { id: "local", name: "Local", kind: "local", createdAt: "now", updatedAt: "now" } };
    let writes = 0;
    const controller = new ActivityController(() => state, (patch) => { writes += 1; state = { ...state, ...patch }; });

    controller.applyWorkspaceActivity(activity("/idle", { hasSessionActivity: false }), "local");

    expect(writes).toBe(0);
    expect(state.workspaceActivities).toEqual({});
  });

  // The guard compares against the machine that owns the activity. A heartbeat
  // for a non-selected machine must not be judged against the selected
  // machine's map, or a real change would be dropped.
  it("applies an unselected machine's first activity even when the selected machine tracks that cwd", () => {
    let state: AppState = { ...initialAppState(), selectedMachine: { id: "local", name: "Local", kind: "local", createdAt: "now", updatedAt: "now" } };
    const controller = new ActivityController(() => state, (patch) => { state = { ...state, ...patch }; });

    controller.applyWorkspaceActivity(activity("/repo"), "local");
    controller.applyWorkspaceActivity(activity("/repo"), "remote");

    expect(state.machineActivities["remote"]).toEqual({ "/repo": activity("/repo") });
    expect(state.machineActivities["local"]).toEqual({ "/repo": activity("/repo") });
  });
});
