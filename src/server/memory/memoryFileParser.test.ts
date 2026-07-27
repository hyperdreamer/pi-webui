import { describe, expect, it } from "vitest";
import { parseMemoryFile } from "./memoryFileParser.js";

describe("parseMemoryFile", () => {
  it("returns an empty array for empty input", () => {
    expect(parseMemoryFile("")).toEqual([]);
  });

  it("returns an empty array for whitespace-only input", () => {
    expect(parseMemoryFile("   \n  \n  ")).toEqual([]);
  });

  it("parses a single entry without metadata", () => {
    const result = parseMemoryFile("A simple memory entry.");
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe("A simple memory entry.");
    expect(result[0]?.id).toHaveLength(8);
    expect(result[0]?.category).toBeUndefined();
    expect(result[0]?.created).toBeUndefined();
    expect(result[0]?.last).toBeUndefined();
    expect(result[0]?.failureReason).toBeUndefined();
  });

  it("parses multiple entries separated by § delimiter", () => {
    const result = parseMemoryFile("First entry.\n§\nSecond entry.\n§\nThird entry.");
    expect(result).toHaveLength(3);
    expect(result[0]?.content).toBe("First entry.");
    expect(result[1]?.content).toBe("Second entry.");
    expect(result[2]?.content).toBe("Third entry.");
  });

  it("extracts category prefix [category]", () => {
    const result = parseMemoryFile("[tool-quirk] Something weird about Node.");
    expect(result).toHaveLength(1);
    expect(result[0]?.category).toBe("tool-quirk");
  });

  it("extracts category prefixes for insight, correction, failure, preference, convention", () => {
    const categories = ["insight", "correction", "failure", "preference", "convention"];
    for (const cat of categories) {
      const result = parseMemoryFile(`[${cat}] An entry.`);
      expect(result[0]?.category).toBe(cat);
    }
  });

  it("extracts metadata comment with created and last dates", () => {
    const result = parseMemoryFile("An entry. <!-- created=2026-07-27, last=2026-07-27 -->");
    expect(result).toHaveLength(1);
    expect(result[0]?.created).toBe("2026-07-27");
    expect(result[0]?.last).toBe("2026-07-27");
  });

  it("extracts failure reason suffix", () => {
    const input = "[tool-quirk] Something broke. — Failed: fs/promises.readFile(0) raised ERR_INVALID_ARG_TYPE.";
    const result = parseMemoryFile(input);
    expect(result).toHaveLength(1);
    expect(result[0]?.failureReason).toBe("fs/promises.readFile(0) raised ERR_INVALID_ARG_TYPE.");
  });

  it("generates deterministic ids via sha256", () => {
    const result1 = parseMemoryFile("Same content.");
    const result2 = parseMemoryFile("Same content.");
    expect(result1[0]?.id).toBe(result2[0]?.id);
  });

  it("generates different ids for different content", () => {
    const result1 = parseMemoryFile("Content A.");
    const result2 = parseMemoryFile("Content B.");
    expect(result1[0]?.id).not.toBe(result2[0]?.id);
  });

  it("skips empty entries between delimiters", () => {
    const result = parseMemoryFile("First.\n§\n\n§\nThird.");
    expect(result).toHaveLength(2);
    expect(result[0]?.content).toBe("First.");
    expect(result[1]?.content).toBe("Third.");
  });

  it("handles a real pi-hermes-memory style entry", () => {
    const input = "[tool-quirk] In this Node v24.15 environment, inline ESM audit parsers cannot use fs/promises.readFile(0); consume process.stdin with async iteration (Buffer.concat chunks) instead. — Failed: fs/promises.readFile(0) raised ERR_INVALID_ARG_TYPE, aborting the parser after the audit command ran. <!-- created=2026-07-27, last=2026-07-27 -->";
    const result = parseMemoryFile(input);
    expect(result).toHaveLength(1);
    expect(result[0]?.category).toBe("tool-quirk");
    expect(result[0]?.created).toBe("2026-07-27");
    expect(result[0]?.last).toBe("2026-07-27");
    expect(result[0]?.failureReason).toBe("fs/promises.readFile(0) raised ERR_INVALID_ARG_TYPE, aborting the parser after the audit command ran.");
    expect(result[0]?.id).toHaveLength(8);
  });

  it("parses entry with only category prefix and no other metadata", () => {
    const result = parseMemoryFile("[insight] A useful observation.");
    expect(result).toHaveLength(1);
    expect(result[0]?.category).toBe("insight");
    expect(result[0]?.created).toBeUndefined();
    expect(result[0]?.last).toBeUndefined();
    expect(result[0]?.failureReason).toBeUndefined();
  });

  it("parses entry with metadata comment but no category", () => {
    const result = parseMemoryFile("Plain text. <!-- created=2026-01-01, last=2026-06-15 -->");
    expect(result).toHaveLength(1);
    expect(result[0]?.category).toBeUndefined();
    expect(result[0]?.created).toBe("2026-01-01");
    expect(result[0]?.last).toBe("2026-06-15");
  });

  it("handles multi-line entry content", () => {
    const result = parseMemoryFile("Line one.\nLine two.\nLine three.");
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe("Line one.\nLine two.\nLine three.");
  });

  it("handles leading and trailing § delimiters gracefully", () => {
    const result = parseMemoryFile("§\nOnly entry.\n§");
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe("Only entry.");
  });
});
