import { createAssistantMessageEventStream, InMemoryCredentialStore, normalizeContext, type AssistantMessage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  DefaultResourceLoader,
  SessionManager,
  type SessionBeforeTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { MODEL_RATE_LIMITS_BLOCKED_MESSAGE, createModelRateLimitOwner, type ModelRateLimitOwner } from "../rateLimits/modelRateLimitOwner";
import { wrapModelStream } from "../rateLimits/modelRateLimitAdapters";
import {
  createFakeModelRateLimitClock,
  fixtureIdentity,
  fixtureLimits,
  fixtureSnapshot,
  fixtureTerminalMessage,
} from "../rateLimits/modelRateLimit.testSupport";
import { createDefaultRuntimeFactory } from "./piSessionService";
import { createTestModelRuntime, fakeAgentSessionServices, fakeRuntime, seedCredential, sessionGateway, testModel, TEST_MODEL_ID, TEST_MODEL_PROVIDER, testModelRuntime } from "./piSessionService.testSupport";

const TEST_AGENT_DIR = "/tmp/pi-webui-test-agent";
const identity = fixtureIdentity("anthropic", "demo-model");
const candidateIdentity = fixtureIdentity("anthropic", "utility-lightweight");

/** Catalog-typed model for StreamFn calls; `testModel()` is `Model<any>`. */
function catalogModel() {
  const model = testModelRuntime.getModel(TEST_MODEL_PROVIDER, TEST_MODEL_ID);
  if (model === undefined) throw new Error("test model not found");
  return model;
}

function completedStream(input: number): StreamFn {
  return (model) => {
    const stream = createAssistantMessageEventStream();
    const base = fixtureTerminalMessage({ api: model.api, provider: model.provider, model: model.id });
    const message: AssistantMessage = fixtureTerminalMessage({
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { ...base.usage, input, totalTokens: input },
    });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
  };
}

function makeFactory(owner: ModelRateLimitOwner, delegate: StreamFn) {
  const streamFunction = vi.fn<StreamFn>((model, context, options) => delegate(model, context, options));
  const fake = fakeRuntime("limited-session", { agent: { streamFunction } });
  const services = fakeAgentSessionServices();
  const createServices = vi.fn<typeof createAgentSessionServices>(() => Promise.resolve(services));
  // The SDK session class has private state; this host-surface fake is the tested adapter boundary.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const createdSession = fake.session as unknown as Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"];
  const createFromServices = vi.fn<typeof createAgentSessionFromServices>(() => Promise.resolve({
    session: createdSession,
    extensionsResult: services.resourceLoader.getExtensions(),
  }));
  return {
    streamFunction,
    createServices,
    factory: createDefaultRuntimeFactory(
      testModelRuntime,
      sessionGateway([]),
      { configuredCandidates: vi.fn().mockResolvedValue([]) },
      { info: vi.fn() },
      undefined,
      undefined,
      undefined,
      owner,
      { createServices, createFromServices },
    ),
  };
}

async function createRuntimeSession(factory: ReturnType<typeof createDefaultRuntimeFactory>) {
  return await factory({
    cwd: process.cwd(),
    agentDir: TEST_AGENT_DIR,
    sessionManager: SessionManager.inMemory(process.cwd()),
    delegationToolsEnabled: false,
  });
}

describe("PiSessionService rate limit integration", () => {
  it("shares one model budget across independently created sessions and charges once per call", async () => {
    const clock = createFakeModelRateLimitClock();
    const owner = createModelRateLimitOwner({ clock });
    owner.applySnapshot(fixtureSnapshot({ anthropic: { "demo-model": fixtureLimits(undefined, 1) } }), "accepted-document");
    const sessionA = makeFactory(owner, completedStream(0));
    const sessionB = makeFactory(owner, completedStream(0));
    const model = { ...testModel(), id: "demo-model" };
    const context = normalizeContext({ messages: [] });

    const first = await createRuntimeSession(sessionA.factory);
    const second = await createRuntimeSession(sessionB.factory);

    expect(first.session.agent.streamFunction).not.toBe(sessionA.streamFunction);
    await expect((await first.session.agent.streamFunction(model, context, {})).result()).resolves.toMatchObject({ stopReason: "stop" });
    const queued = (await second.session.agent.streamFunction(model, context, {})).result();
    expect(owner.pendingWaiterCount(identity)).toBe(1);
    clock.advance(60_000);
    await expect(queued).resolves.toMatchObject({ stopReason: "stop" });
    expect(sessionA.streamFunction).toHaveBeenCalledTimes(1);
    expect(sessionB.streamFunction).toHaveBeenCalledTimes(1);
  });

  it("re-wraps each replacement runtime without double wrapping", async () => {
    const clock = createFakeModelRateLimitClock();
    const owner = createModelRateLimitOwner({ clock });
    const sessionA = makeFactory(owner, completedStream(0));
    const sessionB = makeFactory(owner, completedStream(0));

    const first = await createRuntimeSession(sessionA.factory);
    const second = await createRuntimeSession(sessionB.factory);

    expect(first.session.agent.streamFunction).not.toBe(second.session.agent.streamFunction);
    expect(wrapModelStream(owner, first.session.agent.streamFunction)).toBe(first.session.agent.streamFunction);
    await expect((await first.session.agent.streamFunction(catalogModel(), normalizeContext({ messages: [] }), {})).result()).resolves.toMatchObject({ stopReason: "stop" });
    expect(sessionA.streamFunction).toHaveBeenCalledTimes(1);
  });

  it("charges the branch-summary utility candidate model", async () => {
    const credentials = new InMemoryCredentialStore();
    await seedCredential(credentials, "anthropic", { type: "api_key", key: "sk-test" });
    const modelRuntime = await createTestModelRuntime(credentials);
    const clock = createFakeModelRateLimitClock();
    const owner = createModelRateLimitOwner({ clock });
    owner.applySnapshot(fixtureSnapshot({ anthropic: { "utility-lightweight": fixtureLimits(5) } }), "accepted-document");
    const candidate = { ...testModel(), id: "utility-lightweight" };
    const streamFunction = vi.fn<StreamFn>(completedStream(5));
    const fake = fakeRuntime("utility-session", { agent: { streamFunction }, model: testModel() });
    const services = fakeAgentSessionServices();
    const createServices = vi.fn<typeof createAgentSessionServices>(() => Promise.resolve(services));
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const createdSession = fake.session as unknown as Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"];
    const createFromServices = vi.fn<typeof createAgentSessionFromServices>(() => Promise.resolve({
      session: createdSession,
      extensionsResult: services.resourceLoader.getExtensions(),
    }));
    const factory = createDefaultRuntimeFactory(
      modelRuntime,
      sessionGateway([]),
      { configuredCandidates: vi.fn().mockResolvedValue([{ model: candidate, thinkingLevel: "high", slot: "lightweight" }]) },
      { info: vi.fn() },
      undefined,
      undefined,
      undefined,
      owner,
      { createServices, createFromServices },
    );

    await createRuntimeSession(factory);

    const extensionFactories = createServices.mock.calls[0]?.[0].resourceLoaderOptions?.extensionFactories;
    if (extensionFactories === undefined) throw new Error("Expected utility extension factory");
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: TEST_AGENT_DIR,
      settingsManager: services.settingsManager,
      extensionFactories,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const beforeTree = loader.getExtensions().extensions[0]?.handlers.get("session_before_tree")?.[0];
    if (beforeTree === undefined) throw new Error("Expected utility tree handler");

    await beforeTree(treeEvent(), { model: testModel() });

    expect(streamFunction.mock.calls[0]?.[0]).toBe(candidate);
    const followUp = owner.acquire(candidateIdentity);
    expect(owner.pendingWaiterCount(candidateIdentity)).toBe(1);
    owner.dispose();
    await expect(followUp).resolves.toEqual({ status: "aborted" });
  });

  it("removes a queued stream waiter when the session call is aborted", async () => {
    const clock = createFakeModelRateLimitClock();
    const owner = createModelRateLimitOwner({ clock });
    owner.applySnapshot(fixtureSnapshot({ anthropic: { "demo-model": fixtureLimits(undefined, 1) } }), "accepted-document");
    const session = makeFactory(owner, completedStream(0));
    const runtime = await createRuntimeSession(session.factory);
    const model = { ...testModel(), id: "demo-model" };
    await owner.acquire(identity);
    const controller = new AbortController();

    const queued = (await runtime.session.agent.streamFunction(model, normalizeContext({ messages: [] }), { signal: controller.signal })).result();
    expect(owner.pendingWaiterCount(identity)).toBe(1);
    controller.abort();

    await expect(queued).resolves.toMatchObject({ stopReason: "aborted", errorMessage: "Request was aborted" });
    expect(owner.pendingWaiterCount(identity)).toBe(0);
    expect(session.streamFunction).not.toHaveBeenCalled();
  });

  it("fails sessions closed with the structured terminal when no snapshot was accepted", async () => {
    const owner = createModelRateLimitOwner({ clock: createFakeModelRateLimitClock() });
    owner.reportLoadFailure("models.json could not be parsed: bad");
    const session = makeFactory(owner, completedStream(0));
    const runtime = await createRuntimeSession(session.factory);

    const message = await (await runtime.session.agent.streamFunction(catalogModel(), normalizeContext({ messages: [] }), {})).result();

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe(`${MODEL_RATE_LIMITS_BLOCKED_MESSAGE} models.json could not be parsed: bad`);
    expect(session.streamFunction).not.toHaveBeenCalled();
  });
});

function treeEvent(): SessionBeforeTreeEvent {
  return {
    type: "session_before_tree",
    preparation: {
      targetId: "target-entry",
      oldLeafId: "branch-entry",
      commonAncestorId: null,
      entriesToSummarize: [{
        type: "custom_message",
        id: "branch-entry",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        customType: "rate-limit-test",
        content: "Verify utility routing",
        display: false,
      }],
      userWantsSummary: true,
    },
    signal: new AbortController().signal,
  };
}
