import {
  MODEL_RATE_LIMIT_FIELDS,
  modelRateLimitFieldMessage,
  parseModelRateLimitDraftText,
  parseModelRateLimitStoredValue,
  type ModelRateLimitField,
} from "../../../../shared/modelRateLimits";
import type { ModelsConfigDocument, ModelsConfigModel, ModelsConfigProvider } from "../../api";

export const MODEL_API_OPTIONS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;

interface ModelApiOptionState {
  api: (typeof MODEL_API_OPTIONS)[number];
  selected: boolean;
}

/**
 * Keep selection on each option so a freshly mounted select can resolve it
 * after Lit inserts the dynamic option list.
 */
export function modelApiOptionStates(selectedApi: string | undefined): readonly ModelApiOptionState[] {
  return MODEL_API_OPTIONS.map((api) => ({ api, selected: api === selectedApi }));
}

/** Preserve the configured model selection while Lit mounts fetched options. */
export function modelIdOptionStates<T extends { id: string }>(
  candidates: readonly T[],
  selectedModelId: string,
): readonly { candidate: T; selected: boolean }[] {
  return candidates.map((candidate) => ({ candidate, selected: candidate.id === selectedModelId }));
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ThinkingLevelMapMode = "default" | "disabled" | "custom";

export interface AddedCustomProvider {
  config: ModelsConfigDocument;
  providerName: string;
}

export type ProviderRenameResult =
  | { config: ModelsConfigDocument }
  | { config: ModelsConfigDocument; error: string };

export function addCustomProvider(config: ModelsConfigDocument): AddedCustomProvider {
  const providers = config.providers ?? {};
  const providerName = nextCustomProviderName(providers);
  return {
    config: withProviders(config, { ...providers, [providerName]: { api: "openai-completions" } }),
    providerName,
  };
}

export function renameProvider(config: ModelsConfigDocument, oldName: string, requestedName: string): ProviderRenameResult {
  const newName = requestedName.trim();
  const providers = config.providers ?? {};
  if (newName === "") return { config, error: "Provider name is required." };
  if (oldName === newName) return { config };
  if (providers[oldName] === undefined) return { config, error: `Provider "${oldName}" no longer exists.` };
  if (providers[newName] !== undefined) return { config, error: `A provider named "${newName}" already exists.` };

  const renamed: Record<string, ModelsConfigProvider> = {};
  for (const [name, provider] of Object.entries(providers)) {
    renamed[name === oldName ? newName : name] = provider;
  }
  return { config: withProviders(config, renamed) };
}

export function updateProvider(config: ModelsConfigDocument, providerName: string, provider: ModelsConfigProvider): ModelsConfigDocument {
  const providers = config.providers ?? {};
  if (providers[providerName] === undefined) return config;
  return withProviders(config, { ...providers, [providerName]: provider });
}

export function removeProvider(config: ModelsConfigDocument, providerName: string): ModelsConfigDocument {
  const providers = config.providers ?? {};
  if (providers[providerName] === undefined) return config;
  return withProviders(config, providersWithout(providers, providerName));
}

export function addModel(config: ModelsConfigDocument, providerName: string): ModelsConfigDocument {
  const provider = config.providers?.[providerName];
  if (provider === undefined) return config;
  const models = [...(provider.models ?? []), { id: "" }];
  return updateProvider(config, providerName, { ...provider, models });
}

export function updateModel(config: ModelsConfigDocument, providerName: string, index: number, model: ModelsConfigModel): ModelsConfigDocument {
  const provider = config.providers?.[providerName];
  const currentModels = provider?.models;
  if (provider === undefined || currentModels === undefined || index < 0 || index >= currentModels.length) return config;
  const models = [...currentModels];
  models[index] = model;
  return updateProvider(config, providerName, { ...provider, models });
}

export function removeModel(config: ModelsConfigDocument, providerName: string, index: number): ModelsConfigDocument {
  const provider = config.providers?.[providerName];
  const currentModels = provider?.models;
  if (provider === undefined || currentModels === undefined || index < 0 || index >= currentModels.length) return config;
  const models = currentModels.filter((_model, candidateIndex) => candidateIndex !== index);
  if (models.length === 0) {
    const nextProvider = { ...provider };
    delete nextProvider.models;
    return updateProvider(config, providerName, nextProvider);
  }
  return updateProvider(config, providerName, { ...provider, models });
}

export function setThinkingLevelMapEntry(
  map: Record<string, string | null> | undefined,
  level: ThinkingLevel,
  mode: ThinkingLevelMapMode,
  value?: string,
): Record<string, string | null> | undefined {
  const next = mode === "default" ? thinkingLevelMapWithout(map ?? {}, level) : { ...(map ?? {}) };
  if (mode === "disabled") next[level] = null;
  if (mode === "custom") {
    const trimmed = value?.trim();
    next[level] = trimmed === undefined || trimmed === "" ? level : trimmed;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

export interface ModelRateLimitFieldDraft {
  /** Text shown in the numeric input. "" means clear. */
  text: string;
  /** Raw loaded value when the stored value cannot be represented as input text. */
  loadedInvalidValue?: unknown;
  /** Present while this field is invalid; blocks Save. */
  error?: string;
}

export interface ModelRateLimitDraft {
  tpm: ModelRateLimitFieldDraft;
  prm: ModelRateLimitFieldDraft;
}

export type ModelRateLimitDraftMap = Record<string, ModelRateLimitDraft>;

export type RateLimitDraftReconciliationChange =
  | { type: "rename"; providerName: string; from: string; to: string }
  | { type: "delete"; providerName: string; modelId: string; occurrence: number };

/** Unambiguous identity key for one models[] occurrence. */
export function rateLimitDraftKey(providerName: string, modelId: string, occurrence: number): string {
  return JSON.stringify(["model-rate-limit-draft", providerName, modelId, occurrence]);
}

export function modelRateLimitDraftsFromDocument(document: ModelsConfigDocument): ModelRateLimitDraftMap {
  const drafts: ModelRateLimitDraftMap = {};
  for (const [providerName, provider] of Object.entries(document.providers ?? {})) {
    const occurrences = new Map<string, number>();
    for (const model of provider.models ?? []) {
      const occurrence = occurrences.get(model.id) ?? 0;
      occurrences.set(model.id, occurrence + 1);
      drafts[rateLimitDraftKey(providerName, model.id, occurrence)] = modelRateLimitDraftFromEntry(model);
    }
  }
  return drafts;
}

export function applyRateLimitDraftField(
  draft: ModelRateLimitDraft,
  field: ModelRateLimitField,
  text: string,
): ModelRateLimitDraft {
  const parsed = parseModelRateLimitDraftText(text);
  const nextField: ModelRateLimitFieldDraft = parsed.ok
    ? { text }
    : { text, error: modelRateLimitFieldMessage(field, parsed.reason) };
  return { ...draft, [field]: nextField };
}

export function setModelRateLimitField(
  model: ModelsConfigModel,
  field: ModelRateLimitField,
  value: number | undefined,
): ModelsConfigModel {
  const next = { ...model };
  if (value !== undefined) {
    next[field] = value;
    return next;
  }
  if (field === "tpm") {
    delete next.tpm;
  } else {
    delete next.prm;
  }
  return next;
}

export function reconcileRateLimitDrafts(
  drafts: ModelRateLimitDraftMap,
  previousDocument: ModelsConfigDocument,
  nextDocument: ModelsConfigDocument,
  change?: RateLimitDraftReconciliationChange,
): ModelRateLimitDraftMap {
  const carried = change === undefined ? { ...drafts } : draftsAfterChange(drafts, previousDocument, change);
  const nextDrafts = modelRateLimitDraftsFromDocument(nextDocument);
  const result: ModelRateLimitDraftMap = {};
  for (const [key, nextDraft] of Object.entries(nextDrafts)) {
    result[key] = carried[key] ?? nextDraft;
  }
  return result;
}

export function firstInvalidRateLimitDraft(
  drafts: ModelRateLimitDraftMap,
): { key: string; providerName: string; modelId: string; field: ModelRateLimitField; message: string } | undefined {
  for (const [key, draft] of Object.entries(drafts)) {
    for (const field of MODEL_RATE_LIMIT_FIELDS) {
      const error = draft[field].error;
      if (error === undefined) continue;
      const identity = rateLimitDraftKeyIdentity(key);
      return { key, providerName: identity.providerName, modelId: identity.modelId, field, message: error };
    }
  }
  return undefined;
}

function withProviders(config: ModelsConfigDocument, providers: Record<string, ModelsConfigProvider>): ModelsConfigDocument {
  return { ...config, providers };
}

function providersWithout(providers: Record<string, ModelsConfigProvider>, nameToRemove: string): Record<string, ModelsConfigProvider> {
  const next: Record<string, ModelsConfigProvider> = {};
  for (const [name, provider] of Object.entries(providers)) {
    if (name !== nameToRemove) next[name] = provider;
  }
  return next;
}

function thinkingLevelMapWithout(map: Record<string, string | null>, levelToRemove: ThinkingLevel): Record<string, string | null> {
  const next: Record<string, string | null> = {};
  for (const [level, value] of Object.entries(map)) {
    if (level !== levelToRemove) next[level] = value;
  }
  return next;
}

function nextCustomProviderName(providers: Record<string, ModelsConfigProvider>): string {
  let candidate = "new-provider";
  let index = 1;
  while (providers[candidate] !== undefined) candidate = `new-provider-${String(index++)}`;
  return candidate;
}

function modelRateLimitDraftFromEntry(entry: ModelsConfigModel): ModelRateLimitDraft {
  const draft: ModelRateLimitDraft = { tpm: { text: "" }, prm: { text: "" } };
  for (const field of MODEL_RATE_LIMIT_FIELDS) {
    const parsed = parseModelRateLimitStoredValue(entry[field]);
    if (!parsed.ok) {
      draft[field] = { text: "", loadedInvalidValue: entry[field], error: modelRateLimitFieldMessage(field, parsed.reason) };
    } else if (parsed.value !== undefined) {
      draft[field] = { text: String(parsed.value) };
    }
  }
  return draft;
}

function draftsAfterChange(
  drafts: ModelRateLimitDraftMap,
  previousDocument: ModelsConfigDocument,
  change: RateLimitDraftReconciliationChange,
): ModelRateLimitDraftMap {
  if (change.type === "rename") {
    const unchanged: ModelRateLimitDraftMap = {};
    const moved: ModelRateLimitDraftMap = {};
    for (const [key, draft] of Object.entries(drafts)) {
      const identity = rateLimitDraftKeyIdentity(key);
      if (identity.providerName === change.providerName && identity.modelId === change.from) {
        moved[rateLimitDraftKey(change.providerName, change.to, identity.occurrence)] = draft;
      } else {
        unchanged[key] = draft;
      }
    }
    return { ...unchanged, ...moved };
  }

  const count = occurrenceCount(previousDocument, change.providerName, change.modelId);
  const next: ModelRateLimitDraftMap = {};
  for (const [key, draft] of Object.entries(drafts)) {
    const identity = rateLimitDraftKeyIdentity(key);
    if (identity.providerName !== change.providerName || identity.modelId !== change.modelId) {
      next[key] = draft;
      continue;
    }
    if (identity.occurrence === change.occurrence) continue;
    const shiftedOccurrence =
      identity.occurrence > change.occurrence && identity.occurrence < count ? identity.occurrence - 1 : identity.occurrence;
    next[rateLimitDraftKey(change.providerName, change.modelId, shiftedOccurrence)] = draft;
  }
  return next;
}

function occurrenceCount(document: ModelsConfigDocument, providerName: string, modelId: string): number {
  const models = document.providers?.[providerName]?.models ?? [];
  return models.filter((model) => model.id === modelId).length;
}

function rateLimitDraftKeyIdentity(key: string): { providerName: string; modelId: string; occurrence: number } {
  const parsed: unknown = JSON.parse(key);
  if (!Array.isArray(parsed)) return { providerName: "", modelId: "", occurrence: -1 };
  const entry: readonly unknown[] = parsed;
  return {
    providerName: typeof entry[1] === "string" ? entry[1] : "",
    modelId: typeof entry[2] === "string" ? entry[2] : "",
    occurrence: typeof entry[3] === "number" ? entry[3] : -1,
  };
}
