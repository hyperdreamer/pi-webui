import { LitElement, type TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSpeechClientApi, HostSpeechControllerSnapshot } from "../controllers/hostSpeechController";
import { HostSpeechController } from "../controllers/hostSpeechController";
import type { HostSpeechTerminalResult } from "../../../shared/apiTypes";
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

  it("stops the captured run before assigning archive, source removal, changed prose, and page re-keying", async () => {
    const speakable = assistantLine("Answer");
    const transcript = {
      messages: [userLine("Ask"), speakable],
      messagePageStart: 10,
      messagePageEnd: 12,
      messagePageTotal: 12,
    };
    const cases: { name: string; patch: Partial<AppState> }[] = [
      { name: "archive", patch: { selectedSession: { ...localSession, archived: true } } },
      { name: "removal", patch: { messages: [userLine("Ask")] } },
      { name: "replacement", patch: { messages: [userLine("Ask"), assistantLine("Changed")] } },
      { name: "re-key", patch: { messagePageStart: 9, messagePageEnd: 11, messagePageTotal: 11 } },
    ];

    for (const scenario of cases) {
      const { app, speak, stop, first } = await startActiveSpeech(transcript);
      const stoppedWhileOld: AppState[] = [];
      stop.mockImplementation(() => {
        stoppedWhileOld.push(appState(app));
        return Promise.resolve({ runId: "run-1", stopped: true });
      });

      applyStatePatch(app, scenario.patch);

      expect(stop, scenario.name).toHaveBeenCalledOnce();
      expect(stoppedWhileOld[0]?.selectedSession?.archived, scenario.name).not.toBe(true);
      expect(stoppedWhileOld[0]?.messages, scenario.name).toEqual(transcript.messages);
      expect(stoppedWhileOld[0]?.messagePageStart, scenario.name).toBe(10);
      expect(hostSpeechController(app).snapshot.active, scenario.name).toBeUndefined();
      first.resolve({ runId: "run-1", outcome: "canceled" });
      await first.promise.catch(() => undefined);
      expect(speak, scenario.name).toHaveBeenCalledOnce();
    }
  });

  it("keeps speech active for an equivalent republish, earlier-page prepend, and unrelated patch", async () => {
    const speakable = assistantLine("Answer");
    const transcript = {
      messages: [userLine("Ask"), speakable],
      messagePageStart: 10,
      messagePageEnd: 12,
      messagePageTotal: 12,
    };
    const { app, stop, first, controller } = await startActiveSpeech(transcript);
    const originalMessages = transcript.messages;

    applyStatePatch(app, { error: "unrelated" });
    applyStatePatch(app, { messages: [userLine("Ask"), assistantLine("Answer")] });
    applyStatePatch(app, {
      messages: [assistantLine("Earlier"), userLine("Ask"), speakable],
      messagePageStart: 9,
      messagePageEnd: 12,
      messagePageTotal: 12,
    });

    expect(stop).not.toHaveBeenCalled();
    expect(controller.snapshot.active).toEqual({
      runId: "run-1",
      sessionId: localSession.id,
      messageKey: "assistant-index:11",
    });
    expect(appState(app).messages).not.toBe(originalMessages);
    first.resolve({ runId: "run-1", outcome: "ended" });
    await first.promise;
    expect(controller.snapshot.active).toBeUndefined();
  });

  it("does not let a replaced run's late completion clear a newer run", async () => {
    const speakable = assistantLine("Answer");
    const second = deferred<HostSpeechTerminalResult>();
    const { app, stop, first, controller } = await startActiveSpeech({
      messages: [userLine("Ask"), speakable],
      messagePageStart: 10,
      messagePageEnd: 12,
      messagePageTotal: 12,
    }, [second.promise]);

    applyStatePatch(app, { messages: [userLine("Ask"), assistantLine("Changed")] });
    expect(controller.snapshot.active).toBeUndefined();
    await vi.waitFor(() => { expect(stop).toHaveBeenCalledWith("run-1"); });

    const secondStart = controller.startManual({
      machineId: "local",
      sessionId: localSession.id,
      messageKey: "assistant-index:11",
      text: "Changed",
    });
    expect(controller.snapshot.active?.runId).toBe("run-2");

    first.resolve({ runId: "run-1", outcome: "ended" });
    await first.promise;
    expect(controller.snapshot.active).toEqual({
      runId: "run-2",
      sessionId: localSession.id,
      messageKey: "assistant-index:11",
    });
    expect(stop).toHaveBeenCalledOnce();

    second.resolve({ runId: "run-2", outcome: "ended" });
    await secondStart;
    expect(controller.snapshot.active).toBeUndefined();
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
    const stop = vi.spyOn(controller, "stop").mockResolvedValue(undefined);
    const startManual = vi.spyOn(controller, "startManual").mockResolvedValue(undefined);
    const status = { available: true, voices: [{ name: "Ada", language: "en-US" }] };
    const active = { runId: "run-1", sessionId: localSession.id, messageKey: "assistant-index:2" };
    vi.spyOn(controller, "snapshot", "get").mockReturnValue({ status, loadingStatus: true, active });

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
    expect(controller.snapshot.active).toEqual(active);
    expect(stop).not.toHaveBeenCalled();
    expect(startManual).not.toHaveBeenCalled();
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

async function startActiveSpeech(
  transcript: Pick<AppState, "messages" | "messagePageStart" | "messagePageEnd" | "messagePageTotal">,
  laterSpeak: Promise<HostSpeechTerminalResult>[] = [],
) {
  const app = createApp();
  const controller = hostSpeechController(app);
  const first = deferred<HostSpeechTerminalResult>();
  const speak = vi.fn<HostSpeechClientApi["speak"]>();
  speak.mockReturnValueOnce(first.promise);
  for (const later of laterSpeak) speak.mockReturnValueOnce(later);
  const stop = vi.fn<HostSpeechClientApi["stop"]>().mockResolvedValue({ runId: "run-1", stopped: true });
  const runIds = ["run-1", "run-2"];
  if (!Reflect.set(controller, "api", {
    status: vi.fn<HostSpeechClientApi["status"]>().mockResolvedValue({ available: true, voices: [] }),
    speak,
    stop,
  })) throw new Error("Could not inject host speech API");
  if (!Reflect.set(controller, "createRunId", () => runIds.shift() ?? "run-extra")) {
    throw new Error("Could not inject host speech run ids");
  }
  setAppState(app, speechState(localSession, transcript));
  controller.select({ machineId: "local", sessionId: localSession.id });
  await controller.refreshStatus();
  const start = controller.startManual({
    machineId: "local",
    sessionId: localSession.id,
    messageKey: "assistant-index:11",
    text: "Answer",
  });
  expect(controller.snapshot.active).toEqual({
    runId: "run-1",
    sessionId: localSession.id,
    messageKey: "assistant-index:11",
  });
  void start.catch(() => undefined);
  return { app, controller, speak, stop, first, start };
}

function userLine(text: string) {
  return { role: "user" as const, parts: [{ type: "text" as const, text }] };
}

function assistantLine(text: string) {
  return { role: "assistant" as const, parts: [{ type: "text" as const, text }] };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}
