import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelsConfigErrorCode } from "../../shared/apiTypes";
import { ModelsConfigServiceError } from "./modelsConfigService";
import { registerModelsConfigRoutes, type ModelsConfigRouteService } from "./modelsConfigRoutes";

let app: FastifyInstance;

beforeEach(() => {
  app = Fastify({ logger: false });
});

afterEach(async () => {
  await app.close();
});

function routeService(overrides: Partial<ModelsConfigRouteService> = {}): ModelsConfigRouteService {
  return {
    read: vi.fn().mockResolvedValue({ providers: {} }),
    readLimitsStatus: vi.fn().mockReturnValue({ contractVersion: 1, revision: 0, admission: "ready", source: "none" }),
    save: vi.fn().mockResolvedValue({ success: true, contractVersion: 1, revision: 1 }),
    test: vi.fn().mockResolvedValue({ ok: true, latencyMs: 5 }),
    discover: vi.fn().mockResolvedValue({ models: [] }),
    ...overrides,
  };
}

describe("models-config routes", () => {
  it("returns a bare document on read and the additive save response", async () => {
    const document = { providers: { acme: { models: [{ id: "demo", tpm: 10 }] } } };
    registerModelsConfigRoutes(app, routeService({ read: vi.fn().mockResolvedValue(document) }));

    const read = await app.inject({ method: "GET", url: "/models-config" });
    const save = await app.inject({ method: "PUT", url: "/models-config", payload: { providers: {} } });

    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(document);
    expect(save.statusCode).toBe(200);
    expect(save.json()).toEqual({ success: true, contractVersion: 1, revision: 1 });
  });

  it("returns the limits sidecar shape including an optional error", async () => {
    registerModelsConfigRoutes(app, routeService({
      readLimitsStatus: vi.fn().mockReturnValue({ contractVersion: 1, revision: 2, admission: "blocked", source: "none", error: "bad file" }),
    }));

    const response = await app.inject({ method: "GET", url: "/models-config/limits" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ contractVersion: 1, revision: 2, admission: "blocked", source: "none", error: "bad file" });
  });

  it.each<{ code: ModelsConfigErrorCode; status: number }>([
    { code: "MODELS_CONFIG_PARSE_FAILED", status: 422 },
    { code: "MODELS_CONFIG_IO_FAILED", status: 500 },
    { code: "MODELS_CONFIG_SAVE_INVALID", status: 400 },
    { code: "MODELS_CONFIG_INVALID_LIMITS", status: 400 },
    { code: "MODELS_CONFIG_UNREADABLE", status: 409 },
    { code: "MODELS_CONFIG_PERSIST_FAILED", status: 500 },
    { code: "MODELS_CONFIG_REFRESH_FAILED", status: 502 },
    { code: "MODELS_CONFIG_INTERNAL", status: 500 },
  ])("maps $code to HTTP $status with structured fields", async ({ code, status }) => {
    const error = new ModelsConfigServiceError(code, `message for ${code}`, {
      provider: "acme",
      modelId: "demo",
      field: "tpm",
      reason: "negative",
      occurrence: 0,
      ...(code === "MODELS_CONFIG_REFRESH_FAILED" ? { persisted: true } : {}),
    });
    registerModelsConfigRoutes(app, routeService({ save: vi.fn().mockRejectedValue(error) }));

    const response = await app.inject({ method: "PUT", url: "/models-config", payload: { providers: {} } });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({
      error: `message for ${code}`,
      code,
      file: "models.json",
      provider: "acme",
      modelId: "demo",
      field: "tpm",
      reason: "negative",
      occurrence: 0,
      ...(code === "MODELS_CONFIG_REFRESH_FAILED" ? { persisted: true } : {}),
    });
  });

  it("maps an unexpected failure to MODELS_CONFIG_INTERNAL", async () => {
    registerModelsConfigRoutes(app, routeService({ read: vi.fn().mockRejectedValue(new Error("boom")) }));

    const response = await app.inject({ method: "GET", url: "/models-config" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Models configuration operation failed.", code: "MODELS_CONFIG_INTERNAL", file: "models.json" });
  });

  it("keeps the connection test and discovery response shapes unchanged", async () => {
    registerModelsConfigRoutes(app, routeService({
      test: vi.fn().mockResolvedValue({ ok: false, error: "no key", latencyMs: 12, status: 401 }),
      discover: vi.fn().mockResolvedValue({ models: [{ id: "gpt-test", name: "GPT Test" }] }),
    }));

    const testResponse = await app.inject({ method: "POST", url: "/models-config/test", payload: {} });
    const discoverResponse = await app.inject({ method: "POST", url: "/models-config/discover", payload: {} });

    expect(testResponse.statusCode).toBe(400);
    expect(testResponse.json()).toEqual({ ok: false, error: "no key", latencyMs: 12, status: 401 });
    expect(discoverResponse.statusCode).toBe(200);
    expect(discoverResponse.json()).toEqual({ models: [{ id: "gpt-test", name: "GPT Test" }] });
  });
});
