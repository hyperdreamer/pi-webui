import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
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

function streamThatCompletes(text: string): StreamFn {
  return () => {
    const stream = createAssistantMessageEventStream();
    const message = fakeAssistantMessage({ content: [{ type: "text", text }] });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
  };
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
  it("generates a session name by calling the injected streamFn", async () => {
    const stream = streamThatCompletes('Title: "Fix the bug"');
    const streamFn = vi.fn<StreamFn>((model, context, options) =>
      stream(model, context, options),
    );

    const name = await generateShortSessionName(streamFn, fakeModel(), "Please fix the login bug");

    expect(name).toBe("Fix the bug");
    expect(streamFn).toHaveBeenCalledOnce();
    expect(streamFn.mock.calls[0]?.[2]).toMatchObject({
      maxTokens: 24,
      reasoning: "minimal",
    });
  });

  it("sends an explicit max thinking level with a title request", async () => {
    const stream = streamThatCompletes("Fix the bug");
    const streamFn = vi.fn<StreamFn>((model, context, options) =>
      stream(model, context, options),
    );

    await generateShortSessionName(
      streamFn,
      fakeModel(),
      "Please fix the login bug",
      "max",
    );

    expect(streamFn.mock.calls[0]?.[2]).toMatchObject({
      maxTokens: 24,
      reasoning: "max",
    });
  });

  it("omits reasoning from an off title request", async () => {
    const stream = streamThatCompletes("Fix the bug");
    const streamFn = vi.fn<StreamFn>((model, context, options) =>
      stream(model, context, options),
    );

    await generateShortSessionName(
      streamFn,
      fakeModel(),
      "Please fix the login bug",
      "off",
    );

    expect(streamFn.mock.calls[0]?.[2]).toMatchObject({ maxTokens: 24 });
    expect(streamFn.mock.calls[0]?.[2]).not.toHaveProperty("reasoning");
  });

  it("returns undefined when the stream reports an error", async () => {
    const streamFn = streamThatErrors();

    const name = await generateShortSessionName(streamFn, fakeModel(), "Please fix the login bug");

    expect(name).toBeUndefined();
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

  it("builds a concise fallback from the first request", () => {
    expect(fallbackSessionName("Seems like auto name for sessions is not working, I still get the first message as a name."))
      .toBe("Seems like auto name for sessions");
  });

  it("ignores skill blocks in fallback names", () => {
    expect(fallbackSessionName('<skill name="x" location="/x">\nDo x\n</skill>\n\nCheck the UI now'))
      .toBe("Check the UI now");
  });

  it("skips fallback names when the first request is missing", () => {
    expect(fallbackSessionName(undefined)).toBeUndefined();
  });
});
