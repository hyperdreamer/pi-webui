import { describe, expect, it } from "vitest";
import type {
  ExactModelSelection,
  ModelTierLadder,
  ModelTierModelOption,
  ModelTierSettingsResponse,
} from "../../../shared/apiTypes";
import {
  modelPolicyDraftFromPolicy,
  selectDraftExact,
  selectDraftTier,
  sessionModelPolicyUpdateFromDraft,
  type SessionModelPolicyDraft,
  updateDraftExactModel,
  updateDraftExactThinking,
} from "./sessionModelPolicyDraft";

const defaultModelOption: ModelTierModelOption = {
  model: { provider: "openai", id: "gpt-default" },
  name: "Default",
  thinkingLevels: ["low", "medium", "high"],
};
const repairModelOption: ModelTierModelOption = {
  model: { provider: "openai", id: "gpt-repair" },
  name: "Repair",
  thinkingLevels: ["off", "low"],
};

const incompleteOrStaleExactSelections: readonly (readonly [string, ExactModelSelection])[] = [
  ["blank provider", { model: { provider: "", id: "gpt-default" }, thinkingLevel: "medium" }],
  ["blank model id", { model: { provider: "openai", id: "" }, thinkingLevel: "medium" }],
  ["blank thinking level", { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "" }],
  ["stale model", { model: { provider: "openai", id: "retired-model" }, thinkingLevel: "medium" }],
  ["stale provider", { model: { provider: "other", id: "gpt-default" }, thinkingLevel: "medium" }],
  ["model-specific unsupported thinking", { model: { provider: "openai", id: "gpt-repair" }, thinkingLevel: "medium" }],
];

function validLadder(): ModelTierLadder {
  return {
    economy: { model: { ...repairModelOption.model }, thinkingLevel: "off" },
    fast: { model: { ...repairModelOption.model }, thinkingLevel: "low" },
    standard: { model: { ...defaultModelOption.model }, thinkingLevel: "low" },
    advanced: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" },
    capable: { model: { ...defaultModelOption.model }, thinkingLevel: "high" },
    frontier: { model: { ...defaultModelOption.model }, thinkingLevel: "high" },
  };
}

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

function validCatalog(): ModelTierSettingsResponse {
  return {
    contractVersion: 1,
    ladder: validLadder(),
    models: [defaultModelOption, repairModelOption],
    rows: validRows(),
    valid: true,
  };
}

function exactDraft(exact: ExactModelSelection): SessionModelPolicyDraft {
  return { mode: "exact", exact };
}

describe("session model policy drafts", () => {
  it("switches between Exact and Tiered while preserving both remembered branches", () => {
    const exact = { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" };
    const initial = modelPolicyDraftFromPolicy({ mode: "exact", exact });

    expect(selectDraftTier(initial, "advanced")).toEqual({
      mode: "tiered",
      exact,
      tier: "advanced",
    });

    expect(selectDraftExact(selectDraftTier(initial, "advanced"))).toEqual({
      mode: "exact",
      exact,
      tier: "advanced",
    });

    expect(initial).toEqual({ mode: "exact", exact });
  });

  it("copies a policy without repairing a stale Exact branch or dropping its remembered tier", () => {
    const policy = {
      mode: "exact" as const,
      exact: {
        model: { provider: "missing-provider", id: "retired-model" },
        thinkingLevel: "retired",
      },
      tier: "capable" as const,
    };

    const draft = modelPolicyDraftFromPolicy(policy);

    expect(draft).toEqual(policy);
    expect(draft).not.toBe(policy);
    expect(draft.exact).not.toBe(policy.exact);
    expect(draft.exact.model).not.toBe(policy.exact.model);
    expect(sessionModelPolicyUpdateFromDraft(draft, validCatalog())).toBeUndefined();
  });

  it("keeps an invalid Tiered policy visibly blocked without repairing either branch", () => {
    const policy = {
      mode: "tiered" as const,
      exact: {
        model: { provider: "missing-provider", id: "retired-model" },
        thinkingLevel: "retired",
      },
      tier: "advanced" as const,
    };
    const catalog = validCatalog();
    const blockedCatalog = {
      ...catalog,
      rows: { ...catalog.rows, advanced: { valid: false, reason: "configured tier is unavailable" } },
      valid: false,
      configError: "configured ladder is invalid",
    };

    const draft = modelPolicyDraftFromPolicy(policy);

    expect(draft).toEqual(policy);
    expect(sessionModelPolicyUpdateFromDraft(draft, blockedCatalog)).toBeUndefined();
    expect(draft).toEqual(policy);
  });

  it("clears rather than clamps an unsupported thinking level when the Exact model changes", () => {
    const source = modelPolicyDraftFromPolicy({
      mode: "exact",
      exact: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" },
      tier: "advanced",
    });

    const updated = updateDraftExactModel(source, repairModelOption);

    expect(updated).toEqual({
      mode: "exact",
      exact: { model: repairModelOption.model, thinkingLevel: "" },
      tier: "advanced",
    });
    expect(updated.exact.thinkingLevel).not.toBe("off");
    expect(updated).not.toBe(source);
    expect(updated.exact).not.toBe(source.exact);
    expect(updated.exact.model).not.toBe(repairModelOption.model);
    expect(source).toEqual({
      mode: "exact",
      exact: { model: defaultModelOption.model, thinkingLevel: "medium" },
      tier: "advanced",
    });
    expect(sessionModelPolicyUpdateFromDraft(updated, validCatalog())).toBeUndefined();
  });

  it("preserves a thinking level only when the newly selected Exact model supports it", () => {
    const source = exactDraft({ model: { ...repairModelOption.model }, thinkingLevel: "low" });

    expect(updateDraftExactModel(source, defaultModelOption)).toEqual({
      mode: "exact",
      exact: { model: defaultModelOption.model, thinkingLevel: "low" },
    });
    expect(source).toEqual({
      mode: "exact",
      exact: { model: repairModelOption.model, thinkingLevel: "low" },
    });
  });

  it("updates Exact thinking immutably without silently validating or substituting it", () => {
    const source: SessionModelPolicyDraft = {
      mode: "exact",
      exact: { model: { ...repairModelOption.model }, thinkingLevel: "off" },
      tier: "fast",
    };

    const updated = updateDraftExactThinking(source, "medium");

    expect(updated).toEqual({
      mode: "exact",
      exact: { model: repairModelOption.model, thinkingLevel: "medium" },
      tier: "fast",
    });
    expect(source.exact.thinkingLevel).toBe("off");
    expect(sessionModelPolicyUpdateFromDraft(updated, validCatalog())).toBeUndefined();
  });

  it("forms a valid Exact update without leaking the remembered tier", () => {
    const exact = { model: { ...defaultModelOption.model }, thinkingLevel: "medium" };
    const draft = modelPolicyDraftFromPolicy({ mode: "exact", exact, tier: "advanced" });

    const update = sessionModelPolicyUpdateFromDraft(draft, validCatalog());

    expect(update).toEqual({ mode: "exact", exact });
    expect(update).not.toHaveProperty("tier");
    if (update?.mode !== "exact") throw new Error("Expected an Exact update");
    expect(update.exact).not.toBe(draft.exact);
    expect(update.exact.model).not.toBe(draft.exact.model);
  });

  it("allows a catalog ladder failure to remain independent from a valid Exact update", () => {
    const catalog: ModelTierSettingsResponse = {
      contractVersion: 1,
      models: [defaultModelOption, repairModelOption],
      rows: {
        economy: { valid: false },
        fast: { valid: false },
        standard: { valid: false },
        advanced: { valid: false },
        capable: { valid: false },
        frontier: { valid: false },
      },
      valid: false,
      configError: "missing model-tier ladder",
    };
    const draft = exactDraft({ model: { ...defaultModelOption.model }, thinkingLevel: "high" });

    expect(sessionModelPolicyUpdateFromDraft(draft, catalog)).toEqual({
      mode: "exact",
      exact: { model: defaultModelOption.model, thinkingLevel: "high" },
    });
  });

  it.each(incompleteOrStaleExactSelections)(
    "does not form an Exact update for an incomplete or stale draft: %s",
    (_label, exact) => {
      expect(sessionModelPolicyUpdateFromDraft(exactDraft(exact), validCatalog())).toBeUndefined();
    },
  );

  it("forms a Tiered update only from the selected tier and never includes the Exact branch", () => {
    const draft = selectDraftTier(
      exactDraft({ model: { ...defaultModelOption.model }, thinkingLevel: "medium" }),
      "advanced",
    );

    const update = sessionModelPolicyUpdateFromDraft(draft, validCatalog());

    expect(update).toEqual({ mode: "tiered", tier: "advanced" });
    expect(update).not.toHaveProperty("exact");
  });

  it("does not form a Tiered update without a selected canonical tier", () => {
    const draft: SessionModelPolicyDraft = {
      mode: "tiered",
      exact: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" },
    };

    expect(sessionModelPolicyUpdateFromDraft(draft, validCatalog())).toBeUndefined();
  });

  it("does not form a Tiered update when the ladder is missing, globally invalid, incomplete, or selected row is invalid", () => {
    const draft = selectDraftTier(
      exactDraft({ model: { ...defaultModelOption.model }, thinkingLevel: "medium" }),
      "advanced",
    );
    const catalog = validCatalog();
    const missingLadder: ModelTierSettingsResponse = {
      contractVersion: 1,
      models: catalog.models,
      rows: catalog.rows,
      valid: true,
    };
    const globallyInvalid = { ...catalog, valid: false };
    const incompleteLadder = validCatalog();
    if (incompleteLadder.ladder === undefined) throw new Error("Expected a complete test ladder");
    Reflect.deleteProperty(incompleteLadder.ladder, "frontier");
    const selectedRowInvalid = {
      ...catalog,
      rows: { ...catalog.rows, advanced: { valid: false, reason: "blocked" } },
    };

    expect(sessionModelPolicyUpdateFromDraft(draft, missingLadder)).toBeUndefined();
    expect(sessionModelPolicyUpdateFromDraft(draft, globallyInvalid)).toBeUndefined();
    expect(sessionModelPolicyUpdateFromDraft(draft, incompleteLadder)).toBeUndefined();
    expect(sessionModelPolicyUpdateFromDraft(draft, selectedRowInvalid)).toBeUndefined();
  });

  it("does not mutate a supplied draft or catalog while validating an update", () => {
    const draft = selectDraftTier(
      exactDraft({ model: { ...defaultModelOption.model }, thinkingLevel: "medium" }),
      "advanced",
    );
    const catalog = validCatalog();
    const draftBefore = structuredClone(draft);
    const catalogBefore = structuredClone(catalog);

    sessionModelPolicyUpdateFromDraft(draft, catalog);

    expect(draft).toEqual(draftBefore);
    expect(catalog).toEqual(catalogBefore);
  });
});
