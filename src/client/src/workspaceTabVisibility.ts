export const TERMINAL_TAB_HIDDEN_STORAGE_KEY = "pi-webui:terminal-tab-hidden";
export const INFO_TAB_HIDDEN_STORAGE_KEY = "pi-webui:info-tab-hidden";

export interface WorkspaceTabVisibility {
  terminalHidden: boolean;
  infoHidden: boolean;
}

export type WorkspaceTabVisibilityStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readWorkspaceTabVisibility(storage: WorkspaceTabVisibilityStorage | undefined = browserStorage()): WorkspaceTabVisibility {
  return {
    terminalHidden: readHiddenPreference(storage, TERMINAL_TAB_HIDDEN_STORAGE_KEY),
    infoHidden: readHiddenPreference(storage, INFO_TAB_HIDDEN_STORAGE_KEY),
  };
}

export function writeWorkspaceTabVisibility(preferences: WorkspaceTabVisibility, storage: WorkspaceTabVisibilityStorage | undefined = browserStorage()): void {
  writeHiddenPreference(storage, TERMINAL_TAB_HIDDEN_STORAGE_KEY, preferences.terminalHidden);
  writeHiddenPreference(storage, INFO_TAB_HIDDEN_STORAGE_KEY, preferences.infoHidden);
}

function readHiddenPreference(storage: WorkspaceTabVisibilityStorage | undefined, key: string): boolean {
  if (storage === undefined) return false;
  try {
    return storage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function writeHiddenPreference(storage: WorkspaceTabVisibilityStorage | undefined, key: string, hidden: boolean): void {
  if (storage === undefined) return;
  try {
    if (hidden) storage.setItem(key, "true");
    else storage.removeItem(key);
  } catch {
    // Ignore localStorage quota/privacy errors; the tab visibility still applies for this page.
  }
}

function browserStorage(): WorkspaceTabVisibilityStorage | undefined {
  try {
    if (typeof window === "undefined") return undefined;
    return window.localStorage;
  } catch {
    return undefined;
  }
}
