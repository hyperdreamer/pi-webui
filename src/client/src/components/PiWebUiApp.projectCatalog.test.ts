import { LitElement } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectWorkspaceTopologySnapshot } from "../controllers/projectActivityOwnershipCoordinator";
import { WorkspaceController } from "../controllers/workspaceController";
import { initialAppState, type AppState } from "../appState";
import { sessionsApi, type Project, type SessionInfo, type Workspace } from "../api";
import { sessionActivityIndicators } from "../sessionActivity";
import { PiWebUiApp } from "./PiWebUiApp";

const project: Project = {
  id: "project-a",
  name: "Project A",
  path: "/work/project-a",
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
const parentSession: SessionInfo = {
  id: "parent",
  path: "/sessions/parent.jsonl",
  cwd: mainWorkspace.path,
  created: "2026-07-30T00:00:00.000Z",
  modified: "2026-07-30T00:00:00.000Z",
  messageCount: 1,
  firstMessage: "Parent session",
};
const spawnedSession: SessionInfo = {
  id: "spawned",
  path: "/sessions/spawned.jsonl",
  cwd: featureWorkspace.path,
  created: "2026-07-30T00:00:00.000Z",
  modified: "2026-07-30T00:00:00.000Z",
  messageCount: 1,
  firstMessage: "Spawned session",
  parentSessionPath: parentSession.path,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebUiApp project catalog wiring", () => {
  it("defers selected-project catalog observation until foreground workspace loading completes and disposes on disconnect", () => {
    const timers = fakeTimers();
    const app = createApp({ catalogTimers: timers });
    const catalog = projectCatalogController(app);
    const updatePolling = vi.spyOn(catalog, "updatePolling");
    const dispose = vi.spyOn(catalog, "dispose");
    setAppState(app, {
      ...initialAppState(),
      selectedProject: project,
      workspaces: [mainWorkspace],
      isLoadingWorkspaces: true,
    });

    invokeConnected(app);
    updatePolling.mockClear();

    expect(timers.pendingCallbacks()).toHaveLength(0);

    applyAppState(app, { isLoadingWorkspaces: false });

    expect(updatePolling).toHaveBeenCalledOnce();
    expect(updatePolling).toHaveBeenCalledWith(true);
    expect(timers.pendingCallbacks()).toHaveLength(1);

    invokeDisconnected(app);
    expect(dispose).toHaveBeenCalledOnce();
    expect(timers.pendingCallbacks()).toHaveLength(0);
  });

  it("does not start catalog polling for a detached app", () => {
    const app = createApp();
    const catalog = projectCatalogController(app);
    const updatePolling = vi.spyOn(catalog, "updatePolling").mockImplementation(() => undefined);
    if (!Reflect.set(app, "syncWindowTitle", () => undefined)) throw new Error("Could not stub window title synchronization");

    applyAppState(app, {
      ...initialAppState(),
      selectedProject: project,
      workspaces: [mainWorkspace],
      isLoadingWorkspaces: false,
    });

    expect(updatePolling).toHaveBeenCalledWith(false);
  });

  it("requests immediate catalog reconciliation when the selected realtime socket opens", () => {
    const app = createApp();
    const catalog = projectCatalogController(app);
    const refresh = vi.spyOn(catalog, "refresh").mockResolvedValue(undefined);

    invokeRealtimeConnected(app);

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("requests immediate catalog reconciliation after browser resume", async () => {
    const app = createApp();
    const catalog = projectCatalogController(app);
    const refresh = vi.spyOn(catalog, "refresh").mockResolvedValue(undefined);
    const unreadRenegotiation = deferred<undefined>();
    stubBrowserResumeRecovery(app);
    if (!Reflect.set(app, "renegotiateUnreadMachines", () => unreadRenegotiation.promise)) {
      throw new Error("Could not defer unread renegotiation");
    }

    const resuming = invokeBrowserResumeRefresh(app);

    expect(refresh).toHaveBeenCalledOnce();

    unreadRenegotiation.resolve(undefined);
    await resuming;
  });

  it("reconciles an activity-discovered worktree through the selected project catalog seam", async () => {
    const app = createApp();
    const activeSession = {
      sessionId: spawnedSession.id,
      phase: "active" as const,
      label: "prompt accepted",
      at: "now",
    };
    setAppState(app, {
      ...initialAppState(),
      projects: [project],
      selectedProject: project,
      selectedWorkspace: mainWorkspace,
      workspaces: [mainWorkspace],
      workspacesByProjectId: { [project.id]: [mainWorkspace] },
      projectSessions: [parentSession],
      sessionActivities: { [spawnedSession.id]: activeSession },
    });
    const listSessions = vi.spyOn(sessionsApi, "sessions").mockResolvedValue([spawnedSession]);
    bindSessionsApiAtWorkspaceControllerSeam(app);

    await activityTopologyCallback(app)({
      machineId: "local",
      projectId: project.id,
      projectPath: project.path,
      workspaces: [mainWorkspace, featureWorkspace],
    });

    const state = appState(app);
    expect(state.workspaces).toContainEqual(featureWorkspace);
    expect(state.projectSessions).toContainEqual(spawnedSession);
    expect(listSessions).toHaveBeenCalledWith(featureWorkspace.path, "local");
    expect(state.selectedProject).toEqual(project);
    expect(state.selectedWorkspace).toEqual(mainWorkspace);
    expect(sessionActivityIndicators(spawnedSession, state.projectSessions, {
      statuses: state.sessionStatuses,
      activities: state.sessionActivities,
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "session", label: "This session is working" }),
    ]));
  });
});

interface ProjectCatalogLifecycleController {
  updatePolling(observed?: boolean): void;
  refresh(): Promise<void>;
  dispose(): void;
}

interface RealtimeConnector {
  connect(onEvent: (event: unknown) => void, onOpen?: () => void, machineId?: string): void;
}

interface SelectedSessionRefresher {
  refreshSelectedSession(): Promise<void>;
}

type ApplyAppState = (this: PiWebUiApp, patch: Partial<AppState>) => void;
type LifecycleHook = (this: PiWebUiApp) => void;
type ConnectRealtime = (this: PiWebUiApp) => void;
type RefreshAfterBrowserResume = (this: PiWebUiApp) => Promise<void>;
type ActivityTopologyCallback = (snapshot: ProjectWorkspaceTopologySnapshot) => unknown;

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

interface CreateAppOptions {
  catalogTimers?: FakeTimers;
}

interface FakeTimers {
  setTimeout(callback: () => void): number;
  clearTimeout(id: number): void;
  pendingCallbacks(): readonly (() => void)[];
}

function fakeTimers(): FakeTimers {
  const callbacks = new Map<number, () => void>();
  let nextId = 1;
  return {
    setTimeout(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      callbacks.delete(id);
    },
    pendingCallbacks: () => [...callbacks.values()],
  };
}

function createApp({ catalogTimers }: CreateAppOptions = {}): PiWebUiApp {
  const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  vi.stubGlobal("window", {
    location: { search: "" },
    localStorage: storage,
    sessionStorage: storage,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout: catalogTimers === undefined ? () => 1 : (callback: () => void) => catalogTimers.setTimeout(callback),
    clearTimeout: catalogTimers === undefined ? () => undefined : (id: number) => { catalogTimers.clearTimeout(id); },
  });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  return new PiWebUiApp();
}

function bindSessionsApiAtWorkspaceControllerSeam(app: PiWebUiApp): void {
  const controller = workspaceController(app);
  const api: unknown = Reflect.get(controller, "api");
  if (!isWorkspaceControllerApi(api)) throw new Error("PiWebUiApp workspace controller API is unavailable");
  // The aggregate API copies endpoint functions at module initialization; bind the
  // controller's existing API seam to the directly stubbed sessions endpoint.
  if (!Reflect.set(controller, "api", { ...api, sessions: sessionsApi.sessions })) {
    throw new Error("Could not bind the sessions API at the workspace controller seam");
  }
}

function workspaceController(app: PiWebUiApp): WorkspaceController {
  const value: unknown = Reflect.get(app, "workspaces");
  if (!(value instanceof WorkspaceController)) throw new Error("PiWebUiApp workspace controller is unavailable");
  return value;
}

function projectCatalogController(app: PiWebUiApp): ProjectCatalogLifecycleController {
  const value: unknown = Reflect.get(app, "projectCatalog");
  if (!isProjectCatalogLifecycleController(value)) throw new Error("PiWebUiApp project catalog controller is unavailable");
  return value;
}

function activityTopologyCallback(app: PiWebUiApp): ActivityTopologyCallback {
  const coordinator: unknown = Reflect.get(app, "projectActivityOwnership");
  if (typeof coordinator !== "object" || coordinator === null) throw new Error("PiWebUiApp project activity ownership coordinator is unavailable");
  const callback: unknown = Reflect.get(coordinator, "onProjectTopology");
  if (!isActivityTopologyCallback(callback)) throw new Error("PiWebUiApp project activity topology callback is unavailable");
  return callback;
}

function applyAppState(app: PiWebUiApp, patch: Partial<AppState>): void {
  const method: unknown = Reflect.get(app, "setState");
  if (!isApplyAppState(method)) throw new Error("PiWebUiApp.setState is not callable");
  method.call(app, patch);
}

function setAppState(app: PiWebUiApp, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebUiApp state");
}

function appState(app: PiWebUiApp): AppState {
  const value: unknown = Reflect.get(app, "state");
  if (!isAppState(value)) throw new Error("PiWebUiApp state is unavailable");
  return value;
}

function invokeConnected(app: PiWebUiApp): void {
  stubConnectedSideEffects(app);
  vi.spyOn(LitElement.prototype, "connectedCallback").mockImplementation(() => undefined);
  setConnectionState(app, true);
  const method: unknown = Reflect.get(app, "connectedCallback");
  if (!isLifecycleHook(method)) throw new Error("PiWebUiApp.connectedCallback is not callable");
  method.call(app);
}

function invokeDisconnected(app: PiWebUiApp): void {
  vi.spyOn(LitElement.prototype, "disconnectedCallback").mockImplementation(() => undefined);
  setConnectionState(app, false);
  const method: unknown = Reflect.get(app, "disconnectedCallback");
  if (!isLifecycleHook(method)) throw new Error("PiWebUiApp.disconnectedCallback is not callable");
  method.call(app);
}

function invokeRealtimeConnected(app: PiWebUiApp): void {
  const realtime = realtimeConnector(app);
  vi.spyOn(realtime, "connect").mockImplementation((_onEvent, onOpen) => { onOpen?.(); });
  const method: unknown = Reflect.get(app, "connectRealtime");
  if (!isConnectRealtime(method)) throw new Error("PiWebUiApp.connectRealtime is not callable");
  method.call(app);
}

function stubBrowserResumeRecovery(app: PiWebUiApp): void {
  if (!Reflect.set(app, "renegotiateUnreadMachines", () => Promise.resolve())) throw new Error("Could not stub unread renegotiation");
  if (!Reflect.set(app, "refreshMachineActivities", () => Promise.resolve())) throw new Error("Could not stub machine activity refresh");
  if (!Reflect.set(app, "refreshWorkspaceDeletionRuns", () => Promise.resolve())) throw new Error("Could not stub workspace deletion refresh");
  vi.spyOn(selectedSessionRefresher(app), "refreshSelectedSession").mockResolvedValue(undefined);
}

function invokeBrowserResumeRefresh(app: PiWebUiApp): Promise<void> {
  const method: unknown = Reflect.get(app, "refreshAfterBrowserResume");
  if (!isRefreshAfterBrowserResume(method)) throw new Error("PiWebUiApp.refreshAfterBrowserResume is not callable");
  return method.call(app);
}

function stubConnectedSideEffects(app: PiWebUiApp): void {
  const asyncNoop = () => Promise.resolve();
  if (!Reflect.set(app, "applyPreferredTheme", () => undefined)) throw new Error("Could not stub theme application");
  if (!Reflect.set(app, "connectRealtime", () => undefined)) throw new Error("Could not stub realtime connection");
  if (!Reflect.set(app, "renegotiateUnreadMachines", asyncNoop)) throw new Error("Could not stub unread renegotiation");
  if (!Reflect.set(app, "refreshWorkspaceActivity", asyncNoop)) throw new Error("Could not stub workspace activity refresh");
  if (!Reflect.set(app, "loadClientConfig", asyncNoop)) throw new Error("Could not stub client config loading");
  if (!Reflect.set(app, "ensureGatewayPluginsLoaded", asyncNoop)) throw new Error("Could not stub gateway plugin loading");
  if (!Reflect.set(app, "loadProjectsAndRestoreRoute", asyncNoop)) throw new Error("Could not stub initial route loading");
  if (!Reflect.set(app, "syncWindowTitle", () => undefined)) throw new Error("Could not stub window title synchronization");
}

function realtimeConnector(app: PiWebUiApp): RealtimeConnector {
  const value: unknown = Reflect.get(app, "realtime");
  if (!isRealtimeConnector(value)) throw new Error("PiWebUiApp realtime socket is unavailable");
  return value;
}

function selectedSessionRefresher(app: PiWebUiApp): SelectedSessionRefresher {
  const value: unknown = Reflect.get(app, "sessions");
  if (!isSelectedSessionRefresher(value)) throw new Error("PiWebUiApp session controller is unavailable");
  return value;
}

function setConnectionState(app: PiWebUiApp, connected: boolean): void {
  Object.defineProperty(app, "isConnected", { configurable: true, value: connected });
}

interface WorkspaceControllerApi {
  sessions: unknown;
  workspaces: unknown;
}

function isAppState(value: unknown): value is AppState {
  return typeof value === "object" && value !== null
    && Array.isArray(Reflect.get(value, "workspaces"))
    && Array.isArray(Reflect.get(value, "projectSessions"))
    && typeof Reflect.get(value, "sessionStatuses") === "object"
    && typeof Reflect.get(value, "sessionActivities") === "object";
}

function isWorkspaceControllerApi(value: unknown): value is WorkspaceControllerApi {
  return typeof value === "object" && value !== null
    && typeof Reflect.get(value, "sessions") === "function"
    && typeof Reflect.get(value, "workspaces") === "function";
}

function isProjectCatalogLifecycleController(value: unknown): value is ProjectCatalogLifecycleController {
  return typeof value === "object" && value !== null
    && typeof Reflect.get(value, "updatePolling") === "function"
    && typeof Reflect.get(value, "refresh") === "function"
    && typeof Reflect.get(value, "dispose") === "function";
}

function isActivityTopologyCallback(value: unknown): value is ActivityTopologyCallback {
  return typeof value === "function";
}

function isApplyAppState(value: unknown): value is ApplyAppState {
  return typeof value === "function";
}

function isLifecycleHook(value: unknown): value is LifecycleHook {
  return typeof value === "function";
}

function isConnectRealtime(value: unknown): value is ConnectRealtime {
  return typeof value === "function";
}

function isRefreshAfterBrowserResume(value: unknown): value is RefreshAfterBrowserResume {
  return typeof value === "function";
}

function isRealtimeConnector(value: unknown): value is RealtimeConnector {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "connect") === "function";
}

function isSelectedSessionRefresher(value: unknown): value is SelectedSessionRefresher {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "refreshSelectedSession") === "function";
}
