import { describe, expect, it, beforeEach, vi } from "vitest";
import { DEFAULT_RAIL_ORDER, readRailOrder, writeRailOrder, type ReorderableRailItem } from "./activityRailOrder";

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
      const order: ReorderableRailItem[] = ["history", "theme", "terminal", "browser", "git-update-manager", "system-prompt"];
      storage.setItem("pi-webui:activity-rail-order", JSON.stringify(order));
      expect(readRailOrder()).toEqual(order);
    });

    it("replaces the legacy File Manager identifier with Git Update Manager", () => {
      const legacyOrder = ["history", "theme", "terminal", "browser", "file-manager", "system-prompt"];
      storage.setItem("pi-webui:activity-rail-order", JSON.stringify(legacyOrder));

      expect(readRailOrder()).toEqual(["history", "theme", "terminal", "browser", "git-update-manager", "system-prompt"]);
    });

    it("adds Browser and Git Update Manager to a valid saved order from before either existed", () => {
      const legacyOrder = ["history", "theme", "terminal", "system-prompt"];
      storage.setItem("pi-webui:activity-rail-order", JSON.stringify(legacyOrder));

      expect(readRailOrder()).toEqual(["history", "theme", "terminal", "browser", "git-update-manager", "system-prompt"]);
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

    it("returns undefined when an item is not a valid ReorderableRailItem", () => {
      storage.setItem("pi-webui:activity-rail-order", JSON.stringify(["terminal", "theme", "system-prompt", "invalid"]));
      expect(readRailOrder()).toBeUndefined();
    });

    it("returns undefined when there are duplicate items", () => {
      storage.setItem("pi-webui:activity-rail-order", JSON.stringify(["terminal", "theme", "system-prompt", "terminal"]));
      expect(readRailOrder()).toBeUndefined();
    });

    it("returns undefined when localStorage is unavailable", () => {
      vi.stubGlobal("localStorage", undefined);
      expect(readRailOrder()).toBeUndefined();
    });

    it("rejects an order that includes info (info is never reorderable)", () => {
      storage.setItem("pi-webui:activity-rail-order", JSON.stringify(["terminal", "theme", "system-prompt", "info"]));
      expect(readRailOrder()).toBeUndefined();
    });
  });

  describe("writeRailOrder", () => {
    it("persists the order to localStorage", () => {
      const order: ReorderableRailItem[] = ["history", "system-prompt", "theme", "git-update-manager", "terminal", "browser"];
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
    it("DEFAULT_RAIL_ORDER contains exactly 6 reorderable items", () => {
      expect(DEFAULT_RAIL_ORDER).toHaveLength(6);
      const itemSet = new Set(DEFAULT_RAIL_ORDER);
      expect(itemSet.has("terminal")).toBe(true);
      expect(itemSet.has("browser")).toBe(true);
      expect(itemSet.has("git-update-manager")).toBe(true);
      expect(itemSet.has("theme")).toBe(true);
      expect(itemSet.has("system-prompt")).toBe(true);
      expect(itemSet.has("history")).toBe(true);
      expect(itemSet.size).toBe(6);
    });
  });
});
