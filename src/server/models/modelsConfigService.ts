import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rename, rm, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  ModelConnectionTestRequest,
  ModelConnectionTestResponse,
  ModelDiscoveryModel,
  ModelDiscoveryRequest,
  ModelDiscoveryResponse,
  ModelsConfigDocument,
  ModelsConfigErrorCode,
  ModelsConfigLimitsStatusResponse,
  ModelsConfigProvider,
  ModelsConfigSaveResponse,
} from "../../shared/apiTypes.js";
import {
  modelRateLimitFieldMessage,
  type ModelRateLimitField,
  type ModelRateLimitInvalidReason,
} from "../../shared/modelRateLimits.js";
import { wrapModelCompletion, type ModelCompletionFunction } from "../rateLimits/modelRateLimitAdapters.js";
import {
  extractModelRateLimits,
  type ModelRateLimitValidationError,
} from "../rateLimits/modelRateLimitConfig.js";
import type { ModelRateLimitOwner } from "../rateLimits/modelRateLimitOwner.js";
import { ModelsJsonParseError, parseModelsJsonText } from "./modelsJsonParser.js";

const MODEL_CONNECTION_TEST_TIMEOUT_MS = 20_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 20_000;

const MODEL_CONFIGURATION_ERROR_PREFIXES = [
  "Failed to load models.json:",
  "Failed to parse models.json:",
  "Invalid models.json schema:",
] as const;

type ModelConnectionRuntime = Pick<ModelRuntime, "getError" | "getModel" | "getAuth" | "completeSimple">;
type ModelConnectionRuntimeFactory = (options: { modelsPath: string; authPath: string }) => Promise<ModelConnectionRuntime>;
type ModelsReloadRuntime = Pick<ModelRuntime, "refresh" | "getError">;

export interface ModelsConfigServiceLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface ModelsConfigServiceErrorDetails {
  provider?: string;
  modelId?: string;
  field?: ModelRateLimitField;
  reason?: ModelRateLimitInvalidReason;
  occurrence?: number;
  persisted?: boolean;
}

/** Structured models-config failure; routes map `code` to an HTTP status. */
export class ModelsConfigServiceError extends Error {
  constructor(
    readonly code: ModelsConfigErrorCode,
    message: string,
    readonly details: ModelsConfigServiceErrorDetails = {},
  ) {
    super(message);
    this.name = "ModelsConfigServiceError";
  }
}

export interface ModelsConfigServiceDependencies {
  agentDir: string;
  /** The daemon's shared runtime, refreshed from models.json after a successful save. */
  modelRuntime?: ModelsReloadRuntime;
  createConnectionRuntime?: ModelConnectionRuntimeFactory;
  /** Daemon-owned limiter that receives accepted snapshots. */
  rateLimits?: ModelRateLimitOwner;
  logger?: ModelsConfigServiceLogger;
}

type StoredDocumentRead =
  | { kind: "missing" }
  | { kind: "document"; document: ModelsConfigDocument };

/**
 * Owns the active profile's editable `models.json` document and isolated model
 * connection checks. It intentionally lives with sessiond so file ownership and
 * credentials stay aligned with the long-lived Pi runtime.
 */
export class ModelsConfigService {
  private readonly modelsPath: string;
  private readonly authPath: string;
  private readonly modelRuntime: ModelsReloadRuntime | undefined;
  private readonly createConnectionRuntime: ModelConnectionRuntimeFactory;
  private readonly rateLimits: ModelRateLimitOwner | undefined;
  private readonly logger: ModelsConfigServiceLogger | undefined;
  private operationChain: Promise<void> = Promise.resolve();

  constructor({
    agentDir,
    modelRuntime,
    createConnectionRuntime = createConnectionRuntimeForProfile,
    rateLimits,
    logger,
  }: ModelsConfigServiceDependencies) {
    this.modelsPath = join(agentDir, "models.json");
    this.authPath = join(agentDir, "auth.json");
    this.modelRuntime = modelRuntime;
    this.createConnectionRuntime = createConnectionRuntime;
    this.rateLimits = rateLimits;
    this.logger = logger;
  }

  /** Reads, validates, and publishes the startup snapshot. Never throws. */
  async initialize(): Promise<void> {
    await this.enqueue(async () => {
      let source: "missing-file" | "accepted-document" = "accepted-document";
      try {
        const loaded = await this.readStoredDocument();
        if (loaded.kind === "missing") source = "missing-file";
        const document = loaded.kind === "missing" ? emptyModelsConfigDocument() : loaded.document;
        const extraction = extractModelRateLimits(document);
        if (!extraction.ok) throw invalidLimitsError(extraction.errors[0]);
        this.rateLimits?.applySnapshot(extraction.snapshot, source);
      } catch (error) {
        this.rateLimits?.reportLoadFailure(errorMessage(error));
        this.logger?.warn({ file: "models.json", err: error }, "failed to load models.json");
      }
    });
  }

  async read(): Promise<ModelsConfigDocument> {
    const loaded = await this.readStoredDocument();
    return loaded.kind === "missing" ? emptyModelsConfigDocument() : loaded.document;
  }

  readLimitsStatus(): ModelsConfigLimitsStatusResponse {
    const status = this.rateLimits?.readStatus();
    if (status === undefined) return { contractVersion: 1, revision: 0, admission: "ready", source: "none" };
    return {
      contractVersion: 1,
      revision: status.revision,
      admission: status.admission,
      source: status.source,
      ...(status.error === undefined ? {} : { error: status.error }),
    };
  }

  async save(value: unknown): Promise<ModelsConfigSaveResponse> {
    return await this.enqueue(async () => {
      const shape = validateModelsConfigDraftShape(value);
      if (!shape.ok) {
        throw new ModelsConfigServiceError(
          "MODELS_CONFIG_SAVE_INVALID",
          `models.json save request is not a valid configuration: ${shape.message}`,
        );
      }

      const extraction = extractModelRateLimits(shape.document);
      if (!extraction.ok) throw invalidLimitsError(extraction.errors[0]);

      try {
        await this.readStoredDocument();
      } catch (error) {
        if (error instanceof ModelsConfigServiceError && error.code === "MODELS_CONFIG_PARSE_FAILED") {
          throw new ModelsConfigServiceError(
            "MODELS_CONFIG_UNREADABLE",
            "models.json could not be read as a valid configuration; fix the file and reload before saving.",
          );
        }
        throw error;
      }

      await this.persist(shape.document);
      await this.refreshAfterSave(shape.document);
      const revision = this.rateLimits?.applySnapshot(extraction.snapshot, "accepted-document");
      return {
        success: true,
        contractVersion: 1,
        ...(revision === undefined ? {} : { revision }),
      };
    });
  }

  async test(value: unknown): Promise<ModelConnectionTestResponse> {
    const request = parseModelConnectionTestRequest(value);
    let temporaryDirectory: string | undefined;

    try {
      temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-webui-model-test-"));
      const temporaryModelsPath = join(temporaryDirectory, "models.json");
      await writeFile(temporaryModelsPath, JSON.stringify(modelsDocumentForConnectionTest(request), null, 2), "utf8");

      const runtime = await this.createConnectionRuntime({ modelsPath: temporaryModelsPath, authPath: this.authPath });
      const loadError = runtime.getError();
      if (loadError !== undefined) return { ok: false, error: loadError };

      const model = runtime.getModel(request.providerName, request.model.id);
      if (model === undefined) return { ok: false, error: `Model not found: ${request.providerName}/${request.model.id}` };

      const resolved = await runtime.getAuth(model);
      if (resolved?.auth.apiKey === undefined || resolved.auth.apiKey === "") {
        return { ok: false, error: `No API key found for "${request.providerName}"` };
      }

      const delegate: ModelCompletionFunction = (model, context, options) =>
        runtime.completeSimple(model, context, options);
      const rateLimits = this.rateLimits;
      const completeSimple = rateLimits === undefined ? delegate : wrapModelCompletion(rateLimits, delegate);
      return await runModelConnectionTest(completeSimple, model, resolved.auth.apiKey, resolved.auth.headers);
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    } finally {
      if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async discover(value: unknown): Promise<ModelDiscoveryResponse> {
    const request = parseModelDiscoveryRequest(value);
    let temporaryDirectory: string | undefined;

    try {
      temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-webui-model-discovery-"));
      const temporaryModelsPath = join(temporaryDirectory, "models.json");
      await writeFile(temporaryModelsPath, JSON.stringify(modelsDocumentForDiscovery(request), null, 2), "utf8");

      const runtime = await this.createConnectionRuntime({ modelsPath: temporaryModelsPath, authPath: this.authPath });
      const loadError = runtime.getError();
      if (loadError !== undefined) throw new Error(loadError);

      const resolved = await runtime.getAuth(request.providerName);
      if (resolved === undefined) throw new Error(`No API key found for "${request.providerName}"`);

      const endpoint = modelDiscoveryEndpoint(request.provider.baseUrl, request.provider.api, resolved.auth.apiKey);
      const response = await fetchModels(endpoint, request.provider.api, resolved.auth.apiKey, resolved.auth.headers);
      if (!response.ok) throw new Error(`Model discovery request failed with HTTP ${String(response.status)}`);

      return { models: parseDiscoveredModels(await response.json(), request.provider.api) };
    } finally {
      if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private async readStoredDocument(): Promise<StoredDocumentRead> {
    let content: string;
    try {
      content = await readFile(this.modelsPath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return { kind: "missing" };
      throw new ModelsConfigServiceError("MODELS_CONFIG_IO_FAILED", `Failed to read models.json: ${errorMessage(error)}`);
    }

    let parsed: unknown;
    try {
      parsed = parseModelsJsonText(content);
    } catch (error) {
      if (error instanceof ModelsJsonParseError) {
        throw new ModelsConfigServiceError("MODELS_CONFIG_PARSE_FAILED", `models.json could not be parsed: ${error.message}`);
      }
      throw error;
    }

    const shape = validateModelsConfigDraftShape(parsed);
    if (!shape.ok) throw new ModelsConfigServiceError("MODELS_CONFIG_PARSE_FAILED", `models.json could not be parsed: ${shape.message}`);
    return { kind: "document", document: shape.document };
  }

  private async persist(document: ModelsConfigDocument): Promise<void> {
    try {
      await writeModelsJsonAtomically(this.modelsPath, document);
    } catch (error) {
      throw new ModelsConfigServiceError("MODELS_CONFIG_PERSIST_FAILED", `Failed to persist models.json: ${errorMessage(error)}`);
    }
  }

  private async refreshAfterSave(document: ModelsConfigDocument): Promise<void> {
    const modelRuntime = this.modelRuntime;
    if (modelRuntime === undefined) return;
    try {
      const result = await modelRuntime.refresh({ allowNetwork: false });
      if (result.aborted) throw new Error("models.json refresh was aborted");
      const configurationError = narrowRefreshFailure(modelRuntime.getError(), document);
      if (configurationError !== undefined) throw new Error(configurationError);
    } catch (error) {
      const message = errorMessage(error);
      this.rateLimits?.reportLoadFailure(message);
      throw new ModelsConfigServiceError(
        "MODELS_CONFIG_REFRESH_FAILED",
        `models.json was saved, but the active model configuration could not be reloaded: ${message}`,
        { persisted: true },
      );
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationChain.then(operation, operation);
    this.operationChain = run.then(() => undefined, () => undefined);
    return run;
  }
}

export function emptyModelsConfigDocument(): ModelsConfigDocument {
  return { providers: {} };
}

/** One pure shape validator shared by read, save, and the save guard. */
export function validateModelsConfigDraftShape(
  value: unknown,
): { ok: true; document: ModelsConfigDocument } | { ok: false; message: string } {
  if (!isRecord(value)) return { ok: false, message: "models.json must be a JSON object" };
  const rawProviders = value["providers"];
  if (rawProviders === undefined) return { ok: true, document: { ...value, providers: {} } };
  if (!isRecord(rawProviders)) return { ok: false, message: "models.json providers must be an object" };

  const providers: Record<string, ModelsConfigProvider> = {};
  for (const [providerName, rawProvider] of Object.entries(rawProviders)) {
    if (!isRecord(rawProvider)) return { ok: false, message: `models.json provider "${providerName}" must be an object` };
    const rawModels = rawProvider["models"];
    if (rawModels !== undefined) {
      if (!Array.isArray(rawModels)) return { ok: false, message: `models.json provider "${providerName}" models must be an array` };
      for (const entry of rawModels) {
        if (!isRecord(entry)) return { ok: false, message: `models.json provider "${providerName}" model entries must be objects` };
        if (typeof entry["id"] !== "string") return { ok: false, message: `models.json provider "${providerName}" model entries must have a string id` };
      }
    }
    const provider: ModelsConfigProvider = {};
    for (const [key, entry] of Object.entries(rawProvider)) provider[key] = entry;
    providers[providerName] = provider;
  }
  return { ok: true, document: { ...value, providers } };
}

export function parseModelConnectionTestRequest(value: unknown): ModelConnectionTestRequest {
  if (!isRecord(value)) throw new Error("Model test request must be an object");
  const providerName = requiredTrimmedString(value, "providerName");
  const provider = requiredRecord(value, "provider");
  const model = requiredRecord(value, "model");
  const modelId = requiredTrimmedString(model, "id");
  return {
    providerName,
    provider: { ...provider },
    model: { ...model, id: modelId },
  };
}

export function parseModelDiscoveryRequest(value: unknown): ModelDiscoveryRequest {
  if (!isRecord(value)) throw new Error("Model discovery request must be an object");
  const providerName = requiredTrimmedString(value, "providerName");
  const provider = requiredRecord(value, "provider");
  return {
    providerName,
    provider: { ...provider, baseUrl: requiredTrimmedString(provider, "baseUrl") },
  };
}

function invalidLimitsError(error: ModelRateLimitValidationError | undefined): ModelsConfigServiceError {
  if (error === undefined) return new ModelsConfigServiceError("MODELS_CONFIG_INVALID_LIMITS", "models.json has invalid rate limits");
  return new ModelsConfigServiceError(
    "MODELS_CONFIG_INVALID_LIMITS",
    modelRateLimitFieldMessage(error.field, error.reason),
    {
      provider: error.provider,
      modelId: error.modelId,
      field: error.field,
      reason: error.reason,
      occurrence: error.occurrence,
    },
  );
}

function narrowRefreshFailure(error: string | undefined, document: ModelsConfigDocument): string | undefined {
  if (error === undefined || error === "") return undefined;
  const providerKeys = new Set(Object.keys(document.providers ?? {}));
  for (const line of error.split("\n")) {
    const trimmed = line.trim();
    if (MODEL_CONFIGURATION_ERROR_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return trimmed;
    const match = /^Provider "([^"]+)":/u.exec(trimmed);
    if (match !== null && providerKeys.has(match[1] ?? "")) return trimmed;
  }
  return undefined;
}

async function writeModelsJsonAtomically(modelsPath: string, document: ModelsConfigDocument): Promise<void> {
  await mkdir(dirname(modelsPath), { recursive: true });
  const targetPath = await resolveModelsWriteTarget(modelsPath);
  await mkdir(dirname(targetPath), { recursive: true });

  const existing = await statIfExists(targetPath);
  if (existing !== undefined && existing.nlink > 1) {
    throw new Error("models.json has multiple hard links; refusing to replace one directory entry");
  }
  const mode = process.platform === "win32" || existing === undefined ? undefined : existing.mode & 0o7777;
  const temporaryPath = join(dirname(targetPath), `${basename(targetPath)}.${String(process.pid)}.${randomUUID()}.tmp`);

  let handle: FileHandle | undefined;
  try {
    handle = mode === undefined ? await open(temporaryPath, "w") : await open(temporaryPath, "w", mode);
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function resolveModelsWriteTarget(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return await resolveMissingModelsWriteTarget(filePath);
  }
}

/**
 * Mirrors `resolveMissingWriteTarget` in `src/server/storage/projectStore.ts`.
 * A missing leaf may itself be a dangling symlink, so walk `lstat`/`readlink`
 * until an existing component is reached and return the physical target path
 * instead of the link path. Otherwise the later `rename` would replace the
 * link rather than write through it.
 */
async function resolveMissingModelsWriteTarget(filePath: string): Promise<string> {
  let candidate = filePath;
  const visited = new Set<string>();

  for (;;) {
    let metadata: Stats;
    try {
      metadata = await lstat(candidate);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      if (candidate.endsWith(sep) || candidate.endsWith("/")) {
        throw new Error(`models.json path must resolve to a file: ${filePath}`, { cause: error });
      }
      const physicalParent = await realpath(dirname(candidate));
      return join(physicalParent, basename(candidate));
    }

    if (!metadata.isSymbolicLink()) return await realpath(candidate);

    const physicalParent = await realpath(dirname(candidate));
    const physicalCandidate = join(physicalParent, basename(candidate));
    if (visited.has(physicalCandidate)) {
      throw new Error("Cannot resolve models.json write target because of a symbolic-link cycle");
    }
    visited.add(physicalCandidate);

    const target = await readlink(physicalCandidate);
    // Preserve component order until the filesystem has traversed any symlink
    // before `..`; path.join/resolve would collapse those components too soon.
    candidate = isAbsolute(target) ? target : `${physicalParent}${physicalParent.endsWith(sep) ? "" : sep}${target}`;
  }
}

async function statIfExists(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function runModelConnectionTest(
  completeSimple: ModelCompletionFunction,
  model: NonNullable<ReturnType<ModelConnectionRuntime["getModel"]>>,
  apiKey: string,
  headers: Record<string, string | null> | undefined,
): Promise<ModelConnectionTestResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(); }, MODEL_CONNECTION_TEST_TIMEOUT_MS);
  const startedAt = Date.now();
  let status: number | undefined;

  try {
    const message = await completeSimple(model, {
      messages: [{
        role: "user",
        content: "Reply with OK only.",
        timestamp: Date.now(),
      }],
    }, {
      apiKey,
      ...(headers === undefined ? {} : { headers }),
      maxTokens: 16,
      timeoutMs: MODEL_CONNECTION_TEST_TIMEOUT_MS,
      maxRetries: 0,
      cacheRetention: "none",
      signal: controller.signal,
      onResponse: (response) => { status = response.status; },
    });
    const latencyMs = Date.now() - startedAt;

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return {
        ok: false,
        error: message.errorMessage ?? (controller.signal.aborted ? "Test timed out" : "Model returned an error"),
        latencyMs,
        ...(status === undefined ? {} : { status }),
      };
    }

    return {
      ok: true,
      latencyMs,
      ...(status === undefined ? {} : { status }),
      responseText: assistantText(message.content),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function modelsDocumentForConnectionTest(request: ModelConnectionTestRequest): ModelsConfigDocument {
  return {
    providers: {
      [request.providerName]: {
        ...request.provider,
        models: [{ ...request.model, id: request.model.id.trim() }],
      },
    },
  };
}

function modelsDocumentForDiscovery(request: ModelDiscoveryRequest): ModelsConfigDocument {
  return { providers: { [request.providerName]: providerWithoutModels(request.provider) } };
}

function providerWithoutModels(provider: ModelsConfigProvider): ModelsConfigProvider {
  const result: ModelsConfigProvider = {};
  for (const [name, value] of Object.entries(provider)) {
    if (name !== "models") result[name] = value;
  }
  return result;
}

async function createConnectionRuntimeForProfile(options: { modelsPath: string; authPath: string }): Promise<ModelConnectionRuntime> {
  return await ModelRuntime.create({
    modelsPath: options.modelsPath,
    authPath: options.authPath,
    // Isolated checks resolve the profile's credentials but do not refresh
    // unrelated provider catalogs before issuing their request.
    allowModelNetwork: false,
  });
}

function modelDiscoveryEndpoint(baseUrl: string | undefined, api: string | undefined, apiKey: string | undefined): URL {
  if (baseUrl === undefined) throw new Error("baseUrl is required");
  const endpointPath = api === "anthropic-messages" ? "v1/models" : "models";
  const endpoint = new URL(endpointPath, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error("Provider base URL must use HTTP or HTTPS");
  if (api === "google-generative-ai") {
    if (apiKey === undefined || apiKey === "") throw new Error("No API key found for Google model discovery");
    endpoint.searchParams.set("key", apiKey);
  }
  return endpoint;
}

async function fetchModels(
  endpoint: URL,
  api: string | undefined,
  apiKey: string | undefined,
  configuredHeaders: Record<string, string | null> | undefined,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(); }, MODEL_DISCOVERY_TIMEOUT_MS);
  const suppressedHeaders = new Set<string>();
  const headers = new Headers({ accept: "application/json" });

  for (const [name, value] of Object.entries(configuredHeaders ?? {})) {
    if (value === null) {
      suppressedHeaders.add(name.toLowerCase());
      headers.delete(name);
    } else {
      headers.set(name, value);
    }
  }

  if (api === "google-generative-ai") {
    // Google accepts the resolved key in the query string above.
  } else if (api === "anthropic-messages") {
    setDefaultDiscoveryHeader(headers, suppressedHeaders, "x-api-key", apiKey);
    setDefaultDiscoveryHeader(headers, suppressedHeaders, "anthropic-version", "2023-06-01");
  } else {
    setDefaultDiscoveryHeader(headers, suppressedHeaders, "authorization", apiKey === undefined || apiKey === "" ? undefined : `Bearer ${apiKey}`);
  }

  try {
    return await fetch(endpoint, { headers, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Model discovery timed out", { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function setDefaultDiscoveryHeader(headers: Headers, suppressedHeaders: ReadonlySet<string>, name: string, value: string | undefined): void {
  if (value === undefined || headers.has(name) || suppressedHeaders.has(name.toLowerCase())) return;
  headers.set(name, value);
}

function parseDiscoveredModels(value: unknown, api: string | undefined): ModelDiscoveryModel[] {
  const entries = modelDiscoveryEntries(value);
  const models: ModelDiscoveryModel[] = [];
  const knownIds = new Set<string>();

  for (const entry of entries) {
    const model = parseDiscoveredModel(entry, api);
    if (model === undefined || knownIds.has(model.id)) continue;
    knownIds.add(model.id);
    models.push(model);
  }
  return models;
}

function modelDiscoveryEntries(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) throw new Error("Model discovery response must be an object or array");
  const data = value["data"];
  if (Array.isArray(data)) return data;
  const models = value["models"];
  if (Array.isArray(models)) return models;
  throw new Error("Model discovery response did not contain a model list");
}

function parseDiscoveredModel(value: unknown, api: string | undefined): ModelDiscoveryModel | undefined {
  if (typeof value === "string") return discoveredModel(value);
  if (!isRecord(value)) return undefined;

  const rawId = typeof value["id"] === "string" ? value["id"] : value["name"];
  if (typeof rawId !== "string") return undefined;
  const id = api === "google-generative-ai" ? rawId.replace(/^models\//u, "") : rawId;
  const name = firstString(value["displayName"], value["display_name"], typeof value["id"] === "string" ? value["name"] : undefined);
  return discoveredModel(id, name);
}

function discoveredModel(id: string, name?: string): ModelDiscoveryModel | undefined {
  const trimmedId = id.trim();
  if (trimmedId === "") return undefined;
  const trimmedName = name?.trim();
  return trimmedName === undefined || trimmedName === "" || trimmedName === trimmedId
    ? { id: trimmedId }
    : { id: trimmedId, name: trimmedName };
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function assistantText(content: readonly unknown[]): string {
  return content
    .filter(isTextContent)
    .map((block) => block.text)
    .join("")
    .slice(0, 300);
}

function isTextContent(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value["type"] === "text" && typeof value["text"] === "string";
}

function requiredTrimmedString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function requiredRecord(record: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = record[field];
  if (!isRecord(value)) throw new Error(`${field} is required`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
