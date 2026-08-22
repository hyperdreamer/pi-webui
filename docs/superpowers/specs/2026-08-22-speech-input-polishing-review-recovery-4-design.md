# Speech Input Polishing Review Recovery 4 Design

**Date:** 2026-08-22

## Context

The third successor run is preserved at `.sdd/speech-input-polishing-review-recovery-3-20260822/`. Its Capable audit child `01a02a01-d9f6-7317-8402-e93fc8db7f45` received a prompt that differed from the persisted rendered prompt after correlation (`the report path it was given` versus `the report path in Dispatch Context`). The child report and every claim are inadmissible. The checked-in v1 reducer only accepts `dispatch-mismatch` during a dispatch-intent phase, so the mismatch could not be sealed after `dispatch-started`; revision 7 records a recovery ruling and leaves the run as preserved historical evidence in `IMPLEMENT_RUNNING`.

The source candidate remains unchanged. The exact Settings candidate range is `265b97081b6b0871ccb8aa024061e2625402e8ac..1d11c29c4235d5aedcf305c2604e5c18f4abeb22`. The only working-tree source-adjacent change is the intentional amendment to `docs/superpowers/plans/2026-08-22-speech-input-polishing.md`.

## Goal

Obtain one admissible independent audit, review, correction, and final-review chain for the committed Settings candidate without reopening or relying on any predecessor run.

## Design

Create a fourth distinct SDD run in the existing `speech-input-polishing` worktree. Its first task is a Capable read-only audit of the exact candidate range. The task brief contains the complete role requirements and the successor run's global constraints; it must not use any predecessor report or transcript.

To make dispatch correlation mechanical, each child receives a short persisted relay envelope. The run root stores a relay payload containing the canonical role contract and task brief, plus a deterministic renderer template that tells the child to read that payload. The parent renders the short envelope from the canonical prompt-renderer function, stores the exact bytes in the dispatch intent, and passes those same bytes to `spawn_subsession`. The child transcript is compared byte-for-byte with the stored envelope before `dispatch-started` is recorded or any report is admitted. A mismatch remains terminal in the intent phase.

After the audit, the controller performs the ordinary independent task review, any finding-scoped fixer and re-reviewer rounds, and a Frontier final review over the complete branch from merge base. Only a controller-dispatched fixer may modify the authorized Settings component/test files for adjudicated findings.

## Safety And Evidence Boundaries

- Preserve all predecessor run roots, including the nonterminal recovery-3 root, and never hand-edit their state or progress files.
- Treat Git commits and current source inspection as authority; predecessor reports, transcripts, and findings are inadmissible.
- Keep the original plan amendment unstaged and outside every correction.
- Do not change daemon routes, transport, model service, browser speech controller, prompt editor, dependencies, README, or `CHANGELOG.md`.
- Retain default-on omitted settings, explicit `false`, gateway/session-daemon ownership, no selected-machine route, no Local provider, no persistence or sensitive logging, and no automatic prompt submission.
- The final handoff must tell the user that `pi-webui-sessiond.service` needs a manual restart because the feature includes session-daemon changes.
