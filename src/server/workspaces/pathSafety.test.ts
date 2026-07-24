import { describe, expect, it } from "vitest";
import { normalizeRelativePath } from "./pathSafety.js";

describe("normalizeRelativePath", () => {
  it("normalizes separators and dot segments", () => {
    expect(normalizeRelativePath("./src//client\\main.ts")).toBe("src/client/main.ts");
  });

  it("rejects absolute paths", () => {
    expect(() => normalizeRelativePath("/etc/passwd")).toThrow("Absolute paths are not allowed");
  });

  it("rejects traversal", () => {
    expect(() => normalizeRelativePath("src/../secret")).toThrow("Path traversal is not allowed");
  });
});
