export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count)) return "0";
  if (count < 1000) return Math.round(count).toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${String(Math.round(count / 1000))}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${String(Math.round(count / 1_000_000))}M`;
}

export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost === 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/** Always-precise cost for tooltips and detail views. */
export function formatPreciseCost(cost: number): string {
  if (!Number.isFinite(cost) || cost === 0) return "$0.0000";
  return `$${cost.toFixed(4)}`;
}

/** Full locale-aware number string for detail views (not compact). */
export function formatFullNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Math.round(n).toLocaleString();
}

/**
 * Format integer with optional compact fallback for large values.
 * Used for context-window display where millions may need abbreviation.
 */
export function formatCompactNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${String(Math.round(n / 1000))}k`;
  return Math.round(n).toString();
}
