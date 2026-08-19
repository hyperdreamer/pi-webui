# Workspace Tasks F-2 Final Remediation Design

**Date:** 2026-08-20

## Context

The final review in `.sdd/workspace-tasks-final-review-dispatch-recovery` reproduced F-2: a known `validation` or `unavailable` move result can arrive while an ordinary refresh has both source reads in flight. `startRefresh()` clears the old error, but the later known result publishes a new nonblocking `moveError`; after both authoritative reads succeed, `refreshSelection()` publishes without clearing that error.

The exact source reproduction is deterministic: start a refresh with deferred workspace/global reads, resolve a known move error while both reads are pending, then resolve both reads successfully. The final state contains `moveError` with both source generations advanced.

## Decision

Keep `moveError` public shape unchanged. Add only private controller provenance that associates a known move error with the specific current refresh operation that was in flight when the result was accepted. A successful, current two-source refresh clears an error associated with that exact refresh. A failed, cancelled, stale, or superseded refresh does not clear it, and an error from a later move remains visible.

The refresh context needs a private per-operation identity distinct from selection generation. Known move-result handling records the active refresh identity only when it is current for the same selection. Selection invalidation, a new move, and refresh start continue to clear the error and its provenance together. Completion checks source outcomes and identity before clearing, so it cannot erase a newer result.

## Boundaries

- Modify only `src/client/src/controllers/workspaceTasksController.ts` and `src/client/src/controllers/workspaceTasksController.test.ts` for product behavior and regression coverage.
- Preserve the `WorkspaceTasksWorkspaceState` public contract, task schema, route/API contracts, CAS semantics, move recovery state, panel draft behavior, F-1 source acknowledgement, F-3 move-owner settlement, plugin API, session daemon, README, CHANGELOG, release metadata, dependencies, and existing Changeset.
- Preserve every earlier `.sdd` run root unchanged. Their reports remain process history; the new run must establish fresh test and review evidence.

## Test Strategy

Use the controller harness with controllable promises.

1. For both known move kinds, begin a refresh, accept the known move result while both reads are pending, then complete both reads successfully. Assert the final state has no `moveError`, no blocking move state/gate, and fresh source generations.
2. Assert a known error accepted after the refresh has completed remains visible, proving completion does not erase a newer move result.
3. Assert an incomplete/non-authoritative refresh does not clear an error produced during it.
4. Retain existing tests for initial Refresh clearing, new-move/selection clearing, nonblocking CRUD, and partial/unknown blocking recovery.

Run the focused controller suite before and after the implementation, then typecheck, targeted ESLint, `npm run verify:fast`, the serial `npm run verify`, build, pack dry-run, Changeset status, whitespace, protected-path, and clean-tree checks.
