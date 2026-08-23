# Speech Input Polishing Timeout Remediation Recovery 3

**Date:** 2026-08-23

## Context

The timeout-remediation recovery-2 run is terminal at `.sdd/speech-input-polishing-timeout-remediation-recovery-2-20260823/` in `DISPATCH_MISMATCH_BLOCKED`. Its child `01a02be1-e954-7b57-bcf3-8988ce5f02dd` received a prompt whose `reportPath` omitted the worktree component. Its report, status token, and all child claims are inadmissible and remain sealed as historical evidence.

The committed correction is `d67ef99c18b7b3e095e928b123cd35b2e1891635`, which addresses final-review finding `F-001`: the speech-polishing provider call lacked an explicit timeout below the 30-second route deadline. The correction is durable Git evidence and must be audited independently. The intentional unstaged amendment to `docs/superpowers/plans/2026-08-22-speech-input-polishing.md` remains protected.

## Goal

Obtain an admissible fresh source-and-Git audit, independent task review, and Frontier final review for the speech-input polishing feature and committed provider-timeout correction without reopening any terminal run, changing product code, or creating a new worktree.

## Scope

The successor run is read-only at its implementation task. It audits:

- the complete feature range `780c3fc1d98e2533d166f694469deccfb93008b8..HEAD`;
- the exact six-file timeout correction commit `d67ef99c18b7b3e095e928b123cd35b2e1891635` (`d67ef99^..d67ef99`);
- the inherited `F-001` behavior and fresh regression tests; and
- the protected dirty plan amendment and session-daemon restart boundary.

No product file, test, Changeset, documentation, plan, index, branch, or `HEAD` may be modified by the audit child. All previous SDD roots, reports, prompts, transcripts, receipts, and findings remain historical evidence only. If fresh review finds a real defect, the controller must open a separately scoped remediation plan rather than allowing this run to edit code.

## Design

A single Capable implementer performs a fresh read-only audit from current Git and source. It verifies that `src/shared/speechInputPolishing.ts` owns the `30_000` route and `25_000` model budgets, that the route imports and re-exports the route budget, that the service passes the model budget alongside its existing signal/retry/cache/token options, and that regression tests observe the five-second margin. It also checks the existing client, Settings, daemon, transport, persistence, security, and documentation boundaries so independent reviewers receive complete evidence.

The controller persists one minimal exact prompt, compares the child’s first user message byte-for-byte before correlation, admits no mismatched report, and then dispatches independent task and Frontier final reviewers. Any new prompt mismatch is terminal and preserved; it is never repaired in place or adopted after the fact.

## Alternatives Considered

1. Reopen recovery-2 and admit its child report. Rejected because terminal runs accept no continuation and the child prompt was byte-mismatched.
2. Recreate the timeout correction in a new implementation task. Rejected because the correction already exists as a committed, independently inspectable Git change.
3. Audit the committed tree in a fresh successor run, then review it independently. Chosen because it restores admissible review evidence without mutating the candidate.

## Verification

The audit must run focused and broader speech-input tests, typecheck, scoped lint, Changeset status, package dry-run, staged validation, and diff checks. It must verify no generated `dist` or `CHANGELOG.md` changes and preserve the protected plan amendment. Task review and Frontier final review must inspect the exact pinned ranges independently and use the deterministic schemas.

Because `src/server/speechInput/speechInputPolishingService.ts` is loaded by the long-lived session daemon, the final handoff must explicitly require a manual restart of `pi-webui-sessiond.service`.
