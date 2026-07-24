import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { effectiveUploadsConfig, parsePathAccessConfig, parseUploadsConfig, type PiWebUiConfig } from "../../config.js";
import type { PiWebUiPathAccessConfig, PiWebUiUploadsConfig } from "../../shared/apiTypes.js";

export const PROJECT_PI_WEBUI_CONFIG_PATH = ".pi-webui/config.json";

export interface ProjectPiWebUiConfig {
  version?: 1;
  pathAccess?: PiWebUiPathAccessConfig;
  uploads?: PiWebUiUploadsConfig;
}

export interface LoadedProjectPiWebUiConfig {
  path: string;
  exists: boolean;
  config: ProjectPiWebUiConfig;
}

export async function loadProjectPiWebUiConfig(projectPath: string): Promise<LoadedProjectPiWebUiConfig> {
  const path = join(projectPath, PROJECT_PI_WEBUI_CONFIG_PATH);
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) throw new Error(`PI WEBUI project config must be a JSON object: ${path}`);
    return { path, exists: true, config: parseProjectPiWebUiConfig(parsed, path) };
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) return { path, exists: false, config: {} };
    throw error;
  }
}

export async function loadEffectiveProjectPathAccess(projectPath: string, globalConfig: PiWebUiConfig): Promise<PiWebUiPathAccessConfig | undefined> {
  const projectConfig = await loadProjectPiWebUiConfig(projectPath);
  return mergePathAccessConfigs(globalConfig.pathAccess, projectConfig.config.pathAccess);
}

export async function loadEffectiveProjectUploadsConfig(projectPath: string, globalConfig: PiWebUiConfig): Promise<PiWebUiUploadsConfig> {
  const projectConfig = await loadProjectPiWebUiConfig(projectPath);
  return effectiveUploadsConfig({ uploads: { ...(globalConfig.uploads ?? {}), ...(projectConfig.config.uploads ?? {}) } });
}

export function mergePathAccessConfigs(...configs: (PiWebUiPathAccessConfig | undefined)[]): PiWebUiPathAccessConfig | undefined {
  const allowedPaths = dedupe(configs.flatMap((config) => config?.allowedPaths ?? []));
  return allowedPaths.length === 0 ? undefined : { allowedPaths };
}

function parseProjectPiWebUiConfig(value: Record<string, unknown>, path: string): ProjectPiWebUiConfig {
  const version = value["version"];
  return {
    ...(version !== undefined ? { version: parseProjectConfigVersion(version, path) } : {}),
    ...(value["pathAccess"] !== undefined ? { pathAccess: parsePathAccessConfig(value["pathAccess"], path) } : {}),
    ...(value["uploads"] !== undefined ? { uploads: parseUploadsConfig(value["uploads"], path) } : {}),
  };
}

function parseProjectConfigVersion(value: unknown, path: string): 1 {
  if (value !== 1) throw new Error(`PI WEBUI project config version must be 1: ${path}`);
  return 1;
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
