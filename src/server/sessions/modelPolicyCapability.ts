import type {
  ExactModelSelection,
  ModelTier,
  SessionModelPolicy,
} from "../../shared/apiTypes.js";
import type { LadderValidation } from "./modelTierRegistry.js";

/**
 * Version of the capability result. Consumers reject unknown versions rather
 * than attempt a partial read, so this number is part of the contract and moves
 * only alongside a documented field change.
 */
export const MODEL_POLICY_CONTRACT_VERSION = 1;

/**
 * What `spawn_subsession` accepts, advertised so a caller can confirm a typed
 * tier is a binding channel before dispatching anything.
 *
 * `tier` is the only channel. Prompt text never selects a model: the runtime
 * does not scan prompt bytes for model-selection commands. A rendered
 * `Model tier: <tier>` line carries no control effect. The one exception is a
 * guard rather than a mechanism: a leading label that *disagrees* with the typed
 * tier fails the spawn, so a stale echo cannot imply a tier nobody requested.
 */
export const TRACKED_DISPATCH_ADVERTISEMENT = {
  contractVersion: MODEL_POLICY_CONTRACT_VERSION,
  tierField: true,
  scope: "parent-session",
  canonicalInputs: ["cwd", "prompt", "tier"],
  returnsSessionId: true,
} as const;

/** Read-only view of one session's model policy and the ladder behind it. */
export interface ModelPolicyCapabilityResult {
  contractVersion: typeof MODEL_POLICY_CONTRACT_VERSION;
  policy: {
    mode: "exact" | "tiered";
    /** Retained across an Exact switch so returning to Tiered restores it. */
    rememberedTier: ModelTier | null;
    /** The tier in force now; always `null` in Exact mode. */
    currentTier: ModelTier | null;
    currentRuntime: ExactModelSelection;
    /** `null` only when the tier in force cannot resolve. */
    nextRequestResolved: ExactModelSelection | null;
    blockedReason: string | null;
  };
  ladder: {
    valid: boolean;
    revision: string | null;
    blockedReason: string | null;
  };
  trackedDispatch: typeof TRACKED_DISPATCH_ADVERTISEMENT;
}

export interface ModelPolicyCapabilityInput {
  /** Active policy, or `undefined` when the newest persisted entry is malformed. */
  policy: SessionModelPolicy | undefined;
  /** The tuple the session is running on right now. */
  currentRuntime: ExactModelSelection;
  ladder: LadderValidation;
  /** Resolves a tier through the machine ladder; throws when unresolvable. */
  resolveTier: (tier: ModelTier) => ExactModelSelection;
  /** A live runtime block or persisted-entry defect, if either applies. */
  blockedReason?: string | undefined;
}

/**
 * Builds the read-only capability result.
 *
 * Pure by design: every input is supplied, so each row of the contract's
 * conditional-invariants table is directly testable without a session, a
 * runtime, or a model catalog.
 *
 * `nextRequestResolved` is resolved rather than assumed. A Tiered session whose
 * tier no longer resolves reports `null` with an actionable `ladder.blockedReason`,
 * which is a dispatch-blocking state; reporting the current tuple instead would
 * claim the next request is safe when it is not.
 */
export function buildModelPolicyCapability(
  input: ModelPolicyCapabilityInput
): ModelPolicyCapabilityResult {
  const mode = input.policy?.mode ?? "exact";
  const rememberedTier = input.policy?.tier ?? null;
  // Exact mode pins a tuple directly, so no tier is in force even when one is
  // remembered for a later switch back to Tiered.
  const currentTier = mode === "tiered" ? rememberedTier : null;

  const resolution = resolveNextRequest(currentTier, input);

  return {
    contractVersion: MODEL_POLICY_CONTRACT_VERSION,
    policy: {
      mode,
      rememberedTier,
      currentTier,
      currentRuntime: input.currentRuntime,
      nextRequestResolved: resolution.selection,
      blockedReason: input.blockedReason ?? null,
    },
    ladder: {
      valid: input.ladder.valid,
      // Nothing tracks a ladder revision, and no consumer reads one. Reporting
      // `null` states that honestly instead of inventing a counter.
      revision: null,
      blockedReason: ladderBlockedReason(input.ladder, resolution.failure),
    },
    trackedDispatch: TRACKED_DISPATCH_ADVERTISEMENT,
  };
}

function resolveNextRequest(
  currentTier: ModelTier | null,
  input: ModelPolicyCapabilityInput
): { selection: ExactModelSelection | null; failure: string | undefined } {
  // Exact mode's next request is the tuple it is already pinned to; there is no
  // tier to resolve, so an invalid ladder cannot change what the session sends.
  if (currentTier === null)
    return { selection: input.currentRuntime, failure: undefined };
  try {
    return { selection: input.resolveTier(currentTier), failure: undefined };
  } catch (error) {
    return {
      selection: null,
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * A resolution failure is surfaced even when `validate()` reported the ladder
 * valid, because the two can disagree: the catalog may change between a cached
 * validation and this resolution. The actionable reason wins over silence.
 */
function ladderBlockedReason(
  ladder: LadderValidation,
  failure: string | undefined
): string | null {
  if (!ladder.valid) return ladder.reason;
  return failure ?? null;
}
