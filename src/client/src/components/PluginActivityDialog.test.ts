// @vitest-environment jsdom

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

const focusOrderActivity: QualifiedActivityRailContribution = {
  ...activity,
  render: () => html`
    <form aria-label="Memory controls">
      <button id="priority-three" type="button" tabindex="3">Review saved memories</button>
      <button id="priority-one" type="button" tabindex="1">Save memory</button>
      <button id="cancel-memory" type="button">Cancel</button>
      <button id="reset-memory" type="button" tabindex="-1">Reset memory</button>
    </form>
  `,
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

async function attachDialog(contribution = activity): Promise<PluginActivityDialog> {
  const dialog = createDialog(contribution);
  document.body.append(dialog);
  await dialog.updateComplete;
  return dialog;
}

function dialogButton(dialog: PluginActivityDialog, selector: string): HTMLButtonElement {
  const button = dialog.shadowRoot?.querySelector<HTMLButtonElement>(selector);
  if (button === null || button === undefined) throw new Error(`Expected dialog button ${selector}`);
  return button;
}

function dispatchTabKeydown(element: HTMLElement, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab", shiftKey });
  element.dispatchEvent(event);
  return event;
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
  document.body.replaceChildren();
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

  it("focuses the close button after its first DOM update", async () => {
    const dialog = await attachDialog(focusOrderActivity);
    const closeButton = dialogButton(dialog, ".plugin-activity-close");

    expect(dialog.shadowRoot?.activeElement).toBe(closeButton);
  });

  it("wraps Tab from the actual last sequential stop past a tabindex=-1 control", async () => {
    const dialog = await attachDialog(focusOrderActivity);
    const firstTabStop = dialogButton(dialog, "#priority-one");
    const lastTabStop = dialogButton(dialog, "#cancel-memory");
    const excludedControl = dialogButton(dialog, "#reset-memory");

    expect(excludedControl.tabIndex).toBe(-1);
    lastTabStop.focus();
    const tab = dispatchTabKeydown(lastTabStop);

    expect(tab.defaultPrevented).toBe(true);
    expect(dialog.shadowRoot?.activeElement).toBe(firstTabStop);
  });

  it("does not treat a programmatically focused tabindex=-1 control as the first stop", async () => {
    const dialog = await attachDialog(focusOrderActivity);
    const excludedControl = dialogButton(dialog, "#reset-memory");

    excludedControl.focus();
    const shiftTab = dispatchTabKeydown(excludedControl, true);

    expect(shiftTab.defaultPrevented).toBe(false);
    expect(dialog.shadowRoot?.activeElement).toBe(excludedControl);
  });

  it("wraps Shift+Tab from the actual first positive-tabindex stop to the last", async () => {
    const dialog = await attachDialog(focusOrderActivity);
    const firstTabStop = dialogButton(dialog, "#priority-one");
    const lastTabStop = dialogButton(dialog, "#cancel-memory");

    firstTabStop.focus();
    const shiftTab = dispatchTabKeydown(firstTabStop, true);

    expect(shiftTab.defaultPrevented).toBe(true);
    expect(dialog.shadowRoot?.activeElement).toBe(lastTabStop);
  });
});
