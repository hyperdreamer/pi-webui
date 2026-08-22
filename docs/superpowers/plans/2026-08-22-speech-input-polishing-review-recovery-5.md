# Speech Input Polishing Review Recovery 5 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Establish a fresh admissible audit and review chain for the committed Speech input Settings candidate after recovery 4 was terminally invalidated by a prompt-byte mismatch.

**Architecture:** Start with a no-source-change Capable audit of the exact current candidate range, then use independent task-review, finding-scoped correction/re-review when required, and a mandatory Frontier final-review gate. Each dispatch uses a persisted relay payload and an exact rendered envelope; correlation is required before any report enters canonical state.

**Tech Stack:** TypeScript, Lit, Vitest, npm, Git, deterministic SDD state machine, raw tracked-subsession dispatch.

## Global Constraints

- Preserve `.sdd/speech-input-polishing-browser-recovery-20260822/`, `.sdd/speech-input-polishing-review-recovery-20260822/`, `.sdd/speech-input-polishing-review-recovery-2-20260822/`, `.sdd/speech-input-polishing-review-recovery-3-20260822/`, and `.sdd/speech-input-polishing-review-recovery-4-20260822/` as historical evidence only. Do not hand-edit their state, progress, prompts, reports, receipts, transcripts, or findings. The recovery-4 re-review child `01a02a7c-8b6f-7ac8-8ec3-338be2377116` received mismatched prompt bytes and its report/token are inadmissible.
- The original Settings candidate is `265b97081b6b0871ccb8aa024061e2625402e8ac..1d11c29c4235d5aedcf305c2604e5c18f4abeb22`. The valid committed correction is `eaedc2906659a2ca5a53165d8fcc3c090d0bcbec`, based on `23d49cb829f510fcd252fc5192612479df0081fb`. Audit the complete carried-forward source range `265b97081b6b0871ccb8aa024061e2625402e8ac..eaedc2906659a2ca5a53165d8fcc3c090d0bcbec` from Git; do not recreate or revert the correction.
- The candidate plus correction changes only these four product files in the relevant source range: `src/client/src/components/settings/SettingsGeneralPanel.ts`, `src/client/src/components/settings/SettingsGeneralPanel.test.ts`, `src/client/src/components/SettingsDialog.ts`, and `src/client/src/components/SettingsDialog.general.test.ts`, along with the original candidate's docs/Changeset files. Any later correction must remain within the four permitted Settings files.
- Preserve the intentional unstaged amendment to `docs/superpowers/plans/2026-08-22-speech-input-polishing.md`; it is outside every audit and correction allowlist. Do not stage, overwrite, stash, reset, or commit it.
- The initial audit child is strictly read-only and must create no product commit. Only a controller-dispatched fixer may modify the four permitted Settings files, and only for adjudicated finding IDs.
- Preserve default-on behavior when the preference is omitted, explicit `false`, accessible checkbox wiring, revision and credential mutation semantics, gateway/session-daemon ownership, selected-machine independence, no Local provider, no session/archive/history/workspace/draft/transcript persistence, no sensitive logging, and no automatic prompt submission.
- Do not modify daemon routes, transport, model service, browser speech controller, prompt editor, dependencies, README, or `CHANGELOG.md`.
- Before every dispatch, persist the rendered prompt and compare the child transcript's first user message byte-for-byte before recording `dispatch-started` or admitting a report. A mismatch is terminal and must never be reissued or adopted in this run.
- The final response must tell the user that `pi-webui-sessiond.service` needs a manual restart because this feature includes session-daemon changes.

## Scope Check

This run has one audit task. The controller derives the independent task review, any scoped fix/re-review rounds, and the mandatory Frontier final review.

## Task 1: Audit The Committed Settings Candidate After Correction

**Implementer tier:** Capable

### Files

- Inspect: `src/client/src/components/settings/SettingsGeneralPanel.ts`
- Inspect: `src/client/src/components/settings/SettingsGeneralPanel.test.ts`
- Inspect: `src/client/src/components/SettingsDialog.ts`
- Inspect: `src/client/src/components/SettingsDialog.general.test.ts`
- Inspect: `src/client/src/components/settings/settingsConfigDraft.ts`
- Inspect: `docs/config.md`
- Inspect: `docs/config.html`
- Inspect: `.changeset/speech-input-polishing.md`
- Test: `src/client/src/components/settings/SettingsGeneralPanel.test.ts`
- Test: `src/client/src/components/settings/settingsConfigDraft.test.ts`
- Test: `src/client/src/components/SettingsDialog.general.test.ts`
- Test: `src/client/src/controllers/speechInputController.test.ts`
- Test: `src/server/speechInput/speechInputPolishingService.test.ts`
- Test: `src/server/speechInput/speechInputPolishingRoutes.test.ts`
- Test: `src/server/app.speechInput.test.ts`
- Test: `src/server/sessiond/sessionProxyRoutes.test.ts`
- Test: `src/sessiond/sessionDaemonClient.test.ts`
- Test: `src/server/speechInput/speechInputSettingsRoutes.test.ts`

### Interfaces

- Consumes: the current Git range `265b97081b6b0871ccb8aa024061e2625402e8ac..eaedc2906659a2ca5a53165d8fcc3c090d0bcbec`; the Settings dialog readiness signal; speech draft conversion helpers; and repository testing, architecture, documentation, and Changesets guidance.
- Produces: exactly one read-only audit report at the controller-provided path, with exact scope, every requirement finding, and actual verification outcomes; no product commit or source change.

### Step 1: Establish the evidence boundary

Read this plan's Global Constraints and the applicable repository guidance. Do not use any predecessor report, transcript, or out-of-tree child report as correctness evidence. Run:

```bash
git status --short --untracked-files=all
git diff --name-status 265b97081b6b0871ccb8aa024061e2625402e8ac eaedc2906659a2ca5a53165d8fcc3c090d0bcbec
git diff --check 265b97081b6b0871ccb8aa024061e2625402e8ac eaedc2906659a2ca5a53165d8fcc3c090d0bcbec
git diff --check 265b97081b6b0871ccb8aa024061e2625402e8ac eaedc2906659a2ca5a53165d8fcc3c090d0bcbec -- src/client/src/components/settings/SettingsGeneralPanel.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts src/client/src/components/SettingsDialog.ts src/client/src/components/SettingsDialog.general.test.ts
```

Confirm the source range and current `HEAD` independently. The protected plan amendment is the only expected dirty source-adjacent path. Do not stage, commit, stash, check out, or edit product, plan, or SDD artifacts.

### Step 2: Audit observable Settings behavior

Read the current panel, dialog loading/save lifecycle, draft conversion, focused tests, configuration documents, and Changeset. Verify all of the following:

- The checkbox is in the Speech input card, has an accessible label, defaults checked when omitted or legacy, and is unchecked for explicit `false`.
- Its change handler stores a real boolean and a full save sends an explicit boolean while preserving revision and credential mutation semantics.
- The checkbox, sibling speech controls, save, and credential-clear actions are disabled during saving, stale, unavailable, insecure, and parent gateway Settings loading.
- A retained-response reload is inert: parent `loading` and typed speech readiness become unavailable/loading before a deferred reload resolves, stale or failed responses cannot restore readiness, and a newer app-owned response can restore only its own current revision.
- Direct save and credential-clear guards return before reading retained credential input or requesting confirmation when readiness is not current and usable.
- Stale revision, secure-context, password retention, credential clearing, reload, selected-machine targeting, and successful-save cleanup remain intact.
- The visible Speech input card retains the lightweight utility-model/provider disclosure and states gateway/session-daemon-local scope, selected-machine independence, no Pi session, no transcript/prompt persistence, no automatic submission/queue/steer/start behavior, sensitive-data exclusion from logs/errors, and manual `pi-webui-sessiond.service` restart guidance. Configuration documents remain coherent.
- The Changeset names `@hyperdreamer/pi-webui`, requests a `minor` release, and has valid concise frontmatter. README and CHANGELOG remain untouched.

Record every defect with exact file/line evidence. Do not fix defects in this read-only task.

### Step 3: Run read-only verification

Use a temporary directory outside the repository when needed. Record actual outcomes for focused Settings tests, the broader speech-input test set, typecheck, scoped ESLint, `npm run changelog:status`, `npm run pack:dry`, `npm run verify:staged`, and Git diff checks. Separate environment-only Vite, storage, or dependency-layout failures from source defects, and do not leave product artifacts.

Suggested commands:

```bash
TMPDIR=/data/home/guest/tmp/pi-webui-speech-review npm test -- --run src/client/src/components/settings/SettingsGeneralPanel.test.ts src/client/src/components/settings/settingsConfigDraft.test.ts src/client/src/components/SettingsDialog.general.test.ts
TMPDIR=/data/home/guest/tmp/pi-webui-speech-review npm test -- --run src/client/src/controllers/speechInputController.test.ts src/server/speechInput/speechInputPolishingService.test.ts src/server/speechInput/speechInputPolishingRoutes.test.ts src/server/app.speechInput.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/sessiond/sessionDaemonClient.test.ts src/server/speechInput/speechInputSettingsRoutes.test.ts
TMPDIR=/data/home/guest/tmp/pi-webui-speech-review npm run typecheck
TMPDIR=/data/home/guest/tmp/pi-webui-speech-review npx eslint src/client/src/components/settings/SettingsGeneralPanel.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts src/client/src/components/SettingsDialog.ts src/client/src/components/SettingsDialog.general.test.ts
npm run changelog:status
npm run pack:dry
npm run verify:staged
git diff --check 265b97081b6b0871ccb8aa024061e2625402e8ac eaedc2906659a2ca5a53165d8fcc3c090d0bcbec
git diff --check
```

### Step 4: Write exactly one report

Write exactly one report at the controller-provided report path. Use `STATUS: DONE` when the audit completed, even when findings exist. Include the exact carried-forward range, scope result, every requirement finding, actual command outcomes, and an explicit statement that no source files, tests, package metadata, plan files, index, or `HEAD` were modified and no commit was created. Do not write any other deliverable.

### Step 5: Defer correction and approval to the controller

The controller must independently review this exact current range. If it confirms a load-bearing finding, it must open the normal scoped fixer and a fresh re-reviewer. After task approval it must dispatch a Frontier final reviewer over `780c3fc1d98e2533d166f694469deccfb93008b8..HEAD`, reconcile all findings, verify the protected plan amendment and product tree, and complete only with final `SPEC: PASS` and `QUALITY: APPROVED`.
