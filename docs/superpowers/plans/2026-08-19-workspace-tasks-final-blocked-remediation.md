# Workspace Tasks Final-Blocked Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Resolve the three load-bearing Workspace Tasks findings carried from the terminal browser-review run while preserving the existing contracts.

**Architecture:** Keep acknowledgement ownership in the selected-workspace controller and the bundled panel boundary, and keep move-claim ownership in the process-local registry. The client task exposes source-scoped generations and a nonblocking known move error; the server task serializes only the active-owner settlement decision without introducing a journal or distributed lock.

**Tech Stack:** TypeScript, Fastify, native custom elements, Vitest, Node.js 22.19+.

## Global Constraints

- The predecessor run `.sdd/workspace-tasks-browser-review-recovery` is terminal `FINAL_BLOCKED` and must remain unchanged; its final report and F-1/F-2/F-3 findings are evidence, not permission to edit that run.
- Carry findings F-1, F-2, and F-3 by these exact IDs and resolve them only with evidence from the new task reports and final review.
- Review the whole product range from merge base `5eda56bbab1c295e04623ed156039c3ddc847072` through the new remediation HEAD; do not review only the new remediation commits.
- Preserve Workspace Tasks version-one schema, `<workspace>/.pi-webui/tasks.json`, route/API contracts, CAS behavior, move recovery behavior, panel draft retention, and public plugin contracts.
- Do not modify `src/plugin-api.ts`, session-daemon code/protocol, runtime ownership, `README.md`, `CHANGELOG.md`, release metadata, dependencies, or unrelated source.
- Do not add or edit a Changeset; the existing Workspace Tasks Changeset remains the release record.
- Work only in `/data/home/guest/Development/pi-webui/.worktrees/workspace-tasks-global-catalog-final-continuation`; do not create, switch to, or remove a worktree.
- Every child prompt must be persisted before dispatch, sent byte-for-byte, compared with the child first user message before report admission, and recorded beneath the new run root.
- Use TDD for every correction: write the smallest behavior regression, run it and observe the expected RED failure, implement the minimum fix, then run focused GREEN checks before broader verification.
- Keep browser fixtures and generated verification artifacts out of the product tree; no browser probe is a substitute for the deterministic F-1/F-2/F-3 regressions.

## Task 1: Repair Client Acknowledgement And Known Move Error State

**Implementer tier:** Capable

**Files:**

- Modify: `src/client/src/controllers/workspaceTasksController.ts`
- Test: `src/client/src/controllers/workspaceTasksController.test.ts`
- Modify: `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts`
- Test: `pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts`
- Test if needed: `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts`

**Interfaces:**

- Consumes `WorkspaceTasksWorkspaceState`, `WorkspaceTasksActions`, `WorkspaceTask`, `WorkspaceTaskRef`, and `WorkspaceTaskScope` from `src/client/src/controllers/workspaceTasksController.ts` and the existing panel bridge in `pi-webui-plugins/workspace-tasks/pi-webui-plugin.ts`.
- Produces an internal state projection with source-scoped monotonically increasing generations for `workspace` and `global`, incremented for authoritative source responses and successful direct mutation responses, including semantic no-ops.
- Produces an optional nonblocking known move error with `kind: "validation" | "unavailable"` and a user-facing message. It must be distinct from the blocking recovery `move` state and must not create a mutation gate.
- The panel consumes the generation projection and move error, retaining the existing `.context`, `.workspaceTasksState`, and `.workspaceTasksActions` property contract.

- [ ] **Step 1: Add F-1 and F-2 regressions first**

Add deterministic tests before production edits:

```text
F-1 controller/panel path: a successful same-value direct update publishes a higher generation for only the updated source; an unrelated source publication does not advance the pending source generation. The panel closes the editor only after the matching source generation is observed. Keep the existing no-authoritative-publication test open after the action promise resolves.
F-2 controller path: a move returning { kind: "validation" } and one returning { kind: "unavailable" } publish a nonblocking move error, no blocking move recovery state, and no mutation gate. After the result, a normal create/update on a loaded source is still sent. Refresh clears the move error. Panel path: the move editor remains mounted, shows the error, has no Retry control, and permits a later task action.
```

Run the smallest relevant test files serially and confirm each new assertion fails against the current implementation for the reported reason. Do not weaken or delete the existing draft-retention and recovery tests.

- [ ] **Step 2: Add source-scoped generations and the nonblocking move error**

In `WorkspaceTasksController`, add the smallest internal state fields needed to expose two source generations and one selected move error. Advance a source generation whenever an authoritative read response or direct mutation response is accepted; the direct response path must advance it even when the canonical catalog content and revision are unchanged. Clear a known move error when a new move starts, when the selected workspace changes, and when an authoritative Refresh begins or completes. In the known `validation`/`unavailable` branch, clear `moveContext`, blocking `moveState`, and any move gate, then publish only the nonblocking error.

In `TasksPanelElement`, capture the source generation at action start and mark a pending source delivered only when its generation advances or its authoritative catalog key changes. Remove the `published && !changedAnyScope` top-level identity acknowledgement. Preserve source refresh lifecycle handling, failure handling, and the no-publication draft-retention behavior. Render the known move error as an inline status, leave the editor draft mounted, exclude that error from `isScopeDisabled`/mutation blocking, and prevent the successful-move path from closing the editor when the move error is present.

- [ ] **Step 3: Run focused GREEN checks**

Run, serially:

```bash
npm test -- --run src/client/src/controllers/workspaceTasksController.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts
npm run typecheck
npx eslint src/client/src/controllers/workspaceTasksController.ts src/client/src/controllers/workspaceTasksController.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts
```

Record the RED and GREEN outcomes. Verify the focused suite still covers delayed publications, source-scoped failures, move recovery, and keyboard/editor behavior.

- [ ] **Step 4: Inspect the client diff and commit**

Check `git diff --check`, `git diff --stat`, protected-path projections, and `git status --short`. Commit only the allowed client files with `fix(tasks): scope client task acknowledgements and move errors`. Include the commit SHA in the report.

## Task 2: Preserve Active Move-Owner Claim Settlement

**Implementer tier:** Capable

**Files:**

- Modify: `src/server/workspaceTasks/workspaceTasksMoveRegistry.ts`
- Test: `src/server/workspaceTasks/workspaceTasksMoveRegistry.test.ts`
- Modify if needed: `src/server/workspaceTasks/workspaceTasksCatalogService.ts`
- Test if needed: `src/server/workspaceTasks/workspaceTasksCatalogService.test.ts`
- Test if needed: `src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.test.ts`
- Test if needed: `src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.test.ts`

**Interfaces:**

- Consumes `MachineGlobalTasksMoveRegistry.withMoveLock()`, `reconcileGlobalMoveClaim()`, `WorkspaceTasksMovePermit`, `WorkspaceTasksMovePlan`, and the existing global/workspace adapter authorizer calls.
- Produces the same `WorkspaceTasksMoveResult` and permit contracts, but a non-owner reconciliation cannot invalidate an active owner permit for the claim whose operation lock is running.
- Owner settlement with its exact permit still clears complete state or returns the defined unrecognized conflict. Stale-claim reconciliation after the owner lock exits retains its existing recovery behavior.

- [ ] **Step 1: Add deterministic F-3 race regressions first**

Add a registry-level regression that holds `withMoveLock(operationId, ...)` open after destination acknowledgement, invokes `reconcileGlobalMoveClaim({ scope: "global" })` without a permit with an authoritative complete pair, and asserts `WorkspaceTasksMoveRecoveryPendingError`, a still-live owner permit, and successful owner settlement. Repeat the interleaving for an authoritative unrecognized pair and assert the owner receives the manual-resolution conflict while a later direct writer can reconcile after the owner exits.

Add or extend a catalog-service regression using the existing controlled adapters so the direct-writer reconciliation occurs between source-removal publication/verification and `completeWithPermit()`. Assert that the move returns `completed` for the exact complete pair, never `unavailable`, and that a direct writer is allowed after owner settlement. Keep existing stale-claim, partial, unknown-outcome, and unrelated-workspace tests unchanged.

Run the smallest registry/service tests and confirm the new race assertions fail against the current implementation because `clearClaim()` invalidates the owner permit.

- [ ] **Step 2: Guard active-owner settlement at the registry boundary**

Make the minimum registry change that distinguishes an owner call carrying the exact permit from a non-owner reconciliation while `activeMoveOperationId` equals the live claim's operation ID. After the authoritative observation and claim-identity recheck, a non-owner must return recovery-pending without clearing the claim; an owner permit may settle complete or unrecognized state. Preserve the existing late-observation protection, destination-pending behavior, stale-claim cleanup after the lock exits, and exact permit-intent checks. Change the catalog service only if the regression demonstrates that result mapping or call ordering still loses the owner result.

- [ ] **Step 3: Run focused GREEN checks**

Run, serially:

```bash
npm test -- --run src/server/workspaceTasks/workspaceTasksMoveRegistry.test.ts src/server/workspaceTasks/workspaceTasksCatalogService.test.ts src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.test.ts src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.test.ts
npm run typecheck
npx eslint src/server/workspaceTasks/workspaceTasksMoveRegistry.ts src/server/workspaceTasks/workspaceTasksMoveRegistry.test.ts src/server/workspaceTasks/workspaceTasksCatalogService.ts src/server/workspaceTasks/workspaceTasksCatalogService.test.ts src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.test.ts src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.test.ts
```

Record RED/GREEN evidence and confirm no direct writer can bypass the active claim while unrelated workspaces remain available.

- [ ] **Step 4: Run complete verification and inspect the whole range**

After both task commits are present, run serially:

```bash
npm run verify:fast
npm run verify
npm run build
npm run pack:dry
npm run changelog:status
git diff --check
git status --short
```

Confirm the original merge base is an ancestor of the new HEAD, protected paths remain unchanged, the existing Changeset is untouched, and no temporary artifacts remain.

- [ ] **Step 5: Commit and report the server correction**

Inspect the exact server diff and commit only allowed production/test files with `fix(tasks): protect active move owner settlement`. Include the commit SHA and complete verification results in the report. The final reviewer must judge the entire `5eda56bb..HEAD` range and reconcile F-1, F-2, and F-3.
