import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_WEBUI_CAPABILITIES } from "../../../shared/capabilities";
import type { UtilityModelSettingsResponse, UtilityModelSettingsResponseV1, UtilityModelSettingsResponseV2, UtilityModelSettingsUpdate } from "../../../shared/apiTypes";
import { utilityModelsApi } from "../api";
import { activeSettingsPanelTag, SettingsDialog } from "./SettingsDialog";
import {
  callDialogPromise,
  callDialogUpdated,
  configResponse,
  deferred,
  getDialogProperty,
  remoteMachine,
  secondRemoteMachine,
  setDialogProperty,
  stubWindowTimers,
} from "./SettingsDialog.testSupport";

const lightweight = { provider: "openai", id: "gpt-small" };
const context = { provider: "anthropic", id: "claude-context" };

function response(overrides: Partial<UtilityModelSettingsResponseV1> = {}): UtilityModelSettingsResponseV1 {
  return {
    contractVersion: 1,
    settings: { lightweight, context },
    models: [
      { model: lightweight, name: "Small" },
      { model: context, name: "Context" },
    ],
    slots: {
      lightweight: { valid: true },
      context: { valid: true },
    },
    valid: true,
    ...overrides,
  };
}

function responseV2(overrides: Partial<UtilityModelSettingsResponseV2> = {}): UtilityModelSettingsResponseV2 {
  return {
    contractVersion: 2,
    settings: { lightweight: { ...lightweight, thinkingLevel: "max" }, context },
    models: [
      { model: lightweight, name: "Small", thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
      { model: context, name: "Context", thinkingLevels: ["off", "max"] },
    ],
    slots: {
      lightweight: { valid: true },
      context: { valid: true },
    },
    valid: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("settings-dialog utility model machine targeting", () => {
  it("routes utilitymodels section to settings-utility-models-panel", () => {
    expect(activeSettingsPanelTag("utilitymodels")).toBe("settings-utility-models-panel");
  });

  it("loads utility model settings from the selected machine", async () => {
    const settings = response();
    const settingsSpy = vi.spyOn(utilityModelsApi, "settings").mockResolvedValue(settings);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    await callDialogPromise(dialog, "loadUtilityModelsForTarget");

    expect(settingsSpy.mock.calls).toEqual([["remote-a"]]);
    expect(getDialogProperty(dialog, "utilityModelsConfigResponse")).toBe(settings);
    expect(getDialogProperty(dialog, "utilityModelsError")).toBe("");
    expect(getDialogProperty(dialog, "utilityModelsLoading")).toBe(false);
  });

  it("ignores stale utility model load responses after the selected machine changes", async () => {
    const load = deferred<UtilityModelSettingsResponse>();
    vi.spyOn(utilityModelsApi, "settings").mockReturnValue(load.promise);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    const loadPromise = callDialogPromise(dialog, "loadUtilityModelsForTarget");
    expect(getDialogProperty(dialog, "utilityModelsLoading")).toBe(true);

    dialog.machine = secondRemoteMachine;
    load.resolve(response());
    await loadPromise;

    expect(getDialogProperty(dialog, "utilityModelsConfigResponse")).toBeUndefined();
  });

  it("saves utility model settings using the loaded contract version through the selected-machine endpoint", async () => {
    stubWindowTimers();
    const update = { lightweight, context: null } satisfies UtilityModelSettingsUpdate;
    const loaded = responseV2();
    const saved = responseV2({ settings: { lightweight } });
    const saveSpy = vi.spyOn(utilityModelsApi, "save").mockResolvedValue(saved);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    setDialogProperty(dialog, "utilityModelsConfigResponse", loaded);

    await callDialogPromise(dialog, "saveUtilityModels", update);

    expect(saveSpy.mock.calls).toEqual([[update, loaded.contractVersion, "remote-a"]]);
    expect(getDialogProperty(dialog, "utilityModelsConfigResponse")).toBe(saved);
    expect(getDialogProperty(dialog, "savedMessage")).toBe("Config saved.");
    expect(getDialogProperty(dialog, "saving")).toBe(false);
  });

  it("does not save utility model settings before their response is loaded", async () => {
    const saveSpy = vi.spyOn(utilityModelsApi, "save");
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    await callDialogPromise(dialog, "saveUtilityModels", { lightweight, context });

    expect(saveSpy).not.toHaveBeenCalled();
    expect(getDialogProperty(dialog, "utilityModelsError")).toBe(
      "Utility model settings must be loaded before saving.",
    );
    expect(getDialogProperty(dialog, "saving")).toBe(false);
  });

  it("merges confirmed local utility settings into both gateway config views", async () => {
    stubWindowTimers();
    const initialConfig = configResponse({
      host: "127.0.0.1",
      utilityModels: { lightweight, context },
    });
    const confirmedSettings = { context };
    const saved = response({ settings: confirmedSettings });
    vi.spyOn(utilityModelsApi, "save").mockResolvedValue(saved);
    const onConfigSaved = vi.fn();
    const dialog = new SettingsDialog();
    dialog.onConfigSaved = onConfigSaved;
    setDialogProperty(dialog, "configResponse", initialConfig);
    setDialogProperty(dialog, "utilityModelsConfigResponse", response());

    await callDialogPromise(dialog, "saveUtilityModels", { lightweight: null, context });

    expect(getDialogProperty(dialog, "configResponse")).toMatchObject({
      config: { host: "127.0.0.1", utilityModels: confirmedSettings },
      effectiveConfig: { host: "127.0.0.1", utilityModels: confirmedSettings },
    });
    expect(onConfigSaved).toHaveBeenCalledWith({ host: "127.0.0.1", utilityModels: confirmedSettings });
  });

  it("avoids utility model requests when a remote machine lacks the granular capability", async () => {
    const settingsSpy = vi.spyOn(utilityModelsApi, "settings");
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    dialog.machineRuntime = {
      machineId: remoteMachine.id,
      ok: true,
      checkedAt: "now",
      capabilities: [PI_WEBUI_CAPABILITIES.selectedMachineSettings, PI_WEBUI_CAPABILITIES.modelTierSettings],
    };

    await callDialogPromise(dialog, "loadUtilityModelsForTarget");

    expect(settingsSpy).not.toHaveBeenCalled();
    expect(getDialogProperty(dialog, "utilityModelsLoading")).toBe(false);
    expect(getDialogProperty(dialog, "utilityModelsError")).toBe(
      "Selected-machine settings are not available on Lab Mac. Update and restart PI WEBUI on that machine, then try again.",
    );
  });

  it("retains task-specific utility model load and save errors", async () => {
    const loadDialog = new SettingsDialog();
    loadDialog.machine = remoteMachine;
    vi.spyOn(utilityModelsApi, "settings").mockRejectedValue(new Error("Load failed"));

    await callDialogPromise(loadDialog, "loadUtilityModelsForTarget");

    expect(getDialogProperty(loadDialog, "utilityModelsError")).toBe(
      "Failed to load utility model settings from Lab Mac (remote machine): Load failed",
    );

    vi.restoreAllMocks();
    vi.spyOn(utilityModelsApi, "save").mockRejectedValue(new Error("Save failed"));
    const saveDialog = new SettingsDialog();
    saveDialog.machine = remoteMachine;
    setDialogProperty(saveDialog, "utilityModelsConfigResponse", response());

    await callDialogPromise(saveDialog, "saveUtilityModels", { lightweight, context });

    expect(getDialogProperty(saveDialog, "utilityModelsError")).toBe(
      "Failed to save utility model settings on Lab Mac (remote machine): Save failed",
    );
    expect(getDialogProperty(saveDialog, "saving")).toBe(false);
  });

  it("resets and reloads utility state when its capability changes without reloading model tiers", () => {
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    dialog.machineRuntime = {
      machineId: remoteMachine.id,
      ok: true,
      checkedAt: "now",
      capabilities: [PI_WEBUI_CAPABILITIES.modelTierSettings, PI_WEBUI_CAPABILITIES.utilityModelSettings],
    };
    setDialogProperty(dialog, "utilityModelsConfigResponse", response());
    const loadUtilityModels = vi.fn(() => Promise.resolve());
    const loadModelTiers = vi.fn(() => Promise.resolve());
    expect(Reflect.set(dialog, "loadUtilityModelsForTarget", loadUtilityModels)).toBe(true);
    expect(Reflect.set(dialog, "loadModelTiersForTarget", loadModelTiers)).toBe(true);
    Object.defineProperty(dialog, "isConnected", { configurable: true, value: true });

    callDialogUpdated(dialog, new Map([["machineRuntime", {
      machineId: remoteMachine.id,
      ok: true,
      checkedAt: "before",
      capabilities: [PI_WEBUI_CAPABILITIES.modelTierSettings],
    }]]));

    expect(getDialogProperty(dialog, "utilityModelsConfigResponse")).toBeUndefined();
    expect(loadUtilityModels).toHaveBeenCalledWith(expect.objectContaining({ id: remoteMachine.id }));
    expect(loadModelTiers).not.toHaveBeenCalled();
  });
});
