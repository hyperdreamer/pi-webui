import { html, type TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Machine, Project, Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import type { ActivityRailDisplayItem } from "../plugins/activityRail";
import { PluginRegistry } from "../plugins/registry";
import type { ActivityRailContext, QualifiedContributionId } from "../plugins/types";
import { isTemplateResult, templateValueAfterMarker } from "../templateInspection.testSupport";
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
  id: "remote-a",
  name: "Remote A",
  kind: "remote",
  createdAt: "now",
  updatedAt: "now",
};
const dashboardId: QualifiedContributionId = "example:dashboard";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebUiApp activity rail orchestration", () => {
  it("opens a visible plugin activity and restores its origin focus after closing", async () => {
    const app = createApp();
    registerActivityPlugin(app);
    setAppState(app, selectedActivityState());
    const restoreFocus = vi.fn();
    const updateComplete = Promise.resolve(true);
    Object.defineProperty(app, "updateComplete", { configurable: true, value: updateComplete });

    expect(activityRailItems(app).map((item) => item.id)).toEqual([dashboardId]);

    openActivityRailItem(app, dashboardId, restoreFocus);
    expect(activeActivityId(app)).toBe(dashboardId);

    closeActivityRailItem(app);
    expect(restoreFocus).not.toHaveBeenCalled();
    await updateComplete;

    expect(restoreFocus).toHaveBeenCalledOnce();
  });

  it("does not expose workspace scope when no workspace is selected", () => {
    const app = createApp();
    setAppState(app, {
      ...initialAppState(),
      selectedMachine: remoteMachine,
      selectedProject: project,
    });

    const context = createActivityRailContext(app);

    expect(context.machine).toEqual({ id: remoteMachine.id, name: remoteMachine.name, kind: remoteMachine.kind });
    expect("workspaceScope" in context).toBe(false);
    expect(Reflect.get(context, "onRefreshMemory")).toEqual(expect.any(Function));
  });

  it("provides selected-workspace file and terminal helpers to activity contexts", () => {
    const app = createApp();
    setAppState(app, selectedActivityState());

    const context = createActivityRailContext(app);
    const scope = context.workspaceScope;
    if (scope === undefined) throw new Error("Expected an activity workspace scope");

    expect(scope.workspace).toBe(workspace);
    expect(typeof scope.files.readFile).toBe("function");
    expect(typeof scope.files.writeFile).toBe("function");
    expect(typeof scope.files.deleteFile).toBe("function");
    expect(typeof scope.files.moveFile).toBe("function");
    expect(typeof scope.terminal.open).toBe("function");
    expect(typeof scope.terminal.runCommand).toBe("function");
  });

  it("does not open a contribution that safe projection hides", () => {
    const app = createApp();
    registerActivityPlugin(app, () => false);
    setAppState(app, selectedActivityState());

    expect(activityRailItems(app)).toEqual([]);

    openActivityRailItem(app, dashboardId, vi.fn());

    expect(activeActivityId(app)).toBeUndefined();
  });

  it("closes an active contribution after its workspace-dependent visibility disappears", () => {
    const app = createApp();
    registerActivityPlugin(app, (context) => context.workspaceScope !== undefined);
    const state = selectedActivityState();
    setAppState(app, state);
    openActivityRailItem(app, dashboardId, vi.fn());
    expect(activeActivityId(app)).toBe(dashboardId);

    setAppState(app, { ...state, selectedWorkspace: undefined });
    reconcileActivityRailVisibility(app);

    expect(activeActivityId(app)).toBeUndefined();
  });

  it("closes the compact rail before activating a plugin activity", () => {
    const app = createApp();
    registerActivityPlugin(app);
    setAppState(app, selectedActivityState());
    setCompactRailOpen(app, true);
    let compactRailOpenAtActivation: boolean | undefined;
    vi.spyOn(app, "requestUpdate").mockImplementation((name) => {
      if (name === "activeActivityRailId") compactRailOpenAtActivation = compactRailOpen(app);
    });

    openActivityRailItem(app, dashboardId, vi.fn());

    expect(compactRailOpenAtActivation).toBe(false);
    expect(compactRailOpen(app)).toBe(false);
    expect(activeActivityId(app)).toBe(dashboardId);
  });

  it("renders the context-bar launcher for the compact 761–1180px layout", () => {
    const app = createApp();
    setMobileNavigationLayout(app, false);
    setDesktopActivityRailLayout(app, false);

    const compactContextBar = renderContextBar(app);
    expect(compactContextBar).not.toBeNull();
    if (compactContextBar === null) throw new Error("Expected an app context bar outside the desktop rail layout");
    expect(templateValueAfterMarker(compactContextBar, ".activityRailOpen=")).toBe(false);
    toggleActivityRailFromContextBar(compactContextBar)();
    expect(compactRailOpen(app)).toBe(true);

    setDesktopActivityRailLayout(app, true);
    expect(renderContextBar(app)).toBeNull();
  });

  it("closes the compact rail after the desktop dock returns", () => {
    const app = createApp();
    setCompactRailOpen(app, true);
    setDesktopActivityRailLayout(app, true);

    reconcileActivityRailVisibility(app);

    expect(compactRailOpen(app)).toBe(false);
  });

  it("keeps global shortcuts out of an open compact rail or activity dialog", () => {
    const app = createApp();
    const handleShortcut = replaceKeyboardHandler(app);

    setCompactRailOpen(app, true);
    dispatchGlobalKeyDown(app);
    expect(handleShortcut).not.toHaveBeenCalled();
    expect(isChatObscured(app)).toBe(true);

    setCompactRailOpen(app, false);
    setActiveActivityId(app, dashboardId);
    dispatchGlobalKeyDown(app);
    expect(handleShortcut).not.toHaveBeenCalled();
    expect(isChatObscured(app)).toBe(true);
  });
});

type ActivityRailItems = (this: PiWebUiApp) => ActivityRailDisplayItem[];
type CreateActivityRailContext = (this: PiWebUiApp) => ActivityRailContext;
type OpenActivityRailItem = (this: PiWebUiApp, id: QualifiedContributionId, restoreFocus: () => void) => void;
type CloseActivityRailItem = (this: PiWebUiApp) => void;
type UpdatedHook = (this: PiWebUiApp) => void;
type RenderContextBar = (this: PiWebUiApp) => TemplateResult | null;
type IsChatObscured = (this: PiWebUiApp) => boolean;
type GlobalKeyDownHandler = (event: Event) => void;

function selectedActivityState(): AppState {
  return {
    ...initialAppState(),
    selectedMachine: remoteMachine,
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

function registerActivityPlugin(
  app: PiWebUiApp,
  visible: (context: ActivityRailContext) => boolean = () => true,
): void {
  pluginRegistry(app).register({
    id: "example",
    plugin: {
      apiVersion: 1,
      name: "Example dashboard",
      activate: () => ({
        contributions: {
          activityRailItems: [{
            id: "dashboard",
            title: "Example dashboard",
            icon: html`<svg aria-hidden="true"></svg>`,
            visible,
            render: () => html`<p>Dashboard</p>`,
          }],
        },
      }),
    },
  });
}

function pluginRegistry(app: PiWebUiApp): PluginRegistry {
  const value: unknown = Reflect.get(app, "plugins");
  if (!(value instanceof PluginRegistry)) throw new Error("PiWebUiApp plugin registry is unavailable");
  return value;
}

function setAppState(app: PiWebUiApp, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebUiApp state");
}

function activityRailItems(app: PiWebUiApp): ActivityRailDisplayItem[] {
  const method: unknown = Reflect.get(app, "activityRailItems");
  if (!isActivityRailItems(method)) throw new Error("PiWebUiApp.activityRailItems is not callable");
  return method.call(app);
}

function createActivityRailContext(app: PiWebUiApp): ActivityRailContext {
  const method: unknown = Reflect.get(app, "createActivityRailContext");
  if (!isCreateActivityRailContext(method)) throw new Error("PiWebUiApp.createActivityRailContext is not callable");
  return method.call(app);
}

function openActivityRailItem(app: PiWebUiApp, id: QualifiedContributionId, restoreFocus: () => void): void {
  const method: unknown = Reflect.get(app, "openActivityRailItem");
  if (!isOpenActivityRailItem(method)) throw new Error("PiWebUiApp.openActivityRailItem is not callable");
  method.call(app, id, restoreFocus);
}

function closeActivityRailItem(app: PiWebUiApp): void {
  const method: unknown = Reflect.get(app, "closeActivityRailItem");
  if (!isCloseActivityRailItem(method)) throw new Error("PiWebUiApp.closeActivityRailItem is not callable");
  method.call(app);
}

function activeActivityId(app: PiWebUiApp): QualifiedContributionId | undefined {
  const value: unknown = Reflect.get(app, "activeActivityRailId");
  if (value === undefined) return undefined;
  if (!isQualifiedContributionId(value)) throw new Error("PiWebUiApp active activity id is invalid");
  return value;
}

function setActiveActivityId(app: PiWebUiApp, id: QualifiedContributionId): void {
  if (!Reflect.set(app, "activeActivityRailId", id)) throw new Error("Could not set PiWebUiApp active activity id");
}

function setCompactRailOpen(app: PiWebUiApp, open: boolean): void {
  if (!Reflect.set(app, "compactRailOpen", open)) throw new Error("Could not set PiWebUiApp compact rail state");
}

function compactRailOpen(app: PiWebUiApp): boolean {
  const value: unknown = Reflect.get(app, "compactRailOpen");
  if (typeof value !== "boolean") throw new Error("PiWebUiApp compact rail state is invalid");
  return value;
}

function reconcileActivityRailVisibility(app: PiWebUiApp): void {
  const updated: unknown = Reflect.get(app, "updated");
  if (!isUpdatedHook(updated)) throw new Error("PiWebUiApp.updated is not callable");
  updated.call(app);
}

function setMobileNavigationLayout(app: PiWebUiApp, mobile: boolean): void {
  setAppShellBoolean(app, "isMobileNavigationLayout", mobile);
}

function setDesktopActivityRailLayout(app: PiWebUiApp, desktop: boolean): void {
  setAppShellBoolean(app, "isDesktopActivityRailLayout", desktop);
}

function setAppShellBoolean(app: PiWebUiApp, key: "isMobileNavigationLayout" | "isDesktopActivityRailLayout", value: boolean): void {
  const appShell: unknown = Reflect.get(app, "appShell");
  if (typeof appShell !== "object" || appShell === null || !Reflect.set(appShell, key, value)) {
    throw new Error(`Could not set PiWebUiApp app-shell ${key}`);
  }
}

function renderContextBar(app: PiWebUiApp): TemplateResult | null {
  const method: unknown = Reflect.get(app, "renderContextBar");
  if (!isRenderContextBar(method)) throw new Error("PiWebUiApp.renderContextBar is not callable");
  const rendered = method.call(app);
  if (rendered !== null && !isTemplateResult(rendered)) throw new Error("PiWebUiApp context bar did not return a template");
  return rendered;
}

function toggleActivityRailFromContextBar(template: TemplateResult): () => void {
  const value = templateValueAfterMarker(template, ".onToggleActivityRail=");
  if (!isVoidCallback(value)) throw new Error("PiWebUiApp context bar toggle callback is unavailable");
  return value;
}

function replaceKeyboardHandler(app: PiWebUiApp) {
  const keyboard: unknown = Reflect.get(app, "keyboard");
  if (typeof keyboard !== "object" || keyboard === null || typeof Reflect.get(keyboard, "handle") !== "function") {
    throw new Error("PiWebUiApp keyboard dispatcher is unavailable");
  }
  const handle = vi.fn(() => false);
  if (!Reflect.set(keyboard, "handle", handle)) throw new Error("Could not replace PiWebUiApp keyboard dispatcher");
  return handle;
}

function dispatchGlobalKeyDown(app: PiWebUiApp): void {
  const handler: unknown = Reflect.get(app, "onKeyDown");
  if (!isGlobalKeyDownHandler(handler)) throw new Error("PiWebUiApp global keydown handler is unavailable");
  handler.call(app, new Event("keydown"));
}

function isChatObscured(app: PiWebUiApp): boolean {
  const method: unknown = Reflect.get(app, "isChatObscured");
  if (!isChatObscuredMethod(method)) throw new Error("PiWebUiApp.isChatObscured is not callable");
  return method.call(app);
}

function isQualifiedContributionId(value: unknown): value is QualifiedContributionId {
  return typeof value === "string" && value.includes(":");
}

function isVoidCallback(value: unknown): value is () => void {
  return typeof value === "function";
}

function isActivityRailItems(value: unknown): value is ActivityRailItems {
  return typeof value === "function";
}

function isCreateActivityRailContext(value: unknown): value is CreateActivityRailContext {
  return typeof value === "function";
}

function isOpenActivityRailItem(value: unknown): value is OpenActivityRailItem {
  return typeof value === "function";
}

function isCloseActivityRailItem(value: unknown): value is CloseActivityRailItem {
  return typeof value === "function";
}

function isUpdatedHook(value: unknown): value is UpdatedHook {
  return typeof value === "function";
}

function isRenderContextBar(value: unknown): value is RenderContextBar {
  return typeof value === "function";
}

function isGlobalKeyDownHandler(value: unknown): value is GlobalKeyDownHandler {
  return typeof value === "function";
}

function isChatObscuredMethod(value: unknown): value is IsChatObscured {
  return typeof value === "function";
}
