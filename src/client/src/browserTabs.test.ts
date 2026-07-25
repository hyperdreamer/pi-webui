import { describe, expect, it } from "vitest";
import {
  BLANK_BROWSER_URL,
  BROWSER_ZOOM_STORAGE_KEY,
  clampBrowserZoom,
  createBrowserTabsState,
  browserTabLabel,
  normalizeBrowserAddress,
  readBrowserZoom,
  updateBrowserTabs,
  writeBrowserZoom,
} from "./browserTabs";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("browser tabs", () => {
  it("starts with one blank selected tab", () => {
    expect(createBrowserTabsState("tab-1")).toEqual({
      tabs: [{ id: "tab-1", url: BLANK_BROWSER_URL, reloadRevision: 0 }],
      activeTabId: "tab-1",
    });
  });

  it("adds a blank tab and selects it", () => {
    const next = updateBrowserTabs(createBrowserTabsState("tab-1"), { type: "add", tabId: "tab-2" });

    expect(next.activeTabId).toBe("tab-2");
    expect(next.tabs).toEqual([
      { id: "tab-1", url: BLANK_BROWSER_URL, reloadRevision: 0 },
      { id: "tab-2", url: BLANK_BROWSER_URL, reloadRevision: 0 },
    ]);
  });

  it("navigates and reloads only the chosen tab", () => {
    const tabs = updateBrowserTabs(createBrowserTabsState("tab-1"), { type: "add", tabId: "tab-2" });
    const navigated = updateBrowserTabs(tabs, { type: "navigate", tabId: "tab-1", url: "https://example.com/guide" });
    const reloaded = updateBrowserTabs(navigated, { type: "reload", tabId: "tab-1" });

    expect(reloaded.tabs).toEqual([
      { id: "tab-1", url: "https://example.com/guide", reloadRevision: 1 },
      { id: "tab-2", url: BLANK_BROWSER_URL, reloadRevision: 0 },
    ]);
  });

  it("selects the adjacent tab after closing the active tab", () => {
    const withSecond = updateBrowserTabs(createBrowserTabsState("tab-1"), { type: "add", tabId: "tab-2" });
    const withThird = updateBrowserTabs(withSecond, { type: "add", tabId: "tab-3" });

    const afterMiddleClose = updateBrowserTabs({ ...withThird, activeTabId: "tab-2" }, { type: "close", tabId: "tab-2" });
    const afterLastClose = updateBrowserTabs(afterMiddleClose, { type: "close", tabId: "tab-3" });
    const afterFinalClose = updateBrowserTabs(afterLastClose, { type: "close", tabId: "tab-1" });

    expect(afterMiddleClose.activeTabId).toBe("tab-3");
    expect(afterLastClose.activeTabId).toBe("tab-1");
    expect(afterFinalClose).toEqual({ tabs: [], activeTabId: undefined });
  });

  it("normalizes web addresses without permitting executable URL schemes", () => {
    expect(normalizeBrowserAddress("example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeBrowserAddress("http://localhost:3000")).toBe("http://localhost:3000/");
    expect(normalizeBrowserAddress(" https://example.com ")).toBe("https://example.com/");
    expect(normalizeBrowserAddress("javascript:alert(1)")).toBeUndefined();
    expect(normalizeBrowserAddress("data:text/html,hello")).toBeUndefined();
    expect(normalizeBrowserAddress("not a url")).toBeUndefined();
  });

  it("derives concise tab labels from an address", () => {
    expect(browserTabLabel(BLANK_BROWSER_URL)).toBe("New tab");
    expect(browserTabLabel("https://docs.example.com/guide")).toBe("docs.example.com");
  });

  it("uses the default page zoom when no preference is stored", () => {
    expect(readBrowserZoom(new MemoryStorage())).toBe(100);
  });

  it("clamps and persists page zoom", () => {
    const storage = new MemoryStorage();

    expect(clampBrowserZoom(12)).toBe(50);
    expect(clampBrowserZoom(208)).toBe(200);
    writeBrowserZoom(137.6, storage);

    expect(storage.getItem(BROWSER_ZOOM_STORAGE_KEY)).toBe("138");
    expect(readBrowserZoom(storage)).toBe(138);
  });
});
