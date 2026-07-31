// @vitest-environment jsdom

import { LitElement, html } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import { PluginRegistry } from "../plugins/registry";

vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
const { PiWebUiApp } = await import("./PiWebUiApp");
const { ActivityRail } = await import("./ActivityRail");
const { AppContextBar } = await import("./appShell/AppContextBar");
const { PluginActivityDialog } = await import("./PluginActivityDialog");
type PiWebUiAppElement = InstanceType<typeof PiWebUiApp>;
type ActivityRailElement = InstanceType<typeof ActivityRail>;
type AppContextBarElement = InstanceType<typeof AppContextBar>;
type PluginActivityDialogElement = InstanceType<typeof PluginActivityDialog>;

const dialogPrototype = HTMLDialogElement.prototype;
const originalShowModal = Object.getOwnPropertyDescriptor(dialogPrototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(dialogPrototype, "close");
let mountedApp: PiWebUiAppElement | undefined;

function restoreDialogMethod(name: "showModal" | "close", descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(dialogPrototype, name);
  else Object.defineProperty(dialogPrototype, name, descriptor);
}

function compactMediaQuery(): MediaQueryList {
  return {
    matches: false,
    media: "(min-width: 1181px)",
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
}

beforeEach(() => {
  Object.defineProperty(dialogPrototype, "showModal", {
    configurable: true,
    writable: true,
    value: function (this: HTMLDialogElement): void { this.open = true; },
  });
  Object.defineProperty(dialogPrototype, "close", {
    configurable: true,
    writable: true,
    value: function (this: HTMLDialogElement): void { this.open = false; },
  });
});

afterEach(async () => {
  document.body.replaceChildren();
  await mountedApp?.updateComplete;
  await Promise.resolve();
  mountedApp = undefined;
  restoreDialogMethod("showModal", originalShowModal);
  restoreDialogMethod("close", originalClose);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (typeof window.matchMedia !== "function") Reflect.deleteProperty(window, "matchMedia");
});

describe("PiWebUiApp compact activity focus restoration", () => {
  it("returns focus to the connected compact launcher after a drawer plugin dialog closes", async () => {
    vi.stubGlobal("matchMedia", () => compactMediaQuery());
    const app = new PiWebUiApp();
    registerActivityPlugin(app);
    setAppState(app, initialAppState());
    setCompactActivityRailLayout(app);
    mountWithoutAppSideEffects(app);
    await app.updateComplete;

    const contextBar = appContextBar(app);
    await contextBar.updateComplete;
    const launcher = activityRailLauncher(contextBar);
    launcher.focus();
    expect(contextBar.shadowRoot?.activeElement).toBe(launcher);

    launcher.click();
    await app.updateComplete;
    const rail = activityRail(app);
    await rail.updateComplete;
    const drawerPluginSource = drawerPluginButton(rail);

    drawerPluginSource.click();
    await app.updateComplete;
    await rail.updateComplete;

    expect(drawerPluginSource.isConnected).toBe(false);
    const dialog = pluginActivityDialog(app);
    await dialog.updateComplete;
    const nativeDialog = dialog.shadowRoot?.querySelector<HTMLDialogElement>("dialog.plugin-activity-backdrop");
    const dialogClose = dialog.shadowRoot?.querySelector<HTMLButtonElement>(".plugin-activity-close");
    if (nativeDialog === null || nativeDialog === undefined || dialogClose === null || dialogClose === undefined) {
      throw new Error("Expected the active plugin dialog and its close control");
    }
    expect(nativeDialog.open).toBe(true);
    expect(dialog.shadowRoot?.activeElement).toBe(dialogClose);

    dialogClose.click();
    await app.updateComplete;
    await Promise.resolve();

    expect(launcher.isConnected).toBe(true);
    expect(contextBar.shadowRoot?.activeElement).toBe(launcher);
  });

  it("returns focus to the connected compact launcher when the compact drawer is closed standalone", async () => {
    vi.stubGlobal("matchMedia", () => compactMediaQuery());
    const app = new PiWebUiApp();
    registerActivityPlugin(app);
    setAppState(app, initialAppState());
    setCompactActivityRailLayout(app);
    mountWithoutAppSideEffects(app);
    await app.updateComplete;

    const contextBar = appContextBar(app);
    await contextBar.updateComplete;
    const launcher = activityRailLauncher(contextBar);
    launcher.focus();
    expect(contextBar.shadowRoot?.activeElement).toBe(launcher);

    launcher.click();
    await app.updateComplete;
    const rail = activityRail(app);
    await rail.updateComplete;

    const drawerClose = rail.shadowRoot?.querySelector<HTMLButtonElement>(".compact-rail-close");
    if (drawerClose === null || drawerClose === undefined) throw new Error("Expected compact drawer close button");
    drawerClose.click();
    await app.updateComplete;
    await Promise.resolve();

    expect(launcher.isConnected).toBe(true);
    expect(contextBar.shadowRoot?.activeElement).toBe(launcher);
  });

  it("renders the compact activity rail overlay outside the navigation panel so mobile layout cannot hide it", async () => {
    vi.stubGlobal("matchMedia", () => compactMediaQuery());
    const app = new PiWebUiApp();
    registerActivityPlugin(app);
    setAppState(app, initialAppState());
    setMobileActivityRailLayout(app);
    mountWithoutAppSideEffects(app);
    await app.updateComplete;

    const contextBar = appContextBar(app);
    await contextBar.updateComplete;
    const launcher = activityRailLauncher(contextBar);

    launcher.click();
    await app.updateComplete;

    const rail = activityRail(app);
    await rail.updateComplete;
    const backdrop = rail.shadowRoot?.querySelector<HTMLElement>(".compact-rail-backdrop");
    expect(backdrop).not.toBeNull();
    const navPanel = app.renderRoot.querySelector("#navigation-panel");
    expect(navPanel?.contains(rail)).toBe(false);
  });
});

function mountWithoutAppSideEffects(app: PiWebUiAppElement): void {
  mountedApp = app;
  vi.spyOn(PiWebUiApp.prototype, "connectedCallback").mockImplementation(function (this: PiWebUiAppElement): void {
    LitElement.prototype.connectedCallback.call(this);
  });
  vi.spyOn(PiWebUiApp.prototype, "disconnectedCallback").mockImplementation(function (this: PiWebUiAppElement): void {
    LitElement.prototype.disconnectedCallback.call(this);
  });
  document.body.append(app);
}

function registerActivityPlugin(app: PiWebUiAppElement): void {
  pluginRegistry(app).register({
    id: "focus-example",
    plugin: {
      apiVersion: 1,
      name: "Focus example",
      activate: () => ({
        contributions: {
          activityRailItems: [{
            id: "drawer",
            title: "Drawer activity",
            icon: html`<svg aria-hidden="true"></svg>`,
            render: () => html`<p>Drawer activity body</p>`,
          }],
        },
      }),
    },
  });
}

function pluginRegistry(app: PiWebUiAppElement): PluginRegistry {
  const value: unknown = Reflect.get(app, "plugins");
  if (!(value instanceof PluginRegistry)) throw new Error("PiWebUiApp plugin registry is unavailable");
  return value;
}

function setAppState(app: PiWebUiAppElement, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebUiApp state");
}

function setCompactActivityRailLayout(app: PiWebUiAppElement): void {
  const appShell: unknown = Reflect.get(app, "appShell");
  if (typeof appShell !== "object" || appShell === null
    || !Reflect.set(appShell, "isDesktopActivityRailLayout", false)
    || !Reflect.set(appShell, "isMobileNavigationLayout", false)) {
    throw new Error("Could not configure PiWebUiApp compact activity-rail layout");
  }
}

function setMobileActivityRailLayout(app: PiWebUiAppElement): void {
  const appShell: unknown = Reflect.get(app, "appShell");
  if (typeof appShell !== "object" || appShell === null
    || !Reflect.set(appShell, "isDesktopActivityRailLayout", false)
    || !Reflect.set(appShell, "isMobileNavigationLayout", true)) {
    throw new Error("Could not configure PiWebUiApp mobile activity-rail layout");
  }
}

function appContextBar(app: PiWebUiAppElement): AppContextBarElement {
  const contextBar = app.renderRoot.querySelector("app-context-bar");
  if (!(contextBar instanceof AppContextBar)) throw new Error("Expected the compact app context bar");
  return contextBar;
}

function activityRailLauncher(contextBar: AppContextBarElement): HTMLButtonElement {
  const launcher = contextBar.shadowRoot?.querySelector<HTMLButtonElement>(".activity-rail-action-button");
  if (launcher === null || launcher === undefined) throw new Error("Expected the compact activity-rail launcher");
  return launcher;
}

function activityRail(app: PiWebUiAppElement): ActivityRailElement {
  const rail = app.renderRoot.querySelector("activity-rail");
  if (!(rail instanceof ActivityRail)) throw new Error("Expected the activity rail");
  return rail;
}

function drawerPluginButton(rail: ActivityRailElement): HTMLButtonElement {
  const source = rail.shadowRoot?.querySelector<HTMLButtonElement>(".plugin-rail-button");
  if (source === null || source === undefined) throw new Error("Expected the compact drawer plugin source");
  return source;
}

function pluginActivityDialog(app: PiWebUiAppElement): PluginActivityDialogElement {
  const dialog = app.renderRoot.querySelector("plugin-activity-dialog");
  if (!(dialog instanceof PluginActivityDialog)) throw new Error("Expected the active plugin activity dialog");
  return dialog;
}
