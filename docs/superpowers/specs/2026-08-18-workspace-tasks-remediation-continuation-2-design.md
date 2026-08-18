# Workspace Tasks Remediation Continuation 2 Design

## Purpose

This continuation preserves the valid product commits from the blocked remediation runs while regenerating every audit and review artifact under a fresh SDD run. No predecessor child report is admissible evidence.

## Carry-forward source range

- Base: `de2e1dd67048179f33c20d67adf9ddb8a86037e8`
- Head: `d16cd5be97476c15ab4c17c167b16a7ba1f5310f`
- The range contains the original four-finding remediation and the follow-up correction for the move reconciliation race and real-composition route coverage.

## Scope

The audit task is read-only. A bounded fixer may modify only the already-approved Workspace Tasks production/test files if a fresh reviewer identifies a load-bearing defect. Protected APIs, daemon ownership, release metadata, dependencies, and unrelated source remain out of scope.

## Evidence rules

- Git and the exact source range are authoritative.
- Prior run reports are historical artifacts only.
- Every child receives the exact persisted `render-prompt` bytes, and its first message is checked before its report is admitted.
- SDD state and progress are changed only through reducer transitions.
- Completion requires independent task approval and Frontier final approval with no open finding.
