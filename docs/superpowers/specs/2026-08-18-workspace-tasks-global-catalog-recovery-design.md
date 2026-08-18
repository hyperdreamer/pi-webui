# Workspace Tasks Verification Recovery Design

**Date:** 2026-08-18

## Context

The original deterministic SDD run for Workspace Tasks reached `DISPATCH_MISMATCH_BLOCKED` at revision 221 while dispatching its final browser-verification task. The controller compared the persisted rendered prompt with the child transcript and found a byte mismatch: the child received 5,777 UTF-8 bytes while the stored prompt was 5,800 bytes. The first difference was in the `NEEDS_CONTEXT` instruction. The child therefore produced no admissible evidence, even though its worktree remained clean and its uncommitted source changes were removed before it stopped.

The original run root, state, progress ledger, prompt, report, and mismatch artifacts remain sealed and are not reopened. The committed feature range through `da1463cce69a50199ff17835e765d89b4e30913d` is the only source baseline carried forward. The mismatched child's transcript, report, browser output, and any derived claims are excluded from the successor run.

## Goal

Independently repeat the final Workspace Tasks browser acceptance and complete-branch verification from the committed feature baseline, then obtain fresh task-review and whole-branch Frontier final-review evidence.

## Design

The successor run has one implementation task. It performs a no-source-change audit of the exact committed Workspace Tasks range, runs the focused cross-layer tests, mounts the real bundled panel in a temporary Chromium/CDP probe, and records desktop/mobile geometry, themes, scoped identity, native disclosure, recovery, keyboard/focus, and overflow observations. It then runs the required `verify:fast`, serial `verify`, build, package, Changeset, and whitespace checks in order.

No source or test change is authorized merely to create a verification commit. If the fresh browser probe measures a real defect, the task must add the narrowest deterministic regression first, observe its RED failure against the current implementation, make the minimum fix, rerun the focused suite, and repeat the same browser measurement. Only that measured source/test change may be committed.

The fresh task reviewer independently checks the no-source-change audit or measured fix. A Frontier final reviewer then reviews the complete branch from the successor run's merge base through its final HEAD, reconciles all carried findings from the prior valid task reviews, and treats the original mismatch artifacts as excluded evidence.

## Safety And Evidence Boundaries

- The original blocked run is immutable and remains terminal.
- The successor plan and run have a distinct path and digest.
- The successor task must render prompts from persisted files and compare each admitted child transcript's initial user message byte-for-byte before pinning its report.
- The mismatched Task 15 child report, transcript, probe output, and status are not evidence in the successor run.
- No automatic retry, compensation, merge, or source rewrite is allowed.
- The browser probe uses temporary or `/tmp` artifacts only and leaves no shipped fixture.
- `README.md`, `CHANGELOG.md`, `src/plugin-api.ts`, session-daemon code, and runtime ownership remain unchanged unless a measured UI fix itself requires only the named panel source/test files.

## Acceptance

The successor run reaches `COMPLETE` only after the fresh task review reports `SPEC: PASS` and `QUALITY: APPROVED`, the Frontier final review approves the whole branch, all required verification commands pass, the feature worktree is clean, and the original blocked run remains byte-preserved and terminal.
