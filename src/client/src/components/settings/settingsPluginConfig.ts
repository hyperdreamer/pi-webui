import type { PiWebUiConfigResponse, PiWebUiConfigValues } from "../../api";

export function pluginEnabledConfigPatch(baseConfig: PiWebUiConfigValues, pluginId: string, enabled: boolean): PiWebUiConfigValues {
  const currentPlugins = baseConfig.plugins ?? {};
  const currentPluginConfig = currentPlugins[pluginId] ?? {};
  return {
    plugins: {
      ...currentPlugins,
      [pluginId]: { ...currentPluginConfig, enabled },
    },
  };
}

export function mergeSelectedMachinePluginConfig(base: PiWebUiConfigResponse, selectedMachine: PiWebUiConfigResponse): PiWebUiConfigResponse {
  return {
    ...base,
    config: mergePluginConfig(base.config, selectedMachine.config),
    effectiveConfig: mergePluginConfig(base.effectiveConfig, selectedMachine.effectiveConfig),
  };
}

function mergePluginConfig(base: PiWebUiConfigValues, selectedMachine: PiWebUiConfigValues): PiWebUiConfigValues {
  if (selectedMachine.plugins === undefined) return base;
  return { ...base, plugins: selectedMachine.plugins };
}
