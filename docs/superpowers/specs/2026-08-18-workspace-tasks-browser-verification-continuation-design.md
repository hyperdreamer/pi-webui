# Workspace Tasks Browser Verification Continuation Design

**Date:** 2026-08-18

## Context

The original Workspace Tasks SDD run is terminal at `DISPATCH_MISMATCH_BLOCKED` and remains sealed. Its first recovery run at `.sdd/workspace-tasks-global-catalog-recovery` is nonterminal but has no active child after three Advanced implementers stopped on provider-side relay failures while working only on temporary Chromium/CDP fixtures. That run is preserved unchanged and its partial reports, fixture files, transcript output, and browser claims are not evidence for this continuation.

The committed product baseline is `3373dc212ee5680924271126c496908a1b543143`, which includes the complete Workspace Tasks feature and the recovery plan documents. The product worktree was clean after every stalled child. The continuation runs on the separate `feature/workspace-tasks-global-catalog-recovery-2` worktree so it does not overlap the stalled run's state or source ownership.

## Goal

Obtain fresh browser acceptance and complete-branch verification through smaller, independently reviewed tasks without relying on any excluded probe result.

## Design

The continuation splits the previous final task into three bounded tasks:

1. Construct and smoke-test a disposable raw-CDP fixture that imports the built Workspace Tasks panel, uses controller-shaped state/actions, and establishes a valid page target, module load, and measurement channel.
2. Run the full browser acceptance matrix through that fixture. A fixture failure is repaired only in `/tmp`; a product defect is repaired only after a deterministic RED regression and then re-measured in Chromium.
3. Remove every temporary fixture and run the focused cross-layer suite plus complete serial verification and package checks.

Each task receives independent implementation and review gates. The final Frontier review covers the entire feature range from `5eda56bbab1c295e04623ed156039c3ddc847072` through the final successor head, with a carry-forward ledger that records the prior valid task-review finding IDs as fixed and the excluded runs as non-evidence.

## Evidence Boundaries

- Do not read or use reports, transcript output, fixture files, screenshots, or result JSON from either prior Task 15 attempt as evidence.
- Do not modify the sealed original or stalled recovery run roots.
- A new probe must be created under `/tmp/workspace-tasks-cdp-recovery-2`; it must serve the root page as HTML, resolve the page-level DevTools target, and clean up Chromium, server, and profile resources in `finally`.
- A browser result is admissible only when the successor child writes its report from a byte-matched persisted prompt.
- No shipped source/test change is allowed without a fresh measured product defect, a deterministic RED regression, a minimal fix, GREEN verification, and a repeated measurement.
- No release, tag, push, merge, session-daemon change, public plugin-API change, README update, or CHANGELOG update is part of this continuation.

## Acceptance

The successor reaches `COMPLETE` only when all three task reviews report `SPEC: PASS` and `QUALITY: APPROVED`, the browser task records desktop/mobile and theme/interaction evidence from the new fixture, the final verification commands exit zero, the worktree is clean, and the whole-branch Frontier review approves the final source range.
