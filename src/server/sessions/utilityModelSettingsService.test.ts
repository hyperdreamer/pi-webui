import { describe, expect, it, vi } from "vitest";
import type { UtilityModelSettings, UtilityModelSettingsResponse } from "../../shared/apiTypes.js";
import { createUtilityModelSettingsService, type UtilityModelSettingsConfig } from "./utilityModelSettingsService.js";

interface TestModel {
  provider: string;
  id: string;
  name: string;
}

const availableModels: readonly TestModel[] = [
  { provider: "acme", id: "small", name: "Acme Small" },
  { provider: "acme", id: "large", name: "Acme Large" },
];

const configuredSettings: UtilityModelSettings = {
  lightweight: { provider: "acme", id: "small" },
  context: { provider: "acme", id: "large" },
};

describe("utility model settings service", () => {
  it("refreshes offline, projects available models without thinking levels, and preserves configured settings", async () => {
    const harness = createHarness({ utilityModels: configuredSettings });

    await expect(harness.service.inspect()).resolves.toEqual({
      contractVersion: 1,
      settings: configuredSettings,
      models: [
        { model: { provider: "acme", id: "small" }, name: "Acme Small" },
        { model: { provider: "acme", id: "large" }, name: "Acme Large" },
      ],
      slots: validSlots(),
      valid: true,
    });
    expect(harness.modelRuntime.refresh).toHaveBeenCalledExactlyOnceWith({ allowNetwork: false });
  });

  it("treats empty utility settings as valid", async () => {
    const response = await createHarness({ utilityModels: {} }).service.inspect();

    expect(response).toEqual({
      contractVersion: 1,
      settings: {},
      models: [
        { model: { provider: "acme", id: "small" }, name: "Acme Small" },
        { model: { provider: "acme", id: "large" }, name: "Acme Large" },
      ],
      slots: validSlots(),
      valid: true,
    });
  });

  it("retains stale configured references and invalidates only their slots", async () => {
    const settings: UtilityModelSettings = {
      lightweight: { provider: "acme", id: "ghost" },
      context: { provider: "acme", id: "large" },
    };

    const response = await createHarness({ utilityModels: settings }).service.inspect();

    expect(response.settings).toEqual(settings);
    expect(response.valid).toBe(false);
    expect(response.slots).toEqual({
      lightweight: { valid: false, reason: "lightweight utility model acme/ghost is unavailable" },
      context: { valid: true },
    });
  });

  it("reports malformed external settings with empty settings and invalid slots", async () => {
    const response = await createHarness({ utilityModelsError: "utilityModels.lightweight.id is required" }).service.inspect();

    expect(response).toEqual({
      contractVersion: 1,
      configError: "utilityModels.lightweight.id is required",
      settings: {},
      models: [
        { model: { provider: "acme", id: "small" }, name: "Acme Small" },
        { model: { provider: "acme", id: "large" }, name: "Acme Large" },
      ],
      slots: invalidSlots("utilityModels.lightweight.id is required"),
      valid: false,
    });
  });

  it("preserves an existing lightweight setting when updating context and confirms the saved snapshot", async () => {
    const harness = createHarness({ utilityModels: configuredSettings });
    const context = { provider: "acme", id: "small" };

    const response = await harness.service.update({ context });

    expect(harness.saveConfig).toHaveBeenCalledExactlyOnceWith({
      utilityModels: {
        lightweight: { provider: "acme", id: "small" },
        context,
      },
    });
    expect(response.settings).toEqual({
      lightweight: { provider: "acme", id: "small" },
      context,
    });
    expect(harness.events).toEqual(["refresh", "snapshot", "save", "refresh", "snapshot"]);
    expect(harness.modelRuntime.refresh).toHaveBeenCalledTimes(2);
    expect(harness.modelRuntime.refresh).toHaveBeenNthCalledWith(1, { allowNetwork: false });
    expect(harness.modelRuntime.refresh).toHaveBeenNthCalledWith(2, { allowNetwork: false });
  });

  it("clears only a slot explicitly set to null", async () => {
    const harness = createHarness({ utilityModels: configuredSettings });

    const response = await harness.service.update({ lightweight: null });

    expect(harness.saveConfig).toHaveBeenCalledExactlyOnceWith({
      utilityModels: { context: { provider: "acme", id: "large" } },
    });
    expect(response.settings).toEqual({ context: { provider: "acme", id: "large" } });
    expect(response.slots).toEqual(validSlots());
    expect(response.valid).toBe(true);
  });

  it("starts an update from empty settings when the persisted configuration is malformed", async () => {
    const harness = createHarness({ utilityModelsError: "utilityModels.context.id is required" });

    await harness.service.update({ context: { provider: "acme", id: "large" } });

    expect(harness.saveConfig).toHaveBeenCalledExactlyOnceWith({
      utilityModels: { context: { provider: "acme", id: "large" } },
    });
  });

  it("rejects unavailable replacement references before saving", async () => {
    const harness = createHarness({ utilityModels: configuredSettings });

    await expect(harness.service.update({ context: { provider: "acme", id: "ghost" } }))
      .rejects.toThrow("context utility model acme/ghost is unavailable");

    expect(harness.modelRuntime.refresh).toHaveBeenCalledExactlyOnceWith({ allowNetwork: false });
    expect(harness.modelRuntime.getAvailableSnapshot).toHaveBeenCalledOnce();
    expect(harness.saveConfig).not.toHaveBeenCalled();
  });

  it("validates retained configured references along with the requested patch", async () => {
    const harness = createHarness({ utilityModels: { lightweight: { provider: "acme", id: "ghost" } } });

    await expect(harness.service.update({ context: { provider: "acme", id: "large" } }))
      .rejects.toThrow("lightweight utility model acme/ghost is unavailable");

    expect(harness.saveConfig).not.toHaveBeenCalled();
  });
});

function validSlots(): UtilityModelSettingsResponse["slots"] {
  return {
    lightweight: { valid: true },
    context: { valid: true },
  };
}

function invalidSlots(reason: string): UtilityModelSettingsResponse["slots"] {
  return {
    lightweight: { valid: false, reason },
    context: { valid: false, reason },
  };
}

function createHarness(initialConfig: UtilityModelSettingsConfig) {
  let config = initialConfig;
  const events: string[] = [];
  const modelRuntime = {
    refresh: vi.fn(() => {
      events.push("refresh");
      return Promise.resolve({ aborted: false, errors: new Map() });
    }),
    getAvailableSnapshot: vi.fn(() => {
      events.push("snapshot");
      return availableModels;
    }),
  };
  const saveConfig = vi.fn((patch: { utilityModels: UtilityModelSettings }) => {
    events.push("save");
    config = { utilityModels: patch.utilityModels };
  });
  const service = createUtilityModelSettingsService({
    loadConfig: () => config,
    saveConfig,
    modelRuntime,
  });
  return { events, modelRuntime, saveConfig, service };
}
