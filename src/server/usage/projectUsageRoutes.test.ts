import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerProjectUsageRoutes } from "./projectUsageRoutes";
import type { ProjectUsageResponse } from "../../shared/apiTypes.js";

function report(): ProjectUsageResponse {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sessionCount: 0 };
  return {
    projectPath: "/dev/app",
    buckets: { live: { ...zero, input: 5, sessionCount: 1 }, retired: zero, archived: zero },
    total: { ...zero, input: 5, sessionCount: 1 },
    generatedAt: "2026-08-05T00:00:00.000Z",
  };
}

interface TestProjectUsageReporter {
  report(scope: { projectPath: string; liveCwds: readonly string[] }): Promise<ProjectUsageResponse>;
  count(scope: { projectPath: string; liveCwds: readonly string[] }): Promise<number>;
}

async function appWith(usage: Pick<TestProjectUsageReporter, "report"> & Partial<Pick<TestProjectUsageReporter, "count">>) {
  const app = Fastify();
  registerProjectUsageRoutes(app, {
    count: () => Promise.resolve(0),
    ...usage,
  });
  await app.ready();
  return app;
}

describe("registerProjectUsageRoutes", () => {
  it("returns the report for a valid scope", async () => {
    const app = await appWith({ report: () => Promise.resolve(report()) });
    const response = await app.inject({ method: "POST", url: "/sessions/project-usage", payload: { projectPath: "/dev/app", liveCwds: ["/dev/app"] } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(report());
    await app.close();
  });

  it("passes the requested scope through", async () => {
    const reportFn = vi.fn(() => Promise.resolve(report()));
    const app = await appWith({ report: reportFn });
    await app.inject({ method: "POST", url: "/sessions/project-usage", payload: { projectPath: "/dev/app", liveCwds: ["/dev/app", "/dev/app/.worktrees/x"] } });

    expect(reportFn).toHaveBeenCalledWith({ projectPath: "/dev/app", liveCwds: ["/dev/app", "/dev/app/.worktrees/x"] });
    await app.close();
  });

  it("returns the count for a valid scope", async () => {
    const count = vi.fn(() => Promise.resolve(3));
    const app = await appWith({ report: () => Promise.resolve(report()), count });
    const response = await app.inject({ method: "POST", url: "/sessions/project-usage/count", payload: { projectPath: "/dev/app", liveCwds: ["/dev/app"] } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sessionCount: 3 });
    expect(count).toHaveBeenCalledWith({ projectPath: "/dev/app", liveCwds: ["/dev/app"] });
    await app.close();
  });

  it.each([
    ["projectPath", { projectPath: "", liveCwds: [] }, { error: "projectPath is required" }],
    ["liveCwds", { projectPath: "/dev/app", liveCwds: "nope" }, { error: "liveCwds must be an array of strings" }],
  ])("rejects an invalid %s for the count route with the existing 400 shape", async (_field, payload, expected) => {
    const app = await appWith({ report: () => Promise.resolve(report()) });
    const response = await app.inject({ method: "POST", url: "/sessions/project-usage/count", payload });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(expected);
    await app.close();
  });

  it("rejects a missing projectPath with 400", async () => {
    const app = await appWith({ report: () => Promise.resolve(report()) });
    const response = await app.inject({ method: "POST", url: "/sessions/project-usage", payload: { liveCwds: [] } });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a non-array liveCwds with 400", async () => {
    const app = await appWith({ report: () => Promise.resolve(report()) });
    const response = await app.inject({ method: "POST", url: "/sessions/project-usage", payload: { projectPath: "/dev/app", liveCwds: "nope" } });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("defaults liveCwds to an empty list when omitted", async () => {
    const reportFn = vi.fn(() => Promise.resolve(report()));
    const app = await appWith({ report: reportFn });
    const response = await app.inject({ method: "POST", url: "/sessions/project-usage", payload: { projectPath: "/dev/app" } });

    expect(response.statusCode).toBe(200);
    expect(reportFn).toHaveBeenCalledWith({ projectPath: "/dev/app", liveCwds: [] });
    await app.close();
  });

  it("maps a service failure to 500", async () => {
    const app = await appWith({ report: () => Promise.reject(new Error("scan blew up")) });
    const response = await app.inject({ method: "POST", url: "/sessions/project-usage", payload: { projectPath: "/dev/app", liveCwds: [] } });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: "scan blew up" });
    await app.close();
  });
});
