import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavigationSectionsController } from "../appShell/navigationState";
import { templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebUiApp } from "./PiWebUiApp";

type SelectNavigationItem = (this: PiWebUiApp, section: "sessions", nextTarget: "chat", action: () => Promise<void>) => Promise<void>;
type RenderNavigationPanel = (this: PiWebUiApp) => TemplateResult;
type RenameStartCallback = () => void;

describe("PiWebUiApp session rename selection handling", () => {
  it("cancels a pending selection before it can refocus the chat editor", async () => {
    const app = createApp();
    const focusNavigationTarget = vi.fn(() => Promise.resolve());
    const advanceAfterSelection = vi.fn();
    const selection = deferred<undefined>();
    installSelectionHarness(app, focusNavigationTarget, advanceAfterSelection);

    const pendingSelection = selectNavigationItem(app, () => selection.promise);
    renameStartCallback(renderNavigationPanel(app))();
    selection.resolve(undefined);
    await pendingSelection;

    expect(advanceAfterSelection).toHaveBeenCalledOnce();
    expect(focusNavigationTarget).not.toHaveBeenCalled();
  });
});

function createApp(): PiWebUiApp {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage });
  return new PiWebUiApp();
}

function installSelectionHarness(app: PiWebUiApp, focusNavigationTarget: () => Promise<void>, advanceAfterSelection: () => void): void {
  if (!Reflect.set(app, "withChatScrollTransition", async (action: () => Promise<void>) => { await action(); })) throw new Error("Could not install chat transition harness");
  if (!Reflect.set(app, "focusNavigationTarget", focusNavigationTarget)) throw new Error("Could not install navigation focus harness");
  const navigationSections: unknown = Reflect.get(app, "navigationSections");
  if (!(navigationSections instanceof NavigationSectionsController)) throw new Error("PiWebUiApp navigation sections were unavailable");
  vi.spyOn(navigationSections, "advanceAfterSelection").mockImplementation(() => { advanceAfterSelection(); });
}

function selectNavigationItem(app: PiWebUiApp, action: () => Promise<void>): Promise<void> {
  const method: unknown = Reflect.get(app, "selectNavigationItem");
  if (!isSelectNavigationItem(method)) throw new Error("PiWebUiApp.selectNavigationItem is not callable");
  return method.call(app, "sessions", "chat", action);
}

function renderNavigationPanel(app: PiWebUiApp): TemplateResult {
  const method: unknown = Reflect.get(app, "renderNavigationPanel");
  if (!isRenderNavigationPanel(method)) throw new Error("PiWebUiApp.renderNavigationPanel is not callable");
  return method.call(app);
}

function renameStartCallback(template: TemplateResult): RenameStartCallback {
  const callback = templateValueAfterMarker(template, ".onRenameSessionStart=");
  if (!isRenameStartCallback(callback)) throw new Error("Expected session rename-start callback");
  return callback;
}

function isSelectNavigationItem(value: unknown): value is SelectNavigationItem {
  return typeof value === "function";
}

function isRenderNavigationPanel(value: unknown): value is RenderNavigationPanel {
  return typeof value === "function";
}

function isRenameStartCallback(value: unknown): value is RenameStartCallback {
  return typeof value === "function";
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
