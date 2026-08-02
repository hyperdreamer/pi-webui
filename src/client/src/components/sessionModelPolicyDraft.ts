import {
  MODEL_TIERS,
  type ExactModelSelection,
  type ModelTier,
  type ModelTierModelOption,
  type ModelTierSettingsResponse,
  type SessionModelPolicy,
  type SessionModelPolicyUpdate,
  type TierModelRef,
} from "../../../shared/apiTypes";

export interface SessionModelPolicyDraft {
  mode: "exact" | "tiered";
  exact: ExactModelSelection;
  tier?: ModelTier;
}

export interface DraftSeedInput {
  /** Newest persisted policy, when one exists and parsed. */
  policy?: SessionModelPolicy;
  /** Tuple the runtime confirmed, or a starter's machine defaults. */
  liveResolved?: ExactModelSelection;
  catalog?: ModelTierSettingsResponse;
}

export function modelPolicyDraftFromPolicy(policy: SessionModelPolicy): SessionModelPolicyDraft {
  return {
    mode: policy.mode,
    exact: cloneExactSelection(policy.exact),
    ...(policy.tier === undefined ? {} : { tier: policy.tier }),
  };
}

/**
 * Deterministic draft seed. Every branch is explainable and none invents a
 * model: an absent policy and absent live tuple produce empty selections that
 * `isDraftReadyToApply` rejects, so nothing can be applied until the user picks.
 */
export function seedModelPolicyDraft(input: DraftSeedInput): SessionModelPolicyDraft {
  const base = baseDraft(input);
  if (base.mode !== "tiered" || base.tier !== undefined) return base;
  const rows = input.catalog?.rows;
  if (rows === undefined || !Object.hasOwn(rows, "standard") || !rows.standard.valid) return base;
  return { ...base, tier: "standard" };
}

function baseDraft(input: DraftSeedInput): SessionModelPolicyDraft {
  if (input.policy !== undefined) return modelPolicyDraftFromPolicy(input.policy);
  const live = input.liveResolved;
  if (live !== undefined) return { mode: "exact", exact: cloneExactSelection(live) };
  return { mode: "exact", exact: { model: { provider: "", id: "" }, thinkingLevel: "" } };
}

export function selectDraftTier(draft: SessionModelPolicyDraft, tier: ModelTier): SessionModelPolicyDraft {
  return { ...draft, mode: "tiered", tier };
}

export function selectDraftExact(draft: SessionModelPolicyDraft): SessionModelPolicyDraft {
  return { ...draft, mode: "exact" };
}

export function updateDraftExactModel(
  draft: SessionModelPolicyDraft,
  option: ModelTierModelOption,
): SessionModelPolicyDraft {
  const thinkingLevel = option.thinkingLevels.includes(draft.exact.thinkingLevel)
    ? draft.exact.thinkingLevel
    : "";
  return {
    ...draft,
    exact: {
      model: { ...option.model },
      thinkingLevel,
    },
  };
}

export function updateDraftExactThinking(
  draft: SessionModelPolicyDraft,
  thinkingLevel: string,
): SessionModelPolicyDraft {
  return {
    ...draft,
    exact: {
      ...draft.exact,
      thinkingLevel,
    },
  };
}

export function sessionModelPolicyUpdateFromDraft(
  draft: SessionModelPolicyDraft,
  catalog: ModelTierSettingsResponse,
): SessionModelPolicyUpdate | undefined {
  if (draft.mode === "exact") {
    if (!isValidExactSelection(draft.exact, catalog.models)) return undefined;
    return { mode: "exact", exact: cloneExactSelection(draft.exact) };
  }

  const tier = draft.tier;
  if (
    tier === undefined
    || !catalog.valid
    || !hasCompleteLadder(catalog)
    || !hasValidTierRow(catalog, tier)
  ) {
    return undefined;
  }
  return { mode: "tiered", tier };
}

/**
 * Whether this draft forms a complete, applicable tuple. Delegates to
 * `sessionModelPolicyUpdateFromDraft` so completion can never disagree with what
 * would actually be submitted.
 */
export function isDraftReadyToApply(
  draft: SessionModelPolicyDraft,
  catalog: ModelTierSettingsResponse | undefined,
): boolean {
  if (catalog === undefined) return false;
  return sessionModelPolicyUpdateFromDraft(draft, catalog) !== undefined;
}

function isValidExactSelection(
  exact: ExactModelSelection,
  models: readonly ModelTierModelOption[],
): boolean {
  if (
    !isNonBlank(exact.model.provider)
    || !isNonBlank(exact.model.id)
    || !isNonBlank(exact.thinkingLevel)
  ) {
    return false;
  }
  const option = models.find((candidate) => sameModel(candidate.model, exact.model));
  return option?.thinkingLevels.includes(exact.thinkingLevel) === true;
}

function hasCompleteLadder(catalog: ModelTierSettingsResponse): boolean {
  const ladder = catalog.ladder;
  return ladder !== undefined && MODEL_TIERS.every((tier) => Object.hasOwn(ladder, tier));
}

function hasValidTierRow(catalog: ModelTierSettingsResponse, tier: ModelTier): boolean {
  return Object.hasOwn(catalog.rows, tier) && catalog.rows[tier].valid;
}

function sameModel(left: TierModelRef, right: TierModelRef): boolean {
  return left.provider === right.provider && left.id === right.id;
}

function isNonBlank(value: string): boolean {
  return value.trim() !== "";
}

function cloneExactSelection(exact: ExactModelSelection): ExactModelSelection {
  return {
    model: { ...exact.model },
    thinkingLevel: exact.thinkingLevel,
  };
}
