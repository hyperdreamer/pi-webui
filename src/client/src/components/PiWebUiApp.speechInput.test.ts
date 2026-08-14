// @vitest-environment jsdom

import type { TemplateResult } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configApi, pluginsApi, speechInputApi, type SpeechInputSettingsResponse } from "../api";
import { initialAppState, type AppState } from "../appState";
import { findTemplateContaining, isTemplateResult, templateValueAfterMarker } from "../templateInspection.testSupport";
import { SettingsDialog } from "./SettingsDialog";
import { PiWebUiApp } from "./PiWebUiApp";

interface KeyEventDouble {
  key: string;
  preventDefault: () => void;
  stopPropagation: () => void;
  calls: { preventDefault: number; stopPropagation: number };
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", mediaQuery);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebUiApp speech input Escape delegation", () => {
  it("cancels active dictation before modal and shortcut guards consume Escape", () => {
    const app = new PiWebUiApp();
    const cancelSpeechInput = vi.fn(() => true);
    const keyboard = replaceKeyboardHandler(app);
    setPromptEditor(app, { cancelSpeechInput });
    Reflect.set(app, "settingsSection", "general");
    const event = keyEvent("Escape");

    invokeGlobalKeyDown(app, event);

    expect(cancelSpeechInput).toHaveBeenCalledOnce();
    expect(event.calls.preventDefault).toBe(1);
    expect(event.calls.stopPropagation).toBe(1);
    expect(keyboard).not.toHaveBeenCalled();
  });

  it("preserves idle Escape modal and shortcut behavior when dictation declines it", () => {
    const app = new PiWebUiApp();
    const cancelSpeechInput = vi.fn(() => false);
    const keyboard = replaceKeyboardHandler(app);
    setPromptEditor(app, { cancelSpeechInput });
    Reflect.set(app, "settingsSection", "general");
    const modalEvent = keyEvent("Escape");

    invokeGlobalKeyDown(app, modalEvent);

    expect(cancelSpeechInput).toHaveBeenCalledOnce();
    expect(modalEvent.calls.preventDefault).toBe(0);
    expect(modalEvent.calls.stopPropagation).toBe(0);
    expect(keyboard).not.toHaveBeenCalled();

    Reflect.set(app, "settingsSection", undefined);
    keyboard.mockReturnValue(true);
    const shortcutEvent = keyEvent("Escape");
    invokeGlobalKeyDown(app, shortcutEvent);

    expect(cancelSpeechInput).toHaveBeenCalledTimes(2);
    expect(keyboard).toHaveBeenCalledOnce();
    expect(shortcutEvent.calls.preventDefault).toBe(1);
    expect(shortcutEvent.calls.stopPropagation).toBe(1);
  });

  it("does not delegate non-Escape keys to the prompt editor", () => {
    const app = new PiWebUiApp();
    const cancelSpeechInput = vi.fn(() => true);
    const keyboard = replaceKeyboardHandler(app);
    setPromptEditor(app, { cancelSpeechInput });
    const event = keyEvent("Enter");

    invokeGlobalKeyDown(app, event);

    expect(cancelSpeechInput).not.toHaveBeenCalled();
    expect(keyboard).toHaveBeenCalledOnce();
  });
});

describe("PiWebUiApp speech input settings ownership", () => {
  it("suppresses a dialog reload after app adoption advances the live request sequence before the dialog rerenders", async () => {
    const staleSpeech = deferred<SpeechInputSettingsResponse>();
    const older = speechInputSettingsResponse("00000000-0000-4000-8000-000000000001");
    const newer = speechInputSettingsResponse("00000000-0000-4000-8000-000000000002");
    const stale = speechInputSettingsResponse("00000000-0000-4000-8000-000000000003");
    vi.spyOn(configApi, "config").mockResolvedValue(gatewayConfigResponse());
    vi.spyOn(pluginsApi, "plugins").mockResolvedValue({ plugins: [] });
    vi.spyOn(speechInputApi, "settings").mockReturnValue(staleSpeech.promise);
    const { app } = speechSettingsApp(vi.fn());
    Reflect.set(app, "speechInputSettingsConnected", true);
    Reflect.set(app, "speechInputSettings", older);
    Reflect.set(app, "speechInputSettingsRequestSeq", 12);
    Reflect.set(app, "settingsSection", "general");
    const appDialog = settingsDialogTemplate(app);
    const requestSeq = templateValueAfterMarker(appDialog, ".speechInputSettingsRequestSeq=");
    const isRequestCurrent = templateValueAfterMarker(appDialog, ".isSpeechInputSettingsRequestCurrent=");
    const appOnSpeechInputSettingsLoaded = templateValueAfterMarker(appDialog, ".onSpeechInputSettingsLoaded=");
    if (typeof requestSeq !== "number") throw new Error("settings-dialog did not receive the speech settings request sequence");
    if (typeof isRequestCurrent !== "function") throw new Error("settings-dialog did not receive the live speech settings request validator");
    if (typeof appOnSpeechInputSettingsLoaded !== "function") throw new Error("settings-dialog did not receive the speech settings adoption callback");

    const dialog = new SettingsDialog();
    dialog.speechInputSettings = older;
    Reflect.set(dialog, "speechInputSettingsRequestSeq", requestSeq);
    Reflect.set(dialog, "isSpeechInputSettingsRequestCurrent", isRequestCurrent);
    const onSpeechInputSettingsLoaded = vi.fn((response: SpeechInputSettingsResponse) => {
      Reflect.apply(appOnSpeechInputSettingsLoaded, undefined, [response]);
    });
    dialog.onSpeechInputSettingsLoaded = onSpeechInputSettingsLoaded;

    const load = callPrivateDialogPromise(dialog, "loadConfig");
    callAppMethod(app, "handleSpeechInputSettingsLoaded", newer);
    staleSpeech.resolve(stale);
    await load;

    expect(getDialogProperty(dialog, "speechInputSettings")).toBe(older);
    expect(onSpeechInputSettingsLoaded).not.toHaveBeenCalled();
    expect(getAppProperty(app, "speechInputSettings")).toBe(newer);
  });

  it("loads the app-owned snapshot at startup and suppresses an older direct response after dialog adoption", async () => {
    const initial = deferred<SpeechInputSettingsResponse>();
    const dialogResponse = speechInputSettingsResponse("00000000-0000-4000-8000-000000000002");
    const staleResponse = speechInputSettingsResponse("00000000-0000-4000-8000-000000000003");
    const settings = vi.fn(() => initial.promise);
    const { app, channel } = speechSettingsApp(settings);

    callAppMethod(app, "connectSpeechInputSettings");
    expect(settings).toHaveBeenCalledOnce();
    callAppMethod(app, "handleSpeechInputSettingsLoaded", dialogResponse);
    initial.resolve(staleResponse);
    await flush();

    expect(getAppProperty(app, "speechInputSettings")).toBe(dialogResponse);
    expect(channel.published).toEqual([]);
    callAppMethod(app, "disconnectSpeechInputSettings");
  });

  it("refreshes speech settings through browser resume", async () => {
    const startup = speechInputSettingsResponse("00000000-0000-4000-8000-000000000001");
    const resumed = speechInputSettingsResponse("00000000-0000-4000-8000-000000000002");
    const settings = vi.fn()
      .mockResolvedValueOnce(startup)
      .mockResolvedValueOnce(resumed);
    const { app } = speechSettingsApp(settings);
    stubResumeDependencies(app);

    callAppMethod(app, "connectSpeechInputSettings");
    await flush();
    await callAppPromise(app, "refreshAfterBrowserResume");

    expect(settings).toHaveBeenCalledTimes(2);
    expect(getAppProperty(app, "speechInputSettings")).toBe(resumed);
    callAppMethod(app, "disconnectSpeechInputSettings");
  });

  it("adopts dialog saves before publishing only the new revision", () => {
    const settings = vi.fn();
    const { app, channel } = speechSettingsApp(settings);
    const saved = speechInputSettingsResponse("00000000-0000-4000-8000-000000000004");

    callAppMethod(app, "connectSpeechInputSettings");
    settings.mockClear();
    callAppMethod(app, "handleSpeechInputSettingsSaved", saved);

    expect(getAppProperty(app, "speechInputSettings")).toBe(saved);
    expect(channel.published).toEqual([saved.revision]);
    expect(settings).not.toHaveBeenCalled();
    callAppMethod(app, "disconnectSpeechInputSettings");
  });

  it("coalesces a queued revision burst and runs one trailing refresh for newer in-flight revisions", async () => {
    const startup = speechInputSettingsResponse("00000000-0000-4000-8000-000000000001");
    const firstChannelRefresh = deferred<SpeechInputSettingsResponse>();
    const trailingChannelRefresh = deferred<SpeechInputSettingsResponse>();
    const settings = vi.fn()
      .mockResolvedValueOnce(startup)
      .mockReturnValueOnce(firstChannelRefresh.promise)
      .mockReturnValueOnce(trailingChannelRefresh.promise);
    const { app, channel } = speechSettingsApp(settings);

    callAppMethod(app, "connectSpeechInputSettings");
    await flush();
    settings.mockClear();
    channel.emit("00000000-0000-4000-8000-000000000002");
    channel.emit("00000000-0000-4000-8000-000000000003");
    await flush();
    expect(settings).toHaveBeenCalledOnce();

    channel.emit("00000000-0000-4000-8000-000000000004");
    channel.emit("00000000-0000-4000-8000-000000000005");
    firstChannelRefresh.resolve(speechInputSettingsResponse("00000000-0000-4000-8000-000000000003"));
    await flush();
    expect(settings).toHaveBeenCalledTimes(2);

    trailingChannelRefresh.resolve(speechInputSettingsResponse("00000000-0000-4000-8000-000000000005"));
    await flush();
    expect(settings).toHaveBeenCalledTimes(2);
    expect(getAppProperty(app, "speechInputSettings")).toMatchObject({ revision: "00000000-0000-4000-8000-000000000005" });
    callAppMethod(app, "disconnectSpeechInputSettings");
  });

  it("retains the last successful snapshot on a failed channel refresh and still services one trailing invalidation", async () => {
    const startup = speechInputSettingsResponse("00000000-0000-4000-8000-000000000001");
    const failedRefresh = deferred<SpeechInputSettingsResponse>();
    const trailingRefresh = deferred<SpeechInputSettingsResponse>();
    const settings = vi.fn()
      .mockResolvedValueOnce(startup)
      .mockReturnValueOnce(failedRefresh.promise)
      .mockReturnValueOnce(trailingRefresh.promise);
    const { app, channel } = speechSettingsApp(settings);

    callAppMethod(app, "connectSpeechInputSettings");
    await flush();
    settings.mockClear();
    channel.emit("00000000-0000-4000-8000-000000000002");
    await flush();
    channel.emit("00000000-0000-4000-8000-000000000003");
    failedRefresh.reject(new Error("offline"));
    await flush();

    expect(getAppProperty(app, "speechInputSettings")).toBe(startup);
    expect(settings).toHaveBeenCalledTimes(2);
    trailingRefresh.resolve(speechInputSettingsResponse("00000000-0000-4000-8000-000000000003"));
    await flush();
    expect(getAppProperty(app, "speechInputSettings")).toMatchObject({ revision: "00000000-0000-4000-8000-000000000003" });
    callAppMethod(app, "disconnectSpeechInputSettings");
  });

  it("passes the exact app-owned response object to starter and active prompt editors", () => {
    const snapshot = speechInputSettingsResponse("00000000-0000-4000-8000-000000000006");
    const { app } = speechSettingsApp(vi.fn());
    const workspace = {
      id: "workspace-a",
      projectId: "project-a",
      path: "/work/project-a",
      label: "Project A",
      isMain: true,
      isGitRepo: true,
      isGitWorktree: false,
    };
    const starterState: AppState = { ...initialAppState(), selectedWorkspace: workspace, workspaces: [workspace] };
    Reflect.set(app, "speechInputSettings", snapshot);
    Reflect.set(app, "state", starterState);
    const starter = requiredTemplate(callAppMethod(app, "renderSessionStartScreen", starterState));

    const session = {
      id: "session-a",
      cwd: workspace.path,
      path: "/work/project-a/.pi/sessions/session-a.jsonl",
      created: "2026-08-13T00:00:00.000Z",
      modified: "2026-08-13T00:00:00.000Z",
      messageCount: 0,
      firstMessage: "",
    };
    const activeState: AppState = {
      ...starterState,
      selectedSession: session,
      sessions: [session],
      projectSessions: [session],
    };
    Reflect.set(app, "state", activeState);
    const active = app.render();

    expect(templateValueAfterMarker(starter, ".speechInputSettings=")).toBe(snapshot);
    expect(templateValueAfterMarker(active, ".speechInputSettings=")).toBe(snapshot);
  });

  it("ignores same revisions and closes the channel before a queued refresh can run", async () => {
    const current = speechInputSettingsResponse("00000000-0000-4000-8000-000000000001");
    const settings = vi.fn().mockResolvedValue(current);
    const { app, channel } = speechSettingsApp(settings);

    callAppMethod(app, "connectSpeechInputSettings");
    await flush();
    settings.mockClear();
    channel.emit(current.revision);
    await flush();
    expect(settings).not.toHaveBeenCalled();

    channel.emit("00000000-0000-4000-8000-000000000002");
    callAppMethod(app, "disconnectSpeechInputSettings");
    await flush();
    expect(settings).not.toHaveBeenCalled();
    expect(channel.close).toHaveBeenCalledOnce();
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

class FakeSpeechInputSettingsChannel {
  readonly published: string[] = [];
  readonly close = vi.fn();
  private onRevision: ((revision: string) => void) | undefined;

  bind(onRevision: (revision: string) => void): void {
    this.onRevision = onRevision;
  }

  publish(revision: string): void {
    this.published.push(revision);
  }

  emit(revision: string): void {
    if (this.onRevision === undefined) throw new Error("Speech channel has not been connected");
    this.onRevision(revision);
  }
}

function speechSettingsApp(settings: () => Promise<SpeechInputSettingsResponse>): { app: PiWebUiApp; channel: FakeSpeechInputSettingsChannel } {
  const channel = new FakeSpeechInputSettingsChannel();
  const app = new PiWebUiApp({
    speechInputApi: { settings },
    createSpeechInputSettingsChannel: (onRevision: (revision: string) => void) => {
      channel.bind(onRevision);
      return channel;
    },
  });
  return { app, channel };
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  if (resolve === undefined || reject === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve, reject };
}

function speechInputSettingsResponse(revision: string): SpeechInputSettingsResponse {
  return {
    contractVersion: 1,
    revision,
    settings: {
      provider: "auto",
      cloud: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe" },
    },
    credential: { configured: false, resolution: "missing" },
  };
}

function gatewayConfigResponse() {
  return {
    path: "/tmp/pi-webui/config.json",
    exists: true,
    config: {},
    effectiveConfig: {},
    envOverrides: {
      host: false,
      port: false,
      allowedHosts: false,
      spawnSessions: false,
      subsessions: false,
      agentCommand: false,
      agentDir: false,
      agentSessionDir: false,
    },
  };
}

function requiredTemplate(value: unknown): TemplateResult {
  if (!isTemplateResult(value)) throw new Error("Expected a Lit TemplateResult");
  return value;
}

function getAppProperty(app: PiWebUiApp, property: string): unknown {
  return Reflect.get(app, property);
}

function getDialogProperty(dialog: SettingsDialog, property: string): unknown {
  return Reflect.get(dialog, property);
}

function settingsDialogTemplate(app: PiWebUiApp): TemplateResult {
  const dialog = findTemplateContaining(app.render(), "<settings-dialog");
  if (dialog === undefined) throw new Error("PiWebUiApp did not render settings-dialog");
  return dialog;
}

async function callPrivateDialogPromise(dialog: SettingsDialog, methodName: string): Promise<void> {
  const method: unknown = Reflect.get(dialog, methodName);
  if (typeof method !== "function") throw new Error(`SettingsDialog.${methodName} is not callable`);
  const result: unknown = Reflect.apply(method, dialog, []);
  if (!(result instanceof Promise)) throw new Error(`SettingsDialog.${methodName} did not return a promise`);
  await result;
}

function callAppMethod(app: PiWebUiApp, methodName: string, ...args: readonly unknown[]): unknown {
  const method: unknown = Reflect.get(app, methodName);
  if (typeof method !== "function") throw new Error(`PiWebUiApp.${methodName} is not callable`);
  return Reflect.apply(method, app, args);
}

async function callAppPromise(app: PiWebUiApp, methodName: string, ...args: readonly unknown[]): Promise<void> {
  const result = callAppMethod(app, methodName, ...args);
  if (!(result instanceof Promise)) throw new Error(`PiWebUiApp.${methodName} did not return a promise`);
  await result;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function stubResumeDependencies(app: PiWebUiApp): void {
  const projectCatalog: unknown = Reflect.get(app, "projectCatalog");
  if (typeof projectCatalog === "object" && projectCatalog !== null) Reflect.set(projectCatalog, "refresh", vi.fn());
  Reflect.set(app, "renegotiateUnreadMachines", vi.fn(() => Promise.resolve(undefined)));
  Reflect.set(app, "refreshMachineActivities", vi.fn(() => Promise.resolve(undefined)));
  Reflect.set(app, "refreshWorkspaceDeletionRuns", vi.fn(() => Promise.resolve(undefined)));
  const sessions: unknown = Reflect.get(app, "sessions");
  if (typeof sessions === "object" && sessions !== null) Reflect.set(sessions, "refreshSelectedSession", vi.fn(() => Promise.resolve(undefined)));
}

function setPromptEditor(app: PiWebUiApp, promptEditor: { cancelSpeechInput: () => boolean }): void {
  Object.defineProperty(app, "promptEditor", { configurable: true, value: promptEditor });
}

function mediaQuery(query: string): MediaQueryList {
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

function replaceKeyboardHandler(app: PiWebUiApp) {
  const keyboard: unknown = Reflect.get(app, "keyboard");
  if (typeof keyboard !== "object" || keyboard === null || typeof Reflect.get(keyboard, "handle") !== "function") {
    throw new Error("PiWebUiApp keyboard dispatcher was unavailable");
  }
  const handle = vi.fn(() => false);
  if (!Reflect.set(keyboard, "handle", handle)) throw new Error("Could not replace PiWebUiApp keyboard dispatcher");
  return handle;
}

function invokeGlobalKeyDown(app: PiWebUiApp, event: KeyEventDouble): void {
  const handler: unknown = Reflect.get(app, "onKeyDown");
  if (typeof handler !== "function") throw new Error("PiWebUiApp global keydown handler was unavailable");
  Reflect.apply(handler, app, [event]);
}

function keyEvent(key: string): KeyEventDouble {
  const calls = { preventDefault: 0, stopPropagation: 0 };
  return {
    key,
    calls,
    preventDefault: () => { calls.preventDefault += 1; },
    stopPropagation: () => { calls.stopPropagation += 1; },
  };
}
