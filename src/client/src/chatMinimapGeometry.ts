/**
 * Pure geometry helpers for the conversation minimap.
 *
 * Separated from the Lit component so that scroll-ratio math, clamping, and
 * pointer-to-scroll mapping can be tested without DOM or custom elements.
 */

/** Metrics extracted from the chat scroll container. */
export interface MinimapMetrics {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

/** Computed viewport state for the minimap. */
export interface MinimapViewport {
  scrollRatio: number;
  viewportRatio: number;
  visible: boolean;
}

/** A single message marker for the minimap. */
export interface MinimapMarker {
  /** Position of the marker's article top as a ratio (0–1) of total scroll height. */
  topRatio: number;
  /** The role of the message. */
  role: "user" | "assistant";
  /** Short preview text for the tooltip (truncated by the caller). */
  preview: string;
}

/**
 * Compute the minimap viewport state from raw scroll metrics.
 *
 * The minimap is hidden when there is not enough scrollable overflow (> 20 px).
 */
export function computeMinimapViewport(metrics: MinimapMetrics): MinimapViewport {
  const { scrollHeight, clientHeight, scrollTop } = metrics;
  if (clientHeight <= 0 || scrollHeight <= 0) {
    return { scrollRatio: 0, viewportRatio: 1, visible: false };
  }
  const scrollable = scrollHeight - clientHeight;
  if (scrollable <= 20) {
    return { scrollRatio: 0, viewportRatio: 1, visible: false };
  }
  const scrollRatio = clampRatio(scrollTop / scrollable);
  const viewportRatio = clampRatio(clientHeight / scrollHeight);
  return { scrollRatio, viewportRatio, visible: true };
}

/** Clamp a number to the 0–1 range. */
export function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Map a click position on the minimap rail (as a 0–1 ratio) to the target
 * scroll position (as a 0–1 ratio over the scrollable range).
 *
 * The adjustment centres the viewport on the click point unless the click is
 * near one of the extents.
 */
export function minimapClickToScrollRatio(
  clickRatio: number,
  viewportRatio: number,
): number {
  const clamped = clampRatio(clickRatio);
  if (viewportRatio >= 1) return 0;
  return clampRatio((clamped - viewportRatio / 2) / (1 - viewportRatio));
}

/**
 * Map the current scroll ratio to the top of the viewport indicator on the
 * minimap (as a 0–1 ratio over the rail height).
 */
export function scrollToMinimapTopRatio(
  scrollRatio: number,
  viewportRatio: number,
): number {
  return clampRatio(scrollRatio * (1 - viewportRatio));
}

/**
 * Compute the top ratio (0–1) of a message element relative to the total
 * scroll height, accounting for the current scroll offset.
 */
export function messageTopRatio(
  elementTop: number,
  containerTop: number,
  scrollTop: number,
  scrollHeight: number,
): number {
  if (scrollHeight <= 0) return 0;
  return clampRatio((elementTop - containerTop + scrollTop) / scrollHeight);
}

/** Extract a validated scroll ratio from a CustomEvent detail payload. */
export function extractMinimapScrollRatio(detail: unknown): number | undefined {
  if (typeof detail !== "object" || detail === null) return undefined;
  if (!("ratio" in detail)) return undefined;
  const ratio: unknown = detail.ratio;
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return undefined;
  return clampRatio(ratio);
}
