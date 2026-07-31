// @vitest-environment jsdom

import { html } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import type { ReportActivityRailError } from "../plugins/activityRail";
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

const openShadowPluginBodyTag = "native-dialog-open-shadow-plugin-body";

if (customElements.get(openShadowPluginBodyTag) === undefined) {
  customElements.define(openShadowPluginBodyTag, class extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = `<button id="nested-action" type="button">Retry</button>`;
    }
  });
}

const openShadowActivity: QualifiedActivityRailContribution = {
  ...activity,
  render: () => html`<native-dialog-open-shadow-plugin-body></native-dialog-open-shadow-plugin-body>`,
};

const dialogPrototype = HTMLDialogElement.prototype;
const originalShowModal = Object.getOwnPropertyDescriptor(dialogPrototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(dialogPrototype, "close");
const showModal = vi.fn(function (this: HTMLDialogElement): void {
  this.open = true;
});
const close = vi.fn(function (this: HTMLDialogElement): void {
  this.open = false;
});

function restoreDialogMethod(name: "showModal" | "close", descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(dialogPrototype, name);
  else Object.defineProperty(dialogPrototype, name, descriptor);
}

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

interface DialogFixtureOptions {
  contribution?: QualifiedActivityRailContribution;
  onClose?: () => void;
  onReportError?: ReportActivityRailError;
}

async function attachDialog({
  contribution = activity,
  onClose,
  onReportError,
}: DialogFixtureOptions = {}): Promise<PluginActivityDialog> {
  const dialog = new PluginActivityDialog();
  dialog.activity = contribution;
  dialog.context = createActivityRailContext();
  if (onClose !== undefined) dialog.onClose = onClose;
  if (onReportError !== undefined) dialog.onReportError = onReportError;
  document.body.append(dialog);
  await dialog.updateComplete;
  return dialog;
}

function nativeDialog(component: PluginActivityDialog): HTMLDialogElement {
  const dialog = component.shadowRoot?.querySelector<HTMLDialogElement>("dialog.plugin-activity-backdrop");
  if (dialog === null || dialog === undefined) throw new Error("Expected a native plugin activity dialog");
  return dialog;
}

function closeButton(component: PluginActivityDialog): HTMLButtonElement {
  const button = component.shadowRoot?.querySelector<HTMLButtonElement>(".plugin-activity-close");
  if (button === null || button === undefined) throw new Error("Expected a plugin activity close control");
  return button;
}

function frame(component: PluginActivityDialog): HTMLElement {
  const element = component.shadowRoot?.querySelector<HTMLElement>(".plugin-activity-frame");
  if (element === null || element === undefined) throw new Error("Expected a plugin activity frame");
  return element;
}

function openShadowControl(component: PluginActivityDialog): HTMLButtonElement {
  const pluginBody = component.shadowRoot?.querySelector<HTMLElement>(openShadowPluginBodyTag);
  const control = pluginBody?.shadowRoot?.querySelector<HTMLButtonElement>("#nested-action");
  if (control === null || control === undefined) throw new Error("Expected an open-shadow plugin control");
  return control;
}

beforeEach(() => {
  showModal.mockClear();
  close.mockClear();
  Object.defineProperty(dialogPrototype, "showModal", { configurable: true, writable: true, value: showModal });
  Object.defineProperty(dialogPrototype, "close", { configurable: true, writable: true, value: close });
});

afterEach(() => {
  document.body.replaceChildren();
  restoreDialogMethod("showModal", originalShowModal);
  restoreDialogMethod("close", originalClose);
  vi.restoreAllMocks();
});

describe("PluginActivityDialog", () => {
  it("opens a native modal dialog with host-owned chrome after first update", async () => {
    const component = await attachDialog();
    const dialog = nativeDialog(component);

    expect(dialog.localName).toBe("dialog");
    expect(dialog.getAttribute("class")).toBe("plugin-activity-backdrop");
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("Memory");
    expect(dialog.textContent).toContain("Body");
    expect(showModal).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(true);
  });

  it("focuses the host close control after the native dialog opens", async () => {
    const component = await attachDialog();
    const button = closeButton(component);

    expect(component.shadowRoot?.activeElement).toBe(button);
  });

  it("delegates close button, native cancel, and exact dialog-surface clicks to onClose", async () => {
    const onClose = vi.fn();
    const component = await attachDialog({ onClose });
    const dialog = nativeDialog(component);

    closeButton(component).click();
    expect(onClose).toHaveBeenCalledOnce();

    onClose.mockClear();
    const cancel = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();

    onClose.mockClear();
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(onClose).toHaveBeenCalledOnce();

    onClose.mockClear();
    frame(component).dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves composed Tab events from an open-shadow plugin body to native dialog navigation", async () => {
    const component = await attachDialog({ contribution: openShadowActivity });
    const control = openShadowControl(component);

    control.focus();
    const tab = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: "Tab",
    });
    control.dispatchEvent(tab);

    expect(tab.defaultPrevented).toBe(false);
  });

  it("contains plugin render failures behind a usable host close control", async () => {
    const error = new Error("broken body");
    const onClose = vi.fn();
    const onReportError = vi.fn();
    const component = await attachDialog({
      contribution: {
        ...activity,
        render: () => {
          throw error;
        },
      },
      onClose,
      onReportError,
    });
    const fallback = component.shadowRoot?.querySelector(".plugin-activity-render-failure");

    expect(fallback?.textContent).toBe("This plugin activity could not be rendered.");
    expect(onReportError).toHaveBeenCalledWith("render", "memory:memory", error);

    closeButton(component).click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uses the component-edge default reporter for plugin render failures", async () => {
    const error = new Error("broken body");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await attachDialog({
      contribution: {
        ...activity,
        render: () => {
          throw error;
        },
      },
    });

    expect(warn).toHaveBeenCalledWith("Plugin activity rail contribution failed", "render", "memory:memory", error);
  });

  it("cleans up an open native dialog without mapping native close events to app close", async () => {
    const onClose = vi.fn();
    const component = await attachDialog({ onClose });
    const dialog = nativeDialog(component);

    dialog.dispatchEvent(new Event("close"));
    expect(onClose).not.toHaveBeenCalled();

    component.remove();
    expect(close).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });
});
