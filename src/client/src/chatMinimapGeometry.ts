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

const MINIMAP_TOOLTIP_HEIGHT_PX = 22;
const MINIMAP_TOOLTIP_GAP_PX = 2;

/**
 * Calculate a top position for every minimap preview while keeping nearby
 * previews apart where the rail has enough room. Positions remain in source
 * order and within the rail; crowded rails distribute previews across the
 * available height so no marker's information is omitted.
 */
export function minimapTooltipTopPositions(
  markers: readonly MinimapMarker[],
  railHeight: number,
): number[] {
  if (markers.length === 0) return [];

  const height = Number.isFinite(railHeight) ? Math.max(0, railHeight) : 0;
  const maxTop = Math.max(0, height - MINIMAP_TOOLTIP_HEIGHT_PX);
  const ordered = markers
    .map((marker, index) => ({
      index,
      desiredTop: clampRatio(marker.topRatio) * height - MINIMAP_TOOLTIP_HEIGHT_PX / 2,
    }))
    .sort((left, right) => left.desiredTop - right.desiredTop || left.index - right.index);
  const positions = new Array<number>(markers.length).fill(0);
  const assignPositions = (tops: readonly number[]): number[] => {
    for (let index = 0; index < ordered.length; index += 1) {
      const marker = ordered[index];
      const top = tops[index];
      if (marker === undefined || top === undefined) continue;
      positions[marker.index] = Math.round(top);
    }
    return positions;
  };

  if (ordered.length === 1) {
    return assignPositions([Math.min(maxTop, Math.max(0, ordered[0]?.desiredTop ?? 0))]);
  }

  const minimumSpacing = MINIMAP_TOOLTIP_HEIGHT_PX + MINIMAP_TOOLTIP_GAP_PX;
  const requiredHeight = ordered.length * MINIMAP_TOOLTIP_HEIGHT_PX
    + (ordered.length - 1) * MINIMAP_TOOLTIP_GAP_PX;
  if (requiredHeight > height) {
    return assignPositions(ordered.map((_, index) => maxTop * index / (ordered.length - 1)));
  }

  const separatedTops = ordered.map(({ desiredTop }) => Math.min(maxTop, Math.max(0, desiredTop)));
  for (let index = 1; index < separatedTops.length; index += 1) {
    const previous = separatedTops[index - 1];
    const current = separatedTops[index];
    if (previous === undefined || current === undefined) continue;
    separatedTops[index] = Math.max(current, previous + minimumSpacing);
  }
  const lastIndex = separatedTops.length - 1;
  const lastTop = separatedTops[lastIndex];
  if (lastTop !== undefined) separatedTops[lastIndex] = Math.min(lastTop, maxTop);
  for (let index = lastIndex - 1; index >= 0; index -= 1) {
    const next = separatedTops[index + 1];
    const current = separatedTops[index];
    if (next === undefined || current === undefined) continue;
    separatedTops[index] = Math.min(current, next - minimumSpacing);
  }
  return assignPositions(separatedTops);
}

/** Extract a validated scroll ratio from a CustomEvent detail payload. */
export function extractMinimapScrollRatio(detail: unknown): number | undefined {
  if (typeof detail !== "object" || detail === null) return undefined;
  if (!("ratio" in detail)) return undefined;
  const ratio: unknown = detail.ratio;
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return undefined;
  return clampRatio(ratio);
}
