import { html } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { machineScopedPluginId } from "../../../shared/machinePluginIds";
import type { Machine, Project, Workspace } from "../api";
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
const remoteMachine: Machine = {
  id: "remote-1",
  name: "Remote 1",
  kind: "remote",
  createdAt: "now",
  updatedAt: "now",
};
const learnedSkillsActivityId: QualifiedContributionId = "workspace-learned-skills:workspace.learned-skills";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebUiApp Learned Skills activity-Rail lifecycle wiring", () => {
  it("starts polling when a selected workspace has a visible Learned Skills activity", () => {
    const app = createApp();
    registerLearnedSkillsActivityRail(app);
    const next = selectedWorkspaceState();
    setAppState(app, next);
    setRouteRestoreInProgress(app);
    stubWorkspaceChangeSideEffects(app);
    const updatePolling = vi.spyOn(learnedSkillsController(app), "updatePolling").mockImplementation(() => undefined);

    handleWorkspaceChange(app, initialAppState(), next);

    expect(updatePolling).toHaveBeenCalledWith(true);
  });

  it("stops polling and hides Learned Skills when no workspace is selected", () => {
    const app = createApp();
    registerLearnedSkillsActivityRail(app);
    const next: AppState = {
      ...initialAppState(),
      selectedProject: project,
    };
    setAppState(app, next);
    const updatePolling = vi.spyOn(learnedSkillsController(app), "updatePolling").mockImplementation(() => undefined);

    handleWorkspaceChange(app, initialAppState(), next);

    expect(activityRailItems(app)).toEqual([]);
    expect(updatePolling).toHaveBeenCalledWith(false);
  });

  it("stops polling when the Learned Skills activity is absent", () => {
    const app = createApp();
    const next = selectedWorkspaceState();
    setAppState(app, next);
    setRouteRestoreInProgress(app);
    stubWorkspaceChangeSideEffects(app);
    const updatePolling = vi.spyOn(learnedSkillsController(app), "updatePolling").mockImplementation(() => undefined);

    handleWorkspaceChange(app, initialAppState(), next);

    expect(activityRailItems(app)).toEqual([]);
    expect(updatePolling).toHaveBeenCalledWith(false);
  });

  it("stops polling and hides Learned Skills after confirmed unavailability", () => {
    const app = createApp();
    registerLearnedSkillsActivityRail(app);
    const next: AppState = {
      ...selectedWorkspaceState(),
      learnedSkills: { kind: "unavailable" },
    };
    setAppState(app, next);
    setRouteRestoreInProgress(app);
    stubWorkspaceChangeSideEffects(app);
    const updatePolling = vi.spyOn(learnedSkillsController(app), "updatePolling").mockImplementation(() => undefined);

    handleWorkspaceChange(app, initialAppState(), next);

    expect(activityRailItems(app)).toEqual([]);
    expect(updatePolling).toHaveBeenCalledWith(false);
  });

  it("restarts polling when the selected workspace path changes", () => {
    const app = createApp();
    registerLearnedSkillsActivityRail(app);
    const previous = selectedWorkspaceState();
    const next: AppState = {
      ...previous,
      selectedWorkspace: { ...workspace, path: "/work/project-a-renamed" },
    };
    setAppState(app, next);
    const updatePolling = vi.spyOn(learnedSkillsController(app), "updatePolling").mockImplementation(() => undefined);

    handleWorkspaceChange(app, previous, next);

    expect(updatePolling).toHaveBeenCalledWith(true);
  });

  it("uses safe visibility without evaluating the Learned Skills badge during polling", () => {
    const app = createApp();
    const visible = vi.fn(visibleLearnedSkillsActivity);
    const badge = vi.fn(() => 2);
    registerLearnedSkillsActivityRail(app, false, visible, badge);
    setAppState(app, selectedWorkspaceState());
    const updatePolling = vi.spyOn(learnedSkillsController(app), "updatePolling").mockImplementation(() => undefined);

    synchronizeLearnedSkillsPollingForSelectedWorkspace(app);

    expect(visible).toHaveBeenCalledOnce();
    expect(badge).not.toHaveBeenCalled();
    expect(updatePolling).toHaveBeenCalledWith(true);
  });

  it("observes the selected remote machine activity instead of the gateway copy", () => {
    const app = createApp();
    const gatewayVisible = vi.fn(visibleLearnedSkillsActivity);
    const remoteVisible = vi.fn(visibleLearnedSkillsActivity);
    registerLearnedSkillsActivityRail(app, true, gatewayVisible);
    registerRemoteLearnedSkillsActivityRail(app, remoteMachine.id, true, remoteVisible);
    setAppState(app, {
      ...selectedWorkspaceState(),
      selectedMachine: remoteMachine,
    });
    const updatePolling = vi.spyOn(learnedSkillsController(app), "updatePolling").mockImplementation(() => undefined);

    synchronizeLearnedSkillsPollingForSelectedWorkspace(app);

    expect(gatewayVisible).not.toHaveBeenCalled();
    expect(remoteVisible).toHaveBeenCalledOnce();
    expect(updatePolling).toHaveBeenCalledWith(true);
  });

  it("exposes an internal refresh callback that refreshes Learned Skills", () => {
    const app = createApp();
    const refresh = vi.spyOn(learnedSkillsController(app), "refresh").mockResolvedValue(undefined);

    const context = createActivityRailContext(app, learnedSkillsActivityId);
    const onRefreshLearnedSkills: unknown = Reflect.get(context, "onRefreshLearnedSkills");
    if (!isVoidCallback(onRefreshLearnedSkills)) {
      throw new Error("PiWebUiApp did not expose an internal Learned Skills refresh callback");
    }
    onRefreshLearnedSkills();

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("disposes the Learned Skills controller on disconnect", () => {
    const app = createApp();
    const dispose = vi.spyOn(learnedSkillsController(app), "dispose").mockImplementation(() => undefined);

    invokeDisconnected(app);

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("re-evaluates polling after external Learned Skills activity registration", async () => {
    const app = createApp();
    setAppState(app, selectedWorkspaceState());
    stubExternalPluginRegistrationSideEffects(app);
    const updatePolling = vi.spyOn(learnedSkillsController(app), "updatePolling").mockImplementation(() => undefined);

    const registered = await registerExternalPlugins(app, "Learned Skills", () => Promise.resolve([{
      id: "workspace-learned-skills",
      plugin: learnedSkillsActivityPlugin(),
    }]));

    expect(registered).toBe(true);
    expect(updatePolling).toHaveBeenCalledWith(true);
  });
});

interface LearnedSkillsLifecycleController {
  updatePolling(observed?: boolean): void;
  refresh(): Promise<void>;
  dispose(): void;
}

type HandleWorkspaceChange = (this: PiWebUiApp, previous: AppState, next: AppState) => void;
type CreateActivityRailContext = (this: PiWebUiApp, contributionId: QualifiedContributionId) => ActivityRailContext;
type ActivityRailItems = (this: PiWebUiApp) => ActivityRailDisplayItem[];
type RegisterExternalPlugins = (this: PiWebUiApp, label: string, load: () => Promise<PiWebUiPluginRegistration[]>) => Promise<boolean>;
type DisconnectedHook = (this: PiWebUiApp) => void;
type LearnedSkillsActivityVisibility = (context: ActivityRailContext) => boolean;
type LearnedSkillsActivityBadge = (context: ActivityRailContext) => number | undefined;
type SynchronizeLearnedSkillsPollingForSelectedWorkspace = (this: PiWebUiApp) => void;

function selectedWorkspaceState(): AppState {
  return {
    ...initialAppState(),
    selectedProject: project,
    selectedWorkspace: workspace,
  };
}

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

function registerLearnedSkillsActivityRail(
  app: PiWebUiApp,
  machineSpecific = false,
  visible: LearnedSkillsActivityVisibility = visibleLearnedSkillsActivity,
  badge?: LearnedSkillsActivityBadge,
): void {
  pluginRegistry(app).register({
    id: "workspace-learned-skills",
    machineSpecific,
    plugin: learnedSkillsActivityPlugin(visible, badge),
  });
}

function registerRemoteLearnedSkillsActivityRail(
  app: PiWebUiApp,
  machineId: string,
  machineSpecific = false,
  visible: LearnedSkillsActivityVisibility = visibleLearnedSkillsActivity,
  badge?: LearnedSkillsActivityBadge,
): void {
  pluginRegistry(app).register({
    id: machineScopedPluginId(machineId, "workspace-learned-skills"),
    machineId,
    sourcePluginId: "workspace-learned-skills",
    machineSpecific,
    plugin: learnedSkillsActivityPlugin(visible, badge),
  });
}

function learnedSkillsActivityPlugin(
  visible: LearnedSkillsActivityVisibility = visibleLearnedSkillsActivity,
  badge: LearnedSkillsActivityBadge = (context) => context.state.learnedSkills.kind === "data" ? 2 : undefined,
): PiWebUiPluginRegistration["plugin"] {
  return {
    apiVersion: 1,
    name: "Learned Skills",
    activate: () => ({
      contributions: {
        activityRailItems: [{
          id: "workspace.learned-skills",
          title: "Learned Skills",
          icon: html`<svg aria-hidden="true"></svg>`,
          visible,
          badge,
          render: () => html``,
        }],
      },
    }),
  };
}

function visibleLearnedSkillsActivity(context: ActivityRailContext): boolean {
  return context.workspaceScope !== undefined && context.state.learnedSkills.kind !== "unavailable";
}

function pluginRegistry(app: PiWebUiApp): PluginRegistry {
  const value: unknown = Reflect.get(app, "plugins");
  if (!(value instanceof PluginRegistry)) throw new Error("PiWebUiApp plugin registry is unavailable");
  return value;
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

function learnedSkillsController(app: PiWebUiApp): LearnedSkillsLifecycleController {
  const value: unknown = Reflect.get(app, "learnedSkills");
  if (!isLearnedSkillsLifecycleController(value)) throw new Error("PiWebUiApp Learned Skills controller is unavailable");
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

function synchronizeLearnedSkillsPollingForSelectedWorkspace(app: PiWebUiApp): void {
  const method: unknown = Reflect.get(app, "synchronizeLearnedSkillsPollingForSelectedWorkspace");
  if (!isSynchronizeLearnedSkillsPollingForSelectedWorkspace(method)) {
    throw new Error("PiWebUiApp Learned Skills polling synchronizer is unavailable");
  }
  method.call(app);
}

function invokeDisconnected(app: PiWebUiApp): void {
  const method: unknown = Reflect.get(app, "disconnectedCallback");
  if (!isDisconnectedHook(method)) throw new Error("PiWebUiApp.disconnectedCallback is not callable");
  method.call(app);
}

function isLearnedSkillsLifecycleController(value: unknown): value is LearnedSkillsLifecycleController {
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

function isSynchronizeLearnedSkillsPollingForSelectedWorkspace(
  value: unknown,
): value is SynchronizeLearnedSkillsPollingForSelectedWorkspace {
  return typeof value === "function";
}

function isDisconnectedHook(value: unknown): value is DisconnectedHook {
  return typeof value === "function";
}
