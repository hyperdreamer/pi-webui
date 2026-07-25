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

describe("PiWebUiApp info tab visibility", () => {
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
