# Speech Input Polishing Browser Recovery Design

**Date:** 2026-08-22

## Purpose

Continue the Speech Input transcript-polishing feature after the continuation SDD run became terminal in `DISPATCH_MISMATCH_BLOCKED` while dispatching the browser-controller task. The child produced a committed browser integration at `207f8cc47c1f98945ea2f93fb763e1f92a70b962`, but its prompt bytes differed from the persisted renderer output, so that child's report and verdict are not admissible correctness evidence.

The fresh run must independently audit the exact browser commit range from Git, obtain a fresh task review, and then complete the remaining user-facing Settings, configuration documentation, and Changeset work.

## Sealed run

Preserve `.sdd/speech-input-polishing-recovery-20260822/` unchanged after recording its terminal mismatch transition. Do not use its Task 3 child report or verdict as evidence. The mismatched child transcript may establish only the prompt-byte divergence; the committed source remains inspectable through Git.

## Candidate source range

- Feature base before the browser task: `a8acf115e26779699db608b1f9d2111c56f785fb`.
- Browser integration candidate: `a8acf115e26779699db608b1f9d2111c56f785fb..207f8cc47c1f98945ea2f93fb763e1f92a70b962`.
- Complete carried-forward candidate after the browser task: `780c3fc1d98e2533d166f694469deccfb93008b8..207f8cc47c1f98945ea2f93fb763e1f92a70b962`.

The first fresh task is read-only. It independently verifies the exact browser API/controller/editor range, its tests and protected paths, and its current worktree scope. It makes no product source change and creates no commit.

## Remaining implementation

After the browser audit is independently reviewed, implement the remaining feature in one bounded task:

1. Expose the persistent default-on transcript-polishing preference in Settings General, keep the lightweight-model disclosure accurate, synchronize `docs/config.md` and `docs/config.html`, and add the minor user-facing Changeset.

The existing committed service, routes, transport, and browser controller remain the owners of their respective boundaries. The Settings task must consume their contracts without changing them.

## Contracts to preserve

- `polishVoiceInput` is default-on when omitted and explicit `false` survives persistence and omitted updates.
- Browser and Cloud final transcripts share the controller polishing path; no Local provider or selected-machine polishing route exists.
- The browser sends application-relative `api/speech-input/polish`; the gateway owns the browser route and the local session daemon owns the authenticated model call.
- Successful polishing inserts the returned bounded plain text. A genuine current polish failure falls back to raw insertion and shows `Voice input polishing failed; inserted the raw transcript.` only when raw insertion succeeds.
- Polishing never creates sessions, archives, prompt history, workspace files, drafts, transcript records, or automatic prompt submissions.
- Errors, logs, telemetry, persistence, and unrelated responses do not expose transcript text, polished text, prompts, provider bodies, credential sources, or resolved credentials.
- The Settings disclosure must state that enabling polishing sends captured transcript text to the configured lightweight utility model for conservative cleanup and must not claim the model is local or selected-machine scoped.
- Configuration documentation belongs in `docs/config.md` and `docs/config.html`; do not expand `README.md`.
- A user-visible feature requires a `.changeset/speech-input-polishing.md` fragment for `@hyperdreamer/pi-webui` with a minor bump. Do not edit `CHANGELOG.md`.

## Verification boundary

Every fresh child receives the exact persisted renderer output and its first user message is compared byte-for-byte before its report is admitted. The fresh continuation must independently review every task and run a final Frontier review across the feature-base range. Completion requires no open load-bearing finding, valid Changeset/package state, clean source state apart from the intentionally preserved predecessor-plan amendment, and `state.json` audit status `OK`.
