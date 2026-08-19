# Workspace Tasks F-2 Final Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic subagent-driven-development controller to execute this plan task-by-task.

**Goal:** Correct the final-review F-2 refresh-completion race without regressing the resolved F-1 and F-3 Workspace Tasks contracts.

**Architecture:** A controller-private refresh identity and move-error provenance distinguish an error emitted during a current authoritative refresh from one emitted later. A successful current two-source refresh clears only the error tied to its own operation; all public state, server protocol, and panel contracts remain unchanged.

**Tech Stack:** TypeScript, Vitest, Node.js 22.19+.

## Global Constraints

- Work only in `/data/home/guest/Development/pi-webui/.worktrees/workspace-tasks-global-catalog-final-continuation`.
- Preserve every existing `.sdd` run root, including terminal mismatch/blocked runs, exactly as historical evidence. Do not edit their state, progress, prompts, reports, receipts, or event files.
- Carry F-1, F-2, and F-3 by exact ID. F-2 is the only open correction: a successful two-source refresh must clear a known move error that arrived during that same refresh, without clearing an error from a later move or non-authoritative refresh.
- Review the full product range from merge base `5eda56bbab1c295e04623ed156039c3ddc847072` through final HEAD.
- Preserve Workspace Tasks version-one schema, `<workspace>/.pi-webui/tasks.json`, route/API contracts, CAS behavior, move recovery, panel draft retention, F-1 source-scoped acknowledgement, F-3 active-owner settlement, and public plugin contracts.
- Do not modify `src/plugin-api.ts`, any session-daemon code/protocol, runtime ownership, `README.md`, `CHANGELOG.md`, release metadata, dependencies, unrelated source, or any Changeset.
- Task 1 may modify only `src/client/src/controllers/workspaceTasksController.ts` and `src/client/src/controllers/workspaceTasksController.test.ts`.
- Every child receives a persisted exact one-line bootstrap pointing to a complete run-local dispatch file. Verify that file exists before intent, record `dispatch-started` immediately after spawn, and compare first user bytes before report admission. A mismatch blocks the run.
- Use TDD: write each regression first, observe its focused RED failure against current source, then make the minimum implementation and observe GREEN. Keep temporary artifacts outside shipped source and remove them before reporting.

## Task 1: Settle Known Move Errors At Authoritative Refresh Completion

**Implementer tier:** Capable

**Files:**

- Modify: `src/client/src/controllers/workspaceTasksController.ts:90-330, 580-610, 1280-1310`
- Test: `src/client/src/controllers/workspaceTasksController.test.ts:860-910`

**Interfaces:**

- Consumes `RefreshContext`, `startRefresh()`, `refreshSelection()`, `handleMoveResult()`, and `clearMoveError()` from `WorkspaceTasksController`.
- Preserves public `WorkspaceTasksWorkspaceState.moveError?: { kind: "validation" | "unavailable"; message: string }` without adding public fields or changing panel/API contracts.
- Produces controller-private refresh/error provenance such that only a successful, current, matching refresh can clear the known error recorded during it.

- [ ] **Step 1: Add focused F-2 regressions before production edits**

Add deterministic controller tests using existing `deferred()` reads and the existing fake client.

1. Parameterize `validation` and `unavailable`. Load initial catalogs, start `actions.refresh()` with both replacement reads deferred, await `settle()`, run `actions.move()` with the known result, and assert `moveError` is visible while the refresh remains in flight. Resolve both refresh reads successfully and await refresh. Assert final `moveError` is absent, `move` and `mutationGate` are absent, and both source generations advanced from the initial values.
2. Start and complete an authoritative refresh, then accept a known move result. Assert the later `moveError` remains visible. This protects a later move result from the earlier refresh completion.
3. Start a refresh with one successful source and one unavailable/failing source, accept a known move result while it is in flight, complete the reads, and assert the known `moveError` remains. Only a two-source authoritative completion may clear it.
4. Keep the existing initial Refresh-clear, new-move clear, selection clear, nonblocking CRUD, partial, and unknown-outcome regressions intact.

Run serially and record RED:

```text
npm run test:serial -- --run src/client/src/controllers/workspaceTasksController.test.ts
```

The first regression must fail because current `refreshSelection()` publishes after successful reads without clearing the error emitted during the refresh. Do not edit production code until the failure is observed for that reason.

- [ ] **Step 2: Implement the smallest private provenance guard**

Give each newly created refresh context a private monotonically increasing operation identity distinct from `selectionGeneration`. Associate a known `validation`/`unavailable` `moveError` with the current matching refresh identity when that result is accepted; no public state shape changes. Clear the error and its provenance together on refresh start, new move, selection replacement/invalidation, and only after both source outcomes of the same current refresh are successful. A cancelled, failed, stale, superseded, or nonmatching refresh must not clear it. Do not weaken `isRefreshContextCurrent()`, direct mutation gates, blocking partial/unknown recovery, or source-generation publication.

- [ ] **Step 3: Run focused GREEN verification**

Run serially:

```text
npm run test:serial -- --run src/client/src/controllers/workspaceTasksController.test.ts
npm run typecheck
npx eslint src/client/src/controllers/workspaceTasksController.ts src/client/src/controllers/workspaceTasksController.test.ts
npm run verify:fast
```

Inspect `git diff --check` and confirm the diff contains only the two allowed client files before proceeding.

- [ ] **Step 4: Commit the correction**

Run `git status --short`, recheck that protected paths and prior `.sdd` roots are unchanged, then commit only the two allowed files:

```text
fix(tasks): clear stale known move errors after refresh
```

Write exactly one task report with the RED command/output reason, GREEN checks, final commit SHA, scope check, and any concerns.

## Completion Boundary

After Task 1 and its independent task review approve, run `npm run verify`, `npm run build`, `npm run pack:dry`, `npm run changelog:status`, `git diff --check`, protected-path scans, and clean-tree checks. Dispatch a fresh Frontier final reviewer over `5eda56bbab1c295e04623ed156039c3ddc847072..HEAD`. The final review must explicitly resolve F-1/F-3, verify the F-2 overlap and later-error/no-authoritative guards, exclude all inadmissible prior reports, and complete only with spec PASS, quality APPROVED, no open load-bearing findings, and terminal SDD COMPLETE.
