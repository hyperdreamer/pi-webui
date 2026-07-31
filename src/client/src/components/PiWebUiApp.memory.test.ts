import { html } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { machineScopedPluginId } from "../../../shared/machinePluginIds";
import type { Project, Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import type { ActivityRailDisplayItem } from "../plugins/activityRail";
import { PluginRegistry } from "../plugins/registry";
import type { ActivityRailContext, PiWebUiPluginRegistration, QualifiedContributionId } from "../plugins/types";
import { PiWebUiApp } from "./PiWebUiApp";

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
const memoryActivityId: QualifiedContributionId = "workspace-memory:workspace.memory";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebUiApp Memory activity-Rail lifecycle wiring", () => {
  it("restarts Memory polling when the selected workspace path changes and the local activity is enabled", () => {
    const app = createApp();
    registerMemoryActivityRail(app);
    const previous: AppState = {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: workspace,
    };
    const next: AppState = {
      ...previous,
      selectedWorkspace: { ...workspace, path: "/work/project-a-renamed" },
    };
    setAppState(app, next);
    const updatePolling = vi.spyOn(memoryController(app), "updatePolling").mockImplementation(() => undefined);

    handleWorkspaceChange(app, previous, next);

    expect(updatePolling).toHaveBeenCalledWith(true);
  });

  it("starts selected-workspace Memory polling for a visible local activity, exposes its internal retry callback, and disposes it on disconnect", () => {
    const app = createApp();
    registerMemoryActivityRail(app);
    const next: AppState = {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: workspace,
      workspaceTool: "core:workspace.terminal",
    };
    setAppState(app, next);
    setRouteRestoreInProgress(app);
    stubWorkspaceChangeSideEffects(app);
    const memory = memoryController(app);
    const updatePolling = vi.spyOn(memory, "updatePolling").mockImplementation(() => undefined);
    const refresh = vi.spyOn(memory, "refresh").mockResolvedValue(undefined);
    const dispose = vi.spyOn(memory, "dispose").mockImplementation(() => undefined);

    handleWorkspaceChange(app, initialAppState(), next);

    expect(activityRailItems(app).map((item) => item.id)).toContain(memoryActivityId);
    expect(updatePolling).toHaveBeenCalledWith(true);
    const context = createActivityRailContext(app, memoryActivityId);
    const onRefreshMemory: unknown = Reflect.get(context, "onRefreshMemory");
    if (!isVoidCallback(onRefreshMemory)) throw new Error("PiWebUiApp did not expose an internal memory refresh callback");
    onRefreshMemory();
    expect(refresh).toHaveBeenCalledOnce();

    invokeDisconnected(app);

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("uses safe visibility without evaluating the Memory badge during polling", () => {
    const app = createApp();
    const visible = vi.fn(visibleMemoryActivity);
    const badge = vi.fn(() => 2);
    registerMemoryActivityRail(app, false, visible, badge);
    const next: AppState = {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: workspace,
    };
    setAppState(app, next);
    const updatePolling = vi.spyOn(memoryController(app), "updatePolling").mockImplementation(() => undefined);

    synchronizeMemoryPollingForSelectedWorkspace(app);

    expect(visible).toHaveBeenCalledOnce();
    expect(badge).not.toHaveBeenCalled();
    expect(updatePolling).toHaveBeenCalledWith(true);
  });

  it("binds selected remote Memory polling visibility to the remote activity context", () => {
    const app = createApp();
    const remoteMachine = {
      id: "remote-1",
      name: "Remote 1",
      kind: "remote" as const,
      createdAt: "now",
      updatedAt: "now",
    };
    let closeFromPolling: (() => void) | undefined;
    const visible = (context: ActivityRailContext): boolean => {
      closeFromPolling = () => { context.host.close(); };
      return visibleMemoryActivity(context);
    };
    registerRemoteMemoryActivityRail(app, remoteMachine.id, false, visible);
    const next: AppState = {
      ...initialAppState(),
      selectedMachine: remoteMachine,
      selectedProject: project,
      selectedWorkspace: workspace,
    };
    setAppState(app, next);
    const remoteActivityId = qualifiedContributionId(`${machineScopedPluginId(remoteMachine.id, "workspace-memory")}:workspace.memory`);
    openActivityRailItem(app, remoteActivityId, vi.fn());
    expect(activeActivityId(app)).toBe(remoteActivityId);
    const updatePolling = vi.spyOn(memoryController(app), "updatePolling").mockImplementation(() => undefined);

    synchronizeMemoryPollingForSelectedWorkspace(app);

    expect(updatePolling).toHaveBeenCalledWith(true);
    if (closeFromPolling === undefined) throw new Error("Expected polling to retain the remote Memory host.close callback");
    closeFromPolling();
    expect(activeActivityId(app)).toBeUndefined();
  });

  it("observes an enabled visible Memory activity from the selected remote machine", () => {
    const app = createApp();
    const remoteMachine = {
      id: "remote-1",
      name: "Remote 1",
      kind: "remote" as const,
      createdAt: "now",
      updatedAt: "now",
    };
    registerRemoteMemoryActivityRail(app, remoteMachine.id);
    const next: AppState = {
      ...initialAppState(),
      selectedMachine: remoteMachine,
      selectedProject: project,
      selectedWorkspace: workspace,
      memory: {
        kind: "data",
        globalEntries: [{ id: "global", content: "Global memory" }],
        projectEntries: [{ id: "project", content: "Project memory" }],
      },
    };
    setAppState(app, next);
    setRouteRestoreInProgress(app);
    stubWorkspaceChangeSideEffects(app);
    const updatePolling = vi.spyOn(memoryController(app), "updatePolling").mockImplementation(() => undefined);
    const remoteActivityId = `${machineScopedPluginId(remoteMachine.id, "workspace-memory")}:workspace.memory`;
    const remoteMemoryActivity = pluginRegistry(app).getActivityRailItems().find((activity) => activity.id === remoteActivityId);
    if (remoteMemoryActivity === undefined) throw new Error("Expected a selected remote Memory activity");
    const context = createActivityRailContext(app, remoteMemoryActivity.id);

    expect(remoteMemoryActivity.visible?.(context)).toBe(true);
    expect(remoteMemoryActivity.badge?.(context)).toBe(2);

    handleWorkspaceChange(app, initialAppState(), next);

    expect(updatePolling).toHaveBeenCalledWith(true);
  });

  it("observes the selected remote Memory activity when a machine-specific gateway activity is replaced", () => {
    const app = createApp();
    const remoteMachine = {
      id: "remote-1",
      name: "Remote 1",
      kind: "remote" as const,
      createdAt: "now",
      updatedAt: "now",
    };
    registerMemoryActivityRail(app, true);
    registerRemoteMemoryActivityRail(app, remoteMachine.id, true);
    const next: AppState = {
      ...initialAppState(),
      selectedMachine: remoteMachine,
      selectedProject: project,
      selectedWorkspace: workspace,
    };
    setAppState(app, next);
    setRouteRestoreInProgress(app);
    stubWorkspaceChangeSideEffects(app);
    const updatePolling = vi.spyOn(memoryController(app), "updatePolling").mockImplementation(() => undefined);

    handleWorkspaceChange(app, initialAppState(), next);

    expect(updatePolling).toHaveBeenCalledWith(true);
  });

  it("deactivates Memory polling when safe activity visibility reports confirmed unavailability", () => {
    const app = createApp();
    registerMemoryActivityRail(app);
    const next: AppState = {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: workspace,
      memory: { kind: "unavailable" },
    };
    setAppState(app, next);
    setRouteRestoreInProgress(app);
    stubWorkspaceChangeSideEffects(app);
    const updatePolling = vi.spyOn(memoryController(app), "updatePolling").mockImplementation(() => undefined);

    handleWorkspaceChange(app, initialAppState(), next);

    expect(activityRailItems(app)).toEqual([]);
    expect(updatePolling).toHaveBeenCalledWith(false);
  });

  it("deactivates Memory polling when the activity is absent", () => {
    const app = createApp();
    const next: AppState = {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: workspace,
    };
    setAppState(app, next);
    setRouteRestoreInProgress(app);
    stubWorkspaceChangeSideEffects(app);
    const updatePolling = vi.spyOn(memoryController(app), "updatePolling").mockImplementation(() => undefined);

    handleWorkspaceChange(app, initialAppState(), next);

    expect(updatePolling).toHaveBeenCalledWith(false);
  });

  it("deactivates Memory polling after a visible activity is removed", () => {
    const app = createApp();
    registerMemoryActivityRail(app);
    const next: AppState = {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: workspace,
    };
    setAppState(app, next);
    setRouteRestoreInProgress(app);
    stubWorkspaceChangeSideEffects(app);
    const updatePolling = vi.spyOn(memoryController(app), "updatePolling").mockImplementation(() => undefined);

    handleWorkspaceChange(app, initialAppState(), next);
    setPluginRegistry(app, new PluginRegistry());
    activityRailItems(app);

    expect(updatePolling).toHaveBeenNthCalledWith(1, true);
    expect(updatePolling).toHaveBeenNthCalledWith(2, false);
  });

  it("deactivates Memory polling and hides its activity when no workspace is selected", () => {
    const app = createApp();
    registerMemoryActivityRail(app);
    const next: AppState = {
      ...initialAppState(),
      selectedProject: project,
    };
    setAppState(app, next);
    const updatePolling = vi.spyOn(memoryController(app), "updatePolling").mockImplementation(() => undefined);

    handleWorkspaceChange(app, initialAppState(), next);

    expect(activityRailItems(app)).toEqual([]);
    expect(updatePolling).toHaveBeenCalledWith(false);
  });

  it("re-evaluates Memory polling after external activity registration for the active workspace", async () => {
    const app = createApp();
    const next: AppState = {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: workspace,
    };
    setAppState(app, next);
    stubExternalPluginRegistrationSideEffects(app);
    const updatePolling = vi.spyOn(memoryController(app), "updatePolling").mockImplementation(() => undefined);

    const registered = await registerExternalPlugins(app, "Memory", () => Promise.resolve([{
      id: "workspace-memory",
      plugin: memoryActivityPlugin(),
    }]));

    expect(registered).toBe(true);
    expect(updatePolling).toHaveBeenCalledWith(true);
  });
});

interface MemoryLifecycleController {
  updatePolling(observed?: boolean): void;
  refresh(): Promise<void>;
  dispose(): void;
}

type HandleWorkspaceChange = (this: PiWebUiApp, previous: AppState, next: AppState) => void;
type CreateActivityRailContext = (this: PiWebUiApp, contributionId: QualifiedContributionId) => ActivityRailContext;
type ActivityRailItems = (this: PiWebUiApp) => ActivityRailDisplayItem[];
type RegisterExternalPlugins = (this: PiWebUiApp, label: string, load: () => Promise<PiWebUiPluginRegistration[]>) => Promise<boolean>;
type DisconnectedHook = (this: PiWebUiApp) => void;
type MemoryActivityVisibility = (context: ActivityRailContext) => boolean;
type MemoryActivityBadge = (context: ActivityRailContext) => number | undefined;
type SynchronizeMemoryPollingForSelectedWorkspace = (this: PiWebUiApp) => void;
type OpenActivityRailItem = (this: PiWebUiApp, id: QualifiedContributionId, restoreFocus: () => void) => void;

function createApp(): PiWebUiApp {
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
    setTimeout: () => 1,
    clearTimeout: () => undefined,
  });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  return new PiWebUiApp();
}

function registerMemoryActivityRail(
  app: PiWebUiApp,
  machineSpecific = false,
  visible: MemoryActivityVisibility = visibleMemoryActivity,
  badge?: MemoryActivityBadge,
): void {
  pluginRegistry(app).register({
    id: "workspace-memory",
    machineSpecific,
    plugin: memoryActivityPlugin(visible, badge),
  });
}

function registerRemoteMemoryActivityRail(
  app: PiWebUiApp,
  machineId: string,
  machineSpecific = false,
  visible: MemoryActivityVisibility = visibleMemoryActivity,
  badge?: MemoryActivityBadge,
): void {
  pluginRegistry(app).register({
    id: machineScopedPluginId(machineId, "workspace-memory"),
    machineId,
    sourcePluginId: "workspace-memory",
    machineSpecific,
    plugin: memoryActivityPlugin(visible, badge),
  });
}

function memoryActivityPlugin(
  visible: MemoryActivityVisibility = visibleMemoryActivity,
  badge: MemoryActivityBadge = (context) => context.state.memory.kind === "data" ? 2 : undefined,
): PiWebUiPluginRegistration["plugin"] {
  return {
    apiVersion: 1,
    name: "Memory",
    activate: () => ({
      contributions: {
        activityRailItems: [{
          id: "workspace.memory",
          title: "Memory",
          icon: html`<svg aria-hidden="true"></svg>`,
          visible,
          badge,
          render: () => html``,
        }],
      },
    }),
  };
}

function visibleMemoryActivity(context: ActivityRailContext): boolean {
  return context.workspaceScope !== undefined && context.state.memory.kind !== "unavailable";
}

function pluginRegistry(app: PiWebUiApp): PluginRegistry {
  const value: unknown = Reflect.get(app, "plugins");
  if (!(value instanceof PluginRegistry)) throw new Error("PiWebUiApp plugin registry is unavailable");
  return value;
}

function setPluginRegistry(app: PiWebUiApp, registry: PluginRegistry): void {
  if (!Reflect.set(app, "plugins", registry)) throw new Error("Could not replace PiWebUiApp plugin registry");
}

function setAppState(app: PiWebUiApp, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebUiApp state");
}

function setRouteRestoreInProgress(app: PiWebUiApp): void {
  if (!Reflect.set(app, "routeRestoreDepth", 1)) throw new Error("Could not set PiWebUiApp route restore depth");
}

function stubWorkspaceChangeSideEffects(app: PiWebUiApp): void {
  if (!Reflect.set(app, "refreshActiveTerminals", () => Promise.resolve())) throw new Error("Could not stub terminal refresh");
  if (!Reflect.set(app, "refreshWorkspaceDeletionRuns", () => Promise.resolve())) throw new Error("Could not stub workspace deletion refresh");
}

function stubExternalPluginRegistrationSideEffects(app: PiWebUiApp): void {
  if (!Reflect.set(app, "applyPreferredTheme", () => undefined)) throw new Error("Could not stub theme application");
  if (!Reflect.set(app, "requestUpdate", () => undefined)) throw new Error("Could not stub update request");
}

function memoryController(app: PiWebUiApp): MemoryLifecycleController {
  const value: unknown = Reflect.get(app, "memory");
  if (!isMemoryLifecycleController(value)) throw new Error("PiWebUiApp memory controller is unavailable");
  return value;
}

function handleWorkspaceChange(app: PiWebUiApp, previous: AppState, next: AppState): void {
  const method: unknown = Reflect.get(app, "handleWorkspaceChange");
  if (!isHandleWorkspaceChange(method)) throw new Error("PiWebUiApp.handleWorkspaceChange is not callable");
  method.call(app, previous, next);
}

function createActivityRailContext(app: PiWebUiApp, contributionId: QualifiedContributionId): ActivityRailContext {
  const method: unknown = Reflect.get(app, "createActivityRailContext");
  if (!isCreateActivityRailContext(method)) throw new Error("PiWebUiApp.createActivityRailContext is not callable");
  return method.call(app, contributionId);
}

function activityRailItems(app: PiWebUiApp): ActivityRailDisplayItem[] {
  const method: unknown = Reflect.get(app, "activityRailItems");
  if (!isActivityRailItems(method)) throw new Error("PiWebUiApp.activityRailItems is not callable");
  return method.call(app);
}

function registerExternalPlugins(app: PiWebUiApp, label: string, load: () => Promise<PiWebUiPluginRegistration[]>): Promise<boolean> {
  const method: unknown = Reflect.get(app, "registerExternalPlugins");
  if (!isRegisterExternalPlugins(method)) throw new Error("PiWebUiApp.registerExternalPlugins is not callable");
  return method.call(app, label, load);
}

function synchronizeMemoryPollingForSelectedWorkspace(app: PiWebUiApp): void {
  const method: unknown = Reflect.get(app, "synchronizeMemoryPollingForSelectedWorkspace");
  if (!isSynchronizeMemoryPollingForSelectedWorkspace(method)) throw new Error("PiWebUiApp Memory polling synchronizer is unavailable");
  method.call(app);
}

function openActivityRailItem(app: PiWebUiApp, id: QualifiedContributionId, restoreFocus: () => void): void {
  const method: unknown = Reflect.get(app, "openActivityRailItem");
  if (!isOpenActivityRailItem(method)) throw new Error("PiWebUiApp activity opener is unavailable");
  method.call(app, id, restoreFocus);
}

function activeActivityId(app: PiWebUiApp): QualifiedContributionId | undefined {
  const value: unknown = Reflect.get(app, "activeActivityRailId");
  if (value === undefined) return undefined;
  if (!isQualifiedContributionId(value)) throw new Error("PiWebUiApp active activity id is invalid");
  return value;
}

function qualifiedContributionId(value: string): QualifiedContributionId {
  if (!isQualifiedContributionId(value)) throw new Error("Expected a qualified contribution id");
  return value;
}

function invokeDisconnected(app: PiWebUiApp): void {
  const method: unknown = Reflect.get(app, "disconnectedCallback");
  if (!isDisconnectedHook(method)) throw new Error("PiWebUiApp.disconnectedCallback is not callable");
  method.call(app);
}

function isQualifiedContributionId(value: unknown): value is QualifiedContributionId {
  return typeof value === "string" && value.includes(":");
}

function isSynchronizeMemoryPollingForSelectedWorkspace(value: unknown): value is SynchronizeMemoryPollingForSelectedWorkspace {
  return typeof value === "function";
}

function isOpenActivityRailItem(value: unknown): value is OpenActivityRailItem {
  return typeof value === "function";
}

function isMemoryLifecycleController(value: unknown): value is MemoryLifecycleController {
  return typeof value === "object" && value !== null
    && typeof Reflect.get(value, "updatePolling") === "function"
    && typeof Reflect.get(value, "refresh") === "function"
    && typeof Reflect.get(value, "dispose") === "function";
}

function isVoidCallback(value: unknown): value is () => void {
  return typeof value === "function";
}

function isHandleWorkspaceChange(value: unknown): value is HandleWorkspaceChange {
  return typeof value === "function";
}

function isCreateActivityRailContext(value: unknown): value is CreateActivityRailContext {
  return typeof value === "function";
}

function isActivityRailItems(value: unknown): value is ActivityRailItems {
  return typeof value === "function";
}

function isRegisterExternalPlugins(value: unknown): value is RegisterExternalPlugins {
  return typeof value === "function";
}

function isDisconnectedHook(value: unknown): value is DisconnectedHook {
  return typeof value === "function";
}
