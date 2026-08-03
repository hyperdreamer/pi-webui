import { describe, expect, it, vi } from "vitest";
import { testModel } from "./piSessionService.testSupport.js";
import { SessionDefaultsService } from "./sessionDefaultsService.js";
import type { StarterModelPolicyPreferenceInspection } from "./starterModelPolicyPreferenceStore.js";

describe("SessionDefaultsService", () => {
  it("reads the persisted default model and thinking level without a session", async () => {
    const model = testModel();
    const harness = createHarness({ model, thinkingLevel: "high" });

    const defaults = await harness.service.read("/workspace");

    expect(defaults).toMatchObject({
      model: { provider: model.provider, id: model.id },
      thinkingLevel: "high",
      models: [{ provider: model.provider, id: model.id }],
      thinkingLevels: ["off", "low", "high"],
    });
    expect(harness.modelRuntime.refresh).toHaveBeenCalledExactlyOnceWith({ allowNetwork: false });
    expect(harness.settings.flush).not.toHaveBeenCalled();
  });

  it("combines Pi defaults with a valid starter preference", async () => {
    const harness = createHarness({
      model: testModel(),
      thinkingLevel: "high",
      preferenceInspection: {
        kind: "valid",
        preference: { mode: "exact", tier: "advanced" },
      },
    });

    await expect(harness.service.read("/workspace")).resolves.toMatchObject({
      thinkingLevel: "high",
      starterModelPolicyPreference: { mode: "exact", tier: "advanced" },
    });
  });

  it("keeps Exact defaults available when preference inspection fails", async () => {
    const harness = createHarness({
      model: testModel(),
      thinkingLevel: "high",
      inspectError: new Error("preference store unavailable"),
    });

    await expect(harness.service.read("/workspace")).resolves.toMatchObject({
      thinkingLevel: "high",
      starterModelPolicyPreferenceError: "preference store unavailable",
    });
  });

  it("persists a default model change and clamps the default thinking level for it", async () => {
    const model = testModel();
    const alternate = { ...model, id: "alternate-model" };
    const harness = createHarness({ model, models: [model, alternate], thinkingLevel: "high" });

    const defaults = await harness.service.update("/workspace", {
      model: { provider: alternate.provider, modelId: alternate.id },
    });

    expect(harness.settings.setDefaultModelAndProvider).toHaveBeenCalledWith(alternate.provider, alternate.id);
    expect(harness.settings.setDefaultThinkingLevel).toHaveBeenCalledWith("off");
    expect(harness.settings.flush).toHaveBeenCalledOnce();
    expect(defaults).toMatchObject({
      model: { provider: alternate.provider, id: alternate.id },
      thinkingLevel: "off",
      thinkingLevels: ["off"],
    });
  });

  it("persists a supported default thinking level without changing the model", async () => {
    const model = testModel();
    const harness = createHarness({
      model,
      thinkingLevel: "high",
      preferenceInspection: {
        kind: "valid",
        preference: { mode: "tiered", tier: "capable" },
      },
    });

    const defaults = await harness.service.update("/workspace", { thinkingLevel: "low" });

    expect(harness.settings.setDefaultModelAndProvider).not.toHaveBeenCalled();
    expect(harness.settings.setDefaultThinkingLevel).toHaveBeenCalledWith("low");
    expect(harness.settings.flush).toHaveBeenCalledOnce();
    expect(defaults.thinkingLevel).toBe("low");
    expect(defaults.starterModelPolicyPreference).toEqual({ mode: "tiered", tier: "capable" });
  });

  it("writes only the preference store for a preference update", async () => {
    const harness = createHarness({ model: testModel(), thinkingLevel: "high" });
    harness.preferenceStore.inspect.mockResolvedValue({
      kind: "valid",
      preference: { mode: "tiered", tier: "frontier" },
    });

    await expect(harness.service.update("/workspace", {
      starterModelPolicyPreference: { mode: "tiered", tier: "frontier" },
    })).resolves.toMatchObject({
      starterModelPolicyPreference: { mode: "tiered", tier: "frontier" },
    });

    expect(harness.preferenceStore.replace).toHaveBeenCalledWith(
      "/workspace",
      { mode: "tiered", tier: "frontier" },
    );
    expect(harness.settings.setDefaultModelAndProvider).not.toHaveBeenCalled();
    expect(harness.settings.setDefaultThinkingLevel).not.toHaveBeenCalled();
    expect(harness.settings.flush).not.toHaveBeenCalled();
  });

  it("propagates preference write failures without changing Pi settings", async () => {
    const harness = createHarness({
      model: testModel(),
      thinkingLevel: "high",
      replaceError: new Error("preference write failed"),
    });

    await expect(harness.service.update("/workspace", {
      starterModelPolicyPreference: { mode: "exact", tier: "fast" },
    })).rejects.toThrow("preference write failed");

    expect(harness.settings.setDefaultModelAndProvider).not.toHaveBeenCalled();
    expect(harness.settings.setDefaultThinkingLevel).not.toHaveBeenCalled();
    expect(harness.settings.flush).not.toHaveBeenCalled();
  });

  it("rejects an unavailable default model without changing settings", async () => {
    const model = testModel();
    const harness = createHarness({ model, thinkingLevel: "high" });

    await expect(harness.service.update("/workspace", { model: { provider: "other", modelId: "missing" } })).rejects.toThrow("Model not available");

    expect(harness.settings.setDefaultModelAndProvider).not.toHaveBeenCalled();
    expect(harness.settings.setDefaultThinkingLevel).not.toHaveBeenCalled();
    expect(harness.settings.flush).not.toHaveBeenCalled();
  });

  it("rejects a default thinking level unsupported by the configured default model", async () => {
    const model = { ...testModel(), id: "alternate-model" };
    const harness = createHarness({ model, thinkingLevel: "off" });

    await expect(harness.service.update("/workspace", { thinkingLevel: "high" })).rejects.toThrow("not supported by the default model");

    expect(harness.settings.setDefaultThinkingLevel).not.toHaveBeenCalled();
    expect(harness.settings.flush).not.toHaveBeenCalled();
  });
});

function createHarness(input: {
  model: ReturnType<typeof testModel>;
  models?: readonly ReturnType<typeof testModel>[];
  thinkingLevel: "off" | "low" | "high";
  preferenceInspection?: StarterModelPolicyPreferenceInspection;
  inspectError?: Error;
  replaceError?: Error;
}) {
  let provider = input.model.provider;
  let modelId = input.model.id;
  let thinkingLevel = input.thinkingLevel;
  const settings = {
    getDefaultProvider: () => provider,
    getDefaultModel: () => modelId,
    getDefaultThinkingLevel: () => thinkingLevel,
    setDefaultModelAndProvider: vi.fn((nextProvider: string, nextModelId: string) => {
      provider = nextProvider;
      modelId = nextModelId;
    }),
    setDefaultThinkingLevel: vi.fn((nextLevel: "off" | "low" | "high") => {
      thinkingLevel = nextLevel;
    }),
    flush: vi.fn(() => Promise.resolve()),
  };
  const modelRuntime = {
    refresh: vi.fn(() => Promise.resolve({ aborted: false, errors: new Map() })),
    getAvailableSnapshot: () => input.models ?? [input.model],
  };
  const preferenceStore = {
    inspect: vi.fn((): Promise<StarterModelPolicyPreferenceInspection> => input.inspectError === undefined
      ? Promise.resolve(input.preferenceInspection ?? { kind: "absent" })
      : Promise.reject(input.inspectError)),
    replace: vi.fn((): Promise<void> => input.replaceError === undefined
      ? Promise.resolve()
      : Promise.reject(input.replaceError)),
  };
  const service = new SessionDefaultsService({
    agentDir: "/agent",
    modelRuntime,
    starterModelPolicyPreferenceStore: preferenceStore,
    createSettingsManager: () => settings,
    thinkingLevelsForModel: (model) => model?.id === "alternate-model" || model === undefined ? ["off"] : ["off", "low", "high"],
  });
  return { service, settings, modelRuntime, preferenceStore };
}
