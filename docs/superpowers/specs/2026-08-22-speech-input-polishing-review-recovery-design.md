# Speech Input Polishing Review Recovery Design

**Date:** 2026-08-22

## Context

The original Speech input polishing feature is implemented on the isolated `speech-input-polishing` worktree and branch. The Settings/documentation/Changeset task is committed as `1d11c29`, with the exact candidate range `265b970..1d11c29` containing the five authorized files.

The fresh Task 2 reviewer dispatch in run `.sdd/speech-input-polishing-browser-recovery-20260822/` is inadmissible. Its stored prompt names the worktree run root, but the child transcript's initial user message names the repository-root `.sdd` paths. The child produced no report. The run's checked-in v1 reducer has no legal post-correlation `dispatch-mismatch` event, so the run remains a preserved nonterminal historical artifact at revision 20 with a recovery receipt. It is not reopened and its child claims are not evidence.

## Goal

Obtain fresh, independent evidence for the committed Settings task, repair only findings that survive that fresh review, and complete a whole-branch Frontier review without recreating the feature or modifying daemon/browser runtime boundaries.

## Candidate And Final Ranges

- Candidate Settings range: `265b97081b6b0871ccb8aa024061e2625402e8ac..1d11c29c4235d5aedcf305c2604e5c18f4abeb22`.
- Candidate files: `.changeset/speech-input-polishing.md`, `docs/config.html`, `docs/config.md`, `src/client/src/components/settings/SettingsGeneralPanel.test.ts`, and `src/client/src/components/settings/SettingsGeneralPanel.ts`.
- Original feature base for final review: `780c3fc1d98e2533d166f694469deccfb93008b8`.
- Final review must cover the original feature base through the final branch `HEAD`, including any narrowly scoped correction commit and continuation documents.

## Design

The successor deterministic run has one Capable read-only audit task. It independently inspects the exact candidate range, runs the focused Settings and related speech suites plus type, lint, Changeset, packaging, and whitespace checks, and writes a report without changing product files. The audit explicitly checks the parent-to-child loading contract: `SettingsDialog.loadConfig()` sets `loading=true` during reload while retaining the previous speech response, so `SettingsGeneralPanel` must disable the existing speech form during that interval.

A fresh task reviewer then reviews the candidate range and the audit independently. If it reports a load-bearing defect, the controller opens its ordinary scoped fix round. The fixer receives only adjudicated finding IDs, the relevant test and evidence, and the candidate file allowlist; it must add a deterministic regression before making the smallest correction and commit only the authorized Settings/test files. A fresh re-reviewer checks only that fix range and the open findings. No correction is made merely because the sealed predecessor mentioned it.

After task completion, a Frontier final reviewer checks the complete feature branch from `780c3fc` through `HEAD`, reconciles the finding ledger, reruns or verifies the required checks, and approves only with no open load-bearing findings and a clean product worktree.

## Safety And Evidence Boundaries

- Preserve the predecessor run root, `state.json`, `progress.md`, prompts, reports, mismatch event, and recovery receipt; do not hand-edit or reopen it.
- Treat the candidate commit as code to inspect, not certified evidence; treat the predecessor reviewer transcript/report as inadmissible.
- Preserve the intentional uncommitted amendment to `docs/superpowers/plans/2026-08-22-speech-input-polishing.md` throughout the successor run.
- The initial audit may not modify source, tests, package metadata, plan files, the index, or `HEAD`. Fix rounds may modify only the task's authorized Settings/test files for adjudicated findings.
- Do not modify session-daemon routes, daemon transport, model service, browser API client, SpeechInputController, PromptEditor, selected-machine behavior, README, CHANGELOG, dependencies, or release publication state.
- No session, archive, prompt history, workspace file, draft, transcript record, credential, provider response, prompt, or transcript content may be added to logs or unrelated responses.
- Every successor child prompt is rendered and persisted before dispatch. Its initial user message must match the stored prompt byte-for-byte before the controller records correlation or admits the report; any mismatch is preserved and blocks that run.
