import type { ModelsConfigDocument } from "../../shared/apiTypes.js";
import {
  MODEL_RATE_LIMIT_FIELDS,
  modelRateLimitFieldMessage,
  modelRateLimitValuesFromEntry,
  type ModelRateLimitField,
  type ModelRateLimitInvalidReason,
  type ModelRateLimitValues,
} from "../../shared/modelRateLimits.js";

export interface ModelRateLimitIdentity {
  readonly provider: string;
  readonly modelId: string;
}

export interface ModelRateLimitValidationError {
  provider: string;
  modelId: string;
  occurrence: number;
  field: ModelRateLimitField;
  reason: ModelRateLimitInvalidReason;
  message: string;
}

export interface ModelRateLimitSnapshot {
  /** provider -> modelId -> enabled values. Empty providers/models are absent. */
  readonly limits: ReadonlyMap<string, ReadonlyMap<string, ModelRateLimitValues>>;
}

export type ModelRateLimitExtraction =
  | { ok: true; snapshot: ModelRateLimitSnapshot }
  | { ok: false; errors: readonly ModelRateLimitValidationError[] };

export function emptyModelRateLimitSnapshot(): ModelRateLimitSnapshot {
  return { limits: new Map() };
}

export function extractModelRateLimits(document: ModelsConfigDocument): ModelRateLimitExtraction {
  const limits = new Map<string, Map<string, ModelRateLimitValues>>();
  const errors: ModelRateLimitValidationError[] = [];
  const providers = document.providers;
  if (providers === undefined || !isRecord(providers)) return { ok: true, snapshot: { limits } };

  for (const provider of Object.keys(providers)) {
    const providerRecord = providers[provider];
    if (!isRecord(providerRecord)) continue;
    const models = providerRecord.models;
    if (!Array.isArray(models)) continue;

    let providerLimits = limits.get(provider);
    if (providerLimits === undefined) {
      providerLimits = new Map();
      limits.set(provider, providerLimits);
    }

    const occurrences = new Map<string, number>();
    for (const entry of models) {
      if (!isRecord(entry)) continue;
      const rawId = entry.id;
      const modelId = typeof rawId === "string" ? rawId : "";
      const occurrence = occurrences.get(modelId) ?? 0;
      occurrences.set(modelId, occurrence + 1);

      if (modelId === "") {
        for (const field of MODEL_RATE_LIMIT_FIELDS) {
          if (entry[field] === undefined) continue;
          errors.push({ provider, modelId, occurrence, field, reason: "missing-model-id", message: modelRateLimitFieldMessage(field, "missing-model-id") });
        }
        continue;
      }

      const parsed = modelRateLimitValuesFromEntry(entry);
      if (!parsed.ok) {
        errors.push({ provider, modelId, occurrence, field: parsed.field, reason: parsed.reason, message: modelRateLimitFieldMessage(parsed.field, parsed.reason) });
        continue;
      }
      providerLimits.set(modelId, parsed.values);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const enabledLimits = new Map<string, Map<string, ModelRateLimitValues>>();
  for (const [provider, providerLimits] of limits) {
    const enabled = new Map<string, ModelRateLimitValues>();
    for (const [modelId, values] of providerLimits) {
      if (values.tpm !== undefined || values.rpm !== undefined) enabled.set(modelId, values);
    }
    if (enabled.size > 0) enabledLimits.set(provider, enabled);
  }
  return { ok: true, snapshot: { limits: enabledLimits } };
}

export function modelRateLimitValuesFor(
  snapshot: ModelRateLimitSnapshot,
  identity: ModelRateLimitIdentity,
): ModelRateLimitValues | undefined {
  return snapshot.limits.get(identity.provider)?.get(identity.modelId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
