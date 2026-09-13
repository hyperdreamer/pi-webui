export const MODEL_RATE_LIMIT_FIELDS = ["tpm", "prm"] as const;
export type ModelRateLimitField = (typeof MODEL_RATE_LIMIT_FIELDS)[number];

export const MODEL_RATE_LIMIT_WINDOW_MS = 60_000;

export type ModelRateLimitInvalidReason =
  | "not-a-number"
  | "not-finite"
  | "not-an-integer"
  | "negative"
  | "unsafe-integer"
  | "missing-model-id";

export type ModelRateLimitInvalidFieldReason = Exclude<
  ModelRateLimitInvalidReason,
  "missing-model-id"
>;

export interface ModelRateLimitValues {
  tpm?: number;
  prm?: number;
}

export type ModelRateLimitFieldParse =
  | { ok: true; value: number | undefined }
  | { ok: false; reason: ModelRateLimitInvalidFieldReason };

const TERMINAL_USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

const CANONICAL_NON_NEGATIVE_INTEGER = /^(0|[1-9][0-9]*)$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates one stored `tpm`/`prm` value from models.json. */
export function parseModelRateLimitStoredValue(value: unknown): ModelRateLimitFieldParse {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number") return { ok: false, reason: "not-a-number" };
  if (!Number.isFinite(value)) return { ok: false, reason: "not-finite" };
  if (!Number.isInteger(value)) return { ok: false, reason: "not-an-integer" };
  if (value < 0) return { ok: false, reason: "negative" };
  if (!Number.isSafeInteger(value)) return { ok: false, reason: "unsafe-integer" };
  return { ok: true, value: value === 0 ? 0 : value };
}

/** Validates raw dialog input text. Blank clears the field. */
export function parseModelRateLimitDraftText(text: string): ModelRateLimitFieldParse {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  if (!CANONICAL_NON_NEGATIVE_INTEGER.test(trimmed)) return { ok: false, reason: "not-a-number" };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return { ok: false, reason: "unsafe-integer" };
  return { ok: true, value: value === 0 ? 0 : value };
}

/** Returns only enabled (positive) dimensions; omitted and 0 are absent. */
export function modelRateLimitValuesFromEntry(
  entry: Record<string, unknown>,
): { ok: true; values: ModelRateLimitValues } | { ok: false; field: ModelRateLimitField; reason: ModelRateLimitInvalidFieldReason } {
  const values: ModelRateLimitValues = {};
  for (const field of MODEL_RATE_LIMIT_FIELDS) {
    const parsed = parseModelRateLimitStoredValue(entry[field]);
    if (!parsed.ok) return { ok: false, field, reason: parsed.reason };
    if (parsed.value !== undefined && parsed.value > 0) values[field] = parsed.value;
  }
  return { ok: true, values };
}

/** Stable user-facing message shared by API errors and dialog field errors. */
export function modelRateLimitFieldMessage(field: ModelRateLimitField, reason: ModelRateLimitInvalidReason): string {
  if (reason === "missing-model-id") return "Set a Model ID before setting rate limits.";
  const label = field === "tpm" ? "Tokens per minute" : "Requests per minute";
  if (reason === "not-a-number") return `${label} must be a whole number.`;
  return `${label} must be a non-negative whole number.`;
}

/** Sums terminal usage counters; invalid or missing counters contribute zero. */
export function sumModelTerminalTokens(usage: unknown): number {
  if (!isRecord(usage)) return 0;
  let sum = 0;
  for (const field of TERMINAL_USAGE_FIELDS) {
    const value = usage[field];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) sum += value;
  }
  return sum;
}
