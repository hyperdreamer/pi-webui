import { describe, expect, it } from "vitest";
import { scrollDeltaForMarker, scrollTopForBottomDistance, selectPrependMarker } from "./chatScrollAnchoring";

describe("chat scroll anchoring", () => {
  it("selects the nearest marker at or above the viewport top", () => {
    expect(selectPrependMarker([
      { id: "below", offset: 20 },
      { id: "above-far", offset: -50 },
      { id: "above-near", offset: -2 },
    ])).toEqual({ id: "above-near", offset: -2 });
  });

  it("falls back to the nearest marker below the viewport top", () => {
    expect(selectPrependMarker([
      { id: "below-far", offset: 80 },
      { id: "below-near", offset: 12 },
    ])).toEqual({ id: "below-near", offset: 12 });
  });

  it("returns undefined when there are no markers", () => {
    expect(selectPrependMarker([])).toBeUndefined();
  });

  it("computes the scroll delta needed to keep a marker at the same offset", () => {
    expect(scrollDeltaForMarker(150, 40)).toBe(110);
  });

  it("computes fallback scrollTop from bottom distance", () => {
    expect(scrollTopForBottomDistance(1000, 250)).toBe(750);
    expect(scrollTopForBottomDistance(100, 250)).toBe(0);
  });
});
