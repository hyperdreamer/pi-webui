import { describe, expect, it } from "vitest";
import { HOST_SPEECH_MAX_TEXT_CHARS } from "../../shared/hostSpeech";
import type { ChatLine } from "./components/shared";
import { assistantSpeechMessageKey, assistantSpeechText } from "./hostSpeechText";

function assistant(text: string): ChatLine {
  return { role: "assistant", parts: [{ type: "text", text }] };
}

describe("assistantSpeechText", () => {
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
