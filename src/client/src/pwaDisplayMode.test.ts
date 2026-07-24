import { describe, expect, it } from "vitest";
import { PWA_DISPLAY_MODE_QUERIES, detectPwaDisplayMode } from "./pwaDisplayMode";

describe("detectPwaDisplayMode", () => {
  it("detects installed app display modes from media query matches", () => {
    expect(detectPwaDisplayMode([{ matches: false }, { matches: true }], undefined)).toBe(true);
  });

  it("detects iOS standalone PWAs", () => {
    expect(detectPwaDisplayMode([], { standalone: true })).toBe(true);
  });

  it("does not detect a normal browser tab as a PWA", () => {
    expect(detectPwaDisplayMode([{ matches: false }], { standalone: false })).toBe(false);
  });

  it("checks the installed app display modes supported by the manifest", () => {
    expect(PWA_DISPLAY_MODE_QUERIES).toEqual([
      "(display-mode: standalone)",
      "(display-mode: fullscreen)",
      "(display-mode: minimal-ui)",
    ]);
  });
});
