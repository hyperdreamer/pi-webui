import type { PiWebUiConfigResponse, PiWebUiConfigValues } from "../../api";

export function mergeSelectedMachineAccessConfig(base: PiWebUiConfigResponse, selectedMachine: PiWebUiConfigResponse): PiWebUiConfigResponse {
  return {
    ...base,
    config: mergeAccessConfig(base.config, selectedMachine.config),
    effectiveConfig: mergeAccessConfig(base.effectiveConfig, selectedMachine.effectiveConfig),
  };
}

function mergeAccessConfig(base: PiWebUiConfigValues, selectedMachine: PiWebUiConfigValues): PiWebUiConfigValues {
  return {
    ...base,
    ...(selectedMachine.pathAccess === undefined ? {} : { pathAccess: selectedMachine.pathAccess }),
    ...(selectedMachine.uploads === undefined ? {} : { uploads: selectedMachine.uploads }),
    ...(selectedMachine.maxUploadBytes === undefined ? {} : { maxUploadBytes: selectedMachine.maxUploadBytes }),
  };
}
