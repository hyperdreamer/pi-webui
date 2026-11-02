import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type GitStatusResponse, type Machine, type Project, type Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import { GitController } from "./gitController";

const project: Project = { id: "project-1", name: "Project", path: "/repo", createdAt: "now" };
const gitWorkspace: Workspace = { id: "workspace-1", projectId: project.id, path: "/repo", label: "main", isMain: true, isGitRepo: true, isGitWorktree: false };
const remoteMachine: Machine = { id: "remote-a", name: "Remote A", kind: "remote", createdAt: "now", updatedAt: "now" };

const nativeAbortTimeout = AbortSignal.timeout.bind(AbortSignal);

afterEach(() => {
  vi.useRealTimers();
  restoreAbortTimeout(nativeAbortTimeout);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GitController badge polling", () => {
  it("loads and polls Git status for a selected Git workspace even outside the Git panel", async () => {
    const harness = controllerFor(gitWorkspace);
    const { controller } = harness;
    const setInterval = vi.fn(() => 41);
    vi.stubGlobal("window", { setInterval, clearInterval: vi.fn() });
    const gitStatus = vi.spyOn(api, "gitStatus").mockResolvedValue({
      isGitRepo: true,
      hash: "status-hash",
      files: [{ path: "src/changed.ts", index: "modified", workingTree: "unmodified" }],
    });

    controller.updatePolling();

    await vi.waitFor(() => { expect(gitStatus).toHaveBeenCalledWith(project.id, gitWorkspace.id, "local"); });
    expect(harness.state.gitStatus?.files).toHaveLength(1);
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 8_000);
  });

  it("does not poll a non-Git workspace", () => {
    const nonGitWorkspace = { ...gitWorkspace, isGitRepo: false };
    const { controller } = controllerFor(nonGitWorkspace);
    const setInterval = vi.fn(() => 41);
    vi.stubGlobal("window", { setInterval, clearInterval: vi.fn() });
    const gitStatus = vi.spyOn(api, "gitStatus");

    controller.updatePolling();

    expect(gitStatus).not.toHaveBeenCalled();
    expect(setInterval).not.toHaveBeenCalled();
  });

  it("keeps a foreground error unchanged when background badge polling succeeds", async () => {
    const harness = controllerFor(gitWorkspace, { error: "Foreground error" });
    const { controller } = harness;
    vi.stubGlobal("window", { setInterval: vi.fn(() => 41), clearInterval: vi.fn() });
    const gitStatus = vi.spyOn(api, "gitStatus").mockResolvedValue({ isGitRepo: true, hash: "status-hash", files: [] });

    controller.updatePolling();

    await vi.waitFor(() => { expect(gitStatus).toHaveBeenCalledOnce(); });
    expect(harness.state.error).toBe("Foreground error");
  });

  it("keeps a foreground error unchanged when background badge polling fails", async () => {
    const harness = controllerFor(gitWorkspace, { error: "Foreground error" });
    const { controller } = harness;
    vi.stubGlobal("window", { setInterval: vi.fn(() => 41), clearInterval: vi.fn() });
    const gitStatus = vi.spyOn(api, "gitStatus").mockRejectedValue(new Error("Git unavailable"));

    controller.updatePolling();

    await vi.waitFor(() => { expect(gitStatus).toHaveBeenCalledOnce(); });
    expect(harness.state.error).toBe("Foreground error");
  });

  it("keeps a manual refresh current when polling is already configured for the workspace", async () => {
    const harness = controllerFor(gitWorkspace);
    const { controller } = harness;
    vi.stubGlobal("window", { setInterval: vi.fn(() => 41), clearInterval: vi.fn() });
    const manualStatus = deferred<ReturnType<typeof status>>();
    const gitStatus = vi.spyOn(api, "gitStatus")
      .mockResolvedValueOnce(status("initial"))
      .mockReturnValueOnce(manualStatus.promise);

    controller.updatePolling();
    await vi.waitFor(() => { expect(harness.state.gitStatus?.hash).toBe("initial"); });
    const manualRefresh = controller.refreshGit();
    controller.updatePolling();
    manualStatus.resolve(status("manual"));
    await manualRefresh;

    expect(harness.state.gitStatus?.hash).toBe("manual");
    expect(gitStatus).toHaveBeenCalledTimes(2);
  });

  it("ignores a prior workspace status response after badge polling switches workspaces", async () => {
    const workspaceB = { ...gitWorkspace, id: "workspace-2", path: "/other" };
    const harness = controllerFor(gitWorkspace);
    const { controller } = harness;
    vi.stubGlobal("window", { setInterval: vi.fn(() => 41), clearInterval: vi.fn() });
    const firstStatus = deferred<ReturnType<typeof status>>();
    const secondStatus = deferred<ReturnType<typeof status>>();
    vi.spyOn(api, "gitStatus").mockImplementation((_projectId, workspaceId) => workspaceId === gitWorkspace.id ? firstStatus.promise : secondStatus.promise);

    controller.updatePolling();
    await vi.waitFor(() => { expect(api.gitStatus).toHaveBeenCalledWith(project.id, gitWorkspace.id, "local"); });
    harness.apply({ selectedWorkspace: workspaceB });
    controller.updatePolling();
    await vi.waitFor(() => { expect(api.gitStatus).toHaveBeenCalledWith(project.id, workspaceB.id, "local"); });

    secondStatus.resolve(status("workspace-b"));
    await vi.waitFor(() => { expect(harness.state.gitStatus?.hash).toBe("workspace-b"); });
    firstStatus.resolve(status("workspace-a"));
    await firstStatus.promise;
    await Promise.resolve();

    expect(harness.state.gitStatus?.hash).toBe("workspace-b");
  });

  it("ignores a prior workspace diff response after selection changes", async () => {
    const workspaceB = { ...gitWorkspace, id: "workspace-2", path: "/other" };
    const harness = controllerFor(gitWorkspace, { selectedDiffPath: "src/a.ts" });
    const { controller } = harness;
    const unstaged = deferred<ReturnType<typeof diff>>();
    const staged = deferred<ReturnType<typeof diff>>();
    vi.spyOn(api, "gitDiff").mockImplementation((_projectId, _workspaceId, options) => options?.staged === true ? staged.promise : unstaged.promise);

    const refreshing = controller.refreshDiff("src/a.ts");
    harness.apply({ selectedWorkspace: workspaceB, selectedDiffPath: undefined, selectedDiff: undefined, selectedStagedDiff: undefined });
    unstaged.resolve(diff(false));
    staged.resolve(diff(true));
    await refreshing;

    expect(harness.state.selectedDiff).toBeUndefined();
    expect(harness.state.selectedStagedDiff).toBeUndefined();
  });

  it("ignores an in-flight badge request after polling is disposed", async () => {
    const harness = controllerFor(gitWorkspace);
    const { controller } = harness;
    vi.stubGlobal("window", { setInterval: vi.fn(() => 41), clearInterval: vi.fn() });
    const pendingStatus = deferred<ReturnType<typeof status>>();
    vi.spyOn(api, "gitStatus").mockReturnValue(pendingStatus.promise);

    controller.updatePolling();
    await vi.waitFor(() => { expect(api.gitStatus).toHaveBeenCalledOnce(); });
    controller.dispose();
    pendingStatus.resolve(status("late-status"));
    await pendingStatus.promise;
    await Promise.resolve();

    expect(harness.state.gitStatus).toBeUndefined();
  });
});

describe("GitController background polling budget", () => {
  it("keeps one pass deadline across a delayed status and its consequential diffs without shortening a manual refresh", async () => {
    startPollingClock();
    const harness = controllerFor(gitWorkspace, { selectedMachine: remoteMachine, selectedDiffPath: "src/a.ts" });
    const statusSignals: (AbortSignal | undefined)[] = [];
    const diffSignals: (AbortSignal | undefined)[] = [];
    const polledDiffs = abortableDeferred<ReturnType<typeof diff>>();
    const manualStatus = abortableDeferred<GitStatusResponse>();
    vi.spyOn(api, "gitStatus").mockImplementation((_projectId, _workspaceId, _machineId, signal) => {
      statusSignals.push(signal);
      if (statusSignals.length === 1) return delayed(15_000).then(() => statusWithPath("poll", "src/a.ts"));
      return manualStatus.bind(signal);
    });
    let diffCalls = 0;
    vi.spyOn(api, "gitDiff").mockImplementation((_projectId, _workspaceId, options, _machineId, signal) => {
      diffSignals.push(signal);
      diffCalls += 1;
      if (diffCalls <= 2) return polledDiffs.bind(signal);
      return Promise.resolve(diff(options?.staged === true));
    });

    harness.controller.updatePolling();
    await vi.advanceTimersByTimeAsync(0);

    expect(api.gitStatus).toHaveBeenCalledOnce();
    expect(api.gitDiff).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_000);

    expect(api.gitDiff).toHaveBeenCalledTimes(2);
    expect(harness.state.gitStatus?.hash).toBe("poll");

    // A separate deadline for the consequential reads would keep them alive
    // well past the pass; the shared deadline closes them five seconds in.
    await vi.advanceTimersByTimeAsync(4_000);

    expect(diffSignals.every((signal) => signal?.aborted === false)).toBe(true);
    expect(harness.state.selectedDiff).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(statusSignals[0]?.aborted).toBe(true);
    expect(diffSignals.every((signal) => signal?.aborted === true)).toBe(true);
    expect(harness.state.selectedDiff).toBeUndefined();
    expect(harness.state.error).toBe("");

    const manualRefresh = harness.controller.refreshGit();
    await vi.advanceTimersByTimeAsync(20_001);

    expect(api.gitStatus).toHaveBeenCalledTimes(2);
    expect(statusSignals[1]).toBeUndefined();

    manualStatus.resolve(statusWithPath("manual", "src/a.ts"));
    await manualRefresh;

    expect(harness.state.gitStatus?.hash).toBe("manual");
    expect(harness.state.selectedDiff).toEqual(diff(false));
    expect(harness.state.error).toBe("");
  });

  it("aborts pending consequential diffs when a foreground read supersedes the background pass", async () => {
    startPollingClock();
    const harness = controllerFor(gitWorkspace, { selectedMachine: remoteMachine, selectedDiffPath: "src/a.ts" });
    const statusSignals: (AbortSignal | undefined)[] = [];
    const diffSignals: (AbortSignal | undefined)[] = [];
    const polledDiffs = abortableDeferred<ReturnType<typeof diff>>();
    const manualStatus = abortableDeferred<GitStatusResponse>();
    vi.spyOn(api, "gitStatus").mockImplementation((_projectId, _workspaceId, _machineId, signal) => {
      statusSignals.push(signal);
      return statusSignals.length === 1 ? Promise.resolve(statusWithPath("poll", "src/a.ts")) : manualStatus.bind(signal);
    });
    vi.spyOn(api, "gitDiff").mockImplementation((_projectId, _workspaceId, options, _machineId, signal) => {
      diffSignals.push(signal);
      return diffSignals.length <= 2 ? polledDiffs.bind(signal) : Promise.resolve(diff(options?.staged === true));
    });

    harness.controller.updatePolling();
    await vi.advanceTimersByTimeAsync(0);

    expect(api.gitDiff).toHaveBeenCalledTimes(2);
    expect(harness.state.gitStatus?.hash).toBe("poll");

    const manualRefresh = harness.controller.refreshGit();

    expect(diffSignals.slice(0, 2).every((signal) => signal?.aborted === true)).toBe(true);
    expect(harness.state.selectedDiff).toBeUndefined();

    manualStatus.resolve(statusWithPath("manual", "src/a.ts"));
    await manualRefresh;

    expect(harness.state.gitStatus?.hash).toBe("manual");
    expect(harness.state.selectedDiff).toEqual(diff(false));
    expect(harness.state.error).toBe("");
  });

  it("drops a cancelled background pass instead of publishing its status and consequential diffs", async () => {
    startPollingClock();
    const harness = controllerFor(gitWorkspace, {
      selectedMachine: remoteMachine,
      selectedDiffPath: "src/a.ts",
      gitStatus: statusWithPath("initial", "src/a.ts"),
    });
    const polledStatus = deferred<GitStatusResponse>();
    const unstaged = deferred<ReturnType<typeof diff>>();
    const staged = deferred<ReturnType<typeof diff>>();
    const diffSignals: (AbortSignal | undefined)[] = [];
    vi.spyOn(api, "gitStatus").mockReturnValue(polledStatus.promise);
    vi.spyOn(api, "gitDiff").mockImplementation((_projectId, _workspaceId, options, _machineId, signal) => {
      diffSignals.push(signal);
      return rejectOnAbort(options?.staged === true ? staged.promise : unstaged.promise, signal);
    });

    harness.controller.updatePolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.gitStatus).toHaveBeenCalledOnce();

    // The polled status settles before its cancelled continuation runs, so only
    // pass ownership can keep it from publishing and starting diffs.
    polledStatus.resolve(statusWithPath("poll", "src/a.ts"));
    const refreshing = harness.controller.refreshDiff("src/a.ts");
    unstaged.resolve(diff(false));
    staged.resolve(diff(true));
    await refreshing;

    expect(harness.state.gitStatus?.hash).toBe("initial");
    expect(diffSignals).toHaveLength(2);
    expect(harness.state.selectedDiff).toEqual(diff(false));
    expect(harness.state.selectedStagedDiff).toEqual(diff(true));
    expect(harness.state.error).toBe("");
  });

  it("cancels an active background poll before a foreground refresh", async () => {
    startPollingClock();
    const harness = controllerFor(gitWorkspace, { selectedMachine: remoteMachine });
    const statusSignals: (AbortSignal | undefined)[] = [];
    const polled = abortableDeferred<GitStatusResponse>();
    const manual = abortableDeferred<GitStatusResponse>();
    vi.spyOn(api, "gitStatus").mockImplementation((_projectId, _workspaceId, _machineId, signal) => {
      statusSignals.push(signal);
      return statusSignals.length === 1 ? polled.bind(signal) : manual.bind(signal);
    });

    harness.controller.updatePolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.gitStatus).toHaveBeenCalledOnce();

    const manualRefresh = harness.controller.refreshGit();

    expect(statusSignals[0]?.aborted).toBe(true);
    expect(statusSignals[1]).toBeUndefined();

    manual.resolve(status("manual"));
    await manualRefresh;

    expect(harness.state.gitStatus?.hash).toBe("manual");
    expect(harness.state.error).toBe("");
  });

  it("skips a poll tick while foreground Git work is pending", async () => {
    const { intervals } = startPollingClock();
    const harness = controllerFor(gitWorkspace, { selectedMachine: remoteMachine });
    const statusSignals: (AbortSignal | undefined)[] = [];
    const manual = abortableDeferred<GitStatusResponse>();
    vi.spyOn(api, "gitStatus").mockImplementation((_projectId, _workspaceId, _machineId, signal) => {
      statusSignals.push(signal);
      return statusSignals.length === 1 ? Promise.resolve(status("initial")) : manual.bind(signal);
    });

    harness.controller.updatePolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.state.gitStatus?.hash).toBe("initial");
    expect(intervals).toHaveLength(1);

    const manualRefresh = harness.controller.refreshGit();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.gitStatus).toHaveBeenCalledTimes(2);

    intervals[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.gitStatus).toHaveBeenCalledTimes(2);

    manual.resolve(status("manual"));
    await manualRefresh;

    intervals[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.gitStatus).toHaveBeenCalledTimes(3);
    expect(statusSignals[2]).not.toBeUndefined();
    expect(harness.state.gitStatus?.hash).toBe("manual");
  });

  it("keeps a genuine foreground failure after the background window", async () => {
    startPollingClock();
    const harness = controllerFor(gitWorkspace);
    vi.spyOn(api, "gitStatus").mockRejectedValue(new Error("Git unavailable"));

    const manualRefresh = harness.controller.refreshGit();
    await vi.advanceTimersByTimeAsync(20_001);
    await manualRefresh;

    expect(harness.state.error).toBe("Error: Git unavailable");
  });
});

function controllerFor(workspace: Workspace, patch: Partial<AppState> = {}): { controller: GitController; state: AppState; apply(patch: Partial<AppState>): void } {
  let state: AppState = {
    ...initialAppState(),
    selectedProject: project,
    selectedWorkspace: workspace,
    ...patch,
  };
  const controller = new GitController(
    () => state,
    (next) => { state = { ...state, ...next }; },
    () => undefined,
  );
  return {
    controller,
    get state() { return state; },
    apply: (next) => { state = { ...state, ...next }; },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}

function status(hash: string) {
  return { isGitRepo: true, hash, files: [] };
}

function diff(staged: boolean) {
  return { path: "src/a.ts", staged, hash: staged ? "staged" : "unstaged", diff: "", truncated: false };
}

function statusWithPath(hash: string, path: string): GitStatusResponse {
  return { isGitRepo: true, hash, files: [{ path, index: "modified", workingTree: "unmodified" }] };
}

interface AbortableDeferred<T> {
  bind(signal: AbortSignal | undefined): Promise<T>;
  resolve(value: T): void;
}

function abortableDeferred<T>(): AbortableDeferred<T> {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { settle = resolve; });
  return {
    bind: (signal) => rejectOnAbort(promise, signal),
    resolve: (value) => { settle(value); },
  };
}

/** Rejects a pending read when its transport signal aborts, like a real fetch. */
function rejectOnAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortReason(signal));
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

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const fallback = new Error("The operation was aborted");
  fallback.name = "AbortError";
  return fallback;
}

function delayed(delayMs: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, delayMs); });
}

/** Drives the background deadline and the poll interval on a faked clock. */
function startPollingClock(): { readonly intervals: (() => void)[] } {
  vi.useFakeTimers();
  restoreAbortTimeout((delayMs: number): AbortSignal => {
    const controller = new AbortController();
    setTimeout(() => { controller.abort(new DOMException("The operation timed out.", "TimeoutError")); }, delayMs);
    return controller.signal;
  });
  const intervals: (() => void)[] = [];
  vi.stubGlobal("window", {
    setInterval: (callback: () => void): number => {
      intervals.push(callback);
      return 41;
    },
    clearInterval: vi.fn(),
  });
  return { intervals };
}

function restoreAbortTimeout(replacement: unknown): void {
  Object.defineProperty(AbortSignal, "timeout", { configurable: true, writable: true, value: replacement });
}
