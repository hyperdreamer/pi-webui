import { describe, expect, it } from "vitest";
import { arrayOf, parseRecentProjectEntry } from "./parsers";

const entry = { id: "e1", name: "alpha", path: "/work/alpha", lastUsedAt: "2026-01-01T00:00:00.000Z" };

describe("parseRecentProjectEntry", () => {
  it("parses a complete entry", () => {
    expect(parseRecentProjectEntry(entry)).toEqual(entry);
  });

  it("parses an ordered collection", () => {
    expect(arrayOf(parseRecentProjectEntry)([entry])).toEqual([entry]);
  });

  it.each(["id", "name", "path", "lastUsedAt"] as const)("rejects a missing %s", (key) => {
    expect(() => parseRecentProjectEntry({ ...entry, [key]: undefined })).toThrow();
  });

  it("rejects a non-string timestamp and a non-object entry", () => {
    expect(() => parseRecentProjectEntry({ ...entry, lastUsedAt: 0 })).toThrow();
    expect(() => parseRecentProjectEntry("nope")).toThrow();
  });

  it("rejects a non-array collection", () => {
    expect(() => arrayOf(parseRecentProjectEntry)({})).toThrow();
  });
});
