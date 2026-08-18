# Workspace Tasks Verification Recovery 4 Design

**Date:** 2026-08-18

## Purpose

Produce fresh, admissible browser acceptance and complete-branch verification for the committed Workspace Tasks implementation after the prior recovery run was sealed at `DISPATCH_MISMATCH_BLOCKED`. This is a verification continuation, not a product redesign.

## Sealed predecessor

The predecessor run is `/data/home/guest/Development/pi-webui/.worktrees/workspace-tasks-global-catalog-recovery-3/.sdd/workspace-tasks-verification-recovery-3`. It is terminal at revision 20 because the Task 2 child received prompt bytes that differed from the stored dispatch intent. Its Task 2 report, acceptance runner, browser output, and child claim are inadmissible evidence. Its `state.json`, `progress.md`, prompts, reports, and artifacts remain preserved and are not edited.

The mismatched child made no tracked source change and created no commit. The source authority is therefore the pre-dispatch commit `04120a41712f7f5bb8a94da8b7f23c58e8bc3dfb` on the new recovery branch. The feature source range remains `5eda56bbab1c295e04623ed156039c3ddc847072..04120a41712f7f5bb8a94da8b7f23c58e8bc3dfb`; the only change after the prior source baseline is the already committed recovery documentation. A fresh run must establish its own browser evidence without consulting either predecessor's reports or temporary files.

## Fresh browser evidence

Task 1 creates a new disposable root at `/tmp/workspace-tasks-cdp-recovery-4`. It builds the current plugin output, creates a fixture from scratch, and imports only generated Workspace Tasks modules through a dynamic local HTTP server. It uses a temporary Chromium profile and dynamic ports, discovers a `type: page` target from that Chromium process's `/json/list`, and connects only to that target's page CDP socket.

The fixture assigns the real element's controller-shaped context, workspace/global state, and typed actions. It exposes deterministic helpers for theme application, catalog publication, scoped filters, native disclosure state, equal scoped IDs, promotion, demotion, destination collision, partial and unknown recovery, guarded retry, keyboard focus, long commands, and geometry. The raw-CDP runner exercises every helper through the real shadow DOM.

The acceptance matrix covers `1280x900` and `430x844` with Classic, PI WEBUI Dark, and PI WEBUI Light. It records panel and document `scrollWidth` versus `clientWidth`, summary/body bounds, action wrapping, long-script bounds and internal overflow, focus-visible outline measurements, duplicate-ID accessible names, filter `aria-pressed` state, native disclosure persistence, focus return after cancel/confirm, Tab, Escape, and Enter. It exercises promotion, demotion, collision, partial recovery, unknown-outcome refresh gating, guarded Retry, and terminal dispatch metadata.

All browser/server/profile/result artifacts are cleaned in `finally`; only the fixture and runner remain until Task 2 performs final cleanup. No predecessor temporary root is read or reused.

## Measured-defect boundary

A fixture or probe assertion failure is corrected only in the new temporary root. A shipped defect may be changed only when a fresh Chromium measurement identifies it, a deterministic regression is observed RED against the current implementation, the minimum source/test fix is made and committed, focused GREEN verification passes, and the identical browser measurement passes afterward. No speculative product changes, unrelated cleanup, automatic retries, or dependency changes are allowed.

## Complete verification

Task 2 runs the focused cross-layer suites and the full verification commands serially on the resulting clean branch. It verifies package contents, Changeset status, protected-file scope, and absence of the recovery-4 temporary root and browser processes. The deterministic controller then performs its independent task reviews and mandatory whole-branch Frontier final review. No merge, push, release, tag, or npm publication occurs in this recovery.
