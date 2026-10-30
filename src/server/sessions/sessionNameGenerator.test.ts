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
