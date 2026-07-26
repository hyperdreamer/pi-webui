/** Stable identifiers for reorderable Activity Rail icons. */
export type ReorderableRailItem = "terminal" | "git-update-manager" | "theme" | "system-prompt" | "history" | "info";

const REORDERABLE_ITEMS: readonly ReorderableRailItem[] = [
  "terminal",
  "git-update-manager",
  "theme",
  "system-prompt",
  "history",
  "info",
];
const LEGACY_FILE_MANAGER_ITEM = "file-manager";
const REMOVED_BROWSER_ITEM = "browser";

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
  for (const rawItem of value) {
    if (typeof rawItem !== "string") return undefined;
    const item = rawItem === LEGACY_FILE_MANAGER_ITEM ? "git-update-manager" : rawItem;
    if (item === REMOVED_BROWSER_ITEM) continue;
    if (!isReorderableItem(item) || seen.has(item)) return undefined;
    seen.add(item);
    result.push(item);
  }

  if (result.length === REORDERABLE_ITEMS.length) return result;

  const migrated = [...result];
  if (!seen.has("git-update-manager")) {
    const terminalIndex = migrated.indexOf("terminal");
    migrated.splice(terminalIndex + 1, 0, "git-update-manager");
  }
  if (!seen.has("info")) {
    migrated.push("info");
  }
  return migrated.length === REORDERABLE_ITEMS.length ? migrated : undefined;
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
