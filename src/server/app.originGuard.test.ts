import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { buildApp, type AppDependencies } from "./app.js";
import { WebSocket, WebSocketServer } from "ws";
import { fakeRemoteClient, fakeSessionDaemon, createFakeSpeechInputSettingsService } from "./app.testSupport.js";
import { ProjectService } from "./projects/projectService.js";
import { ProjectStore } from "./storage/projectStore.js";
import { WorkspaceService } from "./workspaces/workspaceService.js";
import { MachineService } from "./machines/machineService.js";
import { MachineStore } from "./machines/machineStore.js";
import type { FastifyInstance } from "fastify";
import type { PiWebUiConfigValues, PiWebUiConfigResponse } from "../shared/apiTypes.js";
import type { PiWebUiConfigService } from "./configRoutes.js";
import type { SessionProxyDaemon } from "./sessiond/sessionProxyRoutes.js";

async function originGateway(allowedOrigins: string[] = [], socketTarget?: string) {
  const root = await mkdtemp(join(tmpdir(), "origin-gateway-"));
  const path = join(root, "workspace"); await mkdir(path);
  const projects = new ProjectService(new ProjectStore(join(root, "projects.json")));
  const project = await projects.add({ path }); const workspaces = new WorkspaceService();
  const workspace = (await workspaces.list(project))[0]; if (!workspace) throw new Error("Missing main workspace");
  const calls: string[] = []; const remoteCalls: string[] = [];
  let desired: PiWebUiConfigValues = { allowedOrigins };
  const response = (): PiWebUiConfigResponse => ({ path: join(root, "config.json"), exists: true, config: desired, effectiveConfig: desired, envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false, sessiondUrl: false } });
  const config: PiWebUiConfigService = { read: vi.fn(response), write: (next) => { desired = next; return response(); }, update: (change) => { desired = change(desired); return response(); } };
  const daemon: SessionProxyDaemon = { ...fakeSessionDaemon(), request: (method: string, path: string) => { calls.push(`${method} ${path}`); return Promise.resolve({ statusCode: 200, headers: { "content-type": "application/json" }, body: "{}" }); }, connectWebSocket: (path: string) => { calls.push(`socket ${path}`); if (socketTarget === undefined || socketTarget === "") throw new Error("Socket upstream was not configured"); return new WebSocket(socketTarget); } };
  const remote = fakeRemoteClient({ request: (method, path) => { remoteCalls.push(`${method} ${path}`); return Promise.resolve({ statusCode: 200, headers: { "content-type": "application/json" }, body: Readable.from(["{}"]) }); }, connectWebSocket: (path) => { remoteCalls.push(`socket ${path}`); if (socketTarget === undefined || socketTarget === "") throw new Error("Socket upstream was not configured"); return new WebSocket(socketTarget); } });
  const machines = new MachineService(new MachineStore(join(root, "machines.json")), { remoteClientFactory: () => remote });
  const machine = await machines.add({ name: "remote-a", baseUrl: "http://remote.invalid" });
  // The registry supplies a real public Machine; only its id is fixed for the matrix.
  const lookup = vi.spyOn(machines, "remoteTarget").mockResolvedValue({ machine: { ...machine, id: "remote-a" }, client: remote });
  // The socket proxy reads the client by id instead of the combined target.
  const clientLookup = vi.spyOn(machines, "remoteClient").mockResolvedValue(remote);
  const dependencies: AppDependencies = { projects, workspaces, machines, sessionDaemon: daemon, config, speechInputSettings: createFakeSpeechInputSettingsService(), clientDist: false, logger: false };
  const app = await buildApp(dependencies);
  return { app, root, project, workspace, calls, remoteCalls, lookup, clientLookup, config, dependencies, daemon, remote, async close() { await app.close(); await rm(root, { recursive: true, force: true }); } };
}

const prefixes = ["/api", "/api/machines/local", "/api/machines/remote-a"] as const;
const origins = { matching: "http://pi.test:8808", foreign: "https://foreign.example", null: "null", malformed: "%%%", absent: undefined } as const;
const methods = [
  { method: "POST", suffix: "/sessions", payload: { cwd: "/tmp" } },
  { method: "PUT", suffix: "/sessions/s1/model-policy", payload: { policy: { mode: "tiered", tier: "standard" } } },
  { method: "PATCH", suffix: "/skills", payload: { cwd: "/tmp", filePath: "/tmp/SKILL.md", disableModelInvocation: true } },
  { method: "DELETE", suffix: "/sessions/s1", payload: undefined },
] as const;

for (const prefix of prefixes) for (const entry of methods) for (const [name, origin] of Object.entries(origins)) {
  it(`gateway ${prefix} ${entry.method} ${name}`, async () => {
    const fixture = await originGateway();
    try {
      const before = fixture.lookup.mock.calls.length;
      const result = await fixture.app.inject({ method: entry.method, url: `${prefix}${entry.suffix}`, headers: { host: "pi.test:8808", ...(origin === undefined ? {} : { origin }) }, ...(entry.payload === undefined ? {} : { payload: entry.payload }) });
      const accepted = name === "matching" || name === "absent";
      expect(result.statusCode).toBe(accepted ? 200 : 403);
      expect(fixture.calls.length + fixture.remoteCalls.length).toBe(accepted ? 1 : 0);
      if (!accepted) { expect(result.body).toBe('{"error":"Cross-origin request rejected"}'); expect(fixture.lookup.mock.calls.length).toBe(before); }
    } finally { await fixture.close(); }
  });
}

for (const prefix of prefixes) for (const method of ["GET", "HEAD"] as const) it(`gateway safe ${prefix} ${method} ignores foreign Origin`, async () => {
  const fixture = await originGateway();
  try {
    const result = await fixture.app.inject({ method, url: `${prefix}/sessions?cwd=%2Ftmp`, headers: { host: "pi.test:8808", origin: "https://foreign.example" } });
    expect(result.statusCode).toBe(200); expect(fixture.calls.length + fixture.remoteCalls.length).toBe(1);
  } finally { await fixture.close(); }
});

it("stops gateway construction when startup config cannot be read", async () => {
  const f = await originGateway();
  try {
    await expect(buildApp({ ...f.dependencies, config: { ...f.config, read: () => Promise.reject(new Error("config unavailable")) } })).rejects.toThrow("config unavailable");
  } finally { await f.close(); }
});

async function socketHandshake(url: string, origin?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: origin === undefined ? {} : { origin } });
    const deadline = setTimeout(() => { socket.terminate(); reject(new Error("Handshake deadline")); }, 2000);
    const done = (status: number, body: string) => { clearTimeout(deadline); socket.terminate(); resolve({ status, body }); };
    socket.once("message", () => { done(101, ""); });
    socket.once("unexpected-response", (_request, response) => {
      const chunks: Buffer[] = []; response.on("data", (c: Buffer) => chunks.push(c));
      response.once("end", () => { done(response.statusCode ?? 0, Buffer.concat(chunks).toString()); });
      response.once("error", (error) => { reject(error); });
    });
    socket.on("error", (error) => { clearTimeout(deadline); if (socket.readyState !== WebSocket.CLOSED) reject(error); });
  });
}

const families = ["/events", "/sessions/events", "/sessions/s1/events", "workspace terminal"] as const;
for (const prefix of prefixes) for (const family of families) for (const [name, fixedOrigin] of Object.entries(origins)) it(`gateway socket ${prefix} ${family} ${name}`, async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(upstream, "listening");
  let attached = 0; upstream.on("connection", (s) => { attached++; s.send("ready"); });
  const address = upstream.address(); if (address === null || typeof address === "string") throw new Error("TCP expected");
  const fixture = await originGateway([], `ws://127.0.0.1:${String(address.port)}`);
  try {
    const http = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const origin = name === "matching" ? http : fixedOrigin;
    const suffix = family === "workspace terminal" ? `/projects/${encodeURIComponent(fixture.project.id)}/workspaces/${encodeURIComponent(fixture.workspace.id)}/terminals/t1/socket?cols=80&rows=24` : family;
    const before = fixture.lookup.mock.calls.length; const beforeClients = fixture.clientLookup.mock.calls.length;
    const result = await socketHandshake(http.replace("http:", "ws:") + prefix + suffix, origin);
    const accepted = name === "matching" || name === "absent";
    expect(result.status).toBe(accepted ? 101 : 403);
    if (accepted) await vi.waitFor(() => { expect(attached).toBe(1); });
    else { expect(result.body).toBe('{"error":"Cross-origin request rejected"}'); expect(attached).toBe(0); expect(fixture.calls).toEqual([]); expect(fixture.remoteCalls).toEqual([]); expect(fixture.lookup.mock.calls.length).toBe(before); expect(fixture.clientLookup.mock.calls.length).toBe(beforeClients); }
  } finally {
    for (const socket of upstream.clients) socket.terminate();
    await fixture.close(); await new Promise<void>((resolve) => { upstream.close(() => { resolve(); }); });
  }
});

it("gateway accepts the public HTTPS origin described by forwarded proto", async () => {
  const f = await originGateway();
  try {
    for (const [origin, expected] of [["https://pi.test:8808", 200], ["http://pi.test:8808", 403]] as const) expect((await f.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: f.workspace.path }, headers: { host: "pi.test:8808", "x-forwarded-proto": "https, http", origin } })).statusCode).toBe(expected);
  } finally { await f.close(); }
});

it("gateway permits only an exact configured public origin after Host rewriting", async () => {
  for (const allowedOrigins of [[], ["https://public.example:8443"]]) {
    const f = await originGateway(allowedOrigins);
    try {
      await f.config.update((c) => ({ ...c, allowedHosts: true }));
      for (const [origin, expected] of [["https://public.example:8443", allowedOrigins.length ? 200 : 403], ["https://public.example:8444", 403]] as const) expect((await f.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: f.workspace.path }, headers: { host: "internal:8808", origin } })).statusCode).toBe(expected);
    } finally { await f.close(); }
  }
});

it("gateway protects every unsafe method without awaiting body parsing", async () => {
  const f = await originGateway();
  try {
    for (const entry of methods) {
      const result = await f.app.inject({ method: entry.method, url: `/api${entry.suffix}`, headers: { host: "pi.test:8808", origin: "https://foreign.example", "content-type": "application/json" }, payload: "{" });
      expect(result.statusCode).toBe(403); expect(result.body).toBe('{"error":"Cross-origin request rejected"}');
    }
    expect(f.calls).toEqual([]); expect(f.remoteCalls).toEqual([]);
  } finally { await f.close(); }
});

it("gateway retains its startup snapshot until rebuilt", async () => {
  const initial: string[] = []; const f = await originGateway(initial); const rebuilt: FastifyInstance[] = [];
  const request = (app: FastifyInstance, origin: string) => app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: f.workspace.path }, headers: { host: "pi.test:8808", origin } });
  try {
    const saved = await f.app.inject({ method: "PUT", url: "/api/config", payload: { config: { allowedOrigins: ["https://public.example"] } }, headers: { host: "pi.test:8808", origin: "http://pi.test:8808" } });
    expect(saved.json<PiWebUiConfigResponse>().config.allowedOrigins).toEqual(["https://public.example"]);
    initial.push("https://public.example");
    expect((await request(f.app, "https://public.example")).statusCode).toBe(403);
    expect((await request(f.app, "http://pi.test:8808")).statusCode).toBe(200);
    const next = await buildApp(f.dependencies); rebuilt.push(next);
    expect((await request(next, "https://public.example")).statusCode).toBe(200);
    const cleared = await next.inject({ method: "PUT", url: "/api/config", payload: { config: { allowedOrigins: [] } }, headers: { host: "pi.test:8808", origin: "http://pi.test:8808" } });
    expect(cleared.json<PiWebUiConfigResponse>().effectiveConfig.allowedOrigins).toEqual([]);
    expect((await request(next, "https://public.example")).statusCode).toBe(200);
    const last = await buildApp(f.dependencies); rebuilt.push(last);
    expect((await request(last, "https://public.example")).statusCode).toBe(403);
    expect((await request(last, "http://pi.test:8808")).statusCode).toBe(200);
  } finally { for (const app of rebuilt.reverse()) await app.close(); await f.close(); }
});
