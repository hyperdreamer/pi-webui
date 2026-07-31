import { describe, expect, it } from "vitest";
import {
  MODEL_TIERS,
  type ModelTierLadder,
  type ModelTierModelOption,
  type ModelTierSettingsResponse,
  type TierModelRef,
} from "../../../../shared/apiTypes";
import {
  emptyModelTierLadderDraft,
  modelTierLadderDraftFromResponse,
  modelTierLadderFromDraft,
  updateTierModel,
  updateTierThinkingLevel,
  validateModelTierDraft,
} from "./modelTierLadderDraft";

const smallModel: TierModelRef = { provider: "openai", id: "gpt-small" };
const largeModel: TierModelRef = { provider: "openai", id: "org/gpt-large/model" };
const staleModel: TierModelRef = { provider: "missing-provider", id: "org/stale/model" };

const models: readonly ModelTierModelOption[] = [
  { model: smallModel, name: "Small", thinkingLevels: ["off"] },
  { model: largeModel, name: "Large", thinkingLevels: ["off", "low", "medium", "high", "max"] },
];

function validLadder(): ModelTierLadder {
  return {
    economy: { model: largeModel, thinkingLevel: "medium" },
    fast: { model: largeModel, thinkingLevel: "medium" },
    standard: { model: largeModel, thinkingLevel: "high" },
    advanced: { model: largeModel, thinkingLevel: "high" },
    capable: { model: largeModel, thinkingLevel: "max" },
    frontier: { model: largeModel, thinkingLevel: "max" },
  };
}

function responseWithLadder(ladder?: ModelTierLadder): ModelTierSettingsResponse {
  return {
    contractVersion: 1,
    ...(ladder === undefined ? {} : { ladder }),
    models: [...models],
    rows: {
      economy: { valid: ladder !== undefined },
      fast: { valid: ladder !== undefined },
      standard: { valid: ladder !== undefined },
      advanced: { valid: ladder !== undefined },
      capable: { valid: ladder !== undefined },
      frontier: { valid: ladder !== undefined },
    },
    valid: ladder !== undefined,
  };
}

describe("model tier ladder drafts", () => {
  it("creates six empty rows in canonical order when the response has no ladder", () => {
    const draft = modelTierLadderDraftFromResponse(responseWithLadder());

    expect(Object.keys(draft)).toEqual(MODEL_TIERS);
    expect(draft).toEqual({
      economy: { thinkingLevel: "" },
      fast: { thinkingLevel: "" },
      standard: { thinkingLevel: "" },
      advanced: { thinkingLevel: "" },
      capable: { thinkingLevel: "" },
      frontier: { thinkingLevel: "" },
    });
    expect(emptyModelTierLadderDraft()).toEqual(draft);
  });

  it("maps configured rows without splitting model IDs that contain slashes", () => {
    const ladder = validLadder();
    const draft = modelTierLadderDraftFromResponse(responseWithLadder(ladder));

    expect(draft.economy).toEqual({ model: { provider: "openai", id: "org/gpt-large/model" }, thinkingLevel: "medium" });
    expect(draft.frontier).toEqual(ladder.frontier);
    expect(draft.economy.model?.provider).toBe("openai");
    expect(draft.economy.model?.id).toBe("org/gpt-large/model");
  });

  it("preserves a compatible thinking level and clears an incompatible one on model selection", () => {
    const source = modelTierLadderDraftFromResponse(responseWithLadder(validLadder()));

    const preserved = updateTierModel(source, "economy", largeModel, models);
    expect(preserved.economy).toEqual({ model: largeModel, thinkingLevel: "medium" });

    const cleared = updateTierModel(source, "economy", smallModel, models);
    expect(cleared.economy).toEqual({ model: smallModel, thinkingLevel: "" });
    expect(validateModelTierDraft(cleared, models).rows.economy).toMatchObject({ valid: false });
    expect(validateModelTierDraft(cleared, models).rows.economy.reason).toContain("thinking");
    expect(cleared.economy.thinkingLevel).not.toBe("off");
    expect(source.economy).toEqual({ model: largeModel, thinkingLevel: "medium" });
  });

  it("reports row-specific errors for missing, empty, unavailable, and unsupported values", () => {
    const missing = validateModelTierDraft(emptyModelTierLadderDraft(), models);
    expect(missing.rows.economy).toMatchObject({ valid: false });
    expect(missing.rows.economy.reason).toContain("economy");
    expect(missing.rows.economy.reason).toContain("model");

    const emptyThinking = updateTierModel(emptyModelTierLadderDraft(), "fast", smallModel, models);
    const emptyThinkingValidation = validateModelTierDraft(emptyThinking, models);
    expect(emptyThinkingValidation.rows.fast).toMatchObject({ valid: false });
    expect(emptyThinkingValidation.rows.fast.reason).toContain("thinking");

    let unavailable = updateTierModel(emptyModelTierLadderDraft(), "standard", staleModel, models);
    unavailable = updateTierThinkingLevel(unavailable, "standard", "off");
    const unavailableValidation = validateModelTierDraft(unavailable, models);
    expect(unavailableValidation.rows.standard).toMatchObject({ valid: false });
    expect(unavailableValidation.rows.standard.reason).toContain("standard");
    expect(unavailableValidation.rows.standard.reason).toContain("unavailable");

    let unsupported = updateTierModel(emptyModelTierLadderDraft(), "advanced", smallModel, models);
    unsupported = updateTierThinkingLevel(unsupported, "advanced", "high");
    const unsupportedValidation = validateModelTierDraft(unsupported, models);
    expect(unsupportedValidation.rows.advanced).toMatchObject({ valid: false });
    expect(unsupportedValidation.rows.advanced.reason).toContain("advanced");
    expect(unsupportedValidation.rows.advanced.reason).toContain("unsupported");
  });

  it("converts only complete valid drafts and permits duplicate exact tuples", () => {
    const draft = modelTierLadderDraftFromResponse(responseWithLadder(validLadder()));
    expect(modelTierLadderFromDraft(draft, models)).toEqual(validLadder());

    const incomplete = updateTierThinkingLevel(draft, "frontier", "");
    expect(modelTierLadderFromDraft(incomplete, models)).toBeUndefined();

    const duplicate = updateTierModel(draft, "frontier", largeModel, models);
    const duplicateWithSameThinking = updateTierThinkingLevel(duplicate, "frontier", "medium");
    expect(validateModelTierDraft(duplicateWithSameThinking, models).valid).toBe(true);
    expect(modelTierLadderFromDraft(duplicateWithSameThinking, models)).toMatchObject({
      economy: { model: largeModel, thinkingLevel: "medium" },
      frontier: { model: largeModel, thinkingLevel: "medium" },
    });
  });

  it("keeps stale configured models in drafts while validation marks them unavailable", () => {
    const ladder = validLadder();
    ladder.frontier = { model: staleModel, thinkingLevel: "max" };
    const draft = modelTierLadderDraftFromResponse(responseWithLadder(ladder));

    expect(draft.frontier).toEqual({ model: staleModel, thinkingLevel: "max" });
    expect(validateModelTierDraft(draft, models).rows.frontier).toEqual({
      valid: false,
      reason: "tier frontier names unavailable model missing-provider/org/stale/model",
    });
    expect(modelTierLadderFromDraft(draft, models)).toBeUndefined();
  });

  it("updates only the selected canonical row immutably", () => {
    const source = modelTierLadderDraftFromResponse(responseWithLadder(validLadder()));
    const updated = updateTierThinkingLevel(source, "capable", "low");

    expect(updated).not.toBe(source);
    expect(updated.capable).not.toBe(source.capable);
    expect(updated.capable).toEqual({ model: largeModel, thinkingLevel: "low" });
    expect(updated.economy).toBe(source.economy);
    expect(Object.keys(updated)).toEqual(MODEL_TIERS);
    expect(source.capable.thinkingLevel).toBe("max");
  });
});
