import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type SessionBeforeTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createDefaultRuntimeFactory, PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, createTestModelRuntime, fakeAgentSessionServices, fakeRuntime, runtimeCreator, seedCredential, sessionGateway, sessionRecord, sessionRef, TEST_MODEL_ID, TEST_MODEL_PROVIDER, testModel, testModelRuntime, type RuntimeCreator } from "./piSessionService.testSupport.js";
import type { ResolvedUtilityModel } from "./utilityModelResolver.js";

const TEST_AGENT_DIR = "/tmp/pi-webui-test-agent";

describe("PiSessionService prompt, queue, and auth warnings", () => {
  it("sends prompts to an injected runtime without touching the SDK runtime", async () => {
    const fake = fakeRuntime("prompt-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("prompt-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("prompt-session"), "Build the thing");

    expect(fake.calls.prompt).toEqual([{ text: "Build the thing", options: undefined }]);
    await service.dispose();
  });

  it("echoes the user message for direct prompts but not command-forwarded ones", async () => {
    const fake = fakeRuntime("echo-session", {
      resourceLoader: { getSkills: () => ({ skills: [{ name: "skill-creator" }] }) },
    });
    const hub = new CapturingSessionEventHub();
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("echo-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("echo-session"), "Build the thing");
    expect(hub.sessionEvents.filter(({ event }) => event.type === "message.append")).toHaveLength(1);

    // The client optimistically renders command-forwarded prompts (e.g. /skill:*),
    // so the server must not publish a second copy via message.append.
    await service.runCommand(sessionRef("echo-session"), "/skill:skill-creator");
    expect(hub.sessionEvents.filter(({ event }) => event.type === "message.append")).toHaveLength(1);
    expect(fake.calls.prompt).toEqual([
      { text: "Build the thing", options: undefined },
      { text: "/skill:skill-creator", options: undefined },
    ]);

    await service.dispose();
  });

  it("rejects malformed prompt text before opening the runtime", async () => {
    const fake = fakeRuntime("prompt-session");
    let createCalls = 0;
    const createAgentRuntime: RuntimeCreator = async () => {
      createCalls += 1;
      await Promise.resolve();
      return fake.runtime;
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime,
      sessionManager: sessionGateway([sessionRecord("prompt-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.prompt("prompt-session", undefined)).rejects.toThrow("Prompt text is required");

    expect(createCalls).toBe(0);
    expect(fake.calls.prompt).toEqual([]);
    await service.dispose();
  });

  it("uses the configured lightweight high level without changing active title state", async () => {
    const activeModel = testModel();
    const lightweightModel = { ...activeModel, id: "utility-lightweight" };
    const streamFn = vi.fn<StreamFn>((streamModel) => completedTitleStream(streamModel.id, "Fix login bug"));
    const hub = new CapturingSessionEventHub();
    const setModel = vi.fn(() => Promise.resolve());
    const setThinkingLevel = vi.fn();
    const fake = fakeRuntime("name-session", {
      model: activeModel,
      thinkingLevel: "high",
      setModel,
      setThinkingLevel,
      agent: { streamFunction: streamFn },
    });
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      utilityModelResolver: {
        configuredCandidates: vi.fn().mockResolvedValue([
          utilityCandidate(lightweightModel, "high"),
        ]),
      },
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("name-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("name-session"), "Please fix the login bug");
    await vi.waitFor(() => { expect(fake.session.sessionName).toBe("Fix login bug"); });

    expect(streamFn.mock.calls.map(([model]) => model)).toEqual([lightweightModel]);
    expect(streamFn.mock.calls[0]?.[2]).toMatchObject({ reasoning: "high" });
    expect(fake.session.model).toBe(activeModel);
    expect(fake.session.thinkingLevel).toBe("high");
    expect(setModel).not.toHaveBeenCalled();
    expect(setThinkingLevel).not.toHaveBeenCalled();
    expect(hub.sessionEvents.some(({ event }) => event.type === "session.name" && event.name === "Fix login bug")).toBe(true);
    await service.dispose();
  });

  it("falls back from a failed lightweight title model to the active model", async () => {
    const activeModel = testModel();
    const lightweightModel = { ...activeModel, id: "utility-lightweight" };
    const streamFn = vi.fn<StreamFn>((streamModel) => streamModel === lightweightModel
      ? failedTitleStream(streamModel.id)
      : completedTitleStream(streamModel.id, "Active model title"));
    const fake = fakeRuntime("fallback-name-session", { model: activeModel, agent: { streamFunction: streamFn } });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      utilityModelResolver: {
        configuredCandidates: vi.fn().mockResolvedValue([
          utilityCandidate(lightweightModel, "high"),
        ]),
      },
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("fallback-name-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("fallback-name-session"), "Please fix the login bug");
    await vi.waitFor(() => { expect(fake.session.sessionName).toBe("Active model title"); });

    expect(streamFn.mock.calls.map(([model]) => model)).toEqual([lightweightModel, activeModel]);
    expect(streamFn.mock.calls.map(([, , options]) => options?.reasoning)).toEqual([
      "high",
      "minimal",
    ]);
    expect(fake.session.model).toBe(activeModel);
    await service.dispose();
  });

  it("deduplicates a same-model title fallback with the same thinking level", async () => {
    const activeModel = testModel();
    const streamFn = vi.fn<StreamFn>((streamModel) => completedTitleStream(streamModel.id, "Shared title"));
    const fake = fakeRuntime("deduplicated-name-session", {
      model: activeModel,
      agent: { streamFunction: streamFn },
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      utilityModelResolver: {
        configuredCandidates: vi.fn().mockResolvedValue([
          utilityCandidate(activeModel, "minimal"),
        ]),
      },
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("deduplicated-name-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("deduplicated-name-session"), "Please fix the login bug");
    await vi.waitFor(() => { expect(fake.session.sessionName).toBe("Shared title"); });

    expect(streamFn).toHaveBeenCalledOnce();
    expect(streamFn.mock.calls[0]?.[0]).toBe(activeModel);
    expect(streamFn.mock.calls[0]?.[2]).toMatchObject({ reasoning: "minimal" });
    await service.dispose();
  });

  it("keeps a same-model title fallback when its thinking level differs", async () => {
    const activeModel = testModel();
    let attempts = 0;
    const streamFn = vi.fn<StreamFn>((streamModel) => {
      attempts += 1;
      return attempts === 1
        ? failedTitleStream(streamModel.id)
        : completedTitleStream(streamModel.id, "Minimal title");
    });
    const fake = fakeRuntime("level-distinct-name-session", {
      model: activeModel,
      agent: { streamFunction: streamFn },
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      utilityModelResolver: {
        configuredCandidates: vi.fn().mockResolvedValue([
          utilityCandidate(activeModel, "high"),
        ]),
      },
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("level-distinct-name-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("level-distinct-name-session"), "Please fix the login bug");
    await vi.waitFor(() => { expect(fake.session.sessionName).toBe("Minimal title"); });

    expect(streamFn.mock.calls.map(([model]) => model)).toEqual([activeModel, activeModel]);
    expect(streamFn.mock.calls.map(([, , options]) => options?.reasoning)).toEqual([
      "high",
      "minimal",
    ]);
    await service.dispose();
  });

  it("uses only the active model for a first-prompt title when no utility model is configured", async () => {
    const activeModel = testModel();
    const streamFn = vi.fn<StreamFn>((streamModel) => completedTitleStream(streamModel.id, "Active model title"));
    const fake = fakeRuntime("active-name-session", { model: activeModel, agent: { streamFunction: streamFn } });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      utilityModelResolver: {
        configuredCandidates: vi.fn().mockResolvedValue([]),
      },
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("active-name-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("active-name-session"), "Please fix the login bug");
    await vi.waitFor(() => { expect(fake.session.sessionName).toBe("Active model title"); });

    expect(streamFn.mock.calls.map(([model]) => model)).toEqual([activeModel]);
    expect(fake.session.model).toBe(activeModel);
    await service.dispose();
  });

  it("uses the narrowed active-model snapshot for first-prompt title fallback", async () => {
    const activeModel = testModel();
    const streamFn = vi.fn<StreamFn>((streamModel) => completedTitleStream(streamModel.id, "Snapshot model title"));
    const fake = fakeRuntime("snapshot-name-session", { agent: { streamFunction: streamFn } });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      utilityModelResolver: {
        configuredCandidates: vi.fn().mockResolvedValue([]),
      },
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("snapshot-name-session")]),
      heartbeatIntervalMs: 60_000,
    });
    await service.status(sessionRef("snapshot-name-session"));
    let modelReads = 0;
    Object.defineProperty(fake.session, "model", {
      configurable: true,
      get() {
        modelReads += 1;
        return modelReads === 3 ? undefined : activeModel;
      },
    });

    await service.prompt(sessionRef("snapshot-name-session"), "Please fix the login bug");
    Object.defineProperty(fake.session, "model", {
      configurable: true,
      value: activeModel,
      writable: true,
    });
    await vi.waitFor(() => { expect(fake.session.sessionName).toBe("Snapshot model title"); });

    expect(streamFn.mock.calls.map(([model]) => model)).toEqual([activeModel]);
    await service.dispose();
  });

  it("contains and logs failures from asynchronous title bookkeeping", async () => {
    const bookkeepingFailure = new Error("session name write failed");
    const logger = { info: vi.fn() };
    const activeModel = testModel();
    const streamFn = vi.fn<StreamFn>((streamModel) => completedTitleStream(streamModel.id, "Unused title"));
    const fake = fakeRuntime("failed-name-session", { model: activeModel, agent: { streamFunction: streamFn } });
    fake.session.setSessionName = () => { throw bookkeepingFailure; };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      logger,
      utilityModelResolver: {
        configuredCandidates: vi.fn().mockResolvedValue([]),
      },
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("failed-name-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("failed-name-session"), "Please fix the login bug");
    await vi.waitFor(() => {
      expect(logger.info).toHaveBeenCalledWith(
        {
          sessionId: "failed-name-session",
          error: "session name write failed",
        },
        "failed to apply generated session name",
      );
    });

    expect(fake.session.sessionName).toBeUndefined();
    await service.dispose();
  });

  it("names relay handoffs deterministically without resolving or calling a model", async () => {
    const configuredCandidates = vi.fn(() => Promise.resolve([
      utilityCandidate(testModel(), "minimal"),
    ]));
    const streamFn = vi.fn<StreamFn>(() => { throw new Error("title stream should not run"); });
    const fake = fakeRuntime("relay-name-session", { agent: { streamFunction: streamFn } });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      utilityModelResolver: { configuredCandidates },
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("relay-name-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(
      sessionRef("relay-name-session"),
      'Relay "utility-routing" leg 2 begins now.\n\nContinue the implementation.',
    );

    expect(fake.session.sessionName).toBe("Relay utility-routing leg 2");
    expect(configuredCandidates).not.toHaveBeenCalled();
    expect(streamFn).not.toHaveBeenCalled();
    await service.dispose();
  });

  it("installs working utility routing in each default runtime without mutating model settings", async () => {
    const credentials = new InMemoryCredentialStore();
    await seedCredential(credentials, TEST_MODEL_PROVIDER, { type: "api_key", key: "sk-test" });
    const modelRuntime = await createTestModelRuntime(credentials);
    const activeModel = modelRuntime.getModel(TEST_MODEL_PROVIDER, TEST_MODEL_ID);
    if (activeModel === undefined) throw new Error("Expected active model fixture");
    const utilityModel = { ...activeModel, id: "utility-lightweight" };
    const configuredCandidates = vi.fn().mockResolvedValue([
      utilityCandidate(utilityModel, "high"),
    ]);
    const streamFunction = vi.fn<StreamFn>((model) => completedTitleStream(model.id, "Runtime factory summary"));
    const setModel = vi.fn(() => Promise.resolve());
    const setThinkingLevel = vi.fn();
    const fake = fakeRuntime("factory-session", {
      modelRuntime,
      model: activeModel,
      thinkingLevel: "high",
      setModel,
      setThinkingLevel,
      agent: { streamFunction },
    });
    const services = fakeAgentSessionServices();
    const setDefaultProvider = vi.spyOn(services.settingsManager, "setDefaultProvider");
    const setDefaultModel = vi.spyOn(services.settingsManager, "setDefaultModel");
    const setDefaultModelAndProvider = vi.spyOn(services.settingsManager, "setDefaultModelAndProvider");
    const createServices = vi.fn<typeof createAgentSessionServices>(() => Promise.resolve(services));
    // The SDK session class has private state; this host-surface fake is the tested adapter boundary.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const createdSession = fake.session as unknown as Awaited<
      ReturnType<typeof createAgentSessionFromServices>
    >["session"];
    const createFromServices = vi.fn<typeof createAgentSessionFromServices>(() => Promise.resolve({
      session: createdSession,
      extensionsResult: services.resourceLoader.getExtensions(),
    }));
    const runtimeFactory = createDefaultRuntimeFactory(
      modelRuntime,
      sessionGateway([]),
      { configuredCandidates },
      { info: vi.fn() },
      undefined,
      undefined,
      undefined,
      { createServices, createFromServices },
    );
    const sessionManager = SessionManager.inMemory(process.cwd());

    const result = await runtimeFactory({
      cwd: process.cwd(),
      agentDir: TEST_AGENT_DIR,
      sessionManager,
      delegationToolsEnabled: false,
    });

    expect(createServices).toHaveBeenCalledOnce();
    const createServicesOptions = createServices.mock.calls[0]?.[0];
    expect(createServicesOptions).toMatchObject({
      cwd: process.cwd(),
      agentDir: TEST_AGENT_DIR,
      modelRuntime,
    });
    const extensionFactories = createServicesOptions?.resourceLoaderOptions?.extensionFactories;
    expect(extensionFactories).toHaveLength(1);
    expect(extensionFactories?.[0]).toMatchObject({
      name: "pi-webui-utility-models",
      hidden: true,
    });
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
    const loadedExtensions = loader.getExtensions();
    expect(loadedExtensions.errors).toEqual([]);
    const beforeTree = loadedExtensions.extensions[0]?.handlers.get("session_before_tree")?.[0];
    if (beforeTree === undefined) throw new Error("Expected utility tree handler");

    const utilityResult = await beforeTree(runtimeFactoryTreeEvent(), {
      model: activeModel,
    });
    if (
      typeof utilityResult !== "object" ||
      utilityResult === null ||
      !("summary" in utilityResult) ||
      typeof utilityResult.summary !== "object" ||
      utilityResult.summary === null ||
      !("summary" in utilityResult.summary) ||
      typeof utilityResult.summary.summary !== "string"
    ) {
      throw new Error("Expected utility branch summary result");
    }
    expect(utilityResult.summary.summary).toContain("Runtime factory summary");

    expect(configuredCandidates).toHaveBeenCalledOnce();
    expect(configuredCandidates).toHaveBeenCalledWith("lightweight");
    expect(streamFunction).toHaveBeenCalledOnce();
    expect(streamFunction.mock.calls[0]?.[0]).toBe(utilityModel);
    expect(streamFunction.mock.calls[0]?.[2]).toMatchObject({ reasoning: "high" });
    expect(createFromServices).toHaveBeenCalledOnce();
    expect(createFromServices.mock.calls[0]?.[0].services).toBe(services);
    expect(result.session).toBe(createdSession);
    expect(result.session.agent.streamFunction).toBe(streamFunction);
    expect(result.services).toBe(services);
    expect(result.diagnostics).toBe(services.diagnostics);
    expect(fake.session.model).toBe(activeModel);
    expect(fake.session.thinkingLevel).toBe("high");
    expect(setModel).not.toHaveBeenCalled();
    expect(setThinkingLevel).not.toHaveBeenCalled();
    expect(setDefaultProvider).not.toHaveBeenCalled();
    expect(setDefaultModel).not.toHaveBeenCalled();
    expect(setDefaultModelAndProvider).not.toHaveBeenCalled();
  });

  it("includes queued message details in session status", async () => {
    const fake = fakeRuntime("status-session", {
      messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }],
      pendingMessageCount: 2,
      getSteeringMessages: () => ["adjust this turn"],
      getFollowUpMessages: () => ["then do this"],
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("status-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.status(sessionRef("status-session"))).resolves.toMatchObject({
      pendingMessageCount: 2,
      queuedMessages: [{ kind: "steer", text: "adjust this turn" }, { kind: "followUp", text: "then do this" }],
      messageCount: 2,
    });
    await service.dispose();
  });

  it("does not enqueue duplicate queued message text", async () => {
    const fake = fakeRuntime("dedupe-session", {
      isStreaming: true,
      pendingMessageCount: 1,
      getFollowUpMessages: () => ["already queued"],
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("dedupe-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("dedupe-session"), "already queued", "followUp");

    expect(fake.calls.prompt).toEqual([]);
    await service.dispose();
  });

  it("does not append queued prompts to the transcript before delivery", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("queued-session", { isStreaming: true });
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("queued-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("queued-session"), "Wait for the current turn", "followUp");

    expect(fake.calls.prompt).toEqual([{ text: "Wait for the current turn", options: { streamingBehavior: "followUp" } }]);
    expect(hub.sessionEvents.some(({ event }) => event.type === "message.append")).toBe(false);
    await service.dispose();
  });

  it("holds prompts sent during compaction until compaction finishes", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("compacting-session", { isCompacting: true });
    let resolveFirstPrompt: (() => void) | undefined;
    fake.session.prompt = (text: string, options?: { streamingBehavior?: "steer" | "followUp" }) => {
      fake.calls.prompt.push({ text, options });
      if (options === undefined) {
        fake.session.isStreaming = true;
        return new Promise<void>((resolve) => { resolveFirstPrompt = resolve; });
      }
      return Promise.resolve();
    };
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("compacting-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("compacting-session"), "Start task 1", "followUp");
    await service.prompt(sessionRef("compacting-session"), "Then task 2", "followUp");

    expect(fake.calls.prompt).toEqual([]);
    expect(hub.sessionEvents.some(({ event }) => event.type === "message.append")).toBe(false);
    await expect(service.status(sessionRef("compacting-session"))).resolves.toMatchObject({
      pendingMessageCount: 2,
      queuedMessages: [{ kind: "followUp", text: "Start task 1" }, { kind: "followUp", text: "Then task 2" }],
    });

    fake.session.isCompacting = false;
    fake.emit({ type: "compaction_end" });
    // compaction_end drains the held queue on a scheduled timer; wait for the
    // first prompt to be delivered rather than sleeping a fixed interval.
    await vi.waitFor(() => {
      expect(fake.calls.prompt).toEqual([{ text: "Start task 1", options: undefined }]);
    });

    expect(hub.sessionEvents.some(({ event }) => event.type === "message.append" && JSON.stringify(event.message).includes("Start task 1"))).toBe(true);
    await expect(service.status(sessionRef("compacting-session"))).resolves.toMatchObject({
      pendingMessageCount: 1,
      queuedMessages: [{ kind: "followUp", text: "Then task 2" }],
    });

    fake.emit({ type: "agent_start" });
    // agent_start drains the next queued prompt asynchronously; wait for both
    // prompts to have been delivered rather than sleeping.
    await vi.waitFor(() => {
      expect(fake.calls.prompt).toEqual([
        { text: "Start task 1", options: undefined },
        { text: "Then task 2", options: { streamingBehavior: "followUp" } },
      ]);
    });
    await expect(service.status(sessionRef("compacting-session"))).resolves.toMatchObject({
      pendingMessageCount: 0,
      queuedMessages: [],
    });
    resolveFirstPrompt?.();
    await service.dispose();
  });

  it("clears runtime and compaction queues without interrupting active work", async () => {
    const steeringMessages = ["adjust this turn"];
    const followUpMessages = ["then do this"];
    const transcript = [{ role: "user", content: "keep this history" }];
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("clear-queue-session", {
      messages: transcript,
      isStreaming: true,
      isCompacting: true,
      pendingMessageCount: 2,
      getSteeringMessages: () => steeringMessages,
      getFollowUpMessages: () => followUpMessages,
    });
    const clearRuntimeQueue = vi.fn(() => {
      const cleared = { steering: [...steeringMessages], followUp: [...followUpMessages] };
      steeringMessages.length = 0;
      followUpMessages.length = 0;
      fake.session.pendingMessageCount = 0;
      return cleared;
    });
    fake.session.clearQueue = clearRuntimeQueue;
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("clear-queue-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("clear-queue-session"), "queued during compaction", "followUp");
    await expect(service.status(sessionRef("clear-queue-session"))).resolves.toMatchObject({
      isStreaming: true,
      isCompacting: true,
      pendingMessageCount: 3,
      queuedMessages: [
        { kind: "steer", text: "adjust this turn" },
        { kind: "followUp", text: "then do this" },
        { kind: "followUp", text: "queued during compaction" },
      ],
    });

    const status = await service.clearQueue(sessionRef("clear-queue-session"));

    expect(clearRuntimeQueue).toHaveBeenCalledOnce();
    expect(status).toMatchObject({
      isStreaming: true,
      isCompacting: true,
      pendingMessageCount: 0,
      queuedMessages: [],
      messageCount: 1,
    });
    expect(fake.session.messages).toBe(transcript);
    expect(fake.calls.prompt).toEqual([]);
    expect(fake.calls.abort).toBe(0);
    expect(fake.calls.dispose).toBe(0);
    const publishedStatuses = hub.sessionEvents.filter(({ event }) => event.type === "status.update");
    expect(publishedStatuses.at(-1)?.event).toEqual({ type: "status.update", status });
    await service.dispose();
  });

  it("clears an already-empty queue idempotently", async () => {
    const fake = fakeRuntime("clear-empty-queue-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("clear-empty-queue-session")]),
      heartbeatIntervalMs: 60_000,
    });

    const firstStatus = await service.clearQueue(sessionRef("clear-empty-queue-session"));
    const secondStatus = await service.clearQueue(sessionRef("clear-empty-queue-session"));

    expect(fake.calls.clearQueue).toBe(2);
    expect(fake.calls.abort).toBe(0);
    expect(firstStatus).toMatchObject({ pendingMessageCount: 0, queuedMessages: [] });
    expect(secondStatus).toMatchObject({ pendingMessageCount: 0, queuedMessages: [] });
    await service.dispose();
  });

  it("clears queued messages when aborting active work", async () => {
    const fake = fakeRuntime("abort-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("abort-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef("abort-session"));
    await service.abort(sessionRef("abort-session"));

    expect(fake.calls.clearQueue).toBe(1);
    expect(fake.calls.abort).toBe(1);
    await service.dispose();
  });

  it("clears prompts queued during compaction when aborting active work", async () => {
    const fake = fakeRuntime("abort-compaction-session", { isCompacting: true });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("abort-compaction-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("abort-compaction-session"), "Do not deliver after abort", "followUp");
    await expect(service.status(sessionRef("abort-compaction-session"))).resolves.toMatchObject({ pendingMessageCount: 1 });
    await service.abort(sessionRef("abort-compaction-session"));

    expect(fake.calls.clearQueue).toBe(1);
    expect(fake.calls.prompt).toEqual([]);
    await expect(service.status(sessionRef("abort-compaction-session"))).resolves.toMatchObject({ pendingMessageCount: 0, queuedMessages: [] });
    await service.dispose();
  });

  it("refreshes models.json before listing and selecting models", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-webui-model-runtime-"));
    try {
      const modelsPath = join(agentDir, "models.json");
      await writeLocalModelsConfig(modelsPath, "initial-model");
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath,
        allowModelNetwork: false,
      });
      const setSessionModel = vi.fn(() => Promise.resolve());
      const fake = fakeRuntime("models-session", { modelRuntime, setModel: setSessionModel });
      const service = new PiSessionService(new CapturingSessionEventHub(), {
        agentDir,
        modelRuntime,
        createAgentRuntime: runtimeCreator(fake.runtime),
        sessionManager: sessionGateway([sessionRecord("models-session")]),
        heartbeatIntervalMs: 60_000,
      });

      try {
        await writeLocalModelsConfig(modelsPath, "listed-model");
        const listed = await service.availableModels(sessionRef("models-session"));
        expect(listed).toEqual(expect.arrayContaining([
          expect.objectContaining({ provider: "test-local", id: "listed-model" }),
        ]));
        expect(listed).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ provider: "test-local", id: "initial-model" }),
        ]));

        await writeLocalModelsConfig(modelsPath, "selected-model");
        await expect(service.setModel(sessionRef("models-session"), "test-local", "selected-model")).resolves.toBeDefined();
        expect(setSessionModel).toHaveBeenCalledWith(expect.objectContaining({
          provider: "test-local",
          id: "selected-model",
        }));
      } finally {
        await service.dispose();
      }
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("refreshes auth state and dedupes warnings when logout removes the current model's credentials", async () => {
    const hub = new CapturingSessionEventHub();
    // The shared model runtime reads a live credential store. Mutating the store
    // and refreshing here simulates the committed snapshot that
    // ModelRuntime.login()/logout() establishes before AuthService emits.
    // applyAuthChange then only needs to notify active sessions.
    const credentials = new InMemoryCredentialStore();
    await seedCredential(credentials, "anthropic", { type: "api_key", key: "sk-test" });
    const modelRuntime = await createTestModelRuntime(credentials);
    const model = modelRuntime.getModel(TEST_MODEL_PROVIDER, TEST_MODEL_ID);
    if (model === undefined) throw new Error("Expected Anthropic model fixture");
    const fake = fakeRuntime("auth-session", { model, modelRuntime });

    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("auth-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef("auth-session"));
    hub.sessionEvents.length = 0;
    hub.globalEvents.length = 0;

    await credentials.delete("anthropic");
    await modelRuntime.refresh({ allowNetwork: false });
    service.applyAuthChange({ removedProviderId: "anthropic" });
    service.applyAuthChange({ removedProviderId: "anthropic" });

    const warningCount = () => hub.sessionEvents.filter(({ event }) => event.type === "command.output" && event.level === "error" && event.message.includes(`${TEST_MODEL_PROVIDER}/${TEST_MODEL_ID}`)).length;
    expect(warningCount()).toBe(1);
    expect(hub.globalEvents.some((event) => event.type === "status.update" && event.status.sessionId === "auth-session")).toBe(true);

    await seedCredential(credentials, "anthropic", { type: "api_key", key: "sk-new" });
    await modelRuntime.refresh({ allowNetwork: false });
    service.applyAuthChange();
    await credentials.delete("anthropic");
    await modelRuntime.refresh({ allowNetwork: false });
    service.applyAuthChange({ removedProviderId: "anthropic" });
    expect(warningCount()).toBe(2);

    await service.dispose();
  });

  it("clears queued messages when stopping a session runtime", async () => {
    const fake = fakeRuntime("stop-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("stop-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef("stop-session"));
    await service.stop(sessionRef("stop-session"));

    expect(fake.calls.clearQueue).toBe(1);
    await service.dispose();
  });
});

function runtimeFactoryTreeEvent(): SessionBeforeTreeEvent {
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
        customType: "runtime-factory-test",
        content: "Verify utility routing",
        display: false,
      }],
      userWantsSummary: true,
    },
    signal: new AbortController().signal,
  };
}

function completedTitleStream(modelId: string, text: string) {
  const stream = createAssistantMessageEventStream();
  const message = titleAssistantMessage(modelId, {
    content: [{ type: "text", text }],
  });
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
  return stream;
}

function failedTitleStream(modelId: string) {
  const stream = createAssistantMessageEventStream();
  const message = titleAssistantMessage(modelId, {
    stopReason: "error",
    errorMessage: "utility title failed",
  });
  stream.push({ type: "error", reason: "error", error: message });
  stream.end(message);
  return stream;
}

function utilityCandidate(
  model: ReturnType<typeof testModel>,
  thinkingLevel: ResolvedUtilityModel<ReturnType<typeof testModel>>["thinkingLevel"],
  slot: ResolvedUtilityModel<ReturnType<typeof testModel>>["slot"] = "lightweight",
): ResolvedUtilityModel<ReturnType<typeof testModel>> {
  return { model, thinkingLevel, slot };
}

function titleAssistantMessage(modelId: string, patch: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: modelId,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
    ...patch,
  };
}

async function writeLocalModelsConfig(path: string, modelId: string): Promise<void> {
  await writeFile(path, JSON.stringify({
    providers: {
      "test-local": {
        name: "Test Local",
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "offline-test-key",
        api: "openai-completions",
        models: [{
          id: modelId,
          name: modelId,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000,
          maxTokens: 100,
        }],
      },
    },
  }));
}
