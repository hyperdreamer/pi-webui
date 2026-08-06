export const LEARNED_SKILLS_LAYOUT_STORAGE_KEY = "pi-webui:workspace-learned-skills:layout:v1";
export const DEFAULT_LIST_WIDTH = 280;
export const MIN_LIST_WIDTH = 190;
export const MAX_LIST_WIDTH = 440;
export const MIN_DETAIL_WIDTH = 320;
export const DIVIDER_WIDTH = 8;

export type LayoutStorage = Pick<Storage, "getItem" | "setItem">;

interface LearnedSkillsLayoutEnvelope {
  version: 1;
  listWidth: number;
}

export function readLearnedSkillsListWidth(storage?: LayoutStorage): number {
  const source = storage ?? browserStorage();
  if (source === undefined) return DEFAULT_LIST_WIDTH;

  try {
    const raw = source.getItem(LEARNED_SKILLS_LAYOUT_STORAGE_KEY);
    if (raw === null) return DEFAULT_LIST_WIDTH;

    const parsed: unknown = JSON.parse(raw);
    if (!isLayoutEnvelope(parsed) || !Number.isFinite(parsed.listWidth)) return DEFAULT_LIST_WIDTH;
    return clampLearnedSkillsListWidth(parsed.listWidth);
  } catch {
    return DEFAULT_LIST_WIDTH;
  }
}

export function writeLearnedSkillsListWidth(width: number, storage?: LayoutStorage): void {
  const source = storage ?? browserStorage();
  if (source === undefined) return;

  const envelope: LearnedSkillsLayoutEnvelope = {
    version: 1,
    listWidth: clampLearnedSkillsListWidth(width),
  };
  try {
    source.setItem(LEARNED_SKILLS_LAYOUT_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Browser privacy modes and full quotas should not break the panel.
  }
}

export function clampLearnedSkillsListWidth(width: number, containerWidth?: number): number {
  const safeWidth = Number.isFinite(width) ? width : DEFAULT_LIST_WIDTH;
  let maximum = MAX_LIST_WIDTH;
  if (containerWidth !== undefined && Number.isFinite(containerWidth)) {
    maximum = Math.min(MAX_LIST_WIDTH, Math.floor(containerWidth - MIN_DETAIL_WIDTH - DIVIDER_WIDTH));
  }

  // A desktop container is expected to be wide enough for the minimum detail
  // pane. Keep the minimum as the final guard for transient narrow geometry.
  maximum = Math.max(MIN_LIST_WIDTH, maximum);
  return Math.round(Math.min(maximum, Math.max(MIN_LIST_WIDTH, safeWidth)));
}

function browserStorage(): LayoutStorage | undefined {
  try {
    if (typeof globalThis.localStorage === "undefined") return undefined;
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function isLayoutEnvelope(value: unknown): value is LearnedSkillsLayoutEnvelope {
  if (!isRecord(value)) return false;
  return value["version"] === 1 && typeof value["listWidth"] === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
