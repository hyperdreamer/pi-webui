# Speech Input Polishing Timeout Remediation Recovery 2

**Date:** 2026-08-23

## Context

The first timeout-remediation run is terminal at `.sdd/speech-input-polishing-timeout-remediation-20260823/` in `DISPATCH_MISMATCH_BLOCKED`. Its implementer child received a prompt with one extra leading space in the role contract. The child report and all child claims are inadmissible. The child nevertheless created Git commit `d67ef99c18b7b3e095e928b123cd35b2e1891635`, which is preserved as uncorrelated Git evidence and must be checked independently rather than recreated or trusted through the child report.

The correction addresses final-review finding `F-001`: the speech-polishing provider call lacked an explicit timeout below the 30-second route deadline. The current branch also contains the original speech-input polishing feature and its historical recovery documentation. The intentional unstaged amendment to `docs/superpowers/plans/2026-08-22-speech-input-polishing.md` remains protected.

## Goal

Obtain an admissible, fresh source-and-Git audit, task review, and Frontier final review for the speech-input polishing feature including the timeout correction, without reopening the terminal predecessor, changing product code, or creating a new worktree.

## Scope

The successor run is read-only at its implementation task. It audits:

- the complete feature range `780c3fc1d98e2533d166f694469deccfb93008b8..HEAD`;
- the timeout correction commit `d67ef99c18b7b3e095e928b123cd35b2e1891635` and its six-file product diff;
- the inherited `F-001` behavior and its regression tests; and
- the protected dirty plan amendment and daemon-restart boundary.

No product file, test, Changeset, documentation, plan, index, branch, or `HEAD` may be modified by the audit child. The existing terminal run and all predecessor SDD artifacts remain historical evidence only. If fresh review finds a real defect, the controller must open a new explicitly scoped remediation plan rather than allowing this read-only run to edit code.

## Design

A single Capable implementer performs a fresh read-only audit from Git and current source. It does not use the mismatched child's report, transcript, or status as correctness evidence. It verifies that the shared module owns `30_000` and `25_000` budgets, that the route imports and re-exports the route budget, that the service passes the model budget alongside the existing signal/retry/cache/token options, and that tests would fail if the timeout wiring regressed. It also checks the full speech-input feature's existing route, daemon, client, Settings, persistence, security, and documentation boundaries so the final reviewer receives a complete evidence package.

The controller records the child session only after comparing its first user message byte-for-byte with the persisted rendered prompt. It then admits the report, dispatches an independent task reviewer, and proceeds to the mandatory Frontier final reviewer only when the task review passes. Any prompt mismatch terminates this successor run; it is never repaired in place or correlated after the fact.

## Alternatives Considered

1. Reopen the terminal timeout-remediation run and admit the existing report. Rejected because terminal runs accept no continuation event and the prompt mismatch invalidates the child evidence.
2. Recreate the timeout fix in a new implementation dispatch. Rejected because it would duplicate an already committed correction and obscure whether the current Git tree is correct.
3. Audit the committed tree in a fresh successor run, then review it independently. Chosen because Git provides durable source evidence while the fresh run restores the required independent review chain without mutating the candidate.

## Verification

The audit must run the focused speech-polishing service and route tests, the broader speech-input tests relevant to the feature, typecheck, scoped lint, Changeset status, package dry-run, staged validation, and diff checks. It must confirm that the only pre-existing dirty path is the protected plan amendment and that no generated `dist` or `CHANGELOG.md` change remains. The task reviewer and Frontier final reviewer must inspect the exact pinned ranges themselves and report findings using the deterministic schemas.

Because `src/server/speechInput/speechInputPolishingService.ts` is loaded by the long-lived session daemon, the final handoff must explicitly require a manual restart of `pi-webui-sessiond.service`.
