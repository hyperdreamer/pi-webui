import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
// Template inspection is proportionate here because this test covers the
// callback boundary between the Activity Rail and application shell.
import { templateStrings, templateText, templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebUiApp } from "./PiWebUiApp";

type RenderApp = (this: PiWebUiApp) => TemplateResult;
type VoidCallback = () => void;
type IsChatObscured = (this: PiWebUiApp) => boolean;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PiWebUiApp Browser panel", () => {
  it("opens and closes the Browser panel from the Activity Rail", () => {
    const app = createApp();
    const initial = renderApp(app);

    expect(templateStrings(initial).join("")).toMatch(/<activity-rail[\s\S]*?\.onOpenBrowser=/);
    const openBrowser = callbackAfterMarker(initial, ".onOpenBrowser=");
    openBrowser();

    expect(Reflect.get(app, "browserPanelOpen")).toBe(true);
    expect(isChatObscured(app)).toBe(true);

    const open = renderApp(app);
    expect(templateText(open)).toContain("<browser-panel");
    const closeBrowser = callbackAfterMarker(open, "<browser-panel");
    closeBrowser();

    expect(Reflect.get(app, "browserPanelOpen")).toBe(false);
    expect(isChatObscured(app)).toBe(false);
  });
});

function createApp(): PiWebUiApp {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage, innerWidth: 1280 });
  const app = new PiWebUiApp();
  if (!Reflect.set(app, "getBoundingClientRect", () => ({ width: 1280 }))) throw new Error("Could not stub PiWebUiApp bounds");
  return app;
}

function renderApp(app: PiWebUiApp): TemplateResult {
  const render: unknown = Reflect.get(app, "render");
  if (!isRenderApp(render)) throw new Error("PiWebUiApp.render is not callable");
  return render.call(app);
}

function callbackAfterMarker(template: TemplateResult, marker: string): VoidCallback {
  const value: unknown = templateValueAfterMarker(template, marker);
  if (!isVoidCallback(value)) throw new Error(`Expected callback after ${marker}`);
  return value;
}

function isChatObscured(app: PiWebUiApp): boolean {
  const method: unknown = Reflect.get(app, "isChatObscured");
  if (!isChatObscuredMethod(method)) throw new Error("PiWebUiApp.isChatObscured is not callable");
  return method.call(app);
}

function isRenderApp(value: unknown): value is RenderApp {
  return typeof value === "function";
}

function isVoidCallback(value: unknown): value is VoidCallback {
  return typeof value === "function";
}

function isChatObscuredMethod(value: unknown): value is IsChatObscured {
  return typeof value === "function";
}
