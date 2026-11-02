import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryEntry, MemorySnapshotResponse } from "../../../shared/apiTypes";
import type { Machine, Project, Workspace } from "../api";
import { initialAppState, resetWorkspaceScopedState, type AppState } from "../appState";
import { MemoryController, type MemoryControllerDependencies } from "./memoryController";

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
const remoteMachine: Machine = { id: "remote-a", name: "Remote A", kind: "remote", createdAt: "now", updatedAt: "now" };

const nativeAbortTimeout = AbortSignal.timeout.bind(AbortSignal);

afterEach(() => {
  vi.useRealTimers();
  restoreAbortTimeout(nativeAbortTimeout);
});

describe("MemoryController", () => {
  it("loads immediately and schedules the next poll only after the request settles", async () => {
    const snapshot = vi.fn().mockResolvedValue({ kind: "data", globalEntries: [entry("g")], projectEntries: [entry("p")] });
    const timers = fakeTimers();
    const harness = controllerFor({ snapshot, timers });

    harness.controller.updatePolling();

    await vi.waitFor(() => { expect(snapshot).toHaveBeenCalledOnce(); });
    await vi.waitFor(() => { expect(harness.state.memory).toMatchObject({ kind: "data" }); });

    expect(snapshot).toHaveBeenCalledWith(workspace.path, "local");
    expect(timers.delays).toEqual([30_000]);
    expect(timers.pendingCallbacks()).toHaveLength(1);
  });

  it("does not schedule an overlapping poll while the current poll is unresolved", async () => {
    const pending = deferred<MemorySnapshotResponse>();
    const snapshot = vi.fn()
      .mockResolvedValueOnce(dataSnapshot("initial"))
      .mockReturnValueOnce(pending.promise);
    const timers = fakeTimers();
    const harness = controllerFor({ snapshot, timers });

    harness.controller.updatePolling();
    await vi.waitFor(() => { expect(harness.state.memory).toMatchObject({ kind: "data" }); });
    timers.fireLatest();
    await vi.waitFor(() => { expect(snapshot).toHaveBeenCalledTimes(2); });

    harness.controller.updatePolling();

    expect(timers.pendingCallbacks()).toHaveLength(0);
    expect(snapshot).toHaveBeenCalledTimes(2);

    pending.resolve(dataSnapshot("settled"));
    await vi.waitFor(() => { expect(timers.pendingCallbacks()).toHaveLength(1); });
  });

  it("joins a current-scope refresh while a request is in flight without adding a fetch or timer", async () => {
    const pending = deferred<MemorySnapshotResponse>();
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

    expect(harness.state.memory).toEqual({ kind: "data", globalEntries: [entry("settled")], projectEntries: [] });
    expect(timers.delays).toEqual([30_000]);
    expect(timers.pendingCallbacks()).toHaveLength(1);
  });

  it("drops a late workspace-A snapshot after workspace-B becomes current", async () => {
    const first = deferred<MemorySnapshotResponse>();
    const second = deferred<MemorySnapshotResponse>();
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
    await vi.waitFor(() => { expect(harness.state.memory).toMatchObject({ kind: "data", globalEntries: [{ content: "b" }] }); });
    expect(timers.delays).toEqual([30_000]);
    expect(timers.pendingCallbacks()).toHaveLength(1);

    first.resolve(dataSnapshot("a"));
    await first.promise;
    await Promise.resolve();

    expect(harness.state.memory).toMatchObject({ kind: "data", globalEntries: [{ content: "b" }] });
    expect(timers.delays).toEqual([30_000]);
    expect(timers.pendingCallbacks()).toHaveLength(1);
  });

  it("stops polling after a confirmed unavailable snapshot", async () => {
    const snapshot = vi.fn().mockResolvedValue({ kind: "unavailable" });
    const timers = fakeTimers();
    const harness = controllerFor({ snapshot, timers });

    harness.controller.updatePolling();

    await vi.waitFor(() => { expect(harness.state.memory).toEqual({ kind: "unavailable" }); });
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
    await vi.waitFor(() => { expect(harness.state.memory).toMatchObject({ kind: "data", globalEntries: [{ content: "initial" }] }); });
    expect(timers.pendingCallbacks()).toHaveLength(1);

    harness.controller.updatePolling(false);

    expect(timers.pendingCallbacks()).toHaveLength(0);
    await Promise.resolve();
    expect(snapshot).toHaveBeenCalledOnce();

    harness.controller.updatePolling(true);
    await vi.waitFor(() => { expect(snapshot).toHaveBeenCalledTimes(2); });
    expect(timers.pendingCallbacks()).toHaveLength(1);
  });

  it("keeps an available zero-entry snapshot as data", async () => {
    const snapshot = vi.fn().mockResolvedValue({ kind: "data", globalEntries: [], projectEntries: [] });
    const harness = controllerFor({ snapshot, timers: fakeTimers() });

    harness.controller.updatePolling();

    await vi.waitFor(() => { expect(harness.state.memory).toEqual({ kind: "data", globalEntries: [], projectEntries: [] }); });
  });

  it("preserves a project-only snapshot error beside global data", async () => {
    const snapshot = vi.fn().mockResolvedValue({
      kind: "data",
      globalEntries: [entry("global")],
      projectEntries: [],
      projectUnavailableMessage: "Project memory could not be read.",
    });
    const harness = controllerFor({ snapshot, timers: fakeTimers() });

    harness.controller.updatePolling();

    await vi.waitFor(() => { expect(harness.state.memory).toEqual({
      kind: "data",
      globalEntries: [entry("global")],
      projectEntries: [],
      projectUnavailableMessage: "Project memory could not be read.",
    }); });
  });

  it("retains prior data and attaches refreshError after a background failure", async () => {
    const snapshot = vi.fn()
      .mockResolvedValueOnce(dataSnapshot("initial"))
      .mockRejectedValueOnce(new Error("Memory endpoint unavailable"));
    const timers = fakeTimers();
    const harness = controllerFor({ snapshot, timers });

    harness.controller.updatePolling();
    await vi.waitFor(() => { expect(harness.state.memory).toMatchObject({ kind: "data", globalEntries: [{ content: "initial" }] }); });
    timers.fireLatest();

    await vi.waitFor(() => { expect(harness.state.memory).toEqual({
      kind: "data",
      globalEntries: [entry("initial")],
      projectEntries: [],
      refreshError: "Error: Memory endpoint unavailable",
    }); });
    expect(timers.pendingCallbacks()).toHaveLength(1);
  });

  it("uses error state when the first load fails", async () => {
    const snapshot = vi.fn().mockRejectedValue(new Error("Memory endpoint unavailable"));
    const timers = fakeTimers();
    const harness = controllerFor({ snapshot, timers });

    harness.controller.updatePolling();

    await vi.waitFor(() => { expect(harness.state.memory).toEqual({ kind: "error", message: "Error: Memory endpoint unavailable" }); });
    expect(timers.pendingCallbacks()).toHaveLength(1);
  });

  it("schedules a retry after a synchronous snapshot failure instead of retaining a settled request", async () => {
    const snapshot = vi.fn(() => { throw new Error("Memory endpoint unavailable synchronously"); });
    const timers = fakeTimers();
    const harness = controllerFor({ snapshot, timers });

    harness.controller.updatePolling();

    await vi.waitFor(() => { expect(harness.state.memory).toEqual({ kind: "error", message: "Error: Memory endpoint unavailable synchronously" }); });
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
    await vi.waitFor(() => { expect(harness.state.memory).toMatchObject({ kind: "data", globalEntries: [{ content: "initial" }] }); });
    timers.fireLatest();
    await vi.waitFor(() => { expect(harness.state.memory).toMatchObject({ kind: "data", refreshError: "Error: Temporary failure" }); });

    await harness.controller.refresh();

    expect(harness.state.memory).toEqual({ kind: "data", globalEntries: [entry("retried")], projectEntries: [] });
    expect(timers.delays).toEqual([30_000, 30_000, 30_000]);
    expect(timers.pendingCallbacks()).toHaveLength(1);
  });

  it("uses one changed-scope request when a synchronous snapshot failure settles immediately", async () => {
    const snapshot = vi.fn()
      .mockResolvedValueOnce(dataSnapshot("initial"))
      .mockImplementation(() => { throw new Error("Changed-scope failure"); });
    const harness = controllerFor({ snapshot, timers: fakeTimers() });

    harness.controller.updatePolling();
    await vi.waitFor(() => { expect(harness.state.memory).toMatchObject({ kind: "data", globalEntries: [{ content: "initial" }] }); });
    harness.apply({ selectedWorkspace: { ...workspace, id: "workspace-b", path: "/work/project-b" } });
    snapshot.mockClear();

    await harness.controller.refresh();

    expect(snapshot).toHaveBeenCalledOnce();
    expect(harness.state.memory).toEqual({ kind: "error", message: "Error: Changed-scope failure" });
  });

  it("cleans up timers and discards a late result after disposal", async () => {
    const pending = deferred<MemorySnapshotResponse>();
    const snapshot = vi.fn()
      .mockResolvedValueOnce(dataSnapshot("initial"))
      .mockReturnValueOnce(pending.promise);
    const timers = fakeTimers();
    const harness = controllerFor({ snapshot, timers });

    harness.controller.updatePolling();
    await vi.waitFor(() => { expect(harness.state.memory).toMatchObject({ kind: "data", globalEntries: [{ content: "initial" }] }); });
    timers.fireLatest();
    await vi.waitFor(() => { expect(snapshot).toHaveBeenCalledTimes(2); });

    harness.controller.dispose();
    pending.resolve(dataSnapshot("late"));
    await pending.promise;
    await Promise.resolve();

    expect(timers.pendingCallbacks()).toHaveLength(0);
    expect(harness.state.memory).toEqual({ kind: "data", globalEntries: [entry("initial")], projectEntries: [] });
  });

  it("treats a changed workspace path with the same project and workspace ids as a new scope", async () => {
    const snapshot = vi.fn()
      .mockResolvedValueOnce(dataSnapshot("original-path"))
      .mockResolvedValueOnce(dataSnapshot("changed-path"));
    const harness = controllerFor({ snapshot, timers: fakeTimers() });

    harness.controller.updatePolling();
    await vi.waitFor(() => { expect(harness.state.memory).toMatchObject({ kind: "data", globalEntries: [{ content: "original-path" }] }); });
    harness.apply({ selectedWorkspace: { ...workspace, path: "/work/project-a-renamed" } });
    harness.controller.updatePolling();

    await vi.waitFor(() => { expect(harness.state.memory).toMatchObject({ kind: "data", globalEntries: [{ content: "changed-path" }] }); });
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

describe("workspace-scoped memory state", () => {
  it("resets memory to loading", () => {
    expect(resetWorkspaceScopedState().memory).toEqual({ kind: "loading" });
  });
});

describe("memory background read budget", () => {
  it("bows out of a scheduled remote poll without changing published memory and keeps polling", async () => {
    useBackgroundDeadlineTimers();
    const reads: ReadIntentRecord[] = [];
    const initial = deferred<MemorySnapshotResponse>();
    const polled = deferred<MemorySnapshotResponse>();
    const recovered = deferred<MemorySnapshotResponse>();
    const snapshot = vi.fn<(projectPath: string, machineId: string, signal?: AbortSignal) => Promise<MemorySnapshotResponse>>()
      .mockImplementationOnce((_path, _machineId, signal) => {
        reads.push(recordIntent(signal));
        return initial.promise;
      })
      .mockImplementationOnce((_path, _machineId, signal) => {
        reads.push(recordIntent(signal));
        return rejectOnAbort(polled.promise, signal);
      })
      .mockImplementationOnce((_path, _machineId, signal) => {
        reads.push(recordIntent(signal));
        return recovered.promise;
      });
    const timers = fakeTimers();
    const harness = controllerFor({ snapshot, timers, statePatch: { selectedMachine: remoteMachine } });

    harness.controller.updatePolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads.map((read) => read.intent)).toEqual(["foreground"]);

    initial.resolve(dataSnapshot("initial"));
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.state.memory).toMatchObject({ kind: "data", globalEntries: [{ content: "initial" }] });
    expect(timers.pendingCallbacks()).toHaveLength(1);

    timers.fireLatest();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(reads.map((read) => read.intent)).toEqual(["foreground", "background"]);
    expect(harness.state.memory).toEqual({ kind: "data", globalEntries: [entry("initial")], projectEntries: [] });
    expect(timers.pendingCallbacks()).toHaveLength(1);

    timers.fireLatest();
    await vi.advanceTimersByTimeAsync(0);
    recovered.resolve(dataSnapshot("recovered"));
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.state.memory).toMatchObject({ kind: "data", globalEntries: [{ content: "recovered" }] });
  });

  it("gives a manual refresh foreground priority over a running scheduled poll", async () => {
    useBackgroundDeadlineTimers();
    const reads: ReadIntentRecord[] = [];
    const initial = deferred<MemorySnapshotResponse>();
    const polled = deferred<MemorySnapshotResponse>();
    const manual = deferred<MemorySnapshotResponse>();
    const snapshot = vi.fn<(projectPath: string, machineId: string, signal?: AbortSignal) => Promise<MemorySnapshotResponse>>()
      .mockImplementationOnce((_path, _machineId, signal) => {
        reads.push(recordIntent(signal));
        return initial.promise;
      })
      .mockImplementationOnce((_path, _machineId, signal) => {
        reads.push(recordIntent(signal));
        return rejectOnAbort(polled.promise, signal);
      })
      .mockImplementationOnce((_path, _machineId, signal) => {
        reads.push(recordIntent(signal));
        return manual.promise;
      });
    const timers = fakeTimers();
    const harness = controllerFor({ snapshot, timers, statePatch: { selectedMachine: remoteMachine } });

    harness.controller.updatePolling();
    await vi.advanceTimersByTimeAsync(0);
    initial.resolve(dataSnapshot("initial"));
    await vi.advanceTimersByTimeAsync(0);

    timers.fireLatest();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads.map((read) => read.intent)).toEqual(["foreground", "background"]);

    const manualRefresh = harness.controller.refresh();

    expect(reads.map((read) => read.intent)).toEqual(["foreground", "background", "foreground"]);
    expect(reads[1]?.signal?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.state.memory).toEqual({ kind: "data", globalEntries: [entry("initial")], projectEntries: [] });

    manual.resolve(dataSnapshot("manual"));
    await manualRefresh;

    expect(harness.state.memory).toEqual({ kind: "data", globalEntries: [entry("manual")], projectEntries: [] });
    expect(timers.pendingCallbacks()).toHaveLength(1);
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

function entry(id: string): MemoryEntry {
  return { id, content: id };
}

function dataSnapshot(label: string): Extract<MemorySnapshotResponse, { kind: "data" }> {
  return { kind: "data", globalEntries: [entry(label)], projectEntries: [] };
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

function controllerFor(input: { snapshot: NonNullable<MemoryControllerDependencies["snapshot"]>; timers: FakeTimers; statePatch?: Partial<AppState> }) {
  let state: AppState = {
    ...initialAppState(),
    selectedProject: project,
    selectedWorkspace: workspace,
    ...input.statePatch,
  };
  const controller = new MemoryController(
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

interface ReadIntentRecord {
  intent: "background" | "foreground";
  signal: AbortSignal | undefined;
}

function recordIntent(signal: AbortSignal | undefined): ReadIntentRecord {
  return { intent: signal === undefined ? "foreground" : "background", signal };
}

/** Drives the background deadline by faking the clock it is scheduled on. */
function useBackgroundDeadlineTimers(): void {
  vi.useFakeTimers();
  restoreAbortTimeout((delayMs: number): AbortSignal => {
    const controller = new AbortController();
    setTimeout(() => { controller.abort(new DOMException("The operation timed out.", "TimeoutError")); }, delayMs);
    return controller.signal;
  });
}

function restoreAbortTimeout(replacement: unknown): void {
  Object.defineProperty(AbortSignal, "timeout", { configurable: true, writable: true, value: replacement });
}

/** Rejects a pending read when its transport signal aborts, like a real fetch. */
function rejectOnAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      const reason: unknown = signal.reason;
      const fallback = new Error("The operation was aborted");
      fallback.name = "AbortError";
      reject(reason instanceof Error ? reason : fallback);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
