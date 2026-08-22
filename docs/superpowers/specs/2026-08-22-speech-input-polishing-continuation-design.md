# Speech Input Transcript Polishing Continuation Design

**Date:** 2026-08-22

## Purpose

Continue the Speech Input transcript-polishing feature after the original deterministic SDD run became terminal in `DISPATCH_MISMATCH_BLOCKED`. The original source commits remain on the isolated feature branch, but the mismatched task-review child is not admissible evidence. A fresh run must independently audit the committed settings and daemon work before implementing the remaining transport, controller, and UI boundaries.

## Sealed predecessor

The predecessor run is preserved at `.sdd/speech-input-polishing-relocated-20260822/`. Its state, progress ledger, prompts, reports, receipts, and mismatch ruling are historical artifacts and must not be edited or used as correctness evidence. The mismatch was caused by a spawned reviewer receiving prompt bytes different from the stored rendered prompt. The candidate source itself remains inspectable through Git.

## Candidate source ranges

- Feature base: `780c3fc1d98e2533d166f694469deccfb93008b8`.
- Settings contract candidate: `780c3fc1d98e2533d166f694469deccfb93008b8..b8be7851c438eea2911346c1cc355ceb7e9582e7`.
- Daemon service candidate: `b8be7851c438eea2911346c1cc355ceb7e9582e7..1885278e65eadc0f5c4a0f72cb1483fd8ef5cc40`.
- Complete carried-forward candidate: `780c3fc1d98e2533d166f694469deccfb93008b8..1885278e65eadc0f5c4a0f72cb1483fd8ef5cc40`.

The first continuation task is read-only. It independently verifies these exact ranges, the persisted setting behavior, the service result contract, daemon composition, tests, typecheck, lint, and protected-path scope. No source change is authorized in that task.

## Remaining implementation

After the audit task is independently reviewed, implement the remaining feature in three bounded tasks:

1. Add the gateway-only and session-daemon polish routes, strict bounded request/response parsing, two-request admission, no-store responses, 30-second deadlines, and signal-aware Unix/TCP/gateway proxy cancellation. Do not expose a selected-machine polishing route.
2. Add the browser API client and SpeechInputController polish phase for Browser and Cloud final transcripts, with active-run settings snapshots, stale-generation cancellation, successful polished insertion, disabled direct insertion, and outcome-aware raw fallback.
3. Add the Settings checkbox and disclosure, synchronize configuration documentation, add the minor Changeset, and run final verification.

The gateway owns the browser-facing request. The local session daemon owns the authenticated lightweight model call. No selected remote coding machine, active Pi session, session archive, prompt history, workspace file, draft, or transcript record participates in polishing.

## Contracts

- `polishVoiceInput` is default-on when omitted and explicit `false` is preserved.
- The browser sends `{ text }` to application-relative `api/speech-input/polish`; the successful response returns only the polished text required for insertion.
- Errors, logs, telemetry, unrelated responses, and persistence must not contain transcript text, polished text, prompts, provider bodies, credential sources, or resolved credentials.
- The exact fallback message is `Voice input polishing failed; inserted the raw transcript.` and is shown only when raw insertion reports `inserted` after a genuine polish failure.
- The controller never submits a prompt automatically.
- Service/model failures remain safe typed failures; cancellation is distinguishable and suppresses stale editor mutation.

## Verification boundary

Every continuation child receives the exact persisted renderer output and its first message is compared byte-for-byte before its report is admitted. The continuation must reach a fresh independent task-review approval for every task and a Frontier final review across the feature-base range. Completion requires no open load-bearing finding, a clean worktree apart from explicitly preserved historical artifacts outside the feature worktree's source, and `state.json` audit status `OK`.
