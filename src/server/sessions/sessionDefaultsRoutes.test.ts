import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSessionDefaultsRoutes, type SessionDefaultsRouteService } from "./sessionDefaultsRoutes.js";

let app: FastifyInstance;
let service: SessionDefaultsRouteService;
let read: ReturnType<typeof vi.fn<SessionDefaultsRouteService["read"]>>;
let update: ReturnType<typeof vi.fn<SessionDefaultsRouteService["update"]>>;

const defaults = {
  model: { provider: "openai", id: "gpt-default" },
  thinkingLevel: "high",
  models: [{ provider: "openai", id: "gpt-default" }],
  thinkingLevels: ["off", "low", "high"],
};

beforeEach(async () => {
  read = vi.fn<SessionDefaultsRouteService["read"]>(() => Promise.resolve(defaults));
  update = vi.fn<SessionDefaultsRouteService["update"]>(() => Promise.resolve(defaults));
  service = { read, update };
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
});
