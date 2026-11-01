import { describe, expect, it, vi } from "vitest";
import type { Machine, Project, SessionInfo, Workspace } from "../api";
import { HttpRequestError } from "../api";
import { HttpResponseBodyError } from "../api/http";
import { initialAppState, type AppState } from "../appState";
import { sessionActivityIndicators } from "../sessionActivity";
import { REMOTE_BACKGROUND_REQUEST_TIMEOUT_MS, DEFAULT_REMOTE_REQUEST_TIMEOUT_MS } from "../../../shared/machineRequestTimeout";
import { isLoadCancellation, LoadCancelledError } from "./cancellableLoadScope";
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

  it("keeps the latest exact workspace reselect's sessions and preferred selection", async () => {
    const project: Project = { id: "project-1", name: "workspace", path: "/workspace", createdAt: "now" };
    const main = workspace(project, "workspace-1", "/workspace");
    const firstRequest = deferred<SessionInfo[]>();
    const latestRequest = deferred<SessionInfo[]>();
    const requests = [firstRequest, latestRequest];
    const selectedSessionIds: string[] = [];
    let state: AppState = {
      ...initialAppState(),
      projects: [project],
      selectedProject: project,
      selectedWorkspace: main,
    };
    const controller = new WorkspaceController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      {
        ...sessionControllerStub(),
        clearActiveSession: () => undefined,
        preferredSession: (_cwd, sessions) => sessions[0],
        selectSession: (selected) => {
          selectedSessionIds.push(selected.id);
          return Promise.resolve();
        },
      },
      new InMemoryWorkspaceSelectionMemory(),
      {
        api: {
          workspaces: () => Promise.resolve([]),
          sessions: () => {
            const request = requests.shift();
            if (request === undefined) throw new Error("Unexpected session request");
            return request.promise;
          },
        },
      },
    );
    const firstSelecting = controller.selectWorkspace({ ...main });
    const latestSelecting = controller.selectWorkspace({ ...main });
    const latestSessions = [session("latest", main.path)];

    latestRequest.resolve(latestSessions);
    await latestSelecting;

    expect(state.sessions).toEqual(latestSessions);
    expect(state.projectSessions).toEqual(latestSessions);
    expect(state.isLoadingSessions).toBe(false);
    expect(selectedSessionIds).toEqual(["latest"]);

    firstRequest.resolve([session("stale", main.path)]);
    await firstSelecting;

    expect(state.sessions).toEqual(latestSessions);
    expect(state.projectSessions).toEqual(latestSessions);
    expect(state.isLoadingSessions).toBe(false);
    expect(selectedSessionIds).toEqual(["latest"]);
  });

  it("ignores a stale exact workspace reselect error", async () => {
    const project: Project = { id: "project-1", name: "workspace", path: "/workspace", createdAt: "now" };
    const main = workspace(project, "workspace-1", "/workspace");
    const firstRequest = deferred<SessionInfo[]>();
    const latestRequest = deferred<SessionInfo[]>();
    const requests = [firstRequest, latestRequest];
    const latestSessions = [session("latest", main.path)];
    let state: AppState = {
      ...initialAppState(),
      projects: [project],
      selectedProject: project,
      selectedWorkspace: main,
    };
    const controller = new WorkspaceController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      sessionControllerStub(),
      new InMemoryWorkspaceSelectionMemory(),
      {
        api: {
          workspaces: () => Promise.resolve([]),
          sessions: () => {
            const request = requests.shift();
            if (request === undefined) throw new Error("Unexpected session request");
            return request.promise;
          },
        },
      },
    );
    const firstSelecting = controller.selectWorkspace({ ...main });
    const latestSelecting = controller.selectWorkspace({ ...main });

    latestRequest.resolve(latestSessions);
    await latestSelecting;
    firstRequest.reject(new Error("stale sessions request"));
    await firstSelecting;

    expect(state.sessions).toEqual(latestSessions);
    expect(state.projectSessions).toEqual(latestSessions);
    expect(state.isLoadingSessions).toBe(false);
    expect(state.error).toBe("");
  });

  it("keeps a newer catalog topology when a foreground project load settles late", async () => {
    const staleWorkspaces = [mainWorkspace];
    const currentWorkspaces = [mainWorkspace, featureWorkspace];
    const foregroundWorkspaces = deferred<Workspace[]>();
    const selectedSessionIds: string[] = [];
    let state: AppState = { ...initialAppState(), projects: [project] };
    const controller = new WorkspaceController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      {
        ...sessionControllerStub(),
        clearActiveSession: () => undefined,
        preferredSession: (_cwd, sessions) => sessions[0],
        selectSession: (selected) => {
          selectedSessionIds.push(selected.id);
          return Promise.resolve();
        },
      },
      new InMemoryWorkspaceSelectionMemory(),
      {
        api: {
          workspaces: () => foregroundWorkspaces.promise,
          sessions: (cwd) => Promise.resolve(cwd === featureWorkspace.path ? [spawnedSession] : [parentSession]),
        },
      },
    );

    const selecting = controller.selectProject(project, { workspaceId: featureWorkspace.id });
    const topologyRequest = controller.captureProjectCatalogTopologyRequest({
      machineId: "local",
      projectId: project.id,
      projectPath: project.path,
    });
    await controller.reconcileProjectCatalog({
      machineId: "local",
      project,
      workspaces: currentWorkspaces,
      topologyRequest,
    });

    expect(state.workspaces).toEqual(currentWorkspaces);
    expect(state.workspacesByProjectId[project.id]).toEqual(currentWorkspaces);

    foregroundWorkspaces.resolve(staleWorkspaces);
    await selecting;

    expect(state.workspaces).toEqual(currentWorkspaces);
    expect(state.workspacesByProjectId[project.id]).toEqual(currentWorkspaces);
    expect(state.selectedWorkspace).toEqual(featureWorkspace);
    expect(selectedSessionIds).toEqual([spawnedSession.id]);
  });

  it("settles a catalog-completed foreground session list after a later topology request starts", async () => {
    const foregroundWorkspaces = deferred<Workspace[]>();
    const featureSessions = deferred<SessionInfo[]>();
    const selectedSessionIds: string[] = [];
    const listSessions = vi.fn((cwd: string) => (
      cwd === featureWorkspace.path ? featureSessions.promise : Promise.resolve<SessionInfo[]>([])
    ));
    let state: AppState = { ...initialAppState(), projects: [project] };
    const controller = new WorkspaceController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      {
        ...sessionControllerStub(),
        clearActiveSession: () => undefined,
        preferredSession: (_cwd, sessions) => sessions[0],
        selectSession: (selected) => {
          selectedSessionIds.push(selected.id);
          return Promise.resolve();
        },
      },
      new InMemoryWorkspaceSelectionMemory(),
      {
        api: {
          workspaces: () => foregroundWorkspaces.promise,
          sessions: listSessions,
        },
      },
    );

    const selecting = controller.selectProject(project, {
      workspaceId: featureWorkspace.id,
      sessionId: spawnedSession.id,
    });
    const topologyRequest = controller.captureProjectCatalogTopologyRequest({
      machineId: "local",
      projectId: project.id,
      projectPath: project.path,
    });
    const reconciling = controller.reconcileProjectCatalog({
      machineId: "local",
      project,
      workspaces: [mainWorkspace, featureWorkspace],
      topologyRequest,
    });
    await vi.waitFor(() => {
      expect(listSessions).toHaveBeenCalledWith(featureWorkspace.path, "local", expect.any(AbortSignal));
    });

    controller.captureProjectCatalogTopologyRequest({
      machineId: "local",
      projectId: project.id,
      projectPath: project.path,
    });
    featureSessions.resolve([spawnedSession]);
    await reconciling;

    expect(state.selectedWorkspace).toEqual(featureWorkspace);
    expect(state.sessions).toEqual(expect.arrayContaining([spawnedSession]));
    expect(state.projectSessions).toEqual(expect.arrayContaining([spawnedSession]));
    expect(state.isLoadingSessions).toBe(false);
    expect(selectedSessionIds).toEqual([spawnedSession.id]);

    foregroundWorkspaces.resolve([mainWorkspace]);
    await selecting;
  });

  it("does not restore an old-path foreground topology after the same project ID is retargeted", async () => {
    const replacementProject = { ...project, path: "/workspace-replacement" };
    const oldMain = workspace(project, "workspace-1", project.path);
    const replacementMain = workspace(replacementProject, "workspace-1", replacementProject.path);
    const oldForeground = deferred<Workspace[]>();
    const replacementForeground = deferred<Workspace[]>();
    const workspaces = vi.fn()
      .mockImplementationOnce(() => oldForeground.promise)
      .mockImplementationOnce(() => replacementForeground.promise);
    const harness = controllerForCatalog({ projects: [project], listWorkspaces: workspaces });

    const oldSelecting = harness.controller.selectProject(project);
    harness.apply({ projects: [replacementProject] });
    const replacementSelecting = harness.controller.selectProject(replacementProject);
    const topologyRequest = harness.controller.captureProjectCatalogTopologyRequest({
      machineId: "local",
      projectId: replacementProject.id,
      projectPath: replacementProject.path,
    });
    await harness.controller.reconcileProjectCatalog({
      machineId: "local",
      project: replacementProject,
      workspaces: [replacementMain],
      topologyRequest,
    });

    oldForeground.resolve([oldMain]);
    replacementForeground.resolve([oldMain]);
    await Promise.all([oldSelecting, replacementSelecting]);

    expect(harness.state.selectedProject).toEqual(replacementProject);
    expect(harness.state.workspaces).toEqual([replacementMain]);
    expect(harness.state.workspacesByProjectId[replacementProject.id]).toEqual([replacementMain]);
    expect(harness.state.selectedWorkspace).toEqual(replacementMain);
  });

  it("ignores a stale foreground project-load failure after catalog selection completes", async () => {
    const foregroundWorkspaces = deferred<Workspace[]>();
    const currentWorkspaces = [mainWorkspace, featureWorkspace];
    let state: AppState = { ...initialAppState(), projects: [project] };
    const controller = new WorkspaceController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      sessionControllerStub(),
      new InMemoryWorkspaceSelectionMemory(),
      {
        api: {
          workspaces: () => foregroundWorkspaces.promise,
          sessions: () => Promise.resolve([]),
        },
      },
    );

    const selecting = controller.selectProject(project);
    const topologyRequest = controller.captureProjectCatalogTopologyRequest({
      machineId: "local",
      projectId: project.id,
      projectPath: project.path,
    });
    await controller.reconcileProjectCatalog({
      machineId: "local",
      project,
      workspaces: currentWorkspaces,
      topologyRequest,
    });

    foregroundWorkspaces.reject(new Error("stale foreground workspace load"));
    await selecting;

    expect(state.workspaces).toEqual(currentWorkspaces);
    expect(state.workspacesByProjectId[project.id]).toEqual(currentWorkspaces);
    expect(state.selectedWorkspace).toEqual(mainWorkspace);
    expect(state.error).toBe("");
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
    expect(sessionsApi).toHaveBeenCalledWith(featureWorkspace.path, "local", expect.any(AbortSignal));
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
        applyRefreshedSessionLists: () => Promise.resolve(),
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
      expect(listSessions).toHaveBeenCalledWith(mainWorkspace.path, "local", undefined);
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

  it("does not clear a newer machine scope's session loading when a stale catalog fallback settles", async () => {
    const fallbackSessions = deferred<SessionInfo[]>();
    const harness = controllerForCatalog({
      selectedWorkspace: featureWorkspace,
      workspaces: [mainWorkspace, featureWorkspace],
      workspacesByProjectId: { [project.id]: [mainWorkspace, featureWorkspace] },
      projectSessions: [parentSession, spawnedSession],
      listSessions: () => fallbackSessions.promise,
    });

    const reconciling = harness.controller.reconcileProjectCatalog({
      machineId: "local",
      project,
      workspaces: [mainWorkspace],
    });
    await vi.waitFor(() => {
      expect(harness.state.selectedWorkspace).toEqual(mainWorkspace);
      expect(harness.state.isLoadingSessions).toBe(true);
    });

    harness.apply({ selectedMachine: remoteMachine, isLoadingSessions: true });
    fallbackSessions.resolve([]);

    await reconciling;

    expect(harness.state.selectedMachine).toEqual(remoteMachine);
    expect(harness.state.isLoadingSessions).toBe(true);
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

  it("keeps a replacement-path catalog snapshot cache-only for an obsolete selected project", async () => {
    const replacementProject = { ...project, path: "/workspace-replacement" };
    const oldMainWorkspace = workspace(project, "old-main", project.path);
    const replacementMainWorkspace = workspace(replacementProject, "replacement-main", replacementProject.path);
    const oldSession = session("old", oldMainWorkspace.path);
    const listSessions = vi.fn(() => Promise.resolve<SessionInfo[]>([]));
    const updateUrl = vi.fn();
    const harness = controllerForCatalog({
      projects: [replacementProject],
      selectedProject: project,
      selectedWorkspace: oldMainWorkspace,
      workspaces: [oldMainWorkspace],
      workspacesByProjectId: { [project.id]: [oldMainWorkspace] },
      sessions: [oldSession],
      projectSessions: [oldSession],
      listSessions,
      updateUrl,
    });

    await harness.controller.reconcileProjectCatalog({
      machineId: "local",
      project: replacementProject,
      workspaces: [replacementMainWorkspace],
    });

    expect(harness.state.workspacesByProjectId[project.id]).toEqual([replacementMainWorkspace]);
    expect(harness.state.selectedProject).toEqual(project);
    expect(harness.state.workspaces).toEqual([oldMainWorkspace]);
    expect(harness.state.selectedWorkspace).toEqual(oldMainWorkspace);
    expect(harness.state.sessions).toEqual([oldSession]);
    expect(harness.state.projectSessions).toEqual([oldSession]);
    expect(listSessions).not.toHaveBeenCalled();
    expect(updateUrl).not.toHaveBeenCalled();
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

  it("keeps a failed catalog fallback session list in the background and retries it on an identical snapshot", async () => {
    const error = new Error("main workspace sessions unavailable");
    const onBackgroundError = vi.fn();
    const listSessions = vi.fn((cwd: string) => (
      cwd === mainWorkspace.path && listSessions.mock.calls.length === 1
        ? Promise.reject<SessionInfo[]>(error)
        : Promise.resolve<SessionInfo[]>([parentSession])
    ));
    const { controller, state } = catalogHarnessWithLiveSessionController({
      selectedWorkspace: featureWorkspace,
      workspaces: [mainWorkspace, featureWorkspace],
      sessions: [spawnedSession],
      projectSessions: [parentSession, spawnedSession],
      error: "existing foreground error",
      listSessions,
      onBackgroundError,
    });
    const snapshot = {
      machineId: "local",
      project,
      workspaces: [mainWorkspace],
    };

    await controller.reconcileProjectCatalog(snapshot);

    expect(state.selectedWorkspace).toEqual(mainWorkspace);
    expect(state.error).toBe("existing foreground error");
    expect(state.sessions).toEqual([parentSession]);
    expect(state.projectSessions).toEqual([parentSession]);
    expect(state.isLoadingSessions).toBe(false);
    expect(onBackgroundError).toHaveBeenCalledWith("reconcile selected workspace fallback sessions", error);

    await controller.reconcileProjectCatalog(snapshot);

    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(listSessions).toHaveBeenLastCalledWith(mainWorkspace.path, "local");
    expect(state.sessions).toEqual([parentSession]);
    expect(state.projectSessions).toEqual([parentSession]);
  });

  it("recovers a stale catalog fallback rejection under a newer same-scope topology token", async () => {
    const fallbackSessions = deferred<SessionInfo[]>();
    const error = new Error("main workspace sessions unavailable");
    const onBackgroundError = vi.fn();
    const listSessions = vi.fn((cwd: string) => (
      cwd === mainWorkspace.path && listSessions.mock.calls.length === 1
        ? fallbackSessions.promise
        : Promise.resolve<SessionInfo[]>([parentSession])
    ));
    const harness = controllerForCatalog({
      selectedWorkspace: featureWorkspace,
      workspaces: [mainWorkspace, featureWorkspace],
      workspacesByProjectId: { [project.id]: [mainWorkspace, featureWorkspace] },
      sessions: [spawnedSession],
      projectSessions: [parentSession, spawnedSession],
      error: "existing foreground error",
      listSessions,
      onBackgroundError,
    });
    const scope = { machineId: "local", projectId: project.id, projectPath: project.path };
    const olderRequest = harness.controller.captureProjectCatalogTopologyRequest(scope);

    const reconcilingOlderSnapshot = harness.controller.reconcileProjectCatalog({
      machineId: "local",
      project,
      workspaces: [mainWorkspace],
      topologyRequest: olderRequest,
    });
    await vi.waitFor(() => {
      expect(listSessions).toHaveBeenCalledOnce();
    });

    const newerRequest = harness.controller.captureProjectCatalogTopologyRequest(scope);
    await harness.controller.reconcileProjectCatalog({
      machineId: "local",
      project,
      workspaces: [mainWorkspace],
      topologyRequest: newerRequest,
    });
    expect(harness.state.selectedWorkspace).toEqual(mainWorkspace);
    expect(harness.state.sessions).toEqual([]);
    expect(harness.state.projectSessions).toEqual([]);
    expect(harness.state.isLoadingSessions).toBe(true);

    fallbackSessions.reject(error);
    await reconcilingOlderSnapshot;

    expect(harness.state.sessions).toEqual([parentSession]);
    expect(harness.state.projectSessions).toEqual([parentSession]);
    expect(harness.state.error).toBe("existing foreground error");
    expect(harness.state.isLoadingSessions).toBe(false);
    expect(onBackgroundError).toHaveBeenCalledOnce();
    expect(onBackgroundError).toHaveBeenCalledWith("reconcile selected workspace fallback sessions", error);

    const retryRequest = harness.controller.captureProjectCatalogTopologyRequest(scope);
    await harness.controller.reconcileProjectCatalog({
      machineId: "local",
      project,
      workspaces: [mainWorkspace],
      topologyRequest: retryRequest,
    });

    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(listSessions).toHaveBeenLastCalledWith(mainWorkspace.path, "local");
    expect(harness.state.sessions).toEqual([parentSession]);
    expect(harness.state.projectSessions).toEqual([parentSession]);
  });

  it("restores eligible rows without publishing or navigating a stale catalog fallback success", async () => {
    const fallbackSessions = deferred<SessionInfo[]>();
    const staleListedSession = session("stale-listed", mainWorkspace.path);
    const retriedSession = session("retried", mainWorkspace.path);
    const listSessions = vi.fn((cwd: string) => (
      cwd === mainWorkspace.path && listSessions.mock.calls.length === 1
        ? fallbackSessions.promise
        : Promise.resolve<SessionInfo[]>([retriedSession])
    ));
    const updateUrl = vi.fn();
    const selectSession = vi.fn(() => {
      updateUrl();
      return Promise.resolve();
    });
    const harness = controllerForCatalog({
      selectedWorkspace: featureWorkspace,
      workspaces: [mainWorkspace, featureWorkspace],
      workspacesByProjectId: { [project.id]: [mainWorkspace, featureWorkspace] },
      sessions: [spawnedSession],
      projectSessions: [parentSession, spawnedSession],
      error: "existing foreground error",
      listSessions,
      updateUrl,
      sessionController: {
        applyRefreshedSessionLists: () => Promise.resolve(),
        clearActiveSession: () => undefined,
        preferredSession: () => staleListedSession,
        selectSession,
      },
    });
    const scope = { machineId: "local", projectId: project.id, projectPath: project.path };
    const olderRequest = harness.controller.captureProjectCatalogTopologyRequest(scope);

    const reconcilingOlderSnapshot = harness.controller.reconcileProjectCatalog({
      machineId: "local",
      project,
      workspaces: [mainWorkspace],
      topologyRequest: olderRequest,
    });
    await vi.waitFor(() => {
      expect(listSessions).toHaveBeenCalledOnce();
    });

    const newerRequest = harness.controller.captureProjectCatalogTopologyRequest(scope);
    await harness.controller.reconcileProjectCatalog({
      machineId: "local",
      project,
      workspaces: [mainWorkspace],
      topologyRequest: newerRequest,
    });

    fallbackSessions.resolve([staleListedSession]);
    await reconcilingOlderSnapshot;

    expect(harness.state.sessions).toEqual([parentSession]);
    expect(harness.state.projectSessions).toEqual([parentSession]);
    expect(harness.state.sessions).not.toContainEqual(staleListedSession);
    expect(harness.state.projectSessions).not.toContainEqual(staleListedSession);
    expect(harness.state.error).toBe("existing foreground error");
    expect(harness.state.isLoadingSessions).toBe(false);
    expect(selectSession).not.toHaveBeenCalled();
    expect(updateUrl).not.toHaveBeenCalled();

    const retryRequest = harness.controller.captureProjectCatalogTopologyRequest(scope);
    await harness.controller.reconcileProjectCatalog({
      machineId: "local",
      project,
      workspaces: [mainWorkspace],
      topologyRequest: retryRequest,
    });

    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(listSessions).toHaveBeenLastCalledWith(mainWorkspace.path, "local");
    expect(harness.state.sessions).toEqual(expect.arrayContaining([parentSession, retriedSession]));
    expect(harness.state.projectSessions).toEqual(expect.arrayContaining([parentSession, retriedSession]));
    expect(selectSession).not.toHaveBeenCalled();
    expect(updateUrl).not.toHaveBeenCalled();
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

describe("WorkspaceController session list provenance", () => {
  it("publishes captured remote selection and receiving provenance", async () => {
    vi.useFakeTimers();
    try {
      const clock = fakeClock(1_000_000);
      const fixture = createSessionListHarness(remoteLabMachine, { now: clock.now });
      const pending = fixture.controller.selectWorkspace(remoteWorkspace);

      expect(fixture.state.sessionListLoad).toMatchObject({
        owner: "selection",
        scope: { machineId: "remote-lab", projectId: "project-1", workspaceId: "workspace-1", workspacePath: "/repo" },
        startedAt: 1_000_000,
        budgetMs: DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
        phase: "waiting",
      });
      expect(fixture.reads).toHaveLength(1);
      expect(fixture.reads[0]?.machineId).toBe("remote-lab");
      expect(fixture.reads[0]?.responseStarted).toEqual(expect.any(Function));

      fixture.reads[0]?.startResponse();
      expect(fixture.state.sessionListLoad?.phase).toBe("receiving");

      fixture.reads[0]?.resolve([remoteSession]);
      await pending;

      expect(fixture.state.sessionListLoad).toBeUndefined();
      expect(fixture.state.sessionListFailure).toBeUndefined();
      expect(fixture.state.sessions).toEqual([remoteSession]);
    } finally {
      vi.useRealTimers();
    }

    const local = createSessionListHarness(undefined);
    const selecting = local.controller.selectWorkspace(remoteWorkspace);
    expect(local.state.sessionListLoad).toBeUndefined();
    expect(local.reads[0]?.responseStarted).toBeUndefined();
    local.reads[0]?.resolve([]);
    await selecting;
    expect(local.state.sessionListLoad).toBeUndefined();
    expect(local.state.sessionListFailure).toBeUndefined();
  });

  it("keeps catalog fallback silent while bounding its remote read", async () => {
    vi.useFakeTimers();
    try {
      await withoutNativeAbortTimeout(async () => {
        const fixture = createSessionListHarness(remoteLabMachine, {
          state: { selectedWorkspace: remoteSiblingWorkspace },
        });
        const pending = fixture.controller.reconcileProjectCatalog({
          machineId: "remote-lab",
          project: remoteProject,
          workspaces: [remoteWorkspace],
        });
        await vi.waitFor(() => {
          expect(fixture.reads).toHaveLength(1);
        });
        expect(fixture.state.selectedWorkspace).toEqual(remoteWorkspace);
        expect(fixture.reads[0]?.cwd).toBe(remoteWorkspace.path);

        await vi.advanceTimersByTimeAsync(REMOTE_BACKGROUND_REQUEST_TIMEOUT_MS);
        await pending;

        expect(isLoadCancellation(fixture.reads[0]?.failure)).toBe(true);
        expect(fixture.state.sessionListLoad).toBeUndefined();
        expect(fixture.state.sessionListFailure).toBeUndefined();
        expect(fixture.state.error).toBe("");
        expect(fixture.state.isLoadingSessions).toBe(false);
        expect(fixture.reportedErrors).toEqual([]);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes timeout and transfer failures without writing state error", async () => {
    vi.useFakeTimers();
    try {
      const clock = fakeClock(1_000_000);

      const timeout = createSessionListHarness(remoteLabMachine, { now: clock.now });
      const timeoutPending = timeout.controller.selectWorkspace(remoteWorkspace);
      clock.advance(2_000);
      timeout.reads[0]?.reject(new HttpRequestError("gateway timeout", 504));
      await timeoutPending;
      expect(timeout.state.sessionListFailure).toMatchObject({
        kind: "timeout",
        elapsedMs: 2_000,
        budgetMs: DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
      });
      expect(timeout.state.sessionListLoad).toBeUndefined();
      expect(timeout.state.error).toBe("");
      expect(timeout.state.isLoadingSessions).toBe(false);

      const transfer = createSessionListHarness(remoteLabMachine, { now: clock.now });
      const transferPending = transfer.controller.selectWorkspace(remoteWorkspace);
      transfer.reads[0]?.startResponse();
      clock.advance(3_000);
      transfer.reads[0]?.reject(new HttpResponseBodyError(200, new Error("body stopped")));
      await transferPending;
      expect(transfer.state.sessionListFailure).toMatchObject({ kind: "transfer", elapsedMs: 3_000 });
      expect(transfer.state.error).toBe("");
      expect(transfer.state.isLoadingSessions).toBe(false);

      const ordinary = createSessionListHarness(remoteLabMachine, { now: clock.now });
      const ordinaryPending = ordinary.controller.selectWorkspace(remoteWorkspace);
      ordinary.reads[0]?.reject(new HttpRequestError("bad gateway", 502));
      await ordinaryPending;
      expect(ordinary.state.sessionListFailure).toBeUndefined();
      expect(ordinary.state.error).toContain("bad gateway");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries only the current list without selecting or detaching a session", async () => {
    const fixture = createSessionListHarness(remoteLabMachine);
    const failing = fixture.controller.selectWorkspace(remoteWorkspace);
    fixture.reads[0]?.reject(new HttpRequestError("gateway timeout", 504));
    await failing;
    expect(fixture.state.sessionListFailure).toMatchObject({ kind: "timeout" });

    fixture.state.selectedSession = { ...remoteSession };
    fixture.state.sessions = [{ ...remoteSession }];
    fixture.recording.reset();
    fixture.listSessions.mockClear();
    fixture.urlChanges.length = 0;

    const retry = fixture.controller.retrySessionList();
    expect(fixture.listSessions).toHaveBeenCalledTimes(1);
    expect(fixture.recording.selectionCalls).toEqual([]);
    expect(fixture.recording.streamCalls).toEqual([]);
    expect(fixture.state.sessionListLoad?.owner).toBe("retry");

    fixture.reads[1]?.resolve([{ ...remoteSession, archived: true }]);
    await retry;

    expect(fixture.state.selectedSession).toEqual(expect.objectContaining({ id: "session-1" }));
    expect(fixture.state.sessionListFailure).toBeUndefined();
    expect(fixture.state.sessionListLoad).toBeUndefined();
    expect(fixture.urlChanges).toHaveLength(0);
    expect(fixture.recording.selectionCalls).toEqual([]);
    expect(fixture.recording.streamCalls).toEqual([]);
    expect(fixture.recording.applyCalls).toEqual([
      { cwd: remoteWorkspace.path, machineId: "remote-lab", preserveSelection: true },
    ]);
  });

  it("a superseded load cannot advance or clear a newer load in the same scope", async () => {
    const fixture = createSessionListHarness(remoteLabMachine, { state: { selectedWorkspace: remoteWorkspace } });
    const original = fixture.controller.selectWorkspace(remoteWorkspace);
    const retry = fixture.controller.retrySessionList();
    expect(fixture.reads).toHaveLength(2);

    fixture.reads[0]?.startResponse();
    expect(fixture.state.sessionListLoad).toMatchObject({ owner: "retry", phase: "waiting" });

    fixture.reads[0]?.reject(new HttpRequestError("old", 504));
    await original;
    expect(fixture.state.sessionListLoad?.owner).toBe("retry");
    expect(fixture.state.sessionListFailure).toBeUndefined();

    const switching = fixture.controller.selectWorkspace(remoteSiblingWorkspace);
    fixture.reads[1]?.reject(new HttpRequestError("late", 504));
    fixture.reads[2]?.resolve([]);
    await Promise.allSettled([original, retry, switching]);

    expect(fixture.state.sessionListFailure).toBeUndefined();
    expect(fixture.state.error).toBe("");
  });

  it("foreground mutation refresh survives later background invalidations in the queue", async () => {
    vi.useFakeTimers();
    try {
      await withoutNativeAbortTimeout(async () => {
        const fixture = createSessionListHarness(remoteLabMachine, { state: { selectedWorkspace: remoteWorkspace } });
        void fixture.controller.refreshSessionLists([remoteWorkspace.path], "remote-lab", "background");
        await vi.advanceTimersByTimeAsync(SESSION_LIST_REFRESH_DELAY_MS);
        expect(fixture.reads).toHaveLength(1);

        const foreground = fixture.controller.refreshSessionLists([remoteWorkspace.path], "remote-lab", "foreground");
        await vi.advanceTimersByTimeAsync(REMOTE_BACKGROUND_REQUEST_TIMEOUT_MS);

        expect(fixture.reads).toHaveLength(1);
        expect(isLoadCancellation(fixture.reads[0]?.failure)).toBe(true);

        await vi.advanceTimersByTimeAsync(SESSION_LIST_REFRESH_DELAY_MS);
        expect(fixture.reads).toHaveLength(2);
        const foregroundRead = fixture.reads[1];
        expect(foregroundRead?.signal?.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(REMOTE_BACKGROUND_REQUEST_TIMEOUT_MS);
        const foregroundReadWasFullBudget = foregroundRead?.signal?.aborted === false;
        expect(foregroundReadWasFullBudget).toBe(true);

        foregroundRead?.resolve([remoteSession]);
        await foreground;

        expect(observedReadIntents(fixture.reads)).toEqual([
          { cwd: remoteWorkspace.path, intent: "background" },
          { cwd: remoteWorkspace.path, intent: "foreground" },
        ]);
        expect(fixture.recording.applyCalls).toEqual([
          { cwd: remoteWorkspace.path, machineId: "remote-lab", preserveSelection: undefined },
        ]);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves per cwd intent and deferred dirty work behind selection", async () => {
    vi.useFakeTimers();
    try {
      await withoutNativeAbortTimeout(async () => {
        const fixture = createSessionListHarness(remoteLabMachine);
        const selecting = fixture.controller.selectWorkspace(remoteWorkspace);
        const foreground = fixture.controller.refreshSessionLists([remoteWorkspace.path], "remote-lab", "foreground");
        void fixture.controller.refreshSessionLists([remoteSiblingWorkspace.path], "remote-lab", "background");

        await vi.advanceTimersByTimeAsync(SESSION_LIST_REFRESH_DELAY_MS);
        expect(fixture.reads).toHaveLength(1);

        fixture.reads[0]?.resolve([]);
        await selecting;
        // Drop the selection read and its cross-workspace catalog reads so the
        // remaining observations are exactly the deferred invalidation pass.
        fixture.reads.length = 0;

        await vi.advanceTimersByTimeAsync(SESSION_LIST_REFRESH_DELAY_MS);
        expect(fixture.reads.map((read) => read.cwd)).toEqual([remoteWorkspace.path, remoteSiblingWorkspace.path]);

        await vi.advanceTimersByTimeAsync(REMOTE_BACKGROUND_REQUEST_TIMEOUT_MS);
        expect(isLoadCancellation(fixture.reads[1]?.failure)).toBe(true);
        expect(fixture.reads[0]?.signal?.aborted).toBe(false);

        fixture.reads[0]?.resolve([remoteSession]);
        await foreground;

        expect(observedReadIntents(fixture.reads)).toEqual([
          { cwd: remoteWorkspace.path, intent: "foreground" },
          { cwd: remoteSiblingWorkspace.path, intent: "background" },
        ]);
        expect(fixture.recording.applyCalls).toEqual([
          { cwd: remoteWorkspace.path, machineId: "remote-lab", preserveSelection: undefined },
        ]);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps cancelled discovery hydration eligible for a later snapshot", async () => {
    const fixture = createSessionListHarness(remoteLabMachine, {
      state: {
        selectedWorkspace: remoteWorkspace,
        workspaces: [remoteWorkspace],
        workspacesByProjectId: { [remoteProject.id]: [remoteWorkspace] },
      },
    });
    const snapshot = {
      machineId: "remote-lab",
      project: remoteProject,
      workspaces: [remoteWorkspace, remoteSiblingWorkspace],
    };

    const reconciling = fixture.controller.reconcileProjectCatalog(snapshot);
    await vi.waitFor(() => {
      expect(fixture.reads).toHaveLength(1);
    });
    expect(fixture.reads[0]?.cwd).toBe(remoteSiblingWorkspace.path);

    fixture.reads[0]?.reject(new LoadCancelledError("hydration cancelled"));
    await reconciling;

    expect(fixture.state.projectSessions).toEqual([]);
    expect(fixture.reportedErrors).toEqual([]);

    const later = fixture.controller.reconcileProjectCatalog(snapshot);
    await vi.waitFor(() => {
      expect(fixture.reads).toHaveLength(2);
    });
    fixture.reads[1]?.resolve([session("discovered", remoteSiblingWorkspace.path)]);
    await later;

    expect(fixture.state.projectSessions.map((candidate) => candidate.id)).toContain("discovered");
  });
});

describe("WorkspaceController session list operation ownership", () => {
  // A superseded selection still rejects, but the retry that replaced it owns
  // every record: the old read must not fall through to the generic banner.
  it("keeps a superseded selection's failure out of the generic error channel", async () => {
    const fixture = createSessionListHarness(remoteLabMachine);
    const superseded = fixture.controller.selectWorkspace(remoteWorkspace);
    expect(fixture.state.sessionListLoad).toMatchObject({ owner: "selection" });
    expect(fixture.state.isLoadingSessions).toBe(true);

    const retry = fixture.controller.retrySessionList();
    expect(fixture.reads).toHaveLength(2);
    expect(fixture.state.sessionListLoad).toMatchObject({ owner: "retry" });

    fixture.reads[0]?.reject(new HttpRequestError("old selection timeout", 504));
    await superseded;

    expect(fixture.state.error).toBe("");
    expect(fixture.state.sessionListFailure).toBeUndefined();
    expect(fixture.state.sessionListLoad).toMatchObject({ owner: "retry" });
    expect(fixture.state.isLoadingSessions).toBe(true);

    fixture.reads[1]?.resolve([remoteSession]);
    await retry;

    expect(fixture.state.error).toBe("");
    expect(fixture.state.sessionListFailure).toBeUndefined();
    expect(fixture.state.sessionListLoad).toBeUndefined();
    expect(fixture.state.isLoadingSessions).toBe(false);
    expect(fixture.recording.applyCalls).toEqual([
      { cwd: remoteWorkspace.path, machineId: "remote-lab", preserveSelection: true },
    ]);
  });

  // A retry is a foreground read like any other: a non-typed rejection is an
  // ordinary error, not a silently swallowed one.
  it("publishes an ordinary retry failure through the generic error channel", async () => {
    const fixture = createSessionListHarness(remoteLabMachine);
    const failing = fixture.controller.selectWorkspace(remoteWorkspace);
    fixture.reads[0]?.reject(new HttpRequestError("gateway timeout", 504));
    await failing;
    expect(fixture.state.sessionListFailure).toMatchObject({ kind: "timeout" });

    const retry = fixture.controller.retrySessionList();
    fixture.reads[1]?.reject(new HttpRequestError("bad gateway", 502));
    await retry;

    expect(fixture.state.error).toContain("bad gateway");
    expect(fixture.state.sessionListFailure).toBeUndefined();
    expect(fixture.state.sessionListLoad).toBeUndefined();
    expect(fixture.state.isLoadingSessions).toBe(false);
  });

  it("publishes an untyped retry failure and keeps a cancelled retry silent", async () => {
    const fixture = createSessionListHarness(remoteLabMachine);
    const failing = fixture.controller.selectWorkspace(remoteWorkspace);
    fixture.reads[0]?.reject(new HttpRequestError("gateway timeout", 504));
    await failing;

    const retry = fixture.controller.retrySessionList();
    fixture.reads[1]?.reject(new Error("network down"));
    await retry;

    expect(fixture.state.error).toContain("network down");
    expect(fixture.state.sessionListFailure).toBeUndefined();
    expect(fixture.state.isLoadingSessions).toBe(false);

    const silent = createSessionListHarness(remoteLabMachine);
    const failed = silent.controller.selectWorkspace(remoteWorkspace);
    silent.reads[0]?.reject(new HttpRequestError("gateway timeout", 504));
    await failed;
    const previousFailure = silent.state.sessionListFailure;
    expect(previousFailure).toMatchObject({ kind: "timeout" });

    const cancelled = silent.controller.retrySessionList();
    silent.reads[1]?.reject(new LoadCancelledError("retry cancelled"));
    await cancelled;

    expect(silent.state.error).toBe("");
    expect(silent.state.sessionListFailure).toEqual(previousFailure);
    expect(silent.state.sessionListLoad).toBeUndefined();
  });

  // A dirty cwd that leaves the catalog while the selection stays can never be
  // read, so the pass must drop it, settle its caller, and stop rescheduling.
  it("drops dirty cwds that leave the catalog and stops scheduling", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createSessionListHarness(remoteLabMachine, { state: { selectedWorkspace: remoteWorkspace } });
      let settled = false;
      const dropped = fixture.controller
        .refreshSessionLists([remoteSiblingWorkspace.path], "remote-lab", "foreground")
        .then(() => { settled = true; });

      await fixture.controller.reconcileProjectCatalog({
        machineId: "remote-lab",
        project: remoteProject,
        workspaces: [remoteWorkspace],
      });
      expect(fixture.state.workspaces.map((candidate) => candidate.path)).toEqual([remoteWorkspace.path]);

      await vi.advanceTimersByTimeAsync(SESSION_LIST_REFRESH_DELAY_MS);

      expect(settled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(fixture.reads).toHaveLength(0);
      await dropped;
    } finally {
      vi.useRealTimers();
    }
  });

  // Reselecting the same workspace is a new selection generation: a retry
  // admitted for the previous generation must not answer for the new one.
  it("does not share a retry operation across a same-workspace reselection", async () => {
    const fixture = createSessionListHarness(remoteLabMachine, {
      state: {
        workspaces: [remoteWorkspace],
        workspacesByProjectId: { [remoteProject.id]: [remoteWorkspace] },
      },
    });
    const selection = fixture.controller.selectWorkspace(remoteWorkspace);
    fixture.reads[0]?.reject(new HttpRequestError("gateway timeout", 504));
    await selection;
    expect(fixture.state.sessionListFailure).toMatchObject({ kind: "timeout" });

    const retryA = fixture.controller.retrySessionList();
    expect(fixture.reads).toHaveLength(2);

    const reselection = fixture.controller.selectWorkspace(remoteWorkspace);
    expect(fixture.reads).toHaveLength(3);
    expect(fixture.reads[1]?.signal?.aborted).toBe(true);

    const retryB = fixture.controller.retrySessionList();
    let retryBSettled = false;
    void retryB.then(() => { retryBSettled = true; });
    await Promise.resolve();
    await Promise.resolve();

    expect(fixture.reads).toHaveLength(4);
    expect(fixture.state.sessionListLoad).toMatchObject({ owner: "retry" });
    expect(retryBSettled).toBe(false);

    // The superseded retry's continuation must not clear the newer record.
    await retryA;
    expect(fixture.state.sessionListLoad).toMatchObject({ owner: "retry" });
    void fixture.controller.retrySessionList();
    expect(fixture.reads).toHaveLength(4);

    fixture.reads[3]?.resolve([{ ...remoteSession, archived: true }]);
    await retryB;
    expect(retryBSettled).toBe(true);

    fixture.reads[2]?.resolve([]);
    await reselection;
    await Promise.allSettled([selection, retryA]);

    expect(fixture.state.error).toBe("");
    expect(fixture.state.sessionListFailure).toBeUndefined();
    expect(fixture.state.sessionListLoad).toBeUndefined();
  });
});

type WorkspaceApi = NonNullable<WorkspaceControllerDependencies["api"]>;
type ListSessions = WorkspaceApi["sessions"];
type ListWorkspaces = WorkspaceApi["workspaces"];

interface CatalogHarnessInput extends Partial<AppState> {
  listSessions?: ListSessions;
  listWorkspaces?: ListWorkspaces;
  onBackgroundError?: WorkspaceControllerDependencies["onBackgroundError"];
  sessionController?: Pick<SessionController, "clearActiveSession" | "preferredSession" | "selectSession" | "applyRefreshedSessionLists">;
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
  selectedWorkspace?: Workspace;
  workspaces: Workspace[];
  sessions?: SessionInfo[];
  projectSessions: SessionInfo[];
  error?: string;
  listSessions?: ListSessions;
  onBackgroundError?: WorkspaceControllerDependencies["onBackgroundError"];
}) {
  const state: AppState = {
    ...initialAppState(),
    projects: [project],
    selectedProject: project,
    selectedWorkspace: input.selectedWorkspace ?? mainWorkspace,
    workspaces: input.workspaces,
    workspacesByProjectId: { [project.id]: input.workspaces },
    sessions: input.sessions ?? [parentSession],
    projectSessions: input.projectSessions,
    ...(input.error === undefined ? {} : { error: input.error }),
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
      ...(input.onBackgroundError === undefined ? {} : { onBackgroundError: input.onBackgroundError }),
    },
  );
  return { controller, sessionController, state };
}

function sessionControllerStub(): Pick<SessionController, "clearActiveSession" | "preferredSession" | "selectSession" | "applyRefreshedSessionLists"> {
  return {
    applyRefreshedSessionLists: () => Promise.resolve(),
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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

/** Matches the controller's short window that merges a burst of invalidations. */
const SESSION_LIST_REFRESH_DELAY_MS = 50;

const remoteProject: Project = { id: "project-1", name: "repo", path: "/repo", createdAt: "now" };
const remoteWorkspace: Workspace = workspace(remoteProject, "workspace-1", "/repo");
const remoteSiblingWorkspace: Workspace = workspace(remoteProject, "workspace-2", "/repo-two");
const remoteLabMachine: Machine = { id: "remote-lab", name: "Remote Lab", kind: "remote", createdAt: "now", updatedAt: "now" };
const remoteSession = session("session-1", remoteWorkspace.path);

interface RecordedSessionListRead {
  readonly cwd: string;
  readonly machineId: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly promise: Promise<SessionInfo[]>;
  readonly responseStarted: ((response: Response) => void) | undefined;
  readonly failure: unknown;
  resolve(rows: SessionInfo[]): void;
  reject(reason: unknown): void;
  startResponse(): void;
}

interface RecordedApplyCall {
  cwd: string;
  machineId: string;
  preserveSelection: boolean | undefined;
}

function createSessionListHarness(
  machine: Machine | undefined,
  input: { state?: Partial<AppState>; now?: () => number } = {},
) {
  const state: AppState = {
    ...initialAppState(),
    ...(machine === undefined ? {} : { machines: [machine], selectedMachine: machine }),
    projects: [remoteProject],
    selectedProject: remoteProject,
    workspaces: [remoteWorkspace, remoteSiblingWorkspace],
    workspacesByProjectId: { [remoteProject.id]: [remoteWorkspace, remoteSiblingWorkspace] },
    ...input.state,
  };
  const reads: RecordedSessionListRead[] = [];
  const urlChanges: unknown[] = [];
  const reportedErrors: { operation: string; error: unknown }[] = [];
  const selectionCalls: string[] = [];
  const streamCalls: string[] = [];
  const applyCalls: RecordedApplyCall[] = [];
  const listSessions = vi.fn((cwd: string, machineId?: string, signal?: AbortSignal, responseStarted?: (response: Response) => void) => {
    const read = recordSessionListRead(cwd, machineId, signal, responseStarted);
    reads.push(read);
    return read.promise;
  });
  const workspaceController = new WorkspaceController(
    () => state,
    (patch) => { Object.assign(state, patch); },
    () => { urlChanges.push(undefined); },
    {
      applyRefreshedSessionLists: (lists, machineId, options) => {
        for (const list of lists) applyCalls.push({ cwd: list.cwd, machineId, preserveSelection: options?.preserveSelection });
        return Promise.resolve();
      },
      clearActiveSession: () => { streamCalls.push("clear"); },
      preferredSession: () => undefined,
      selectSession: (selected) => {
        selectionCalls.push(selected.id);
        streamCalls.push(`join:${selected.id}`);
        return Promise.resolve();
      },
    },
    new InMemoryWorkspaceSelectionMemory(),
    {
      api: {
        workspaces: () => Promise.resolve([remoteWorkspace, remoteSiblingWorkspace]),
        sessions: listSessions,
      },
      ...(input.now === undefined ? {} : { now: input.now }),
      onBackgroundError: (operation, error) => { reportedErrors.push({ operation, error }); },
    },
  );
  return {
    controller: workspaceController,
    state,
    reads,
    listSessions,
    urlChanges,
    reportedErrors,
    recording: {
      selectionCalls,
      streamCalls,
      applyCalls,
      reset: () => {
        selectionCalls.length = 0;
        streamCalls.length = 0;
        applyCalls.length = 0;
      },
    },
  };
}

function recordSessionListRead(
  cwd: string,
  machineId: string | undefined,
  signal: AbortSignal | undefined,
  responseStarted: ((response: Response) => void) | undefined,
): RecordedSessionListRead {
  let resolveRead!: (rows: SessionInfo[]) => void;
  let rejectRead!: (reason: unknown) => void;
  let failure: unknown;
  const promise = new Promise<SessionInfo[]>((resolve, reject) => {
    resolveRead = resolve;
    rejectRead = reject;
  });
  const fail = (reason: unknown): void => {
    if (failure === undefined) failure = reason;
    rejectRead(reason);
  };
  signal?.addEventListener("abort", () => { fail(signal.reason); }, { once: true });
  return {
    cwd,
    machineId,
    signal,
    promise,
    responseStarted,
    get failure() { return failure; },
    resolve: (rows) => { resolveRead(rows); },
    reject: fail,
    startResponse: () => { responseStarted?.(new Response(null, { status: 200 })); },
  };
}

function fakeClock(start: number) {
  let current = start;
  return {
    now: () => current,
    advance: (milliseconds: number) => { current += milliseconds; },
  };
}

/**
 * Intent is only observable through the budget it selects: a background read
 * bows out with the 20 s window and a foreground read keeps the machine budget.
 */
function observedReadIntents(reads: readonly RecordedSessionListRead[]): { cwd: string; intent: "background" | "foreground" }[] {
  return reads.map((read) => ({
    cwd: read.cwd,
    intent: isLoadCancellation(read.failure) ? "background" : "foreground",
  }));
}

/** The bounded background helper translates its native deadline into a marker abort. */
async function withoutNativeAbortTimeout(run: () => Promise<void>): Promise<void> {
  const native = AbortSignal.timeout.bind(AbortSignal);
  Object.defineProperty(AbortSignal, "timeout", { configurable: true, writable: true, value: undefined });
  try {
    await run();
  } finally {
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, writable: true, value: native });
  }
}
