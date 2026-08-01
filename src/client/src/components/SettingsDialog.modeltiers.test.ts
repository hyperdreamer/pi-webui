import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_WEBUI_CAPABILITIES } from "../../../shared/capabilities";
import type { ModelTierSettingsResponse } from "../../../shared/apiTypes";
import { modelTiersApi } from "../api";
import { activeSettingsPanelTag, SettingsDialog } from "./SettingsDialog";
import {
  callDialogPromise,
  configResponse,
  deferred,
  getDialogProperty,
  remoteMachine,
  secondRemoteMachine,
  setDialogProperty,
  stubWindowTimers,
} from "./SettingsDialog.testSupport";

const sampleResponse: ModelTierSettingsResponse = {
  contractVersion: 1,
  ladder: {
    economy: { model: { provider: "openai", id: "gpt-4o-mini" }, thinkingLevel: "off" },
    fast: { model: { provider: "openai", id: "gpt-4o-mini" }, thinkingLevel: "off" },
    standard: { model: { provider: "openai", id: "gpt-4o" }, thinkingLevel: "off" },
    advanced: { model: { provider: "openai", id: "gpt-4o" }, thinkingLevel: "off" },
    capable: { model: { provider: "openai", id: "o3-mini" }, thinkingLevel: "off" },
    frontier: { model: { provider: "openai", id: "o3-mini" }, thinkingLevel: "off" },
  },
  models: [
    { model: { provider: "openai", id: "gpt-4o-mini" }, name: "GPT-4o Mini", thinkingLevels: [] },
    { model: { provider: "openai", id: "gpt-4o" }, name: "GPT-4o", thinkingLevels: [] },
    { model: { provider: "openai", id: "o3-mini" }, name: "o3-mini", thinkingLevels: ["low", "medium", "high"] },
  ],
  rows: {
    economy: { valid: true },
    fast: { valid: true },
    standard: { valid: true },
    advanced: { valid: true },
    capable: { valid: true },
    frontier: { valid: true },
  },
  valid: true,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("settings-dialog model tiers machine targeting", () => {
  it("routes modeltiers section to settings-model-tiers-panel", () => {
    expect(activeSettingsPanelTag("modeltiers")).toBe("settings-model-tiers-panel");
  });

  it("loads model tier settings from the selected machine", async () => {
    const settingsSpy = vi.spyOn(modelTiersApi, "settings").mockResolvedValue(sampleResponse);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    await callDialogPromise(dialog, "loadModelTiersForTarget");

    expect(settingsSpy.mock.calls).toEqual([["remote-a"]]);
    expect(getDialogProperty(dialog, "modelTiersConfigResponse")).toBe(sampleResponse);
    expect(getDialogProperty(dialog, "modelTiersError")).toBe("");
    expect(getDialogProperty(dialog, "modelTiersLoading")).toBe(false);
  });

  it("ignores stale model-tier load responses after the selected machine changes", async () => {
    const load = deferred<ModelTierSettingsResponse>();
    vi.spyOn(modelTiersApi, "settings").mockReturnValue(load.promise);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    const loadPromise = callDialogPromise(dialog, "loadModelTiersForTarget");
    expect(getDialogProperty(dialog, "modelTiersLoading")).toBe(true);

    dialog.machine = secondRemoteMachine;
    load.resolve(sampleResponse);
    await loadPromise;

    expect(getDialogProperty(dialog, "modelTiersConfigResponse")).toBeUndefined();
  });

  it("saves selected-machine model tiers through the selected-machine endpoint", async () => {
    stubWindowTimers();
    const ladder = sampleResponse.ladder;
    expect(ladder).toBeDefined();
    if (ladder === undefined) return;
    const savedResponse: ModelTierSettingsResponse = { ...sampleResponse };
    const saveSpy = vi.spyOn(modelTiersApi, "save").mockResolvedValue(savedResponse);
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;

    await callDialogPromise(dialog, "saveModelTiers", ladder);

    expect(saveSpy.mock.calls).toEqual([[ladder, "remote-a"]]);
    expect(getDialogProperty(dialog, "modelTiersConfigResponse")).toBe(savedResponse);
    expect(getDialogProperty(dialog, "savedMessage")).toBe("Config saved.");
    expect(getDialogProperty(dialog, "saving")).toBe(false);
  });

  it("updates local config response and calls onConfigSaved when local model tiers are saved", async () => {
    stubWindowTimers();
    const ladder = sampleResponse.ladder;
    expect(ladder).toBeDefined();
    if (ladder === undefined) return;
    const initialConfig = configResponse({ host: "127.0.0.1" });
    const savedResponse: ModelTierSettingsResponse = { ...sampleResponse };
    vi.spyOn(modelTiersApi, "save").mockResolvedValue(savedResponse);
    const onConfigSaved = vi.fn();
    const dialog = new SettingsDialog();
    dialog.onConfigSaved = onConfigSaved;
    setDialogProperty(dialog, "configResponse", initialConfig);

    await callDialogPromise(dialog, "saveModelTiers", ladder);

    expect(getDialogProperty(dialog, "configResponse")).toMatchObject({
      config: { host: "127.0.0.1", modelTiers: ladder },
      effectiveConfig: { host: "127.0.0.1", modelTiers: ladder },
    });
    expect(onConfigSaved).toHaveBeenCalledWith(expect.objectContaining({ host: "127.0.0.1", modelTiers: ladder }));
  });

  it("fails save gracefully and retains error state when API fails", async () => {
    vi.spyOn(modelTiersApi, "save").mockRejectedValue(new Error("Server error"));
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    const ladder = sampleResponse.ladder;
    expect(ladder).toBeDefined();
    if (ladder === undefined) return;

    await callDialogPromise(dialog, "saveModelTiers", ladder);

    expect(getDialogProperty(dialog, "modelTiersError")).toBe(
      "Failed to save model tier settings on Lab Mac (remote machine): Server error",
    );
    expect(getDialogProperty(dialog, "saving")).toBe(false);
  });

  it("handles unsupported remote capability without making requests", async () => {
    const settingsSpy = vi.spyOn(modelTiersApi, "settings");
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    dialog.machineRuntime = {
      machineId: remoteMachine.id,
      ok: true,
      checkedAt: "now",
      capabilities: [],
    };

    await callDialogPromise(dialog, "loadModelTiersForTarget");

    expect(settingsSpy).not.toHaveBeenCalled();
    expect(getDialogProperty(dialog, "modelTiersLoading")).toBe(false);
    expect(getDialogProperty(dialog, "modelTiersError")).toBe(
      "Selected-machine settings are not available on Lab Mac. Update and restart PI WEBUI on that machine, then try again.",
    );
  });

  it("treats remote machine advertising settings.selectedMachine without settings.modelTiers as unsupported", async () => {
    const settingsSpy = vi.spyOn(modelTiersApi, "settings");
    const dialog = new SettingsDialog();
    dialog.machine = remoteMachine;
    dialog.machineRuntime = {
      machineId: remoteMachine.id,
      ok: true,
      checkedAt: "now",
      capabilities: [PI_WEBUI_CAPABILITIES.selectedMachineSettings],
    };

    await callDialogPromise(dialog, "loadModelTiersForTarget");

    expect(settingsSpy).not.toHaveBeenCalled();
    expect(getDialogProperty(dialog, "modelTiersLoading")).toBe(false);
    expect(getDialogProperty(dialog, "modelTiersError")).toBe(
      "Selected-machine settings are not available on Lab Mac. Update and restart PI WEBUI on that machine, then try again.",
    );
  });
});
