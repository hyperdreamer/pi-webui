import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { buildApp, type AppDependencies } from "./app.js";
import { WebSocket } from "ws";
import { fakeRemoteClient, fakeSessionDaemon, createFakeSpeechInputSettingsService } from "./app.testSupport.js";
import { ProjectService } from "./projects/projectService.js";
import { ProjectStore } from "./storage/projectStore.js";
import { WorkspaceService } from "./workspaces/workspaceService.js";
import { MachineService } from "./machines/machineService.js";
import { MachineStore } from "./machines/machineStore.js";
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
  const dependencies: AppDependencies = { projects, workspaces, machines, sessionDaemon: daemon, config, speechInputSettings: createFakeSpeechInputSettingsService(), clientDist: false, logger: false };
  const app = await buildApp(dependencies);
  return { app, root, project, workspace, calls, remoteCalls, lookup, config, dependencies, daemon, remote, async close() { await app.close(); await rm(root, { recursive: true, force: true }); } };
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
