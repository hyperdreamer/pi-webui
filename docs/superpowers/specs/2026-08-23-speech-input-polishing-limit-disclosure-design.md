# Speech Input Polishing Limit Disclosure Design

**Date:** 2026-08-23

## Context

The deterministic run `.sdd/speech-input-polishing-timeout-remediation-recovery-4-20260823/` is terminal at revision 17 in `FINAL_BLOCKED`. Its admissible Frontier report recorded one Important, load-bearing finding, `F-1`: the runtime implements bounded transcript polishing, but Settings and the paired configuration documentation do not disclose those limits consistently.

The runtime behavior is already implemented and verified: the gateway admits at most two concurrent polishing requests, the browser and route use 30-second deadlines, the utility-model provider uses a 25-second timeout with a five-second reserve, input and polished output are each bounded to 1 MiB of UTF-8 text, and polishing failures fall back to inserting the original transcript. This successor corrects only the user-facing contract and regression coverage. It does not reopen or edit the terminal run.

The intentional unstaged amendment to `docs/superpowers/plans/2026-08-22-speech-input-polishing.md` remains protected and must stay byte-for-byte unchanged and unstaged.

## Goal

Synchronize the visible Settings disclosure, `docs/config.md`, and `docs/config.html` with the implemented transcript-polishing limits and raw-transcript fallback, and add focused tests that fail if those claims disappear or drift.

## User-Facing Contract

Settings and both configuration documents must communicate all of these facts:

- the gateway accepts at most two concurrent transcript-polishing requests;
- the browser and HTTP route each use a 30-second deadline;
- the utility-model provider has 25 seconds, leaving five seconds for cancellation, cleanup, and the HTTP response;
- transcript input and polished output are each limited to 1 MiB of UTF-8 text; and
- if polishing times out or otherwise fails, PI WEBUI inserts the original transcript instead, leaving it editable and never submitting it automatically.

The canonical concise Settings copy is:

> Transcript polishing accepts at most two concurrent requests. Each request has a 30-second client and route deadline; the utility-model provider has 25 seconds, leaving five seconds for cancellation, cleanup, and the HTTP response. Input and polished output are each limited to 1 MiB of UTF-8 text. If polishing times out or fails, PI WEBUI inserts the original transcript instead.

This copy appears as a second `<small>` disclosure under the existing Transcript polishing checkbox. It adds no control, state, interaction, or layout abstraction.

## Documentation Placement

`README.md` remains unchanged. The detailed limits belong in the existing Speech input section of `docs/config.md` and `docs/config.html`.

The existing **Capture and transcription limits** heading becomes **Capture, transcription, and polishing limits** in both representations. The section gains semantically identical polishing bullets covering concurrency, the two deadlines and reserve, the 1 MiB input/output bounds, and original-transcript fallback. Existing capture and transcription bullets remain intact.

The Markdown page is part of the published npm package and the HTML page is the paired website representation, so both are user-facing and must remain synchronized.

## Test Design

Testing follows RED-GREEN without changing runtime behavior.

1. Extend the existing transcript-polishing disclosure test in `SettingsGeneralPanel.test.ts` with exact assertions for concurrency, deadlines, reserve, input/output bounds, and fallback. Run it before editing the component and confirm it fails because the disclosure is absent.
2. Add `src/speechInputPolishingDocumentation.test.ts`, following the existing repository-file documentation-test pattern. It reads `docs/config.md` and `docs/config.html`, normalizes Markdown/HTML markup and whitespace, and asserts that both contain the renamed limits heading and the same required polishing claims. Run it before editing the documents and confirm it fails for the missing claims.
3. Add only the minimum copy needed to make both focused tests pass. The tests assert user-observable text, not Lit internals or implementation structure.

The paired-document test deliberately duplicates only a short list of required contract fragments. A generated documentation source or production copy constants module would add machinery without improving this bounded correction.

## Changeset

Do not add a third Changeset. Amend the existing unreleased minor fragment `.changeset/speech-input-polishing.md` so it describes the same completed feature contract:

> Expose transcript-polishing controls with bounded request behavior, original-transcript fallback, and documented lightweight utility-model processing.

Keep `.changeset/speech-input-polishing-timeout.md` unchanged. Do not edit `CHANGELOG.md`; Changesets will generate it during release preparation.

## Scope Boundaries

The correction may modify only:

- `src/client/src/components/settings/SettingsGeneralPanel.ts`;
- `src/client/src/components/settings/SettingsGeneralPanel.test.ts`;
- `src/speechInputPolishingDocumentation.test.ts`;
- `docs/config.md`;
- `docs/config.html`; and
- `.changeset/speech-input-polishing.md`.

Do not modify speech controllers, routes, services, shared timeout constants, settings persistence, transport, daemon composition, dependencies, README, FAQ, `CHANGELOG.md`, or unrelated documentation. Do not add a copy-sharing production abstraction.

## Alternatives Considered

1. Put exact limits in Settings and both docs with focused consistency tests. Chosen because it directly satisfies `F-1` with a small, reviewable change.
2. Keep Settings generic and put numbers only in docs. Rejected because the final-review contract explicitly requires Settings and both docs to agree on limits.
3. Generate Settings and documentation from shared constants or a template. Rejected as disproportionate: the runtime constants already own behavior, while user-facing prose has different formatting needs in Lit, Markdown, and HTML.

## Verification And Review

The implementation must prove the two focused tests fail before copy changes and pass afterward. It then runs typecheck, targeted ESLint, Changesets status, staged verification, `git diff --check`, and package dry-run verification without leaving generated artifacts. A fresh task reviewer inspects the exact remediation commit. The mandatory Frontier final reviewer reviews the complete feature range from `780c3fc1d98e2533d166f694469deccfb93008b8` through the new final `HEAD` and reconciles carried finding `F-1` as fixed.

Because the complete feature includes session-daemon code, the final user handoff must still require a manual restart of `pi-webui-sessiond.service`, even though this particular correction changes only UI copy, documentation, tests, and the existing Changeset.
