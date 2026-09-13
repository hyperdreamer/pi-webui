import { describe, expect, it } from "vitest";
import type { ModelsConfigDocument } from "../../shared/apiTypes";
import {
  emptyModelRateLimitSnapshot,
  extractModelRateLimits,
  modelRateLimitValuesFor,
} from "./modelRateLimitConfig";

const model = (id: string, limits: Record<string, unknown> = {}) => ({ id, ...limits });

describe("model rate limit extraction", () => {
  it("recognizes limits only on explicit models entries", () => {
    const document: ModelsConfigDocument = {
      tpm: 10,
      providers: {
        acme: {
          tpm: 20,
          prm: 30,
          modelOverrides: { demo: { tpm: 40, prm: 50 } },
          models: [model("demo", { tpm: 100, prm: 5 })],
        },
      },
    };

    const extraction = extractModelRateLimits(document);

    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;
    expect(modelRateLimitValuesFor(extraction.snapshot, { provider: "acme", modelId: "demo" })).toEqual({ tpm: 100, prm: 5 });
    expect(extraction.snapshot.limits.size).toBe(1);
    expect(document["tpm"]).toBe(10);
    expect(document.providers?.["acme"]?.modelOverrides).toEqual({ demo: { tpm: 40, prm: 50 } });
  });

  it("keeps provider and model budgets independent with collision-safe identity", () => {
    const document: ModelsConfigDocument = {
      providers: {
        "a/b": { models: [model("c", { tpm: 7 })] },
        a: { models: [model("b/c", { prm: 3 })] },
        other: { models: [model("c", { tpm: 9 })] },
      },
    };

    const extraction = extractModelRateLimits(document);

    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;
    expect(modelRateLimitValuesFor(extraction.snapshot, { provider: "a/b", modelId: "c" })).toEqual({ tpm: 7 });
    expect(modelRateLimitValuesFor(extraction.snapshot, { provider: "a", modelId: "b/c" })).toEqual({ prm: 3 });
    expect(modelRateLimitValuesFor(extraction.snapshot, { provider: "other", modelId: "c" })).toEqual({ tpm: 9 });
  });

  it("keeps ids with surrounding whitespace distinct", () => {
    const document: ModelsConfigDocument = {
      providers: { acme: { models: [model("strict", { prm: 1 }), model(" strict", { prm: 2 })] } },
    };

    const extraction = extractModelRateLimits(document);

    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;
    expect(modelRateLimitValuesFor(extraction.snapshot, { provider: "acme", modelId: "strict" })).toEqual({ prm: 1 });
    expect(modelRateLimitValuesFor(extraction.snapshot, { provider: "acme", modelId: " strict" })).toEqual({ prm: 2 });
  });

  it("lets the last duplicate own both dimensions and drops omitted dimensions", () => {
    const document: ModelsConfigDocument = {
      providers: { acme: { models: [model("demo", { tpm: 100, prm: 5 }), model("demo", { tpm: 300 })] } },
    };

    const extraction = extractModelRateLimits(document);

    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;
    expect(modelRateLimitValuesFor(extraction.snapshot, { provider: "acme", modelId: "demo" })).toEqual({ tpm: 300 });
  });

  it("drops every identity without an enabled dimension", () => {
    const document: ModelsConfigDocument = {
      providers: { acme: { models: [model("plain"), model("zero", { tpm: 0, prm: 0 })] } },
    };

    const extraction = extractModelRateLimits(document);

    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;
    expect(extraction.snapshot.limits.size).toBe(0);
    expect(emptyModelRateLimitSnapshot().limits.size).toBe(0);
  });

  it("rejects the whole snapshot when a shadowed duplicate is invalid", () => {
    const document: ModelsConfigDocument = {
      providers: { acme: { models: [model("demo", { tpm: "bad" }), model("demo", { tpm: 10 })] } },
    };

    expect(extractModelRateLimits(document)).toEqual({
      ok: false,
      errors: [{
        provider: "acme",
        modelId: "demo",
        occurrence: 0,
        field: "tpm",
        reason: "not-a-number",
        message: "Tokens per minute must be a whole number.",
      }],
    });
  });

  it("collects all errors in provider, entry, and field order", () => {
    const document: ModelsConfigDocument = {
      providers: {
        first: { models: [model("", { tpm: 1, prm: 2 }), model("b", { tpm: 1.5 })] },
        second: { models: [model("a", { prm: -1 })] },
      },
    };

    const extraction = extractModelRateLimits(document);

    expect(extraction.ok).toBe(false);
    if (extraction.ok) return;
    expect(extraction.errors.map(({ provider, modelId, occurrence, field, reason }) => ({ provider, modelId, occurrence, field, reason }))).toEqual([
      { provider: "first", modelId: "", occurrence: 0, field: "tpm", reason: "missing-model-id" },
      { provider: "first", modelId: "", occurrence: 0, field: "prm", reason: "missing-model-id" },
      { provider: "first", modelId: "b", occurrence: 0, field: "tpm", reason: "not-an-integer" },
      { provider: "second", modelId: "a", occurrence: 0, field: "prm", reason: "negative" },
    ]);
  });

  it("treats absent or malformed collections as no limits", () => {
    expect(extractModelRateLimits({})).toEqual({ ok: true, snapshot: { limits: new Map() } });
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- deliberately malformed document for defensive extraction.
    expect(extractModelRateLimits({ providers: { acme: { models: "no" } } } as unknown as ModelsConfigDocument)).toEqual({ ok: true, snapshot: { limits: new Map() } });
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- deliberately malformed entries for defensive extraction.
    expect(extractModelRateLimits({ providers: { acme: { models: [null, { id: "demo", tpm: 5 }] } } } as unknown as ModelsConfigDocument).ok).toBe(true);
  });
});
