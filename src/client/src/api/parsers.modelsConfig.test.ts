import { describe, expect, it } from "vitest";
import { parseModelDiscoveryResponse, parseModelsConfigDocument, parseModelsConfigLimitsStatusResponse, parseModelsConfigSaveResponse } from "./parsers";

describe("parseModelsConfigDocument", () => {
  it("rejects malformed provider model lists before they reach the Models dialog", () => {
    expect(() => parseModelsConfigDocument({
      providers: {
        custom: { models: "not-an-array" },
      },
    })).toThrow("Expected models configuration models array");
  });

  it("parses provider-discovered model ids and optional display names", () => {
    expect(parseModelDiscoveryResponse({
      models: [
        { id: "gpt-test", name: "GPT Test" },
        { id: "gpt-mini" },
      ],
    })).toEqual({
      models: [
        { id: "gpt-test", name: "GPT Test" },
        { id: "gpt-mini" },
      ],
    });
    expect(() => parseModelDiscoveryResponse({ models: [{ name: "missing-id" }] })).toThrow("id");
  });

  it("types numeric tpm/rpm while preserving invalid stored values", () => {
    const parsed = parseModelsConfigDocument({
      providers: { acme: { models: [{ id: "demo", tpm: 100, rpm: "bad" }] } },
    });

    expect(parsed.providers?.["acme"]?.models?.[0]?.tpm).toBe(100);
    expect(parsed.providers?.["acme"]?.models?.[0]?.rpm).toBe("bad");
  });

  it("parses the strict limits status sidecar", () => {
    expect(parseModelsConfigLimitsStatusResponse({ contractVersion: 1, revision: 2, admission: "ready", source: "accepted-document" }))
      .toEqual({ contractVersion: 1, revision: 2, admission: "ready", source: "accepted-document" });
    expect(parseModelsConfigLimitsStatusResponse({ contractVersion: 1, revision: 0, admission: "blocked", source: "none", error: "bad" }))
      .toEqual({ contractVersion: 1, revision: 0, admission: "blocked", source: "none", error: "bad" });
    expect(() => parseModelsConfigLimitsStatusResponse({ contractVersion: 1, revision: 0, admission: "ready", source: "none", extra: true })).toThrow("Unexpected");
    expect(() => parseModelsConfigLimitsStatusResponse({ contractVersion: 2, revision: 0, admission: "ready", source: "none" })).toThrow("contract version");
    expect(() => parseModelsConfigLimitsStatusResponse({ contractVersion: 1, revision: 0, admission: "maybe", source: "none" })).toThrow("admission");
    expect(() => parseModelsConfigLimitsStatusResponse({ contractVersion: 1, revision: 0, admission: "ready", source: "nowhere" })).toThrow("source");
  });

  it("parses the additive save response revision", () => {
    expect(parseModelsConfigSaveResponse({ success: true })).toEqual({ success: true });
    expect(parseModelsConfigSaveResponse({ success: true, contractVersion: 1, revision: 4 }))
      .toEqual({ success: true, contractVersion: 1, revision: 4 });
    expect(() => parseModelsConfigSaveResponse({ success: true, contractVersion: 2 })).toThrow("contract version");
  });

  it("preserves compatible custom provider fields while parsing editable model entries", () => {
    expect(parseModelsConfigDocument({
      defaultModel: "custom/demo",
      providers: {
        custom: {
          api: "openai-completions",
          customTransportFlag: true,
          headers: { "x-tenant": "demo" },
          models: [{ id: "demo", reasoning: true, customModelFlag: "retained" }],
        },
      },
    })).toEqual({
      defaultModel: "custom/demo",
      providers: {
        custom: {
          api: "openai-completions",
          customTransportFlag: true,
          headers: { "x-tenant": "demo" },
          models: [{ id: "demo", reasoning: true, customModelFlag: "retained" }],
        },
      },
    });
  });
});
