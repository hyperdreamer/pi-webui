import { describe, expect, it, vi } from "vitest";
import type {
  UtilityModelBinding,
  UtilityModelSettings,
  UtilityModelSettingsResponseV2,
} from "../../shared/apiTypes.js";
import { createUtilityModelSettingsService, type UtilityModelSettingsConfig } from "./utilityModelSettingsService.js";

interface TestModel {
  provider: string;
  id: string;
  name: string;
  thinkingLevels: readonly string[];
}

const availableModels: readonly TestModel[] = [
  { provider: "acme", id: "small", name: "Acme Small", thinkingLevels: ["off", "minimal", "low", "turbo"] },
  { provider: "acme", id: "large", name: "Acme Large", thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"] },
];

const configuredSettings: UtilityModelSettings = {
  lightweight: { provider: "acme", id: "small", thinkingLevel: "minimal" },
  context: { provider: "acme", id: "large", thinkingLevel: "max" },
};

describe("utility model settings service", () => {
  it("refreshes offline, projects only known levels from each model, and preserves configured settings", async () => {
    const harness = createHarness({ utilityModels: configuredSettings });

    await expect(harness.service.inspect()).resolves.toEqual({
      contractVersion: 2,
      settings: configuredSettings,
      models: [
        {
          model: { provider: "acme", id: "small" },
          name: "Acme Small",
          thinkingLevels: ["off", "minimal", "low"],
        },
        {
          model: { provider: "acme", id: "large" },
          name: "Acme Large",
          thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
        },
      ],
      slots: validSlots(),
      valid: true,
    });
    expect(harness.modelRuntime.refresh).toHaveBeenCalledExactlyOnceWith({ allowNetwork: false });
  });

  it("treats empty utility settings as valid", async () => {
    const response = await createHarness({ utilityModels: {} }).service.inspect();

    expect(response).toEqual({
      contractVersion: 2,
      settings: {},
      models: modelOptions(),
      slots: validSlots(),
      valid: true,
    });
  });

  it("treats an omitted level as auto when the selected model does not support minimal", async () => {
    const settings: UtilityModelSettings = {
      context: { provider: "acme", id: "large" },
    };

    const response = await createHarness({ utilityModels: settings }).service.inspect();

    expect(response).toMatchObject({
      contractVersion: 2,
      settings,
      slots: validSlots(),
      valid: true,
    });
    expect(response.settings.context?.thinkingLevel).toBeUndefined();
  });

  it("retains stale configured references and invalidates only their slots", async () => {
    const settings: UtilityModelSettings = {
      lightweight: { provider: "acme", id: "ghost", thinkingLevel: "minimal" },
      context: { provider: "acme", id: "large", thinkingLevel: "max" },
    };

    const response = await createHarness({ utilityModels: settings }).service.inspect();

    expect(response.settings).toEqual(settings);
    expect(response.contractVersion).toBe(2);
    expect(response.valid).toBe(false);
    expect(response.slots).toEqual({
      lightweight: { valid: false, reason: "lightweight utility model acme/ghost is unavailable" },
      context: { valid: true },
    });
  });

  it("retains a persisted unsupported level and invalidates only its slot", async () => {
    const settings: UtilityModelSettings = {
      lightweight: { provider: "acme", id: "small", thinkingLevel: "minimal" },
      context: { provider: "acme", id: "large", thinkingLevel: "minimal" },
    };

    const response = await createHarness({ utilityModels: settings }).service.inspect();

    expect(response.settings).toEqual(settings);
    expect(response.valid).toBe(false);
    expect(response.slots).toEqual({
      lightweight: { valid: true },
      context: {
        valid: false,
        reason: "context utility model acme/large does not support thinking level minimal",
      },
    });
  });

  it("reports malformed external settings with empty settings and invalid slots", async () => {
    const response = await createHarness({ utilityModelsError: "utilityModels.lightweight.id is required" }).service.inspect();

    expect(response).toEqual({
      contractVersion: 2,
      configError: "utilityModels.lightweight.id is required",
      settings: {},
      models: modelOptions(),
      slots: invalidSlots("utilityModels.lightweight.id is required"),
      valid: false,
    });
  });

  it("accepts a supported explicit max and confirms the saved snapshot", async () => {
    const harness = createHarness({
      utilityModels: { lightweight: { provider: "acme", id: "small", thinkingLevel: "minimal" } },
    });
    const context = { provider: "acme", id: "large", thinkingLevel: "max" } satisfies UtilityModelBinding;

    const response = await harness.service.update({ context });

    expect(harness.saveConfig).toHaveBeenCalledExactlyOnceWith({
      utilityModels: {
        lightweight: { provider: "acme", id: "small", thinkingLevel: "minimal" },
        context,
      },
    });
    expect(response.settings).toEqual({
      lightweight: { provider: "acme", id: "small", thinkingLevel: "minimal" },
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
      utilityModels: { context: { provider: "acme", id: "large", thinkingLevel: "max" } },
    });
    expect(response.settings).toEqual({ context: { provider: "acme", id: "large", thinkingLevel: "max" } });
    expect(response.slots).toEqual(validSlots());
    expect(response.valid).toBe(true);
  });

  it("serializes concurrent updates so both complete bindings retain their levels", async () => {
    const firstSaveStarted = deferred();
    const releaseFirstSave = deferred();
    let saveCalls = 0;
    const harness = createHarness(
      { utilityModels: {} },
      {
        beforeSave: async () => {
          saveCalls += 1;
          if (saveCalls === 1) {
            firstSaveStarted.resolve();
            await releaseFirstSave.promise;
          }
        },
      },
    );
    const lightweight = { provider: "acme", id: "small", thinkingLevel: "minimal" } satisfies UtilityModelBinding;
    const context = { provider: "acme", id: "large", thinkingLevel: "max" } satisfies UtilityModelBinding;

    const first = harness.service.update({ lightweight });
    await firstSaveStarted.promise;
    const second = harness.service.update({ context });
    releaseFirstSave.resolve();
    await Promise.all([first, second]);

    expect(harness.config()).toEqual({
      utilityModels: { lightweight, context },
    });
  });

  it("starts an update from empty settings when the persisted configuration is malformed", async () => {
    const harness = createHarness({ utilityModelsError: "utilityModels.context.id is required" });

    await harness.service.update({ context: { provider: "acme", id: "large", thinkingLevel: "max" } });

    expect(harness.saveConfig).toHaveBeenCalledExactlyOnceWith({
      utilityModels: { context: { provider: "acme", id: "large", thinkingLevel: "max" } },
    });
  });

  it("rejects unavailable replacement references before saving", async () => {
    const harness = createHarness({ utilityModels: configuredSettings });

    await expect(harness.service.update({ context: { provider: "acme", id: "ghost", thinkingLevel: "minimal" } }))
      .rejects.toThrow("context utility model acme/ghost is unavailable");

    expect(harness.modelRuntime.refresh).toHaveBeenCalledExactlyOnceWith({ allowNetwork: false });
    expect(harness.modelRuntime.getAvailableSnapshot).toHaveBeenCalledOnce();
    expect(harness.saveConfig).not.toHaveBeenCalled();
  });

  it("rejects unsupported explicit levels before saving", async () => {
    const harness = createHarness({ utilityModels: configuredSettings });

    await expect(harness.service.update({ context: { provider: "acme", id: "large", thinkingLevel: "minimal" } }))
      .rejects.toThrow("context utility model acme/large does not support thinking level minimal");

    expect(harness.saveConfig).not.toHaveBeenCalled();
  });

  it("validates retained configured levels along with the requested patch", async () => {
    const harness = createHarness({
      utilityModels: { context: { provider: "acme", id: "large", thinkingLevel: "minimal" } },
    });

    await expect(harness.service.update({ lightweight: { provider: "acme", id: "small", thinkingLevel: "minimal" } }))
      .rejects.toThrow("context utility model acme/large does not support thinking level minimal");

    expect(harness.saveConfig).not.toHaveBeenCalled();
  });
});

function modelOptions(): UtilityModelSettingsResponseV2["models"] {
  return [
    {
      model: { provider: "acme", id: "small" },
      name: "Acme Small",
      thinkingLevels: ["off", "minimal", "low"],
    },
    {
      model: { provider: "acme", id: "large" },
      name: "Acme Large",
      thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    },
  ];
}

function validSlots(): UtilityModelSettingsResponseV2["slots"] {
  return {
    lightweight: { valid: true },
    context: { valid: true },
  };
}

function invalidSlots(reason: string): UtilityModelSettingsResponseV2["slots"] {
  return {
    lightweight: { valid: false, reason },
    context: { valid: false, reason },
  };
}

function createHarness(
  initialConfig: UtilityModelSettingsConfig,
  options: { beforeSave?: () => Promise<void> } = {},
) {
  let config = initialConfig;
  const events: string[] = [];
  const thinkingLevelsForModel = vi.fn((model: TestModel | undefined): readonly string[] => model?.thinkingLevels ?? []);
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
  const saveConfig = vi.fn(async (patch: { utilityModels: UtilityModelSettings }) => {
    events.push("save");
    await options.beforeSave?.();
    config = { utilityModels: patch.utilityModels };
  });
  const service = createUtilityModelSettingsService({
    loadConfig: () => config,
    saveConfig,
    modelRuntime,
    thinkingLevelsForModel,
  });
  return { config: () => config, events, modelRuntime, saveConfig, service, thinkingLevelsForModel };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise = (): void => undefined;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}
