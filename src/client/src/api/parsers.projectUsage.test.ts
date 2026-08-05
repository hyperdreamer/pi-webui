import { describe, expect, it } from "vitest";
import { parseProjectUsageCountResponse, parseProjectUsageResponse } from "./parsers";

const totals = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5, sessionCount: 6 };

function validResponse(): Record<string, unknown> {
  return {
    projectPath: "/dev/app",
    buckets: { live: totals, retired: totals, archived: totals },
    total: { ...totals, input: 3 },
    generatedAt: "2026-08-05T00:00:00.000Z",
  };
}

describe("parseProjectUsageResponse", () => {
  it("parses a complete response", () => {
    const parsed = parseProjectUsageResponse(validResponse());
    expect(parsed.projectPath).toBe("/dev/app");
    expect(parsed.buckets.live).toEqual(totals);
    expect(parsed.buckets.retired.cacheRead).toBe(3);
    expect(parsed.buckets.archived.sessionCount).toBe(6);
    expect(parsed.total.input).toBe(3);
    expect(parsed.generatedAt).toBe("2026-08-05T00:00:00.000Z");
  });

  it("throws when a bucket is missing", () => {
    const response = validResponse();
    response["buckets"] = { live: totals, retired: totals };
    expect(() => parseProjectUsageResponse(response)).toThrow();
  });

  it("throws when a numeric field is not a number", () => {
    const response = validResponse();
    response["total"] = { ...totals, cost: "free" };
    expect(() => parseProjectUsageResponse(response)).toThrow();
  });

  it("throws when the payload is not an object", () => {
    expect(() => parseProjectUsageResponse(null)).toThrow();
  });
});

describe("parseProjectUsageCountResponse", () => {
  it("parses a complete count response", () => {
    expect(parseProjectUsageCountResponse({ sessionCount: 6 })).toEqual({ sessionCount: 6 });
  });

  it.each([
    null,
    {},
    { sessionCount: "6" },
    { sessionCount: -1 },
    { sessionCount: 1.5 },
  ])("rejects an invalid count response %#", (value) => {
    expect(() => parseProjectUsageCountResponse(value)).toThrow();
  });

  it("rejects unknown response fields", () => {
    expect(() => parseProjectUsageCountResponse({ sessionCount: 6, unexpected: true })).toThrow();
  });
});
