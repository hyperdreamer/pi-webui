import { describe, expect, it, beforeEach, vi } from "vitest";
import { ALL_RAIL_ITEMS, DEFAULT_RAIL_ORDER, readRailOrder, writeRailOrder, type ActivityRailItem } from "./activityRailOrder";

function storageMock(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
  };
}

describe("activityRailOrder", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = storageMock();
    vi.stubGlobal("localStorage", storage);
  });

  describe("readRailOrder", () => {
    it("returns undefined when nothing is stored", () => {
      expect(readRailOrder()).toBeUndefined();
    });

    it("returns a valid stored order", () => {
      const order: ActivityRailItem[] = ["info", "theme", "terminal", "browser", "history", "system-prompt"];
      storage.setItem("pi-webui:activity-rail-order", JSON.stringify(order));
      expect(readRailOrder()).toEqual(order);
    });

    it("adds Browser to a valid saved order from before Browser existed", () => {
      const legacyOrder = ["info", "theme", "terminal", "history", "system-prompt"];
      storage.setItem("pi-webui:activity-rail-order", JSON.stringify(legacyOrder));

      expect(readRailOrder()).toEqual(["info", "theme", "terminal", "browser", "history", "system-prompt"]);
    });

    it("returns undefined for invalid JSON", () => {
      storage.setItem("pi-webui:activity-rail-order", "{bad");
      expect(readRailOrder()).toBeUndefined();
    });

    it("returns undefined when not an array", () => {
      storage.setItem("pi-webui:activity-rail-order", '"terminal"');
      expect(readRailOrder()).toBeUndefined();
    });

    it("returns undefined when the array has wrong length", () => {
      storage.setItem("pi-webui:activity-rail-order", JSON.stringify(["terminal", "theme"]));
      expect(readRailOrder()).toBeUndefined();
    });

    it("returns undefined when an item is not a valid ActivityRailItem", () => {
      storage.setItem("pi-webui:activity-rail-order", JSON.stringify(["terminal", "theme", "system-prompt", "history", "invalid"]));
      expect(readRailOrder()).toBeUndefined();
    });

    it("returns undefined when there are duplicate items", () => {
      storage.setItem("pi-webui:activity-rail-order", JSON.stringify(["terminal", "theme", "system-prompt", "history", "terminal"]));
      expect(readRailOrder()).toBeUndefined();
    });

    it("returns undefined when localStorage is unavailable", () => {
      vi.stubGlobal("localStorage", undefined);
      expect(readRailOrder()).toBeUndefined();
    });
  });

  describe("writeRailOrder", () => {
    it("persists the order to localStorage", () => {
      const order: ActivityRailItem[] = ["history", "info", "theme", "terminal", "system-prompt"];
      writeRailOrder(order);
      const stored = storage.getItem("pi-webui:activity-rail-order");
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored ?? "")).toEqual(order);
    });

    it("does not throw when localStorage is unavailable", () => {
      vi.stubGlobal("localStorage", undefined);
      expect(() => { writeRailOrder([...DEFAULT_RAIL_ORDER]); }).not.toThrow();
    });

    it("does not throw when localStorage throws on setItem", () => {
      storage.setItem = () => { throw new Error("quota exceeded"); };
      expect(() => { writeRailOrder([...DEFAULT_RAIL_ORDER]); }).not.toThrow();
    });
  });

  describe("constants", () => {
    it("DEFAULT_RAIL_ORDER contains all six items", () => {
      expect(DEFAULT_RAIL_ORDER).toHaveLength(6);
      for (const item of ALL_RAIL_ITEMS) {
        expect(DEFAULT_RAIL_ORDER).toContain(item);
      }
      // No duplicates
      expect(new Set(DEFAULT_RAIL_ORDER).size).toBe(6);
    });

    it("ALL_RAIL_ITEMS contains exactly 6 identifiers", () => {
      expect(ALL_RAIL_ITEMS).toHaveLength(6);
      expect(ALL_RAIL_ITEMS).toContain("terminal");
      expect(ALL_RAIL_ITEMS).toContain("browser");
      expect(ALL_RAIL_ITEMS).toContain("theme");
      expect(ALL_RAIL_ITEMS).toContain("system-prompt");
      expect(ALL_RAIL_ITEMS).toContain("history");
      expect(ALL_RAIL_ITEMS).toContain("info");
    });
  });
});
