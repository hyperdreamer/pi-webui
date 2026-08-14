import type { PiWebUiConfigMutationCoordinator, PiWebUiConfigMutationSnapshot } from "../../configMutationCoordinator.js";
import type {
  PiWebUiConfigValues,
  SpeechInputCredentialMutation,
  SpeechInputSettings,
  SpeechInputSettingsResponse,
  SpeechInputSettingsUpdate,
} from "../../shared/apiTypes.js";
import { canonicalBcp47LanguageTag, effectiveSpeechInputSettings, isCanonicalLowercaseUuid, speechInputTranscriptionEndpoint } from "../../shared/speechInput.js";
import { inspectPiCompatibleCredentialSource } from "./piCompatibleCredentialResolver.js";

const PRESERVED_CREDENTIAL_ENDPOINT_MESSAGE = "Re-enter the API key source when changing the cloud base URL.";
const CONFLICT_MESSAGE = "Speech input settings changed. Reload and try again.";

const MAX_LANGUAGE_LENGTH = 128;
const MAX_BASE_URL_LENGTH = 2_048;
const MAX_MODEL_LENGTH = 256;
const MAX_CREDENTIAL_SOURCE_BYTES = 8 * 1024;

/** Typed settings validation failure; routes map it to a safe 400. */
export class SpeechInputSettingsValidationError extends Error {
  readonly code = "SPEECH_INPUT_SETTINGS_VALIDATION";
}

/** Typed revision mismatch; routes map it to a safe 409 and never write. */
export class SpeechInputSettingsConflictError extends Error {
  readonly code = "SPEECH_INPUT_SETTINGS_CONFLICT";

  constructor() {
    super(CONFLICT_MESSAGE);
  }
}

export interface SpeechInputSettingsService {
  read(): Promise<SpeechInputSettingsResponse>;
  update(value: unknown): Promise<SpeechInputSettingsResponse>;
}

export interface SpeechInputSettingsServiceDependencies {
  coordinator: PiWebUiConfigMutationCoordinator;
  /** Environment used only for the nonexecuting credential inspection. */
  env?: NodeJS.ProcessEnv;
  /** Called exactly once after a committed mutation; never on conflict/failure. */
  onCommitted?: () => void;
}

/**
 * The canonical browser surface for speech input settings. It owns the raw
 * speechInput config knowledge, projects redacted nonsecret settings plus a
 * nonexecuting credential status, and mutates exclusively through the shared
 * cross-process config mutation coordinator with revision CAS semantics.
 */
export function createSpeechInputSettingsService(dependencies: SpeechInputSettingsServiceDependencies): SpeechInputSettingsService {
  const { coordinator, env, onCommitted } = dependencies;

  const responseFromSnapshot = (snapshot: PiWebUiConfigMutationSnapshot): SpeechInputSettingsResponse => {
    const speech = snapshot.loaded.config.speechInput;
    return {
      contractVersion: 1,
      revision: snapshot.speechInputRevision,
      settings: effectiveSpeechInputSettings(speech),
      credential: inspectPiCompatibleCredentialSource(speech?.cloud?.apiKey, env),
    };
  };

  return {
    async read(): Promise<SpeechInputSettingsResponse> {
      return responseFromSnapshot(await coordinator.read());
    },

    async update(value: unknown): Promise<SpeechInputSettingsResponse> {
      const update = parseSpeechInputSettingsUpdate(value);
      const committed = await coordinator.mutate((current) => {
        // The revision comparison runs inside the transaction, before any
        // replacement is constructed, so a stale revision never rotates.
        if (update.expectedRevision !== current.speechInputRevision) {
          throw new SpeechInputSettingsConflictError();
        }
        return applyCredentialMutation(current, update);
      }, { rotateSpeechInputRevision: true });
      onCommitted?.();
      return responseFromSnapshot(committed);
    },
  };
}

function applyCredentialMutation(current: PiWebUiConfigMutationSnapshot, update: SpeechInputSettingsUpdate): PiWebUiConfigValues {
  const currentConfig = current.loaded.config;
  const mutation = update.credential;
  if (mutation.action === "preserve") return applyPreserve(currentConfig, update);
  if (mutation.action === "replace") return applyReplace(currentConfig, update, mutation.value);
  return applyClear(currentConfig);
}

function applyPreserve(currentConfig: PiWebUiConfigValues, update: SpeechInputSettingsUpdate): PiWebUiConfigValues {
  const existingSource = currentConfig.speechInput?.cloud?.apiKey;
  if (existingSource !== undefined && existingSource !== "") {
    const currentEndpoint = speechInputTranscriptionEndpoint(effectiveSpeechInputSettings(currentConfig.speechInput).cloud.baseUrl);
    const submittedEndpoint = speechInputTranscriptionEndpoint(update.settings.cloud.baseUrl);
    if (currentEndpoint !== submittedEndpoint) {
      // A preserved credential must never be redirected to a different cloud
      // endpoint; changing the destination requires replace or a prior clear.
      throw new SpeechInputSettingsValidationError(PRESERVED_CREDENTIAL_ENDPOINT_MESSAGE);
    }
  }
  return {
    ...currentConfig,
    speechInput: {
      provider: update.settings.provider,
      ...(update.settings.language === undefined ? {} : { language: update.settings.language }),
      cloud: {
        baseUrl: update.settings.cloud.baseUrl,
        model: update.settings.cloud.model,
        ...(existingSource === undefined || existingSource === "" ? {} : { apiKey: existingSource }),
      },
    },
  };
}

function applyReplace(currentConfig: PiWebUiConfigValues, update: SpeechInputSettingsUpdate, credentialValue: string): PiWebUiConfigValues {
  return {
    ...currentConfig,
    speechInput: {
      provider: update.settings.provider,
      ...(update.settings.language === undefined ? {} : { language: update.settings.language }),
      cloud: {
        baseUrl: update.settings.cloud.baseUrl,
        model: update.settings.cloud.model,
        apiKey: credentialValue,
      },
    },
  };
}

/**
 * Clear is credential-only: it copies the committed raw speech/cloud subtree
 * and removes only `apiKey`. Submitted nonsecret fields are validated but not
 * applied, and defaults are derived only for the response, never persisted.
 */
function applyClear(currentConfig: PiWebUiConfigValues): PiWebUiConfigValues {
  const speech = currentConfig.speechInput;
  if (speech === undefined) return { ...currentConfig };
  const nextSpeech = { ...speech };
  if (speech.cloud !== undefined) {
    const nextCloud = { ...speech.cloud };
    delete nextCloud.apiKey;
    nextSpeech.cloud = nextCloud;
  }
  return { ...currentConfig, speechInput: nextSpeech };
}

const UPDATE_KEYS = new Set(["expectedRevision", "settings", "credential"]);
const SETTINGS_KEYS = new Set(["provider", "language", "cloud"]);
const CLOUD_KEYS = new Set(["baseUrl", "model"]);

function parseSpeechInputSettingsUpdate(value: unknown): SpeechInputSettingsUpdate {
  const record = requireRecord(value, "Speech input settings update must be an object");
  rejectUnknownKeys(record, UPDATE_KEYS, "Speech input settings update");

  const expectedRevision = record["expectedRevision"];
  if (typeof expectedRevision !== "string" || !isCanonicalLowercaseUuid(expectedRevision)) {
    throw new SpeechInputSettingsValidationError("Speech input settings expectedRevision must be a canonical lowercase UUID");
  }

  return {
    expectedRevision,
    settings: parseSettings(record["settings"]),
    credential: parseCredentialMutation(record["credential"]),
  };
}

function parseSettings(value: unknown): SpeechInputSettings {
  const record = requireRecord(value, "Speech input settings update settings must be an object");
  rejectUnknownKeys(record, SETTINGS_KEYS, "Speech input settings update settings");

  const provider = record["provider"];
  if (provider !== "auto" && provider !== "browser" && provider !== "cloud") {
    throw new SpeechInputSettingsValidationError("Speech input settings provider must be auto, browser, or cloud");
  }

  let language: string | undefined;
  const languageValue = record["language"];
  if (languageValue !== undefined) {
    if (typeof languageValue !== "string") {
      throw new SpeechInputSettingsValidationError("Speech input settings language must be a canonical BCP 47 language tag");
    }
    const canonical = canonicalBcp47LanguageTag(languageValue);
    if (canonical === undefined || canonical.length > MAX_LANGUAGE_LENGTH) {
      throw new SpeechInputSettingsValidationError("Speech input settings language must be a canonical BCP 47 language tag");
    }
    language = canonical;
  }

  return {
    provider,
    ...(language === undefined ? {} : { language }),
    cloud: parseCloud(record["cloud"]),
  };
}

function parseCloud(value: unknown): SpeechInputSettings["cloud"] {
  const record = requireRecord(value, "Speech input settings update cloud must be an object");
  rejectUnknownKeys(record, CLOUD_KEYS, "Speech input settings update cloud");

  const baseUrlValue = record["baseUrl"];
  if (typeof baseUrlValue !== "string" || baseUrlValue.trim() === "") {
    throw new SpeechInputSettingsValidationError("Speech input settings cloud base URL must be a non-empty HTTPS URL");
  }
  const baseUrl = baseUrlValue.trim();
  if (baseUrl.length > MAX_BASE_URL_LENGTH) {
    throw new SpeechInputSettingsValidationError("Speech input settings cloud base URL must be at most 2048 characters");
  }
  validateHttpsBaseUrl(baseUrl);

  const modelValue = record["model"];
  if (typeof modelValue !== "string" || modelValue.trim() === "") {
    throw new SpeechInputSettingsValidationError("Speech input settings cloud model must be a non-empty string");
  }
  const model = modelValue.trim();
  if (model.length > MAX_MODEL_LENGTH) {
    throw new SpeechInputSettingsValidationError("Speech input settings cloud model must be at most 256 characters");
  }

  return { baseUrl, model };
}

function validateHttpsBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SpeechInputSettingsValidationError("Speech input settings cloud base URL must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:") {
    throw new SpeechInputSettingsValidationError("Speech input settings cloud base URL must use HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new SpeechInputSettingsValidationError("Speech input settings cloud base URL must not contain credentials");
  }
  if (url.search !== "") {
    throw new SpeechInputSettingsValidationError("Speech input settings cloud base URL must not contain a query string");
  }
  if (url.hash !== "") {
    throw new SpeechInputSettingsValidationError("Speech input settings cloud base URL must not contain a fragment");
  }
}

function parseCredentialMutation(value: unknown): SpeechInputCredentialMutation {
  const record = requireRecord(value, "Speech input settings update credential must be an object");
  const action = record["action"];
  if (action !== "preserve" && action !== "replace" && action !== "clear") {
    throw new SpeechInputSettingsValidationError("Speech input settings credential action must be preserve, replace, or clear");
  }

  const keys = Object.keys(record);
  if (action === "preserve" || action === "clear") {
    if (keys.length !== 1) {
      throw new SpeechInputSettingsValidationError(`Speech input settings credential ${action} must not include extra fields`);
    }
    return { action };
  }

  if (keys.length !== 2 || !Object.prototype.hasOwnProperty.call(record, "value")) {
    throw new SpeechInputSettingsValidationError("Speech input settings credential replace must include exactly one value");
  }
  const credentialValue = record["value"];
  if (typeof credentialValue !== "string" || credentialValue.trim() === "") {
    throw new SpeechInputSettingsValidationError("Speech input settings credential replace value must be a nonblank string");
  }
  if (Buffer.byteLength(credentialValue, "utf8") > MAX_CREDENTIAL_SOURCE_BYTES) {
    throw new SpeechInputSettingsValidationError("Speech input settings credential replace value must be at most 8 KiB of UTF-8 text");
  }
  // The exact submitted source is stored byte-for-byte; never normalized.
  return { action: "replace", value: credentialValue };
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new SpeechInputSettingsValidationError(message);
  return value;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: Set<string>, field: string): void {
  const unknownKey = Object.keys(record).find((key) => !allowed.has(key));
  if (unknownKey !== undefined) {
    throw new SpeechInputSettingsValidationError(`${field} contains unknown key ${JSON.stringify(unknownKey)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
