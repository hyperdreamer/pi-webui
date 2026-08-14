import { describe, expect, it } from "vitest";
import {
  parseSpeechInputAudioMimeType,
  speechInputAudioFilename,
} from "./speechInputAudio.js";

describe("speech input audio MIME helpers", () => {
  it.each([
    ["audio/webm;codecs=opus", "audio/webm;codecs=opus", "speech.webm"],
    [" AUDIO/WEBM ; CODECS = OPUS ", "audio/webm;codecs=opus", "speech.webm"],
    ["audio/ogg;codecs=opus", "audio/ogg;codecs=opus", "speech.ogg"],
    ["Audio/Ogg ; codecs = Opus", "audio/ogg;codecs=opus", "speech.ogg"],
    ["audio/mp4;codecs=mp4a.40.2", "audio/mp4;codecs=mp4a.40.2", "speech.m4a"],
    [" AUDIO/MP4 ; CODECS = MP4A.40.2 ", "audio/mp4;codecs=mp4a.40.2", "speech.m4a"],
    ["audio/mp4", "audio/mp4", "speech.m4a"],
    [" AUDIO/MP4 ", "audio/mp4", "speech.m4a"],
  ] as const)("canonicalizes %s", (input, expected, filename) => {
    const mimeType = parseSpeechInputAudioMimeType(input);

    expect(mimeType).toBe(expected);
    if (mimeType !== undefined) expect(speechInputAudioFilename(mimeType)).toBe(filename);
  });

  it.each([
    undefined,
    "",
    "audio/webm",
    "audio/ogg",
    "audio/webm;codecs=vp9",
    "audio/ogg;codecs=vorbis",
    "audio/mp4;codecs=opus",
    "audio/webm; charset=utf-8; codecs=opus",
    "audio/ogg;codecs=opus;foo=bar",
    "audio/mp4; charset=utf-8",
    "video/webm;codecs=opus",
    "audio /webm;codecs=opus",
  ])("rejects unsupported or parameterized MIME %s", (value) => {
    expect(parseSpeechInputAudioMimeType(value)).toBeUndefined();
  });
});
