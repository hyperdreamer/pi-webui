import { type ExactModelSelection, type ModelTier, type TierModelRef } from "../../../shared/apiTypes";
import { KNOWN_THINKING_LEVELS } from "../../../shared/thinkingLevels";

export const TIER_LABELS: Record<ModelTier, string> = {
  economy: "Economy",
  fast: "Fast",
  standard: "Standard",
  advanced: "Advanced",
  capable: "Capable",
  frontier: "Frontier",
};

/** Canonical ascending thinking-level order. */
/**
 * Canonical ascending order for presenting thinking levels. Derived from pi's
 * own list rather than duplicated, so a level pi adds cannot silently sort last
 * as an unknown.
 */
export const THINKING_LEVEL_ORDER = KNOWN_THINKING_LEVELS;

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
