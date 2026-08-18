# Workspace Tasks Browser Verification Continuation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Independently establish browser acceptance and complete verification for the committed Workspace Tasks feature after two stalled verification runs.

**Architecture:** Use a disposable raw-CDP harness in three bounded tasks: fixture construction, browser execution with measured-fix handling, and final serial verification. The source baseline is carried from `3373dc2`; all prior incomplete probe evidence is excluded.

**Tech Stack:** TypeScript, Lit custom elements, Vitest, Node.js 22.19+, Chromium DevTools Protocol, Changesets.

## Global Constraints

- The design in `docs/superpowers/specs/2026-08-18-workspace-tasks-browser-verification-continuation-design.md` and the approved Workspace Tasks design remain authoritative.
- Preserve the original `.sdd/workspace-tasks-global-catalog` run and the stalled `.sdd/workspace-tasks-global-catalog-recovery` run unchanged; neither is evidence.
- Treat `3373dc212ee5680924271126c496908a1b543143` as the source baseline and `5eda56bbab1c295e04623ed156039c3ddc847072` as the whole feature-range base.
- Do not use any prior Task 15 transcript, report, probe source, screenshots, result JSON, or child claim as evidence.
- Node.js 22.19 is the minimum supported runtime; add no runtime dependencies.
- Keep `src/plugin-api.ts`, `README.md`, `CHANGELOG.md`, session-daemon code/protocol, and runtime ownership unchanged.
- Use temporary files only under `/tmp/workspace-tasks-cdp-recovery-2`; clean every browser, server, profile, script, and result artifact before final scope inspection.
- Do not change shipped source/tests unless a fresh Chromium measurement proves a product defect. A measured fix requires a deterministic RED regression, minimal source change, GREEN focused verification, and the same browser measurement rerun.
- Use raw CDP against a page target from the new Chromium process; do not connect to the browser-level WebSocket and do not poll an unrelated fixed port.
- Run tasks serially and do not run full verification concurrently with another heavy process.
- Do not merge, push, publish, tag, release, or change the session daemon.

## Task 1: Construct A Disposable CDP Fixture

**Implementer tier:** Advanced

**Files:**

- Create temporarily, then retain only until Task 3 cleanup: `/tmp/workspace-tasks-cdp-recovery-2/fixture.html` and `/tmp/workspace-tasks-cdp-recovery-2/probe.mjs`.
- Create temporarily, then remove: `/tmp/workspace-tasks-cdp-recovery-2/fixture-result.json`.
- Do not modify shipped source or tests in this task.

**Interfaces:**

- Consumes the compiled `dist/pi-webui-plugins/workspace-tasks/tasksPanelElement.js` generated from the current worktree, `defineTasksPanelElement()`, and the internal `.context`, `.workspaceTasksState`, and `.workspaceTasksActions` element properties.
- Produces a fixture that sets `window.__workspaceTasksProbeReady` only after the real custom element module loads and mounts, plus a report at the task report path documenting the fixture URL, Chromium process, page-target discovery, and smoke measurements.
- Exposes deterministic fixture functions for Task 2: theme application, viewport measurement, scoped filter selection, group disclosure, duplicate-ID action lookup, promotion/demotion/collision/recovery actions, and keyboard focus snapshots.

- [ ] **Step 1: Establish the clean baseline and build the plugin**

Run:

```bash
git status --short
git rev-parse HEAD
npm run build:plugins
```

Require no tracked or untracked source changes before fixture creation. Confirm the built panel module exists under `dist/pi-webui-plugins/workspace-tasks/` and is generated from this checkout.

- [ ] **Step 2: Write a bounded fixture and raw-CDP driver**

Create only `/tmp/workspace-tasks-cdp-recovery-2/fixture.html` and `probe.mjs`. Serve `/` with `Content-Type: text/html; charset=utf-8`, serve only the required dist files below the worktree dist root, reject other paths, choose a free server and Chromium debugging port, and create a temporary Chromium profile. Discover `/json/list`, select a `type: "page"` target owned by this process, enable `Runtime` and `Page` on that page socket, navigate to the fixture, and wait for the readiness flag. Put server, browser, socket, and profile cleanup in `finally`.

- [ ] **Step 3: Run the fixture smoke probe**

At `1280x900` and `430x844`, verify that the real panel mounts, a theme can be applied, the panel and document have measurable dimensions, and a deterministic catalog state can be published. Write a compact JSON smoke result under `/tmp/workspace-tasks-cdp-recovery-2/fixture-result.json`; do not claim the full acceptance matrix yet.

- [ ] **Step 4: Inspect scope and report**

Run:

```bash
node --check /tmp/workspace-tasks-cdp-recovery-2/probe.mjs
git status --short
git diff --check
```

Write exactly one implementer report with the smoke result and fixture paths. Do not commit temporary files or shipped source.

## Task 2: Run Browser Acceptance And Handle Measured Defects

**Implementer tier:** Advanced

**Files:**

- Modify only temporary files under `/tmp/workspace-tasks-cdp-recovery-2/` for fixture corrections.
- Modify only if a fresh browser measurement proves a shipped defect: `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts`.
- Add only a corresponding deterministic regression in `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts` or `pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts` when a shipped defect is measured.

**Interfaces:**

- Consumes the Task 1 report at the successor run root and the smoke fixture at `/tmp/workspace-tasks-cdp-recovery-2/`.
- Produces a fresh browser report with raw-CDP evidence for desktop and `430x844`, classic/light/dark themes, scoped filters, native disclosures, equal IDs, promotion/demotion, collision, partial recovery, guarded retry, keyboard focus, long commands, and overflow.
- Produces no shipped commit when the committed panel passes. A measured product fix, if required, is committed with only its source/test files after focused GREEN checks.

- [ ] **Step 1: Verify Task 1 evidence and run the same fixture fresh**

Read only the Task 1 report from this successor run and inspect the temporary fixture. Re-run the driver from a fresh Chromium process and profile. If the fixture fails, classify the failure from HTTP status/content type, page exceptions, CDP target identity, and fixture assertions before changing anything.

- [ ] **Step 2: Exercise the acceptance matrix**

For both viewports and all three themes, record panel/document `scrollWidth` versus `clientWidth`, summary/body bounds, action wrapping, long script bounds and vertical overflow, visible focus outlines, duplicate-ID accessible names, `aria-pressed` filters, native disclosure state, and focus return after cancel/confirm. Exercise Global/Project equal IDs, promotion, demotion, destination collision, partial recovery, refresh-gated Retry, Tab, Escape, and Enter. Open collapsed disclosures before targeting their controls; a hidden element is not valid browser focus evidence.

- [ ] **Step 3: Fix only a measured product defect**

If the matrix measures a defect in shipped behavior, add its narrowest deterministic regression first and run it against the current source to observe RED. Make the minimum source change, run the focused panel suite to observe GREEN, rebuild the plugin, and repeat the identical CDP measurement. If the failure is fixture-only, correct only `/tmp` and repeat without source edits.

- [ ] **Step 4: Write the browser report and optional measured commit**

Record exact Chromium version, ports/process ownership, viewport/theme measurements, interaction traces, fixture corrections, and any source/test commit. Do not use prior-run evidence. Leave the temporary fixture for Task 3 cleanup.

## Task 3: Complete Serial Verification And Clean The Worktree

**Implementer tier:** Standard

**Files:**

- Delete temporary `/tmp/workspace-tasks-cdp-recovery-2/` artifacts before completion.
- Modify no shipped file unless Task 2 already committed a measured fix and a verification-only correction is strictly required by a fresh failing check.

**Interfaces:**

- Consumes Task 1 and Task 2 reports from the successor run, the current branch HEAD, and any measured source/test commit from Task 2.
- Produces a final implementation report with focused and full verification command output, package contents, Changeset status, clean scope, and removed temporary-artifact evidence.

- [ ] **Step 1: Run the focused cross-layer suites**

Run one at a time:

```bash
npm test -- --run src/shared/workspaceTasks.test.ts src/shared/workspaceTasksApi.test.ts scripts/build-plugins.test.mjs src/client/src/api/http.test.ts src/client/src/api/workspaceTasksApi.test.ts src/client/src/controllers/workspaceTasksController.test.ts src/client/src/components/PiWebUiApp.workspaceTasks.test.ts src/client/src/plugins/registry.test.ts pi-webui-plugins/pluginPublicApi.test.ts pi-webui-plugins/workspace-tasks/config.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts pi-webui-plugins/workspace-tasks/taskRunner.test.ts pi-webui-plugins/workspace-tasks/pi-webui-plugin.test.ts
npm run test:serial -- --run src/config.test.ts src/configMutationCoordinator.test.ts src/server/workspaceTasks src/server/app.workspaceTasks.test.ts src/server/app.localAliases.test.ts src/server/app.workspaceFiles.test.ts src/server/app.remoteProxy.test.ts
```

- [ ] **Step 2: Run the complete verification sequence**

Run serially on an otherwise idle machine:

```bash
npm run verify:fast
npm run verify
npm run build
npm run pack:dry
npm run changelog:status
git diff --check
```

Require every command to exit zero. Confirm the package dry run includes the compiled Workspace Tasks entry, `taskDomain.js`, `docs/plugins.md`, and `docs/config.md`, while paired HTML pages remain repository-only.

- [ ] **Step 3: Remove temporary artifacts and inspect the complete range**

Remove `/tmp/workspace-tasks-cdp-recovery-2/`, any Chromium profile, and any leftover process. Run:

```bash
git status --short
git diff --check
git diff --name-only 5eda56bbab1c295e04623ed156039c3ddc847072..HEAD
```

No temporary artifact may be tracked or remain in the worktree. Protected files remain unchanged. Write the final task report and commit only a measured Task 2 source/test change if one exists; otherwise do not create an empty commit.
