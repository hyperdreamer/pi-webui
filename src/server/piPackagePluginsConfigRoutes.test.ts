import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiPackagePluginsConfigService } from "./piPackagePluginsConfigService.js";
import { registerPiPackagePluginsConfigRoutes } from "./piPackagePluginsConfigRoutes.js";

let app: FastifyInstance;
let service: PiPackagePluginsConfigService;
let list: ReturnType<typeof vi.fn>;
let mutate: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const response = { packages: [], totals: { extensions: 0, skills: 0, prompts: 0, themes: 0 }, diagnostics: [] };
  const nextList = vi.fn<PiPackagePluginsConfigService["list"]>(() => Promise.resolve(response));
  const nextMutate = vi.fn<PiPackagePluginsConfigService["mutate"]>(() => Promise.resolve(response));
  list = nextList;
  mutate = nextMutate;
  service = { list: nextList, mutate: nextMutate };
  app = Fastify({ logger: false });
  registerPiPackagePluginsConfigRoutes(app, service);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("registerPiPackagePluginsConfigRoutes", () => {
  it("reads workspace package plugins and sends each source action to the service", async () => {
    const listed = await app.inject({ method: "GET", url: "/api/package-plugins?cwd=%2Frepo%20one" });
    const changed = await app.inject({
      method: "POST",
      url: "/api/package-plugins",
      payload: { action: "disable", source: "npm:@acme/tools", scope: "global", cwd: "/repo one" },
    });

    expect([listed.statusCode, changed.statusCode]).toEqual([200, 200]);
    expect(list).toHaveBeenCalledWith("/repo one");
    expect(mutate).toHaveBeenCalledWith({
      action: "disable",
      source: "npm:@acme/tools",
      scope: "global",
      cwd: "/repo one",
    });
  });

  it("rejects malformed workspace and action requests before calling the service", async () => {
    const missingCwd = await app.inject({ method: "GET", url: "/api/package-plugins" });
    const invalidAction = await app.inject({
      method: "POST",
      url: "/api/package-plugins",
      payload: { action: "publish", cwd: "/repo" },
    });

    expect(missingCwd.statusCode).toBe(400);
    expect(missingCwd.json()).toEqual({ error: "cwd is required" });
    expect(invalidAction.statusCode).toBe(400);
    expect(invalidAction.json()).toEqual({ error: "Unsupported Pi package plugin action: publish" });
    expect(list).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });
});
