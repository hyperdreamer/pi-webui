import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ThinkingLevel } from "../../shared/thinkingLevels.js";
import {
  SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS,
  SPEECH_INPUT_POLISHING_ROUTE_TIMEOUT_MS,
} from "../../shared/speechInputPolishing.js";
import type {
  ResolvedUtilityModel,
  UtilityModelResolver,
} from "../sessions/utilityModelResolver.js";
import {
  SPEECH_INPUT_POLISHING_MAX_OUTPUT_BYTES,
  SpeechInputPolishingAbortedError,
  SpeechInputPolishingUnavailableError,
  createSpeechInputPolishingService,
  type SpeechInputPolishingServiceDependencies,
} from "./speechInputPolishingService.js";

const firstModel = fakeModel("acme", "first");
const secondModel = fakeModel("acme", "second");
const rawTranscript = "please update the API client timeout";

describe("SpeechInputPolishingService", () => {
  it("uses only lightweight candidates in resolver order and falls back after an invalid result", async () => {
    const calls: Model<Api>[] = [];
    const service = createHarness(
      [candidate(firstModel, "low"), candidate(secondModel, "minimal")],
      (model) => {
        calls.push(model);
        return Promise.resolve(model === firstModel
          ? assistantMessage([], "length")
          : assistantMessage([{ type: "text", text: "Please update the API client timeout." }]));
      },
    );

    await expect(service.polish(rawTranscript)).resolves.toBe(
      "Please update the API client timeout.",
    );
    expect(calls).toEqual([firstModel, secondModel]);
    expect(harnessConfiguredCandidates(service)).toHaveBeenCalledWith("lightweight");
  });

  it("passes the fixed context, suppressed reasoning, signal, and bounded one-shot options", async () => {
    let received:
      | {
          model: Model<Api>;
          context: Context;
          options: ModelsSimpleStreamOptions | undefined;
        }
      | undefined;
    const completeSimple = (
      model: Model<Api>,
      context: Context,
      options?: ModelsSimpleStreamOptions,
    ): Promise<AssistantMessage> => {
      received = { model, context, options };
      return Promise.resolve(assistantMessage([{ type: "text", text: "cleaned" }]));
    };
    const controller = new AbortController();
    const service = createHarness(
      [candidate(firstModel, "high")],
      completeSimple,
    );

    await expect(service.polish(rawTranscript, controller.signal)).resolves.toBe("cleaned");
    expect(received?.model).toBe(firstModel);
    expect(received?.context.systemPrompt).toContain("Return only polished plain text");
    expect(received?.context.systemPrompt).toContain("Preserve meaning, intent, technical tokens");
    expect(received?.context.systemPrompt).toContain("Do not add, delete, or infer requirements");
    expect(received?.context.messages).toHaveLength(1);
    expect(received?.context.messages[0]?.role).toBe("user");
    expect(received?.context.messages[0]?.content).toBe(rawTranscript);
    expect(typeof received?.context.messages[0]?.timestamp).toBe("number");
    expect(received?.context.tools).toBeUndefined();
    expect(received?.options).toEqual(expect.objectContaining({
      maxRetries: 0,
      cacheRetention: "none",
      signal: controller.signal,
      timeoutMs: SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS,
    }));
    expect(SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS).toBeLessThan(SPEECH_INPUT_POLISHING_ROUTE_TIMEOUT_MS);
    expect("maxTokens" in (received?.options ?? {})).toBe(false);
    expect(received?.options?.maxTokens).toBeUndefined();
    expect("reasoning" in (received?.options ?? {})).toBe(false);
  });

  it("omits maxTokens from completeSimple options", async () => {
    let capturedOptions: ModelsSimpleStreamOptions | undefined;
    const service = createHarness([candidate(firstModel)], (_model, _context, options) => {
      capturedOptions = options;
      return Promise.resolve(assistantMessage([{ type: "text", text: "polished text" }]));
    });

    await expect(service.polish(rawTranscript)).resolves.toBe("polished text");
    expect(capturedOptions).toBeDefined();
    expect("maxTokens" in (capturedOptions ?? {})).toBe(false);
    expect(capturedOptions?.maxTokens).toBeUndefined();
  });

  it("omits reasoning property when model supports off", async () => {
    let capturedOptions: ModelsSimpleStreamOptions | undefined;
    const modelWithOptionalReasoning = fakeModel("acme", "reasoning-optional", ["off", "low", "high"]);
    const service = createHarness([candidate(modelWithOptionalReasoning, "high")], (_model, _context, options) => {
      capturedOptions = options;
      return Promise.resolve(assistantMessage([{ type: "text", text: "polished text" }]));
    });

    await expect(service.polish(rawTranscript)).resolves.toBe("polished text");
    expect("reasoning" in (capturedOptions ?? {})).toBe(false);
  });

  it("passes lowest clamped thinking level when model mandates reasoning", async () => {
    let capturedOptions: ModelsSimpleStreamOptions | undefined;
    const modelRequiringReasoning = fakeModel("acme", "reasoning-required", ["minimal", "low", "high"]);
    const service = createHarness([candidate(modelRequiringReasoning, "high")], (_model, _context, options) => {
      capturedOptions = options;
      return Promise.resolve(assistantMessage([{ type: "text", text: "polished text" }]));
    });

    await expect(service.polish(rawTranscript)).resolves.toBe("polished text");
    expect(capturedOptions?.reasoning).toBe("minimal");
  });

  it("evaluates clamping per candidate independently during fallback", async () => {
    const optionsSeen: (ModelsSimpleStreamOptions | undefined)[] = [];
    const candidate1 = candidate(fakeModel("acme", "model-1", ["off", "high"]), "high");
    const candidate2 = candidate(fakeModel("acme", "model-2", ["minimal", "high"]), "high");

    const service = createHarness([candidate1, candidate2], (model, _context, options) => {
      optionsSeen.push(options);
      if (model === candidate1.model) {
        return Promise.resolve(assistantMessage([], "error"));
      }
      return Promise.resolve(assistantMessage([{ type: "text", text: "polished by candidate 2" }]));
    });

    await expect(service.polish(rawTranscript)).resolves.toBe("polished by candidate 2");
    expect(optionsSeen).toHaveLength(2);
    expect("reasoning" in (optionsSeen[0] ?? {})).toBe(false);
    expect(optionsSeen[1]?.reasoning).toBe("minimal");
  });

  it("accepts output at exact 1 MiB boundary and rejects output exceeding 1 MiB", async () => {
    const exactLimitText = "a".repeat(SPEECH_INPUT_POLISHING_MAX_OUTPUT_BYTES);
    const serviceExact = createHarness([candidate(firstModel)], () =>
      Promise.resolve(assistantMessage([{ type: "text", text: exactLimitText }])),
    );
    await expect(serviceExact.polish(rawTranscript)).resolves.toBe(exactLimitText);

    const oversizedText = "a".repeat(SPEECH_INPUT_POLISHING_MAX_OUTPUT_BYTES + 1);
    const serviceOversized = createHarness([candidate(firstModel)], () =>
      Promise.resolve(assistantMessage([{ type: "text", text: oversizedText }])),
    );
    await expect(serviceOversized.polish(rawTranscript)).rejects.toBeInstanceOf(
      SpeechInputPolishingUnavailableError,
    );
  });

  it("extracts text blocks while ignoring thinking blocks", async () => {
    const service = createHarness([candidate(firstModel)], () => Promise.resolve(assistantMessage([
      { type: "thinking", thinking: "internal reasoning" },
      { type: "text", text: "Keep " },
      { type: "thinking", thinking: "more internal reasoning" },
      { type: "text", text: "the technical token API.v2." },
    ])));

    await expect(service.polish(rawTranscript)).resolves.toBe(
      "Keep the technical token API.v2.",
    );
  });

  it.each(["length", "toolUse", "deferred", "aborted", "error", "pending"] as const)(
    "rejects a %s stop result as a safe typed failure",
    async (stopReason) => {
      const service = createHarness([candidate(firstModel)], () =>
        Promise.resolve(assistantMessage([{ type: "text", text: "should not be accepted" }], stopReason)));

      await expect(service.polish(rawTranscript)).rejects.toBeInstanceOf(
        SpeechInputPolishingUnavailableError,
      );
    },
  );

  it("rejects tool calls even when a response also contains text", async () => {
    const service = createHarness([candidate(firstModel)], () => Promise.resolve(assistantMessage([
      { type: "text", text: "text before tool" },
      { type: "toolCall", id: "tool-1", name: "write", arguments: {} },
    ])));

    await expect(service.polish(rawTranscript)).rejects.toBeInstanceOf(
      SpeechInputPolishingUnavailableError,
    );
  });

  it("rejects empty and oversized extracted text", async () => {
    const empty = createHarness([candidate(firstModel)], () => Promise.resolve(assistantMessage([
      { type: "text", text: "  \n" },
    ])));
    await expect(empty.polish(rawTranscript)).rejects.toBeInstanceOf(
      SpeechInputPolishingUnavailableError,
    );

    const oversized = createHarness([candidate(firstModel)], () => Promise.resolve(assistantMessage([
      { type: "text", text: "x".repeat(1024 * 1024 + 1) },
    ])));
    await expect(oversized.polish(rawTranscript)).rejects.toBeInstanceOf(
      SpeechInputPolishingUnavailableError,
    );
  });

  it("reports no configured lightweight candidates as a typed unavailable failure", async () => {
    const completeSimple = vi.fn<SpeechInputPolishingServiceDependencies["modelRuntime"]["completeSimple"]>();
    const service = createHarness([], completeSimple);

    await expect(service.polish(rawTranscript)).rejects.toBeInstanceOf(
      SpeechInputPolishingUnavailableError,
    );
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("does not access session-manager state or persistence APIs", async () => {
    const completeSimple = vi.fn<SpeechInputPolishingServiceDependencies["modelRuntime"]["completeSimple"]>(
      () => Promise.resolve(assistantMessage([{ type: "text", text: "cleaned" }])),
    );
    const runtime = Object.defineProperty({ completeSimple }, "sessionManager", {
      get() {
        throw new Error("session manager must not be accessed");
      },
    });
    const resolver: UtilityModelResolver<Model<Api>> = {
      configuredCandidates: vi.fn(() => Promise.resolve([candidate(firstModel)])),
    };
    const service = createSpeechInputPolishingService({
      modelRuntime: runtime,
      utilityModelResolver: resolver,
    });

    await expect(service.polish(rawTranscript)).resolves.toBe("cleaned");
    expect(completeSimple).toHaveBeenCalledOnce();
  });

  it("rejects promptly with a typed cancellation while forwarding the caller signal", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const completeSimple = vi.fn<SpeechInputPolishingServiceDependencies["modelRuntime"]["completeSimple"]>(
      (_model, _context, options) => {
        receivedSignal = options?.signal;
        return new Promise<AssistantMessage>(() => undefined);
      },
    );
    const service = createHarness([candidate(firstModel)], completeSimple);
    const pending = service.polish(rawTranscript, controller.signal);

    await vi.waitFor(() => {
      expect(completeSimple).toHaveBeenCalledOnce();
    });
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(SpeechInputPolishingAbortedError);
    expect(receivedSignal).toBe(controller.signal);
  });
});

function createHarness(
  candidates: readonly ResolvedUtilityModel<Model<Api>>[],
  completeSimple: SpeechInputPolishingServiceDependencies["modelRuntime"]["completeSimple"],
) {
  const configuredCandidates = vi.fn(() => Promise.resolve(candidates));
  const resolver: UtilityModelResolver<Model<Api>> = {
    configuredCandidates,
  };
  const service = createSpeechInputPolishingService({
    modelRuntime: { completeSimple },
    utilityModelResolver: resolver,
  });
  harnessConfiguredCandidatesByService.set(service, configuredCandidates);
  return service;
}

const harnessConfiguredCandidatesByService = new WeakMap<object, UtilityModelResolver<Model<Api>>["configuredCandidates"]>();

function harnessConfiguredCandidates(service: object): UtilityModelResolver<Model<Api>>["configuredCandidates"] {
  const configuredCandidates = harnessConfiguredCandidatesByService.get(service);
  if (configuredCandidates === undefined) throw new Error("test resolver was not registered");
  return configuredCandidates;
}

function candidate(
  model: Model<Api>,
  thinkingLevel: ThinkingLevel = "minimal",
): ResolvedUtilityModel<Model<Api>> {
  return { model, thinkingLevel, slot: "lightweight" };
}

function fakeModel(
  provider: string,
  id: string,
  thinkingLevels?: ThinkingLevel[],
): Model<Api> {
  const allLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  const thinkingLevelMap = thinkingLevels === undefined
    ? undefined
    : Object.fromEntries(
        allLevels.map((lvl) => [lvl, thinkingLevels.includes(lvl) ? lvl : null]),
      );
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://example.invalid/v1",
    reasoning: true,
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 1_024,
  };
}

function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "acme",
    model: "first",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}
