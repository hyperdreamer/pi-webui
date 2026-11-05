#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { buildApp } from "../src/server/app.ts";
import { ProjectService } from "../src/server/projects/projectService.ts";
import { ProjectStore } from "../src/server/storage/projectStore.ts";
import { WorkspaceService } from "../src/server/workspaces/workspaceService.ts";
import { MachineService } from "../src/server/machines/machineService.ts";
import { MachineStore } from "../src/server/machines/machineStore.ts";
const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const chromium = option("--chromium"); const output = option("--output-dir");
if (!chromium || !output || args.length !== 4) throw new Error("Required: --chromium <executable> --output-dir <audit-directory>");
await mkdir(output, { recursive: true });
const result = { passed: false, browserVersion: null, animationProgress: null, forbidden: {}, positiveControls: {}, navigation: {}, policies: {}, diagnostics: [] };
const scriptPath = fileURLToPath(import.meta.url);
result.scriptSha256 = createHash("sha256").update(await readFile(scriptPath)).digest("hex");
result.revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: resolve(dirname(scriptPath), ".."), encoding: "utf8" }).trim();
await copyFile(scriptPath, join(output, "verify-local-file-link-viewer.mjs"));
const POLICY = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' http: https:; style-src 'unsafe-inline' http: https:; img-src http: https: data: blob:; font-src http: https: data:; media-src http: https: data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; object-src 'none'";
const policies = {
  original: POLICY,
  connect: POLICY.replace("connect-src 'none'", "connect-src http: https: ws: wss:"),
  formBlocked: POLICY.replace("sandbox allow-scripts", "sandbox allow-scripts allow-forms"),
  formAllowed: POLICY.replace("sandbox allow-scripts", "sandbox allow-scripts allow-forms").replace("form-action 'none'", "form-action http: https:"),
  frame: POLICY.replace("frame-src 'none'", "frame-src http: https:"),
  worker: POLICY.replace("sandbox allow-scripts; ", "").replace("worker-src 'none'", "worker-src 'self'"),
  object: POLICY.replace("sandbox allow-scripts; ", "").replace("object-src 'none'", "object-src http: https:").replace("frame-src 'none'", "frame-src http: https:"),
  base: POLICY.replace("base-uri 'none'", "base-uri http: https:"),
  unsandboxed: POLICY.replace("sandbox allow-scripts; ", ""),
};
result.policies = policies;
// Deliberately wrong production policy for the baseline-oracle negative control.
// A baseline assertion that accepts this value cannot detect a weakened policy.
const WRONG_BASELINE_POLICY = "sandbox allow-scripts; default-src * data: blob: 'unsafe-inline'; connect-src *";
// The baseline request carries no auditPolicy parameter and must arrive with the
// unmodified production header. Every injected policy is recorded here so the
// audit can prove the override hook never touched a baseline/original request.
const policyOverride = { baselineRequests: 0, baselineWrites: 0, applications: [] };
const baselineOverrides = () => policyOverride.applications.filter((entry) => entry.requested === null || entry.requested === "original");
function assertProductionBaseline(headers, label) {
  assert.equal(headers.get("content-security-policy"), POLICY, `${label}: production CSP baseline mismatch`);
  assert.equal(headers.get("content-length"), null, `${label}: file view must not precompute content-length`);
  assert.equal(headers.get("referrer-policy"), "no-referrer", `${label}: file view must keep referrer-policy no-referrer`);
}
class Cdp {
  constructor(socket) {
    this.socket = socket; this.sequence = 0; this.pending = new Map();
    socket.on("message", (data) => { const message = JSON.parse(String(data)); const request = this.pending.get(message.id); if (!request) return; this.pending.delete(message.id); clearTimeout(request.timer); if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result); });
    socket.on("close", () => { for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error("CDP closed")); } this.pending.clear(); });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.sequence;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP deadline: ${method}`)); }, 10000);
      this.pending.set(id, { resolve: resolveRequest, reject, timer }); this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(sessionId, expression) {
    const value = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails)); return value.result.value;
  }
}
const counts = new Map(); const upgrades = new Map(); const protectedCounts = { action: 0, socket: 0, worker: 0, bridge: 0 }; const statuses = [];
const requestNames = ["/fetch", "/xhr", "/eventsource", "/beacon", "/form", "/frame", "/object", "/base-probe", "/executed-frame", "/executed-object", "/executed-worker", "/resource-image", "/resource-script", "/resource-style", "/executed-script"];
const increment = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const snapshot = () => ({ requests: Object.fromEntries(requestNames.map((name) => [name, counts.get(name) ?? 0])), upgrades: { "/ws": upgrades.get("/ws") ?? 0 }, handlers: { ...protectedCounts } });
const clearCounts = () => { counts.clear(); upgrades.clear(); protectedCounts.action = 0; protectedCounts.socket = 0; protectedCounts.worker = 0; protectedCounts.bridge = 0; statuses.length = 0; };
const acceptedSockets = new Set();
const trackSocket = (socket) => { acceptedSockets.add(socket); socket.once("close", () => acceptedSockets.delete(socket)); socket.on("error", () => undefined); };
async function until(condition, label, duration = 6000) { const deadline = performance.now() + duration; while (!condition()) { assert(performance.now() < deadline, label); await delay(10); } }
function onceBounded(emitter, event, label, duration = 6000) {
  return new Promise((resolveEvent, reject) => {
    const cleanup = () => { clearTimeout(timer); emitter.removeListener(event, complete); emitter.removeListener("error", failed); };
    const complete = (...values) => { cleanup(); resolveEvent(values); }; const failed = (error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(label)); }, duration);
    emitter.once(event, complete); emitter.once("error", failed);
  });
}
function rawHandshake(url, origin) {
  return new Promise((resolveHandshake, reject) => {
    const socket = new WebSocket(url, { headers: { origin } }); trackSocket(socket); let settled = false;
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("Audit handshake deadline")); }, 6000);
    const complete = (status, body) => { if (settled) return; settled = true; clearTimeout(timer); socket.terminate(); resolveHandshake({ status, body }); };
    socket.once("message", () => complete(101, ""));
    socket.once("unexpected-response", (_request, response) => { const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.once("end", () => complete(response.statusCode, Buffer.concat(chunks).toString())); });
    socket.on("error", error => { if (!settled) { clearTimeout(timer); reject(error); } });
  });
}
let app; let mock; let mockSockets; let browser; let cdpSocket; let root; let appUrl; let mockUrl; let spawnError;
async function stopBrowser() {
  if (!browser || browser.exitCode !== null) return;
  const exited = once(browser, "exit").catch(() => undefined); browser.kill("SIGTERM");
  await Promise.race([exited, delay(1000)]); if (browser.exitCode === null) { browser.kill("SIGKILL"); await until(() => browser.exitCode !== null || browser.signalCode !== null, "Chromium was not reaped", 2000); }
}
function fixtureHtml() {
  return `<!doctype html><meta charset="utf-8"><title>Private file view audit</title><div id="animation">animation</div><script>
  const app = ${JSON.stringify(appUrl)}, mock = ${JSON.stringify(mockUrl)};
  const mode = new URL(location.href).searchParams.get('probe') || 'all';
  window.animationFrames = 0; function frame() { window.animationFrames++; document.querySelector('#animation').style.transform = 'translateX(' + window.animationFrames + 'px)'; requestAnimationFrame(frame); } requestAnimationFrame(frame);
  window.originEvidence = { origin: self.origin, storage: false }; try { localStorage.setItem('private-audit','yes'); window.originEvidence.storage = true; localStorage.removeItem('private-audit'); } catch {}
  window.violations = []; document.addEventListener('securitypolicyviolation', e => window.violations.push(e.violatedDirective));
  const tasks = []; const selected = name => mode === 'all' || mode === name;
  if (selected('connect')) {
    tasks.push(fetch(mock + '/fetch', { mode: 'no-cors' }).catch(() => undefined));
    tasks.push(new Promise(resolve => { const x = new XMLHttpRequest(); x.onloadend = resolve; x.onerror = resolve; x.open('GET', mock + '/xhr'); x.send(); }));
    tasks.push(new Promise(resolve => { const s = new WebSocket(mock.replace('http:', 'ws:') + '/ws'); s.onopen = () => { s.close(); resolve(); }; s.onerror = resolve; }));
    tasks.push(new Promise(resolve => { const e = new EventSource(mock + '/eventsource'); e.onopen = () => { e.close(); resolve(); }; e.onerror = () => { e.close(); resolve(); }; }));
    navigator.sendBeacon(mock + '/beacon', 'audit');
  }
  if (selected('frame')) { const iframe = document.createElement('iframe'); iframe.src = mock + '/frame'; document.body.append(iframe); }
  if (selected('worker')) { try { const worker = new Worker(app + '/api/audit/worker'); tasks.push(new Promise(resolve => { worker.onmessage = () => { worker.terminate(); resolve(); }; worker.onerror = () => { worker.terminate(); resolve(); }; })); } catch {} }
  if (selected('object')) { const object = document.createElement('object'); object.type = 'text/html'; object.data = mock + '/object'; document.body.append(object); }
  if (selected('base')) { const base = document.createElement('base'); base.href = mock + '/'; document.head.append(base); const image = new Image(); image.src = 'base-probe'; document.body.append(image); }
  const remoteImage = new Image(); remoteImage.src = mock + '/resource-image'; document.body.append(remoteImage);
  const remoteScript = document.createElement('script'); remoteScript.src = mock + '/resource-script'; document.head.append(remoteScript);
  const remoteStyle = document.createElement('link'); remoteStyle.rel = 'stylesheet'; remoteStyle.href = mock + '/resource-style'; document.head.append(remoteStyle);
  if (selected('form')) { const f = document.createElement('form'); f.method = 'POST'; f.action = mock + '/form'; document.body.append(f); window.submitAuditForm = () => { window.formAttempted = true; f.submit(); }; }
  window.auditStarted = true;
  Promise.allSettled(tasks).then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))).then(() => window.auditDone = true);
  </script>`;
}
async function waitFor(cdp, sessionId, expression) {
  return cdp.evaluate(sessionId, `(async () => { const deadline = performance.now() + 6000; while (!(${expression})) { if (performance.now() > deadline) throw new Error('Page condition deadline'); await new Promise(r => requestAnimationFrame(r)); } return true; })()`);
}
try {
  await access(chromium, constants.X_OK);
  root = await mkdtemp(join(tmpdir(), "pi-file-view-audit-")); const workspacePath = join(root, "workspace"); await mkdir(workspacePath);
  const projects = new ProjectService(new ProjectStore(join(root, "projects.json"))); const project = await projects.add({ path: workspacePath }); const workspaces = new WorkspaceService(); const [workspace] = await workspaces.list(project); assert(workspace);
  const response = () => ({ path: join(root, "config.json"), exists: true, config: {}, effectiveConfig: {}, envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false, sessiondUrl: false } });
  app = await buildApp({ projects, workspaces, machines: new MachineService(new MachineStore(join(root, "machines.json"))), config: { read: response, write: response, update: response }, sessionDaemon: { request: async () => { protectedCounts.bridge++; return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{}' }; }, connectWebSocket: (path) => { protectedCounts.bridge++; return new WebSocket(mockUrl.replace("http:", "ws:") + path); } }, hostSpeech: { status: async () => ({ available: false, voices: [] }), speak: async (r) => ({ runId: r.runId, outcome: 'ended' }), stop: async () => undefined, close: async () => undefined }, logger: false, clientDist: false });
  // Baseline requests must carry the unmodified production header, so a broken
  // production policy fails this audit. Only the deliberately weakened control
  // policies are injected here, and each application is recorded so the audit
  // can prove a baseline/original request was never rewritten.
  app.addHook("onSend", async (request, reply, payload) => {
    const url = new URL(request.url, "http://private.invalid");
    if (!url.pathname.includes("/file/view")) return payload;
    const baseline = !url.searchParams.has("auditPolicy");
    const requested = url.searchParams.get("auditPolicy");
    if (baseline) policyOverride.baselineRequests++;
    if (requested !== null && requested !== "original" && Object.hasOwn(policies, requested)) {
      reply.header("Content-Security-Policy", policies[requested]);
      policyOverride.applications.push({ requested, path: url.pathname });
      if (baseline || requested === "original") policyOverride.baselineWrites++;
    }
    return payload;
  });
  app.addHook("onResponse", async (request, reply) => { if (["/api/audit/action", "/api/audit/socket", "/api/audit/control"].some(path => request.url.startsWith(path))) statuses.push({ path: request.url, status: reply.statusCode, origin: request.headers.origin, upgrade: request.headers.upgrade ?? null }); });
  app.post("/api/audit/action", () => { protectedCounts.action++; return { ok: true }; });
  app.get("/api/audit/socket", { websocket: true }, (socket) => { trackSocket(socket); protectedCounts.socket++; socket.send("ready"); });
  app.get("/api/audit/worker", (_request, reply) => { protectedCounts.worker++; return reply.type("application/javascript").send(`fetch(${JSON.stringify("WORKER_MARKER")}, {mode:'no-cors'}).then(() => postMessage('done')).catch(() => postMessage('failed'));` .replace(JSON.stringify("WORKER_MARKER"), JSON.stringify(mockUrl + "/executed-worker"))); });
  app.get("/api/audit/control", (_r, reply) => reply.type("text/html").send("<!doctype html><title>same-origin control</title>"));
  // Probe-only response with a deliberately wrong production policy. It never
  // passes through the policy override hook and exists only for the baseline
  // oracle self-check below.
  app.get("/api/audit/baseline-probe", (_request, reply) => reply.type("text/html").header("Content-Security-Policy", WRONG_BASELINE_POLICY).send("<!doctype html><title>baseline oracle probe</title>"));
  appUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  mock = http.createServer((request, response) => {
    const path = new URL(request.url, "http://private.invalid").pathname; increment(counts, path);
    response.setHeader("Access-Control-Allow-Origin", "*"); response.setHeader("Cache-Control", "no-store");
    if (path === "/eventsource") { response.setHeader("Content-Type", "text/event-stream"); response.end("data: ready\n\n"); }
    else if (path === "/frame" || path === "/object") { response.setHeader("Content-Type", "text/html"); response.end(`<script>fetch('/executed-${path.slice(1)}',{mode:'no-cors'})<\/script>`); }
    else if (path === "/foreign") {
      response.setHeader("Content-Type", "text/html");
      const sessionSocket = JSON.stringify(appUrl.replace("http:", "ws:") + "/api/audit/socket");
      const eventsSocket = JSON.stringify(appUrl.replace("http:", "ws:") + "/api/events");
      response.end(`<!doctype html><script>
const attempts = window.foreignAttempts = { action: false, bridge: false, socket: false, events: false };
fetch(${JSON.stringify(appUrl + "/api/audit/action")},{method:'POST',mode:'no-cors',body:'audit'}).catch(()=>undefined).finally(()=>{attempts.action=true});
fetch(${JSON.stringify(appUrl + "/api/sessions")},{method:'POST',mode:'no-cors',body:'{}'}).catch(()=>undefined).finally(()=>{attempts.bridge=true});
const s=new WebSocket(${sessionSocket});s.onopen=()=>{attempts.socket=true};s.onerror=()=>{window.socketFailed=true;attempts.socket=true};
const e=new WebSocket(${eventsSocket});e.onopen=()=>{attempts.events=true};e.onerror=()=>{attempts.events=true};
window.foreignStarted=true;<\/script>`);
    }
    else if (path === "/resource-script") { response.setHeader("Content-Type", "application/javascript"); response.end(`new Image().src=${JSON.stringify(mockUrl + "/executed-script")}`); }
    else if (path === "/resource-style") { response.setHeader("Content-Type", "text/css"); response.end("#animation { color: rgb(1, 2, 3); }"); }
    else { response.setHeader("Content-Type", "text/plain"); response.end("ok"); }
  });
  mockSockets = new WebSocketServer({ noServer: true }); mock.on("upgrade", (request, socket, head) => { increment(upgrades, new URL(request.url, "http://private.invalid").pathname); mockSockets.handleUpgrade(request, socket, head, (websocket) => { trackSocket(websocket); websocket.send("ready"); }); });
  await new Promise((done) => mock.listen(0, "127.0.0.1", done)); mockUrl = `http://127.0.0.1:${mock.address().port}`;
  await writeFile(join(workspacePath, "audit.html"), fixtureHtml());
  const profile = join(root, "chromium"); await mkdir(profile); const stderr = [];
  browser = spawn(chromium, ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] }); browser.stderr.on("data", (data) => stderr.push(String(data))); browser.on("error", (error) => { spawnError = error; result.diagnostics.push(String(error)); });
  const activePort = join(profile, "DevToolsActivePort"); let portText;
  for (let i = 0; i < 250; i++) { try { portText = await readFile(activePort, "utf8"); break; } catch { if (spawnError) throw spawnError; if (browser.exitCode !== null) throw new Error(`Chromium exited: ${stderr.join("")}`); await delay(20); } }
  assert(portText, "Chromium debugging endpoint unavailable"); const [port, endpoint] = portText.trim().split("\n");
  cdpSocket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`); await onceBounded(cdpSocket, "open", "CDP connection deadline"); const cdp = new Cdp(cdpSocket);
  result.browserVersion = await cdp.send("Browser.getVersion"); const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" }); const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }); await cdp.send("Page.enable", {}, sessionId); await cdp.send("Runtime.enable", {}, sessionId);
  const route = `${appUrl}/api/projects/${encodeURIComponent(project.id)}/workspaces/${encodeURIComponent(workspace.id)}/file/view`;
  const viewUrl = (policy, probe = "all") => `${route}?${new URLSearchParams({ path: "audit.html", ...(policy === "original" ? {} : { auditPolicy: policy }), probe })}`;
  const baselineSelfCheck = async () => {
    // Self-check stage, fail closed: the probe's deliberately wrong production
    // policy must be rejected by the same assertion used for the real baseline.
    const probe = await fetch(appUrl + "/api/audit/baseline-probe"); assert.equal(probe.status, 200, "Baseline oracle probe was not served");
    const probePolicy = probe.headers.get("content-security-policy"); await probe.arrayBuffer();
    assert.equal(probePolicy, WRONG_BASELINE_POLICY, "Baseline oracle probe did not deliver the deliberately wrong policy");
    let rejected = null; try { assertProductionBaseline(probe.headers, "baseline oracle negative control"); } catch (error) { rejected = error instanceof Error ? error.message : String(error); }
    if (rejected === null) throw new Error("Baseline oracle self-check failed: a deliberately wrong production CSP was accepted");
    if (!rejected.includes("production CSP baseline mismatch")) throw new Error(`Baseline oracle self-check failed: the wrong production CSP was not rejected by the CSP comparison (${rejected})`);
    // Positive baseline: request the real production response without any
    // auditPolicy parameter, prove the override observer saw it, and prove the
    // observer recorded no override application for it.
    const url = viewUrl("original"); assert.equal(new URL(url).searchParams.has("auditPolicy"), false, "Baseline request must not carry an auditPolicy override");
    const observed = policyOverride.baselineRequests; const response = await fetch(url); assert.equal(response.status, 200);
    assert.equal(policyOverride.baselineRequests, observed + 1, "Baseline request bypassed the policy override observer");
    assert.equal(policyOverride.baselineWrites, 0, "Baseline request was rewritten by the policy override hook");
    assert.deepEqual(baselineOverrides(), [], "Baseline request was rewritten by the policy override hook");
    assertProductionBaseline(response.headers, "production baseline");
    result.headers = Object.fromEntries(response.headers);
    result.baseline = { url, policy: response.headers.get("content-security-policy"), baselineRequests: policyOverride.baselineRequests, baselineWrites: policyOverride.baselineWrites, overrideApplications: [...policyOverride.applications], negativeControl: { policy: probePolicy, rejected } };
    await response.arrayBuffer();
  };
  await baselineSelfCheck();
  const navigate = async (url) => { await cdp.send("Page.navigate", { url }, sessionId); await waitFor(cdp, sessionId, `location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`); };
  const run = async (policy, probe) => {
    clearCounts(); await navigate(viewUrl(policy, probe)); await waitFor(cdp, sessionId, "window.auditDone === true");
    if (probe === "all") { await cdp.evaluate(sessionId, "window.submitAuditForm()"); await cdp.evaluate(sessionId, "new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))"); assert.equal(await cdp.evaluate(sessionId, "window.formAttempted"), true); }
    if (policy === "connect") await until(() => ["/fetch", "/xhr", "/eventsource", "/beacon"].every(name => (counts.get(name) ?? 0) > 0) && (upgrades.get("/ws") ?? 0) > 0, "Connect positive controls incomplete");
    if (probe === "frame" || probe === "object") await until(() => (counts.get(`/executed-${probe}`) ?? 0) > 0, `${probe} execution marker missing`);
    if (probe === "base") await until(() => (counts.get("/base-probe") ?? 0) > 0, "Base control did not change resource resolution");
    if (probe === "form") { await cdp.evaluate(sessionId, "window.submitAuditForm()"); await waitFor(cdp, sessionId, "window.violations.includes('form-action')"); }
    await until(() => ["/resource-image", "/resource-script", "/resource-style", "/executed-script"].every(name => (counts.get(name) ?? 0) > 0), "Allowed remote resource controls missing");
    return snapshot();
  };
  result.forbidden = await run("original", "all");
  const frames = await cdp.evaluate(sessionId, "(async () => { const a = window.animationFrames; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return [a,window.animationFrames]; })()"); assert(frames[1] > frames[0]); result.animationProgress = frames;
  const opaque = await cdp.evaluate(sessionId, "window.originEvidence"); assert.equal(opaque.origin, "null"); assert.equal(opaque.storage, false); result.opaqueOrigin = opaque;
  for (const path of ["/fetch", "/xhr", "/eventsource", "/beacon", "/form", "/frame", "/object", "/base-probe", "/executed-frame", "/executed-object", "/executed-worker"]) assert.equal(result.forbidden.requests[path] ?? 0, 0, path);
  assert.equal(result.forbidden.upgrades["/ws"] ?? 0, 0); assert.equal(result.forbidden.handlers.worker, 0); assert.equal(result.forbidden.handlers.bridge, 0); assert((result.forbidden.requests["/resource-image"] ?? 0) > 0);
  for (const [policy, probe] of [["connect", "connect"], ["frame", "frame"], ["worker", "worker"], ["object", "object"], ["base", "base"], ["unsandboxed", "connect"]]) {
    const control = await run(policy, probe); result.positiveControls[policy] = control;
    if (policy === "connect") { for (const path of ["/fetch", "/xhr", "/eventsource", "/beacon"]) assert((control.requests[path] ?? 0) > 0, path); assert((control.upgrades["/ws"] ?? 0) > 0); }
    if (policy === "frame" || policy === "object") { await waitFor(cdp, sessionId, "document.readyState === 'complete'"); await new Promise((done) => setImmediate(done)); assert((counts.get(`/executed-${policy}`) ?? 0) > 0); }
    if (policy === "worker") { assert(control.handlers.worker > 0); assert((control.requests["/executed-worker"] ?? 0) > 0); }
    if (policy === "base") assert((control.requests["/base-probe"] ?? 0) > 0);
    if (policy === "unsandboxed") { const origin = await cdp.evaluate(sessionId, "window.originEvidence"); assert.equal(origin.origin, appUrl); assert.equal(origin.storage, true); for (const path of ["/fetch", "/xhr", "/eventsource", "/beacon"]) assert.equal(control.requests[path] ?? 0, 0); }
  }
  result.positiveControls.formBlocked = await run("formBlocked", "form"); assert.equal(counts.get("/form") ?? 0, 0);
  clearCounts(); await navigate(viewUrl("formAllowed", "form")); await waitFor(cdp, sessionId, "window.auditDone === true"); await cdp.evaluate(sessionId, "window.submitAuditForm()");
  await until(() => (counts.get("/form") ?? 0) > 0, "Form control did not reach mock");
  result.positiveControls.formAllowed = snapshot();
  clearCounts(); await navigate(viewUrl("original", "connect")); await waitFor(cdp, sessionId, "window.auditDone === true");
  await cdp.evaluate(sessionId, `location.href = ${JSON.stringify(mockUrl + "/foreign")}`);
  await waitFor(cdp, sessionId, "window.foreignAttempts && Object.values(window.foreignAttempts).every(Boolean)");
  assert.equal(protectedCounts.bridge, 0, "daemon bridge called before cross-origin rejection");
  assert.equal(protectedCounts.action, 0); assert.equal(protectedCounts.socket, 0);
  const navDeadline = Date.now() + 6000; while (statuses.filter((s) => s.status === 403).length < 2) { assert(Date.now() < navDeadline, "Navigation guard observations missing"); await delay(10); }
  assert.equal(await cdp.evaluate(sessionId, "location.origin"), mockUrl); result.navigation = { statuses: [...statuses], handlers: { ...protectedCounts } }; assert(statuses.some((s) => s.path === "/api/audit/action" && s.status === 403)); assert(statuses.some((s) => s.path === "/api/audit/socket" && s.status === 403));
  const browserNavigation = { statuses: [...statuses], handlers: { ...protectedCounts } }; assert(statuses.some(s => s.path === "/api/audit/socket" && s.upgrade === "websocket" && s.origin === mockUrl && s.status === 403));
  const rejectedPost = await fetch(appUrl + "/api/audit/action", { method: "POST", headers: { origin: mockUrl }, body: "observer" });
  assert.equal(rejectedPost.status, 403); assert.equal(await rejectedPost.text(), '{"error":"Cross-origin request rejected"}');
  const rejectedSocket = await rawHandshake(appUrl.replace("http:", "ws:") + "/api/audit/socket", mockUrl); assert.deepEqual(rejectedSocket, { status: 403, body: '{"error":"Cross-origin request rejected"}' });
  const safeRead = await cdp.evaluate(sessionId, `fetch(${JSON.stringify(appUrl + "/api/audit/control")}).then(() => 'readable').catch(() => 'cors-blocked')`); assert.equal(safeRead, "cors-blocked");
  assert(statuses.some(s => s.path === "/api/audit/control" && s.origin === mockUrl && s.status === 200));
  result.navigation = { ...browserNavigation, rejectedPost: { status: 403, body: '{"error":"Cross-origin request rejected"}' }, rejectedSocket, foreignSafeGet: { serverStatus: 200, browserRead: safeRead }, bridgeCalls: protectedCounts.bridge };
  assert.equal(protectedCounts.action, 0); assert.equal(protectedCounts.socket, 0); assert.equal(protectedCounts.bridge, 0);
  clearCounts(); await navigate(appUrl + "/api/audit/control");
  const positive = await cdp.evaluate(sessionId, `(async () => { const action = await fetch('/api/audit/action', {method:'POST',body:'control'}); const socket = await new Promise((resolve,reject) => { const s = new WebSocket(${JSON.stringify(appUrl.replace("http:", "ws:") + "/api/audit/socket")}); s.onmessage=()=>{s.close();resolve(101)};s.onerror=reject; }); const daemonRequest = await fetch('/api/sessions', {method:'POST',headers:{'content-type':'application/json'},body:'{}'}); const daemonSocket = await new Promise((resolve,reject) => { const s = new WebSocket(${JSON.stringify(appUrl.replace("http:", "ws:") + "/api/events")}); s.onmessage=()=>{s.close();resolve(101)};s.onerror=reject; }); return {action:action.status,socket,daemonRequest:daemonRequest.status,daemonSocket}; })()`);
  assert.deepEqual(positive, { action: 200, socket: 101, daemonRequest: 200, daemonSocket: 101 }); assert.equal(protectedCounts.action, 1); assert.equal(protectedCounts.socket, 1); assert.equal(protectedCounts.bridge, 2); result.positiveControls.guard = { ...positive, handlers: { ...protectedCounts } };
  const finalOverrides = baselineOverrides();
  result.policyOverride = { baselineRequests: policyOverride.baselineRequests, baselineWrites: policyOverride.baselineWrites, baselineOverrides: finalOverrides, applications: [...policyOverride.applications] };
  assert.equal(policyOverride.baselineWrites, 0, "Policy override hook rewrote a baseline request during the audit");
  assert.deepEqual(finalOverrides, [], "Policy override hook rewrote a baseline request during the audit");
  result.passed = true;
} catch (error) { result.diagnostics.push(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; }
finally {
  try {
    cdpSocket?.terminate(); for (const socket of acceptedSockets) socket.terminate(); await stopBrowser();
    if (mockSockets) await new Promise(done => mockSockets.close(done));
    if (mock) { mock.closeAllConnections(); await new Promise((done) => mock.close(done)); }
    if (app) await app.close(); if (root) await rm(root, { recursive: true, force: true });
  } catch (error) { result.passed = false; process.exitCode = 1; result.diagnostics.push(`Cleanup failed: ${String(error)}`); }
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result, null, 2));
}
