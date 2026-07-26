import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_WEBUI_CAPABILITIES } from "../../../shared/capabilities";
import type { Project } from "../api";
import { initialAppState, type AppState } from "../appState";
// Template inspection is proportionate here: these tests target custom-element
// callback boundaries between the navigation, overlays, and application shell.
import { isTemplateResult, templateStrings, templateValueAfterMarker, templateValues } from "../templateInspection.testSupport";
import { PiWebUiApp } from "./PiWebUiApp";

afterEach(() => {
  vi.unstubAllGlobals();
});

const project: Project = {
  id: "project-a",
  name: "Project A",
  path: "/work/project-a",
  createdAt: "2026-07-26T00:00:00.000Z",
};

describe("PiWebUiApp navigation actions", () => {
  it("opens the project dialog from the Projects section add control", () => {
    const app = createApp();

    templateCallbackAfterMarker(renderNavigationPanel(app), ".onAddProject=")();

    expect(Reflect.get(app, "state")).toMatchObject({ projectDialogOpen: true });
    expect(isChatObscured(app)).toBe(true);
  });

  it("opens the expanded project browser and marks chat as obscured", () => {
    const app = createApp();
    const restoreFocus = vi.fn();
    const open = projectBrowserOpenCallback(templateValueAfterMarker(
      renderNavigationPanel(app),
      ".onOpenProjectBrowser=",
    ));

    open(restoreFocus);

    expect(Reflect.get(app, "projectBrowserOpen")).toBe(true);
    expect(isChatObscured(app)).toBe(true);
    expect(templateStrings(projectBrowserDialogTemplate(app)).join("")).toContain("<project-browser-dialog");
  });

  it("restores launcher focus when the expanded project browser is dismissed", async () => {
    const app = createApp();
    const restoreFocus = vi.fn();
    const open = projectBrowserOpenCallback(templateValueAfterMarker(
      renderNavigationPanel(app),
      ".onOpenProjectBrowser=",
    ));
    open(restoreFocus);
    // Detached Lit elements do not settle updateComplete in this Node runner;
    // model the post-render promise to verify the focus-restoration boundary.
    Object.defineProperty(app, "updateComplete", { configurable: true, value: Promise.resolve(true) });

    templateCallbackAfterMarker(projectBrowserDialogTemplate(app), ".onClose=")();
    await app.updateComplete;

    expect(Reflect.get(app, "projectBrowserOpen")).toBe(false);
    expect(restoreFocus).toHaveBeenCalledOnce();
  });

  it("closes the expanded project browser and opens the project dialog from Add", () => {
    const app = createApp();
    const open = projectBrowserOpenCallback(templateValueAfterMarker(
      renderNavigationPanel(app),
      ".onOpenProjectBrowser=",
    ));
    open(vi.fn());

    templateCallbackAfterMarker(projectBrowserDialogTemplate(app), ".onAdd=")();

    expect(Reflect.get(app, "projectBrowserOpen")).toBe(false);
    expect(Reflect.get(app, "state")).toMatchObject({ projectDialogOpen: true });
  });

  it("closes the expanded project browser before selecting a project through navigation", () => {
    const app = createApp();
    Reflect.set(app, "projectBrowserOpen", true);
    const selectNavigationItem = vi.fn(() => {
      expect(Reflect.get(app, "projectBrowserOpen")).toBe(false);
      return Promise.resolve();
    });
    if (!Reflect.set(app, "selectNavigationItem", selectNavigationItem)) throw new Error("Could not replace PiWebUiApp.selectNavigationItem");

    selectProjectFromBrowser(app, project);

    expect(selectNavigationItem).toHaveBeenCalledOnce();
  });

  it("opens models configuration from the navigation underbar for the selected machine", () => {
    const app = createApp();
    setAppState(app, {
      ...initialAppState(),
      selectedMachine: {
        id: "remote-a",
        name: "Remote build host",
        kind: "remote",
        baseUrl: "https://remote.example.test/",
        createdAt: "2026-06-04T00:00:00.000Z",
        updatedAt: "2026-06-04T00:00:00.000Z",
      },
    });

    const openModels = templateCallbackAfterMarker(renderNavigationPanel(app), ".onOpenModels=");
    openModels();

    expect(Reflect.get(app, "modelsConfigDialogOpen")).toBe(true);
  });

  it("opens Full history for the selected persisted session inside the application", () => {
    const app = createApp();
    setAppState(app, {
      ...initialAppState(),
      selectedMachine: {
        id: "remote-a",
        name: "Remote build host",
        kind: "remote",
        baseUrl: "https://remote.example.test/",
        createdAt: "2026-06-04T00:00:00.000Z",
        updatedAt: "2026-06-04T00:00:00.000Z",
      },
      selectedSession: {
        id: "session-a",
        cwd: "/work/project-a",
        path: "/sessions/session-a.jsonl",
        persisted: true,
        created: "2026-06-04T00:00:00.000Z",
        modified: "2026-06-04T00:00:00.000Z",
        messageCount: 1,
        firstMessage: "Show the complete conversation",
      },
    });

    const rendered = renderApp(app);
    expect(templateStrings(rendered).join("")).toMatch(/<activity-rail[\s\S]*?\.onOpenHistory=/);
    expect(templateValueAfterMarker(rendered, ".historyEnabled=")).toBe(true);
    templateCallbackAfterMarker(rendered, ".onOpenHistory=")();

    expect(Reflect.get(app, "historyWindow")).toMatchObject({
      machineId: "remote-a",
      session: { id: "session-a", cwd: "/work/project-a" },
    });
    expect(isChatObscured(app)).toBe(true);
    expect(templateValueAfterMarker(renderApp(app), "<session-history-window")).toBe("remote-a");
  });

  it("opens Skills configuration for the selected workspace and obscures chat", () => {
    const app = createApp();
    setAppState(app, {
      ...initialAppState(),
      selectedWorkspace: {
        id: "workspace-a",
        projectId: "project-a",
        path: "/work/project-a",
        label: "main",
        isMain: true,
        isGitRepo: true,
        isGitWorktree: false,
      },
    });

    const navigation = renderNavigationPanel(app);
    const openSkills = templateCallbackAfterMarker(navigation, ".onOpenSkills=");

    expect(templateValueAfterMarker(navigation, ".skillsEnabled=")).toBe(true);
    openSkills();

    expect(Reflect.get(app, "skillsConfigDialogOpen")).toBe(true);
    expect(isChatObscured(app)).toBe(true);
    // This property boundary proves the active workspace is handed to the dialog.
    expect(templateValueAfterMarker(renderApp(app), ".cwd=")).toBe("/work/project-a");
  });

  it("opens the selected session's System prompt from the left activity rail", () => {
    const app = createApp();
    setAppState(app, {
      ...initialAppState(),
      selectedMachine: {
        id: "remote-a",
        name: "Remote build host",
        kind: "remote",
        baseUrl: "https://remote.example.test/",
        createdAt: "2026-06-04T00:00:00.000Z",
        updatedAt: "2026-06-04T00:00:00.000Z",
      },
      machineRuntimes: {
        "remote-a": { machineId: "remote-a", ok: true, checkedAt: "2026-06-04T00:00:00.000Z", capabilities: [PI_WEBUI_CAPABILITIES.sessionsSystemPrompt] },
      },
      selectedSession: {
        id: "session-a",
        cwd: "/work/project-a",
        path: "/sessions/session-a.jsonl",
        created: "2026-06-04T00:00:00.000Z",
        modified: "2026-06-04T00:00:00.000Z",
        messageCount: 1,
        firstMessage: "Show the system prompt",
      },
    });

    const rendered = renderApp(app);
    expect(templateStrings(rendered).join("")).toMatch(/<activity-rail[\s\S]*?\.onOpenSystemPrompt=/);
    const openSystemPrompt = templateCallbackAfterMarker(rendered, ".onOpenSystemPrompt=");

    expect(templateValueAfterMarker(rendered, ".systemPromptEnabled=")).toBe(true);
    openSystemPrompt();

    expect(Reflect.get(app, "systemPromptDialogOpen")).toBe(true);
    expect(isChatObscured(app)).toBe(true);
  });

  it("disables the left-rail System prompt control when the selected machine does not support it", () => {
    const app = createApp();
    setAppState(app, {
      ...initialAppState(),
      selectedSession: {
        id: "session-a",
        cwd: "/work/project-a",
        path: "/sessions/session-a.jsonl",
        created: "2026-06-04T00:00:00.000Z",
        modified: "2026-06-04T00:00:00.000Z",
        messageCount: 1,
        firstMessage: "Show the system prompt",
      },
    });

    expect(templateValueAfterMarker(renderApp(app), ".systemPromptEnabled=")).toBe(false);
  });

  it("opens Plugins configuration for the selected workspace, session, and machine", () => {
    const app = createApp();
    setAppState(app, {
      ...initialAppState(),
      selectedMachine: {
        id: "remote-a",
        name: "Remote build host",
        kind: "remote",
        baseUrl: "https://remote.example.test/",
        createdAt: "2026-06-04T00:00:00.000Z",
        updatedAt: "2026-06-04T00:00:00.000Z",
      },
      selectedWorkspace: {
        id: "workspace-a",
        projectId: "project-a",
        path: "/work/project-a",
        label: "main",
        isMain: true,
        isGitRepo: true,
        isGitWorktree: false,
      },
      selectedSession: {
        id: "session-a",
        cwd: "/work/project-a",
        path: "/sessions/session-a.jsonl",
        created: "2026-06-04T00:00:00.000Z",
        modified: "2026-06-04T00:00:00.000Z",
        messageCount: 1,
        firstMessage: "Configure plugins",
      },
    });

    const navigation = renderNavigationPanel(app);
    const openPlugins = templateCallbackAfterMarker(navigation, ".onOpenPlugins=");

    expect(templateValueAfterMarker(navigation, ".pluginsEnabled=")).toBe(true);
    openPlugins();

    expect(Reflect.get(app, "pluginsConfigDialogOpen")).toBe(true);
    expect(isChatObscured(app)).toBe(true);
    const rendered = renderApp(app);
    expect(templateValueAfterMarker(rendered, ".cwd=")).toBe("/work/project-a");
    expect(templateValueAfterMarker(rendered, ".session=")).toMatchObject({ id: "session-a", cwd: "/work/project-a" });
  });
});

type RenderNavigationPanel = (this: PiWebUiApp) => TemplateResult;
type RenderApp = (this: PiWebUiApp) => TemplateResult;
type IsChatObscured = (this: PiWebUiApp) => boolean;
type NavigationCallback = () => void;
type ProjectBrowserOpenCallback = (restoreFocus: () => void) => void;
type ProjectBrowserSelection = (this: PiWebUiApp, project: Project) => void;

function createApp(): PiWebUiApp {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage, innerWidth: 1280 });
  const app = new PiWebUiApp();
  if (!Reflect.set(app, "getBoundingClientRect", () => ({ width: 1280 }))) throw new Error("Could not stub PiWebUiApp bounds");
  return app;
}

function setAppState(app: PiWebUiApp, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebUiApp state");
}

function renderNavigationPanel(app: PiWebUiApp): TemplateResult {
  const method: unknown = Reflect.get(app, "renderNavigationPanel");
  if (!isRenderNavigationPanel(method)) throw new Error("PiWebUiApp.renderNavigationPanel is not callable");
  return method.call(app);
}

function renderApp(app: PiWebUiApp): TemplateResult {
  const method: unknown = Reflect.get(app, "render");
  if (!isRenderApp(method)) throw new Error("PiWebUiApp.render is not callable");
  return method.call(app);
}

function projectBrowserDialogTemplate(app: PiWebUiApp): TemplateResult {
  const template = findTemplateContaining(renderApp(app), "<project-browser-dialog");
  if (template === undefined) throw new Error("PiWebUiApp did not render project-browser-dialog");
  return template;
}

function findTemplateContaining(value: unknown, marker: string): TemplateResult | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const template = findTemplateContaining(item, marker);
      if (template !== undefined) return template;
    }
    return undefined;
  }
  if (!isTemplateResult(value)) return undefined;
  if (templateStrings(value).some((part) => part.includes(marker))) return value;
  for (const child of templateValues(value)) {
    const template = findTemplateContaining(child, marker);
    if (template !== undefined) return template;
  }
  return undefined;
}

function templateCallbackAfterMarker(template: TemplateResult, marker: string): NavigationCallback {
  const value = templateValueAfterMarker(template, marker);
  if (!isNavigationCallback(value)) throw new Error(`Expected callback after ${marker}`);
  return value;
}

function isChatObscured(app: PiWebUiApp): boolean {
  const method: unknown = Reflect.get(app, "isChatObscured");
  if (!isChatObscuredMethod(method)) throw new Error("PiWebUiApp.isChatObscured is not callable");
  return method.call(app);
}

function selectProjectFromBrowser(app: PiWebUiApp, projectToSelect: Project): void {
  const method: unknown = Reflect.get(app, "selectProjectFromBrowser");
  if (!isProjectBrowserSelection(method)) throw new Error("PiWebUiApp.selectProjectFromBrowser is not callable");
  method.call(app, projectToSelect);
}

function isRenderNavigationPanel(value: unknown): value is RenderNavigationPanel {
  return typeof value === "function";
}

function isRenderApp(value: unknown): value is RenderApp {
  return typeof value === "function";
}

function isNavigationCallback(value: unknown): value is NavigationCallback {
  return typeof value === "function";
}

function projectBrowserOpenCallback(value: unknown): ProjectBrowserOpenCallback {
  if (!isProjectBrowserOpenCallback(value)) throw new Error("Expected expanded project browser callback");
  return value;
}

function isProjectBrowserOpenCallback(value: unknown): value is ProjectBrowserOpenCallback {
  return typeof value === "function";
}

function isProjectBrowserSelection(value: unknown): value is ProjectBrowserSelection {
  return typeof value === "function";
}

function isChatObscuredMethod(value: unknown): value is IsChatObscured {
  return typeof value === "function";
}
