import { html, svg } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { PluginRuntimeContext } from "@hyperdreamer/pi-webui/plugin-api";
import plugin from "./pi-webui-plugin.js";

describe("Updates plugin actions", () => {
  it("forces an update check through the host runtime context", async () => {
    const action = plugin.activate({ apiVersion: 1, pluginId: "updates", html, svg }).contributions.actions?.find((candidate) => candidate.id === "check");
    if (action === undefined) throw new Error("Expected update check action");
    const checkForPiWebUiUpdates = vi.fn(() => Promise.resolve());
    const context = runtimeContext({ checkForPiWebUiUpdates });

    expect(action.enabled?.(context)).toBe(true);
    await action.run(context);

    expect(checkForPiWebUiUpdates).toHaveBeenCalledOnce();
  });

  it("disables the action on older hosts without the update-check helper", () => {
    const action = plugin.activate({ apiVersion: 1, pluginId: "updates", html, svg }).contributions.actions?.find((candidate) => candidate.id === "check");
    if (action === undefined) throw new Error("Expected update check action");
    const context = runtimeContext();

    expect(action.enabled?.(context)).toBe(false);
    expect(action.disabledReason?.(context)).toContain("newer PI WEBUI gateway");
  });
});

function runtimeContext(patch: Partial<PluginRuntimeContext> = {}): PluginRuntimeContext {
  const noop = () => undefined;
  return {
    state: {},
    prompt: { insertText: noop, getText: () => "", getSelection: () => null },
    openActionPalette: noop,
    focusPrompt: noop,
    addProject: noop,
    configureAuth: noop,
    logoutAuth: noop,
    openThemePicker: noop,
    selectMainView: noop,
    selectWorkspaceTool: noop,
    openTerminal: noop,
    refreshFiles: noop,
    refreshGit: noop,
    refreshAppData: noop,
    reloadPage: noop,
    startSession: noop,
    archiveSession: noop,
    stopActiveWork: noop,
    ...patch,
  };
}
