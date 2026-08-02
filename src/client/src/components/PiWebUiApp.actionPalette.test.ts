// @vitest-environment jsdom

import { LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import type { AppAction } from "../actions";

vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => inactiveMediaQuery(query));
  vi.stubGlobal("requestAnimationFrame", () => 0);
});
const { PiWebUiApp } = await import("./PiWebUiApp");
const { ActionPalette } = await import("./ActionPalette");
type PiWebUiAppElement = InstanceType<typeof PiWebUiApp>;
type GlobalKeyDownHandler = (this: PiWebUiAppElement, event: Event) => void;
let mountedApp: PiWebUiAppElement | undefined;

afterEach(async () => {
  document.body.replaceChildren();
  await mountedApp?.updateComplete;
  await Promise.resolve();
  mountedApp = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (typeof window.matchMedia !== "function") Reflect.deleteProperty(window, "matchMedia");
  // Opening the settings dialog pushes ?settings=... onto the shared jsdom URL, and
  // PiWebUiApp seeds `settingsSection` from that query on construction. Without this
  // reset the next app in this file starts with settings open, which silently changes
  // what the global-shortcut guard does.
  window.history.replaceState({}, "", "/");
});

describe("PiWebUiApp action palette persistence", () => {
  it("keeps the palette open after running an action that does not opt out", async () => {
    const { app, ran } = await openPaletteWith([
      { id: "test.persistent", title: "Refresh Files", run: () => { ran.push("test.persistent"); } },
    ]);

    clickPaletteRow(app, "Refresh Files");
    await app.updateComplete;

    expect(ran).toEqual(["test.persistent"]);
    expect(paletteOpen(app)).toBe(true);
    expect(actionPalette(app)).not.toBeNull();
  });

  it("closes the palette after running an action that opts in", async () => {
    const { app, ran } = await openPaletteWith([
      { id: "test.closing", title: "Focus Prompt", closesActionPalette: true, run: () => { ran.push("test.closing"); } },
    ]);

    clickPaletteRow(app, "Focus Prompt");
    await app.updateComplete;

    expect(ran).toEqual(["test.closing"]);
    expect(paletteOpen(app)).toBe(false);
  });

  it("flips a layout toggle title in place and preserves the search query", async () => {
    const app = new PiWebUiApp();
    setAppState(app, { ...initialAppState(), actionPaletteOpen: true });
    mountWithoutAppSideEffects(app);
    await app.updateComplete;

    const palette = actionPalette(app);
    if (palette === null) throw new Error("Expected the action palette to be rendered");
    const input = palette.shadowRoot?.querySelector<HTMLInputElement>("input");
    if (input === null || input === undefined) throw new Error("Expected the palette search input");
    input.value = "terminal tab";
    input.dispatchEvent(new Event("input"));
    await palette.updateComplete;

    clickPaletteRow(app, "Hide Terminal Tab");
    await Promise.resolve();
    await app.updateComplete;
    await palette.updateComplete;

    expect(paletteOpen(app)).toBe(true);
    expect(palette.shadowRoot?.querySelector("input")?.value).toBe("terminal tab");
    const titles = [...(palette.shadowRoot?.querySelectorAll(".options button strong") ?? [])].map((node) => node.textContent);
    expect(titles).toContain("Show Terminal Tab");
    expect(titles).not.toContain("Hide Terminal Tab");
  });

  it("leaves no palette mounted when a dialog action opens its dialog", async () => {
    const app = new PiWebUiApp();
    setAppState(app, { ...initialAppState(), actionPaletteOpen: true });
    mountWithoutAppSideEffects(app);
    await app.updateComplete;

    clickPaletteRow(app, "Open Settings");
    await Promise.resolve();
    await app.updateComplete;

    expect(paletteOpen(app)).toBe(false);
    expect(actionPalette(app)).toBeNull();
    expect(app.renderRoot.querySelector("settings-dialog")).not.toBeNull();
  });

  it("keeps global shortcuts out of an open palette", async () => {
    const app = new PiWebUiApp();
    setAppState(app, { ...initialAppState(), actionPaletteOpen: true });
    mountWithoutAppSideEffects(app);
    await app.updateComplete;
    const handleShortcut = replaceKeyboardHandler(app);

    dispatchGlobalKeyDown(app);

    expect(handleShortcut).not.toHaveBeenCalled();
    expect(paletteOpen(app)).toBe(true);
  });

  it("resumes global shortcuts once the palette closes", async () => {
    const app = new PiWebUiApp();
    setAppState(app, { ...initialAppState(), actionPaletteOpen: false });
    mountWithoutAppSideEffects(app);
    await app.updateComplete;
    const handleShortcut = replaceKeyboardHandler(app);

    dispatchGlobalKeyDown(app);

    expect(handleShortcut).toHaveBeenCalled();
  });
});

async function openPaletteWith(actions: AppAction[]): Promise<{ app: PiWebUiAppElement; ran: string[] }> {
  const ran: string[] = [];
  const app = new PiWebUiApp();
  setAppState(app, { ...initialAppState(), actionPaletteOpen: true });
  vi.spyOn(Object.getPrototypeOf(app), "getActions").mockReturnValue(actions);
  mountWithoutAppSideEffects(app);
  await app.updateComplete;
  return { app, ran };
}

function inactiveMediaQuery(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
}

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

function setAppState(app: PiWebUiAppElement, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebUiApp state");
}

function paletteOpen(app: PiWebUiAppElement): boolean {
  const state: unknown = Reflect.get(app, "state");
  if (typeof state !== "object" || state === null) throw new Error("PiWebUiApp state is unavailable");
  return Reflect.get(state, "actionPaletteOpen") === true;
}

function actionPalette(app: PiWebUiAppElement): InstanceType<typeof ActionPalette> | null {
  const palette = app.renderRoot.querySelector("action-palette");
  return palette instanceof ActionPalette ? palette : null;
}

function clickPaletteRow(app: PiWebUiAppElement, title: string): void {
  const palette = actionPalette(app);
  if (palette === null) throw new Error("Expected the action palette to be rendered");
  const rows = [...(palette.shadowRoot?.querySelectorAll<HTMLButtonElement>(".options button") ?? [])];
  const row = rows.find((candidate) => candidate.textContent.includes(title));
  if (row === undefined) throw new Error(`Expected a palette row titled ${title}`);
  row.click();
}

/** Replaces the shortcut dispatcher so the guard can be observed without running actions. */
function replaceKeyboardHandler(app: PiWebUiAppElement) {
  const keyboard: unknown = Reflect.get(app, "keyboard");
  if (typeof keyboard !== "object" || keyboard === null || typeof Reflect.get(keyboard, "handle") !== "function") {
    throw new Error("PiWebUiApp keyboard dispatcher is unavailable");
  }
  const handle = vi.fn(() => false);
  if (!Reflect.set(keyboard, "handle", handle)) throw new Error("Could not replace PiWebUiApp keyboard dispatcher");
  return handle;
}

function dispatchGlobalKeyDown(app: PiWebUiAppElement): void {
  const handler: unknown = Reflect.get(app, "onKeyDown");
  if (!isGlobalKeyDownHandler(handler)) throw new Error("PiWebUiApp global keydown handler is unavailable");
  handler.call(app, new Event("keydown"));
}

function isGlobalKeyDownHandler(value: unknown): value is GlobalKeyDownHandler {
  return typeof value === "function";
}
