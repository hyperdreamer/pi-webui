import { describe, expect, it } from "vitest";
import type {
  ExactModelSelection,
  ModelTierLadder,
  ModelTierModelOption,
  ModelTierSettingsResponse,
  SessionDefaultsResponse,
  SessionDefaultsV2Response,
  SessionModelPolicy,
} from "../../../shared/apiTypes";
import {
  completeUnownedStarterExactFromActiveTier,
  evaluateStarterModelPolicyDraft,
  isDraftReadyToApply,
  modelPolicyDraftFromPolicy,
  relinkStarterExactBranch,
  sameExactSelection,
  seedModelPolicyDraft,
  seedStarterModelPolicyDraft,
  selectDraftExact,
  selectDraftTier,
  sessionModelPolicyUpdateFromDraft,
  starterModelPolicyPreferenceFromDraft,
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
const completePiDefault: ExactModelSelection = {
  model: { provider: "openai", id: "gpt-default" },
  thinkingLevel: "medium",
};
const unavailableExact: ExactModelSelection = {
  model: { provider: "unavailable", id: "retired-model" },
  thinkingLevel: "retired",
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

function starterDefaults(
  overrides: Partial<SessionDefaultsResponse> = {},
): SessionDefaultsResponse {
  return {
    model: { provider: "openai", id: "gpt-default" },
    thinkingLevel: "medium",
    models: [{ provider: "openai", id: "gpt-default" }],
    thinkingLevels: ["low", "medium", "high"],
    ...overrides,
  };
}

function v2Defaults(
  overrides: Partial<SessionDefaultsV2Response> = {},
): SessionDefaultsV2Response {
  return {
    starterModelPolicyContractVersion: 2,
    model: { ...completePiDefault.model },
    thinkingLevel: completePiDefault.thinkingLevel,
    models: [{ ...completePiDefault.model }],
    thinkingLevels: ["low", "medium", "high"],
    ...overrides,
  };
}

function v2DefaultsWithoutPiExact(
  overrides: Omit<Partial<SessionDefaultsV2Response>, "model" | "thinkingLevel"> = {},
): SessionDefaultsV2Response {
  const defaults = v2Defaults({ ...overrides, thinkingLevel: "" });
  delete defaults.model;
  return defaults;
}

describe("starter model policy drafts", () => {
  it("seeds the complete machine Exact defaults when no preference is stored", () => {
    const defaults = starterDefaults();
    const before = structuredClone(defaults);

    const draft = seedStarterModelPolicyDraft(defaults);

    expect(draft).toEqual({
      mode: "exact",
      exact: {
        model: { provider: "openai", id: "gpt-default" },
        thinkingLevel: "medium",
      },
    });
    expect(draft.exact.model).not.toBe(defaults.model);
    expect(defaults).toEqual(before);
  });

  it("keeps old unversioned peers on the Exact Pi-default behavior", () => {
    expect(seedStarterModelPolicyDraft(starterDefaults())).toEqual({
      mode: "exact",
      exact: completePiDefault,
    });
  });

  it("seeds a fresh version-two response as Tiered with a complete Pi Exact branch", () => {
    expect(seedStarterModelPolicyDraft(v2Defaults({}))).toEqual({
      mode: "tiered",
      tier: "standard",
      exact: completePiDefault,
    });
  });

  it("clones a full version-two preference verbatim, including unavailable remembered Exact intent", () => {
    const defaults = v2Defaults({
      starterModelPolicyPreference: {
        mode: "exact",
        exact: unavailableExact,
        tier: "frontier",
      },
    });
    const before = structuredClone(defaults);

    const draft = seedStarterModelPolicyDraft(defaults);

    expect(draft).toEqual({
      mode: "exact",
      exact: unavailableExact,
      tier: "frontier",
    });
    expect(draft.exact).not.toBe(unavailableExact);
    expect(draft.exact.model).not.toBe(unavailableExact.model);
    expect(defaults).toEqual(before);
  });

  it("retains an unavailable Exact branch from a full Tiered version-two preference", () => {
    const defaults = v2Defaults({
      starterModelPolicyPreference: {
        mode: "tiered",
        exact: unavailableExact,
        tier: "frontier",
      },
    });

    expect(seedStarterModelPolicyDraft(defaults)).toEqual({
      mode: "tiered",
      exact: unavailableExact,
      tier: "frontier",
    });
  });

  it("hydrates a version-two legacy Tiered preference from complete Pi defaults", () => {
    const defaults = v2Defaults({
      starterModelPolicyPreference: { mode: "tiered", tier: "fast" },
    });

    const draft = seedStarterModelPolicyDraft(defaults);

    expect(draft).toEqual({ mode: "tiered", exact: completePiDefault, tier: "fast" });
    expect(draft.exact.model).not.toBe(defaults.model);
  });

  it("keeps an incomplete version-two legacy Exact preference incomplete and blocked", () => {
    const defaults = v2DefaultsWithoutPiExact({
      starterModelPolicyPreference: { mode: "exact" },
    });
    const draft = seedStarterModelPolicyDraft(defaults);

    expect(draft).toEqual({
      mode: "exact",
      exact: { model: { provider: "", id: "" }, thinkingLevel: "" },
    });
    expect(evaluateStarterModelPolicyDraft(draft, validCatalog())).toEqual({
      kind: "blocked",
      reason: "Choose a provider, model, and thinking level before starting",
    });
  });

  it("fills fresh and legacy Tiered empty Exact branches only after their active tiers resolve", () => {
    const freshDefaults = v2DefaultsWithoutPiExact();
    const legacyDefaults = v2DefaultsWithoutPiExact({
      starterModelPolicyPreference: { mode: "tiered", tier: "frontier" },
    });
    const fresh = seedStarterModelPolicyDraft(freshDefaults);
    const legacy = seedStarterModelPolicyDraft(legacyDefaults);
    const unavailableCatalog = validCatalog();
    unavailableCatalog.rows.standard = { valid: false, reason: "Standard tier is unavailable" };
    const freshBefore = structuredClone(fresh);
    const legacyBefore = structuredClone(legacy);

    const unresolvedFresh = completeUnownedStarterExactFromActiveTier(
      fresh,
      freshDefaults,
      unavailableCatalog,
    );
    const completedFresh = completeUnownedStarterExactFromActiveTier(fresh, freshDefaults, validCatalog());
    const completedLegacy = completeUnownedStarterExactFromActiveTier(legacy, legacyDefaults, validCatalog());

    expect(unresolvedFresh).toEqual(fresh);
    expect(unresolvedFresh).not.toBe(fresh);
    expect(completedFresh).toEqual({
      mode: "tiered",
      tier: "standard",
      exact: validLadder().standard,
    });
    expect(completedLegacy).toEqual({
      mode: "tiered",
      tier: "frontier",
      exact: validLadder().frontier,
    });
    expect(fresh).toEqual(freshBefore);
    expect(legacy).toEqual(legacyBefore);
  });

  it("fills an unowned Exact branch from its selected valid tier despite inactive catalog rows", () => {
    const defaults = v2DefaultsWithoutPiExact();
    const draft = seedStarterModelPolicyDraft(defaults);
    const catalog = validCatalog();
    catalog.rows.frontier = { valid: false, reason: "Frontier tier is unavailable" };
    catalog.valid = false;

    expect(completeUnownedStarterExactFromActiveTier(draft, defaults, catalog)).toEqual({
      mode: "tiered",
      tier: "standard",
      exact: validLadder().standard,
    });
  });

  it("never replaces a full remembered Exact branch through tier completion", () => {
    const defaults = v2Defaults({
      starterModelPolicyPreference: {
        mode: "tiered",
        exact: unavailableExact,
        tier: "standard",
      },
    });
    const draft = seedStarterModelPolicyDraft(defaults);
    const before = structuredClone(draft);

    const completed = completeUnownedStarterExactFromActiveTier(draft, defaults, validCatalog());

    expect(completed).toEqual(draft);
    expect(completed).not.toBe(draft);
    expect(completed.exact).not.toBe(draft.exact);
    expect(draft).toEqual(before);
  });

  it("restores Exact mode with its optional remembered tier", () => {
    expect(seedStarterModelPolicyDraft(starterDefaults({
      starterModelPolicyPreference: { mode: "exact", tier: "fast" },
    }))).toMatchObject({ mode: "exact", tier: "fast" });
  });

  it("restores a complete Tiered preference without replacing its tier", () => {
    expect(seedStarterModelPolicyDraft(starterDefaults({
      starterModelPolicyPreference: { mode: "tiered", tier: "advanced" },
    }))).toMatchObject({ mode: "tiered", tier: "advanced" });
  });

  it("seeds an empty Exact branch when the machine defaults are incomplete", () => {
    const incompleteDefaults = starterDefaults({ thinkingLevel: "" });
    delete incompleteDefaults.model;

    expect(seedStarterModelPolicyDraft(incompleteDefaults)).toEqual({
      mode: "exact",
      exact: { model: { provider: "", id: "" }, thinkingLevel: "" },
    });
  });

  it("relinks only an Exact draft to changed defaults while preserving its tier", () => {
    const draft: SessionModelPolicyDraft = {
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-old" }, thinkingLevel: "low" },
      tier: "fast",
    };
    const defaults = starterDefaults({
      model: { provider: "anthropic", id: "claude-new" },
      thinkingLevel: "high",
    });
    const draftBefore = structuredClone(draft);
    const defaultsBefore = structuredClone(defaults);

    const relinked = relinkStarterExactBranch(draft, defaults);

    expect(relinked).toEqual({
      mode: "exact",
      exact: { model: { provider: "anthropic", id: "claude-new" }, thinkingLevel: "high" },
      tier: "fast",
    });
    expect(relinked).not.toBe(draft);
    expect(relinked.exact.model).not.toBe(defaults.model);
    expect(draft).toEqual(draftBefore);
    expect(defaults).toEqual(defaultsBefore);
  });

  it("returns the same Exact draft for a value-equivalent relink", () => {
    const draft: SessionModelPolicyDraft = {
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
      tier: "capable",
    };

    expect(relinkStarterExactBranch(draft, starterDefaults())).toBe(draft);
  });

  it("does not overwrite the remembered Exact branch while Tiered", () => {
    const draft: SessionModelPolicyDraft = {
      mode: "tiered",
      exact: { model: { provider: "openai", id: "remembered" }, thinkingLevel: "low" },
      tier: "advanced",
    };
    const before = structuredClone(draft);

    expect(relinkStarterExactBranch(draft, starterDefaults())).toBe(draft);
    expect(draft).toEqual(before);
  });

  it("derives only complete persisted preferences without mutating drafts", () => {
    const exact: SessionModelPolicyDraft = {
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
    };
    const exactWithTier: SessionModelPolicyDraft = { ...exact, tier: "fast" };
    const tiered: SessionModelPolicyDraft = { ...exact, mode: "tiered", tier: "frontier" };
    const incompleteTiered: SessionModelPolicyDraft = { ...exact, mode: "tiered" };
    const before = structuredClone({ exact, exactWithTier, tiered, incompleteTiered });

    expect(starterModelPolicyPreferenceFromDraft(exact)).toEqual({ mode: "exact" });
    expect(starterModelPolicyPreferenceFromDraft(exactWithTier)).toEqual({
      mode: "exact",
      tier: "fast",
    });
    expect(starterModelPolicyPreferenceFromDraft(tiered)).toEqual({
      mode: "tiered",
      tier: "frontier",
    });
    expect(starterModelPolicyPreferenceFromDraft(incompleteTiered)).toBeUndefined();
    expect({ exact, exactWithTier, tiered, incompleteTiered }).toEqual(before);
  });

  it("compares Exact selections by provider, model id, and thinking level", () => {
    const exact: ExactModelSelection = {
      model: { provider: "openai", id: "gpt-default" },
      thinkingLevel: "medium",
    };

    expect(sameExactSelection(exact, structuredClone(exact))).toBe(true);
    expect(sameExactSelection(exact, {
      model: { provider: "anthropic", id: "gpt-default" },
      thinkingLevel: "medium",
    })).toBe(false);
    expect(sameExactSelection(exact, {
      model: { provider: "openai", id: "gpt-other" },
      thinkingLevel: "medium",
    })).toBe(false);
    expect(sameExactSelection(exact, {
      model: { provider: "openai", id: "gpt-default" },
      thinkingLevel: "high",
    })).toBe(false);
  });
});

describe("starter model policy readiness", () => {
  it("reports the active Exact provider/model as unavailable while ignoring an inactive tier", () => {
    const catalog = validCatalog();
    catalog.rows.frontier = { valid: false, reason: "Frontier tier is unavailable" };
    const draft: SessionModelPolicyDraft = {
      mode: "exact",
      exact: unavailableExact,
      tier: "frontier",
    };

    expect(evaluateStarterModelPolicyDraft(draft, catalog)).toEqual({
      kind: "blocked",
      reason: "Selected provider/model is unavailable",
    });
  });

  it("reports unsupported active Exact thinking while ignoring an inactive tier", () => {
    const catalog = validCatalog();
    catalog.rows.frontier = { valid: false, reason: "Frontier tier is unavailable" };
    const draft: SessionModelPolicyDraft = {
      mode: "exact",
      exact: { model: { ...repairModelOption.model }, thinkingLevel: "medium" },
      tier: "frontier",
    };

    expect(evaluateStarterModelPolicyDraft(draft, catalog)).toEqual({
      kind: "blocked",
      reason: "Selected thinking level is unsupported by the selected model",
    });
  });

  it("returns the selected Tiered row reason while ignoring an unavailable inactive Exact branch", () => {
    const catalog = validCatalog();
    catalog.rows.advanced = { valid: false, reason: "Advanced tier is disabled" };
    const draft: SessionModelPolicyDraft = {
      mode: "tiered",
      exact: unavailableExact,
      tier: "advanced",
    };

    expect(evaluateStarterModelPolicyDraft(draft, catalog)).toEqual({
      kind: "blocked",
      reason: "Advanced tier is disabled",
    });
  });

  it("reveals a retained branch block only after that branch becomes active", () => {
    const tiered: SessionModelPolicyDraft = {
      mode: "tiered",
      exact: unavailableExact,
      tier: "standard",
    };

    expect(evaluateStarterModelPolicyDraft(tiered, validCatalog())).toMatchObject({ kind: "ready" });
    expect(evaluateStarterModelPolicyDraft(selectDraftExact(tiered), validCatalog())).toEqual({
      kind: "blocked",
      reason: "Selected provider/model is unavailable",
    });
    expect(evaluateStarterModelPolicyDraft(selectDraftTier(selectDraftExact(tiered), "standard"), validCatalog()))
      .toMatchObject({ kind: "ready" });
  });

  it("becomes ready after tier configuration repair without changing the draft", () => {
    const draft: SessionModelPolicyDraft = {
      mode: "tiered",
      exact: unavailableExact,
      tier: "advanced",
    };
    const brokenCatalog = validCatalog();
    brokenCatalog.rows.advanced = { valid: false, reason: "Advanced tier is unavailable" };
    const before = structuredClone(draft);

    const blocked = evaluateStarterModelPolicyDraft(draft, brokenCatalog);
    const ready = evaluateStarterModelPolicyDraft(draft, validCatalog());

    expect(blocked).toEqual({ kind: "blocked", reason: "Advanced tier is unavailable" });
    expect(ready).toMatchObject({ kind: "ready" });
    expect(draft).toEqual(before);
  });

  it("returns a deep-cloned full Tiered initializer and selected resolved tuple", () => {
    const draft: SessionModelPolicyDraft = {
      mode: "tiered",
      exact: completePiDefault,
      tier: "standard",
    };
    const catalog = validCatalog();
    const draftBefore = structuredClone(draft);
    const catalogBefore = structuredClone(catalog);

    const evaluation = evaluateStarterModelPolicyDraft(draft, catalog);

    expect(evaluation).toEqual({
      kind: "ready",
      initialModelPolicy: {
        mode: "tiered",
        exact: completePiDefault,
        tier: "standard",
      },
      resolved: validLadder().standard,
    });
    if (evaluation.kind !== "ready") throw new Error("Expected a ready starter policy evaluation");
    expect(evaluation.initialModelPolicy.exact).not.toBe(draft.exact);
    expect(evaluation.initialModelPolicy.exact.model).not.toBe(draft.exact.model);
    expect(evaluation.resolved).not.toBe(catalog.ladder?.standard);
    expect(evaluation.resolved.model).not.toBe(catalog.ladder?.standard.model);
    expect(draft).toEqual(draftBefore);
    expect(catalog).toEqual(catalogBefore);
  });

  it("uses the catalog error before a stable fallback when a selected Tiered row has no reason", () => {
    const catalogError = validCatalog();
    catalogError.rows.frontier = { valid: false };
    catalogError.configError = "Model tier configuration is invalid";
    const fallback = validCatalog();
    fallback.rows.frontier = { valid: false };
    const draft: SessionModelPolicyDraft = {
      mode: "tiered",
      exact: completePiDefault,
      tier: "frontier",
    };

    expect(evaluateStarterModelPolicyDraft(draft, catalogError)).toEqual({
      kind: "blocked",
      reason: "Model tier configuration is invalid",
    });
    expect(evaluateStarterModelPolicyDraft(draft, fallback)).toEqual({
      kind: "blocked",
      reason: "Selected model tier is unavailable",
    });
  });
});

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

describe("seedModelPolicyDraft", () => {
  it("restores a persisted policy including a remembered tier in exact mode", () => {
    const catalog = validCatalog();
    const policy: SessionModelPolicy = {
      mode: "exact",
      exact: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" },
      tier: "fast",
    };

    const draft = seedModelPolicyDraft({ policy, catalog });

    expect(draft).toEqual({
      mode: "exact",
      exact: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" },
      tier: "fast",
    });
    expect(isDraftReadyToApply(draft, catalog)).toBe(true);
  });

  it("falls back to the live resolved tuple when nothing is persisted", () => {
    const catalog = validCatalog();
    const liveResolved = { model: { ...repairModelOption.model }, thinkingLevel: "low" };

    const draft = seedModelPolicyDraft({ liveResolved, catalog });

    expect(draft).toEqual({ mode: "exact", exact: liveResolved });
    expect(isDraftReadyToApply(draft, catalog)).toBe(true);
  });

  it("seeds an empty exact draft when there is no policy and no live tuple", () => {
    const catalog = validCatalog();
    const draft = seedModelPolicyDraft({ catalog });

    expect(draft).toEqual({
      mode: "exact",
      exact: { model: { provider: "", id: "" }, thinkingLevel: "" },
    });
    expect(isDraftReadyToApply(draft, catalog)).toBe(false);
  });

  it("pre-selects standard for a tiered policy with no tier when that row is valid", () => {
    const catalog = validCatalog();
    const policy: SessionModelPolicy = {
      mode: "tiered",
      exact: { model: { provider: "", id: "" }, thinkingLevel: "" },
    };

    const draft = seedModelPolicyDraft({ policy, catalog });

    expect(draft.tier).toBe("standard");
    expect(isDraftReadyToApply(draft, catalog)).toBe(true);
  });

  it("leaves the tier unset when the standard row is invalid", () => {
    const catalog = validCatalog();
    catalog.rows.standard = { valid: false, reason: "Standard is not configured" };
    const policy: SessionModelPolicy = {
      mode: "tiered",
      exact: { model: { provider: "", id: "" }, thinkingLevel: "" },
    };

    const draft = seedModelPolicyDraft({ policy, catalog });

    expect(draft.tier).toBeUndefined();
    expect(isDraftReadyToApply(draft, catalog)).toBe(false);
  });

  it("does not overwrite a tier the persisted policy already chose", () => {
    const catalog = validCatalog();
    const policy: SessionModelPolicy = {
      mode: "tiered",
      exact: { model: { provider: "", id: "" }, thinkingLevel: "" },
      tier: "frontier",
    };

    const draft = seedModelPolicyDraft({ policy, catalog });

    expect(draft.tier).toBe("frontier");
    expect(isDraftReadyToApply(draft, catalog)).toBe(true);
  });

  it("does not pre-select a tier for an exact draft", () => {
    const catalog = validCatalog();

    expect(seedModelPolicyDraft({ catalog }).tier).toBeUndefined();
  });
});

describe("isDraftReadyToApply", () => {
  it("is false when the catalog has not loaded", () => {
    // Valid against validCatalog(), so this isolates catalog absence rather than
    // also failing on an invalid selection.
    const draft = modelPolicyDraftFromPolicy({
      mode: "exact",
      exact: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" },
    });

    expect(isDraftReadyToApply(draft, undefined)).toBe(false);
    expect(isDraftReadyToApply(draft, validCatalog())).toBe(true);
  });

  it("is false for an exact draft whose thinking level was cleared by a model change", () => {
    const catalog = validCatalog();
    const draft = modelPolicyDraftFromPolicy({
      mode: "exact",
      exact: { model: { ...defaultModelOption.model }, thinkingLevel: "" },
    });

    expect(isDraftReadyToApply(draft, catalog)).toBe(false);
  });

  it("is false for a tiered draft with no tier chosen", () => {
    const catalog = validCatalog();
    const draft: SessionModelPolicyDraft = {
      mode: "tiered",
      exact: { model: { provider: "", id: "" }, thinkingLevel: "" },
    };

    expect(isDraftReadyToApply(draft, catalog)).toBe(false);
  });

  it("agrees with sessionModelPolicyUpdateFromDraft on every input", () => {
    const catalog = validCatalog();
    const drafts: SessionModelPolicyDraft[] = [
      // Ready. Without this row the matrix proves nothing about Exact mode.
      {
        mode: "exact",
        exact: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" },
      },
      // Not ready: level cleared by a model change.
      {
        mode: "exact",
        exact: { model: { ...defaultModelOption.model }, thinkingLevel: "" },
      },
      // Not ready: model absent from the catalog.
      {
        mode: "exact",
        exact: { model: { provider: "openai", id: "not-in-catalog" }, thinkingLevel: "medium" },
      },
      // Ready: a level the repair model does support.
      {
        mode: "exact",
        exact: { model: { ...repairModelOption.model }, thinkingLevel: "low" },
      },
      // Not ready: a level the repair model does not support.
      {
        mode: "exact",
        exact: { model: { ...repairModelOption.model }, thinkingLevel: "high" },
      },
      { mode: "exact", exact: { model: { provider: "", id: "" }, thinkingLevel: "" } },
      {
        mode: "tiered",
        exact: { model: { provider: "", id: "" }, thinkingLevel: "" },
        tier: "standard",
      },
      { mode: "tiered", exact: { model: { provider: "", id: "" }, thinkingLevel: "" } },
    ];

    for (const draft of drafts) {
      expect(isDraftReadyToApply(draft, catalog)).toBe(
        sessionModelPolicyUpdateFromDraft(draft, catalog) !== undefined,
      );
    }
  });
});
