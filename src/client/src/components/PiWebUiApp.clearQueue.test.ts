import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MachineRuntime, SessionInfo, SessionStatus } from "../api";
import { initialAppState, type AppState } from "../appState";
import { SessionController } from "../controllers/sessionController";
import { PI_WEBUI_CAPABILITIES } from "../../../shared/capabilities";
// Template inspection here is the escape hatch for verifying the Clear-queue
// callback wiring in a node environment (no DOM harness). See
// templateInspection.testSupport for the proportionality rationale.
import { templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebUiApp } from "./PiWebUiApp";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebUiApp per-message action wiring", () => {
  it("passes stable supported-runtime callbacks through to SessionController", async () => {
    const app = createApp();
    const state = stateWithRuntime(runtimeWithCapabilities([PI_WEBUI_CAPABILITIES.sessionsMessageActions]));
    setAppState(app, state);
    const controller = appSessionController(app);
    const editFromHere = vi.spyOn(controller, "editFromHere").mockResolvedValue({ cancelled: false });
    const forkFromHere = vi.spyOn(controller, "forkFromHere").mockResolvedValue(undefined);

    const firstRender = renderChatView(app, state);
    const secondRender = renderChatView(app, state);
    const firstEdit = templateEditFromHereCallback(firstRender);
    const firstFork = templateForkFromHereCallback(firstRender);

    expect(templateValueAfterMarker(firstRender, ".canMessageActions=")).toBe(true);
    expect(templateEditFromHereCallback(secondRender)).toBe(firstEdit);
    expect(templateForkFromHereCallback(secondRender)).toBe(firstFork);
    const focusChatComposer = vi.fn(() => Promise.resolve());
    if (!Reflect.set(app, "focusChatComposer", focusChatComposer)) throw new Error("Could not replace prompt focus boundary");
    await firstEdit("assistant-1", "Revise this");
    await firstFork("user-2");
    expect(editFromHere).toHaveBeenCalledExactlyOnceWith("assistant-1", "Revise this");
    expect(focusChatComposer).toHaveBeenCalledOnce();
    expect(forkFromHere).toHaveBeenCalledExactlyOnceWith("user-2");
  });

  it("does not enable per-message actions without their capability", () => {
    const app = createApp();
    const state = stateWithRuntime(runtimeWithCapabilities([PI_WEBUI_CAPABILITIES.sessionsReload]));
    setAppState(app, state);

    expect(templateValueAfterMarker(renderChatView(app, state), ".canMessageActions=")).toBe(false);
  });
});

describe("PiWebUiApp queued-message clear wiring", () => {
  it("passes a stable supported-runtime callback through to SessionController", () => {
    const app = createApp();
    const state = stateWithRuntime(runtimeWithCapabilities([PI_WEBUI_CAPABILITIES.sessionsClearQueue]));
    setAppState(app, state);
    const controller = appSessionController(app);
    const clearServerQueue = vi.spyOn(controller, "clearServerQueue").mockResolvedValue(undefined);

    const firstRender = renderChatView(app, state);
    const secondRender = renderChatView(app, state);
    const firstCallback = templateCallbackAfterMarker(firstRender, ".onClearServerQueue=");
    const secondCallback = templateCallbackAfterMarker(secondRender, ".onClearServerQueue=");

    expect(templateValueAfterMarker(firstRender, ".canClearServerQueue=")).toBe(true);
    expect(secondCallback).toBe(firstCallback);
    firstCallback();
    expect(clearServerQueue).toHaveBeenCalledOnce();
  });

  it("passes false when runtime discovery is unavailable, unhealthy, or lacks the capability", () => {
    const app = createApp();
    const runtimes: (MachineRuntime | undefined)[] = [
      undefined,
      { ...runtimeWithCapabilities([PI_WEBUI_CAPABILITIES.sessionsClearQueue]), ok: false },
      runtimeWithCapabilities([PI_WEBUI_CAPABILITIES.sessionsReload]),
    ];

    for (const runtime of runtimes) {
      const state = stateWithRuntime(runtime);
      setAppState(app, state);
      expect(templateValueAfterMarker(renderChatView(app, state), ".canClearServerQueue=")).toBe(false);
    }
  });
});

describe("PiWebUiApp manual compaction wiring", () => {
  it("runs the compact command and retains its control while a session is active", () => {
    const app = createApp();
    const controller = appSessionController(app);
    const runCommand = vi.spyOn(controller, "runCommand").mockResolvedValue(true);
    const idleState = { ...stateWithRuntime(undefined), status: idleStatus() };
    setAppState(app, idleState);

    // This verifies the app-to-composer callback boundary without mounting a DOM.
    const onCompact = templateCompactCallback(renderApp(app));
    onCompact();

    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledWith("/compact");

    setAppState(app, { ...idleState, status: queuedStatus() });

    expect(templateCompactCallback(renderApp(app))).toBe(onCompact);
  });
});

type RenderChatView = (this: PiWebUiApp, state: AppState, session: SessionInfo) => TemplateResult;
type RenderApp = (this: PiWebUiApp) => TemplateResult;
type ClearServerQueueCallback = () => void;
type CompactCallback = () => void;
type EditFromHereCallback = (assistantEntryId: string, editorText: string) => void | Promise<void>;
type ForkFromHereCallback = (userEntryId: string) => void | Promise<void>;

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

function stateWithRuntime(runtime: MachineRuntime | undefined): AppState {
  const session: SessionInfo = {
    id: "session-1",
    cwd: "/repo",
    path: "/repo/session-1.jsonl",
    created: "2026-07-14T00:00:00.000Z",
    modified: "2026-07-14T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hello",
  };
  return {
    ...initialAppState(),
    selectedSession: session,
    status: queuedStatus(),
    machineRuntimes: runtime === undefined ? {} : { local: runtime },
  };
}

function runtimeWithCapabilities(capabilities: NonNullable<MachineRuntime["capabilities"]>): MachineRuntime {
  return { machineId: "local", ok: true, checkedAt: "2026-07-14T00:00:00.000Z", capabilities };
}

function queuedStatus(): SessionStatus {
  return {
    ...idleStatus(),
    isStreaming: true,
    pendingMessageCount: 1,
    queuedMessages: [{ kind: "followUp", text: "queued" }],
  };
}

function idleStatus(): SessionStatus {
  return {
    sessionId: "session-1",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}

function setAppState(app: PiWebUiApp, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebUiApp state");
}

function appSessionController(app: PiWebUiApp): SessionController {
  const controller: unknown = Reflect.get(app, "sessions");
  if (!(controller instanceof SessionController)) throw new Error("PiWebUiApp SessionController was unavailable");
  return controller;
}

function renderChatView(app: PiWebUiApp, state: AppState): TemplateResult {
  const method: unknown = Reflect.get(app, "renderChatView");
  if (!isRenderChatView(method)) throw new Error("PiWebUiApp.renderChatView is not callable");
  const session = state.selectedSession;
  if (session === undefined) throw new Error("Expected a selected session");
  return method.call(app, state, session);
}

function renderApp(app: PiWebUiApp): TemplateResult {
  const method: unknown = Reflect.get(app, "render");
  if (!isRenderApp(method)) throw new Error("PiWebUiApp.render is not callable");
  return method.call(app);
}

function isRenderChatView(value: unknown): value is RenderChatView {
  return typeof value === "function";
}

function isRenderApp(value: unknown): value is RenderApp {
  return typeof value === "function";
}

function templateCallbackAfterMarker(template: TemplateResult, marker: string): ClearServerQueueCallback {
  const value = templateValueAfterMarker(template, marker);
  if (!isClearServerQueueCallback(value)) throw new Error(`Expected callback after ${marker}`);
  return value;
}

function isClearServerQueueCallback(value: unknown): value is ClearServerQueueCallback {
  return typeof value === "function";
}

function templateCompactCallback(template: TemplateResult): CompactCallback {
  const value = templateValueAfterMarker(template, ".onCompact=");
  if (!isCompactCallback(value)) throw new Error("Expected compact callback");
  return value;
}

function isCompactCallback(value: unknown): value is CompactCallback {
  return typeof value === "function";
}

function templateEditFromHereCallback(template: TemplateResult): EditFromHereCallback {
  const value = templateValueAfterMarker(template, ".onEditFromHere=");
  if (!isEditFromHereCallback(value)) throw new Error("Expected edit-from-here callback");
  return value;
}

function templateForkFromHereCallback(template: TemplateResult): ForkFromHereCallback {
  const value = templateValueAfterMarker(template, ".onForkFromHere=");
  if (!isForkFromHereCallback(value)) throw new Error("Expected fork-from-here callback");
  return value;
}

function isEditFromHereCallback(value: unknown): value is EditFromHereCallback {
  return typeof value === "function";
}

function isForkFromHereCallback(value: unknown): value is ForkFromHereCallback {
  return typeof value === "function";
}
