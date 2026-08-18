# Workspace Tasks Verification Recovery 3 Plan

> This plan is executed with the deterministic subagent-driven-development controller.

**Goal:** Independently establish browser acceptance and complete verification for the committed Workspace Tasks feature.

**Architecture:** Use a disposable raw-CDP fixture and serial verification in three bounded tasks. The source baseline is the existing clean head `44bd0051c94e44dc77f390eb6b12ab00b942017f`; prior blocked runs are non-evidence.

**Tech Stack:** TypeScript, Lit custom elements, Vitest, Node.js 22.19+, Chromium DevTools Protocol, Changesets.

## Global Constraints

- The design in `docs/superpowers/specs/2026-08-18-workspace-tasks-verification-recovery-3-design.md` and the approved Workspace Tasks design remain authoritative.
- Preserve `/data/home/guest/Development/pi-webui/.worktrees/workspace-tasks-global-catalog/.sdd/workspace-tasks-global-catalog` and `/data/home/guest/Development/pi-webui/.worktrees/workspace-tasks-global-catalog-recovery-2/.sdd/workspace-tasks-browser-verification-continuation` unchanged; neither is evidence.
- Treat `44bd0051c94e44dc77f390eb6b12ab00b942017f` as the source baseline and `5eda56bbab1c295e04623ed156039c3ddc847072` as the whole feature-range base.
- Do not use any prior Task 15 or browser-continuation transcript, report, probe source, screenshot, result JSON, or child claim as evidence.
- Node.js 22.19 is the minimum supported runtime; add no runtime dependencies.
- Keep `src/plugin-api.ts`, `README.md`, `CHANGELOG.md`, session-daemon code/protocol, and runtime ownership unchanged unless Task 2 documents a fresh measured product defect and follows its RED/GREEN rule.
- Use temporary files only under `/tmp/workspace-tasks-cdp-recovery-3`; clean every browser, server, profile, script, and result artifact before Task 3 completes.
- Use raw CDP against a page target discovered from the new Chromium process; do not connect to a browser-level socket or poll an unrelated fixed port.
- Run tasks serially and never run full verification concurrently with another heavy process.
- Do not merge, push, publish, tag, release, or change the session daemon.
- Every child prompt must be rendered to a file, stored in the dispatch intent, and compared byte-for-byte with the child first message before its report is admitted.

## Task 1: Audit The Existing Range And Build A Fresh CDP Fixture

**Implementer tier:** Advanced

**Files:**

- Create temporarily, then retain only until Task 3 cleanup: `/tmp/workspace-tasks-cdp-recovery-3/fixture.html` and `/tmp/workspace-tasks-cdp-recovery-3/probe.mjs`.
- Create temporarily, then remove: `/tmp/workspace-tasks-cdp-recovery-3/fixture-result.json`.
- Modify no shipped source or tests.

**Interfaces:**

- Consumes the compiled `dist/pi-webui-plugins/workspace-tasks/tasksPanelElement.js` generated from this worktree.
- Produces a fixture that imports `defineTasksPanelElement()`, mounts the real custom element, assigns controller-shaped `.context`, `.workspaceTasksState`, and `.workspaceTasksActions`, and exposes deterministic helpers for Task 2.
- Produces a report documenting the exact clean source range, fresh server/Chromium/page-target identity, helper inventory, and two-viewport smoke measurements.

- [ ] **Step 1: Verify the pinned clean source range and build the plugin**

Run:

```bash
git status --short
git rev-parse HEAD
git diff --name-only 44bd0051c94e44dc77f390eb6b12ab00b942017f..HEAD
npm run build:plugins
```

Require `HEAD` to equal `44bd0051c94e44dc77f390eb6b12ab00b942017f`, an empty source diff, and a generated panel module under `dist/pi-webui-plugins/workspace-tasks/`.

- [ ] **Step 2: Construct only the disposable fixture and raw-CDP driver**

Serve `/` as `text/html; charset=utf-8`, allowlist only the required generated Workspace Tasks modules below the worktree `dist` root, reject other paths, choose dynamic server/debug ports, use a temporary Chromium profile, discover `/json/list`, select a `type: "page"` target owned by this process, connect only to its page socket, enable `Runtime` and `Page`, and clean all resources in `finally`.

The fixture must expose theme application, viewport measurement, catalog publication, scoped filters, native group disclosure, duplicate-ID action lookup, promotion/demotion/collision/recovery controls, and keyboard focus snapshots.

- [ ] **Step 3: Run fresh smoke measurements**

At `1280x900` and `430x844`, verify real custom-element mounting, theme application, measurable panel/document dimensions, deterministic catalog publication, and required helper inventory. Write and then remove the compact smoke result during the run; retain only the fixture and driver for Task 2.

- [ ] **Step 4: Inspect scope and report**

Run `node --check /tmp/workspace-tasks-cdp-recovery-3/probe.mjs`, `git status --short`, and `git diff --check`. Write exactly one implementer report. Do not commit temporary files or shipped source.

## Task 2: Run Fresh Browser Acceptance And Handle Only Measured Defects

**Implementer tier:** Advanced

**Files:**

- Modify only temporary files under `/tmp/workspace-tasks-cdp-recovery-3` for fixture corrections.
- Modify only `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts` and one corresponding deterministic regression in `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts` or `pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts` if a fresh Chromium measurement proves a shipped defect.

**Interfaces:**

- Consumes only the Task 1 report from this run and the fresh temporary fixture.
- Produces a fresh raw-CDP acceptance report covering desktop/mobile, classic/light/dark themes, scope filters, native disclosures, equal IDs, promotion/demotion, collision, partial and unknown recovery, guarded retry, keyboard focus, long commands, and overflow.
- Produces no shipped commit when the committed panel passes. Any measured fix must be minimal, committed, and re-measured identically after focused GREEN verification.

- [ ] **Step 1: Verify Task 1 evidence and start a fresh browser process**

Read only this run's Task 1 report. Start a new Chromium process/profile and rerun the fixture. Classify fixture failures from HTTP status/content type, CDP target identity, page exceptions, and fixture assertions before changing anything.

- [ ] **Step 2: Exercise the complete acceptance matrix**

For both viewports and all three themes, record panel/document `scrollWidth` versus `clientWidth`, summary/body bounds, action wrapping, long-script bounds and vertical overflow, visible focus outlines, duplicate-ID accessible names, `aria-pressed` filters, native disclosure state, and focus return after cancel/confirm. Exercise Global/Project equal IDs, promotion, demotion, destination collision, partial recovery, refresh-gated Retry, Tab, Escape, and Enter. Open collapsed disclosures before targeting controls.

- [ ] **Step 3: Apply the measured-defect protocol if needed**

If and only if the matrix measures a shipped defect, write its narrowest deterministic regression first and run it against the current source to observe RED. Make the minimum source change, run focused GREEN verification, rebuild the plugin, and repeat the identical CDP measurement. Fixture-only failures are corrected only under `/tmp`.

- [ ] **Step 4: Report exact evidence**

Record Chromium version, owned process/ports, viewport/theme measurements, interaction traces, fixture corrections, and any source/test commit. Leave the temporary fixture for Task 3 cleanup.

## Task 3: Complete Serial Verification And Clean The Worktree

**Implementer tier:** Standard

**Files:**

- Delete `/tmp/workspace-tasks-cdp-recovery-3/` before completion.
- Modify no shipped file unless Task 2 already committed a measured fix and a verification-only correction is strictly required by a fresh failing check.

**Interfaces:**

- Consumes Task 1 and Task 2 reports from this run, the current branch HEAD, and any measured source/test commit.
- Produces a final report with focused and full verification output, package contents, Changeset status, clean scope, and removed temporary-artifact evidence.

- [ ] **Step 1: Run focused cross-layer suites serially**

Run one at a time:

```bash
npm test -- --run src/shared/workspaceTasks.test.ts src/shared/workspaceTasksApi.test.ts scripts/build-plugins.test.mjs src/client/src/api/http.test.ts src/client/src/api/workspaceTasksApi.test.ts src/client/src/controllers/workspaceTasksController.test.ts src/client/src/components/PiWebUiApp.workspaceTasks.test.ts src/client/src/plugins/registry.test.ts pi-webui-plugins/pluginPublicApi.test.ts pi-webui-plugins/workspace-tasks/config.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts pi-webui-plugins/workspace-tasks/taskRunner.test.ts pi-webui-plugins/workspace-tasks/pi-webui-plugin.test.ts
npm run test:serial -- --run src/config.test.ts src/configMutationCoordinator.test.ts src/server/workspaceTasks src/server/app.workspaceTasks.test.ts src/server/app.localAliases.test.ts src/server/app.workspaceFiles.test.ts src/server/app.remoteProxy.test.ts
```

- [ ] **Step 2: Run complete verification serially**

Run `npm run verify:fast`, `npm run verify`, `npm run build`, `npm run pack:dry`, `npm run changelog:status`, and `git diff --check`, one at a time. Require every command to exit zero and confirm the package contains the compiled Workspace Tasks entry, `taskDomain.js`, `docs/plugins.md`, and `docs/config.md`, while paired HTML pages remain repository-only.

- [ ] **Step 3: Remove temporary artifacts and inspect the exact range**

Remove `/tmp/workspace-tasks-cdp-recovery-3/`, any leftover browser process/profile, and all untracked probe output. Run:

```bash
git status --short
git diff --check
git diff --name-only 5eda56bbab1c295e04623ed156039c3ddc847072..HEAD
```

Protected files remain unchanged. Write the final task report and commit only a measured Task 2 source/test change if one exists; otherwise do not create an empty commit.
