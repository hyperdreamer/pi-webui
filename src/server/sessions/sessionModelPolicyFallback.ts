import type {
  ExactModelSelection,
  SessionModelPolicy,
} from "../../shared/apiTypes.js";
import type { SessionModelPolicyPlan } from "./sessionModelPolicy.js";
import type { UtilityModelUnavailable } from "./utilityModelResolver.js";

/**
 * Build the substituted exact policy and its defensive re-validation target
 * from the resolved lightweight candidate. Pure: neither argument is mutated,
 * and the target is a separate clone so it never aliases `policy.exact`.
 */
export function fallbackSessionModelPolicy(
  requested: SessionModelPolicy,
  candidate: { provider: string; id: string; thinkingLevel: string },
): SessionModelPolicyPlan {
  const exact: ExactModelSelection = {
    model: { provider: candidate.provider, id: candidate.id },
    thinkingLevel: candidate.thinkingLevel,
  };
  return {
    policy: {
      mode: "exact",
      exact,
      ...(requested.tier === undefined ? {} : { tier: requested.tier }),
    },
    target: { model: { ...exact.model }, thinkingLevel: exact.thinkingLevel },
  };
}

/**
 * The single explicit failure when the lightweight slot cannot start the
 * session. It names the requested policy, the original recognized failure, the
 * precise lightweight reason, and where the slot is configured.
 */
export function initialPolicyUnavailableError(
  requested: SessionModelPolicy,
  cause: unknown,
  unavailable: UtilityModelUnavailable | undefined,
): Error {
  const original = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `Could not start the session with the remembered model policy (${describeRequestedPolicy(requested)}): ${original} The lightweight utility model fallback is unavailable because ${unavailableClause(unavailable)}. Configure utilityModels.lightweight in Settings → Utility models.`,
    { cause },
  );
}

function describeRequestedPolicy(requested: SessionModelPolicy): string {
  if (requested.mode === "exact") {
    return `${requested.exact.model.provider}/${requested.exact.model.id} at thinking level ${requested.exact.thinkingLevel}`;
  }
  return requested.tier === undefined ? "Tiered mode" : `tier ${requested.tier}`;
}

function unavailableClause(unavailable: UtilityModelUnavailable | undefined): string {
  if (unavailable === undefined) return "the lightweight model is not available to this session";
  const clause = UNAVAILABLE_CLAUSES[unavailable.reason];
  const detail = unavailable.detail;
  return detail === undefined || detail === "" ? clause : `${clause} (${detail})`;
}

const UNAVAILABLE_CLAUSES: Record<UtilityModelUnavailable["reason"], string> = {
  "slot-unset": "no lightweight model is configured",
  "config-invalid": "the utility model configuration is invalid",
  "model-unavailable": "its configured model is unavailable",
  "thinking-level-unsupported": "its configured thinking level is unsupported",
  "resolution-failed": "the lightweight model could not be resolved",
};
