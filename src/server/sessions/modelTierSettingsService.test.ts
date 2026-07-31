import { describe, expect, it, vi } from "vitest";
import type { ModelTierLadder, ModelTierSettingsResponse } from "../../shared/apiTypes.js";
import { createModelTierSettingsService, type ModelTierSettingsConfig } from "./modelTierSettingsService.js";

interface TestModel {
  provider: string;
  id: string;
  name: string;
  thinkingLevels: readonly string[];
}

const availableModels: readonly TestModel[] = [
  { provider: "acme", id: "small", name: "Acme Small", thinkingLevels: ["off"] },
  { provider: "acme", id: "large", name: "Acme Large", thinkingLevels: ["off", "low", "medium", "high", "max"] },
];

function ladder(overrides: Partial<ModelTierLadder> = {}): ModelTierLadder {
  const complete: ModelTierLadder = {
    economy: { model: { provider: "acme", id: "small" }, thinkingLevel: "off" },
    fast: { model: { provider: "acme", id: "small" }, thinkingLevel: "off" },
    standard: { model: { provider: "acme", id: "large" }, thinkingLevel: "low" },
    advanced: { model: { provider: "acme", id: "large" }, thinkingLevel: "medium" },
    capable: { model: { provider: "acme", id: "large" }, thinkingLevel: "high" },
    frontier: { model: { provider: "acme", id: "large" }, thinkingLevel: "max" },
  };
  return { ...complete, ...overrides };
}

describe("model tier settings service", () => {
  it("refreshes offline, projects the available catalog, and preserves the configured ladder", async () => {
    const configuredLadder = ladder();
    const harness = createHarness({ modelTiers: configuredLadder });

    const response = await harness.service.inspect();

    expect(response).toEqual({
      contractVersion: 1,
      ladder: configuredLadder,
      models: [
        { model: { provider: "acme", id: "small" }, name: "Acme Small", thinkingLevels: ["off"] },
        { model: { provider: "acme", id: "large" }, name: "Acme Large", thinkingLevels: ["off", "low", "medium", "high", "max"] },
      ],
      rows: validRows(),
      valid: true,
    });
    expect(harness.modelRuntime.refresh).toHaveBeenCalledExactlyOnceWith({ allowNetwork: false });
  });

  it("marks all six rows valid when every configured model and thinking level is available", async () => {
    const response = await createHarness({ modelTiers: ladder() }).service.inspect();

    expect(response.valid).toBe(true);
    expect(response.rows).toEqual(validRows());
    expect(Object.keys(response.rows)).toEqual(["economy", "fast", "standard", "advanced", "capable", "frontier"]);
  });

  it("retains an unavailable model and invalidates only its affected row", async () => {
    const configuredLadder = ladder({
      frontier: { model: { provider: "acme", id: "ghost" }, thinkingLevel: "max" },
    });

    const response = await createHarness({ modelTiers: configuredLadder }).service.inspect();

    expect(response.ladder).toEqual(configuredLadder);
    expect(response.valid).toBe(false);
    expect(response.rows.frontier).toEqual({
      valid: false,
      reason: "tier frontier names unavailable model acme/ghost",
    });
    expect(Object.entries(response.rows).filter(([tier]) => tier !== "frontier").every(([, row]) => row.valid)).toBe(true);
  });

  it("retains an unsupported thinking level without clamping it", async () => {
    const configuredLadder = ladder({
      economy: { model: { provider: "acme", id: "small" }, thinkingLevel: "max" },
    });

    const response = await createHarness({ modelTiers: configuredLadder }).service.inspect();

    expect(response.ladder).toEqual(configuredLadder);
    expect(response.ladder?.economy.thinkingLevel).toBe("max");
    expect(response.rows.economy).toEqual({
      valid: false,
      reason: "tier economy names thinking level max, unsupported by acme/small",
    });
    expect(Object.entries(response.rows).filter(([tier]) => tier !== "economy").every(([, row]) => row.valid)).toBe(true);
  });

  it("loads the catalog even when model-tier configuration is missing", async () => {
    const response = await createHarness({}).service.inspect();

    expect(response.ladder).toBeUndefined();
    expect(response.configError).toBeUndefined();
    expect(response.valid).toBe(false);
    expect(response.models).toHaveLength(2);
    expect(Object.values(response.rows)).toHaveLength(6);
    expect(Object.values(response.rows).every((row) => !row.valid)).toBe(true);
  });

  it("reports an externally malformed ladder without exposing a misleading ladder", async () => {
    const response = await createHarness({ modelTiersError: "missing frontier tier" }).service.inspect();

    expect(response).toMatchObject({ contractVersion: 1, configError: "missing frontier tier", valid: false });
    expect(response.ladder).toBeUndefined();
    expect(Object.values(response.rows).every((row) => !row.valid)).toBe(true);
  });

  it("validates every replacement row against one refreshed snapshot before saving", async () => {
    const replacement = ladder({
      economy: { model: { provider: "acme", id: "ghost" }, thinkingLevel: "off" },
    });
    const harness = createHarness({ modelTiers: ladder() });

    await expect(harness.service.replace(replacement)).rejects.toThrow("acme/ghost");

    expect(harness.modelRuntime.refresh).toHaveBeenCalledExactlyOnceWith({ allowNetwork: false });
    expect(harness.modelRuntime.getAvailableSnapshot).toHaveBeenCalledOnce();
    expect(harness.thinkingLevelsForModel).toHaveBeenCalledTimes(5);
    expect(harness.saveConfig).not.toHaveBeenCalled();
    expect(harness.events).toEqual(["refresh", "snapshot"]);
  });

  it("rejects an invalid replacement without calling the saver", async () => {
    const replacement = ladder({
      capable: { model: { provider: "acme", id: "large" }, thinkingLevel: "minimal" },
    });
    const harness = createHarness({ modelTiers: ladder() });

    await expect(harness.service.replace(replacement)).rejects.toThrow(/minimal/u);

    expect(harness.saveConfig).not.toHaveBeenCalled();
  });

  it("saves only the complete ladder patch and returns the confirmed post-save inspection", async () => {
    const replacement = ladder({
      standard: { model: { provider: "acme", id: "large" }, thinkingLevel: "high" },
    });
    const harness = createHarness({ modelTiers: ladder() });

    const response = await harness.service.replace(replacement);

    expect(harness.saveConfig).toHaveBeenCalledExactlyOnceWith({ modelTiers: replacement });
    expect(harness.events).toEqual(["refresh", "snapshot", "save", "refresh", "snapshot"]);
    expect(response.ladder).toEqual(replacement);
    expect(response.valid).toBe(true);
    expect(response.rows).toEqual(validRows());
  });
});

function validRows(): ModelTierSettingsResponse["rows"] {
  return {
    economy: { valid: true },
    fast: { valid: true },
    standard: { valid: true },
    advanced: { valid: true },
    capable: { valid: true },
    frontier: { valid: true },
  };
}

function createHarness(initialConfig: ModelTierSettingsConfig) {
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
  const saveConfig = vi.fn((patch: { modelTiers: ModelTierLadder }) => {
    events.push("save");
    config = { modelTiers: patch.modelTiers };
  });
  const service = createModelTierSettingsService({
    loadConfig: () => config,
    modelRuntime,
    saveConfig,
    thinkingLevelsForModel,
  });
  return { events, modelRuntime, saveConfig, service, thinkingLevelsForModel };
}
