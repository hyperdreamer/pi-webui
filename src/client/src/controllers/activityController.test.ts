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
});
