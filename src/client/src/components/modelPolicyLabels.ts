import { type ExactModelSelection, type ModelTier, type TierModelRef } from "../../../shared/apiTypes";

export const TIER_LABELS: Record<ModelTier, string> = {
  economy: "Economy",
  fast: "Fast",
  standard: "Standard",
  advanced: "Advanced",
  capable: "Capable",
  frontier: "Frontier",
};

/** Canonical ascending thinking-level order. Levels outside this list sort last, in input order. */
export const THINKING_LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function describeModel(model: TierModelRef): string {
  return `${model.provider}/${model.id}`;
}

export function describeSelection(selection: ExactModelSelection): string {
  // No substitution: a blank thinking level is reported as missing rather than
  // shown as "off", which would be a guess about what the runtime resolved.
  const thinking = selection.thinkingLevel.trim() === "" ? "no thinking level" : selection.thinkingLevel;
  return `${describeModel(selection.model)} · ${thinking}`;
}

export function modelKey(model: TierModelRef): string {
  return `${model.provider}:${model.id}`;
}
