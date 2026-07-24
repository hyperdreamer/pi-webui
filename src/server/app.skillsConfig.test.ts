import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { SKILLS_OPERATION_PROXY_TIMEOUT_MS } from "../shared/federatedRoutes.js";
import { appTestContext, fakeRemoteClient, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();

const cwd = "/workspace/skills-project";
const encodedCwd = encodeURIComponent(cwd);
const toggle = { cwd, filePath: "/workspace/skills-project/.pi/skills/testing/SKILL.md", disableModelInvocation: true };
const search = { query: "testing", limit: 12 };
const install = { cwd, package: "owner/repo@testing", scope: "project" };
const update = { cwd, package: "owner/repo@testing", scope: "project" };

describe("buildApp Skills configuration routes", () => {
  it("forwards local Skills listing, toggling, discovery, installation, and updates to the session daemon", async () => {
    const list = await appTestContext.app.inject({ method: "GET", url: `/api/machines/local/skills?cwd=${encodedCwd}` });
    const toggled = await appTestContext.app.inject({ method: "PATCH", url: "/api/machines/local/skills", payload: toggle });
    const searched = await appTestContext.app.inject({ method: "POST", url: "/api/machines/local/skills/search", payload: search });
    const installed = await appTestContext.app.inject({ method: "POST", url: "/api/machines/local/skills/install", payload: install });
    const checked = await appTestContext.app.inject({ method: "POST", url: "/api/machines/local/skills/check", payload: update });
    const updated = await appTestContext.app.inject({ method: "POST", url: "/api/machines/local/skills/update", payload: update });

    expect([list.statusCode, toggled.statusCode, searched.statusCode, installed.statusCode, checked.statusCode, updated.statusCode]).toEqual([200, 200, 200, 200, 200, 200]);
    expect(appTestContext.sessionDaemonRequests).toEqual([
      { method: "GET", path: `/skills?cwd=${encodedCwd}` },
      { method: "PATCH", path: "/skills", body: toggle },
      { method: "POST", path: "/skills/search", body: search },
      { method: "POST", path: "/skills/install", body: install },
      { method: "POST", path: "/skills/check", body: update },
      { method: "POST", path: "/skills/update", body: update },
    ]);
  });

  it("proxies the allowlisted Skills routes to a remote machine", async () => {
    const added = await appTestContext.app.inject({
      method: "POST",
      url: "/api/machines",
      payload: { name: "Remote", baseUrl: "https://remote.example.test/" },
    });
    const remote = added.json<{ id: string }>();
    const request = vi.fn((method: string, path: string, body: unknown) => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ method, path, body })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const list = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/skills?cwd=${encodedCwd}` });
    const toggled = await appTestContext.app.inject({ method: "PATCH", url: `/api/machines/${remote.id}/skills`, payload: toggle });
    const searched = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/skills/search`, payload: search });
    const installed = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/skills/install`, payload: install });
    const checked = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/skills/check`, payload: update });
    const updated = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/skills/update`, payload: update });

    expect([list.statusCode, toggled.statusCode, searched.statusCode, installed.statusCode, checked.statusCode, updated.statusCode]).toEqual([200, 200, 200, 200, 200, 200]);
    expect(SKILLS_OPERATION_PROXY_TIMEOUT_MS).toBe(5 * 60_000);
    expect(request).toHaveBeenNthCalledWith(1, "GET", `/api/skills?cwd=${encodedCwd}`, undefined);
    expect(request).toHaveBeenNthCalledWith(2, "PATCH", "/api/skills", toggle);
    expect(request).toHaveBeenNthCalledWith(3, "POST", "/api/skills/search", search, { timeoutMs: SKILLS_OPERATION_PROXY_TIMEOUT_MS });
    expect(request).toHaveBeenNthCalledWith(4, "POST", "/api/skills/install", install, { timeoutMs: SKILLS_OPERATION_PROXY_TIMEOUT_MS });
    expect(request).toHaveBeenNthCalledWith(5, "POST", "/api/skills/check", update, { timeoutMs: SKILLS_OPERATION_PROXY_TIMEOUT_MS });
    expect(request).toHaveBeenNthCalledWith(6, "POST", "/api/skills/update", update, { timeoutMs: SKILLS_OPERATION_PROXY_TIMEOUT_MS });
  });
});
