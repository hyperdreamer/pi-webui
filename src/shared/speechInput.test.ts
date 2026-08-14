import { describe, expect, it } from "vitest";
import {
  SPEECH_INPUT_DEFAULT_BASE_URL,
  SPEECH_INPUT_DEFAULT_MODEL,
  canonicalBcp47LanguageTag,
  effectiveSpeechInputSettings,
  isCanonicalLowercaseUuid,
  speechInputCloudLanguage,
  speechInputTranscriptionEndpoint,
} from "./speechInput";

describe("speech input settings projection", () => {
  it("resolves omitted config to Auto without a language and the OpenAI defaults", () => {
    const expected = {
      provider: "auto",
      cloud: { baseUrl: SPEECH_INPUT_DEFAULT_BASE_URL, model: SPEECH_INPUT_DEFAULT_MODEL },
    };
    expect(effectiveSpeechInputSettings(undefined)).toEqual(expected);
    expect(effectiveSpeechInputSettings({})).toEqual(expected);
  });

  it("keeps explicit canonical values", () => {
    expect(effectiveSpeechInputSettings({
      provider: "browser",
      language: "pt-BR",
      cloud: { baseUrl: "https://gateway.example.test/v1", model: "whisper-1" },
    })).toEqual({
      provider: "browser",
      language: "pt-BR",
      cloud: { baseUrl: "https://gateway.example.test/v1", model: "whisper-1" },
    });
  });

  it("derives defaults for omitted cloud fields", () => {
    expect(effectiveSpeechInputSettings({ cloud: { baseUrl: "https://gateway.example.test/" } }).cloud).toEqual({
      baseUrl: "https://gateway.example.test/",
      model: SPEECH_INPUT_DEFAULT_MODEL,
    });
    expect(effectiveSpeechInputSettings({ provider: "cloud" }).cloud).toEqual({
      baseUrl: SPEECH_INPUT_DEFAULT_BASE_URL,
      model: SPEECH_INPUT_DEFAULT_MODEL,
    });
  });
});

describe("speech input cloud language mapping", () => {
  it("maps canonical BCP 47 tags to their primary language subtag", () => {
    expect(speechInputCloudLanguage("pt-BR")).toBe("pt");
    expect(speechInputCloudLanguage("en-US")).toBe("en");
    expect(speechInputCloudLanguage("pt")).toBe("pt");
    expect(speechInputCloudLanguage("zh-Hant-TW")).toBe("zh");
  });

  it("keeps Auto without a language", () => {
    expect(speechInputCloudLanguage(undefined)).toBeUndefined();
  });
});

describe("speech input transcription endpoint construction", () => {
  it("appends exactly one /audio/transcriptions path segment", () => {
    expect(speechInputTranscriptionEndpoint("https://api.openai.com/v1"))
      .toBe("https://api.openai.com/v1/audio/transcriptions");
  });

  it("canonicalizes host case, default HTTPS port, and trailing path slashes", () => {
    expect(speechInputTranscriptionEndpoint("https://API.OpenAI.com:443/v1///"))
      .toBe(speechInputTranscriptionEndpoint("https://api.openai.com/v1"));
    expect(speechInputTranscriptionEndpoint("https://api.openai.com:443/"))
      .toBe("https://api.openai.com/audio/transcriptions");
    expect(speechInputTranscriptionEndpoint("https://api.openai.com:443"))
      .toBe("https://api.openai.com/audio/transcriptions");
  });

  it("preserves non-root base paths", () => {
    expect(speechInputTranscriptionEndpoint("https://gateway.example.test/speech/openai/v1/"))
      .toBe("https://gateway.example.test/speech/openai/v1/audio/transcriptions");
    expect(speechInputTranscriptionEndpoint("https://gateway.example.test/speech/openai/v1"))
      .toBe("https://gateway.example.test/speech/openai/v1/audio/transcriptions");
    expect(speechInputTranscriptionEndpoint("https://gateway.example.test"))
      .toBe("https://gateway.example.test/audio/transcriptions");
    expect(speechInputTranscriptionEndpoint("https://gateway.example.test/"))
      .toBe("https://gateway.example.test/audio/transcriptions");
  });

  it("rejects insecure or credential/query/fragment-bearing base URLs", () => {
    for (const baseUrl of [
      "http://api.openai.com/v1",
      "https://user@api.openai.com/v1",
      "https://:pass@api.openai.com/v1",
      "https://api.openai.com/v1?key=x",
      "https://api.openai.com/v1#frag",
      "not a url",
      "",
    ]) {
      expect(() => speechInputTranscriptionEndpoint(baseUrl)).toThrow();
    }
  });
});

describe("canonical lowercase UUID and BCP 47 helpers", () => {
  it("accepts canonical lowercase UUID revisions", () => {
    expect(isCanonicalLowercaseUuid("00000000-0000-4000-8000-000000000001")).toBe(true);
    expect(isCanonicalLowercaseUuid("01234567-89ab-4cde-8f01-23456789abcd")).toBe(true);
  });

  it("rejects noncanonical UUID spellings", () => {
    for (const value of [
      "01234567-89ab-4cde-8f01-23456789abcd".toUpperCase(),
      "00000000-0000-4000-8000-00000000000",
      "00000000-0000-4000-8000-0000000000010",
      "0000000000004000800000000000000001",
      "00000000-0000-5000-8000-000000000001",
      "00000000-0000-4000-c000-000000000001",
      "00000000_0000-4000-8000-000000000001",
      "",
    ]) {
      expect(isCanonicalLowercaseUuid(value)).toBe(false);
    }
  });

  it("canonicalizes BCP 47 tags syntactically without accepting Auto", () => {
    expect(canonicalBcp47LanguageTag("en-us")).toBe("en-US");
    expect(canonicalBcp47LanguageTag("pt-BR")).toBe("pt-BR");
    expect(canonicalBcp47LanguageTag("zh-Hant-TW")).toBe("zh-Hant-TW");
    expect(canonicalBcp47LanguageTag("auto")).toBeUndefined();
    expect(canonicalBcp47LanguageTag("not a tag")).toBeUndefined();
    expect(canonicalBcp47LanguageTag("")).toBeUndefined();
  });
});
