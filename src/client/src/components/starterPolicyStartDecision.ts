import type {
  ModelTierSettingsResponse,
  StarterModelPolicyPreference,
} from "../../../shared/apiTypes";
import {
  evaluateStarterModelPolicyDraft,
  isCanonicalTier,
  isSyntacticallyCompleteExactSelection,
  type SessionModelPolicyDraft,
} from "./sessionModelPolicyDraft";

export const STARTER_POLICY_FALLBACK_WARNING_CLAUSE =
  "The session may start with the Lightweight utility model.";

/**
 * The client-side completeness contract the server request parser enforces for
 * the fields a draft can carry: non-blank Exact provider/id/thinking in both
 * modes, plus a canonical tier while Tiered is active.
 */
export function isStructurallyCompleteStarterPolicy(
  draft: SessionModelPolicyDraft,
): boolean {
  return isSyntacticallyCompleteExactSelection(draft.exact)
    && (draft.mode === "exact" || isCanonicalTier(draft.tier));
}

export function starterModelPolicyPreference(
  draft: SessionModelPolicyDraft,
): StarterModelPolicyPreference {
  if (!isStructurallyCompleteStarterPolicy(draft)) {
    throw new Error("Cannot build a complete starter model policy from an incomplete draft");
  }
  return {
    mode: draft.mode,
    exact: {
      model: { ...draft.exact.model },
      thinkingLevel: draft.exact.thinkingLevel,
    },
    ...(draft.tier === undefined ? {} : { tier: draft.tier }),
  };
}

export type StarterStartDecision =
  | { kind: "ready" }
  | { kind: "fallback"; requested: StarterModelPolicyPreference; warning?: string }
  | { kind: "blocked"; reason: string };

export function starterStartDecision(input: {
  draft: SessionModelPolicyDraft | undefined;
  catalog: ModelTierSettingsResponse | undefined;
  fallbackSupported: boolean;
  catalogUnavailableReason: string;
}): StarterStartDecision | undefined {
  const { draft, catalog, fallbackSupported, catalogUnavailableReason } = input;
  if (draft === undefined) return undefined;

  if (!isStructurallyCompleteStarterPolicy(draft)) {
    if (catalog === undefined) {
      return { kind: "blocked", reason: catalogUnavailableReason };
    }
    const evaluation = evaluateStarterModelPolicyDraft(draft, catalog);
    if (evaluation.kind === "blocked") {
      return { kind: "blocked", reason: evaluation.reason };
    }
    // Defensive: the predicate is strictly weaker than the evaluator, so an
    // incomplete draft cannot evaluate ready.
    return {
      kind: "blocked",
      reason: "Choose a provider, model, and thinking level before starting",
    };
  }

  const requested = starterModelPolicyPreference(draft);
  if (catalog === undefined) {
    return fallbackSupported
      ? { kind: "fallback", requested }
      : { kind: "blocked", reason: catalogUnavailableReason };
  }

  const evaluation = evaluateStarterModelPolicyDraft(draft, catalog);
  if (evaluation.kind === "ready") return { kind: "ready" };
  if (!fallbackSupported) return { kind: "blocked", reason: evaluation.reason };
  return {
    kind: "fallback",
    requested,
    warning: `${evaluation.reason}. ${STARTER_POLICY_FALLBACK_WARNING_CLAUSE}`,
  };
}
