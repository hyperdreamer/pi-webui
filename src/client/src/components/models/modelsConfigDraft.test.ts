import { describe, expect, it } from "vitest";
import { parseModelsConfigDocument } from "../../api/parsers";
import type { ModelsConfigDocument } from "../../api";
import {
  MODEL_API_OPTIONS,
  addCustomProvider,
  addModel,
  applyRateLimitDraftField,
  firstInvalidRateLimitDraft,
  modelApiOptionStates,
  modelIdOptionStates,
  modelRateLimitDraftsFromDocument,
  rateLimitDraftKey,
  reconcileRateLimitDrafts,
  removeModel,
  renameProvider,
  setModelRateLimitField,
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

  it("encodes draft keys without separator collisions", () => {
    expect(rateLimitDraftKey("a/b", "c", 0)).toBe('["model-rate-limit-draft","a/b","c",0]');
    expect(rateLimitDraftKey("a", "b/c", 0)).not.toBe(rateLimitDraftKey("a/b", "c", 0));
  });

  it("derives drafts from valid and invalid stored values", () => {
    const drafts = modelRateLimitDraftsFromDocument(parseModelsConfigDocument({
      providers: { acme: { models: [
        { id: "valid", tpm: 100, prm: 0 },
        { id: "invalid", tpm: "bad" },
      ] } },
    }));

    expect(drafts[rateLimitDraftKey("acme", "valid", 0)]).toEqual({ tpm: { text: "100" }, prm: { text: "0" } });
    expect(drafts[rateLimitDraftKey("acme", "invalid", 0)]).toEqual({
      tpm: { text: "", loadedInvalidValue: "bad", error: "Tokens per minute must be a whole number." },
      prm: { text: "" },
    });
  });

  it("applies valid, invalid, and blank draft text without trimming the stored text", () => {
    const initial = { tpm: { text: "10" }, prm: { text: "" } };

    expect(applyRateLimitDraftField(initial, "tpm", " 250 ")).toEqual({ tpm: { text: " 250 " }, prm: { text: "" } });
    expect(applyRateLimitDraftField(initial, "tpm", "1e3")).toEqual({
      tpm: { text: "1e3", error: "Tokens per minute must be a whole number." },
      prm: { text: "" },
    });
    expect(applyRateLimitDraftField(initial, "prm", "0")).toEqual({ tpm: { text: "10" }, prm: { text: "0" } });
    expect(applyRateLimitDraftField(initial, "tpm", "")).toEqual({ tpm: { text: "" }, prm: { text: "" } });
  });

  it("sets and deletes numeric fields without touching other members", () => {
    const model = { id: "demo", name: "Demo", tpm: 5 };

    expect(setModelRateLimitField(model, "tpm", 250)).toEqual({ id: "demo", name: "Demo", tpm: 250 });
    expect(setModelRateLimitField(model, "tpm", undefined)).toEqual({ id: "demo", name: "Demo" });
    expect(setModelRateLimitField(model, "prm", 0)).toEqual({ id: "demo", name: "Demo", tpm: 5, prm: 0 });
  });

  it("reconciles rename and add without orphaning drafts", () => {
    const previous = { providers: { acme: { models: [{ id: "a", tpm: 1 }, { id: "b", prm: 2 }] } } };
    const drafts = modelRateLimitDraftsFromDocument(previous);
    const bKey = rateLimitDraftKey("acme", "b", 0);
    const bDraft = drafts[bKey];
    if (bDraft === undefined) throw new Error("Expected draft for b");
    drafts[bKey] = applyRateLimitDraftField(bDraft, "prm", "bad");

    const renamedDocument = { providers: { acme: { models: [{ id: "a", tpm: 1 }, { id: "renamed", prm: 2 }] } } };
    const afterRename = reconcileRateLimitDrafts(drafts, previous, renamedDocument, { type: "rename", providerName: "acme", from: "b", to: "renamed" });

    expect(afterRename[rateLimitDraftKey("acme", "renamed", 0)]?.prm.error).toBeDefined();
    expect(afterRename[bKey]).toBeUndefined();

    const addedDocument = { providers: { acme: { models: [{ id: "a", tpm: 1 }, { id: "renamed", prm: 2 }, { id: "new" }] } } };
    const afterAdd = reconcileRateLimitDrafts(afterRename, renamedDocument, addedDocument);

    expect(afterAdd[rateLimitDraftKey("acme", "new", 0)]).toEqual({ tpm: { text: "" }, prm: { text: "" } });
    expect(afterAdd[rateLimitDraftKey("acme", "a", 0)]).toEqual({ tpm: { text: "1" }, prm: { text: "" } });
  });

  it("shifts drafts for later occurrences of a deleted duplicate", () => {
    const previous = { providers: { acme: { models: [{ id: "demo", tpm: 1 }, { id: "demo", tpm: 2 }] } } };
    const drafts = modelRateLimitDraftsFromDocument(previous);
    drafts[rateLimitDraftKey("acme", "demo", 1)] = { tpm: { text: "bad", error: "Tokens per minute must be a whole number." }, prm: { text: "" } };
    const next = { providers: { acme: { models: [{ id: "demo", tpm: 2 }] } } };

    const afterDelete = reconcileRateLimitDrafts(drafts, previous, next, { type: "delete", providerName: "acme", modelId: "demo", occurrence: 0 });

    expect(afterDelete[rateLimitDraftKey("acme", "demo", 0)]?.tpm.error).toBe("Tokens per minute must be a whole number.");
    expect(afterDelete[rateLimitDraftKey("acme", "demo", 1)]).toBeUndefined();
  });

  it("returns the first invalid draft with its identity", () => {
    const drafts = modelRateLimitDraftsFromDocument(parseModelsConfigDocument({
      providers: { acme: { models: [{ id: "demo", tpm: "bad" }, { id: "second", prm: "worse" }] } },
    }));

    expect(firstInvalidRateLimitDraft(drafts)).toMatchObject({
      key: rateLimitDraftKey("acme", "demo", 0),
      providerName: "acme",
      modelId: "demo",
      field: "tpm",
      message: "Tokens per minute must be a whole number.",
    });
    expect(firstInvalidRateLimitDraft({})).toBeUndefined();
  });
});
