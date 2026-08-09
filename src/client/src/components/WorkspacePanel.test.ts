import { html } from "lit";
import { describe, expect, it } from "vitest";
import type { QualifiedContributionId } from "../plugins/types";
import { templateText } from "../templateInspection.testSupport";
import { WorkspacePanel, type ResolvedWorkspacePanelTab } from "./WorkspacePanel";

function tab(id: QualifiedContributionId, title: string, content: string, badge?: string | number): ResolvedWorkspacePanelTab {
  return {
    id,
    title,
    ...(badge === undefined ? {} : { badge }),
    render: () => html`<span>${content}</span>`,
  };
}

describe("WorkspacePanel", () => {
  it("renders a selected hidden panel without showing its tab", () => {
    const element = new WorkspacePanel();
    element.tabs = [
      tab("core:workspace.files", "Files", "files-content"),
      tab("core:workspace.info", "System details", "hidden-info-content"),
    ];
    element.tool = "core:workspace.info";
    element.hiddenTools = ["core:workspace.info"];

    const text = templateText(element.render());

    expect(text).toContain("hidden-info-content");
    expect(text).toContain("Files");
    expect(text).not.toContain("System details");
  });

  it("renders a selected hidden Terminal panel without showing its tab", () => {
    const element = new WorkspacePanel();
    element.tabs = [
      tab("core:workspace.files", "Files", "files-content"),
      tab("core:workspace.terminal", "Terminal", "hidden-terminal-content"),
    ];
    element.tool = "core:workspace.terminal";
    element.hiddenTools = ["core:workspace.terminal"];

    const text = templateText(element.render());

    expect(text).toContain("hidden-terminal-content");
    expect(text).toContain("Files");
    expect(text).not.toContain("Terminal");
  });

  it("renders a tab-badge and accessible numeric label when badge is a positive count", () => {
    const element = new WorkspacePanel();
    element.tabs = [tab("plugin:memory", "Memory", "content", 3)];
    element.tool = "plugin:memory";

    const text = templateText(element.render());

    expect(text).toContain("tab-badge");
    expect(text).toContain("3");
    expect(text).toContain("Memory, 3");
  });

  it("renders no tab-badge when badge is undefined (empty data)", () => {
    const element = new WorkspacePanel();
    element.tabs = [tab("plugin:memory", "Memory", "content")];
    element.tool = "plugin:memory";

    const text = templateText(element.render());

    expect(text).not.toContain("tab-badge");
    expect(text).toContain("Memory");
  });
});
