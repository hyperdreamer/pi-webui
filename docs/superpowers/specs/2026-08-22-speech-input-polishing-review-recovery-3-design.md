# Speech Input Polishing Review Recovery 3 Design

**Date:** 2026-08-22

## Context

The feature branch `speech-input-polishing` contains the complete Speech input polishing implementation through the committed Settings task `1d11c29`. The exact candidate range for that task is `265b97081b6b0871ccb8aa024061e2625402e8ac..1d11c29c4235d5aedcf305c2604e5c18f4abeb22`.

Two successor SDD runs have now been sealed because the assistant's manually replayed child prompt differed from the controller-persisted rendered prompt by a single word each time:

- `.sdd/speech-input-polishing-review-recovery-20260822/` is terminal at revision 10 (`DISPATCH_MISMATCH_BLOCKED`) during Task 1 review. Its audit report found `F-001`, but its task-review child was not correlated and produced no admissible report.
- `.sdd/speech-input-polishing-review-recovery-2-20260822/` is terminal at revision 6 (`DISPATCH_MISMATCH_BLOCKED`) during Task 1 implementation dispatch. Its child produced an inadmissible report, but no result was correlated.

The original `.sdd/speech-input-polishing-browser-recovery-20260822/` run is also preserved and inadmissible. None of these runs may be reopened, edited, or used as review evidence. The committed source remains unchanged; the only dirty source-adjacent path is the intentional predecessor-plan amendment `docs/superpowers/plans/2026-08-22-speech-input-polishing.md`.

## Goal

Obtain one fully admissible fresh audit/review/fix/final-review chain for the committed Settings candidate and finish the feature branch without changing protected runtime boundaries.

## Design

Create a distinct successor SDD run with one Capable read-only audit task. The controller must render the child prompt with `sdd-state render-prompt`, persist those exact bytes, and use those same bytes as the `spawn_subsession` prompt. Before recording `dispatch-started` or admitting a report, compare the child's initial user message with the stored rendered prompt byte-for-byte. If the comparison cannot be established or fails, preserve a terminal mismatch receipt and stop; do not spawn a replacement within the run.

The audit independently checks the exact candidate range and the retained-response Settings reload interlock identified by the prior inadmissible audit. A derived independent task reviewer evaluates the candidate and audit report. Confirmed load-bearing findings go through the ordinary controller-scoped fixer and re-reviewer loop; the fixer may modify only `SettingsGeneralPanel.ts` and its focused test, with a RED regression before the correction and a committed GREEN result. A Frontier final reviewer then evaluates `780c3fc1d98e2533d166f694469deccfb93008b8..HEAD` and reconciles every finding.

## Safety And Evidence Boundaries

- Preserve all three predecessor run roots and every artifact under them. Never hand-edit `state.json` or `progress.md`, and never admit their reports or child transcripts.
- Pin the candidate range and original feature merge base in the new run. Inspect source from Git, not from predecessor claims.
- Preserve `docs/superpowers/plans/2026-08-22-speech-input-polishing.md` unstaged and untouched. No audit or fixer may include it in a commit.
- The audit child is read-only. Only a controller-dispatched fixer may modify the authorized Settings component/test files for adjudicated finding IDs.
- Keep default-on omitted settings, explicit `false`, conservative polishing disclosure, gateway/session-daemon ownership, no selected-machine route, no Local provider, no persistence or sensitive logging, and no automatic prompt submission.
- Do not modify the already-committed daemon routes, transport, model service, browser speech controller, prompt editor, dependencies, README, or `CHANGELOG.md`. The final handoff must tell the user that `pi-webui-sessiond.service` needs a manual restart because the feature branch contains session-daemon changes.
