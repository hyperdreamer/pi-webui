# Speech Input Polishing Review Recovery 3 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Establish admissible independent review of the committed Settings candidate, repair only adjudicated defects, and complete whole-branch review.

**Architecture:** A fresh read-only audit is followed by deterministic independent task review, scoped fix/re-review rounds when required, and a final Frontier review. Every child receives the exact persisted rendered prompt bytes; prompt correlation is verified before any child result is admitted.

**Tech Stack:** Git, deterministic SDD state machine, Vitest, TypeScript, ESLint, Changesets, npm packaging, Lit Settings components.

## Global Constraints

- The runs `.sdd/speech-input-polishing-browser-recovery-20260822/`, `.sdd/speech-input-polishing-review-recovery-20260822/`, and `.sdd/speech-input-polishing-review-recovery-2-20260822/` remain historical evidence only; their reports, child transcripts, and findings are inadmissible.
- The exact Settings candidate range is `265b97081b6b0871ccb8aa024061e2625402e8ac..1d11c29c4235d5aedcf305c2604e5c18f4abeb22`; inspect it from Git.
- The candidate range contains exactly `.changeset/speech-input-polishing.md`, `docs/config.html`, `docs/config.md`, `src/client/src/components/settings/SettingsGeneralPanel.test.ts`, and `src/client/src/components/settings/SettingsGeneralPanel.ts`.
- Preserve the intentional uncommitted amendment to `docs/superpowers/plans/2026-08-22-speech-input-polishing.md`; keep it unstaged and outside every correction.
- The initial audit child is read-only and must not modify product files, tests, package metadata, plan files, the index, or `HEAD`; a correction may occur only in a controller-dispatched fix round for adjudicated finding IDs.
- The Settings checkbox must remain default-on when omitted, preserve explicit `false`, disclose transfer to the configured lightweight utility model, and remain gateway/session-daemon scoped regardless of the selected coding machine.
- Any correction must add or update a deterministic regression, demonstrate the expected RED failure before the production change, run focused GREEN verification, and commit only authorized Settings component/test files.
- Do not add a Local speech provider, selected-machine polishing route, session/archive/history/workspace/draft/transcript persistence, credential/provider/prompt/transcript logging, dependency, README, or `CHANGELOG.md` change.
- Do not modify the already-committed session-daemon routes, transport, model service, browser speech controller, prompt editor, or unrelated features. Because the feature branch includes daemon changes, the final response must inform the user that `pi-webui-sessiond.service` needs a manual restart.
- Render and persist every child prompt before spawn, pass the stored bytes unchanged, and compare the child's initial user message byte-for-byte with the stored rendered prompt before `dispatch-started` correlation or report admission. Any mismatch is terminal and inadmissible.

## Scope Check

This continuation has one audit task. The controller derives independent task review, any scoped fix/re-review rounds, and the mandatory Frontier final review.

## Task 1: Audit The Committed Settings Candidate Read-Only

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

- Consumes: candidate range `265b97081b6b0871ccb8aa024061e2625402e8ac..1d11c29c4235d5aedcf305c2604e5c18f4abeb22`; `SettingsDialog.loading` passed to `SettingsGeneralPanel.loading`; `speechInputDraftFromResponse()` and `speechInputUpdateFromDraft()`; and repository testing, architecture, documentation, and Changesets guidance.
- Produces: one read-only audit report at the controller-provided path with exact scope, requirement findings, and actual verification outcomes; no product commit or source change.

### Step 1: Establish the evidence boundary

Read this task brief and applicable repository guidance. Do not use any predecessor report or child transcript as correctness evidence. From the worktree run:

```bash
git status --short --untracked-files=all
git diff --name-status 265b97081b6b0871ccb8aa024061e2625402e8ac 1d11c29c4235d5aedcf305c2604e5c18f4abeb22
git diff --check 265b97081b6b0871ccb8aa024061e2625402e8ac 1d11c29c4235d5aedcf305c2604e5c18f4abeb22
git diff --check
```

Confirm exactly the five authorized candidate files changed in the range and the only dirty source-adjacent path is the protected predecessor-plan amendment. Do not stage, commit, stash, check out, or edit product or SDD artifacts.

### Step 2: Audit observable Settings behavior

Read the Settings panel, `SettingsDialog` loading/save lifecycle, draft conversion helpers, tests, configuration documents, and Changeset. Verify:

- the checkbox is in the Speech input card, has an accessible label, defaults checked when omitted/legacy, and is unchecked for explicit `false`;
- its change handler stores a real boolean and a full save sends an explicit boolean while preserving revision and credential mutation semantics;
- the checkbox and all sibling speech controls plus save/clear actions are disabled during saving, stale, unavailable, insecure, and parent gateway Settings loading;
- the retained-response reload case is safe: `SettingsDialog.loadConfig()` sets `loading=true` while the prior speech response remains present until the deferred reload resolves, so controls and mutation guards cannot act during that interval;
- stale revision, secure-context, password retention, credential clearing, reload, and successful-save cleanup remain intact;
- UI copy and both configuration documents agree on lightweight utility-model transfer, gateway/local session-daemon scope regardless of selected coding machine, no Pi session or transcript/prompt persistence, no automatic submission, privacy/logging boundaries, and manual `pi-webui-sessiond.service` restart guidance;
- the Changeset names `@hyperdreamer/pi-webui`, requests `minor`, and has valid concise frontmatter; README and CHANGELOG are untouched.

Record any defect with exact file/line evidence in the report; do not fix it in this read-only task.

### Step 3: Run read-only verification

Use a data-backed temporary directory if `/tmp` is constrained. Run and record actual results:

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

Separate environment-only storage, Vite, or dependency-layout failures from source defects. Verify any workaround without leaving product artifacts.

### Step 4: Write exactly one report

Inspect final status. Write exactly one report at the controller-provided path. Use `STATUS: DONE` when the audit completed, even when findings exist. Include the exact candidate range, scope result, every requirement finding, actual command outcomes, and an explicit statement that no source files, tests, package metadata, plan files, index, or `HEAD` were modified and no commit was created. Do not write any other deliverable.

### Step 5: Defer all corrections and approval to the controller

The controller must independently review this exact candidate range. If it confirms a load-bearing finding, it must open the normal scoped fixer and fresh re-reviewer. After task approval it must dispatch a Frontier final reviewer over `780c3fc1d98e2533d166f694469deccfb93008b8..HEAD`, reconcile all finding resolutions, verify a clean product worktree, and complete only with final `SPEC: PASS` and `QUALITY: APPROVED`.
