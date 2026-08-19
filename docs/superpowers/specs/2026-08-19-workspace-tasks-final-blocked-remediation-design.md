# Workspace Tasks Final-Blocked Remediation Design

**Date:** 2026-08-19

## Purpose

Resolve the three load-bearing findings from the Frontier final review of the immutable Workspace Tasks product range. The prior browser-review run is terminally blocked because its audit task allowed only a Tasks panel source edit, while the findings also require controller and server ownership-boundary changes. This design is the explicit scope expansion for a new remediation run; the blocked run and its reports remain immutable evidence.

## Findings

- **F-1, source acknowledgement:** `TasksPanelElement` infers delivery of a canonical no-op mutation from top-level panel-state identity plus unchanged catalog content. A source-scoped acknowledgement/generation must be emitted by `WorkspaceTasksController` after a successful direct mutation, including a canonical no-op, and consumed by the panel. Unrelated publications and resolved action promises without that acknowledgement must retain the draft.
- **F-2, known move errors:** A known pre-destination `validation` or `unavailable` move result is represented as a blocking `move` conflict after the controller discards its move context. The result must instead be a nonblocking, scoped move error that retains the editor draft, does not disable CRUD, and is cleared by a later Refresh or a new move attempt.
- **F-3, active owner permit:** A direct writer can reconcile an exact complete or unrecognized pair while the move owner is still inside `withMoveLock`, clear the live claim, invalidate the owner's permit, and make the owner return an unavailable result after both publications completed. Non-owner reconciliation must not clear the active owner's claim; the owner permit must remain authoritative until settlement.

## Invariants

- Workspace Tasks version-one schema, storage paths, route/API contracts, CAS checks, move result meanings, guarded retry behavior, panel draft retention, and public plugin contracts remain compatible.
- A source acknowledgement is scoped to a catalog source and advances only when that source receives an authoritative response or successful direct mutation response. Top-level object identity is never an acknowledgement by itself.
- A known no-write move error is not a recovery claim. It is visible to the panel but does not participate in mutation blocking or Retry.
- While an operation's `withMoveLock` is active, a non-owner reconciliation may observe state but cannot clear that operation's live claim. The owner, using its permit, may settle complete or unrecognized state. Once the owner lock has ended, stale-claim reconciliation retains its existing behavior.
- No fix introduces a journal, dependency, session-daemon change, or distributed-lock claim.

## Scope

Client files allowed for the first task:

- `src/client/src/controllers/workspaceTasksController.ts`
- `src/client/src/controllers/workspaceTasksController.test.ts`
- `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts`
- `pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts`
- `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts` only if the focused regression belongs there

Server files allowed for the second task:

- `src/server/workspaceTasks/workspaceTasksMoveRegistry.ts`
- `src/server/workspaceTasks/workspaceTasksMoveRegistry.test.ts`
- `src/server/workspaceTasks/workspaceTasksCatalogService.ts`
- `src/server/workspaceTasks/workspaceTasksCatalogService.test.ts`
- the existing global/workspace adapter tests only if a deterministic direct-writer race requires their test seam

No task may modify `src/plugin-api.ts`, session-daemon code or protocol, runtime ownership, README, CHANGELOG, release metadata, dependencies, or unrelated source. The existing Workspace Tasks Changeset remains the release record; no new Changeset is added in this remediation.

## Verification

Each task uses TDD: a focused regression must fail against the pinned product source before its minimum production correction is written. The task reviewer independently checks the task range. The final Frontier reviewer checks the original merge base through the final remediation HEAD, reconciles F-1/F-2/F-3, and requires a clean worktree plus full serial verification.
