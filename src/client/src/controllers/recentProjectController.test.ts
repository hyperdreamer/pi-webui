import { describe, expect, it, vi } from "vitest";
import type { RecentProjectEntry } from "../../../shared/apiTypes";
import { HttpRequestError } from "../api";
import { RecentProjectController, type RecentProjectsState } from "./recentProjectController";

function entry(path: string, id = path): RecentProjectEntry {
  return { id, name: path.split("/").at(-1) ?? path, path, lastUsedAt: "2026-01-01T00:00:00.000Z" };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness(overrides: Partial<{
  recentProjects: (machineId?: string) => Promise<RecentProjectEntry[]>;
  recordRecentProject: (projectId: string, machineId?: string) => Promise<RecentProjectEntry[]>;
  removeRecentProject: (entryId: string, machineId?: string) => Promise<RecentProjectEntry[]>;
}> = {}, machineId = "local", reconcileProjects: (machineId: string) => Promise<boolean | undefined> = () => Promise.resolve(undefined)) {
  const states: RecentProjectsState[] = [];
  const errors: string[] = [];
  let current = machineId;
  const api = {
    recentProjects: overrides.recentProjects ?? (() => Promise.resolve([])),
    recordRecentProject: overrides.recordRecentProject ?? (() => Promise.resolve([])),
    removeRecentProject: overrides.removeRecentProject ?? (() => Promise.resolve([])),
  };
  const controller = new RecentProjectController({
    api,
    machineId: () => current,
    onChange: (state) => { states.push(state); },
    onBackgroundError: (operation) => { errors.push(operation); },
    reconcileProjects,
  });
  return { api, controller, errors, states, selectMachine: (next: string) => { current = next; } };
}

describe("RecentProjectController loading", () => {
  it("loads history for the selected machine", async () => {
    const recentProjects = vi.fn().mockResolvedValue([entry("/work/alpha")]);
    const { controller, states } = harness({ recentProjects }, "remote-a");

    await controller.load();

    expect(recentProjects).toHaveBeenCalledWith("remote-a");
    expect(states[0]).toEqual({ kind: "loading" });
    expect(controller.state).toEqual({ kind: "ready", entries: [entry("/work/alpha")] });
  });

  it("exposes a failure message and recovers on retry", async () => {
    const recentProjects = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([entry("/work/alpha")]);
    const { controller } = harness({ recentProjects });

    await controller.load();
    expect(controller.state).toEqual({ kind: "failed", message: "offline" });

    await controller.retry();
    expect(controller.state).toEqual({ kind: "ready", entries: [entry("/work/alpha")] });
  });

  it("discards a response that resolves after the machine changed", async () => {
    const pending = deferred<RecentProjectEntry[]>();
    const { controller, selectMachine } = harness({ recentProjects: () => pending.promise });

    const load = controller.load();
    selectMachine("remote-b");
    pending.resolve([entry("/work/stale")]);
    await load;

    expect(controller.state).toEqual({ kind: "loading" });
  });
});

describe("RecentProjectController recording work", () => {
  it("records work and applies the authoritative order", async () => {
    const recordRecentProject = vi.fn().mockResolvedValue([entry("/work/beta"), entry("/work/alpha")]);
    const { controller } = harness({
      recentProjects: () => Promise.resolve([entry("/work/alpha"), entry("/work/beta")]),
      recordRecentProject,
    });
    await controller.load();

    controller.recordWork("project-beta");
    await vi.waitFor(() => {
      expect(controller.state).toEqual({ kind: "ready", entries: [entry("/work/beta"), entry("/work/alpha")] });
    });
    expect(recordRecentProject).toHaveBeenCalledWith("project-beta", "local");
  });

  it("issues no request when the project is already newest", async () => {
    const recordRecentProject = vi.fn().mockResolvedValue([]);
    const { controller } = harness({
      recentProjects: () => Promise.resolve([entry("/work/alpha", "entry-alpha")]),
      recordRecentProject,
    });
    await controller.load();

    controller.recordWork("project-alpha");
    controller.recordWork("project-alpha");

    await vi.waitFor(() => { expect(recordRecentProject).toHaveBeenCalledTimes(1); });
    expect(recordRecentProject).toHaveBeenCalledWith("project-alpha", "local");
  });

  it("reports a failed touch as a background error and keeps the current order", async () => {
    const { controller, errors } = harness({
      recentProjects: () => Promise.resolve([entry("/work/alpha")]),
      recordRecentProject: () => Promise.reject(new Error("boom")),
    });
    await controller.load();

    controller.recordWork("project-beta");

    await vi.waitFor(() => { expect(errors).toEqual(["record recent project"]); });
    expect(controller.state).toEqual({ kind: "ready", entries: [entry("/work/alpha")] });
  });

  it("orders a later touch after an earlier load for the same machine", async () => {
    const staleLoad = deferred<RecentProjectEntry[]>();
    const acceptedTouch = deferred<RecentProjectEntry[]>();
    const recordRecentProject = vi.fn(() => acceptedTouch.promise);
    const { controller } = harness({
      recentProjects: () => staleLoad.promise,
      recordRecentProject,
    });

    const loading = controller.load();
    controller.recordWork("project-beta");
    await Promise.resolve();

    expect(recordRecentProject).not.toHaveBeenCalled();
    staleLoad.resolve([entry("/work/alpha"), entry("/work/beta")]);
    await loading;
    await vi.waitFor(() => { expect(recordRecentProject).toHaveBeenCalledTimes(1); });
    acceptedTouch.resolve([entry("/work/beta"), entry("/work/alpha")]);
    await vi.waitFor(() => {
      expect(controller.state).toEqual({ kind: "ready", entries: [entry("/work/beta"), entry("/work/alpha")] });
    });
  });

  it("records later work when an earlier reload invalidates the newest belief", async () => {
    const reload = deferred<RecentProjectEntry[]>();
    const recordRecentProject = vi.fn()
      .mockResolvedValueOnce([entry("/work/alpha"), entry("/work/beta")])
      .mockResolvedValueOnce([entry("/work/alpha"), entry("/work/beta")]);
    const recentProjects = vi.fn()
      .mockResolvedValueOnce([entry("/work/alpha"), entry("/work/beta")])
      .mockReturnValueOnce(reload.promise);
    const { controller } = harness({ recentProjects, recordRecentProject });

    await controller.load();
    controller.recordWork("project-alpha");
    await vi.waitFor(() => { expect(recordRecentProject).toHaveBeenCalledTimes(1); });

    const loading = controller.load();
    controller.recordWork("project-alpha");
    await Promise.resolve();

    expect(recordRecentProject).toHaveBeenCalledTimes(1);
    reload.resolve([entry("/work/beta"), entry("/work/alpha")]);
    await loading;
    await vi.waitFor(() => { expect(recordRecentProject).toHaveBeenCalledTimes(2); });

    expect(recordRecentProject).toHaveBeenLastCalledWith("project-alpha", "local");
    expect(controller.state).toEqual({
      kind: "ready",
      entries: [entry("/work/alpha"), entry("/work/beta")],
    });
  });

  it("preserves every distinct A-B-A intent in API issue order", async () => {
    const betaTouch = deferred<RecentProjectEntry[]>();
    const issued: string[] = [];
    const recordRecentProject = vi.fn((projectId: string) => {
      issued.push(projectId);
      if (issued.length === 1) return Promise.resolve([entry("/work/alpha"), entry("/work/beta")]);
      if (projectId === "project-beta") return betaTouch.promise;
      return Promise.resolve([entry("/work/alpha"), entry("/work/beta")]);
    });
    const { controller } = harness({
      recentProjects: () => Promise.resolve([entry("/work/alpha"), entry("/work/beta")]),
      recordRecentProject,
    });
    await controller.load();

    controller.recordWork("project-alpha");
    await vi.waitFor(() => { expect(issued).toEqual(["project-alpha"]); });

    controller.recordWork("project-beta");
    await vi.waitFor(() => { expect(issued).toEqual(["project-alpha", "project-beta"]); });
    controller.recordWork("project-alpha");

    expect(issued).toEqual(["project-alpha", "project-beta"]);
    betaTouch.resolve([entry("/work/beta"), entry("/work/alpha")]);

    await vi.waitFor(() => {
      expect(issued).toEqual(["project-alpha", "project-beta", "project-alpha"]);
      expect(controller.state).toEqual({ kind: "ready", entries: [entry("/work/alpha"), entry("/work/beta")] });
    });
  });

  it("collapses a failed same-project burst without clearing a newer queued intent", async () => {
    const betaTouch = deferred<RecentProjectEntry[]>();
    const issued: string[] = [];
    const recordRecentProject = vi.fn((projectId: string) => {
      issued.push(projectId);
      if (projectId === "project-alpha") return Promise.resolve([entry("/work/alpha"), entry("/work/beta")]);
      if (projectId === "project-beta" && issued.filter((id) => id === projectId).length === 1) return betaTouch.promise;
      if (projectId === "project-beta") return Promise.resolve([entry("/work/beta"), entry("/work/alpha")]);
      return Promise.resolve([entry("/work/gamma"), entry("/work/alpha"), entry("/work/beta")]);
    });
    const { controller, errors } = harness({
      recentProjects: () => Promise.resolve([entry("/work/alpha"), entry("/work/beta")]),
      recordRecentProject,
    });
    await controller.load();
    controller.recordWork("project-alpha");
    await vi.waitFor(() => { expect(issued).toEqual(["project-alpha"]); });

    controller.recordWork("project-beta");
    await vi.waitFor(() => { expect(issued).toEqual(["project-alpha", "project-beta"]); });
    controller.recordWork("project-beta");
    controller.recordWork("project-beta");
    controller.recordWork("project-gamma");
    betaTouch.reject(new Error("offline"));

    await vi.waitFor(() => {
      expect(errors).toEqual(["record recent project"]);
      expect(issued).toEqual(["project-alpha", "project-beta", "project-gamma"]);
      expect(controller.state).toEqual({
        kind: "ready",
        entries: [entry("/work/gamma"), entry("/work/alpha"), entry("/work/beta")],
      });
    });
  });

  it("retries a touch after the previous attempt failed", async () => {
    const recordRecentProject = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([entry("/work/beta"), entry("/work/alpha")]);
    const { controller, errors } = harness({
      recentProjects: () => Promise.resolve([entry("/work/alpha"), entry("/work/beta")]),
      recordRecentProject,
    });
    await controller.load();

    controller.recordWork("project-beta");
    await vi.waitFor(() => { expect(errors).toEqual(["record recent project"]); });
    controller.recordWork("project-beta");

    await vi.waitFor(() => { expect(recordRecentProject).toHaveBeenCalledTimes(2); });
    expect(controller.state).toEqual({ kind: "ready", entries: [entry("/work/beta"), entry("/work/alpha")] });
  });

  it("serializes mutations so an earlier response cannot overwrite a later one", async () => {
    const first = deferred<RecentProjectEntry[]>();
    const second = deferred<RecentProjectEntry[]>();
    const recordRecentProject = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { controller } = harness({
      recentProjects: () => Promise.resolve([entry("/work/alpha"), entry("/work/beta")]),
      recordRecentProject,
    });
    await controller.load();

    controller.recordWork("project-beta");
    controller.recordWork("project-alpha");
    second.resolve([entry("/work/alpha"), entry("/work/beta")]);
    first.resolve([entry("/work/beta"), entry("/work/alpha")]);

    await vi.waitFor(() => { expect(recordRecentProject).toHaveBeenCalledTimes(2); });
    expect(controller.state).toEqual({ kind: "ready", entries: [entry("/work/alpha"), entry("/work/beta")] });
  });
});

describe("RecentProjectController removing entries", () => {
  it("applies the authoritative list after removal", async () => {
    const removeRecentProject = vi.fn().mockResolvedValue([entry("/work/beta")]);
    const { controller } = harness({
      recentProjects: () => Promise.resolve([entry("/work/alpha"), entry("/work/beta")]),
      removeRecentProject,
    });
    await controller.load();

    await expect(controller.removeEntry("/work/alpha")).resolves.toEqual({ kind: "removed" });

    expect(removeRecentProject).toHaveBeenCalledWith("/work/alpha", "local");
    expect(controller.state).toEqual({ kind: "ready", entries: [entry("/work/beta")] });
  });

  it("orders a later removal after an earlier load for the same machine", async () => {
    const staleLoad = deferred<RecentProjectEntry[]>();
    const acceptedRemoval = deferred<RecentProjectEntry[]>();
    const removeRecentProject = vi.fn(() => acceptedRemoval.promise);
    const { controller } = harness({
      recentProjects: () => staleLoad.promise,
      removeRecentProject,
    });

    const loading = controller.load();
    const removing = controller.removeEntry("entry-alpha");
    await Promise.resolve();

    expect(removeRecentProject).not.toHaveBeenCalled();
    staleLoad.resolve([entry("/work/alpha"), entry("/work/beta")]);
    await loading;
    await vi.waitFor(() => { expect(removeRecentProject).toHaveBeenCalledTimes(1); });
    acceptedRemoval.resolve([entry("/work/beta")]);
    await removing;
    expect(controller.state).toEqual({ kind: "ready", entries: [entry("/work/beta")] });
  });

  it("returns a fully reconciled registered conflict without treating it as removal", async () => {
    const calls: string[] = [];
    const conflict = new HttpRequestError("Recent project is registered", 409);
    const recentProjects = vi.fn()
      .mockResolvedValueOnce([entry("/work/alpha")])
      .mockImplementationOnce(() => {
        calls.push("history");
        return Promise.resolve([entry("/work/alpha")]);
      });
    const reconcileProjects = vi.fn(() => {
      calls.push("catalog");
      return Promise.resolve(undefined);
    });
    const { controller } = harness({
      recentProjects,
      removeRecentProject: () => {
        calls.push("remove");
        return Promise.reject(conflict);
      },
    }, "local", reconcileProjects);
    await controller.load();

    await expect(controller.removeEntry("/work/alpha")).resolves.toEqual({ kind: "registered-conflict", error: conflict });

    expect(calls).toEqual(["remove", "catalog", "history"]);
    expect(recentProjects).toHaveBeenCalledTimes(2);
    expect(reconcileProjects).toHaveBeenCalledWith("local");
    expect(controller.state).toEqual({ kind: "ready", entries: [entry("/work/alpha")] });
  });

  it.each([
    ["catalog", false, true],
    ["history", true, false],
  ])("preserves the original conflict when %s reconciliation fails", async (_label, catalogSucceeds, historySucceeds) => {
    const conflict = new HttpRequestError("Recent project is registered", 409);
    const recentProjects = vi.fn()
      .mockResolvedValueOnce([entry("/work/alpha")])
      .mockImplementationOnce(() => historySucceeds
        ? Promise.resolve([entry("/work/alpha")])
        : Promise.reject(new Error("history offline")));
    const reconcileProjects = vi.fn(() => catalogSucceeds
      ? Promise.resolve(undefined)
      : Promise.reject(new Error("catalog offline")));
    const { controller } = harness({
      recentProjects,
      removeRecentProject: () => Promise.reject(conflict),
    }, "local", reconcileProjects);
    await controller.load();

    await expect(controller.removeEntry("/work/alpha")).rejects.toBe(conflict);

    expect(recentProjects).toHaveBeenCalledTimes(2);
    expect(reconcileProjects).toHaveBeenCalledWith("local");
  });

  it("does not reconcile a non-conflict removal failure", async () => {
    const failure = new HttpRequestError("Machine offline", 503);
    const recentProjects = vi.fn().mockResolvedValue([entry("/work/alpha")]);
    const reconcileProjects = vi.fn(() => Promise.resolve(undefined));
    const { controller } = harness({
      recentProjects,
      removeRecentProject: () => Promise.reject(failure),
    }, "local", reconcileProjects);
    await controller.load();

    await expect(controller.removeEntry("/work/alpha")).rejects.toBe(failure);

    expect(recentProjects).toHaveBeenCalledTimes(1);
    expect(reconcileProjects).not.toHaveBeenCalled();
  });
});

describe("RecentProjectController machine operation scopes", () => {
  it("does not publish a mutation after the selected machine changes", async () => {
    const oldMachineTouch = deferred<RecentProjectEntry[]>();
    const recentProjects = vi.fn((machineId?: string) => Promise.resolve(
      machineId === "remote-b" ? [entry("/remote/beta")] : [entry("/local/alpha")],
    ));
    const { controller, selectMachine } = harness({
      recentProjects,
      recordRecentProject: () => oldMachineTouch.promise,
    });
    await controller.load();

    controller.recordWork("local-project");
    selectMachine("remote-b");
    await controller.load();
    oldMachineTouch.resolve([entry("/local/touched")]);
    await Promise.resolve();

    expect(controller.state).toEqual({ kind: "ready", entries: [entry("/remote/beta")] });
  });

  it("lets a new machine load, touch, and remove while an old-machine operation is blocked", async () => {
    const oldMachineTouch = deferred<RecentProjectEntry[]>();
    const recordRecentProject = vi.fn((projectId: string, machineId?: string) => (
      machineId === "local" ? oldMachineTouch.promise : Promise.resolve([entry(`/remote/${projectId}`)])
    ));
    const removeRecentProject = vi.fn(() => Promise.resolve([]));
    const recentProjects = vi.fn((machineId?: string) => Promise.resolve(
      machineId === "remote-b" ? [entry("/remote/seed")] : [entry("/local/seed")],
    ));
    const { controller, selectMachine } = harness({ recentProjects, recordRecentProject, removeRecentProject });
    await controller.load();

    controller.recordWork("blocked-local-project");
    await vi.waitFor(() => {
      expect(recordRecentProject).toHaveBeenCalledWith("blocked-local-project", "local");
    });

    selectMachine("remote-b");
    await controller.load();
    controller.recordWork("remote-project");
    const removing = controller.removeEntry("remote-entry");

    try {
      await vi.waitFor(() => {
        expect(recordRecentProject).toHaveBeenCalledWith("remote-project", "remote-b");
        expect(removeRecentProject).toHaveBeenCalledWith("remote-entry", "remote-b");
      });
    } finally {
      oldMachineTouch.resolve([entry("/local/touched")]);
      await removing;
    }

    expect(recentProjects).toHaveBeenCalledWith("remote-b");
    expect(controller.state).toEqual({ kind: "ready", entries: [] });
  });
});
