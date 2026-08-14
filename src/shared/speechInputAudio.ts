export const SPEECH_INPUT_MAX_AUDIO_BYTES = 20 * 1024 * 1024;
export const SPEECH_INPUT_MAX_TRANSCRIPT_BYTES = 1024 * 1024;
export const SPEECH_INPUT_PROVIDER_TIMEOUT_MS = 120_000;
export const SPEECH_INPUT_UPLOAD_TIMEOUT_MS = 130_000;

export type SpeechInputAudioMimeType =
  | "audio/webm;codecs=opus"
  | "audio/ogg;codecs=opus"
  | "audio/mp4;codecs=mp4a.40.2"
  | "audio/mp4";

const MIME_TYPE_PATTERN = /^\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\/([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?:\s*;\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*([!#$%&'*+.^_`|~0-9A-Za-z.-]+))?\s*$/u;

/**
 * Strictly recognizes the recorder formats PI WEBUI can forward without
 * changing the encoded container. Header field names and token values are
 * case-insensitive here because browsers vary their Content-Type spelling.
 */
export function parseSpeechInputAudioMimeType(value: string | undefined): SpeechInputAudioMimeType | undefined {
  if (value === undefined) return undefined;
  const match = MIME_TYPE_PATTERN.exec(value);
  if (match === null) return undefined;
  const type = match[1]?.toLowerCase();
  const subtype = match[2]?.toLowerCase();
  const parameter = match[3]?.toLowerCase();
  const parameterValue = match[4]?.toLowerCase();
  const mediaType = type === undefined || subtype === undefined ? undefined : `${type}/${subtype}`;

  if (mediaType === "audio/webm" && parameter === "codecs" && parameterValue === "opus") {
    return "audio/webm;codecs=opus";
  }
  if (mediaType === "audio/ogg" && parameter === "codecs" && parameterValue === "opus") {
    return "audio/ogg;codecs=opus";
  }
  if (mediaType === "audio/mp4" && parameter === "codecs" && parameterValue === "mp4a.40.2") {
    return "audio/mp4;codecs=mp4a.40.2";
  }
  if (mediaType === "audio/mp4" && parameter === undefined) return "audio/mp4";
  return undefined;
}

export function speechInputAudioFilename(value: SpeechInputAudioMimeType): "speech.webm" | "speech.ogg" | "speech.m4a" {
  if (value === "audio/webm;codecs=opus") return "speech.webm";
  if (value === "audio/ogg;codecs=opus") return "speech.ogg";
  return "speech.m4a";
}
