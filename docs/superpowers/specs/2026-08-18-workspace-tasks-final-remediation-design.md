# Workspace Tasks Final Remediation Design

**Date:** 2026-08-18

## Purpose

Implement the four load-bearing findings from the Frontier final review of the Workspace Tasks feature. The previous final-fix dispatch was invalid because its handoff brief forbade product edits; this remediation plan explicitly authorizes only the four listed production/test corrections.

## Findings

- **F-2:** `WorkspaceTasksGlobalCatalogAdapter.replace()` acknowledges a global publication, then classifies a later coordinator/reload error as unavailable. Every error after publication attempt/acknowledgement must be `WorkspaceTasksUnknownOutcomeError`, invoke the unknown callback, and route as typed `500`.
- **F-3:** `WorkspaceTasksCatalogService` returns unknown outcome after destination publication when authoritative reread proves a pristine or unrecognized pair without reconciling the live claim. The service must reconcile the permit before returning, clear mismatched claims, and return the defined zero-write conflict/retry-pristine result; only unavailable/unproven reads retain recovery.
- **F-4:** `TasksPanelElement.reconcilePendingAction()` requires a changed catalog JSON key, so a successful canonical no-op update can leave the editor open. Add explicit mutation acknowledgement settlement or an equivalent authoritative generation that handles semantic no-op updates without weakening the existing “no publication” draft-retention test.
- **F-5:** Workspace address validation occurs outside the adapter’s write classification boundary. Unknown/deleted project/workspace errors must be typed known no-write identity/unavailable errors and must not become unknown outcome `500`.

## Scope

Only the server adapters/service/routes, bundled Tasks panel/controller tests, and their focused tests may change. No public plugin API, session daemon, dependency, documentation, or release metadata changes are allowed. The child must use TDD: each regression fails before the minimum fix, then focused GREEN and full verification. The remediation commit is reviewed as an ordinary task and then by a fresh Frontier final reviewer.
