import { html } from "lit";
import { describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { renderActivityRailBody, visibleActivityRailItems } from "./activityRail";
import type { ActivityRailContext, QualifiedActivityRailContribution } from "./types";

describe("activity rail contribution evaluation", () => {
  it("isolates callback failures while preserving registry order", () => {
    const context = createActivityRailContext();
    const reportError = vi.fn();
    const hidden: QualifiedActivityRailContribution = {
      id: "example:hidden",
      pluginId: "example",
      localId: "hidden",
      title: "Hidden",
      icon: html`<svg></svg>`,
      order: 10,
      visible: () => {
        throw new Error("visible callback failed");
      },
      render: () => html`<p>Hidden</p>`,
    };
    const badgeFailure: QualifiedActivityRailContribution = {
      id: "example:badge-failure",
      pluginId: "example",
      localId: "badge-failure",
      title: "Zulu",
      icon: html`<svg></svg>`,
      order: 10,
      visible: () => true,
      badge: () => {
        throw new Error("badge callback failed");
      },
      render: () => html`<p>Badge failure</p>`,
    };
    const visible: QualifiedActivityRailContribution = {
      id: "example:visible",
      pluginId: "example",
      localId: "visible",
      title: "Alpha",
      icon: html`<svg></svg>`,
      order: 10,
      badge: () => 3,
      render: () => html`<p>Visible</p>`,
    };
    const renderFailure: QualifiedActivityRailContribution = {
      id: "example:render-failure",
      pluginId: "example",
      localId: "render-failure",
      title: "Render failure",
      icon: html`<svg></svg>`,
      render: () => {
        throw new Error("render callback failed");
      },
    };

    expect(visibleActivityRailItems([hidden, badgeFailure, visible], context, reportError)
      .map((item) => ({ id: item.id, badge: item.badge })))
      .toEqual([
        { id: "example:badge-failure", badge: undefined },
        { id: "example:visible", badge: 3 },
      ]);

    expect(reportError).toHaveBeenCalledWith("badge", "example:badge-failure", expect.any(Error));
    expect(reportError).toHaveBeenCalledWith("visible", "example:hidden", expect.any(Error));
    expect(renderActivityRailBody(renderFailure, context, reportError)).toBeUndefined();
    expect(reportError).toHaveBeenCalledWith("render", "example:render-failure", expect.any(Error));
  });
});

function createActivityRailContext(): ActivityRailContext {
  const noop = () => undefined;
  return {
    state: initialAppState(),
    prompt: {
      insertText: noop,
      getText: () => "",
      getSelection: () => null,
    },
    openActionPalette: noop,
    focusPrompt: noop,
    addProject: noop,
    addMachine: noop,
    refreshSelectedMachine: noop,
    removeSelectedMachine: noop,
    openSelectedMachine: noop,
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
    deleteWorkspace: noop,
    startSession: noop,
    archiveSession: noop,
    reloadSession: noop,
    deleteCachedNewSession: noop,
    stopActiveWork: noop,
    machine: { id: "local", name: "Local", kind: "local" },
    host: { requestRender: noop, close: noop },
  };
}
