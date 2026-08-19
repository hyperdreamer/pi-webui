# Workspace Tasks Post-Correlation Dispatch Recovery Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic subagent-driven-development controller to execute this plan task-by-task.

**Goal:** Audit the candidate client correction after a prompt-correlated dispatch mismatch, implement the remaining active-owner move settlement correction, and obtain fresh browser and independent review evidence.

**Architecture:** The mismatched remediation run remains historical and inadmissible. A fresh read-only audit certifies or rejects the candidate client commit. The server task then protects active move-owner permits at the registry boundary. The final Frontier review covers the complete Workspace Tasks range from the original merge base.

**Tech Stack:** TypeScript, Fastify, native custom elements, Vitest, Chromium/CDP, Node.js 22.19+.

## Global Constraints

- Work only in `/data/home/guest/Development/pi-webui/.worktrees/workspace-tasks-global-catalog-final-continuation`.
- The prior run `.sdd/workspace-tasks-final-blocked-remediation` has a persisted prompt-mismatch receipt after dispatch correlation. Preserve its state, progress ledger, prompt, report, receipt, and candidate commit references as historical artifacts; do not admit its report or commit as SDD evidence and do not hand-edit its state.
- Preserve `.sdd/workspace-tasks-browser-review-recovery`, `.sdd/workspace-tasks-final-continuation`, `.sdd/workspace-tasks-final-continuation-recovery`, and `.sdd/workspace-tasks-post-mismatch-continuation-recovery` unchanged as historical artifacts.
- Carry findings F-1, F-2, and F-3 by these exact IDs. The candidate client commit is source to inspect, not trusted evidence. Resolve each finding only with fresh task reports, regressions, and final review.
- The original merge base is `5eda56bbab1c295e04623ed156039c3ddc847072`. The candidate client commit is `1488190065582687440f1cc3062c50e461b0ce5b`. The final reviewer must inspect the whole range from the original merge base through the final remediation HEAD.
- Preserve Workspace Tasks version-one schema, `<workspace>/.pi-webui/tasks.json`, route/API contracts, CAS behavior, move recovery behavior, panel draft retention, and public plugin contracts.
- Do not modify `src/plugin-api.ts`, session-daemon code or protocol, runtime ownership, `README.md`, `CHANGELOG.md`, release metadata, dependencies, or unrelated source.
- Do not add or edit a Changeset; the existing Workspace Tasks Changeset remains the release record.
- Every child prompt must be rendered and persisted beneath this run root before dispatch. Dispatch only the exact persisted bytes. Compare the child first user message byte-for-byte with the stored prompt before recording `dispatch-started` or admitting a report. On mismatch, record `dispatch-mismatch` while still in the dispatch-intent phase and stop the run.
- Use TDD for Task 2: add the smallest regression, run it and observe the expected RED failure, implement the minimum correction, then run focused GREEN checks before broader verification.
- Task 1 is read-only. Browser fixtures, screenshots, logs, profiles, and dev servers are verification-only, must stay outside shipped source, and must be removed before reporting.
- Do not use any predecessor child report, claimed test result, verdict, or rationale as correctness evidence. Git source may be inspected independently.

## Task 1: Audit Candidate Client Correction And Browser Acceptance

**Implementer tier:** Capable

**Files:**

- Read-only audit of `5eda56bbab1c295e04623ed156039c3ddc847072..1488190065582687440f1cc3062c50e461b0ce5b`.
- Read-only inspection of `src/client/src/controllers/workspaceTasksController.ts` and `src/client/src/controllers/workspaceTasksController.test.ts`.
- Read-only inspection of `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts` and its focused tests.
- Create only the audit report and temporary verification artifacts beneath the new run root.

**Interfaces:**

- Consumes the candidate source range and the carried F-1/F-2 finding descriptions.
- Produces one independent audit report with exact source identity, changed-file scope, fresh test results, browser/CDP acceptance evidence, and cleanup evidence.
- Produces no product, test, documentation, package, dependency, configuration, or Git-history changes.

- [ ] **Step 1: Verify candidate identity and protected scope**

Confirm that the original merge base and candidate commit are ancestors of the current branch tip. Record the branch, exact HEAD, clean status before work, candidate changed-file list, range diff check, and protected-path projections. Confirm the candidate commit changes only the four intended client/panel files and their focused tests. State explicitly that the prompt-mismatched implementer report and its claimed verification are excluded.

- [ ] **Step 2: Independently inspect F-1 and F-2**

Read the candidate diff and surrounding controller/panel ownership boundaries. Verify that source generations advance for authoritative responses and successful direct semantic no-ops, that unrelated publications cannot acknowledge a pending source, and that a resolved action without authoritative publication retains the draft. Verify that known pre-destination `validation` and `unavailable` move results are represented as a distinct nonblocking `moveError`, leave no blocking move state or mutation gate, retain the editor, allow later CRUD, omit Retry, and clear on Refresh/new move/selection change. Confirm genuine partial and unknown-outcome recovery remains blocking and retryable.

- [ ] **Step 3: Run fresh deterministic verification**

Run serially on an otherwise idle machine:

```text
npm run test:serial -- --run src/client/src/controllers/workspaceTasksController.test.ts
npm run test:serial -- --run pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts
npm run typecheck
npx eslint src/client/src/controllers/workspaceTasksController.ts src/client/src/controllers/workspaceTasksController.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts
```

Record actual outputs and any non-failing environmental warnings. Do not infer correctness from the inadmissible candidate report.

- [ ] **Step 4: Run Chromium/CDP acceptance**

Using only temporary fixtures outside the product tree, run a real Chromium/CDP probe against the candidate client. Cover a loaded Workspace Tasks panel at desktop and narrow viewport sizes, a canonical no-op action with an unrelated publication, a known validation/unavailable move error with retained editor and enabled CRUD, Refresh clearing the known error, and a genuine partial move retaining blocking Retry behavior. Capture concise DOM assertions and screenshots or logs under the run root, then stop the server and remove every fixture/profile/screenshot/log before reporting.

If the environment cannot provide Chromium/CDP, record the exact capability failure and leave the task incomplete rather than treating unit tests as browser acceptance.

- [ ] **Step 5: Report the audit**

Write exactly one report at the Dispatch Context report path. Use `DONE` only when source inspection, focused verification, and browser acceptance all pass with cleanup complete. Include the exact candidate range, changed files, protected-path result, test commands/results, browser evidence paths and cleanup result, and excluded predecessor evidence. Do not create a commit.

## Task 2: Protect Active Move-Owner Settlement

**Implementer tier:** Capable

**Files:**

- Modify: `src/server/workspaceTasks/workspaceTasksMoveRegistry.ts`
- Test: `src/server/workspaceTasks/workspaceTasksMoveRegistry.test.ts`
- Modify if needed: `src/server/workspaceTasks/workspaceTasksCatalogService.ts`
- Test if needed: `src/server/workspaceTasks/workspaceTasksCatalogService.test.ts`
- Test if needed: `src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.test.ts`
- Test if needed: `src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.test.ts`

**Interfaces:**

- Consumes `MachineGlobalTasksMoveRegistry.withMoveLock()`, `reconcileGlobalMoveClaim()`, `WorkspaceTasksMovePermit`, `WorkspaceTasksMovePlan`, and existing adapter/service authorization calls.
- Produces the existing `WorkspaceTasksMoveResult` and permit contracts while preventing a non-owner reconciliation from invalidating a live owner permit for the same operation.

- [ ] **Step 1: Add F-3 regressions first**

Use a deferred registry observation while `withMoveLock(operationId, ...)` remains open after destination acknowledgement. Invoke a no-permit non-owner reconciliation with an authoritative exact-complete pair and assert it returns recovery-pending without invalidating the owner permit; then settle successfully with the owner permit. Repeat with an authoritative unrecognized pair and assert the owner receives the defined manual-resolution conflict while a later direct writer can reconcile after the owner exits.

Add or extend a catalog-service regression using controlled adapters so a direct no-op writer reconciles between source-removal publication/verification and `completeWithPermit()`. Assert the move returns `completed` for the exact pair, never `unavailable`. Keep stale-claim, partial, unknown-outcome, destination-pending, and unrelated-workspace coverage unchanged. Run the smallest registry/service tests and confirm the new assertions fail against the candidate because `clearClaim()` invalidates the owner permit.

- [ ] **Step 2: Implement the minimum registry ownership guard**

After authoritative observation and claim-identity recheck, distinguish an owner call carrying the exact permit from a no-permit non-owner while `activeMoveOperationId` equals the live claim operation. A non-owner must return recovery-pending without clearing the active claim; the owner may settle exact-complete or unrecognized state. Preserve late-observation protection, destination-pending behavior, stale-claim cleanup after the owner lock exits, exact permit-intent checks, and existing result mapping. Change the catalog service only if the new regression proves call ordering or mapping still loses an owner result.

- [ ] **Step 3: Run focused GREEN checks**

Run serially:

```text
npm test -- --run src/server/workspaceTasks/workspaceTasksMoveRegistry.test.ts src/server/workspaceTasks/workspaceTasksCatalogService.test.ts src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.test.ts src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.test.ts
npm run typecheck
npx eslint src/server/workspaceTasks/workspaceTasksMoveRegistry.ts src/server/workspaceTasks/workspaceTasksMoveRegistry.test.ts src/server/workspaceTasks/workspaceTasksCatalogService.ts src/server/workspaceTasks/workspaceTasksCatalogService.test.ts src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.test.ts src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.test.ts
```

Record RED/GREEN evidence and verify direct writers remain available for unrelated workspaces.

- [ ] **Step 4: Verify and commit the server correction**

Run `npm run verify:fast`, `npm run verify`, `npm run build`, `npm run pack:dry`, `npm run changelog:status`, `git diff --check`, and `git status --short`. Confirm the original merge base remains an ancestor, protected paths and the existing Changeset are unchanged, and temporary browser artifacts are absent. Commit only allowed server production/test files with `fix(tasks): protect active move owner settlement`. Include the commit SHA and exact verification results in the report.

## Completion Boundary

After both tasks and independent task reviews pass, dispatch a fresh Frontier final reviewer over `5eda56bbab1c295e04623ed156039c3ddc847072..HEAD`. The final package must include the F-1/F-2/F-3 carry-forward ledger, the admitted Task 1 browser evidence, the Task 2 race evidence, and explicit exclusion of the mismatched run. Complete only with `SPEC: PASS`, `QUALITY: APPROVED`, no unresolved load-bearing findings, clean Git state, and SDD audit status `OK`.
