import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExactModelSelection,
  ModelTier,
  StarterModelPolicyPreference,
} from "../../shared/apiTypes.js";
import { PiSessionService, type PiAgentSession, type PiSessionRuntime } from "./piSessionService.js";
import {
  inspectSessionCreationRootEligibility,
  inspectSessionCreationSource,
  SESSION_CREATION_SOURCE_CUSTOM_TYPE,
} from "./sessionCreationSource.js";
import {
  inspectSessionModelPolicy,
  SESSION_MODEL_POLICY_CUSTOM_TYPE,
} from "./sessionModelPolicy.js";
import type { StarterPreferenceWrite } from "./starterModelPolicyPreferenceStore.js";
import { runtimeThinkingLevels, type LadderValidation } from "./modelTierRegistry.js";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import {
  CapturingSessionEventHub,
  emptyArchiveStore,
  fakeRuntime,
  fakeSessionManager,
  sessionRecord,
  sessionRef,
  testModelRuntime,
} from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-webui-model-policy-test-agent";
const TEST_CWD = "/workspace";
const TEST_SESSION_ID = "model-policy-session";
const TEST_SESSION_DIR = mkdtempSync(
  join(tmpdir(), "pi-webui-model-policy-test-")
);
const TEST_SESSION_FILE = join(TEST_SESSION_DIR, `${TEST_SESSION_ID}.jsonl`);
const DEFAULT_SELECTION: ExactModelSelection = {
  model: { provider: "openai", id: "gpt-default" },
  thinkingLevel: "medium",
};

/** Tier target the stub registry resolves to unless a test overrides it. */
const ADVANCED_SELECTION: ExactModelSelection = {
  model: { provider: "openai", id: "gpt-advanced" },
  thinkingLevel: "high",
};

interface ModelPolicyHarnessOptions {
  branch?: readonly unknown[];
  existing?: boolean;
  persistedFile?: boolean;
  parentSession?: string;
  append?: "available" | "missing" | "throws" | "throwsOnce";
  failCreationSourceAppend?: boolean;
  silentlyDropModelPolicyAppend?: boolean;
  silentlyDropCreationSourceAppend?: boolean;
  failDurableCommit?: boolean;
  emitInitializerEvents?: boolean;
  model?: PiAgentSession["model"];
  thinkingLevel?: PiAgentSession["thinkingLevel"];
  ladderValidation?: LadderValidation;
  archived?: boolean;
  /**
   * Scoped runtime catalog. Reasoning models expose pi's full thinking ladder;
   * a non-reasoning model exposes only "off", which is how a target thinking
   * level becomes unsupported without stubbing pi's own level lookup.
   */
  scopedModels?: readonly { provider: string; id: string; reasoning?: boolean }[];
  /** Tier target the stub tier registry resolves to. */
  tierTarget?: ExactModelSelection;
  /** Reject `setModel` on the nth (1-based) runtime call, e.g. a restore attempt. */
  failSetModelOnCall?: number;
  /** Force pi's silent thinking clamp: record this level instead of the requested one. */
  clampThinkingTo?: PiAgentSession["thinkingLevel"];
  /**
   * Hold `setModel` on the nth (1-based) call until the harness releases it. Keeps
   * a policy transition observably in flight so concurrent prompt/queue behavior
   * inside the transient window can be asserted deterministically.
   */
  holdSetModelOnCall?: number;
  /**
   * Runs while the adapter awaits `modelRuntime.refresh`. Used to simulate work
   * that starts during async target resolution, before any setter runs.
   */
  onModelRuntimeRefresh?: () => void;
  spawnTargetCwd?: string;
  preferenceStore?: {
    replace(cwd: string, write: StarterPreferenceWrite): Promise<void>;
  };
}

const DEFAULT_SCOPED_MODELS = [
  { provider: "openai", id: "gpt-default", reasoning: true },
  { provider: "openai", id: "gpt-advanced", reasoning: true },
  { provider: "openai", id: "gpt-basic" },
] as const;

const services: PiSessionService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => service.dispose()));
  rmSync(TEST_SESSION_FILE, { force: true });
});

afterAll(() => {
  rmSync(TEST_SESSION_DIR, { recursive: true, force: true });
});

function runtimeModel(provider: string, id: string, reasoning = true): NonNullable<PiAgentSession["model"]> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub with the minimal surface the harness reads.
  return { provider, id, ...(reasoning ? { reasoning: true } : {}) } as NonNullable<PiAgentSession["model"]>;
}

function piThinkingLevel(level: string): ThinkingLevel {
  switch (level) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return level;
    default:
      throw new Error(`Unknown Pi thinking level: ${level}`);
  }
}

function policyEntry(data: unknown): unknown {
  return { type: "custom", customType: SESSION_MODEL_POLICY_CUSTOM_TYPE, data };
}

function creationSourceEntry(data: unknown = {
  version: 2,
  source: "session-list-plus",
  origin: {
    sessionId: TEST_SESSION_ID,
    sessionFile: TEST_SESSION_FILE,
  },
}): unknown {
  return { type: "custom", customType: SESSION_CREATION_SOURCE_CUSTOM_TYPE, data };
}

function createModelPolicyHarness(options: ModelPolicyHarnessOptions = {}) {
  const branch = [...(options.branch ?? [])];
  const operations: string[] = [];
  /** Runtime/persistence operations in the order the adapter performed them. */
  const calls: string[] = [];
  const getBranch = vi.fn(() => branch);
  let appendFailures = 0;
  const appendCustomEntry = vi.fn((customType: string, data?: unknown) => {
    operations.push(`appendCustomEntry:${customType}`);
    calls.push(`appendCustomEntry:${customType}`);
    if (customType === SESSION_CREATION_SOURCE_CUSTOM_TYPE && options.failCreationSourceAppend === true) {
      throw new Error("creation source persistence failed");
    }
    const failsOnce = options.append === "throwsOnce" && appendFailures === 0;
    if (options.append === "throws" || failsOnce) {
      appendFailures += 1;
      throw new Error("model policy persistence failed");
    }
    const silentlyDropped =
      (customType === SESSION_MODEL_POLICY_CUSTOM_TYPE &&
        options.silentlyDropModelPolicyAppend === true) ||
      (customType === SESSION_CREATION_SOURCE_CUSTOM_TYPE &&
        options.silentlyDropCreationSourceAppend === true);
    if (silentlyDropped) return "entry-not-persisted";
    branch.push({ type: "custom", customType, data });
    return `entry-${String(branch.length)}`;
  });
  const prompt = vi.fn(() => {
    operations.push("prompt");
    calls.push("prompt");
    return Promise.resolve();
  });
  const scopedModels = (options.scopedModels ?? DEFAULT_SCOPED_MODELS)
    .map((entry: { provider: string; id: string; reasoning?: boolean }) => ({
      model: runtimeModel(entry.provider, entry.id, entry.reasoning ?? false),
    }));
  const supportedLevels = (model: PiAgentSession["model"]): readonly string[] => runtimeThinkingLevels(model);
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: DEFAULT_SELECTION.model.provider,
    defaultModel: DEFAULT_SELECTION.model.id,
    defaultThinkingLevel: "medium",
  });
  const settingsFlush = vi.spyOn(settingsManager, "flush");
  let releaseSetModel: (() => void) | undefined;
  const setModelGate = new Promise<void>((resolve) => { releaseSetModel = resolve; });
  let setModelCalls = 0;
  const setModel = vi.fn(async (model: NonNullable<PiAgentSession["model"]>) => {
    setModelCalls += 1;
    calls.push(`setModel:${model.provider}/${model.id}`);
    operations.push(`setModel:${model.provider}/${model.id}`);
    if (options.failSetModelOnCall === setModelCalls) {
      throw new Error("runtime rejected the model change");
    }
    fake.session.model = model;
    settingsManager.setDefaultModelAndProvider(model.provider, model.id);
    // pi re-clamps thinking against the incoming model while switching models.
    const levels = supportedLevels(model);
    if (!levels.includes(fake.session.thinkingLevel)) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- pi's level set, narrowed for the stub session.
      fake.session.thinkingLevel = (levels[0] ?? "off") as PiAgentSession["thinkingLevel"];
    }
    if (options.holdSetModelOnCall === setModelCalls) await setModelGate;
  });
  const setThinkingLevel = vi.fn((level: PiAgentSession["thinkingLevel"]) => {
    calls.push(`setThinkingLevel:${level}`);
    operations.push(`setThinkingLevel:${level}`);
    // pi clamps silently rather than failing; `clampThinkingTo` reproduces that.
    const previous = fake.session.thinkingLevel;
    fake.session.thinkingLevel = options.clampThinkingTo ?? level;
    if (fake.session.thinkingLevel !== previous) {
      settingsManager.setDefaultThinkingLevel(fake.session.thinkingLevel);
      if (options.emitInitializerEvents === true) {
        fake.emit({
          type: "thinking_level_changed",
          level: fake.session.thinkingLevel,
        });
      }
    }
  });
  const cycleModel = vi.fn(() => {
    const next = scopedModels.find(({ model }) => model.id !== fake.session.model?.id)?.model;
    if (next === undefined) return Promise.resolve(undefined);
    return setModel(next).then(() => ({ model: next }));
  });
  const cycleThinkingLevel = vi.fn(() => {
    const levels = supportedLevels(fake.session.model);
    const next = levels[(levels.indexOf(fake.session.thinkingLevel) + 1) % Math.max(levels.length, 1)];
    if (next === undefined) return undefined;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- pi's level set, narrowed for the stub session.
    setThinkingLevel(next as PiAgentSession["thinkingLevel"]);
    return fake.session.thinkingLevel;
  });
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- pi's level set, narrowed for the stub session.
  const getAvailableThinkingLevels = vi.fn(() => supportedLevels(fake.session.model) as PiAgentSession["thinkingLevel"][]);
  const refreshHook = options.onModelRuntimeRefresh;
  // Delegating wrapper: only `refresh` is intercepted, every other ModelRuntime
  // read still goes to the real runtime (bound to it, so pi's own internals keep
  // working).
  const modelRuntime = refreshHook === undefined ? testModelRuntime : new Proxy(testModelRuntime, {
    get(target, property, receiver): unknown {
      if (property !== "refresh") return Reflect.get(target, property, receiver);
      return async (...args: Parameters<typeof testModelRuntime.refresh>) => {
        const result = await testModelRuntime.refresh(...args);
        refreshHook();
        return result;
      };
    },
  });
  const manager = fakeSessionManager(TEST_CWD, {
    getBranch,
    getEntries: getBranch,
    getSessionId: () => TEST_SESSION_ID,
    getSessionFile: () => TEST_SESSION_FILE,
    getHeader: () => ({
      id: TEST_SESSION_ID,
      ...(options.parentSession === undefined
        ? {}
        : { parentSession: options.parentSession }),
    }),
    ...(options.append === "missing" ? { appendCustomEntry: undefined } : { appendCustomEntry }),
  });
  const fake = fakeRuntime(TEST_SESSION_ID, {
    model: options.model ?? runtimeModel(DEFAULT_SELECTION.model.provider, DEFAULT_SELECTION.model.id),
    thinkingLevel: options.thinkingLevel ?? "medium",
    sessionManager: manager,
    sessionFile: TEST_SESSION_FILE,
    settingsManager,
    modelRuntime,
    scopedModels,
    prompt,
    setModel,
    cycleModel,
    setThinkingLevel,
    cycleThinkingLevel,
    getAvailableThinkingLevels,
  });
  let rebindSession: ((session: PiAgentSession) => Promise<void>) | undefined;
  fake.runtime.setRebindSession = (callback) => {
    rebindSession = callback;
  };

  const hub = new CapturingSessionEventHub();
  const publishGlobal = hub.publishGlobal.bind(hub);
  vi.spyOn(hub, "publishGlobal").mockImplementation((event) => {
    operations.push(`global:${event.type}`);
    publishGlobal(event);
  });
  const publish = hub.publish.bind(hub);
  vi.spyOn(hub, "publish").mockImplementation((sessionId, event) => {
    operations.push(`session:${event.type}`);
    publish(sessionId, event);
  });
  const validate = vi.fn(() => options.ladderValidation ?? { valid: true } as const);
  const tierTarget = options.tierTarget ?? ADVANCED_SELECTION;
  const resolve = vi.fn((tier: ModelTier) => {
    const model = scopedModels.find(({ model: candidate }) => candidate.provider === tierTarget.model.provider
      && candidate.id === tierTarget.model.id)?.model;
    if (model === undefined) throw new Error(`tier ${tier} names unavailable model`);
    return { tier, model, thinkingLevel: tierTarget.thinkingLevel };
  });
  const modelTierRegistry = { resolve, validate };
  const existing = options.existing ?? true;
  if (existing && options.persistedFile !== false) {
    writeFileSync(
      TEST_SESSION_FILE,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: TEST_SESSION_ID,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: TEST_CWD,
      })}\n`,
      "utf8"
    );
  } else {
    rmSync(TEST_SESSION_FILE, { force: true });
  }
  /** Runtime handed to the *next* `createAgentRuntime` call (e.g. after reload). */
  let nextRuntime: PiSessionRuntime | undefined;
  let durableTranscriptPresent = false;
  const commitInitialEntries = vi.fn(() => {
    operations.push("commitInitialEntries");
    durableTranscriptPresent = true;
    writeFileSync(
      TEST_SESSION_FILE,
      `${[
        {
          type: "session",
          version: 3,
          id: TEST_SESSION_ID,
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: TEST_CWD,
        },
        ...branch,
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
      "utf8"
    );
    return options.failDurableCommit === true
      ? Promise.reject(new Error("initial session durable commit failed"))
      : Promise.resolve();
  });
  const discardInitialEntries = vi.fn(() => {
    operations.push("discardInitialEntries");
    durableTranscriptPresent = false;
    rmSync(TEST_SESSION_FILE, { force: true });
    return Promise.resolve();
  });
  const service = new PiSessionService(hub, {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    createAgentRuntime: () => {
      const runtime = nextRuntime ?? fake.runtime;
      nextRuntime = undefined;
      return Promise.resolve(runtime);
    },
    modelTierRegistry,
    ...(options.preferenceStore === undefined
      ? {}
      : { starterModelPolicyPreferenceStore: options.preferenceStore }),
    ...(options.archived !== true ? {} : {
      archiveStore: {
        ...emptyArchiveStore(),
        get: () => Promise.resolve({
          sessionId: TEST_SESSION_ID,
          cwd: TEST_CWD,
          archivedAt: "2026-01-02T00:00:00.000Z",
          archivePath: `/archive/${TEST_SESSION_ID}.jsonl`,
        }),
        isArchived: () => Promise.resolve(true),
      },
    }),
    sessionManager: {
      create: vi.fn(() => manager),
      list: vi.fn(() => Promise.resolve(existing ? [sessionRecord(TEST_SESSION_ID, TEST_CWD)] : [])),
      open: vi.fn(() => manager),
      commitInitialEntries,
      discardInitialEntries,
    },
    ...(options.spawnTargetCwd === undefined ? {} : {
      spawnTargets: {
        resolveSpawnTarget: () => Promise.resolve({ allowed: true as const, cwd: options.spawnTargetCwd ?? TEST_CWD }),
      },
    }),
    heartbeatIntervalMs: 60_000,
  });
  services.push(service);

  return {
    appendCustomEntry,
    branch,
    calls,
    commitInitialEntries,
    discardInitialEntries,
    durableTranscriptPresent: () => durableTranscriptPresent,
    fake,
    getBranch,
    hub,
    manager,
    operations,
    prompt,
    rebind: async (session: PiAgentSession) => {
      if (rebindSession === undefined) throw new Error("runtime rebind callback was not installed");
      await rebindSession(session);
    },
    releaseSetModel: () => { releaseSetModel?.(); },
    resolve,
    service,
    settingsFlush,
    settingsManager,
    /** Hand a replacement runtime to the next reopen (`reload`) of this session. */
    useNextRuntime: (runtime: PiSessionRuntime) => { nextRuntime = runtime; },
    validate,
  };
}

describe("PiSessionService model policy lifecycle", () => {
  it("persists the new root runtime's Exact tuple before accepting its first prompt", async () => {
    const harness = createModelPolicyHarness({ existing: false });

    await harness.service.start(TEST_CWD);

    expect(harness.appendCustomEntry).toHaveBeenCalledOnce();
    expect(harness.appendCustomEntry).toHaveBeenCalledWith(SESSION_MODEL_POLICY_CUSTOM_TYPE, {
      version: 1,
      mode: "exact",
      exact: DEFAULT_SELECTION,
    });
    expect(harness.prompt).not.toHaveBeenCalled();

    await harness.service.prompt(sessionRef(TEST_SESSION_ID, TEST_CWD), "hello");
    await vi.waitFor(() => {
      expect(harness.prompt).toHaveBeenCalledWith("hello", undefined);
    });
    expect(harness.operations.indexOf(`appendCustomEntry:${SESSION_MODEL_POLICY_CUSTOM_TYPE}`))
      .toBeLessThan(harness.operations.indexOf("prompt"));
  });

  it("hydrates the newest Tiered policy while displaying the reopened runtime tuple", async () => {
    const harness = createModelPolicyHarness({
      branch: [policyEntry({
        version: 1,
        mode: "tiered",
        exact: {
          model: { provider: "openai", id: "gpt-remembered" },
          thinkingLevel: "off",
        },
        tier: "advanced",
      })],
    });

    const status = await harness.service.status(sessionRef(TEST_SESSION_ID, TEST_CWD));

    expect(status.modelPolicy).toEqual({
      mode: "tiered",
      tier: "advanced",
      resolved: DEFAULT_SELECTION,
      ladderValid: true,
    });
    expect(harness.appendCustomEntry).not.toHaveBeenCalled();
  });

  it("keeps a malformed newest entry authoritative and omits executable policy from inspection", async () => {
    const harness = createModelPolicyHarness({
      branch: [
        policyEntry({ version: 1, mode: "exact", exact: DEFAULT_SELECTION }),
        policyEntry({ version: 99 }),
      ],
    });

    const response = await harness.service.modelPolicy(sessionRef(TEST_SESSION_ID, TEST_CWD));

    expect(response).not.toHaveProperty("policy");
    expect(response.session.modelPolicy).toEqual({
      mode: "exact",
      resolved: DEFAULT_SELECTION,
      ladderValid: true,
      blockedReason: "unsupported policy version",
    });
    expect(harness.appendCustomEntry).not.toHaveBeenCalled();
  });

  it("writes exactly one default Exact entry before publishing session.created", async () => {
    const harness = createModelPolicyHarness({ existing: false });

    await harness.service.start(TEST_CWD);

    expect(harness.appendCustomEntry).toHaveBeenCalledOnce();
    const appendIndex = harness.operations.indexOf(`appendCustomEntry:${SESSION_MODEL_POLICY_CUSTOM_TYPE}`);
    const createdIndex = harness.operations.indexOf("global:session.created");
    expect(appendIndex).toBeGreaterThanOrEqual(0);
    expect(createdIndex).toBeGreaterThan(appendIndex);
  });

  it("initializes a plus Tiered root as model, thinking, full policy, then source before announcing it", async () => {
    const harness = createModelPolicyHarness({ existing: false });
    const initialModelPolicy = {
      mode: "tiered",
      exact: {
        model: { provider: "retired", id: "remembered" },
        thinkingLevel: "retired-level",
      },
      tier: "advanced",
    } as const;

    const created = await harness.service.start(TEST_CWD, {
      creationSource: "session-list-plus",
      initialModelPolicy,
    });

    expect(harness.resolve).toHaveBeenCalledOnce();
    expect(harness.resolve).toHaveBeenCalledWith("advanced");
    expect(harness.calls).toEqual([
      "setModel:openai/gpt-advanced",
      "setThinkingLevel:high",
      `appendCustomEntry:${SESSION_MODEL_POLICY_CUSTOM_TYPE}`,
      `appendCustomEntry:${SESSION_CREATION_SOURCE_CUSTOM_TYPE}`,
    ]);
    expect(harness.appendCustomEntry).toHaveBeenCalledWith(
      SESSION_MODEL_POLICY_CUSTOM_TYPE,
      {
        version: 1,
        mode: "tiered",
        exact: initialModelPolicy.exact,
        tier: "advanced",
      }
    );
    expect(harness.appendCustomEntry).toHaveBeenCalledWith(
      SESSION_CREATION_SOURCE_CUSTOM_TYPE,
      {
        version: 2,
        source: "session-list-plus",
        origin: {
          sessionId: TEST_SESSION_ID,
          sessionFile: TEST_SESSION_FILE,
        },
      }
    );
    const policyAppendIndex = harness.operations.indexOf(
      `appendCustomEntry:${SESSION_MODEL_POLICY_CUSTOM_TYPE}`
    );
    const sourceAppendIndex = harness.operations.indexOf(
      `appendCustomEntry:${SESSION_CREATION_SOURCE_CUSTOM_TYPE}`
    );
    const commitIndex = harness.operations.indexOf("commitInitialEntries");
    const createdIndex = harness.operations.indexOf("global:session.created");
    expect(harness.operations.indexOf("setModel:openai/gpt-advanced")).toBeLessThan(
      harness.operations.indexOf("setThinkingLevel:high")
    );
    expect(harness.operations.indexOf("setThinkingLevel:high")).toBeLessThan(policyAppendIndex);
    expect(policyAppendIndex).toBeLessThan(sourceAppendIndex);
    expect(commitIndex).toBeGreaterThan(sourceAppendIndex);
    expect(createdIndex).toBeGreaterThan(commitIndex);
    expect(harness.commitInitialEntries).toHaveBeenCalledOnce();
    expect(created).toMatchObject({ creationSource: "session-list-plus" });
    const createdEvent = harness.hub.globalEvents.find(
      (event) => event.type === "session.created"
    );
    expect(createdEvent).toMatchObject({
      type: "session.created",
      session: { creationSource: "session-list-plus" },
    });
    const statusEvent = harness.hub.globalEvents.find(
      (event) => event.type === "status.update"
    );
    expect(statusEvent).toMatchObject({
      type: "status.update",
      status: {
        modelPolicy: {
          mode: "tiered",
          tier: "advanced",
          resolved: {
            model: { provider: "openai", id: "gpt-advanced" },
            thinkingLevel: "high",
          },
          ladderValid: true,
        },
      },
    });
  });

  it("does not publish initializer runtime events before the durable plus-root commit", async () => {
    const harness = createModelPolicyHarness({
      existing: false,
      emitInitializerEvents: true,
    });

    await harness.service.start(TEST_CWD, {
      creationSource: "session-list-plus",
      initialModelPolicy: {
        mode: "tiered",
        exact: DEFAULT_SELECTION,
        tier: "advanced",
      },
    });

    const commitIndex = harness.operations.indexOf("commitInitialEntries");
    const firstStatusIndex = harness.operations.findIndex(
      (operation) => operation === "session:status.update" || operation === "global:status.update"
    );
    expect(commitIndex).toBeGreaterThanOrEqual(0);
    expect(firstStatusIndex).toBeGreaterThan(commitIndex);
    expect(
      harness.operations
        .slice(0, commitIndex)
        .filter((operation) =>
          operation === "session:status.update" ||
          operation === "global:status.update" ||
          operation === "session:thinking_level_changed"
        )
    ).toEqual([]);
    const firstStatus = harness.hub.sessionEvents.find(
      ({ event }) => event.type === "status.update"
    );
    expect(firstStatus?.event).toMatchObject({
      type: "status.update",
      status: {
        modelPolicy: {
          mode: "tiered",
          tier: "advanced",
          resolved: ADVANCED_SELECTION,
        },
      },
    });
  });

  it("initializes a plus Exact root without resolving its unavailable inactive tier", async () => {
    const harness = createModelPolicyHarness({
      existing: false,
      tierTarget: {
        model: { provider: "retired", id: "unavailable-tier-target" },
        thinkingLevel: "high",
      },
    });

    await harness.service.start(TEST_CWD, {
      creationSource: "session-list-plus",
      initialModelPolicy: {
        mode: "exact",
        exact: DEFAULT_SELECTION,
        tier: "frontier",
      },
    });

    expect(harness.resolve).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([
      "setModel:openai/gpt-default",
      "setThinkingLevel:medium",
      `appendCustomEntry:${SESSION_MODEL_POLICY_CUSTOM_TYPE}`,
      `appendCustomEntry:${SESSION_CREATION_SOURCE_CUSTOM_TYPE}`,
    ]);
    expect(harness.appendCustomEntry).toHaveBeenCalledWith(
      SESSION_MODEL_POLICY_CUSTOM_TYPE,
      {
        version: 1,
        mode: "exact",
        exact: DEFAULT_SELECTION,
        tier: "frontier",
      }
    );
  });

  it("does not append a creation source for an ordinary new root", async () => {
    const harness = createModelPolicyHarness({ existing: false });

    const created = await harness.service.start(TEST_CWD);

    expect(harness.operations).not.toContain(
      `appendCustomEntry:${SESSION_CREATION_SOURCE_CUSTOM_TYPE}`
    );
    expect(created).not.toHaveProperty("creationSource");
  });

  it("does not append a plus creation source for spawn-session or tracked-subsession roots", async () => {
    const spawned = createModelPolicyHarness({ existing: false, spawnTargetCwd: "/workspace-feature" });
    const tracked = createModelPolicyHarness({ existing: false, spawnTargetCwd: "/workspace-feature" });

    await spawned.service.spawnSession({
      spawningCwd: TEST_CWD,
      prompt: "continue",
      cwd: "/workspace-feature",
    });
    await tracked.service.spawnSubsession({
      spawningCwd: TEST_CWD,
      parentSessionId: "parent-session",
      parentSessionFile: undefined,
      prompt: "continue tracked",
      cwd: "/workspace-feature",
    });

    expect(spawned.operations).not.toContain(
      `appendCustomEntry:${SESSION_CREATION_SOURCE_CUSTOM_TYPE}`
    );
    expect(tracked.operations).not.toContain(
      `appendCustomEntry:${SESSION_CREATION_SOURCE_CUSTOM_TYPE}`
    );
  });

  it("serves streaming status from the lifecycle cache without rescanning policy or ladder state", async () => {
    const harness = createModelPolicyHarness();

    await harness.service.status(sessionRef(TEST_SESSION_ID, TEST_CWD));
    const branchReadsAfterCreate = harness.getBranch.mock.calls.length;
    expect(harness.validate).toHaveBeenCalledOnce();

    await harness.service.status(sessionRef(TEST_SESSION_ID, TEST_CWD));
    await harness.service.status(sessionRef(TEST_SESSION_ID, TEST_CWD));
    harness.fake.emit({ type: "message_update" });

    expect(harness.getBranch).toHaveBeenCalledTimes(branchReadsAfterCreate);
    expect(harness.validate).toHaveBeenCalledOnce();

    await harness.service.modelPolicy(sessionRef(TEST_SESSION_ID, TEST_CWD));
    expect(harness.getBranch).toHaveBeenCalledTimes(branchReadsAfterCreate + 1);
    expect(harness.validate).toHaveBeenCalledTimes(2);
  });

  it("refreshes policy inspection before binding status publication to a replacement session", async () => {
    const harness = createModelPolicyHarness();
    await harness.service.status(sessionRef(TEST_SESSION_ID, TEST_CWD));
    const replacementBranch = vi.fn(() => [policyEntry({
      version: 1,
      mode: "tiered",
      exact: DEFAULT_SELECTION,
      tier: "frontier",
    })]);
    const replacement = fakeRuntime(TEST_SESSION_ID, {
      model: runtimeModel("openai", "gpt-rebound"),
      thinkingLevel: "high",
      sessionManager: fakeSessionManager(TEST_CWD, { getBranch: replacementBranch }),
    });

    await harness.rebind(replacement.session);
    replacement.emit({ type: "message_update" });

    const statusEvent = [...harness.hub.globalEvents].reverse().find((event) => event.type === "status.update");
    expect(statusEvent).toMatchObject({
      type: "status.update",
      status: {
        modelPolicy: {
          mode: "tiered",
          tier: "frontier",
          resolved: {
            model: { provider: "openai", id: "gpt-rebound" },
            thinkingLevel: "high",
          },
          ladderValid: true,
        },
      },
    });
    expect(replacementBranch).toHaveBeenCalled();
    expect(harness.validate).toHaveBeenCalledTimes(2);
  });

  it("cleans up an unseen plus root when its active Exact selection is unavailable", async () => {
    const harness = createModelPolicyHarness({ existing: false });

    await expect(harness.service.start(TEST_CWD, {
      creationSource: "session-list-plus",
      initialModelPolicy: {
        mode: "exact",
        exact: {
          model: { provider: "retired", id: "unavailable" },
          thinkingLevel: "medium",
        },
        tier: "standard",
      },
    })).rejects.toThrow(/Model not found: retired\/unavailable/u);

    expect(harness.calls).toEqual([]);
    expect(harness.service.activeCount()).toBe(0);
    expect(harness.fake.calls.abort).toBe(1);
    expect(harness.fake.calls.dispose).toBe(1);
    expect(harness.prompt).not.toHaveBeenCalled();
    expect(harness.hub.globalEvents.some((event) => event.type === "session.created")).toBe(false);
  });

  it("cleans up an unseen plus root when its active Tiered selection cannot resolve", async () => {
    const harness = createModelPolicyHarness({
      existing: false,
      tierTarget: {
        model: { provider: "retired", id: "unavailable-tier-target" },
        thinkingLevel: "high",
      },
    });

    await expect(harness.service.start(TEST_CWD, {
      creationSource: "session-list-plus",
      initialModelPolicy: {
        mode: "tiered",
        exact: DEFAULT_SELECTION,
        tier: "advanced",
      },
    })).rejects.toThrow(/tier advanced names unavailable model/u);

    expect(harness.resolve).toHaveBeenCalledOnce();
    expect(harness.calls).toEqual([]);
    expect(harness.service.activeCount()).toBe(0);
    expect(harness.fake.calls.abort).toBe(1);
    expect(harness.fake.calls.dispose).toBe(1);
    expect(harness.prompt).not.toHaveBeenCalled();
    expect(harness.hub.globalEvents.some((event) => event.type === "session.created")).toBe(false);
  });

  it("cleans up an unseen plus root when full policy persistence fails", async () => {
    const harness = createModelPolicyHarness({ existing: false, append: "throws" });

    await expect(harness.service.start(TEST_CWD, {
      creationSource: "session-list-plus",
      initialModelPolicy: { mode: "exact", exact: DEFAULT_SELECTION },
    })).rejects.toThrow("model policy persistence failed");

    expect(harness.calls).toContain(`appendCustomEntry:${SESSION_MODEL_POLICY_CUSTOM_TYPE}`);
    expect(harness.calls).not.toContain(`appendCustomEntry:${SESSION_CREATION_SOURCE_CUSTOM_TYPE}`);
    expect(harness.service.activeCount()).toBe(0);
    expect(harness.fake.calls.abort).toBe(1);
    expect(harness.fake.calls.dispose).toBe(1);
    expect(harness.prompt).not.toHaveBeenCalled();
    expect(harness.hub.globalEvents.some((event) => event.type === "session.created")).toBe(false);
  });

  it("cleans up an unseen plus root when a policy append is not durable", async () => {
    const harness = createModelPolicyHarness({
      existing: false,
      silentlyDropModelPolicyAppend: true,
    });

    await expect(harness.service.start(TEST_CWD, {
      creationSource: "session-list-plus",
      initialModelPolicy: { mode: "exact", exact: DEFAULT_SELECTION },
    })).rejects.toThrow("Cannot verify the complete initial session model policy");

    expect(harness.calls).toEqual([
      "setModel:openai/gpt-default",
      "setThinkingLevel:medium",
      `appendCustomEntry:${SESSION_MODEL_POLICY_CUSTOM_TYPE}`,
    ]);
    expect(harness.service.activeCount()).toBe(0);
    expect(harness.fake.calls.abort).toBe(1);
    expect(harness.fake.calls.dispose).toBe(1);
    expect(harness.prompt).not.toHaveBeenCalled();
    expect(harness.hub.globalEvents.some((event) => event.type === "session.created")).toBe(false);
  });

  it("cleans up an unseen plus root when source persistence fails", async () => {
    const harness = createModelPolicyHarness({ existing: false, failCreationSourceAppend: true });

    await expect(
      harness.service.start(TEST_CWD, {
        creationSource: "session-list-plus",
        initialModelPolicy: { mode: "exact", exact: DEFAULT_SELECTION },
      })
    ).rejects.toThrow("creation source persistence failed");

    expect(harness.calls).toEqual([
      "setModel:openai/gpt-default",
      "setThinkingLevel:medium",
      `appendCustomEntry:${SESSION_MODEL_POLICY_CUSTOM_TYPE}`,
      `appendCustomEntry:${SESSION_CREATION_SOURCE_CUSTOM_TYPE}`,
    ]);
    expect(harness.service.activeCount()).toBe(0);
    expect(harness.fake.calls.abort).toBe(1);
    expect(harness.fake.calls.dispose).toBe(1);
    expect(harness.prompt).not.toHaveBeenCalled();
    expect(harness.hub.globalEvents.some((event) => event.type === "session.created")).toBe(false);
  });

  it.each([
    ["policy append", { append: "throws" as const }, "model policy persistence failed"],
    ["source append", { failCreationSourceAppend: true }, "creation source persistence failed"],
    ["durable commit", { failDurableCommit: true }, "initial session durable commit failed"],
  ])("restores runtime and persisted Pi defaults after a %s failure", async (_failure, failureOptions, message) => {
    const harness = createModelPolicyHarness({
      existing: false,
      emitInitializerEvents: true,
      ...failureOptions,
    });

    await expect(
      harness.service.start(TEST_CWD, {
        creationSource: "session-list-plus",
        initialModelPolicy: {
          mode: "tiered",
          exact: DEFAULT_SELECTION,
          tier: "advanced",
        },
      })
    ).rejects.toThrow(message);

    expect(harness.fake.session.model).toMatchObject(DEFAULT_SELECTION.model);
    expect(harness.fake.session.thinkingLevel).toBe(DEFAULT_SELECTION.thinkingLevel);
    expect(harness.settingsManager.getGlobalSettings()).toMatchObject({
      defaultProvider: DEFAULT_SELECTION.model.provider,
      defaultModel: DEFAULT_SELECTION.model.id,
      defaultThinkingLevel: DEFAULT_SELECTION.thinkingLevel,
    });
    expect(harness.settingsFlush).toHaveBeenCalled();
    expect(harness.service.activeCount()).toBe(0);
    expect(harness.durableTranscriptPresent()).toBe(false);
    expect(
      harness.hub.sessionEvents.some(({ event }) => event.type === "status.update")
    ).toBe(false);
    expect(
      harness.hub.globalEvents.some(
        (event) => event.type === "status.update" || event.type === "session.created"
      )
    ).toBe(false);
  });

  it("cleans up an unseen plus root when a source append is not durable", async () => {
    const harness = createModelPolicyHarness({
      existing: false,
      silentlyDropCreationSourceAppend: true,
    });

    await expect(harness.service.start(TEST_CWD, {
      creationSource: "session-list-plus",
      initialModelPolicy: { mode: "exact", exact: DEFAULT_SELECTION },
    })).rejects.toThrow("Cannot verify the session creation source");

    expect(harness.calls).toEqual([
      "setModel:openai/gpt-default",
      "setThinkingLevel:medium",
      `appendCustomEntry:${SESSION_MODEL_POLICY_CUSTOM_TYPE}`,
      `appendCustomEntry:${SESSION_CREATION_SOURCE_CUSTOM_TYPE}`,
    ]);
    expect(harness.service.activeCount()).toBe(0);
    expect(harness.fake.calls.abort).toBe(1);
    expect(harness.fake.calls.dispose).toBe(1);
    expect(harness.prompt).not.toHaveBeenCalled();
    expect(harness.hub.globalEvents.some((event) => event.type === "session.created")).toBe(false);
  });

  it("cleans up a new root when default policy persistence is unavailable", async () => {
    const harness = createModelPolicyHarness({ existing: false, append: "missing" });

    await expect(harness.service.start(TEST_CWD)).rejects.toThrow(/persist.*model policy/iu);

    expect(harness.service.activeCount()).toBe(0);
    expect(harness.fake.calls.abort).toBe(1);
    expect(harness.fake.calls.dispose).toBe(1);
  });

  it("rejects a new root whose runtime has no resolved model instead of persisting an incomplete policy", async () => {
    const harness = createModelPolicyHarness({ existing: false, model: undefined });
    harness.fake.session.model = undefined;

    await expect(harness.service.start(TEST_CWD)).rejects.toThrow(/runtime model/iu);

    expect(harness.appendCustomEntry).not.toHaveBeenCalled();
    expect(harness.service.activeCount()).toBe(0);
  });
});

describe("PiSessionService real SessionManager plus-root integration", () => {
  it("reopens durable policy, provenance, and root eligibility before publication", async () => {
    const integrationDir = mkdtempSync(
      join(TEST_SESSION_DIR, "real-session-manager-")
    );
    const integrationCwd = join(integrationDir, "workspace");
    const integrationAgentDir = join(integrationDir, "agent");
    const integrationSessionDir = join(integrationDir, "sessions");
    mkdirSync(integrationCwd, { recursive: true });
    const gateway = createPiSessionManagerGateway({
      agentDir: integrationAgentDir,
      env: { PI_WEBUI_AGENT_SESSION_DIR: integrationSessionDir },
      sessionDirEnvKeys: ["PI_WEBUI_AGENT_SESSION_DIR"],
    });
    const hub = new CapturingSessionEventHub();
    const preferenceStore = { replace: vi.fn(() => Promise.resolve()) };
    const runtimeById = new Map<
      string,
      ReturnType<typeof fakeRuntime>
    >();
    const service = new PiSessionService(hub, {
      agentDir: integrationAgentDir,
      sessionManager: gateway,
      modelRuntime: testModelRuntime,
      createAgentRuntime: (_createRuntime, options) => {
        const manager = options.sessionManager;
        const settingsManager = SettingsManager.inMemory({
          defaultProvider: DEFAULT_SELECTION.model.provider,
          defaultModel: DEFAULT_SELECTION.model.id,
          defaultThinkingLevel: "medium",
        });
        const runtime = fakeRuntime(manager.getSessionId(), {
          sessionFile: manager.getSessionFile(),
          sessionManager: manager,
          settingsManager,
          model: runtimeModel(
            DEFAULT_SELECTION.model.provider,
            DEFAULT_SELECTION.model.id
          ),
          thinkingLevel: "medium",
          modelRuntime: testModelRuntime,
          scopedModels: [
            {
              model: runtimeModel(
                DEFAULT_SELECTION.model.provider,
                DEFAULT_SELECTION.model.id
              ),
            },
            {
              model: runtimeModel(
                ADVANCED_SELECTION.model.provider,
                ADVANCED_SELECTION.model.id
              ),
            },
          ],
          setModel: (model) => {
            runtime.session.model = model;
            settingsManager.setDefaultModelAndProvider(
              model.provider,
              model.id
            );
            return Promise.resolve();
          },
          setThinkingLevel: (level) => {
            const previous = runtime.session.thinkingLevel;
            runtime.session.thinkingLevel = level;
            if (level !== previous) {
              settingsManager.setDefaultThinkingLevel(
                piThinkingLevel(level)
              );
              runtime.emit({ type: "thinking_level_changed", level });
            }
          },
          getAvailableThinkingLevels: () => [
            "off",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
          ],
        });
        runtimeById.set(manager.getSessionId(), runtime);
        return Promise.resolve(runtime.runtime);
      },
      modelTierRegistry: {
        resolve: (tier) => ({
          tier,
          model: runtimeModel(
            ADVANCED_SELECTION.model.provider,
            ADVANCED_SELECTION.model.id
          ),
          thinkingLevel: ADVANCED_SELECTION.thinkingLevel,
        }),
        validate: () => ({ valid: true }),
      },
      starterModelPolicyPreferenceStore: preferenceStore,
      heartbeatIntervalMs: 60_000,
    });
    services.push(service);
    const initialPolicy = {
      mode: "tiered",
      exact: DEFAULT_SELECTION,
      tier: "advanced",
    } as const;
    const publicationChecks: string[] = [];
    const publishGlobal = hub.publishGlobal.bind(hub);
    vi.spyOn(hub, "publishGlobal").mockImplementation((event) => {
      if (event.type === "status.update" || event.type === "session.created") {
        const runtime = runtimeById.values().next().value;
        if (runtime === undefined)
          throw new Error("Expected a runtime before publication");
        const sessionFile = runtime.session.sessionFile;
        if (sessionFile === undefined)
          throw new Error("Expected a session file before publication");
        expect(existsSync(sessionFile)).toBe(true);
        const reopened = gateway.open(sessionFile);
        const entries = reopened.getEntries?.() ?? reopened.getBranch();
        expect(
          inspectSessionModelPolicy(entries, DEFAULT_SELECTION)
        ).toMatchObject({ kind: "persisted", policy: initialPolicy });
        const source = inspectSessionCreationSource(entries);
        expect(source).toMatchObject({
          kind: "valid",
          source: "session-list-plus",
          origin: {
            sessionId: reopened.getSessionId(),
            sessionFile,
          },
        });
        const header = reopened.getHeader?.();
        if (header?.id === undefined)
          throw new Error("Expected a reopened session header");
        expect(
          inspectSessionCreationRootEligibility(source, {
            sessionId: header.id,
            sessionFile,
            ...(header.parentSession === undefined
              ? {}
              : { parentSession: header.parentSession }),
          })
        ).toEqual({ kind: "eligible" });
        publicationChecks.push(event.type);
      }
      publishGlobal(event);
    });

    const created = await service.start(integrationCwd, {
      creationSource: "session-list-plus",
      initialModelPolicy: initialPolicy,
    });

    expect(created.persisted).toBe(true);
    expect(publicationChecks).toEqual(["status.update", "session.created"]);
    await expect(
      service.rememberCurrentModelPolicy({
        id: created.id,
        cwd: integrationCwd,
      })
    ).resolves.toEqual(initialPolicy);
    expect(preferenceStore.replace).toHaveBeenCalledOnce();
  });
});

describe("PiSessionService model policy mutation", () => {
  const ref = () => sessionRef(TEST_SESSION_ID, TEST_CWD);
  const exactEntry = (selection: ExactModelSelection = DEFAULT_SELECTION, tier?: ModelTier) => policyEntry({
    version: 1,
    mode: "exact",
    exact: selection,
    ...(tier === undefined ? {} : { tier }),
  });

  it("leaves the confirmed runtime and policy unchanged when remembering the policy fails", async () => {
    const preferenceStore = {
      replace: vi.fn(() => Promise.reject(new Error("preference store unavailable"))),
    };
    const harness = createModelPolicyHarness({
      branch: [creationSourceEntry(), exactEntry(DEFAULT_SELECTION, "advanced")],
      preferenceStore,
    });
    const before = await harness.service.modelPolicy(ref());
    if (before.policy === undefined) throw new Error("expected a confirmed model policy");
    const branchReadsBeforeRemember = harness.getBranch.mock.calls.length;
    harness.calls.length = 0;

    await expect(harness.service.rememberCurrentModelPolicy(ref()))
      .rejects.toThrow("preference store unavailable");

    expect(harness.getBranch).toHaveBeenCalledTimes(branchReadsBeforeRemember + 1);
    const after = await harness.service.modelPolicy(ref());
    expect(after).toEqual(before);
    expect(after.policy).toEqual({
      mode: "exact",
      exact: DEFAULT_SELECTION,
      tier: "advanced",
    } satisfies StarterModelPolicyPreference);
    expect(harness.calls).toEqual([]);
    expect(preferenceStore.replace).toHaveBeenCalledWith(TEST_CWD, {
      kind: "full",
      preference: before.policy,
    });
  });

  it("rejects remember for an in-memory plus root whose JSONL is absent", async () => {
    const preferenceStore = { replace: vi.fn(() => Promise.resolve()) };
    const harness = createModelPolicyHarness({
      branch: [creationSourceEntry(), exactEntry()],
      persistedFile: false,
      preferenceStore,
    });

    await expect(harness.service.rememberCurrentModelPolicy(ref()))
      .rejects.toThrow(/durably persisted/u);

    expect(preferenceStore.replace).not.toHaveBeenCalled();
  });

  it("rejects remember for a parented session with a copied plus marker", async () => {
    const preferenceStore = { replace: vi.fn(() => Promise.resolve()) };
    const harness = createModelPolicyHarness({
      branch: [creationSourceEntry(), exactEntry()],
      parentSession: "/sessions/parent.jsonl",
      preferenceStore,
    });

    await expect(harness.service.rememberCurrentModelPolicy(ref()))
      .rejects.toThrow(/top-level root/u);

    expect(preferenceStore.replace).not.toHaveBeenCalled();
  });

  it("rejects remember when a copied marker origin does not match the opened root", async () => {
    const preferenceStore = { replace: vi.fn(() => Promise.resolve()) };
    const harness = createModelPolicyHarness({
      branch: [
        creationSourceEntry({
          version: 2,
          source: "session-list-plus",
          origin: {
            sessionId: "different-root",
            sessionFile: "/imports/different-root.jsonl",
          },
        }),
        exactEntry(),
      ],
      preferenceStore,
    });

    await expect(harness.service.rememberCurrentModelPolicy(ref()))
      .rejects.toThrow(/top-level root/u);

    expect(preferenceStore.replace).not.toHaveBeenCalled();
  });

  it("applies a Tiered policy as model, then thinking, then persistence", async () => {
    const harness = createModelPolicyHarness({ branch: [exactEntry()] });
    await harness.service.status(ref());
    harness.calls.length = 0;

    const response = await harness.service.setModelPolicy(ref(), { mode: "tiered", tier: "advanced" });

    expect(harness.calls).toEqual([
      "setModel:openai/gpt-advanced",
      "setThinkingLevel:high",
      `appendCustomEntry:${SESSION_MODEL_POLICY_CUSTOM_TYPE}`,
    ]);
    expect(harness.appendCustomEntry).toHaveBeenLastCalledWith(SESSION_MODEL_POLICY_CUSTOM_TYPE, {
      version: 1,
      mode: "tiered",
      exact: DEFAULT_SELECTION,
      tier: "advanced",
    });
    expect(response.policy).toEqual({ mode: "tiered", exact: DEFAULT_SELECTION, tier: "advanced" });
    expect(response.session.modelPolicy).toEqual({
      mode: "tiered",
      tier: "advanced",
      resolved: ADVANCED_SELECTION,
      ladderValid: true,
    });
  });

  it("rejects a tier whose thinking level the incoming model does not support before any setter runs", async () => {
    const harness = createModelPolicyHarness({
      branch: [exactEntry()],
      scopedModels: [
        { provider: "openai", id: "gpt-default", reasoning: true },
        { provider: "openai", id: "gpt-advanced" },
      ],
    });
    await harness.service.status(ref());
    harness.calls.length = 0;

    await expect(harness.service.setModelPolicy(ref(), { mode: "tiered", tier: "advanced" }))
      .rejects.toThrow(/unsupported by openai\/gpt-advanced/iu);

    expect(harness.calls).toEqual([]);
    expect((await harness.service.status(ref())).modelPolicy).toMatchObject({
      mode: "exact",
      resolved: DEFAULT_SELECTION,
    });
  });

  it("initializes an explicit Tiered root before session.created and before its first prompt", async () => {
    const harness = createModelPolicyHarness({ existing: false });

    await harness.service.start(TEST_CWD, { modelPolicy: { mode: "tiered", tier: "advanced" } });

    expect(harness.appendCustomEntry).toHaveBeenCalledOnce();
    expect(harness.appendCustomEntry).toHaveBeenCalledWith(SESSION_MODEL_POLICY_CUSTOM_TYPE, {
      version: 1,
      mode: "tiered",
      // The root's original runtime tuple is remembered as its Exact branch.
      exact: DEFAULT_SELECTION,
      tier: "advanced",
    });
    expect(harness.calls).toEqual([
      "setModel:openai/gpt-advanced",
      "setThinkingLevel:high",
      `appendCustomEntry:${SESSION_MODEL_POLICY_CUSTOM_TYPE}`,
    ]);
    const appendIndex = harness.operations.indexOf(`appendCustomEntry:${SESSION_MODEL_POLICY_CUSTOM_TYPE}`);
    expect(harness.operations.indexOf("global:session.created")).toBeGreaterThan(appendIndex);

    await harness.service.prompt(ref(), "hello");
    await vi.waitFor(() => { expect(harness.prompt).toHaveBeenCalledOnce(); });
    expect(harness.operations.indexOf("prompt")).toBeGreaterThan(appendIndex);
  });

  it("restores the prior model and thinking pair when policy persistence fails", async () => {
    const harness = createModelPolicyHarness({ branch: [exactEntry()], append: "throws" });
    await harness.service.status(ref());
    harness.calls.length = 0;

    await expect(harness.service.setModelPolicy(ref(), { mode: "tiered", tier: "advanced" }))
      .rejects.toThrow("model policy persistence failed");

    expect(harness.calls).toEqual([
      "setModel:openai/gpt-advanced",
      "setThinkingLevel:high",
      `appendCustomEntry:${SESSION_MODEL_POLICY_CUSTOM_TYPE}`,
      "setModel:openai/gpt-default",
      "setThinkingLevel:medium",
    ]);
    const status = await harness.service.status(ref());
    expect(status.modelPolicy).toEqual({ mode: "exact", resolved: DEFAULT_SELECTION, ladderValid: true });
  });

  it("treats pi's silent thinking clamp as a failed transition and restores the prior pair", async () => {
    const harness = createModelPolicyHarness({ branch: [exactEntry()], clampThinkingTo: "medium" });
    await harness.service.status(ref());
    harness.calls.length = 0;

    await expect(harness.service.setModelPolicy(ref(), { mode: "tiered", tier: "advanced" }))
      .rejects.toThrow(/thinking/iu);

    expect(harness.calls).toEqual([
      "setModel:openai/gpt-advanced",
      "setThinkingLevel:high",
      "setModel:openai/gpt-default",
      "setThinkingLevel:medium",
    ]);
    expect(harness.appendCustomEntry).not.toHaveBeenCalled();
  });

  it("blocks prompts when a failed application cannot prove restoration", async () => {
    const harness = createModelPolicyHarness({
      branch: [exactEntry()],
      append: "throws",
      failSetModelOnCall: 2,
    });
    await harness.service.status(ref());

    await expect(harness.service.setModelPolicy(ref(), { mode: "tiered", tier: "advanced" }))
      .rejects.toThrow("model policy persistence failed");

    const status = await harness.service.status(ref());
    expect(status.modelPolicy?.blockedReason).toMatch(/^MODEL_POLICY_BLOCKED: /u);

    await expect(harness.service.prompt(ref(), "must not reach pi")).rejects.toThrow(/MODEL_POLICY_BLOCKED/u);
    expect(harness.prompt).not.toHaveBeenCalled();
  });

  it("rejects policy mutation on an archived session before any setter runs", async () => {
    const harness = createModelPolicyHarness({ branch: [exactEntry()], archived: true });

    await expect(harness.service.setModelPolicy(ref(), { mode: "tiered", tier: "advanced" }))
      .rejects.toThrow(/Archived sessions are read-only/u);

    expect(harness.calls).toEqual([]);
  });

  it("rejects policy mutation while the session has active work", async () => {
    const harness = createModelPolicyHarness({ branch: [exactEntry()] });
    await harness.service.status(ref());
    harness.fake.session.isStreaming = true;
    harness.calls.length = 0;

    await expect(harness.service.setModelPolicy(ref(), { mode: "tiered", tier: "advanced" }))
      .rejects.toThrow(/Stop current session activity/u);

    expect(harness.calls).toEqual([]);
  });

  it("rejects direct Exact model and thinking routes while Tiered is active", async () => {
    const harness = createModelPolicyHarness({
      branch: [policyEntry({ version: 1, mode: "tiered", exact: DEFAULT_SELECTION, tier: "advanced" })],
    });
    await harness.service.status(ref());
    harness.calls.length = 0;

    await expect(harness.service.setModel(ref(), "openai", "gpt-advanced")).rejects.toThrow(/Tiered/u);
    await expect(harness.service.cycleModel(ref(), "forward")).rejects.toThrow(/Tiered/u);
    await expect(harness.service.setThinkingLevel(ref(), "high")).rejects.toThrow(/Tiered/u);
    await expect(harness.service.cycleThinkingLevel(ref())).rejects.toThrow(/Tiered/u);

    expect(harness.calls).toEqual([]);
  });

  it("records pi's confirmed effective tuple for Exact model, cycle, and thinking routes", async () => {
    const harness = createModelPolicyHarness({ branch: [exactEntry(DEFAULT_SELECTION, "advanced")] });
    await harness.service.status(ref());
    harness.calls.length = 0;

    // gpt-basic has no reasoning support, so pi clamps thinking to "off" while
    // switching models. The recorded policy must be that confirmed pair.
    await harness.service.setModel(ref(), "openai", "gpt-basic");
    expect(harness.appendCustomEntry).toHaveBeenLastCalledWith(SESSION_MODEL_POLICY_CUSTOM_TYPE, {
      version: 1,
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-basic" }, thinkingLevel: "off" },
      tier: "advanced",
    });

    await harness.service.cycleModel(ref(), "forward");
    expect(harness.appendCustomEntry).toHaveBeenLastCalledWith(SESSION_MODEL_POLICY_CUSTOM_TYPE, {
      version: 1,
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "off" },
      tier: "advanced",
    });

    await harness.service.setThinkingLevel(ref(), "high");
    expect(harness.appendCustomEntry).toHaveBeenLastCalledWith(SESSION_MODEL_POLICY_CUSTOM_TYPE, {
      version: 1,
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "high" },
      tier: "advanced",
    });

    await harness.service.cycleThinkingLevel(ref());
    const level = harness.fake.session.thinkingLevel;
    expect(harness.appendCustomEntry).toHaveBeenLastCalledWith(SESSION_MODEL_POLICY_CUSTOM_TYPE, {
      version: 1,
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: level },
      tier: "advanced",
    });
    expect((await harness.service.modelPolicy(ref())).policy).toEqual({
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: level },
      tier: "advanced",
    });
  });

  it("restores the pre-route tuple when an Exact route cannot persist its policy", async () => {
    const harness = createModelPolicyHarness({ branch: [exactEntry()], append: "throws" });
    await harness.service.status(ref());
    harness.calls.length = 0;

    await expect(harness.service.setModel(ref(), "openai", "gpt-basic"))
      .rejects.toThrow("model policy persistence failed");

    expect(harness.calls).toEqual([
      "setModel:openai/gpt-basic",
      `appendCustomEntry:${SESSION_MODEL_POLICY_CUSTOM_TYPE}`,
      "setModel:openai/gpt-default",
      "setThinkingLevel:medium",
    ]);
    expect((await harness.service.status(ref())).modelPolicy).toEqual({
      mode: "exact",
      resolved: DEFAULT_SELECTION,
      ladderValid: true,
    });
  });

  it("repairs an invalid newest entry and clears a blocked runtime through an explicit Exact update", async () => {
    const harness = createModelPolicyHarness({
      branch: [exactEntry(), policyEntry({ version: 99 })],
      append: "throwsOnce",
      failSetModelOnCall: 2,
    });

    await expect(harness.service.setModelPolicy(ref(), { mode: "tiered", tier: "advanced" }))
      .rejects.toThrow("model policy persistence failed");
    expect((await harness.service.status(ref())).modelPolicy?.blockedReason).toMatch(/^MODEL_POLICY_BLOCKED: /u);

    const repaired = await harness.service.setModelPolicy(ref(), { mode: "exact", exact: ADVANCED_SELECTION });

    expect(repaired.policy).toEqual({ mode: "exact", exact: ADVANCED_SELECTION });
    expect(repaired.session.modelPolicy).toEqual({
      mode: "exact",
      resolved: ADVANCED_SELECTION,
      ladderValid: true,
    });
    await harness.service.prompt(ref(), "now allowed");
    await vi.waitFor(() => { expect(harness.prompt).toHaveBeenCalledOnce(); });
  });

  it("blocks a compaction-queued prompt whose policy entry became invalid while it waited", async () => {
    const harness = createModelPolicyHarness({ branch: [exactEntry()] });
    await harness.service.status(ref());
    harness.fake.session.isCompacting = true;

    await harness.service.prompt(ref(), "queued during compaction");
    expect(harness.prompt).not.toHaveBeenCalled();

    harness.branch.push(policyEntry({ version: 99 }));
    harness.fake.session.isCompacting = false;
    harness.fake.emit({ type: "compaction_end" });

    await vi.waitFor(() => {
      expect(harness.hub.sessionEvents.some(({ event }) => event.type === "session.error")).toBe(true);
    });
    expect(harness.prompt).not.toHaveBeenCalled();
  });
});

describe("PiSessionService model policy mutation safety", () => {
  const ref = () => sessionRef(TEST_SESSION_ID, TEST_CWD);
  const exactEntry = (selection: ExactModelSelection = DEFAULT_SELECTION) => policyEntry({
    version: 1,
    mode: "exact",
    exact: selection,
  });

  it("rejects a policy transition when a prompt starts while the target is being resolved", async () => {
    // The refresh hook runs inside the awaited target resolution, i.e. after the
    // entry idle guard and before the first setter. The holder lets the hook reach
    // the harness the same statement creates.
    const holder: { session?: PiAgentSession } = {};
    const harness = createModelPolicyHarness({
      branch: [exactEntry()],
      onModelRuntimeRefresh: () => {
        if (holder.session !== undefined) holder.session.isStreaming = true;
      },
    });
    holder.session = harness.fake.session;
    await harness.service.status(ref());
    harness.calls.length = 0;

    await expect(harness.service.setModelPolicy(ref(), { mode: "tiered", tier: "advanced" }))
      .rejects.toThrow(/Stop current session activity/u);

    // No setter ran, so the runtime tuple and the persisted policy are untouched.
    expect(harness.calls.filter((call) => !call.startsWith("appendCustomEntry"))).toEqual([]);
    expect(harness.appendCustomEntry).not.toHaveBeenCalled();
    harness.fake.session.isStreaming = false;
    expect((await harness.service.status(ref())).modelPolicy).toEqual({
      mode: "exact",
      resolved: DEFAULT_SELECTION,
      ladderValid: true,
    });
  });

  it("still applies a transition when the only active work is the policy mutation itself", async () => {
    // Guards must not treat their own serialized entry mutation as a conflict,
    // and tree navigation must keep its own specific message.
    const harness = createModelPolicyHarness({ branch: [exactEntry()] });
    await harness.service.status(ref());
    harness.calls.length = 0;

    const response = await harness.service.setModelPolicy(ref(), { mode: "tiered", tier: "advanced" });

    expect(response.policy).toEqual({ mode: "tiered", exact: DEFAULT_SELECTION, tier: "advanced" });
    expect(harness.calls).toEqual([
      "setModel:openai/gpt-advanced",
      "setThinkingLevel:high",
      `appendCustomEntry:${SESSION_MODEL_POLICY_CUSTOM_TYPE}`,
    ]);
  });

  it("publishes one blocked status after a failed transition and before the route error", async () => {
    const harness = createModelPolicyHarness({
      branch: [exactEntry()],
      append: "throws",
      failSetModelOnCall: 2,
    });
    await harness.service.status(ref());
    harness.hub.sessionEvents.length = 0;
    harness.hub.globalEvents.length = 0;

    await expect(harness.service.setModelPolicy(ref(), { mode: "tiered", tier: "advanced" }))
      .rejects.toThrow("model policy persistence failed");

    const activities = harness.hub.sessionEvents.filter(({ event }) => event.type === "activity.update");
    const statuses = harness.hub.sessionEvents.filter(({ event }) => event.type === "status.update");
    // Exactly one failure activity and one status: no success is published, and
    // nothing is published between the setters.
    expect(activities).toHaveLength(1);
    expect(activities[0]?.event).toMatchObject({ type: "activity.update", activity: { phase: "error" } });
    expect(statuses).toHaveLength(1);
    const status = statuses[0]?.event;
    if (status?.type !== "status.update") throw new Error("expected a status.update event");
    expect(status.status.modelPolicy?.blockedReason).toMatch(/^MODEL_POLICY_BLOCKED: /u);
  });

  it("publishes a blocked status when an Exact route cannot persist and cannot restore", async () => {
    const harness = createModelPolicyHarness({
      branch: [exactEntry()],
      append: "throws",
      failSetModelOnCall: 2,
    });
    await harness.service.status(ref());
    harness.hub.sessionEvents.length = 0;

    await expect(harness.service.setModel(ref(), "openai", "gpt-advanced"))
      .rejects.toThrow("model policy persistence failed");

    const statuses = harness.hub.sessionEvents.filter(({ event }) => event.type === "status.update");
    expect(statuses).toHaveLength(1);
    const status = statuses[0]?.event;
    if (status?.type !== "status.update") throw new Error("expected a status.update event");
    expect(status.status.modelPolicy?.blockedReason).toMatch(/^MODEL_POLICY_BLOCKED: /u);
  });

  it("publishes nothing extra when a policy target is rejected before any setter", async () => {
    const harness = createModelPolicyHarness({
      branch: [exactEntry()],
      scopedModels: [
        { provider: "openai", id: "gpt-default", reasoning: true },
        { provider: "openai", id: "gpt-advanced" },
      ],
    });
    await harness.service.status(ref());
    harness.hub.sessionEvents.length = 0;

    await expect(harness.service.setModelPolicy(ref(), { mode: "tiered", tier: "advanced" }))
      .rejects.toThrow(/unsupported by openai\/gpt-advanced/iu);

    expect(harness.hub.sessionEvents).toEqual([]);
  });

  it("keeps an unproven runtime block after the session is closed and reopened", async () => {
    const harness = createModelPolicyHarness({
      branch: [exactEntry()],
      append: "throws",
      failSetModelOnCall: 2,
    });
    await harness.service.status(ref());

    await expect(harness.service.setModelPolicy(ref(), { mode: "tiered", tier: "advanced" }))
      .rejects.toThrow("model policy persistence failed");
    expect((await harness.service.status(ref())).modelPolicy?.blockedReason).toMatch(/^MODEL_POLICY_BLOCKED: /u);

    // Reload closes the runtime and reopens the session from disk. The persisted
    // entry is valid, so nothing in the reopened session's own state proves the
    // ambiguous tuple was repaired.
    const reopened = fakeRuntime(TEST_SESSION_ID, {
      model: runtimeModel("openai", "gpt-advanced"),
      thinkingLevel: "high",
      sessionManager: harness.manager,
      scopedModels: [{ model: runtimeModel("openai", "gpt-advanced") }],
    });
    harness.useNextRuntime(reopened.runtime);
    await harness.service.reload(ref());

    const status = await harness.service.status(ref());
    expect(status.modelPolicy?.blockedReason).toMatch(/^MODEL_POLICY_BLOCKED: /u);
    await expect(harness.service.prompt(ref(), "must not reach pi after reload"))
      .rejects.toThrow(/MODEL_POLICY_BLOCKED/u);
    expect(reopened.calls.prompt).toEqual([]);
  });

  it("repairs a reopened blocked session through an explicit policy application", async () => {
    // The block deliberately survives reopen (see the test above): a fresh runtime
    // proves nothing about the tuple that became ambiguous. What must stay true is
    // that the block is *repairable* after reopen rather than terminal, so a
    // reopened session is never permanently unable to prompt.
    const harness = createModelPolicyHarness({
      branch: [exactEntry()],
      append: "throwsOnce",
      failSetModelOnCall: 2,
    });
    await harness.service.status(ref());

    await expect(harness.service.setModelPolicy(ref(), { mode: "tiered", tier: "advanced" }))
      .rejects.toThrow("model policy persistence failed");
    expect((await harness.service.status(ref())).modelPolicy?.blockedReason).toMatch(/^MODEL_POLICY_BLOCKED: /u);

    const reopened = fakeRuntime(TEST_SESSION_ID, {
      model: runtimeModel(DEFAULT_SELECTION.model.provider, DEFAULT_SELECTION.model.id),
      thinkingLevel: "medium",
      sessionManager: harness.manager,
      scopedModels: [
        { model: runtimeModel(DEFAULT_SELECTION.model.provider, DEFAULT_SELECTION.model.id) },
        { model: runtimeModel(ADVANCED_SELECTION.model.provider, ADVANCED_SELECTION.model.id) },
      ],
      // The default stub's setters are inert; the repair needs a runtime that
      // actually adopts the requested pair so the application can be confirmed.
      setModel: (model: NonNullable<PiAgentSession["model"]>) => {
        reopened.session.model = model;
        return Promise.resolve();
      },
      setThinkingLevel: (level: PiAgentSession["thinkingLevel"]) => {
        reopened.session.thinkingLevel = level;
      },
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- pi's level set, narrowed for the stub session.
      getAvailableThinkingLevels: () => [...runtimeThinkingLevels(reopened.session.model)] as PiAgentSession["thinkingLevel"][],
    });
    harness.useNextRuntime(reopened.runtime);
    await harness.service.reload(ref());
    expect((await harness.service.status(ref())).modelPolicy?.blockedReason).toMatch(/^MODEL_POLICY_BLOCKED: /u);

    // blockedReason never disables mutation, so an explicit application still runs
    // and clears the block once a tuple is confirmed again.
    const repaired = await harness.service.setModelPolicy(ref(), { mode: "exact", exact: ADVANCED_SELECTION });

    expect(repaired.session.modelPolicy).toEqual({
      mode: "exact",
      resolved: ADVANCED_SELECTION,
      ladderValid: true,
    });
    await harness.service.prompt(ref(), "allowed after repair");
    await vi.waitFor(() => { expect(reopened.calls.prompt).toHaveLength(1); });
  });

  it("keeps an unproven runtime block across a runtime rebind", async () => {
    const harness = createModelPolicyHarness({
      branch: [exactEntry()],
      append: "throws",
      failSetModelOnCall: 2,
    });
    await harness.service.status(ref());

    await expect(harness.service.setModelPolicy(ref(), { mode: "tiered", tier: "advanced" }))
      .rejects.toThrow("model policy persistence failed");

    // A rebind installs a different session object for the same session id. The
    // replacement's own state says nothing about the ambiguous tuple, so the
    // status it publishes must still carry the block.
    const replacement = fakeRuntime(TEST_SESSION_ID, {
      model: runtimeModel("openai", "gpt-advanced"),
      thinkingLevel: "high",
      sessionManager: harness.manager,
    });
    await harness.rebind(replacement.session);
    harness.hub.globalEvents.length = 0;
    replacement.emit({ type: "message_update" });

    const statusEvent = [...harness.hub.globalEvents].reverse().find((event) => event.type === "status.update");
    if (statusEvent?.type !== "status.update") throw new Error("expected a status.update event");
    expect(statusEvent.status.modelPolicy?.blockedReason).toMatch(/^MODEL_POLICY_BLOCKED: /u);
    await expect(harness.service.prompt(ref(), "must not reach pi after rebind"))
      .rejects.toThrow(/MODEL_POLICY_BLOCKED/u);
    expect(replacement.calls.prompt).toEqual([]);
  });

  it("retains an immediate prompt while a policy mutation is in flight and submits the confirmed pair", async () => {
    const harness = createModelPolicyHarness({ branch: [exactEntry()], holdSetModelOnCall: 1 });
    await harness.service.status(ref());
    harness.calls.length = 0;

    const applied = harness.service.setModelPolicy(ref(), { mode: "tiered", tier: "advanced" });
    await vi.waitFor(() => { expect(harness.calls).toContain("setModel:openai/gpt-advanced"); });

    // The advanced model is selected but its thinking level is not applied yet:
    // the transient pair no prompt may observe.
    expect(harness.fake.session.model?.id).toBe("gpt-advanced");
    expect(harness.fake.session.thinkingLevel).toBe("medium");
    await harness.service.prompt(ref(), "must not observe partial policy state");
    expect(harness.prompt).not.toHaveBeenCalled();

    harness.releaseSetModel();
    await applied;

    await vi.waitFor(() => { expect(harness.prompt).toHaveBeenCalledOnce(); });
    // Persistence completed before the prompt reached pi, and the pair pi saw is
    // the confirmed one.
    expect(harness.calls.indexOf(`appendCustomEntry:${SESSION_MODEL_POLICY_CUSTOM_TYPE}`))
      .toBeLessThan(harness.calls.indexOf("prompt"));
    expect(harness.fake.session.model?.id).toBe("gpt-advanced");
    expect(harness.fake.session.thinkingLevel).toBe("high");
  });

  it("never publishes an intermediate resolved pair for a status emitted mid-transition", async () => {
    // setModel has landed the incoming model but setThinkingLevel has not run, so
    // the live runtime tuple is the pair (incoming model, outgoing thinking level)
    // that was never requested and never persisted. An unrelated runtime event
    // publishing a status inside that window must not report it as `resolved`.
    const harness = createModelPolicyHarness({ branch: [exactEntry()], holdSetModelOnCall: 1 });
    await harness.service.status(ref());

    const applied = harness.service.setModelPolicy(ref(), { mode: "tiered", tier: "advanced" });
    await vi.waitFor(() => { expect(harness.calls).toContain("setModel:openai/gpt-advanced"); });
    expect(harness.fake.session.model?.id).toBe("gpt-advanced");
    expect(harness.fake.session.thinkingLevel).toBe("medium");

    harness.hub.sessionEvents.length = 0;
    harness.hub.globalEvents.length = 0;
    harness.fake.emit({ type: "message_update" });

    const midTransition = harness.hub.sessionEvents
      .filter(({ event }) => event.type === "status.update")
      .map(({ event }) => (event.type === "status.update" ? event.status.modelPolicy : undefined));
    expect(midTransition.length).toBeGreaterThan(0);
    for (const policy of midTransition) {
      // The last confirmed tuple, not the half-applied one.
      expect(policy?.resolved).toEqual(DEFAULT_SELECTION);
      expect(policy?.mode).toBe("exact");
    }

    harness.releaseSetModel();
    await applied;

    // Once the transition settles, `resolved` reports the newly confirmed pair.
    expect((await harness.service.status(ref())).modelPolicy).toEqual({
      mode: "tiered",
      tier: "advanced",
      resolved: ADVANCED_SELECTION,
      ladderValid: true,
    });
  });

  it("holds a delayed queue drain during a policy mutation and refuses the prompt when it blocks", async () => {
    const harness = createModelPolicyHarness({
      branch: [exactEntry()],
      append: "throws",
      failSetModelOnCall: 2,
      holdSetModelOnCall: 1,
    });
    await harness.service.status(ref());

    const applied = harness.service.setModelPolicy(ref(), { mode: "tiered", tier: "advanced" });
    await vi.waitFor(() => { expect(harness.calls).toContain("setModel:openai/gpt-advanced"); });

    // Retained rather than submitted, so the input is not lost.
    await harness.service.prompt(ref(), "retained during the policy change");
    expect((await harness.service.status(ref())).queuedMessages).toHaveLength(1);

    // A drain scheduled by ordinary runtime events fires into the transient
    // window and must not submit the retained prompt.
    harness.fake.emit({ type: "agent_end" });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(harness.prompt).not.toHaveBeenCalled();

    harness.releaseSetModel();
    await expect(applied).rejects.toThrow("model policy persistence failed");

    // The transition left an unproven tuple, so the retained prompt is refused
    // rather than sent with an ambiguous model/thinking pair.
    await vi.waitFor(() => {
      expect(harness.hub.sessionEvents.some(({ event }) => event.type === "session.error")).toBe(true);
    });
    expect(harness.prompt).not.toHaveBeenCalled();
  });
});
