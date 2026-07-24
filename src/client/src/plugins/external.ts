import { machineScopedPluginId } from "../../../shared/machinePluginIds";
import { resolveAppUrl, type AppUrlContext } from "../appUrl";
import type { PiWebUiPlugin, PiWebUiPluginRegistration } from "./types";

export interface PluginManifestEntry {
  id: string;
  module: string;
  machineSpecific: boolean;
}

interface PluginManifest {
  plugins: PluginManifestEntry[];
}

export interface LoadExternalPluginsOptions {
  machineId?: string;
  shouldLoadPlugin?: (entry: PluginManifestEntry) => boolean;
  moduleLoader?: (moduleUrl: string) => Promise<unknown>;
}

export async function loadExternalPlugins(manifestUrl = "pi-webui-plugins/manifest.json", options: LoadExternalPluginsOptions = {}): Promise<PiWebUiPluginRegistration[]> {
  const resolvedManifestUrl = resolveAppUrl(manifestUrl);
  const manifest = await fetchPluginManifest(resolvedManifestUrl);
  if (manifest === undefined) return [];

  const registrations: PiWebUiPluginRegistration[] = [];
  for (const entry of manifest.plugins) {
    if (options.shouldLoadPlugin?.(entry) === false) continue;
    try {
      const moduleUrl = resolvePluginModuleUrl(entry.module, resolvedManifestUrl);
      const module = await (options.moduleLoader ?? importPluginModule)(moduleUrl);
      const plugin = parsePluginModule(module, moduleUrl);
      registrations.push({
        id: options.machineId === undefined ? entry.id : machineScopedPluginId(options.machineId, entry.id),
        plugin,
        machineSpecific: entry.machineSpecific,
        ...(options.machineId === undefined ? {} : { machineId: options.machineId, sourcePluginId: entry.id }),
      });
    } catch (error) {
      console.warn(`Failed to load PI WEBUI plugin ${entry.module}`, error);
    }
  }
  return registrations;
}

export function resolvePluginModuleUrl(moduleReference: string, manifestUrl: string, appUrlContext?: AppUrlContext): string {
  if (!moduleReference.startsWith("/")) return new URL(moduleReference, manifestUrl).toString();
  return appUrlContext === undefined ? resolveAppUrl(moduleReference) : resolveAppUrl(moduleReference, appUrlContext);
}

async function importPluginModule(moduleUrl: string): Promise<unknown> {
  return import(/* @vite-ignore */ moduleUrl);
}

async function fetchPluginManifest(manifestUrl: string): Promise<PluginManifest | undefined> {
  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Failed to load plugin manifest: ${response.statusText}`);
  return parseManifest(await response.json());
}

function parseManifest(value: unknown): PluginManifest {
  if (!isRecord(value) || !Array.isArray(value["plugins"])) throw new Error("Invalid plugin manifest");
  return {
    plugins: value["plugins"].map((entry) => {
      if (!isRecord(entry) || typeof entry["id"] !== "string" || entry["id"] === "" || typeof entry["module"] !== "string" || entry["module"] === "") throw new Error("Invalid plugin manifest entry");
      return { id: entry["id"], module: entry["module"], machineSpecific: parseMachineSpecific(entry["machineSpecific"]) };
    }),
  };
}

function parseMachineSpecific(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error("Invalid plugin manifest entry");
  return value;
}

function parsePluginModule(module: unknown, moduleUrl: string): PiWebUiPlugin {
  if (!isRecord(module)) throw new Error(`Plugin module ${moduleUrl} did not export an object`);
  const plugin = module["default"];
  if (!isPiWebUiPlugin(plugin)) throw new Error(`Plugin module ${moduleUrl} default export is not a PiWebUiPlugin`);
  return plugin;
}

function isPiWebUiPlugin(value: unknown): value is PiWebUiPlugin {
  return isRecord(value) && value["apiVersion"] === 1 && typeof value["name"] === "string" && typeof value["activate"] === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
