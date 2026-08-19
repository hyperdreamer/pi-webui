# Workspace Tasks Short-Bootstrap Recovery Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic subagent-driven-development controller to execute this plan task-by-task.

**Goal:** Produce admissible Workspace Tasks client audit/browser evidence after two prompt-mismatch runs, implement the active move-owner settlement correction, and complete independent review.

**Architecture:** The predecessor runs are sealed. Task 1 uses a short exact bootstrap to make dispatch receipt reliable, then performs a read-only audit from the persisted brief. Task 2 implements the F-3 registry guard with TDD. Independent task reviews and one Frontier final review cover the original range.

**Tech Stack:** TypeScript, Fastify, native custom elements, Vitest, Chromium/CDP, Node.js 22.19+.

## Global Constraints

- Work only in `/data/home/guest/Development/pi-webui/.worktrees/workspace-tasks-global-catalog-final-continuation`.
- Preserve `.sdd/workspace-tasks-final-blocked-remediation` and `.sdd/workspace-tasks-post-correlation-dispatch-recovery` unchanged as terminal mismatch artifacts, including state, progress, prompts, reports, receipts, and event files. Their child reports and browser claims are inadmissible evidence.
- Preserve all earlier Workspace Tasks recovery run roots and reports as historical artifacts only.
- Carry findings F-1, F-2, and F-3 by exact ID. The candidate client commit `1488190065582687440f1cc3062c50e461b0ce5b` is source to inspect, not trusted evidence.
- Review the complete product range from merge base `5eda56bbab1c295e04623ed156039c3ddc847072` through the final remediation HEAD.
- Preserve Workspace Tasks version-one schema, `<workspace>/.pi-webui/tasks.json`, route/API contracts, CAS behavior, move recovery behavior, panel draft retention, and public plugin contracts.
- Do not modify `src/plugin-api.ts`, session-daemon code or protocol, runtime ownership, `README.md`, `CHANGELOG.md`, release metadata, dependencies, or unrelated source. Do not add or edit a Changeset.
- Every child receives a short persisted bootstrap, not a manually relayed long rendered prompt. The bootstrap must be stored before dispatch, sent byte-for-byte, and compared with the first child user message before `dispatch-started` or report admission. On mismatch, record `dispatch-mismatch` in the intent phase and stop.
- Task 1 is read-only. Browser fixtures, screenshots, logs, profiles, servers, and candidate diff files are verification-only and must be removed before its report is written.
- Task 2 uses TDD: RED regression first, minimum fix, focused GREEN, then broader checks.
- Do not use any predecessor child report, claimed test, verdict, or rationale as correctness evidence.

## Task 1: Audit Client Candidate And Browser Acceptance

**Implementer tier:** Capable

**Files:**

- Read-only audit of `5eda56bbab1c295e04623ed156039c3ddc847072..1488190065582687440f1cc3062c50e461b0ce5b`.
- Read-only inspection of `src/client/src/controllers/workspaceTasksController.ts`, its focused tests, `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts`, and its focused tests.
- Create only the run-local audit report and temporary verification artifacts.

**Bootstrap:** The exact dispatch prompt is the following single-line bootstrap, persisted at the prompt path before spawn:

```text
Model tier: capable
Read the complete Task 1 brief at: <briefPath>
Work read-only in: <worktree>
Write exactly one audit report at: <reportPath>
Return exactly one status token: DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, or BLOCKED.
```

The controller substitutes the absolute paths from Dispatch Context into this bootstrap before persistence. The child must read the complete brief, perform the audit, and write the report. The bootstrap is the only byte-exact transport requirement for this recovery dispatch.

- [ ] **Step 1: Verify identity and scope**

Verify the original merge base and candidate commit ancestry, branch/HEAD/status, candidate changed-file list, candidate diff check, and protected-path projections. State that the two mismatch-run reports and claims are excluded.

- [ ] **Step 2: Verify F-1 and F-2 directly**

Inspect the candidate source and tests. Confirm source-scoped generation acknowledgement for semantic no-ops, unrelated-publication isolation, no-publication draft retention, distinct nonblocking validation/unavailable move errors, retained editor, no Retry for known no-write errors, CRUD availability, Refresh/new move/selection clearing, and preserved blocking partial/unknown recovery.

- [ ] **Step 3: Run focused checks**

Run serially:

```text
npm run test:serial -- --run src/client/src/controllers/workspaceTasksController.test.ts
npm run test:serial -- --run pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts
npm run typecheck
npx eslint src/client/src/controllers/workspaceTasksController.ts src/client/src/controllers/workspaceTasksController.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts
```

Record actual results.

- [ ] **Step 4: Run Chromium/CDP acceptance**

Use temporary fixtures outside shipped source. Probe desktop and narrow viewports; assert F-1 unrelated/matching generation settlement and draft retention; assert F-2 validation/unavailable nonblocking retained editor/no Retry/CRUD/Refresh clear; assert genuine partial move remains blocking with Retry. Stop servers/processes and remove all fixtures, profiles, screenshots, logs, and probe files before reporting. A tooling limitation must be reported as a blocker, not silently waived.

- [ ] **Step 5: Report**

Write exactly one report at the fresh run report path. Use `DONE` only when source inspection, focused checks, browser acceptance, and cleanup pass. Do not commit.

## Task 2: Protect Active Move-Owner Settlement

**Implementer tier:** Capable

**Files:**

- Modify: `src/server/workspaceTasks/workspaceTasksMoveRegistry.ts`
- Test: `src/server/workspaceTasks/workspaceTasksMoveRegistry.test.ts`
- Modify/test if needed: `src/server/workspaceTasks/workspaceTasksCatalogService.ts` and `.test.ts`
- Test if needed: existing global/workspace adapter tests only for the deterministic race seam

**Bootstrap:** Use the same short-bootstrap form with Task 2’s absolute brief and report paths, typed as `Model tier: capable`.

- [ ] **Step 1: RED regressions**

Hold `withMoveLock(operationId, ...)` open after destination acknowledgement. Reconcile a no-permit exact-complete pair and assert recovery-pending without invalidating the owner permit; settle successfully with the exact owner permit. Repeat for an unrecognized pair and assert the owner receives the defined manual-resolution conflict while a later direct writer can reconcile after owner exit. Add service-level interleaving proving a direct writer cannot turn a completed move into unavailable between source publication and `completeWithPermit()`. Run the smallest tests and record RED.

- [ ] **Step 2: Minimum registry guard**

After authoritative observation and claim recheck, if the same claim’s operation lock is active, a no-permit non-owner returns recovery-pending without clearing the claim; the exact owner permit may settle complete/unrecognized. Preserve late-observation, destination-pending, stale-claim-after-lock, exact permit, partial, and unknown-outcome behavior.

- [ ] **Step 3: GREEN checks**

Run serially:

```text
npm test -- --run src/server/workspaceTasks/workspaceTasksMoveRegistry.test.ts src/server/workspaceTasks/workspaceTasksCatalogService.test.ts src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.test.ts src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.test.ts
npm run typecheck
npx eslint src/server/workspaceTasks/workspaceTasksMoveRegistry.ts src/server/workspaceTasks/workspaceTasksMoveRegistry.test.ts src/server/workspaceTasks/workspaceTasksCatalogService.ts src/server/workspaceTasks/workspaceTasksCatalogService.test.ts src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.test.ts src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.test.ts
```

- [ ] **Step 4: Verify and commit**

Run `npm run verify:fast`, `npm run verify`, `npm run build`, `npm run pack:dry`, `npm run changelog:status`, `git diff --check`, and `git status --short`. Confirm protected paths, existing Changeset, and temporary artifacts are unchanged/absent. Commit only allowed files with `fix(tasks): protect active move owner settlement` and report the SHA.

## Completion Boundary

After both tasks and independent task reviews pass, obtain a fresh Frontier final review over `5eda56bbab1c295e04623ed156039c3ddc847072..HEAD`, carrying F-1/F-2/F-3 and explicitly excluding the mismatch reports. Complete only with spec PASS, quality APPROVED, no open load-bearing findings, clean Git state, and SDD audit status OK.
