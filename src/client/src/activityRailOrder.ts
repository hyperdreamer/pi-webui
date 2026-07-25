/**
 * Stable identifiers for Activity Rail icons.
 *
 * The Browser joins the reorderable tools. The "info" icon remains pinned at
 * the bottom, separated by a spacer.
 */
export type ReorderableRailItem = "terminal" | "browser" | "theme" | "system-prompt" | "history";

const REORDERABLE_ITEMS: readonly ReorderableRailItem[] = [
  "terminal",
  "browser",
  "theme",
  "system-prompt",
  "history",
];

export const DEFAULT_RAIL_ORDER: readonly ReorderableRailItem[] = [...REORDERABLE_ITEMS];

const REORDERABLE_ITEM_IDS = new Set<string>(REORDERABLE_ITEMS);
const STORAGE_KEY = "pi-webui:activity-rail-order";

function browserStorage(): Storage | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

function isReorderableItem(value: string): value is ReorderableRailItem {
  return REORDERABLE_ITEM_IDS.has(value);
}

function normalizeRailOrder(value: unknown): ReorderableRailItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: ReorderableRailItem[] = [];
  const seen = new Set<ReorderableRailItem>();
  for (const item of value) {
    if (typeof item !== "string" || !isReorderableItem(item) || seen.has(item)) return undefined;
    seen.add(item);
    result.push(item);
  }

  if (result.length === REORDERABLE_ITEMS.length) return result;
  if (result.length !== REORDERABLE_ITEMS.length - 1 || seen.has("browser")) return undefined;

  const terminalIndex = result.indexOf("terminal");
  return [
    ...result.slice(0, terminalIndex + 1),
    "browser",
    ...result.slice(terminalIndex + 1),
  ];
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
