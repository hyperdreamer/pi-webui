import type { CommandOption, TierModelRef } from "../../../../shared/apiTypes";

/**
 * The shape both settings panels share when they offer a machine's available
 * models: a model reference plus an optional display name. `ModelTierModelOption`
 * and `UtilityModelOption` are both assignable to it, so the option projection
 * below stays independent of each panel's thinking-level contract.
 */
export interface SettingsModelChoice {
  readonly model: TierModelRef;
  readonly name?: string;
}

/** Picker value used for "no explicit model" rows, such as utility inheritance. */
export const INHERITED_SETTINGS_MODEL_VALUE = "";

/** Stable picker/option identity for a model reference. */
export function settingsModelKey(model: TierModelRef): string {
  return JSON.stringify([model.provider, model.id]);
}

/** Human-readable `provider/id` rendering of a model reference. */
export function describeSettingsModel(model: TierModelRef): string {
  return `${model.provider}/${model.id}`;
}

/** The choice a picker value refers to, or undefined when it is not available. */
export function settingsModelChoiceByKey<T extends SettingsModelChoice>(
  choices: readonly T[],
  key: string,
): T | undefined {
  return choices.find((choice) => settingsModelKey(choice.model) === key);
}

/**
 * Searchable, provider-grouped picker options for a machine's available models.
 *
 * Options are sorted by provider then model id so the grouped dialog renders one
 * contiguous header per provider. The model id is the label (the provider is
 * already the group header) and the display name becomes the secondary line, so
 * the picker's query matches ids, names, and the provider-qualified value.
 */
export function settingsModelPickerOptions(
  choices: readonly SettingsModelChoice[],
  inherited?: { readonly label: string },
): CommandOption[] {
  const sorted = [...choices].sort((left, right) => (
    left.model.provider === right.model.provider
      ? left.model.id.localeCompare(right.model.id)
      : left.model.provider.localeCompare(right.model.provider)
  ));
  const options = sorted.map((choice) => ({
    value: settingsModelKey(choice.model),
    label: choice.model.id,
    ...(choice.name === undefined || choice.name === "" || choice.name === choice.model.id
      ? {}
      : { description: choice.name }),
    ...(choice.model.provider === "" ? {} : { group: choice.model.provider }),
  }));
  return inherited === undefined
    ? options
    : [{ value: INHERITED_SETTINGS_MODEL_VALUE, label: inherited.label }, ...options];
}
