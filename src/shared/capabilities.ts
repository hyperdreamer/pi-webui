import { PI_WEBUI_CAPABILITIES, type PiWebUiCapability, type PiWebUiRuntimeComponent, type PiWebUiServiceComponent } from "./apiTypes.js";

export { PI_WEBUI_CAPABILITIES };
export type { PiWebUiCapability };

export const KNOWN_PI_WEBUI_CAPABILITIES = Object.values(PI_WEBUI_CAPABILITIES);
const knownPiWebUiCapabilities: ReadonlySet<string> = new Set(KNOWN_PI_WEBUI_CAPABILITIES);

export const WEB_RUNTIME_CAPABILITIES = [
  PI_WEBUI_CAPABILITIES.sessionsDeleteArchived,
  PI_WEBUI_CAPABILITIES.sessionsBulkMutations,
  PI_WEBUI_CAPABILITIES.sessionsCleanup,
  PI_WEBUI_CAPABILITIES.sessionsReload,
  PI_WEBUI_CAPABILITIES.sessionsClearQueue,
  PI_WEBUI_CAPABILITIES.sessionsMessageActions,
  PI_WEBUI_CAPABILITIES.sessionsSystemPrompt,
  PI_WEBUI_CAPABILITIES.sessionsPersistedState,
  PI_WEBUI_CAPABILITIES.sessionsNotifications,
  PI_WEBUI_CAPABILITIES.sessionsUnread,
  PI_WEBUI_CAPABILITIES.promptAttachments,
  PI_WEBUI_CAPABILITIES.workspaceFileSuggestions,
  PI_WEBUI_CAPABILITIES.piPackagesManage,
  PI_WEBUI_CAPABILITIES.selectedMachineSettings,
  PI_WEBUI_CAPABILITIES.agentProfileConfig,
] as const satisfies readonly PiWebUiCapability[];

export const SESSIOND_RUNTIME_CAPABILITIES = [
  PI_WEBUI_CAPABILITIES.sessionsDeleteArchived,
  PI_WEBUI_CAPABILITIES.sessionsBulkMutations,
  PI_WEBUI_CAPABILITIES.sessionsCleanup,
  PI_WEBUI_CAPABILITIES.sessionsReload,
  PI_WEBUI_CAPABILITIES.sessionsClearQueue,
  PI_WEBUI_CAPABILITIES.sessionsMessageActions,
  PI_WEBUI_CAPABILITIES.sessionsSystemPrompt,
  PI_WEBUI_CAPABILITIES.sessionsPersistedState,
  PI_WEBUI_CAPABILITIES.sessionsNotifications,
  PI_WEBUI_CAPABILITIES.sessionsUnread,
  PI_WEBUI_CAPABILITIES.promptAttachments,
] as const satisfies readonly PiWebUiCapability[];

const EFFECTIVE_CAPABILITY_REQUIREMENTS = {
  [PI_WEBUI_CAPABILITIES.sessionsDeleteArchived]: ["web", "sessiond"],
  [PI_WEBUI_CAPABILITIES.sessionsBulkMutations]: ["web", "sessiond"],
  [PI_WEBUI_CAPABILITIES.sessionsCleanup]: ["web", "sessiond"],
  [PI_WEBUI_CAPABILITIES.sessionsReload]: ["web", "sessiond"],
  [PI_WEBUI_CAPABILITIES.sessionsClearQueue]: ["web", "sessiond"],
  [PI_WEBUI_CAPABILITIES.sessionsMessageActions]: ["web", "sessiond"],
  [PI_WEBUI_CAPABILITIES.sessionsSystemPrompt]: ["web", "sessiond"],
  [PI_WEBUI_CAPABILITIES.sessionsPersistedState]: ["web", "sessiond"],
  [PI_WEBUI_CAPABILITIES.sessionsNotifications]: ["web", "sessiond"],
  [PI_WEBUI_CAPABILITIES.sessionsUnread]: ["web", "sessiond"],
  [PI_WEBUI_CAPABILITIES.promptAttachments]: ["web", "sessiond"],
  [PI_WEBUI_CAPABILITIES.workspaceFileSuggestions]: ["web"],
  [PI_WEBUI_CAPABILITIES.piPackagesManage]: ["web"],
  [PI_WEBUI_CAPABILITIES.selectedMachineSettings]: ["web"],
  [PI_WEBUI_CAPABILITIES.agentProfileConfig]: ["web"],
  [PI_WEBUI_CAPABILITIES.modelTierSettings]: ["web", "sessiond"],
} as const satisfies Record<PiWebUiCapability, readonly PiWebUiServiceComponent[]>;

export function isPiWebUiCapability(value: unknown): value is PiWebUiCapability {
  return typeof value === "string" && knownPiWebUiCapabilities.has(value);
}

export function supportsPiWebUiCapability(source: { capabilities?: readonly PiWebUiCapability[] } | undefined, capability: PiWebUiCapability): boolean {
  return source?.capabilities?.includes(capability) === true;
}

export function parseKnownPiWebUiCapabilities(value: unknown): PiWebUiCapability[] | undefined {
  if (!Array.isArray(value) || !value.every((capability) => typeof capability === "string")) return undefined;
  return value.filter(isPiWebUiCapability);
}

export function effectivePiWebUiCapabilities(components: Partial<Record<PiWebUiServiceComponent, Pick<PiWebUiRuntimeComponent, "available" | "capabilities">>>): PiWebUiCapability[] {
  return KNOWN_PI_WEBUI_CAPABILITIES.filter((capability) => {
    const requiredComponents = EFFECTIVE_CAPABILITY_REQUIREMENTS[capability];
    return requiredComponents.every((component) => {
      const runtime = components[component];
      return runtime?.available === true && supportsPiWebUiCapability(runtime, capability);
    });
  });
}
