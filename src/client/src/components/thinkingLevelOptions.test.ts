import { describe, expect, it } from "vitest";
import { thinkingLevelOptions } from "./thinkingLevelOptions";

describe("thinkingLevelOptions", () => {
  it("sorts canonically rather than by input order", () => {
    const options = thinkingLevelOptions({
      supported: ["xhigh", "high", "off", "medium", "minimal", "low"],
      all: [],
      selected: "medium",
    });

    expect(options.map((option) => option.level)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("includes unsupported levels as unselectable", () => {
    const options = thinkingLevelOptions({
      supported: ["off", "low"],
      all: ["off", "low", "medium", "high"],
      selected: "off",
    });

    expect(options.map((option) => [option.level, option.supported])).toEqual([
      ["off", true],
      ["low", true],
      ["medium", false],
      ["high", false],
    ]);
  });

  it("marks the selected level and carries cost descriptions", () => {
    const options = thinkingLevelOptions({
      supported: ["off", "low", "medium"],
      all: [],
      selected: "low",
    });

    expect(options.find((option) => option.level === "low")?.selected).toBe(true);
    expect(options.find((option) => option.level === "medium")?.description).toBe("Moderate reasoning (~8k tokens)");
  });

  it("puts unknown levels last, in input order, with no description", () => {
    const options = thinkingLevelOptions({
      supported: ["ludicrous", "off", "zzz"],
      all: [],
      selected: "off",
    });

    expect(options.map((option) => option.level)).toEqual(["off", "ludicrous", "zzz"]);
    expect(options.at(-1)?.description).toBeUndefined();
  });

  it("does not duplicate a level present in both lists", () => {
    const options = thinkingLevelOptions({
      supported: ["off", "low"],
      all: ["low", "off"],
      selected: "off",
    });

    expect(options.map((option) => option.level)).toEqual(["off", "low"]);
  });
});
