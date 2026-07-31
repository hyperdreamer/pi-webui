import { html } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { templateEventHandlerAfterValue, templateText } from "../templateInspection.testSupport";
import type { ActivityRailContext, QualifiedActivityRailContribution } from "../plugins/types";
import { PluginActivityDialog } from "./PluginActivityDialog";

const activity: QualifiedActivityRailContribution = {
  id: "memory:memory",
  pluginId: "memory",
  localId: "memory",
  title: "Memory",
  icon: html`<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3a7 7 0 0 0-7 7v4a4 4 0 0 0 4 4h6a4 4 0 0 0 4-4v-4a7 7 0 0 0-7-7Z"></path></svg>`,
  render: () => html`<p>Body</p>`,
};

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

function createDialog(contribution = activity): PluginActivityDialog {
  const dialog = new PluginActivityDialog();
  dialog.activity = contribution;
  dialog.context = createActivityRailContext();
  return dialog;
}

function clickEvent(target: EventTarget, currentTarget: EventTarget): Event {
  const event = new Event("click");
  Object.defineProperties(event, {
    target: { value: target },
    currentTarget: { value: currentTarget },
  });
  return event;
}

function keydownEvent(key: string): Event {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  return event;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PluginActivityDialog", () => {
  it("renders host-owned dialog chrome for an activity", () => {
    const markup = templateText(createDialog().render());

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-label="Memory"');
    expect(markup).toContain('aria-label="Close Memory"');
    expect(markup).toContain("Body");
  });

  it("delegates the close button, Escape key, and exact backdrop click", () => {
    const onClose = vi.fn();
    const dialog = createDialog();
    dialog.onClose = onClose;
    const rendered = dialog.render();

    // Node component tests inspect the stable accessible labels to exercise Lit event wiring.
    templateEventHandlerAfterValue(rendered, "Close Memory", "@click")(new Event("click"));
    expect(onClose).toHaveBeenCalledOnce();

    onClose.mockClear();
    const escape = keydownEvent("Escape");
    templateEventHandlerAfterValue(rendered, "Memory", "@keydown")(escape);
    expect(onClose).toHaveBeenCalledOnce();
    expect(escape.defaultPrevented).toBe(true);

    onClose.mockClear();
    const backdrop = new EventTarget();
    templateEventHandlerAfterValue(rendered, "Memory", "@click")(clickEvent(backdrop, backdrop));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not close when a click bubbles from inside the dialog", () => {
    const onClose = vi.fn();
    const dialog = createDialog();
    dialog.onClose = onClose;
    const backdrop = new EventTarget();

    templateEventHandlerAfterValue(dialog.render(), "Memory", "@click")(clickEvent(new EventTarget(), backdrop));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("contains a failed plugin body render without removing the close control", () => {
    const error = new Error("broken body");
    const renderFailure: QualifiedActivityRailContribution = {
      ...activity,
      render: () => {
        throw error;
      },
    };
    const onReportError = vi.fn();
    const dialog = createDialog(renderFailure);
    dialog.onReportError = onReportError;

    const markup = templateText(dialog.render());

    expect(markup).toContain("This plugin activity could not be rendered.");
    expect(markup).toContain('aria-label="Close Memory"');
    expect(onReportError).toHaveBeenCalledWith("render", "memory:memory", error);
  });

  it("reports an unhandled plugin render failure through the component-edge default reporter", () => {
    const error = new Error("broken body");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dialog = createDialog({
      ...activity,
      render: () => {
        throw error;
      },
    });

    dialog.render();

    expect(warn).toHaveBeenCalledWith("Plugin activity rail contribution failed", "render", "memory:memory", error);
  });
});
