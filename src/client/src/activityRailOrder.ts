/**
 * Stable identifiers for Activity Rail icons.
 *
 * Only the first four items are reorderable via drag-and-drop.  The "info"
 * icon is always pinned at the bottom, separated by a spacer.
 */
export type ReorderableRailItem = "terminal" | "theme" | "system-prompt" | "history";

const REORDERABLE_ITEMS: readonly string[] = [
  "terminal",
  "theme",
  "system-prompt",
  "history",
];

export const DEFAULT_RAIL_ORDER: readonly ReorderableRailItem[] = [
  "terminal",
  "theme",
  "system-prompt",
  "history",
];

const STORAGE_KEY = "pi-webui:activity-rail-order";

function browserStorage(): Storage | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

function isReorderableItem(value: string): value is ReorderableRailItem {
  return REORDERABLE_ITEMS.includes(value);
}

function normalizeRailOrder(value: unknown): ReorderableRailItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length !== REORDERABLE_ITEMS.length) return undefined;
  const result: ReorderableRailItem[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !isReorderableItem(item)) return undefined;
    if (seen.has(item)) return undefined;
    seen.add(item);
    result.push(item);
  }
  return result;
}

export function readRailOrder(): ReorderableRailItem[] | undefined {
  try {
    const storage = browserStorage();
    if (storage === undefined) return undefined;
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return normalizeRailOrder(parsed);
  } catch {
    return undefined;
  }
}

export function writeRailOrder(order: ReorderableRailItem[]): void {
  try {
    const storage = browserStorage();
    if (storage === undefined) return;
    storage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch {
    // Ignore localStorage quota / privacy errors.
  }
}
