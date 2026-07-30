import { describe, expect, it, vi } from "vitest";
import type { Machine, Project, Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import {
  ProjectCatalogController,
  type ProjectCatalogControllerDependencies,
  type ProjectCatalogSnapshot,
} from "./projectCatalogController";

const project: Project = {
  id: "project-a",
  name: "Project A",
  path: "/work/project-a",
  createdAt: "now",
};
const otherProject: Project = {
  id: "project-b",
  name: "Project B",
  path: "/work/project-b",
  createdAt: "now",
};
const mainWorkspace: Workspace = {
  id: "workspace-main",
  projectId: project.id,
  path: project.path,
  label: "main",
  isMain: true,
  isGitRepo: true,
  isGitWorktree: false,
};
const featureWorkspace: Workspace = {
  id: "workspace-feature",
  projectId: project.id,
  path: "/work/project-a-feature",
  label: "feature",
  isMain: false,
  isGitRepo: true,
  isGitWorktree: true,
};
const otherWorkspace: Workspace = {
  id: "workspace-other",
  projectId: otherProject.id,
  path: otherProject.path,
  label: "main",
  isMain: true,
  isGitRepo: true,
  isGitWorktree: false,
};
const remoteMachine: Machine = {
  id: "remote-a",
  name: "Remote A",
  kind: "remote",
  createdAt: "now",
  updatedAt: "now",
};

describe("ProjectCatalogController", () => {
  it("uses the foreground project snapshot as a seed and schedules one fallback poll", () => {
    const timers = fakeTimers();
    const workspaces = vi.fn<(projectId: string, machineId: string) => Promise<Workspace[]>>();
    const applySnapshot = vi.fn<(snapshot: ProjectCatalogSnapshot) => void>();
    const harness = controllerFor({ workspaces, applySnapshot, timers });

    harness.controller.updatePolling();

    expect(workspaces).not.toHaveBeenCalled();
    expect(timers.delays).toEqual([5_000]);
  });

  it("refreshes immediately and schedules the next poll only after the request settles", async () => {
    const timers = fakeTimers();
    const response = deferred<Workspace[]>();
    const workspaces = vi.fn(() => response.promise);
    const applySnapshot = vi.fn();
    const harness = controllerFor({ workspaces, applySnapshot, timers });
    harness.controller.updatePolling();

    const refreshing = harness.controller.refresh();
    expect(workspaces).toHaveBeenCalledOnce();
    expect(timers.pendingCallbacks()).toHaveLength(0);

    response.resolve([featureWorkspace]);
    await refreshing;

    expect(applySnapshot).toHaveBeenCalledWith({
      machineId: "local",
      project,
      workspaces: [featureWorkspace],
    });
    expect(timers.delays).toEqual([5_000, 5_000]);
  });

  it("serializes a changed-scope refresh behind the stale in-flight request", async () => {
    const first = deferred<Workspace[]>();
    const second = deferred<Workspace[]>();
    const workspaces = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const applySnapshot = vi.fn();
    const harness = controllerFor({ workspaces, applySnapshot, timers: fakeTimers() });
    harness.controller.updatePolling();

    const staleRefresh = harness.controller.refresh();
    harness.apply({ selectedProject: otherProject, isLoadingWorkspaces: false });
    harness.controller.updatePolling();
    const currentRefresh = harness.controller.refresh();

    expect(workspaces).toHaveBeenCalledOnce();
    first.resolve([mainWorkspace]);
    await Promise.resolve();
    expect(workspaces).toHaveBeenCalledTimes(2);

    second.resolve([otherWorkspace]);
    await Promise.all([staleRefresh, currentRefresh]);

    expect(applySnapshot).toHaveBeenCalledTimes(1);
    expect(applySnapshot).toHaveBeenCalledWith({
      machineId: "local",
      project: otherProject,
      workspaces: [otherWorkspace],
    });
  });

  it("returns the existing promise for a same-scope refresh while a request is in flight", async () => {
    const response = deferred<Workspace[]>();
    const workspaces = vi.fn<(projectId: string, machineId: string) => Promise<Workspace[]>>()
      .mockReturnValue(response.promise);
    const applySnapshot = vi.fn();
    const harness = controllerFor({ workspaces, applySnapshot, timers: fakeTimers() });
    harness.controller.updatePolling();

    const firstRefresh = harness.controller.refresh();
    const secondRefresh = harness.controller.refresh();

    expect(secondRefresh).toBe(firstRefresh);
    expect(workspaces).toHaveBeenCalledOnce();

    response.resolve([mainWorkspace]);
    await firstRefresh;

    expect(applySnapshot).toHaveBeenCalledOnce();
  });

  it("shares one trailing request among changed-scope refresh callers", async () => {
    const first = deferred<Workspace[]>();
    const second = deferred<Workspace[]>();
    const workspaces = vi.fn<(projectId: string, machineId: string) => Promise<Workspace[]>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const applySnapshot = vi.fn();
    const harness = controllerFor({ workspaces, applySnapshot, timers: fakeTimers() });
    harness.controller.updatePolling();

    const staleRefresh = harness.controller.refresh();
    harness.apply({ selectedProject: otherProject });
    harness.controller.updatePolling();
    const firstCurrentRefresh = harness.controller.refresh();
    const secondCurrentRefresh = harness.controller.refresh();

    expect(secondCurrentRefresh).toBe(firstCurrentRefresh);
    expect(workspaces).toHaveBeenCalledOnce();

    first.resolve([mainWorkspace]);
    await Promise.resolve();
    expect(workspaces).toHaveBeenCalledTimes(2);

    second.resolve([otherWorkspace]);
    await Promise.all([staleRefresh, firstCurrentRefresh, secondCurrentRefresh]);

    expect(applySnapshot).toHaveBeenCalledOnce();
  });

  it("treats machine ID, project ID, and project path as the polling scope", () => {
    const timers = fakeTimers();
    const workspaces = vi.fn<(projectId: string, machineId: string) => Promise<Workspace[]>>();
    const harness = controllerFor({ workspaces, applySnapshot: vi.fn(), timers });

    harness.controller.updatePolling();
    harness.apply({ selectedMachine: remoteMachine });
    harness.controller.updatePolling();
    harness.apply({ selectedProject: { ...project, path: "/work/project-a-renamed" } });
    harness.controller.updatePolling();
    harness.apply({ selectedProject: { ...project, id: "project-a-replaced", path: "/work/project-a-renamed" } });
    harness.controller.updatePolling();

    expect(workspaces).not.toHaveBeenCalled();
    expect(timers.delays).toEqual([5_000, 5_000, 5_000, 5_000]);
    expect(timers.pendingCallbacks()).toHaveLength(1);
  });

  it("does not schedule or fetch while the selected project's workspaces are loading", async () => {
    const timers = fakeTimers();
    const workspaces = vi.fn<(projectId: string, machineId: string) => Promise<Workspace[]>>();
    const harness = controllerFor({
      workspaces,
      applySnapshot: vi.fn(),
      timers,
      statePatch: { isLoadingWorkspaces: true },
    });

    harness.controller.updatePolling();
    await harness.controller.refresh();

    expect(workspaces).not.toHaveBeenCalled();
    expect(timers.delays).toEqual([]);
    expect(timers.pendingCallbacks()).toHaveLength(0);
  });

  it("keeps a retargeted project seeded while a stale request settles", async () => {
    const staleResponse = deferred<Workspace[]>();
    const timers = fakeTimers();
    const workspaces = vi.fn<(projectId: string, machineId: string) => Promise<Workspace[]>>()
      .mockReturnValue(staleResponse.promise);
    const applySnapshot = vi.fn();
    const harness = controllerFor({ workspaces, applySnapshot, timers });
    harness.controller.updatePolling();

    const staleRefresh = harness.controller.refresh();
    harness.apply({ selectedProject: otherProject });
    harness.controller.updatePolling();

    expect(workspaces).toHaveBeenCalledOnce();
    staleResponse.resolve([mainWorkspace]);
    await staleRefresh;

    expect(applySnapshot).not.toHaveBeenCalled();
    expect(workspaces).toHaveBeenCalledOnce();
    expect(timers.delays).toEqual([5_000, 5_000]);
    expect(timers.pendingCallbacks()).toHaveLength(1);
  });

  it("reports a background fetch error and schedules a retry without replacing global error", async () => {
    const error = new Error("workspace catalog unavailable");
    const timers = fakeTimers();
    const workspaces = vi.fn<(projectId: string, machineId: string) => Promise<Workspace[]>>()
      .mockRejectedValue(error);
    const onBackgroundError = vi.fn();
    const harness = controllerFor({
      workspaces,
      applySnapshot: vi.fn(),
      timers,
      onBackgroundError,
      statePatch: { error: "existing foreground error" },
    });
    harness.controller.updatePolling();

    timers.fireLatest();
    await vi.waitFor(() => { expect(onBackgroundError).toHaveBeenCalledOnce(); });

    expect(onBackgroundError).toHaveBeenCalledWith("reconcile selected project catalog", error);
    expect(harness.state.error).toBe("existing foreground error");
    expect(timers.delays).toEqual([5_000, 5_000]);
    expect(timers.pendingCallbacks()).toHaveLength(1);
  });

  it("retries after a synchronously thrown background workspace request", async () => {
    const error = new Error("workspace catalog failed synchronously");
    const timers = fakeTimers();
    const workspaces = vi.fn<(projectId: string, machineId: string) => Promise<Workspace[]>>(() => {
      throw error;
    });
    const onBackgroundError = vi.fn();
    const harness = controllerFor({ workspaces, applySnapshot: vi.fn(), timers, onBackgroundError });
    harness.controller.updatePolling();

    timers.fireLatest();
    await vi.waitFor(() => { expect(onBackgroundError).toHaveBeenCalledOnce(); });
    timers.fireLatest();
    await vi.waitFor(() => { expect(workspaces).toHaveBeenCalledTimes(2); });

    expect(timers.delays).toEqual([5_000, 5_000, 5_000]);
    expect(timers.pendingCallbacks()).toHaveLength(1);
  });

  it("clears a scheduled fallback poll when disposed", () => {
    const timers = fakeTimers();
    const harness = controllerFor({
      workspaces: vi.fn<(projectId: string, machineId: string) => Promise<Workspace[]>>(),
      applySnapshot: vi.fn(),
      timers,
    });
    harness.controller.updatePolling();

    harness.controller.dispose();

    expect(timers.pendingCallbacks()).toHaveLength(0);
  });

  it("suppresses a late response after disposal", async () => {
    const response = deferred<Workspace[]>();
    const workspaces = vi.fn<(projectId: string, machineId: string) => Promise<Workspace[]>>()
      .mockReturnValue(response.promise);
    const applySnapshot = vi.fn();
    const timers = fakeTimers();
    const harness = controllerFor({ workspaces, applySnapshot, timers });
    harness.controller.updatePolling();

    const refreshing = harness.controller.refresh();
    harness.controller.dispose();
    response.resolve([mainWorkspace]);
    await refreshing;

    expect(applySnapshot).not.toHaveBeenCalled();
    expect(timers.pendingCallbacks()).toHaveLength(0);
  });
});

interface FakeTimers {
  readonly delays: number[];
  fireLatest(): void;
  pendingCallbacks(): (() => void)[];
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
}

function fakeTimers(): FakeTimers {
  const callbacks = new Map<number, () => void>();
  const delays: number[] = [];
  let nextId = 1;
  return {
    delays,
    setTimeout(callback, delayMs) {
      const id = nextId++;
      delays.push(delayMs);
      callbacks.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      callbacks.delete(id);
    },
    fireLatest() {
      const entry = [...callbacks.entries()].at(-1);
      if (entry === undefined) throw new Error("Expected a pending timer");
      callbacks.delete(entry[0]);
      entry[1]();
    },
    pendingCallbacks: () => [...callbacks.values()],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (resolvePromise === undefined || rejectPromise === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function controllerFor(input: {
  workspaces: NonNullable<ProjectCatalogControllerDependencies["workspaces"]>;
  applySnapshot: ProjectCatalogControllerDependencies["applySnapshot"];
  timers: FakeTimers;
  statePatch?: Partial<AppState>;
  onBackgroundError?: ProjectCatalogControllerDependencies["onBackgroundError"];
}) {
  let state: AppState = {
    ...initialAppState(),
    selectedProject: project,
    workspaces: [mainWorkspace],
    ...input.statePatch,
  };
  const controller = new ProjectCatalogController(
    () => state,
    {
      workspaces: input.workspaces,
      applySnapshot: input.applySnapshot,
      timer: input.timers,
      ...(input.onBackgroundError === undefined ? {} : { onBackgroundError: input.onBackgroundError }),
    },
  );
  return {
    controller,
    timers: input.timers,
    get state() { return state; },
    apply: (patch: Partial<AppState>) => { state = { ...state, ...patch }; },
  };
}
