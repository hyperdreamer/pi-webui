# Workspace Tasks Final Review Recovery Design

**Date:** 2026-08-18

## Purpose

Complete the missing Frontier final review for the committed Workspace Tasks feature. The browser and serial verification task was independently accepted by the recovery-6 task reviewer; only its final reviewer dispatch was inadmissible because the child received parent-checkout artifact paths instead of the stored worktree paths.

## Evidence boundary

The source authority is `5eda56bbab1c295e04623ed156039c3ddc847072..b78bb44f0cb68ff4cfcc8b930af787263d665144`. The recovery-6 Task 1 implementer report and task-review report are admitted evidence because their prompts, paths, status, and task-review approval were verified. The recovery-6 final-review prompt, child transcript, and any final-review result are inadmissible and must not be read as evidence. Recovery-3, recovery-4, and recovery-5 run roots and their mismatched child evidence remain preserved and excluded.

## Continuation

Recovery-7 has one no-source-change audit task. It confirms the exact Git range and protected-file scope, independently verifies the admitted recovery-6 task result and its clean worktree/package claims, runs the remaining lightweight build/package/Changeset checks, and constructs a fresh final-review package plus empty ledger beneath its own run root. The task reviewer then checks that handoff. A newly rendered Frontier final-review prompt points only at recovery-7 paths and the exact committed range.

No product files, tests, session-daemon code, or runtime ownership change in this continuation. No merge, push, tag, release, or npm publication occurs.
