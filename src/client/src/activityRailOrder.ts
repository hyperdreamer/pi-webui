/** Stable identifiers for every icon on the Activity Rail. */
export type ActivityRailItem = "terminal" | "browser" | "theme" | "system-prompt" | "history" | "info";

export const ALL_RAIL_ITEMS: readonly ActivityRailItem[] = [
  "terminal",
  "browser",
  "theme",
  "system-prompt",
  "history",
  "info",
];

export const DEFAULT_RAIL_ORDER: readonly ActivityRailItem[] = [...ALL_RAIL_ITEMS];

const ALL_RAIL_ITEM_IDS = new Set<string>(ALL_RAIL_ITEMS);
const STORAGE_KEY = "pi-webui:activity-rail-order";

function browserStorage(): Storage | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

function isActivityRailItem(value: string): value is ActivityRailItem {
  return ALL_RAIL_ITEM_IDS.has(value);
}

function normalizeRailOrder(value: unknown): ActivityRailItem[] | undefined {
  if (!isStringArray(value)) return undefined;
  const order: ActivityRailItem[] = [];
  const seen = new Set<ActivityRailItem>();
  for (const item of value) {
    if (!isActivityRailItem(item) || seen.has(item)) return undefined;
    seen.add(item);
    order.push(item);
  }

  const missing = ALL_RAIL_ITEMS.filter((item) => !seen.has(item));
  if (missing.length === 0) return order;
  if (missing.length !== 1 || missing[0] !== "browser") return undefined;

  const terminalIndex = order.indexOf("terminal");
  return [
    ...order.slice(0, terminalIndex + 1),
    "browser",
    ...order.slice(terminalIndex + 1),
  ];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Read the persisted rail order, or `undefined` if none is stored. */
export function readRailOrder(): ActivityRailItem[] | undefined {
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

/** Persist a rail order to localStorage. */
export function writeRailOrder(order: ActivityRailItem[]): void {
  try {
    const storage = browserStorage();
    if (storage === undefined) return;
    storage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch {
    // Ignore localStorage quota / privacy errors.
  }
}
