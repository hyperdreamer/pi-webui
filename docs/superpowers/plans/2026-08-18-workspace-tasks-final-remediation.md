# Workspace Tasks Final Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Fix the four load-bearing Workspace Tasks findings identified by the Frontier final review and verify the resulting product branch.

**Architecture:** Keep fixes at their existing ownership boundaries: global persistence classifies post-publication errors, move orchestration reconciles live claims, the bundled panel settles successful no-op mutations through explicit acknowledgement, and workspace adapter identity validation maps to known no-write failures. No new cross-cutting abstraction or public API is introduced.

**Tech Stack:** TypeScript, Fastify, Lit custom elements, Vitest, Node.js 22.19+.

## Global Constraints

- The final-review findings F-2 through F-5 in the approved remediation design are authoritative; implement only those corrections.
- Preserve existing move, CAS, unknown-outcome, draft-retention, route, and public-plugin contracts unless the finding explicitly changes them.
- Add no dependencies. Do not modify `src/plugin-api.ts`, session-daemon code/protocol, runtime ownership, README, CHANGELOG, or release metadata.
- Use TDD for every correction: write a focused regression, observe RED against the current implementation, make the minimum fix, observe GREEN, then run the broader verification.
- Work only in `/data/home/guest/Development/pi-webui/.worktrees/workspace-tasks-global-catalog-remediation`; do not edit predecessor run roots or browser artifacts.
- Preserve user changes and unrelated worktree state. Commit only the allowed production/test files with a behavior-specific Conventional Commit.

## Task 1: Correct Final-Review Findings F-2 Through F-5

**Implementer tier:** Capable

**Files:**

- Modify: `src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.ts`
- Modify: `src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.test.ts`
- Modify: `src/server/workspaceTasks/workspaceTasksCatalogService.ts`
- Modify: `src/server/workspaceTasks/workspaceTasksCatalogService.test.ts`
- Modify: `src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.ts`
- Modify: `src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.test.ts`
- Modify: `src/server/workspaceTasks/workspaceTasksRoutes.test.ts` if needed for the F-5 status contract
- Modify: `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts`
- Modify: `pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts` or `tasksPanelElement.test.ts`

**Interfaces:**

- F-2 produces a global replace that treats all failures after publication attempt/acknowledgement as `WorkspaceTasksUnknownOutcomeError`, invokes `onWriteOutcomeUnknown`, and preserves pre-publication failures as known unavailable. Its route response is typed `500 { kind: "unknown-outcome" }`.
- F-3 produces move orchestration that reconciles a live permit against the authoritative post-destination pair before classifying pristine/unrecognized states, clears mismatched claims, and does not leave unrelated direct writers recovery-blocked after a proven non-destination state.
- F-4 produces panel settlement that closes a successful canonical no-op update while retaining the existing regression that a resolved action with no authoritative source publication keeps the draft open. Use an explicit action acknowledgement/generation or an equivalent state-owned signal, not a content-key guess.
- F-5 produces known no-write identity/unavailable classification for project/workspace address validation before mutation queue/publication. Add route-level evidence that a deleted/unknown workspace does not return typed unknown-outcome `500`.

- [ ] **Step 1: Inspect the findings and add RED regressions**

Read the final-review finding locations and current tests. Add one minimal regression per finding:

```text
F-2: controlled coordinator calls onSaved, then throws; expect UnknownOutcomeError and ["acknowledged", "unknown"] callbacks.
F-3: after destination publication, authoritative pristine/unrecognized observation clears the live claim and returns the defined conflict; a following direct write is not recovery-blocked.
F-4: edit a task with whitespace-only draft changes that canonicalize to the current task; resolve the update successfully and assert the editor closes/focus returns, while the existing “no authoritative publication” test remains open.
F-5: replace a deleted/unknown workspace address and assert a known no-write unavailable/identity response and route status, never unknown-outcome 500.
```

Run the smallest focused test commands for each new regression and confirm each fails for the reported mechanism, not because of a test typo.

- [ ] **Step 2: Implement the minimum corrections**

Fix F-2 by using publication-attempt state as the boundary after which every ordinary coordinator error is unknown; keep authorization, revision, invalid-catalog, and known pre-publication failures typed as before. Fix F-3 by routing post-destination authoritative observations through the registry’s permit-aware reconciliation before returning from pristine/unrecognized branches; preserve partial/complete behavior and no compensation. Fix F-4 through an explicit successful action acknowledgement or mutation generation that the panel can settle even when semantic catalog content is unchanged; do not settle merely because the action promise resolved if no authoritative publication was reported. Fix F-5 by catching identity validation before entering the write queue and translating it to the existing known no-write unavailable/identity boundary.

- [ ] **Step 3: Run focused GREEN verification**

Run serially:

```bash
npm test -- --run src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.test.ts src/server/workspaceTasks/workspaceTasksCatalogService.test.ts src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.test.ts src/server/workspaceTasks/workspaceTasksRoutes.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts
npm run typecheck
npx eslint src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.ts src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.test.ts src/server/workspaceTasks/workspaceTasksCatalogService.ts src/server/workspaceTasks/workspaceTasksCatalogService.test.ts src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.ts src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.test.ts src/server/workspaceTasks/workspaceTasksRoutes.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts
```

- [ ] **Step 4: Run complete verification and inspect scope**

Run `npm run verify`, `npm run build`, `npm run pack:dry`, `npm run changelog:status`, and `git diff --check` serially. Verify the diff contains only the allowed files, protected files remain unchanged, and no test fixture or generated output is tracked.

- [ ] **Step 5: Commit and report**

Inspect `git status --porcelain`, `git diff --stat`, and the exact diff. Commit the tested correction as `fix(tasks): resolve final review findings`. Write exactly one implementer report with RED/GREEN evidence, focused/full verification, commit SHA, and any remaining concern.
