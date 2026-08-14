import { describe, expect, it } from "vitest";
import type { SpeechInputSettingsResponse } from "../../../shared/apiTypes";
import { SPEECH_INPUT_MAX_TRANSCRIPT_BYTES } from "../../../shared/speechInputAudio";
import {
  buildSpeechTranscriptInsertion,
  chooseSpeechInputAudioMimeType,
  resolveSpeechInputProvider,
  type SpeechInputAvailabilityMap,
  type SpeechInputTargetSnapshot,
} from "./speechInputCore";

const AVAILABLE: SpeechInputAvailabilityMap = {
  browser: { available: true },
  cloud: { available: true },
};

function settings(overrides?: Partial<SpeechInputSettingsResponse>): SpeechInputSettingsResponse {
  return {
    contractVersion: 1,
    revision: "3f80a0ba-60eb-4b8f-9f80-62a231cf5a0b",
    settings: { provider: "auto", cloud: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe" } },
    credential: { configured: false, resolution: "missing" },
    ...overrides,
  };
}

function capture(text: string, from: number, to: number): SpeechInputTargetSnapshot {
  return {
    identity: { kind: "starter", machineId: "machine", projectId: "project", workspaceId: "workspace" },
    text,
    from,
    to,
  };
}

describe("resolveSpeechInputProvider", () => {
  it("resolves Auto to Browser when Browser is available", () => {
    expect(resolveSpeechInputProvider(settings(), AVAILABLE)).toEqual({ available: true, provider: "browser" });
  });

  it("falls back to Cloud in Auto when Browser is unavailable and Cloud is eligible", () => {
    const availability: SpeechInputAvailabilityMap = {
      browser: { available: false, reason: "Browser recognition is unavailable" },
      cloud: { available: true },
    };
    const resolved: SpeechInputSettingsResponse = settings({
      settings: { provider: "auto", cloud: { baseUrl: "https://api.openai.com/v1", model: "m" } },
      credential: { configured: true, source: "literal", resolution: "resolved" },
    });
    expect(resolveSpeechInputProvider(resolved, availability)).toEqual({ available: true, provider: "cloud" });
  });

  it("combines stable reasons when neither provider can start in Auto", () => {
    const availability: SpeechInputAvailabilityMap = {
      browser: { available: false, reason: "Browser recognition is unavailable" },
      cloud: { available: false, reason: "Microphone capture is unavailable" },
    };
    const missing: SpeechInputSettingsResponse = settings({
      settings: { provider: "auto", cloud: { baseUrl: "https://api.openai.com/v1", model: "m" } },
      credential: { configured: false, resolution: "missing" },
    });
    expect(resolveSpeechInputProvider(missing, availability)).toEqual({
      available: false,
      reason: "Browser recognition is unavailable; Cloud credential is not configured",
    });

    const resolved: SpeechInputSettingsResponse = settings({
      settings: { provider: "auto", cloud: { baseUrl: "https://api.openai.com/v1", model: "m" } },
      credential: { configured: true, source: "literal", resolution: "resolved" },
    });
    expect(resolveSpeechInputProvider(resolved, availability)).toEqual({
      available: false,
      reason: "Browser recognition is unavailable; Microphone capture is unavailable",
    });
  });

  it("never falls back from an explicit Browser choice", () => {
    const preference: SpeechInputSettingsResponse = settings({
      settings: { provider: "browser", cloud: { baseUrl: "https://api.openai.com/v1", model: "m" } },
      credential: { configured: true, source: "literal", resolution: "resolved" },
    });
    const availability: SpeechInputAvailabilityMap = {
      browser: { available: false, reason: "Not a secure context" },
      cloud: { available: true },
    };
    expect(resolveSpeechInputProvider(preference, availability)).toEqual({
      available: false,
      reason: "Not a secure context",
    });
    expect(resolveSpeechInputProvider(preference, AVAILABLE)).toEqual({ available: true, provider: "browser" });
  });

  it("never falls back from an explicit Cloud choice", () => {
    const preference: SpeechInputSettingsResponse = settings({
      settings: { provider: "cloud", cloud: { baseUrl: "https://api.openai.com/v1", model: "m" } },
      credential: { configured: false, resolution: "missing" },
    });
    const availability: SpeechInputAvailabilityMap = {
      browser: { available: true },
      cloud: { available: true },
    };
    expect(resolveSpeechInputProvider(preference, availability)).toEqual({
      available: false,
      reason: "Cloud credential is not configured",
    });
    expect(
      resolveSpeechInputProvider(
        settings({
          settings: { provider: "cloud", cloud: { baseUrl: "https://api.openai.com/v1", model: "m" } },
          credential: { configured: true, source: "literal", resolution: "resolved" },
        }),
        AVAILABLE,
      ),
    ).toEqual({ available: true, provider: "cloud" });
  });

  it("treats an unchecked command credential as eligible for Cloud", () => {
    const preference: SpeechInputSettingsResponse = settings({
      settings: { provider: "cloud", cloud: { baseUrl: "https://api.openai.com/v1", model: "m" } },
      credential: { configured: true, source: "command", resolution: "unchecked" },
    });
    expect(resolveSpeechInputProvider(preference, AVAILABLE)).toEqual({ available: true, provider: "cloud" });
  });

  it("treats missing and unresolved credentials as unavailable for Cloud", () => {
    const mediaOnly: SpeechInputAvailabilityMap = {
      browser: { available: false, reason: "Browser recognition is unavailable" },
      cloud: { available: true },
    };
    const unresolved: SpeechInputSettingsResponse = settings({
      settings: { provider: "auto", cloud: { baseUrl: "https://api.openai.com/v1", model: "m" } },
      credential: { configured: true, source: "environment", resolution: "unresolved" },
    });
    expect(resolveSpeechInputProvider(unresolved, mediaOnly)).toEqual({
      available: false,
      reason: "Browser recognition is unavailable; Cloud credential is unresolved",
    });
  });

  it("treats Cloud media unavailability as unavailable even with a resolved credential", () => {
    const mediaUnavailable: SpeechInputAvailabilityMap = {
      browser: { available: false, reason: "Browser recognition is unavailable" },
      cloud: { available: false, reason: "No accepted recorder format" },
    };
    const resolved: SpeechInputSettingsResponse = settings({
      settings: { provider: "cloud", cloud: { baseUrl: "https://api.openai.com/v1", model: "m" } },
      credential: { configured: true, source: "literal", resolution: "resolved" },
    });
    expect(resolveSpeechInputProvider(resolved, mediaUnavailable)).toEqual({
      available: false,
      reason: "No accepted recorder format",
    });
  });

  it("ignores the opaque revision when resolving providers", () => {
    const availability: SpeechInputAvailabilityMap = {
      browser: { available: false, reason: "Browser recognition is unavailable" },
      cloud: { available: true },
    };
    const first = settings({
      revision: "11111111-1111-4111-8111-111111111111",
      settings: { provider: "auto", cloud: { baseUrl: "https://api.openai.com/v1", model: "m" } },
      credential: { configured: true, source: "literal", resolution: "resolved" },
    });
    const second: SpeechInputSettingsResponse = {
      ...first,
      revision: "22222222-2222-4222-8222-222222222222",
    };
    expect(resolveSpeechInputProvider(first, availability)).toEqual(
      resolveSpeechInputProvider(second, availability),
    );
  });
});

describe("buildSpeechTranscriptInsertion", () => {
  it("inserts into empty text at the captured caret", () => {
    expect(buildSpeechTranscriptInsertion(capture("", 0, 0), "", "hello")).toEqual({
      ok: true,
      insert: "hello",
      from: 0,
      to: 0,
      caret: 5,
    });
  });

  it("adds a single left boundary space at a middle caret", () => {
    expect(buildSpeechTranscriptInsertion(capture("hello world", 5, 5), "hello world", "cruel")).toEqual({
      ok: true,
      insert: " cruel",
      from: 5,
      to: 5,
      caret: 11,
    });
  });

  it("avoids duplicate whitespace next to an existing space", () => {
    expect(buildSpeechTranscriptInsertion(capture("hello world", 6, 6), "hello world", "big")).toEqual({
      ok: true,
      insert: "big ",
      from: 6,
      to: 6,
      caret: 10,
    });
    expect(buildSpeechTranscriptInsertion(capture("hello ", 6, 6), "hello ", "world")).toEqual({
      ok: true,
      insert: "world",
      from: 6,
      to: 6,
      caret: 11,
    });
    expect(buildSpeechTranscriptInsertion(capture(" hello", 0, 0), " hello", "world")).toEqual({
      ok: true,
      insert: "world",
      from: 0,
      to: 0,
      caret: 5,
    });
  });

  it("replaces a selected range and keeps its from/to offsets", () => {
    expect(buildSpeechTranscriptInsertion(capture("hello world", 6, 11), "hello world", "there")).toEqual({
      ok: true,
      insert: "there",
      from: 6,
      to: 11,
      caret: 11,
    });
    expect(buildSpeechTranscriptInsertion(capture("aXb", 1, 2), "aXb", "y")).toEqual({
      ok: true,
      insert: " y ",
      from: 1,
      to: 2,
      caret: 4,
    });
  });

  it("bounds astral characters by UTF-16 offsets", () => {
    const before = buildSpeechTranscriptInsertion(capture("😀world", 2, 7), "😀world", "earth");
    expect(before).toEqual({ ok: true, insert: " earth", from: 2, to: 7, caret: 8 });
    if (!before.ok) throw new Error("expected a successful insertion");
    expect(before.caret).toBe(before.from + before.insert.length);

    const inside = buildSpeechTranscriptInsertion(capture("a😀b", 1, 3), "a😀b", "x");
    expect(inside).toEqual({ ok: true, insert: " x ", from: 1, to: 3, caret: 4 });
    if (!inside.ok) throw new Error("expected a successful insertion");
    expect(inside.caret).toBe(inside.from + inside.insert.length);
  });

  it("does not add a space after an opening delimiter", () => {
    expect(buildSpeechTranscriptInsertion(capture("(", 1, 1), "(", "hello")).toEqual({
      ok: true,
      insert: "hello",
      from: 1,
      to: 1,
      caret: 6,
    });
  });

  it("does not add a space before closing punctuation", () => {
    expect(buildSpeechTranscriptInsertion(capture("x", 1, 1), "x", "!")).toEqual({
      ok: true,
      insert: "!",
      from: 1,
      to: 1,
      caret: 2,
    });
  });

  it("does not add a space after a transcript-ending opening delimiter", () => {
    expect(buildSpeechTranscriptInsertion(capture("y", 0, 0), "y", "(")).toEqual({
      ok: true,
      insert: "(",
      from: 0,
      to: 0,
      caret: 1,
    });
  });

  it("does not add a space before a suffix closing punctuation character", () => {
    expect(buildSpeechTranscriptInsertion(capture("!", 0, 0), "!", "x")).toEqual({
      ok: true,
      insert: "x",
      from: 0,
      to: 0,
      caret: 1,
    });
  });

  it("trims only outer transcript whitespace and preserves internal text", () => {
    expect(buildSpeechTranscriptInsertion(capture("", 0, 0), "", "  Hello,   World!  ")).toEqual({
      ok: true,
      insert: "Hello,   World!",
      from: 0,
      to: 0,
      caret: 15,
    });
  });

  it("returns changed for stale or invalid captured documents", () => {
    expect(buildSpeechTranscriptInsertion(capture("hello", 0, 0), "goodbye", "hi")).toEqual({
      ok: false,
      reason: "changed",
    });
    expect(buildSpeechTranscriptInsertion(capture("hello", -1, 0), "hello", "hi")).toEqual({
      ok: false,
      reason: "changed",
    });
    expect(buildSpeechTranscriptInsertion(capture("hello", 2, 1), "hello", "hi")).toEqual({
      ok: false,
      reason: "changed",
    });
    expect(buildSpeechTranscriptInsertion(capture("hello", 0, 6), "hello", "hi")).toEqual({
      ok: false,
      reason: "changed",
    });
    expect(buildSpeechTranscriptInsertion(capture("hello", 0.5, 1), "hello", "hi")).toEqual({
      ok: false,
      reason: "changed",
    });
  });

  it("returns empty for blank transcripts", () => {
    expect(buildSpeechTranscriptInsertion(capture("", 0, 0), "", "")).toEqual({ ok: false, reason: "empty" });
    expect(buildSpeechTranscriptInsertion(capture("", 0, 0), "", "   \n\t ")).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("accepts exactly 1 MiB of UTF-8 transcript and rejects one byte over", () => {
    const atLimit = "a".repeat(SPEECH_INPUT_MAX_TRANSCRIPT_BYTES);
    expect(buildSpeechTranscriptInsertion(capture("", 0, 0), "", atLimit)).toEqual({
      ok: true,
      insert: atLimit,
      from: 0,
      to: 0,
      caret: atLimit.length,
    });
    expect(
      buildSpeechTranscriptInsertion(capture("", 0, 0), "", "a".repeat(SPEECH_INPUT_MAX_TRANSCRIPT_BYTES + 1)),
    ).toEqual({ ok: false, reason: "too-large" });
  });

  it("counts the transcript bound in UTF-8 bytes, not code units", () => {
    const astral = "😀".repeat(SPEECH_INPUT_MAX_TRANSCRIPT_BYTES / 4);
    expect(buildSpeechTranscriptInsertion(capture("", 0, 0), "", astral)).toEqual({
      ok: true,
      insert: astral,
      from: 0,
      to: 0,
      caret: astral.length,
    });
    expect(buildSpeechTranscriptInsertion(capture("", 0, 0), "", astral + "😀")).toEqual({
      ok: false,
      reason: "too-large",
    });
  });
});

describe("chooseSpeechInputAudioMimeType", () => {
  it("selects the first supported value in exact order", () => {
    const asked: string[] = [];
    const isTypeSupported = (type: string) => {
      asked.push(type);
      return type === "audio/mp4;codecs=mp4a.40.2";
    };
    expect(chooseSpeechInputAudioMimeType(isTypeSupported)).toBe("audio/mp4;codecs=mp4a.40.2");
    expect(asked).toEqual(["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4;codecs=mp4a.40.2"]);
  });

  it("short-circuits on the first supported value", () => {
    const asked: string[] = [];
    const isTypeSupported = (type: string) => {
      asked.push(type);
      return true;
    };
    expect(chooseSpeechInputAudioMimeType(isTypeSupported)).toBe("audio/webm;codecs=opus");
    expect(asked).toEqual(["audio/webm;codecs=opus"]);
  });

  it("prefers the codec-less mp4 form only after the parameterized forms", () => {
    const asked: string[] = [];
    const isTypeSupported = (type: string) => {
      asked.push(type);
      return type === "audio/mp4";
    };
    expect(chooseSpeechInputAudioMimeType(isTypeSupported)).toBe("audio/mp4");
    expect(asked).toEqual([
      "audio/webm;codecs=opus",
      "audio/ogg;codecs=opus",
      "audio/mp4;codecs=mp4a.40.2",
      "audio/mp4",
    ]);
  });

  it("returns undefined when no value is supported", () => {
    expect(chooseSpeechInputAudioMimeType(() => false)).toBeUndefined();
  });
});
