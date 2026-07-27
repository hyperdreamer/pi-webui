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
