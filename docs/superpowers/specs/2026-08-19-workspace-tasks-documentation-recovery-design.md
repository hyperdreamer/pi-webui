# Workspace Tasks Documentation Recovery Design

**Date:** 2026-08-19

## Context

The post-mismatch continuation run reached `TASK_BLOCKED` after its fixer child received a first user message that differed from the persisted prompt bytes. That child report and its attempted correction are inadmissible evidence. The original predecessor run and the post-mismatch run remain sealed and unchanged.

The correction for the admitted documentation finding was independently inspected and committed as `6ca0e6d` on the existing continuation branch. It changes only the paired configuration guidance and adds a focused regression. A fresh deterministic run is still required to audit that commit and obtain independent task and Frontier final-review evidence.

## Goal

Complete an admissible review of the corrected Workspace Tasks documentation without reopening either mismatch-blocked run or changing the product source again.

## Design

The successor run has one read-only audit task. It pins the exact correction range `92933dc785e06f21e855d647e55c6ce22ef349e7..6ca0e6d`, the whole Workspace Tasks range from `5eda56bbab1c295e04623ed156039c3ddc847072` to the current branch tip, and the protected-path constraints. The task independently reads the paired Markdown/HTML guidance and regression, runs focused and repository verification, and creates no product commit.

A fresh Frontier task reviewer checks the full range and the correction finding. A fresh Frontier final reviewer then checks the complete range, reconciles the finding ledger, and approves only a clean worktree with passing verification and no residual findings.

Because a previous long prompt was manually copied incorrectly, the successor dispatch uses a short persisted file-backed bootstrap authorized by the recovery ruling. The bootstrap names the complete brief and report paths and carries the typed tier. Its exact bytes are compared with the child transcript before the audit report is admitted.

## Safety Boundaries

- The two prior mismatch run roots, state files, progress ledgers, prompts, reports, and receipts remain untouched.
- The new run has a distinct root and plan digest.
- No source, test, dependency, release metadata, README, CHANGELOG, session-daemon, or runtime-ownership changes are authorized.
- The existing pending Workspace Tasks Changeset remains the release record for the feature; no additional release fragment is created.
- Final acceptance requires independent review approval, an empty reconciled ledger, clean Git state, and successful verification.
