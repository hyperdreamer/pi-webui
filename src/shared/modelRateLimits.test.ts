import { describe, expect, it } from "vitest";
import {
  MODEL_RATE_LIMIT_FIELDS,
  MODEL_RATE_LIMIT_WINDOW_MS,
  modelRateLimitFieldMessage,
  modelRateLimitValuesFromEntry,
  parseModelRateLimitDraftText,
  parseModelRateLimitStoredValue,
  sumModelTerminalTokens,
} from "./modelRateLimits";

describe("model rate limit values", () => {
  it("exposes the two fields and the rolling window", () => {
    expect(MODEL_RATE_LIMIT_FIELDS).toEqual(["tpm", "prm"]);
    expect(MODEL_RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });

  it("accepts omitted, zero, and positive safe integers and reports each rejection reason", () => {
    expect(parseModelRateLimitStoredValue(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseModelRateLimitStoredValue(0)).toEqual({ ok: true, value: 0 });
    expect(parseModelRateLimitStoredValue(-0)).toEqual({ ok: true, value: 0 });
    expect(parseModelRateLimitStoredValue(90_000)).toEqual({ ok: true, value: 90_000 });
    expect(parseModelRateLimitStoredValue(-1)).toEqual({ ok: false, reason: "negative" });
    expect(parseModelRateLimitStoredValue(1.5)).toEqual({ ok: false, reason: "not-an-integer" });
    expect(parseModelRateLimitStoredValue(Number.NaN)).toEqual({ ok: false, reason: "not-finite" });
    expect(parseModelRateLimitStoredValue(Number.POSITIVE_INFINITY)).toEqual({ ok: false, reason: "not-finite" });
    expect(parseModelRateLimitStoredValue(Number.MAX_SAFE_INTEGER + 1)).toEqual({ ok: false, reason: "unsafe-integer" });
    expect(parseModelRateLimitStoredValue("90")).toEqual({ ok: false, reason: "not-a-number" });
    expect(parseModelRateLimitStoredValue(true)).toEqual({ ok: false, reason: "not-a-number" });
    expect(parseModelRateLimitStoredValue(null)).toEqual({ ok: false, reason: "not-a-number" });
    expect(parseModelRateLimitStoredValue({})).toEqual({ ok: false, reason: "not-a-number" });
    expect(parseModelRateLimitStoredValue([])).toEqual({ ok: false, reason: "not-a-number" });
  });

  it("parses only canonical non-negative decimal draft text", () => {
    expect(parseModelRateLimitDraftText("")).toEqual({ ok: true, value: undefined });
    expect(parseModelRateLimitDraftText("   ")).toEqual({ ok: true, value: undefined });
    expect(parseModelRateLimitDraftText("0")).toEqual({ ok: true, value: 0 });
    expect(parseModelRateLimitDraftText(" 100000 ")).toEqual({ ok: true, value: 100_000 });
    for (const text of ["+5", "-0", "007", "1e3", "1.5", "0x10", "1_000", "1 000", "abc", "-5"]) {
      expect(parseModelRateLimitDraftText(text)).toEqual({ ok: false, reason: "not-a-number" });
    }
    expect(parseModelRateLimitDraftText(String(Number.MAX_SAFE_INTEGER + 1))).toEqual({ ok: false, reason: "unsafe-integer" });
  });

  it("keeps only positive values and reports the first invalid field in field order", () => {
    expect(modelRateLimitValuesFromEntry({})).toEqual({ ok: true, values: {} });
    expect(modelRateLimitValuesFromEntry({ tpm: 0, prm: 5 })).toEqual({ ok: true, values: { prm: 5 } });
    expect(modelRateLimitValuesFromEntry({ tpm: 9, prm: 5 })).toEqual({ ok: true, values: { tpm: 9, prm: 5 } });
    expect(modelRateLimitValuesFromEntry({ prm: "5" })).toEqual({ ok: false, field: "prm", reason: "not-a-number" });
    expect(modelRateLimitValuesFromEntry({ tpm: -1, prm: "5" })).toEqual({ ok: false, field: "tpm", reason: "negative" });
  });

  it("sums only the four terminal counters and never adds totalTokens", () => {
    expect(sumModelTerminalTokens({ input: 10, output: 4, cacheRead: 3, cacheWrite: 2, totalTokens: 9_999 })).toBe(19);
    expect(sumModelTerminalTokens({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 500 })).toBe(0);
    expect(sumModelTerminalTokens({ input: -5, output: Number.NaN, cacheRead: Number.POSITIVE_INFINITY, cacheWrite: "3" })).toBe(0);
    expect(sumModelTerminalTokens({ output: 7 })).toBe(7);
    expect(sumModelTerminalTokens(undefined)).toBe(0);
    expect(sumModelTerminalTokens(null)).toBe(0);
    expect(sumModelTerminalTokens("nope")).toBe(0);
  });

  it("returns stable field messages", () => {
    expect(modelRateLimitFieldMessage("tpm", "not-a-number")).toBe("Tokens per minute must be a whole number.");
    expect(modelRateLimitFieldMessage("prm", "not-a-number")).toBe("Requests per minute must be a whole number.");
    expect(modelRateLimitFieldMessage("tpm", "negative")).toBe("Tokens per minute must be a non-negative whole number.");
    expect(modelRateLimitFieldMessage("prm", "not-finite")).toBe("Requests per minute must be a non-negative whole number.");
    expect(modelRateLimitFieldMessage("tpm", "unsafe-integer")).toBe("Tokens per minute must be a non-negative whole number.");
    expect(modelRateLimitFieldMessage("prm", "missing-model-id")).toBe("Set a Model ID before setting rate limits.");
  });
});
