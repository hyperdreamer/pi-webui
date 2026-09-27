import type {
  UtilityModelBinding,
  UtilityModelSettings,
  UtilityModelSlot,
} from "../../shared/apiTypes.js";
import type { ThinkingLevel } from "../../shared/thinkingLevels.js";

export type UtilityModelTask = "lightweight" | "context";

export interface UtilityModelIdentity {
  provider: string;
  id: string;
}

export interface UtilityModelAttempt<TModel extends UtilityModelIdentity> {
  model: TModel;
  thinkingLevel: ThinkingLevel;
}

export interface ResolvedUtilityModel<TModel extends UtilityModelIdentity>
  extends UtilityModelAttempt<TModel> {
  slot: UtilityModelSlot;
}

export type UtilityModelUnavailableReason =
  | "slot-unset"
  | "config-invalid"
  | "model-unavailable"
  | "thinking-level-unsupported"
  | "resolution-failed";

export interface UtilityModelUnavailable {
  reason: UtilityModelUnavailableReason;
  detail?: string;
}

export interface UtilityModelInspection<TModel extends UtilityModelIdentity> {
  candidates: readonly ResolvedUtilityModel<TModel>[];
  unavailable?: UtilityModelUnavailable;
}

export interface UtilityModelResolver<
  TModel extends UtilityModelIdentity,
> {
  inspect(task: UtilityModelTask): Promise<UtilityModelInspection<TModel>>;
  configuredCandidates(
    task: UtilityModelTask,
  ): Promise<readonly ResolvedUtilityModel<TModel>[]>;
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
  thinkingLevelsForModel(model: TModel | undefined): readonly string[];
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
  const inspect = async (
    task: UtilityModelTask,
  ): Promise<UtilityModelInspection<TModel>> => {
    try {
      await deps.modelRuntime.refresh({ allowNetwork: false });
      const config = deps.loadConfig();
      if (config.utilityModelsError !== undefined) {
        return {
          candidates: [],
          unavailable: {
            reason: "config-invalid",
            detail: config.utilityModelsError,
          },
        };
      }
      if (config.utilityModels === undefined) {
        return { candidates: [], unavailable: { reason: "slot-unset" } };
      }

      const available = deps.modelRuntime.getAvailableSnapshot();
      const candidates: ResolvedUtilityModel<TModel>[] = [];
      const seen = new Set<string>();
      let slotFailure: UtilityModelUnavailable | undefined;
      for (const slot of taskSlots[task]) {
        const reference = config.utilityModels[slot];
        if (reference === undefined) {
          slotFailure ??= { reason: "slot-unset" };
          continue;
        }
        const candidate = available.find(
          (model) =>
            model.provider === reference.provider && model.id === reference.id,
        );
        if (candidate === undefined) {
          slotFailure ??= {
            reason: "model-unavailable",
            detail: `${reference.provider}/${reference.id}`,
          };
          continue;
        }
        const thinkingLevel = effectiveThinkingLevel(
          reference,
          deps.thinkingLevelsForModel(candidate),
        );
        if (thinkingLevel === undefined) {
          // `effectiveThinkingLevel` only returns undefined for an explicitly
          // configured level the model does not support.
          slotFailure ??= {
            reason: "thinking-level-unsupported",
            detail: reference.thinkingLevel ?? "",
          };
          continue;
        }
        const resolved = { model: candidate, thinkingLevel, slot };
        const key = attemptKey(resolved);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(resolved);
      }
      if (candidates.length > 0) return { candidates };
      return {
        candidates: [],
        unavailable: slotFailure ?? { reason: "resolution-failed" },
      };
    } catch (error) {
      logNoThrow(
        deps.logger,
        { err: error, task },
        "utility model resolution failed",
      );
      return {
        candidates: [],
        unavailable: {
          reason: "resolution-failed",
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
  };

  return {
    inspect,
    configuredCandidates: async (task) => (await inspect(task)).candidates,
  };
}

export async function runWithUtilityModelFallback<
  TModel extends UtilityModelIdentity,
  TResult,
>(
  resolver: UtilityModelResolver<TModel>,
  task: UtilityModelTask,
  activeAttempt: UtilityModelAttempt<TModel> | undefined,
  run: (
    attempt: UtilityModelAttempt<TModel>,
  ) => Promise<TResult | undefined> | TResult | undefined,
  onFailure?: (attempt: UtilityModelAttempt<TModel>, error: unknown) => void,
): Promise<TResult | undefined> {
  const configured = await resolver.configuredCandidates(task);
  const candidates: UtilityModelAttempt<TModel>[] = [];
  const seen = new Set<string>();

  for (const attempt of [
    ...configured,
    ...(activeAttempt === undefined ? [] : [activeAttempt]),
  ]) {
    const key = attemptKey(attempt);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(attempt);
  }

  for (const attempt of candidates) {
    try {
      const result = await run(attempt);
      if (result !== undefined) return result;
    } catch (error) {
      onFailure?.(attempt, error);
    }
  }
  return undefined;
}

function effectiveThinkingLevel(
  binding: UtilityModelBinding,
  supported: readonly string[],
): ThinkingLevel | undefined {
  if (binding.thinkingLevel !== undefined) {
    return supported.includes(binding.thinkingLevel)
      ? binding.thinkingLevel
      : undefined;
  }
  return supported.includes("minimal") ? "minimal" : "off";
}

function attemptKey(attempt: UtilityModelAttempt<UtilityModelIdentity>): string {
  return JSON.stringify([
    attempt.model.provider,
    attempt.model.id,
    attempt.thinkingLevel,
  ]);
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
