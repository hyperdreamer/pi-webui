import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelConnectionTestRequest, ModelConnectionTestResponse, ModelDiscoveryModel, ModelDiscoveryRequest, ModelDiscoveryResponse, ModelsConfigDocument, ModelsConfigProvider, ModelsConfigSaveResponse } from "../../shared/apiTypes.js";

const MODEL_CONNECTION_TEST_TIMEOUT_MS = 20_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 20_000;

type ModelConnectionRuntime = Pick<ModelRuntime, "getError" | "getModel" | "getAuth" | "completeSimple">;
type ModelConnectionRuntimeFactory = (options: { modelsPath: string; authPath: string }) => Promise<ModelConnectionRuntime>;
type ModelsReloadRuntime = Pick<ModelRuntime, "refresh">;

export interface ModelsConfigServiceDependencies {
  agentDir: string;
  /** The daemon's shared runtime, refreshed from models.json after a successful save. */
  modelRuntime?: ModelsReloadRuntime;
  createConnectionRuntime?: ModelConnectionRuntimeFactory;
}

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

  constructor({ agentDir, modelRuntime, createConnectionRuntime = createConnectionRuntimeForProfile }: ModelsConfigServiceDependencies) {
    this.modelsPath = join(agentDir, "models.json");
    this.authPath = join(agentDir, "auth.json");
    this.modelRuntime = modelRuntime;
    this.createConnectionRuntime = createConnectionRuntime;
  }

  async read(): Promise<ModelsConfigDocument> {
    try {
      return normalizeModelsConfigDocument(JSON.parse(await readFile(this.modelsPath, "utf8")));
    } catch (error) {
      if (isMissingFile(error) || error instanceof SyntaxError) return emptyModelsConfigDocument();
      throw error;
    }
  }

  async save(value: unknown): Promise<ModelsConfigSaveResponse> {
    const document = parseModelsConfigDocument(value);
    await mkdir(dirname(this.modelsPath), { recursive: true });
    await writeFile(this.modelsPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await this.modelRuntime?.refresh({ allowNetwork: false });
    return { success: true };
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

      return await runModelConnectionTest(runtime, model, resolved.auth.apiKey, resolved.auth.headers);
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
}

export function emptyModelsConfigDocument(): ModelsConfigDocument {
  return { providers: {} };
}

export function normalizeModelsConfigDocument(value: unknown): ModelsConfigDocument {
  if (!isRecord(value)) return emptyModelsConfigDocument();
  const providers = value["providers"];
  if (providers !== undefined && !isRecord(providers)) return { ...value, providers: {} };
  return { ...value, ...(providers === undefined ? { providers: {} } : {}) };
}

export function parseModelsConfigDocument(value: unknown): ModelsConfigDocument {
  if (!isRecord(value)) throw new Error("models.json must be a JSON object");
  const providers = value["providers"];
  if (providers !== undefined && !isRecord(providers)) throw new Error("models.json providers must be an object");
  return { ...value };
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

async function runModelConnectionTest(
  runtime: ModelConnectionRuntime,
  model: NonNullable<ReturnType<ModelConnectionRuntime["getModel"]>>,
  apiKey: string,
  headers: Record<string, string | null> | undefined,
): Promise<ModelConnectionTestResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(); }, MODEL_CONNECTION_TEST_TIMEOUT_MS);
  const startedAt = Date.now();
  let status: number | undefined;

  try {
    const message = await runtime.completeSimple(model, {
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
