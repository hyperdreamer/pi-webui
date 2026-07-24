import { describe, expect, it } from "vitest";
import { parseModelDiscoveryResponse, parseModelsConfigDocument } from "./parsers";

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
