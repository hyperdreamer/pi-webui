import { describe, expect, it, vi } from "vitest";
import type { RecentProjectEntry } from "../../../shared/apiTypes";
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
}> = {}, machineId = "local") {
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

    await controller.removeEntry("/work/alpha");

    expect(removeRecentProject).toHaveBeenCalledWith("/work/alpha", "local");
    expect(controller.state).toEqual({ kind: "ready", entries: [entry("/work/beta")] });
  });

  it("refreshes and rethrows when removal conflicts with a registration", async () => {
    const { controller } = harness({
      recentProjects: () => Promise.resolve([entry("/work/alpha")]),
      removeRecentProject: () => Promise.reject(new Error("Recent project is registered")),
    });
    await controller.load();

    await expect(controller.removeEntry("/work/alpha")).rejects.toThrow(/registered/i);
    expect(controller.state).toEqual({ kind: "ready", entries: [entry("/work/alpha")] });
  });
});
