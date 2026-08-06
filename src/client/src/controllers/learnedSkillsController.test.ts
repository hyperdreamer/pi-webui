import { describe, expect, it, vi } from "vitest";
import type { LearnedSkill, LearnedSkillsSnapshotResponse } from "../../../shared/apiTypes";
import type { Project, Workspace } from "../api";
import { initialAppState, resetWorkspaceScopedState, type AppState } from "../appState";
import { LearnedSkillsController, type LearnedSkillsControllerDependencies } from "./learnedSkillsController";

const project: Project = { id: "project-a", name: "Project A", path: "/work/project-a", createdAt: "now" };
const workspace: Workspace = {
  id: "workspace-a",
  projectId: project.id,
  path: "/work/project-a",
  label: "main",
  isMain: true,
  isGitRepo: true,
  isGitWorktree: false,
};

describe("LearnedSkillsController", () => {
  it("loads immediately and schedules the next poll only after the request settles", async () => {
    const snapshot = vi.fn().mockResolvedValue({ kind: "data", globalSkills: [skill("g")], projectSkills: [skill("p")] });
    const timers = fakeTimers();
    const harness = controllerFor({ snapshot, timers });

    harness.controller.updatePolling();

    await vi.waitFor(() => { expect(snapshot).toHaveBeenCalledOnce(); });
    await vi.waitFor(() => { expect(harness.state.learnedSkills).toMatchObject({ kind: "data" }); });

    expect(snapshot).toHaveBeenCalledWith(workspace.path, "local");
    expect(timers.delays).toEqual([30_000]);
    expect(timers.pendingCallbacks()).toHaveLength(1);
  });

  it("does not schedule an overlapping poll while the current poll is unresolved", async () => {
    const pending = deferred<LearnedSkillsSnapshotResponse>();
    const snapshot = vi.fn()
      .mockResolvedValueOnce(dataSnapshot("initial"))
      .mockReturnValueOnce(pending.promise);
    const timers = fakeTimers();
    const harness = controllerFor({ snapshot, timers });

    harness.controller.updatePolling();
    await vi.waitFor(() => { expect(harness.state.learnedSkills).toMatchObject({ kind: "data" }); });
    timers.fireLatest();
    await vi.waitFor(() => { expect(snapshot).toHaveBeenCalledTimes(2); });

    harness.controller.updatePolling();

    expect(timers.pendingCallbacks()).toHaveLength(0);
    expect(snapshot).toHaveBeenCalledTimes(2);

    pending.resolve(dataSnapshot("settled"));
    await vi.waitFor(() => { expect(timers.pendingCallbacks()).toHaveLength(1); });
  });

  it("joins a current-scope refresh while a request is in flight without adding a fetch or timer", async () => {
    const pending = deferred<LearnedSkillsSnapshotResponse>();
    const snapshot = vi.fn().mockReturnValue(pending.promise);
    const timers = fakeTimers();
    const harness = controllerFor({ snapshot, timers });

    harness.controller.updatePolling();
    await vi.waitFor(() => { expect(snapshot).toHaveBeenCalledOnce(); });
    const refresh = harness.controller.refresh();

    expect(snapshot).toHaveBeenCalledOnce();
    expect(timers.pendingCallbacks()).toHaveLength(0);

    pending.resolve(dataSnapshot("settled"));
    await refresh;

    expect(harness.state.learnedSkills).toEqual({ kind: "data", globalSkills: [skill("settled")], projectSkills: [] });
    expect(timers.delays).toEqual([30_000]);
    expect(timers.pendingCallbacks()).toHaveLength(1);
  });

  it("drops a late workspace-A snapshot after workspace-B becomes current", async () => {
    const first = deferred<LearnedSkillsSnapshotResponse>();
    const second = deferred<LearnedSkillsSnapshotResponse>();
    const snapshot = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const timers = fakeTimers();
    const harness = controllerFor({ snapshot, timers });

    harness.controller.updatePolling();
    await vi.waitFor(() => { expect(snapshot).toHaveBeenCalledOnce(); });
    harness.apply({ selectedWorkspace: { ...workspace, id: "workspace-b", path: "/work/project-b" } });
    harness.controller.updatePolling();
    await vi.waitFor(() => { expect(snapshot).toHaveBeenCalledTimes(2); });

    second.resolve(dataSnapshot("b"));
    await vi.waitFor(() => { expect(harness.state.learnedSkills).toMatchObject({ kind: "data", globalSkills: [{ id: "b" }] }); });
    expect(timers.delays).toEqual([30_000]);
    expect(timers.pendingCallbacks()).toHaveLength(1);

    first.resolve(dataSnapshot("a"));
    await first.promise;
    await Promise.resolve();

    expect(harness.state.learnedSkills).toMatchObject({ kind: "data", globalSkills: [{ id: "b" }] });
    expect(timers.delays).toEqual([30_000]);
    expect(timers.pendingCallbacks()).toHaveLength(1);
  });

  it("stops polling after a confirmed unavailable snapshot", async () => {
    const snapshot = vi.fn().mockResolvedValue({ kind: "unavailable" });
    const timers = fakeTimers();
    const harness = controllerFor({ snapshot, timers });

    harness.controller.updatePolling();

    await vi.waitFor(() => { expect(harness.state.learnedSkills).toEqual({ kind: "unavailable" }); });
    expect(snapshot).toHaveBeenCalledOnce();
    expect(timers.pendingCallbacks()).toHaveLength(0);
    await Promise.resolve();
    expect(snapshot).toHaveBeenCalledOnce();
  });

  it("clears pending polls while observation is disabled and restarts when it resumes", async () => {
    const snapshot = vi.fn()
      .mockResolvedValueOnce(dataSnapshot("initial"))
      .mockResolvedValueOnce(dataSnapshot("resumed"));
    const timers = fakeTimers();
    const harness = controllerFor({ snapshot, timers });

    harness.controller.updatePolling(true);
    await vi.waitFor(() => { expect(harness.state.learnedSkills).toMatchObject({ kind: "data", globalSkills: [{ id: "initial" }] }); });
    expect(timers.pendingCallbacks()).toHaveLength(1);

    harness.controller.updatePolling(false);

    expect(timers.pendingCallbacks()).toHaveLength(0);
    await Promise.resolve();
    expect(snapshot).toHaveBeenCalledOnce();

    harness.controller.updatePolling(true);
    await vi.waitFor(() => { expect(snapshot).toHaveBeenCalledTimes(2); });
    expect(timers.pendingCallbacks()).toHaveLength(1);
  });

  it("keeps an available zero-skill snapshot as data", async () => {
    const snapshot = vi.fn().mockResolvedValue({ kind: "data", globalSkills: [], projectSkills: [] });
    const harness = controllerFor({ snapshot, timers: fakeTimers() });

    harness.controller.updatePolling();

    await vi.waitFor(() => { expect(harness.state.learnedSkills).toEqual({ kind: "data", globalSkills: [], projectSkills: [] }); });
  });

  it("preserves a project-only snapshot error beside global data", async () => {
    const snapshot = vi.fn().mockResolvedValue({
      kind: "data",
      globalSkills: [skill("global")],
      projectSkills: [],
      projectUnavailableMessage: "Project skills could not be read.",
    });
    const harness = controllerFor({ snapshot, timers: fakeTimers() });

    harness.controller.updatePolling();

    await vi.waitFor(() => { expect(harness.state.learnedSkills).toEqual({
      kind: "data",
      globalSkills: [skill("global")],
      projectSkills: [],
      projectUnavailableMessage: "Project skills could not be read.",
    }); });
  });

  it("retains prior data and attaches refreshError after a background failure", async () => {
    const snapshot = vi.fn()
      .mockResolvedValueOnce(dataSnapshot("initial"))
      .mockRejectedValueOnce(new Error("Skills endpoint unavailable"));
    const timers = fakeTimers();
    const harness = controllerFor({ snapshot, timers });

    harness.controller.updatePolling();
    await vi.waitFor(() => { expect(harness.state.learnedSkills).toMatchObject({ kind: "data", globalSkills: [{ id: "initial" }] }); });
    timers.fireLatest();

    await vi.waitFor(() => { expect(harness.state.learnedSkills).toEqual({
      kind: "data",
      globalSkills: [skill("initial")],
      projectSkills: [],
      refreshError: "Error: Skills endpoint unavailable",
    }); });
    expect(timers.pendingCallbacks()).toHaveLength(1);
  });

  it("uses error state when the first load fails", async () => {
    const snapshot = vi.fn().mockRejectedValue(new Error("Skills endpoint unavailable"));
    const timers = fakeTimers();
    const harness = controllerFor({ snapshot, timers });

    harness.controller.updatePolling();

    await vi.waitFor(() => { expect(harness.state.learnedSkills).toEqual({ kind: "error", message: "Error: Skills endpoint unavailable" }); });
    expect(timers.pendingCallbacks()).toHaveLength(1);
  });

  it("schedules a retry after a synchronous snapshot failure instead of retaining a settled request", async () => {
    const snapshot = vi.fn(() => { throw new Error("Skills endpoint unavailable synchronously"); });
    const timers = fakeTimers();
    const harness = controllerFor({ snapshot, timers });

    harness.controller.updatePolling();

    await vi.waitFor(() => { expect(harness.state.learnedSkills).toEqual({ kind: "error", message: "Error: Skills endpoint unavailable synchronously" }); });
    expect(snapshot).toHaveBeenCalledOnce();
    expect(timers.delays).toEqual([30_000]);
    expect(timers.pendingCallbacks()).toHaveLength(1);

    timers.fireLatest();

    await vi.waitFor(() => { expect(snapshot).toHaveBeenCalledTimes(2); });
    expect(timers.delays).toEqual([30_000, 30_000]);
    expect(timers.pendingCallbacks()).toHaveLength(1);
  });

  it("retries the current scope and clears a retained refresh error", async () => {
    const snapshot = vi.fn()
      .mockResolvedValueOnce(dataSnapshot("initial"))
      .mockRejectedValueOnce(new Error("Temporary failure"))
      .mockResolvedValueOnce(dataSnapshot("retried"));
    const timers = fakeTimers();
    const harness = controllerFor({ snapshot, timers });

    harness.controller.updatePolling();
    await vi.waitFor(() => { expect(harness.state.learnedSkills).toMatchObject({ kind: "data", globalSkills: [{ id: "initial" }] }); });
    timers.fireLatest();
    await vi.waitFor(() => { expect(harness.state.learnedSkills).toMatchObject({ kind: "data", refreshError: "Error: Temporary failure" }); });

    await harness.controller.refresh();

    expect(harness.state.learnedSkills).toEqual({ kind: "data", globalSkills: [skill("retried")], projectSkills: [] });
    expect(timers.delays).toEqual([30_000, 30_000, 30_000]);
    expect(timers.pendingCallbacks()).toHaveLength(1);
  });

  it("uses one changed-scope request when a synchronous snapshot failure settles immediately", async () => {
    const snapshot = vi.fn()
      .mockResolvedValueOnce(dataSnapshot("initial"))
      .mockImplementation(() => { throw new Error("Changed-scope failure"); });
    const harness = controllerFor({ snapshot, timers: fakeTimers() });

    harness.controller.updatePolling();
    await vi.waitFor(() => { expect(harness.state.learnedSkills).toMatchObject({ kind: "data", globalSkills: [{ id: "initial" }] }); });
    harness.apply({ selectedWorkspace: { ...workspace, id: "workspace-b", path: "/work/project-b" } });
    snapshot.mockClear();

    await harness.controller.refresh();

    expect(snapshot).toHaveBeenCalledOnce();
    expect(harness.state.learnedSkills).toEqual({ kind: "error", message: "Error: Changed-scope failure" });
  });

  it("cleans up timers and discards a late result after disposal", async () => {
    const pending = deferred<LearnedSkillsSnapshotResponse>();
    const snapshot = vi.fn()
      .mockResolvedValueOnce(dataSnapshot("initial"))
      .mockReturnValueOnce(pending.promise);
    const timers = fakeTimers();
    const harness = controllerFor({ snapshot, timers });

    harness.controller.updatePolling();
    await vi.waitFor(() => { expect(harness.state.learnedSkills).toMatchObject({ kind: "data", globalSkills: [{ id: "initial" }] }); });
    timers.fireLatest();
    await vi.waitFor(() => { expect(snapshot).toHaveBeenCalledTimes(2); });

    harness.controller.dispose();
    pending.resolve(dataSnapshot("late"));
    await pending.promise;
    await Promise.resolve();

    expect(timers.pendingCallbacks()).toHaveLength(0);
    expect(harness.state.learnedSkills).toEqual({ kind: "data", globalSkills: [skill("initial")], projectSkills: [] });
  });

  it("treats a changed workspace path with the same project and workspace ids as a new scope", async () => {
    const snapshot = vi.fn()
      .mockResolvedValueOnce(dataSnapshot("original-path"))
      .mockResolvedValueOnce(dataSnapshot("changed-path"));
    const harness = controllerFor({ snapshot, timers: fakeTimers() });

    harness.controller.updatePolling();
    await vi.waitFor(() => { expect(harness.state.learnedSkills).toMatchObject({ kind: "data", globalSkills: [{ id: "original-path" }] }); });
    harness.apply({ selectedWorkspace: { ...workspace, path: "/work/project-a-renamed" } });
    harness.controller.updatePolling();

    await vi.waitFor(() => { expect(harness.state.learnedSkills).toMatchObject({ kind: "data", globalSkills: [{ id: "changed-path" }] }); });
    expect(snapshot).toHaveBeenNthCalledWith(1, "/work/project-a", "local");
    expect(snapshot).toHaveBeenNthCalledWith(2, "/work/project-a-renamed", "local");
  });

  it("treats selected machine and project ids as scope changes", async () => {
    const snapshot = vi.fn()
      .mockResolvedValueOnce(dataSnapshot("local"))
      .mockResolvedValueOnce(dataSnapshot("remote"))
      .mockResolvedValueOnce(dataSnapshot("other-project"));
    const harness = controllerFor({ snapshot, timers: fakeTimers() });

    harness.controller.updatePolling();
    await vi.waitFor(() => { expect(snapshot).toHaveBeenCalledTimes(1); });
    harness.apply({ selectedMachine: { id: "remote-a", name: "Remote A", kind: "remote", createdAt: "now", updatedAt: "now" } });
    harness.controller.updatePolling();
    await vi.waitFor(() => { expect(snapshot).toHaveBeenCalledTimes(2); });
    const otherProject = { ...project, id: "project-b" };
    harness.apply({ selectedProject: otherProject, selectedWorkspace: { ...workspace, projectId: otherProject.id } });
    harness.controller.updatePolling();
    await vi.waitFor(() => { expect(snapshot).toHaveBeenCalledTimes(3); });

    expect(snapshot).toHaveBeenNthCalledWith(1, workspace.path, "local");
    expect(snapshot).toHaveBeenNthCalledWith(2, workspace.path, "remote-a");
    expect(snapshot).toHaveBeenNthCalledWith(3, workspace.path, "remote-a");
  });
});

describe("workspace-scoped learned skills state", () => {
  it("resets learned skills to loading", () => {
    expect(resetWorkspaceScopedState().learnedSkills).toEqual({ kind: "loading" });
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

function skill(id: string): LearnedSkill {
  return { id, name: id, description: id, filePath: `skills/${id}.md` };
}

function dataSnapshot(label: string): Extract<LearnedSkillsSnapshotResponse, { kind: "data" }> {
  return { kind: "data", globalSkills: [skill(label)], projectSkills: [] };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error("Deferred promise is unavailable");
      resolvePromise(value);
    },
  };
}

function controllerFor(input: { snapshot: NonNullable<LearnedSkillsControllerDependencies["snapshot"]>; timers: FakeTimers; statePatch?: Partial<AppState> }) {
  let state: AppState = {
    ...initialAppState(),
    selectedProject: project,
    selectedWorkspace: workspace,
    ...input.statePatch,
  };
  const controller = new LearnedSkillsController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    { snapshot: input.snapshot, timer: input.timers },
  );
  return {
    controller,
    timers: input.timers,
    get state() { return state; },
    apply: (patch: Partial<AppState>) => { state = { ...state, ...patch }; },
  };
}
