import { describe, expect, it, vi } from "vitest";
import { testModel } from "./piSessionService.testSupport.js";
import { SessionDefaultsService } from "./sessionDefaultsService.js";
import type { StarterPreferenceInspection } from "./starterModelPolicyPreferenceStore.js";

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
        kind: "legacy-v1",
        preference: { mode: "exact", tier: "advanced" },
      },
    });

    await expect(harness.service.read("/workspace")).resolves.toMatchObject({
      thinkingLevel: "high",
      starterModelPolicyPreference: { mode: "exact", tier: "advanced" },
    });
  });

  it("down-projects a full starter preference for an unversioned read", async () => {
    const harness = createHarness({
      model: testModel(),
      thinkingLevel: "high",
      preferenceInspection: {
        kind: "full",
        preference: {
          mode: "tiered",
          exact: {
            model: { provider: "acme", id: "reasoner" },
            thinkingLevel: "high",
          },
          tier: "frontier",
        },
      },
    });

    const defaults = await harness.service.read("/workspace");

    expect(defaults.starterModelPolicyPreference).toEqual({
      mode: "tiered",
      tier: "frontier",
    });
    expect(defaults).not.toHaveProperty("starterModelPolicyContractVersion");
    expect(defaults.starterModelPolicyPreference).not.toHaveProperty("exact");
  });

  it("returns a cloned full starter preference under contract version two", async () => {
    const preference = {
      mode: "tiered" as const,
      exact: {
        model: { provider: "retired", id: "remembered" },
        thinkingLevel: "retired-level",
      },
      tier: "frontier" as const,
    };
    const harness = createHarness({
      model: testModel(),
      thinkingLevel: "high",
      preferenceInspection: { kind: "full", preference },
    });

    const defaults = await harness.service.readV2("/workspace");

    const hydratedPreference = defaults.starterModelPolicyPreference;
    expect(defaults.starterModelPolicyContractVersion).toBe(2);
    expect(hydratedPreference).toEqual(preference);
    expect(hydratedPreference).not.toBe(preference);
    if (hydratedPreference === undefined || !("exact" in hydratedPreference)) {
      throw new Error("Expected a full starter model policy preference");
    }
    expect(hydratedPreference.exact).not.toBe(preference.exact);
    expect(hydratedPreference.exact.model).not.toBe(preference.exact.model);
  });

  it("hydrates unavailable raw Exact settings for a legacy preference", async () => {
    const harness = createHarness({
      model: testModel(),
      thinkingLevel: "high",
      configuredProvider: "retired",
      configuredModelId: "remembered",
      configuredThinkingLevel: "retired-level",
      preferenceInspection: {
        kind: "legacy-v1",
        preference: { mode: "exact" },
      },
    });

    const defaults = await harness.service.readV2("/workspace");

    expect(defaults.starterModelPolicyPreference).toEqual({
      mode: "exact",
      exact: {
        model: { provider: "retired", id: "remembered" },
        thinkingLevel: "retired-level",
      },
    });
    expect(defaults.model).toBeUndefined();
    expect(defaults.thinkingLevel).toBe("off");
  });

  it("hydrates raw Exact settings and a canonical tier for a legacy Tiered preference", async () => {
    const model = testModel();
    const harness = createHarness({
      model,
      thinkingLevel: "high",
      preferenceInspection: {
        kind: "legacy-v1",
        preference: { mode: "tiered", tier: "frontier" },
      },
    });

    const defaults = await harness.service.readV2("/workspace");

    expect(defaults.starterModelPolicyPreference).toEqual({
      mode: "tiered",
      exact: {
        model: { provider: model.provider, id: model.id },
        thinkingLevel: "high",
      },
      tier: "frontier",
    });
  });

  it.each([
    ["provider is undefined", { configuredProvider: undefined }],
    ["model id is undefined", { configuredModelId: undefined }],
    ["thinking level is undefined", { configuredThinkingLevel: undefined }],
    ["provider is blank", { configuredProvider: "" }],
    ["model id is blank", { configuredModelId: "" }],
    ["thinking level is blank", { configuredThinkingLevel: "" }],
  ])("retains the legacy preference shape when the raw %s", async (_description, configured) => {
    const harness = createHarness({
      model: testModel(),
      thinkingLevel: "high",
      ...configured,
      preferenceInspection: {
        kind: "legacy-v1",
        preference: { mode: "tiered", tier: "frontier" },
      },
    });

    const defaults = await harness.service.readV2("/workspace");

    expect(defaults.starterModelPolicyPreference).toEqual({ mode: "tiered", tier: "frontier" });
    expect(defaults.starterModelPolicyPreference).not.toHaveProperty("exact");
  });

  it("returns ordinary defaults and a preference error when inspection throws", async () => {
    const model = testModel();
    const harness = createHarness({
      model,
      thinkingLevel: "high",
      inspectError: new Error("preference store unavailable"),
    });

    const defaults = await harness.service.readV2("/workspace");

    expect(defaults).toMatchObject({
      starterModelPolicyContractVersion: 2,
      model: { provider: model.provider, id: model.id },
      thinkingLevel: "high",
      starterModelPolicyPreferenceError: "preference store unavailable",
    });
    expect(defaults).not.toHaveProperty("starterModelPolicyPreference");
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
        kind: "legacy-v1",
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
      kind: "legacy-v1",
      preference: { mode: "tiered", tier: "frontier" },
    });

    await expect(harness.service.update("/workspace", {
      starterModelPolicyPreference: { mode: "tiered", tier: "frontier" },
    })).resolves.toMatchObject({
      starterModelPolicyPreference: { mode: "tiered", tier: "frontier" },
    });

    expect(harness.preferenceStore.replace).toHaveBeenCalledWith("/workspace", {
      kind: "legacy-v1",
      preference: { mode: "tiered", tier: "frontier" },
    });
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
  configuredProvider?: string | undefined;
  configuredModelId?: string | undefined;
  configuredThinkingLevel?: string | undefined;
  preferenceInspection?: StarterPreferenceInspection;
  inspectError?: Error;
  replaceError?: Error;
}) {
  let provider = "configuredProvider" in input ? input.configuredProvider : input.model.provider;
  let modelId = "configuredModelId" in input ? input.configuredModelId : input.model.id;
  let thinkingLevel = "configuredThinkingLevel" in input ? input.configuredThinkingLevel : input.thinkingLevel;
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
    inspect: vi.fn((): Promise<StarterPreferenceInspection> => input.inspectError === undefined
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
