import type { FastifyInstance } from "fastify";
import { agentDirEnvSource, hasAgentDirEnvOverride, hasAgentSessionDirEnvOverride, loadPiWebUiConfig, parseAgentConfig, parseModelTiersConfig, parseTtsConfig, parseUploadsConfig, resolveEffectivePiWebUiConfig, type AgentPathHost, type LoadOptions, type PiWebUiConfig } from "../config.js";
import { PiWebUiConfigMutationBusyError, createPiWebUiConfigMutationCoordinator, type PiWebUiConfigMutationCoordinator, type PiWebUiConfigMutationSnapshot } from "../configMutationCoordinator.js";
import type { PiWebUiAgentDirEnvSource, PiWebUiConfigEnvOverrides, PiWebUiConfigResponse, PiWebUiConfigValues } from "../shared/apiTypes.js";
import { isPiWebUiPluginId } from "../shared/pluginIds.js";

export interface PiWebUiConfigService {
  read: () => PiWebUiConfigResponse | Promise<PiWebUiConfigResponse>;
  write: (config: PiWebUiConfigValues) => PiWebUiConfigResponse | Promise<PiWebUiConfigResponse>;
  update: (mutate: (current: PiWebUiConfigValues) => PiWebUiConfigValues) => PiWebUiConfigResponse | Promise<PiWebUiConfigResponse>;
}

export const SELECTED_MACHINE_CONFIG_KEYS = [
  "plugins",
  "pathAccess",
  "uploads",
  "maxUploadBytes",
  "modelTiers",
  "spawnSessions",
  "subsessions",
  "agent",
] as const satisfies readonly (keyof PiWebUiConfigValues)[];

const SELECTED_MACHINE_CONFIG_KEY_SET = new Set<string>(SELECTED_MACHINE_CONFIG_KEYS);

/**
 * The production file service coordinates every mutation through the
 * cross-process coordinator and projects each response from the exact
 * committed snapshot, so a later writer's commit can never leak into an
 * earlier mutation's response. Ordinary reads stay on the lock-free JSON read
 * path because they expose no revision and need no write transaction.
 *
 * The environment is pinned at construction: a live process.env could
 * otherwise change between construction and the first mutation, moving the
 * config and lock database paths away from the session daemon's frozen
 * startup snapshot. Callers that own a shared coordinator (for example
 * `buildApp`, which hands the same instance to the speech settings service)
 * pass it in so there is exactly one mutation authority per process.
 */
export function createFilePiWebUiConfigService(options: LoadOptions = {}, coordinator?: PiWebUiConfigMutationCoordinator): PiWebUiConfigService {
  const pinnedOptions: LoadOptions = options.env === undefined ? { ...options, env: Object.freeze({ ...process.env }) } : options;
  let ownedCoordinator: PiWebUiConfigMutationCoordinator | undefined;
  const mutationCoordinator = (): PiWebUiConfigMutationCoordinator => {
    if (coordinator !== undefined) return coordinator;
    ownedCoordinator ??= createPiWebUiConfigMutationCoordinator({ config: pinnedOptions });
    return ownedCoordinator;
  };
  return {
    read: () => currentPiWebUiConfigResponse(pinnedOptions),
    write: async (config) => {
      const snapshot = await mutationCoordinator().mutate(() => config);
      return piWebUiConfigResponseFromSnapshot(snapshot, pinnedOptions);
    },
    update: async (mutate) => {
      const snapshot = await mutationCoordinator().mutate((current) => mutate(current.loaded.config));
      return piWebUiConfigResponseFromSnapshot(snapshot, pinnedOptions);
    },
  };
}

export function currentPiWebUiConfigResponse(options: LoadOptions = {}): PiWebUiConfigResponse {
  return piWebUiConfigResponseFromSnapshot({ loaded: loadPiWebUiConfig(options), speechInputRevision: "" }, options);
}

/** Pure projection of a coordinated snapshot without disk I/O. */
export function piWebUiConfigResponseFromSnapshot(snapshot: PiWebUiConfigMutationSnapshot, options: LoadOptions = {}): PiWebUiConfigResponse {
  const effective = resolveEffectivePiWebUiConfig(snapshot.loaded, options);
  const env = options.env ?? process.env;
  return {
    path: snapshot.loaded.path,
    exists: snapshot.loaded.exists,
    config: snapshot.loaded.config,
    effectiveConfig: effective.config,
    ...(snapshot.loaded.modelTiersError === undefined ? {} : { modelTiersError: snapshot.loaded.modelTiersError }),
    envOverrides: piWebUiConfigEnvOverrides(env, effective.config),
  };
}

/**
 * Browser-facing generic config responses omit the entire persisted speech
 * subtree; only route serialization calls this. The service itself stays
 * full-fidelity because internal consumers and the dedicated speech modules
 * need the raw config.
 */
export function redactSpeechInputConfigResponse(response: PiWebUiConfigResponse): PiWebUiConfigResponse {
  return {
    ...response,
    config: redactSpeechInputConfigValues(response.config),
    effectiveConfig: redactSpeechInputConfigValues(response.effectiveConfig),
  };
}

function redactSpeechInputConfigValues(config: PiWebUiConfigValues): PiWebUiConfigValues {
  if (config.speechInput === undefined) return config;
  const redacted: PiWebUiConfigValues = { ...config };
  delete redacted.speechInput;
  return redacted;
}

export function registerConfigRoutes(app: FastifyInstance, service: PiWebUiConfigService = createFilePiWebUiConfigService()): void {
  app.get("/api/config", async (_request, reply) => {
    try {
      return redactSpeechInputConfigResponse(await service.read());
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Body: { config?: unknown } | undefined }>("/api/config", async (request, reply) => {
    try {
      const body = request.body?.config;
      if (isRecord(body) && Object.hasOwn(body, "speechInput")) {
        throw new Error("PI WEBUI config speechInput must be updated through the dedicated speech input settings API");
      }
      const requested = parseConfigRequest(body);
      const response = await service.update((current) => ({
        ...requested,
        ...(current.speechInput === undefined ? {} : { speechInput: current.speechInput }),
      }));
      return redactSpeechInputConfigResponse(response);
    } catch (error) {
      const status = configMutationErrorStatus(error);
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });
}

export function registerLocalMachineConfigRoutes(app: FastifyInstance, service: PiWebUiConfigService = createFilePiWebUiConfigService()): void {
  app.get("/api/machines/local/config", async (_request, reply) => {
    try {
      return selectedMachineConfigResponse(await service.read());
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Body: { config?: unknown } | undefined }>("/api/machines/local/config", async (request, reply) => {
    try {
      const patch = parseSelectedMachineConfigRequest(request.body?.config);
      const response = await service.update((current) => mergeSelectedMachineConfig(current, patch));
      return selectedMachineConfigResponse(response);
    } catch (error) {
      const status = configMutationErrorStatus(error);
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });
}

export function parseSelectedMachineConfigRequest(value: unknown, agentPathHost: AgentPathHost = "current"): PiWebUiConfig {
  if (!isRecord(value)) throw new Error("PI WEBUI selected-machine config update must include a config object");
  for (const key of Object.keys(value)) {
    if (!SELECTED_MACHINE_CONFIG_KEY_SET.has(key)) throw new Error(`PI WEBUI selected-machine config key is not allowed: ${key}`);
  }
  try {
    return pickSelectedMachineConfig(parseConfigRequest(value, agentPathHost));
  } catch (error) {
    throw new Error(selectedMachineConfigErrorMessage(error), { cause: error });
  }
}

export function mergeSelectedMachineConfig(current: PiWebUiConfigValues, patch: PiWebUiConfigValues): PiWebUiConfig {
  return { ...current, ...pickSelectedMachineConfig(patch) };
}

export function selectedMachineConfigResponse(response: PiWebUiConfigResponse): PiWebUiConfigResponse {
  return {
    ...response,
    config: pickSelectedMachineConfig(response.config),
    effectiveConfig: pickSelectedMachineConfig(response.effectiveConfig),
  };
}

export function parsePiWebUiConfigResponseBody(value: unknown, source = "PI WEBUI config response"): PiWebUiConfigResponse {
  const record = requireResponseRecord(value, source);
  return {
    path: requireResponseString(record, "path", source),
    exists: requireResponseBoolean(record, "exists", source),
    config: parseConfigRequest(record["config"], "portable"),
    effectiveConfig: parseConfigRequest(record["effectiveConfig"], "portable"),
    ...(record["modelTiersError"] === undefined ? {} : { modelTiersError: requireResponseString(record, "modelTiersError", source) }),
    envOverrides: parsePiWebUiConfigEnvOverridesResponse(record["envOverrides"], source),
  };
}

function parseConfigRequest(value: unknown, agentPathHost: AgentPathHost = "current"): PiWebUiConfig {
  if (!isRecord(value)) throw new Error("PI WEBUI config update must include a config object");
  const config: PiWebUiConfig = {};
  const host = value["host"];
  const port = value["port"];
  const allowedHosts = value["allowedHosts"];
  const shortcuts = value["shortcuts"];
  const plugins = value["plugins"];
  const pathAccess = value["pathAccess"];
  const uploads = value["uploads"];
  const maxUploadBytes = value["maxUploadBytes"];
  const modelTiers = value["modelTiers"];
  const spawnSessions = value["spawnSessions"];
  const subsessions = value["subsessions"];
  const agent = value["agent"];
  const tts = value["tts"];
  if (host !== undefined) {
    if (typeof host !== "string") throw new Error("PI WEBUI config host must be a string");
    config.host = host;
  }
  if (port !== undefined) {
    if (typeof port !== "number") throw new Error("PI WEBUI config port must be a number");
    config.port = port;
  }
  if (allowedHosts !== undefined) config.allowedHosts = parseAllowedHostsRequest(allowedHosts);
  if (shortcuts !== undefined) config.shortcuts = parseShortcutsRequest(shortcuts);
  if (plugins !== undefined) config.plugins = parsePluginsRequest(plugins);
  if (pathAccess !== undefined) config.pathAccess = parsePathAccessRequest(pathAccess);
  if (uploads !== undefined) config.uploads = parseUploadsConfig(uploads, "request");
  if (maxUploadBytes !== undefined) config.maxUploadBytes = parseMaxUploadBytesRequest(maxUploadBytes);
  if (modelTiers !== undefined) config.modelTiers = parseModelTiersConfig(modelTiers, "request");
  if (spawnSessions !== undefined) {
    if (typeof spawnSessions !== "boolean") throw new Error("PI WEBUI config spawnSessions must be a boolean");
    config.spawnSessions = spawnSessions;
  }
  if (subsessions !== undefined) {
    if (typeof subsessions !== "boolean") throw new Error("PI WEBUI config subsessions must be a boolean");
    config.subsessions = subsessions;
  }
  if (agent !== undefined) config.agent = parseAgentRequest(agent, agentPathHost);
  if (tts !== undefined) config.tts = parseTtsConfig(tts, "request");
  return config;
}

function pickSelectedMachineConfig(config: PiWebUiConfigValues): PiWebUiConfig {
  return {
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

function selectedMachineConfigErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  if (message.startsWith("PI WEBUI config ")) return `PI WEBUI selected-machine config ${message.slice("PI WEBUI config ".length)}`;
  return `PI WEBUI selected-machine config ${message}`;
}

function parseAllowedHostsRequest(value: unknown): string[] | true {
  if (value === true) return true;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("PI WEBUI config allowedHosts must be true or an array of strings");
  }
  return value;
}

function parseShortcutsRequest(value: unknown): Record<string, string | null> {
  if (!isRecord(value)) throw new Error("PI WEBUI config shortcuts must be an object");
  return Object.fromEntries(Object.entries(value).map(([actionId, shortcut]) => {
    if (shortcut !== null && (typeof shortcut !== "string" || shortcut === "")) throw new Error("PI WEBUI config shortcut values must be non-empty strings or null");
    return [actionId, shortcut];
  }));
}

function parsePathAccessRequest(value: unknown): NonNullable<PiWebUiConfig["pathAccess"]> {
  if (!isRecord(value)) throw new Error("PI WEBUI config pathAccess must be an object");
  const allowedPaths = value["allowedPaths"];
  return {
    ...(allowedPaths === undefined ? {} : { allowedPaths: parseAllowedPathsRequest(allowedPaths) }),
  };
}

function parseAllowedPathsRequest(value: unknown): string[] {
  if (!isNonEmptyStringArray(value)) {
    throw new Error("PI WEBUI config pathAccess.allowedPaths must be an array of non-empty strings");
  }
  return value;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "");
}

function parseMaxUploadBytesRequest(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error("PI WEBUI config maxUploadBytes must be a positive integer");
  return value;
}

function parseAgentRequest(value: unknown, pathHost: AgentPathHost): NonNullable<PiWebUiConfig["agent"]> {
  return parseAgentConfig(value, "request", pathHost);
}

function parsePluginsRequest(value: unknown): NonNullable<PiWebUiConfig["plugins"]> {
  if (!isRecord(value) || Array.isArray(value)) throw new Error("PI WEBUI config plugins must be an object");
  return Object.fromEntries(Object.entries(value).map(([pluginId, config]) => {
    if (!isPiWebUiPluginId(pluginId)) throw new Error("PI WEBUI config plugin ids are invalid");
    if (!isRecord(config) || Array.isArray(config)) throw new Error("PI WEBUI config plugin entries must be objects");
    const enabled = config["enabled"];
    if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("PI WEBUI config plugin enabled values must be booleans");
    const settings = config["settings"];
    if (settings !== undefined && (!isRecord(settings) || Array.isArray(settings))) throw new Error("PI WEBUI config plugin settings must be objects");
    return [pluginId, config];
  }));
}

function parsePiWebUiConfigEnvOverridesResponse(value: unknown, source: string): PiWebUiConfigEnvOverrides {
  const record = requireResponseRecord(value, `${source} envOverrides`);
  return {
    host: requireResponseBoolean(record, "host", source),
    port: requireResponseBoolean(record, "port", source),
    allowedHosts: requireResponseBoolean(record, "allowedHosts", source),
    spawnSessions: requireResponseBoolean(record, "spawnSessions", source),
    subsessions: requireResponseBoolean(record, "subsessions", source),
    agentCommand: optionalResponseBoolean(record, "agentCommand", source) ?? false,
    agentDir: optionalResponseBoolean(record, "agentDir", source) ?? false,
    ...optionalAgentDirSource(record, source),
    agentSessionDir: optionalResponseBoolean(record, "agentSessionDir", source) ?? false,
  };
}

function requireResponseRecord(value: unknown, source: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${source} must be an object`);
  return value;
}

function requireResponseString(record: Record<string, unknown>, key: string, source: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${source} field must be a string: ${key}`);
  return value;
}

function requireResponseBoolean(record: Record<string, unknown>, key: string, source: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`${source} field must be a boolean: ${key}`);
  return value;
}

function optionalResponseBoolean(record: Record<string, unknown>, key: string, source: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${source} field must be a boolean: ${key}`);
  return value;
}

function optionalAgentDirSource(record: Record<string, unknown>, source: string): { agentDirSource?: PiWebUiAgentDirEnvSource } {
  const value = record["agentDirSource"];
  if (value === undefined) return {};
  if (value !== "pi-webui" && value !== "pi-compatibility") throw new Error(`${source} field must be a valid agent directory source: agentDirSource`);
  return { agentDirSource: value };
}

function piWebUiConfigEnvOverrides(env: NodeJS.ProcessEnv, config: PiWebUiConfig = {}): PiWebUiConfigEnvOverrides {
  const command = config.agent?.command;
  const dirEnvSource = agentDirEnvSource(env);
  return {
    host: isEnvSet(env["PI_WEBUI_HOST"]),
    port: isEnvSet(env["PI_WEBUI_PORT"]) || isEnvSet(env["PORT"]),
    allowedHosts: isEnvSet(env["PI_WEBUI_ALLOWED_HOSTS"]),
    spawnSessions: isEnvSet(env["PI_WEBUI_SPAWN_SESSIONS"]),
    subsessions: isEnvSet(env["PI_WEBUI_SUBSESSIONS"]),
    agentCommand: isEnvSet(env["PI_WEBUI_AGENT_COMMAND"]),
    agentDir: hasAgentDirEnvOverride(env, command),
    ...(dirEnvSource === undefined ? {} : { agentDirSource: dirEnvSource }),
    agentSessionDir: hasAgentSessionDirEnvOverride(env, command),
  };
}

function isEnvSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

function isConfigValidationError(error: unknown): boolean {
  return error instanceof Error && (error.message.startsWith("PI WEBUI config") || error.message.startsWith("PI WEBUI selected-machine config"));
}

function configMutationErrorStatus(error: unknown): number {
  if (error instanceof PiWebUiConfigMutationBusyError) return 503;
  if (isConfigValidationError(error)) return 400;
  return 500;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
