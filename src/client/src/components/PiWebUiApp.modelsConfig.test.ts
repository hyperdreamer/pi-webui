import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
// Template inspection is proportionate here: this test targets the callback
// boundary between the navigation custom element and the application shell.
import { templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebUiApp } from "./PiWebUiApp";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PiWebUiApp navigation actions", () => {
  it("opens the project dialog from the Projects section add control", () => {
    const app = createApp();

    templateCallbackAfterMarker(renderNavigationPanel(app), ".onAddProject=")();

    expect(Reflect.get(app, "state")).toMatchObject({ projectDialogOpen: true });
    expect(isChatObscured(app)).toBe(true);
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

function isRenderNavigationPanel(value: unknown): value is RenderNavigationPanel {
  return typeof value === "function";
}

function isRenderApp(value: unknown): value is RenderApp {
  return typeof value === "function";
}

function isNavigationCallback(value: unknown): value is NavigationCallback {
  return typeof value === "function";
}

function isChatObscuredMethod(value: unknown): value is IsChatObscured {
  return typeof value === "function";
}
