import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { MODEL_TIERS, type ModelTier, type ModelTierLadder, type PiWebUiAgentDirEnvSource, type PiWebUiConfigValues, type PiWebUiSpeechInputCloudConfig, type PiWebUiSpeechInputConfig, type SpeechInputProviderPreference, type TierModelRef, type UtilityModelBinding, type UtilityModelSettings } from "./shared/apiTypes.js";
import { isPiCompanionCommand, usesPiCodingAgentStateCompatibility } from "./shared/activeAgentProfile.js";
import { isPiWebUiPluginId, piWebUiPluginIdPattern } from "./shared/pluginIds.js";
import { isKnownThinkingLevel } from "./shared/thinkingLevels.js";

export { isPiCompanionCommand };

export type PiWebUiConfig = PiWebUiConfigValues;

export interface LoadedPiWebUiConfig {
  path: string;
  exists: boolean;
  config: PiWebUiConfig;
  /** A malformed external ladder is reported without blocking unrelated config use. */
  modelTiersError?: string;
  /** Malformed external utility settings are reported without blocking unrelated config use. */
  utilityModelsError?: string;
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

export interface PiWebUiConfigFileOperations {
  /** Physical write target for a configured path, following existing or dangling symlinks. */
  resolveWriteTarget(path: string): { path: string; mode?: number };
  /** Create a fresh file at `path` with the given mode, failing if it exists. */
  writeExclusive(path: string, contents: string, mode: number): void;
  setMode(path: string, mode: number): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Injected sync file-operation seam used only by config persistence. */
  fileOperations?: PiWebUiConfigFileOperations;
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

  const parsedConfig = parsePiWebUiConfig(parsed, path, { allowInvalidModelTiers: true, allowInvalidUtilityModels: true });
  return {
    path,
    exists: true,
    config: parsedConfig.config,
    ...(parsedConfig.modelTiersError === undefined ? {} : { modelTiersError: parsedConfig.modelTiersError }),
    ...(parsedConfig.utilityModelsError === undefined ? {} : { utilityModelsError: parsedConfig.utilityModelsError }),
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
  if (normalized.tts !== undefined) delete existing["tts"];
  if (normalized.modelTiers !== undefined) delete existing["modelTiers"];
  if (normalized.utilityModels !== undefined) delete existing["utilityModels"];
  // Only an explicit speech save may replace the raw speech subtree; an
  // unrelated save preserves the persisted credential source byte-for-byte.
  if (piWebUiConfigRecord(config)["speechInput"] !== undefined) delete existing["speechInput"];
  const merged = { ...existing, ...piWebUiConfigRecord(normalized) };
  const operations = options.fileOperations ?? defaultPiWebUiConfigFileOperations;
  mkdirSync(dirname(path), { recursive: true });
  const target = operations.resolveWriteTarget(path);
  const tempPath = temporaryConfigPath(target.path);
  // A brand-new credential-free file is created at 0o666 so the process umask
  // derives the same default mode a plain write would produce; every other
  // case pins an explicit final mode and therefore starts at the safe 0o600.
  const finalMode = finalConfigMode(merged, target);
  const creationMode = finalMode === undefined ? 0o666 : 0o600;
  try {
    operations.writeExclusive(tempPath, `${JSON.stringify(merged, null, 2)}\n`, creationMode);
    if (finalMode !== undefined) operations.setMode(tempPath, finalMode);
    operations.rename(tempPath, target.path);
  } catch (error) {
    // The unique temp is always ours once resolveWriteTarget succeeded, so a
    // best-effort removal cannot touch another writer's file. Cleanup failures
    // are secondary to the original error.
    try {
      operations.remove(tempPath);
    } catch {
      // Best-effort cleanup only; the original error is the failure to report.
    }
    throw error;
  }
  return loadPiWebUiConfig(options);
}

function temporaryConfigPath(targetPath: string): string {
  return join(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.tmp`);
}

/**
 * Choose the final persisted mode from the merged raw object:
 * - a nonempty saved credential source forces 0600;
 * - an existing credential-free target keeps its own permission bits;
 * - a brand-new credential-free file keeps the umask-derived creation mode.
 */
function finalConfigMode(merged: Record<string, unknown>, target: { path: string; mode?: number }): number | undefined {
  const speechInput = isRecord(merged["speechInput"]) ? merged["speechInput"] : undefined;
  const cloud = speechInput === undefined ? undefined : (isRecord(speechInput["cloud"]) ? speechInput["cloud"] : undefined);
  const apiKey = cloud === undefined ? undefined : cloud["apiKey"];
  if (typeof apiKey === "string" && apiKey !== "") return 0o600;
  if (target.mode !== undefined) return target.mode & 0o777;
  return undefined;
}

const defaultPiWebUiConfigFileOperations: PiWebUiConfigFileOperations = {
  resolveWriteTarget: (path) => defaultResolveWriteTarget(path),
  writeExclusive: (path, contents, mode) => {
    writeFileSync(path, contents, { encoding: "utf8", flag: "wx", mode });
  },
  setMode: (path, mode) => {
    chmodSync(path, mode);
  },
  rename: (from, to) => {
    renameSync(from, to);
  },
  remove: (path) => {
    rmSync(path, { force: true });
  },
};

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * A trailing separator marks a directory reference, never a file leaf.
 * `sep` gives the native separator; `/` is additionally accepted on every
 * platform so Windows-target paths behave like POSIX ones.
 */
function hasTerminalPathSeparator(candidate: string): boolean {
  return candidate.endsWith(sep) || candidate.endsWith("/");
}

/**
 * Physical write-target resolution with the same semantics as ProjectStore:
 * follow an existing configured symlink to its real file; for a dangling
 * symlink, walk links without prematurely collapsing `..`, reject
 * cycles/non-file terminal paths, and use the physical target parent.
 */
function defaultResolveWriteTarget(filePath: string): { path: string; mode?: number } {
  try {
    const effectivePath = realpathSync(filePath);
    const metadata = statSync(effectivePath);
    if (metadata.isDirectory()) {
      throw new Error(`PI WEBUI config path must resolve to a file: ${filePath}`);
    }
    return {
      path: effectivePath,
      ...(process.platform === "win32" ? {} : { mode: metadata.mode & 0o777 }),
    };
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) return resolveMissingWriteTarget(filePath);
    if (isNodeErrorWithCode(error, "ELOOP")) {
      throw new Error("Cannot resolve PI WEBUI config path because of a symbolic-link cycle", { cause: error });
    }
    throw error;
  }
}

function resolveMissingWriteTarget(filePath: string): { path: string; mode?: number } {
  let candidate = filePath;
  const visited = new Set<string>();

  for (;;) {
    let metadata;
    try {
      metadata = lstatSync(candidate);
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        if (hasTerminalPathSeparator(candidate)) {
          throw new Error(`PI WEBUI config path must resolve to a file: ${filePath}`, { cause: error });
        }
        const physicalParent = realpathSync(dirname(candidate));
        return { path: join(physicalParent, basename(candidate)) };
      }
      throw error;
    }

    if (!metadata.isSymbolicLink()) {
      if (metadata.isDirectory()) {
        throw new Error(`PI WEBUI config path must resolve to a file: ${filePath}`);
      }
      return {
        path: realpathSync(candidate),
        ...(process.platform === "win32" ? {} : { mode: metadata.mode & 0o777 }),
      };
    }

    const physicalParent = realpathSync(dirname(candidate));
    const physicalCandidate = join(physicalParent, basename(candidate));
    if (visited.has(physicalCandidate)) {
      throw new Error("Cannot resolve PI WEBUI config path because of a symbolic-link cycle");
    }
    visited.add(physicalCandidate);

    const target = readlinkSync(physicalCandidate);
    // Preserve component order until the filesystem has traversed any symlink
    // before `..`; path.join/resolve would collapse those components too soon.
    candidate = isAbsolute(target) ? target : `${physicalParent}${physicalParent.endsWith(sep) ? "" : sep}${target}`;
  }
}

export function replacePiWebUiModelTiers(modelTiers: ModelTierLadder, options: LoadOptions = {}): LoadedPiWebUiConfig {
  const loaded = loadPiWebUiConfig(options);
  return savePiWebUiConfig({ ...loaded.config, modelTiers }, options);
}

export function replacePiWebUiUtilityModels(utilityModels: UtilityModelSettings, options: LoadOptions = {}): LoadedPiWebUiConfig {
  const loaded = loadPiWebUiConfig(options);
  return savePiWebUiConfig({ ...loaded.config, utilityModels }, options);
}

function readExistingConfigObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  // A directory at the configured path is rejected later by the atomic writer;
  // reading it as JSON would raise a platform-dependent EISDIR instead.
  if (statSync(path).isDirectory()) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`PI WEBUI config must be a JSON object: ${path}`);
  return parsed;
}

interface ParsedPiWebUiConfig {
  config: PiWebUiConfig;
  modelTiersError?: string;
  utilityModelsError?: string;
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
    ...(config.utilityModels !== undefined ? { utilityModels: config.utilityModels } : {}),
    ...(config.spawnSessions !== undefined ? { spawnSessions: config.spawnSessions } : {}),
    ...(config.subsessions !== undefined ? { subsessions: config.subsessions } : {}),
    ...(config.agent !== undefined ? { agent: config.agent } : {}),
    ...(config.tts !== undefined ? { tts: config.tts } : {}),
    ...(config.speechInput !== undefined ? { speechInput: config.speechInput } : {}),
  };
}

function parsePiWebUiConfig(value: Record<string, unknown>, path: string, options: { allowInvalidModelTiers?: boolean; allowInvalidUtilityModels?: boolean } = {}): ParsedPiWebUiConfig {
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

  let utilityModels: UtilityModelSettings | undefined;
  let utilityModelsError: string | undefined;
  if (value["utilityModels"] !== undefined) {
    try {
      utilityModels = parseUtilityModelsConfig(value["utilityModels"], path);
    } catch (error) {
      if (options.allowInvalidUtilityModels !== true) throw error;
      utilityModelsError = error instanceof Error ? error.message : String(error);
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
      ...(utilityModels === undefined ? {} : { utilityModels }),
      ...(value["spawnSessions"] !== undefined ? { spawnSessions: parseSpawnSessions(value["spawnSessions"], path) } : {}),
      ...(value["subsessions"] !== undefined ? { subsessions: parseSubsessions(value["subsessions"], path) } : {}),
      ...(value["agent"] !== undefined ? { agent: parseAgentConfig(value["agent"], path) } : {}),
      ...(value["tts"] !== undefined ? { tts: parseTtsConfig(value["tts"], path) } : {}),
      ...(value["speechInput"] !== undefined ? { speechInput: parseSpeechInputConfig(value["speechInput"], path) } : {}),
    },
    ...(modelTiersError === undefined ? {} : { modelTiersError }),
    ...(utilityModelsError === undefined ? {} : { utilityModelsError }),
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

export function parseUtilityModelsConfig(value: unknown, path: string): UtilityModelSettings {
  if (!isRecord(value)) {
    throw new Error(`PI WEBUI config utilityModels must be an object: ${path}`);
  }
  const unknownKey = Object.keys(value).find(
    (key) => key !== "lightweight" && key !== "context",
  );
  if (unknownKey !== undefined) {
    throw new Error(
      `PI WEBUI config utilityModels contains unknown key ${JSON.stringify(unknownKey)}: ${path}`,
    );
  }

  return {
    ...(value["lightweight"] !== undefined ? { lightweight: parseUtilityModelBinding(value["lightweight"], "utilityModels.lightweight", path) } : {}),
    ...(value["context"] !== undefined ? { context: parseUtilityModelBinding(value["context"], "utilityModels.context", path) } : {}),
  };
}

function parseUtilityModelBinding(
  value: unknown,
  key: string,
  path: string,
): UtilityModelBinding {
  if (!isRecord(value)) {
    throw new Error(`PI WEBUI config ${key} must be an object: ${path}`);
  }
  const unknownKey = Object.keys(value).find(
    (entryKey) =>
      entryKey !== "provider" &&
      entryKey !== "id" &&
      entryKey !== "thinkingLevel",
  );
  if (unknownKey !== undefined) {
    throw new Error(
      `PI WEBUI config ${key} contains unknown key ${JSON.stringify(unknownKey)}: ${path}`,
    );
  }

  const thinkingLevel = value["thinkingLevel"];
  if (
    thinkingLevel !== undefined &&
    (typeof thinkingLevel !== "string" || !isKnownThinkingLevel(thinkingLevel))
  ) {
    throw new Error(
      `PI WEBUI config ${key}.thinkingLevel must be one of off, minimal, low, medium, high, xhigh, or max: ${path}`,
    );
  }

  return {
    provider: parseString(value["provider"], `${key}.provider`, path),
    id: parseString(value["id"], `${key}.id`, path),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
}

function parseModelTierEntry(value: unknown, key: string, path: string): ModelTierLadder[ModelTier] {
  if (!isRecord(value)) throw new Error(`PI WEBUI config ${key} must be an object: ${path}`);
  const unknownKey = Object.keys(value).find((entryKey) => entryKey !== "model" && entryKey !== "thinkingLevel");
  if (unknownKey !== undefined) throw new Error(`PI WEBUI config ${key} contains unknown key ${JSON.stringify(unknownKey)}: ${path}`);
  const thinkingLevel = value["thinkingLevel"];
  if (typeof thinkingLevel !== "string" || thinkingLevel === "") throw new Error(`PI WEBUI config ${key}.thinkingLevel must be a non-empty string: ${path}`);
  return {
    model: parseModelReference(value["model"], `${key}.model`, path),
    thinkingLevel,
  };
}

function parseModelReference(value: unknown, key: string, path: string): TierModelRef {
  if (!isRecord(value)) throw new Error(`PI WEBUI config ${key} must be an object: ${path}`);
  const unknownKey = Object.keys(value).find((modelKey) => modelKey !== "provider" && modelKey !== "id");
  if (unknownKey !== undefined) throw new Error(`PI WEBUI config ${key} contains unknown key ${JSON.stringify(unknownKey)}: ${path}`);
  return {
    provider: parseString(value["provider"], `${key}.provider`, path),
    id: parseString(value["id"], `${key}.id`, path),
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

const SPEECH_INPUT_CONFIG_KEYS = new Set(["provider", "language", "cloud"]);
const SPEECH_INPUT_CLOUD_KEYS = new Set(["baseUrl", "model", "apiKey"]);
const SPEECH_INPUT_PROVIDERS: readonly SpeechInputProviderPreference[] = ["auto", "browser", "cloud"];

/**
 * Strict persisted speech-input parsing. The credential source is persisted
 * byte-for-byte after only a blank-input rejection; base URL and model persist
 * without outer whitespace; the language persists as one canonical BCP 47 tag.
 */
export function parseSpeechInputConfig(value: unknown, path: string): PiWebUiSpeechInputConfig {
  if (!isRecord(value)) throw new Error(`PI WEBUI config speechInput must be an object: ${path}`);
  const unknownKey = Object.keys(value).find((key) => !SPEECH_INPUT_CONFIG_KEYS.has(key));
  if (unknownKey !== undefined) {
    throw new Error(`PI WEBUI config speechInput contains unknown key ${JSON.stringify(unknownKey)}: ${path}`);
  }

  const provider = value["provider"];
  if (provider !== undefined && !isSpeechInputProvider(provider)) {
    throw new Error(`PI WEBUI config speechInput.provider must be one of auto, browser, or cloud: ${path}`);
  }

  const language = value["language"];
  let parsedLanguage: string | undefined;
  if (language !== undefined) {
    if (typeof language !== "string") {
      throw new Error(`PI WEBUI config speechInput.language must be a canonical BCP 47 language tag: ${path}`);
    }
    let canonical: string;
    try {
      canonical = Intl.getCanonicalLocales(language)[0] ?? "";
    } catch {
      throw new Error(`PI WEBUI config speechInput.language must be a canonical BCP 47 language tag: ${path}`);
    }
    if (canonical.length > 128) {
      throw new Error(`PI WEBUI config speechInput.language must be at most 128 characters: ${path}`);
    }
    parsedLanguage = canonical;
  }

  const cloud = value["cloud"];
  let parsedCloud: PiWebUiSpeechInputCloudConfig | undefined;
  if (cloud !== undefined) {
    if (!isRecord(cloud)) throw new Error(`PI WEBUI config speechInput.cloud must be an object: ${path}`);
    const cloudUnknownKey = Object.keys(cloud).find((key) => !SPEECH_INPUT_CLOUD_KEYS.has(key));
    if (cloudUnknownKey !== undefined) {
      throw new Error(`PI WEBUI config speechInput.cloud contains unknown key ${JSON.stringify(cloudUnknownKey)}: ${path}`);
    }

    const baseUrl = cloud["baseUrl"];
    let parsedBaseUrl: string | undefined;
    if (baseUrl !== undefined) {
      if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
        throw new Error(`PI WEBUI config speechInput.cloud.baseUrl must be a non-empty HTTPS URL: ${path}`);
      }
      const trimmedBaseUrl = baseUrl.trim();
      if (trimmedBaseUrl.length > 2_048) {
        throw new Error(`PI WEBUI config speechInput.cloud.baseUrl must be at most 2048 characters: ${path}`);
      }
      parsedBaseUrl = parseSpeechInputBaseUrl(trimmedBaseUrl, path);
    }

    const model = cloud["model"];
    let parsedModel: string | undefined;
    if (model !== undefined) {
      if (typeof model !== "string" || model.trim() === "") {
        throw new Error(`PI WEBUI config speechInput.cloud.model must be a non-empty string: ${path}`);
      }
      const trimmedModel = model.trim();
      if (trimmedModel.length > 256) {
        throw new Error(`PI WEBUI config speechInput.cloud.model must be at most 256 characters: ${path}`);
      }
      parsedModel = trimmedModel;
    }

    const apiKey = cloud["apiKey"];
    let parsedApiKey: string | undefined;
    if (apiKey !== undefined) {
      if (typeof apiKey !== "string" || apiKey.trim() === "") {
        throw new Error(`PI WEBUI config speechInput.cloud.apiKey must be a non-empty string: ${path}`);
      }
      if (Buffer.byteLength(apiKey, "utf8") > 8 * 1024) {
        throw new Error(`PI WEBUI config speechInput.cloud.apiKey must be at most 8 KiB of UTF-8 text: ${path}`);
      }
      parsedApiKey = apiKey;
    }

    parsedCloud = {
      ...(parsedBaseUrl === undefined ? {} : { baseUrl: parsedBaseUrl }),
      ...(parsedModel === undefined ? {} : { model: parsedModel }),
      ...(parsedApiKey === undefined ? {} : { apiKey: parsedApiKey }),
    };
  }

  return {
    ...(provider === undefined ? {} : { provider }),
    ...(parsedLanguage === undefined ? {} : { language: parsedLanguage }),
    ...(parsedCloud === undefined ? {} : { cloud: parsedCloud }),
  };
}

function isSpeechInputProvider(value: unknown): value is SpeechInputProviderPreference {
  return typeof value === "string" && SPEECH_INPUT_PROVIDERS.some((provider) => provider === value);
}

function parseSpeechInputBaseUrl(value: string, path: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`PI WEBUI config speechInput.cloud.baseUrl must be a valid HTTPS URL: ${path}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`PI WEBUI config speechInput.cloud.baseUrl must use HTTPS: ${path}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`PI WEBUI config speechInput.cloud.baseUrl must not contain credentials: ${path}`);
  }
  if (url.search !== "") {
    throw new Error(`PI WEBUI config speechInput.cloud.baseUrl must not contain a query string: ${path}`);
  }
  if (url.hash !== "") {
    throw new Error(`PI WEBUI config speechInput.cloud.baseUrl must not contain a fragment: ${path}`);
  }
  return value;
}

const TTS_CONFIG_KEYS = new Set(["voice", "rate"]);

export function parseTtsConfig(value: unknown, path: string): NonNullable<PiWebUiConfig["tts"]> {
  if (!isRecord(value)) throw new Error(`PI WEBUI config tts must be an object: ${path}`);
  const unknownKey = Object.keys(value).find((key) => !TTS_CONFIG_KEYS.has(key));
  if (unknownKey !== undefined) throw new Error(`PI WEBUI config tts contains unknown key ${JSON.stringify(unknownKey)}: ${path}`);
  const voice = value["voice"];
  const rate = value["rate"];

  let parsedVoice: string | undefined;
  if (voice !== undefined) {
    if (typeof voice !== "string" || voice.trim() === "") {
      throw new Error(`PI WEBUI config tts.voice must be a non-empty string: ${path}`);
    }
    parsedVoice = voice.trim();
  }

  let parsedRate: number | undefined;
  if (rate !== undefined) {
    if (typeof rate !== "number" || !Number.isInteger(rate) || rate < -100 || rate > 100) {
      throw new Error(`PI WEBUI config tts.rate must be an integer between -100 and 100: ${path}`);
    }
    parsedRate = rate;
  }

  return {
    ...(parsedVoice !== undefined ? { voice: parsedVoice } : {}),
    ...(parsedRate !== undefined ? { rate: parsedRate } : {}),
  };
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
