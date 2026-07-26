import { describe, expect, it, vi } from "vitest";
import { testModel } from "./piSessionService.testSupport.js";
import { SessionDefaultsService } from "./sessionDefaultsService.js";

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
    const harness = createHarness({ model, thinkingLevel: "high" });

    const defaults = await harness.service.update("/workspace", { thinkingLevel: "low" });

    expect(harness.settings.setDefaultModelAndProvider).not.toHaveBeenCalled();
    expect(harness.settings.setDefaultThinkingLevel).toHaveBeenCalledWith("low");
    expect(harness.settings.flush).toHaveBeenCalledOnce();
    expect(defaults.thinkingLevel).toBe("low");
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
  const service = new SessionDefaultsService({
    agentDir: "/agent",
    modelRuntime,
    createSettingsManager: () => settings,
    thinkingLevelsForModel: (model) => model?.id === "alternate-model" || model === undefined ? ["off"] : ["off", "low", "high"],
  });
  return { service, settings, modelRuntime };
}
