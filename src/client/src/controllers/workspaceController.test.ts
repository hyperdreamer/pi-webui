import { describe, expect, it, vi } from "vitest";
import type { Machine, Project, SessionInfo, Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import { sessionActivityIndicators } from "../sessionActivity";
import { SessionController } from "./sessionController";
import { FakeSocket } from "./sessionController.testSupport";
import { InMemoryWorkspaceSelectionMemory } from "./workspaceSelection";
import { WorkspaceController, type WorkspaceControllerDependencies } from "./workspaceController";

const project: Project = {
  id: "project-1",
  name: "workspace",
  path: "/workspace",
  createdAt: "now",
};
const otherProject: Project = {
  id: "project-2",
  name: "other workspace",
  path: "/other-workspace",
  createdAt: "now",
};
const mainWorkspace = workspace(project, "workspace-1", project.path);
const featureWorkspace = workspace(project, "workspace-feature", "/workspace-feature");
const parentSession = session("parent", mainWorkspace.path);
const spawnedSession = session("spawned", featureWorkspace.path, { parentSessionPath: parentSession.path });
const remoteMachine: Machine = {
  id: "remote",
  name: "Remote",
  kind: "remote",
  createdAt: "now",
  updatedAt: "now",
};

describe("WorkspaceController", () => {
  it("marks sessions as loading until an opened workspace has returned its session list", async () => {
    const sessionRequest = deferred<SessionInfo[]>();
    let state: AppState = { ...initialAppState(), projects: [project], selectedProject: project };
    const sessions = sessionControllerStub();
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

    const selecting = controller.selectWorkspace(mainWorkspace);

    expect(state.isLoadingSessions).toBe(true);

    sessionRequest.resolve([]);
    await selecting;

    expect(state.isLoadingSessions).toBe(false);
    expect(state.sessions).toEqual([]);
  });

  it("loads related sessions from the selected project's other workspaces", async () => {
    let state: AppState = {
      ...initialAppState(),
      projects: [project],
      selectedProject: project,
      workspaces: [mainWorkspace, featureWorkspace],
    };
    const sessions = sessionControllerStub();
    const sessionsApi = vi.fn((cwd: string) => Promise.resolve(cwd === mainWorkspace.path ? [parentSession] : [spawnedSession]));
    const controller = new WorkspaceController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      sessions,
      new InMemoryWorkspaceSelectionMemory(),
      { api: { workspaces: () => Promise.resolve([]), sessions: sessionsApi } },
    );

    await controller.selectWorkspace(mainWorkspace);

    await vi.waitFor(() => {
      expect(state.projectSessions).toEqual([parentSession, spawnedSession]);
    });
    expect(sessionsApi).toHaveBeenCalledWith(featureWorkspace.path, "local");
  });

  it("applies a selected-project topology snapshot to both workspace projections and hydrates only added workspaces", async () => {
    const listSessions = vi.fn((cwd: string) => Promise.resolve(cwd === featureWorkspace.path ? [spawnedSession] : []));
    const harness = controllerForCatalog({
      selectedProject: project,
      selectedWorkspace: mainWorkspace,
      workspaces: [mainWorkspace],
      workspacesByProjectId: { [project.id]: [mainWorkspace] },
      projectSessions: [parentSession],
      listSessions,
    });

    await harness.controller.reconcileProjectCatalog({
      machineId: "local",
      project,
      workspaces: [mainWorkspace, featureWorkspace],
    });

    expect(harness.state.workspaces).toEqual([mainWorkspace, featureWorkspace]);
    expect(harness.state.workspacesByProjectId[project.id]).toEqual([mainWorkspace, featureWorkspace]);
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(listSessions).toHaveBeenCalledWith(featureWorkspace.path, "local");
    expect(harness.state.projectSessions).toEqual(expect.arrayContaining([parentSession, spawnedSession]));
    expect(harness.state.selectedWorkspace).toEqual(mainWorkspace);
  });

  it("renders activity after a session event preceded discovery of its worktree", async () => {
    const { controller, sessionController, state } = catalogHarnessWithLiveSessionController({
      workspaces: [mainWorkspace],
      projectSessions: [parentSession],
    });

    sessionController.applyGlobalEvent({ type: "session.created", session: spawnedSession });
    sessionController.applyGlobalEvent({
      type: "activity.update",
      activity: { sessionId: spawnedSession.id, phase: "active", label: "prompt accepted", at: "now" },
    });
    sessionController.flushPendingUpdates();

    expect(state.projectSessions).not.toContainEqual(spawnedSession);

    await controller.reconcileProjectCatalog({
      machineId: "local",
      project,
      workspaces: [mainWorkspace, featureWorkspace],
    });

    const indicators = sessionActivityIndicators(spawnedSession, state.projectSessions, {
      statuses: state.sessionStatuses,
      activities: state.sessionActivities,
    });
    expect(indicators).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "session", label: "This session is working" }),
    ]));
  });

  it("preserves a live session row that arrives while discovered-workspace hydration is in flight", async () => {
    const listedSessions = deferred<SessionInfo[]>();
    const { controller, sessionController, state } = catalogHarnessWithLiveSessionController({
      workspaces: [mainWorkspace],
      projectSessions: [parentSession],
      listSessions: () => listedSessions.promise,
    });

    const reconciling = controller.reconcileProjectCatalog({
      machineId: "local",
      project,
      workspaces: [mainWorkspace, featureWorkspace],
    });
    const liveSpawnedSession = { ...spawnedSession, messageCount: 7 };
    sessionController.applyGlobalEvent({ type: "session.created", session: liveSpawnedSession });
    listedSessions.resolve([{ ...spawnedSession, messageCount: 1 }]);

    await reconciling;

    expect(state.projectSessions.find((candidate) => candidate.path === spawnedSession.path)).toEqual(liveSpawnedSession);
  });

  it("hydrates a relocated workspace when its ID is unchanged but its path changes", async () => {
    const previousFeatureWorkspace = { ...featureWorkspace, path: "/workspace-feature-old" };
    const relocatedFeatureWorkspace = { ...featureWorkspace, path: "/workspace-feature-new" };
    const relocatedSession = { ...spawnedSession, cwd: relocatedFeatureWorkspace.path };
    const listSessions = vi.fn((cwd: string) => Promise.resolve(cwd === relocatedFeatureWorkspace.path ? [relocatedSession] : []));
    const harness = controllerForCatalog({
      selectedWorkspace: mainWorkspace,
      workspaces: [mainWorkspace, previousFeatureWorkspace],
      workspacesByProjectId: { [project.id]: [mainWorkspace, previousFeatureWorkspace] },
      projectSessions: [parentSession],
      listSessions,
    });

    await harness.controller.reconcileProjectCatalog({
      machineId: "local",
      project,
      workspaces: [mainWorkspace, relocatedFeatureWorkspace],
    });

    expect(harness.state.workspaces).toEqual([mainWorkspace, relocatedFeatureWorkspace]);
    expect(harness.state.projectSessions).toEqual(expect.arrayContaining([parentSession, relocatedSession]));
    expect(listSessions).toHaveBeenCalledWith(relocatedFeatureWorkspace.path, "local");
  });

  it("selects the main fallback when the selected workspace is removed from a snapshot", async () => {
    const harness = controllerForCatalog({
      selectedWorkspace: featureWorkspace,
      workspaces: [mainWorkspace, featureWorkspace],
      workspacesByProjectId: { [project.id]: [mainWorkspace, featureWorkspace] },
      projectSessions: [parentSession, spawnedSession],
    });

    await harness.controller.reconcileProjectCatalog({
      machineId: "local",
      project,
      workspaces: [mainWorkspace],
    });

    expect(harness.state.selectedProject).toEqual(project);
    expect(harness.state.selectedWorkspace).toEqual(mainWorkspace);
    expect(harness.state.workspaces).toEqual([mainWorkspace]);
    expect(harness.state.workspacesByProjectId[project.id]).toEqual([mainWorkspace]);
  });

  it("does not apply fallback sessions or navigation after its catalog path becomes stale", async () => {
    const fallbackSessions = deferred<SessionInfo[]>();
    const listSessions = vi.fn(() => fallbackSessions.promise);
    const updateUrl = vi.fn();
    const selectSession = vi.fn(() => {
      updateUrl();
      return Promise.resolve();
    });
    const harness = controllerForCatalog({
      selectedWorkspace: featureWorkspace,
      workspaces: [mainWorkspace, featureWorkspace],
      workspacesByProjectId: { [project.id]: [mainWorkspace, featureWorkspace] },
      projectSessions: [parentSession, spawnedSession],
      listSessions,
      updateUrl,
      sessionController: {
        clearActiveSession: () => undefined,
        preferredSession: () => parentSession,
        selectSession,
      },
    });

    const reconciling = harness.controller.reconcileProjectCatalog({
      machineId: "local",
      project,
      workspaces: [mainWorkspace],
    });
    await vi.waitFor(() => {
      expect(listSessions).toHaveBeenCalledWith(mainWorkspace.path, "local");
    });

    harness.apply({ projects: [{ ...project, path: "/workspace-moved" }] });
    fallbackSessions.resolve([parentSession]);

    await reconciling;

    expect(harness.state.sessions).toEqual([]);
    expect(harness.state.projectSessions).toEqual([]);
    expect(harness.state.isLoadingSessions).toBe(false);
    expect(selectSession).not.toHaveBeenCalled();
    expect(updateUrl).not.toHaveBeenCalled();
  });

  it("keeps a newer foreground selection's session loading state when a stale catalog fallback finishes", async () => {
    const fallbackSessions = deferred<SessionInfo[]>();
    const foregroundSessions = deferred<SessionInfo[]>();
    const listSessions = vi.fn(() => fallbackSessions.promise)
      .mockImplementationOnce(() => fallbackSessions.promise)
      .mockImplementationOnce(() => foregroundSessions.promise);
    const harness = controllerForCatalog({
      selectedWorkspace: featureWorkspace,
      workspaces: [mainWorkspace, featureWorkspace],
      workspacesByProjectId: { [project.id]: [mainWorkspace, featureWorkspace] },
      projectSessions: [parentSession, spawnedSession],
      listSessions,
    });

    const reconciling = harness.controller.reconcileProjectCatalog({
      machineId: "local",
      project,
      workspaces: [mainWorkspace],
    });
    await vi.waitFor(() => {
      expect(listSessions).toHaveBeenCalledTimes(1);
    });

    harness.apply({ projects: [{ ...project, path: "/workspace-moved" }] });
    const selectingForeground = harness.controller.selectWorkspace(mainWorkspace);
    await vi.waitFor(() => {
      expect(listSessions).toHaveBeenCalledTimes(2);
    });

    fallbackSessions.resolve([]);
    await reconciling;

    expect(harness.state.isLoadingSessions).toBe(true);

    foregroundSessions.resolve([]);
    await selectingForeground;

    expect(harness.state.isLoadingSessions).toBe(false);
  });

  it("clears the foreground selection when no workspace remains after a snapshot", async () => {
    const harness = controllerForCatalog({
      selectedWorkspace: mainWorkspace,
      workspaces: [mainWorkspace],
      workspacesByProjectId: { [project.id]: [mainWorkspace] },
      projectSessions: [parentSession],
      error: "existing foreground error",
    });

    await harness.controller.reconcileProjectCatalog({
      machineId: "local",
      project,
      workspaces: [],
    });

    expect(harness.state.selectedProject).toBeUndefined();
    expect(harness.state.selectedWorkspace).toBeUndefined();
    expect(harness.state.workspaces).toEqual([]);
    expect(harness.state.projectSessions).toEqual([]);
    expect(harness.state.error).toBe("existing foreground error");
  });

  it("updates only the per-project topology cache for a non-selected project snapshot", async () => {
    const otherMainWorkspace = workspace(otherProject, "other-main", otherProject.path);
    const otherFeatureWorkspace = workspace(otherProject, "other-feature", "/other-workspace-feature");
    const listSessions = vi.fn(() => Promise.resolve([spawnedSession]));
    const harness = controllerForCatalog({
      projects: [project, otherProject],
      selectedProject: project,
      selectedWorkspace: mainWorkspace,
      workspaces: [mainWorkspace],
      workspacesByProjectId: {
        [project.id]: [mainWorkspace],
        [otherProject.id]: [otherMainWorkspace],
      },
      projectSessions: [parentSession],
      listSessions,
    });

    await harness.controller.reconcileProjectCatalog({
      machineId: "local",
      project: otherProject,
      workspaces: [otherMainWorkspace, otherFeatureWorkspace],
    });

    expect(harness.state.workspaces).toEqual([mainWorkspace]);
    expect(harness.state.selectedProject).toEqual(project);
    expect(harness.state.selectedWorkspace).toEqual(mainWorkspace);
    expect(harness.state.projectSessions).toEqual([parentSession]);
    expect(harness.state.workspacesByProjectId[otherProject.id]).toEqual([otherMainWorkspace, otherFeatureWorkspace]);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("retains a failed discovered workspace for background retry without replacing foreground error", async () => {
    const error = new Error("feature sessions unavailable");
    const listSessions = vi.fn(() => Promise.reject(error));
    const onBackgroundError = vi.fn();
    const harness = controllerForCatalog({
      selectedWorkspace: mainWorkspace,
      workspaces: [mainWorkspace],
      workspacesByProjectId: { [project.id]: [mainWorkspace] },
      projectSessions: [parentSession],
      error: "existing foreground error",
      listSessions,
      onBackgroundError,
    });
    const snapshot = {
      machineId: "local",
      project,
      workspaces: [mainWorkspace, featureWorkspace],
    };

    await harness.controller.reconcileProjectCatalog(snapshot);

    expect(harness.state.workspaces).toEqual([mainWorkspace, featureWorkspace]);
    expect(harness.state.error).toBe("existing foreground error");
    expect(harness.state.projectSessions).toEqual([parentSession]);
    expect(onBackgroundError).toHaveBeenCalledWith("reconcile discovered workspace sessions", error);

    await harness.controller.reconcileProjectCatalog(snapshot);

    expect(listSessions).toHaveBeenCalledTimes(2);
  });

  it("preserves foreground error when failed discovery falls back from a removed workspace", async () => {
    const unavailableWorkspace = workspace(project, "workspace-unavailable", "/workspace-unavailable");
    const error = new Error("unavailable workspace sessions");
    const onBackgroundError = vi.fn();
    const harness = controllerForCatalog({
      selectedWorkspace: featureWorkspace,
      workspaces: [mainWorkspace, featureWorkspace],
      workspacesByProjectId: { [project.id]: [mainWorkspace, featureWorkspace] },
      projectSessions: [parentSession, spawnedSession],
      error: "existing foreground error",
      listSessions: (cwd: string) => {
        if (cwd === unavailableWorkspace.path) return Promise.reject<SessionInfo[]>(error);
        return Promise.resolve<SessionInfo[]>([]);
      },
      onBackgroundError,
    });

    await harness.controller.reconcileProjectCatalog({
      machineId: "local",
      project,
      workspaces: [mainWorkspace, unavailableWorkspace],
    });

    expect(harness.state.selectedWorkspace).toEqual(mainWorkspace);
    expect(harness.state.error).toBe("existing foreground error");
    expect(onBackgroundError).toHaveBeenCalledWith("reconcile discovered workspace sessions", error);
  });

  it("rejects catalog snapshots with stale machine, project, or path scope", async () => {
    const listSessions = vi.fn(() => Promise.resolve([spawnedSession]));
    const harness = controllerForCatalog({
      selectedWorkspace: mainWorkspace,
      workspaces: [mainWorkspace],
      workspacesByProjectId: { [project.id]: [mainWorkspace] },
      projectSessions: [parentSession],
      listSessions,
    });
    const snapshot = { machineId: "local", project, workspaces: [mainWorkspace, featureWorkspace] };

    await harness.controller.reconcileProjectCatalog({ ...snapshot, machineId: remoteMachine.id });
    harness.apply({ projects: [] });
    await harness.controller.reconcileProjectCatalog(snapshot);
    harness.apply({ projects: [{ ...project, path: "/workspace-moved" }] });
    await harness.controller.reconcileProjectCatalog(snapshot);

    expect(harness.state.workspaces).toEqual([mainWorkspace]);
    expect(harness.state.workspacesByProjectId[project.id]).toEqual([mainWorkspace]);
    expect(harness.state.projectSessions).toEqual([parentSession]);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("does not merge discovered sessions after the catalog scope changes during hydration", async () => {
    const listedSessions = deferred<SessionInfo[]>();
    const harness = controllerForCatalog({
      selectedWorkspace: mainWorkspace,
      workspaces: [mainWorkspace],
      workspacesByProjectId: { [project.id]: [mainWorkspace] },
      projectSessions: [parentSession],
      listSessions: () => listedSessions.promise,
    });

    const reconciling = harness.controller.reconcileProjectCatalog({
      machineId: "local",
      project,
      workspaces: [mainWorkspace, featureWorkspace],
    });
    harness.apply({ selectedMachine: remoteMachine });
    listedSessions.resolve([spawnedSession]);

    await reconciling;

    expect(harness.state.projectSessions).toEqual([parentSession]);
  });

  it("returns fetched workspaces after reconciling them for command-run callers", async () => {
    const listWorkspaces = vi.fn(() => Promise.resolve([mainWorkspace, featureWorkspace]));
    const harness = controllerForCatalog({
      selectedWorkspace: mainWorkspace,
      workspaces: [mainWorkspace],
      workspacesByProjectId: { [project.id]: [mainWorkspace] },
      projectSessions: [parentSession],
      listWorkspaces,
      listSessions: (cwd: string) => Promise.resolve(cwd === featureWorkspace.path ? [spawnedSession] : []),
    });

    const fetched = await harness.controller.refreshProjectWorkspaces(project.id);

    expect(fetched).toEqual([mainWorkspace, featureWorkspace]);
    expect(harness.state.workspaces).toEqual([mainWorkspace, featureWorkspace]);
    expect(harness.state.workspacesByProjectId[project.id]).toEqual([mainWorkspace, featureWorkspace]);
    expect(harness.state.projectSessions).toEqual(expect.arrayContaining([parentSession, spawnedSession]));
  });
});

type WorkspaceApi = NonNullable<WorkspaceControllerDependencies["api"]>;
type ListSessions = WorkspaceApi["sessions"];
type ListWorkspaces = WorkspaceApi["workspaces"];

interface CatalogHarnessInput extends Partial<AppState> {
  listSessions?: ListSessions;
  listWorkspaces?: ListWorkspaces;
  onBackgroundError?: WorkspaceControllerDependencies["onBackgroundError"];
  sessionController?: Pick<SessionController, "clearActiveSession" | "preferredSession" | "selectSession">;
  updateUrl?: () => void;
}

function controllerForCatalog({
  listSessions = () => Promise.resolve([]),
  listWorkspaces = () => Promise.resolve([]),
  onBackgroundError,
  sessionController = sessionControllerStub(),
  updateUrl = () => undefined,
  ...statePatch
}: CatalogHarnessInput) {
  const state: AppState = {
    ...initialAppState(),
    projects: [project],
    selectedProject: project,
    ...statePatch,
  };
  const controller = new WorkspaceController(
    () => state,
    (patch) => { Object.assign(state, patch); },
    updateUrl,
    sessionController,
    new InMemoryWorkspaceSelectionMemory(),
    {
      api: { workspaces: listWorkspaces, sessions: listSessions },
      ...(onBackgroundError === undefined ? {} : { onBackgroundError }),
    },
  );
  return {
    controller,
    get state() { return state; },
    apply: (patch: Partial<AppState>) => { Object.assign(state, patch); },
  };
}

function catalogHarnessWithLiveSessionController(input: {
  workspaces: Workspace[];
  projectSessions: SessionInfo[];
  listSessions?: ListSessions;
}) {
  const state: AppState = {
    ...initialAppState(),
    projects: [project],
    selectedProject: project,
    selectedWorkspace: mainWorkspace,
    workspaces: input.workspaces,
    workspacesByProjectId: { [project.id]: input.workspaces },
    sessions: [parentSession],
    projectSessions: input.projectSessions,
  };
  const sessionController = new SessionController(
    () => state,
    (patch) => { Object.assign(state, patch); },
    () => undefined,
    undefined,
    { socket: new FakeSocket() },
  );
  const controller = new WorkspaceController(
    () => state,
    (patch) => { Object.assign(state, patch); },
    () => undefined,
    sessionController,
    new InMemoryWorkspaceSelectionMemory(),
    {
      api: {
        workspaces: () => Promise.resolve([]),
        sessions: input.listSessions ?? ((cwd: string) => Promise.resolve(cwd === featureWorkspace.path ? [spawnedSession] : [])),
      },
    },
  );
  return { controller, sessionController, state };
}

function sessionControllerStub(): Pick<SessionController, "clearActiveSession" | "preferredSession" | "selectSession"> {
  return {
    clearActiveSession: () => undefined,
    preferredSession: () => undefined,
    selectSession: () => Promise.resolve(),
  };
}

function workspace(projectForWorkspace: Project, id: string, path: string): Workspace {
  return {
    id,
    projectId: projectForWorkspace.id,
    path,
    label: id,
    isMain: path === projectForWorkspace.path,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}
