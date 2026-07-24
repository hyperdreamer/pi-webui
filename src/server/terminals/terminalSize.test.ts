import { describe, expect, it } from "vitest";
import { parseTerminalSize, terminalSizeQuery } from "./terminalSize.js";

describe("terminal size helpers", () => {
  it("normalizes valid terminal dimensions", () => {
    expect(parseTerminalSize("120.9", "40.2")).toEqual({ cols: 120, rows: 40 });
    expect(parseTerminalSize(80, 24)).toEqual({ cols: 80, rows: 24 });
  });

  it("rejects missing or invalid dimensions", () => {
    expect(parseTerminalSize(undefined, "24")).toBeUndefined();
    expect(parseTerminalSize("0", "24")).toBeUndefined();
    expect(parseTerminalSize("80", "NaN")).toBeUndefined();
    expect(parseTerminalSize("80", "-1")).toBeUndefined();
  });

  it("builds a normalized query string only for valid dimensions", () => {
    expect(terminalSizeQuery("120.9", "40.2")).toBe("?cols=120&rows=40");
    expect(terminalSizeQuery("invalid", "40")).toBe("");
  });
});
