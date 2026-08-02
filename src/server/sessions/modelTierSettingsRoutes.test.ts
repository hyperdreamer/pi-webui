import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { ModelTierLadder, ModelTierSettingsResponse } from "../../shared/apiTypes";
import { FEDERATED_HTTP_ROUTES } from "../../shared/federatedRoutes";
import type { ModelTierSettingsRouteService } from "./modelTierSettingsRoutes";
import { registerModelTierSettingsRoutes } from "./modelTierSettingsRoutes";

let app: FastifyInstance;
let service: ModelTierSettingsRouteService;
let inspectMock: MockInstance<() => Promise<ModelTierSettingsResponse>>;
let replaceMock: MockInstance<(ladder: ModelTierLadder) => Promise<ModelTierSettingsResponse>>;

beforeEach(() => {
  app = Fastify({ logger: false });
  service = {
    inspect: () => Promise.resolve(snapshot()),
    replace: (ladder) => Promise.resolve(snapshot({ ladder })),
  };
  inspectMock = vi.spyOn(service, "inspect");
  replaceMock = vi.spyOn(service, "replace");
  registerModelTierSettingsRoutes(app, service);
});

afterEach(async () => {
  await app.close();
});

describe("model tier settings routes", () => {
  it("returns the service snapshot unchanged from GET", async () => {
    const expected = snapshot();
    inspectMock.mockResolvedValueOnce(expected);

    const response = await app.inject({ method: "GET", url: "/model-tiers" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected);
    expect(inspectMock).toHaveBeenCalledOnce();
  });

  it("accepts one complete ladder, replaces it, and returns the confirmed snapshot", async () => {
    const ladder = completeLadder();
    const confirmed = snapshot({ ladder });
    replaceMock.mockResolvedValueOnce(confirmed);

    const response = await app.inject({
      method: "PUT",
      url: "/model-tiers",
      payload: { ladder },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(confirmed);
    expect(replaceMock).toHaveBeenCalledExactlyOnceWith(ladder);
  });

  for (const invalidCase of invalidRequestCases()) {
    it(`rejects ${invalidCase.name} with an actionable 400 error`, async () => {
      const response = await app.inject({ method: "PUT", url: "/model-tiers", payload: invalidCase.body });

      expect(response.statusCode).toBe(400);
      const responseBody = response.json<{ error: string }>();
      expect(responseBody.error).toMatch(invalidCase.message);
      expect(replaceMock).not.toHaveBeenCalled();
    });
  }

  it("maps runtime and configuration validation failures to 400 without reporting success", async () => {
    replaceMock.mockRejectedValueOnce(new Error("tier frontier names unavailable model acme/ghost"));

    const response = await app.inject({
      method: "PUT",
      url: "/model-tiers",
      payload: { ladder: completeLadder() },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "tier frontier names unavailable model acme/ghost" });
    expect(response.json()).not.toHaveProperty("valid");
  });

  it("advertises both remote model-tier methods while leaving other routes unlisted", () => {
    expect(FEDERATED_HTTP_ROUTES.filter((route) => route.path === "/model-tiers")).toEqual([
      { method: "GET", path: "/model-tiers" },
      { method: "PUT", path: "/model-tiers" },
    ]);
    expect(FEDERATED_HTTP_ROUTES).not.toContainEqual({ method: "GET", path: "/model-tier-debug" });
  });
});

interface InvalidRequestCase {
  name: string;
  body: Record<string, unknown>;
  message: RegExp;
}

function invalidRequestCases(): InvalidRequestCase[] {
  return [
    {
      name: "malformed ladder",
      body: { ladder: "not a ladder" },
      message: /must be an object/u,
    },
    {
      name: "partial ladder",
      body: { ladder: { economy: completeLadder().economy } },
      message: /missing fast/u,
    },
    {
      name: "unknown tier",
      body: { ladder: { ...completeLadder(), bonus: completeLadder().economy } },
      message: /unknown tier/u,
    },
    {
      name: "unknown ladder field",
      body: { ladder: { ...completeLadder(), economy: { ...completeLadder().economy, label: "not allowed" } } },
      message: /unknown key/u,
    },
    {
      name: "unknown request field",
      body: { ladder: completeLadder(), extra: true },
      message: /unknown field/u,
    },
  ];
}

function completeLadder(): ModelTierLadder {
  return {
    economy: { model: { provider: "acme", id: "small" }, thinkingLevel: "low" },
    fast: { model: { provider: "acme", id: "small" }, thinkingLevel: "medium" },
    standard: { model: { provider: "acme", id: "large" }, thinkingLevel: "medium" },
    advanced: { model: { provider: "acme", id: "large" }, thinkingLevel: "high" },
    capable: { model: { provider: "acme", id: "large" }, thinkingLevel: "xhigh" },
    frontier: { model: { provider: "acme", id: "large" }, thinkingLevel: "max" },
  };
}

function snapshot(overrides: Partial<ModelTierSettingsResponse> = {}): ModelTierSettingsResponse {
  return {
    contractVersion: 1,
    models: [],
    rows: {
      economy: { valid: true },
      fast: { valid: true },
      standard: { valid: true },
      advanced: { valid: true },
      capable: { valid: true },
      frontier: { valid: true },
    },
    valid: true,
    ...overrides,
  };
}
