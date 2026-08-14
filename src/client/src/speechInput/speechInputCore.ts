import type { SpeechInputSettingsResponse } from "../../../shared/apiTypes";
import { SPEECH_INPUT_MAX_TRANSCRIPT_BYTES, type SpeechInputAudioMimeType } from "../../../shared/speechInputAudio";

export type SpeechInputProviderId = "browser" | "cloud";

export type SpeechInputAvailability =
  | { available: true }
  | { available: false; reason: string };

export interface SpeechInputAvailabilityMap {
  browser: SpeechInputAvailability;
  cloud: SpeechInputAvailability;
}

export type SpeechInputProviderResolution =
  | { available: true; provider: SpeechInputProviderId }
  | { available: false; reason: string };

export type SpeechInputComposerIdentity =
  | { kind: "starter"; machineId: string; projectId: string; workspaceId: string }
  | { kind: "session"; machineId: string; projectId: string; workspaceId: string; sessionId: string };

export interface SpeechInputTargetSnapshot {
  identity: SpeechInputComposerIdentity;
  text: string;
  from: number;
  to: number;
}

export type SpeechTranscriptInsertion =
  | { ok: true; insert: string; from: number; to: number; caret: number }
  | { ok: false; reason: "empty" | "too-large" | "changed" };

/** Characters after which a dictated word must not gain a boundary space. */
const OPENING_DELIMITERS = new Set(["(", "[", "{"]);

/** Characters before which a dictated word must not gain a boundary space. */
const CLOSING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "%", ")", "]", "}"]);

function isNonWhitespace(char: string | undefined): char is string {
  return char !== undefined && !/\s/u.test(char);
}

function cloudUnavailableReason(settings: SpeechInputSettingsResponse, availability: SpeechInputAvailabilityMap): string {
  const resolution = settings.credential.resolution;
  if (resolution === "missing") return "Cloud credential is not configured";
  if (resolution === "unresolved") return "Cloud credential is unresolved";
  if (!availability.cloud.available) return availability.cloud.reason;
  // Unreachable from callers: a resolved/unchecked credential with media
  // available is exactly what cloudEligible() accepts.
  return "Cloud is unavailable";
}

function cloudEligible(settings: SpeechInputSettingsResponse, availability: SpeechInputAvailabilityMap): boolean {
  const resolution = settings.credential.resolution;
  return (
    availability.cloud.available &&
    (resolution === "resolved" || resolution === "unchecked")
  );
}

/**
 * Resolves the provider for one run. Auto evaluates Browser then Cloud once;
 * explicit choices never fall back. Cloud eligibility combines the page-local
 * recorder capability with the gateway credential status: a missing or
 * unresolved credential is unavailable before capture, while a command source
 * stays eligible because routine checks must not execute it.
 */
export function resolveSpeechInputProvider(
  settings: SpeechInputSettingsResponse,
  availability: SpeechInputAvailabilityMap,
): SpeechInputProviderResolution {
  const preference = settings.settings.provider;
  if (preference === "browser") {
    return availability.browser.available
      ? { available: true, provider: "browser" }
      : { available: false, reason: availability.browser.reason };
  }
  if (preference === "cloud") {
    return cloudEligible(settings, availability)
      ? { available: true, provider: "cloud" }
      : { available: false, reason: cloudUnavailableReason(settings, availability) };
  }
  if (availability.browser.available) return { available: true, provider: "browser" };
  if (cloudEligible(settings, availability)) return { available: true, provider: "cloud" };
  return {
    available: false,
    reason: `${availability.browser.reason}; ${cloudUnavailableReason(settings, availability)}`,
  };
}

const textEncoder = new TextEncoder();

/**
 * Builds the single CodeMirror insertion for a final transcript, or a stable
 * failure reason. Outer transcript whitespace is trimmed; internal whitespace,
 * punctuation, and capitalization are preserved. Boundary spaces are added
 * only when adjacent non-whitespace text would otherwise join words, never
 * after an opening delimiter or before closing punctuation. The returned
 * caret is a JavaScript/CodeMirror UTF-16 offset.
 */
export function buildSpeechTranscriptInsertion(
  captured: SpeechInputTargetSnapshot,
  currentText: string,
  transcript: string,
): SpeechTranscriptInsertion {
  if (
    !Number.isInteger(captured.from) ||
    !Number.isInteger(captured.to) ||
    captured.from < 0 ||
    captured.to < captured.from ||
    captured.to > captured.text.length
  ) {
    return { ok: false, reason: "changed" };
  }
  if (currentText !== captured.text) return { ok: false, reason: "changed" };

  const trimmed = transcript.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  if (textEncoder.encode(trimmed).byteLength > SPEECH_INPUT_MAX_TRANSCRIPT_BYTES) {
    return { ok: false, reason: "too-large" };
  }

  const leftChar = captured.text[captured.from - 1];
  const rightChar = captured.text[captured.to];
  const firstChar = trimmed[0];
  const lastChar = trimmed[trimmed.length - 1];

  const leftSpace =
    isNonWhitespace(leftChar) &&
    isNonWhitespace(firstChar) &&
    !OPENING_DELIMITERS.has(leftChar) &&
    !CLOSING_PUNCTUATION.has(firstChar);
  const rightSpace =
    isNonWhitespace(lastChar) &&
    isNonWhitespace(rightChar) &&
    !OPENING_DELIMITERS.has(lastChar) &&
    !CLOSING_PUNCTUATION.has(rightChar);

  const insert = (leftSpace ? " " : "") + trimmed + (rightSpace ? " " : "");
  return { ok: true, insert, from: captured.from, to: captured.to, caret: captured.from + insert.length };
}

/**
 * Chooses the recorder format from the exact design allowlist in order,
 * returning the first value the browser supports.
 */
export function chooseSpeechInputAudioMimeType(
  isTypeSupported: (type: string) => boolean,
): SpeechInputAudioMimeType | undefined {
  const candidates: SpeechInputAudioMimeType[] = [
    "audio/webm;codecs=opus",
    "audio/ogg;codecs=opus",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
  ];
  return candidates.find((candidate) => isTypeSupported(candidate));
}
