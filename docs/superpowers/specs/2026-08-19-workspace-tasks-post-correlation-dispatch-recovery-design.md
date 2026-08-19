# Workspace Tasks Post-Correlation Dispatch Recovery Design

**Date:** 2026-08-19

## Purpose

Recover the Workspace Tasks remediation after the Task 1 child received prompt bytes that differed from the persisted dispatch intent. The child produced commit `1488190065582687440f1cc3062c50e461b0ce5b`, but its report and commit are candidate source only until a fresh deterministic run audits them. The v1 SDD reducer has no legal `dispatch-mismatch` transition after `dispatch-started`; the interrupted run is therefore preserved as an inadmissible historical artifact and is not repaired by hand.

## Goal

Obtain fresh, admissible evidence for the client corrections F-1 and F-2, implement the remaining server correction F-3, obtain Chromium/CDP acceptance for the corrected client behavior, and complete independent task and Frontier final review over the complete Workspace Tasks range.

## Candidate And Ranges

- Original merge base: `5eda56bbab1c295e04623ed156039c3ddc847072`.
- Candidate client correction: `1488190065582687440f1cc3062c50e461b0ce5b`.
- Candidate range to audit: `5eda56bbab1c295e04623ed156039c3ddc847072..1488190065582687440f1cc3062c50e461b0ce5b`.
- The successor plan commit will be the run's base reference; the final reviewer must inspect the original merge base through the final remediation HEAD.

## Design

Task 1 is read-only. It independently inspects the candidate client commit and its tests, verifies F-1 source-scoped acknowledgement and F-2 nonblocking known move-error behavior, runs fresh focused verification, and performs a temporary-fixture Chromium/CDP acceptance pass. It creates only ignored artifacts beneath the new run root. It must not rely on the mismatched child's report, claimed RED/GREEN output, or rationale.

Task 2 implements F-3 with TDD. A registry-level deferred interleaving holds an owner lock after destination acknowledgement while a non-owner observes an exact-complete and an unrecognized pair. The non-owner must not invalidate the live owner's permit; the owner must settle with its exact permit. A service-level regression proves a direct writer cannot turn a completed move into `unavailable` in the publication-to-settlement window.

Each task receives an independent task review. The final Frontier review covers `5eda56bbab1c295e04623ed156039c3ddc847072..HEAD`, explicitly checks F-1, F-2, and F-3, and requires fresh browser evidence, a clean worktree, and full verification. At most one ordinary fix loop and the single final-fix wave permitted by the SDD controller may be used for newly discovered load-bearing findings.

## Safety Boundaries

- Preserve `.sdd/workspace-tasks-final-blocked-remediation`, its mismatch receipt, report, prompt, state, and progress artifacts unchanged after recording the receipt.
- Preserve all predecessor browser-review and post-mismatch run roots and their reports as historical artifacts only.
- Treat commit `1488190065582687440f1cc3062c50e461b0ce5b` as code to inspect, not as certified evidence.
- Preserve Workspace Tasks version-one schema, `<workspace>/.pi-webui/tasks.json`, route/API contracts, CAS behavior, move recovery behavior, panel draft retention, and public plugin contracts.
- Do not modify `src/plugin-api.ts`, session-daemon code or protocol, runtime ownership, `README.md`, `CHANGELOG.md`, release metadata, dependencies, or unrelated source. Do not add or edit a Changeset.
- Browser fixtures, screenshots, logs, profiles, and servers are verification-only and must be removed before completion.
- Every new child prompt is rendered and persisted before dispatch. The exact persisted bytes are compared with the child's first user message before `dispatch-started` is recorded or any report is admitted. A mismatch blocks that run; it is never diagnosed by another child.
