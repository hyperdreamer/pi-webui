import { describe, expect, it } from "vitest";
import { terminalBackgroundWithOpacity } from "./TerminalPanel";

describe("terminalBackgroundWithOpacity", () => {
  it("makes a hex terminal background translucent at the requested opacity", () => {
    expect(terminalBackgroundWithOpacity("#05070a", 55)).toBe("rgba(5, 7, 10, 0.55)");
  });

  it("keeps the original terminal background at full opacity", () => {
    expect(terminalBackgroundWithOpacity("#05070a", 100)).toBe("#05070a");
  });

  it("clamps an opacity below zero to a transparent terminal color", () => {
    expect(terminalBackgroundWithOpacity("#05070a", -1)).toBe("rgba(5, 7, 10, 0)");
  });
});
