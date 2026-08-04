import type {
  UtilityModelSettings,
  UtilityModelSlot,
} from "../../shared/apiTypes.js";

export type UtilityModelTask = "lightweight" | "context";

export interface UtilityModelIdentity {
  provider: string;
  id: string;
}

export interface UtilityModelResolver<
  TModel extends UtilityModelIdentity,
> {
  configuredCandidates: (task: UtilityModelTask) => Promise<readonly TModel[]>;
}

export interface UtilityModelResolverConfig {
  utilityModels?: UtilityModelSettings;
  utilityModelsError?: string;
}

export interface UtilityModelResolverRuntime<
  TModel extends UtilityModelIdentity,
> {
  refresh(options?: { allowNetwork?: boolean }): Promise<unknown>;
  getAvailableSnapshot(): readonly TModel[];
}

export interface UtilityModelResolverLogger {
  info(details: Record<string, unknown>, message: string): void;
}

export interface UtilityModelResolverDependencies<
  TModel extends UtilityModelIdentity,
> {
  loadConfig(): UtilityModelResolverConfig;
  modelRuntime: UtilityModelResolverRuntime<TModel>;
  logger?: UtilityModelResolverLogger;
}

const taskSlots: Record<UtilityModelTask, readonly UtilityModelSlot[]> = {
  lightweight: ["lightweight"],
  context: ["context", "lightweight"],
};

export function createUtilityModelResolver<
  TModel extends UtilityModelIdentity,
>(
  deps: UtilityModelResolverDependencies<TModel>,
): UtilityModelResolver<TModel> {
  return {
    configuredCandidates: async (task) => {
      try {
        await deps.modelRuntime.refresh({ allowNetwork: false });
        const config = deps.loadConfig();
        if (
          config.utilityModelsError !== undefined ||
          config.utilityModels === undefined
        ) {
          return [];
        }

        const available = deps.modelRuntime.getAvailableSnapshot();
        const candidates: TModel[] = [];
        const seen = new Set<string>();
        for (const slot of taskSlots[task]) {
          const reference = config.utilityModels[slot];
          if (reference === undefined) continue;
          const candidate = available.find(
            (model) =>
              model.provider === reference.provider && model.id === reference.id,
          );
          if (candidate === undefined) continue;
          const key = modelKey(candidate);
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push(candidate);
        }
        return candidates;
      } catch (error) {
        logNoThrow(
          deps.logger,
          { err: error, task },
          "utility model resolution failed",
        );
        return [];
      }
    },
  };
}

export async function runWithUtilityModelFallback<
  TModel extends UtilityModelIdentity,
  TResult,
>(
  resolver: UtilityModelResolver<TModel>,
  task: UtilityModelTask,
  activeModel: TModel | undefined,
  run: (model: TModel) => Promise<TResult | undefined> | TResult | undefined,
  onFailure?: (model: TModel, error: unknown) => void,
): Promise<TResult | undefined> {
  const configured = await resolver.configuredCandidates(task);
  const candidates: TModel[] = [];
  const seen = new Set<string>();

  for (const model of [
    ...configured,
    ...(activeModel === undefined ? [] : [activeModel]),
  ]) {
    const key = modelKey(model);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(model);
  }

  for (const model of candidates) {
    try {
      const result = await run(model);
      if (result !== undefined) return result;
    } catch (error) {
      onFailure?.(model, error);
    }
  }
  return undefined;
}

function modelKey(model: UtilityModelIdentity): string {
  return JSON.stringify([model.provider, model.id]);
}

function logNoThrow(
  logger: UtilityModelResolverLogger | undefined,
  details: Record<string, unknown>,
  message: string,
): void {
  try {
    logger?.info(details, message);
  } catch {
    // Diagnostics must not defeat the active-model fallback.
  }
}
