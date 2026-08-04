import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MachineRuntime, SessionInfo, SessionReorderRequest } from "../api";
import { initialAppState, type AppState } from "../appState";
import { ProjectCatalogController } from "../controllers/projectCatalogController";
import { SessionController } from "../controllers/sessionController";
import { PI_WEBUI_CAPABILITIES } from "../../../shared/capabilities";
import { templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebUiApp } from "./PiWebUiApp";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebUiApp session reorder wiring", () => {
  it("gates reordering on the selected runtime capability", () => {
    const app = createApp();
    const supported = stateWithRuntime(runtimeWithCapabilities([
      PI_WEBUI_CAPABILITIES.sessionsReorder,
    ]));
    setAppState(app, supported);
    expect(templateValueAfterMarker(
      renderNavigationPanel(app),
      ".canReorderSessions=",
    )).toBe(true);

    setAppState(app, stateWithRuntime(runtimeWithCapabilities([
      PI_WEBUI_CAPABILITIES.sessionsReload,
    ])));
    expect(templateValueAfterMarker(
      renderNavigationPanel(app),
      ".canReorderSessions=",
    )).toBe(false);
    setAppState(app, stateWithRuntime(undefined));
    expect(templateValueAfterMarker(
      renderNavigationPanel(app),
      ".canReorderSessions=",
    )).toBe(false);
  });

  it("forwards exact reorder requests to SessionController", async () => {
    const app = createApp();
    const state = stateWithRuntime(runtimeWithCapabilities([
      PI_WEBUI_CAPABILITIES.sessionsReorder,
    ]));
    setAppState(app, state);
    const selected = state.selectedSession;
    if (selected === undefined) throw new Error("Expected selected session fixture");
    const request = reorderRequestFixture(selected);
    const reorderSession = vi.spyOn(appSessionController(app), "reorderSession")
      .mockResolvedValue(undefined);
    const value = templateValueAfterMarker(
      renderNavigationPanel(app),
      ".onReorderSession=",
    );
    if (!isReorderCallback(value)) throw new Error("Expected session reorder callback");

    const returned = value(selected, request);
    expect(returned).toBe(reorderSession.mock.results[0]?.value);
    await returned;

    expect(reorderSession).toHaveBeenCalledExactlyOnceWith(selected, request);
  });

  it("injects project-catalog refresh as the controller recovery boundary", async () => {
    const app = createApp();
    const projectCatalog: unknown = Reflect.get(app, "projectCatalog");
    if (!(projectCatalog instanceof ProjectCatalogController)) {
      throw new Error("PiWebUiApp ProjectCatalogController was unavailable");
    }
    const refresh = vi.spyOn(projectCatalog, "refresh").mockResolvedValue(undefined);
    const recovery: unknown = Reflect.get(
      appSessionController(app),
      "refreshProjectSessionCatalog",
    );
    if (!isProjectCatalogRecovery(recovery)) throw new Error("Expected project catalog recovery dependency");

    await recovery();

    expect(refresh).toHaveBeenCalledOnce();
  });
});

type RenderNavigationPanel = (this: PiWebUiApp) => TemplateResult;

function createApp(): PiWebUiApp {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage, innerWidth: 1280 });
  const app = new PiWebUiApp();
  if (!Reflect.set(app, "getBoundingClientRect", () => ({ width: 1280 }))) {
    throw new Error("Could not stub PiWebUiApp bounds");
  }
  return app;
}

function stateWithRuntime(runtime: MachineRuntime | undefined): AppState {
  const session = sessionFixture("session-1");
  return {
    ...initialAppState(),
    selectedSession: session,
    machineRuntimes: runtime === undefined ? {} : { local: runtime },
  };
}

function runtimeWithCapabilities(capabilities: NonNullable<MachineRuntime["capabilities"]>): MachineRuntime {
  return { machineId: "local", ok: true, checkedAt: "2026-07-14T00:00:00.000Z", capabilities };
}

function setAppState(app: PiWebUiApp, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebUiApp state");
}

function appSessionController(app: PiWebUiApp): SessionController {
  const controller: unknown = Reflect.get(app, "sessions");
  if (!(controller instanceof SessionController)) throw new Error("PiWebUiApp SessionController was unavailable");
  return controller;
}

function renderNavigationPanel(app: PiWebUiApp): TemplateResult {
  const method: unknown = Reflect.get(app, "renderNavigationPanel");
  if (!isRenderNavigationPanel(method)) throw new Error("PiWebUiApp.renderNavigationPanel is not callable");
  return method.call(app);
}

function isRenderNavigationPanel(value: unknown): value is RenderNavigationPanel {
  return typeof value === "function";
}

function isReorderCallback(value: unknown): value is (session: SessionInfo, input: SessionReorderRequest) => void | Promise<void> {
  return typeof value === "function";
}

function isProjectCatalogRecovery(value: unknown): value is () => void | Promise<void> {
  return typeof value === "function";
}

function sessionFixture(id: string): SessionInfo {
  return {
    id,
    cwd: "/repo",
    path: `/sessions/${id}.jsonl`,
    persisted: true,
    created: "now",
    modified: "now",
    messageCount: 0,
    firstMessage: id,
  };
}

function reorderRequestFixture(selected: SessionInfo): SessionReorderRequest {
  return {
    cwd: selected.cwd,
    scope: { kind: "root", cwd: selected.cwd },
    pinned: false,
    catalogCwds: [selected.cwd],
    orderedSessions: [{ id: selected.id, cwd: selected.cwd }],
  };
}
