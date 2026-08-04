import {
  MODEL_TIERS,
  type ExactModelSelection,
  type LegacyStarterModelPolicyPreference,
  type ModelTier,
  type ModelTierModelOption,
  type ModelTierSettingsResponse,
  type SessionDefaultsResponse,
  type SessionDefaultsV2Response,
  type SessionModelPolicy,
  type SessionModelPolicyUpdate,
  type StarterModelPolicyPreference,
  type TierModelRef,
} from "../../../shared/apiTypes";

export interface SessionModelPolicyDraft {
  mode: "exact" | "tiered";
  exact: ExactModelSelection;
  tier?: ModelTier;
}

export type StarterModelPolicyEvaluation =
  | {
      kind: "ready";
      initialModelPolicy: StarterModelPolicyPreference;
      resolved: ExactModelSelection;
    }
  | { kind: "blocked"; reason: string };

type StarterDefaults = SessionDefaultsResponse | SessionDefaultsV2Response;

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

export function starterExactSelection(
  defaults: StarterDefaults,
): ExactModelSelection | undefined {
  const provider = defaults.model?.provider;
  const id = defaults.model?.id;
  if (provider === undefined || id === undefined || !isNonBlank(provider) || !isNonBlank(id)) return undefined;
  if (!isNonBlank(defaults.thinkingLevel)) return undefined;
  return { model: { provider, id }, thinkingLevel: defaults.thinkingLevel };
}

export function seedStarterModelPolicyDraft(
  defaults: StarterDefaults,
): SessionModelPolicyDraft {
  const exact = starterExactSelection(defaults) ?? emptyExactSelection();
  const preference = defaults.starterModelPolicyPreference;
  if (!isSessionDefaultsV2Response(defaults)) {
    return starterDraftFromLegacyPreference(preference, exact, "exact");
  }
  if (isFullStarterModelPolicyPreference(preference)) {
    return {
      mode: preference.mode,
      exact: cloneExactSelection(preference.exact),
      ...(preference.tier === undefined ? {} : { tier: preference.tier }),
    };
  }
  if (preference !== undefined) return starterDraftFromLegacyPreference(preference, exact, preference.mode);
  return {
    mode: "tiered",
    exact: cloneExactSelection(exact),
    tier: "standard",
  };
}

export function relinkStarterExactBranch(
  draft: SessionModelPolicyDraft,
  defaults: StarterDefaults,
): SessionModelPolicyDraft {
  const exact = starterExactSelection(defaults);
  if (exact === undefined || draft.mode === "tiered" || sameExactSelection(draft.exact, exact)) return draft;
  return { ...draft, exact: cloneExactSelection(exact) };
}

export function starterModelPolicyPreferenceFromDraft(
  draft: SessionModelPolicyDraft,
): LegacyStarterModelPolicyPreference | undefined {
  if (draft.mode === "tiered" && draft.tier === undefined) return undefined;
  return {
    mode: draft.mode,
    ...(draft.tier === undefined ? {} : { tier: draft.tier }),
  };
}

export function sameExactSelection(
  left: ExactModelSelection,
  right: ExactModelSelection,
): boolean {
  return left.model.provider === right.model.provider
    && left.model.id === right.model.id
    && left.thinkingLevel === right.thinkingLevel;
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

/**
 * Fill only an unowned starter Exact branch from the active tier. A full
 * version-two preference owns its Exact branch, even when the remembered tuple
 * has become unavailable.
 */
export function completeUnownedStarterExactFromActiveTier(
  draft: SessionModelPolicyDraft,
  defaults: StarterDefaults,
  catalog: ModelTierSettingsResponse,
): SessionModelPolicyDraft {
  const complete = cloneDraft(draft);
  if (
    hasFullStarterModelPolicyPreference(defaults)
    || draft.mode !== "tiered"
    || isSyntacticallyCompleteExactSelection(draft.exact)
    || !isCanonicalTier(draft.tier)
    || !hasCompleteLadder(catalog)
    || !hasValidTierRow(catalog, draft.tier)
  ) {
    return complete;
  }
  const resolved = catalog.ladder?.[draft.tier];
  if (resolved === undefined || !isSyntacticallyCompleteExactSelection(resolved)) return complete;
  return { ...complete, exact: cloneExactSelection(resolved) };
}

/**
 * Validate only the branch which will be used to start the session. The other
 * Exact branch still needs a complete syntax-only tuple for the full protocol
 * initializer, but an unavailable remembered selection remains valid intent.
 */
export function evaluateStarterModelPolicyDraft(
  draft: SessionModelPolicyDraft,
  catalog: ModelTierSettingsResponse,
): StarterModelPolicyEvaluation {
  const active = draft.mode === "exact"
    ? evaluateActiveExact(draft.exact, catalog)
    : evaluateActiveTiered(draft, catalog);
  if (active.kind === "blocked") return active;

  const inactiveExactSyntaxError = exactSyntaxError(draft.exact);
  if (inactiveExactSyntaxError !== undefined) {
    return { kind: "blocked", reason: inactiveExactSyntaxError };
  }
  return {
    kind: "ready",
    initialModelPolicy: {
      mode: draft.mode,
      exact: cloneExactSelection(draft.exact),
      ...(draft.tier === undefined ? {} : { tier: draft.tier }),
    },
    resolved: cloneExactSelection(active.resolved),
  };
}

function isValidExactSelection(
  exact: ExactModelSelection,
  models: readonly ModelTierModelOption[],
): boolean {
  if (exactSyntaxError(exact) !== undefined) return false;
  const option = models.find((candidate) => sameModel(candidate.model, exact.model));
  return option?.thinkingLevels.includes(exact.thinkingLevel) === true;
}

function evaluateActiveExact(
  exact: ExactModelSelection,
  catalog: ModelTierSettingsResponse,
): { kind: "ready"; resolved: ExactModelSelection } | { kind: "blocked"; reason: string } {
  const syntaxError = exactSyntaxError(exact);
  if (syntaxError !== undefined) return { kind: "blocked", reason: syntaxError };
  const option = catalog.models.find((candidate) => sameModel(candidate.model, exact.model));
  if (option === undefined) return { kind: "blocked", reason: "Selected provider/model is unavailable" };
  if (!option.thinkingLevels.includes(exact.thinkingLevel)) {
    return { kind: "blocked", reason: "Selected thinking level is unsupported by the selected model" };
  }
  return { kind: "ready", resolved: cloneExactSelection(exact) };
}

function evaluateActiveTiered(
  draft: SessionModelPolicyDraft,
  catalog: ModelTierSettingsResponse,
): { kind: "ready"; resolved: ExactModelSelection } | { kind: "blocked"; reason: string } {
  const tier = draft.tier;
  if (!isCanonicalTier(tier)) return { kind: "blocked", reason: tierBlockReason(undefined, catalog) };
  const row = Object.hasOwn(catalog.rows, tier) ? catalog.rows[tier] : undefined;
  if (row?.valid !== true) return { kind: "blocked", reason: tierBlockReason(row, catalog) };
  const resolved = catalog.ladder?.[tier];
  if (resolved === undefined || !isSyntacticallyCompleteExactSelection(resolved)) {
    return { kind: "blocked", reason: tierBlockReason(row, catalog) };
  }
  return { kind: "ready", resolved: cloneExactSelection(resolved) };
}

function starterDraftFromLegacyPreference(
  preference: LegacyStarterModelPolicyPreference | undefined,
  exact: ExactModelSelection,
  defaultMode: "exact" | "tiered",
): SessionModelPolicyDraft {
  return {
    mode: preference?.mode ?? defaultMode,
    exact: cloneExactSelection(exact),
    ...(preference?.tier === undefined ? {} : { tier: preference.tier }),
  };
}

function isSessionDefaultsV2Response(defaults: StarterDefaults): defaults is SessionDefaultsV2Response {
  return "starterModelPolicyContractVersion" in defaults;
}

function isFullStarterModelPolicyPreference(
  preference: SessionDefaultsV2Response["starterModelPolicyPreference"],
): preference is StarterModelPolicyPreference {
  return preference !== undefined && Object.hasOwn(preference, "exact");
}

function hasFullStarterModelPolicyPreference(defaults: StarterDefaults): boolean {
  return isSessionDefaultsV2Response(defaults)
    && isFullStarterModelPolicyPreference(defaults.starterModelPolicyPreference);
}

function emptyExactSelection(): ExactModelSelection {
  return { model: { provider: "", id: "" }, thinkingLevel: "" };
}

function cloneDraft(draft: SessionModelPolicyDraft): SessionModelPolicyDraft {
  return {
    mode: draft.mode,
    exact: cloneExactSelection(draft.exact),
    ...(draft.tier === undefined ? {} : { tier: draft.tier }),
  };
}

function exactSyntaxError(exact: ExactModelSelection): string | undefined {
  return isSyntacticallyCompleteExactSelection(exact)
    ? undefined
    : "Choose a provider, model, and thinking level before starting";
}

function isSyntacticallyCompleteExactSelection(exact: ExactModelSelection): boolean {
  return isNonBlank(exact.model.provider)
    && isNonBlank(exact.model.id)
    && isNonBlank(exact.thinkingLevel);
}

function isCanonicalTier(tier: ModelTier | undefined): tier is ModelTier {
  return tier !== undefined && MODEL_TIERS.includes(tier);
}

function tierBlockReason(
  row: { reason?: string } | undefined,
  catalog: ModelTierSettingsResponse,
): string {
  if (row?.reason !== undefined && isNonBlank(row.reason)) return row.reason;
  if (catalog.configError !== undefined && isNonBlank(catalog.configError)) return catalog.configError;
  return "Selected model tier is unavailable";
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
