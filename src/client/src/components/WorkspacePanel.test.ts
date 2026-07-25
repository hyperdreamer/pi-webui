import { html } from "lit";
import { describe, expect, it } from "vitest";
import type { Workspace } from "../api";
import type { QualifiedWorkspacePanelContribution } from "../plugins/types";
import { templateText } from "../templateInspection.testSupport";
import { WorkspacePanel } from "./WorkspacePanel";

const workspace: Workspace = {
  id: "workspace-a",
  projectId: "project-a",
  path: "/work/project-a",
  label: "project-a",
  isMain: true,
  isGitRepo: true,
  isGitWorktree: false,
};

function panel(id: "core:workspace.files" | "core:workspace.info", title: string, content: string): QualifiedWorkspacePanelContribution {
  return {
    id,
    pluginId: "core",
    localId: id.slice("core:".length),
    title,
    render: () => html`<span>${content}</span>`,
  };
}

describe("WorkspacePanel", () => {
  it("renders a selected hidden panel without showing its tab", () => {
    const element = new WorkspacePanel();
    element.workspace = workspace;
    if (!Reflect.set(element, "panelContext", {})) throw new Error("Could not supply workspace panel context");
    element.panels = [
      panel("core:workspace.files", "Files", "files-content"),
      panel("core:workspace.info", "System details", "hidden-info-content"),
    ];
    element.tool = "core:workspace.info";
    Reflect.set(element, "hiddenTools", ["core:workspace.info"]);

    const text = templateText(element.render());

    expect(text).toContain("hidden-info-content");
    expect(text).toContain("Files");
    expect(text).not.toContain("System details");
  });
});
