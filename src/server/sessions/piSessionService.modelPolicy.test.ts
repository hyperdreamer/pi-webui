import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExactModelSelection, ModelTier } from "../../shared/apiTypes.js";
import { PiSessionService, type PiAgentSession } from "./piSessionService.js";
import { SESSION_MODEL_POLICY_CUSTOM_TYPE } from "./sessionModelPolicy.js";
import { runtimeThinkingLevels, type LadderValidation } from "./modelTierRegistry.js";
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
  append?: "available" | "missing" | "throws" | "throwsOnce";
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
}

const DEFAULT_SCOPED_MODELS = [
  { provider: "openai", id: "gpt-default", reasoning: true },
  { provider: "openai", id: "gpt-advanced", reasoning: true },
  { provider: "openai", id: "gpt-basic" },
] as const;

const services: PiSessionService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => service.dispose()));
});

function runtimeModel(provider: string, id: string, reasoning = true): NonNullable<PiAgentSession["model"]> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub with the minimal surface the harness reads.
  return { provider, id, ...(reasoning ? { reasoning: true } : {}) } as NonNullable<PiAgentSession["model"]>;
}

function policyEntry(data: unknown): unknown {
  return { type: "custom", customType: SESSION_MODEL_POLICY_CUSTOM_TYPE, data };
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
    const failsOnce = options.append === "throwsOnce" && appendFailures === 0;
    if (options.append === "throws" || failsOnce) {
      appendFailures += 1;
      throw new Error("model policy persistence failed");
    }
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
  let setModelCalls = 0;
  const setModel = vi.fn((model: NonNullable<PiAgentSession["model"]>) => {
    setModelCalls += 1;
    calls.push(`setModel:${model.provider}/${model.id}`);
    operations.push(`setModel:${model.provider}/${model.id}`);
    if (options.failSetModelOnCall === setModelCalls) {
      return Promise.reject(new Error("runtime rejected the model change"));
    }
    fake.session.model = model;
    // pi re-clamps thinking against the incoming model while switching models.
    const levels = supportedLevels(model);
    if (!levels.includes(fake.session.thinkingLevel)) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- pi's level set, narrowed for the stub session.
      fake.session.thinkingLevel = (levels[0] ?? "off") as PiAgentSession["thinkingLevel"];
    }
    return Promise.resolve();
  });
  const setThinkingLevel = vi.fn((level: PiAgentSession["thinkingLevel"]) => {
    calls.push(`setThinkingLevel:${level}`);
    operations.push(`setThinkingLevel:${level}`);
    // pi clamps silently rather than failing; `clampThinkingTo` reproduces that.
    fake.session.thinkingLevel = options.clampThinkingTo ?? level;
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
  const manager = fakeSessionManager(TEST_CWD, {
    getBranch,
    ...(options.append === "missing" ? { appendCustomEntry: undefined } : { appendCustomEntry }),
  });
  const fake = fakeRuntime(TEST_SESSION_ID, {
    model: options.model ?? runtimeModel(DEFAULT_SELECTION.model.provider, DEFAULT_SELECTION.model.id),
    thinkingLevel: options.thinkingLevel ?? "medium",
    sessionManager: manager,
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
  const service = new PiSessionService(hub, {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    createAgentRuntime: () => Promise.resolve(fake.runtime),
    modelTierRegistry,
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
    },
    heartbeatIntervalMs: 60_000,
  });
  services.push(service);

  return {
    appendCustomEntry,
    branch,
    calls,
    fake,
    getBranch,
    hub,
    operations,
    prompt,
    rebind: async (session: PiAgentSession) => {
      if (rebindSession === undefined) throw new Error("runtime rebind callback was not installed");
      await rebindSession(session);
    },
    resolve,
    service,
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

describe("PiSessionService model policy mutation", () => {
  const ref = () => sessionRef(TEST_SESSION_ID, TEST_CWD);
  const exactEntry = (selection: ExactModelSelection = DEFAULT_SELECTION, tier?: ModelTier) => policyEntry({
    version: 1,
    mode: "exact",
    exact: selection,
    ...(tier === undefined ? {} : { tier }),
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
