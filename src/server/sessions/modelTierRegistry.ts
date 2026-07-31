import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { isKnownThinkingLevel } from "../../shared/thinkingLevels.js";
import { MODEL_TIERS, type ModelTier, type ModelTierLadder, type TierModelRef } from "../../shared/apiTypes.js";

export { MODEL_TIERS, type ModelTier, type ModelTierEntry, type ModelTierLadder, type TierModelRef } from "../../shared/apiTypes.js";

/**
 * The six-rung tier ladder, ascending. A tier is a stable name a caller can
 * request; the machine's ladder decides what it resolves to.
 *
 * Tier selection is typed, never textual. Nothing here parses prompt content: a
 * tier arrives as one of these names or resolution fails.
 */


/** A tier resolved to something the runtime will accept. */
export interface ResolvedTier {
  tier: ModelTier;
  model: TierModelRef;
  thinkingLevel: string;
}

export type LadderValidation = { valid: true } | { valid: false; reason: string };

/**
 * What resolution needs from the model runtime. Narrowed to two reads so tests
 * can supply fixtures without constructing a runtime, and so this module cannot
 * quietly depend on anything else.
 */
export interface TierResolutionDeps<TModel extends { provider: string; id: string }> {
  models: readonly TModel[];
  supportedThinkingLevels(model: TModel | undefined): readonly string[];
}

export function isModelTier(value: string): value is ModelTier {
  return MODEL_TIERS.some((tier) => tier === value);
}

/** Default thinking-level lookup, delegating to Pi rather than a local table. */
export function runtimeThinkingLevels(model: Model<Api> | undefined): readonly string[] {
  return model === undefined ? [] : getSupportedThinkingLevels(model);
}

export interface ResolvedRuntimeTier<TModel extends { provider: string; id: string }> {
  tier: ModelTier;
  model: TModel;
  thinkingLevel: string;
}

export interface ModelTierRegistry<TModel extends { provider: string; id: string }> {
  resolve(tier: ModelTier): ResolvedRuntimeTier<TModel>;
}

export interface ModelTierRegistryConfig {
  modelTiers?: ModelTierLadder;
  modelTiersError?: string;
}

export interface ModelTierRegistryDeps<TModel extends { provider: string; id: string }> {
  loadConfig(): ModelTierRegistryConfig;
  models(): readonly TModel[];
  supportedThinkingLevels(model: TModel | undefined): readonly string[];
}

/**
 * Bind config intent to one currently available runtime model. This wrapper is
 * deliberately synchronous: the session daemon's model runtime publishes a
 * current catalog snapshot, and a request must fail closed against that
 * snapshot rather than inventing a fallback while it refreshes.
 */
export function createModelTierRegistry<TModel extends { provider: string; id: string }>(
  deps: ModelTierRegistryDeps<TModel>,
): ModelTierRegistry<TModel> {
  return {
    resolve(tier) {
      const config = deps.loadConfig();
      if (config.modelTiersError !== undefined) {
        throw new Error(`model tier configuration is invalid: ${config.modelTiersError}`);
      }
      if (config.modelTiers === undefined) {
        throw new Error("model tier configuration is missing");
      }
      const models = deps.models();
      const resolved = resolveTier(tier, config.modelTiers, {
        models,
        supportedThinkingLevels: (model) => deps.supportedThinkingLevels(model),
      });
      const model = models.find((candidate) => candidate.provider === resolved.model.provider && candidate.id === resolved.model.id);
      if (model === undefined) {
        // This is defensive against a catalog changing between the resolution
        // lookup and the runtime handoff. It is still a terminal resolution
        // failure, never a neighbouring-tier substitution.
        throw new Error(`tier ${tier} names unavailable model ${resolved.model.provider}/${resolved.model.id}`);
      }
      return { tier: resolved.tier, model, thinkingLevel: resolved.thinkingLevel };
    },
  };
}

function describeModel(model: TierModelRef): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Resolve one tier, or throw explaining why not.
 *
 * Every failure is terminal by design. Substituting a neighbouring tier would
 * silently run weaker or stronger work than the caller asked for, which is the
 * exact failure the tier system exists to prevent.
 */
export function resolveTier<TModel extends { provider: string; id: string }>(
  tier: string,
  ladder: Partial<ModelTierLadder>,
  deps: TierResolutionDeps<TModel>,
): ResolvedTier {
  if (!isModelTier(tier)) throw new Error(`unknown tier: ${tier}`);

  const entry = ladder[tier];
  if (entry === undefined) throw new Error(`tier ${tier} has no ladder entry`);

  const available = deps.models.find(
    (candidate) => candidate.provider === entry.model.provider && candidate.id === entry.model.id,
  );
  if (available === undefined) {
    throw new Error(`tier ${tier} names unavailable model ${describeModel(entry.model)}`);
  }

  if (!isKnownThinkingLevel(entry.thinkingLevel)) {
    throw new Error(`tier ${tier} names unknown thinking level ${entry.thinkingLevel}`);
  }

  const supported = deps.supportedThinkingLevels(available);
  if (!supported.includes(entry.thinkingLevel)) {
    throw new Error(
      `tier ${tier} names thinking level ${entry.thinkingLevel}, unsupported by ${describeModel(entry.model)}`,
    );
  }

  return { tier, model: { ...entry.model }, thinkingLevel: entry.thinkingLevel };
}

/**
 * Validate a complete ladder. Returns a reason rather than throwing, because a
 * broken ladder is a reportable configuration state, not an exception path.
 */
export function validateLadder<TModel extends { provider: string; id: string }>(
  ladder: Partial<ModelTierLadder>,
  deps: TierResolutionDeps<TModel>,
): LadderValidation {
  for (const tier of MODEL_TIERS) {
    try {
      resolveTier(tier, ladder, deps);
    } catch (error) {
      return { valid: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  return { valid: true };
}
