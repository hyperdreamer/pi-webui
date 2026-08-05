import { isKnownThinkingLevel, type ThinkingLevel } from "../../shared/thinkingLevels.js";
import {
  UTILITY_MODEL_SLOTS,
  type UtilityModelOptionV2,
  type UtilityModelSettings,
  type UtilityModelSettingsResponseV2,
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
  thinkingLevelsForModel(model: TModel | undefined): readonly string[];
}

export interface UtilityModelSettingsService {
  inspect(): Promise<UtilityModelSettingsResponseV2>;
  update(patch: UtilityModelSettingsUpdate): Promise<UtilityModelSettingsResponseV2>;
}

/**
 * Inspect and atomically update machine-global utility model settings against
 * the daemon's latest authenticated model catalog.
 */
export function createUtilityModelSettingsService<TModel extends UtilityModelSettingsModel>(
  deps: UtilityModelSettingsServiceDependencies<TModel>,
): UtilityModelSettingsService {
  let updateQueue: Promise<void> = Promise.resolve();

  const inspect = async (): Promise<UtilityModelSettingsResponseV2> => {
    const models = await refreshedSnapshot();
    return responseFor(deps.loadConfig(), models);
  };

  return {
    inspect,

    update: (patch) => enqueueUpdate(() => updateSettings(patch)),
  };

  function enqueueUpdate<T>(operation: () => Promise<T>): Promise<T> {
    const queuedUpdate = updateQueue.then(operation);
    updateQueue = queuedUpdate.then(
      () => undefined,
      () => undefined,
    );
    return queuedUpdate;
  }

  async function updateSettings(patch: UtilityModelSettingsUpdate): Promise<UtilityModelSettingsResponseV2> {
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
  }

  async function refreshedSnapshot(): Promise<readonly TModel[]> {
    await deps.modelRuntime.refresh({ allowNetwork: false });
    return deps.modelRuntime.getAvailableSnapshot();
  }

  function responseFor(config: UtilityModelSettingsConfig, models: readonly TModel[]): UtilityModelSettingsResponseV2 {
    const modelOptions = models.map(modelOptionFor);
    if (config.utilityModelsError !== undefined) {
      return {
        contractVersion: 2,
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
      contractVersion: 2,
      settings,
      models: modelOptions,
      slots,
      valid: UTILITY_MODEL_SLOTS.every((slot) => slots[slot].valid),
    };
  }

  function supportedThinkingLevels(model: TModel): ThinkingLevel[] {
    return deps.thinkingLevelsForModel(model).filter(isKnownThinkingLevel);
  }

  function modelOptionFor(model: TModel): UtilityModelOptionV2 {
    return {
      model: { provider: model.provider, id: model.id },
      ...(model.name === undefined ? {} : { name: model.name }),
      thinkingLevels: supportedThinkingLevels(model),
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

    const available = models.find((model) => model.provider === configured.provider && model.id === configured.id);
    if (available === undefined) {
      return { valid: false, reason: `${slot} utility model ${configured.provider}/${configured.id} is unavailable` };
    }

    if (
      configured.thinkingLevel !== undefined &&
      !supportedThinkingLevels(available).includes(configured.thinkingLevel)
    ) {
      return {
        valid: false,
        reason: `${slot} utility model ${configured.provider}/${configured.id} does not support thinking level ${configured.thinkingLevel}`,
      };
    }

    return { valid: true };
  }

  function invalidSlots(reason: string): Record<UtilityModelSlot, UtilityModelSlotValidation> {
    return {
      lightweight: { valid: false, reason },
      context: { valid: false, reason },
    };
  }
}
