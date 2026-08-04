import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AuthResult,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  type BranchSummaryResult,
  type CompactionResult,
  type SessionBeforeCompactEvent,
  type SessionBeforeTreeEvent,
  type compact as PiCompact,
  type generateBranchSummary as PiGenerateBranchSummary,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  createUtilityModelExtension,
  createUtilityModelHandlers,
  type UtilityModelExtensionRuntimeRefs,
  type UtilityModelHandlerContext,
} from "./utilityModelExtension.js";
import type { UtilityModelResolver } from "./utilityModelResolver.js";

const lightweightModel = fakeModel("acme", "small", true);
const contextModel = fakeModel("acme", "large", true);
const activeModel = fakeModel("session", "active", true);
const usage = fakeUsage();
const compactionResult: CompactionResult = {
  summary: "compacted",
  firstKeptEntryId: "entry-kept",
  tokensBefore: 12_000,
  usage,
};

type GenerateBranchSummaryFn = typeof PiGenerateBranchSummary;
type CompactFn = typeof PiCompact;

describe("utility model branch summary handler", () => {
  it("uses only lightweight and returns Pi's summary details and usage", async () => {
    const signal = new AbortController().signal;
    const retry = { enabled: true, maxRetries: 4, baseDelayMs: 25 };
    const streamResult = createAssistantMessageEventStream();
    const streamFunction = vi.fn<StreamFn>(() => streamResult);
    const generateBranchSummary = vi.fn<GenerateBranchSummaryFn>(() => Promise.resolve({
      summary: "branch summary",
      readFiles: ["src/read.ts"],
      modifiedFiles: ["src/changed.ts"],
      usage,
    }));
    const resolver = resolverFor({ lightweight: [lightweightModel] });
    const getAuth = vi.fn((): Promise<AuthResult> => Promise.resolve({
      auth: {
        apiKey: "secret",
        headers: { "x-keep": "present", "x-remove": null },
      },
      env: { ACME_REGION: "test-region" },
    }));
    const refs = runtimeRefs(streamFunction, retry, 2_048);
    let modelReads = 0;
    const handlers = createUtilityModelHandlers({
      resolver,
      modelRuntime: { getAuth },
      refs,
      generateBranchSummary,
      compact: successfulCompact(),
      runtimeThinkingLevels: () => ["off", "minimal"],
    });

    await expect(
      handlers.sessionBeforeTree(
        treeEvent({ signal, customInstructions: "Focus on auth", replaceInstructions: true }),
        contextWithModel(activeModel, () => { modelReads += 1; }),
      ),
    ).resolves.toEqual({
      summary: {
        summary: "branch summary",
        details: {
          readFiles: ["src/read.ts"],
          modifiedFiles: ["src/changed.ts"],
        },
        usage,
      },
    });

    expect(modelReads).toBeGreaterThan(0);
    expect(resolver.configuredCandidates).toHaveBeenCalledOnce();
    expect(resolver.configuredCandidates).toHaveBeenCalledWith("lightweight");
    expect(generateBranchSummary).toHaveBeenCalledOnce();
    expect(generateBranchSummary.mock.calls[0]?.[0]).toEqual(branchEntries());
    const options = generateBranchSummary.mock.calls[0]?.[1];
    expect(options).toMatchObject({
      model: lightweightModel,
      apiKey: "secret",
      headers: { "x-keep": "present" },
      env: { ACME_REGION: "test-region" },
      signal,
      customInstructions: "Focus on auth",
      replaceInstructions: true,
      reserveTokens: 2_048,
      retry,
    });
    expect(options?.headers).not.toHaveProperty("x-remove");
    expect(options?.streamFn).toBeDefined();

    const streamContext: Context = { messages: [] };
    const streamOptions: SimpleStreamOptions = { maxTokens: 128 };
    expect(
      await options?.streamFn?.(lightweightModel, streamContext, streamOptions),
    ).toBe(streamResult);
    expect(streamFunction).toHaveBeenCalledWith(lightweightModel, streamContext, {
      maxTokens: 128,
      reasoning: "minimal",
    });
  });

  it("short-circuits when a summary was not requested or there are no entries", async () => {
    const resolver = resolverFor({ lightweight: [lightweightModel] });
    const generateBranchSummary = vi.fn<GenerateBranchSummaryFn>();
    const handlers = createHandlers({ resolver, generateBranchSummary });

    await expect(
      handlers.sessionBeforeTree(
        treeEvent({ userWantsSummary: false }),
        contextWithModel(activeModel),
      ),
    ).resolves.toBeUndefined();
    await expect(
      handlers.sessionBeforeTree(
        treeEvent({ entriesToSummarize: [] }),
        contextWithModel(activeModel),
      ),
    ).resolves.toBeUndefined();

    expect(resolver.configuredCandidates).not.toHaveBeenCalled();
    expect(generateBranchSummary).not.toHaveBeenCalled();
  });

  it("returns undefined when no utility model is configured or runtime refs are missing", async () => {
    const noCandidates = resolverFor({ lightweight: [] });
    const missingRefs = resolverFor({ lightweight: [lightweightModel] });
    const generateBranchSummary = vi.fn<GenerateBranchSummaryFn>();
    const withoutCandidates = createHandlers({
      resolver: noCandidates,
      generateBranchSummary,
    });
    const withoutRefs = createHandlers({
      resolver: missingRefs,
      generateBranchSummary,
      refs: {},
    });

    await expect(
      withoutCandidates.sessionBeforeTree(treeEvent(), contextWithModel(activeModel)),
    ).resolves.toBeUndefined();
    await expect(
      withoutRefs.sessionBeforeTree(treeEvent(), contextWithModel(activeModel)),
    ).resolves.toBeUndefined();

    expect(generateBranchSummary).not.toHaveBeenCalled();
  });

  it("returns undefined for thrown, errored, or missing lightweight summaries", async () => {
    const attempts: (() => Promise<BranchSummaryResult>)[] = [
      () => Promise.reject(new Error("provider failed")),
      () => Promise.resolve({ error: "summary failed" }),
      () => Promise.resolve({}),
    ];

    for (const attempt of attempts) {
      const generateBranchSummary = vi.fn<GenerateBranchSummaryFn>(attempt);
      const handlers = createHandlers({ generateBranchSummary });
      await expect(
        handlers.sessionBeforeTree(treeEvent(), contextWithModel(activeModel)),
      ).resolves.toBeUndefined();
    }
  });
});

describe("utility model compaction handler", () => {
  it("tries context then lightweight and passes Pi compaction inputs", async () => {
    const controller = new AbortController();
    const retry = { enabled: true, maxRetries: 2, baseDelayMs: 10 };
    const streamResult = createAssistantMessageEventStream();
    const streamFunction = vi.fn<StreamFn>(() => streamResult);
    const compact = vi.fn<CompactFn>((_preparation, model) => (
      model.id === "large"
        ? Promise.reject(new Error("context failed"))
        : Promise.resolve(compactionResult)
    ));
    const resolver = resolverFor({ context: [contextModel, lightweightModel] });
    const getAuth = vi.fn((model: Model<Api>): Promise<AuthResult> => Promise.resolve({
      auth: {
        apiKey: `${model.id}-key`,
        headers: { "x-model": model.id, "x-delete": null },
      },
      env: { ACME_MODEL: model.id },
    }));
    const handlers = createUtilityModelHandlers({
      resolver,
      modelRuntime: { getAuth },
      refs: runtimeRefs(streamFunction, retry, 4_096),
      generateBranchSummary: successfulBranchSummary(),
      compact,
      runtimeThinkingLevels: (model) => model.id === "large" ? ["off", "minimal"] : ["off"],
    });
    const event = compactEvent({
      signal: controller.signal,
      customInstructions: "Retain decisions",
    });

    await expect(
      handlers.sessionBeforeCompact(event, contextWithModel(activeModel)),
    ).resolves.toEqual({ compaction: compactionResult });

    expect(resolver.configuredCandidates).toHaveBeenCalledWith("context");
    expect(compact).toHaveBeenCalledTimes(2);
    expect(compact.mock.calls.map((call) => call[1])).toEqual([
      contextModel,
      lightweightModel,
    ]);
    expect(compact.mock.calls[0]).toEqual([
      event.preparation,
      contextModel,
      "large-key",
      { "x-model": "large" },
      "Retain decisions",
      controller.signal,
      "minimal",
      expect.any(Function),
      { ACME_MODEL: "large" },
      retry,
    ]);
    expect(compact.mock.calls[1]).toEqual([
      event.preparation,
      lightweightModel,
      "small-key",
      { "x-model": "small" },
      "Retain decisions",
      controller.signal,
      "off",
      streamFunction,
      { ACME_MODEL: "small" },
      retry,
    ]);

    const wrappedStream = compact.mock.calls[0]?.[7];
    const streamContext: Context = { messages: [] };
    expect(
      await wrappedStream?.(contextModel, streamContext, { maxTokens: 64 }),
    ).toBe(streamResult);
    expect(streamFunction).toHaveBeenCalledWith(contextModel, streamContext, {
      maxTokens: 64,
      reasoning: "minimal",
    });
  });

  it("advances past an unauthenticated context candidate", async () => {
    const compact = vi.fn<CompactFn>(() => Promise.resolve(compactionResult));
    const resolver = resolverFor({ context: [contextModel, lightweightModel] });
    const getAuth = vi.fn((model: Model<Api>): Promise<AuthResult | undefined> => Promise.resolve(
      model.id === "large"
        ? undefined
        : { auth: { apiKey: "small-key" } },
    ));
    const handlers = createHandlers({ resolver, compact, getAuth });

    await expect(
      handlers.sessionBeforeCompact(compactEvent(), contextWithModel(activeModel)),
    ).resolves.toEqual({ compaction: compactionResult });

    expect(getAuth).toHaveBeenCalledTimes(2);
    expect(compact).toHaveBeenCalledOnce();
    expect(compact.mock.calls[0]?.[1]).toBe(lightweightModel);
  });

  it("returns undefined after all configured compaction candidates fail", async () => {
    const compact = vi.fn<CompactFn>((_preparation, model) => (
      Promise.reject(new Error(`${model.id} failed`))
    ));
    const handlers = createHandlers({
      resolver: resolverFor({ context: [contextModel, lightweightModel] }),
      compact,
    });

    await expect(
      handlers.sessionBeforeCompact(compactEvent(), contextWithModel(activeModel)),
    ).resolves.toBeUndefined();
    expect(compact).toHaveBeenCalledTimes(2);
  });

  it("stops candidate iteration and cancels when aborted", async () => {
    const controller = new AbortController();
    const compact = vi.fn<CompactFn>(() => {
      controller.abort();
      return Promise.reject(new Error("aborted"));
    });
    const handlers = createHandlers({
      resolver: resolverFor({ context: [contextModel, lightweightModel] }),
      compact,
    });

    await expect(
      handlers.sessionBeforeCompact(
        compactEvent({ signal: controller.signal }),
        contextWithModel(activeModel),
      ),
    ).resolves.toEqual({ cancel: true });
    expect(compact).toHaveBeenCalledOnce();
  });
});

describe("utility model inline extension", () => {
  it("is hidden and registers exactly the two summarization handlers without model mutation", async () => {
    const deps = handlerDependencies();
    const extension = createUtilityModelExtension(deps);
    expect(typeof extension).toBe("object");
    if (typeof extension === "function") throw new Error("expected named inline extension");

    expect(extension.name).toBe("pi-webui-utility-models");
    expect(extension.hidden).toBe(true);

    const loader = new DefaultResourceLoader({
      cwd: "/workspace",
      agentDir: "/tmp/pi-webui-utility-model-test",
      extensionFactories: [extension],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loadedExtensions = loader.getExtensions();
    expect(loadedExtensions.errors).toEqual([]);
    expect(loadedExtensions.extensions).toHaveLength(1);
    const [loaded] = loadedExtensions.extensions;
    if (loaded === undefined) throw new Error("expected loaded inline extension");

    expect(loaded.hidden).toBe(true);
    expect([...loaded.handlers.keys()]).toEqual([
      "session_before_tree",
      "session_before_compact",
    ]);
  });
});

interface HandlerOptions {
  resolver?: UtilityModelResolver<Model<Api>>;
  refs?: UtilityModelExtensionRuntimeRefs;
  generateBranchSummary?: GenerateBranchSummaryFn;
  compact?: CompactFn;
  getAuth?: (model: Model<Api>) => Promise<AuthResult | undefined>;
}

function createHandlers(options: HandlerOptions = {}) {
  return createUtilityModelHandlers({
    ...handlerDependencies(options),
    ...(options.refs === undefined ? {} : { refs: options.refs }),
  });
}

function handlerDependencies(options: HandlerOptions = {}) {
  const streamFunction = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
  return {
    resolver: options.resolver ?? resolverFor({ lightweight: [lightweightModel] }),
    modelRuntime: {
      getAuth: options.getAuth ?? (() => Promise.resolve({ auth: { apiKey: "test-key" } })),
    },
    refs: options.refs ?? runtimeRefs(
      streamFunction,
      { enabled: true, maxRetries: 1, baseDelayMs: 1 },
      1_024,
    ),
    generateBranchSummary: options.generateBranchSummary ?? successfulBranchSummary(),
    compact: options.compact ?? successfulCompact(),
    runtimeThinkingLevels: () => ["off"],
  };
}

function resolverFor(
  candidates: Partial<Record<"lightweight" | "context", readonly Model<Api>[]>>,
): UtilityModelResolver<Model<Api>> {
  return {
    configuredCandidates: vi.fn((task: "lightweight" | "context") => Promise.resolve(candidates[task] ?? [])),
  };
}

function runtimeRefs(
  streamFunction: StreamFn,
  retry: { enabled: boolean; maxRetries: number; baseDelayMs: number },
  reserveTokens: number,
): UtilityModelExtensionRuntimeRefs {
  return {
    streamFunction,
    settingsManager: {
      getBranchSummarySettings: () => ({ reserveTokens, skipPrompt: false }),
      getRetrySettings: () => retry,
    },
  };
}

function successfulBranchSummary(): GenerateBranchSummaryFn {
  return vi.fn(() => Promise.resolve({ summary: "summary" }));
}

function successfulCompact(): CompactFn {
  return vi.fn(() => Promise.resolve(compactionResult));
}

function treeEvent(
  overrides: Partial<SessionBeforeTreeEvent["preparation"]> & {
    signal?: AbortSignal;
  } = {},
): SessionBeforeTreeEvent {
  const { signal = new AbortController().signal, ...preparationOverrides } = overrides;
  return {
    type: "session_before_tree",
    preparation: {
      targetId: "target",
      oldLeafId: "old-leaf",
      commonAncestorId: null,
      entriesToSummarize: branchEntries(),
      userWantsSummary: true,
      ...preparationOverrides,
    },
    signal,
  };
}

function compactEvent(
  overrides: {
    signal?: AbortSignal;
    customInstructions?: string;
  } = {},
): SessionBeforeCompactEvent {
  const signal = overrides.signal ?? new AbortController().signal;
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "entry-kept",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 12_000,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 4_096, keepRecentTokens: 8_192 },
    },
    branchEntries: branchEntries(),
    ...(overrides.customInstructions === undefined
      ? {}
      : { customInstructions: overrides.customInstructions }),
    reason: "threshold",
    willRetry: false,
    signal,
  };
}

function branchEntries(): SessionBeforeTreeEvent["preparation"]["entriesToSummarize"] {
  return [{
    type: "custom",
    id: "entry-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "test",
    data: { value: true },
  }];
}

function contextWithModel(
  model: Model<Api> | undefined,
  onRead?: () => void,
): UtilityModelHandlerContext {
  return {
    get model() {
      onRead?.();
      return model;
    },
  };
}

function fakeModel(provider: string, id: string, reasoning: boolean): Model<Api> {
  const model: Model<Api> = {
    provider,
    id,
    name: id,
    api: "openai-responses",
    baseUrl: "https://example.test/v1",
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
  return Object.freeze(model);
}

function fakeUsage(): Usage {
  return {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
