# Workspace Tasks Verification Recovery 3 Design

**Date:** 2026-08-18

## Context

The original Workspace Tasks run and the first browser continuation are sealed at `DISPATCH_MISMATCH_BLOCKED`. Their reports, prompts, browser artifacts, and reviewer verdicts are excluded evidence. The committed product branch remains clean at `44bd0051c94e44dc77f390eb6b12ab00b942017f`, which contains the complete Workspace Tasks implementation and the prior continuation documents.

## Goal

Complete fresh browser acceptance, serial verification, and independent review for the exact existing feature range without changing shipped source unless a new browser measurement proves a defect.

## Approach

Run three bounded tasks in a new isolated worktree:

1. Audit the exact clean source range and create a disposable raw-CDP fixture with fresh two-viewport smoke evidence.
2. Execute the full browser acceptance matrix and make only a measured, regression-tested product fix if required.
3. Run focused and complete serial verification, remove all temporary artifacts, and leave the branch clean.

Each task gets an independent implementer and reviewer gate. The final review covers the whole feature range from `5eda56bbab1c295e04623ed156039c3ddc847072` through the successor head.

## Evidence Boundaries

- Preserve both prior run roots unchanged; do not read their reports or use their browser artifacts as evidence.
- Pin `44bd0051c94e44dc77f390eb6b12ab00b942017f` as the source baseline and `5eda56bbab1c295e04623ed156039c3ddc847072` as the feature-range base.
- Use only `/tmp/workspace-tasks-cdp-recovery-3` for temporary browser files, profiles, servers, and results.
- A dispatched child is admissible only when its first message exactly matches the persisted rendered prompt and its typed tier is verified.
- Keep protected source, plugin API, README, CHANGELOG, session-daemon code, and runtime ownership unchanged unless a measured defect requires the explicitly scoped source/test fix.

## Acceptance

The run reaches `COMPLETE` only after all task reviews pass both axes, fresh browser evidence covers desktop/mobile, themes, scope filters, grouped tasks, equal IDs, move recovery, keyboard focus, long commands, and overflow, the full serial verification sequence exits zero, temporary artifacts are removed, and the final whole-range review approves with no open findings.
