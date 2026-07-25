import { describe, expect, it } from "vitest";
import {
  clampRatio,
  computeMinimapViewport,
  extractMinimapScrollRatio,
  messageTopRatio,
  minimapTooltipTopPositions,
  minimapClickToScrollRatio,
  scrollToMinimapTopRatio,
} from "./chatMinimapGeometry";

describe("computeMinimapViewport", () => {
  it("returns visible:false when scrollHeight is zero", () => {
    expect(
      computeMinimapViewport({ scrollHeight: 0, clientHeight: 600, scrollTop: 0 }),
    ).toEqual({ scrollRatio: 0, viewportRatio: 1, visible: false });
  });

  it("returns visible:false when clientHeight is zero", () => {
    expect(
      computeMinimapViewport({ scrollHeight: 1000, clientHeight: 0, scrollTop: 0 }),
    ).toEqual({ scrollRatio: 0, viewportRatio: 1, visible: false });
  });

  it("returns visible:false when overflow is 20 px or less", () => {
    expect(
      computeMinimapViewport({ scrollHeight: 620, clientHeight: 600, scrollTop: 0 }),
    ).toEqual({ scrollRatio: 0, viewportRatio: 1, visible: false });
  });

  it("returns visible:true when overflow exceeds 20 px", () => {
    expect(
      computeMinimapViewport({ scrollHeight: 2000, clientHeight: 600, scrollTop: 0 }),
    ).toEqual({ scrollRatio: 0, viewportRatio: 0.3, visible: true });
  });

  it("computes mid-scroll ratio correctly", () => {
    const result = computeMinimapViewport({
      scrollHeight: 2000,
      clientHeight: 600,
      scrollTop: 700,
    });
    // scrollable = 1400, scrollRatio = 700/1400 = 0.5
    expect(result.scrollRatio).toBeCloseTo(0.5);
    expect(result.viewportRatio).toBeCloseTo(0.3);
    expect(result.visible).toBe(true);
  });

  it("clamps scroll ratio to 1 when scrolled to bottom", () => {
    const result = computeMinimapViewport({
      scrollHeight: 2000,
      clientHeight: 600,
      scrollTop: 1400,
    });
    expect(result.scrollRatio).toBe(1);
  });
});

describe("clampRatio", () => {
  it("clamps values below 0", () => {
    expect(clampRatio(-0.5)).toBe(0);
  });

  it("clamps values above 1", () => {
    expect(clampRatio(1.5)).toBe(1);
  });

  it("passes through values in range", () => {
    expect(clampRatio(0.73)).toBeCloseTo(0.73);
  });

  it("handles NaN and Infinity", () => {
    expect(clampRatio(NaN)).toBe(0);
    expect(clampRatio(Infinity)).toBe(0);
    expect(clampRatio(-Infinity)).toBe(0);
  });
});

describe("minimapClickToScrollRatio", () => {
  it("maps centre click to middle of content", () => {
    // viewportRatio = 0.3, clickRatio = 0.5
    // adjusted = (0.5 - 0.15) / 0.7 = 0.35 / 0.7 = 0.5
    expect(minimapClickToScrollRatio(0.5, 0.3)).toBeCloseTo(0.5);
  });

  it("maps top click to scroll start", () => {
    const result = minimapClickToScrollRatio(0, 0.3);
    // (0 - 0.15) / 0.7 = -0.15/0.7 ≈ -0.214 → clamped to 0
    expect(result).toBe(0);
  });

  it("maps bottom click to scroll end", () => {
    const result = minimapClickToScrollRatio(1, 0.3);
    // (1 - 0.15) / 0.7 = 0.85/0.7 ≈ 1.214 → clamped to 1
    expect(result).toBe(1);
  });

  it("returns 0 when viewport fills entire height", () => {
    expect(minimapClickToScrollRatio(0.5, 1)).toBe(0);
  });
});

describe("scrollToMinimapTopRatio", () => {
  it("maps scroll start to top of rail", () => {
    expect(scrollToMinimapTopRatio(0, 0.3)).toBe(0);
  });

  it("maps scroll end to bottom of rail minus viewport", () => {
    // scrollRatio=1, viewportRatio=0.3 → top = 1 * 0.7 = 0.7
    expect(scrollToMinimapTopRatio(1, 0.3)).toBeCloseTo(0.7);
  });
});

describe("messageTopRatio", () => {
  it("computes ratio for an element in the middle", () => {
    // elementTop=800, containerTop=200, scrollTop=300, scrollHeight=2000
    // top = (800 - 200 + 300) / 2000 = 900/2000 = 0.45
    expect(messageTopRatio(800, 200, 300, 2000)).toBeCloseTo(0.45);
  });

  it("returns 0 when scrollHeight is 0", () => {
    expect(messageTopRatio(100, 0, 0, 0)).toBe(0);
  });

  it("clamps to 0 for elements above viewport", () => {
    // element above the container by a large margin
    const result = messageTopRatio(0, 500, 0, 1000);
    // (0 - 500 + 0) / 1000 = -0.5 → clamped to 0
    expect(result).toBe(0);
  });

  it("clamps to 1 for elements far below viewport", () => {
    const result = messageTopRatio(3000, 0, 0, 1000);
    // (3000 - 0 + 0) / 1000 = 3 → clamped to 1
    expect(result).toBe(1);
  });
});

describe("minimapTooltipTopPositions", () => {
  const markers = [
    { topRatio: 0.1, role: "user" as const, preview: "First" },
    { topRatio: 0.11, role: "assistant" as const, preview: "Second" },
    { topRatio: 0.12, role: "user" as const, preview: "Third" },
  ];

  it("returns a separated preview position for every minimap marker", () => {
    const positions = minimapTooltipTopPositions(markers, 200);

    expect(positions).toEqual([9, 33, 57]);
    expect(positions).toHaveLength(markers.length);
  });

  it("keeps previews inside the minimap rail", () => {
    expect(
      minimapTooltipTopPositions([
        { topRatio: 0, role: "user", preview: "Top" },
        { topRatio: 1, role: "assistant", preview: "Bottom" },
      ], 100),
    ).toEqual([0, 78]);
  });

  it("still assigns every preview a distinct rail position when there is not enough room to separate them", () => {
    expect(
      minimapTooltipTopPositions([
        { topRatio: 0, role: "user", preview: "One" },
        { topRatio: 0.1, role: "assistant", preview: "Two" },
        { topRatio: 0.2, role: "user", preview: "Three" },
        { topRatio: 0.3, role: "assistant", preview: "Four" },
      ], 80),
    ).toEqual([0, 19, 39, 58]);
  });
});

describe("extractMinimapScrollRatio", () => {
  it("returns undefined for non-object detail", () => {
    expect(extractMinimapScrollRatio(null)).toBeUndefined();
    expect(extractMinimapScrollRatio("string")).toBeUndefined();
    expect(extractMinimapScrollRatio(42)).toBeUndefined();
  });

  it("returns undefined when ratio field is missing", () => {
    expect(extractMinimapScrollRatio({})).toBeUndefined();
    expect(extractMinimapScrollRatio({ other: 1 })).toBeUndefined();
  });

  it("returns clamped ratio for valid input", () => {
    expect(extractMinimapScrollRatio({ ratio: 0.5 })).toBeCloseTo(0.5);
  });

  it("clamps out-of-range values", () => {
    expect(extractMinimapScrollRatio({ ratio: 1.5 })).toBe(1);
    expect(extractMinimapScrollRatio({ ratio: -0.2 })).toBe(0);
  });

  it("returns undefined for NaN ratio", () => {
    expect(extractMinimapScrollRatio({ ratio: NaN })).toBeUndefined();
  });
});
