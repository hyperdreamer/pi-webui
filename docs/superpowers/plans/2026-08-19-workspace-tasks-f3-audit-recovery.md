# Workspace Tasks F-3 Audit Recovery Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic subagent-driven-development controller to execute this plan task-by-task.

**Goal:** Produce admissible fresh F-3 server audit evidence after the Task 2 prompt mismatch, independently review it, and complete a Frontier review of the full Workspace Tasks range.

**Architecture:** The previous run is blocked and preserved. This one-task successor audits the current F-3 server correction without modifying source, then a separate reviewer checks the audit. A final Frontier reviewer inspects the complete original-base-to-HEAD range and carries F-1/F-2/F-3 explicitly.

**Tech Stack:** TypeScript, Fastify, Vitest, Node.js 22.19+.

## Global Constraints

- Work only in `/data/home/guest/Development/pi-webui/.worktrees/workspace-tasks-global-catalog-final-continuation`.
- Preserve `.sdd/workspace-tasks-final-blocked-remediation`, `.sdd/workspace-tasks-post-correlation-dispatch-recovery`, and `.sdd/workspace-tasks-short-bootstrap-recovery` unchanged as historical/blocked artifacts. Do not edit their state, progress, prompts, reports, receipts, or event files.
- Carry findings F-1, F-2, and F-3 by exact ID in the final review. The client candidate commit `1488190065582687440f1cc3062c50e461b0ce5b` and server candidate commit `bb96c94131b7283076ba479427186f782629a252` are source to inspect, not trusted evidence from inadmissible reports.
- Review the complete product range from merge base `5eda56bbab1c295e04623ed156039c3ddc847072` through the final HEAD.
- Preserve Workspace Tasks version-one schema, `<workspace>/.pi-webui/tasks.json`, route/API contracts, CAS behavior, move recovery behavior, panel draft retention, and public plugin contracts.
- Do not modify `src/plugin-api.ts`, session-daemon code or protocol, runtime ownership, `README.md`, `CHANGELOG.md`, release metadata, dependencies, unrelated source, or Changesets.
- Every child receives a persisted exact short bootstrap line pointing to a run-local dispatch file. Compare it byte-for-byte with the child’s first user message before dispatch-started and before report admission. On mismatch, do not admit any report or source claims.
- Task 1 is read-only. Verification artifacts, logs, profiles, and servers must be outside shipped source and removed before reporting.

## Task 1: Fresh F-3 Server Audit

**Implementer tier:** Capable

**Files:**

- Read-only review of `src/server/workspaceTasks/workspaceTasksMoveRegistry.ts` and `.test.ts`.
- Read-only review of `src/server/workspaceTasks/workspaceTasksCatalogService.ts` and `.test.ts`.
- Read-only review of the candidate range `5eda56bbab1c295e04623ed156039c3ddc847072..bb96c94131b7283076ba479427186f782629a252`.
- Write only the run-local audit report and temporary verification artifacts.

**Dispatch bootstrap:** Persist one exact line pointing to a run-local dispatch file. The dispatch file must tell the child to read this complete Task 1 brief, independently inspect the candidate F-3 implementation and tests, and write exactly one report at the run report path. It must prohibit source/index/HEAD edits and exclude all prior reports and claims.

- [ ] **Step 1: Verify identity and scope**

Verify branch, HEAD, clean status, original merge-base ancestry, candidate ancestry, candidate commit changed files, protected-path projection, and absence of temporary artifacts. Treat the prior Task 2 report and commit claims as inadmissible.

- [ ] **Step 2: Audit F-3 source and tests**

Verify that active move-owner permits cannot be invalidated by a no-permit direct writer between authoritative publication and `completeWithPermit()`. Check owner-token identity, start-owner and retry-owner transitions, exact-permit settlement for complete/unrecognized pairs, recovery-pending for non-owner observations while the lock is active, stale-claim reconciliation after owner exit, and unrelated-operation/workspace behavior. Inspect whether tests are falsifiable and actually cover the race.

- [ ] **Step 3: Run fresh checks**

Run and record actual results:

```text
npm test -- --run src/server/workspaceTasks/workspaceTasksMoveRegistry.test.ts src/server/workspaceTasks/workspaceTasksCatalogService.test.ts src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.test.ts src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.test.ts
npm run typecheck
npx eslint src/server/workspaceTasks/workspaceTasksMoveRegistry.ts src/server/workspaceTasks/workspaceTasksMoveRegistry.test.ts src/server/workspaceTasks/workspaceTasksCatalogService.test.ts src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.test.ts src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.test.ts
npm run verify:fast
```

Do not claim tests run by the inadmissible Task 2 child; execute them in this audit.

- [ ] **Step 4: Report and cleanup**

Write exactly one report at the run-local report path. Use `DONE` only if source inspection, focused checks, scope checks, and cleanup pass. Do not commit or modify product files.

## Completion Boundary

After Task 1 and its independent review pass, run `npm run verify`, `npm run build`, `npm run pack:dry`, `npm run changelog:status`, `git diff --check`, and protected-path/status scans. Dispatch a fresh Frontier final reviewer over `5eda56bbab1c295e04623ed156039c3ddc847072..HEAD`, carrying F-1/F-2/F-3 and excluding all inadmissible mismatch reports. Complete only with final spec PASS, quality APPROVED, no open load-bearing findings, clean Git state, and terminal SDD COMPLETE.
