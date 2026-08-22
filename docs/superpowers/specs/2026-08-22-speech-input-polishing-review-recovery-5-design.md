# Speech Input Polishing Review Recovery 5 Design

**Date:** 2026-08-22

## Context

Recovery 4 is terminal at `.sdd/speech-input-polishing-review-recovery-4-20260822/` in `DISPATCH_MISMATCH_BLOCKED` revision 15. Its Frontier re-review child `01a02a7c-8b6f-7ac8-8ec3-338be2377116` received prompt bytes that differed from the persisted intent: the Dispatch Context used a repository-root report path and a duplicated package path. The child encountered `ENOENT`; its out-of-tree report and `APPROVED` token are inadmissible. Recovery 4's state, progress, prompts, receipts, reports, and mismatch evidence must remain unchanged.

The source correction commit was created before that mismatch and is independently verifiable in Git. `eaedc2906659a2ca5a53165d8fcc3c090d0bcbec` changes only the four authorized Settings source/test files relative to `23d49cb829f510fcd252fc5192612479df0081fb`. The intentional unstaged amendment to `docs/superpowers/plans/2026-08-22-speech-input-polishing.md` remains protected and is not part of the candidate.

## Goal

Obtain an admissible, fresh audit, independent task review, and mandatory final review for the already committed Settings candidate without creating a worktree, reverting the valid correction, or relying on any predecessor report or transcript.

## Design

Create a fifth distinct SDD run in the existing `speech-input-polishing` worktree. Its single Capable task is a read-only audit of the exact current candidate range `265b97081b6b0871ccb8aa024061e2625402e8ac..eaedc2906659a2ca5a53165d8fcc3c090d0bcbec`, including the committed readiness correction. The audit makes no source commit. The controller then dispatches a fresh independent task reviewer over that exact range. If the reviewer identifies an adjudicated defect, only a controller-dispatched fixer may change the permitted Settings files; otherwise the task proceeds to the required Frontier final review over `780c3fc1d98e2533d166f694469deccfb93008b8..HEAD`.

Every child receives a short persisted relay envelope generated from the canonical renderer. The complete payload, brief, and rendered bytes live under this run root. The returned session is recorded immediately, and the completed child's first user message must match the stored rendered bytes byte-for-byte before `dispatch-started` or report admission. A mismatch is sealed as terminal; no prompt is re-rendered and no mismatched result is adopted.

## Safety And Evidence Boundaries

- Preserve all predecessor roots: browser recovery, review recovery 1, 2, 3, and terminal recovery 4. Their reports, findings, transcripts, and state are inadmissible.
- Treat Git commits and fresh source inspection as authority. The valid correction commit is carried forward; do not recreate its RED/GREEN cycle or revert it merely to manufacture a new commit.
- Keep the original plan amendment unstaged and outside every audit, review, and correction allowlist.
- Correction files remain limited to `SettingsGeneralPanel.ts`, its focused test, and, only when genuinely needed for typed readiness propagation, `SettingsDialog.ts` and `SettingsDialog.general.test.ts`.
- Preserve default-on omitted settings, explicit `false`, accessible checkbox wiring, revision and credential semantics, gateway/session-daemon ownership, selected-machine independence, no Local provider, no persistence, no sensitive logging, no automatic prompt submission, and the visible operational disclosures.
- Do not modify daemon routes, transport, model service, browser speech controller, prompt editor, dependencies, README, or `CHANGELOG.md`.
- The final handoff must tell the user that `pi-webui-sessiond.service` needs a manual restart because the feature includes session-daemon changes.
