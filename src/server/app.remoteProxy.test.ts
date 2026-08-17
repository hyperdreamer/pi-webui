import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { RemoteMachineRequestError, type MachineClient } from "./machines/machineClient.js";
import { REMOTE_HTTP_ROUTES } from "./machines/machineProxyRoutes.js";
import { SESSION_REORDER_SESSION_ID_MAX_LENGTH } from "../shared/apiTypes.js";
import { PI_PACKAGE_MUTATION_PROXY_TIMEOUT_MS, PI_PACKAGE_PLUGINS_OPERATION_PROXY_TIMEOUT_MS, SESSION_TREE_NAVIGATION_PROXY_TIMEOUT_MS, FEDERATED_HTTP_ROUTES } from "../shared/federatedRoutes.js";
import { WORKSPACE_TASKS_MOVE_BODY_LIMIT_BYTES, WORKSPACE_TASKS_REPLACE_BODY_LIMIT_BYTES } from "../shared/workspaceTasksApi.js";
import { appTestContext, fakeRemoteClient, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();

const TASK_ROUTE_SPECS = [
  { method: "GET", path: "/projects/:projectId/workspaces/:workspaceId/workspace-tasks" },
  { method: "PUT", path: "/projects/:projectId/workspaces/:workspaceId/workspace-tasks" },
  { method: "POST", path: "/projects/:projectId/workspaces/:workspaceId/workspace-tasks/move", timeoutMs: 30_000 },
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
    expect(request).toHaveBeenNthCalledWith(1, "GET", workspacePath, undefined);
    expect(request).toHaveBeenNthCalledWith(2, "PUT", workspacePath, REPLACE_TASKS_REQUEST);
    expect(request).toHaveBeenNthCalledWith(3, "POST", `${workspacePath}/move`, MOVE_TASKS_REQUEST, { timeoutMs: 30_000 });
    expect(request).toHaveBeenNthCalledWith(4, "GET", "/api/workspace-tasks/global", undefined);
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
    expect(request).toHaveBeenCalledWith("GET", "/api/workspace-tasks/global", undefined);
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

  it("uses the move-only 30 second timeout and maps a remote timeout to 504", async () => {
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
      { timeoutMs: 30_000 },
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
    expect(request).toHaveBeenCalledWith("GET", "/api/projects?active=true", undefined);
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
    expect(request).toHaveBeenCalledWith("GET", "/api/pi-webui/status?refresh=1", undefined);
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
    expect(request).toHaveBeenNthCalledWith(1, "GET", "/api/pi-packages", undefined);
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
    expect(request).toHaveBeenNthCalledWith(1, "GET", `/api/package-plugins?cwd=${encodeURIComponent(cwd)}`, undefined);
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
    expect(request).toHaveBeenCalledWith("GET", "/api/projects/p1/workspaces", undefined);
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
    expect(request).toHaveBeenCalledWith("GET", "/api/projects/p1/workspaces/w1/file/preview?path=diagram.svg", undefined);
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
    expect(request).toHaveBeenNthCalledWith(1, "GET", "/api/sessions/notifications", undefined);
    expect(request).toHaveBeenNthCalledWith(2, "GET", "/api/sessions/s%201/notifications?cwd=%2Frepo%20one", undefined);
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
