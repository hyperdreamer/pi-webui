import type { Api, AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  cleanSessionName,
  deterministicSessionName,
  fallbackSessionName,
  generateShortSessionName,
  isUsableSessionTitle,
  normalizeSessionName,
  shortenSessionName,
} from "./sessionNameGenerator.js";

function fakeModel(): Model<Api> {
  return { id: "fake-model", name: "Fake Model", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://example.test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };
}

function fakeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

function completedMessageStream(
  message: AssistantMessage,
  doneReason: Extract<AssistantMessageEvent, { type: "done" }>["reason"] = "stop",
  delta?: string,
): StreamFn {
  return () => {
    const stream = createAssistantMessageEventStream();
    if (delta !== undefined) {
      stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message });
    }
    stream.push({ type: "done", reason: doneReason, message });
    stream.end(message);
    return stream;
  };
}

function streamThatCompletes(text: string): StreamFn {
  return completedMessageStream(fakeAssistantMessage({ content: [{ type: "text", text }] }));
}

function streamThatErrors(): StreamFn {
  return () => {
    const stream = createAssistantMessageEventStream();
    const message = fakeAssistantMessage({ stopReason: "error", errorMessage: "boom" });
    stream.push({ type: "error", reason: "error", error: message });
    stream.end(message);
    return stream;
  };
}

// Provider/proxy boundary: exercise a block tag the SDK union cannot represent.
function externalContent(value: unknown): AssistantMessage["content"] {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return value as AssistantMessage["content"];
}

describe("sessionNameGenerator", () => {
  it("generates a normalized title with reasoning off and a 256-token ceiling", async () => {
    const model = fakeModel();
    const streamFn = vi.fn<StreamFn>(streamThatCompletes('Title: "Fix the bug"'));
    await expect(generateShortSessionName(streamFn, model, "Please fix the login bug"))
      .resolves.toEqual({ ok: true, title: "Fix the bug" });
    expect(streamFn).toHaveBeenCalledOnce();
    expect(streamFn.mock.calls[0]?.[0]).toBe(model);
    expect(streamFn.mock.calls[0]?.[2]).toMatchObject({ maxTokens: 256 });
    expect(streamFn.mock.calls[0]?.[2]).not.toHaveProperty("reasoning");
  });

  it("rejects a length-limited completion", async () => {
    const streamFn = completedMessageStream(fakeAssistantMessage({
      stopReason: "length", content: [{ type: "text", text: "Fix login bug" }],
    }), "length");
    await expect(generateShortSessionName(streamFn, fakeModel(), "Fix login"))
      .resolves.toEqual({ ok: false, reason: "incomplete-stop" });
  });

  it("rejects a stream that ends without done despite text deltas", async () => {
    const message = fakeAssistantMessage({ content: [{ type: "text", text: "Fix login bug" }] });
    const streamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "text_delta", contentIndex: 0, delta: "Fix login bug", partial: message });
      stream.end(message);
      return stream;
    };
    await expect(generateShortSessionName(streamFn, fakeModel(), "Fix login"))
      .resolves.toEqual({ ok: false, reason: "no-completion" });
  });

  it("classifies an emitted stream error directly", async () => {
    await expect(generateShortSessionName(streamThatErrors(), fakeModel(), "Fix login"))
      .resolves.toEqual({ ok: false, reason: "stream-error" });
  });

  it.each([
    ["x".repeat(4_000), "x".repeat(4_000)],
    ["x".repeat(4_001), "x".repeat(4_000) + "…"],
    ["𠮷".repeat(2_001), "𠮷".repeat(2_000) + "…"],
  ])("keeps the title timeout and input truncation unchanged", async (input, suffix) => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const timestamp = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(timestamp);
    const model = fakeModel();
    const streamFn = vi.fn<StreamFn>(streamThatCompletes("Fix login bug"));
    try {
      await expect(generateShortSessionName(streamFn, model, input))
        .resolves.toEqual({ ok: true, title: "Fix login bug" });
      expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
      expect(streamFn).toHaveBeenCalledExactlyOnceWith(model, {
        messages: [
          { role: "system", content: "Generate a concise title for a coding-agent chat session. Return only the title, with no quotes or punctuation wrapper.", timestamp: 0 },
          { role: "user", content: `Create a 2-6 word title for this request:\n\n${suffix}`, timestamp },
        ],
      }, { maxTokens: 256, signal });
      expect(streamFn.mock.calls[0]?.[0]).toBe(model);
      expect(streamFn.mock.calls[0]?.[2]?.signal).toBe(signal);
      if (input.startsWith("𠮷")) {
        expect(suffix).toBe("𠮷".repeat(2_000) + "…");
        expect(Array.from(suffix)).toHaveLength(2_001);
      }
    } finally {
      now.mockRestore();
      timeout.mockRestore();
    }
  });

  it("uses final text blocks instead of partial deltas or thinking text", async () => {
    const message = fakeAssistantMessage({ content: [
      { type: "thinking", thinking: "We need a session title" },
      { type: "text", text: "Fix" }, { type: "text", text: "login bug" },
    ] });
    await expect(generateShortSessionName(completedMessageStream(message, "stop", "Wrong partial title"), fakeModel(), "Fix login"))
      .resolves.toEqual({ ok: true, title: "Fixlogin bug" });
  });

  it("accepts thinking plus a usable text title", async () => {
    const message = fakeAssistantMessage({ content: [
      { type: "thinking", thinking: "We need a session title" },
      { type: "text", text: "Fix login bug" },
    ] });
    await expect(generateShortSessionName(completedMessageStream(message), fakeModel(), "Fix login"))
      .resolves.toEqual({ ok: true, title: "Fix login bug" });
  });

  it.each(["toolUse", "deferred", "aborted", "error", "pending"] as const)("rejects non-answer terminal reason %s", async (stopReason) => {
    const message = fakeAssistantMessage({ stopReason, content: [{ type: "text", text: "Fix login bug" }] });
    await expect(generateShortSessionName(completedMessageStream(message, "stop"), fakeModel(), "Fix login"))
      .resolves.toEqual({ ok: false, reason: "incomplete-stop" });
  });

  it("accepts message stop despite a non-stop done reason", async () => {
    const message = fakeAssistantMessage({ stopReason: "stop", content: [{ type: "text", text: "Fix login bug" }] });
    await expect(generateShortSessionName(completedMessageStream(message, "length"), fakeModel(), "Fix login"))
      .resolves.toEqual({ ok: true, title: "Fix login bug" });
  });

  it.each(["toolCall", "unknown"] as const)("rejects non-text content type %s", async (type) => {
    const unexpected = type === "toolCall"
      ? { type: "toolCall", id: "call-1", name: "lookup", arguments: {} }
      : { type: "unknown" };
    const message = fakeAssistantMessage({ content: externalContent([
      { type: "text", text: "Fix login bug" }, unexpected,
    ]) });
    await expect(generateShortSessionName(completedMessageStream(message), fakeModel(), "Fix login"))
      .resolves.toEqual({ ok: false, reason: "non-text-content" });
  });

  it.each<{ content: AssistantMessage["content"] }>([
    { content: [] },
    { content: [{ type: "text", text: " \t " }] },
    { content: [{ type: "text", text: 'Title: ""' }] },
    { content: [{ type: "thinking", thinking: "We need a session title" }] },
  ])("classifies blank and thinking-only completions as empty", async ({ content }) => {
    await expect(generateShortSessionName(completedMessageStream(fakeAssistantMessage({ content })), fakeModel(), "Fix login"))
      .resolves.toEqual({ ok: false, reason: "empty" });
  });

  it("checks stop reason before tool content", async () => {
    const message = fakeAssistantMessage({ stopReason: "toolUse", content: [
      { type: "text", text: "Fix login bug" },
      { type: "toolCall", id: "call-1", name: "lookup", arguments: {} },
    ] });
    await expect(generateShortSessionName(completedMessageStream(message), fakeModel(), "Fix login"))
      .resolves.toEqual({ ok: false, reason: "incomplete-stop" });
  });

  it("checks content types before empty text", async () => {
    const message = fakeAssistantMessage({ content: [
      { type: "toolCall", id: "call-1", name: "lookup", arguments: {} },
      { type: "text", text: "   " },
    ] });
    await expect(generateShortSessionName(completedMessageStream(message), fakeModel(), "Fix login"))
      .resolves.toEqual({ ok: false, reason: "non-text-content" });
  });

  it("lets a thrown stream factory failure reach the caller", async () => {
    const failure = new Error("factory failed");
    const streamFn = vi.fn<StreamFn>(() => { throw failure; });
    await expect(generateShortSessionName(streamFn, fakeModel(), "Fix login")).rejects.toBe(failure);
  });

  it("lets a thrown stream iteration failure reach the caller", async () => {
    const failure = new Error("iteration failed");
    const message = fakeAssistantMessage({ content: [{ type: "text", text: "Fix login bug" }] });
    const stream = createAssistantMessageEventStream();
    stream.end(message);
    const iterator = vi.spyOn(stream, Symbol.asyncIterator).mockImplementation(async function* (): AsyncGenerator<AssistantMessageEvent> {
      yield { type: "text_delta", contentIndex: 0, delta: "Fix login bug", partial: message };
      await Promise.resolve();
      throw failure;
    });
    try {
      await expect(generateShortSessionName(() => stream, fakeModel(), "Fix login")).rejects.toBe(failure);
    } finally {
      iterator.mockRestore();
    }
  });

  it("validates the entire title before shortening", async () => {
    const title = "Investigate strange session naming behavior across providers before generating final answers";
    expect(title.split(/\s+/)).toHaveLength(11);
    expect(title.slice(0, 60)).toBe("Investigate strange session naming behavior across providers");
    await expect(generateShortSessionName(streamThatCompletes(title), fakeModel(), "Fix naming"))
      .resolves.toEqual({ ok: false, reason: "unusable" });
  });

  it.each([
    "No quotes please", "Remove punctuation wrapper", "Create a 2-6 word title", "Create a 2-6 words title",
    "The user wants login fixes", "We need a session title", "Need to produce title", "Need to infer title",
    "Need to craft title", "Fix login because we need retries",
  ])("rejects reasoning echo %s", async (title) => {
    await expect(generateShortSessionName(streamThatCompletes(title), fakeModel(), "Fix naming"))
      .resolves.toEqual({ ok: false, reason: "unusable" });
  });

  it.each<[number, string]>([
    [1, "Login"], [7, "Fix flaky article bridge FTS retry test"],
    [8, "Fix flaky article bridge FTS retry test failures"],
  ])("accepts a legitimate %s-word title", async (count, title) => {
    expect(title.split(/\s+/)).toHaveLength(count);
    await expect(generateShortSessionName(streamThatCompletes(title), fakeModel(), "Fix naming"))
      .resolves.toEqual({ ok: true, title });
  });

  it("rejects a nine-word title", async () => {
    await expect(generateShortSessionName(streamThatCompletes("Fix flaky article bridge FTS retry test failures today"), fakeModel(), "Fix naming"))
      .resolves.toEqual({ ok: false, reason: "unusable" });
  });

  it.each(["and", "or", "for", "the", "a", "an", "to", "with", "of", "in", "on", "by", "With,"])("rejects dangling connector %s", async (connector) => {
    await expect(generateShortSessionName(streamThatCompletes(`Fix login ${connector}`), fakeModel(), "Fix naming"))
      .resolves.toEqual({ ok: false, reason: "unusable" });
  });

  it("accepts a connector substring in a complete word", async () => {
    await expect(generateShortSessionName(streamThatCompletes("Fix login within"), fakeModel(), "Fix naming"))
      .resolves.toEqual({ ok: true, title: "Fix login within" });
  });

  it("shortens only after accepting a long legitimate title", async () => {
    await expect(generateShortSessionName(streamThatCompletes("Improve authentication reliability across distributed production environments"), fakeModel(), "Fix naming"))
      .resolves.toEqual({ ok: true, title: "Improve authentication reliability across distributed" });
  });

  it("never revalidates the shortened display value", async () => {
    const title = "Investigate authentication failures across providers and document recovery";
    expect(title.split(/\s+/)).toHaveLength(8);
    await expect(generateShortSessionName(streamThatCompletes(title), fakeModel(), "Fix naming"))
      .resolves.toEqual({ ok: true, title: "Investigate authentication failures across providers and" });
  });

  it.each(["x", "𠮷"])("accepts and caps a long unspaced title: %s", async (character) => {
    const result = await generateShortSessionName(streamThatCompletes(character.repeat(61)), fakeModel(), "Fix naming");
    expect(result).toEqual({ ok: true, title: character.repeat(60) });
    if (!result.ok) throw new Error("Expected an accepted unspaced title");
    expect(Array.from(result.title)).toHaveLength(60);
    if (character === "𠮷") expect(result.title).toHaveLength(120);
  });

  it("shortens at a word boundary", () => {
    expect(shortenSessionName("Improve authentication reliability across distributed production environments"))
      .toBe("Improve authentication reliability across distributed");
  });

  it("preserves punctuation adjacent to the shortening cut", () => {
    expect(shortenSessionName("x".repeat(59) + "! suffix")).toBe("x".repeat(59) + "!");
  });

  it("preserves a full sixty-code-point prefix ending at a boundary", () => {
    const expected = "Investigate strange session naming behavior across providers";
    expect(Array.from(expected)).toHaveLength(60);
    expect(shortenSessionName(`${expected} globally`)).toBe(expected);
  });

  it.each(["x", "界", "𠮷"])("caps an unspaced value at sixty code points: %s", (character) => {
    const result = shortenSessionName(character.repeat(61));
    expect(result).toBe(character.repeat(60));
    expect(Array.from(result)).toHaveLength(60);
    if (character === "𠮷") expect(result).toHaveLength(120);
    expect(shortenSessionName("x".repeat(61) + " suffix")).toBe("x".repeat(60));
  });

  it("leaves a short display string unchanged", () => {
    expect(shortenSessionName("")).toBe("");
    expect(shortenSessionName("Fix login bug")).toBe("Fix login bug");
  });

  it("keeps cleanSessionName as normalization plus shortening", () => {
    expect(cleanSessionName('Title: "Fix Session Naming."\nextra')).toBe("Fix Session Naming");
    expect(cleanSessionName("We need title")).toBe("We need title");
    expect(cleanSessionName("Improve authentication reliability across distributed production environments"))
      .toBe("Improve authentication reliability across distributed");
    expect(cleanSessionName('Title: ""')).toBeUndefined();
  });

  it.each<[string, string | undefined]>([
    ['Title: "Fix Session Naming."\nextra', "Fix Session Naming"],
    ["  Session title: 'Fix\t login   bug.'  ", "Fix login bug"],
    ["Fix login bug\nWe need a title", "Fix login bug"],
    [" \nFix login bug", undefined],
    ['Title: ""', undefined],
    ["We need a session title", "We need a session title"],
    ["x".repeat(61), "x".repeat(61)],
  ])("normalizes labels quotes whitespace and the first line: %s", (input, expected) => {
    expect(normalizeSessionName(input)).toBe(expected);
  });

  it("validates uncapped title structure", () => {
    const cases: readonly (readonly [string, boolean])[] = [
      ["", false], [" \t ", false], ["Login", true],
      ["Fix flaky article bridge FTS retry test", true],
      ["Fix flaky article bridge FTS retry test failures", true],
      ["Fix flaky article bridge FTS retry test failures today", false],
      ["No quotes please", false], ["Remove punctuation wrapper", false],
      ["Create a 2-6 word title", false], ["Create a 2-6 words title", false],
      ["The user wants login fixes", false], ["We need a session title", false],
      ["Need to produce title", false], ["Need to infer title", false],
      ["Need to craft title", false], ["Fix login because we need retries", false],
      ["Fix login With,", false], ["Fix login within", true],
      ["Fix login and!", false], ["Fix login by:;!?", false],
      ["Fix login wIth", false], ["Fix login without", true],
      ["x".repeat(61), true], ["界".repeat(61), true],
      ["𠮷".repeat(61), true], ["Fix need to craft title", false],
    ];
    for (const [value, expected] of cases) {
      expect(isUsableSessionTitle(value), value).toBe(expected);
    }
    for (const connector of ["and", "or", "for", "the", "a", "an", "to", "with", "of", "in", "on", "by"]) {
      expect(isUsableSessionTitle(`Fix login ${connector}`), connector).toBe(false);
    }
  });

  it("builds deterministic names for relay handoff prompts", () => {
    expect(deterministicSessionName('Relay "handoff-check" leg 2 begins now.\n\nYou are the next runner.'))
      .toBe("Relay handoff-check leg 2");
  });

  it("preserves the relay leg when truncating deterministic relay names", () => {
    expect(deterministicSessionName('Relay "very-long-relay-name-that-would-otherwise-push-the-leg-number-out-of-view" leg 42 begins now.'))
      .toBe("Relay very-long-relay-name-that-would-otherwise-push leg 42");
  });

  it("does not build deterministic names for non-canonical relay prompts", () => {
    expect(deterministicSessionName('You are continuing Relay "handoff-check" under the Relay method.'))
      .toBeUndefined();
  });

  it.each([
    ["PM: Bug: Utility models for session naming doesn't work", "Bug: Utility models for session naming"],
    ["Project manager: Fix the flaky login retry tests", "Fix the flaky login retry tests"],
    ["  pM :   Bug: Utility models for session naming doesn't work", "Bug: Utility models for session naming"],
    ["  pRoJeCt MaNaGeR : Fix the flaky login retry tests", "Fix the flaky login retry tests"],
  ])("strips a leading PM or project-manager marker from a fallback: %s", (input, expected) => {
    expect(fallbackSessionName(input)).toBe(expected);
  });

  it.each([
    "Model tier: Worker\nRole: Implementer\nYou are the deterministic SDD lane runner for the f-worker lane of appio.",
    "PM:\nModel tier: Worker\n\nRole: Implementer\nYou are the deterministic SDD lane runner for the f-worker lane of appio.",
    "PM:\r\nModel tier: Worker\r\n\r\nRole: Implementer\r\nYou are the deterministic SDD lane runner for the f-worker lane of appio.",
    "model TIER: Worker\r\n\r\nROLE: Implementer\r\nYou are the deterministic SDD lane runner for the f-worker lane of appio.",
  ])("strips leading tier and role metadata before the fallback slice: %s", (input) => {
    expect(fallbackSessionName(input)).toBe("deterministic SDD lane runner for the");
  });

  it.each([
    ["You are the deterministic SDD lane runner for the f-worker lane of appio.", "deterministic SDD lane runner for the"],
    ["You are an expert debugger for login failures", "expert debugger for login failures"],
    ["You are a coding assistant fixing login failures", "coding assistant fixing login failures"],
  ])("removes only the leading role introduction: %s", (input, expected) => {
    expect(fallbackSessionName(input)).toBe(expected);
  });

  it("keeps metadata after substantive request text", () => {
    expect(fallbackSessionName("Investigate failures\nRole: reviewer"))
      .toBe("Investigate failures Role: reviewer");
  });

  it("preserves existing first-request and skill-block fallbacks", () => {
    expect(fallbackSessionName("Seems like auto name for sessions is not working, I still get the first message as a name."))
      .toBe("Seems like auto name for sessions");
    expect(fallbackSessionName('<skill name="x" location="/x">\nDo x\n</skill>\n\nCheck the UI now'))
      .toBe("Check the UI now");
  });

  it.each([
    "```ts\nconst value = 1;\n```", "PM:", "Project manager:",
    "Model tier: Worker\nRole: Implementer",
    '<skill name="x" location="/x">\nDo x\n</skill>', " \n\t ", "",
  ])("returns no fallback for empty cleaned request %s", (input) => {
    expect(fallbackSessionName(input)).toBeUndefined();
  });

  it("returns no fallback for non-string requests", () => {
    for (const input of [undefined, null, 42, false, {}, []]) {
      expect(fallbackSessionName(input)).toBeUndefined();
    }
  });

  it("normalizes and shortens fallback text without model-title validation", () => {
    expect(fallbackSessionName("You are the deterministic SDD lane runner for the f-worker lane of appio."))
      .toBe("deterministic SDD lane runner for the");
    expect(fallbackSessionName("We need a session title")).toBe("We need a session title");
    expect(fallbackSessionName("x".repeat(61))).toBe("x".repeat(60));
    expect(fallbackSessionName("𠮷".repeat(61))).toBe("𠮷".repeat(60));
  });
});
