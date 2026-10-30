import type { UtilityModelSettings } from "../../shared/apiTypes.js";
import { UTILITY_MODEL_SESSION_ONLY } from "../../shared/apiTypes.js";
import { describe, expect, it, vi } from "vitest";
import {
  createUtilityModelResolver,
  runWithUtilityModelFallback,
  type UtilityModelAttempt,
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
const supportedThinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

describe("utility model resolver", () => {
  it("resolves an omitted utility thinking intent to minimal when supported", async () => {
    const { resolver } = createHarness({
      utilityModels: { lightweight: { provider: "acme", id: "small" } },
    });

    await expect(resolver.configuredCandidates("lightweight")).resolves.toEqual([
      { model: lightweight, thinkingLevel: "minimal", slot: "lightweight" },
    ]);
  });

  it("resolves an omitted utility thinking intent to off without minimal support", async () => {
    const { resolver } = createHarness(
      { utilityModels: { lightweight: { provider: "acme", id: "small" } } },
      { thinkingLevelsForModel: () => ["off"] },
    );

    await expect(resolver.configuredCandidates("lightweight")).resolves.toEqual([
      { model: lightweight, thinkingLevel: "off", slot: "lightweight" },
    ]);
  });

  it("passes explicit xhigh and max levels through to their configured slots", async () => {
    const { resolver } = createHarness({
      utilityModels: {
        lightweight: {
          provider: "acme",
          id: "small",
          thinkingLevel: "xhigh",
        },
        context: {
          provider: "acme",
          id: "large",
          thinkingLevel: "max",
        },
      },
    });

    await expect(resolver.configuredCandidates("context")).resolves.toEqual([
      { model: context, thinkingLevel: "max", slot: "context" },
      { model: lightweight, thinkingLevel: "xhigh", slot: "lightweight" },
    ]);
  });

  it("skips only a context slot whose explicit level is no longer supported", async () => {
    const { resolver } = createHarness(
      {
        utilityModels: {
          lightweight: {
            provider: "acme",
            id: "small",
            thinkingLevel: "low",
          },
          context: {
            provider: "acme",
            id: "large",
            thinkingLevel: "max",
          },
        },
      },
      {
        thinkingLevelsForModel: (model) =>
          model?.id === "large" ? ["off", "minimal"] : ["off", "low"],
      },
    );

    await expect(resolver.configuredCandidates("context")).resolves.toEqual([
      { model: lightweight, thinkingLevel: "low", slot: "lightweight" },
    ]);
  });

  it("deduplicates same-model candidates with the same effective level in first-seen order", async () => {
    const { resolver } = createHarness({
      utilityModels: {
        lightweight: {
          provider: "acme",
          id: "small",
          thinkingLevel: "minimal",
        },
        context: { provider: "acme", id: "small" },
      },
    });

    await expect(resolver.configuredCandidates("context")).resolves.toEqual([
      { model: lightweight, thinkingLevel: "minimal", slot: "context" },
    ]);
  });

  it("keeps same-model candidates with distinct effective levels in slot order", async () => {
    const { resolver } = createHarness({
      utilityModels: {
        lightweight: {
          provider: "acme",
          id: "small",
          thinkingLevel: "low",
        },
        context: {
          provider: "acme",
          id: "small",
          thinkingLevel: "max",
        },
      },
    });

    await expect(resolver.configuredCandidates("context")).resolves.toEqual([
      { model: lightweight, thinkingLevel: "max", slot: "context" },
      { model: lightweight, thinkingLevel: "low", slot: "lightweight" },
    ]);
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
      thinkingLevelsForModel: () => supportedThinkingLevels,
    });

    await expect(resolver.configuredCandidates("lightweight")).resolves.toEqual([
      { model: lightweight, thinkingLevel: "minimal", slot: "lightweight" },
    ]);
    config = { utilityModels: { lightweight: { provider: "acme", id: "large" } } };
    catalog = [context];
    await expect(resolver.configuredCandidates("lightweight")).resolves.toEqual([
      { model: context, thinkingLevel: "minimal", slot: "lightweight" },
    ]);

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenNthCalledWith(1, { allowNetwork: false });
    expect(refresh).toHaveBeenNthCalledWith(2, { allowNetwork: false });
    expect(loadConfig).toHaveBeenCalledTimes(2);
    expect(getAvailableSnapshot).toHaveBeenCalledTimes(2);
  });

  describe("inspect", () => {
    it("reports candidates identically to configuredCandidates", async () => {
      const { resolver } = createHarness({
        utilityModels: { lightweight: { provider: "acme", id: "small" } },
      });

      const inspection = await resolver.inspect("lightweight");
      expect(inspection.candidates).toEqual(
        await resolver.configuredCandidates("lightweight"),
      );
    });

    it("reports an unset slot", async () => {
      const empty = createHarness({});
      const emptyModels = createHarness({ utilityModels: {} });

      await expect(empty.resolver.inspect("lightweight")).resolves.toEqual({
        candidates: [],
        sessionModelOnly: false,
        unavailable: { reason: "slot-unset" },
      });
      await expect(emptyModels.resolver.inspect("lightweight")).resolves.toEqual({
        candidates: [],
        sessionModelOnly: false,
        unavailable: { reason: "slot-unset" },
      });
    });

    it("reports an invalid utility configuration with its detail", async () => {
      const { resolver } = createHarness({
        utilityModelsError: "utilityModels.lightweight.id is required",
      });

      await expect(resolver.inspect("lightweight")).resolves.toEqual({
        candidates: [],
        sessionModelOnly: false,
        unavailable: {
          reason: "config-invalid",
          detail: "utilityModels.lightweight.id is required",
        },
      });
    });

    it("reports a configured model missing from the catalog", async () => {
      const { resolver } = createHarness({
        utilityModels: { lightweight: { provider: "acme", id: "retired" } },
      });

      await expect(resolver.inspect("lightweight")).resolves.toEqual({
        candidates: [],
        sessionModelOnly: false,
        unavailable: { reason: "model-unavailable", detail: "acme/retired" },
      });
    });

    it("reports an explicitly configured level the model does not support", async () => {
      const { resolver } = createHarness(
        {
          utilityModels: {
            lightweight: { provider: "acme", id: "small", thinkingLevel: "max" },
          },
        },
        { thinkingLevelsForModel: () => ["off", "minimal"] },
      );

      await expect(resolver.inspect("lightweight")).resolves.toEqual({
        candidates: [],
        sessionModelOnly: false,
        unavailable: { reason: "thinking-level-unsupported", detail: "max" },
      });
    });

    it("reports a resolution failure and logs it without throwing", async () => {
      const error = new Error("catalog unavailable");
      const logger = { info: vi.fn() };
      const resolver = createUtilityModelResolver({
        loadConfig: () => ({
          utilityModels: { lightweight: { provider: "acme", id: "small" } },
        }),
        modelRuntime: {
          refresh: () => Promise.reject(error),
          getAvailableSnapshot: () => [lightweight],
        },
        thinkingLevelsForModel: () => supportedThinkingLevels,
        logger,
      });

      await expect(resolver.inspect("lightweight")).resolves.toEqual({
        candidates: [],
        sessionModelOnly: false,
        unavailable: { reason: "resolution-failed", detail: "catalog unavailable" },
      });
      expect(logger.info).toHaveBeenCalledWith(
        { err: error, task: "lightweight" },
        "utility model resolution failed",
      );
    });

    it("reports a config load failure as resolution-failed", async () => {
      const { resolver } = createHarness(
        {},
        { loadConfigError: new Error("config unavailable") },
      );

      await expect(resolver.inspect("lightweight")).resolves.toEqual({
        candidates: [],
        sessionModelOnly: false,
        unavailable: { reason: "resolution-failed", detail: "config unavailable" },
      });
    });

    it("returns the session-only inspection for Context", async () => {
      const { resolver } = createHarness({
        utilityModels: { context: UTILITY_MODEL_SESSION_ONLY },
      });

      const inspection = await resolver.inspect("context");

      expect(inspection).toEqual({ candidates: [], sessionModelOnly: true });
      expect(Object.hasOwn(inspection, "unavailable")).toBe(false);
      await expect(resolver.configuredCandidates("context")).resolves.toEqual([]);
    });

    it("keeps Lightweight resolution under a session-only Context", async () => {
      const { resolver } = createHarness({
        utilityModels: {
          lightweight: { provider: "acme", id: "small" },
          context: UTILITY_MODEL_SESSION_ONLY,
        },
      });

      await expect(resolver.inspect("lightweight")).resolves.toEqual({
        candidates: [
          { model: lightweight, thinkingLevel: "minimal", slot: "lightweight" },
        ],
        sessionModelOnly: false,
      });
    });

    it("never reports session-only for the inherited or fixed states", async () => {
      const states = [
        createHarness({}),
        createHarness({ utilityModels: {} }),
        createHarness({
          utilityModels: { context: { provider: "acme", id: "large" } },
        }),
      ];

      for (const { resolver } of states) {
        expect((await resolver.inspect("lightweight")).sessionModelOnly).toBe(false);
        expect((await resolver.inspect("context")).sessionModelOnly).toBe(false);
      }
    });

    it("keeps configuration-error precedence over the sentinel", async () => {
      const { resolver } = createHarness({
        utilityModelsError: "utilityModels.lightweight.id is required",
        utilityModels: { context: UTILITY_MODEL_SESSION_ONLY },
      });

      await expect(resolver.inspect("context")).resolves.toEqual({
        candidates: [],
        sessionModelOnly: false,
        unavailable: {
          reason: "config-invalid",
          detail: "utilityModels.lightweight.id is required",
        },
      });
    });

    it("treats the sentinel as a resolved state, not a slot failure", async () => {
      const { resolver } = createHarness({
        utilityModels: {
          lightweight: { provider: "acme", id: "small" },
          context: UTILITY_MODEL_SESSION_ONLY,
        },
      });

      const inspection = await resolver.inspect("context");

      expect(inspection).toEqual({ candidates: [], sessionModelOnly: true });
      expect(Object.hasOwn(inspection, "unavailable")).toBe(false);
      expect(inspection.candidates).toEqual([]);
    });

    it("omits unavailable when a candidate resolves", async () => {
      const { resolver } = createHarness({
        utilityModels: { lightweight: { provider: "acme", id: "small" } },
      });

      const inspection = await resolver.inspect("lightweight");
      expect(inspection.candidates).toHaveLength(1);
      expect(Object.hasOwn(inspection, "unavailable")).toBe(false);
    });
  });
});

describe("utility model fallback runner", () => {
  it("keeps same-model attempts with different levels and advances after failures", async () => {
    const configuredOff = Object.freeze({
      model: Object.freeze({ ...lightweight }),
      thinkingLevel: "off" as const,
      slot: "context" as const,
    });
    const configuredXhigh = Object.freeze({
      model: Object.freeze({ ...context }),
      thinkingLevel: "xhigh" as const,
      slot: "lightweight" as const,
    });
    const configured = Object.freeze([configuredOff, configuredXhigh]);
    const activeAttempt = Object.freeze({
      model: Object.freeze({ ...lightweight, name: "Active alias" }),
      thinkingLevel: "minimal" as const,
    });
    const resolver: UtilityModelResolver<FakeModel> = {
      inspect: vi.fn(() => Promise.resolve({ candidates: configured, sessionModelOnly: false })),
      configuredCandidates: vi.fn(() => Promise.resolve(configured)),
    };
    const failure = new Error("off attempt failed");
    const run = vi.fn((attempt: UtilityModelAttempt<FakeModel>): Promise<string | undefined> => {
      if (attempt.thinkingLevel === "off") return Promise.reject(failure);
      if (attempt.thinkingLevel === "xhigh") return Promise.resolve(undefined);
      return Promise.resolve("active result");
    });
    const onFailure = vi.fn();

    await expect(
      runWithUtilityModelFallback(
        resolver,
        "context",
        activeAttempt,
        run,
        onFailure,
      ),
    ).resolves.toBe("active result");

    expect(run.mock.calls.map(([attempt]) => [
      attempt.model.provider,
      attempt.model.id,
      attempt.thinkingLevel,
    ])).toEqual([
      ["acme", "small", "off"],
      ["acme", "large", "xhigh"],
      ["acme", "small", "minimal"],
    ]);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith(configuredOff, failure);
    expect(configuredOff).toEqual({
      model: lightweight,
      thinkingLevel: "off",
      slot: "context",
    });
    expect(activeAttempt).toEqual({
      model: { ...lightweight, name: "Active alias" },
      thinkingLevel: "minimal",
    });
  });

  it("deduplicates an active attempt with the configured model and level", async () => {
    const configured = Object.freeze({
      model: Object.freeze({ ...lightweight }),
      thinkingLevel: "minimal" as const,
      slot: "lightweight" as const,
    });
    const activeAttempt = Object.freeze({
      model: Object.freeze({ ...lightweight, name: "Active alias" }),
      thinkingLevel: "minimal" as const,
    });
    const resolver: UtilityModelResolver<FakeModel> = {
      inspect: vi.fn(() => Promise.resolve({ candidates: [configured], sessionModelOnly: false })),
      configuredCandidates: vi.fn(() => Promise.resolve([configured])),
    };
    const run = vi.fn(() => Promise.resolve(undefined));

    await expect(
      runWithUtilityModelFallback(resolver, "lightweight", activeAttempt, run),
    ).resolves.toBeUndefined();

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(configured);
    expect(activeAttempt).toEqual({
      model: { ...lightweight, name: "Active alias" },
      thinkingLevel: "minimal",
    });
  });

  it("normalizes every candidate before identity and execution", async () => {
    const configured = Object.freeze({
      model: Object.freeze({ ...lightweight }), thinkingLevel: "high" as const,
      slot: "lightweight" as const,
    });
    const active = Object.freeze({
      model: Object.freeze({ ...lightweight, name: "Active alias" }), thinkingLevel: "minimal" as const,
    });
    const candidates = Object.freeze([configured]);
    const resolver: UtilityModelResolver<FakeModel> = {
      inspect: vi.fn(() => Promise.resolve({ candidates, sessionModelOnly: false })),
      configuredCandidates: vi.fn(() => Promise.resolve(candidates)),
    };
    const normalizeAttempt = vi.fn((attempt: UtilityModelAttempt<FakeModel>): UtilityModelAttempt<FakeModel> => ({
      ...attempt, thinkingLevel: "off",
    }));
    const run = vi.fn<(attempt: UtilityModelAttempt<FakeModel>) => string | undefined>(() => undefined);
    await expect(runWithUtilityModelFallback(
      resolver, "lightweight", active, run, undefined, normalizeAttempt,
    )).resolves.toBeUndefined();

    // eslint-disable-next-line @typescript-eslint/unbound-method -- assertion target is the resolver's own mock, never invoked via `this`.
    expect(resolver.configuredCandidates).toHaveBeenCalledExactlyOnceWith("lightweight");
    expect(normalizeAttempt).toHaveBeenCalledTimes(2);
    expect(normalizeAttempt.mock.calls[0]?.[0]).toBe(configured);
    expect(normalizeAttempt.mock.calls[1]?.[0]).toBe(active);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toBe(normalizeAttempt.mock.results[0]?.value);
    expect(run.mock.calls[0]?.[0]).not.toBe(configured);
    expect(run.mock.calls[0]?.[0].model).toBe(configured.model);
    expect(run.mock.calls[0]?.[0].thinkingLevel).toBe("off");
    expect(configured).toEqual({ model: lightweight, thinkingLevel: "high", slot: "lightweight" });
    expect(active).toEqual({ model: { ...lightweight, name: "Active alias" }, thinkingLevel: "minimal" });
  });

  it("passes normalized attempts to exception diagnostics and preserves distinct identities", async () => {
    const first = Object.freeze({ model: Object.freeze({ ...lightweight }), thinkingLevel: "high" as const, slot: "lightweight" as const });
    const otherProvider = Object.freeze({ model: Object.freeze({ ...lightweight, provider: "other" }), thinkingLevel: "low" as const, slot: "context" as const });
    const active = Object.freeze({ model: Object.freeze({ ...context }), thinkingLevel: "minimal" as const });
    const candidates = Object.freeze([first, otherProvider]);
    const resolver: UtilityModelResolver<FakeModel> = {
      inspect: vi.fn(() => Promise.resolve({ candidates, sessionModelOnly: false })),
      configuredCandidates: vi.fn(() => Promise.resolve(candidates)),
    };
    const normalizeAttempt = vi.fn((attempt: UtilityModelAttempt<FakeModel>): UtilityModelAttempt<FakeModel> => ({
      ...attempt, thinkingLevel: "off",
    }));
    const failure = new Error("normalized attempt failed");
    const run = vi.fn<(attempt: UtilityModelAttempt<FakeModel>) => string | undefined>()
      .mockImplementationOnce(() => { throw failure; })
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce("active result");
    const onFailure = vi.fn();

    await expect(runWithUtilityModelFallback(
      resolver, "context", active, run, onFailure, normalizeAttempt,
    )).resolves.toBe("active result");
    expect(normalizeAttempt).toHaveBeenCalledTimes(3);
    expect(run.mock.calls.map(([attempt]) => [attempt.model.provider, attempt.model.id, attempt.thinkingLevel]))
      .toEqual([["acme", "small", "off"], ["other", "small", "off"], ["acme", "large", "off"]]);
    expect(run.mock.calls[0]?.[0].model).toBe(first.model);
    expect(run.mock.calls[1]?.[0].model).toBe(otherProvider.model);
    expect(run.mock.calls[2]?.[0].model).toBe(active.model);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith(run.mock.calls[0]?.[0], failure);
    expect(onFailure.mock.calls[0]?.[0]).toBe(run.mock.calls[0]?.[0]);
    expect(first.thinkingLevel).toBe("high");
    expect(otherProvider.thinkingLevel).toBe("low");
    expect(active.thinkingLevel).toBe("minimal");
  });
});

interface ResolverConfig {
  utilityModels?: UtilityModelSettings;
  utilityModelsError?: string;
}

function createHarness(
  config: ResolverConfig,
  options: {
    loadConfigError?: Error;
    refreshError?: Error;
    thinkingLevelsForModel?: (model: FakeModel | undefined) => readonly string[];
  } = {},
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
      thinkingLevelsForModel:
        options.thinkingLevelsForModel ?? (() => supportedThinkingLevels),
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
