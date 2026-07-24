import { usesPiCodingAgentStateCompatibility } from "../../../../shared/activeAgentProfile";
import type { ActiveAgentProfileDescriptor, PiWebUiConfigEnvOverrides, PiWebUiConfigResponse, PiWebUiConfigValues } from "../../api";

export type AgentProfileActivationState = "active" | "restart-required" | "unavailable";

export function spawnSessionsConfigPatch(enabled: boolean): PiWebUiConfigValues {
  return { spawnSessions: enabled };
}

export function subsessionsConfigPatch(enabled: boolean): PiWebUiConfigValues {
  return { subsessions: enabled };
}

export function agentProfileActivationState(
  config: PiWebUiConfigResponse | undefined,
  activeProfile: ActiveAgentProfileDescriptor | undefined,
): AgentProfileActivationState {
  const desiredProfile = config?.effectiveConfig.agent;
  if (desiredProfile?.command === undefined || desiredProfile.dir === undefined || activeProfile === undefined) return "unavailable";
  const desiredSessionDirEnvKeys = [
    "PI_WEBUI_AGENT_SESSION_DIR",
    ...(usesPiCodingAgentStateCompatibility(desiredProfile.command) ? ["PI_CODING_AGENT_SESSION_DIR"] : []),
  ];
  return desiredProfile.command === activeProfile.command
    && desiredProfile.dir === activeProfile.dir
    && sameStrings(activeProfile.sessionDirEnvKeys, desiredSessionDirEnvKeys)
    ? "active"
    : "restart-required";
}

export function agentDirFieldOverridden(envOverrides: PiWebUiConfigEnvOverrides | undefined, draftCommand: string): boolean {
  if (envOverrides?.agentDirSource === "pi-webui") return true;
  if (envOverrides?.agentDirSource === "pi-compatibility") return usesPiCodingAgentStateCompatibility(draftCommand.trim() || "pi");
  // Older remote responses do not identify the source. Keep their override
  // read-only rather than incorrectly treating a PI_WEBUI_AGENT_DIR as conditional.
  return envOverrides?.agentDir === true;
}

export function mergeSelectedMachineSessiondConfig(base: PiWebUiConfigResponse, selectedMachine: PiWebUiConfigResponse): PiWebUiConfigResponse {
  const envOverrides: PiWebUiConfigEnvOverrides = {
    ...base.envOverrides,
    spawnSessions: selectedMachine.envOverrides.spawnSessions,
    subsessions: selectedMachine.envOverrides.subsessions,
    agentCommand: selectedMachine.envOverrides.agentCommand,
    agentDir: selectedMachine.envOverrides.agentDir,
    agentSessionDir: selectedMachine.envOverrides.agentSessionDir,
  };
  if (selectedMachine.envOverrides.agentDirSource === undefined) delete envOverrides.agentDirSource;
  else envOverrides.agentDirSource = selectedMachine.envOverrides.agentDirSource;

  return {
    ...base,
    config: { ...base.config, ...selectedMachine.config },
    effectiveConfig: { ...base.effectiveConfig, ...selectedMachine.effectiveConfig },
    envOverrides,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
