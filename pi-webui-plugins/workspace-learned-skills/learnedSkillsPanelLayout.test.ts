import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LIST_WIDTH,
  LEARNED_SKILLS_LAYOUT_STORAGE_KEY,
  MAX_LIST_WIDTH,
  MIN_LIST_WIDTH,
  clampLearnedSkillsListWidth,
  readLearnedSkillsListWidth,
  writeLearnedSkillsListWidth,
  type LayoutStorage,
} from "./learnedSkillsPanelLayout.js";

function storageWith(value: string | null): LayoutStorage {
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn(),
  };
}

describe("learned skills panel layout", () => {
  it("reads the version-one layout envelope", () => {
    const storage = storageWith(JSON.stringify({ version: 1, listWidth: 320 }));

    expect(readLearnedSkillsListWidth(storage)).toBe(320);
    expect(storage.getItem).toHaveBeenCalledWith(LEARNED_SKILLS_LAYOUT_STORAGE_KEY);
  });

  it.each([
    ["missing", null],
    ["invalid JSON", "{"],
    ["wrong version", JSON.stringify({ version: 2, listWidth: 320 })],
    ["non-numeric width", JSON.stringify({ version: 1, listWidth: "NaN" })],
    ["non-finite width", JSON.stringify({ version: 1, listWidth: null })],
  ])("uses the default width for %s storage", (_label, value) => {
    expect(readLearnedSkillsListWidth(storageWith(value))).toBe(DEFAULT_LIST_WIDTH);
  });

  it("uses the default when storage access throws", () => {
    const storage: LayoutStorage = {
      getItem: vi.fn(() => { throw new Error("privacy mode"); }),
      setItem: vi.fn(),
    };

    expect(readLearnedSkillsListWidth(storage)).toBe(DEFAULT_LIST_WIDTH);
  });

  it("statically clamps widths to the supported range", () => {
    expect(clampLearnedSkillsListWidth(-100)).toBe(MIN_LIST_WIDTH);
    expect(clampLearnedSkillsListWidth(320)).toBe(320);
    expect(clampLearnedSkillsListWidth(900)).toBe(MAX_LIST_WIDTH);
    expect(clampLearnedSkillsListWidth(Number.NaN)).toBe(DEFAULT_LIST_WIDTH);
  });

  it("limits the list so the runtime container retains detail space", () => {
    expect(clampLearnedSkillsListWidth(MAX_LIST_WIDTH, 700)).toBe(372);
    expect(clampLearnedSkillsListWidth(MAX_LIST_WIDTH, 900)).toBe(MAX_LIST_WIDTH);
  });

  it("writes a versioned envelope with a clamped integer width", () => {
    const storage = storageWith(null);

    writeLearnedSkillsListWidth(320.6, storage);

    expect(storage.setItem).toHaveBeenCalledWith(
      LEARNED_SKILLS_LAYOUT_STORAGE_KEY,
      JSON.stringify({ version: 1, listWidth: 321 }),
    );
  });

  it("does not throw when persistence is blocked or over quota", () => {
    const storage: LayoutStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => { throw new Error("quota exceeded"); }),
    };

    expect(() => { writeLearnedSkillsListWidth(320, storage); }).not.toThrow();
  });
});
