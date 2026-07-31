import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../api";
import { initialAppState } from "../appState";
import { isTemplateResult, templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebUiApp } from "./PiWebUiApp";

const workspace: Workspace = {
  id: "workspace-a",
  projectId: "project-a",
  path: "/work/project-a",
  label: "project-a",
  isMain: true,
  isGitRepo: true,
  isGitWorktree: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PiWebUiApp workspace tab visibility", () => {
  it("keeps the hidden Info panel available to the workspace panel content", () => {
    const app = createApp();
    if (!Reflect.set(app, "state", { ...initialAppState(), selectedWorkspace: workspace, workspaceTool: "core:workspace.info", mainView: "core:workspace.info" })) {
      throw new Error("Could not set app state");
    }
    if (!Reflect.set(app, "infoTabHidden", true)) throw new Error("Could not hide Info tab");

    const rendered = renderWorkspacePanel(app);

    expect(templateValueAfterMarker(rendered, ".hiddenTools=")).toEqual(["core:workspace.info"]);
    expect(templateValueAfterMarker(rendered, ".panels=")).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "core:workspace.files" }),
      expect.objectContaining({ id: "core:workspace.info" }),
    ]));
  });

  it("keeps the hidden Terminal panel available when a plugin explicitly opens it", () => {
    const app = createApp();
    if (!Reflect.set(app, "state", { ...initialAppState(), selectedWorkspace: workspace, workspaceTool: "core:workspace.terminal", mainView: "core:workspace.terminal" })) {
      throw new Error("Could not set app state");
    }
    if (!Reflect.set(app, "terminalTabHidden", true)) throw new Error("Could not hide Terminal tab");

    const rendered = renderWorkspacePanel(app);

    expect(templateValueAfterMarker(rendered, ".hiddenTools=")).toEqual(["core:workspace.terminal"]);
    expect(templateValueAfterMarker(rendered, ".panels=")).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "core:workspace.files" }),
      expect.objectContaining({ id: "core:workspace.terminal" }),
    ]));
    expect(mobileMainTabs(app).map((tab) => tab.id)).not.toContain("core:workspace.terminal");
  });
});

function createApp(): PiWebUiApp {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage });
  return new PiWebUiApp();
}

function renderWorkspacePanel(app: PiWebUiApp): TemplateResult {
  const render: unknown = Reflect.get(app, "renderWorkspacePanel");
  if (typeof render !== "function") throw new Error("Workspace panel renderer was unavailable");
  const result: unknown = render.call(app);
  if (!isTemplateResult(result)) throw new Error("Workspace panel renderer did not return a template");
  return result;
}

function mobileMainTabs(app: PiWebUiApp): { id: string }[] {
  const render: unknown = Reflect.get(app, "mobileMainTabs");
  if (typeof render !== "function") throw new Error("Mobile main tab renderer was unavailable");
  const result: unknown = render.call(app);
  if (!Array.isArray(result) || !result.every(isMobileMainTab)) throw new Error("Mobile main tab renderer returned an invalid result");
  return result;
}

function isMobileMainTab(value: unknown): value is { id: string } {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "id") === "string";
}
