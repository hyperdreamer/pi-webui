import type { PiPackagesResponse, PiWebUiConfigResponse, PiWebUiPluginsResponse, SpeechInputSettingsResponse } from "../../api";
import { friendlyPiPackageErrorMessage, isPiPackageManagementUnsupported, piPackageTargetLabel, type PiPackageManagementSupport, type PiPackageTargetContext } from "./piPackageSettings";

export interface GatewaySettingsLoaders {
  loadConfig: () => Promise<PiWebUiConfigResponse>;
  loadPlugins: () => Promise<PiWebUiPluginsResponse>;
  loadSpeechInputSettings: () => Promise<SpeechInputSettingsResponse>;
}

export interface GatewaySettingsLoadResult {
  config?: PiWebUiConfigResponse;
  plugins?: PiWebUiPluginsResponse;
  speechInputSettings?: SpeechInputSettingsResponse;
  error: string;
}

export interface PiPackagesLoadResult {
  packagesResponse?: PiPackagesResponse;
  error: string;
  skipped?: boolean;
}

export async function loadGatewaySettingsData(loaders: GatewaySettingsLoaders): Promise<GatewaySettingsLoadResult> {
  const [config, plugins, speechInputSettings] = await Promise.allSettled([
    loaders.loadConfig(),
    loaders.loadPlugins(),
    loaders.loadSpeechInputSettings(),
  ]);
  const result: GatewaySettingsLoadResult = { error: "" };
  const errors: string[] = [];

  if (config.status === "fulfilled") result.config = config.value;
  else errors.push(`config: ${errorMessage(config.reason)}`);

  if (plugins.status === "fulfilled") result.plugins = plugins.value;
  else errors.push(`PI WEBUI plugins: ${errorMessage(plugins.reason)}`);

  if (speechInputSettings.status === "fulfilled") result.speechInputSettings = speechInputSettings.value;
  else errors.push(`speech input: ${errorMessage(speechInputSettings.reason)}`);

  if (errors.length > 0) result.error = `Failed to load settings: ${errors.join("; ")}`;
  return result;
}

export async function loadPiPackagesData(target: PiPackageTargetContext, loadPackages: (targetId: string) => Promise<PiPackagesResponse>, support?: PiPackageManagementSupport): Promise<PiPackagesLoadResult> {
  if (isPiPackageManagementUnsupported(support)) {
    return { error: support.message ?? `Pi package management is not available on ${piPackageTargetLabel(target)}.`, skipped: true };
  }

  try {
    return { packagesResponse: await loadPackages(target.id), error: "" };
  } catch (error) {
    return { error: `Failed to load Pi packages from ${piPackageTargetLabel(target)}: ${friendlyPiPackageErrorMessage(errorMessage(error), target)}` };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
