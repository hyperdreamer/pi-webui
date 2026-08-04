import { describe, expect, it, vi } from "vitest";
import {
  createUtilityModelResolver,
  runWithUtilityModelFallback,
  type UtilityModelResolver,
} from "./utilityModelResolver.js";

interface FakeModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

const lightweight = fakeModel("acme", "small", "Acme Small");
const context = fakeModel("acme", "large", "Acme Large");
const active = fakeModel("session", "active", "Session Active");

describe("utility model resolver", () => {
  it("resolves lightweight from the current exact catalog entry", async () => {
    const { resolver } = createHarness({
      utilityModels: { lightweight: { provider: "acme", id: "small" } },
    });

    await expect(resolver.configuredCandidates("lightweight")).resolves.toEqual([lightweight]);
  });

  it("resolves context before lightweight", async () => {
    const { resolver } = createHarness({
      utilityModels: {
        lightweight: { provider: "acme", id: "small" },
        context: { provider: "acme", id: "large" },
      },
    });

    await expect(resolver.configuredCandidates("context")).resolves.toEqual([context, lightweight]);
  });

  it("deduplicates repeated provider/id candidates in first-seen order", async () => {
    const { resolver } = createHarness({
      utilityModels: {
        lightweight: { provider: "acme", id: "small" },
        context: { provider: "acme", id: "small" },
      },
    });

    await expect(resolver.configuredCandidates("context")).resolves.toEqual([lightweight]);
  });

  it.each([
    ["absent", {}],
    ["malformed", { utilityModelsError: "utilityModels.lightweight.id is required" }],
    ["stale", { utilityModels: { lightweight: { provider: "acme", id: "retired" } } }],
  ])("returns no candidates for %s configuration", async (_label, config) => {
    const { resolver } = createHarness(config);

    await expect(resolver.configuredCandidates("lightweight")).resolves.toEqual([]);
  });

  it("returns no candidates when config loading or catalog refresh fails", async () => {
    const loadFailure = createHarness({}, { loadConfigError: new Error("config unavailable") });
    const refreshFailure = createHarness(
      { utilityModels: { lightweight: { provider: "acme", id: "small" } } },
      { refreshError: new Error("catalog unavailable") },
    );

    await expect(loadFailure.resolver.configuredCandidates("lightweight")).resolves.toEqual([]);
    await expect(refreshFailure.resolver.configuredCandidates("lightweight")).resolves.toEqual([]);
  });

  it("refreshes without network and observes current settings and catalog on every operation", async () => {
    let config: ResolverConfig = {
      utilityModels: { lightweight: { provider: "acme", id: "small" } },
    };
    let catalog: readonly FakeModel[] = [lightweight];
    const refresh = vi.fn(() => Promise.resolve(undefined));
    const getAvailableSnapshot = vi.fn(() => catalog);
    const loadConfig = vi.fn(() => config);
    const resolver = createUtilityModelResolver({
      loadConfig,
      modelRuntime: { refresh, getAvailableSnapshot },
    });

    await expect(resolver.configuredCandidates("lightweight")).resolves.toEqual([lightweight]);
    config = { utilityModels: { lightweight: { provider: "acme", id: "large" } } };
    catalog = [context];
    await expect(resolver.configuredCandidates("lightweight")).resolves.toEqual([context]);

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenNthCalledWith(1, { allowNetwork: false });
    expect(refresh).toHaveBeenNthCalledWith(2, { allowNetwork: false });
    expect(loadConfig).toHaveBeenCalledTimes(2);
    expect(getAvailableSnapshot).toHaveBeenCalledTimes(2);
  });
});

describe("utility model fallback runner", () => {
  it("continues after throws and undefined results, then returns the active-model result", async () => {
    const configured = [Object.freeze({ ...lightweight }), Object.freeze({ ...context })];
    const frozenActive = Object.freeze({ ...active });
    const resolver: UtilityModelResolver<FakeModel> = {
      configuredCandidates: vi.fn(() => Promise.resolve(configured)),
    };
    const failure = new Error("lightweight failed");
    const run = vi.fn((model: FakeModel): Promise<string | undefined> => {
      if (model.id === "small") return Promise.reject(failure);
      if (model.id === "large") return Promise.resolve(undefined);
      return Promise.resolve("active result");
    });
    const onFailure = vi.fn();

    await expect(
      runWithUtilityModelFallback(resolver, "context", frozenActive, run, onFailure),
    ).resolves.toBe("active result");

    expect(run.mock.calls.map(([model]) => `${model.provider}/${model.id}`)).toEqual([
      "acme/small",
      "acme/large",
      "session/active",
    ]);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith(configured[0], failure);
    expect(configured).toEqual([lightweight, context]);
    expect(frozenActive).toEqual(active);
  });

  it("does not retry the active model when its provider/id is already configured", async () => {
    const configured = Object.freeze({ ...lightweight });
    const duplicateActive = Object.freeze({ ...lightweight, name: "Active alias" });
    const resolver: UtilityModelResolver<FakeModel> = {
      configuredCandidates: vi.fn(() => Promise.resolve([configured])),
    };
    const run = vi.fn(() => Promise.resolve(undefined));

    await expect(
      runWithUtilityModelFallback(resolver, "lightweight", duplicateActive, run),
    ).resolves.toBeUndefined();

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(configured);
    expect(duplicateActive).toEqual({ ...lightweight, name: "Active alias" });
  });
});

interface ResolverConfig {
  utilityModels?: {
    lightweight?: { provider: string; id: string };
    context?: { provider: string; id: string };
  };
  utilityModelsError?: string;
}

function createHarness(
  config: ResolverConfig,
  options: { loadConfigError?: Error; refreshError?: Error } = {},
) {
  const refresh = vi.fn(() => {
    if (options.refreshError !== undefined) return Promise.reject(options.refreshError);
    return Promise.resolve(undefined);
  });
  const getAvailableSnapshot = vi.fn(() => [lightweight, context]);
  const loadConfig = vi.fn(() => {
    if (options.loadConfigError !== undefined) throw options.loadConfigError;
    return config;
  });
  return {
    resolver: createUtilityModelResolver({
      loadConfig,
      modelRuntime: { refresh, getAvailableSnapshot },
    }),
    refresh,
    getAvailableSnapshot,
    loadConfig,
  };
}

function fakeModel(provider: string, id: string, name: string): FakeModel {
  return {
    provider,
    id,
    name,
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}
