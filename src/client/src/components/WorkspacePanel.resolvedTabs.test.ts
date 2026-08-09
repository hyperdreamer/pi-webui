// @vitest-environment jsdom

import { html } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { QualifiedContributionId } from "../plugins/types";
import { WorkspacePanel, type ResolvedWorkspacePanelTab } from "./WorkspacePanel";

function tab(id: QualifiedContributionId, title: string, render = () => html`<p>${title} body</p>`): ResolvedWorkspacePanelTab {
  return { id, title, render };
}

async function mount(overrides: Partial<WorkspacePanel>): Promise<{ panel: WorkspacePanel; teardown: () => void }> {
  await import("./WorkspacePanel");
  const panel = new WorkspacePanel();
  Object.assign(panel, overrides);
  document.body.append(panel);
  await panel.updateComplete;
  return { panel, teardown: () => { panel.remove(); } };
}

function tabButtons(panel: WorkspacePanel): HTMLButtonElement[] {
  return [...panel.renderRoot.querySelectorAll<HTMLButtonElement>(".tabs button")];
}

describe("workspace-panel resolved tabs", () => {
  it("renders a machine-level tab with no workspace and no panel context", async () => {
    const { panel, teardown } = await mount({
      tabs: [tab("core:recent-projects", "Recent Projects")],
      tool: "core:recent-projects",
    });

    expect(tabButtons(panel).map((button) => button.textContent.trim())).toEqual(["Recent Projects"]);
    expect(panel.renderRoot.textContent).toContain("Recent Projects body");

    teardown();
  });

  it("falls back to the first available tab when the remembered tool is absent", async () => {
    const { panel, teardown } = await mount({
      tabs: [tab("core:recent-projects", "Recent Projects")],
      tool: "core:workspace.files",
    });

    expect(panel.renderRoot.textContent).toContain("Recent Projects body");

    teardown();
  });

  it("omits a hidden tab from the header while keeping the visible ones", async () => {
    const { panel, teardown } = await mount({
      tabs: [tab("core:recent-projects", "Recent Projects"), tab("core:workspace.info", "Info")],
      hiddenTools: ["core:workspace.info"],
      tool: "core:recent-projects",
    });

    expect(tabButtons(panel).map((button) => button.textContent.trim())).toEqual(["Recent Projects"]);
    expect(panel.renderRoot.textContent).toContain("Recent Projects body");
    expect(panel.renderRoot.textContent).not.toContain("Info body");

    teardown();
  });

  it("reports selection through onSelectTool and renders the empty state with no tabs", async () => {
    const onSelectTool = vi.fn();
    const selected = await mount({
      tabs: [tab("core:recent-projects", "Recent Projects"), tab("core:workspace.files", "Files")],
      tool: "core:recent-projects",
      onSelectTool,
    });

    tabButtons(selected.panel)[1]?.click();
    expect(onSelectTool).toHaveBeenCalledWith("core:workspace.files");
    selected.teardown();

    const empty = await mount({ tabs: [], emptyState: { title: "Select a workspace" } });
    expect(empty.panel.renderRoot.textContent).toContain("Select a workspace");
    empty.teardown();
  });
});
