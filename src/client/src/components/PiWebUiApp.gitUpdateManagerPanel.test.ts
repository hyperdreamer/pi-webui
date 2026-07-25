import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
// Template inspection is proportionate here because this test covers the
// callback boundary between the Activity Rail and application shell.
import { templateStrings, templateText, templateValueAfterMarker } from "../templateInspection.testSupport";
import { initialAppState } from "../appState";
import { PiWebUiApp } from "./PiWebUiApp";

type RenderApp = (this: PiWebUiApp) => TemplateResult;
type VoidCallback = () => void;
type IsChatObscured = (this: PiWebUiApp) => boolean;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PiWebUiApp Git Update Manager panel", () => {
  it("opens and closes Git Update Manager from the Activity Rail", () => {
    const app = createApp();
    Reflect.set(app, "state", { ...initialAppState(), selectedWorkspace: workspace() });
    const initial = renderApp(app);

    expect(templateStrings(initial).join("")).toMatch(/<activity-rail[\s\S]*?\.onOpenGitUpdateManager=/);
    callbackAfterMarker(initial, ".onOpenGitUpdateManager=")();

    expect(Reflect.get(app, "gitUpdateManagerPanelOpen")).toBe(true);
    expect(isChatObscured(app)).toBe(true);

    const open = renderApp(app);
    expect(templateText(open)).toContain("<git-update-manager-panel");
    callbackAfterMarker(open, ".onClose=")();

    expect(Reflect.get(app, "gitUpdateManagerPanelOpen")).toBe(false);
    expect(isChatObscured(app)).toBe(false);
  });

  it("passes the distinct changed-file count to the Activity Rail", () => {
    const app = createApp();
    Reflect.set(app, "state", {
      ...initialAppState(),
      selectedWorkspace: workspace(),
      gitStatus: {
        isGitRepo: true,
        hash: "git-status",
        files: [
          { path: "src/both.ts", index: "modified", workingTree: "modified" },
          { path: "new.md", index: "untracked", workingTree: "untracked" },
        ],
      },
    });

    expect(templateValueAfterMarker(renderApp(app), ".gitUpdateManagerCount=")).toBe(2);
  });
});

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

function workspace() {
  return { id: "workspace-1", projectId: "project-1", path: "/repo", label: "repo", isMain: true, isGitRepo: true, isGitWorktree: false };
}

function renderApp(app: PiWebUiApp): TemplateResult {
  const render: unknown = Reflect.get(app, "render");
  if (!isRenderApp(render)) throw new Error("PiWebUiApp.render is not callable");
  return render.call(app);
}

function callbackAfterMarker(template: TemplateResult, marker: string): VoidCallback {
  const value: unknown = templateValueAfterMarker(template, marker);
  if (!isVoidCallback(value)) throw new Error(`Expected callback after ${marker}`);
  return value;
}

function isChatObscured(app: PiWebUiApp): boolean {
  const method: unknown = Reflect.get(app, "isChatObscured");
  if (!isChatObscuredMethod(method)) throw new Error("PiWebUiApp.isChatObscured is not callable");
  return method.call(app);
}

function isRenderApp(value: unknown): value is RenderApp {
  return typeof value === "function";
}

function isVoidCallback(value: unknown): value is VoidCallback {
  return typeof value === "function";
}

function isChatObscuredMethod(value: unknown): value is IsChatObscured {
  return typeof value === "function";
}
