# Speech Input Polishing Review Recovery 2 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Establish admissible independent review of the committed Settings candidate, repair only adjudicated defects, and complete whole-branch review.

**Architecture:** A fresh read-only audit reviews the exact candidate range after two predecessor runs became terminal because manually replayed child prompts did not match persisted rendered prompts. The controller's normal task-review, scoped-fix, re-review, and final Frontier-review stages provide the only correction and approval path.

**Tech Stack:** Git, deterministic SDD state machine, Vitest, TypeScript, ESLint, Changesets, npm packaging, Lit Settings components.

## Global Constraints

- The runs `.sdd/speech-input-polishing-browser-recovery-20260822/` and `.sdd/speech-input-polishing-review-recovery-20260822/` remain historical evidence only; their reports, child transcripts, and findings are inadmissible.
- The exact Settings candidate range is `265b97081b6b0871ccb8aa024061e2625402e8ac..1d11c29c4235d5aedcf305c2604e5c18f4abeb22`; inspect it from Git rather than trusting either predecessor run.
- The candidate range contains exactly `.changeset/speech-input-polishing.md`, `docs/config.html`, `docs/config.md`, `src/client/src/components/settings/SettingsGeneralPanel.test.ts`, and `src/client/src/components/settings/SettingsGeneralPanel.ts`.
- Preserve the intentional uncommitted amendment to `docs/superpowers/plans/2026-08-22-speech-input-polishing.md`; keep it unstaged and outside every source correction.
- The initial audit child is read-only and must not modify product files, tests, package metadata, plan files, the index, or `HEAD`; a correction may occur only in a controller-dispatched fix round for adjudicated finding IDs.
- The Settings checkbox must remain default-on when omitted, preserve explicit `false`, disclose transfer to the configured lightweight utility model, and remain gateway/session-daemon scoped regardless of the selected coding machine.
- Any correction must add or update a deterministic regression, demonstrate the expected RED failure before the production change, run focused GREEN verification, and commit only authorized Settings component/test files.
- Do not add a Local speech provider, selected-machine polishing route, session/archive/history/workspace/draft/transcript persistence, credential/provider/prompt/transcript logging, dependency, README, or `CHANGELOG.md` change.
- Do not modify the already-committed session-daemon routes, transport, model service, browser speech controller, prompt editor, or unrelated features. Because the branch includes daemon changes, inform the user that `pi-webui-sessiond.service` needs a manual restart after implementation.
- Every child prompt must be rendered and persisted before spawn, passed byte-for-byte without manual retyping, and compared with the child's initial prompt before session correlation or report admission. A mismatch must remain terminal and inadmissible.

## Scope Check

This continuation has one audit task. The controller derives independent task review, any scoped fix/re-review rounds, and the mandatory final Frontier review from that task.

## Task 1: Re-Audit The Settings Candidate And Establish Admissible Evidence

**Implementer tier:** Capable

**Files:**

- Inspect: `src/client/src/components/settings/SettingsGeneralPanel.ts`
- Inspect: `src/client/src/components/settings/SettingsGeneralPanel.test.ts`
- Inspect: `src/client/src/components/SettingsDialog.ts`
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

**Interfaces:**

- Consumes: candidate Git range `265b97081b6b0871ccb8aa024061e2625402e8ac..1d11c29c4235d5aedcf305c2604e5c18f4abeb22`; `SettingsDialog.loading` passed to `SettingsGeneralPanel.loading`; `speechInputDraftFromResponse()` and `speechInputUpdateFromDraft()`; and repository testing, architecture, documentation, and Changesets guidance.
- Produces: a read-only report with independently verified scope, requirement-by-requirement findings, exact test/package outcomes, and no product commit or source change.

### Step 1: Establish immutable evidence boundaries

Read this task brief and applicable repository guidance. Do not read either sealed predecessor review report as correctness evidence. Inspect exactly the candidate range and current status:

```bash
git status --short --untracked-files=all
git diff --name-status 265b97081b6b0871ccb8aa024061e2625402e8ac 1d11c29c4235d5aedcf305c2604e5c18f4abeb22
git diff --check 265b97081b6b0871ccb8aa024061e2625402e8ac 1d11c29c4235d5aedcf305c2604e5c18f4abeb22
git diff --check
```

Confirm the range contains only the five authorized candidate files and that the only dirty source-adjacent path is the intentional predecessor-plan amendment. Treat any other product change as a scope finding. Do not stage, commit, stash, check out, or edit any product or SDD artifact.

### Step 2: Verify the Settings behavior and the retained-response reload case

Read the component, its tests, `SettingsDialog` loading/save lifecycle, draft conversion, and relevant existing tests. Independently verify:

- the checkbox is under the Speech input card, has an accessible label, is checked when the setting is omitted/legacy, and is unchecked for explicit `false`;
- change handling writes a real boolean to the draft and full save serialization emits an explicit boolean while preserving revision and credential mutation behavior;
- the checkbox, sibling speech controls, save action, and credential-clear action are disabled when saving, stale, unavailable, insecure, or while the parent gateway Settings load is active;
- the retained-response case is covered: `SettingsDialog.loadConfig()` sets `loading=true` while the old speech response remains adopted until deferred loading completes, so `SettingsGeneralPanel` must not permit edits, save, or credential clear during that interval;
- existing stale revision, secure-context, password retention, credential clearing, reload, and successful-save cleanup remain intact;
- UI disclosure and both config documents accurately state lightweight utility-model transfer, gateway/local session-daemon scope, no Pi session or transcript/prompt persistence, no automatic submission, privacy/logging boundaries, and the manual daemon restart note;
- the Changeset names `@hyperdreamer/pi-webui`, requests `minor`, and has valid concise frontmatter.

If a defect is observed, record exact file and line evidence in the report only; do not fix it in this task.

### Step 3: Run fresh read-only verification

Use a data-backed temporary directory if `/tmp` is constrained. Run the focused checks first and record actual outcomes:

```bash
npm test -- --run src/client/src/components/settings/SettingsGeneralPanel.test.ts src/client/src/components/settings/settingsConfigDraft.test.ts src/client/src/components/SettingsDialog.general.test.ts
npm test -- --run src/client/src/controllers/speechInputController.test.ts src/server/speechInput/speechInputPolishingService.test.ts src/server/speechInput/speechInputPolishingRoutes.test.ts src/server/app.speechInput.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/sessiond/sessionDaemonClient.test.ts src/server/speechInput/speechInputSettingsRoutes.test.ts
npm run typecheck
npx eslint src/client/src/components/settings/SettingsGeneralPanel.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts
npm run changelog:status
npm run pack:dry
npm run verify:staged
git diff --check 265b97081b6b0871ccb8aa024061e2625402e8ac 1d11c29c4235d5aedcf305c2604e5c18f4abeb22
git diff --check
```

Separate environment-only storage, Vite, or dependency-layout failures from source defects. Do not claim a workaround without verifying it and leaving no product artifact.

### Step 4: Write the read-only handoff

Inspect status again. Write exactly one report at the controller-provided report path with `STATUS: DONE` when the audit completed, even if it reports findings. State that no source files, tests, package metadata, plan files, index, or `HEAD` were modified and no commit was created. Include the exact candidate range, all findings with concrete evidence, and actual verification results. Do not stage or commit.

### Step 5: Leave review and correction to the controller

The controller must independently review the exact candidate range. If a load-bearing finding is confirmed, it must open a scoped fix round and then a fresh re-review. After task approval, it must dispatch a Frontier final reviewer over `780c3fc1d98e2533d166f694469deccfb93008b8..HEAD`, reconcile all findings, verify protected files and the intentional dirty amendment, and complete only with approval and no unresolved findings.
