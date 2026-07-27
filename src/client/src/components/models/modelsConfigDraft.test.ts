import { describe, expect, it } from "vitest";
import type { ModelsConfigDocument } from "../../api";
import {
  MODEL_API_OPTIONS,
  addCustomProvider,
  addModel,
  modelApiOptionStates,
  modelIdOptionStates,
  removeModel,
  renameProvider,
  setThinkingLevelMapEntry,
  updateModel,
} from "./modelsConfigDraft";

describe("modelsConfigDraft", () => {
  it("adds a uniquely named OpenAI-compatible custom provider without dropping other config", () => {
    const source: ModelsConfigDocument = {
      defaultModel: "anthropic/claude-sonnet",
      providers: {
        "new-provider": { api: "anthropic-messages" },
      },
    };

    const result = addCustomProvider(source);

    expect(result.providerName).toBe("new-provider-1");
    expect(result.config).toEqual({
      defaultModel: "anthropic/claude-sonnet",
      providers: {
        "new-provider": { api: "anthropic-messages" },
        "new-provider-1": { api: "openai-completions" },
      },
    });
  });

  it("marks the configured API format for option-level selection", () => {
    expect(modelApiOptionStates("anthropic-messages")).toEqual([
      { api: "openai-completions", selected: false },
      { api: "openai-responses", selected: false },
      { api: "anthropic-messages", selected: true },
      { api: "google-generative-ai", selected: false },
    ]);
    expect(modelApiOptionStates(undefined)).toEqual(MODEL_API_OPTIONS.map((api) => ({ api, selected: false })));
  });

  it("marks the configured fetched model ID for option-level selection", () => {
    const candidates = [
      { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
      { id: "claude-opus-5", name: "Claude Opus 5" },
    ];

    expect(modelIdOptionStates(candidates, "claude-opus-5")).toEqual([
      { candidate: candidates[0], selected: false },
      { candidate: candidates[1], selected: true },
    ]);
  });

  it("refuses a provider rename that would overwrite a different provider", () => {
    const source: ModelsConfigDocument = {
      providers: {
        local: { api: "openai-completions" },
        production: { api: "anthropic-messages" },
      },
    };

    expect(renameProvider(source, "local", "production")).toEqual({
      config: source,
      error: 'A provider named "production" already exists.',
    });
  });

  it("updates custom models without losing provider fields and removes an empty model list", () => {
    const source: ModelsConfigDocument = {
      providers: {
        custom: {
          baseUrl: "https://models.example.test/v1",
          headers: { "x-tenant": "demo" },
          models: [{ id: "first" }],
        },
      },
    };

    const withNewModel = addModel(source, "custom");
    const withEditedModel = updateModel(withNewModel, "custom", 1, { id: "second", reasoning: true });
    const afterFirstRemoval = removeModel(withEditedModel, "custom", 0);
    const result = removeModel(afterFirstRemoval, "custom", 0);

    expect(withEditedModel.providers?.["custom"]).toEqual({
      baseUrl: "https://models.example.test/v1",
      headers: { "x-tenant": "demo" },
      models: [{ id: "first" }, { id: "second", reasoning: true }],
    });
    expect(result.providers?.["custom"]).toEqual({
      baseUrl: "https://models.example.test/v1",
      headers: { "x-tenant": "demo" },
    });
  });

  it("edits thinking levels with distinct default, disabled, and custom states", () => {
    const existing = { low: "budget", high: null };

    expect(setThinkingLevelMapEntry(existing, "low", "default")).toEqual({ high: null });
    expect(setThinkingLevelMapEntry(existing, "medium", "disabled")).toEqual({ low: "budget", high: null, medium: null });
    expect(setThinkingLevelMapEntry(existing, "max", "custom", "maximum")).toEqual({ low: "budget", high: null, max: "maximum" });
    expect(setThinkingLevelMapEntry(undefined, "off", "default")).toBeUndefined();
  });
});
