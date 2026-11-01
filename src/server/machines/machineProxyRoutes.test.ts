import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Machine, PiWebUiConfigResponse } from "../../shared/apiTypes.js";
import {
  FEDERATED_HTTP_ROUTES,
  PI_PACKAGE_MUTATION_PROXY_TIMEOUT_MS,
  PI_PACKAGE_PLUGINS_OPERATION_PROXY_TIMEOUT_MS,
  SESSION_TREE_NAVIGATION_PROXY_TIMEOUT_MS,
  SKILLS_OPERATION_PROXY_TIMEOUT_MS,
  WORKSPACE_TASKS_FEDERATED_HTTP_ROUTES,
  type FederatedHttpRouteSpec,
} from "../../shared/federatedRoutes.js";
import { proxySessionDaemonRequest, type SessionProxyDaemon } from "../sessiond/sessionProxyRoutes.js";
import { registerMachineRoutes } from "./machineRoutes.js";
import { RemoteMachineClient, type MachineClient, type MachineJsonResponse, type MachineRequestOptions } from "./machineClient.js";
import { proxyMachineHttpRequest, registerMachineProxyRoutes } from "./machineProxyRoutes.js";
import { MachineService } from "./machineService.js";
import { MachineStore } from "./machineStore.js";

const REMOTE_MACHINE_ID = "remote-lab";
const SESSIONS_URL = `/api/machines/${REMOTE_MACHINE_ID}/sessions?cwd=%2Frepo`;

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

describe("machine proxy selected-machine config route", () => {
  it("preserves sessiond and sessiondUrl across a remote config round-trip", async () => {
    const sessiond = { host: "0.0.0.0", port: 8810, url: "http://127.0.0.1:8810" };
    const upstream: PiWebUiConfigResponse = {
      path: "/home/remote/.config/pi-webui/config.json",
      exists: true,
      config: { host: "127.0.0.1", port: 8808, shortcuts: { "core:view.chat": "mod+1" }, sessiond, agent: { command: "agent-lab", dir: "/srv/agent-lab" } },
      effectiveConfig: { host: "127.0.0.1", port: 8808, shortcuts: { "core:view.chat": "mod+1" }, sessiond, agent: { command: "agent-lab", dir: "/srv/agent-lab" } },
      envOverrides: {
        host: false,
        port: false,
        allowedHosts: false,
        spawnSessions: false,
        subsessions: false,
        agentCommand: false,
        agentDir: false,
        agentSessionDir: false,
        sessiondUrl: true,
      },
    };
    const machines = new MachineService();
    vi.spyOn(machines, "get").mockResolvedValue(machineRecord());
    vi.spyOn(machines, "remoteClient").mockResolvedValue(fakeClient(upstream));
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    registerMachineProxyRoutes(app, machines);

    const response = await app.inject({ method: "GET", url: "/api/machines/remote-a/config" });

    expect(response.statusCode).toBe(200);
    const body = response.json<PiWebUiConfigResponse>();
    expect(body.config.sessiond).toEqual(sessiond);
    expect(body.effectiveConfig.sessiond).toEqual(sessiond);
    expect(body.envOverrides.sessiondUrl).toBe(true);
    expect(body.config).not.toHaveProperty("host");
    expect(body.config).not.toHaveProperty("port");
    expect(body.config).not.toHaveProperty("shortcuts");
  });
});

describe("machine proxy route budgets", () => {
  it("preserves meaningful route overrides and removes the workspace move override", async () => {
    const calls = await proxyEachRouteWithStoredTimeout(90_000);

    expect(calls["/skills/search"]?.timeoutMs).toBe(300_000);
    expect(calls["/skills/search"]?.timeoutMs).toBe(SKILLS_OPERATION_PROXY_TIMEOUT_MS);
    expect(calls["/package-plugins"]?.timeoutMs).toBe(PI_PACKAGE_PLUGINS_OPERATION_PROXY_TIMEOUT_MS);
    expect(calls["/pi-packages/install"]?.timeoutMs).toBe(PI_PACKAGE_MUTATION_PROXY_TIMEOUT_MS);
    expect(calls["/sessions/tree/navigate"]?.timeoutMs).toBe(SESSION_TREE_NAVIGATION_PROXY_TIMEOUT_MS);
    // The stored machine value reaches ordinary reads and the move route, which has
    // no operation override left.
    expect(calls["/projects"]?.timeoutMs).toBe(90_000);
    expect(calls["/workspace-tasks/move"]?.timeoutMs).toBe(90_000);
    // Only the GET read carries the reply-owned lifecycle signal.
    expect(calls["/config"]?.signal).toBeInstanceOf(AbortSignal);
    expect(calls["/config"]?.put?.signal).toBeUndefined();
    expect(calls["/skills/search"]?.signal).toBeUndefined();
    expect(calls["/workspace-tasks/move"]?.signal).toBeUndefined();
  });
});

describe("machine proxy remote read cancellation", () => {
  it("cancels an unfinished remote read when the downstream reply closes", async () => {
    const deferred = deferredRemoteGet();
    const harness = makeReplyHarness();

    const pending = invokeRemoteGet(deferred.client, harness.reply);
    await deferred.started.promise;
    expect(deferred.options()?.signal).toBeInstanceOf(AbortSignal);

    harness.raw.emit("close");
    deferred.abortPendingRead();

    await expect(pending).resolves.toBe(harness.reply);
    expect(deferred.options()?.signal?.aborted).toBe(true);
    expect(harness.writes).toEqual([]);
    expect(harness.raw.listenerCount("finish")).toBe(0);
    expect(harness.raw.listenerCount("close")).toBe(0);
  });

  it("cleans disconnect listeners for replies that never stream", async () => {
    await assertNoOwnedListenersAfterMissingMachine();
    await assertLookupFailureEscapesWithNoOwnedListeners();
    await assertNoOwnedListenersAfterRejectedFetch();
    await assertNoOwnedListenersAfterEmptyBody();
    await assertNoOwnedListenersAfterBufferedConfig();
    await assertNormalFinishDoesNotAbort();
  });

  it("cancels config GET buffering without cancelling config PUT", async () => {
    const getRead = deferredConfigJson();
    const getHarness = makeReplyHarness();
    const getPending = invokeRemoteGet(getRead.client, getHarness.reply, { url: `/api/machines/${REMOTE_MACHINE_ID}/config`, spec: routeSpec("GET", "/config") });
    await getRead.started.promise;

    getHarness.raw.emit("close");
    getRead.abortPendingRead();

    await expect(getPending).resolves.toBe(getHarness.reply);
    expect(getRead.options()?.signal?.aborted).toBe(true);
    expect(getHarness.writes).toEqual([]);

    const putWrite = deferredConfigJson();
    const putHarness = makeReplyHarness();
    const putPending = proxyMachineHttpRequest(
      proxyMachines(putWrite.client),
      routeSpec("PUT", "/config"),
      REMOTE_MACHINE_ID,
      "PUT",
      `/api/machines/${REMOTE_MACHINE_ID}/config`,
      { config: { maxUploadBytes: 1024 } },
      undefined,
      putHarness.reply,
    );
    await putWrite.started.promise;

    putHarness.raw.emit("close");
    expect(putWrite.options()?.signal).toBeUndefined();
    putWrite.resolve(configResponseBody());

    await expect(putPending).resolves.toBe(putHarness.reply);
    expect(putHarness.writes).toHaveLength(1);
    expect(putHarness.writes[0]?.statusCode).toBe(200);
  });

  it("propagates browser bow out through both gateways to the daemon transport", async () => {
    const receiving = makeReplyHarness();
    const daemonCalls: { body: unknown; signal: AbortSignal | undefined }[] = [];
    const daemon: SessionProxyDaemon = {
      request: (_method, _path, body, signal) => new Promise<never>((_resolve, reject) => {
        daemonCalls.push({ body, signal });
        if (signal === undefined) {
          reject(new Error("the receiving hop did not opt into cancellation"));
          return;
        }
        signal.addEventListener("abort", () => { reject(signalReason(signal)); }, { once: true });
      }),
      connectWebSocket: () => { throw new Error("WebSocket is not used by this test"); },
    };
    const receivingPending = proxySessionDaemonRequest(daemon, "/api", { method: "GET", url: "/sessions?cwd=%2Frepo" }, receiving.reply);

    const originFetch = deferredOriginFetch(() => { receiving.raw.emit("close"); });
    const origin = makeReplyHarness();
    const originPending = invokeRemoteGet(originFetch.client, origin.reply);
    await originFetch.started.promise;

    origin.raw.emit("close");

    await expect(originPending).resolves.toBe(origin.reply);
    await expect(receivingPending).resolves.toBe(receiving.reply);
    expect(originFetch.signal()?.aborted).toBe(true);
    const daemonSignal = daemonCalls[0]?.signal;
    expect(daemonSignal).toBeInstanceOf(AbortSignal);
    expect(daemonSignal).not.toBe(originFetch.signal());
    expect(daemonSignal?.aborted).toBe(true);
    expect(daemonCalls[0]?.body).toBeUndefined();
    expect(origin.writes).toEqual([]);
    expect(receiving.writes).toEqual([]);

    // A separately accepted mutation keeps the unsignalled path and completes.
    const mutation = makeReplyHarness();
    const accepted: SessionProxyDaemon = {
      request: (_method, _path, body, signal) => {
        expect(signal).toBeUndefined();
        return Promise.resolve({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ dismissed: body !== undefined }) });
      },
      connectWebSocket: () => { throw new Error("WebSocket is not used by this test"); },
    };
    await expect(proxySessionDaemonRequest(accepted, "/api", {
      method: "POST",
      url: "/sessions/session-1/notifications/dismiss",
      body: { cwd: "/repo", notificationId: "notice-1" },
    }, mutation.reply)).resolves.toBe(mutation.reply);
    expect(mutation.writes).toHaveLength(1);
  });
});

describe("machine proxy streaming replies", () => {
  it("flushes upstream headers before the first body chunk", async () => {
    const source = deferredReadableBody();
    const harness = makeReplyHarness();

    const pending = invokeRemoteGet(streamingClient(source.stream), harness.reply);
    await harness.flushed;

    expect(harness.flush.count).toBe(1);
    expect(source.emitted()).toBe(0);
    expect(harness.bodyReads).toBe(0);
    expect(harness.flush.statusCode).toBe(200);
    expect(harness.flush.headers["content-type"]).toBe("application/json");
    expect(harness.flush.headers["x-content-type-options"]).toBe("nosniff");

    source.releaseAll('{"rows":[]}');
    await expect(pending).resolves.toBe(harness.reply);
    expect(harness.bodyReads).toBe(1);
    expect(harness.raw.listenerCount("pipe")).toBe(0);
  });

  it("destroys a streamed reply on upstream error after header flush", async () => {
    const source = deferredReadableBody();
    const harness = makeReplyHarness({ streamFails: new Error("upstream body failed") });

    const pending = invokeRemoteGet(streamingClient(source.stream), harness.reply);
    await harness.flushed;

    expect(harness.flush.count).toBe(1);
    await expect(pending).resolves.toBe(harness.reply);
    expect(harness.raw.destroyed).toBe(true);
    expect(harness.writes).toHaveLength(0);
  });

  it("removes the flush listener when the streamed send throws before piping", async () => {
    const source = deferredReadableBody();
    const harness = makeReplyHarness({ sendThrows: new Error("reply already sent") });

    const pending = invokeRemoteGet(streamingClient(source.stream), harness.reply);

    await expect(pending).resolves.toBe(harness.reply);
    expect(harness.raw.listenerCount("pipe")).toBe(0);
    expect(harness.raw.listenerCount("finish")).toBe(0);
    expect(harness.raw.listenerCount("close")).toBe(0);
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]?.statusCode).toBe(502);
  });
});

describe("machine timeout validation", () => {
  it("returns the same timeout validation error from machine POST and PATCH", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-webui-machine-proxy-"));
    const storePath = join(directory, "machines.json");
    const beforeMachineRecord = {
      id: REMOTE_MACHINE_ID,
      name: "Remote Lab",
      kind: "remote",
      baseUrl: "https://remote.example.test",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    };
    await writeFile(storePath, JSON.stringify({ machines: [beforeMachineRecord] }), "utf8");
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    registerMachineRoutes(app, new MachineService(new MachineStore(storePath)));
    try {
      const post = await app.inject({
        method: "POST",
        url: "/api/machines",
        payload: { name: "Second Remote", baseUrl: "https://second.example.test", requestTimeoutMs: 120_000.5 },
      });
      const patch = await app.inject({ method: "PATCH", url: `/api/machines/${REMOTE_MACHINE_ID}`, payload: { requestTimeoutMs: 120_000.5 } });

      expect(post.statusCode).toBe(400);
      expect(patch.statusCode).toBe(400);
      expect(post.json()).toEqual({ error: "requestTimeoutMs must be an integer between 5000 and 180000 milliseconds" });
      expect(patch.json()).toEqual(post.json());
      expect(await readMachineRecord(storePath, REMOTE_MACHINE_ID)).toEqual(beforeMachineRecord);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

interface RouteCall {
  timeoutMs?: number;
  signal?: AbortSignal;
  put?: { timeoutMs?: number; signal?: AbortSignal };
}

async function proxyEachRouteWithStoredTimeout(storedTimeoutMs: number): Promise<Record<string, RouteCall>> {
  const calls: Record<string, RouteCall> = {};
  let currentKey = "";
  const client = fakeMachineClient({
    request: (_method, _path, _body, options) => {
      calls[currentKey] = summarize(options);
      return Promise.resolve({ statusCode: 200, headers: { "content-type": "application/json" }, body: Readable.from(["{}"]) });
    },
    requestJson: (method, _path, _body, options) => {
      if (method === "GET") {
        calls["/config"] = summarize(options);
      } else {
        calls["/config"] = { ...calls["/config"], put: summarize(options) };
      }
      return Promise.resolve({ statusCode: 200, headers: { "content-type": "application/json" }, body: configResponseBody() });
    },
  });
  const machines = proxyMachines(client, storedTimeoutMs);

  const invoke = async (spec: FederatedHttpRouteSpec, url: string, body: unknown): Promise<void> => {
    currentKey = routeKey(spec);
    await proxyMachineHttpRequest(machines, spec, REMOTE_MACHINE_ID, spec.method, url, body, undefined, makeReplyHarness().reply);
  };

  await invoke(routeSpec("POST", "/skills/search"), `/api/machines/${REMOTE_MACHINE_ID}/skills/search`, { query: "remote" });
  await invoke(routeSpec("POST", "/package-plugins"), `/api/machines/${REMOTE_MACHINE_ID}/package-plugins`, { cwd: "/repo", source: "npm:@acme/tools", action: "disable" });
  await invoke(routeSpec("POST", "/pi-packages/install"), `/api/machines/${REMOTE_MACHINE_ID}/pi-packages/install`, { source: "npm:@acme/tools" });
  await invoke(routeSpec("POST", "/sessions/:sessionId/tree/navigate"), `/api/machines/${REMOTE_MACHINE_ID}/sessions/session-1/tree/navigate`, { cwd: "/repo", targetId: "entry-1" });
  await invoke(WORKSPACE_TASKS_FEDERATED_HTTP_ROUTES[2], `/api/machines/${REMOTE_MACHINE_ID}/projects/project-1/workspaces/workspace-1/workspace-tasks/move`, moveTaskRequest());
  await invoke(routeSpec("GET", "/projects"), `/api/machines/${REMOTE_MACHINE_ID}/projects`, undefined);
  await invoke(routeSpec("GET", "/config"), `/api/machines/${REMOTE_MACHINE_ID}/config`, undefined);
  await invoke(routeSpec("PUT", "/config"), `/api/machines/${REMOTE_MACHINE_ID}/config`, { config: { maxUploadBytes: 1024 } });

  return calls;
}

function routeKey(spec: FederatedHttpRouteSpec): string {
  if (spec.path === "/sessions/:sessionId/tree/navigate") return "/sessions/tree/navigate";
  if (spec.path.endsWith("/workspace-tasks/move")) return "/workspace-tasks/move";
  return spec.path;
}

function summarize(options: MachineRequestOptions | undefined): RouteCall {
  return {
    ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  };
}

function routeSpec(method: FederatedHttpRouteSpec["method"], path: string): FederatedHttpRouteSpec {
  const spec = FEDERATED_HTTP_ROUTES.find((route) => route.method === method && route.path === path);
  if (spec === undefined) throw new Error(`No federated HTTP route is registered for ${method} ${path}`);
  return spec;
}

function moveTaskRequest(): unknown {
  const catalog = { version: 1, tasks: [] };
  return {
    operationId: "00000000-0000-4000-8000-000000000001",
    intent: "start",
    source: { ref: { scope: "workspace", id: "build" }, expectedCatalog: { kind: "loaded", revision: "workspace-revision", config: catalog } },
    destination: { scope: "global", expectedCatalog: { kind: "loaded", revision: "global-revision", config: catalog }, task: { id: "build", title: "Build", command: "npm run build", confirm: false } },
  };
}

async function assertNoOwnedListenersAfterMissingMachine(): Promise<void> {
  const harness = makeReplyHarness();
  const machines = new MachineService();
  vi.spyOn(machines, "get").mockResolvedValue(machineRecord());
  vi.spyOn(machines, "remoteClient").mockResolvedValue(undefined);

  await expect(proxyMachineHttpRequest(machines, routeSpec("GET", "/sessions"), REMOTE_MACHINE_ID, "GET", SESSIONS_URL, undefined, undefined, harness.reply)).resolves.toBe(harness.reply);

  expect(harness.writes[0]?.statusCode).toBe(404);
  expectOwnedListenersReleased(harness);
}

async function assertLookupFailureEscapesWithNoOwnedListeners(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-webui-machine-proxy-lookup-"));
  const storePath = join(directory, "machines.json");
  await writeFile(storePath, "{ not a machine registry", "utf8");
  const harness = makeReplyHarness();
  try {
    // A registry read failure is not a gateway failure; Fastify still owns it.
    await expect(proxyMachineHttpRequest(
      new MachineService(new MachineStore(storePath)),
      routeSpec("GET", "/sessions"),
      REMOTE_MACHINE_ID,
      "GET",
      SESSIONS_URL,
      undefined,
      undefined,
      harness.reply,
    )).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  expect(harness.writes).toEqual([]);
  expectOwnedListenersReleased(harness);
}

async function assertNoOwnedListenersAfterRejectedFetch(): Promise<void> {
  const harness = makeReplyHarness();
  const client = fakeMachineClient({ request: () => Promise.reject(new Error("connection refused")) });

  await expect(invokeRemoteGet(client, harness.reply)).resolves.toBe(harness.reply);

  expect(harness.writes).toHaveLength(1);
  expect(harness.writes[0]?.statusCode).toBe(502);
  expectOwnedListenersReleased(harness);
}

async function assertNoOwnedListenersAfterEmptyBody(): Promise<void> {
  const harness = makeReplyHarness();
  const client = fakeMachineClient({ request: () => Promise.resolve({ statusCode: 204, headers: {} }) });

  await expect(invokeRemoteGet(client, harness.reply)).resolves.toBe(harness.reply);

  expect(harness.writes[0]?.statusCode).toBe(204);
  expectOwnedListenersReleased(harness);
}

async function assertNoOwnedListenersAfterBufferedConfig(): Promise<void> {
  const harness = makeReplyHarness();
  const client = fakeMachineClient({
    requestJson: () => Promise.resolve({ statusCode: 200, headers: { "content-type": "application/json" }, body: configResponseBody() }),
  });

  await expect(invokeRemoteGet(client, harness.reply, { url: `/api/machines/${REMOTE_MACHINE_ID}/config`, spec: routeSpec("GET", "/config") })).resolves.toBe(harness.reply);

  expect(harness.writes[0]?.statusCode).toBe(200);
  expectOwnedListenersReleased(harness);
}

async function assertNormalFinishDoesNotAbort(): Promise<void> {
  const deferred = deferredRemoteGet();
  const harness = makeReplyHarness();
  const pending = invokeRemoteGet(deferred.client, harness.reply);
  await deferred.started.promise;

  harness.raw.emit("finish");

  expect(deferred.options()?.signal?.aborted).toBe(false);
  expect(harness.raw.listenerCount("finish")).toBe(0);
  expect(harness.raw.listenerCount("close")).toBe(0);

  deferred.resolveEmptyBody();
  await expect(pending).resolves.toBe(harness.reply);
  expect(deferred.options()?.signal?.aborted).toBe(false);
}

function expectOwnedListenersReleased(harness: ReplyHarness): void {
  expect(harness.raw.listenerCount("finish")).toBe(0);
  expect(harness.raw.listenerCount("close")).toBe(0);
  expect(harness.raw.listenerCount("pipe")).toBe(0);
}

function machineRecord(requestTimeoutMs?: number): Machine {
  return {
    id: REMOTE_MACHINE_ID,
    name: "Remote Lab",
    kind: "remote",
    baseUrl: "https://remote.example.test/base",
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

function proxyMachines(client: MachineClient, requestTimeoutMs?: number): MachineService {
  const machines = new MachineService();
  vi.spyOn(machines, "get").mockResolvedValue(machineRecord(requestTimeoutMs));
  vi.spyOn(machines, "remoteClient").mockResolvedValue(client);
  return machines;
}

function invokeRemoteGet(client: MachineClient, reply: FastifyReply, options: { url?: string; spec?: FederatedHttpRouteSpec } = {}): Promise<FastifyReply> {
  return proxyMachineHttpRequest(
    proxyMachines(client),
    options.spec ?? routeSpec("GET", "/sessions"),
    REMOTE_MACHINE_ID,
    "GET",
    options.url ?? SESSIONS_URL,
    undefined,
    undefined,
    reply,
  );
}

function streamingClient(body: NodeJS.ReadableStream): MachineClient {
  return fakeMachineClient({
    request: () => Promise.resolve({ statusCode: 200, headers: { "content-type": "application/json", "x-content-type-options": "nosniff" }, body }),
  });
}

interface DeferredRemoteGet {
  readonly client: MachineClient;
  readonly started: Started;
  options(): MachineRequestOptions | undefined;
  abortPendingRead(): void;
  resolveEmptyBody(): void;
}

function deferredRemoteGet(): DeferredRemoteGet {
  let captured: MachineRequestOptions | undefined;
  let fail: ((error: Error) => void) | undefined;
  let finish: (() => void) | undefined;
  const started = startedSignal();
  const client = fakeMachineClient({
    request: (_method, _path, _body, options) => new Promise((resolve, reject) => {
      captured = options;
      fail = reject;
      finish = () => { resolve({ statusCode: 204, headers: {} }); };
      options?.signal?.addEventListener("abort", () => {
        reject(options.signal === undefined ? new Error("missing signal") : signalReason(options.signal));
      }, { once: true });
      started.resolve();
    }),
  });
  return {
    client,
    started,
    options: () => captured,
    abortPendingRead: () => { fail?.(new Error("the read should already have been cancelled")); },
    resolveEmptyBody: () => { finish?.(); },
  };
}

interface DeferredConfigJson {
  readonly client: MachineClient;
  readonly started: Started;
  options(): MachineRequestOptions | undefined;
  abortPendingRead(): void;
  resolve(body: PiWebUiConfigResponse): void;
}

function deferredConfigJson(): DeferredConfigJson {
  let captured: MachineRequestOptions | undefined;
  let fail: ((error: Error) => void) | undefined;
  let finish: ((value: MachineJsonResponse) => void) | undefined;
  const started = startedSignal();
  const client = fakeMachineClient({
    requestJson: (_method, _path, _body, options) => new Promise<MachineJsonResponse>((resolve, reject) => {
      captured = options;
      fail = reject;
      finish = resolve;
      options?.signal?.addEventListener("abort", () => {
        reject(options.signal === undefined ? new Error("missing signal") : signalReason(options.signal));
      }, { once: true });
      started.resolve();
    }),
  });
  return {
    client,
    started,
    options: () => captured,
    abortPendingRead: () => { fail?.(new Error("the read should already have been cancelled")); },
    resolve: (body) => { finish?.({ statusCode: 200, headers: { "content-type": "application/json" }, body }); },
  };
}

interface DeferredOriginFetch {
  readonly client: MachineClient;
  readonly started: Started;
  signal(): AbortSignal | undefined;
}

/**
 * Real remote machine client over an injected fetch: aborting the browser's reply
 * stops the origin transport, which bridges to the receiving gateway's reply close
 * exactly as the remote HTTP transport would.
 */
function deferredOriginFetch(onTransportAbort: () => void): DeferredOriginFetch {
  const started = startedSignal();
  let captured: AbortSignal | undefined;
  const fetchImpl = (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal ?? undefined;
    captured = signal ?? undefined;
    signal?.addEventListener("abort", () => {
      onTransportAbort();
      reject(signalReason(signal));
    }, { once: true });
    started.resolve();
  });
  const client = new RemoteMachineClient({ baseUrl: "https://remote.example.test" }, fetchImpl);
  return { client, started, signal: () => captured };
}

function configResponseBody(): PiWebUiConfigResponse {
  return {
    path: "/home/remote/.config/pi-webui/config.json",
    exists: true,
    config: { maxUploadBytes: 1024 },
    effectiveConfig: { maxUploadBytes: 1024 },
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

async function readMachineRecord(storePath: string, machineId: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await readFile(storePath, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed["machines"])) throw new Error("Expected a machine registry file");
  const machines: unknown[] = parsed["machines"];
  return machines.find((machine) => isRecord(machine) && machine["id"] === machineId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function signalReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

interface Started {
  readonly promise: Promise<void>;
  resolve(): void;
}

function startedSignal(): Started {
  let mark: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { mark = resolve; });
  return { promise, resolve: () => { mark(); } };
}

function fakeClient(body: PiWebUiConfigResponse): MachineClient {
  return fakeMachineClient({
    request: () => Promise.reject(new Error("raw request not configured for this test")),
    requestJson: () => Promise.resolve({ statusCode: 200, headers: {}, body }),
  });
}

function fakeMachineClient(overrides: Partial<MachineClient>): MachineClient {
  return {
    request: () => Promise.resolve({ statusCode: 200, headers: {}, body: Readable.from([]) }),
    requestJson: () => Promise.resolve({ statusCode: 200, headers: {}, body: undefined }),
    connectWebSocket: () => { throw new Error("WebSocket not configured for this test"); },
    ...overrides,
  };
}

interface DeferredBody {
  readonly stream: Readable;
  emitted(): number;
  releaseAll(chunk: string): void;
}

/** A source whose first chunk is pushed only when the test releases it. */
function deferredReadableBody(): DeferredBody {
  let emitted = 0;
  const stream = new Readable({
    read() {
      // Chunks are pushed explicitly by the test.
    },
  });
  return {
    stream,
    emitted: () => emitted,
    releaseAll: (chunk) => {
      emitted += 1;
      stream.push(chunk);
      stream.push(null);
    },
  };
}

interface RawReply extends EventEmitter {
  writableFinished: boolean;
  destroyed: boolean;
  headersSent: boolean;
  statusCode: number;
  destroyError: Error | undefined;
  flushHeaders(): void;
  setHeader(name: string, value: string | string[]): void;
  getHeaders(): Record<string, string | string[]>;
  destroy(error?: Error): void;
}

interface ReplyWrite {
  readonly statusCode: number | undefined;
  readonly body: unknown;
}

interface ReplyFlush {
  count: number;
  statusCode: number | undefined;
  headers: Record<string, string | string[]>;
}

interface ReplyBehavior {
  destroyed?: boolean;
  writableFinished?: boolean;
  sendThrows?: Error;
  streamFails?: Error;
}

interface ReplyHarness {
  readonly reply: FastifyReply;
  readonly raw: RawReply;
  readonly writes: ReplyWrite[];
  readonly flush: ReplyFlush;
  readonly flushed: Promise<void>;
  readonly bodyReads: number;
}

/** The outgoing ServerResponse is an event emitter plus the small surface this proxy reads. */
function asRawReply(value: object): RawReply {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double for the outgoing ServerResponse.
  return value as RawReply;
}

/** The reply surface this proxy writes through: `code`, `header`, `send`, and `raw`. */
function asFastifyReply(value: object): FastifyReply {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double for the Fastify reply.
  return value as FastifyReply;
}

/**
 * Minimal outgoing reply: the raw response emits Fastify's `pipe` event after the
 * final headers are set and before any body byte, exactly like the installed
 * stream path.
 */
function makeReplyHarness(behavior: ReplyBehavior = {}): ReplyHarness {
  const raw = asRawReply(new EventEmitter());
  raw.writableFinished = behavior.writableFinished ?? false;
  raw.destroyed = behavior.destroyed ?? false;
  raw.headersSent = false;
  raw.statusCode = 200;
  raw.destroyError = undefined;

  let statusCode = 200;
  const headers: Record<string, string | string[]> = {};
  const flush: ReplyFlush = { count: 0, statusCode: undefined, headers: {} };
  let markFlushed: () => void = () => undefined;
  const flushed = new Promise<void>((resolve) => { markFlushed = resolve; });
  const reads = { bodyReads: 0 };

  raw.setHeader = (name, value) => { headers[name.toLowerCase()] = value; return raw; };
  raw.getHeaders = () => headers;
  raw.destroy = (error?: Error) => { raw.destroyed = true; raw.destroyError = error; };
  raw.flushHeaders = () => {
    flush.count += 1;
    raw.headersSent = true;
    flush.statusCode = statusCode;
    flush.headers = { ...headers };
    markFlushed();
  };

  const writes: ReplyWrite[] = [];
  const reply = {
    raw,
    code(status: number) { statusCode = status; return reply; },
    header(name: string, value: string | string[]) { raw.setHeader(name, value); return reply; },
    send(payload?: unknown): unknown {
      if (payload instanceof Readable) {
        if (behavior.sendThrows !== undefined) throw behavior.sendThrows;
        return new Promise<FastifyReply>((resolve, reject) => {
          raw.emit("pipe", payload);
          if (behavior.streamFails !== undefined) {
            reject(behavior.streamFails);
            return;
          }
          payload.on("data", () => { reads.bodyReads += 1; });
          payload.once("end", () => { raw.writableFinished = true; resolve(asFastifyReply(reply)); });
          payload.once("error", reject);
        });
      }
      writes.push({ statusCode, body: payload });
      raw.writableFinished = true;
      return reply;
    },
  };

  return {
    reply: asFastifyReply(reply),
    raw,
    writes,
    flush,
    flushed,
    get bodyReads() { return reads.bodyReads; },
  };
}
