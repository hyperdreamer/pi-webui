import { writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { RemoteMachineRequestError, type MachineClient } from "./machines/machineClient.js";
import { REMOTE_HTTP_ROUTES } from "./machines/machineProxyRoutes.js";
import { SESSION_REORDER_SESSION_ID_MAX_LENGTH, type PiWebUiConfigResponse } from "../shared/apiTypes.js";
import { PI_PACKAGE_MUTATION_PROXY_TIMEOUT_MS, PI_PACKAGE_PLUGINS_OPERATION_PROXY_TIMEOUT_MS, SESSION_TREE_NAVIGATION_PROXY_TIMEOUT_MS, FEDERATED_HTTP_ROUTES } from "../shared/federatedRoutes.js";
import { WORKSPACE_TASKS_MOVE_BODY_LIMIT_BYTES, WORKSPACE_TASKS_REPLACE_BODY_LIMIT_BYTES } from "../shared/workspaceTasksApi.js";
import { appTestContext, fakeRemoteClient, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();

// `expect.any` is typed `any` by vitest; the matcher is asserted at the assertion site.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const REPLY_OWNED_SIGNAL = expect.objectContaining({ signal: expect.any(AbortSignal) });

const documentPolicy = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' http: https:; style-src 'unsafe-inline' http: https:; img-src http: https: data: blob:; font-src http: https: data:; media-src http: https: data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; object-src 'none'";

const TASK_ROUTE_SPECS = [
  { method: "GET", path: "/projects/:projectId/workspaces/:workspaceId/workspace-tasks" },
  { method: "PUT", path: "/projects/:projectId/workspaces/:workspaceId/workspace-tasks" },
  { method: "POST", path: "/projects/:projectId/workspaces/:workspaceId/workspace-tasks/move" },
  { method: "GET", path: "/workspace-tasks/global" },
  { method: "PUT", path: "/workspace-tasks/global" },
];

const EMPTY_TASK_CATALOG = { version: 1 as const, tasks: [] };
const REPLACE_TASKS_REQUEST = { expectedRevision: "catalog-revision", config: EMPTY_TASK_CATALOG };
const MOVE_TASKS_REQUEST = {
  operationId: "00000000-0000-4000-8000-000000000001",
  intent: "start" as const,
  source: {
    ref: { scope: "workspace" as const, id: "build" },
    expectedCatalog: {
      kind: "loaded" as const,
      revision: "workspace-revision",
      config: {
        version: 1 as const,
        tasks: [{ id: "build", title: "Build", command: "npm run build", confirm: false }],
      },
    },
  },
  destination: {
    scope: "global" as const,
    expectedCatalog: { kind: "loaded" as const, revision: "global-revision", config: EMPTY_TASK_CATALOG },
    task: { id: "build", title: "Build", command: "npm run build", confirm: false },
  },
};

const pinBody = {
  id: "s 1",
  path: "/repo/session.jsonl",
  cwd: "/repo",
  created: "2026-10-22T00:00:00.000Z",
  modified: "2026-10-22T00:00:00.000Z",
  messageCount: 0,
  firstMessage: "",
  pinned: true,
};
const unpinBody = { ...pinBody, pinned: false };
const forceCleanupBody = {
  generatedAt: "2026-10-22T00:00:00.000Z",
  thresholds: {},
  projects: [],
  totals: { archiveCount: 0, deleteCount: 0 },
  archivedSessionIds: [],
  deletedSessionIds: [],
};
const usageInput = { projectPath: "/repo", liveCwds: ["/repo", "/repo-feature"] };
const zeroUsage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sessionCount: 0,
};
const liveUsage = {
  input: 4, output: 8, cacheRead: 0, cacheWrite: 0, cost: 0.25, sessionCount: 2,
};
const usageBody = {
  projectPath: "/repo",
  buckets: { live: liveUsage, retired: zeroUsage, archived: zeroUsage },
  total: liveUsage,
  generatedAt: "2026-10-22T00:00:00.000Z",
};
const usageCountBody = { sessionCount: 2 };
const missingRemoteRouteBody = { error: "API route not found" };

interface RemoteSessionProxyCase {
  readonly name: string;
  readonly gatewayPath: string;
  readonly payload?: object;
  readonly remotePath: string;
  readonly remoteBody: unknown;
  readonly targetStatus: number;
  readonly targetBody: unknown;
}

const REMOTE_SESSION_PROXY_CASES: readonly RemoteSessionProxyCase[] = [
  {
    name: "pin",
    gatewayPath: "/sessions/s%201/pin",
    payload: { cwd: "/repo" },
    remotePath: "/api/sessions/s%201/pin",
    remoteBody: { cwd: "/repo" },
    targetStatus: 200,
    targetBody: pinBody,
  },
  {
    name: "unpin",
    gatewayPath: "/sessions/s%201/unpin",
    payload: { cwd: "/repo" },
    remotePath: "/api/sessions/s%201/unpin",
    remoteBody: { cwd: "/repo" },
    targetStatus: 200,
    targetBody: unpinBody,
  },
  {
    name: "force cleanup",
    gatewayPath: "/sessions/cleanup/force",
    remotePath: "/api/sessions/cleanup/force",
    remoteBody: undefined,
    targetStatus: 200,
    targetBody: forceCleanupBody,
  },
  {
    name: "project usage",
    gatewayPath: "/sessions/project-usage",
    payload: usageInput,
    remotePath: "/api/sessions/project-usage",
    remoteBody: usageInput,
    targetStatus: 200,
    targetBody: usageBody,
  },
  {
    name: "project usage count",
    gatewayPath: "/sessions/project-usage/count",
    payload: usageInput,
    remotePath: "/api/sessions/project-usage/count",
    remoteBody: usageInput,
    targetStatus: 200,
    targetBody: usageCountBody,
  },
  {
    name: "pin missing from an older remote",
    gatewayPath: "/sessions/s%201/pin",
    payload: { cwd: "/repo" },
    remotePath: "/api/sessions/s%201/pin",
    remoteBody: { cwd: "/repo" },
    targetStatus: 404,
    targetBody: missingRemoteRouteBody,
  },
];

describe("buildApp remote machine proxy routes", () => {
  it("registers task handlers ahead of the generic proxy and translates encoded task paths", async () => {
    expect(FEDERATED_HTTP_ROUTES).toEqual(expect.arrayContaining(TASK_ROUTE_SPECS));
    expect(REMOTE_HTTP_ROUTES).not.toEqual(expect.arrayContaining(TASK_ROUTE_SPECS));

    const machineId = "machine / id";
    await writeRemoteMachine(machineId);
    const request = vi.fn<MachineClient["request"]>((method, path, body) => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ method, path, body })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const workspacePath = "/api/projects/project%20%2F%20id/workspaces/workspace%20%3F%20id/workspace-tasks";
    const gatewayPrefix = "/api/machines/machine%20%2F%20id";
    const responses = [
      await appTestContext.app.inject({ method: "GET", url: `${gatewayPrefix}/projects/project%20%2F%20id/workspaces/workspace%20%3F%20id/workspace-tasks` }),
      await appTestContext.app.inject({ method: "PUT", url: `${gatewayPrefix}/projects/project%20%2F%20id/workspaces/workspace%20%3F%20id/workspace-tasks`, payload: REPLACE_TASKS_REQUEST }),
      await appTestContext.app.inject({ method: "POST", url: `${gatewayPrefix}/projects/project%20%2F%20id/workspaces/workspace%20%3F%20id/workspace-tasks/move`, payload: MOVE_TASKS_REQUEST }),
      await appTestContext.app.inject({ method: "GET", url: `${gatewayPrefix}/workspace-tasks/global` }),
      await appTestContext.app.inject({ method: "PUT", url: `${gatewayPrefix}/workspace-tasks/global`, payload: REPLACE_TASKS_REQUEST }),
    ];

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect(request).toHaveBeenNthCalledWith(1, "GET", workspacePath, undefined, REPLY_OWNED_SIGNAL);
    expect(request).toHaveBeenNthCalledWith(2, "PUT", workspacePath, REPLACE_TASKS_REQUEST);
    expect(request).toHaveBeenNthCalledWith(3, "POST", `${workspacePath}/move`, MOVE_TASKS_REQUEST);
    expect(request).toHaveBeenNthCalledWith(4, "GET", "/api/workspace-tasks/global", undefined, REPLY_OWNED_SIGNAL);
    expect(request).toHaveBeenNthCalledWith(5, "PUT", "/api/workspace-tasks/global", REPLACE_TASKS_REQUEST);
    expect(request).toHaveBeenCalledTimes(5);
    expect(appTestContext.piWebUiConfig).toEqual({});
  });

  it("rejects an invalid portable task mutation before contacting the selected machine", async () => {
    const request = vi.fn<MachineClient["request"]>();
    const machineId = await addRemoteMachine(request);

    const response = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/machines/${machineId}/workspace-tasks/global`,
      payload: { ...REPLACE_TASKS_REQUEST, unexpected: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ kind: "validation" });
    expect(request).not.toHaveBeenCalled();
    expect(appTestContext.piWebUiConfig).toEqual({});
  });

  it.each([400, 409, 500, 503])("forwards target task status %s, body, and safe headers", async (statusCode) => {
    const targetBody = statusCode === 500
      ? { kind: "unknown-outcome", message: "Target task write outcome is unknown." }
      : { kind: "target-error", statusCode };
    const request = vi.fn<MachineClient["request"]>(() => Promise.resolve({
      statusCode,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "set-cookie": "remote-secret=1",
      },
      body: Readable.from([JSON.stringify(targetBody)]),
    }));
    const machineId = await addRemoteMachine(request);

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${machineId}/workspace-tasks/global` });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual(targetBody);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(request).toHaveBeenCalledWith("GET", "/api/workspace-tasks/global", undefined, REPLY_OWNED_SIGNAL);
  });

  it("permits a portable move between the replace and move body caps", async () => {
    const request = vi.fn<MachineClient["request"]>(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ forwarded: true })]),
    }));
    const machineId = await addRemoteMachine(request);
    const move = moveRequestBetweenBodyCaps();
    const byteLength = Buffer.byteLength(JSON.stringify(move), "utf8");

    expect(byteLength).toBeGreaterThan(WORKSPACE_TASKS_REPLACE_BODY_LIMIT_BYTES);
    expect(byteLength).toBeLessThan(WORKSPACE_TASKS_MOVE_BODY_LIMIT_BYTES);

    const response = await appTestContext.app.inject({
      method: "POST",
      url: `/api/machines/${machineId}/projects/project-1/workspaces/workspace-1/workspace-tasks/move`,
      payload: move,
    });

    expect(response.statusCode).toBe(200);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("maps both gateway and explicit local task body caps to typed 413 responses", async () => {
    const request = vi.fn<MachineClient["request"]>();
    const machineId = await addRemoteMachine(request);
    const oversized = {
      expectedRevision: "r".repeat(WORKSPACE_TASKS_REPLACE_BODY_LIMIT_BYTES),
      config: EMPTY_TASK_CATALOG,
    };
    const oversizedMove = {
      ...MOVE_TASKS_REQUEST,
      source: {
        ...MOVE_TASKS_REQUEST.source,
        expectedCatalog: {
          ...MOVE_TASKS_REQUEST.source.expectedCatalog,
          revision: "r".repeat(WORKSPACE_TASKS_MOVE_BODY_LIMIT_BYTES),
        },
      },
    };

    const gatewayResponse = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/machines/${machineId}/workspace-tasks/global`,
      payload: oversized,
    });
    const localResponse = await appTestContext.app.inject({
      method: "PUT",
      url: "/api/machines/local/workspace-tasks/global",
      payload: oversized,
    });
    const moveResponse = await appTestContext.app.inject({
      method: "POST",
      url: `/api/machines/${machineId}/projects/project-1/workspaces/workspace-1/workspace-tasks/move`,
      payload: oversizedMove,
    });

    expect(gatewayResponse.statusCode).toBe(413);
    expect(gatewayResponse.json()).toMatchObject({ kind: "validation" });
    expect(localResponse.statusCode).toBe(413);
    expect(localResponse.json()).toMatchObject({ kind: "validation" });
    expect(moveResponse.statusCode).toBe(413);
    expect(moveResponse.json()).toMatchObject({ kind: "validation" });
    expect(request).not.toHaveBeenCalled();
  });

  it("maps a remote task-move timeout to 504", async () => {
    const request = vi.fn<MachineClient["request"]>(() => Promise.reject(new RemoteMachineRequestError("timed out", 504)));
    const machineId = await addRemoteMachine(request);

    const response = await appTestContext.app.inject({
      method: "POST",
      url: `/api/machines/${machineId}/projects/project-1/workspaces/workspace-1/workspace-tasks/move`,
      payload: MOVE_TASKS_REQUEST,
    });

    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ error: "Remote machine timeout", machineId, statusCode: 504 });
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/api/projects/project-1/workspaces/workspace-1/workspace-tasks/move",
      MOVE_TASKS_REQUEST,
    );
  });

  it("returns 404 for an unknown remote machine without dispatching a task request", async () => {
    const request = vi.fn<MachineClient["request"]>();
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({ method: "GET", url: "/api/machines/missing/workspace-tasks/global" });

    expect(response.statusCode).toBe(404);
    expect(request).not.toHaveBeenCalled();
  });

  it("resolves the explicit local task alias locally instead of returning the generic proxy 501", async () => {
    const ordinary = await appTestContext.app.inject({ method: "GET", url: "/api/workspace-tasks/global" });
    const alias = await appTestContext.app.inject({ method: "GET", url: "/api/machines/local/workspace-tasks/global" });

    expect(ordinary.statusCode).toBe(200);
    expect(alias.statusCode).toBe(200);
    expect(alias.json()).toEqual(ordinary.json());
  });

  it("proxies allowlisted remote HTTP routes through the selected machine", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json", connection: "close" },
      body: Readable.from([JSON.stringify([{ id: "p1", name: "Remote Project", path: "/repo", createdAt: "now" }])]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/projects?active=true` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual([{ id: "p1", name: "Remote Project", path: "/repo", createdAt: "now" }]);
    expect(request).toHaveBeenCalledWith("GET", "/api/projects?active=true", undefined, REPLY_OWNED_SIGNAL);
  });

  it("preserves the force-refresh query when proxying update checks", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn<MachineClient["request"]>(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ ok: true })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/pi-webui/status?refresh=1` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith("GET", "/api/pi-webui/status?refresh=1", undefined, REPLY_OWNED_SIGNAL);
  });

  it("proxies remote Pi package routes and gives package mutations a longer timeout", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn<MachineClient["request"]>((method, path, body) => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ method, path, body })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const listResponse = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/pi-packages` });
    const installBody = { source: "npm:@acme/new-tools" };
    const installResponse = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/pi-packages/install`, payload: installBody });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual({ method: "GET", path: "/api/pi-packages" });
    expect(installResponse.statusCode).toBe(200);
    expect(installResponse.json()).toEqual({ method: "POST", path: "/api/pi-packages/install", body: installBody });
    expect(request).toHaveBeenNthCalledWith(1, "GET", "/api/pi-packages", undefined, REPLY_OWNED_SIGNAL);
    expect(request).toHaveBeenNthCalledWith(2, "POST", "/api/pi-packages/install", installBody, { timeoutMs: PI_PACKAGE_MUTATION_PROXY_TIMEOUT_MS });
  });

  it("proxies remote workspace package Plugins routes with a long package-operation timeout", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn<MachineClient["request"]>((method, path, body) => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ method, path, body })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const cwd = "/repo with spaces";
    const listResponse = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/package-plugins?cwd=${encodeURIComponent(cwd)}` });
    const mutation = { action: "install", source: "npm:@acme/tools", scope: "project", cwd };
    const mutationResponse = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/package-plugins`, payload: mutation });

    expect(listResponse.json()).toEqual({ method: "GET", path: `/api/package-plugins?cwd=${encodeURIComponent(cwd)}` });
    expect(mutationResponse.json()).toEqual({ method: "POST", path: "/api/package-plugins", body: mutation });
    expect(request).toHaveBeenNthCalledWith(1, "GET", `/api/package-plugins?cwd=${encodeURIComponent(cwd)}`, undefined, REPLY_OWNED_SIGNAL);
    expect(request).toHaveBeenNthCalledWith(2, "POST", "/api/package-plugins", mutation, { timeoutMs: PI_PACKAGE_PLUGINS_OPERATION_PROXY_TIMEOUT_MS });
  });

  it("forwards remote session tree navigation with the model-operation timeout", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn<MachineClient["request"]>((method, path, body) => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ method, path, body })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });
    const navigationBody = { cwd: "/repo", targetId: "entry-1", expectedLeafId: "leaf-1", summary: { mode: "default" } };

    const response = await appTestContext.app.inject({
      method: "POST",
      url: `/api/machines/${remote.id}/sessions/s1/tree/navigate`,
      payload: navigationBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ method: "POST", path: "/api/sessions/s1/tree/navigate", body: navigationBody });
    expect(request).toHaveBeenCalledWith("POST", "/api/sessions/s1/tree/navigate", navigationBody, { timeoutMs: SESSION_TREE_NAVIGATION_PROXY_TIMEOUT_MS });
  });

  it("proxies remote workspace effective upload config through the existing federated workspace route", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const remoteWorkspaces = [{
      id: "w1",
      projectId: "p1",
      path: "/repo",
      label: "main",
      isMain: true,
      isGitRepo: false,
      isGitWorktree: false,
      effectiveConfig: { uploads: { defaultFolder: "remote-project-uploads" } },
    }];
    const request = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify(remoteWorkspaces)]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/projects/p1/workspaces` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(remoteWorkspaces);
    expect(request).toHaveBeenCalledWith("GET", "/api/projects/p1/workspaces", undefined, REPLY_OWNED_SIGNAL);
  });

  it("preserves remote file preview security headers while proxying safe response metadata", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: {
        "content-type": "image/svg+xml",
        "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
        "set-cookie": "session=secret",
      },
      body: Readable.from(["<svg xmlns=\"http://www.w3.org/2000/svg\" />"]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/file/preview?path=${encodeURIComponent("diagram.svg")}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/svg+xml");
    expect(response.headers["content-security-policy"]).toContain("sandbox");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body).toBe("<svg xmlns=\"http://www.w3.org/2000/svg\" />");
    expect(request).toHaveBeenCalledWith("GET", "/api/projects/p1/workspaces/w1/file/preview?path=diagram.svg", undefined, REPLY_OWNED_SIGNAL);
  });

  it("forwards file view bytes and every required document header from a nonlocal machine", async () => {
    const request = vi.fn<MachineClient["request"]>(() => Promise.resolve({
      statusCode: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": documentPolicy,
        "set-cookie": "secret=blocked",
      },
      body: Readable.from([Buffer.from("<p>remote</p>")]),
    }));
    const machineId = await addRemoteMachine(request);

    const response = await appTestContext.app.inject({
      url: `/api/machines/${encodeURIComponent(machineId)}/projects/p%20%2F%3F/workspaces/w%20%3F%2F/file/view?path=dir%2Fa+%3F%23%25%2B.html`,
      headers: { range: "bytes=0-1", origin: "https://browser.example" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("<p>remote</p>");
    expect(response.headers["content-security-policy"]).toBe(documentPolicy);
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["content-length"]).toBeUndefined();
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(request.mock.calls[0]?.slice(0, 3)).toEqual(["GET", "/api/projects/p%20%2F%3F/workspaces/w%20%3F%2F/file/view?path=dir%2Fa+%3F%23%25%2B.html", undefined]);
    expect(request.mock.calls[0]?.[3]).toEqual(REPLY_OWNED_SIGNAL);
  });

  const fileViewFailures = [
    [400, "path query parameter is required"],
    [403, "PI WEBUI is not allowed to read this path. Add its root under Settings → General → External path access."],
    [404, "File not found: missing.html"],
    [413, "File is too large to preview (limit 64 MB)."],
    [415, "This file type cannot be previewed in PI WEBUI."],
    [500, "Unable to preview this file."],
  ] as const;

  it.each(fileViewFailures)("forwards the exact plain-text file view failure for %i", async (statusCode, body) => {
    const request = vi.fn<MachineClient["request"]>(() => Promise.resolve({
      statusCode,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "set-cookie": "secret=blocked",
      },
      body: Readable.from([body]),
    }));
    const machineId = await addRemoteMachine(request);

    const response = await appTestContext.app.inject({ url: `/api/machines/${machineId}/projects/p1/workspaces/w1/file/view?path=missing.html` });

    expect(response.statusCode).toBe(statusCode);
    expect(response.body).toBe(body);
    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["content-security-policy"]).toBeUndefined();
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("preserves an interrupted upstream file view as an interrupted downstream transfer", async () => {
    const source = new Readable({ read: () => { /* chunks are pushed by the test */ } });
    const request = vi.fn<MachineClient["request"]>(() => Promise.resolve({
      statusCode: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": documentPolicy,
      },
      body: source,
    }));
    const machineId = await addRemoteMachine(request);
    const baseUrl = await appTestContext.app.listen({ host: "127.0.0.1", port: 0 });
    const headers = deferred<http.IncomingHttpHeaders>();
    const firstData = deferred<undefined>();
    const observation = observeRemoteHttp(
      `${baseUrl}/api/machines/${machineId}/projects/p1/workspaces/w1/file/view?path=a.html`,
      {
        onHeaders: (incoming) => { headers.resolve(incoming.headers); },
        onData: () => { firstData.resolve(undefined); },
      },
    );
    // The data barrier may fail before the observation deadline does; absorb that
    // branch so a buffering regression is reported by the barrier, not as an
    // unhandled rejection.
    void observation.result.catch(() => undefined);
    source.push("<p>partial");
    try {
      const received = await headers.promise;
      expect(received["content-security-policy"]).toBe(documentPolicy);
      expect(received["referrer-policy"]).toBe("no-referrer");
      // Downstream evidence: a proxy that buffers the whole upstream body would
      // never deliver these bytes before the upstream fails.
      await withinDeadline(firstData.promise, "downstream partial file view body");

      source.destroy(new Error("upstream body failed"));

      const result = await observation.result;
      expect(result.status).toBe(200);
      expect(result.aborted).toBe(true);
      expect(result.ended).toBe(false);
      expect(result.bytes).toEqual(Buffer.from("<p>partial"));
    } finally {
      source.destroy();
    }
  });

  it("preserves allowedOrigins through remote selected-machine config reads and writes", async () => {
    const rows: { raw: string[]; expected: string[] }[] = [
      { raw: ["HTTPS://PI.EXAMPLE:443/"], expected: ["https://pi.example"] },
      { raw: [], expected: [] },
    ];
    for (const row of rows) {
      const getRequest = vi.fn<MachineClient["requestJson"]>(() => Promise.resolve({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: remoteMachineConfigResponseBody(row.expected),
      }));
      const machineId = await addRemoteMachine(vi.fn<MachineClient["request"]>());
      appTestContext.remoteClient = fakeRemoteClient({ requestJson: getRequest });

      const read = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${machineId}/config` });

      expect(read.statusCode).toBe(200);
      const readConfig = read.json<PiWebUiConfigResponse>();
      expect(readConfig.config.allowedOrigins).toEqual(row.expected);
      expect(readConfig.effectiveConfig.allowedOrigins).toEqual(row.expected);
      expect(getRequest).toHaveBeenCalledWith("GET", "/api/machines/local/config", undefined, REPLY_OWNED_SIGNAL);

      const putRequest = vi.fn<MachineClient["requestJson"]>(() => Promise.resolve({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: remoteMachineConfigResponseBody(row.expected),
      }));
      appTestContext.remoteClient = fakeRemoteClient({ requestJson: putRequest });

      const write = await appTestContext.app.inject({ method: "PUT", url: `/api/machines/${machineId}/config`, payload: { config: { allowedOrigins: row.raw } } });

      expect(write.statusCode).toBe(200);
      const writtenConfig = write.json<PiWebUiConfigResponse>();
      expect(writtenConfig.config.allowedOrigins).toEqual(row.expected);
      expect(writtenConfig.effectiveConfig.allowedOrigins).toEqual(row.expected);
      expect(putRequest).toHaveBeenCalledWith("PUT", "/api/machines/local/config", { config: { allowedOrigins: row.expected } });
    }

    const malformed = remoteMachineConfigResponseBody([]);
    malformed.effectiveConfig = { allowedOrigins: ["null"] };
    const malformedRequest = vi.fn<MachineClient["requestJson"]>(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: malformed,
    }));
    const malformedMachine = await addRemoteMachine(vi.fn<MachineClient["request"]>());
    appTestContext.remoteClient = fakeRemoteClient({ requestJson: malformedRequest });

    const malformedRead = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${malformedMachine}/config` });

    expect(malformedRead.statusCode).toBe(502);
    expect(malformedRead.json()).toMatchObject({ error: "Remote machine unavailable" });
    expect(malformedRead.body).toContain("Remote machine config response");
  });

  it("keeps file view gateway failures in the JSON envelope", async () => {
    const missing = await appTestContext.app.inject({ url: "/api/machines/missing/projects/p1/workspaces/w1/file/view?path=a.html" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "Machine not found" });

    const offlineId = await addRemoteMachine(vi.fn<MachineClient["request"]>(() => Promise.reject(new RemoteMachineRequestError("connection refused", 502))));
    const offline = await appTestContext.app.inject({ url: `/api/machines/${offlineId}/projects/p1/workspaces/w1/file/view?path=a.html` });
    expect(offline.statusCode).toBe(502);
    expect(offline.json()).toEqual({ error: "Remote machine unavailable", machineId: offlineId, statusCode: 502, detail: "connection refused" });

    const timeoutId = await addRemoteMachine(vi.fn<MachineClient["request"]>(() => Promise.reject(new RemoteMachineRequestError("timed out", 504))));
    const timeout = await appTestContext.app.inject({ url: `/api/machines/${timeoutId}/projects/p1/workspaces/w1/file/view?path=a.html` });
    expect(timeout.statusCode).toBe(504);
    expect(timeout.json()).toEqual({ error: "Remote machine timeout", machineId: timeoutId, statusCode: 504, detail: "timed out" });
  });

  it("proxies remote workspace file writes as raw request bodies", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const request = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ path: "image.png", size: payload.length, modifiedAt: "now", created: true })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({
      method: "PUT",
      url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/file?path=${encodeURIComponent("image.png")}`,
      payload,
      headers: { "content-type": "application/octet-stream" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ path: "image.png", size: payload.length, modifiedAt: "now", created: true });
    expect(request).toHaveBeenCalledWith("PUT", "/api/projects/p1/workspaces/w1/file?path=image.png", payload, { contentType: "application/octet-stream" });
  });

  it("proxies remote terminal command-run and continue routes", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn((method: string, path: string) => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ method, path })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const createBody = { origin: "core", title: "Build", command: "npm test", metadata: { "pi.operation": "test" } };
    const deleteWorkspaceResponse = await appTestContext.app.inject({ method: "DELETE", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1` });
    const createResponse = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/terminal-command-runs`, payload: createBody });
    const listResponse = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/terminal-command-runs?projectId=p1&statuses=running` });
    const getResponse = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/terminal-command-runs/run1` });
    const cancelResponse = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/terminal-command-runs/run1/cancel` });
    const closeWorkspaceTerminalsResponse = await appTestContext.app.inject({ method: "DELETE", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/terminals` });
    const continueResponse = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/projects/p1/workspaces/w1/terminals/t1/continue` });

    expect(deleteWorkspaceResponse.json()).toEqual({ method: "DELETE", path: "/api/projects/p1/workspaces/w1" });
    expect(createResponse.json()).toEqual({ method: "POST", path: "/api/projects/p1/workspaces/w1/terminal-command-runs" });
    expect(listResponse.json()).toEqual({ method: "GET", path: "/api/terminal-command-runs?projectId=p1&statuses=running" });
    expect(getResponse.json()).toEqual({ method: "GET", path: "/api/terminal-command-runs/run1" });
    expect(cancelResponse.json()).toEqual({ method: "POST", path: "/api/terminal-command-runs/run1/cancel" });
    expect(closeWorkspaceTerminalsResponse.json()).toEqual({ method: "DELETE", path: "/api/projects/p1/workspaces/w1/terminals" });
    expect(continueResponse.json()).toEqual({ method: "POST", path: "/api/projects/p1/workspaces/w1/terminals/t1/continue" });
    expect(request).toHaveBeenCalledWith("POST", "/api/projects/p1/workspaces/w1/terminal-command-runs", createBody);
  });

  it("proxies remote session reloads through the selected machine", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ reloaded: true })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/sessions/s1/reload`, payload: { cwd: "/repo" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ reloaded: true });
    expect(request).toHaveBeenCalledWith("POST", "/api/sessions/s1/reload", { cwd: "/repo" });
  });

  it("proxies remote session reorder bodies through the selected machine", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/machines",
      payload: { name: "Remote", baseUrl: "https://remote.example.test/" },
    });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn<MachineClient["request"]>((method, path, body) => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ method, path, body })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });
    const body = {
      cwd: "/repo",
      scope: { kind: "root", cwd: "/repo" },
      pinned: false,
      catalogCwds: ["/repo"],
      orderedSessions: [
        { id: "s-2", cwd: "/repo" },
        { id: "s-1", cwd: "/repo" },
      ],
    };

    const response = await appTestContext.app.inject({
      method: "POST",
      url: `/api/machines/${remote.id}/sessions/s-1/reorder`,
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/api/sessions/s-1/reorder",
      body,
    );
  });

  it("proxies a maximum-length remote reorder session ID through the app router", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/machines",
      payload: { name: "Remote", baseUrl: "https://remote.example.test/" },
    });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn<MachineClient["request"]>((method, path, body) => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ method, path, body })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });
    const sessionId = "x".repeat(SESSION_REORDER_SESSION_ID_MAX_LENGTH);
    const body = {
      cwd: "/repo",
      scope: { kind: "root", cwd: "/repo" },
      pinned: false,
      catalogCwds: ["/repo"],
      orderedSessions: [{ id: sessionId, cwd: "/repo" }],
    };

    const response = await appTestContext.app.inject({
      method: "POST",
      url: `/api/machines/${remote.id}/sessions/${sessionId}/reorder`,
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(request).toHaveBeenCalledWith(
      "POST",
      `/api/sessions/${sessionId}/reorder`,
      body,
    );
  });

  it.each(REMOTE_SESSION_PROXY_CASES)("forwards the $name route to the selected machine", async (proxyCase) => {
    const request = vi.fn<MachineClient["request"]>(() => Promise.resolve({
      statusCode: proxyCase.targetStatus,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify(proxyCase.targetBody)]),
    }));
    const machineId = await addRemoteMachine(request);
    const url = `/api/machines/${machineId}${proxyCase.gatewayPath}`;

    const response = await appTestContext.app.inject({
      method: "POST",
      url,
      ...(proxyCase.payload === undefined ? {} : { payload: proxyCase.payload }),
    });

    expect(response.statusCode).toBe(proxyCase.targetStatus);
    expect(response.json()).toEqual(proxyCase.targetBody);
    expect(response.body).toBe(JSON.stringify(proxyCase.targetBody));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("POST", proxyCase.remotePath, proxyCase.remoteBody);
    expect(appTestContext.sessionDaemonRequests).toHaveLength(0);
  });

  it("returns 404 for an unknown machine on the registered pin route without contacting a remote", async () => {
    const request = vi.fn<MachineClient["request"]>();
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({
      method: "POST",
      url: "/api/machines/missing/sessions/s%201/pin",
      payload: { cwd: "/repo" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Machine not found" });
    expect(request).not.toHaveBeenCalled();
    expect(appTestContext.sessionDaemonRequests).toHaveLength(0);
  });

  it("maps a remote pin transport failure to 502 without reaching the local daemon", async () => {
    const request = vi.fn<MachineClient["request"]>(() => Promise.reject(new RemoteMachineRequestError("connection refused", 502)));
    const machineId = await addRemoteMachine(request);

    const response = await appTestContext.app.inject({
      method: "POST",
      url: `/api/machines/${machineId}/sessions/s%201/pin`,
      payload: { cwd: "/repo" },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: "Remote machine unavailable",
      machineId,
      statusCode: 502,
      detail: "connection refused",
    });
    expect(request).toHaveBeenCalledWith("POST", "/api/sessions/s%201/pin", { cwd: "/repo" });
    expect(appTestContext.sessionDaemonRequests).toHaveLength(0);
  });

  it("proxies only the four allowlisted remote notification HTTP routes", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn<MachineClient["request"]>((method, path, body) => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ method, path, body })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const catalog = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/sessions/notifications` });
    const inbox = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/sessions/${encodeURIComponent("s 1")}/notifications?cwd=${encodeURIComponent("/repo one")}` });
    const dismissBody = { cwd: "/repo one", daemonInstanceId: "daemon-test", notificationId: "notice-1" };
    const dismiss = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/sessions/${encodeURIComponent("s 1")}/notifications/dismiss`, payload: dismissBody });
    const dismissAllBody = { cwd: "/repo one", daemonInstanceId: "daemon-test", throughOrder: 7, throughOverflowWatermark: 2 };
    const dismissAll = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/sessions/${encodeURIComponent("s 1")}/notifications/dismiss-all`, payload: dismissAllBody });
    const wrongMethod = await appTestContext.app.inject({ method: "DELETE", url: `/api/machines/${remote.id}/sessions/s1/notifications` });

    expect([catalog.statusCode, inbox.statusCode, dismiss.statusCode, dismissAll.statusCode]).toEqual([200, 200, 200, 200]);
    expect(wrongMethod.statusCode).toBe(404);
    expect(request).toHaveBeenNthCalledWith(1, "GET", "/api/sessions/notifications", undefined, REPLY_OWNED_SIGNAL);
    expect(request).toHaveBeenNthCalledWith(2, "GET", "/api/sessions/s%201/notifications?cwd=%2Frepo%20one", undefined, REPLY_OWNED_SIGNAL);
    expect(request).toHaveBeenNthCalledWith(3, "POST", "/api/sessions/s%201/notifications/dismiss", dismissBody);
    expect(request).toHaveBeenNthCalledWith(4, "POST", "/api/sessions/s%201/notifications/dismiss-all", dismissAllBody);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("proxies remote session queue clearing through the allowlisted route", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const status = { sessionId: "s1", pendingMessageCount: 0, queuedMessages: [] };
    const request = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify(status)]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/sessions/s1/queue/clear`, payload: { cwd: "/repo" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(status);
    expect(request).toHaveBeenCalledWith("POST", "/api/sessions/s1/queue/clear", { cwd: "/repo" });
  });

  it("allowlists and proxies the models-config limits sidecar exactly once", async () => {
    expect(FEDERATED_HTTP_ROUTES.filter((route) => route.path === "/models-config/limits")).toEqual([
      { method: "GET", path: "/models-config/limits" },
    ]);
    expect(REMOTE_HTTP_ROUTES).toContainEqual({ method: "GET", path: "/models-config/limits" });

    const status = { contractVersion: 1, revision: 2, admission: "blocked", source: "none", error: "bad file" };
    const request = vi.fn<MachineClient["request"]>(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify(status)]),
    }));
    const machineId = await addRemoteMachine(request);

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${machineId}/models-config/limits` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(status);
    expect(request).toHaveBeenCalledWith("GET", "/api/models-config/limits", undefined, REPLY_OWNED_SIGNAL);
  });

  it("forwards remote JSON request bodies and normalizes remote timeouts", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn(() => Promise.reject(new RemoteMachineRequestError("timed out", 504)));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/sessions/s1/prompt`, payload: { text: "hello" } });

    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ error: "Remote machine timeout", machineId: remote.id, statusCode: 504 });
    expect(request).toHaveBeenCalledWith("POST", "/api/sessions/s1/prompt", { text: "hello" });
  });
});

function moveRequestBetweenBodyCaps() {
  const description = "x".repeat(300_000);
  return {
    ...MOVE_TASKS_REQUEST,
    source: {
      ...MOVE_TASKS_REQUEST.source,
      expectedCatalog: {
        ...MOVE_TASKS_REQUEST.source.expectedCatalog,
        config: {
          version: 1 as const,
          tasks: [{
            id: "build",
            title: "Build",
            command: "npm run build",
            description,
            confirm: false,
          }],
        },
      },
    },
    destination: {
      ...MOVE_TASKS_REQUEST.destination,
      expectedCatalog: {
        ...MOVE_TASKS_REQUEST.destination.expectedCatalog,
        config: {
          version: 1 as const,
          tasks: [{
            id: "existing",
            title: "Existing",
            command: "npm run existing",
            description,
            confirm: false,
          }],
        },
      },
    },
  };
}

async function addRemoteMachine(request: MachineClient["request"]): Promise<string> {
  const addResponse = await appTestContext.app.inject({
    method: "POST",
    url: "/api/machines",
    payload: { name: "Remote", baseUrl: "https://remote.example.test/" },
  });
  const remote = addResponse.json<{ id: string }>();
  appTestContext.remoteClient = fakeRemoteClient({ request });
  return remote.id;
}

async function writeRemoteMachine(machineId: string): Promise<void> {
  await writeFile(join(appTestContext.tempDir, "machines.json"), JSON.stringify({
    machines: [{
      id: machineId,
      name: "Encoded remote",
      kind: "remote",
      baseUrl: "https://remote.example.test",
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:00:00.000Z",
    }],
  }), "utf8");
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function withinDeadline<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`${description} deadline`)); }, 2_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function remoteMachineConfigResponseBody(allowedOrigins: string[]): PiWebUiConfigResponse {
  const config = { allowedOrigins, maxUploadBytes: 1024 };
  return {
    path: "/home/remote/.config/pi-webui/config.json",
    exists: true,
    config,
    effectiveConfig: config,
    envOverrides: {
      host: false,
      port: false,
      allowedHosts: false,
      spawnSessions: false,
      subsessions: false,
      agentCommand: false,
      agentDir: false,
      agentSessionDir: false,
      sessiondUrl: false,
    },
  };
}

interface ObservedRemoteResponse {
  ended: boolean;
  aborted: boolean;
  bytes: Buffer;
  headers: http.IncomingHttpHeaders;
  status: number;
}

interface RemoteHttpObservationCallbacks {
  onHeaders?: (response: http.IncomingMessage) => void;
  onData?: (chunk: Buffer) => void;
}

/** Real HTTP observation so an interrupted upstream transfer can be seen as an
 * incomplete downstream response, which inject() cannot represent. */
function observeRemoteHttp(url: string, callbacks: RemoteHttpObservationCallbacks = {}) {
  let request: http.ClientRequest | undefined;
  const result = new Promise<ObservedRemoteResponse>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let response: http.IncomingMessage | undefined;
    const finish = (ended: boolean, aborted: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ ended, aborted, bytes: Buffer.concat(chunks), headers: response?.headers ?? {}, status: response?.statusCode ?? 0 });
    };
    const deadline = setTimeout(() => {
      request?.destroy();
      reject(new Error("HTTP observation deadline"));
    }, 3_000);
    request = http.get(url, (incoming) => {
      response = incoming;
      callbacks.onHeaders?.(incoming);
      incoming.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        callbacks.onData?.(chunk);
      });
      incoming.once("end", () => { finish(true, false); });
      incoming.once("aborted", () => { finish(false, true); });
      incoming.once("error", () => { finish(false, true); });
    });
    request.on("error", () => { finish(false, true); });
  });
  return { result, destroy: () => { request?.destroy(); } };
}
