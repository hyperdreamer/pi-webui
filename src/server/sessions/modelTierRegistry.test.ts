import { describe, expect, it } from "vitest";
import { MODEL_TIERS, createModelTierRegistry, resolveTier, validateLadder, type ModelTierLadder, type TierResolutionDeps } from "./modelTierRegistry.js";

/**
 * Available models are the runtime's answer, not ours. These fixtures mirror the
 * shape `getAvailableSnapshot()` returns, narrowed to the fields tier resolution
 * reads, so a tier can only resolve to something the runtime would accept.
 */
function availableModels() {
  return [
    { provider: "acme", id: "small", thinking: false },
    { provider: "acme", id: "large", thinking: true },
  ];
}

function ladder(overrides: Partial<ModelTierLadder> = {}): ModelTierLadder {
  const base = {
    economy: { model: { provider: "acme", id: "small" }, thinkingLevel: "off" },
    fast: { model: { provider: "acme", id: "small" }, thinkingLevel: "off" },
    standard: { model: { provider: "acme", id: "large" }, thinkingLevel: "low" },
    advanced: { model: { provider: "acme", id: "large" }, thinkingLevel: "medium" },
    capable: { model: { provider: "acme", id: "large" }, thinkingLevel: "high" },
    frontier: { model: { provider: "acme", id: "large" }, thinkingLevel: "max" },
  } satisfies ModelTierLadder;
  return { ...base, ...overrides };
}

/** Thinking support keyed off the fixture's `thinking` flag. */
function supportedThinkingLevels(model: { thinking: boolean } | undefined): readonly string[] {
  if (model === undefined) return [];
  return model.thinking ? ["off", "low", "medium", "high", "xhigh", "max"] : ["off"];
}

type AvailableModel = ReturnType<typeof availableModels>[number];
const deps: TierResolutionDeps<AvailableModel> = { models: availableModels(), supportedThinkingLevels };

describe("model tier registry", () => {
  it("exposes exactly the six canonical tiers in ascending order", () => {
    expect(MODEL_TIERS).toEqual(["economy", "fast", "standard", "advanced", "capable", "frontier"]);
  });

  describe("validateLadder", () => {
    it("accepts a complete ladder whose entries all exist and support their level", () => {
      expect(validateLadder(ladder(), deps)).toEqual({ valid: true });
    });

    it("rejects a ladder missing a tier rather than defaulting it", () => {
      const incomplete: Partial<ModelTierLadder> = { ...ladder() };
      delete incomplete.capable;
      const result = validateLadder(incomplete, deps);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toMatch(/capable/u);
    });

    it("rejects a tier naming a model the runtime does not offer", () => {
      const result = validateLadder(
        ladder({ frontier: { model: { provider: "acme", id: "ghost" }, thinkingLevel: "max" } }),
        deps,
      );
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toMatch(/acme\/ghost/u);
    });

    it("rejects a thinking level the target model does not support", () => {
      const result = validateLadder(
        ladder({ economy: { model: { provider: "acme", id: "small" }, thinkingLevel: "max" } }),
        deps,
      );
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toMatch(/max/u);
    });

    it("rejects an unknown thinking level string", () => {
      const result = validateLadder(
        ladder({ fast: { model: { provider: "acme", id: "small" }, thinkingLevel: "turbo" } }),
        deps,
      );
      expect(result.valid).toBe(false);
    });
  });

  describe("createModelTierRegistry", () => {
    it("returns the exact available runtime model for a configured tier", () => {
      const models = availableModels();
      const registry = createModelTierRegistry<AvailableModel>({
        loadConfig: () => ({ modelTiers: ladder() }),
        models: () => models,
        supportedThinkingLevels,
      });

      expect(registry.resolve("advanced")).toEqual({ tier: "advanced", model: models[1], thinkingLevel: "medium" });
    });

    it("reports missing configuration instead of defaulting to a neighbouring tier", () => {
      const registry = createModelTierRegistry<AvailableModel>({
        loadConfig: () => ({}),
        models: availableModels,
        supportedThinkingLevels,
      });

      expect(() => registry.resolve("economy")).toThrow("model tier configuration is missing");
    });
  });

  describe("resolveTier", () => {
    it("resolves each tier to a concrete provider, model, and thinking level", () => {
      expect(resolveTier("advanced", ladder(), deps)).toEqual({
        tier: "advanced",
        model: { provider: "acme", id: "large" },
        thinkingLevel: "medium",
      });
      expect(resolveTier("economy", ladder(), deps)).toEqual({
        tier: "economy",
        model: { provider: "acme", id: "small" },
        thinkingLevel: "off",
      });
    });

    it("throws for an unknown tier name instead of guessing a neighbour", () => {
      expect(() => resolveTier("turbo", ladder(), deps)).toThrow(/unknown tier/iu);
    });

    it("throws when the requested tier's model is unavailable, never substituting", () => {
      const broken = ladder({ capable: { model: { provider: "acme", id: "ghost" }, thinkingLevel: "high" } });
      expect(() => resolveTier("capable", broken, deps)).toThrow(/acme\/ghost/u);
      // The neighbouring tiers are healthy; resolution must not fall back to them.
      expect(() => resolveTier("capable", broken, deps)).not.toThrow(/advanced|frontier/u);
    });

    it("throws rather than clamping an unsupported thinking level", () => {
      const broken = ladder({ fast: { model: { provider: "acme", id: "small" }, thinkingLevel: "high" } });
      expect(() => resolveTier("fast", broken, deps)).toThrow(/high/u);
    });
  });
});
