# Project History Inset Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render populated Project History entries as continuous cards with balanced 8px side gutters and an accessible, transparent remove action overlaid inside each card.

**Architecture:** Keep the existing `RecentProjectsPanel` DOM and interaction callbacks unchanged: the primary and remove actions remain sibling buttons inside an inert row. Replace only the component-local two-column presentation with a full-width primary card, an absolutely positioned remove target, and a component-local activity-indicator offset; verify the CSS contract in Vitest and the real geometry in Chromium through a disposable `workspace-panel` fixture.

**Tech Stack:** TypeScript 6, Lit 3, CSS shadow-DOM styles, Vitest/jsdom, Vite, Chromium DevTools Protocol, Changesets.

## Global Constraints

- Node.js 22.19.0 is the version floor; add no runtime or development dependency.
- Scope production changes to populated Project History rows in `RecentProjectsPanel`; do not modify `ActivityRail`, navigation, `WorkspacePanel`, shared `listStyles`, server code, session-daemon code, APIs, controllers, persistence, or removal behavior.
- Preserve the existing inert row with sibling primary and remove buttons; never nest the remove button inside the primary button.
- Give every populated row an 8px inline-start gutter from panel content and an 8px inline-end gutter from the list's usable content edge; a non-overlay scrollbar remains at the panel edge outside the inline-end gutter.
- Use one continuous card surface: no detached column, separating border, tinted close region, or visible close region at rest on hover-capable devices.
- The remove target is 32px wide, spans the full card height, stays transparent, appears on row hover or `:focus-within`, remains visible under `@media (hover: none)`, and changes only its icon color from `var(--pi-muted)` to `var(--pi-text)` on direct hover.
- The primary action uses 54px trailing padding; `.action-activity` uses `right: 38px`; neither text nor activity may overlap the remove target.
- Preserve loading, failure, empty, selection, typography, path-wrapping, keyboard, focus-restoration, accessible-name, tooltip, touch, and removal-confirmation behavior.
- Use ordinary component-scoped selectors with no `!important` declarations.
- Add a patch Changeset for `@hyperdreamer/pi-webui`; do not edit `CHANGELOG.md`, README files, or user documentation.
- This is a client-only change; no session-daemon restart is required.

## Task 1: Implement and verify inset Project History cards

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/RecentProjectsPanel.ts:156-186`
- Test: `src/client/src/components/RecentProjectsPanel.test.ts:169-181`
- Create: `.changeset/polish-project-history-cards.md`
- Temporary verification only, then delete: `src/client/project-history-layout-probe.html`
- Temporary verification only, then delete: `src/client/project-history-layout-probe.ts`
- Temporary verification only, then delete: `/tmp/pi-webui-project-history-layout-probe.mjs`

**Interfaces:**

- Consumes: `RecentProjectsPanel.styles`, the existing `panelStyles(): string` test helper, and the existing `.list-body`, `.action-row`, `.action-main`, `.action-activity`, `.recent-project-row`, `.recent-project-open`, and `.recent-project-remove` classes.
- Preserves: the rendered DOM, `onOpenRegistered`, `onOpenClosed`, `onRemoveRequested`, accessible labels, focus callbacks, and every TypeScript API.
- Produces: component-local CSS in which `.recent-projects-list` has 8px inline padding, `.recent-project-row` is a single positioning container, `.recent-project-open` fills the card with 54px trailing padding, `.recent-project-remove` is a transparent 32px-by-full-height overlay, and `.action-activity` is fixed at `right: 38px`.

- [ ] **Step 1: Replace the obsolete fixed-column style test with failing overlay-contract tests**

In `src/client/src/components/RecentProjectsPanel.test.ts`, replace the existing test named `"reserves a fixed action slot with hover, focus, and non-hover visibility rules"` with these two tests:

```ts
  it("lays out inset cards with an overlaid remove target and collision-free activity", () => {
    const styles = panelStyles();

    expect(styles).toMatch(/\.recent-projects-list\s*\{[^}]*box-sizing:\s*border-box;[^}]*padding-inline:\s*8px;/);
    expect(styles).toMatch(/\.recent-project-row\s*\{[^}]*display:\s*block;/);
    expect(styles).not.toMatch(/\.recent-project-row\s*\{[^}]*grid-template-columns:/);
    expect(styles).toMatch(/\.recent-project-open\s*\{[^}]*width:\s*100%;[^}]*border-radius:\s*8px;[^}]*padding-right:\s*54px;[^}]*font:\s*inherit;/);
    expect(styles).toMatch(/\.recent-project-remove\s*\{[^}]*position:\s*absolute;[^}]*top:\s*0;[^}]*right:\s*0;[^}]*z-index:\s*2;[^}]*width:\s*32px;[^}]*min-width:\s*32px;[^}]*height:\s*100%;[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*border-radius:\s*0 8px 8px 0;[^}]*background:\s*transparent;/);
    expect(styles).toMatch(/\.action-activity\s*\{\s*right:\s*38px;\s*\}/);
    expect(styles).not.toContain("!important");
  });

  it("reveals the inline remove action without tinting its target", () => {
    const styles = panelStyles();

    expect(styles).toMatch(/\.recent-project-remove\s*\{[^}]*color:\s*var\(--pi-muted\);[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/);
    expect(styles).toMatch(/\.recent-project-row:hover \.recent-project-remove,\s*\.recent-project-row:focus-within \.recent-project-remove\s*\{\s*opacity:\s*1;\s*pointer-events:\s*auto;/);
    expect(styles).toMatch(/\.recent-project-remove:hover\s*\{\s*color:\s*var\(--pi-text\);\s*background:\s*transparent;\s*\}/);
    expect(styles).not.toMatch(/\.recent-project-row\.selected \.recent-project-remove\s*\{[^}]*background:/);

    const nonHover = styles.slice(styles.indexOf("@media (hover: none)"));
    expect(nonHover).toMatch(/\.recent-project-remove\s*\{\s*opacity:\s*1;\s*pointer-events:\s*auto;/);
  });
```

- [ ] **Step 2: Run the focused test and confirm the red phase**

Run:

```bash
npm test -- --run src/client/src/components/RecentProjectsPanel.test.ts
```

Expected: FAIL with both new layout tests reporting that the current styles still use the `grid-template-columns: minmax(0, 1fr) 32px` column and lack the list inset, full-width card, absolute overlay, 54px padding, transparent hover target, and `right: 38px` activity offset. Do not edit production code until this failure is observed and recorded.

- [ ] **Step 3: Implement the exact component-local layout**

In `src/client/src/components/RecentProjectsPanel.ts`, keep all rendering and behavior unchanged. Replace only the component-local CSS block from the fixed-slot comment through the selected-remove rule with the following rules, retaining the existing path/status rules before it and focus/media rules after it:

```ts
    /* The sibling remove action overlays the card so the row remains one visual surface. */
    .recent-projects-list { box-sizing: border-box; padding-inline: 8px; }
    .recent-project-row { display: block; }
    .recent-project-open { width: 100%; border-radius: 8px; padding-right: 54px; font: inherit; }
    .recent-project-remove {
      position: absolute;
      top: 0;
      right: 0;
      z-index: 2;
      width: 32px;
      min-width: 32px;
      height: 100%;
      padding: 0;
      border: 0;
      border-radius: 0 8px 8px 0;
      background: transparent;
      display: grid;
      place-items: center;
      color: var(--pi-muted);
      opacity: 0;
      pointer-events: none;
    }
    .action-activity { right: 38px; }
    .recent-project-remove svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .recent-project-row:hover .recent-project-remove,
    .recent-project-row:focus-within .recent-project-remove { opacity: 1; pointer-events: auto; }
    .recent-project-remove:hover { color: var(--pi-text); background: transparent; }
```

Delete the old `.recent-project-row { grid-template-columns: ... }` rule, the old segmented border-radius declarations, the old tinted hover background, and the old `.recent-project-row.selected .recent-project-remove` rule. Keep this existing rule unchanged after the replacement:

```ts
    .recent-project-open:focus-visible, .recent-project-remove:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
```

Keep this existing touch rule unchanged:

```ts
    @media (hover: none) {
      .recent-project-remove { opacity: 1; pointer-events: auto; }
    }
```

- [ ] **Step 4: Run focused green checks**

Run:

```bash
npm test -- --run src/client/src/components/RecentProjectsPanel.test.ts
npm test -- --run src/client/src/components/PiWebUiApp.recentProjects.focus.test.ts
npm run typecheck
npx eslint src/client/src/components/RecentProjectsPanel.ts src/client/src/components/RecentProjectsPanel.test.ts
```

Expected: every command exits 0; the focused component suite passes with no failures, the app-level focus suite passes with no failures, TypeScript reports no errors, and ESLint reports no errors.

- [ ] **Step 5: Add the patch Changeset**

Create `.changeset/polish-project-history-cards.md` with exactly:

```md
---
"@hyperdreamer/pi-webui": patch
---

Polish Project History entries with balanced side spacing and an inline remove action that stays hidden until hover or focus.
```

Do not edit `CHANGELOG.md`.

- [ ] **Step 6: Create a disposable real-component Chromium fixture**

Create `src/client/project-history-layout-probe.html` with exactly:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Project History layout probe</title>
    <style>
      :root {
        color-scheme: light;
        --pi-bg: #f8f4ea;
        --pi-text: #211d28;
        --pi-muted: #625b6b;
        --pi-border: #c9c1b3;
        --pi-border-muted: #ddd5c8;
        --pi-surface: #fffaf0;
        --pi-surface-hover: #f1eadc;
        --pi-selection-bg: #ece5ff;
        --pi-accent: #7c3aed;
        --pi-warning: #9a6700;
        --pi-success: #0f9d8a;
      }
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: var(--pi-bg); }
      workspace-panel { width: min(540px, 100vw); height: 360px; }
    </style>
  </head>
  <body>
    <script type="module" src="./project-history-layout-probe.ts"></script>
  </body>
</html>
```

Create `src/client/project-history-layout-probe.ts` with exactly:

```ts
import { html } from "lit";
import type { Project, RecentProjectEntry, Workspace, WorkspaceActivity } from "../shared/apiTypes";
import { RecentProjectsPanel } from "./src/components/RecentProjectsPanel";
import { WorkspacePanel, type ResolvedWorkspacePanelTab } from "./src/components/WorkspacePanel";

const paths = [
  "/work/alpha-project-with-a-long-name-that-wraps-near-the-action-area",
  "/work/beta",
  "/work/gamma",
  "/work/delta",
  "/work/epsilon",
  "/work/zeta",
  "/work/eta",
  "/work/theta",
];
const entries: RecentProjectEntry[] = paths.map((path, index) => ({
  id: `entry-${String(index)}`,
  name: path.split("/").at(-1) ?? path,
  path,
  lastUsedAt: "2026-01-01T00:00:00.000Z",
}));
const projects: Project[] = paths.map((path, index) => ({
  id: `project-${String(index)}`,
  name: path.split("/").at(-1) ?? path,
  path,
  createdAt: "2026-01-01T00:00:00.000Z",
}));
const activeWorkspace: Workspace = {
  id: "workspace-alpha",
  projectId: projects[0]?.id ?? "project-0",
  path: paths[0] ?? "/work/alpha",
  label: "main",
  isMain: true,
  isGitRepo: true,
  isGitWorktree: false,
};
const activeActivity: WorkspaceActivity = {
  cwd: activeWorkspace.path,
  hasSessionActivity: true,
  hasTerminalActivity: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const state = { kind: "ready" as const, entries };
const workspacesByProjectId = { [activeWorkspace.projectId]: [activeWorkspace] };
const activities = { [activeWorkspace.path]: activeActivity };

const tabs: ResolvedWorkspacePanelTab[] = [{
  id: "core:recent-projects",
  title: "Recent Projects",
  render: () => html`
    <recent-projects-panel
      .state=${state}
      .projects=${projects}
      .workspacesByProjectId=${workspacesByProjectId}
      .activities=${activities}
    ></recent-projects-panel>
  `,
}];

const workspacePanel = new WorkspacePanel();
workspacePanel.tabs = tabs;
workspacePanel.tool = "core:recent-projects";
document.body.append(workspacePanel);
await workspacePanel.updateComplete;
const historyPanel = workspacePanel.renderRoot.querySelector<RecentProjectsPanel>("recent-projects-panel");
if (historyPanel === null) throw new Error("RecentProjectsPanel did not render");
await historyPanel.updateComplete;
await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => { resolve(); })));
document.documentElement.dataset["probeReady"] = "true";
```

Create `/tmp/pi-webui-project-history-layout-probe.mjs` with exactly:

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const endpoint = process.env.CDP_URL ?? "http://127.0.0.1:9331";
const viteUrl = process.env.VITE_URL ?? "http://127.0.0.1:8893";
const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
const page = targets.find((target) => target.type === "page");
if (page === undefined) throw new Error("No Chromium page target available");
const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id === undefined) return;
  const request = pending.get(message.id);
  if (request === undefined) return;
  pending.delete(message.id);
  if (message.error !== undefined) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); });
}

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails !== undefined) throw new Error(response.exceptionDetails.text ?? "Browser evaluation failed");
  return response.result.value;
}

async function configure(width, mobile, touch) {
  await send("Emulation.setDeviceMetricsOverride", { width, height: 700, deviceScaleFactor: 1, mobile });
  await send("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: touch ? 1 : 0 });
  await send("Page.navigate", { url: `${viteUrl}/project-history-layout-probe.html?width=${String(width)}&touch=${String(touch)}` });
  await evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 20000;
    const check = () => {
      if (document.documentElement.dataset.probeReady === "true") return resolve(true);
      if (Date.now() > deadline) return reject(new Error("Probe fixture did not settle"));
      setTimeout(check, 50);
    };
    check();
  })`);
}

async function measure() {
  return evaluate(`(() => {
    const workspace = document.querySelector("workspace-panel");
    const workspaceRoot = workspace.shadowRoot;
    const history = workspaceRoot.querySelector("recent-projects-panel");
    const root = history.shadowRoot;
    const content = workspaceRoot.querySelector(".panel-content");
    const header = workspaceRoot.querySelector("header");
    const list = root.querySelector(".recent-projects-list");
    const row = root.querySelector(".recent-project-row");
    const card = root.querySelector(".recent-project-open");
    const remove = root.querySelector(".recent-project-remove");
    const activity = root.querySelector(".action-activity");
    const path = root.querySelector(".recent-project-path");
    const rect = (element) => {
      const value = element.getBoundingClientRect();
      return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height };
    };
    const workspaceRect = rect(workspace);
    const contentRect = rect(content);
    const headerRect = rect(header);
    const listRect = rect(list);
    const rowRect = rect(row);
    const cardRect = rect(card);
    const removeRect = rect(remove);
    const activityRect = rect(activity);
    const pathRect = rect(path);
    const removeStyle = getComputedStyle(remove);
    const listStyle = getComputedStyle(list);
    const scrollbarWidth = list.offsetWidth - list.clientWidth;
    const usableListRight = listRect.right - scrollbarWidth;
    return {
      viewportWidth: window.innerWidth,
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      workspace: workspaceRect,
      content: contentRect,
      header: headerRect,
      headerDisplay: getComputedStyle(header).display,
      list: listRect,
      listClientHeight: list.clientHeight,
      listScrollHeight: list.scrollHeight,
      listPaddingLeft: listStyle.paddingLeft,
      listPaddingRight: listStyle.paddingRight,
      scrollbarWidth,
      row: rowRect,
      card: cardRect,
      remove: removeRect,
      activity: activityRect,
      path: pathRect,
      startGap: cardRect.left - contentRect.left,
      endGap: usableListRight - cardRect.right,
      activityToRemoveGap: removeRect.left - activityRect.right,
      activityOverlapsRemove: activityRect.right > removeRect.left,
      pathOverlapsActivity: pathRect.right > activityRect.left,
      removeInsideCard: removeRect.left >= cardRect.left && removeRect.right <= cardRect.right && removeRect.top === cardRect.top && removeRect.bottom === cardRect.bottom,
      hoverNone: matchMedia("(hover: none)").matches,
      removeOpacity: removeStyle.opacity,
      removePointerEvents: removeStyle.pointerEvents,
      removeBackground: removeStyle.backgroundColor,
      removeColor: removeStyle.color,
      removeOutlineStyle: removeStyle.outlineStyle,
      removeFocused: root.activeElement === remove,
    };
  })()`);
}

async function moveMouse(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function screenshot(path) {
  const capture = await send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  await fs.writeFile(path, Buffer.from(capture.data, "base64"));
}

function closeTo(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 0.25, `${label}: expected ${String(expected)}, got ${String(actual)}`);
}

await send("Page.enable");
await send("Runtime.enable");

await configure(1280, false, false);
await moveMouse(1000, 650);
const resting = await measure();
await moveMouse(resting.card.left + 120, resting.card.top + resting.card.height / 2);
const rowHover = await measure();
await moveMouse(resting.remove.left + resting.remove.width / 2, resting.remove.top + resting.remove.height / 2);
const directHover = await measure();
await screenshot("/tmp/pi-webui-project-history-layout-desktop.png");
await moveMouse(1000, 650);
await evaluate(`(() => {
  const workspace = document.querySelector("workspace-panel");
  const history = workspace.shadowRoot.querySelector("recent-projects-panel");
  history.shadowRoot.querySelector(".recent-project-remove").focus();
})()`);
const focused = await measure();

assert.equal(resting.viewportWidth, 1280);
assert.equal(resting.listPaddingLeft, "8px");
assert.equal(resting.listPaddingRight, "8px");
closeTo(resting.startGap, 8, "desktop start gutter");
closeTo(resting.endGap, 8, "desktop end gutter");
closeTo(resting.header.left, resting.workspace.left, "header left edge");
closeTo(resting.header.right, resting.workspace.right, "header right edge");
closeTo(resting.list.right, resting.workspace.right, "scroll container right edge");
assert.ok(resting.listScrollHeight > resting.listClientHeight, "fixture must expose a vertical scrollbar");
assert.equal(resting.documentScrollWidth, resting.documentClientWidth);
closeTo(resting.remove.width, 32, "remove width");
closeTo(resting.remove.height, resting.card.height, "remove full height");
assert.equal(resting.removeInsideCard, true);
closeTo(resting.activityToRemoveGap, 7, "activity box to remove gap");
assert.equal(resting.activityOverlapsRemove, false);
assert.equal(resting.pathOverlapsActivity, false);
assert.equal(resting.removeOpacity, "0");
assert.equal(resting.removePointerEvents, "none");
assert.equal(rowHover.removeOpacity, "1");
assert.equal(rowHover.removePointerEvents, "auto");
assert.equal(rowHover.removeBackground, "rgba(0, 0, 0, 0)");
assert.equal(directHover.removeBackground, "rgba(0, 0, 0, 0)");
assert.notEqual(directHover.removeColor, rowHover.removeColor);
assert.equal(focused.removeFocused, true);
assert.equal(focused.removeOpacity, "1");
assert.equal(focused.removePointerEvents, "auto");
assert.notEqual(focused.removeOutlineStyle, "none");

await configure(390, true, true);
const touch = await measure();
await screenshot("/tmp/pi-webui-project-history-layout-touch.png");
assert.equal(touch.viewportWidth, 390);
assert.equal(touch.headerDisplay, "none");
assert.equal(touch.hoverNone, true);
closeTo(touch.startGap, 8, "touch start gutter");
closeTo(touch.endGap, 8, "touch end gutter");
assert.equal(touch.removeOpacity, "1");
assert.equal(touch.removePointerEvents, "auto");
assert.equal(touch.removeBackground, "rgba(0, 0, 0, 0)");
assert.equal(touch.removeInsideCard, true);
assert.equal(touch.activityOverlapsRemove, false);
assert.equal(touch.pathOverlapsActivity, false);
assert.equal(touch.documentScrollWidth, touch.documentClientWidth);

console.log(JSON.stringify({ resting, rowHover, directHover, focused, touch }, null, 2));
socket.close();
```

- [ ] **Step 7: Run the Chromium geometry and interaction probe, inspect screenshots, and clean up**

First ensure ports `8893` and `9331` are unused. Then run the disposable Vite and Chromium processes and the probe:

```bash
if ss -ltnH 'sport = :8893' | grep -q . || ss -ltnH 'sport = :9331' | grep -q .; then
  echo "Probe port already in use" >&2
  exit 1
fi
rm -rf /tmp/pi-webui-project-history-layout-profile
npm run dev:client -- --host 127.0.0.1 --port 8893 --strictPort >/tmp/pi-webui-project-history-layout-vite.log 2>&1 &
VITE_PID=$!
chromium --headless=new --disable-gpu --no-sandbox \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9331 \
  --user-data-dir=/tmp/pi-webui-project-history-layout-profile about:blank \
  >/tmp/pi-webui-project-history-layout-chromium.log 2>&1 &
CHROMIUM_PID=$!
for attempt in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:8893/project-history-layout-probe.html >/dev/null \
    && curl -fsS http://127.0.0.1:9331/json/list >/dev/null; then
    break
  fi
  if [ "$attempt" -eq 40 ]; then
    cat /tmp/pi-webui-project-history-layout-vite.log
    cat /tmp/pi-webui-project-history-layout-chromium.log
    exit 1
  fi
  sleep 0.25
done
VITE_URL=http://127.0.0.1:8893 CDP_URL=http://127.0.0.1:9331 \
  node /tmp/pi-webui-project-history-layout-probe.mjs \
  >/tmp/pi-webui-project-history-layout-result.json
cat /tmp/pi-webui-project-history-layout-result.json
identify /tmp/pi-webui-project-history-layout-desktop.png \
  /tmp/pi-webui-project-history-layout-touch.png
```

Expected: the Node probe exits 0 and prints measurements proving exact 8px gutters, a 32px full-height remove target contained by the card, a 7px activity-box gap, no text/activity/remove overlap, hidden desktop rest state, visible row-hover/focus states, explicitly matched `(hover: none)` touch visibility, transparent direct-hover target, fixed desktop header/scroll edges, hidden existing narrow header, and no horizontal document overflow. `identify` reports two non-empty PNG screenshots. Inspect both screenshots and confirm there is no segmented trailing card surface, clipping, overlap, or incoherent text.

After inspection, stop processes by listener PID as well as recorded PID, then delete every fixture and probe artifact:

```bash
for port in 8893 9331; do
  pids=$(ss -ltnpH "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | sort -u)
  for pid in $pids; do kill "$pid" 2>/dev/null || true; done
done
for attempt in $(seq 1 30); do
  if ! pgrep -f '[r]emote-debugging-port=9331' >/dev/null; then break; fi
  sleep 0.2
done
rm -rf \
  src/client/project-history-layout-probe.html \
  src/client/project-history-layout-probe.ts \
  /tmp/pi-webui-project-history-layout-probe.mjs \
  /tmp/pi-webui-project-history-layout-profile \
  /tmp/pi-webui-project-history-layout-vite.log \
  /tmp/pi-webui-project-history-layout-chromium.log \
  /tmp/pi-webui-project-history-layout-result.json \
  /tmp/pi-webui-project-history-layout-desktop.png \
  /tmp/pi-webui-project-history-layout-touch.png
```

Verify cleanup:

```bash
if ss -ltnH 'sport = :8893' | grep -q . || ss -ltnH 'sport = :9331' | grep -q .; then
  echo "Probe listener still running" >&2
  exit 1
fi
test ! -e src/client/project-history-layout-probe.html
test ! -e src/client/project-history-layout-probe.ts
test ! -e /tmp/pi-webui-project-history-layout-probe.mjs
git status --short
```

Expected: no probe listener or temporary fixture remains. Git status lists only `RecentProjectsPanel.ts`, `RecentProjectsPanel.test.ts`, and `.changeset/polish-project-history-cards.md`.

- [ ] **Step 8: Run broad verification**

Run these commands serially with no concurrent heavy process:

```bash
npm run verify:fast
npm run verify
git diff --check
git status --short
```

Expected: `verify:fast` and the serial `verify` both exit 0 with no test failures; `git diff --check` prints nothing; Git status lists exactly the two component files and the new Changeset.

Review the final diff and confirm there are no DOM, callback, shared-style, server, session-daemon, README, or `CHANGELOG.md` changes.

- [ ] **Step 9: Commit the verified implementation**

```bash
git add \
  src/client/src/components/RecentProjectsPanel.ts \
  src/client/src/components/RecentProjectsPanel.test.ts \
  .changeset/polish-project-history-cards.md
git diff --cached --check
git commit -m "fix(ui): polish project history cards"
```

Expected: one implementation commit containing only the component-local style change, its focused regression tests, and the patch Changeset.
