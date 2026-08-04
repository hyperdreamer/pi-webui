import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDefaultsV2Response } from "../../shared/apiTypes.js";
import { registerSessionDefaultsRoutes, type SessionDefaultsRouteService } from "./sessionDefaultsRoutes.js";

let app: FastifyInstance;
let service: SessionDefaultsRouteService;
let read: ReturnType<typeof vi.fn<SessionDefaultsRouteService["read"]>>;
let readV2: ReturnType<typeof vi.fn<SessionDefaultsRouteService["readV2"]>>;
let update: ReturnType<typeof vi.fn<SessionDefaultsRouteService["update"]>>;

const defaults = {
  model: { provider: "openai", id: "gpt-default" },
  thinkingLevel: "high",
  models: [{ provider: "openai", id: "gpt-default" }],
  thinkingLevels: ["off", "low", "high"],
};

const v2Defaults: SessionDefaultsV2Response = {
  ...defaults,
  starterModelPolicyContractVersion: 2,
  starterModelPolicyPreference: {
    mode: "exact",
    exact: {
      model: { provider: "openai", id: "gpt-default" },
      thinkingLevel: "high",
    },
  },
};

beforeEach(async () => {
  read = vi.fn<SessionDefaultsRouteService["read"]>(() => Promise.resolve(defaults));
  readV2 = vi.fn<SessionDefaultsRouteService["readV2"]>(() => Promise.resolve(v2Defaults));
  update = vi.fn<SessionDefaultsRouteService["update"]>(() => Promise.resolve(defaults));
  service = { read, readV2, update };
  app = Fastify({ logger: false });
  registerSessionDefaultsRoutes(app, service);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("session defaults routes", () => {
  it("reads defaults for the requested workspace", async () => {
    const response = await app.inject({ method: "GET", url: `/session-defaults?cwd=${encodeURIComponent("/repo one")}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(defaults);
    expect(read).toHaveBeenCalledWith("/repo one");
    expect(readV2).not.toHaveBeenCalled();
  });

  it("reads version-two defaults only for contract selector 2", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/session-defaults?cwd=%2Frepo%20one&starterModelPolicyContract=2",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(v2Defaults);
    expect(readV2).toHaveBeenCalledWith("/repo one");
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty selector", "starterModelPolicyContract="],
    ["version one", "starterModelPolicyContract=1"],
    ["an unknown version", "starterModelPolicyContract=3"],
    ["duplicate version-two selectors", "starterModelPolicyContract=2&starterModelPolicyContract=2"],
    ["conflicting selectors", "starterModelPolicyContract=2&starterModelPolicyContract=3"],
  ])("rejects %s before invoking either read method", async (_label, selector) => {
    const response = await app.inject({
      method: "GET",
      url: `/session-defaults?cwd=%2Frepo%20one&${selector}`,
    });

    expect(response.statusCode).toBe(400);
    expect(read).not.toHaveBeenCalled();
    expect(readV2).not.toHaveBeenCalled();
  });

  it("updates a model default without a session id", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/session-defaults",
      payload: { cwd: "/repo one", model: { provider: "openai", modelId: "gpt-next" } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(defaults);
    expect(update).toHaveBeenCalledWith("/repo one", { model: { provider: "openai", modelId: "gpt-next" } });
  });

  it.each([
    ["Exact", { mode: "exact", tier: "fast" }],
    ["Tiered", { mode: "tiered", tier: "advanced" }],
  ] as const)("updates a complete %s starter preference", async (_label, preference) => {
    const response = await app.inject({
      method: "PUT",
      url: "/session-defaults",
      payload: { cwd: "/repo one", starterModelPolicyPreference: preference },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(defaults);
    expect(update).toHaveBeenCalledWith("/repo one", {
      starterModelPolicyPreference: preference,
    });
  });

  it("rejects incomplete model choices before invoking the service", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/session-defaults",
      payload: { cwd: "/repo one", model: { provider: "openai" } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("modelId");
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects invalid thinking levels before invoking the service", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/session-defaults",
      payload: { cwd: "/repo one", thinkingLevel: "unbounded" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("thinkingLevel");
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    ["an incomplete Tiered preference", { cwd: "/repo", starterModelPolicyPreference: { mode: "tiered" } }],
    ["an unknown preference mode", { cwd: "/repo", starterModelPolicyPreference: { mode: "automatic", tier: "standard" } }],
    ["an unknown preference tier", { cwd: "/repo", starterModelPolicyPreference: { mode: "exact", tier: "unknown" } }],
    ["an unknown preference field", { cwd: "/repo", starterModelPolicyPreference: { mode: "exact", future: true } }],
    ["a mixed Exact and preference update", { cwd: "/repo", thinkingLevel: "low", starterModelPolicyPreference: { mode: "exact" } }],
    ["an unknown top-level field", { cwd: "/repo", unknown: true }],
  ])("rejects %s before invoking the service", async (_label, payload) => {
    const response = await app.inject({
      method: "PUT",
      url: "/session-defaults",
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
});
