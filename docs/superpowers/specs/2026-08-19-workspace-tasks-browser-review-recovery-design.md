# Workspace Tasks Browser Review Recovery Design

**Date:** 2026-08-19

## Context

The documentation-recovery run at `.sdd/workspace-tasks-documentation-recovery` is stalled in `TASK_REVIEW_RUNNING` after its correlated Frontier reviewer received the exact persisted bootstrap but stopped during a provider overload. The reviewer wrote no required report, made no worktree changes, and cannot supply an admissible verdict. Its run root, state, progress ledger, prompt, and session transcript remain preserved and are not changed by this recovery.

The Workspace Tasks feature source is committed through `6ca0e6d9a93dd38289ce843dc0fa0360aada6e52`. Fresh focused tests, the serial repository verification suite, build, package dry run, Changeset status, and a read-only pre-fix regression probe have been run independently in the existing worktree. The original Task 15 browser acceptance has no admissible Chromium/CDP artifact, so it remains an explicit verification gap.

## Goal

Produce fresh, admissible browser acceptance and independent review evidence for the committed Workspace Tasks feature without creating another worktree, modifying a sealed run, or making unmeasured product changes.

## Design

A distinct, one-task continuation uses the same existing worktree after confirming that the stalled run has no live lock or child. Its task starts from the immutable product range `5eda56bbab1c295e04623ed156039c3ddc847072..6ca0e6d9a93dd38289ce843dc0fa0360aada6e52` and performs a browser acceptance probe against the real Workspace Tasks custom element.

The probe creates only temporary fixture and CDP files, mounts global and workspace task catalogs with duplicate IDs, grouped tasks, long commands, and deterministic actions, and records desktop plus `430x844` measurements. It verifies filters, disclosure state, focus behavior, accessible action names, theme tokens, and no horizontal overflow or incoherent control overlap. It removes every temporary fixture, browser process, server, log, and screenshot before the task report is written.

If the probe measures a defect, the task follows TDD: add the smallest deterministic regression, demonstrate the red failure, make the minimal scoped panel correction, run the focused panel suite, and repeat the exact browser measurement. If no defect is measured, it creates no product commit.

A fresh task reviewer then reviews the full product range independently. A fresh Frontier final reviewer follows only after task approval. Neither reviewer may use the interrupted reviewer, the stalled documentation-recovery audit, or any prompt-mismatched predecessor report as correctness evidence.

## Safety Boundaries

- Work only in `/data/home/guest/Development/pi-webui/.worktrees/workspace-tasks-global-catalog-final-continuation`; do not create a worktree.
- Preserve every predecessor run root, including the nonterminal stalled documentation-recovery run, as historical evidence.
- Treat `6ca0e6d` as source to inspect, not as a trusted report.
- Preserve the version-one task schema, workspace catalog path, route/API contracts, CAS and move-recovery semantics, panel draft retention, and public plugin API.
- Do not modify `src/plugin-api.ts`, session-daemon code/protocol, runtime ownership, `README.md`, `CHANGELOG.md`, release metadata, dependencies, or unrelated source.
- The existing minor Workspace Tasks Changeset remains the only release record for this feature.
- Final acceptance requires fresh browser evidence or an explicitly recorded browser-tooling limitation, independent task and final review approval, an empty reconciled finding ledger, clean Git state, and fresh verification evidence.
