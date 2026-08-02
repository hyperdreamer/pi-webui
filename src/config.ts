import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { MODEL_TIERS, type ModelTier, type ModelTierLadder, type PiWebUiAgentDirEnvSource, type PiWebUiConfigValues } from "./shared/apiTypes.js";
import { isPiCompanionCommand, usesPiCodingAgentStateCompatibility } from "./shared/activeAgentProfile.js";
import { isPiWebUiPluginId, piWebUiPluginIdPattern } from "./shared/pluginIds.js";

export { isPiCompanionCommand };

export type PiWebUiConfig = PiWebUiConfigValues;

export interface LoadedPiWebUiConfig {
  path: string;
  exists: boolean;
  config: PiWebUiConfig;
  /** A malformed external ladder is reported without blocking unrelated config use. */
  modelTiersError?: string;
}

export interface EffectivePiWebUiConfig extends Omit<PiWebUiConfig, "uploads" | "spawnSessions" | "subsessions" | "agent"> {
  uploads: NonNullable<PiWebUiConfig["uploads"]>;
  spawnSessions: boolean;
  subsessions: boolean;
  agent: Required<NonNullable<PiWebUiConfig["agent"]>>;
}

export interface LoadedEffectivePiWebUiConfig extends Omit<LoadedPiWebUiConfig, "config"> {
  config: EffectivePiWebUiConfig;
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function defaultPiWebUiConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdgConfigHome = env["XDG_CONFIG_HOME"];
  return join(xdgConfigHome !== undefined && xdgConfigHome !== "" ? xdgConfigHome : join(homedir(), ".config"), "pi-webui", "config.json");
}

export function defaultPiWebUiDataDir(): string {
  return join(homedir(), ".pi-webui");
}

/**
 * Default maximum HTTP body size (bytes) for the web/API and session daemon.
 * Generous headroom for base64 image attachments (well above pi's 4.5MB
 * per-image inline limit so several images fit in one request).
 */
export const DEFAULT_PORT = 8808;
export const DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

export const DEFAULT_UPLOADS_FOLDER = ".pi-webui/uploads";

export const DEFAULT_AGENT_COMMAND = "pi";
export const PI_WEBUI_AGENT_COMMAND_ENV = "PI_WEBUI_AGENT_COMMAND";
export const PI_WEBUI_AGENT_DIR_ENV = "PI_WEBUI_AGENT_DIR";
export const PI_WEBUI_AGENT_SESSION_DIR_ENV = "PI_WEBUI_AGENT_SESSION_DIR";
export const PI_CODING_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export const PI_CODING_AGENT_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

export interface EffectivePiWebUiAgentConfig {
  command: string;
  dir: string;
  sessionDirEnvKeys: string[];
}

export function effectiveAgentConfig(env: NodeJS.ProcessEnv = process.env, config: Pick<PiWebUiConfig, "agent"> = {}): EffectivePiWebUiAgentConfig {
  const command = parseAgentCommand(envValue(env, PI_WEBUI_AGENT_COMMAND_ENV) ?? config.agent?.command ?? DEFAULT_AGENT_COMMAND, "agent.command", "environment", "current");
  const configuredDir = envValue(env, PI_WEBUI_AGENT_DIR_ENV) ?? (usesPiCodingAgentStateCompatibility(command) ? envValue(env, PI_CODING_AGENT_DIR_ENV) : undefined) ?? config.agent?.dir ?? defaultAgentDirForCommand(command, env);
  return {
    command,
    dir: resolveAgentDirPath(configuredDir, env, "agent.dir", "environment"),
    sessionDirEnvKeys: agentSessionDirEnvKeys(command),
  };
}

export function agentSessionDirEnvKeys(command = DEFAULT_AGENT_COMMAND): string[] {
  return uniqueStrings([
    PI_WEBUI_AGENT_SESSION_DIR_ENV,
    ...(usesPiCodingAgentStateCompatibility(command) ? [PI_CODING_AGENT_SESSION_DIR_ENV] : []),
  ]);
}

export function agentDirEnvSource(env: NodeJS.ProcessEnv): PiWebUiAgentDirEnvSource | undefined {
  if (isEnvSet(env[PI_WEBUI_AGENT_DIR_ENV])) return "pi-webui";
  if (isEnvSet(env[PI_CODING_AGENT_DIR_ENV])) return "pi-compatibility";
  return undefined;
}

export function hasAgentDirEnvOverride(env: NodeJS.ProcessEnv, command = DEFAULT_AGENT_COMMAND): boolean {
  const source = agentDirEnvSource(env);
  return source === "pi-webui" || (source === "pi-compatibility" && usesPiCodingAgentStateCompatibility(command));
}

export function hasAgentSessionDirEnvOverride(env: NodeJS.ProcessEnv, command = DEFAULT_AGENT_COMMAND): boolean {
  return agentSessionDirEnvKeys(command).some((key) => isEnvSet(env[key]));
}

export function effectiveUploadsConfig(config: Pick<PiWebUiConfig, "uploads"> = {}): NonNullable<PiWebUiConfig["uploads"]> {
  return { defaultFolder: config.uploads?.defaultFolder ?? DEFAULT_UPLOADS_FOLDER };
}

export function maxUploadBytes(env: NodeJS.ProcessEnv = process.env, config: PiWebUiConfig = {}): number {
  const fromEnv = env["PI_WEBUI_MAX_UPLOAD_BYTES"];
  if (fromEnv !== undefined && fromEnv !== "") {
    const parsed = Number(fromEnv);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  if (config.maxUploadBytes !== undefined) return config.maxUploadBytes;
  return DEFAULT_MAX_UPLOAD_BYTES;
}

export function piWebUiDataDir(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const configured = env["PI_WEBUI_DATA_DIR"];
  if (configured === undefined || configured === "") return defaultPiWebUiDataDir();
  return resolve(cwd, configured);
}

export function piWebUiConfigPath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const configured = env["PI_WEBUI_CONFIG"];
  if (configured === undefined || configured === "") return defaultPiWebUiConfigPath(env);
  return resolve(cwd, configured);
}

export function loadPiWebUiConfig(options: LoadOptions = {}): LoadedPiWebUiConfig {
  const env = options.env ?? process.env;
  const path = piWebUiConfigPath(env, options.cwd ?? process.cwd());
  if (!existsSync(path)) return { path, exists: false, config: {} };

  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`PI WEBUI config must be a JSON object: ${path}`);

  const parsedConfig = parsePiWebUiConfig(parsed, path, { allowInvalidModelTiers: true });
  return {
    path,
    exists: true,
    config: parsedConfig.config,
    ...(parsedConfig.modelTiersError === undefined ? {} : { modelTiersError: parsedConfig.modelTiersError }),
  };
}

export function effectivePiWebUiConfig(options: LoadOptions = {}): LoadedEffectivePiWebUiConfig {
  return resolveEffectivePiWebUiConfig(loadPiWebUiConfig(options), options);
}

export function resolveEffectivePiWebUiConfig(loaded: LoadedPiWebUiConfig, options: LoadOptions = {}): LoadedEffectivePiWebUiConfig {
  const env = options.env ?? process.env;
  const host = env["PI_WEBUI_HOST"];
  const port = env["PI_WEBUI_PORT"] ?? env["PORT"];
  const allowedHosts = env["PI_WEBUI_ALLOWED_HOSTS"];
  const maxUpload = env["PI_WEBUI_MAX_UPLOAD_BYTES"];
  const agent = effectiveAgentConfig(env, loaded.config);
  return {
    ...loaded,
    config: {
      ...loaded.config,
      ...(host !== undefined && host !== "" ? { host } : {}),
      ...(port !== undefined && port !== "" ? { port: parsePort(port, "PI_WEBUI_PORT") } : {}),
      ...(allowedHosts !== undefined && allowedHosts !== "" ? { allowedHosts: parseAllowedHostsEnv(allowedHosts) } : {}),
      ...(maxUpload !== undefined && maxUpload !== "" ? { maxUploadBytes: parseMaxUploadBytes(maxUpload, "PI_WEBUI_MAX_UPLOAD_BYTES") } : {}),
      uploads: effectiveUploadsConfig(loaded.config),
      // Always resolved (on by default) so the effective config is the single
      // source of truth for the runtime state and the settings UI toggle.
      spawnSessions: spawnSessionsEnabled(env, loaded.config),
      // Beta capability, resolved off by default.
      subsessions: subsessionsEnabled(env, loaded.config),
      agent: { command: agent.command, dir: agent.dir },
    },
  };
}

export function savePiWebUiConfig(config: PiWebUiConfig, options: LoadOptions = {}): LoadedPiWebUiConfig {
  const env = options.env ?? process.env;
  const path = piWebUiConfigPath(env, options.cwd ?? process.cwd());
  const normalized = parsePiWebUiConfig(piWebUiConfigRecord(config), path).config;
  effectiveAgentConfig(env, normalized);
  const existing = readExistingConfigObject(path);
  if (existing["agent"] !== undefined) parseAgentConfig(existing["agent"], path);
  delete existing["host"];
  delete existing["port"];
  delete existing["allowedHosts"];
  delete existing["shortcuts"];
  delete existing["plugins"];
  delete existing["pathAccess"];
  delete existing["uploads"];
  delete existing["maxUploadBytes"];
  delete existing["spawnSessions"];
  delete existing["subsessions"];
  delete existing["agent"];
  if (normalized.modelTiers !== undefined) delete existing["modelTiers"];
  const merged = { ...existing, ...piWebUiConfigRecord(normalized) };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return { path, exists: true, config: normalized };
}

export function replacePiWebUiModelTiers(modelTiers: ModelTierLadder, options: LoadOptions = {}): LoadedPiWebUiConfig {
  const loaded = loadPiWebUiConfig(options);
  return savePiWebUiConfig({ ...loaded.config, modelTiers }, options);
}

function readExistingConfigObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`PI WEBUI config must be a JSON object: ${path}`);
  return parsed;
}

interface ParsedPiWebUiConfig {
  config: PiWebUiConfig;
  modelTiersError?: string;
}

function piWebUiConfigRecord(config: PiWebUiConfig): Record<string, unknown> {
  return {
    ...(config.host !== undefined ? { host: config.host } : {}),
    ...(config.port !== undefined ? { port: config.port } : {}),
    ...(config.allowedHosts !== undefined ? { allowedHosts: config.allowedHosts } : {}),
    ...(config.shortcuts !== undefined ? { shortcuts: config.shortcuts } : {}),
    ...(config.plugins !== undefined ? { plugins: config.plugins } : {}),
    ...(config.pathAccess !== undefined ? { pathAccess: config.pathAccess } : {}),
    ...(config.uploads !== undefined ? { uploads: config.uploads } : {}),
    ...(config.maxUploadBytes !== undefined ? { maxUploadBytes: config.maxUploadBytes } : {}),
    ...(config.modelTiers !== undefined ? { modelTiers: config.modelTiers } : {}),
    ...(config.spawnSessions !== undefined ? { spawnSessions: config.spawnSessions } : {}),
    ...(config.subsessions !== undefined ? { subsessions: config.subsessions } : {}),
    ...(config.agent !== undefined ? { agent: config.agent } : {}),
  };
}

function parsePiWebUiConfig(value: Record<string, unknown>, path: string, options: { allowInvalidModelTiers?: boolean } = {}): ParsedPiWebUiConfig {
  let modelTiers: ModelTierLadder | undefined;
  let modelTiersError: string | undefined;
  if (value["modelTiers"] !== undefined) {
    try {
      modelTiers = parseModelTiersConfig(value["modelTiers"], path);
    } catch (error) {
      if (options.allowInvalidModelTiers !== true) throw error;
      modelTiersError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    config: {
      ...(value["host"] !== undefined ? { host: parseString(value["host"], "host", path) } : {}),
      ...(value["port"] !== undefined ? { port: parsePort(value["port"], "port", path) } : {}),
      ...(value["allowedHosts"] !== undefined ? { allowedHosts: parseAllowedHosts(value["allowedHosts"], path) } : {}),
      ...(value["shortcuts"] !== undefined ? { shortcuts: parseShortcuts(value["shortcuts"], path) } : {}),
      ...(value["plugins"] !== undefined ? { plugins: parsePlugins(value["plugins"], path) } : {}),
      ...(value["pathAccess"] !== undefined ? { pathAccess: parsePathAccessConfig(value["pathAccess"], path) } : {}),
      ...(value["uploads"] !== undefined ? { uploads: parseUploadsConfig(value["uploads"], path) } : {}),
      ...(value["maxUploadBytes"] !== undefined ? { maxUploadBytes: parseMaxUploadBytes(value["maxUploadBytes"], "maxUploadBytes", path) } : {}),
      ...(modelTiers === undefined ? {} : { modelTiers }),
      ...(value["spawnSessions"] !== undefined ? { spawnSessions: parseSpawnSessions(value["spawnSessions"], path) } : {}),
      ...(value["subsessions"] !== undefined ? { subsessions: parseSubsessions(value["subsessions"], path) } : {}),
      ...(value["agent"] !== undefined ? { agent: parseAgentConfig(value["agent"], path) } : {}),
    },
    ...(modelTiersError === undefined ? {} : { modelTiersError }),
  };
}

function isModelTierConfigKey(value: string): value is ModelTier {
  return MODEL_TIERS.some((tier) => tier === value);
}

export function parseModelTiersConfig(value: unknown, path: string): ModelTierLadder {
  if (!isRecord(value)) throw new Error(`PI WEBUI config modelTiers must be an object: ${path}`);
  const unknownKey = Object.keys(value).find((key) => !isModelTierConfigKey(key));
  if (unknownKey !== undefined) throw new Error(`PI WEBUI config modelTiers contains unknown tier ${JSON.stringify(unknownKey)}: ${path}`);
  const missingTier = MODEL_TIERS.find((tier) => value[tier] === undefined);
  if (missingTier !== undefined) throw new Error(`PI WEBUI config modelTiers must define all six canonical tiers; missing ${missingTier}: ${path}`);

  return {
    economy: parseModelTierEntry(value["economy"], "modelTiers.economy", path),
    fast: parseModelTierEntry(value["fast"], "modelTiers.fast", path),
    standard: parseModelTierEntry(value["standard"], "modelTiers.standard", path),
    advanced: parseModelTierEntry(value["advanced"], "modelTiers.advanced", path),
    capable: parseModelTierEntry(value["capable"], "modelTiers.capable", path),
    frontier: parseModelTierEntry(value["frontier"], "modelTiers.frontier", path),
  };
}

function parseModelTierEntry(value: unknown, key: string, path: string): ModelTierLadder[ModelTier] {
  if (!isRecord(value)) throw new Error(`PI WEBUI config ${key} must be an object: ${path}`);
  const unknownKey = Object.keys(value).find((entryKey) => entryKey !== "model" && entryKey !== "thinkingLevel");
  if (unknownKey !== undefined) throw new Error(`PI WEBUI config ${key} contains unknown key ${JSON.stringify(unknownKey)}: ${path}`);
  if (!isRecord(value["model"])) throw new Error(`PI WEBUI config ${key}.model must be an object: ${path}`);
  const model = value["model"];
  const modelUnknownKey = Object.keys(model).find((modelKey) => modelKey !== "provider" && modelKey !== "id");
  if (modelUnknownKey !== undefined) throw new Error(`PI WEBUI config ${key}.model contains unknown key ${JSON.stringify(modelUnknownKey)}: ${path}`);
  const thinkingLevel = value["thinkingLevel"];
  if (typeof thinkingLevel !== "string" || thinkingLevel === "") throw new Error(`PI WEBUI config ${key}.thinkingLevel must be a non-empty string: ${path}`);
  return {
    model: {
      provider: parseString(model["provider"], `${key}.model.provider`, path),
      id: parseString(model["id"], `${key}.model.id`, path),
    },
    thinkingLevel,
  };
}

function parseMaxUploadBytes(value: unknown, key: string, path = "environment"): number {
  const bytes = typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : NaN;
  if (!Number.isInteger(bytes) || bytes < 1) throw new Error(`PI WEBUI config ${key} must be a positive integer: ${path}`);
  return bytes;
}

function parseSpawnSessions(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`PI WEBUI config spawnSessions must be a boolean: ${path}`);
  return value;
}

/**
 * Whether LLMs may start new sessions via the spawn_session tool. On by default
 * (spawned sessions appear in the session list, so humans notice them); set the
 * env var `PI_WEBUI_SPAWN_SESSIONS` or the `spawnSessions` config key to `false`
 * to disable. The env var takes precedence over the config file.
 */
export function spawnSessionsEnabled(env: NodeJS.ProcessEnv = process.env, config: PiWebUiConfig = {}): boolean {
  const fromEnv = env["PI_WEBUI_SPAWN_SESSIONS"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv === "1" || fromEnv.toLowerCase() === "true";
  return config.spawnSessions ?? true;
}

function parseSubsessions(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`PI WEBUI config subsessions must be a boolean: ${path}`);
  return value;
}

/**
 * Beta: whether LLMs may start tracked child sessions via the spawn_subsession
 * family of tools. Off by default while the capability stabilizes, so it can
 * ship in main without affecting releases; enable with the env var
 * `PI_WEBUI_SUBSESSIONS` or the `subsessions` config key. The env var takes
 * precedence over the config file. Subsessions also require spawnSessions to be
 * enabled (they share the same project-scope resolver).
 */
export function subsessionsEnabled(env: NodeJS.ProcessEnv = process.env, config: PiWebUiConfig = {}): boolean {
  const fromEnv = env["PI_WEBUI_SUBSESSIONS"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv === "1" || fromEnv.toLowerCase() === "true";
  return config.subsessions ?? false;
}

function parseString(value: unknown, key: string, path: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`PI WEBUI config ${key} must be a non-empty string: ${path}`);
  return value;
}

const AGENT_CONFIG_KEYS = new Set(["command", "dir"]);
const SAFE_BARE_AGENT_COMMAND_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/u;

export type AgentPathHost = "current" | "portable";

export function parseAgentConfig(value: unknown, path: string, pathHost: AgentPathHost = "current"): NonNullable<PiWebUiConfig["agent"]> {
  if (!isRecord(value)) throw new Error(`PI WEBUI config agent must be an object: ${path}`);
  const unknownKey = Object.keys(value).find((key) => !AGENT_CONFIG_KEYS.has(key));
  if (unknownKey !== undefined) throw new Error(`PI WEBUI config agent contains unknown key ${JSON.stringify(unknownKey)}: ${path}`);
  const command = value["command"];
  const dir = value["dir"];
  return {
    ...(command !== undefined ? { command: parseAgentCommand(command, "agent.command", path, pathHost) } : {}),
    ...(dir !== undefined ? { dir: parseAgentDir(dir, "agent.dir", path, pathHost) } : {}),
  };
}

function parseAgentCommand(value: unknown, key: string, path: string, pathHost: AgentPathHost): string {
  const command = parseString(value, key, path).trim();
  if (!isSafeAgentCommand(command, pathHost)) {
    const absoluteLabel = pathHost === "current" ? "host-absolute" : "absolute";
    throw new Error(`PI WEBUI config ${key} must be a safe bare executable name or ${absoluteLabel} executable path: ${path}`);
  }
  return command;
}

function parseAgentDir(value: unknown, key: string, path: string, pathHost: AgentPathHost): string {
  const dir = parseString(value, key, path).trim();
  const isAbsoluteDir = pathHost === "current" ? isHostAbsoluteAgentDir(dir) : isPortableAbsoluteAgentPath(dir);
  if (!isAbsoluteDir && !isHomePath(dir, pathHost)) {
    const absoluteLabel = pathHost === "current" ? "a host-absolute" : "an absolute";
    throw new Error(`PI WEBUI config ${key} must be ${absoluteLabel} path or start with ~: ${path}`);
  }
  return dir;
}

function resolveAgentDirPath(value: string, env: NodeJS.ProcessEnv, key: string, path: string): string {
  const parsed = parseAgentDir(value, key, path, "current");
  const expanded = expandHomePath(parsed, env);
  if (!isHostAbsoluteAgentDir(expanded)) {
    throw new Error(`PI WEBUI config ${key} must resolve to a host-absolute path: ${path}`);
  }
  return normalize(expanded);
}

export function isSafeAgentCommandForHost(value: string): boolean {
  return isSafeAgentCommand(value, "current");
}

function isSafeAgentCommand(value: string, pathHost: AgentPathHost): boolean {
  if (value === "" || value !== value.trim() || value.includes("\0") || /[\s;&|`$<>]/u.test(value)) return false;
  if (SAFE_BARE_AGENT_COMMAND_PATTERN.test(value)) return true;
  if (pathHost === "current") return isAbsolute(value) && basename(value) !== "";
  return isAbsoluteLike(value) && value.split(/[\\/]/u).at(-1) !== "";
}

export function isHostAbsoluteAgentDir(value: string): boolean {
  return isSafeAgentDirPath(value) && isAbsolute(value);
}

function isPortableAbsoluteAgentPath(value: string): boolean {
  return isSafeAgentDirPath(value) && isAbsoluteLike(value);
}

function isSafeAgentDirPath(value: string): boolean {
  return value !== "" && value === value.trim() && !hasControlCharacter(value);
}

function parsePort(value: unknown, key: string, path = "environment"): number {
  const port = typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PI WEBUI config ${key} must be an integer from 1 to 65535: ${path}`);
  return port;
}

function parseAllowedHosts(value: unknown, path: string): string[] | true {
  if (value === true) return true;
  if (!isNonEmptyStringArray(value)) {
    throw new Error(`PI WEBUI config allowedHosts must be true or an array of non-empty strings: ${path}`);
  }
  return value;
}

function parseAllowedHostsEnv(value: string): string[] | true {
  if (value === "true") return true;
  return value.split(",").map((host) => host.trim()).filter((host) => host !== "");
}

export function parsePathAccessConfig(value: unknown, path: string): NonNullable<PiWebUiConfigValues["pathAccess"]> {
  if (!isRecord(value)) throw new Error(`PI WEBUI config pathAccess must be an object: ${path}`);
  const allowedPaths = value["allowedPaths"];
  return {
    ...(allowedPaths !== undefined ? { allowedPaths: parseAllowedPaths(allowedPaths, path) } : {}),
  };
}

function parseAllowedPaths(value: unknown, path: string): string[] {
  if (!isNonEmptyStringArray(value)) throw new Error(`PI WEBUI config pathAccess.allowedPaths must be an array of non-empty strings: ${path}`);
  return value;
}

export function parseUploadsConfig(value: unknown, path: string): NonNullable<PiWebUiConfigValues["uploads"]> {
  if (!isRecord(value)) throw new Error(`PI WEBUI config uploads must be an object: ${path}`);
  const defaultFolder = value["defaultFolder"];
  return {
    ...(defaultFolder !== undefined ? { defaultFolder: parseWorkspaceRelativeFolder(defaultFolder, "uploads.defaultFolder", path) } : {}),
  };
}

function parseWorkspaceRelativeFolder(value: unknown, key: string, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`PI WEBUI config ${key} must be a non-empty workspace-relative path: ${path}`);
  if (isAbsoluteLike(value)) throw new Error(`PI WEBUI config ${key} must be workspace-relative: ${path}`);
  const parts = value.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) throw new Error(`PI WEBUI config ${key} must be a non-empty workspace-relative path: ${path}`);
  if (parts.some((part) => part === "..")) throw new Error(`PI WEBUI config ${key} must not contain path traversal: ${path}`);
  return parts.join("/");
}


function isHomePath(value: string, pathHost: AgentPathHost): boolean {
  return value === "~" || value.startsWith("~/") || ((pathHost === "portable" || process.platform === "win32") && value.startsWith("~\\"));
}

function expandHomePath(value: string, env: NodeJS.ProcessEnv): string {
  const home = env["HOME"] !== undefined && env["HOME"] !== "" ? env["HOME"] : homedir();
  if (value === "~") return home;
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) return join(home, value.slice(2));
  return value;
}

function defaultAgentDirForCommand(command: string, env: NodeJS.ProcessEnv): string {
  if (usesPiCodingAgentStateCompatibility(command)) return expandHomePath("~/.pi/agent", env);
  throw new Error(`PI WEBUI config agent.dir or ${PI_WEBUI_AGENT_DIR_ENV} is required when agent.command is ${JSON.stringify(command)}`);
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value !== undefined && value !== "" ? value : undefined;
}

function isEnvSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function isAbsoluteLike(value: string): boolean {
  const withForwardSlashes = value.replace(/\\/g, "/");
  return isAbsolute(value) || withForwardSlashes.startsWith("/") || /^[A-Za-z]:\//.test(withForwardSlashes);
}

function parseShortcuts(value: unknown, path: string): Record<string, string | null> {
  if (!isRecord(value)) throw new Error(`PI WEBUI config shortcuts must be an object: ${path}`);
  return Object.fromEntries(Object.entries(value).map(([actionId, shortcut]) => {
    if (shortcut !== null && (typeof shortcut !== "string" || shortcut === "")) {
      throw new Error(`PI WEBUI config shortcut values must be non-empty strings or null: ${path}`);
    }
    return [actionId, shortcut];
  }));
}

function parsePlugins(value: unknown, path: string): NonNullable<PiWebUiConfigValues["plugins"]> {
  if (!isRecord(value) || Array.isArray(value)) throw new Error(`PI WEBUI config plugins must be an object: ${path}`);
  return Object.fromEntries(Object.entries(value).map(([pluginId, config]) => {
    if (!isPiWebUiPluginId(pluginId)) throw new Error(`PI WEBUI config plugin ids must match ${piWebUiPluginIdPattern.source}: ${path}`);
    if (!isRecord(config) || Array.isArray(config)) throw new Error(`PI WEBUI config plugin entries must be objects: ${path}`);
    const enabled = config["enabled"];
    if (enabled !== undefined && typeof enabled !== "boolean") throw new Error(`PI WEBUI config plugin enabled values must be booleans: ${path}`);
    const settings = config["settings"];
    if (settings !== undefined && (!isRecord(settings) || Array.isArray(settings))) throw new Error(`PI WEBUI config plugin settings must be objects: ${path}`);
    return [pluginId, config];
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "");
}

export function examplePiWebUiConfig(config: PiWebUiConfig = {}): string {
  return `${JSON.stringify({ host: config.host ?? "127.0.0.1", port: config.port ?? DEFAULT_PORT, allowedHosts: config.allowedHosts ?? [] }, null, 2)}\n`;
}
