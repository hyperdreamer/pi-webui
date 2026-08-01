import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExactModelSelection } from "../../shared/apiTypes.js";
import { PiSessionService, type PiAgentSession } from "./piSessionService.js";
import { SESSION_MODEL_POLICY_CUSTOM_TYPE } from "./sessionModelPolicy.js";
import type { LadderValidation } from "./modelTierRegistry.js";
import {
  CapturingSessionEventHub,
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

interface ModelPolicyHarnessOptions {
  branch?: readonly unknown[];
  existing?: boolean;
  append?: "available" | "missing" | "throws";
  model?: PiAgentSession["model"];
  thinkingLevel?: PiAgentSession["thinkingLevel"];
  ladderValidation?: LadderValidation;
}

const services: PiSessionService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => service.dispose()));
});

function runtimeModel(provider: string, id: string): NonNullable<PiAgentSession["model"]> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub with the minimal surface the harness reads.
  return { provider, id } as NonNullable<PiAgentSession["model"]>;
}

function policyEntry(data: unknown): unknown {
  return { type: "custom", customType: SESSION_MODEL_POLICY_CUSTOM_TYPE, data };
}

function createModelPolicyHarness(options: ModelPolicyHarnessOptions = {}) {
  const branch = [...(options.branch ?? [])];
  const operations: string[] = [];
  const getBranch = vi.fn(() => branch);
  const appendCustomEntry = vi.fn((customType: string, data?: unknown) => {
    operations.push(`appendCustomEntry:${customType}`);
    if (options.append === "throws") throw new Error("model policy persistence failed");
    branch.push({ type: "custom", customType, data });
    return `entry-${String(branch.length)}`;
  });
  const prompt = vi.fn(() => {
    operations.push("prompt");
    return Promise.resolve();
  });
  const setModel = vi.fn(() => Promise.resolve(undefined));
  const setThinkingLevel = vi.fn();
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub with the minimal surface the harness reads.
  const getAvailableThinkingLevels = vi.fn(() => ["off", "medium", "high"] as PiAgentSession["thinkingLevel"][]);
  const manager = fakeSessionManager(TEST_CWD, {
    getBranch,
    ...(options.append === "missing" ? { appendCustomEntry: undefined } : { appendCustomEntry }),
  });
  const fake = fakeRuntime(TEST_SESSION_ID, {
    model: options.model ?? runtimeModel(DEFAULT_SELECTION.model.provider, DEFAULT_SELECTION.model.id),
    thinkingLevel: options.thinkingLevel ?? "medium",
    sessionManager: manager,
    prompt,
    setModel,
    setThinkingLevel,
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
  const modelTierRegistry = {
    resolve: vi.fn(() => {
      throw new Error("tier resolution is not expected in Task 3");
    }),
    validate,
  };
  const existing = options.existing ?? true;
  const service = new PiSessionService(hub, {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    createAgentRuntime: () => Promise.resolve(fake.runtime),
    modelTierRegistry,
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
    fake,
    getBranch,
    hub,
    operations,
    prompt,
    rebind: async (session: PiAgentSession) => {
      if (rebindSession === undefined) throw new Error("runtime rebind callback was not installed");
      await rebindSession(session);
    },
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
