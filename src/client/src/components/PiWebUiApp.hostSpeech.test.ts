import { LitElement, type TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSpeechControllerSnapshot } from "../controllers/hostSpeechController";
import { HostSpeechController } from "../controllers/hostSpeechController";
import { initialAppState, type AppState } from "../appState";
import type { Machine, PiWebUiConfigValues, SessionInfo, SessionStatus } from "../api";
import { findTemplateContaining, templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebUiApp } from "./PiWebUiApp";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const localSession = session("local-session");
const replacementSession = session("replacement-session");
const remoteMachine: Machine = {
  id: "remote-a",
  name: "Remote host",
  kind: "remote",
  baseUrl: "https://remote.example.test",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

describe("PiWebUiApp host speech lifecycle", () => {
  it("refreshes host speech on connection, configures future runs from client config, and disposes before disconnecting", () => {
    const app = createApp();
    const controller = hostSpeechController(app);
    const refresh = vi.spyOn(controller, "refreshStatus").mockResolvedValue(undefined);
    const configure = vi.spyOn(controller, "configure");
    const dispose = vi.spyOn(controller, "dispose");
    const sequence: string[] = [];
    vi.spyOn(LitElement.prototype, "disconnectedCallback").mockImplementation(() => { sequence.push("super"); });
    dispose.mockImplementation(() => { sequence.push("dispose"); });

    invokeConnected(app);
    expect(refresh).toHaveBeenCalledOnce();

    applyClientConfig(app, { tts: { voice: "Ada", rate: 20 } });
    expect(configure).toHaveBeenCalledExactlyOnceWith({ voice: "Ada", rate: 20 });

    invokeDisconnected(app);
    expect(sequence).toEqual(["dispose", "super"]);
  });

  it("selects the next machine/session identity before assigning state and does not stop separately", () => {
    const app = createApp();
    setAppState(app, speechState(localSession));
    const controller = hostSpeechController(app);
    const selectedWhileStateWasOld: AppState[] = [];
    const select = vi.spyOn(controller, "select").mockImplementation(() => { selectedWhileStateWasOld.push(appState(app)); });
    const stop = vi.spyOn(controller, "stop").mockResolvedValue(undefined);

    applyStatePatch(app, { selectedSession: replacementSession, status: compactingStatus(replacementSession.id) });

    expect(select).toHaveBeenCalledExactlyOnceWith({ machineId: "local", sessionId: replacementSession.id });
    expect(selectedWhileStateWasOld[0]?.selectedSession).toBe(localSession);
    expect(stop).not.toHaveBeenCalled();
  });

  it("stops active speech before assigning an unchanged selection's rising compaction state", () => {
    const app = createApp();
    setAppState(app, speechState(localSession));
    const controller = hostSpeechController(app);
    const stoppedWhileStateWasIdle: AppState[] = [];
    const select = vi.spyOn(controller, "select").mockImplementation(() => undefined);
    const stop = vi.spyOn(controller, "stop").mockImplementation(() => {
      stoppedWhileStateWasIdle.push(appState(app));
      return Promise.resolve();
    });

    applyStatePatch(app, { status: compactingStatus(localSession.id) });

    expect(stop).toHaveBeenCalledOnce();
    expect(stoppedWhileStateWasIdle[0]?.status?.isCompacting).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });
});

describe("PiWebUiApp host speech component wiring", () => {
  it("delegates a local ChatView action to stop the active key or start a local target", () => {
    const app = createApp();
    const state = speechState(localSession);
    setAppState(app, state);
    const controller = hostSpeechController(app);
    const stop = vi.spyOn(controller, "stop").mockResolvedValue(undefined);
    const start = vi.spyOn(controller, "startManual").mockResolvedValue(undefined);
    const snapshot = vi.spyOn(controller, "snapshot", "get");
    snapshot.mockReturnValue(hostSpeechSnapshot({ active: { runId: "run-1", sessionId: localSession.id, messageKey: "assistant-index:2" } }));

    const toggle = chatToggleCallback(renderChatView(app, state));
    toggle({ message: { role: "assistant", parts: [{ type: "text", text: "Answer" }] }, messageKey: "assistant-index:2", text: "Answer" });
    expect(stop).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();

    snapshot.mockReturnValue(hostSpeechSnapshot());
    toggle({ message: { role: "assistant", parts: [{ type: "text", text: "Answer" }] }, messageKey: "assistant-index:3", text: "Answer" });
    expect(start).toHaveBeenCalledExactlyOnceWith({
      machineId: "local",
      sessionId: localSession.id,
      messageKey: "assistant-index:3",
      text: "Answer",
    });
  });

  it("withholds host speech props from remote chats and keeps controller errors outside app state.error", () => {
    const app = createApp();
    const state = speechState(localSession, { error: "Unrelated application error" });
    setAppState(app, state);
    const controller = hostSpeechController(app);
    vi.spyOn(controller, "snapshot", "get").mockReturnValue(hostSpeechSnapshot({ error: "Speech service failed." }));

    const localChat = renderChatView(app, state);
    expect(templateValueAfterMarker(localChat, ".hostSpeechError=")).toBe("Speech service failed.");
    expect(appState(app).error).toBe("Unrelated application error");

    const remoteState = { ...state, selectedMachine: remoteMachine };
    setAppState(app, remoteState);
    const remoteChat = renderChatView(app, remoteState);
    expect(templateValueAfterMarker(remoteChat, ".hostSpeechStatus=")).toBeUndefined();
    expect(templateValueAfterMarker(remoteChat, ".onToggleHostSpeech=")).toBeUndefined();
  });

  it("passes local status reload and config-save wiring through SettingsDialog without a TTS state error", () => {
    const app = createApp();
    const state = speechState(localSession, { error: "Unrelated application error" });
    setAppState(app, state);
    if (!Reflect.set(app, "settingsSection", "general")) throw new Error("Could not open General settings");
    const controller = hostSpeechController(app);
    const refresh = vi.spyOn(controller, "refreshStatus").mockResolvedValue(undefined);
    const configure = vi.spyOn(controller, "configure");
    const status = { available: true, voices: [{ name: "Ada", language: "en-US" }] };
    vi.spyOn(controller, "snapshot", "get").mockReturnValue({ status, loadingStatus: true });

    const localDialog = settingsDialogTemplate(app);
    expect(templateValueAfterMarker(localDialog, ".showHostSpeechSettings=")).toBe(true);
    expect(templateValueAfterMarker(localDialog, ".hostSpeechStatus=")).toBe(status);
    expect(templateValueAfterMarker(localDialog, ".hostSpeechStatusLoading=")).toBe(true);
    const reload = templateCallback(localDialog, ".onReloadHostSpeech=");
    reload();
    expect(refresh).toHaveBeenCalledOnce();
    const onConfigSaved = templateCallback(localDialog, ".onConfigSaved=");
    onConfigSaved({ tts: { voice: "Ada", rate: -10 } });
    expect(configure).toHaveBeenCalledExactlyOnceWith({ voice: "Ada", rate: -10 });
    expect(appState(app).error).toBe("Unrelated application error");

    setAppState(app, { ...state, selectedMachine: remoteMachine });
    const remoteDialog = settingsDialogTemplate(app);
    expect(templateValueAfterMarker(remoteDialog, ".showHostSpeechSettings=")).toBe(false);
    expect(templateValueAfterMarker(remoteDialog, ".hostSpeechStatus=")).toBeUndefined();
    expect(templateValueAfterMarker(remoteDialog, ".onReloadHostSpeech=")).toBeUndefined();
  });
});

type ApplyStatePatch = (this: PiWebUiApp, patch: Partial<AppState>) => void;
type ApplyClientConfig = (this: PiWebUiApp, config: PiWebUiConfigValues) => void;
type RenderChatView = (this: PiWebUiApp, state: AppState, session: SessionInfo) => TemplateResult;
type LifecycleHook = (this: PiWebUiApp) => void;
type RenderApp = (this: PiWebUiApp) => TemplateResult;
type ChatToggle = (target: { message: unknown; messageKey: string; text: string }) => void;
type TemplateCallback = (config?: { tts?: { voice?: string; rate?: number } }) => void;

function createApp(): PiWebUiApp {
  const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  vi.stubGlobal("window", {
    location: { search: "" },
    localStorage: storage,
    innerWidth: 1280,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setInterval: vi.fn(() => 1),
    clearInterval: vi.fn(),
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn(),
  });
  const app = new PiWebUiApp();
  if (!Reflect.set(app, "getBoundingClientRect", () => ({ width: 1280 }))) throw new Error("Could not stub app bounds");
  return app;
}

function invokeConnected(app: PiWebUiApp): void {
  stubConnectionSideEffects(app);
  vi.spyOn(LitElement.prototype, "connectedCallback").mockImplementation(() => undefined);
  Object.defineProperty(app, "isConnected", { configurable: true, value: true });
  const hook: unknown = Reflect.get(app, "connectedCallback");
  if (!isLifecycleHook(hook)) throw new Error("PiWebUiApp.connectedCallback is not callable");
  hook.call(app);
}

function invokeDisconnected(app: PiWebUiApp): void {
  const hook: unknown = Reflect.get(app, "disconnectedCallback");
  if (!isLifecycleHook(hook)) throw new Error("PiWebUiApp.disconnectedCallback is not callable");
  hook.call(app);
}

function stubConnectionSideEffects(app: PiWebUiApp): void {
  const asyncNoop = () => Promise.resolve();
  for (const name of ["synchronizeProjectCatalogPolling", "connectRealtime", "syncWindowTitle", "applyPreferredTheme"]) {
    if (!Reflect.set(app, name, () => undefined)) throw new Error(`Could not stub ${name}`);
  }
  for (const name of ["renegotiateUnreadMachines", "refreshWorkspaceActivity", "loadClientConfig", "ensureGatewayPluginsLoaded", "loadProjectsAndRestoreRoute"]) {
    if (!Reflect.set(app, name, asyncNoop)) throw new Error(`Could not stub ${name}`);
  }
}

function hostSpeechController(app: PiWebUiApp): HostSpeechController {
  const value: unknown = Reflect.get(app, "hostSpeech");
  if (!(value instanceof HostSpeechController)) throw new Error("PiWebUiApp host speech controller is unavailable");
  return value;
}

function setAppState(app: PiWebUiApp, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebUiApp state");
}

function appState(app: PiWebUiApp): AppState {
  const state: unknown = Reflect.get(app, "state");
  if (!isAppState(state)) throw new Error("PiWebUiApp state is unavailable");
  return state;
}

function applyStatePatch(app: PiWebUiApp, patch: Partial<AppState>): void {
  const method: unknown = Reflect.get(app, "setState");
  if (!isApplyStatePatch(method)) throw new Error("PiWebUiApp.setState is not callable");
  method.call(app, patch);
}

function applyClientConfig(app: PiWebUiApp, config: PiWebUiConfigValues): void {
  const method: unknown = Reflect.get(app, "applyClientConfig");
  if (!isApplyClientConfig(method)) throw new Error("PiWebUiApp.applyClientConfig is not callable");
  method.call(app, config);
}

function renderChatView(app: PiWebUiApp, state: AppState): TemplateResult {
  const method: unknown = Reflect.get(app, "renderChatView");
  if (!isRenderChatView(method)) throw new Error("PiWebUiApp.renderChatView is not callable");
  if (state.selectedSession === undefined) throw new Error("Expected selected session");
  return method.call(app, state, state.selectedSession);
}

function settingsDialogTemplate(app: PiWebUiApp): TemplateResult {
  const render: unknown = Reflect.get(app, "render");
  if (!isRenderApp(render)) throw new Error("PiWebUiApp.render is not callable");
  const template = render.call(app);
  const dialog = findTemplateContaining(template, "<settings-dialog");
  if (dialog === undefined) throw new Error("PiWebUiApp did not render settings-dialog");
  return dialog;
}

function chatToggleCallback(template: TemplateResult): ChatToggle {
  const value = templateValueAfterMarker(template, ".onToggleHostSpeech=");
  if (!isChatToggle(value)) throw new Error("Expected host speech toggle callback");
  return value;
}

function templateCallback(template: TemplateResult, marker: string): TemplateCallback {
  const value = templateValueAfterMarker(template, marker);
  if (!isTemplateCallback(value)) throw new Error(`Expected callback after ${marker}`);
  return value;
}

function isLifecycleHook(value: unknown): value is LifecycleHook {
  return typeof value === "function";
}

function isAppState(value: unknown): value is AppState {
  return typeof value === "object" && value !== null
    && "selectedMachine" in value
    && "selectedSession" in value
    && "error" in value;
}

function isApplyStatePatch(value: unknown): value is ApplyStatePatch {
  return typeof value === "function";
}

function isApplyClientConfig(value: unknown): value is ApplyClientConfig {
  return typeof value === "function";
}

function isRenderChatView(value: unknown): value is RenderChatView {
  return typeof value === "function";
}

function isRenderApp(value: unknown): value is RenderApp {
  return typeof value === "function";
}

function isChatToggle(value: unknown): value is ChatToggle {
  return typeof value === "function";
}

function isTemplateCallback(value: unknown): value is TemplateCallback {
  return typeof value === "function";
}

function session(id: string): SessionInfo {
  return {
    id,
    cwd: "/repo",
    path: `/sessions/${id}.jsonl`,
    created: "2026-08-01T00:00:00.000Z",
    modified: "2026-08-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "Hello",
  };
}

function speechState(selectedSession: SessionInfo, overrides: Partial<AppState> = {}): AppState {
  return {
    ...initialAppState(),
    selectedSession,
    status: idleStatus(selectedSession.id),
    ...overrides,
  };
}

function idleStatus(sessionId: string): SessionStatus {
  return {
    sessionId,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}

function compactingStatus(sessionId: string): SessionStatus {
  return { ...idleStatus(sessionId), isCompacting: true };
}

function hostSpeechSnapshot(overrides: Partial<HostSpeechControllerSnapshot> = {}): HostSpeechControllerSnapshot {
  return { status: { available: true, voices: [] }, loadingStatus: false, ...overrides };
}
