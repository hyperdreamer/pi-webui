import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { expect, it, vi } from "vitest";
import { createSessionDaemonApp } from "./sessionDaemonApp.js";
import { registerSessionRoutes } from "../sessions/sessionRoutes.js";
import type { SessionRouteService } from "../sessions/sessionService.js";
import { registerTerminalRoutes, type TerminalRouteService } from "../terminals/terminalRoutes.js";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import { SkillsConfigService } from "../skills/skillsConfigService.js";
import { registerSkillsConfigRoutes } from "../skills/skillsConfigRoutes.js";
import { SessionDaemonClient } from "../../sessiond/sessionDaemonClient.js";
import { buildApp } from "../app.js";
import { createFakeSpeechInputSettingsService } from "../app.testSupport.js";
import { ProjectService } from "../projects/projectService.js";
import { ProjectStore } from "../storage/projectStore.js";
import { WorkspaceService } from "../workspaces/workspaceService.js";
import { MachineService } from "../machines/machineService.js";
import { MachineStore } from "../machines/machineStore.js";
import type { PiWebUiConfigResponse } from "../../shared/apiTypes.js";

it.each([
  ["http://pi.test:8808", 200], ["https://foreign.example", 403], ["null", 403], ["%%%", 403], [undefined, 200],
] as const)("constructs the production daemon HTTP edge for Origin %s", async (origin, expected) => {
  const app = await createSessionDaemonApp({ logger: false }); let calls = 0;
  app.post("/factory-control", () => { calls++; return { ok: true }; });
  try {
    const result = await app.inject({ method: "POST", url: "/factory-control", headers: { host: "pi.test:8808", ...(origin === undefined ? {} : { origin }) } });
    expect(result.statusCode).toBe(expected); expect(calls).toBe(expected === 200 ? 1 : 0);
    if (expected === 403) expect(result.body).toBe('{"error":"Cross-origin request rejected"}');
  } finally { await app.close(); }
});

async function daemonFixture(allowedOrigins: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "daemon-origin-")); await mkdir(join(root, "workspace"));
  const app = await createSessionDaemonApp({ allowedOrigins, logger: false }); const calls: string[] = [];
  const seenOrigins: (string | undefined)[] = []; app.addHook("onRequest", (r) => { seenOrigins.push(r.headers.origin); return Promise.resolve(); });
  const info = { id: "s1", cwd: join(root, "workspace"), path: join(root, "s1.jsonl"), created: "2026-11-04T00:00:00.000Z", modified: "2026-11-04T00:00:00.000Z", messageCount: 0, firstMessage: "" };
  const status = { sessionId: "s1", isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
  const unused = (): never => { throw new Error("Unexpected daemon test method"); };
  const sessions: SessionRouteService = {
    list: () => Promise.resolve([info]), start: () => { calls.push("start"); return Promise.resolve(info); },
    setModelPolicy: () => { calls.push("setModelPolicy"); return Promise.resolve({ contractVersion: 1, policy: { mode: "tiered", tier: "standard", exact: { model: { provider: "openai", id: "test" }, thinkingLevel: "off" } }, session: status }); },
    deleteArchived: () => { calls.push("deleteArchived"); return Promise.resolve(); }, streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
    exportHistory: unused, messages: unused, status: unused, modelPolicy: unused, rememberCurrentModelPolicy: unused,
    systemPrompt: unused, extensionEntries: unused, notificationCatalog: unused, unreadCatalog: unused, acknowledgeUnread: unused,
    notificationInbox: unused, dismissNotification: unused, dismissAllNotifications: unused, clearQueue: unused, dismissWarning: unused,
    availableModels: unused, setModel: unused, cycleModel: unused, availableThinkingLevels: unused, setThinkingLevel: unused,
    cycleThinkingLevel: unused, commands: unused, prompt: unused, saveAttachments: unused, cleanupPreview: unused,
    cleanup: unused, forceCleanup: unused, archiveMany: unused, deleteArchivedMany: unused, shell: unused, runCommand: unused,
    respondToCommand: unused, navigateTree: unused, editFromHere: unused, forkFromHere: unused, abort: unused, stop: unused,
    archive: unused, archiveTree: unused, restore: unused, reload: unused, detachParent: unused, pin: unused, unpin: unused, reorder: unused,
  };
  const terminalCalls: string[] = [];
  const terminals: TerminalRouteService = {
    list: () => [], create: unused, closeForCwd: unused, close: unused,
    attach: (_id, handlers) => { terminalCalls.push("attach"); handlers.output("replayed", true); return () => undefined; },
    write: () => { terminalCalls.push("write"); }, resize: () => { terminalCalls.push("resize"); },
    continue: unused, runCommand: unused, listCommandRuns: unused, getCommandRun: unused, cancelCommandRun: unused,
  };
  const hub = new SessionEventHub(); const add = vi.spyOn(hub, "add"); const addGlobal = vi.spyOn(hub, "addGlobal");
  const skills = new SkillsConfigService({ agentDir: root, loadSkills: () => Promise.resolve([]), fetcher: () => Promise.reject(new Error("Unexpected network")), runNpx: () => Promise.reject(new Error("Unexpected process")) });
  vi.spyOn(skills, "toggle").mockImplementation(() => { calls.push("toggle"); return Promise.resolve({ success: true }); });
  registerSessionRoutes(app, sessions, hub); registerTerminalRoutes(app, terminals); registerSkillsConfigRoutes(app, skills);
  return { app, root, calls, seenOrigins, get subscriptionCount() { return add.mock.calls.length + addGlobal.mock.calls.length; }, get attachCount() { return terminalCalls.filter((v) => v === "attach").length; }, get resizeCount() { return terminalCalls.filter((v) => v === "resize").length; }, get writeCount() { return terminalCalls.filter((v) => v === "write").length; }, async close() { await app.close(); add.mockRestore(); addGlobal.mockRestore(); await rm(root, { recursive: true, force: true }); } };
}

function handshake(url: string, origin: string | undefined, waitForData = false): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: origin === undefined ? {} : { origin } }); let settled = false;
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("Daemon handshake deadline")); }, 2000);
    const finish = (status: number, body: string) => { if (settled) return; settled = true; clearTimeout(timer); socket.terminate(); resolve({ status, body }); };
    socket.once(waitForData ? "message" : "open", () => { finish(101, ""); });
    socket.once("unexpected-response", (_r, response) => { const chunks: Buffer[] = []; response.on("data", (c: Buffer) => { chunks.push(c); }); response.once("end", () => { finish(response.statusCode ?? 0, Buffer.concat(chunks).toString()); }); response.once("error", (error) => { reject(error); }); });
    socket.on("error", (error) => { if (!settled) { clearTimeout(timer); reject(error); } });
  });
}

const daemonHttpCases = [
  ["POST", "/sessions", { cwd: "/tmp" }, "start"],
  // The real route requires the exact cwd+policy body; a parser 400 is not an admitted control.
  ["PUT", "/sessions/s1/model-policy", { cwd: "/tmp", policy: { mode: "tiered", tier: "standard" } }, "setModelPolicy"],
  ["PATCH", "/skills", { cwd: "/tmp", filePath: "/tmp/SKILL.md", disableModelInvocation: true }, "toggle"],
  ["DELETE", "/sessions/s1", undefined, "deleteArchived"],
] as const;
const daemonOrigins = { matching: "http://pi.test:8808", foreign: "https://foreign.example", null: "null", malformed: "%%%", absent: undefined } as const;

for (const [method, path, payload, boundary] of daemonHttpCases) for (const [name, origin] of Object.entries(daemonOrigins)) it(`daemon ${method} ${name} guards the actual runtime route`, async () => {
  const f = await daemonFixture();
  try {
    const response = await f.app.inject({ method, url: path, ...(payload === undefined ? {} : { payload }), headers: { host: "pi.test:8808", ...(origin === undefined ? {} : { origin }) } });
    const admitted = name === "matching" || name === "absent";
    expect(response.statusCode).toBe(admitted ? 200 : 403);
    expect(f.calls).toEqual(admitted ? [boundary] : []);
    if (!admitted) expect(response.body).toBe('{"error":"Cross-origin request rejected"}');
  } finally { await f.close(); }
});

for (const family of ["/events", "/sessions/events", "/sessions/s1/events", "/terminals/t1/socket?cols=80&rows=24"]) for (const [name, fixedOrigin] of Object.entries(daemonOrigins)) it(`daemon socket ${family} ${name} rejects before runtime attachment`, async () => {
  const f = await daemonFixture();
  try {
    const http = await f.app.listen({ host: "127.0.0.1", port: 0 });
    const result = await handshake(http.replace("http:", "ws:") + family, name === "matching" ? http : fixedOrigin);
    const admitted = name === "matching" || name === "absent";
    expect(result.status).toBe(admitted ? 101 : 403);
    expect(f.subscriptionCount + f.attachCount).toBe(admitted ? 1 : 0);
    if (!admitted) { expect(result.body).toBe('{"error":"Cross-origin request rejected"}'); expect(f.resizeCount).toBe(0); expect(f.writeCount).toBe(0); }
  } finally { await f.close(); }
});

it("daemon reads a copied startup snapshot and changes only after reconstruction", async () => {
  const list = ["https://first.example"]; const old = await daemonFixture(list); list[0] = "https://next.example"; const next = await daemonFixture(list);
  try {
    for (const [f, origin, expected] of [[old, "https://first.example", 200], [old, "https://next.example", 403], [next, "https://next.example", 200], [next, "https://first.example", 403], [old, "http://pi.test:8808", 200], [next, "http://pi.test:8808", 200]] as const) {
      const response = await f.app.inject({ method: "POST", url: "/sessions", payload: { cwd: join(f.root, "workspace") }, headers: { host: "pi.test:8808", origin } }); expect(response.statusCode).toBe(expected);
    }
  } finally { await old.close(); await next.close(); }
});

it("ordinary absent-Origin traffic works across the real gateway to daemon hop", async () => {
  const f = await daemonFixture(); let gateway: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const daemonHttp = await f.app.listen({ host: "127.0.0.1", port: 0 });
    const client = new SessionDaemonClient({ env: { PI_WEBUI_CONFIG: join(f.root, "unused-config.json"), PI_WEBUI_SESSIOND_URL: daemonHttp } });
    const projects = new ProjectService(new ProjectStore(join(f.root, "projects.json"))); await projects.add({ path: join(f.root, "workspace") });
    const response = (): PiWebUiConfigResponse => ({ path: join(f.root, "config.json"), exists: false, config: {}, effectiveConfig: {}, envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false, sessiondUrl: false } });
    gateway = await buildApp({ projects, workspaces: new WorkspaceService(), machines: new MachineService(new MachineStore(join(f.root, "machines.json"))), config: { read: response, write: response, update: response }, speechInputSettings: createFakeSpeechInputSettingsService(), sessionDaemon: client, logger: false, clientDist: false });
    const gatewayHttp = await gateway.listen({ host: "127.0.0.1", port: 0 });
    const post = await gateway.inject({ method: "POST", url: "/api/sessions", payload: { cwd: join(f.root, "workspace") }, headers: { host: "gateway.test", origin: "http://gateway.test" } });
    expect(post.statusCode).toBe(200); expect(f.calls).toEqual(["start"]);
    const socketResult = await handshake(gatewayHttp.replace("http:", "ws:") + "/api/sessions/s1/events", gatewayHttp, true); expect(socketResult.status).toBe(101);
    await vi.waitFor(() => { expect(f.subscriptionCount).toBe(1); }); expect(f.seenOrigins.every((value) => value === undefined)).toBe(true);
    const calls = [...f.calls]; const subscriptions = f.subscriptionCount;
    for (const origin of ["https://foreign.example", "null"]) {
      const direct = await f.app.inject({ method: "POST", url: "/sessions", payload: { cwd: "/tmp" }, headers: { host: "pi.test:8808", origin } }); expect(direct.statusCode).toBe(403);
      expect((await handshake(daemonHttp.replace("http:", "ws:") + "/sessions/s1/events", origin)).status).toBe(403);
    }
    expect(f.calls).toEqual(calls); expect(f.subscriptionCount).toBe(subscriptions);
  } finally { await gateway?.close(); await f.close(); }
});
