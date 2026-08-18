# Workspace Tasks Verification Recovery 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Re-establish fresh browser acceptance and complete serial verification for the committed Workspace Tasks implementation after the predecessor dispatch mismatch.

**Architecture:** A new disposable Chromium fixture and raw-CDP runner independently exercise the real bundled panel and controller-shaped bridge. A second task runs all focused and full verification commands serially, removes every temporary artifact, and reports the exact final source range. The sealed predecessor run is preserved and never supplies evidence.

**Tech Stack:** TypeScript, Lit custom elements, Node.js 22.19+, Vitest, Chromium DevTools Protocol, Changesets.

## Global Constraints

- The approved recovery design in `docs/superpowers/specs/2026-08-18-workspace-tasks-verification-recovery-4-design.md` and the approved Workspace Tasks design are authoritative.
- Preserve `/data/home/guest/Development/pi-webui/.worktrees/workspace-tasks-global-catalog-recovery-3/.sdd/workspace-tasks-verification-recovery-3` unchanged; its Task 2 report, acceptance runner, browser output, and child claim are inadmissible evidence.
- Treat `04120a41712f7f5bb8a94da8b7f23c58e8bc3dfb` as the exact source baseline and `5eda56bbab1c295e04623ed156039c3ddc847072` as the whole feature-range base.
- Do not read or reuse any predecessor report, transcript, temporary fixture, acceptance runner, screenshot, result JSON, or browser output as evidence.
- Use a new temporary root `/tmp/workspace-tasks-cdp-recovery-4`; do not read `/tmp/workspace-tasks-cdp-recovery-3`.
- Node.js 22.19 is the minimum supported runtime; add no runtime dependencies.
- Keep `src/plugin-api.ts`, `README.md`, `CHANGELOG.md`, session-daemon code/protocol, and runtime ownership unchanged unless a fresh Chromium measurement proves a shipped panel defect and the task's RED/GREEN rule is followed.
- Use raw CDP against a page target discovered from the new Chromium process; use dynamic HTTP and DevTools ports and a temporary profile.
- Run tasks serially. Clean every browser, server, profile, result, and recovery-4 temporary artifact before Task 2 completes.
- Every child prompt must be rendered to a file, stored in its dispatch intent, and compared byte-for-byte with the child first message before its report is admitted.
- Do not merge, push, publish, tag, release, or change the session daemon.

## Task 1: Build Fresh Fixture And Run Complete Browser Acceptance

**Implementer tier:** Advanced

**Files:**

- Create temporarily, then leave for Task 2 cleanup: `/tmp/workspace-tasks-cdp-recovery-4/fixture.html`.
- Create temporarily, then leave for Task 2 cleanup: `/tmp/workspace-tasks-cdp-recovery-4/probe.mjs`.
- Create temporarily, then leave for Task 2 cleanup: `/tmp/workspace-tasks-cdp-recovery-4/acceptance.mjs`.
- Modify only `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts` and one corresponding deterministic regression in `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts` or `pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts` if a fresh browser measurement proves a shipped defect.

**Interfaces:**

- Consumes the committed generated Workspace Tasks panel from the current worktree and no predecessor evidence.
- Produces a fresh fixture with controller-shaped `.context`, `.workspaceTasksState`, and `.workspaceTasksActions` properties and deterministic browser helpers for the complete acceptance matrix.
- Produces one report at the Dispatch Context report path with fresh Chromium identity, all viewport/theme measurements, interaction traces, cleanup evidence, and any measured source/test commit.

- [ ] **Step 1: Verify the source baseline and establish RED**

Run:

```bash
git status --short
git rev-parse HEAD
git diff --check
git diff --name-only 5eda56bbab1c295e04623ed156039c3ddc847072..HEAD
npm run build:plugins
```

Require `04120a41712f7f5bb8a94da8b7f23c58e8bc3dfb` to be an ancestor of `HEAD`, record the current `HEAD`, and prove that the source/test projection of the range from that baseline is empty; the range may contain only this recovery plan and spec. Require a generated Workspace Tasks panel. Create the new temporary directory only after the source check. Before writing the fixture, run `node /tmp/workspace-tasks-cdp-recovery-4/probe.mjs` against an absent fixture and record the expected missing-fixture RED result. Do not inspect the predecessor temporary root or run root.

- [ ] **Step 2: Create a fresh raw-CDP fixture and smoke runner**

Build the fixture and probe from scratch under `/tmp/workspace-tasks-cdp-recovery-4`. Serve HTML as `text/html; charset=utf-8`, allowlist only the generated Workspace Tasks modules below the current `dist` root, reject other paths, use dynamic ports and a temporary Chromium profile, discover `/json/list`, select the owned `type: page` target, connect only to its page socket, and enable `Runtime` and `Page`. Expose helpers named `applyTheme`, `measureViewport`, `publishCatalogs`, `publishDefaultCatalogs`, `setScopeFilter`, `setGroupOpen`, `lookupAction`, `preparePromotion`, `prepareDemotion`, `seedDestinationCollision`, `configureMoveOutcome`, `setMoveRecovery`, `recoverMove`, `retryMove`, `focusSnapshot`, and `pressKey`. Run the smoke runner at `1280x900` and `430x844` with Classic, Dark, and Light theme application, deterministic catalog publication, native group disclosure, equal scoped IDs, nonzero dimensions, and no page errors. Remove the compact smoke result and browser profile in `finally`; retain only the three named scripts for Task 2.

- [ ] **Step 3: Exercise the complete acceptance matrix**

Create a separate disposable `acceptance.mjs` under the same root. Run a new Chromium process and fixture server for every acceptance invocation. Record for both viewports and all three themes: panel/document `scrollWidth` and `clientWidth`, summary/body bounds, action-container wrapping, long-command bounds and internal vertical overflow, visible `:focus-visible` outline, duplicate-ID accessible names, `aria-pressed` filters, native disclosure open state and persistence, and focus return after cancel/confirm. Exercise Global/Project equal IDs, promotion, demotion, destination collision, partial recovery, unknown-outcome recovery with Retry disabled during refresh and enabled after authoritative refresh, Tab, Escape, Enter, and long-command terminal metadata. Open collapsed disclosures before targeting their controls. Classify HTTP status/content type, CDP target identity, page exceptions, and fixture assertions separately. Clean result logs, profiles, processes, and server sockets after each run.

- [ ] **Step 4: Apply only a measured shipped fix**

If and only if the matrix measures a real defect in `tasksPanelElement.ts`, write the narrowest deterministic regression first and run it against the current implementation to observe RED. Make the minimum source change, run the focused panel regression GREEN, rebuild the plugin, and rerun the identical acceptance measurement. Correct fixture-only failures under `/tmp/workspace-tasks-cdp-recovery-4` without changing shipped files. Do not commit an empty or speculative fix.

- [ ] **Step 5: Inspect scope and report**

Run `node --check` for every temporary runner, `git status --porcelain`, `git diff --check`, and process/profile/result cleanup checks. Ensure the only remaining files are the three named temporary scripts unless a measured source/test fix was committed. Write exactly one report and return exactly one implementer status.

## Task 2: Run Serial Verification And Clean Recovery Artifacts

**Implementer tier:** Standard

**Files:**

- Delete `/tmp/workspace-tasks-cdp-recovery-4/` before completion.
- Modify no shipped file unless Task 1 committed a measured fix and a fresh verification failure proves a strictly necessary correction within the Task 1 allowlist.

**Interfaces:**

- Consumes only this run's Task 1 report, the current branch HEAD, and any source/test commit explicitly justified by fresh browser evidence.
- Produces one final verification report with exact focused/full command output, package contents, Changeset status, protected-file scope, cleanup evidence, and final HEAD.

- [ ] **Step 1: Verify the admitted Task 1 result and run focused suites**

Read only this run's Task 1 report. Run these commands one at a time on an otherwise idle machine:

```bash
npm test -- --run src/shared/workspaceTasks.test.ts src/shared/workspaceTasksApi.test.ts scripts/build-plugins.test.mjs src/client/src/api/http.test.ts src/client/src/api/workspaceTasksApi.test.ts src/client/src/controllers/workspaceTasksController.test.ts src/client/src/components/PiWebUiApp.workspaceTasks.test.ts src/client/src/plugins/registry.test.ts pi-webui-plugins/pluginPublicApi.test.ts pi-webui-plugins/workspace-tasks/config.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts pi-webui-plugins/workspace-tasks/taskRunner.test.ts pi-webui-plugins/workspace-tasks/pi-webui-plugin.test.ts
npm run test:serial -- --run src/config.test.ts src/configMutationCoordinator.test.ts src/server/workspaceTasks src/server/app.workspaceTasks.test.ts src/server/app.localAliases.test.ts src/server/app.workspaceFiles.test.ts src/server/app.remoteProxy.test.ts
```

Record exact exit status and test counts. Do not use any blocked-run evidence to fill a missing result.

- [ ] **Step 2: Run complete verification serially**

Run one command at a time and require exit zero:

```bash
npm run verify:fast
npm run verify
npm run build
npm run pack:dry
npm run changelog:status
git diff --check
```

Confirm `pack:dry` includes the compiled Workspace Tasks entry, `taskDomain.js`, `docs/plugins.md`, and `docs/config.md`, while paired HTML documentation remains repository-only. If a command fails, report the exact failure and do not claim completion.

- [ ] **Step 3: Remove temporary artifacts and inspect the exact range**

Remove `/tmp/workspace-tasks-cdp-recovery-4/`, any leftover browser process/profile, and untracked probe output. Verify no predecessor root was modified. Run:

```bash
git status --short
git diff --check
git diff --name-only 5eda56bbab1c295e04623ed156039c3ddc847072..HEAD
```

Confirm protected files remain unchanged and no empty verification commit is created. Write exactly one final task report with command results, package evidence, Changeset status, final HEAD, and cleanup proof.
