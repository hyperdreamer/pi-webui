import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import { isTemplateResult, templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebUiApp } from "./PiWebUiApp";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PiWebUiApp header version wiring", () => {
  it("passes the current web runtime version to the navigation header", () => {
    const app = createApp();
    setAppState(app, {
      ...initialAppState(),
      piWebUiStatus: {
        packageName: "@hyperdreamer/pi-webui",
        generatedAt: "2026-07-25T00:00:00.000Z",
        components: {
          web: { component: "web", label: "Web/UI", runtimeVersion: "1.5.1", stale: false, available: true },
          sessiond: { component: "sessiond", label: "Session daemon", stale: false, available: true },
        },
        release: { packageName: "@hyperdreamer/pi-webui", updateAvailable: false },
        commands: {},
        messages: [],
      },
    });

    expect(templateValueAfterMarker(renderNavigationPanel(app), ".version=")).toBe("1.5.1");
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

function setAppState(app: PiWebUiApp, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebUiApp state");
}

function renderNavigationPanel(app: PiWebUiApp): TemplateResult {
  const method: unknown = Reflect.get(app, "renderNavigationPanel");
  if (typeof method !== "function") throw new Error("PiWebUiApp.renderNavigationPanel is not callable");
  const result: unknown = method.call(app);
  if (!isTemplateResult(result)) throw new Error("PiWebUiApp.renderNavigationPanel did not return a template");
  return result;
}
