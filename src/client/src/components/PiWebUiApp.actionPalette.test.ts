// @vitest-environment jsdom

import { LitElement } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import type { AppAction } from "../actions";

vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
const { PiWebUiApp } = await import("./PiWebUiApp");
const { ActionPalette } = await import("./ActionPalette");
type PiWebUiAppElement = InstanceType<typeof PiWebUiApp>;
let mountedApp: PiWebUiAppElement | undefined;

afterEach(async () => {
  document.body.replaceChildren();
  await mountedApp?.updateComplete;
  await Promise.resolve();
  mountedApp = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (typeof window.matchMedia !== "function") Reflect.deleteProperty(window, "matchMedia");
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
});

async function openPaletteWith(actions: AppAction[]): Promise<{ app: PiWebUiAppElement; ran: string[] }> {
  const ran: string[] = [];
  vi.stubGlobal("matchMedia", (query: string) => inactiveMediaQuery(query));
  vi.stubGlobal("requestAnimationFrame", () => 0);
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
