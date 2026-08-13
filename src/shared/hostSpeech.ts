import type { PiWebUiTtsConfig } from "./apiTypes.js";

export const HOST_SPEECH_MAX_TEXT_CHARS = 4_000;
export const HOST_SPEECH_MAX_RUN_ID_CHARS = 128;

export function effectivePiWebUiTtsConfig(config: PiWebUiTtsConfig | undefined): {
  voice?: string;
  rate: number;
} {
  return {
    ...(config?.voice !== undefined ? { voice: config.voice } : {}),
    rate: config?.rate ?? 0,
  };
}

export function truncateHostSpeechText(text: string): string {
  // Normalize CRLF/CR to LF, remove NUL and control chars (Cc) except LF (\n) and Tab (\t)
  const normalized = text
    .replace(/\r\n|\r/gu, "\n")
    .replace(/(?!\t|\n)\p{Cc}/gu, "");
  let sliced = normalized.slice(0, HOST_SPEECH_MAX_TEXT_CHARS);
  if (sliced.length === HOST_SPEECH_MAX_TEXT_CHARS) {
    const last = sliced.charCodeAt(sliced.length - 1);
    const next = normalized.charCodeAt(HOST_SPEECH_MAX_TEXT_CHARS);
    if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
      sliced = sliced.slice(0, -1);
    }
  }
  return sliced.trimEnd();
}

const RUN_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function isHostSpeechRunId(value: string): boolean {
  return RUN_ID_REGEX.test(value);
}
