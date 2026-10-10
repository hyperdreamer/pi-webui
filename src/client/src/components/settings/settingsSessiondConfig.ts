import { usesPiCodingAgentStateCompatibility } from "../../../../shared/activeAgentProfile";
import type { ActiveAgentProfileDescriptor, PiWebUiConfigEnvOverrides, PiWebUiConfigResponse, PiWebUiConfigValues, PiWebUiSessiondConfig, PiWebUiSessiondListenerDescriptor } from "../../api";

export type AgentProfileActivationState = "active" | "restart-required" | "unavailable";

export type SessiondActivationState = "active" | "overridden" | "restart-required" | "unavailable";
export type SessiondCoherenceIssue = "missing-dial-target" | "missing-bind-port";

export function coherenceWarning(
  fileSessiond: PiWebUiSessiondConfig | undefined,
  sessiondUrlOverridden: boolean,
  listener: PiWebUiSessiondListenerDescriptor | undefined,
): SessiondCoherenceIssue | undefined {
  const hasPort = fileSessiond?.port !== undefined;
  const hasUrl = fileSessiond?.url !== undefined;
  if (hasPort && !hasUrl) return sessiondUrlOverridden ? undefined : "missing-dial-target";
  if (!hasPort && hasUrl) return listener?.kind === "tcp" && listener.portSource === "env" ? undefined : "missing-bind-port";
  return undefined;
}

export function coherenceWarningMessage(issue: SessiondCoherenceIssue): string {
  if (issue === "missing-dial-target") {
    return "sessiond.port is configured, but no sessiond.url is set and PI_WEBUI_SESSIOND_URL is not set on that machine, so the web/API will dial the session daemon socket while the daemon listens on TCP. Add sessiond.url or remove sessiond.port.";
  }
  return "sessiond.url is configured, but no sessiond.port is set and PI_WEBUI_SESSIOND_PORT is not set on that machine, so the daemon will listen on the session daemon socket. Add sessiond.port or remove sessiond.url.";
}

export function activationState(
  fileSessiond: PiWebUiSessiondConfig | undefined,
  listener: PiWebUiSessiondListenerDescriptor | undefined,
): SessiondActivationState {
  if (listener === undefined) return "unavailable";
  if (fileSessiond?.port === undefined) {
    if (listener.kind === "socket") return "active";
    return listener.portSource === "env" ? "overridden" : "restart-required";
  }
  const trimmedHost = fileSessiond.host?.trim();
  const desiredHost = trimmedHost !== undefined && trimmedHost !== "" ? trimmedHost : "127.0.0.1";
  if (listener.kind === "socket") return "restart-required";
  if (desiredHost === listener.host && fileSessiond.port === listener.port) return "active";
  const influenced =
    (desiredHost !== listener.host && listener.hostSource === "env")
    || (fileSessiond.port !== listener.port && listener.portSource === "env");
  return influenced ? "overridden" : "restart-required";
}

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
    sessiondUrl: selectedMachine.envOverrides.sessiondUrl ?? false,
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
