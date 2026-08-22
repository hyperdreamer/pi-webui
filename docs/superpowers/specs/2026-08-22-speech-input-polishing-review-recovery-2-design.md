# Speech Input Polishing Review Recovery 2 Design

**Date:** 2026-08-22

## Context

The Speech input polishing feature is implemented on the isolated `speech-input-polishing` branch. The candidate Settings/documentation/Changeset task is the exact committed range `265b97081b6b0871ccb8aa024061e2625402e8ac..1d11c29c4235d5aedcf305c2604e5c18f4abeb22`.

The first successor run, `.sdd/speech-input-polishing-review-recovery-20260822/`, completed a fresh read-only audit and found `F-001`: `SettingsGeneralPanel` does not include the parent `SettingsDialog.loading` state in its shared speech-control disabled expression or mutation guards while a retained speech response remains visible during gateway reload. Its task-review dispatch then became inadmissible before correlation because the manually replayed child prompt differed from the persisted rendered prompt in one forbidden-token example. The run is terminal at revision 10 in `DISPATCH_MISMATCH_BLOCKED`; its state, progress, prompts, reports, receipt, and child transcript remain historical evidence only. The child produced no admissible review report.

The earlier predecessor run `.sdd/speech-input-polishing-browser-recovery-20260822/` is also sealed and inadmissible for the same class of prompt-path mismatch. No source change is needed to recreate either finding; a fresh audit must verify the committed candidate directly.

## Goal

Obtain an admissible independent review of the exact committed Settings candidate, apply only adjudicated load-bearing corrections through the normal deterministic fix loop, and complete the mandatory Frontier review of the whole feature branch.

## Design

Create a distinct successor SDD run with one Capable read-only audit task. The audit reviews the exact candidate Git range, independently verifies the retained-response reload defect and every Settings/documentation/Changeset requirement, runs the permitted checks, and writes a report without changing product files. The task reviewer is derived by the controller at Frontier tier and reviews the same exact range independently.

If the task reviewer confirms a load-bearing finding, the controller opens the ordinary scoped fixer and re-reviewer rounds. A fixer may edit only the adjudicated Settings component and its focused test, must demonstrate the regression in a RED run before the production correction, and must commit the correction. The final Frontier reviewer then checks the complete feature branch from `780c3fc1d98e2533d166f694469deccfb93008b8` through `HEAD`, including the correction and recovery documents, while preserving all protected runtime boundaries.

Every successor prompt is rendered by the controller and persisted before spawn. The exact rendered bytes must be passed to the child without manual transcription; the returned session is recorded immediately, and the child's initial prompt must match the persisted bytes before any result is correlated or admitted.

## Safety And Evidence Boundaries

- Preserve both terminal predecessor run roots and never edit their `state.json`, `progress.md`, prompts, reports, or mismatch receipts.
- Treat the exact Git commits and fresh source inspection as authority; treat all blocked-run reports and child claims as inadmissible review evidence.
- Preserve the intentional uncommitted amendment to `docs/superpowers/plans/2026-08-22-speech-input-polishing.md`; it remains unstaged and outside the product correction allowlist.
- The initial audit is read-only. Only a controller-dispatched fixer may modify the authorized Settings files for adjudicated finding IDs.
- The checkbox remains default-on when omitted, preserves explicit `false`, discloses transfer to the configured lightweight utility model, and remains gateway/session-daemon scoped regardless of selected coding machine.
- Do not add a Local speech provider, selected-machine polishing route, session/archive/history/workspace/draft/transcript persistence, credential/provider/prompt/transcript logging, dependency, README, or `CHANGELOG.md` change.
- Do not modify the already-committed daemon route, transport, model service, browser speech controller, prompt editor, or any unrelated feature. A daemon restart notice remains required because the feature branch includes daemon changes, even though this continuation should not modify them.
