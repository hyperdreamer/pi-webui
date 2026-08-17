import { html, svg } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { WorkspacePanelContext } from "@hyperdreamer/pi-webui/plugin-api";
import plugin from "./pi-webui-plugin.js";

describe("pi-webui workspace-tasks plugin", () => {
  it("exports a version-one plugin with a workspace Tasks contribution", () => {
    expect(plugin.apiVersion).toBe(1);
    expect(plugin.name).toBe("Workspace Tasks");
    expect(typeof plugin.activate).toBe("function");
  });

  it("passes the internal state and actions bridge into the custom element", () => {
    const state = { workspace: { kind: "loading" }, global: { kind: "loading" } };
    const actions = {
      create: () => Promise.resolve(),
      update: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      move: () => Promise.resolve(),
      retryMove: () => Promise.resolve(),
      refresh: () => Promise.resolve(),
    };
    const context = { apiVersion: 1 as const, pluginId: "workspace-tasks", html, svg };
    const result = plugin.activate(context);
    const panel = result.contributions.workspacePanels?.[0];
    if (panel === undefined) throw new Error("Expected Tasks workspace panel");

    const baseContext: WorkspacePanelContext = {
      machine: { id: "local", kind: "local", name: "Local" },
      workspace: { id: "workspace", projectId: "project", path: "/tmp/workspace", label: "Project", isMain: true, isGitRepo: false, isGitWorktree: false },
      state: {},
      files: {
        readFile: () => Promise.reject(new Error("unused")),
        writeFile: () => Promise.reject(new Error("unused")),
        deleteFile: () => Promise.reject(new Error("unused")),
        moveFile: () => Promise.reject(new Error("unused")),
      },
      prompt: { insertText: vi.fn(), getText: () => "", getSelection: () => null },
      terminal: { open: vi.fn(), runCommand: () => Promise.reject(new Error("unused")) },
      host: { requestRender: vi.fn() },
    };
    const panelContext = Object.assign(baseContext, { workspaceTasks: { state, actions } });
    const template = panel.render(panelContext);

    expect(template.strings.join("")).toContain("workspace-tasks-panel");
    expect(template.values).toContain(state);
    expect(template.values).toContain(actions);
  });
});
