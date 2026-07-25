import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type Project, type Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import { GitController } from "./gitController";

const project: Project = { id: "project-1", name: "Project", path: "/repo", createdAt: "now" };
const gitWorkspace: Workspace = { id: "workspace-1", projectId: project.id, path: "/repo", label: "main", isMain: true, isGitRepo: true, isGitWorktree: false };

afterEach(() => {
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
