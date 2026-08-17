import { html, type TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { machineScopedPluginId } from "../../../shared/machinePluginIds";
import type { Machine, Project, Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import type {
  WorkspaceTasksActions,
  WorkspaceTasksControllerDependencies,
  WorkspaceTasksSelection,
  WorkspaceTasksWorkspaceState,
} from "../controllers/workspaceTasksController";
import { PluginRegistry } from "../plugins/registry";
import type {
  PiWebUiPluginRegistration,
  QualifiedContributionId,
  WorkspacePanelContext,
} from "../plugins/types";
import { PiWebUiApp } from "./PiWebUiApp";

const project: Project = {
  id: "project-a",
  name: "Project A",
  path: "/work/project-a",
  createdAt: "now",
};
const workspaceA: Workspace = {
  id: "workspace-a",
  projectId: project.id,
  path: "/work/project-a",
  label: "main",
  isMain: true,
  isGitRepo: true,
  isGitWorktree: false,
};
const workspaceB: Workspace = {
  ...workspaceA,
  id: "workspace-b",
  path: "/work/project-b",
  label: "feature",
  isMain: false,
  isGitWorktree: true,
};
const remoteMachine: Machine = {
  id: "remote-1",
  name: "Remote 1",
  kind: "remote",
  createdAt: "now",
  updatedAt: "now",
};
const tasksPanelId: QualifiedContributionId = "workspace-tasks:workspace.tasks";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebUiApp Workspace Tasks panel bridge", () => {
  it("scopes the bridge only to the bundled Workspace Tasks contribution", () => {
    const controller = new FakeWorkspaceTasksController(taskState("initial"));
    const app = createApp(controller);
    const captures = new Map<string, WorkspacePanelContext[]>();
    const unrelatedCaptures = new Map<string, WorkspacePanelContext[]>();
    setAppState(app, selectedWorkspaceState());
    registerWorkspacePanels(app, "workspace-tasks", [
      panelCapture("workspace.tasks", captures),
      panelCapture("workspace.other", captures),
    ]);
    registerWorkspacePanels(app, "unrelated", [panelCapture("workspace.tasks", unrelatedCaptures)]);

    renderPanel(app, tasksPanelId);
    renderPanel(app, "workspace-tasks:workspace.other");
    renderPanel(app, "unrelated:workspace.tasks");

    const taskContext = latestCapturedContext(captures, "workspace.tasks");
    expect(workspaceTasksBridge(taskContext)).toEqual({
      state: controller.state,
      actions: controller.actions,
    });
    expect(Reflect.has(latestCapturedContext(captures, "workspace.other"), "workspaceTasks")).toBe(false);
    expect(Reflect.has(latestCapturedContext(unrelatedCaptures, "workspace.tasks"), "workspaceTasks")).toBe(false);
  });

  it("matches a remote task panel through its source plugin identity", () => {
    const controller = new FakeWorkspaceTasksController(taskState("remote"));
    const app = createApp(controller);
    const remotePluginId = machineScopedPluginId(remoteMachine.id, "workspace-tasks");
    const captures = new Map<string, WorkspacePanelContext[]>();
    setAppState(app, {
      ...selectedWorkspaceState(),
      selectedMachine: remoteMachine,
    });
    pluginRegistry(app).register({
      id: remotePluginId,
      machineId: remoteMachine.id,
      sourcePluginId: "workspace-tasks",
      machineSpecific: true,
      plugin: workspacePanelPlugin([panelCapture("workspace.tasks", captures)]),
    });

    renderPanel(app, `${remotePluginId}:workspace.tasks`);

    expect(workspaceTasksBridge(latestCapturedContext(captures, "workspace.tasks"))).toEqual({
      state: controller.state,
      actions: controller.actions,
    });
  });

  it("observes tasks only when the qualifying panel is visible for a selected workspace", () => {
    const controller = new FakeWorkspaceTasksController(taskState("observed"));
    const app = createApp(controller);
    const captures = new Map<string, WorkspacePanelContext[]>();
    let visible = false;
    registerWorkspacePanels(app, "workspace-tasks", [
      panelCapture("workspace.tasks", captures, () => visible),
    ]);

    const projectOnly: AppState = {
      ...initialAppState(),
      selectedProject: project,
    };
    setAppState(app, projectOnly);
    handleWorkspaceChange(app, initialAppState(), projectOnly);
    expect(lastObservation(controller)).toEqual({ enabled: false });

    const selected = selectedWorkspaceState();
    setAppState(app, selected);
    setRouteRestoreInProgress(app);
    stubWorkspaceChangeSideEffects(app);
    handleWorkspaceChange(app, projectOnly, selected);
    expect(lastObservation(controller)).toEqual({ enabled: false });

    visible = true;
    workspacePanelTabs(app);

    expect(lastObservation(controller)).toEqual({
      enabled: true,
      selection: workspaceTasksSelection("local", workspaceA),
    });
  });

  it("resynchronizes task selection across workspace, machine, and path changes", () => {
    const firstState = taskState("first");
    const secondState = taskState("second");
    const thirdState = taskState("third");
    const controller = new FakeWorkspaceTasksController(firstState);
    const app = createApp(controller);
    const captures = new Map<string, WorkspacePanelContext[]>();
    registerWorkspacePanels(app, "workspace-tasks", [panelCapture("workspace.tasks", captures)]);

    const first = selectedWorkspaceState();
    setAppState(app, first);
    setRouteRestoreInProgress(app);
    stubWorkspaceChangeSideEffects(app);
    handleWorkspaceChange(app, initialAppState(), first);
    expect(lastObservation(controller)).toEqual({
      enabled: true,
      selection: workspaceTasksSelection("local", workspaceA),
    });

    const second: AppState = {
      ...first,
      selectedWorkspace: workspaceB,
    };
    controller.setState(secondState);
    setAppState(app, second);
    handleWorkspaceChange(app, first, second);
    expect(lastObservation(controller)).toEqual({
      enabled: true,
      selection: workspaceTasksSelection("local", workspaceB),
    });

    const third: AppState = {
      ...second,
      selectedMachine: remoteMachine,
    };
    controller.setState(thirdState);
    setAppState(app, third);
    handleWorkspaceChange(app, second, third);
    expect(lastObservation(controller)).toEqual({
      enabled: true,
      selection: workspaceTasksSelection(remoteMachine.id, workspaceB),
    });

    const renamedWorkspace: Workspace = {
      ...workspaceB,
      path: "/work/project-b-renamed",
    };
    const renamed: AppState = {
      ...third,
      selectedWorkspace: renamedWorkspace,
    };
    setAppState(app, renamed);
    handleWorkspaceChange(app, third, renamed);
    expect(lastObservation(controller)).toEqual({
      enabled: true,
      selection: workspaceTasksSelection(remoteMachine.id, renamedWorkspace),
    });

    renderPanel(app, tasksPanelId);
    expect(workspaceTasksBridge(latestCapturedContext(captures, "workspace.tasks")).state).toBe(thirdState);
    expect(workspaceTasksBridge(latestCapturedContext(captures, "workspace.tasks")).state).not.toBe(firstState);
  });

  it("rerenders the mounted task panel context after a same-workspace controller publication", () => {
    const initialState = taskState("initial");
    const publishedState = taskState("published");
    const controller = new FakeWorkspaceTasksController(initialState);
    const app = createApp(controller);
    const captures = new Map<string, WorkspacePanelContext[]>();
    setAppState(app, selectedWorkspaceState());
    registerWorkspacePanels(app, "workspace-tasks", [panelCapture("workspace.tasks", captures)]);

    renderPanel(app, tasksPanelId);
    const requestUpdate = vi.spyOn(app, "requestUpdate");
    controller.publish(publishedState);
    renderPanel(app, tasksPanelId);

    expect(requestUpdate).toHaveBeenCalledOnce();
    expect(workspaceTasksBridge(latestCapturedContext(captures, "workspace.tasks")).state).toBe(publishedState);
  });

  it("resynchronizes observation after external task panel registration", async () => {
    const controller = new FakeWorkspaceTasksController(taskState("registered"));
    const app = createApp(controller);
    const captures = new Map<string, WorkspacePanelContext[]>();
    setAppState(app, selectedWorkspaceState());
    stubExternalPluginRegistrationSideEffects(app);

    const registered = await registerExternalPlugins(app, "Tasks", () => Promise.resolve([{
      id: "workspace-tasks",
      plugin: workspacePanelPlugin([panelCapture("workspace.tasks", captures)]),
    }]));

    expect(registered).toBe(true);
    expect(lastObservation(controller)).toEqual({
      enabled: true,
      selection: workspaceTasksSelection("local", workspaceA),
    });
  });

  it("disables and disposes the Workspace Tasks controller on disconnect", () => {
    const controller = new FakeWorkspaceTasksController(taskState("disconnect"));
    const app = createApp(controller);

    invokeDisconnected(app);

    expect(lastObservation(controller)).toEqual({ enabled: false });
    expect(controller.dispose).toHaveBeenCalledOnce();
  });
});

interface PanelCapture {
  id: string;
  captures: Map<string, WorkspacePanelContext[]>;
  visible?: (context: WorkspacePanelContext) => boolean;
}

interface WorkspaceTasksLifecycleController {
  readonly state: WorkspaceTasksWorkspaceState;
  readonly actions: WorkspaceTasksActions;
  observe(enabled: boolean): void;
  dispose(): void;
}

type WorkspacePanelTabs = (this: PiWebUiApp) => readonly {
  id: QualifiedContributionId;
  render: () => TemplateResult;
}[];
type HandleWorkspaceChange = (this: PiWebUiApp, previous: AppState, next: AppState) => void;
type RegisterExternalPlugins = (this: PiWebUiApp, label: string, load: () => Promise<PiWebUiPluginRegistration[]>) => Promise<boolean>;
type DisconnectedHook = (this: PiWebUiApp) => void;

class FakeWorkspaceTasksController implements WorkspaceTasksLifecycleController {
  private selectedScope: (() => WorkspaceTasksSelection | undefined) | undefined;
  private onChange: ((state: WorkspaceTasksWorkspaceState) => void) | undefined;
  private currentState: WorkspaceTasksWorkspaceState;
  readonly observations: { enabled: boolean; selection?: WorkspaceTasksSelection }[] = [];
  readonly actions: WorkspaceTasksActions = {
    create: () => Promise.resolve(),
    update: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    move: () => Promise.resolve(),
    retryMove: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
  };
  readonly observe = vi.fn((enabled: boolean) => {
    const selection = this.selectedScope?.();
    this.observations.push(enabled && selection !== undefined
      ? { enabled, selection }
      : { enabled });
  });
  readonly dispose = vi.fn();

  constructor(state: WorkspaceTasksWorkspaceState) {
    this.currentState = state;
  }

  get state(): WorkspaceTasksWorkspaceState {
    return this.currentState;
  }

  connect(dependencies: WorkspaceTasksControllerDependencies): void {
    this.selectedScope = dependencies.selectedScope;
    this.onChange = dependencies.onChange;
  }

  setState(state: WorkspaceTasksWorkspaceState): void {
    this.currentState = state;
  }

  publish(state: WorkspaceTasksWorkspaceState): void {
    this.currentState = state;
    this.onChange?.(state);
  }
}

function createApp(controller: FakeWorkspaceTasksController): PiWebUiApp {
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
  return new PiWebUiApp({
    createWorkspaceTasksController: (dependencies: WorkspaceTasksControllerDependencies) => {
      controller.connect(dependencies);
      return controller;
    },
  });
}

function selectedWorkspaceState(): AppState {
  return {
    ...initialAppState(),
    selectedProject: project,
    selectedWorkspace: workspaceA,
  };
}

function taskState(message: string): WorkspaceTasksWorkspaceState {
  return {
    workspace: { kind: "missing", message, hint: "Create a task catalog.", refreshing: false },
    global: { kind: "loading" },
  };
}

function workspaceTasksSelection(machineId: string, workspace: Workspace): WorkspaceTasksSelection {
  return {
    machineId,
    projectId: workspace.projectId,
    workspaceId: workspace.id,
    workspacePath: workspace.path,
  };
}

function panelCapture(
  id: string,
  captures: Map<string, WorkspacePanelContext[]>,
  visible?: (context: WorkspacePanelContext) => boolean,
): PanelCapture {
  return { id, captures, ...(visible === undefined ? {} : { visible }) };
}

function workspacePanelPlugin(panels: readonly PanelCapture[]): PiWebUiPluginRegistration["plugin"] {
  return {
    apiVersion: 1,
    name: "Workspace Panels",
    activate: () => ({
      contributions: {
        workspacePanels: panels.map((panel) => ({
          id: panel.id,
          title: panel.id,
          ...(panel.visible === undefined ? {} : { visible: panel.visible }),
          render: (context: WorkspacePanelContext) => {
            const captured = panel.captures.get(panel.id) ?? [];
            captured.push(context);
            panel.captures.set(panel.id, captured);
            return html``;
          },
        })),
      },
    }),
  };
}

function registerWorkspacePanels(app: PiWebUiApp, id: string, panels: readonly PanelCapture[]): void {
  pluginRegistry(app).register({ id, plugin: workspacePanelPlugin(panels) });
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

function workspacePanelTabs(app: PiWebUiApp): readonly { id: QualifiedContributionId; render: () => TemplateResult }[] {
  const method: unknown = Reflect.get(app, "resolvedWorkspacePanelTabs");
  if (!isWorkspacePanelTabs(method)) throw new Error("PiWebUiApp workspace panel resolver is unavailable");
  return method.call(app);
}

function renderPanel(app: PiWebUiApp, id: QualifiedContributionId): void {
  const panel = workspacePanelTabs(app).find((candidate) => candidate.id === id);
  if (panel === undefined) throw new Error(`Expected workspace panel ${id}`);
  panel.render();
}

function latestCapturedContext(captures: Map<string, WorkspacePanelContext[]>, id: string): WorkspacePanelContext {
  const context = captures.get(id)?.at(-1);
  if (context === undefined) throw new Error(`Expected a captured workspace panel context for ${id}`);
  return context;
}

function workspaceTasksBridge(context: WorkspacePanelContext): { state: WorkspaceTasksWorkspaceState; actions: WorkspaceTasksActions } {
  const bridge: unknown = Reflect.get(context, "workspaceTasks");
  if (!isWorkspaceTasksBridge(bridge)) throw new Error("Expected a Workspace Tasks panel bridge");
  return bridge;
}

function handleWorkspaceChange(app: PiWebUiApp, previous: AppState, next: AppState): void {
  const method: unknown = Reflect.get(app, "handleWorkspaceChange");
  if (!isHandleWorkspaceChange(method)) throw new Error("PiWebUiApp.handleWorkspaceChange is not callable");
  method.call(app, previous, next);
}

function registerExternalPlugins(app: PiWebUiApp, label: string, load: () => Promise<PiWebUiPluginRegistration[]>): Promise<boolean> {
  const method: unknown = Reflect.get(app, "registerExternalPlugins");
  if (!isRegisterExternalPlugins(method)) throw new Error("PiWebUiApp.registerExternalPlugins is not callable");
  return method.call(app, label, load);
}

function invokeDisconnected(app: PiWebUiApp): void {
  const method: unknown = Reflect.get(app, "disconnectedCallback");
  if (!isDisconnectedHook(method)) throw new Error("PiWebUiApp.disconnectedCallback is not callable");
  method.call(app);
}

function lastObservation(controller: FakeWorkspaceTasksController): { enabled: boolean; selection?: WorkspaceTasksSelection } {
  const observation = controller.observations.at(-1);
  if (observation === undefined) throw new Error("Expected Workspace Tasks observation");
  return observation;
}

function isWorkspacePanelTabs(value: unknown): value is WorkspacePanelTabs {
  return typeof value === "function";
}

function isWorkspaceTasksBridge(value: unknown): value is { state: WorkspaceTasksWorkspaceState; actions: WorkspaceTasksActions } {
  return typeof value === "object" && value !== null
    && Reflect.has(value, "state")
    && Reflect.has(value, "actions");
}

function isHandleWorkspaceChange(value: unknown): value is HandleWorkspaceChange {
  return typeof value === "function";
}

function isRegisterExternalPlugins(value: unknown): value is RegisterExternalPlugins {
  return typeof value === "function";
}

function isDisconnectedHook(value: unknown): value is DisconnectedHook {
  return typeof value === "function";
}
