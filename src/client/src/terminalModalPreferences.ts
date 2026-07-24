export interface TerminalModalPreferences {
  fontSize: number;
  opacity: number;
}

export type TerminalModalPreferencesStorage = Pick<Storage, "getItem" | "setItem">;

export const TERMINAL_MODAL_PREFERENCES_STORAGE_KEY = "pi-webui:terminal-modal-preferences:v1";
export const DEFAULT_TERMINAL_MODAL_PREFERENCES: TerminalModalPreferences = { fontSize: 16, opacity: 94 };
export const MIN_TERMINAL_MODAL_FONT_SIZE = 10;
export const MAX_TERMINAL_MODAL_FONT_SIZE = 28;
export const MIN_TERMINAL_MODAL_OPACITY = 20;
export const MAX_TERMINAL_MODAL_OPACITY = 100;

export function clampTerminalModalFontSize(fontSize: number): number {
  return Math.max(MIN_TERMINAL_MODAL_FONT_SIZE, Math.min(MAX_TERMINAL_MODAL_FONT_SIZE, Math.round(fontSize)));
}

export function clampTerminalModalOpacity(opacity: number): number {
  return Math.max(MIN_TERMINAL_MODAL_OPACITY, Math.min(MAX_TERMINAL_MODAL_OPACITY, Math.round(opacity)));
}

export function readTerminalModalPreferences(storage = browserStorage()): TerminalModalPreferences {
  if (storage === undefined) return { ...DEFAULT_TERMINAL_MODAL_PREFERENCES };
  try {
    return parseTerminalModalPreferences(storage.getItem(TERMINAL_MODAL_PREFERENCES_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_TERMINAL_MODAL_PREFERENCES };
  }
}

export function writeTerminalModalPreferences(preferences: TerminalModalPreferences, storage = browserStorage()): void {
  if (storage === undefined) return;
  try {
    storage.setItem(TERMINAL_MODAL_PREFERENCES_STORAGE_KEY, JSON.stringify({
      fontSize: clampTerminalModalFontSize(preferences.fontSize),
      opacity: clampTerminalModalOpacity(preferences.opacity),
    }));
  } catch {
    // Ignore localStorage quota/privacy errors; the controls still apply for this page.
  }
}

function parseTerminalModalPreferences(raw: string | null): TerminalModalPreferences {
  if (raw === null) return { ...DEFAULT_TERMINAL_MODAL_PREFERENCES };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { ...DEFAULT_TERMINAL_MODAL_PREFERENCES };
    return {
      fontSize: numberPreference(parsed["fontSize"], DEFAULT_TERMINAL_MODAL_PREFERENCES.fontSize, clampTerminalModalFontSize),
      opacity: numberPreference(parsed["opacity"], DEFAULT_TERMINAL_MODAL_PREFERENCES.opacity, clampTerminalModalOpacity),
    };
  } catch {
    return { ...DEFAULT_TERMINAL_MODAL_PREFERENCES };
  }
}

function numberPreference(value: unknown, fallback: number, clamp: (value: number) => number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value) : fallback;
}

function browserStorage(): TerminalModalPreferencesStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
