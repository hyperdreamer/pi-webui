// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render } from "lit";
import { renderThinkingGauge } from "./promptEditorIcons";

function bars(total: number, filled: number): SVGRectElement[] {
  const host = document.createElement("div");
  render(renderThinkingGauge({ total, filled }), host);
  return [...host.querySelectorAll("rect")];
}

function num(rect: SVGRectElement, name: string): number {
  return Number(rect.getAttribute(name));
}

describe("renderThinkingGauge", () => {
  it("renders one bar per available level", () => {
    expect(bars(6, 3)).toHaveLength(6);
    expect(bars(3, 1)).toHaveLength(3);
  });

  it("fills exactly the bars up to the current rank", () => {
    const active = bars(6, 4).map((rect) => rect.getAttribute("class")?.includes("gauge-bar-active"));

    expect(active).toEqual([true, true, true, true, false, false]);
  });

  it("renders every bar unfilled when thinking is off", () => {
    const active = bars(6, 0).map((rect) => rect.getAttribute("class")?.includes("gauge-bar-active"));

    expect(active).toEqual([false, false, false, false, false, false]);
  });

  it("ascends in height so rank reads as magnitude", () => {
    const heights = bars(6, 6).map((rect) => num(rect, "height"));

    expect(heights).toEqual([...heights].sort((left, right) => left - right));
    expect(new Set(heights).size).toBe(heights.length);
  });

  it("shares one baseline so the bars sit on a common floor", () => {
    const baselines = bars(6, 6).map((rect) => num(rect, "y") + num(rect, "height"));

    expect(new Set(baselines.map((value) => value.toFixed(3)))).toHaveLength(1);
  });

  it("uses the vertical space instead of leaving the tallest bar short", () => {
    const rects = bars(6, 6);
    const tallest = Math.max(...rects.map((rect) => num(rect, "height")));

    // The old gauge topped out at 16 of 24, leaving the icon visibly bottom-heavy.
    expect(tallest).toBeGreaterThanOrEqual(18);
  });

  it("keeps corners subtle relative to bar width so bars do not read as lozenges", () => {
    const [rect] = bars(6, 6);
    if (rect === undefined) throw new Error("no bars rendered");

    // rx=1 on a 2-wide bar rounded it into a pill; keep it well under half.
    expect(num(rect, "rx") / num(rect, "width")).toBeLessThan(0.35);
  });

  it("keeps a single bar bar-shaped instead of filling the box as a square", () => {
    const [rect] = bars(1, 1);
    if (rect === undefined) throw new Error("no bars rendered");

    // A model offering only off+low yields total=1. Spanning the full 18-wide
    // track made the icon read as a solid square rather than a gauge.
    expect(num(rect, "width")).toBeLessThanOrEqual(num(rect, "height") / 2);
  });

  it("stays inside the icon box for both sparse and dense level sets", () => {
    for (const total of [1, 3, 6, 7]) {
      for (const rect of bars(total, total)) {
        expect(num(rect, "x")).toBeGreaterThanOrEqual(0);
        expect(num(rect, "x") + num(rect, "width")).toBeLessThanOrEqual(24);
        expect(num(rect, "y")).toBeGreaterThanOrEqual(0);
        expect(num(rect, "y") + num(rect, "height")).toBeLessThanOrEqual(24);
      }
    }
  });
});
