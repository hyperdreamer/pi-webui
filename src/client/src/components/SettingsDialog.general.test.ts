import { afterEach, describe, expect, it, vi } from "vitest";
import type { TemplateResult } from "lit";
import { configApi, pluginsApi, speechInputApi, type PiWebUiConfigResponse, type SpeechInputSettingsResponse, type SpeechInputSettingsUpdate } from "../api";
import { isTemplateResult, templateValueAfterMarker } from "../templateInspection.testSupport";
import { activeSettingsPanelTag, SettingsDialog } from "./SettingsDialog";
import { callDialogPromise, callDialogUpdated, configResponse, deferred, getDialogProperty, pluginsResponse, remoteMachine, secondRemoteMachine, setDialogProperty, speechInputSettingsResponse, stubWindowTimers } from "./SettingsDialog.testSupport";
import { SettingsGeneralPanel } from "./settings/SettingsGeneralPanel";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("settings-dialog general settings machine targeting", () => {
  it("routes each section to a single settings panel with no per-tab scope-note wrapper", () => {
    // The old global "scope-note"/"This tab edits:" wrapper is gone: each section
    // now maps to exactly one panel element. Assert that public routing contract
    // (`activeSettingsPanelTag`) instead of scraping the rendered template markup.
    expect(activeSettingsPanelTag("general")).toBe("settings-general-panel");
    expect(activeSettingsPanelTag("sessiond")).toBe("settings-sessiond-panel");
    expect(activeSettingsPanelTag("packages")).toBe("settings-packages-panel");
    expect(activeSettingsPanelTag("plugins")).toBe("settings-plugins-panel");
    expect(activeSettingsPanelTag("shortcuts")).toBe("settings-shortcuts-panel");
    expect(activeSettingsPanelTag("utilitymodels")).toBe("settings-utility-models-panel");
  });

  it("keeps gateway server config saves on the gateway config endpoint", async () => {
    stubWindowTimers();
    const savedConfig = configResponse({ host: "0.0.0.0", port: 9000, allowedHosts: true });
    const saveSpy = vi.spyOn(configApi, "saveConfig").mockResolvedValue(savedConfig);
    const onConfigSaved = vi.fn();
    const dialog = new SettingsDialog();
    dialog.onConfigSaved = onConfigSaved;

    await callDialogPromise(dialog, "saveConfig", { host: "0.0.0.0", port: 9000, allowedHosts: true });

    expect(saveSpy.mock.calls).toEqual([[{ host: "0.0.0.0", port: 9000, allowedHosts: true }]]);
    expect(getDialogProperty(dialog, "configResponse")).toBe(savedConfig);
    expect(onConfigSaved).toHaveBeenCalledWith({ host: "0.0.0.0", port: 9000, allowedHosts: true });
    expect(getDialogProperty(dialog, "savedMessage")).toBe("Config saved.");
    expect(getDialogProperty(dialog, "saving")).toBe(false);
  });

  it("loads file access and upload config from the selected machine", async () => {
    const config = configResponse({ pathAccess: { allowedPaths: ["/mnt/share"] }, uploads: { defaultFolder: "manual/uploads" } });
    const configSpy = vi.spyOn(configApi, "config").mockResolvedValue(config);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    await callDialogPromise(dialog, "loadAccessConfigForTarget");

    expect(configSpy.mock.calls).toEqual([["remote-a"]]);
    expect(getDialogProperty(dialog, "accessConfigResponse")).toBe(config);
    expect(getDialogProperty(dialog, "accessError")).toBe("");
    expect(getDialogProperty(dialog, "accessLoading")).toBe(false);
  });

  it("saves selected-machine file access and upload config through the selected-machine endpoint", async () => {
    stubWindowTimers();
    const patch = { pathAccess: { allowedPaths: ["/mnt/share", "~/SDKs"] }, uploads: { defaultFolder: "manual/uploads" } };
    const savedConfig = configResponse(patch);
    const saveSpy = vi.spyOn(configApi, "saveConfig").mockResolvedValue(savedConfig);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    await callDialogPromise(dialog, "saveMachineAccessConfig", patch);

    expect(saveSpy.mock.calls).toEqual([[patch, "remote-a"]]);
    expect(getDialogProperty(dialog, "accessConfigResponse")).toBe(savedConfig);
    expect(getDialogProperty(dialog, "configResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "savedMessage")).toBe("Config saved.");
    expect(getDialogProperty(dialog, "saving")).toBe(false);
  });

  it("merges local selected-machine access saves into gateway config without dropping gateway-only values", async () => {
    stubWindowTimers();
    const gatewayConfig = configResponse({
      host: "127.0.0.1",
      port: 8808,
      allowedHosts: ["gateway.local"],
      shortcuts: { "core:view.chat": "mod+1" },
      plugins: { info: { enabled: true } },
      spawnSessions: false,
      pathAccess: { allowedPaths: ["/old"] },
      uploads: { defaultFolder: "old/uploads" },
      maxUploadBytes: 1234,
    });
    const patch = { pathAccess: { allowedPaths: ["~/SDKs"] }, uploads: {} };
    const savedConfig = configResponse({ pathAccess: { allowedPaths: ["~/SDKs"] }, uploads: {}, maxUploadBytes: 5678 });
    const saveSpy = vi.spyOn(configApi, "saveConfig").mockResolvedValue(savedConfig);
    const onConfigSaved = vi.fn();
    const dialog = new SettingsDialog();
    dialog.onConfigSaved = onConfigSaved;
    setDialogProperty(dialog, "configResponse", gatewayConfig);

    await callDialogPromise(dialog, "saveMachineAccessConfig", patch);

    expect(saveSpy.mock.calls).toEqual([[patch, "local"]]);
    expect(getDialogProperty(dialog, "accessConfigResponse")).toBe(savedConfig);
    expect(getDialogProperty(dialog, "configResponse")).toMatchObject({
      config: {
        host: "127.0.0.1",
        port: 8808,
        allowedHosts: ["gateway.local"],
        shortcuts: { "core:view.chat": "mod+1" },
        plugins: { info: { enabled: true } },
        spawnSessions: false,
        pathAccess: { allowedPaths: ["~/SDKs"] },
        uploads: {},
        maxUploadBytes: 5678,
      },
      effectiveConfig: {
        host: "127.0.0.1",
        port: 8808,
        allowedHosts: ["gateway.local"],
        shortcuts: { "core:view.chat": "mod+1" },
        plugins: { info: { enabled: true } },
        spawnSessions: false,
        pathAccess: { allowedPaths: ["~/SDKs"] },
        uploads: {},
        maxUploadBytes: 5678,
      },
    });
    expect(onConfigSaved).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 8808,
      allowedHosts: ["gateway.local"],
      shortcuts: { "core:view.chat": "mod+1" },
      plugins: { info: { enabled: true } },
      spawnSessions: false,
      pathAccess: { allowedPaths: ["~/SDKs"] },
      uploads: {},
      maxUploadBytes: 5678,
    });
  });

  it("ignores stale file access load responses after the selected machine changes", async () => {
    const load = deferred<PiWebUiConfigResponse>();
    vi.spyOn(configApi, "config").mockReturnValue(load.promise);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    const loadPromise = callDialogPromise(dialog, "loadAccessConfigForTarget");
    expect(getDialogProperty(dialog, "accessLoading")).toBe(true);

    dialog.machine = secondRemoteMachine;
    callDialogUpdated(dialog, new Map([["machine", remoteMachine]]));
    load.resolve(configResponse({ pathAccess: { allowedPaths: ["/stale"] } }));
    await loadPromise;

    expect(getDialogProperty(dialog, "accessConfigResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "accessError")).toBe("");
    expect(getDialogProperty(dialog, "accessLoading")).toBe(false);
  });

  it("ignores stale file access save responses after the selected machine changes", async () => {
    const save = deferred<PiWebUiConfigResponse>();
    vi.spyOn(configApi, "saveConfig").mockReturnValue(save.promise);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    const savePromise = callDialogPromise(dialog, "saveMachineAccessConfig", { pathAccess: { allowedPaths: ["/mnt/share"] }, uploads: { defaultFolder: "manual" } });
    expect(getDialogProperty(dialog, "saving")).toBe(true);

    dialog.machine = secondRemoteMachine;
    callDialogUpdated(dialog, new Map([["machine", remoteMachine]]));
    save.resolve(configResponse({ pathAccess: { allowedPaths: ["/mnt/share"] }, uploads: { defaultFolder: "manual" } }));
    await savePromise;

    expect(getDialogProperty(dialog, "accessConfigResponse")).toBeUndefined();
    expect(getDialogProperty(dialog, "savedMessage")).toBe("");
    expect(getDialogProperty(dialog, "saving")).toBe(false);
  });

  it("shows selected-machine file access errors with the selected target name", async () => {
    vi.spyOn(configApi, "config").mockRejectedValue(new Error("Remote machine unavailable"));
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    await callDialogPromise(dialog, "loadAccessConfigForTarget");

    expect(getDialogProperty(dialog, "accessError")).toBe("Failed to load file access/upload config from Lab Mac (remote machine): Could not reach Lab Mac for selected-machine settings. Check the machine connection and try again.");
    expect(getDialogProperty(dialog, "accessLoading")).toBe(false);
  });

  it("forwards gateway host speech state only to the local General panel", () => {
    const status = { available: true, voices: [{ name: "Ada", language: "en-US" }] };
    const onReloadHostSpeech = vi.fn();
    const dialog = new SettingsDialog();
    if (!Reflect.set(dialog, "showHostSpeechSettings", true)) throw new Error("Could not configure host speech visibility");
    if (!Reflect.set(dialog, "hostSpeechStatus", status)) throw new Error("Could not configure host speech status");
    if (!Reflect.set(dialog, "hostSpeechStatusLoading", true)) throw new Error("Could not configure host speech loading");
    if (!Reflect.set(dialog, "onReloadHostSpeech", onReloadHostSpeech)) throw new Error("Could not configure host speech reload");

    const localGeneral = renderActiveSection(dialog);
    expect(templateValueAfterMarker(localGeneral, ".showHostSpeechSettings=")).toBe(true);
    expect(templateValueAfterMarker(localGeneral, ".hostSpeechStatus=")).toBe(status);
    expect(templateValueAfterMarker(localGeneral, ".hostSpeechStatusLoading=")).toBe(true);
    expect(templateValueAfterMarker(localGeneral, ".onReloadHostSpeech=")).toBe(onReloadHostSpeech);

    dialog.machine = remoteMachine;
    const remoteGeneral = renderActiveSection(dialog);
    expect(templateValueAfterMarker(remoteGeneral, ".showHostSpeechSettings=")).toBe(false);
    expect(templateValueAfterMarker(remoteGeneral, ".hostSpeechStatus=")).toBeUndefined();
    expect(templateValueAfterMarker(remoteGeneral, ".hostSpeechStatusLoading=")).toBe(false);
    expect(templateValueAfterMarker(remoteGeneral, ".onReloadHostSpeech=")).toBeUndefined();
  });
  it("forwards the app-owned speech settings snapshot and controls to the General panel for remote selections", () => {
    const dialog = new SettingsDialog();
    const snapshot = speechInputSettingsResponse();
    dialog.machine = remoteMachine;
    dialog.speechInputSettings = snapshot;

    const general = renderActiveSection(dialog);

    expect(templateValueAfterMarker(general, ".speechInputSettings=")).toBe(snapshot);
    expect(templateValueAfterMarker(general, ".onSaveSpeechInput=")).toEqual(expect.any(Function));
    expect(templateValueAfterMarker(general, ".showHostSpeechSettings=")).toBe(false);
  });

  it("loads speech input settings with the gateway reload and notifies the app only for the accepted response", async () => {
    const config = configResponse({ host: "127.0.0.1" });
    const snapshot = speechInputSettingsResponse();
    const onSpeechInputSettingsLoaded = vi.fn();
    vi.spyOn(configApi, "config").mockResolvedValue(config);
    vi.spyOn(pluginsApi, "plugins").mockResolvedValue(pluginsResponse([]));
    vi.spyOn(speechInputApi, "settings").mockResolvedValue(snapshot);
    const dialog = new SettingsDialog();
    dialog.onSpeechInputSettingsLoaded = onSpeechInputSettingsLoaded;

    await callDialogPromise(dialog, "loadConfig");

    expect(speechInputApi.settings).toHaveBeenCalledOnce();
    expect(getDialogProperty(dialog, "speechInputSettings")).toBe(snapshot);
    expect(onSpeechInputSettingsLoaded).toHaveBeenCalledExactlyOnceWith(snapshot);
  });

  it("drops a stale speech settings reload before it can notify the app", async () => {
    const firstConfig = deferred<PiWebUiConfigResponse>();
    const firstPlugins = deferred<ReturnType<typeof pluginsResponse>>();
    const firstSpeech = deferred<SpeechInputSettingsResponse>();
    const current = speechInputSettingsResponse({ revision: "00000000-0000-4000-8000-000000000002" });
    const stale = speechInputSettingsResponse({ revision: "00000000-0000-4000-8000-000000000003" });
    vi.spyOn(configApi, "config")
      .mockReturnValueOnce(firstConfig.promise)
      .mockResolvedValueOnce(configResponse({ host: "127.0.0.1" }));
    vi.spyOn(pluginsApi, "plugins")
      .mockReturnValueOnce(firstPlugins.promise)
      .mockResolvedValueOnce(pluginsResponse([]));
    vi.spyOn(speechInputApi, "settings")
      .mockReturnValueOnce(firstSpeech.promise)
      .mockResolvedValueOnce(current);
    const dialog = new SettingsDialog();
    const onSpeechInputSettingsLoaded = vi.fn();
    dialog.onSpeechInputSettingsLoaded = onSpeechInputSettingsLoaded;

    const staleLoad = callDialogPromise(dialog, "loadConfig");
    await callDialogPromise(dialog, "loadConfig");
    firstConfig.resolve(configResponse({ host: "0.0.0.0" }));
    firstPlugins.resolve(pluginsResponse([]));
    firstSpeech.resolve(stale);
    await staleLoad;

    expect(getDialogProperty(dialog, "speechInputSettings")).toBe(current);
    expect(onSpeechInputSettingsLoaded).toHaveBeenCalledExactlyOnceWith(current);
  });

  it("suppresses a speech load that settles after a newer speech save", async () => {
    stubWindowTimers();
    const staleSpeech = deferred<SpeechInputSettingsResponse>();
    const saved = speechInputSettingsResponse({ revision: "00000000-0000-4000-8000-000000000004" });
    vi.spyOn(configApi, "config").mockResolvedValue(configResponse({ host: "127.0.0.1" }));
    vi.spyOn(pluginsApi, "plugins").mockResolvedValue(pluginsResponse([]));
    vi.spyOn(speechInputApi, "settings").mockReturnValue(staleSpeech.promise);
    vi.spyOn(speechInputApi, "saveSettings").mockResolvedValue(saved);
    const onSpeechInputSettingsLoaded = vi.fn();
    const onSpeechInputSettingsSaved = vi.fn();
    const dialog = new SettingsDialog();
    dialog.onSpeechInputSettingsLoaded = onSpeechInputSettingsLoaded;
    dialog.onSpeechInputSettingsSaved = onSpeechInputSettingsSaved;

    const loadPromise = callDialogPromise(dialog, "loadConfig");
    const current = speechInputSettingsResponse();
    const update: SpeechInputSettingsUpdate = {
      expectedRevision: current.revision,
      settings: current.settings,
      credential: { action: "preserve" },
    };
    await callDialogPromise(dialog, "saveSpeechInputSettings", update);
    staleSpeech.resolve(speechInputSettingsResponse({ revision: "00000000-0000-4000-8000-000000000005" }));
    await loadPromise;

    expect(getDialogProperty(dialog, "speechInputSettings")).toBe(saved);
    expect(onSpeechInputSettingsLoaded).not.toHaveBeenCalled();
    expect(onSpeechInputSettingsSaved).toHaveBeenCalledExactlyOnceWith(saved);
  });

  it("force-adopts the latest app-owned snapshot after an explicit reload is superseded", async () => {
    const staleSpeech = deferred<SpeechInputSettingsResponse>();
    const initial = speechInputSettingsResponse();
    const newer = speechInputSettingsResponse({
      revision: "00000000-0000-4000-8000-000000000006",
      settings: { provider: "browser", language: "fr-FR", cloud: { baseUrl: "https://gateway.example.test/v1", model: "whisper-1" } },
    });
    const stale = speechInputSettingsResponse({ revision: "00000000-0000-4000-8000-000000000007" });
    vi.spyOn(configApi, "config").mockResolvedValue(configResponse({ host: "127.0.0.1" }));
    vi.spyOn(pluginsApi, "plugins").mockResolvedValue(pluginsResponse([]));
    vi.spyOn(speechInputApi, "settings").mockReturnValue(staleSpeech.promise);
    let appRequestSeq = 1;
    const onSpeechInputSettingsLoaded = vi.fn();
    const dialog = new SettingsDialog();
    dialog.speechInputSettings = initial;
    dialog.speechInputSettingsRequestSeq = appRequestSeq;
    dialog.isSpeechInputSettingsRequestCurrent = (requestSeq) => requestSeq === appRequestSeq;
    dialog.onSpeechInputSettingsLoaded = onSpeechInputSettingsLoaded;
    const panel = dirtySpeechInputPanel(initial);

    const reload = callDialogPromise(dialog, "loadConfig", true);
    appRequestSeq += 1;
    dialog.speechInputSettings = newer;
    deliverSpeechInputSettings(panel, newer);

    expect(getPanelProperty(panel, "speechInputStale")).toBe(true);
    expect(getPanelProperty(panel, "credentialEntryDirty")).toBe(true);
    expect(getPanelPassword(panel)).toBe("$SPEECH_KEY");

    staleSpeech.resolve(stale);
    await reload;

    expect(getDialogProperty(dialog, "speechInputSettings")).toBe(newer);
    expect(onSpeechInputSettingsLoaded).not.toHaveBeenCalled();
    expect(getDialogProperty(dialog, "speechInputAdoptionGeneration")).toBe(1);

    panel.speechInputAdoptionGeneration = 1;
    callPanelMethod(panel, "willUpdate", new Map([["speechInputAdoptionGeneration", 0]]));
    expect(getPanelProperty(panel, "speechInputDraftDirty")).toBe(false);
    expect(getPanelProperty(panel, "credentialEntryDirty")).toBe(false);
    expect(getPanelProperty(panel, "speechInputStale")).toBe(false);
    expect(getPanelPassword(panel)).toBe("");
  });

  it("returns a successful speech save to the panel and notifies the app with the new revision", async () => {
    stubWindowTimers();
    const initial = speechInputSettingsResponse();
    const saved = speechInputSettingsResponse({ revision: "00000000-0000-4000-8000-000000000004" });
    const update: SpeechInputSettingsUpdate = {
      expectedRevision: initial.revision,
      settings: initial.settings,
      credential: { action: "preserve" },
    };
    vi.spyOn(speechInputApi, "saveSettings").mockResolvedValue(saved);
    const onSpeechInputSettingsSaved = vi.fn();
    const dialog = new SettingsDialog();
    dialog.speechInputSettings = initial;
    dialog.onSpeechInputSettingsSaved = onSpeechInputSettingsSaved;

    await callDialogPromise(dialog, "saveSpeechInputSettings", update);

    expect(speechInputApi.saveSettings).toHaveBeenCalledExactlyOnceWith(update);
    expect(getDialogProperty(dialog, "speechInputSettings")).toBe(saved);
    expect(getDialogProperty(dialog, "speechInputAdoptionGeneration")).toBe(1);
    expect(onSpeechInputSettingsSaved).toHaveBeenCalledExactlyOnceWith(saved);
  });
});

function renderActiveSection(dialog: SettingsDialog): TemplateResult {
  const render: unknown = Reflect.get(dialog, "renderActiveSection");
  if (typeof render !== "function") throw new Error("SettingsDialog.renderActiveSection is not callable");
  const result: unknown = Reflect.apply(render, dialog, []);
  if (!isTemplateResult(result)) throw new Error("SettingsDialog.renderActiveSection did not return a template");
  return result;
}

function dirtySpeechInputPanel(initial: SpeechInputSettingsResponse): SettingsGeneralPanel {
  const panel = new SettingsGeneralPanel();
  panel.speechInputSecureContext = true;
  panel.speechInputSettings = initial;
  let password = "$SPEECH_KEY";
  Object.defineProperty(panel, "speechInputApiKeyInput", {
    configurable: true,
    get: () => ({
      get value(): string {
        return password;
      },
      set value(next: string) {
        password = next;
      },
    }),
  });
  callPanelMethod(panel, "willUpdate", new Map([["speechInputSettings", undefined]]));
  callPanelMethod(panel, "updateSpeechInputDraft", { model: "unsaved-model" });
  callPanelMethod(panel, "markSpeechInputCredentialEntryDirty");
  return panel;
}

function deliverSpeechInputSettings(panel: SettingsGeneralPanel, response: SpeechInputSettingsResponse): void {
  const previous = panel.speechInputSettings;
  panel.speechInputSettings = response;
  callPanelMethod(panel, "willUpdate", new Map([["speechInputSettings", previous]]));
}

function getPanelPassword(panel: SettingsGeneralPanel): string {
  const input: unknown = Reflect.get(panel, "speechInputApiKeyInput");
  if (typeof input !== "object" || input === null) throw new Error("SettingsGeneralPanel password input was unavailable");
  const value: unknown = Reflect.get(input, "value");
  if (typeof value !== "string") throw new Error("SettingsGeneralPanel password value was unavailable");
  return value;
}

function getPanelProperty(panel: SettingsGeneralPanel, property: string): unknown {
  return Reflect.get(panel, property);
}

function callPanelMethod(panel: SettingsGeneralPanel, methodName: string, ...args: readonly unknown[]): unknown {
  const method: unknown = Reflect.get(panel, methodName);
  if (typeof method !== "function") throw new Error(`SettingsGeneralPanel.${methodName} is not callable`);
  return Reflect.apply(method, panel, args);
}
