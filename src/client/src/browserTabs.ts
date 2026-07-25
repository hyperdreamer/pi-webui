export const BLANK_BROWSER_URL = "about:blank";
export const DEFAULT_BROWSER_ZOOM = 100;
export const MIN_BROWSER_ZOOM = 50;
export const MAX_BROWSER_ZOOM = 200;
export const BROWSER_ZOOM_STORAGE_KEY = "pi-webui:browser-zoom:v1";

export interface BrowserTab {
  id: string;
  url: string;
  reloadRevision: number;
}

export interface BrowserTabsState {
  tabs: readonly BrowserTab[];
  activeTabId: string | undefined;
}

export type BrowserTabsAction =
  | { type: "add"; tabId: string }
  | { type: "select"; tabId: string }
  | { type: "navigate"; tabId: string; url: string }
  | { type: "reload"; tabId: string }
  | { type: "close"; tabId: string };

export type BrowserZoomStorage = Pick<Storage, "getItem" | "setItem">;

export function createBrowserTabsState(tabId: string): BrowserTabsState {
  return {
    tabs: [{ id: tabId, url: BLANK_BROWSER_URL, reloadRevision: 0 }],
    activeTabId: tabId,
  };
}

export function updateBrowserTabs(state: BrowserTabsState, action: BrowserTabsAction): BrowserTabsState {
  switch (action.type) {
    case "add":
      if (state.tabs.some((tab) => tab.id === action.tabId)) return state;
      return {
        tabs: [...state.tabs, { id: action.tabId, url: BLANK_BROWSER_URL, reloadRevision: 0 }],
        activeTabId: action.tabId,
      };
    case "select":
      if (!state.tabs.some((tab) => tab.id === action.tabId) || state.activeTabId === action.tabId) return state;
      return { ...state, activeTabId: action.tabId };
    case "navigate":
      return updateTab(state, action.tabId, (tab) => ({ ...tab, url: action.url, reloadRevision: 0 }));
    case "reload":
      return updateTab(state, action.tabId, (tab) => ({ ...tab, reloadRevision: tab.reloadRevision + 1 }));
    case "close":
      return closeBrowserTab(state, action.tabId);
  }
}

export function normalizeBrowserAddress(address: string): string | undefined {
  const trimmed = address.trim();
  if (trimmed === "" || /\s/.test(trimmed) || hasUnsupportedScheme(trimmed)) return undefined;

  const source = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(source);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function browserTabLabel(url: string): string {
  if (url === BLANK_BROWSER_URL) return "New tab";
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function clampBrowserZoom(zoom: number): number {
  return Math.max(MIN_BROWSER_ZOOM, Math.min(MAX_BROWSER_ZOOM, Math.round(zoom)));
}

export function readBrowserZoom(storage = browserZoomStorage()): number {
  if (storage === undefined) return DEFAULT_BROWSER_ZOOM;
  try {
    const raw = storage.getItem(BROWSER_ZOOM_STORAGE_KEY);
    if (raw === null) return DEFAULT_BROWSER_ZOOM;
    const value = Number(raw);
    return Number.isFinite(value) ? clampBrowserZoom(value) : DEFAULT_BROWSER_ZOOM;
  } catch {
    return DEFAULT_BROWSER_ZOOM;
  }
}

export function writeBrowserZoom(zoom: number, storage = browserZoomStorage()): void {
  if (storage === undefined) return;
  try {
    storage.setItem(BROWSER_ZOOM_STORAGE_KEY, String(clampBrowserZoom(zoom)));
  } catch {
    // Ignore localStorage quota/privacy errors; zoom still applies in this panel.
  }
}

function updateTab(state: BrowserTabsState, tabId: string, update: (tab: BrowserTab) => BrowserTab): BrowserTabsState {
  if (!state.tabs.some((tab) => tab.id === tabId)) return state;
  return { ...state, tabs: state.tabs.map((tab) => tab.id === tabId ? update(tab) : tab) };
}

function closeBrowserTab(state: BrowserTabsState, tabId: string): BrowserTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return state;

  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (state.activeTabId !== tabId) return { ...state, tabs };
  return { tabs, activeTabId: tabs[Math.min(index, tabs.length - 1)]?.id };
}

function hasUnsupportedScheme(value: string): boolean {
  if (/^https?:\/\//i.test(value)) return false;
  if (!/^[a-z][a-z\d+.-]*:/i.test(value)) return false;
  return !/^[^/?#:]+:\d+(?:[/?#]|$)/.test(value);
}

function browserZoomStorage(): BrowserZoomStorage | undefined {
  try {
    if (typeof window === "undefined") return undefined;
    return window.localStorage;
  } catch {
    return undefined;
  }
}
