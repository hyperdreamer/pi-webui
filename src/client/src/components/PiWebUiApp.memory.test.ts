import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebUiApp memory lifecycle wiring", () => {
  it("restarts memory polling when the selected workspace path changes without an id change", () => {
    const app = createApp();
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

    expect(updatePolling).toHaveBeenCalledOnce();
  });

  it("starts selected-workspace memory polling, exposes its internal retry callback, and disposes it on disconnect", () => {
    const app = createApp();
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

    expect(updatePolling).toHaveBeenCalledOnce();
    const context = createWorkspacePanelContext(app, workspace);
    const onRefreshMemory: unknown = Reflect.get(context, "onRefreshMemory");
    if (!isVoidCallback(onRefreshMemory)) throw new Error("PiWebUiApp did not expose an internal memory refresh callback");
    onRefreshMemory();
    expect(refresh).toHaveBeenCalledOnce();

    invokeDisconnected(app);

    expect(dispose).toHaveBeenCalledOnce();
  });
});

interface MemoryLifecycleController {
  updatePolling(): void;
  refresh(): Promise<void>;
  dispose(): void;
}

type HandleWorkspaceChange = (this: PiWebUiApp, previous: AppState, next: AppState) => void;
type CreateWorkspacePanelContext = (this: PiWebUiApp, workspace: Workspace) => object;
type DisconnectedHook = (this: PiWebUiApp) => void;

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

function createWorkspacePanelContext(app: PiWebUiApp, selectedWorkspace: Workspace): object {
  const method: unknown = Reflect.get(app, "createWorkspacePanelContext");
  if (!isCreateWorkspacePanelContext(method)) throw new Error("PiWebUiApp.createWorkspacePanelContext is not callable");
  return method.call(app, selectedWorkspace);
}

function invokeDisconnected(app: PiWebUiApp): void {
  const method: unknown = Reflect.get(app, "disconnectedCallback");
  if (!isDisconnectedHook(method)) throw new Error("PiWebUiApp.disconnectedCallback is not callable");
  method.call(app);
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

function isCreateWorkspacePanelContext(value: unknown): value is CreateWorkspacePanelContext {
  return typeof value === "function";
}

function isDisconnectedHook(value: unknown): value is DisconnectedHook {
  return typeof value === "function";
}
