# Workspace Tasks Final Review Dispatch Recovery Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic subagent-driven-development controller to execute this plan task-by-task.

**Goal:** Re-run the F-3 review with an admissible dispatch, independently review it, and complete final review.

**Architecture:** This successor preserves all prior runs. Its only task is a fresh read-only F-3 review from source. The task reviewer then checks that review. A final Frontier reviewer inspects the full Workspace Tasks range from the original merge base through final HEAD, carrying F-1/F-2/F-3.

**Tech Stack:** TypeScript, Vitest, Node.js 22.19+.

## Global Constraints

- Work only in `/data/home/guest/Development/pi-webui/.worktrees/workspace-tasks-global-catalog-final-continuation`.
- Preserve every prior `.sdd` run root, report, prompt, receipt, event, state, and progress file unchanged. Prior mismatch and blocked reports are evidence of process history, not correctness evidence.
- Carry F-1, F-2, and F-3 by exact ID. Inspect source from merge base `5eda56bbab1c295e04623ed156039c3ddc847072` through final HEAD. Candidate server correction is `bb96c94131b7283076ba479427186f782629a252`.
- Preserve schema, routes, CAS, move recovery, drafts, public plugin contracts, plugin API, session daemon, runtime ownership, README, CHANGELOG, release metadata, dependencies, and Changesets.
- Every child receives a persisted one-line bootstrap pointing to a complete persisted dispatch file. Verify the dispatch file exists before intent; record `dispatch-started` immediately after spawn; compare first user bytes before report admission. Any mismatch blocks the run.
- All work is read-only. Do not modify source, tests, index, HEAD, or prior run roots. Remove temporary verification artifacts before reporting.

## Task 1: Fresh F-3 Review

**Implementer tier:** Capable

**Files:**

- Read-only: `src/server/workspaceTasks/workspaceTasksMoveRegistry.ts`, `.test.ts`, `src/server/workspaceTasks/workspaceTasksCatalogService.test.ts`.
- Read-only: candidate range `5eda56bbab1c295e04623ed156039c3ddc847072..bb96c94131b7283076ba479427186f782629a252`.
- Read-only: admissible F-3 audit report from `.sdd/workspace-tasks-f3-audit-recovery/task-1-implementer-report.md`.
- Write only the new run-local report and temporary artifacts.

- [ ] **Step 1: Fresh source review**

Independently inspect F-3 ownership-token behavior, active start/retry owner protection, exact permit settlement, recovery-pending for non-owner observations, stale-claim reconciliation, and falsifiable tests. Run the four focused server test files, typecheck, targeted ESLint, and `npm run verify:fast`. Verify protected paths, ancestry, clean status, and cleanup. Do not use the blocked review as correctness evidence.

- [ ] **Step 2: Report**

Write exactly one report using `SPEC: PASS|FAIL`, `QUALITY: APPROVED|CHANGES_REQUESTED`, and exact findings. Use `DONE` only after all checks pass. Do not commit.

## Completion Boundary

After Task 1 and an independent task review approve, run `npm run verify`, `npm run build`, `npm run pack:dry`, `npm run changelog:status`, `git diff --check`, and clean/protected-path scans. Dispatch a Frontier final reviewer over `5eda56bbab1c295e04623ed156039c3ddc847072..HEAD`. The final reviewer must explicitly adjudicate F-1, F-2, F-3 and exclude all inadmissible reports. Complete only with final spec PASS, quality APPROVED, no open load-bearing findings, and clean Git state.
