# Workspace Tasks F-3 Audit Recovery Design

**Date:** 2026-08-19

## Purpose

Recover after a controller-side prompt-path mismatch prevented admission of the Task 2 implementer report and commit evidence. The prior run remains blocked and immutable as an audit artifact.

## Goal

Independently audit the F-3 server correction currently present in the worktree, review that audit, and complete a fresh Frontier final review of the entire Workspace Tasks range from merge base `5eda56bbab1c295e04623ed156039c3ddc847072` through the final HEAD.

## Evidence Boundary

The prior Task 1 audit and review from `.sdd/workspace-tasks-short-bootstrap-recovery` are admissible only as historical process evidence; the new F-3 audit must inspect source and run checks directly. The prior Task 2 report, claims, and commit admission are explicitly excluded because its persisted bootstrap did not match the child’s first message. The current `bb96c94131b7283076ba479427186f782629a252` commit is source under audit, not trusted evidence.

## Bootstrap Rule

Each child receives one exact short line pointing to a run-local dispatch instruction file. The pointed file contains the complete task-specific instructions and paths. The one-line prompt is persisted before spawn and compared byte-for-byte with the child’s first user message before the SDD dispatch-started transition. A mismatch is blocked and no report or source claim is admitted.
