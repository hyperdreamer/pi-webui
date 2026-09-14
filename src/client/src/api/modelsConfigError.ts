import type { ModelsConfigErrorCode } from "../../../shared/apiTypes";
import type { ModelRateLimitField, ModelRateLimitInvalidReason } from "../../../shared/modelRateLimits";
import { HttpRequestError } from "./http";

export interface ModelsConfigRequestErrorDetails {
  code?: ModelsConfigErrorCode;
  file?: string;
  provider?: string;
  modelId?: string;
  field?: ModelRateLimitField;
  occurrence?: number;
  reason?: ModelRateLimitInvalidReason;
  persisted?: boolean;
}

/** Structured models-config failure thrown by `modelsConfigApi.save`. */
export class ModelsConfigRequestError extends HttpRequestError {
  readonly details: ModelsConfigRequestErrorDetails;

  constructor(message: string, status: number, details: ModelsConfigRequestErrorDetails = {}) {
    super(message, status);
    this.name = "ModelsConfigRequestError";
    this.details = details;
  }
}

const ERROR_CODES: readonly ModelsConfigErrorCode[] = [
  "MODELS_CONFIG_PARSE_FAILED",
  "MODELS_CONFIG_IO_FAILED",
  "MODELS_CONFIG_SAVE_INVALID",
  "MODELS_CONFIG_INVALID_LIMITS",
  "MODELS_CONFIG_UNREADABLE",
  "MODELS_CONFIG_PERSIST_FAILED",
  "MODELS_CONFIG_REFRESH_FAILED",
  "MODELS_CONFIG_INTERNAL",
];

const REASONS: readonly ModelRateLimitInvalidReason[] = [
  "not-a-number",
  "not-finite",
  "not-an-integer",
  "negative",
  "unsafe-integer",
  "missing-model-id",
];

/** Accepts the structured body when present and always falls back to the `error` string. */
export function modelsConfigErrorFromBody(body: unknown, status: number, fallbackMessage: string): ModelsConfigRequestError {
  const record = isRecord(body) ? body : {};
  const message = typeof record["error"] === "string" && record["error"] !== "" ? record["error"] : fallbackMessage;
  return new ModelsConfigRequestError(message, status, structuredDetails(record));
}

function structuredDetails(record: Record<string, unknown>): ModelsConfigRequestErrorDetails {
  const details: ModelsConfigRequestErrorDetails = {};
  const code = record["code"];
  if (isModelsConfigErrorCode(code)) details.code = code;
  if (typeof record["file"] === "string") details.file = record["file"];
  if (typeof record["provider"] === "string") details.provider = record["provider"];
  if (typeof record["modelId"] === "string") details.modelId = record["modelId"];
  const field = record["field"];
  if (field === "tpm" || field === "rpm") details.field = field;
  if (typeof record["occurrence"] === "number") details.occurrence = record["occurrence"];
  const reason = record["reason"];
  if (isModelRateLimitInvalidReason(reason)) details.reason = reason;
  if (typeof record["persisted"] === "boolean") details.persisted = record["persisted"];
  return details;
}

function isModelsConfigErrorCode(value: unknown): value is ModelsConfigErrorCode {
  return typeof value === "string" && ERROR_CODES.some((code) => code === value);
}

function isModelRateLimitInvalidReason(value: unknown): value is ModelRateLimitInvalidReason {
  return typeof value === "string" && REASONS.some((reason) => reason === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
