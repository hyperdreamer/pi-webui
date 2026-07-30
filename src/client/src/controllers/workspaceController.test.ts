import { describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import type { Project, SessionInfo, Workspace } from "../api";
import { InMemoryWorkspaceSelectionMemory } from "./workspaceSelection";
import { WorkspaceController } from "./workspaceController";
import type { SessionController } from "./sessionController";

describe("WorkspaceController", () => {
  it("marks sessions as loading until an opened workspace has returned its session list", async () => {
    const project: Project = { id: "project-1", name: "workspace", path: "/workspace", createdAt: "now" };
    const workspace: Workspace = {
      id: "workspace-1",
      projectId: project.id,
      path: project.path,
      label: project.name,
      isMain: true,
      isGitRepo: false,
      isGitWorktree: false,
    };
    const sessionRequest = deferred<SessionInfo[]>();
    let state: AppState = { ...initialAppState(), projects: [project], selectedProject: project };
    const controller = new WorkspaceController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      sessionControllerStub(),
      new InMemoryWorkspaceSelectionMemory(),
      {
        api: {
          workspaces: () => Promise.resolve([]),
          sessions: () => sessionRequest.promise,
        },
      },
    );

    const selecting = controller.selectWorkspace(workspace);

    expect(state.isLoadingSessions).toBe(true);

    sessionRequest.resolve([]);
    await selecting;

    expect(state.isLoadingSessions).toBe(false);
    expect(state.sessions).toEqual([]);
  });

  it("preserves loaded memory when reselecting the identical workspace scope", async () => {
    const project: Project = { id: "project-1", name: "workspace", path: "/workspace", createdAt: "now" };
    const main = workspace(project, "workspace-1", "/workspace");
    const memory: AppState["memory"] = {
      kind: "data",
      globalEntries: [{ id: "global", content: "Global memory" }],
      projectEntries: [{ id: "project", content: "Project memory" }],
    };
    const sessionRequest = deferred<SessionInfo[]>();
    let state: AppState = {
      ...initialAppState(),
      projects: [project],
      selectedProject: project,
      selectedWorkspace: main,
      memory,
    };
    const controller = new WorkspaceController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      sessionControllerStub(),
      new InMemoryWorkspaceSelectionMemory(),
      { api: { workspaces: () => Promise.resolve([]), sessions: () => sessionRequest.promise } },
    );

    const selecting = controller.selectWorkspace({ ...main });

    expect(state.memory).toEqual(memory);
    expect(state.isLoadingSessions).toBe(true);

    sessionRequest.resolve([]);
    await selecting;
  });

  it("resets memory when selecting a workspace with a different path", async () => {
    const project: Project = { id: "project-1", name: "workspace", path: "/workspace", createdAt: "now" };
    const main = workspace(project, "workspace-1", "/workspace");
    const moved = workspace(project, "workspace-1", "/workspace-moved");
    const sessionRequest = deferred<SessionInfo[]>();
    let state: AppState = {
      ...initialAppState(),
      projects: [project],
      selectedProject: project,
      selectedWorkspace: main,
      memory: {
        kind: "data",
        globalEntries: [{ id: "global", content: "Global memory" }],
        projectEntries: [{ id: "project", content: "Project memory" }],
      },
    };
    const controller = new WorkspaceController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      sessionControllerStub(),
      new InMemoryWorkspaceSelectionMemory(),
      { api: { workspaces: () => Promise.resolve([]), sessions: () => sessionRequest.promise } },
    );

    const selecting = controller.selectWorkspace(moved);

    expect(state.memory).toEqual({ kind: "loading" });

    sessionRequest.resolve([]);
    await selecting;
  });

  it("loads related sessions from the selected project's other workspaces", async () => {
    const project: Project = { id: "project-1", name: "workspace", path: "/workspace", createdAt: "now" };
    const main = workspace(project, "workspace-1", "/workspace");
    const feature = workspace(project, "workspace-feature", "/workspace-feature");
    const mainSession = session("parent", main.path);
    const featureSession = session("child", feature.path, { parentSessionPath: mainSession.path });
    let state: AppState = { ...initialAppState(), projects: [project], selectedProject: project, workspaces: [main, feature] };
    const sessionsApi = vi.fn((cwd: string) => Promise.resolve(cwd === main.path ? [mainSession] : [featureSession]));
    const controller = new WorkspaceController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      sessionControllerStub(),
      new InMemoryWorkspaceSelectionMemory(),
      { api: { workspaces: () => Promise.resolve([]), sessions: sessionsApi } },
    );

    await controller.selectWorkspace(main);

    await vi.waitFor(() => {
      expect(state.projectSessions).toEqual([mainSession, featureSession]);
    });
    expect(sessionsApi).toHaveBeenCalledWith(feature.path, "local");
  });
});

function workspace(project: Project, id: string, path: string): Workspace {
  return {
    id,
    projectId: project.id,
    path,
    label: id,
    isMain: path === project.path,
    isGitRepo: false,
    isGitWorktree: false,
  };
}

function session(id: string, cwd: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd,
    created: "2026-06-09T00:00:00.000Z",
    modified: "2026-06-09T00:00:00.000Z",
    messageCount: 1,
    firstMessage: id,
    ...overrides,
  };
}

function sessionControllerStub(): Pick<SessionController, "clearActiveSession" | "preferredSession" | "selectSession"> {
  return {
    clearActiveSession: () => undefined,
    preferredSession: () => undefined,
    selectSession: () => Promise.resolve(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}
