// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { HOST_SPEECH_MAX_TEXT_CHARS } from "../../shared/hostSpeech";
import { toSafeMarkdownHtml } from "./formatting/markdown";

import type { ChatLine } from "./components/shared";
import { assistantSpeechMessageKey, assistantSpeechText, resolveAssistantSpeechSource } from "./hostSpeechText";

function assistant(text: string): ChatLine {
  return { role: "assistant", parts: [{ type: "text", text }] };
}

describe("assistantSpeechText", () => {
  it("keeps visual math registration isolated from host speech", () => {
    toSafeMarkdownHtml("before $x^2$ after", { cache: false });

    expect(assistantSpeechText(assistant("before $x^2$ after"))).toBe("before $x^2$ after");
  });

  it("keeps headings, paragraphs, list content, and link labels", () => {
    expect(assistantSpeechText(assistant([
      "# Result",
      "",
      "Read the [configuration guide](https://example.test/config).",
      "",
      "- First item",
      "- Second **important** item",
    ].join("\n")))).toBe([
      "Result",
      "",
      "Read the configuration guide.",
      "",
      "First item",
      "Second important item",
    ].join("\n"));
  });

  it("drops fenced code, indented code, tables, images, destinations, and raw URLs", () => {
    expect(assistantSpeechText(assistant([
      "Before.",
      "",
      "```ts",
      "const secret = 1;",
      "```",
      "",
      "    indented()",
      "",
      "| A | B |",
      "| - | - |",
      "| x | y |",
      "",
      "![diagram](image.png)",
      "Visit https://example.test/raw then [the label](https://example.test/label).",
      "",
      "After.",
    ].join("\n")))).toBe("Before.\n\nVisit then the label.\n\nAfter.");
  });

  it("uses only text parts and keeps separate text parts readable", () => {
    const message: ChatLine = {
      role: "assistant",
      parts: [
        { type: "thinking", text: "private reasoning" },
        { type: "text", text: "First paragraph." },
        { type: "image", mimeType: "image/png", data: "AAAA" },
        { type: "text", text: "Second paragraph." },
      ],
    };
    expect(assistantSpeechText(message)).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it.each([
    { role: "user" as const, parts: [{ type: "text" as const, text: "user" }] },
    { role: "assistant" as const, source: "compaction" as const, parts: [{ type: "text" as const, text: "summary" }] },
    { role: "assistant" as const, source: "branch_summary" as const, parts: [{ type: "text" as const, text: "summary" }] },
    { role: "assistant" as const, parts: [{ type: "image" as const, mimeType: "image/png", data: "AAAA" }] },
  ])("returns empty for ineligible message %#", (message) => {
    expect(assistantSpeechText(message)).toBe("");
  });

  it("silently caps the projected prefix", () => {
    const result = assistantSpeechText(assistant(`Start ${"word ".repeat(2_000)}`));
    expect(result.length).toBe(HOST_SPEECH_MAX_TEXT_CHARS);
    expect(result.startsWith("Start word")).toBe(true);
  });

  it("derives an index-based key regardless of any entry metadata", () => {
    expect(assistantSpeechMessageKey(assistant("reply"), 12)).toBe("assistant-index:12");
    expect(assistantSpeechMessageKey({ role: "assistant", entryId: "reply-7", parts: [{ type: "text", text: "reply" }] }, 12)).toBe("assistant-index:12");
  });
});

describe("resolveAssistantSpeechSource", () => {
  const page = {
    messages: [
      { role: "user" as const, parts: [{ type: "text" as const, text: "Ask" }] },
      assistant("Answer"),
    ],
    messagePageStart: 10,
  };

  it("resolves the raw absolute-index key against the current page window", () => {
    expect(resolveAssistantSpeechSource(page, "assistant-index:11")).toBe("Answer");
  });

  it("returns empty when the key is missing, malformed, or no longer speakable", () => {
    expect(resolveAssistantSpeechSource(page, "assistant-index:10")).toBe("");
    expect(resolveAssistantSpeechSource(page, "assistant-index:12")).toBe("");
    expect(resolveAssistantSpeechSource(page, "assistant-index")).toBe("");
    expect(resolveAssistantSpeechSource(page, "entry:reply-7")).toBe("");
    expect(resolveAssistantSpeechSource({
      messages: [{ role: "assistant", source: "compaction", parts: [{ type: "text", text: "summary" }] }],
      messagePageStart: 11,
    }, "assistant-index:11")).toBe("");
  });
});
