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

  it.each(["run-1", "550e8400-e29b-41d4-a716-446655440000", "tab:run_2.3"])("accepts opaque run id %s", (runId) => {
    expect(isHostSpeechRunId(runId)).toBe(true);
  });

  it.each(["", " leading", "line\nbreak", "x".repeat(HOST_SPEECH_MAX_RUN_ID_CHARS + 1)])("rejects invalid run id %s", (runId) => {
    expect(isHostSpeechRunId(runId)).toBe(false);
  });
});
