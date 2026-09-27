import { describe, expect, it } from "vitest";
import type {
  ModelTier,
  ModelTierLadder,
  ModelTierModelOption,
  ModelTierSettingsResponse,
} from "../../../shared/apiTypes";
import {
  isStructurallyCompleteStarterPolicy,
  starterModelPolicyPreference,
  starterStartDecision,
  STARTER_POLICY_FALLBACK_WARNING_CLAUSE,
} from "./starterPolicyStartDecision";

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

function validCatalog(): ModelTierSettingsResponse {
  const ladder: ModelTierLadder = {
    economy: { model: { ...defaultModelOption.model }, thinkingLevel: "low" },
    fast: { model: { ...defaultModelOption.model }, thinkingLevel: "low" },
    standard: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" },
    advanced: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" },
    capable: { model: { ...defaultModelOption.model }, thinkingLevel: "high" },
    frontier: { model: { ...defaultModelOption.model }, thinkingLevel: "high" },
  };
  return {
    contractVersion: 1,
    ladder,
    models: [defaultModelOption, repairModelOption],
    rows: {
      economy: { valid: true },
      fast: { valid: true },
      standard: { valid: true },
      advanced: { valid: true },
      capable: { valid: true },
      frontier: { valid: true },
    },
    valid: true,
  };
}

const COMPLETE_EXACT = {
  mode: "exact",
  exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
} as const;
const UNAVAILABLE_EXACT = {
  mode: "exact",
  exact: { model: { provider: "openai", id: "retired" }, thinkingLevel: "medium" },
} as const;
const UNSUPPORTED_LEVEL = {
  mode: "exact",
  exact: { model: { provider: "openai", id: "gpt-repair" }, thinkingLevel: "high" },
} as const;
const COMPLETE_TIERED = {
  mode: "tiered",
  exact: COMPLETE_EXACT.exact,
  tier: "standard",
} as const;
const INCOMPLETE_EXACT = {
  mode: "exact",
  exact: { model: { provider: "", id: "" }, thinkingLevel: "" },
} as const;
const INCOMPLETE_TIERED = { mode: "tiered", exact: COMPLETE_EXACT.exact } as const;

const LOADING_REASON = "Loading model policy choices";

describe("isStructurallyCompleteStarterPolicy", () => {
  it("accepts complete exact and tiered drafts", () => {
    expect(isStructurallyCompleteStarterPolicy(COMPLETE_EXACT)).toBe(true);
    expect(isStructurallyCompleteStarterPolicy(COMPLETE_TIERED)).toBe(true);
  });

  it("rejects blank fields and tiered drafts without a canonical tier", () => {
    expect(isStructurallyCompleteStarterPolicy({
      mode: "exact",
      exact: { model: { provider: "", id: "gpt-default" }, thinkingLevel: "medium" },
    })).toBe(false);
    expect(isStructurallyCompleteStarterPolicy({
      mode: "exact",
      exact: { model: { provider: "openai", id: "" }, thinkingLevel: "medium" },
    })).toBe(false);
    expect(isStructurallyCompleteStarterPolicy({
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "" },
    })).toBe(false);
    expect(isStructurallyCompleteStarterPolicy(INCOMPLETE_TIERED)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- deliberately non-canonical tier string from an untyped boundary.
    expect(isStructurallyCompleteStarterPolicy({ ...COMPLETE_TIERED, tier: "nonsense" as ModelTier })).toBe(false);
  });
});

describe("starterModelPolicyPreference", () => {
  it("returns a complete deep clone", () => {
    const preference = starterModelPolicyPreference(COMPLETE_TIERED);

    expect(preference).toEqual({
      mode: "tiered",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" },
      tier: "standard",
    });
    preference.exact.model.id = "mutated";
    expect(COMPLETE_TIERED.exact.model.id).toBe("gpt-default");
  });

  it("throws for an incomplete draft", () => {
    expect(() => starterModelPolicyPreference(INCOMPLETE_EXACT)).toThrow(
      "Cannot build a complete starter model policy from an incomplete draft",
    );
  });
});

describe("starterStartDecision", () => {
  const catalog = validCatalog();

  it("returns undefined while the draft is loading", () => {
    expect(starterStartDecision({
      draft: undefined,
      catalog,
      fallbackSupported: true,
      catalogUnavailableReason: LOADING_REASON,
    })).toBeUndefined();
  });

  it("blocks an incomplete draft with the caller reason when the catalog is unavailable", () => {
    expect(starterStartDecision({
      draft: INCOMPLETE_EXACT,
      catalog: undefined,
      fallbackSupported: true,
      catalogUnavailableReason: LOADING_REASON,
    })).toEqual({ kind: "blocked", reason: LOADING_REASON });
  });

  it("blocks an incomplete draft with the evaluator reason when the catalog is present", () => {
    expect(starterStartDecision({
      draft: INCOMPLETE_EXACT,
      catalog,
      fallbackSupported: true,
      catalogUnavailableReason: LOADING_REASON,
    })).toEqual({
      kind: "blocked",
      reason: "Choose a provider, model, and thinking level before starting",
    });
    expect(starterStartDecision({
      draft: INCOMPLETE_TIERED,
      catalog,
      fallbackSupported: true,
      catalogUnavailableReason: LOADING_REASON,
    })).toEqual({ kind: "blocked", reason: "Selected model tier is unavailable" });
  });

  it("falls back without a warning when the catalog is unavailable and the capability is present", () => {
    const decision = starterStartDecision({
      draft: COMPLETE_EXACT,
      catalog: undefined,
      fallbackSupported: true,
      catalogUnavailableReason: LOADING_REASON,
    });

    expect(decision).toEqual({
      kind: "fallback",
      requested: starterModelPolicyPreference(COMPLETE_EXACT),
    });
    expect(decision === undefined ? true : Object.hasOwn(decision, "warning")).toBe(false);
  });

  it("blocks a complete draft when the catalog is unavailable and the capability is absent", () => {
    expect(starterStartDecision({
      draft: COMPLETE_EXACT,
      catalog: undefined,
      fallbackSupported: false,
      catalogUnavailableReason: LOADING_REASON,
    })).toEqual({ kind: "blocked", reason: LOADING_REASON });
  });

  it("readies a complete draft the catalog accepts", () => {
    expect(starterStartDecision({
      draft: COMPLETE_EXACT,
      catalog,
      fallbackSupported: false,
      catalogUnavailableReason: LOADING_REASON,
    })).toEqual({ kind: "ready" });
    expect(starterStartDecision({
      draft: COMPLETE_TIERED,
      catalog,
      fallbackSupported: false,
      catalogUnavailableReason: LOADING_REASON,
    })).toEqual({ kind: "ready" });
  });

  it("falls back with the live reason and the contingent clause when the catalog blocks", () => {
    expect(starterStartDecision({
      draft: UNAVAILABLE_EXACT,
      catalog,
      fallbackSupported: true,
      catalogUnavailableReason: LOADING_REASON,
    })).toEqual({
      kind: "fallback",
      requested: starterModelPolicyPreference(UNAVAILABLE_EXACT),
      warning: `Selected provider/model is unavailable. ${STARTER_POLICY_FALLBACK_WARNING_CLAUSE}`,
    });

    const unsupported = starterStartDecision({
      draft: UNSUPPORTED_LEVEL,
      catalog,
      fallbackSupported: true,
      catalogUnavailableReason: LOADING_REASON,
    });
    expect(unsupported?.kind === "fallback" ? unsupported.warning : undefined).toBe(
      `Selected thinking level is unsupported by the selected model. ${STARTER_POLICY_FALLBACK_WARNING_CLAUSE}`,
    );
  });

  it("blocks with the evaluator reason when the catalog blocks and the capability is absent", () => {
    expect(starterStartDecision({
      draft: UNAVAILABLE_EXACT,
      catalog,
      fallbackSupported: false,
      catalogUnavailableReason: LOADING_REASON,
    })).toEqual({ kind: "blocked", reason: "Selected provider/model is unavailable" });
    expect(starterStartDecision({
      draft: UNSUPPORTED_LEVEL,
      catalog,
      fallbackSupported: false,
      catalogUnavailableReason: LOADING_REASON,
    })).toEqual({
      kind: "blocked",
      reason: "Selected thinking level is unsupported by the selected model",
    });
  });

  it("falls back for an unsupported level when the catalog is unavailable and the capability is present", () => {
    expect(starterStartDecision({
      draft: UNSUPPORTED_LEVEL,
      catalog: undefined,
      fallbackSupported: true,
      catalogUnavailableReason: LOADING_REASON,
    })?.kind).toBe("fallback");
  });

  it("never falls back for an incomplete draft", () => {
    for (const draft of [INCOMPLETE_EXACT, INCOMPLETE_TIERED]) {
      expect(starterStartDecision({
        draft,
        catalog,
        fallbackSupported: true,
        catalogUnavailableReason: LOADING_REASON,
      })?.kind).toBe("blocked");
      expect(starterStartDecision({
        draft,
        catalog: undefined,
        fallbackSupported: true,
        catalogUnavailableReason: LOADING_REASON,
      })?.kind).toBe("blocked");
    }
  });
});
