import { describe, expect, it } from "vitest";
import {
  HOST_SPEECH_MAX_RUN_ID_CHARS,
  HOST_SPEECH_MAX_TEXT_CHARS,
  effectivePiWebUiTtsConfig,
  isHostSpeechRunId,
  truncateHostSpeechText,
} from "./hostSpeech";

describe("host speech contracts", () => {
  it("resolves omitted TTS settings to OS defaults", () => {
    expect(effectivePiWebUiTtsConfig(undefined)).toEqual({ rate: 0 });
  });

  it("copies explicit settings without inventing an optional voice", () => {
    expect(effectivePiWebUiTtsConfig({ voice: "en-US-Test", rate: -25 })).toEqual({
      voice: "en-US-Test",
      rate: -25,
    });
  });

  it("normalizes controls and silently truncates host speech text", () => {
    const text = `first\r\nsecond\u0000${"x".repeat(HOST_SPEECH_MAX_TEXT_CHARS)}`;
    const result = truncateHostSpeechText(text);
    expect(result).toMatch(/^first\nsecondx/u);
    expect(result).not.toContain("\u0000");
    expect(result).toHaveLength(HOST_SPEECH_MAX_TEXT_CHARS);
  });

  it("removes Unicode Cc controls except LF and Tab while preserving non-BMP characters and DEL/C1 controls handling", () => {
    // \u0007 (BEL, Cc), \u0009 (\t, Cc - keep), \u000A (\n, Cc - keep), \u007F (DEL, Cc - remove), \u0085 (NEL, Cc - remove), \u009F (C1 control, Cc - remove)
    // 😀 (\uD83D\uDE00, non-BMP - keep)
    const text = "Hello\u0007\tWorld\n😀!\u007F\u0085\u009F";
    const result = truncateHostSpeechText(text);
    expect(result).toBe("Hello\tWorld\n😀!");
  });

  it("backs off one unit when a surrogate pair would cross the UTF-16 cap", () => {
    const emoji = "\uD83D\uDE00";
    const result = truncateHostSpeechText(`${"x".repeat(HOST_SPEECH_MAX_TEXT_CHARS - 1)}${emoji}`);
    expect(result).toBe("x".repeat(HOST_SPEECH_MAX_TEXT_CHARS - 1));
    expect(result.length).toBeLessThanOrEqual(HOST_SPEECH_MAX_TEXT_CHARS);
    expect(hasLoneSurrogate(result)).toBe(false);
  });

  it("keeps an emoji that fits exactly at the UTF-16 cap", () => {
    const emoji = "\uD83D\uDE00";
    const text = `${"x".repeat(HOST_SPEECH_MAX_TEXT_CHARS - emoji.length)}${emoji}`;
    const result = truncateHostSpeechText(text);
    expect(result).toBe(text);
    expect(result).toHaveLength(HOST_SPEECH_MAX_TEXT_CHARS);
    expect(hasLoneSurrogate(result)).toBe(false);
  });

  it.each(["run-1", "550e8400-e29b-41d4-a716-446655440000", "tab:run_2.3"])("accepts opaque run id %s", (runId) => {
    expect(isHostSpeechRunId(runId)).toBe(true);
  });

  it.each(["", " leading", "line\nbreak", "x".repeat(HOST_SPEECH_MAX_RUN_ID_CHARS + 1)])("rejects invalid run id %s", (runId) => {
    expect(isHostSpeechRunId(runId)).toBe(false);
  });
});

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      index += 1;
      continue;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) return true;
  }
  return false;
}
