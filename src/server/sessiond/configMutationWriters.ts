import type { PiWebUiConfigMutationCoordinator } from "../../configMutationCoordinator.js";
import type { ModelTierLadder, UtilityModelSettings } from "../../shared/apiTypes.js";

export interface PiWebUiConfigMutationWriters {
  replaceModelTiers(ladder: ModelTierLadder): Promise<void>;
  replaceUtilityModels(settings: UtilityModelSettings): Promise<void>;
}

/**
 * Session-daemon config mutations run through the shared cross-process
 * coordinator so the web/API process and the daemon cannot lose each other's
 * writes. Both writers preserve the current speech subtree by construction:
 * the low-level writer carries omitted keys forward and the coordinator keeps
 * the speech revision stable unless the persisted speech actually changed.
 */
export function createConfigMutationWriters(coordinator: PiWebUiConfigMutationCoordinator): PiWebUiConfigMutationWriters {
  return {
    replaceModelTiers: async (ladder) => {
      await coordinator.mutate((current) => ({ ...current.loaded.config, modelTiers: ladder }));
    },
    replaceUtilityModels: async (settings) => {
      await coordinator.mutate((current) => ({ ...current.loaded.config, utilityModels: settings }));
    },
  };
}
