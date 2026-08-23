# Speech Input Polishing Timeout Remediation Recovery 4

**Date:** 2026-08-23

## Context

The prior timeout-remediation recovery runs are terminal historical evidence. Recovery 3 reached `TASK_BLOCKED` after its correctly correlated child completed verification but stopped without writing its required report or returning a terminal status. No product source was changed by that run. The original timeout-remediation run and recovery 2 were terminal after prompt-byte mismatches and are inadmissible.

The durable product correction is commit `d67ef99c18b7b3e095e928b123cd35b2e1891635`. It addresses final-review finding F-001 by adding a provider timeout below the route deadline. The intentional unstaged amendment to `docs/superpowers/plans/2026-08-22-speech-input-polishing.md` remains protected.

## Goal

Obtain a fresh admissible audit and independent review of the exact timeout correction, followed by the mandatory Frontier final review of the complete speech-input polishing feature, without modifying product code or creating a new worktree.

## Scope

The implementation task is a finite, read-only audit of the exact six-file correction commit and focused regression tests. It does not edit source or rely on any predecessor report. The derived task reviewer and mandatory Frontier final reviewer inspect the exact Git ranges independently; the final reviewer additionally checks the complete feature's client, Settings, daemon, transport, persistence, security, documentation, and Changeset boundaries.

No product file, test, Changeset, documentation, plan, index, branch, `HEAD`, or generated artifact may be modified by the audit child. If review finds a real defect, the controller opens a separately scoped remediation plan rather than allowing this run to edit code.

## Design

One Advanced implementer audits only the correction's six files: shared timeout constants, service options, route binding, regression assertions, and timeout Changeset. It runs the focused service/route tests, typecheck, scoped lint, Changeset status, and diff checks, then writes one bounded report immediately. The task reviewer independently checks the same evidence and can report findings without treating the implementer report as authority. The mandatory Frontier final reviewer audits the whole feature range before completion.

Dispatch prompts use a short persisted relay envelope that points to a complete persisted payload using worktree-relative paths. The controller compares the child’s initial message bytes with that exact envelope before recording correlation. Previous terminal roots remain sealed and are never reopened.

## Verification

The run must preserve the protected dirty plan amendment, prove the exact parent-to-`d67ef99` diff has six paths, prove `25_000 < 30_000`, run the focused tests and static checks, and leave no generated `dist` or `CHANGELOG.md` changes. Task and final reviews must report the deterministic `SPEC` and `QUALITY` axes. The final handoff must require a manual `pi-webui-sessiond.service` restart because the service is loaded by the long-lived session daemon.
