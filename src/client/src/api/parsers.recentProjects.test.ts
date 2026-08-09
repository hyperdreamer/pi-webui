import { describe, expect, it } from "vitest";
import { RECENT_PROJECT_LIMIT } from "../../../shared/apiTypes";
import { parseRecentProjectEntries, parseRecentProjectEntry } from "./parsers";

const entry = { id: "e1", name: "alpha", path: "/work/alpha", lastUsedAt: "2026-01-01T00:00:00.000Z" };

describe("parseRecentProjectEntry", () => {
  it("parses a complete entry", () => {
    expect(parseRecentProjectEntry(entry)).toEqual(entry);
  });

  it("parses an ordered collection", () => {
    expect(parseRecentProjectEntries([entry])).toEqual([entry]);
  });

  it.each(["id", "name", "path", "lastUsedAt"] as const)("rejects a missing %s", (key) => {
    expect(() => parseRecentProjectEntry({ ...entry, [key]: undefined })).toThrow();
  });

  it("rejects invalid or noncanonical timestamps", () => {
    expect(() => parseRecentProjectEntry({ ...entry, lastUsedAt: "not-a-timestamp" })).toThrow();
    expect(() => parseRecentProjectEntry({ ...entry, lastUsedAt: "2026-01-01T00:00:00Z" })).toThrow();
  });

  it("rejects a non-string timestamp and a non-object entry", () => {
    expect(() => parseRecentProjectEntry({ ...entry, lastUsedAt: 0 })).toThrow();
    expect(() => parseRecentProjectEntry("nope")).toThrow();
  });

  it("rejects a non-array collection", () => {
    expect(() => parseRecentProjectEntries({})).toThrow();
  });

  it.each([
    ["an oversized collection", Array.from({ length: RECENT_PROJECT_LIMIT + 1 }, (_, index) => ({ ...entry, id: `e${String(index)}`, path: `/work/${String(index)}` }))],
    ["a duplicate id", [entry, { ...entry, path: "/work/beta" }]],
    ["a duplicate path", [entry, { ...entry, id: "e2" }]],
  ])("rejects %s", (_label, value) => {
    expect(() => parseRecentProjectEntries(value)).toThrow();
  });

  it("accepts exactly the maximum unique collection size", () => {
    const value = Array.from({ length: RECENT_PROJECT_LIMIT }, (_, index) => ({ ...entry, id: `e${String(index)}`, path: `/work/${String(index)}` }));

    expect(parseRecentProjectEntries(value)).toEqual(value);
  });
});
