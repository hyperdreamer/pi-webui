#!/usr/bin/env node
/** Chromium acceptance checks for the selected-session notification surface. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = join(root, "src/client");
const route = "/__sidebar_notifications__/";
const entry = `${route}entry.ts`;
const entryId = "virtual:sidebar-notifications/entry.ts";
const timeoutMs = 30_000;
const deadlineMs = 180_000;
const chrome = process.env.CHROME_BIN || findChrome();
if (!chrome || !existsSync(chrome)) {
  console.error(
    "Chromium was not found. Install chromium-browser/chromium or set CHROME_BIN=/path/to/chrome."
  );
  process.exit(1);
}

let tempRoot;
let vite;
let server;
let browser;
let cdp;
let timer;
let browserError;
const pageErrors = [];
const stop = (signal) => {
  void cleanup().finally(() => {
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("SIGHUP", stop);

async function main() {
  timer = setTimeout(() => {
    console.error("FAIL: browser acceptance deadline exceeded");
    void cleanup().finally(() => process.exit(1));
  }, deadlineMs);
  try {
    tempRoot = await mkdtemp(join(tmpdir(), "pi-webui-notifications-"));
    vite = await createViteServer({
      configFile: false,
      root: clientRoot,
      cacheDir: join(tempRoot, "vite-cache"),
      appType: "custom",
      logLevel: "warn",
      server: { middlewareMode: true, hmr: false, fs: { strict: false } },
      plugins: [
        {
          name: "sidebar-notifications-fixture",
          resolveId(id) {
            return id === entry ? entryId : undefined;
          },
          load(id) {
            return id === entryId ? fixtureSource : undefined;
          },
        },
      ],
    });
    server = createHttpServer((request, response) => {
      if (new URL(request.url ?? "/", "http://localhost").pathname === route) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><script type="module" src="${entry}"></script></body></html>`
        );
        return;
      }
      vite.middlewares(request, response, () => {
        response.writeHead(404);
        response.end("Not found");
      });
    });
    await new Promise((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const port = server.address().port;
    const profile = join(tempRoot, "profile");
    browser = spawn(
      chrome,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
        "--remote-allow-origins=*",
        `--user-data-dir=${profile}`,
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--no-first-run",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    browser.once("error", (error) => {
      browserError = error;
    });
    let browserLog = "";
    browser.stderr.on("data", (data) => {
      browserLog = (browserLog + String(data)).slice(-16_000);
    });
    const start = Date.now();
    let debugPort;
    while (Date.now() - start < timeoutMs) {
      if (browserError)
        throw new Error(`Chromium failed to start: ${browserError.message}`);
      if (browser.exitCode !== null || browser.signalCode !== null)
        throw new Error(`Chromium exited before startup: ${browserLog}`);
      const activePort = await readFile(
        join(profile, "DevToolsActivePort"),
        "utf8"
      ).catch(() => undefined);
      if (activePort) {
        debugPort = Number(activePort.split("\n")[0]);
        break;
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    if (!debugPort)
      throw new Error(
        `Chromium did not expose a debugging port: ${browserLog}`
      );
    const targets = await (
      await fetch(`http://127.0.0.1:${debugPort}/json/list`)
    ).json();
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("Chromium did not expose a page target");
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", {
      url: `http://127.0.0.1:${port}${route}`,
    });
    await waitFor(
      "fixture startup",
      "window.__notificationsFixture?.ready === true"
    );
    assert.equal(
      await call("trayRegistered"),
      true,
      "production app entry did not register session-notification-tray"
    );
    await call("select", "a");
    await desktopChecks();
    await compactChecks();
    await handoffChecks();
    await announcementChecks();
    await targetAndMutationChecks();
    console.log(
      "PASS B1–B4: desktop and compact notification surfaces, breakpoint handoff, announcements and selected-target actions"
    );
  } catch (error) {
    console.error(
      `FAIL: ${error instanceof Error ? error.stack : String(error)}`
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    await cleanup();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGHUP", stop);
  }
}

function findChrome() {
  for (const candidate of [
    "chromium-browser",
    "chromium",
    "google-chrome",
    "google-chrome-stable",
  ]) {
    for (const directory of (process.env.PATH ?? "").split(":")) {
      const path = join(directory, candidate);
      if (directory && existsSync(path)) return path;
    }
  }
  return undefined;
}

let cleaning;
function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    if (cdp) {
      await cdp.send("Browser.close").catch(() => undefined);
      cdp.close();
    }
    if (
      browser &&
      !browserError &&
      browser.exitCode === null &&
      browser.signalCode === null
    ) {
      await Promise.race([
        new Promise((done) => browser.once("exit", done)),
        new Promise((done) => setTimeout(done, 2_000)),
      ]);
      if (browser.exitCode === null && browser.signalCode === null) {
        const exited = new Promise((done) => browser.once("exit", done));
        browser.kill("SIGKILL");
        await exited;
      }
    }
    if (server) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
    if (vite) await vite.close();
    if (tempRoot)
      await rm(tempRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
  })();
  return cleaning;
}

class Cdp {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((accept, reject) => {
      socket.addEventListener("open", accept, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new Cdp(socket);
  }
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.exceptionThrown")
        pageErrors.push(
          message.params?.exceptionDetails?.exception?.description ??
            message.params?.exceptionDetails?.text ??
            "Unknown page exception"
        );
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          new Error(`CDP ${pending.method}: ${JSON.stringify(message.error)}`)
        );
      else pending.resolve(message.result ?? {});
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`CDP closed during ${pending.method}`));
      }
      this.pending.clear();
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, 10_000);
      this.pending.set(id, { resolve: accept, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    this.socket.close();
  }
}

async function evaluate(expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw new Error(
      `Browser evaluation failed: ${
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text
      }`
    );
  return result.result.value;
}
async function call(method, ...args) {
  return evaluate(
    `window.__notificationsFixture[${JSON.stringify(method)}](${args
      .map((arg) => JSON.stringify(arg))
      .join(",")})`
  );
}
async function waitFor(label, expression) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const probe = await evaluate(
      `({ready: Boolean(${expression}), error: window.__notificationsFixture?.error ?? null})`
    ).catch(() => undefined);
    if (probe?.error) throw new Error(`${label}: ${probe.error}`);
    if (probe?.ready) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(
    `Timed out waiting for ${label}. Page errors: ${JSON.stringify(pageErrors)}`
  );
}
async function viewport(width, height) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("settle");
}
async function clickAt(point) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...point,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await call("settle");
}
async function click(name) {
  const point = await call("center", name);
  assert.ok(point, `Missing or hidden ${name}`);
  const hit = await call("hit", name);
  assert.equal(
    hit.matches,
    true,
    `${name} is obstructed at its center: ${JSON.stringify(hit)}`
  );
  await clickAt(point);
}
async function key(key, modifiers = 0) {
  const codes = { Tab: 9, Escape: 27, Enter: 13, k: 75 };
  const event = {
    key,
    code: key === "k" ? "KeyK" : key,
    windowsVirtualKeyCode: codes[key],
    nativeVirtualKeyCode: codes[key],
    modifiers,
  };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...event });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
  await call("settle");
}
async function scrollList() {
  const point = await call("center", "list");
  assert.ok(point, "notification list is not visible");
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    ...point,
    deltaX: 0,
    deltaY: 600,
  });
  await call("settle");
  assert.ok(
    (await call("inspect")).listScrollTop > 0,
    "notification list did not scroll in response to the wheel"
  );
  assert.ok(await call("visibleDismiss"), "no dismiss control is fully visible after scrolling");
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    ...point,
    deltaX: 0,
    deltaY: -10000,
  });
  await call("settle");
}
async function accessibility() {
  return (await cdp.send("Accessibility.getFullAXTree")).nodes.filter(
    (node) => !node.ignored
  );
}
function assertOrder(state) {
  const spacerIndex = state.order.indexOf("rail-spacer");
  assert.ok(spacerIndex >= 0, "missing rail spacer");
  assert.ok(state.reloadIndex >= 0, "missing Reload button");
  assert.ok(state.bellIndex >= 0, "missing Notifications button");
  assert.ok(state.settingsIndex >= 0, "missing Settings button");
  assert.equal(state.reloadIndex, spacerIndex + 1, "Reload must immediately follow the spacer");
  assert.equal(
    state.settingsIndex,
    state.bellIndex + 1,
    `Notifications must immediately precede Settings: ${JSON.stringify(
      state.order
    )}`
  );
  assert.equal(
    state.bellIndex,
    state.reloadIndex + 1,
    `Notifications must immediately follow Reload: ${JSON.stringify(
      state.order
    )}`
  );
}

async function desktopChecks() {
  for (const width of [1440, 1181]) {
    await viewport(width, 900);
    const closed = await call("inspect");
    const requests = await call("requestCount");
    assertOrder(closed);
    assert.match(closed.bellLabel, /103/);
    assert.match(closed.bellLabel, /Alpha/);
    assert.equal(closed.bellExpanded, "false");
    await call("swapPlacement");
    const reversed = await call("inspect");
    assert.throws(() => assertOrder(reversed), /Notifications/);
    await call("restorePlacement");
    const before = await call("inspect");
    await click("bell");
    const opened = await call("inspect");
    assert.equal(
      opened.role,
      "region",
      `desktop tray state: ${JSON.stringify(opened)}`
    );
    assert.equal(opened.modal, false);
    assert.equal(opened.shellInert, false);
    assert.deepEqual(
      opened.chatRect,
      before.chatRect,
      "desktop tray must not resize chat"
    );
    assert.equal(opened.bellExpanded, "true");
    assert.equal(opened.controlsTray, true);
    assert.equal(opened.listCount, 1);
    assert.equal(opened.longMessageFits, true, "desktop long message must wrap without clipping");
    assert.equal(await call("requestCount"), requests, "opening the tray must not request notifications");
    assert.ok(
      opened.listScrollHeight > opened.listClientHeight,
      "desktop list must scroll"
    );
    assert.ok(
      opened.actionsVisible,
      "desktop notification controls must be inside the viewport"
    );
    await scrollList();
    const tree = await accessibility();
    const region = tree.find(
      (node) =>
        node.role?.value === "region" && /Alpha/.test(node.name?.value ?? "")
    );
    const bell = tree.find(
      (node) =>
        node.role?.value === "button" &&
        /103/.test(node.name?.value ?? "") &&
        /Alpha/.test(node.name?.value ?? "")
    );
    assert.ok(
      region,
      "desktop labelled region missing from accessibility tree"
    );
    assert.ok(bell, "full bell name missing from accessibility tree");
    assert.equal(bell.properties?.find((property) => property.name === "expanded")?.value?.value, true, "bell must expose its expanded state");
    assert.ok(tree.some((node) => node.name?.value === "Covered background sentinel"), "desktop background must remain accessible");
    const controls =
      bell.properties?.find((property) => property.name === "controls")?.value
        ?.relatedNodes ?? [];
    assert.ok(
      controls.some(
        (node) => node.backendDOMNodeId === region.backendDOMNodeId
      ),
      `bell accessibility relationship does not resolve to the tray: ${JSON.stringify(
        controls
      )}`
    );
    await call("focusLastRow");
    await key("Tab");
    assert.equal((await call("inspect")).activeInside, false, "desktop tray must not trap keyboard focus");
    await click("composer");
    const closedAfterPointer = await call("inspect");
    assert.equal(closedAfterPointer.open, false);
    assert.equal(
      closedAfterPointer.active,
      "composer",
      "outside pointer must preserve destination focus"
    );
    await cdp.send("Input.insertText", { text: "Browser fixture input" });
    assert.match(
      await call("composerText"),
      /Browser fixture input/,
      "composer must remain interactive"
    );
    await call("clearComposer");
    assert.equal(await call("requestCount"), requests, "closing the tray must not request notifications");
  }
}

async function compactChecks() {
  for (const [width, height] of [
    [1180, 900],
    [390, 844],
  ]) {
    await viewport(width, height);
    let state = await call("inspect");
    assert.match(state.launcherLabel, /103/);
    const closedTree = await accessibility();
    assert.ok(
      closedTree.some(
        (node) =>
          node.role?.value === "button" &&
          /activity rail/i.test(node.name?.value ?? "") &&
          /103/.test(node.name?.value ?? "") &&
          /Alpha/.test(node.name?.value ?? "")
      ),
      "compact launcher's full accessible name is missing"
    );
    await click("launcher");
    await click("bell");
    state = await call("inspect");
    assert.equal(
      state.drawerOpen,
      false,
      `compact sheet state: ${JSON.stringify(state)}`
    );
    assert.equal(state.role, "dialog");
    assert.equal(state.modal, true);
    assert.equal(state.shellInert, true);
    assert.equal(state.active, "heading");
    assert.equal(state.controlsTray, true);
    assert.ok(
      Math.abs(state.sheetRect.left) <= 1 &&
        Math.abs(state.sheetRect.top) <= 1 &&
        Math.abs(state.sheetRect.right - width) <= 1 &&
        Math.abs(state.sheetRect.bottom - height) <= 1,
      "sheet must fill the viewport"
    );
    assert.equal(state.longMessageFits, true, "compact long message must wrap without clipping");
    assert.ok(
      state.listScrollHeight > state.listClientHeight,
      "compact list must scroll"
    );
    assert.ok(state.actionsVisible, "compact header controls must be visible");
    assert.equal(await call("safeAreaPaddingMatches"), true, "sheet padding must follow the browser safe-area insets");
    await scrollList();
    const tree = await accessibility();
    assert.ok(
      tree.some(
        (node) =>
          node.role?.value === "dialog" && /Alpha/.test(node.name?.value ?? "")
      ),
      "labelled compact dialog missing from accessibility tree"
    );
    assert.ok(
      !tree.some((node) => node.name?.value === "Covered background sentinel"),
      "covered background remains in accessibility tree"
    );
    const backgroundPoint = await call("center", "sentinel");
    assert.ok(backgroundPoint, "background pointer sentinel is missing");
    await clickAt(backgroundPoint);
    assert.equal(
      (await call("inspect")).backgroundPointers,
      0,
      "covered background received a pointer event"
    );
    await call("focus", "sentinel");
    assert.equal(
      (await call("inspect")).activeInside,
      true,
      "covered background accepted focus"
    );
    await key("Tab", 8);
    assert.equal(
      (await call("inspect")).activeEnabledInside,
      true,
      "Shift+Tab escaped connected, enabled sheet controls"
    );
    await key("Tab");
    assert.equal(
      (await call("inspect")).activeEnabledInside,
      true,
      "Tab escaped connected, enabled sheet controls"
    );
    await call("installSpeechProbe");
    await key("k", 2);
    assert.equal((await call("inspect")).shortcutEscaped, false);
    await key("Escape");
    state = await call("inspect");
    assert.equal(state.open, false);
    assert.equal(
      state.speechCancels,
      0,
      "Escape must close the sheet before speech cancellation"
    );
    assert.equal(state.active, "launcher");
    assert.equal(state.shellInert, false);
  }
}

async function handoffChecks() {
  await viewport(1440, 900);
  await click("bell");
  await call("focus", "row");
  const initial = await call("inspect");
  const mutations = await call("mutationCount");
  const requests = await call("requestCount");
  await viewport(1180, 900);
  let state = await call("inspect");
  assert.equal(state.role, "dialog");
  assert.equal(state.shellInert, true);
  assert.equal(state.listCount, 1);
  assert.equal(state.active, "row");
  assert.equal(state.heading, initial.heading);
  assert.match(state.launcherLabel, /Alpha/, "resizing must preserve the selected target");
  assert.match(state.launcherLabel, /103/, "resizing must preserve the notification count");
  await viewport(1181, 900);
  state = await call("inspect");
  assert.equal(state.role, "region");
  assert.equal(state.shellInert, false);
  assert.equal(state.active, "row");
  assert.equal(await call("mutationCount"), mutations);
  assert.equal(await call("requestCount"), requests, "resizing must not request notifications");
  await key("Escape");
  assert.equal((await call("inspect")).active, "bell");
  await click("bell");
  await call("focus", "composer");
  await viewport(1180, 900);
  assert.equal((await call("inspect")).active, "heading");
  await key("Escape");
  assert.equal((await call("inspect")).active, "launcher");

  await viewport(1440, 900);
  await click("bell");
  await call("holdMutation");
  await click("clear");
  await waitFor(
    "held Clear all",
    "window.__notificationsFixture.mutationHeld()"
  );
  const pending = await call("lastMutation");
  assert.equal(pending.body.cwd, "/a");
  assert.equal(pending.body.throughOrder, 100);
  assert.equal(pending.body.throughOverflowWatermark, 8);
  await call("addLive", "warning");
  state = await call("inspect");
  assert.equal(state.rowCount, 1, "post-watermark row must remain visible");
  assert.equal(
    state.rowDisabled,
    true,
    "post-watermark dismiss must be disabled during Clear all"
  );
  await viewport(1180, 900);
  state = await call("inspect");
  assert.equal(state.role, "dialog");
  assert.equal(state.shellInert, true);
  assert.equal(
    state.active,
    "heading",
    "disabled control must fall back to heading during handoff"
  );
  assert.equal(state.rowCount, 1);
  await viewport(1181, 900);
  assert.equal((await call("inspect")).rowCount, 1);
  assert.equal(await call("mutationCount"), mutations + 1);
  await call("releaseMutation");
  await waitFor(
    "Clear all settlement",
    "!window.__notificationsFixture.mutationHeld()"
  );
  await call("settle");
  assert.equal((await call("inspect")).rowDisabled, false);
  await key("Escape");
  assert.equal((await call("inspect")).active, "bell");
}

async function announcementChecks() {
  await viewport(1440, 900);
  const baseline = await call("markAnnouncements");
  assert.deepEqual(await call("liveRegionCounts"), { polite: 1, assertive: 1 });
  const initialAppends = await call("announcementAppendCount");
  await call("addLive", "info");
  assert.equal(await call("announcementAppendCount"), initialAppends + 1, "accepted live event must append once");
  let state = await call("announcements");
  assert.equal(state.polite.length, baseline.polite.length + 1);
  assert.equal(state.assertive.length, baseline.assertive.length);
  assert.equal(state.polite.at(-1), "Info notification received.");
  await call("replayLive");
  assert.deepEqual(
    await call("announcements"),
    state,
    "duplicate live event was announced"
  );
  assert.equal(await call("announcementAppendCount"), initialAppends + 1, "duplicate live event appended again");
  await click("bell");
  await viewport(1180, 900);
  await key("Escape");
  await viewport(1440, 900);
  assert.deepEqual(
    await call("announcements"),
    state,
    "layout or open/close replayed announcements"
  );
  assert.equal(await call("announcementNodesStable"), true);
  assert.equal(await call("announcementAppendCount"), initialAppends + 1, "layout changes appended announcements");
  await call("addLive", "error");
  state = await call("announcements");
  assert.equal(
    state.assertive.length,
    baseline.assertive.length + 1,
    "accepted error must use the assertive region"
  );
  assert.equal(state.assertive.at(-1), "Error notification received.");
  assert.equal(await call("announcementAppendCount"), initialAppends + 2, "accepted error must append once");
  await call("holdRead");
  await call("resync");
  await waitFor(
    "held stale recovery",
    "window.__notificationsFixture.readHeld()"
  );
  assert.equal(await call("announcementNodesStable"), true);
  assert.deepEqual(
    await call("announcements"),
    state,
    "stale transition replayed an announcement"
  );
  await call("releaseRead");
  await waitFor(
    "stale recovery",
    "window.__notificationsFixture.presentationKind() === 'fresh'"
  );
  await call("reconnect");
  await waitFor(
    "same-daemon reconnect",
    "window.__notificationsFixture.presentationKind() === 'fresh'"
  );
  assert.equal(await call("announcementNodesStable"), true);
  assert.deepEqual(
    await call("announcements"),
    state,
    "same-daemon reconnect replayed a snapshot"
  );
  const beforeReplacement = await call("announcementAppendCount");
  assert.equal(beforeReplacement, initialAppends + 2, "stale recovery or reconnect appended announcements");
  await call("replaceDaemon");
  await waitFor(
    "replacement daemon baseline",
    "window.__notificationsFixture.daemonId() === 'd2' && window.__notificationsFixture.presentationKind() === 'fresh'"
  );
  assert.equal(
    await call("announcementAppendCount"),
    beforeReplacement,
    "replacement snapshot replayed an announcement"
  );
  const replacementBaseline = await call("announcements");
  await call("addLive", "warning");
  assert.equal(await call("announcementAppendCount"), beforeReplacement + 1, "replacement daemon live event must append once");
  const replacementLive = await call("announcements");
  assert.equal(
    replacementLive.polite.length,
    replacementBaseline.polite.length + 1,
    "new daemon live event must be announced once"
  );
  await call("replayLive");
  assert.deepEqual(await call("announcements"), replacementLive);
  assert.equal(await call("announcementAppendCount"), beforeReplacement + 1, "replacement daemon replay appended again");
}

async function targetAndMutationChecks() {
  await click("bell");
  const mutations = await call("mutationCount");
  const announcements = await call("announcementAppendCount");
  await call("holdRead");
  await call("beginSelect", "b");
  await waitFor(
    "held remote selection",
    "window.__notificationsFixture.readHeld()"
  );
  let state = await call("inspect");
  assert.match(
    state.heading,
    /Beta/,
    "selection must immediately rebind the tray title"
  );
  assert.equal(
    state.rowCount,
    0,
    "old target rows must disappear while the new target loads"
  );
  assert.equal(
    await call("mutationCount"),
    mutations,
    "switching targets must not dismiss the old inbox"
  );
  await call("releaseRead");
  await call("waitSelection");
  state = await call("inspect");
  assert.match(state.bellLabel, /Beta/);
  assert.match(state.bellLabel, /1/);
  assert.match(state.heading, /Beta/);
  assert.equal(state.rowCount, 1);
  assert.equal(await call("announcementRegionsStable"), true, "selection must preserve the announcement regions");
  assert.equal(await call("announcementAppendCount"), announcements, "selection must not announce snapshot rows");
  await click("clear");
  const mutation = await call("lastMutation");
  assert.equal(mutation.body.cwd, "/b");
  assert.equal(mutation.body.throughOrder, 1);
  assert.equal(mutation.body.throughOverflowWatermark, 0);
  assert.match(mutation.path, /remote/);

  await call("setReadFailure", true);
  await call("select", "a", false);
  await waitFor(
    "unavailable inbox",
    "window.__notificationsFixture.presentationKind() === 'unavailable'"
  );
  state = await call("inspect");
  assert.match(state.heading, /Alpha/);
  assert.equal(state.rowCount, 0);
  assert.match(state.stateText, /unavailable/i);
  await call("setReadFailure", false);
  await click("retry");
  await waitFor(
    "inbox retry",
    "window.__notificationsFixture.presentationKind() === 'fresh'"
  );
  state = await call("inspect");
  assert.match(state.heading, /Alpha/);
  assert.ok(state.rowCount > 0, "retry must recover current rows");
}

const fixtureSource = String.raw`
import { PiWebUiApp } from "/src/components/PiWebUiApp.ts";
import { initialAppState } from "/src/appState.ts";
import { api } from "/src/api.ts";

const now = "2026-11-18T12:00:00.000Z";
const machines = [
  { id: "local", name: "Local", kind: "local", createdAt: now, updatedAt: now },
  { id: "remote", name: "Remote", kind: "remote", baseUrl: "https://example.test", createdAt: now, updatedAt: now },
];
const targets = {
  a: { machine: machines[0], session: { id: "s", cwd: "/a", path: "/a/s.jsonl", created: now, modified: now, messageCount: 0, firstMessage: "Alpha" } },
  b: { machine: machines[1], session: { id: "s", cwd: "/b", path: "/b/s.jsonl", created: now, modified: now, messageCount: 0, firstMessage: "Beta" } },
};
const workspace = (cwd) => ({ id: "workspace", projectId: "project", path: cwd, label: cwd, isMain: true, isGitRepo: true, isGitWorktree: false });
const row = (order, severity = "warning", daemon = "d1") => ({ id: daemon + ":" + order, order, receivedAt: now, severity, message: order === 100 ? "Long private message " + "word ".repeat(500) : "Private message " + order, truncated: false });
const rows = Array.from({ length: 100 }, (_, index) => row(100 - index));
const stores = { a: { daemon: "d1", rows, discarded: 3, watermark: 8, revision: 1 }, b: { daemon: "d1", rows: [row(1)], discarded: 0, watermark: 0, revision: 1 } };
let current = "a";
let lastEvent;
let markedRegions;
let markedChildren;
let announcementAppends = 0;
let savedPlacement;
const calls = [];
const sockets = [];
let speechCancels = 0;
let shortcutEscaped = false;
let backgroundPointers = 0;
let holdNextRead = false;
let holdNextMutation = false;
let failReads = false;
let pendingRead;
let pendingMutation;
let selection;
let nextSocket;

function snapshot(key) {
  const store = stores[key];
  const highestSeverity = store.rows.some((item) => item.severity === "error")
    ? "error"
    : store.rows.some((item) => item.severity === "warning") ? "warning" : "info";
  return {
    daemonInstanceId: store.daemon,
    catalogRevision: store.revision,
    summary: {
      sessionId: "s",
      cwd: targets[key].session.cwd,
      inboxRevision: store.revision,
      retainedCount: store.rows.length,
      discardedCount: store.discarded,
      ...(store.rows.length ? { highestSeverity } : {}),
    },
    notifications: store.rows,
    dismissThrough: {
      order: Math.max(0, ...store.rows.map((item) => item.order)),
      overflowWatermark: store.watermark,
    },
  };
}
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url, location.href);
  if (!url.pathname.includes("/notifications")) return originalFetch(input, init);
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  const cwd = url.searchParams.get("cwd") ?? body?.cwd;
  const key = cwd === "/b" ? "b" : "a";
  calls.push({ path: url.pathname, method: init.method ?? "GET", body, cwd });
  if (!init.method && holdNextRead) {
    holdNextRead = false;
    await new Promise((resolve) => { pendingRead = resolve; });
  }
  if (!init.method && failReads) return new Response(JSON.stringify({ error: "Fixture inbox unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
  if (init.method === "POST" && holdNextMutation) {
    holdNextMutation = false;
    await new Promise((resolve) => { pendingMutation = resolve; });
  }
  if (url.pathname.endsWith("/dismiss-all")) {
    const store = stores[key];
    store.rows = store.rows.filter((item) => item.order > body.throughOrder);
    store.discarded = Math.max(0, store.watermark - body.throughOverflowWatermark);
    store.revision++;
  } else if (url.pathname.endsWith("/dismiss")) {
    stores[key].rows = stores[key].rows.filter((item) => item.id !== body.notificationId);
    stores[key].revision++;
  }
  return new Response(JSON.stringify(snapshot(key)), { status: 200, headers: { "Content-Type": "application/json" } });
};
class FakeWebSocket {
  constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); nextSocket?.(this); }
  open() { this.readyState = 1; this.onopen?.({}); }
  emit(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  close() { this.readyState = 3; }
  drop() { this.readyState = 3; this.onclose?.({}); }
  send() {}
}
window.WebSocket = FakeWebSocket;
api.messages = async () => ({ messages: [], start: 0, total: 0 });
api.status = async () => ({ sessionId: "s", isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
api.streamSnapshot = async () => ({ seq: 0, partial: null });
api.extensionEntries = async () => ({ entries: [], seq: 0, readRevision: 1 });
api.thinkingLevels = async () => ({ levels: [] });
Object.defineProperty(navigator, "standalone", { configurable: true, get: () => true });
const app = new PiWebUiApp({ speechInputApi: { settings: () => Promise.reject(new Error("fixture")) }, createSpeechInputSettingsChannel: () => ({ publish() {}, close() {} }) });
for (const name of ["connectRealtime", "synchronizeProjectCatalogPolling", "syncWindowTitle", "syncMachineActivitySubscriptions"]) app[name] = () => undefined;
for (const name of ["renegotiateUnreadMachines", "renegotiateUnreadMachine", "refreshWorkspaceActivity", "refreshAfterBrowserResume", "loadClientConfig", "ensureGatewayPluginsLoaded", "loadProjectsAndRestoreRoute"]) app[name] = () => Promise.resolve();
app.hostSpeech.refreshStatus = () => Promise.resolve();
app.recentProjects.load = () => Promise.resolve();
app.state = { ...initialAppState(), machines, selectedMachine: machines[0], selectedWorkspace: workspace("/a"), machineRuntimes: Object.fromEntries(machines.map((machine) => [machine.id, { machineId: machine.id, ok: true, checkedAt: now, capabilities: ["sessions.notifications"] }])) };
document.body.append(app);
const sentinel = document.createElement("button");
sentinel.textContent = "Covered background sentinel";
sentinel.style.cssText = "position:absolute;right:8px;bottom:8px;width:10px;height:10px;padding:0";
sentinel.addEventListener("pointerdown", () => { backgroundPointers++; });
app.updateComplete.then(() => app.shadowRoot.querySelector(".shell")?.append(sentinel));

function rail() { return app.shadowRoot.querySelector("activity-rail")?.shadowRoot; }
function tray() { return app.shadowRoot.querySelector("session-notification-tray"); }
function context() { return app.shadowRoot.querySelector("app-context-bar")?.shadowRoot; }
function element(name) {
  if (name === "bell") return rail()?.querySelector("button.notifications-button");
  if (name === "launcher") return context()?.querySelector("button.activity-rail-action-button");
  if (name === "heading") return tray()?.shadowRoot?.querySelector(".notification-heading");
  if (name === "row") return tray()?.shadowRoot?.querySelector(".notification-row-dismiss:not([disabled])");
  if (name === "clear") return tray()?.shadowRoot?.querySelector(".notification-clear");
  if (name === "retry") return tray()?.shadowRoot?.querySelector(".notification-retry");
  if (name === "list") return tray()?.shadowRoot?.querySelector(".notification-list");
  if (name === "sentinel") return sentinel;
  if (name === "composer") return app.shadowRoot.querySelector("prompt-editor")?.shadowRoot?.querySelector(".cm-content") ?? sentinel;
  return undefined;
}
function active() { let node = document.activeElement; while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement; return node; }
function rect(node) { if (!node) return null; const value = node.getBoundingClientRect(); return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height }; }
async function settle() {
  await app.updateComplete;
  await Promise.all([app.shadowRoot.querySelector("activity-rail")?.updateComplete, app.shadowRoot.querySelector("app-context-bar")?.updateComplete, tray()?.updateComplete]);
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  await app.updateComplete;
  await tray()?.updateComplete;
}
function inspect() {
  const bell = element("bell");
  const launcher = element("launcher");
  const surface = app.shadowRoot.querySelector(".notification-surface");
  const panel = tray();
  const root = panel?.shadowRoot;
  const list = root?.querySelector(".notification-list");
  const longMessage = root?.querySelector(".notification-message");
  const shell = app.shadowRoot.querySelector(".shell");
  const children = [...(rail()?.querySelectorAll(".rail > *") ?? [])];
  const order = children.map((node) => String(node.className));
  const focus = active();
  const destination = ["bell", "launcher", "heading", "row", "composer"].find((name) => element(name) === focus) ?? focus?.className ?? null;
  const action = root?.querySelector(".notification-close");
  const box = rect(action);
  const chat = app.shadowRoot.querySelector("main");
  return {
    order,
    reloadIndex: order.indexOf("icon-button rail-reload-button"),
    bellIndex: order.indexOf("icon-button notifications-button"),
    settingsIndex: order.indexOf("icon-button settings-button"),
    bellLabel: bell?.getAttribute("aria-label"),
    bellExpanded: bell?.getAttribute("aria-expanded"),
    launcherLabel: launcher?.getAttribute("aria-label"),
    open: !surface?.hidden,
    role: panel?.getAttribute("role"),
    modal: panel?.getAttribute("aria-modal") === "true",
    shellInert: shell?.inert,
    chatRect: rect(chat),
    sheetRect: rect(surface),
    heading: root?.querySelector(".notification-heading")?.textContent,
    active: destination,
    activeInside: focus?.getRootNode() === root,
    activeEnabledInside: focus?.getRootNode() === root && focus.isConnected && !focus.disabled,
    controlsTray: (window.innerWidth >= 1181 ? bell : launcher)?.ariaControlsElements?.includes(panel) === true,
    rowCount: root?.querySelectorAll(".notification-row").length ?? 0,
    rowDisabled: root?.querySelector(".notification-row-dismiss")?.disabled ?? null,
    stateText: root?.querySelector(".notification-state")?.textContent ?? null,
    listCount: root?.querySelectorAll(".notification-list").length ?? 0,
    listScrollHeight: list?.scrollHeight ?? 0,
    listClientHeight: list?.clientHeight ?? 0,
    listScrollTop: list?.scrollTop ?? 0,
    longMessageFits: !!longMessage && longMessage.textContent.length > 2000
      && longMessage.scrollWidth <= longMessage.clientWidth + 1
      && longMessage.scrollHeight <= longMessage.clientHeight + 1,
    actionsVisible: !!box && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
    drawerOpen: !!rail()?.querySelector(".compact-rail-backdrop"),
    speechCancels,
    shortcutEscaped,
    backgroundPointers,
  };
}
window.__notificationsFixture = {
  ready: true, error: null, settle,
  trayRegistered() { return customElements.get("session-notification-tray") !== undefined; },
  async select(key, expectFresh = true) {
    current = key;
    app.setState({ selectedMachine: targets[key].machine, selectedWorkspace: workspace(targets[key].session.cwd), sessions: [targets[key].session] });
    await app.sessions.selectSession(targets[key].session, { updateUrl: false });
    const socket = sockets.at(-1);
    if (!socket) throw new Error("session socket was not created");
    socket.open();
    socket.emit({ type: "session.subscribed" });
    await settle();
    if (expectFresh) {
      for (let i = 0; i < 100; i++) {
        const coverage = app.notifications.socketCoverage;
        if (app.state.selectedNotificationInbox?.status === "fresh"
          && coverage?.postMarkerAdmission !== undefined
          && app.notifications.selectedRefresh === undefined) break;
        await settle();
      }
      if (app.state.selectedNotificationInbox?.status !== "fresh"
        || app.notifications.socketCoverage?.postMarkerAdmission === undefined
        || app.notifications.selectedRefresh !== undefined) {
        throw new Error("notification snapshot and post-subscription read did not settle");
      }
    }
    await settle();
  },
  presentationKind() { return app.notificationPresentation().kind; },
  daemonId() { return app.state.selectedNotificationInbox?.daemonInstanceId; },
  beginSelect(key) { selection = this.select(key); },
  waitSelection() { return selection; },
  holdRead() { holdNextRead = true; },
  readHeld() { return pendingRead !== undefined; },
  releaseRead() { if (!pendingRead) throw new Error("No held inbox read"); const resolve = pendingRead; pendingRead = undefined; resolve(); },
  holdMutation() { holdNextMutation = true; },
  mutationHeld() { return pendingMutation !== undefined; },
  releaseMutation() { if (!pendingMutation) throw new Error("No held mutation"); const resolve = pendingMutation; pendingMutation = undefined; resolve(); },
  setReadFailure(value) { failReads = value; },
  center(name) { const box = rect(element(name)); return box && box.width > 0 && box.height > 0 ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null; },
  visibleDismiss() {
    const list = element("list");
    const bounds = rect(list);
    return [...list.querySelectorAll(".notification-row-dismiss")].some((button) => {
      const box = rect(button);
      return box.left >= bounds.left && box.right <= bounds.right
        && box.top >= bounds.top && box.bottom <= bounds.bottom
        && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
    });
  },
  safeAreaPaddingMatches() {
    const probe = document.createElement("div");
    probe.style.padding = "env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
    document.body.append(probe);
    const expected = getComputedStyle(probe);
    const actual = getComputedStyle(app.shadowRoot.querySelector(".notification-surface"));
    const sides = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];
    const matches = sides.every((side) => expected[side] === actual[side]);
    probe.remove();
    return matches;
  },
  hit(name) {
    const node = element(name);
    const box = rect(node);
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    let hit = document.elementFromPoint(x, y);
    const chain = [];
    while (hit) {
      chain.push([hit.tagName, String(hit.className)]);
      const inner = hit.shadowRoot?.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return { box, chain, matches: hit === node || node.contains(hit) };
  },
  async focus(name) { element(name)?.focus(); await settle(); },
  async focusLastRow() { tray()?.shadowRoot?.querySelector(".notification-row:last-child .notification-row-dismiss")?.focus(); await settle(); },
  composerText() { return element("composer")?.textContent ?? ""; },
  clearComposer() { const editor = app.shadowRoot.querySelector("prompt-editor"); editor?.clear?.(); },
  inspect,
  swapPlacement() { const bell = element("bell"); const settings = rail().querySelector(".settings-button"); savedPlacement = { bell, parent: bell.parentNode, next: bell.nextSibling }; settings.after(bell); },
  restorePlacement() { savedPlacement.parent.insertBefore(savedPlacement.bell, savedPlacement.next); savedPlacement = undefined; },
  installSpeechProbe() { const editor = app.shadowRoot.querySelector("prompt-editor"); if (!editor) throw new Error("prompt editor is missing"); editor.cancelSpeechInput = () => { speechCancels++; return true; }; const handle = app.keyboard.handle.bind(app.keyboard); app.keyboard.handle = (...args) => { shortcutEscaped = true; return handle(...args); }; },
  requestCount() { return calls.length; },
  mutationCount() { return calls.filter((call) => call.method === "POST").length; },
  lastMutation() { return calls.filter((call) => call.method === "POST").at(-1); },
  markAnnouncements() {
    markedRegions = [...app.shadowRoot.querySelectorAll("[aria-live='polite'], [aria-live='assertive']")];
    markedChildren = markedRegions.map((region) => [...region.children]);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && node.hasAttribute("data-announcement-id")) announcementAppends++;
        }
      }
    });
    for (const region of markedRegions) observer.observe(region, { childList: true, subtree: true });
    return this.announcements();
  },
  liveRegionCounts() { return { polite: app.shadowRoot.querySelectorAll("[aria-live='polite']").length, assertive: app.shadowRoot.querySelectorAll("[aria-live='assertive']").length }; },
  announcementAppendCount() { return announcementAppends; },
  announcementRegionsStable() { const regions = [...app.shadowRoot.querySelectorAll("[aria-live='polite'], [aria-live='assertive']")]; return regions.length === markedRegions.length && regions.every((region, index) => region === markedRegions[index]); },
  announcements() { const regions = [...app.shadowRoot.querySelectorAll("[aria-live='polite'], [aria-live='assertive']")]; return { polite: [...(regions.find((region) => region.getAttribute("aria-live") === "polite")?.children ?? [])].map((node) => node.textContent), assertive: [...(regions.find((region) => region.getAttribute("aria-live") === "assertive")?.children ?? [])].map((node) => node.textContent) }; },
  announcementNodesStable() { const regions = [...app.shadowRoot.querySelectorAll("[aria-live='polite'], [aria-live='assertive']")]; return regions.length === markedRegions.length && regions.every((region, index) => region === markedRegions[index] && markedChildren[index].every((child, position) => region.children[position] === child)); },
  async reconnect() { const connected = new Promise((resolve) => { nextSocket = resolve; }); sockets.at(-1).drop(); const socket = await connected; nextSocket = undefined; socket.open(); socket.emit({ type: "session.subscribed" }); await settle(); },
  async resync() { const store = stores[current]; store.revision++; const snap = snapshot(current); sockets.at(-1).emit({ type: "notifications.inbox", daemonInstanceId: store.daemon, catalogRevision: snap.catalogRevision, summary: snap.summary, dismissThrough: snap.dismissThrough, delta: { kind: "resync" } }); await settle(); },
  async replaceDaemon() { const store = stores[current]; store.daemon = "d2"; store.rows = [row(1, "warning", "d2")]; store.discarded = 0; store.watermark = 0; store.revision++; const snap = snapshot(current); sockets.at(-1).emit({ type: "notifications.inbox", daemonInstanceId: "d2", catalogRevision: snap.catalogRevision, summary: snap.summary, dismissThrough: snap.dismissThrough, delta: { kind: "added", notification: store.rows[0] } }); await settle(); },
  async addLive(severity) {
    const store = stores[current];
    const nextOrder = Math.max(0, ...store.rows.map((item) => item.order)) + 1;
    const item = row(nextOrder, severity, store.daemon);
    const overflow = store.rows.length === 100;
    store.rows = [item, ...store.rows.slice(0, 99)];
    if (overflow) {
      store.discarded++;
      store.watermark++;
    }
    store.revision++;
    const snap = snapshot(current);
    lastEvent = {
      type: "notifications.inbox",
      daemonInstanceId: store.daemon,
      catalogRevision: snap.catalogRevision,
      summary: snap.summary,
      dismissThrough: snap.dismissThrough,
      delta: { kind: "added", notification: item },
    };
    sockets.at(-1).emit(lastEvent);
    await settle();
  },
  async replayLive() { sockets.at(-1).emit(lastEvent); await settle(); },
};
`;

await main();
