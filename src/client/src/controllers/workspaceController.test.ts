import { describe, expect, it } from "vitest";
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
    const sessions: Pick<SessionController, "clearActiveSession" | "preferredSession" | "selectSession"> = {
      clearActiveSession: () => undefined,
      preferredSession: () => undefined,
      selectSession: () => Promise.resolve(),
    };
    const controller = new WorkspaceController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      sessions,
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
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}
