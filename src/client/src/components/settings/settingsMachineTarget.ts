import type { Machine, MachineKind, MachineRuntime } from "../../api";
import { PI_WEBUI_CAPABILITIES, supportsPiWebUiCapability } from "../../../../shared/capabilities";

export interface SettingsMachineTarget {
  id: string;
  name: string;
  kind: MachineKind;
}

export type SelectedMachineSettingsSupportState = "supported" | "unsupported" | "unknown";

export interface SelectedMachineSettingsSupport {
  state: SelectedMachineSettingsSupportState;
  message?: string;
}

export type AgentProfileSettingsSupport = SelectedMachineSettingsSupport;
export type ModelTierSettingsSupport = SelectedMachineSettingsSupport;

export function settingsMachineTarget(machine: Pick<Machine, "id" | "name" | "kind"> | undefined): SettingsMachineTarget {
  if (machine !== undefined) return { id: machine.id, name: machine.name, kind: machine.kind };
  return { id: "local", name: "local", kind: "local" };
}

export function settingsMachineTargetLabel(target: SettingsMachineTarget): string {
  return target.kind === "local" ? `${target.name} (local gateway)` : `${target.name} (remote machine)`;
}

export function selectedMachineSettingsSupport(target: SettingsMachineTarget, runtime: Pick<MachineRuntime, "ok" | "capabilities"> | undefined): SelectedMachineSettingsSupport {
  if (target.kind === "local") return { state: "supported" };
  if (runtime?.ok !== true) return { state: "unknown" };
  if (supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.selectedMachineSettings)) return { state: "supported" };
  return { state: "unsupported", message: selectedMachineSettingsUnavailableMessage(target) };
}

export function agentProfileSettingsSupport(target: SettingsMachineTarget, runtime: Pick<MachineRuntime, "ok" | "capabilities"> | undefined): AgentProfileSettingsSupport {
  if (target.kind === "local") return { state: "supported" };
  if (runtime?.ok !== true) {
    return {
      state: "unknown",
      message: `Pi-compatible agent profile support could not be verified on ${target.name}. Reload machine status before changing the profile.`,
    };
  }
  if (supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.agentProfileConfig)) return { state: "supported" };
  return {
    state: "unsupported",
    message: `Pi-compatible agent profile settings are not available on ${target.name}. Update and restart PI WEBUI on that machine, then try again.`,
  };
}

export function modelTierSettingsSupport(target: SettingsMachineTarget, runtime: Pick<MachineRuntime, "ok" | "capabilities"> | undefined): ModelTierSettingsSupport {
  if (target.kind === "local") return { state: "supported" };
  if (runtime?.ok !== true) return { state: "unknown" };
  if (supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.modelTierSettings)) return { state: "supported" };
  return { state: "unsupported", message: selectedMachineSettingsUnavailableMessage(target) };
}

export function selectedMachineSettingsSupportKey(support: SelectedMachineSettingsSupport): string {
  return `${support.state}:${support.message ?? ""}`;
}

export function isSelectedMachineSettingsUnsupported(support: SelectedMachineSettingsSupport | undefined): support is SelectedMachineSettingsSupport & { state: "unsupported" } {
  return support?.state === "unsupported";
}

export function isAgentProfileSettingsSupported(support: AgentProfileSettingsSupport | undefined): boolean {
  return support?.state === "supported";
}

export function selectedMachineSettingsUnavailableMessage(target: SettingsMachineTarget): string {
  return `Selected-machine settings are not available on ${target.name}. Update and restart PI WEBUI on that machine, then try again.`;
}

export function friendlySelectedMachineSettingsErrorMessage(message: string, target: SettingsMachineTarget): string {
  const normalized = message.trim();
  if (target.kind !== "remote") return normalized;
  if (isUnsupportedRemoteSelectedMachineSettingsRouteMessage(normalized)) {
    return selectedMachineSettingsUnavailableMessage(target);
  }
  if (normalized === "Remote machine timeout") {
    return `Timed out while contacting ${target.name} for selected-machine settings. The operation may still be running remotely; reload before retrying.`;
  }
  if (normalized === "Remote machine unavailable") {
    return `Could not reach ${target.name} for selected-machine settings. Check the machine connection and try again.`;
  }
  return normalized;
}

function isUnsupportedRemoteSelectedMachineSettingsRouteMessage(message: string): boolean {
  return message === "Not Found"
    || /route\s+(GET|PUT):?\/api\/(config|plugins)\b.*not found/iu.test(message)
    || /cannot\s+(GET|PUT)\s+.*\/api\/(config|plugins)\b/iu.test(message);
}
