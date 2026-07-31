import {
  MODEL_TIERS,
  type ModelTier,
  type ModelTierLadder,
  type ModelTierModelOption,
  type ModelTierRowValidation,
  type ModelTierSettingsResponse,
} from "../../shared/apiTypes.js";
import { resolveTier } from "./modelTierRegistry.js";

export interface ModelTierSettingsConfig {
  modelTiers?: ModelTierLadder;
  modelTiersError?: string;
}

export interface ModelTierSettingsModel {
  provider: string;
  id: string;
  name?: string;
}

export interface ModelTierSettingsModelRuntime<TModel extends ModelTierSettingsModel> {
  refresh(options?: { allowNetwork?: boolean }): Promise<unknown>;
  getAvailableSnapshot(): readonly TModel[];
}

export interface ModelTierSettingsServiceDependencies<TModel extends ModelTierSettingsModel> {
  loadConfig(): ModelTierSettingsConfig;
  saveConfig(patch: { modelTiers: ModelTierLadder }): unknown;
  modelRuntime: ModelTierSettingsModelRuntime<TModel>;
  thinkingLevelsForModel: (model: TModel | undefined) => readonly string[];
}

export interface ModelTierSettingsService {
  inspect(): Promise<ModelTierSettingsResponse>;
  replace(ladder: ModelTierLadder): Promise<ModelTierSettingsResponse>;
}

/**
 * Inspect and atomically replace the machine-global model-tier ladder against
 * the daemon's latest authenticated model catalog.
 *
 * File access and runtime refresh remain dependency-injected so this boundary
 * can be tested without starting the daemon or making network requests.
 */
export function createModelTierSettingsService<TModel extends ModelTierSettingsModel>(
  deps: ModelTierSettingsServiceDependencies<TModel>,
): ModelTierSettingsService {
  const inspect = async (): Promise<ModelTierSettingsResponse> => {
    const snapshot = await refreshedSnapshot();
    return responseFor(deps.loadConfig(), snapshot);
  };

  return {
    inspect,

    replace: async (ladder) => {
      const snapshot = await refreshedSnapshot();
      const rows = validationRows(ladder, snapshot);
      const invalidRows = MODEL_TIERS.filter((tier) => !rows[tier].valid);
      if (invalidRows.length > 0) {
        throw new Error(invalidRows.map((tier) => rows[tier].reason ?? `tier ${tier} is invalid`).join("; "));
      }

      await deps.saveConfig({ modelTiers: ladder });
      return await inspect();
    },
  };

  async function refreshedSnapshot(): Promise<readonly TModel[]> {
    await deps.modelRuntime.refresh({ allowNetwork: false });
    return deps.modelRuntime.getAvailableSnapshot();
  }

  function responseFor(config: ModelTierSettingsConfig, models: readonly TModel[]): ModelTierSettingsResponse {
    const modelOptions = models.map((model) => modelOptionFor(model));

    if (config.modelTiersError !== undefined) {
      return {
        contractVersion: 1,
        configError: config.modelTiersError,
        models: modelOptions,
        rows: invalidRows(config.modelTiersError),
        valid: false,
      };
    }

    if (config.modelTiers === undefined) {
      return {
        contractVersion: 1,
        models: modelOptions,
        rows: invalidRows("model tier configuration is missing"),
        valid: false,
      };
    }

    const rows = validationRows(config.modelTiers, models);
    return {
      contractVersion: 1,
      ladder: config.modelTiers,
      models: modelOptions,
      rows,
      valid: MODEL_TIERS.every((tier) => rows[tier].valid),
    };
  }

  function modelOptionFor(model: TModel): ModelTierModelOption {
    return {
      model: { provider: model.provider, id: model.id },
      ...(model.name === undefined ? {} : { name: model.name }),
      thinkingLevels: [...deps.thinkingLevelsForModel(model)],
    };
  }

  function validationRows(ladder: Partial<ModelTierLadder>, models: readonly TModel[]): Record<ModelTier, ModelTierRowValidation> {
    return {
      economy: validationFor("economy", ladder, models),
      fast: validationFor("fast", ladder, models),
      standard: validationFor("standard", ladder, models),
      advanced: validationFor("advanced", ladder, models),
      capable: validationFor("capable", ladder, models),
      frontier: validationFor("frontier", ladder, models),
    };
  }

  function validationFor(tier: ModelTier, ladder: Partial<ModelTierLadder>, models: readonly TModel[]): ModelTierRowValidation {
    try {
      resolveTier(tier, ladder, {
        models,
        supportedThinkingLevels: (model) => deps.thinkingLevelsForModel(model),
      });
      return { valid: true };
    } catch (error) {
      return { valid: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  function invalidRows(reason: string): Record<ModelTier, ModelTierRowValidation> {
    return {
      economy: { valid: false, reason },
      fast: { valid: false, reason },
      standard: { valid: false, reason },
      advanced: { valid: false, reason },
      capable: { valid: false, reason },
      frontier: { valid: false, reason },
    };
  }
}
