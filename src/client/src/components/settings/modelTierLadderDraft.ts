import {
  MODEL_TIERS,
  type ModelTier,
  type ModelTierEntry,
  type ModelTierLadder,
  type ModelTierModelOption,
  type ModelTierRowValidation,
  type ModelTierSettingsResponse,
  type TierModelRef,
} from "../../../../shared/apiTypes";

export interface ModelTierDraftRow {
  model?: TierModelRef;
  thinkingLevel: string;
}

export type ModelTierLadderDraft = Record<ModelTier, ModelTierDraftRow>;

export interface ModelTierLadderValidation {
  valid: boolean;
  rows: Record<ModelTier, ModelTierRowValidation>;
}

export function emptyModelTierLadderDraft(): ModelTierLadderDraft {
  return {
    economy: emptyModelTierDraftRow(),
    fast: emptyModelTierDraftRow(),
    standard: emptyModelTierDraftRow(),
    advanced: emptyModelTierDraftRow(),
    capable: emptyModelTierDraftRow(),
    frontier: emptyModelTierDraftRow(),
  };
}

export function modelTierLadderDraftFromResponse(response: ModelTierSettingsResponse): ModelTierLadderDraft {
  if (response.ladder === undefined) return emptyModelTierLadderDraft();
  return {
    economy: draftRowFromEntry(response.ladder.economy),
    fast: draftRowFromEntry(response.ladder.fast),
    standard: draftRowFromEntry(response.ladder.standard),
    advanced: draftRowFromEntry(response.ladder.advanced),
    capable: draftRowFromEntry(response.ladder.capable),
    frontier: draftRowFromEntry(response.ladder.frontier),
  };
}

export function updateTierModel(
  draft: ModelTierLadderDraft,
  tier: ModelTier,
  option: ModelTierModelOption,
): ModelTierLadderDraft {
  const current = draft[tier];
  const thinkingLevel = current.thinkingLevel === "" || option.thinkingLevels.includes(current.thinkingLevel)
    ? current.thinkingLevel
    : "";
  return {
    ...draft,
    [tier]: {
      model: { ...option.model },
      thinkingLevel,
    },
  };
}

export function updateTierThinkingLevel(draft: ModelTierLadderDraft, tier: ModelTier, thinkingLevel: string): ModelTierLadderDraft {
  return {
    ...draft,
    [tier]: {
      ...draft[tier],
      thinkingLevel,
    },
  };
}

export function validateModelTierDraft(draft: ModelTierLadderDraft, models: readonly ModelTierModelOption[]): ModelTierLadderValidation {
  const rows = {
    economy: validateModelTierRow("economy", draft.economy, models),
    fast: validateModelTierRow("fast", draft.fast, models),
    standard: validateModelTierRow("standard", draft.standard, models),
    advanced: validateModelTierRow("advanced", draft.advanced, models),
    capable: validateModelTierRow("capable", draft.capable, models),
    frontier: validateModelTierRow("frontier", draft.frontier, models),
  } satisfies Record<ModelTier, ModelTierRowValidation>;
  return { valid: MODEL_TIERS.every((tier) => rows[tier].valid), rows };
}

export function modelTierLadderFromDraft(draft: ModelTierLadderDraft, models: readonly ModelTierModelOption[]): ModelTierLadder | undefined {
  if (!validateModelTierDraft(draft, models).valid) return undefined;
  return {
    economy: modelTierEntryFromDraft(draft.economy),
    fast: modelTierEntryFromDraft(draft.fast),
    standard: modelTierEntryFromDraft(draft.standard),
    advanced: modelTierEntryFromDraft(draft.advanced),
    capable: modelTierEntryFromDraft(draft.capable),
    frontier: modelTierEntryFromDraft(draft.frontier),
  };
}

function emptyModelTierDraftRow(): ModelTierDraftRow {
  return { thinkingLevel: "" };
}

function draftRowFromEntry(entry: ModelTierEntry): ModelTierDraftRow {
  return {
    model: { ...entry.model },
    thinkingLevel: entry.thinkingLevel,
  };
}

function modelTierEntryFromDraft(row: ModelTierDraftRow): ModelTierEntry {
  if (row.model === undefined) throw new Error("Cannot build a model-tier ladder from an incomplete draft");
  return {
    model: { ...row.model },
    thinkingLevel: row.thinkingLevel,
  };
}

function validateModelTierRow(tier: ModelTier, row: ModelTierDraftRow, models: readonly ModelTierModelOption[]): ModelTierRowValidation {
  const model = row.model;
  if (model === undefined) return { valid: false, reason: `tier ${tier} has no model selected` };
  const option = models.find((candidate) => sameModel(candidate.model, model));
  if (option === undefined) return { valid: false, reason: `tier ${tier} names unavailable model ${describeModel(model)}` };
  if (row.thinkingLevel === "") return { valid: false, reason: `tier ${tier} has no thinking level selected` };
  if (!option.thinkingLevels.includes(row.thinkingLevel)) {
    return { valid: false, reason: `tier ${tier} names thinking level ${row.thinkingLevel}, unsupported by ${describeModel(model)}` };
  }
  return { valid: true };
}

function sameModel(left: TierModelRef, right: TierModelRef): boolean {
  return left.provider === right.provider && left.id === right.id;
}

function describeModel(model: TierModelRef): string {
  return `${model.provider}/${model.id}`;
}
