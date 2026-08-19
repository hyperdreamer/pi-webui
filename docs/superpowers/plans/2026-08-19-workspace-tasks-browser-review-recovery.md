# Workspace Tasks Browser Review Recovery Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to execute this plan task-by-task.

**Goal:** Produce fresh Chromium/CDP acceptance and independent review evidence for the committed Workspace Tasks feature.

**Architecture:** Preserve the stalled documentation-recovery run and all prompt-mismatch runs as immutable historical artifacts. A single fresh audit task probes the real bundled Tasks custom element in Chromium, reruns the complete verification sequence, and makes a product change only for a measured browser defect. Fresh task and Frontier final reviewers independently assess the same immutable feature range.

**Tech Stack:** TypeScript, native custom elements and shadow DOM, Chromium DevTools Protocol, Vitest, Node.js 22.19+, Changesets.

## Global Constraints

- Work only in `/data/home/guest/Development/pi-webui/.worktrees/workspace-tasks-global-catalog-final-continuation`; do not create, switch to, or remove a worktree.
- Preserve `.sdd/workspace-tasks-documentation-recovery` unchanged. Its Frontier reviewer received the exact stored bootstrap but stopped during provider overload before writing a report; do not use that incomplete attempt or its audit report as correctness evidence.
- Preserve every prompt-mismatch predecessor run and do not use its child reports, claimed tests, verdicts, or rationale as correctness evidence.
- Treat `6ca0e6d9a93dd38289ce843dc0fa0360aada6e52` as source to inspect, not as a trusted report. The immutable product range is `5eda56bbab1c295e04623ed156039c3ddc847072..6ca0e6d9a93dd38289ce843dc0fa0360aada6e52`.
- Process-only commits after `6ca0e6d` may be inspected for recovery context but are not product changes. Prove their source/test projection is empty before reviewing the product range.
- Preserve Workspace Tasks version-one schema, `<workspace>/.pi-webui/tasks.json`, route/API contracts, CAS behavior, move recovery behavior, panel draft retention, and public plugin contracts.
- Do not modify `src/plugin-api.ts`, session-daemon code/protocol, runtime ownership, `README.md`, `CHANGELOG.md`, release metadata, dependencies, or unrelated source.
- The existing minor Workspace Tasks Changeset remains the release record. Do not add or edit a Changeset in this recovery.
- Every tracked child prompt must be persisted before dispatch, dispatched byte-for-byte, compared with the child first user message before report admission, and recorded beneath this run root.
- Browser fixture, CDP script, screenshots, logs, Chromium profile, and temporary dev server are verification-only artifacts. Remove them before the task report and verify cleanup with `git status --short` and a closed-port check.

## Task 1: Run Fresh Browser Acceptance And Branch Audit

**Implementer tier:** Capable

**Files:**

- Create temporarily, then remove: a Vite fixture beneath `src/client/` and an ESM CDP driver beneath `/tmp`.
- Create only per-run SDD artifacts beneath the new ignored run root.
- Modify only if a measured defect is found: `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts`.
- Modify only with a deterministic regression for a measured defect: `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts` or `pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts`.

**Interfaces:**

- Consumes the real `defineTasksPanelElement()` and `tasksPanelTagName` from `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts`, whose custom element accepts `.context`, `.workspaceTasksState`, and `.workspaceTasksActions`.
- Consumes `WorkspaceTask`, `WorkspaceTaskRef`, and `WorkspaceTaskScope` from `src/shared/workspaceTasks.ts`; task actions use `create(scope, task)`, `update(ref, task)`, `remove(ref)`, `move(ref, destinationTask)`, `retryMove()`, and `refresh()`.
- Produces one read-only audit report with source identity, browser tooling identity, exact desktop and `430x844` measurements, interaction observations, all verification results, cleanup evidence, and any measured-fix evidence.
- Produces no product commit when no browser defect is found. A measured correction must be committed separately with a behavior-specific conventional message before review.
- The task reviewer independently judges the immutable product range and requires `SPEC: PASS` plus `QUALITY: APPROVED` with no unresolved load-bearing finding. A fresh Frontier final reviewer then judges the same full range.

- [ ] **Step 1: Establish the exact source and scope**

Confirm `5eda56bbab1c295e04623ed156039c3ddc847072` is an ancestor of `6ca0e6d9a93dd38289ce843dc0fa0360aada6e52`. Record `git status --short --branch`, `git diff --check`, and the changed-file projection for the immutable product range. Prove that the product range leaves `src/plugin-api.ts`, session-daemon/runtime-ownership paths, `README.md`, `CHANGELOG.md`, dependency manifests, and release workflow unchanged. Separately show that the commits after `6ca0e6d` contain only process/recovery documents before treating `6ca0e6d` as the browser-audit source tip.

- [ ] **Step 2: Run the focused cross-layer suites**

Run the original Task 15 focused checks before browser probing:

```text
npm test -- --run src/shared/workspaceTasks.test.ts src/shared/workspaceTasksApi.test.ts scripts/build-plugins.test.mjs src/client/src/api/http.test.ts src/client/src/api/workspaceTasksApi.test.ts src/client/src/controllers/workspaceTasksController.test.ts src/client/src/components/PiWebUiApp.workspaceTasks.test.ts src/client/src/plugins/registry.test.ts pi-webui-plugins/pluginPublicApi.test.ts pi-webui-plugins/workspace-tasks/config.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts pi-webui-plugins/workspace-tasks/taskRunner.test.ts pi-webui-plugins/workspace-tasks/pi-webui-plugin.test.ts
npm run test:serial -- --run src/config.test.ts src/configMutationCoordinator.test.ts src/server/workspaceTasks src/server/app.workspaceTasks.test.ts src/server/app.localAliases.test.ts src/server/app.workspaceFiles.test.ts src/server/app.remoteProxy.test.ts
```

Record actual pass/fail results. Do not use an earlier report's counts as evidence.

- [ ] **Step 3: Run a real Chromium/CDP panel acceptance probe**

Create a temporary Vite fixture below `src/client/` and an ESM driver beneath `/tmp`. The fixture must import the real Tasks panel module, call `defineTasksPanelElement()`, mount `pi-webui-workspace-tasks-panel`, and use the existing panel-test context/action shape rather than mock markup. Supply loaded global and workspace catalogs containing grouped tasks, long commands, and equal `id` values in both scopes; assign deterministic actions and an operational terminal context. Wait for custom-element rendering and two animation frames before writing a stable JSON result element.

Start a temporary `npm run dev:client -- --port <free-port> --strictPort` process, verify the fixture URL serves the fixture, then launch headless Chromium with a fresh temporary profile and remote-debugging port. Drive Chromium only through CDP using Node's built-in `WebSocket`; use `Emulation.setDeviceMetricsOverride` before navigation for desktop and exactly `430x844` CSS pixels.

For classic, light, and dark token contexts, record the requested viewport and actual `window.innerWidth`, document and panel `scrollWidth`/`clientWidth`, action-row bounds and wrapping, `details` summary/body bounds, text-area vertical overflow, pairwise interactive-control overlap flags, and a screenshot of the real panel. Exercise All, Global, and Project filters; assert the active filter's `aria-pressed`; open a named group and retain it through All -> Global -> Project -> All; inspect duplicate-ID Edit/Delete/Run accessible names; open and cancel editor/confirmation paths; and record keyboard Tab, Enter, and Escape focus behavior with a visible focus outline. A nonblank panel, no horizontal overflow, no overlap, stable disclosure, scoped duplicate actions, and usable focus are required. If Chromium or CDP is unavailable, record the precise failure and do not claim browser acceptance.

- [ ] **Step 4: Correct only a measured browser defect**

If the probe identifies a concrete defect, add the smallest deterministic regression first in the existing Tasks panel test boundary and run it to demonstrate the expected RED failure. Implement the smallest change in `tasksPanelElement.ts`, rerun the focused panel tests, and rerun the same Chromium measurement. Do not make an unmeasured refactor, style adjustment, or verification-only source change. If no defect is measured, do not change product source or tests.

- [ ] **Step 5: Remove probes and run complete verification serially**

Stop Chromium and Vite, remove every temporary fixture, driver, profile, log, and screenshot, verify the probe ports are closed, then run in order on an otherwise idle machine:

```text
npm run verify:fast
npm run verify
npm run build
npm run pack:dry
npm run changelog:status
git diff --check
git status --short
```

Record the actual test counts, non-failing warning output, and package entries for `dist/pi-webui-plugins/workspace-tasks/taskDomain.js`, `docs/plugins.md`, and `docs/config.md`. Verify no temporary artifact remains tracked or untracked.

- [ ] **Step 6: Commit a measured correction only**

If Step 4 changed source or a regression, inspect the exact diff, run the relevant focused tests again, and commit only the measured correction with a behavior-specific conventional message. If no defect was measured, create no empty product commit. Write the report only after checking the final branch status and exact source range.
