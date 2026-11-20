#!/usr/bin/env node
/**
 * Deterministic Chromium gate for the narrow navigation header.
 *
 * Runs the production client components (real `appStyles`, real theme tokens, real
 * `PiWebUiApp` wiring) against a temporary Vite server, then asserts the layout,
 * accessibility, interaction, and PWA refresh-placement contracts with real geometry
 * and real Chromium input.
 *
 * Usage:
 *   node scripts/verify-narrow-navigation-header.mjs [--chrome-bin <executable>] [--source-overlay <directory>]
 *
 * Chromium is required. There is no skip path. This gate is deliberately not part of
 * `npm run verify`.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const CLIENT_ROOT = join(REPO_ROOT, "src", "client");

const FIXTURE_ROUTE = "/__narrow_navigation_header__/";
const FIXTURE_ENTRY_URL = "/__narrow_navigation_header__/entry.ts";
const FIXTURE_ENTRY_ID = "virtual:narrow-navigation-header/entry.ts";

/** The only two modules the negative control may replace. */
const OVERLAY_PATHS = [
  "src/client/src/components/MachineSwitcher.ts",
  "src/client/src/components/appShell/AppNavigationPanel.ts",
];

const EPSILON = 0.75;
const STARTUP_TIMEOUT_MS = 30_000;
const FIXTURE_READY_TIMEOUT_MS = 15_000;
const CDP_CALL_TIMEOUT_MS = 10_000;
const RUN_DEADLINE_MS = 300_000;
const CHILD_GRACE_MS = 2_000;
const CASE_BATCH_SIZE = 24;

const CHROMIUM_MISSING_MESSAGE = "Chromium was not found. Install chromium-browser/chromium or set CHROME_BIN=/path/to/chrome.";

const GEOMETRY_WIDTHS = [324, 340, 366, 370, 415, 416, 460, 600];
const NARROWEST_WIDTH = 324;
const WIDEST_WITH_ELIDED_LONG_NAME = 460;
const MACHINE_NAMES = ["short", "long"];
const STATUSES = ["online", "offline", "error", "unknown"];
const ACTIVITY_INPUTS = ["none", "session", "terminal", "both"];
const STANDALONE_WIDTHS = [149, 150, 151];
const DRAWER_WIDTHS = [324, 340, 366, 370, 371, 372, 415, 416, 460, 600];
const SWEEP_START = 324;
const SWEEP_END = 600;
const SWEEP_STEP = 2;
const SWEEP_ODD_BOUNDARY = 415;
const REFRESH_VIEWPORTS = [1600, 1181, 1180, 1100, 761, 760, 700];
const DESKTOP_VIEWPORT = { width: 1600, height: 900 };
const DRAWER_VIEWPORT = { width: 1100, height: 900 };
const STANDALONE_HOST_WIDTH = 150;

// ---------------------------------------------------------------------------
// Failure categories
// ---------------------------------------------------------------------------

/**
 * A categorised harness failure. Missing selectors, missing imports, runtime errors,
 * and layout defects are kept strictly apart so an old-source negative control cannot
 * masquerade as a layout failure.
 */
class HarnessError extends Error {
  constructor(category, message, context) {
    super(message);
    this.name = "HarnessError";
    this.category = category;
    this.context = context;
  }
}

function fail(category, message, context) {
  throw new HarnessError(category, message, context);
}

/** Runs `body`, re-raising assertion failures under `category` and `context`. */
function check(category, context, body) {
  try {
    body();
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    fail(category, error instanceof Error ? error.message : String(error), context);
  }
}

// The exact overlap primitives the specification mandates.
function intersection(a, b) {
  return {
    width: Math.min(a.right, b.right) - Math.max(a.left, b.left),
    height: Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
  };
}

function assertSeparate(a, b, label) {
  const overlap = intersection(a, b);
  assert.ok(!(overlap.width > EPSILON && overlap.height > EPSILON), `OVERLAP ${label}: ${JSON.stringify(overlap)}`);
}

function assertPositiveBox(box, what) {
  assert.ok(box !== undefined && box !== null, `${what} is absent`);
  assert.ok(Number.isFinite(box.width) && Number.isFinite(box.height), `${what} has a non-finite rect: ${JSON.stringify(box)}`);
  assert.ok(box.width > 0 && box.height > 0, `${what} has no positive box: ${JSON.stringify(box)}`);
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function caseLabel(context) {
  return Object.entries(context ?? {}).map(([key, value]) => `${key}=${String(value)}`).join(" ");
}

// ---------------------------------------------------------------------------
// Vite child: serves the fixture and the two-module source overlay
// ---------------------------------------------------------------------------

async function runViteChild(args) {
  const { tempRoot, overlayRoot } = parseChildArgs(args);
  const cacheDir = join(tempRoot, "vite-cache");
  await mkdir(cacheDir, { recursive: true });

  const send = (message) => {
    if (process.channel === undefined) return;
    process.send?.(message);
  };

  const overlayApplied = new Set();
  let vite;
  let httpServer;
  try {
    const replacements = await loadOverlaySources(overlayRoot);
    const { createServer } = await import("vite");
    vite = await createServer({
      configFile: false,
      root: CLIENT_ROOT,
      cacheDir,
      appType: "custom",
      logLevel: "warn",
      server: { host: "127.0.0.1", port: 0, middlewareMode: true, hmr: false, fs: { strict: false } },
      plugins: [
        fixturePlugin(),
        ...(replacements === undefined ? [] : [overlayPlugin(replacements, overlayApplied)]),
      ],
    });
    // Middleware mode never reserves a default port, so the harness owns a real HTTP
    // server bound to port 0 and concurrent runs cannot collide on 5173.
    httpServer = createHttpServer((request, response) => {
      const url = request.url === undefined ? "/" : request.url;
      const path = new URL(url, "http://127.0.0.1").pathname;
      if (path === FIXTURE_ROUTE || path === `${FIXTURE_ROUTE}index.html`) {
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(FIXTURE_HTML_SOURCE);
        return;
      }
      vite.middlewares(request, response, () => {
        response.statusCode = 404;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.end("Not found");
      });
    });
    await new Promise((resolveListen, rejectListen) => {
      httpServer.once("error", rejectListen);
      httpServer.listen(0, "127.0.0.1", () => { resolveListen(); });
    });
  } catch (error) {
    send({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack ?? "" : "",
    });
    process.exitCode = 1;
    return;
  }

  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : undefined;
  if (port === undefined) {
    send({ type: "error", message: "The harness HTTP server did not report a listening port" });
    await vite.close();
    process.exitCode = 1;
    return;
  }
  send({ type: "ready", port });

  await new Promise((resolveShutdown) => {
    let finished = false;
    const stop = () => {
      if (finished) return;
      finished = true;
      resolveShutdown();
    };
    process.on("message", (message) => {
      if (message === null || typeof message !== "object") return;
      if (message.type === "overlay-status") {
        send({ type: "overlay-status", applied: [...overlayApplied], expected: OVERLAY_PATHS });
        return;
      }
      if (message.type === "shutdown") stop();
    });
    process.once("disconnect", stop);
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });

  await new Promise((resolveClose) => { httpServer.close(() => { resolveClose(); }); });
  await vite.close();
}

function parseChildArgs(args) {
  let tempRoot;
  let overlayRoot;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--vite-child") continue;
    if (arg === "--temp-root") {
      tempRoot = requireChildValue(args, ++index, arg);
      continue;
    }
    if (arg.startsWith("--temp-root=")) {
      tempRoot = arg.slice("--temp-root=".length);
      continue;
    }
    if (arg === "--source-overlay") {
      overlayRoot = requireChildValue(args, ++index, arg);
      continue;
    }
    if (arg.startsWith("--source-overlay=")) {
      overlayRoot = arg.slice("--source-overlay=".length);
      continue;
    }
    childFail(`Unknown child argument: ${arg}`);
  }
  if (tempRoot === undefined || tempRoot === "") childFail("--temp-root is required in --vite-child mode");
  return { tempRoot: resolve(tempRoot), overlayRoot: overlayRoot === undefined ? undefined : resolve(overlayRoot) };
}

function requireChildValue(args, index, flag) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) childFail(`${flag} requires a value`);
  return value;
}

function childFail(message) {
  console.error(`verify-narrow-navigation-header (child): ${message}`);
  process.exit(2);
}

/**
 * Reads both overlay sources up front. A missing or unreadable file is an error,
 * never a silent skip.
 */
async function loadOverlaySources(overlayRoot) {
  if (overlayRoot === undefined) return undefined;
  const overlayStat = await stat(overlayRoot).catch(() => undefined);
  if (overlayStat === undefined || !overlayStat.isDirectory()) {
    throw new Error(`--source-overlay is not a directory: ${overlayRoot}`);
  }
  const loaded = [];
  for (const repoRelativePath of OVERLAY_PATHS) {
    const absoluteOverlay = resolve(overlayRoot, repoRelativePath);
    const source = await readFile(absoluteOverlay, "utf8").catch((error) => {
      throw new Error(`Unable to read overlay source ${absoluteOverlay}: ${error instanceof Error ? error.message : String(error)}`);
    });
    loaded.push({ repoRelativePath, absoluteSource: resolve(REPO_ROOT, repoRelativePath), absoluteOverlay, source });
  }
  return loaded;
}

/** Serves the harness-only virtual fixture module. */
function fixturePlugin() {
  return {
    name: "narrow-navigation-header-fixture",
    enforce: "pre",
    resolveId(id) {
      if (id === FIXTURE_ENTRY_ID || id === FIXTURE_ENTRY_URL) return FIXTURE_ENTRY_ID;
      return null;
    },
    load(id) {
      if (id === FIXTURE_ENTRY_ID) return FIXTURE_ENTRY_SOURCE;
      return null;
    },
  };
}

/**
 * Replaces exactly the two overlayed production modules while keeping their canonical
 * ids, so relative imports still resolve inside the current tree and each custom element
 * keeps a single module identity. Nothing else is overlaid.
 */
function overlayPlugin(replacements, applied) {
  const byId = new Map();
  for (const replacement of replacements) {
    byId.set(replacement.absoluteSource, replacement);
    console.log(`Overlay replacement: ${replacement.repoRelativePath} <- ${replacement.absoluteOverlay}`);
  }
  return {
    name: "narrow-navigation-header-source-overlay",
    enforce: "pre",
    load(id) {
      const replacement = byId.get(stripViteQuery(id));
      if (replacement === undefined) return null;
      applied.add(replacement.repoRelativePath);
      return replacement.source;
    },
  };
}

function stripViteQuery(id) {
  const queryIndex = id.indexOf("?");
  return queryIndex === -1 ? id : id.slice(0, queryIndex);
}

// ---------------------------------------------------------------------------
// Parent runner: bounded process protocol and cleanup
// ---------------------------------------------------------------------------

async function runParent(args) {
  const options = parseParentArgs(args);

  let chromeBin;
  try {
    chromeBin = resolveChromeBinary(options.chromeBin);
  } catch (error) {
    if (error instanceof HarnessError) {
      console.error(`FAIL [${error.category}] ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "pi-webui-narrow-header-"));
  const logsDir = join(tempRoot, "logs");
  await mkdir(logsDir, { recursive: true });

  const state = {
    tempRoot,
    logsDir,
    child: undefined,
    chrome: undefined,
    cdp: undefined,
    summary: undefined,
    cleanedUp: false,
    warnings: [],
    instanceId: undefined,
    overlay: options.overlayRoot,
    apiProbe: process.env["PI_WEBUI_NARROW_HEADER_API_PROBE"],
  };

  const deadline = setTimeout(() => {
    console.error(`FAIL [FIXTURE_RUNTIME] Run exceeded its ${String(RUN_DEADLINE_MS / 1000)}s deadline.`);
    process.exitCode = 1;
    void cleanup(state, { retainLogs: true }).finally(() => { process.exit(1); });
  }, RUN_DEADLINE_MS);
  deadline.unref?.();

  const onSignal = (signal) => {
    console.error(`Received ${signal}; cleaning up bounded child processes.`);
    void cleanup(state, { retainLogs: true }).finally(() => {
      process.exit(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);

  try {
    const server = await startViteChild(state, options.overlayRoot);
    const debuggingPort = await startChromium(state, chromeBin);
    const cdp = await connectToPage(state, debuggingPort);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: DESKTOP_VIEWPORT.width,
      height: DESKTOP_VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const fixtureUrl = `http://127.0.0.1:${String(server.port)}${FIXTURE_ROUTE}`;
    await navigate(cdp, fixtureUrl);
    await waitForFixture(cdp);
    await injectUnexpectedApiRequest(cdp, state, "before-reload");
    if (options.overlayRoot !== undefined) {
      const overlay = await queryOverlayStatus(state);
      const applied = Array.isArray(overlay.applied) ? overlay.applied : [];
      const missing = OVERLAY_PATHS.filter((repoRelativePath) => !applied.includes(repoRelativePath));
      if (missing.length > 0) {
        fail("FIXTURE_IMPORT", `The source overlay was never applied to: ${missing.join(", ")}. Applied: ${JSON.stringify(applied)}`);
      }
    }
    state.instanceId = await callFixture(cdp, "instanceId");

    const summary = await runScenarios({ cdp, fixtureUrl, state, chromeBin });
    summary.chrome = chromeBin;
    summary.overlay = options.overlayRoot ?? null;
    state.summary = summary;

    console.log(`\nChrome: ${chromeBin}`);
    console.log(`Overlay: ${options.overlayRoot ?? "(none)"}`);
    console.log(`Tested cases: ${String(summary.testedCases)}`);
    console.log(`JSON ${JSON.stringify(summary)}`);
  } catch (error) {
    reportFailure(error, state);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGHUP", onSignal);
    await cleanup(state, { retainLogs: process.exitCode !== undefined && process.exitCode !== 0 });
  }
}

function parseParentArgs(args) {
  let chromeBin;
  let overlayRoot;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/verify-narrow-navigation-header.mjs [--chrome-bin <executable>] [--source-overlay <directory>]

Verifies narrow navigation header geometry, accessibility, native input, and PWA refresh
placement in Chromium. Requires CHROME_BIN or a discoverable Chromium; there is no skip path.`);
      process.exit(0);
    }
    if (arg === "--chrome-bin") {
      chromeBin = requireParentValue(args, ++index, arg);
      continue;
    }
    if (arg.startsWith("--chrome-bin=")) {
      chromeBin = arg.slice("--chrome-bin=".length);
      continue;
    }
    if (arg === "--source-overlay") {
      overlayRoot = requireParentValue(args, ++index, arg);
      continue;
    }
    if (arg.startsWith("--source-overlay=")) {
      overlayRoot = arg.slice("--source-overlay=".length);
      continue;
    }
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }
  return { chromeBin, overlayRoot: overlayRoot === undefined ? undefined : resolve(overlayRoot) };
}

function requireParentValue(args, index, flag) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    console.error(`${flag} requires a value`);
    process.exit(2);
  }
  return value;
}

/** An explicit-but-invalid executable is an error; it never falls back to discovery. */
function resolveChromeBinary(explicit) {
  const configured = explicit ?? process.env["CHROME_BIN"];
  if (configured !== undefined && configured !== "") {
    const resolved = resolve(configured);
    if (!existsSync(resolved)) {
      fail("SETUP", `Chromium executable not found: ${resolved}. Unset CHROME_BIN or point it at a real Chromium binary.`);
    }
    return resolved;
  }
  const discovered = findChrome();
  if (discovered === undefined) fail("SETUP", CHROMIUM_MISSING_MESSAGE);
  return discovered;
}

function findChrome() {
  for (const candidate of ["chromium-browser", "chromium", "google-chrome", "google-chrome-stable"]) {
    for (const directory of (process.env["PATH"] ?? "").split(":")) {
      if (directory === "") continue;
      const candidatePath = join(directory, candidate);
      if (existsSync(candidatePath)) return candidatePath;
    }
  }
  return undefined;
}

async function startViteChild(state, overlayRoot) {
  const childArgs = [SCRIPT_PATH, "--vite-child", "--temp-root", state.tempRoot];
  if (overlayRoot !== undefined) childArgs.push("--source-overlay", overlayRoot);
  const logPath = join(state.logsDir, "vite-child.log");
  const child = spawn(process.execPath, childArgs, {
    cwd: REPO_ROOT,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  state.child = child;
  state.childRequests = new Map();
  pipeChildLogs(child, logPath, "vite");

  return await new Promise((resolveStart, rejectStart) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      settle(rejectStart, new HarnessError("FIXTURE_IMPORT", `Vite child did not report readiness within ${String(STARTUP_TIMEOUT_MS)}ms (log: ${logPath})`));
    }, STARTUP_TIMEOUT_MS);
    child.on("message", (message) => {
      if (message === null || typeof message !== "object") return;
      if (message.type === "ready") {
        settle(resolveStart, { port: message.port });
        return;
      }
      if (message.type === "error") {
        settle(rejectStart, new HarnessError("FIXTURE_IMPORT", `Vite child failed: ${String(message.message)}\n${String(message.stack ?? "")}`));
        return;
      }
      if (message.type === "overlay-status") {
        const pending = state.childRequests.get("overlay-status");
        if (pending !== undefined) {
          state.childRequests.delete("overlay-status");
          pending.resolve(message);
        }
      }
    });
    child.once("error", (error) => {
      settle(rejectStart, new HarnessError("FIXTURE_IMPORT", `Vite child failed to spawn: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      settle(rejectStart, new HarnessError("FIXTURE_IMPORT", `Vite child exited before readiness (code ${String(code)}, signal ${String(signal)}). Log: ${logPath}`));
    });
  });
}

function queryOverlayStatus(state) {
  return new Promise((resolveStatus, rejectStatus) => {
    const child = state.child;
    if (child === undefined) {
      rejectStatus(new HarnessError("FIXTURE_IMPORT", "The Vite child is not running"));
      return;
    }
    const timer = setTimeout(() => {
      state.childRequests.delete("overlay-status");
      rejectStatus(new HarnessError("FIXTURE_IMPORT", "The Vite child did not report its applied overlay modules within 5000ms"));
    }, 5_000);
    state.childRequests.set("overlay-status", {
      resolve: (message) => { clearTimeout(timer); resolveStatus(message); },
    });
    child.send?.({ type: "overlay-status" });
  });
}

function pipeChildLogs(child, logPath, label) {
  const write = (chunk) => {
    const text = Buffer.from(chunk).toString("utf8");
    process.stderr.write(text.startsWith("[") ? text : `[${label}] ${text}`);
    void mkdir(dirname(logPath), { recursive: true })
      .then(() => writeFile(logPath, chunk, { flag: "a" }))
      .catch(() => undefined);
  };
  child.stdout?.on("data", write);
  child.stderr?.on("data", write);
}

async function startChromium(state, chromeBin) {
  await mkdir(state.profileDir ?? join(state.tempRoot, "chrome-profile"), { recursive: true });
  const profileDir = join(state.tempRoot, "chrome-profile");
  state.profileDir = profileDir;
  const logPath = join(state.logsDir, "chromium.log");
  const child = spawn(chromeBin, chromeArgs(profileDir), {
    cwd: REPO_ROOT,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.chrome = child;
  pipeChildLogs(child, logPath, "chromium");

  const portFile = join(profileDir, "DevToolsActivePort");
  const started = Date.now();
  while (Date.now() - started < STARTUP_TIMEOUT_MS) {
    if (child.exitCode !== null) {
      fail("SETUP", `Chromium exited with code ${String(child.exitCode)} before exposing a debugging port (log: ${logPath})`);
    }
    const text = await readFile(portFile, "utf8").catch(() => undefined);
    if (text !== undefined) {
      const [portLine] = text.split("\n");
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && port < 65_536) return port;
    }
    await sleep(100);
  }
  fail("SETUP", `Chromium did not expose a debugging port within ${String(STARTUP_TIMEOUT_MS)}ms (log: ${logPath})`);
}

function chromeArgs(profileDir) {
  return [
    "--headless=new",
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${profileDir}`,
    `--window-size=${String(DESKTOP_VIEWPORT.width)},${String(DESKTOP_VIEWPORT.height)}`,
    "--force-device-scale-factor=1",
    "--hide-scrollbars",
    "--disable-background-networking",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--no-default-browser-check",
    "--no-first-run",
    "--no-sandbox",
    "--mute-audio",
    "about:blank",
  ];
}

async function connectToPage(state, debuggingPort) {
  const listResponse = await fetch(`http://127.0.0.1:${String(debuggingPort)}/json/list`);
  if (!listResponse.ok) {
    fail("SETUP", `Unable to list Chromium targets: ${String(listResponse.status)} ${listResponse.statusText}`);
  }
  const targets = await listResponse.json();
  const page = Array.isArray(targets) ? targets.find((target) => target["type"] === "page") : undefined;
  if (page === undefined) fail("SETUP", "Chromium exposed no page target");
  const cdp = await CdpConnection.connect(String(page["webSocketDebuggerUrl"]));
  state.cdp = cdp;
  cdp.onEvent("Runtime.exceptionThrown", (params) => {
    const detail = params.exceptionDetails;
    const description = detail?.exception?.description ?? detail?.text ?? "unknown exception";
    state.warnings.push(`Page exception: ${String(description).split("\n")[0]}`);
  });
  cdp.onEvent("Runtime.consoleAPICalled", (params) => {
    if (params.type !== "error" && params.type !== "warning") return;
    const text = (params.args ?? []).map((arg) => String(arg.value ?? arg.description ?? "")).join(" ");
    if (text !== "") state.warnings.push(`console.${String(params.type)}: ${text.split("\n")[0]}`);
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  return cdp;
}

/**
 * Idempotent bounded cleanup: page, CDP, Vite child, Chromium, temp tree. A failing
 * or interrupted run retains its bounded logs directory so the printed location stays
 * usable; the profile, cache, and DevTools port directory are always removed.
 */
async function cleanup(state, options = {}) {
  if (state.cleanedUp) return;
  state.cleanedUp = true;
  let failure;
  try {
    if (state.cdp !== undefined) {
      await state.cdp.send("Browser.close").catch(() => undefined);
      state.cdp.close();
      state.cdp = undefined;
    }
    if (state.child !== undefined) {
      try { state.child.send?.({ type: "shutdown" }); } catch { /* channel already gone */ }
      state.child.disconnect?.();
      await terminate(state.child, CHILD_GRACE_MS);
      state.child = undefined;
    }
    if (state.chrome !== undefined) {
      await terminate(state.chrome, CHILD_GRACE_MS);
      state.chrome = undefined;
    }
    if (options.retainLogs === true) {
      await removeWithRetries(state.profileDir ?? join(state.tempRoot, "chrome-profile"));
      await removeWithRetries(join(state.tempRoot, "vite-cache"));
      console.error(`Logs retained at ${state.logsDir}`);
    } else {
      await removeWithRetries(state.tempRoot);
    }
  } catch (error) {
    failure = error;
  }
  if (failure !== undefined) {
    console.error(`FAIL [CLEANUP] ${failure instanceof Error ? failure.message : String(failure)}`);
    process.exitCode = 1;
  }
}

async function terminate(child, graceMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => { child.once("exit", resolveExit); });
  child.kill("SIGTERM");
  const softExited = await Promise.race([exited.then(() => true), sleep(graceMs).then(() => false)]);
  if (softExited) return;
  child.kill("SIGKILL");
  await Promise.race([exited, sleep(graceMs)]);
}

async function removeWithRetries(path) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await sleep(100 * (attempt + 1));
    }
  }
  throw lastError;
}

function reportFailure(error, state) {
  if (error instanceof HarnessError) {
    console.error(`\nFAIL [${error.category}] ${error.message}`);
    if (error.context !== undefined) console.error(`  case: ${caseLabel(error.context)}`);
  } else {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(`\nFAIL [FIXTURE_RUNTIME] ${message}`);
  }
  if (state.warnings.length > 0) {
    console.error("  page messages:");
    for (const warning of state.warnings.slice(0, 20)) console.error(`   - ${warning}`);
  }
  console.error(`  logs: ${state.logsDir}`);
}

// ---------------------------------------------------------------------------
// CDP transport
// ---------------------------------------------------------------------------

class CdpConnection {
  static connect(url) {
    return new Promise((resolveConnect, rejectConnect) => {
      const socket = new WebSocket(url);
      const connection = new CdpConnection(socket);
      socket.addEventListener("open", () => { resolveConnect(connection); }, { once: true });
      socket.addEventListener("error", () => {
        rejectConnect(new HarnessError("SETUP", "Chromium DevTools websocket failed to open"));
      }, { once: true });
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    socket.addEventListener("message", (event) => { this.onMessage(event); });
    socket.addEventListener("close", () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        pending.reject(new HarnessError("FIXTURE_RUNTIME", "Chromium DevTools websocket closed with a call in flight"));
      }
      this.pending.clear();
    });
  }

  onEvent(method, listener) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
  }

  removeEventListeners(method) {
    this.listeners.delete(method);
  }

  send(method, params = {}) {
    if (this.closed) {
      return Promise.reject(new HarnessError("FIXTURE_RUNTIME", `CDP connection is closed (${method})`));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new HarnessError("FIXTURE_RUNTIME", `CDP call ${method} timed out after ${String(CDP_CALL_TIMEOUT_MS)}ms`));
      }, CDP_CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolveSend(value); },
        reject: (error) => { clearTimeout(timer); rejectSend(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitForEvent(method, timeoutMs) {
    return new Promise((resolveEvent, rejectEvent) => {
      const listener = (params) => {
        clearTimeout(timer);
        this.listeners.set(method, (this.listeners.get(method) ?? []).filter((entry) => entry !== listener));
        resolveEvent(params);
      };
      const timer = setTimeout(() => {
        this.listeners.set(method, (this.listeners.get(method) ?? []).filter((entry) => entry !== listener));
        rejectEvent(new HarnessError("FIXTURE_RUNTIME", `Timed out waiting for ${method}`));
      }, timeoutMs);
      this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.close(); } catch { /* already gone */ }
  }

  onMessage(event) {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(new HarnessError("FIXTURE_RUNTIME", `CDP error: ${JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method !== undefined) {
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
    }
  }
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function navigate(cdp, url) {
  const loaded = cdp.waitForEvent("Page.loadEventFired", 20_000).catch(() => undefined);
  await cdp.send("Page.navigate", { url });
  await loaded;
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails !== undefined) {
    fail("FIXTURE_RUNTIME", `Browser evaluation failed: ${JSON.stringify(response.exceptionDetails)}`);
  }
  const result = response.result;
  if (result?.subtype === "error") {
    fail("FIXTURE_RUNTIME", `Browser evaluation produced an error value: ${String(result.description ?? "")}`);
  }
  return result?.value;
}

/** Calls a fixture method and unwraps its structured `{ok, value}` envelope. */
async function callFixture(cdp, method, ...args) {
  const expression = `window.__narrowHeaderFixture[${JSON.stringify(method)}](${args.map((arg) => JSON.stringify(arg)).join(", ")})`;
  const result = await evaluate(cdp, expression);
  if (result === null || typeof result !== "object") {
    fail("FIXTURE_RUNTIME", `Fixture method ${method} returned ${JSON.stringify(result)} instead of a result envelope`);
  }
  if (result.ok !== true) {
    fail(result.category ?? "FIXTURE_RUNTIME", `${method}: ${String(result.message)}`, result.context);
  }
  return result.value;
}

async function waitForFixture(cdp) {
  const started = Date.now();
  let lastErrors = [];
  let probeBootError = null;
  while (Date.now() - started < FIXTURE_READY_TIMEOUT_MS) {
    const probe = await evaluate(cdp, `(() => {
      const fixture = window.__narrowHeaderFixture;
      return {
        ready: fixture !== null && typeof fixture === "object" && fixture.ready === true,
        bootError: fixture !== null && typeof fixture === "object" ? fixture.bootError : null,
        errors: window.__harnessErrors ?? [],
      };
    })()`).catch(() => undefined);
    if (probe?.ready === true) return;
    lastErrors = probe?.errors ?? [];
    probeBootError = probe?.bootError ?? null;
    if (lastErrors.length > 0 || probeBootError !== null) break;
    await sleep(100);
  }
  fail("FIXTURE_IMPORT", `The fixture did not become ready. Page errors: ${JSON.stringify(lastErrors)} bootError: ${String(probeBootError)}`);
}

async function setViewport(cdp, width, height) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
}

async function mouseClick(cdp, point) {
  const base = { x: point.x, y: point.y, button: "left", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base, buttons: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, buttons: 0 });
}

async function pressKey(cdp, sequence) {
  await cdp.send("Input.dispatchKeyEvent", sequence.down);
  await cdp.send("Input.dispatchKeyEvent", sequence.up);
}

const KEY_ENTER = {
  down: { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" },
  up: { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
};
const KEY_SPACE = {
  down: { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: " ", unmodifiedText: " " },
  up: { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 },
};
const KEY_ESCAPE = {
  down: { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  up: { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
};

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function runScenarios({ cdp, fixtureUrl, state }) {
  const summary = {
    status: "pass",
    viewport: DESKTOP_VIEWPORT,
    geometryWidths: GEOMETRY_WIDTHS,
    drawerWidths: DRAWER_WIDTHS,
    standaloneWidths: STANDALONE_WIDTHS,
    refreshViewports: REFRESH_VIEWPORTS,
    testedCases: 0,
    stages: [],
  };
  const counters = {};

  const stage = async (name, body) => {
    const started = Date.now();
    await body();
    summary.stages.push({ name, ms: Date.now() - started });
  };
  const count = (category, amount = 1) => {
    counters[category] = (counters[category] ?? 0) + amount;
    summary.testedCases += amount;
  };

  // Geometry and readability come first: an unchanged 1.26.0 module must reach a real
  // layout assertion, not a missing-selector or refresh-difference error.
  await stage("fixture-environment", async () => {
    await assertFixtureEnvironment(cdp);
    count("BOUNDARY", 2);
  });

  await stage("geometry-matrix", async () => {
    await runGeometryMatrix(cdp, count);
  });

  await stage("version-boundary", async () => {
    await runVersionBoundary(cdp, count);
  });

  await stage("health-word-boundary", async () => {
    await runHealthWordBoundary(cdp, count);
  });

  await stage("standalone-switcher", async () => {
    await runStandaloneMatrix(cdp, count);
  });

  await stage("monotonicity-sweep", async () => {
    await runMonotonicitySweep(cdp, count);
  });

  await stage("drawer-geometry", async () => {
    await runDrawerGeometry(cdp, count);
  });

  await stage("menu-anchor", async () => {
    await runMenuAnchor(cdp, count);
  });

  await stage("native-input", async () => {
    await runNativeInput(cdp, count);
  });

  await stage("refresh-placement", async () => {
    await runRefreshPlacement(cdp, fixtureUrl, state, count);
  });

  await stage("reload-activation", async () => {
    await runReloadActivation(cdp, state, count);
  });

  const guardProbe = await callFixture(cdp, "probeApiGuard");
  check("FIXTURE_RUNTIME", { stage: "api-guard-self-check" }, () => {
    assert.equal(guardProbe.recorded.length, 1, `the XMLHttpRequest guard did not record exactly one application request: ${JSON.stringify(guardProbe)}`);
    assert.match(guardProbe.recorded[0], /^xhr .*\/api\//, `the XMLHttpRequest guard did not record the application request as an xhr entry: ${JSON.stringify(guardProbe.recorded)}`);
    assert.equal(guardProbe.blocked, true, `the XMLHttpRequest guard did not block the application request: ${JSON.stringify(guardProbe)}`);
    assert.equal(guardProbe.passThroughBlocked, false, `the XMLHttpRequest guard blocked a non-application request: ${JSON.stringify(guardProbe)}`);
    assert.deepEqual(guardProbe.passThroughRecorded, [], `the XMLHttpRequest guard recorded a non-application request: ${JSON.stringify(guardProbe.passThroughRecorded)}`);
    assert.equal(guardProbe.remainingCount, guardProbe.baseline, "the guard self-check disturbed the recorded application-request list");
  });

  const violations = await callFixture(cdp, "readApiViolations");
  check("FIXTURE_RUNTIME", { stage: "api-guard" }, () => {
    assert.deepEqual(violations, [], `the fixture made unexpected application network requests: ${JSON.stringify(violations)}`);
  });

  summary.categories = counters;
  if (state.warnings.length > 0) summary.warnings = state.warnings.slice(0, 20);
  return summary;
}

async function assertFixtureEnvironment(cdp) {
  const info = await callFixture(cdp, "info");
  check("FIXTURE_IMPORT", { stage: "environment" }, () => {
    assert.equal(info.version, "1.26.0", "the fixture must render the 1.26.0 runtime version");
    assert.equal(info.appStylesMatches, true, "PiWebUiApp.styles must be the production appStyles");
    assert.notEqual(info.appInlineDisplay, "inline", "the production host stylesheet must style the pi-webui-app host");
  });
  check("BOUNDARY", { stage: "theme" }, () => {
    assert.equal(info.themeId, "themes:pi-webui-dark", "the pi-webui-dark theme contribution must be applied");
    assert.deepEqual(info.missingThemeTokens, [], `theme tokens missing from the document root: ${JSON.stringify(info.missingThemeTokens)}`);
    assert.deepEqual(info.mismatchedThemeTokens, [], `theme token values disagree with the pi-webui-dark contribution: ${JSON.stringify(info.mismatchedThemeTokens)}`);
  });
  const contract = await callFixture(cdp, "readFixtureContract");
  check("FIXTURE_RUNTIME", { stage: "fixture-contract" }, () => {
    assert.equal(contract.hasApp, true, "window.__narrowHeaderFixture.app must expose the mounted PiWebUiApp element");
    assert.equal(contract.appIsProductionElement, true, "window.__narrowHeaderFixture.app must be the production PiWebUiApp element");
    assert.equal(contract.labelText, contract.requestedName, `setMachine resolved before the new machine name rendered: ${JSON.stringify(contract)}`);
  });
}

// -- Geometry matrix --------------------------------------------------------

async function runGeometryMatrix(cdp, count) {
  const specs = [];
  for (const width of GEOMETRY_WIDTHS) {
    for (const name of MACHINE_NAMES) {
      for (const status of STATUSES) {
        for (const activity of ACTIVITY_INPUTS) specs.push({ width, name, status, activity });
      }
    }
  }
  for (const batch of chunks(specs, CASE_BATCH_SIZE)) {
    const snapshots = await callFixture(cdp, "runCases", batch);
    assert.equal(snapshots.length, batch.length, "the fixture returned a different number of cases than requested");
    for (const [index, snapshot] of snapshots.entries()) {
      assertGeometryCase(snapshot, batch[index]);
      count("GEOMETRY");
    }
  }
}

function assertGeometryCase(snapshot, spec) {
  const context = { width: spec.width, name: spec.name, status: spec.status, activity: spec.activity, stage: "geometry" };

  check("BOUNDARY", context, () => {
    assert.ok(Math.abs(snapshot.outer.width - spec.width) <= EPSILON, `outer column resolved to ${String(snapshot.outer.width)}, expected ${String(spec.width)}`);
    const expectedInner = snapshot.viewport.width >= 1181 ? spec.width - 44 : spec.width;
    assert.ok(Math.abs(snapshot.inner.width - expectedInner) <= EPSILON, `inner panel resolved to ${String(snapshot.inner.width)}, expected ${String(expectedInner)}`);
    assert.ok(Math.abs(snapshot.shellNavigationSize - spec.width) <= EPSILON, `--navigation-panel-size resolved to ${String(snapshot.shellNavigationSize)}, expected ${String(spec.width)}`);
  });

  // Presence and positive boxes strictly before any comparison.
  check("KICKER_FIT", context, () => assertPositiveBox(snapshot.kicker.rect, "the kicker"));
  check("READABILITY", context, () => assertPositiveBox(snapshot.label.rect, "the machine name"));
  check("READABILITY", context, () => assertPositiveBox(snapshot.status.rect, "the machine health indicator"));
  check("READABILITY", context, () => assertPositiveBox(snapshot.chevron.rect, "the machine chevron"));
  check("READABILITY", context, () => assertPositiveBox(snapshot.button.rect, "the selected machine button"));
  check("OVERLAP", context, () => assertPositiveBox(snapshot.header.rect, "the navigation header"));
  check("OVERLAP", context, () => assertPositiveBox(snapshot.brand.rect, "the brand"));
  check("OVERLAP", context, () => assertPositiveBox(snapshot.brandSymbol.rect, "the π symbol"));
  check("OVERLAP", context, () => assertPositiveBox(snapshot.brandWordmark.rect, "the WebUI wordmark"));
  check("OVERLAP", context, () => assertPositiveBox(snapshot.actions.rect, "the header Actions button"));
  check("READABILITY", context, () => assertPositiveBox(snapshot.textColumn.rect, "the machine text column"), );

  const activityExpected = (spec.status === "online" || spec.status === "unknown") && spec.activity !== "none";
  if (activityExpected) {
    check("READABILITY", context, () => assertPositiveBox(snapshot.activity?.rect, `the activity indicator (${spec.status}/${spec.activity})`));
  } else {
    check("READABILITY", context, () => {
      assert.equal(snapshot.activity, null, `an activity indicator must not render for ${spec.status}/${spec.activity}`);
    });
  }

  // Activity precedence: session wins over terminal, and both are suppressed for
  // offline and error (already asserted above).
  if (activityExpected) {
    check("READABILITY", context, () => {
      const className = String(snapshot.activity?.className ?? "");
      if (spec.activity === "both" || spec.activity === "session") {
        assert.ok(className.includes("session"), `expected the session activity indicator, got "${className}"`);
      } else {
        assert.ok(className.includes("terminal"), `expected the terminal activity indicator, got "${className}"`);
      }
    });
  }

  // Overlap set: every pair in two dimensions, including the vertically separated
  // kicker/name rows, where a gap on either axis means no overlap.
  check("OVERLAP", context, () => {
    const nodes = [
      ["kicker", snapshot.kicker.rect],
      ["name", snapshot.label.rect],
      ["health", snapshot.status.rect],
      ["chevron", snapshot.chevron.rect],
    ];
    if (snapshot.activity !== null) nodes.push(["activity", snapshot.activity.rect]);
    for (let first = 0; first < nodes.length; first += 1) {
      for (let second = first + 1; second < nodes.length; second += 1) {
        const [leftName, leftRect] = nodes[first];
        const [rightName, rightRect] = nodes[second];
        assertSeparate(leftRect, rightRect, `${leftName}/${rightName}`);
      }
    }
    assertSeparate(snapshot.textColumn.rect, snapshot.status.rect, "text-column/health");
    assertSeparate(snapshot.textColumn.rect, snapshot.chevron.rect, "text-column/chevron");
    if (snapshot.activity !== null) {
      assertSeparate(snapshot.textColumn.rect, snapshot.activity.rect, "text-column/activity");
    }
    assertSeparate(snapshot.brand.rect, snapshot.button.rect, "brand/switcher");
    assertSeparate(snapshot.button.rect, snapshot.actions.rect, "switcher/actions");
    assertSeparate(snapshot.brand.rect, snapshot.actions.rect, "brand/actions");
  });

  // Kicker integrity in its real font.
  check("KICKER_FIT", context, () => assertKickerFits(snapshot.kicker));

  // Text floor and containment.
  check("READABILITY", context, () => {
    assert.ok(snapshot.textColumn.rect.width >= 48 - EPSILON, `machine text column is ${String(snapshot.textColumn.rect.width)}px, below the 48px floor`);
    assert.ok(snapshot.button.scrollWidth <= snapshot.button.clientWidth, `selected button overflows: scrollWidth ${String(snapshot.button.scrollWidth)} > clientWidth ${String(snapshot.button.clientWidth)}`);
    assert.ok(snapshot.header.scrollWidth <= snapshot.header.clientWidth, `header overflows: scrollWidth ${String(snapshot.header.scrollWidth)} > clientWidth ${String(snapshot.header.clientWidth)}`);
  });

  // Name readability and truncation.
  check("READABILITY", context, () => assertNameReadable(snapshot.label, spec));

  // Identity stays recoverable through the tooltip and accessible name.
  check("READABILITY", context, () => {
    assert.ok(String(snapshot.button.title ?? "").includes(snapshot.label.text), `button title ${JSON.stringify(snapshot.button.title)} does not carry the full machine name`);
    assert.equal(snapshot.button.ariaLabel, `Machine: ${snapshot.label.text}. Switch machine.`);
  });
}

function assertKickerFits(kicker) {
  assert.equal(kicker.whiteSpace, "nowrap", `the kicker must not wrap: white-space is "${kicker.whiteSpace}"`);
  assert.equal(kicker.lineCount, 1, `the kicker must render on one line, rendered ${String(kicker.lineCount)} line boxes`);
  assert.equal(kicker.rendered, "MACHINE", `the kicker renders as ${JSON.stringify(kicker.rendered)}`);
  assert.ok(Number.isFinite(kicker.advance) && kicker.advance > 0, `the kicker has no measurable advance: ${String(kicker.advance)}`);
  assert.ok(kicker.advance <= kicker.rect.width + EPSILON, `the kicker advance ${kicker.advance.toFixed(2)}px exceeds its laid-out width ${kicker.rect.width.toFixed(2)}px`);
  const crossCheck = kicker.canvasMeasure + kicker.letterSpacing * kicker.rendered.length;
  assert.ok(Number.isFinite(crossCheck), `canvas measureText failed for the kicker at ${kicker.fontSize}`);
  assert.ok(Math.abs(crossCheck - kicker.advance) <= 1.5, `kicker advance ${kicker.advance.toFixed(2)}px disagrees with canvas measureText ${crossCheck.toFixed(2)}px (font ${kicker.fontSize}, letter-spacing ${String(kicker.letterSpacing)})`);
  const clippingOverflow = kicker.overflow;
  assert.notEqual(clippingOverflow, "hidden", `the kicker must not clip: overflow is "${clippingOverflow}"`);
  assert.notEqual(kicker.textOverflow, "ellipsis", "the kicker must not ellipsize: the name is the only truncating element");
}

function assertNameReadable(label, spec) {
  if (spec.name === "short") {
    if (spec.width === NARROWEST_WIDTH) {
      assert.ok(label.rect.width >= 40 - EPSILON, `the short machine name is ${label.rect.width.toFixed(2)}px wide at the ${String(NARROWEST_WIDTH)}px floor, below the 40px readability floor`);
    }
    return;
  }
  assert.equal(label.overflowX, "hidden", `the long machine name must clip: overflow-x is "${label.overflowX}"`);
  assert.equal(label.textOverflow, "ellipsis", `the long machine name must ellipsize: text-overflow is "${label.textOverflow}"`);
  assert.equal(label.whiteSpace, "nowrap", `the long machine name must not wrap: white-space is "${label.whiteSpace}"`);
  assert.ok(label.rect.width > 0, "the long machine name has a zero-width visible label");
  if (spec.width <= WIDEST_WITH_ELIDED_LONG_NAME) {
    assert.ok(label.scrollWidth > label.clientWidth, `the long machine name must actually overflow, but scrollWidth ${String(label.scrollWidth)} <= clientWidth ${String(label.clientWidth)}`);
  }
}

// -- Version label boundary -------------------------------------------------

async function runVersionBoundary(cdp, count) {
  for (const spec of [
    { width: 415, expectVersionVisible: false, expectedInner: 371 },
    { width: 416, expectVersionVisible: true, expectedInner: 372 },
  ]) {
    const snapshot = await callFixture(cdp, "applyCase", { width: spec.width, name: "short", status: "online", activity: "session" });
    const context = { width: spec.width, inner: spec.expectedInner, stage: "version-boundary" };
    check("BOUNDARY", context, () => {
      assert.ok(Math.abs(snapshot.inner.width - spec.expectedInner) <= EPSILON, `inner panel is ${String(snapshot.inner.width)}, expected ${String(spec.expectedInner)}`);
      assert.ok(snapshot.version !== null, "the fixture must render the version label");
      assert.equal(snapshot.version.text, "v1.26.0", `the rendered version label reads ${JSON.stringify(snapshot.version.text)}`);
    });
    if (spec.expectVersionVisible) {
      check("BOUNDARY", context, () => {
        assert.notEqual(snapshot.version.display, "none", "the version label must be visible from inner 372px");
        assertPositiveBox(snapshot.version.rect, "the visible version label");
      });
    } else {
      check("BOUNDARY", context, () => {
        assert.equal(snapshot.version.display, "none", `the version label must be hidden below inner 372px, display is "${snapshot.version.display}"`);
        assert.ok(snapshot.version.rect.width === 0 && snapshot.version.rect.height === 0, `the hidden version label still occupies a box: ${JSON.stringify(snapshot.version.rect)}`);
      });
    }
    check("OVERLAP", context, () => {
      assertPositiveBox(snapshot.brandSymbol.rect, "the π symbol");
      assertPositiveBox(snapshot.brandWordmark.rect, "the WebUI wordmark");
      assertPositiveBox(snapshot.actions.rect, "the header Actions button");
      assertPositiveBox(snapshot.button.rect, "the selected machine button");
      assertSeparate(snapshot.brand.rect, snapshot.button.rect, "brand/switcher");
      assertSeparate(snapshot.button.rect, snapshot.actions.rect, "switcher/actions");
      const nodes = [
        ["kicker", snapshot.kicker.rect],
        ["name", snapshot.label.rect],
        ["health", snapshot.status.rect],
        ["chevron", snapshot.chevron.rect],
      ];
      for (let first = 0; first < nodes.length; first += 1) {
        for (let second = first + 1; second < nodes.length; second += 1) {
          assertSeparate(nodes[first][1], nodes[second][1], `${nodes[first][0]}/${nodes[second][0]}`);
        }
      }
    });
    check("KICKER_FIT", context, () => assertKickerFits(snapshot.kicker));
    count("BOUNDARY");
  }
}

// -- Health-word boundary ---------------------------------------------------

async function runHealthWordBoundary(cdp, count) {
  // Narrow header state: the health word must be a dot, the status must stay exposed
  // through its own tooltip and the shadow description, and the menu keeps full words.
  for (const status of STATUSES) {
    const snapshot = await callFixture(cdp, "applyCase", { width: NARROWEST_WIDTH, name: "short", status, activity: "session" });
    const context = { width: NARROWEST_WIDTH, status, stage: "health-word" };
    check("BOUNDARY", context, () => {
      assert.equal(snapshot.statusCount, 1, `exactly one selected health indicator must render, found ${String(snapshot.statusCount)}`);
      assert.equal(snapshot.status.fontSize, "0px", `the health word must be hidden below a 150px switcher, font-size is "${snapshot.status.fontSize}"`);
      assert.ok(Math.abs(snapshot.status.rect.width - 7) <= EPSILON, `the health dot is ${snapshot.status.rect.width.toFixed(2)}px wide, expected 7px`);
      assert.ok(Math.abs(snapshot.status.rect.height - 7) <= EPSILON, `the health dot is ${snapshot.status.rect.height.toFixed(2)}px tall, expected 7px`);
      assertPositiveBox(snapshot.status.rect, "the health dot");
      assert.equal(snapshot.status.borderRadius, "50%", `the health dot radius is "${snapshot.status.borderRadius}"`);
      assert.equal(snapshot.status.backgroundColor, snapshot.status.color, `the health dot must use currentColor as its background: ${snapshot.status.backgroundColor} vs colour ${snapshot.status.color}`);
      assert.equal(snapshot.status.title, status, `the selected health indicator title is ${JSON.stringify(snapshot.status.title)}, expected ${JSON.stringify(status)}`);
    });
    check("NATIVE_INPUT", { ...context, stage: "description" }, () => {
      assert.ok(snapshot.description !== null, "the shadow-root status description is missing");
      assert.equal(snapshot.description.id, "machine-status-description", "the status description must use the fixed id");
      assert.equal(snapshot.description.text, `Machine status: ${status}.`, "the status description text is wrong");
      assert.equal(snapshot.button.ariaDescribedby, "machine-status-description", "the selected button must reference the status description");
      assert.equal(snapshot.description.declarations.position, "absolute", "the status description must be absolutely positioned");
      assert.equal(snapshot.description.declarations.width, "1px", "the status description must be 1px wide");
      assert.equal(snapshot.description.declarations.height, "1px", "the status description must be 1px tall");
      assert.equal(snapshot.description.declarations.overflow, "hidden", "the status description must clip overflow");
      assert.equal(snapshot.description.declarations.clipPath, "inset(50%)", "the status description must use clip-path inset(50%)");
      assert.equal(snapshot.description.declarations.whiteSpace, "nowrap", "the status description must not wrap");
      assert.notEqual(snapshot.description.declarations.display, "none", "the status description must never use display:none");
      assert.notEqual(snapshot.description.declarations.visibility, "hidden", "the status description must never use visibility:hidden");
    });
    count("BOUNDARY");
  }

  // Wide header state: the health word renders and there is no separate dot element.
  for (const status of STATUSES) {
    const snapshot = await callFixture(cdp, "applyCase", { width: 460, name: "short", status, activity: "session" });
    const context = { width: 460, status, stage: "health-word-wide" };
    check("BOUNDARY", context, () => {
      assert.equal(snapshot.statusCount, 1, `exactly one health element must render (no separate dot), found ${String(snapshot.statusCount)}`);
      const fontSize = Number.parseFloat(snapshot.status.fontSize);
      assert.ok(Number.isFinite(fontSize) && fontSize > 0, `the health word must render above a 150px switcher, font-size is "${snapshot.status.fontSize}"`);
      assertPositiveBox(snapshot.status.rect, "the health word box");
      assert.equal(snapshot.status.text, status, `the health word reads ${JSON.stringify(snapshot.status.text)}`);
      assert.equal(snapshot.status.title, status, `the health tooltip is ${JSON.stringify(snapshot.status.title)}`);
    });
    count("BOUNDARY");
  }

  // Menu health words are unaffected by the direct-child query, even when the
  // trigger is showing a dot.
  const menu = await callFixture(cdp, "openMenuViaProgrammaticClick");
  check("BOUNDARY", { stage: "menu-health-words" }, () => {
    assert.equal(menu.healthWords.length, 2, `the menu must list both machines, found ${String(menu.healthWords.length)}`);
    for (const entry of menu.healthWords) {
      const fontSize = Number.parseFloat(entry.fontSize);
      assert.ok(Number.isFinite(fontSize) && fontSize > 0, `menu health text must remain full-sized, font-size is "${entry.fontSize}"`);
      const words = STATUSES.filter((word) => entry.text.includes(word));
      assert.ok(words.length >= 1, `menu health text ${JSON.stringify(entry.text)} carries no status word`);
    }
  });
  count("BOUNDARY");
  await callFixture(cdp, "closeMenu");
}

// -- Standalone switcher matrix --------------------------------------------

async function runStandaloneMatrix(cdp, count) {
  await callFixture(cdp, "mountStandalone", { hostWidth: STANDALONE_HOST_WIDTH });
  try {
    for (const width of STANDALONE_WIDTHS) {
      for (const status of STATUSES) {
        const snapshot = await callFixture(cdp, "standaloneSnapshot", { width, status, activity: "session" });
        const context = { switcherWidth: width, status, stage: "standalone" };
        check("BOUNDARY", context, () => {
          assert.ok(Math.abs(snapshot.hostWidth - width) <= EPSILON, `the standalone switcher host is ${snapshot.hostWidth.toFixed(2)}px, expected ${String(width)}px`);
          const fontSize = Number.parseFloat(snapshot.status.fontSize);
          assert.equal(snapshot.statusCount, 1, `exactly one health element must render, found ${String(snapshot.statusCount)}`);
          if (width < 150) {
            assert.equal(snapshot.status.fontSize, "0px", `at ${String(width)}px the health word must be hidden, font-size is "${snapshot.status.fontSize}"`);
            assert.ok(Math.abs(snapshot.status.rect.width - 7) <= EPSILON, `at ${String(width)}px the dot is ${snapshot.status.rect.width.toFixed(2)}px wide, expected 7px`);
            assert.equal(snapshot.status.backgroundColor, snapshot.status.color, "the dot must colour itself with currentColor");
          } else {
            assert.ok(Number.isFinite(fontSize) && fontSize > 0, `at ${String(width)}px the health word must render, font-size is "${snapshot.status.fontSize}"`);
            assert.equal(snapshot.status.text, status, `the health word reads ${JSON.stringify(snapshot.status.text)}`);
          }
          assertPositiveBox(snapshot.status.rect, "the health indicator box");
          assert.equal(snapshot.status.title, status, `the health tooltip is ${JSON.stringify(snapshot.status.title)}`);
        });
        check("NATIVE_INPUT", { ...context, stage: "standalone-description" }, () => {
          assert.ok(snapshot.description !== null, "the standalone switcher is missing its status description");
          assert.equal(snapshot.description.id, "machine-status-description", "the standalone status description must use the fixed id");
          assert.equal(snapshot.description.text, `Machine status: ${status}.`, "the standalone status description text is wrong");
          assert.equal(snapshot.button.ariaDescribedby, "machine-status-description", "the standalone button must reference the status description");
        });
        check("OVERLAP", context, () => {
          assertPositiveBox(snapshot.button.rect, "the standalone selected button");
          assertPositiveBox(snapshot.kicker.rect, "the standalone kicker");
          assertPositiveBox(snapshot.label.rect, "the standalone machine name");
          assertPositiveBox(snapshot.chevron.rect, "the standalone chevron");
          const showsActivity = status === "online" || status === "unknown";
          if (showsActivity) {
            assertPositiveBox(snapshot.activity?.rect, "the standalone activity indicator");
          } else {
            assert.equal(snapshot.activity, null, `the standalone activity indicator must be suppressed for ${status}`);
          }
          const nodes = [
            ["kicker", snapshot.kicker.rect],
            ["name", snapshot.label.rect],
            ["health", snapshot.status.rect],
            ["chevron", snapshot.chevron.rect],
          ];
          if (showsActivity) nodes.push(["activity", snapshot.activity.rect]);
          for (let first = 0; first < nodes.length; first += 1) {
            for (let second = first + 1; second < nodes.length; second += 1) {
              assertSeparate(nodes[first][1], nodes[second][1], `${nodes[first][0]}/${nodes[second][0]}`);
            }
          }
          assert.ok(snapshot.button.scrollWidth <= snapshot.button.clientWidth, `the standalone button overflows: ${String(snapshot.button.scrollWidth)} > ${String(snapshot.button.clientWidth)}`);
        });
        check("KICKER_FIT", context, () => assertKickerFits(snapshot.kicker));
        check("BOUNDARY", { ...context, stage: "standalone-menu-words" }, () => {
          assert.equal(snapshot.menuHealthWords.length, 2, `the standalone menu must list both machines, found ${String(snapshot.menuHealthWords.length)}`);
          for (const word of snapshot.menuHealthWords) {
            assert.ok(STATUSES.some((statusWord) => word.text.includes(statusWord)), `menu health text ${JSON.stringify(word.text)} carries no status word`);
            assert.ok(Number.parseFloat(word.fontSize) > 0, `menu health text must remain full-sized, font-size is "${word.fontSize}"`);
          }
        });
        count("STANDALONE");
      }
    }
  } finally {
    await callFixture(cdp, "unmountStandalone");
  }

  // Two simultaneous standalone instances must each keep one unique description id
  // inside their own shadow root.
  const duplicate = await callFixture(cdp, "duplicateStandaloneProbe");
  check("NATIVE_INPUT", { stage: "standalone-duplicate-ids" }, () => {
    assert.equal(duplicate.length, 2, `expected two standalone switchers, found ${String(duplicate.length)}`);
    for (const entry of duplicate) {
      assert.equal(entry.descriptionCount, 1, `each switcher shadow root must hold exactly one description node, found ${String(entry.descriptionCount)}`);
      assert.equal(entry.describedTargetCount, 1, "aria-describedby must resolve to exactly one node inside the same shadow root");
      assert.equal(entry.descriptionTexts[0], entry.resolvedDescriptionText, "aria-describedby must resolve to the status description");
    }
  });
  count("STANDALONE");
}

// -- Monotonicity sweep -----------------------------------------------------

async function runMonotonicitySweep(cdp, count) {
  const widths = [];
  for (let width = SWEEP_START; width <= SWEEP_END; width += SWEEP_STEP) widths.push(width);
  widths.push(SWEEP_ODD_BOUNDARY);
  widths.sort((left, right) => left - right);
  const unique = [...new Set(widths)];

  for (const status of STATUSES) {
    const specs = unique.map((width) => ({ width, status, activity: "session" }));
    const samples = [];
    for (const batch of chunks(specs, CASE_BATCH_SIZE)) {
      const records = await callFixture(cdp, "runSweep", batch);
      assert.equal(records.length, batch.length, "the fixture returned a different number of sweep samples than requested");
      samples.push(...records);
    }

    // The word must never toggle back off as the panel widens.
    let previous;
    for (const sample of samples) {
      const wordVisible = Number.parseFloat(sample.status.fontSize) > 0 && sample.status.width > 0 && sample.status.height > 0;
      if (previous !== undefined && previous.wordVisible && !wordVisible) {
        fail("MONOTONICITY", `the health word turned off while widening from outer ${String(previous.width)} (inner ${previous.inner.toFixed(2)}, switcher ${previous.switcher.toFixed(2)}) to outer ${String(sample.width)} (inner ${sample.inner.toFixed(2)}, switcher ${sample.switcher.toFixed(2)})`, { status, from: previous.width, to: sample.width });
      }
      previous = { width: sample.width, wordVisible, inner: sample.inner, switcher: sample.switcher };
      count("MONOTONICITY");
    }

    // Positive boxes and no overlap hold across the whole sweep.
    for (const sample of samples) {
      const context = { width: sample.width, status, stage: "sweep" };
      check("KICKER_FIT", context, () => {
        assertPositiveBox(sample.kicker.rect, "the kicker");
        assertKickerFits(sample.kicker);
      });
      check("READABILITY", context, () => {
        assertPositiveBox(sample.label.rect, "the machine name");
        assertPositiveBox(sample.status, "the health indicator");
        assertPositiveBox(sample.chevron, "the chevron");
        assert.ok(sample.textWidth >= 48 - EPSILON, `the machine text column is ${sample.textWidth.toFixed(2)}px, below the 48px floor`);
        assert.ok(sample.buttonScrollWidth <= sample.buttonClientWidth, `the selected button overflows: ${String(sample.buttonScrollWidth)} > ${String(sample.buttonClientWidth)}`);
        assert.ok(sample.headerScrollWidth <= sample.headerClientWidth, `the header overflows: ${String(sample.headerScrollWidth)} > ${String(sample.headerClientWidth)}`);
      });
      check("OVERLAP", context, () => {
        const nodes = [
          ["kicker", sample.kicker.rect],
          ["name", sample.label.rect],
          ["health", sample.status],
          ["chevron", sample.chevron],
        ];
        if (sample.activity !== null) nodes.push(["activity", sample.activity]);
        for (let first = 0; first < nodes.length; first += 1) {
          for (let second = first + 1; second < nodes.length; second += 1) {
            assertSeparate(nodes[first][1], nodes[second][1], `${nodes[first][0]}/${nodes[second][0]}`);
          }
        }
      });
      check("READABILITY", { ...context, stage: "sweep-activity" }, () => {
        if (status === "offline" || status === "error") {
          assert.equal(sample.activity, null, `activity must be suppressed for ${status}`);
        } else {
          assertPositiveBox(sample.activity, "the activity indicator");
        }
      });
      count("SWEEP");
    }
  }
}

// -- Drawer layout geometry -------------------------------------------------

async function runDrawerGeometry(cdp, count) {
  await setViewport(cdp, DRAWER_VIEWPORT.width, DRAWER_VIEWPORT.height);
  try {
    for (const width of DRAWER_WIDTHS) {
      const snapshot = await callFixture(cdp, "applyCase", { width, name: "short", status: "online", activity: "session" });
      const context = { width, viewport: DRAWER_VIEWPORT.width, stage: "drawer" };
      check("BOUNDARY", context, () => {
        assert.ok(Math.abs(snapshot.outer.width - width) <= EPSILON, `outer column resolved to ${snapshot.outer.width.toFixed(2)}, expected ${String(width)}`);
        assert.ok(Math.abs(snapshot.inner.width - width) <= EPSILON, `the drawer layout must not reserve a rail: inner ${snapshot.inner.width.toFixed(2)}, expected ${String(width)}`);
      });
      if (width <= 371) {
        check("BOUNDARY", context, () => {
          assert.ok(snapshot.version !== null, "the fixture must render the version label");
          assert.equal(snapshot.version.display, "none", `the version label must be hidden at inner ${String(width)}px, display is "${snapshot.version.display}"`);
        });
      } else {
        check("BOUNDARY", context, () => {
          assert.ok(snapshot.version !== null, "the fixture must render the version label");
          assert.notEqual(snapshot.version.display, "none", `the version label must be visible at inner ${String(width)}px`);
          assertPositiveBox(snapshot.version.rect, "the visible version label");
        });
      }
      check("OVERLAP", context, () => {
        const nodes = [
          ["kicker", snapshot.kicker.rect],
          ["name", snapshot.label.rect],
          ["health", snapshot.status.rect],
          ["chevron", snapshot.chevron.rect],
          ["activity", snapshot.activity?.rect],
        ];
        for (const [name, rect] of nodes) assertPositiveBox(rect, `the ${name}`);
        for (let first = 0; first < nodes.length; first += 1) {
          for (let second = first + 1; second < nodes.length; second += 1) {
            assertSeparate(nodes[first][1], nodes[second][1], `${nodes[first][0]}/${nodes[second][0]}`);
          }
        }
        assertSeparate(snapshot.brand.rect, snapshot.button.rect, "brand/switcher");
        assertSeparate(snapshot.button.rect, snapshot.actions.rect, "switcher/actions");
      });
      check("KICKER_FIT", context, () => assertKickerFits(snapshot.kicker));
      check("READABILITY", context, () => {
        assert.ok(snapshot.textColumn.rect.width >= 48 - EPSILON, `the machine text column is ${snapshot.textColumn.rect.width.toFixed(2)}px, below the 48px floor`);
        assert.ok(snapshot.header.scrollWidth <= snapshot.header.clientWidth, "the drawer header overflows");
      });
      count("DRAWER");
    }
  } finally {
    await setViewport(cdp, DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
  }
}

// -- Menu anchoring ---------------------------------------------------------

async function runMenuAnchor(cdp, count) {
  await callFixture(cdp, "applyCase", { width: NARROWEST_WIDTH, name: "long", status: "online", activity: "session" });
  const geometry = await callFixture(cdp, "openMenuViaProgrammaticClick");
  const context = { width: NARROWEST_WIDTH, name: "long", stage: "menu-anchor" };

  const expectedWidth = Math.min(280, geometry.viewport.width - 16);
  const expectedLeft = Math.min(
    Math.max(8, geometry.trigger.left),
    Math.max(8, geometry.viewport.width - 8 - expectedWidth),
  );
  const expectedTop = Math.round(geometry.trigger.bottom);

  check("MENU_ANCHOR", context, () => {
    assert.equal(geometry.position, "fixed", `the machine menu must stay viewport-fixed, position is "${geometry.position}"`);
    assert.ok(Math.abs(geometry.menu.width - expectedWidth) <= EPSILON, `menu width is ${geometry.menu.width.toFixed(2)}, expected ${expectedWidth.toFixed(2)}`);
    assert.ok(Math.abs(geometry.menu.left - expectedLeft) <= EPSILON, `menu left is ${geometry.menu.left.toFixed(2)}, expected ${expectedLeft.toFixed(2)}`);
    assert.ok(Math.abs(geometry.menu.top - expectedTop) <= EPSILON, `menu top is ${geometry.menu.top.toFixed(2)}, expected the rounded trigger bottom ${String(expectedTop)}`);
    assert.ok(geometry.menu.left >= -EPSILON, `menu escapes the viewport on the left: ${String(geometry.menu.left)}`);
    assert.ok(geometry.menu.right <= geometry.viewport.width + EPSILON, `menu escapes the viewport on the right: ${String(geometry.menu.right)}`);
    assert.ok(geometry.menu.bottom <= geometry.viewport.height + EPSILON, `menu escapes the viewport at the bottom: ${String(geometry.menu.bottom)}`);
    assert.ok(Number.parseFloat(geometry.maxHeight) >= 0, `menu max-height is invalid: "${geometry.maxHeight}"`);
  });

  // The menu must be genuinely visible outside the header, not merely present.
  check("MENU_ANCHOR", { ...context, stage: "menu-visibility" }, () => {
    const extendsHorizontally = geometry.menu.right > geometry.header.right + EPSILON || geometry.menu.left < geometry.header.left - EPSILON;
    const extendsVertically = geometry.menu.bottom > geometry.header.bottom + EPSILON || geometry.menu.top < geometry.header.top - EPSILON;
    assert.ok(extendsHorizontally || extendsVertically, `the menu must extend outside the ${String(NARROWEST_WIDTH)}px header, menu ${JSON.stringify(geometry.menu)} header ${JSON.stringify(geometry.header)}`);
    assert.equal(geometry.probeHitInsideMenu, true, "a deep elementFromPoint inside the menu's visible region did not hit a menu descendant");
  });

  check("MENU_ANCHOR", { ...context, stage: "menu-health-words" }, () => {
    for (const entry of geometry.healthWords) {
      assert.ok(STATUSES.some((word) => entry.text.includes(word)), `menu entry ${JSON.stringify(entry.text)} lost its full health word`);
    }
  });
  count("MENU_ANCHOR");
  await callFixture(cdp, "closeMenu");
}

// -- Native input -----------------------------------------------------------

async function runNativeInput(cdp, count) {
  await callFixture(cdp, "applyCase", { width: NARROWEST_WIDTH, name: "short", status: "online", activity: "session" });
  const initial = await callFixture(cdp, "readActivation");

  // Enter opens the menu through native activation.
  await callFixture(cdp, "focusTrigger");
  await pressKey(cdp, KEY_ENTER);
  await settleFrames(cdp);
  const afterEnter = await callFixture(cdp, "readActivation");
  check("NATIVE_INPUT", { key: "Enter", stage: "open" }, () => {
    assert.equal(afterEnter.ariaExpanded, "true", `native Enter must open the menu, aria-expanded is "${String(afterEnter.ariaExpanded)}"`);
    assert.ok(afterEnter.menuCount > 0, "native Enter did not render the menu");
    assert.equal(afterEnter.ariaLabel, initial.ariaLabel, "native Enter changed the accessible name");
    assert.equal(afterEnter.ariaDescribedby, initial.ariaDescribedby, "native Enter changed the description reference");
    assert.equal(afterEnter.title, initial.title, "native Enter changed the identity tooltip");
  });
  await pressKey(cdp, KEY_ESCAPE);
  await settleFrames(cdp);
  const afterEnterEscape = await callFixture(cdp, "readActivation");
  check("NATIVE_INPUT", { key: "Enter>Escape", stage: "close" }, () => {
    assert.equal(afterEnterEscape.ariaExpanded, "false", `native Escape must close the menu opened by Enter, aria-expanded is "${String(afterEnterEscape.ariaExpanded)}"`);
    assert.equal(afterEnterEscape.menuCount, 0, "native Escape did not remove the menu");
    assert.equal(afterEnterEscape.deepActiveIsTrigger, true, `native Escape must restore focus to the selected trigger, deep active element is ${String(afterEnterEscape.deepActiveTag)}`);
  });
  count("NATIVE_INPUT");

  // Space activates on keyup and is verified in its own closed-menu case.
  await callFixture(cdp, "focusTrigger");
  await pressKey(cdp, KEY_SPACE);
  await settleFrames(cdp);
  const afterSpace = await callFixture(cdp, "readActivation");
  check("NATIVE_INPUT", { key: "Space", stage: "open" }, () => {
    assert.equal(afterSpace.ariaExpanded, "true", `native Space must open the menu, aria-expanded is "${String(afterSpace.ariaExpanded)}"`);
    assert.ok(afterSpace.menuCount > 0, "native Space did not render the menu");
    assert.equal(afterSpace.ariaLabel, initial.ariaLabel, "native Space changed the accessible name");
    assert.equal(afterSpace.ariaDescribedby, initial.ariaDescribedby, "native Space changed the description reference");
  });
  await pressKey(cdp, KEY_ESCAPE);
  await settleFrames(cdp);
  const afterSpaceEscape = await callFixture(cdp, "readActivation");
  check("NATIVE_INPUT", { key: "Space>Escape", stage: "close" }, () => {
    assert.equal(afterSpaceEscape.ariaExpanded, "false", "native Escape must close the menu opened by Space");
    assert.equal(afterSpaceEscape.menuCount, 0, "native Escape did not remove the Space-opened menu");
    assert.equal(afterSpaceEscape.deepActiveIsTrigger, true, `native Escape must restore focus after Space, deep active element is ${String(afterSpaceEscape.deepActiveTag)}`);
  });
  count("NATIVE_INPUT");

  // Pointer click -> Escape is the third trigger-focus dismissal case.
  const center = await callFixture(cdp, "triggerCenter");
  await mouseClick(cdp, center);
  await settleFrames(cdp);
  const afterClick = await callFixture(cdp, "readActivation");
  check("NATIVE_INPUT", { trigger: "click", stage: "open" }, () => {
    assert.equal(afterClick.ariaExpanded, "true", `a pointer click must open the menu, aria-expanded is "${String(afterClick.ariaExpanded)}"`);
    assert.ok(afterClick.menuCount > 0, "a pointer click did not render the menu");
  });
  await pressKey(cdp, KEY_ESCAPE);
  await settleFrames(cdp);
  const afterClickEscape = await callFixture(cdp, "readActivation");
  check("NATIVE_INPUT", { trigger: "click>Escape", stage: "close" }, () => {
    assert.equal(afterClickEscape.ariaExpanded, "false", "Escape must close the pointer-opened menu");
    assert.equal(afterClickEscape.menuCount, 0, "Escape did not remove the pointer-opened menu");
    assert.equal(afterClickEscape.deepActiveIsTrigger, true, `Escape must restore focus to the selected trigger after a pointer click, deep active element is ${String(afterClickEscape.deepActiveTag)}`);
  });
  count("NATIVE_INPUT");
}

async function settleFrames(cdp) {
  await evaluate(cdp, "new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => { resolve(true); })); })");
}

// -- PWA refresh placement --------------------------------------------------

async function runRefreshPlacement(cdp, fixtureUrlIgnored, state, count) {
  for (const viewportWidth of REFRESH_VIEWPORTS) {
    for (const pwa of [true, false]) {
      await setViewport(cdp, viewportWidth, DESKTOP_VIEWPORT.height);
      const placement = await callFixture(cdp, "mountApp", { width: 324, pwa, name: "short", status: "online", activity: "none" });
      const context = { viewport: viewportWidth, pwa, stage: "refresh" };
      const desktopRail = viewportWidth >= 1181;
      const mobile = viewportWidth <= 760;

      check("REFRESH", context, () => {
        assert.equal(placement.headerReloadCount, 0, `the navigation header must never render a refresh control, found ${String(placement.headerReloadCount)}`);
        if (!pwa) {
          assert.equal(placement.contextControlCount, 0, "non-PWA must not render a context-bar refresh control");
          assert.equal(placement.railReloadCount, 0, "non-PWA must not render a rail refresh control");
          return;
        }
        if (desktopRail) {
          assert.equal(placement.railReloadCount, 1, `PWA at ${String(viewportWidth)}px must render exactly one rail refresh control, found ${String(placement.railReloadCount)}`);
          assert.equal(placement.railReloadVisible, true, "the persistent rail refresh control must be visible");
          assert.equal(placement.contextControlCount, 0, "PWA at desktop-rail widths must not render a context-bar refresh control");
          return;
        }
        assert.equal(placement.contextControlCount, 1, `PWA at ${String(viewportWidth)}px must render exactly one context-bar refresh control, found ${String(placement.contextControlCount)}`);
        assert.equal(placement.contextControlVisible, true, "the context-bar refresh control must be visible");
        assert.equal(placement.contextButtonCount, 1, `PWA at ${String(viewportWidth)}px must render exactly one visible refresh button, found ${String(placement.contextButtonCount)}`);
        assert.equal(placement.contextButtonVisible, true, "the context-bar refresh button must have a positive visible box");
        if (mobile) {
          assert.equal(placement.railReloadCount, 0, `PWA at ${String(viewportWidth)}px must not render a rail refresh control`);
          return;
        }
        assert.equal(placement.railReloadVisible, false, "a closed drawer must not expose a visible rail refresh control");
        assert.ok(placement.launcherVisible, "the activity-rail launcher must be visible in the drawer band");
      });
      count("REFRESH");

      if (pwa && !desktopRail) {
        const launcher = await callFixture(cdp, "launcherCenter");
        await mouseClick(cdp, launcher);
        await settleFrames(cdp);
        const opened = await callFixture(cdp, "readRefresh");
        check("REFRESH", { ...context, drawer: "open" }, () => {
          assert.equal(opened.railDrawerOpen, true, "clicking the launcher must open the activity-rail drawer");
          assert.equal(opened.railReloadCount, mobile ? 0 : 1, mobile
            ? `PWA at ${String(viewportWidth)}px must not render a rail refresh control even with the drawer open, found ${String(opened.railReloadCount)}`
            : `PWA at ${String(viewportWidth)}px must expose one rail refresh control in the open drawer, found ${String(opened.railReloadCount)}`);
          if (!mobile) {
            assert.equal(opened.railReloadVisible, true, "the drawer rail refresh control must be visible");
            assert.equal(opened.contextControlCount, 1, "the context-bar refresh control must still be present while the drawer is open");
            assert.equal(opened.contextButtonVisible, true, "the context-bar refresh button must stay visible while the drawer is open");
            const spacerIndex = opened.railChildren.indexOf("rail-spacer");
            const reloadIndex = opened.railChildren.indexOf("icon-button rail-reload-button");
            const bellIndex = opened.railChildren.indexOf("icon-button notifications-button");
            const settingsIndex = opened.railChildren.indexOf("icon-button settings-button");
            assert.ok(spacerIndex >= 0, `the rail spacer is missing from ${JSON.stringify(opened.railChildren)}`);
            assert.ok(reloadIndex >= 0, `the rail refresh control is missing from ${JSON.stringify(opened.railChildren)}`);
            assert.ok(bellIndex >= 0, "missing Notifications button");
            assert.ok(settingsIndex >= 0, `the rail settings control is missing from ${JSON.stringify(opened.railChildren)}`);
            assert.equal(reloadIndex, spacerIndex + 1, `the rail refresh control must sit directly after the spacer: ${JSON.stringify(opened.railChildren)}`);
            assert.equal(bellIndex, reloadIndex + 1, `Notifications must sit directly after reload: ${JSON.stringify(opened.railChildren)}`);
            assert.equal(settingsIndex, bellIndex + 1, `Settings must sit directly after Notifications: ${JSON.stringify(opened.railChildren)}`);
          }
        });
        count("REFRESH");
      } else if (!pwa) {
        // Non-PWA: opening the drawer must still expose no control. Desktop widths
        // have a persistent rail and no drawer launcher; only the drawer band and
        // mobile layouts render one inside the context bar.
        const closed = await callFixture(cdp, "readRefresh");
        if (closed.launcherVisible && closed.launcherCenter !== null) {
          await mouseClick(cdp, closed.launcherCenter);
          await settleFrames(cdp);
          const opened = await callFixture(cdp, "readRefresh");
          check("REFRESH", { ...context, drawer: "open" }, () => {
            assert.equal(opened.railReloadCount, 0, "non-PWA must not render a rail refresh control with the drawer open");
            assert.equal(opened.contextControlCount, 0, "non-PWA must not render a context-bar refresh control with the drawer open");
            assert.equal(opened.contextButtonCount, 0, "non-PWA must not render a context-bar refresh button with the drawer open");
            assert.equal(opened.headerReloadCount, 0, "non-PWA must not render a header refresh control");
          });
          count("REFRESH");
          await callFixture(cdp, "closeRailDrawer");
        }
      }
    }
  }

  // A mobile header in its normal (navigation) view still has no refresh control.
  for (const viewportWidth of [760, 700]) {
    await setViewport(cdp, viewportWidth, DESKTOP_VIEWPORT.height);
    await callFixture(cdp, "mountApp", { width: 324, pwa: true, name: "short", status: "online", activity: "none" });
    await callFixture(cdp, "setMainView", { view: "navigation" });
    const placement = await callFixture(cdp, "readRefresh");
    check("REFRESH", { viewport: viewportWidth, view: "navigation", stage: "mobile-header" }, () => {
      assert.equal(placement.mobileNavigationVisible, true, "the mobile navigation panel must be mounted in its normal view");
      assert.equal(placement.headerReloadCount, 0, "the mobile navigation header must never render a refresh control");
      assert.equal(placement.contextControlCount, 1, "the mobile context bar must still carry the refresh control");
      assert.equal(placement.contextButtonCount, 1, "the mobile context bar must still carry the visible refresh button");
      assert.equal(placement.contextButtonVisible, true, "the mobile context-bar refresh button must have a positive visible box");
    });
    count("REFRESH");
  }

  await setViewport(cdp, DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
}

// -- Reload activation through application wiring ---------------------------

// Opt-in negative controls must leave a genuine violation for the final assertion,
// even when a later reload replaces the document. Each run injects exactly once.
async function injectUnexpectedApiRequest(cdp, state, stage) {
  if (state.apiProbe !== stage) return;
  state.apiProbe = undefined;
  const path = `/api/narrow-header-${stage}-probe`;
  const result = await evaluate(cdp, `(async () => {
    let blocked = false;
    try {
      const request = new XMLHttpRequest();
      request.open("GET", ${JSON.stringify(path)});
      request.send();
    } catch { blocked = true; }
    const violations = await window.__narrowHeaderFixture.readApiViolations();
    return { blocked, recorded: violations.value };
  })()`);
  check("FIXTURE_RUNTIME", { stage, probe: "unexpected-api-request" }, () => {
    assert.equal(result.blocked, true, "the unexpected-request probe must be blocked");
    assert.ok(result.recorded.includes(`xhr GET ${path}`), `the unexpected-request probe was not recorded: ${JSON.stringify(result.recorded)}`);
  });
  console.log(`Injected one-shot ${stage} API probe: ${JSON.stringify(result.recorded)}`);
}

async function runReloadActivation(cdp, state, count) {
  const cases = [
    { name: "desktop-rail", viewport: 1600, surface: "rail" },
    { name: "drawer-rail", viewport: 1100, surface: "drawer-rail" },
    { name: "drawer-context", viewport: 1100, surface: "context" },
    { name: "mobile-context", viewport: 700, surface: "context" },
  ];

  for (const testCase of cases) {
    if (testCase !== cases[0]) await injectUnexpectedApiRequest(cdp, state, "between-reloads");
    await setViewport(cdp, testCase.viewport, DESKTOP_VIEWPORT.height);
    await callFixture(cdp, "mountApp", { width: 324, pwa: true, name: "short", status: "online", activity: "none" });
    const before = await callFixture(cdp, "instanceId");
    await callFixture(cdp, "resetReloadCount");

    let point;
    if (testCase.surface === "rail") {
      point = await callFixture(cdp, "railReloadCenter");
    } else if (testCase.surface === "context") {
      point = await callFixture(cdp, "contextReloadCenter");
    } else {
      await mouseClick(cdp, await callFixture(cdp, "launcherCenter"));
      await settleFrames(cdp);
      point = await callFixture(cdp, "railReloadCenter");
    }

    const loaded = cdp.waitForEvent("Page.loadEventFired", 20_000);
    await mouseClick(cdp, point);
    await loaded;
    await waitForFixture(cdp);
    const after = await callFixture(cdp, "instanceId");
    const reloadCount = await callFixture(cdp, "readReloadCount");
    const placement = await callFixture(cdp, "readRefresh");

    const context = { reload: testCase.name, viewport: testCase.viewport, surface: testCase.surface };
    check("REFRESH", context, () => {
      assert.notEqual(after, before, "the reload control did not load a new main-frame document");
      assert.equal(reloadCount, 1, `hardReloadApp must run exactly once, ran ${String(reloadCount)} time(s)`);
      assert.equal(placement.headerReloadCount, 0, "the reloaded page must still render no header refresh control");
      if (testCase.viewport >= 1181) {
        assert.equal(placement.railReloadCount, 1, "the reloaded page must still render one rail refresh control");
        assert.equal(placement.contextControlCount, 0, "the reloaded page must still render no context-bar refresh control");
      } else {
        assert.equal(placement.contextControlCount, 1, "the reloaded page must still render one context-bar refresh control");
      }
    });
    count("REFRESH");
  }
  await setViewport(cdp, DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
}

// ---------------------------------------------------------------------------
// Fixture HTML (harness-only local resource, not an application route)
// ---------------------------------------------------------------------------

const FIXTURE_HTML_SOURCE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>narrow navigation header fixture</title>
    <style>
      html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
    </style>
    <script>
      window.__harnessErrors = [];
      window.addEventListener("error", function (event) {
        window.__harnessErrors.push(String(event.message) + " @ " + String(event.filename) + ":" + String(event.lineno));
      });
      window.addEventListener("unhandledrejection", function (event) {
        var reason = event.reason;
        window.__harnessErrors.push("unhandledrejection: " + String(reason && reason.stack ? reason.stack : reason));
      });
    </script>
  </head>
  <body>
    <script type="module" src="${FIXTURE_ENTRY_URL}"></script>
  </body>
</html>
`;

// ---------------------------------------------------------------------------
// Fixture module (browser side; no Node imports, no Node assertions)
// ---------------------------------------------------------------------------

const FIXTURE_ENTRY_SOURCE = String.raw`
import { LitElement } from "lit";
import { appStyles } from "/src/components/shared.ts";
import { PiWebUiApp } from "/src/components/PiWebUiApp.ts";
import { MachineSwitcher } from "/src/components/MachineSwitcher.ts";
import { AppNavigationPanel } from "/src/components/appShell/AppNavigationPanel.ts";
import { ActivityRail } from "/src/components/ActivityRail.ts";
import { AppContextBar } from "/src/components/appShell/AppContextBar.ts";
import { initialAppState } from "/src/appState.ts";
import { themePackPlugin } from "/src/plugins/themes/index.ts";
import { applyPiWebUiTheme, THEME_TOKENS } from "/src/theme.ts";

const PANEL_STORAGE_KEY = "pi-webui:panel-sizes:v1";
const RELOAD_COUNT_KEY = "pi-webui:narrow-header-reload-count";
const PWA_KEY = "pi-webui:narrow-header-pwa";
const API_VIOLATIONS_KEY = "pi-webui:narrow-header-api-violations";
const GENERATED_AT = "2026-10-17T00:00:00.000Z";
const SHORT_NAME = "Local";
const LONG_NAME = "build-server-02.internal.example";
const REMOTE_BASE_URL = "https://build-02.example.test:8443";
const NAME_LOOKUP = { short: SHORT_NAME, long: LONG_NAME };
const STATUS_WORDS = ["online", "offline", "error", "unknown"];

const canvasContext = document.createElement("canvas").getContext("2d");
// Each run starts a fresh Chromium profile. Reuse this tab's log across real reloads.
const apiViolations = JSON.parse(window.sessionStorage.getItem(API_VIOLATIONS_KEY) ?? "[]");
persistApiViolations();
const standaloneSwitchers = [];
const FIXTURE_APP_TAG = "pi-webui-app-fixture";
let FixtureAppElement = null;

window.__harnessInstanceId = (window.crypto && window.crypto.randomUUID)
  ? window.crypto.randomUUID()
  : String(Date.now()) + "-" + String(Math.random());

installNetworkGuards();

function harnessError(category, message) {
  const error = new Error(message);
  error.harnessCategory = category;
  return error;
}

function must(value, what) {
  if (value === null || value === undefined) throw harnessError("FIXTURE_SELECTOR", "Missing required node: " + what);
  return value;
}

function persistApiViolations() {
  window.sessionStorage.setItem(API_VIOLATIONS_KEY, JSON.stringify(apiViolations));
}

function recordApiViolation(violation) {
  apiViolations.push(violation);
  persistApiViolations();
}

function installNetworkGuards() {
  const originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input && input.url);
    if (isAppRequest(url)) {
      recordApiViolation("fetch " + url);
      return Promise.reject(new Error("Unexpected application request in the narrow-header fixture: " + url));
    }
    return originalFetch(input, init);
  };
  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = class GuardedWebSocket extends OriginalWebSocket {
    constructor(url, protocols) {
      if (isAppRequest(String(url))) {
        recordApiViolation("websocket " + String(url) + "\n" + String(new Error("trace").stack));
        window.__harnessErrors.push(String(new Error("ws-trace").stack));
        throw new Error("Unexpected application WebSocket in the narrow-header fixture: " + String(url));
      }
      super(url, protocols);
    }
  };
  // The repository has a real XHR path (src/client/src/api/workspaceUploads.ts), so
  // fetch/WebSocket guards alone would let an application request reach the fixture
  // Vite server. A blocked request is left in UNSENT, which makes its send() throw.
  const blockedXhrRequests = new WeakSet();
  const xhrPrototype = window.XMLHttpRequest.prototype;
  const originalXhrOpen = xhrPrototype.open;
  const originalXhrSend = xhrPrototype.send;
  xhrPrototype.open = function (method, url) {
    if (isAppRequest(String(url))) {
      recordApiViolation("xhr " + String(method) + " " + String(url));
      blockedXhrRequests.add(this);
      return undefined;
    }
    return originalXhrOpen.apply(this, arguments);
  };
  xhrPrototype.send = function () {
    if (blockedXhrRequests.has(this)) {
      throw new Error("Unexpected application XMLHttpRequest in the narrow-header fixture");
    }
    return originalXhrSend.apply(this, arguments);
  };
}

function isAppRequest(url) {
  return url.indexOf("/api/") !== -1 || url.indexOf("pi-webui-plugins") !== -1;
}

// Self-check for the XHR guard: an injected application request must be recorded and
// left blocked, a non-application request must pass through untouched. Only the probe's
// own synthetic entries are removed so the final apiViolations assertion keeps failing
// the run for every genuine application request.
function probeApiGuard() {
  const baseline = apiViolations.length;
  let blocked = false;
  let blockerMessage = "";
  try {
    const blockedRequest = new XMLHttpRequest();
    blockedRequest.open("GET", "/api/narrow-header-guard-probe");
    blockedRequest.send();
  } catch (error) {
    blocked = true;
    blockerMessage = String(error !== null && error !== undefined && error.message !== undefined ? error.message : error);
  }
  const recorded = apiViolations.splice(baseline);
  let passThroughBlocked = false;
  let passThroughMessage = "";
  try {
    const passThroughRequest = new XMLHttpRequest();
    passThroughRequest.open("GET", "/src/theme.ts");
    passThroughRequest.abort();
  } catch (error) {
    passThroughBlocked = true;
    passThroughMessage = String(error !== null && error !== undefined && error.message !== undefined ? error.message : error);
  }
  const passThroughRecorded = apiViolations.splice(baseline);
  persistApiViolations();
  return {
    baseline: baseline,
    recorded: recorded,
    blocked: blocked,
    blockerMessage: blockerMessage,
    passThroughBlocked: passThroughBlocked,
    passThroughMessage: passThroughMessage,
    passThroughRecorded: passThroughRecorded,
    remainingCount: apiViolations.length,
  };
}

function buildMachines() {
  return [
    { id: "local", name: SHORT_NAME, kind: "local", createdAt: GENERATED_AT, updatedAt: GENERATED_AT },
    { id: "remote", name: LONG_NAME, kind: "remote", baseUrl: REMOTE_BASE_URL, createdAt: GENERATED_AT, updatedAt: GENERATED_AT },
  ];
}

function health(machineId, status) {
  return { machineId: machineId, ok: status === "online", checkedAt: GENERATED_AT, status: status };
}

function activityMap(activity) {
  const map = {};
  if (activity === "none") return map;
  map["/tmp/narrow-header-workspace"] = {
    cwd: "/tmp/narrow-header-workspace",
    hasSessionActivity: activity === "session" || activity === "both",
    hasTerminalActivity: activity === "terminal" || activity === "both",
    updatedAt: GENERATED_AT,
  };
  return map;
}

function machineState(selectedId, status, activity) {
  const statuses = {};
  const activities = {};
  for (const machine of buildMachines()) {
    statuses[machine.id] = health(machine.id, machine.id === selectedId ? status : "online");
    activities[machine.id] = machine.id === selectedId ? activityMap(activity) : {};
  }
  return { statuses: statuses, activities: activities };
}

function statusResponse() {
  return {
    packageName: "@hyperdreamer/pi-webui",
    generatedAt: GENERATED_AT,
    components: {
      web: { component: "web", label: "Web/UI", runtimeVersion: "1.26.0", stale: false, available: true },
      sessiond: { component: "sessiond", label: "Session daemon", stale: false, available: true },
    },
    release: { packageName: "@hyperdreamer/pi-webui", updateAvailable: false },
    commands: {},
    messages: [],
  };
}

function rectOf(element) {
  // Accepts a live element or a DOMRect from Range#getClientRects.
  const rect = typeof element.getBoundingClientRect === "function" ? element.getBoundingClientRect() : element;
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
}

function styleOf(element, properties) {
  const computed = getComputedStyle(element);
  const result = {};
  for (const property of properties) {
    const key = property.replace(/-([a-z])/g, function (_, letter) { return letter.toUpperCase(); });
    result[key] = computed.getPropertyValue(property);
  }
  return result;
}

function nextFrame() {
  return new Promise(function (resolve) {
    let settled = false;
    const finish = function () {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(function () { requestAnimationFrame(finish); });
    setTimeout(finish, 250);
  });
}

async function settleApp() {
  const app = document.querySelector(FIXTURE_APP_TAG);
  if (app !== null && app.updateComplete !== undefined) await app.updateComplete;
  await nextFrame();
  await nextFrame();
}

function appElement() {
  const app = document.querySelector(FIXTURE_APP_TAG);
  if (app === null) throw harnessError("FIXTURE_SELECTOR", "Missing pi-webui-app");
  return app;
}

function navParts() {
  const app = must(appElement(), "pi-webui-app");
  const appRoot = must(app.shadowRoot, "pi-webui-app shadow root");
  const frame = must(appRoot.querySelector("#navigation-panel"), "#navigation-panel");
  const panel = must(appRoot.querySelector("app-navigation-panel"), "app-navigation-panel");
  const panelRoot = must(panel.shadowRoot, "app-navigation-panel shadow root");
  const header = must(panelRoot.querySelector("header"), "the navigation header");
  const brand = must(panelRoot.querySelector(".brand"), ".brand");
  const actions = must(panelRoot.querySelector(".header-actions"), ".header-actions");
  const switcher = must(panelRoot.querySelector("machine-switcher"), "the header machine-switcher");
  const switcherRoot = must(switcher.shadowRoot, "the machine-switcher shadow root");
  const button = must(switcherRoot.querySelector(".machine-switcher-button"), ".machine-switcher-button");
  const text = must(switcherRoot.querySelector(".machine-switcher-text"), ".machine-switcher-text");
  const kicker = must(switcherRoot.querySelector(".machine-switcher-kicker"), ".machine-switcher-kicker");
  const label = must(switcherRoot.querySelector(".machine-switcher-label"), ".machine-switcher-label");
  const status = must(switcherRoot.querySelector(".machine-status"), ".machine-status");
  const chevron = must(switcherRoot.querySelector(".machine-chevron"), ".machine-chevron");
  const shell = must(appRoot.querySelector(".shell"), ".shell");
  return {
    app: app, appRoot: appRoot, frame: frame, panel: panel, panelRoot: panelRoot, header: header,
    brand: brand, actions: actions, switcher: switcher, switcherRoot: switcherRoot, button: button,
    text: text, kicker: kicker, label: label, status: status, chevron: chevron, shell: shell,
    version: panelRoot.querySelector(".brand-version"),
    brandSymbol: must(panelRoot.querySelector(".brand-symbol"), ".brand-symbol"),
    brandWordmark: must(panelRoot.querySelector(".brand > span:not(.brand-symbol):not(.brand-version)"), "the WebUI wordmark"),
    activity: button.querySelector(".activity-indicator"),
    description: switcherRoot.querySelector("#machine-status-description"),
  };
}

function kickerInfo(element) {
  const computed = getComputedStyle(element);
  const range = document.createRange();
  range.selectNodeContents(element);
  const lineRects = Array.prototype.map.call(range.getClientRects(), rectOf);
  const text = element.textContent === null ? "" : element.textContent;
  const rendered = computed.textTransform === "uppercase" ? text.toUpperCase() : text;
  const letterSpacing = Number.parseFloat(computed.letterSpacing);
  let canvasMeasure = Number.NaN;
  if (canvasContext !== null) {
    canvasContext.font = computed.fontStyle + " " + computed.fontWeight + " " + computed.fontSize + " " + computed.fontFamily;
    canvasMeasure = canvasContext.measureText(rendered).width;
  }
  return {
    rect: rectOf(element),
    text: text,
    rendered: rendered,
    whiteSpace: computed.whiteSpace,
    overflow: computed.overflow,
    textOverflow: computed.textOverflow,
    fontSize: computed.fontSize,
    letterSpacing: Number.isFinite(letterSpacing) ? letterSpacing : 0,
    canvasMeasure: canvasMeasure,
    lineCount: lineRects.length,
    advance: lineRects.length === 0 ? 0 : Math.max.apply(null, lineRects.map(function (rect) { return rect.width; })),
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  };
}

function labelInfo(element) {
  const computed = getComputedStyle(element);
  return {
    rect: rectOf(element),
    text: element.textContent === null ? "" : element.textContent,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflowX: computed.overflowX,
    textOverflow: computed.textOverflow,
    whiteSpace: computed.whiteSpace,
  };
}

function statusInfo(element) {
  const computed = getComputedStyle(element);
  return {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    rect: rectOf(element),
    text: element.textContent === null ? "" : element.textContent,
    title: element.getAttribute("title"),
    fontSize: computed.fontSize,
    color: computed.color,
    backgroundColor: computed.backgroundColor,
    borderRadius: computed.borderRadius,
    overflow: computed.overflow,
    flex: computed.flex,
  };
}

function withBox(element) {
  const info = statusInfo(element);
  const rect = info.rect;
  return {
    left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
    width: rect.width, height: rect.height,
    rect: rect, text: info.text, title: info.title, fontSize: info.fontSize,
    color: info.color, backgroundColor: info.backgroundColor, borderRadius: info.borderRadius,
    overflow: info.overflow, flex: info.flex,
  };
}

function refreshState() {
  const app = must(appElement(), "pi-webui-app");
  const root = must(app.shadowRoot, "pi-webui-app shadow root");
  const panel = root.querySelector("app-navigation-panel");
  const panelRoot = panel === null ? null : panel.shadowRoot;
  const headerReloads = panelRoot === null
    ? []
    : Array.prototype.slice.call(panelRoot.querySelectorAll('app-refresh-control, .app-refresh-button, .rail-reload-button, [aria-label="Full page reload"]'));
  const context = root.querySelector("app-context-bar");
  const contextRoot = context === null ? null : context.shadowRoot;
  const contextControls = contextRoot === null ? [] : Array.prototype.slice.call(contextRoot.querySelectorAll("app-refresh-control"));
  const contextButtons = contextControls.flatMap(function (control) {
    return control.shadowRoot === null || control.shadowRoot === undefined
      ? []
      : Array.prototype.slice.call(control.shadowRoot.querySelectorAll(".app-refresh-button"));
  });
  const launcher = contextRoot === null ? null : contextRoot.querySelector("button.activity-rail-action-button");
  const rail = root.querySelector("activity-rail");
  const railRoot = rail === null ? null : rail.shadowRoot;
  const railReloads = railRoot === null ? [] : Array.prototype.slice.call(railRoot.querySelectorAll(".rail-reload-button"));
  const railChildren = railRoot === null ? [] : Array.prototype.slice.call(railRoot.querySelectorAll(".rail > *")).map(function (element) {
    return element.className === "" ? element.tagName.toLowerCase() : String(element.className);
  });
  return {
    hasContextBar: context !== null,
    contextBarVisible: context === null ? false : isVisible(context),
    headerReloadCount: headerReloads.length,
    contextControlCount: contextControls.length,
    contextControlVisible: contextControls.some(isVisible),
    contextButtonCount: contextButtons.length,
    contextButtonVisible: contextButtons.some(isVisible),
    railReloadCount: railReloads.length,
    railReloadVisible: railReloads.some(isVisible),
    railDrawerOpen: railRoot !== null && railRoot.querySelector(".compact-rail-backdrop") !== null,
    railChildren: railChildren,
    launcherLabel: launcher === null ? null : launcher.getAttribute("aria-label"),
    launcherVisible: launcher === null ? false : isVisible(launcher),
    launcherRect: launcher === null ? null : rectOf(launcher),
    launcherCenter: launcher === null ? null : centerOf(launcher),
    mobileNavigationVisible: root.querySelector(".mobile-navigation-panel app-navigation-panel") !== null,
  };
}

function centerOf(element) {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function isVisible(element) {
  if (!(element instanceof HTMLElement)) return false;
  const computed = getComputedStyle(element);
  if (computed.display === "none" || computed.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function snapshot() {
  const parts = navParts();
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    shellNavigationSize: Number.parseFloat(parts.shell.style.getPropertyValue("--navigation-panel-size")),
    outer: rectOf(parts.frame),
    inner: rectOf(parts.panel),
    switcher: rectOf(parts.switcher),
    header: { rect: rectOf(parts.header), scrollWidth: parts.header.scrollWidth, clientWidth: parts.header.clientWidth },
    brand: { rect: rectOf(parts.brand), text: parts.brand.textContent === null ? "" : parts.brand.textContent, ariaLabel: parts.brand.getAttribute("aria-label") },
    brandSymbol: { rect: rectOf(parts.brandSymbol) },
    brandWordmark: { rect: rectOf(parts.brandWordmark) },
    version: parts.version === null ? null : {
      rect: rectOf(parts.version),
      display: getComputedStyle(parts.version).display,
      text: parts.version.textContent === null ? "" : parts.version.textContent,
    },
    actions: { rect: rectOf(parts.actions) },
    button: {
      rect: rectOf(parts.button),
      scrollWidth: parts.button.scrollWidth,
      clientWidth: parts.button.clientWidth,
      ariaLabel: parts.button.getAttribute("aria-label"),
      ariaExpanded: parts.button.getAttribute("aria-expanded"),
      ariaDescribedby: parts.button.getAttribute("aria-describedby"),
      title: parts.button.getAttribute("title"),
    },
    textColumn: { rect: rectOf(parts.text) },
    kicker: kickerInfo(parts.kicker),
    label: labelInfo(parts.label),
    status: withBox(parts.status),
    statusCount: parts.switcherRoot.querySelectorAll(".machine-status").length,
    chevron: { rect: rectOf(parts.chevron) },
    activity: parts.activity === null ? null : {
      rect: rectOf(parts.activity),
      className: String(parts.activity.className),
      label: parts.activity.getAttribute("aria-label"),
    },
    description: parts.description === null ? null : {
      text: parts.description.textContent === null ? "" : parts.description.textContent,
      id: parts.description.getAttribute("id"),
      declarations: styleOf(parts.description, ["position", "width", "height", "padding", "margin", "overflow", "clip-path", "white-space", "border-width", "display", "visibility"]),
    },
  };
}

function applyMachine(name, status, activity) {
  const app = appElement();
  const machines = buildMachines();
  const fullName = NAME_LOOKUP[name];
  const selected = machines.find(function (machine) { return machine.name === fullName; });
  if (selected === undefined) throw harnessError("FIXTURE_RUNTIME", "Unknown machine fixture: " + String(name));
  const state = machineState(selected.id, status, activity);
  app.state = Object.assign({}, app.state, {
    machines: machines,
    selectedMachine: selected,
    machineStatuses: state.statuses,
    machineActivities: state.activities,
  });
}

async function applyCase(spec) {
  const app = appElement();
  applyMachine(spec.name, spec.status, spec.activity);
  app.panelResize.resizePanel("navigation", spec.width, { persist: false });
  await settleApp();
  return snapshot();
}

async function sweepSnapshot(spec) {
  const app = appElement();
  applyMachine("short", spec.status, spec.activity);
  app.panelResize.resizePanel("navigation", spec.width, { persist: false });
  await settleApp();
  const parts = navParts();
  return {
    width: spec.width,
    inner: rectOf(parts.panel).width,
    switcher: rectOf(parts.switcher).width,
    status: withBox(parts.status),
    kicker: kickerInfo(parts.kicker),
    label: labelInfo(parts.label),
    chevron: rectOf(parts.chevron),
    activity: parts.activity === null ? null : rectOf(parts.activity),
    textWidth: rectOf(parts.text).width,
    buttonScrollWidth: parts.button.scrollWidth,
    buttonClientWidth: parts.button.clientWidth,
    headerScrollWidth: parts.header.scrollWidth,
    headerClientWidth: parts.header.clientWidth,
  };
}

function deepActiveElement() {
  let element = document.activeElement;
  for (let depth = 0; depth < 12; depth += 1) {
    if (element === null || element === undefined) return null;
    const shadow = element.shadowRoot;
    if (shadow === null || shadow === undefined) return element;
    const inner = shadow.activeElement;
    if (inner === null || inner === undefined) return element;
    element = inner;
  }
  return element;
}

function readActivation() {
  const parts = navParts();
  const active = deepActiveElement();
  return {
    ariaExpanded: parts.button.getAttribute("aria-expanded"),
    ariaLabel: parts.button.getAttribute("aria-label"),
    ariaDescribedby: parts.button.getAttribute("aria-describedby"),
    title: parts.button.getAttribute("title"),
    menuCount: parts.switcherRoot.querySelectorAll(".machine-switcher-menu").length,
    deepActiveTag: active === null ? null : String(active.tagName).toLowerCase(),
    deepActiveIsTrigger: active === parts.button,
  };
}

function focusTrigger() {
  const parts = navParts();
  parts.button.focus();
  return { deepActiveIsTrigger: deepActiveElement() === parts.button };
}

// Self-check for the fixture contract: app must expose the mounted PiWebUiApp element
// and setMachine must resolve only after the new machine state has rendered.
async function readFixtureContract() {
  const exposedApp = window.__narrowHeaderFixture.app;
  const change = await window.__narrowHeaderFixture.setMachine({ name: "long", status: "offline", activity: "none" });
  if (change.ok !== true) throw harnessError(typeof change.category === "string" ? change.category : "FIXTURE_RUNTIME", "fixture.setMachine failed: " + String(change.message));
  const parts = navParts();
  const contract = {
    hasApp: exposedApp !== null && exposedApp !== undefined && exposedApp === appElement(),
    appIsProductionElement: exposedApp instanceof PiWebUiApp,
    requestedName: LONG_NAME,
    labelText: parts.label.textContent === null ? "" : parts.label.textContent,
  };
  const restore = await window.__narrowHeaderFixture.setMachine({ name: "short", status: "online", activity: "none" });
  if (restore.ok !== true) throw harnessError(typeof restore.category === "string" ? restore.category : "FIXTURE_RUNTIME", "fixture.setMachine restore failed: " + String(restore.message));
  return contract;
}

function closeMenu() {
  const parts = navParts();
  if (parts.button.getAttribute("aria-expanded") !== "true") return true;
  parts.button.click();
  return true;
}

function menuGeometry() {
  const parts = navParts();
  const menu = parts.switcherRoot.querySelector(".machine-switcher-menu");
  if (menu === null) throw harnessError("FIXTURE_SELECTOR", "The machine menu is not rendered");
  const computed = getComputedStyle(menu);
  const rect = rectOf(menu);
  return {
    menu: rect,
    trigger: rectOf(parts.button),
    header: rectOf(parts.header),
    inner: rectOf(parts.panel),
    position: computed.position,
    maxHeight: computed.maxHeight,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    probeHitInsideMenu: hitTestInside(menu, rect.right - 20, rect.top + 16),
    healthWords: Array.prototype.map.call(parts.switcherRoot.querySelectorAll(".machine-option-main small"), function (element) {
      return { text: element.textContent === null ? "" : element.textContent, fontSize: getComputedStyle(element).fontSize };
    }),
  };
}

function deepElementFromPoint(x, y) {
  let element = document.elementFromPoint(x, y);
  for (let depth = 0; depth < 12; depth += 1) {
    if (element === null || element === undefined) return null;
    const shadow = element.shadowRoot;
    if (shadow === null || shadow === undefined) return element;
    const inner = shadow.elementFromPoint(x, y);
    if (inner === null || inner === undefined || inner === element) return element;
    element = inner;
  }
  return element;
}

function hitTestInside(target, x, y) {
  const element = deepElementFromPoint(x, y);
  if (element === null) return false;
  return element === target || target.contains(element);
}

async function openMenuViaProgrammaticClick() {
  const parts = navParts();
  parts.button.click();
  await settleApp();
  return menuGeometry();
}

function unmountStandalone() {
  while (standaloneSwitchers.length > 0) {
    const switcher = standaloneSwitchers.pop();
    switcher.remove();
  }
}

async function mountStandalone(spec) {
  unmountStandalone();
  const switcher = document.createElement("machine-switcher");
  if (!(switcher instanceof MachineSwitcher)) throw harnessError("FIXTURE_RUNTIME", "machine-switcher did not upgrade to MachineSwitcher");
  const machines = buildMachines();
  const state = machineState("local", "online", "session");
  switcher.style.width = String(spec.hostWidth) + "px";
  switcher.machines = machines;
  switcher.selected = machines[0];
  switcher.statuses = state.statuses;
  switcher.activities = state.activities;
  document.body.append(switcher);
  standaloneSwitchers.push(switcher);
  if (switcher.updateComplete !== undefined) await switcher.updateComplete;
  await nextFrame();
  return true;
}

async function standaloneSnapshot(spec) {
  const switcher = standaloneSwitchers[standaloneSwitchers.length - 1];
  if (switcher === undefined) throw harnessError("FIXTURE_SELECTOR", "No standalone machine-switcher is mounted");
  const machines = buildMachines();
  const state = machineState("local", spec.status, spec.activity);
  switcher.style.width = String(spec.width) + "px";
  switcher.statuses = state.statuses;
  switcher.activities = state.activities;
  switcher.machines = machines;
  switcher.selected = machines[0];
  if (switcher.updateComplete !== undefined) await switcher.updateComplete;
  await nextFrame();
  await nextFrame();
  const root = must(switcher.shadowRoot, "the standalone machine-switcher shadow root");
  const button = must(root.querySelector(".machine-switcher-button"), "the standalone selected button");
  const statusElement = must(root.querySelector(".machine-status"), "the standalone health indicator");
  const kicker = must(root.querySelector(".machine-switcher-kicker"), "the standalone kicker");
  const label = must(root.querySelector(".machine-switcher-label"), "the standalone machine name");
  const chevron = must(root.querySelector(".machine-chevron"), "the standalone chevron");
  const description = root.querySelector("#machine-status-description");
  const activityElement = button.querySelector(".activity-indicator");
  const status = withBox(statusElement);
  // The menu renders only while open; open it through the trigger to prove the
  // narrow direct-child dot rule leaves the menu's full health words untouched.
  const wasOpen = button.getAttribute("aria-expanded") === "true";
  if (!wasOpen) button.click();
  if (switcher.updateComplete !== undefined) await switcher.updateComplete;
  await nextFrame();
  const menuHealthWords = Array.prototype.map.call(root.querySelectorAll(".machine-option-main small"), function (element) {
    return { text: element.textContent === null ? "" : element.textContent, fontSize: getComputedStyle(element).fontSize };
  });
  if (!wasOpen) button.click();
  if (switcher.updateComplete !== undefined) await switcher.updateComplete;
  await nextFrame();
  return {
    hostWidth: switcher.getBoundingClientRect().width,
    status: status,
    statusCount: root.querySelectorAll(".machine-status").length,
    button: {
      rect: rectOf(button),
      ariaLabel: button.getAttribute("aria-label"),
      ariaDescribedby: button.getAttribute("aria-describedby"),
      title: button.getAttribute("title"),
      scrollWidth: button.scrollWidth,
      clientWidth: button.clientWidth,
    },
    kicker: kickerInfo(kicker),
    label: labelInfo(label),
    chevron: { rect: rectOf(chevron) },
    activity: activityElement === null ? null : { rect: rectOf(activityElement), className: String(activityElement.className) },
    description: description === null ? null : {
      text: description.textContent === null ? "" : description.textContent,
      id: description.getAttribute("id"),
    },
    menuHealthWords: menuHealthWords,
  };
}

async function duplicateStandaloneProbe() {
  unmountStandalone();
  for (let index = 0; index < 2; index += 1) {
    const switcher = document.createElement("machine-switcher");
    if (!(switcher instanceof MachineSwitcher)) throw harnessError("FIXTURE_RUNTIME", "machine-switcher did not upgrade to MachineSwitcher");
    const machines = buildMachines();
    const state = machineState("local", "online", "none");
    switcher.style.width = "150px";
    switcher.machines = machines;
    switcher.selected = machines[0];
    switcher.statuses = state.statuses;
    switcher.activities = state.activities;
    document.body.append(switcher);
    standaloneSwitchers.push(switcher);
    if (switcher.updateComplete !== undefined) await switcher.updateComplete;
  }
  await nextFrame();
  const results = [];
  for (const switcher of standaloneSwitchers) {
    const root = must(switcher.shadowRoot, "a standalone switcher shadow root");
    const descriptions = root.querySelectorAll("#machine-status-description");
    const button = must(root.querySelector(".machine-switcher-button"), "a standalone selected button");
    const reference = button.getAttribute("aria-describedby");
    const resolved = reference === null ? null : root.querySelector("#" + reference);
    results.push({
      descriptionCount: descriptions.length,
      describedTargetCount: resolved === null ? 0 : 1,
      descriptionTexts: Array.prototype.map.call(descriptions, function (element) { return element.textContent === null ? "" : element.textContent; }),
      resolvedDescriptionText: resolved === null ? null : resolved.textContent,
    });
  }
  unmountStandalone();
  return results;
}

function applyStandaloneFlag(pwa) {
  if (pwa) {
    Object.defineProperty(navigator, "standalone", { configurable: true, get: function () { return true; } });
  } else {
    try { delete navigator.standalone; } catch (error) { /* not configurable in this build */ }
  }
}

function seedStorage(width, pwa) {
  window.localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify({ version: 1, navigationPanelWidth: width }));
  window.sessionStorage.setItem(PWA_KEY, pwa ? "1" : "0");
}

// Custom-element definitions capture their lifecycle callbacks at
// customElements.define() time, so reassigning PiWebUiApp.prototype.connectedCallback
// after the production decorator registered the element cannot suppress the app's
// network/session lifecycle. A fixture-only subclass under its own tag keeps the real
// production class, render path, and registered reactive controllers, but connects and
// disconnects through LitElement's lifecycle exactly as the fixture contract requires.
function fixtureAppClass() {
  if (FixtureAppElement === null) {
    FixtureAppElement = class NarrowHeaderFixtureApp extends PiWebUiApp {
      connectedCallback() {
        LitElement.prototype.connectedCallback.call(this);
      }
      disconnectedCallback() {
        LitElement.prototype.disconnectedCallback.call(this);
      }
    };
    customElements.define(FIXTURE_APP_TAG, FixtureAppElement);
  }
  return FixtureAppElement;
}

function unmountApp() {
  const existing = document.querySelectorAll(FIXTURE_APP_TAG);
  for (const element of existing) element.remove();
}

async function mountApp(spec) {
  unmountApp();
  seedStorage(spec.width, spec.pwa);
  applyStandaloneFlag(spec.pwa);
  const app = new (fixtureAppClass())();
  const machines = buildMachines();
  const fullName = NAME_LOOKUP[spec.name === undefined ? "short" : spec.name];
  const selected = machines.find(function (machine) { return machine.name === fullName; }) || machines[0];
  const state = machineState(selected.id, spec.status, spec.activity);
  app.state = Object.assign({}, initialAppState(), {
    machines: machines,
    selectedMachine: selected,
    machineStatuses: state.statuses,
    machineActivities: state.activities,
    piWebUiStatus: statusResponse(),
    mainView: "chat",
  });
  document.body.append(app);
  if (app.updateComplete !== undefined) await app.updateComplete;
  await document.fonts.ready;
  await nextFrame();
  await nextFrame();
  if (!(app.renderRoot.querySelector("app-navigation-panel") instanceof AppNavigationPanel)) throw harnessError("FIXTURE_RUNTIME", "app-navigation-panel did not upgrade to AppNavigationPanel");
  if (!(app.renderRoot.querySelector("activity-rail") instanceof ActivityRail)) throw harnessError("FIXTURE_RUNTIME", "activity-rail did not upgrade to ActivityRail");
  if (!(app.renderRoot.querySelector("app-context-bar") instanceof AppContextBar) && window.innerWidth <= 1180) {
    throw harnessError("FIXTURE_RUNTIME", "app-context-bar did not upgrade to AppContextBar where the layout renders it");
  }
  await settleApp();
  return refreshState();
}

async function setMainView(spec) {
  const app = appElement();
  app.state = Object.assign({}, app.state, { mainView: spec.view });
  await settleApp();
  return true;
}

async function resetReloadCount() {
  window.sessionStorage.setItem(RELOAD_COUNT_KEY, "0");
  const app = appElement();
  const original = app.hardReloadApp.bind(app);
  app.hardReloadApp = function () {
    const current = Number(window.sessionStorage.getItem(RELOAD_COUNT_KEY) || "0");
    window.sessionStorage.setItem(RELOAD_COUNT_KEY, String(current + 1));
    return original();
  };
  return true;
}

function readReloadCount() {
  const raw = window.sessionStorage.getItem(RELOAD_COUNT_KEY);
  return raw === null ? 0 : Number(raw);
}

async function railReloadCenter() {
  const app = appElement();
  const root = app.shadowRoot;
  const rail = root === null ? null : root.querySelector("activity-rail");
  const button = rail === null || rail.shadowRoot === null ? null : rail.shadowRoot.querySelector(".rail-reload-button");
  if (button === null) throw harnessError("FIXTURE_SELECTOR", "The rail refresh control is not rendered");
  if (!isVisible(button)) throw harnessError("FIXTURE_SELECTOR", "The rail refresh control is not visible");
  return centerOf(button);
}

async function contextReloadCenter() {
  const app = appElement();
  const root = app.shadowRoot;
  const context = root === null ? null : root.querySelector("app-context-bar");
  const control = context === null || context.shadowRoot === null ? null : context.shadowRoot.querySelector("app-refresh-control");
  const button = control === null || control.shadowRoot === null ? null : control.shadowRoot.querySelector(".app-refresh-button");
  if (button === null) throw harnessError("FIXTURE_SELECTOR", "The context-bar refresh control is not rendered");
  if (!isVisible(button)) throw harnessError("FIXTURE_SELECTOR", "The context-bar refresh control is not visible");
  return centerOf(button);
}

async function launcherCenter() {
  const state = refreshState();
  if (state.launcherCenter === null) throw harnessError("FIXTURE_SELECTOR", "The activity-rail launcher is not rendered");
  if (!state.launcherVisible) throw harnessError("FIXTURE_SELECTOR", "The activity-rail launcher is not visible");
  return state.launcherCenter;
}

async function closeRailDrawer() {
  const state = refreshState();
  if (!state.railDrawerOpen) return true;
  const app = appElement();
  const root = app.shadowRoot;
  const rail = root === null ? null : root.querySelector("activity-rail");
  const close = rail === null || rail.shadowRoot === null ? null : rail.shadowRoot.querySelector(".compact-rail-close");
  if (close !== null) close.click();
  await settleApp();
  return true;
}

function triggerCenter() {
  return centerOf(navParts().button);
}

async function resolveTheme() {
  const activation = await themePackPlugin.activate();
  const themes = activation.contributions === undefined || activation.contributions.themes === undefined
    ? []
    : activation.contributions.themes;
  const dark = themes.find(function (theme) { return theme.id === "pi-webui-dark"; });
  if (dark === undefined) throw harnessError("FIXTURE_RUNTIME", "themePackPlugin did not contribute pi-webui-dark");
  const qualified = Object.assign({}, dark, { id: "themes:pi-webui-dark" });
  applyPiWebUiTheme(qualified);
  return qualified;
}

function appStylesIsProduction(app) {
  const styles = PiWebUiApp.styles;
  if (styles === appStyles) return true;
  const normalise = function (value) {
    if (value === undefined || value === null) return "";
    if (Array.isArray(value)) return value.map(function (entry) { return String(entry.cssText === undefined ? entry : entry.cssText); }).join("\n");
    return String(value.cssText === undefined ? value : value.cssText);
  };
  return normalise(styles) === normalise(appStyles);
}

function info() {
  const app = appElement();
  return {
    instanceId: window.__harnessInstanceId,
    version: app.state.piWebUiStatus === undefined ? null : app.state.piWebUiStatus.components.web.runtimeVersion,
    appStylesMatches: appStylesIsProduction(app),
    appInlineDisplay: getComputedStyle(app).display,
    themeId: document.documentElement.dataset.piWebUiTheme,
    missingThemeTokens: readMissingThemeTokens(),
    mismatchedThemeTokens: readMismatchedThemeTokens(),
    apiViolations: apiViolations.slice(),
  };
}

function darkContribution() {
  return window.__narrowHeaderDarkTheme;
}

function readMissingThemeTokens() {
  const dark = darkContribution();
  const rootStyle = document.documentElement.style;
  const missing = [];
  for (const token of THEME_TOKENS) {
    const expected = dark.tokens[token];
    if (expected === undefined || expected === "") continue;
    if (rootStyle.getPropertyValue(token).trim() === "") missing.push(token);
  }
  return missing;
}

function readMismatchedThemeTokens() {
  const dark = darkContribution();
  const rootStyle = document.documentElement.style;
  const mismatched = [];
  for (const token of THEME_TOKENS) {
    const expected = dark.tokens[token];
    if (expected === undefined || expected === "") continue;
    const actual = rootStyle.getPropertyValue(token).trim();
    if (actual !== "" && actual !== String(expected).trim()) mismatched.push([token, actual, expected]);
  }
  return mismatched;
}

async function guarded(body) {
  try {
    return { ok: true, value: await body() };
  } catch (error) {
    return {
      ok: false,
      category: error !== null && error !== undefined && typeof error.harnessCategory === "string" ? error.harnessCategory : "FIXTURE_RUNTIME",
      message: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error),
      context: error !== null && error !== undefined && typeof error.harnessContext === "object" ? error.harnessContext : undefined,
      stack: String(error !== null && error !== undefined && error.stack !== undefined ? error.stack : ""),
    };
  }
}

async function runCases(cases) {
  const results = [];
  for (const spec of cases) {
    try {
      results.push(await applyCase(spec));
    } catch (error) {
      if (error !== null && error !== undefined) error.harnessContext = spec;
      throw error;
    }
  }
  return results;
}

async function runSweep(cases) {
  const results = [];
  for (const spec of cases) {
    try {
      results.push(await sweepSnapshot(spec));
    } catch (error) {
      if (error !== null && error !== undefined) error.harnessContext = spec;
      throw error;
    }
  }
  return results;
}

async function boot() {
  const pwa = window.sessionStorage.getItem(PWA_KEY) === "1";
  let width = 324;
  const raw = window.localStorage.getItem(PANEL_STORAGE_KEY);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed.navigationPanelWidth === "number") width = parsed.navigationPanelWidth;
    } catch (error) { /* keep the default floor */ }
  }
  window.__narrowHeaderDarkTheme = await resolveTheme();
  await mountApp({ width: width, pwa: pwa, name: "short", status: "online", activity: "none" });
  return { ready: true, instanceId: window.__harnessInstanceId };
}

window.__narrowHeaderFixture = {
  ready: false,
  bootError: null,
  get app() { return document.querySelector(FIXTURE_APP_TAG); },
  info: function () { return guarded(info); },
  instanceId: function () { return guarded(function () { return window.__harnessInstanceId; }); },
  applyCase: function (spec) { return guarded(function () { return applyCase(spec); }); },
  runCases: function (cases) { return guarded(function () { return runCases(cases); }); },
  runSweep: function (cases) { return guarded(function () { return runSweep(cases); }); },
  mountApp: function (spec) { return guarded(function () { return mountApp(spec); }); },
  setMainView: function (spec) { return guarded(function () { return setMainView(spec); }); },
  setOuterWidth: function (width) {
    return guarded(function () { return applyCase({ width: width, name: "short", status: "online", activity: "none" }); });
  },
  setMachine: function (spec) {
    return guarded(async function () {
      applyMachine(spec.name, spec.status, spec.activity);
      await settleApp();
      return true;
    });
  },
  readFixtureContract: function () { return guarded(readFixtureContract); },
  measure: function () { return guarded(snapshot); },
  readRefresh: function () { return guarded(function () { return refreshState(); }); },
  readActivation: function () { return guarded(readActivation); },
  focusTrigger: function () { return guarded(focusTrigger); },
  closeMenu: function () { return guarded(closeMenu); },
  triggerCenter: function () { return guarded(triggerCenter); },
  openMenuViaProgrammaticClick: function () { return guarded(openMenuViaProgrammaticClick); },
  mountStandalone: function (spec) { return guarded(function () { return mountStandalone(spec); }); },
  standaloneSnapshot: function (spec) { return guarded(function () { return standaloneSnapshot(spec); }); },
  duplicateStandaloneProbe: function () { return guarded(duplicateStandaloneProbe); },
  unmountStandalone: function () { return guarded(async function () { unmountStandalone(); return true; }); },
  railReloadCenter: function () { return guarded(railReloadCenter); },
  contextReloadCenter: function () { return guarded(contextReloadCenter); },
  launcherCenter: function () { return guarded(launcherCenter); },
  closeRailDrawer: function () { return guarded(closeRailDrawer); },
  resetReloadCount: function () { return guarded(resetReloadCount); },
  readReloadCount: function () { return guarded(readReloadCount); },
  readApiViolations: function () { return guarded(function () { return apiViolations.slice(); }); },
  probeApiGuard: function () { return guarded(probeApiGuard); },
};

try {
  await boot();
  window.__narrowHeaderFixture.ready = true;
} catch (error) {
  const detail = String(error !== null && error !== undefined && error.stack !== undefined ? error.stack : error);
  window.__narrowHeaderFixture.bootError = detail;
  window.__harnessErrors.push("fixture boot: " + detail);
}
`;

// ---------------------------------------------------------------------------
// Entry point (last, so every declaration above is initialised first)
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--vite-child")) {
  await runViteChild(rawArgs);
} else {
  await runParent(rawArgs);
}
