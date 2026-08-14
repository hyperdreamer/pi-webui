import type { PiWebUiSpeechInputConfig, SpeechInputSettings } from "./apiTypes.js";

export const SPEECH_INPUT_DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const SPEECH_INPUT_DEFAULT_MODEL = "gpt-4o-mini-transcribe";

const CANONICAL_LOWERCASE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * Canonical lowercase v4 UUID spelling, as produced by the config mutation
 * coordinator's default revision source. Opaque to clients; used to enforce
 * the wire spelling at both the server and browser parser edges.
 */
export function isCanonicalLowercaseUuid(value: string): boolean {
  return CANONICAL_LOWERCASE_UUID_PATTERN.test(value);
}

/**
 * Syntactic-only BCP 47 canonicalization. Returns undefined for malformed
 * tags; "auto" is not a valid BCP 47 tag, so omission remains the only Auto
 * wire representation.
 */
export function canonicalBcp47LanguageTag(value: string): string | undefined {
  try {
    const canonical = Intl.getCanonicalLocales(value);
    return canonical.length === 1 ? canonical[0] : undefined;
  } catch {
    return undefined;
  }
}

/** Effective nonsecret speech settings with the persisted defaults applied. */
export function effectiveSpeechInputSettings(config: PiWebUiSpeechInputConfig | undefined): SpeechInputSettings {
  return {
    provider: config?.provider ?? "auto",
    ...(config?.language === undefined ? {} : { language: config.language }),
    cloud: {
      baseUrl: config?.cloud?.baseUrl ?? SPEECH_INPUT_DEFAULT_BASE_URL,
      model: config?.cloud?.model ?? SPEECH_INPUT_DEFAULT_MODEL,
    },
  };
}

/** Canonical primary language subtag for the cloud `language` field; Auto stays omitted. */
export function speechInputCloudLanguage(language: string | undefined): string | undefined {
  if (language === undefined) return undefined;
  try {
    return new Intl.Locale(language).language;
  } catch {
    return undefined;
  }
}

/**
 * Reparses an already validated HTTPS base URL, canonicalizes URL syntax
 * (host case, default port, trailing path slashes), and appends exactly one
 * `/audio/transcriptions` segment while preserving non-root base paths.
 * Shared by the preserved-credential endpoint comparison and the cloud
 * provider so both always agree on the effective endpoint.
 */
export function speechInputTranscriptionEndpoint(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Speech input cloud base URL must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:") throw new Error("Speech input cloud base URL must use HTTPS");
  if (url.username !== "" || url.password !== "") throw new Error("Speech input cloud base URL must not contain credentials");
  if (url.search !== "") throw new Error("Speech input cloud base URL must not contain a query string");
  if (url.hash !== "") throw new Error("Speech input cloud base URL must not contain a fragment");
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${path}/audio/transcriptions`;
  return url.href;
}
