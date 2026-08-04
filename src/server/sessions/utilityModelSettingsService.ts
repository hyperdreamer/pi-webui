import {
  UTILITY_MODEL_SLOTS,
  type UtilityModelOption,
  type UtilityModelSettings,
  type UtilityModelSettingsResponse,
  type UtilityModelSettingsUpdate,
  type UtilityModelSlot,
  type UtilityModelSlotValidation,
} from "../../shared/apiTypes.js";

export interface UtilityModelSettingsConfig {
  utilityModels?: UtilityModelSettings;
  utilityModelsError?: string;
}

export interface UtilityModelSettingsModel {
  provider: string;
  id: string;
  name?: string;
}

export interface UtilityModelSettingsModelRuntime<TModel extends UtilityModelSettingsModel> {
  refresh(options?: { allowNetwork?: boolean }): Promise<unknown>;
  getAvailableSnapshot(): readonly TModel[];
}

export interface UtilityModelSettingsServiceDependencies<TModel extends UtilityModelSettingsModel> {
  loadConfig(): UtilityModelSettingsConfig;
  saveConfig(patch: { utilityModels: UtilityModelSettings }): unknown;
  modelRuntime: UtilityModelSettingsModelRuntime<TModel>;
}

export interface UtilityModelSettingsService {
  inspect(): Promise<UtilityModelSettingsResponse>;
  update(patch: UtilityModelSettingsUpdate): Promise<UtilityModelSettingsResponse>;
}

/**
 * Inspect and atomically update machine-global utility model settings against
 * the daemon's latest authenticated model catalog.
 */
export function createUtilityModelSettingsService<TModel extends UtilityModelSettingsModel>(
  deps: UtilityModelSettingsServiceDependencies<TModel>,
): UtilityModelSettingsService {
  const inspect = async (): Promise<UtilityModelSettingsResponse> => {
    const models = await refreshedSnapshot();
    return responseFor(deps.loadConfig(), models);
  };

  return {
    inspect,

    update: async (patch) => {
      const current = deps.loadConfig();
      const next: UtilityModelSettings = current.utilityModelsError === undefined
        ? { ...current.utilityModels }
        : {};

      if (Object.prototype.hasOwnProperty.call(patch, "lightweight")) {
        if (patch.lightweight === null) delete next.lightweight;
        else if (patch.lightweight !== undefined) next.lightweight = patch.lightweight;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "context")) {
        if (patch.context === null) delete next.context;
        else if (patch.context !== undefined) next.context = patch.context;
      }

      const models = await refreshedSnapshot();
      const slots = validationSlots(next, models);
      const invalidSlots = UTILITY_MODEL_SLOTS.filter((slot) => !slots[slot].valid);
      if (invalidSlots.length > 0) {
        throw new Error(invalidSlots.map((slot) => slots[slot].reason ?? `${slot} utility model is invalid`).join("; "));
      }

      await deps.saveConfig({ utilityModels: next });
      return await inspect();
    },
  };

  async function refreshedSnapshot(): Promise<readonly TModel[]> {
    await deps.modelRuntime.refresh({ allowNetwork: false });
    return deps.modelRuntime.getAvailableSnapshot();
  }

  function responseFor(config: UtilityModelSettingsConfig, models: readonly TModel[]): UtilityModelSettingsResponse {
    const modelOptions = models.map(modelOptionFor);
    if (config.utilityModelsError !== undefined) {
      return {
        contractVersion: 1,
        configError: config.utilityModelsError,
        settings: {},
        models: modelOptions,
        slots: invalidSlots(config.utilityModelsError),
        valid: false,
      };
    }

    const settings = config.utilityModels ?? {};
    const slots = validationSlots(settings, models);
    return {
      contractVersion: 1,
      settings,
      models: modelOptions,
      slots,
      valid: UTILITY_MODEL_SLOTS.every((slot) => slots[slot].valid),
    };
  }

  function modelOptionFor(model: TModel): UtilityModelOption {
    return {
      model: { provider: model.provider, id: model.id },
      ...(model.name === undefined ? {} : { name: model.name }),
    };
  }

  function validationSlots(settings: UtilityModelSettings, models: readonly TModel[]): Record<UtilityModelSlot, UtilityModelSlotValidation> {
    return {
      lightweight: validationFor("lightweight", settings, models),
      context: validationFor("context", settings, models),
    };
  }

  function validationFor(slot: UtilityModelSlot, settings: UtilityModelSettings, models: readonly TModel[]): UtilityModelSlotValidation {
    const configured = settings[slot];
    if (configured === undefined) return { valid: true };
    const available = models.some((model) => model.provider === configured.provider && model.id === configured.id);
    return available
      ? { valid: true }
      : { valid: false, reason: `${slot} utility model ${configured.provider}/${configured.id} is unavailable` };
  }

  function invalidSlots(reason: string): Record<UtilityModelSlot, UtilityModelSlotValidation> {
    return {
      lightweight: { valid: false, reason },
      context: { valid: false, reason },
    };
  }
}
