# Speech Input Polishing Review Recovery 4 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Establish an admissible independent review chain for the committed Speech input Settings candidate after the predecessor runs were invalidated by prompt-byte mismatches.

**Architecture:** Start a fresh read-only audit from the exact committed candidate range, then use the controller's independent task-review, scoped correction, re-review, and Frontier final-review gates. Every dispatch uses a short persisted relay envelope whose exact bytes are compared with the child's initial message before the session is correlated in canonical state.

**Tech Stack:** TypeScript, Lit, Vitest, npm, Git, deterministic SDD state machine, raw tracked-subsession dispatch.

## Global Constraints

- Preserve `.sdd/speech-input-polishing-browser-recovery-20260822/`, `.sdd/speech-input-polishing-review-recovery-20260822/`, `.sdd/speech-input-polishing-review-recovery-2-20260822/`, and `.sdd/speech-input-polishing-review-recovery-3-20260822/` as historical evidence only; their states, progress ledgers, reports, transcripts, and findings are inadmissible and must not be hand-edited.
- The exact Settings candidate range is `265b97081b6b0871ccb8aa024061e2625402e8ac..1d11c29c4235d5aedcf305c2604e5c18f4abeb22`; inspect it from Git, while the final review covers `780c3fc1d98e2533d166f694469deccfb93008b8..HEAD`.
- The candidate range contains exactly `.changeset/speech-input-polishing.md`, `docs/config.html`, `docs/config.md`, `src/client/src/components/settings/SettingsGeneralPanel.test.ts`, and `src/client/src/components/settings/SettingsGeneralPanel.ts`.
- Preserve the intentional unstaged amendment to `docs/superpowers/plans/2026-08-22-speech-input-polishing.md`; it is outside every audit and correction allowlist.
- The initial audit child is read-only. Only a controller-dispatched fixer may modify `src/client/src/components/settings/SettingsGeneralPanel.ts` and its focused test, and only for adjudicated finding IDs.
- The Settings checkbox remains default-on when omitted, preserves explicit `false`, discloses transfer to the configured lightweight utility model, and stays gateway/session-daemon scoped regardless of the selected coding machine.
- Do not add a Local speech provider, selected-machine polishing route, session/archive/history/workspace/draft/transcript persistence, credential/provider/prompt/transcript logging, dependency, README, or `CHANGELOG.md` change.
- Do not modify committed daemon routes, transport, model service, browser speech controller, prompt editor, or unrelated features. The final response must tell the user that `pi-webui-sessiond.service` needs a manual restart because the feature includes session-daemon changes.
- For every dispatch, first create a run-root relay payload containing the canonical role instructions and the complete task/review brief. Render a short envelope with the canonical prompt-renderer function and persist its exact bytes. Pass those bytes unchanged to `spawn_subsession`; write an observed-session receipt outside canonical state, compare the child's initial user message byte-for-byte, and only then record `dispatch-started`. A mismatch must be recorded from the dispatch-intent phase and is terminal; never admit its report.
- Never re-render or manually reconstruct a stored envelope during recovery. A reissue sends the stored bytes verbatim and accepts the runtime's possible orphan.

## Scope Check

This recovery has one audit task. The controller derives the independent task review, any scoped fix/re-review rounds, and the mandatory Frontier final review.

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

Read the Settings panel, `SettingsDialog` loading/save lifecycle, draft conversion, tests, configuration documents, and Changeset. Verify:

- the checkbox is in the Speech input card, has an accessible label, defaults checked when omitted/legacy, and is unchecked for explicit `false`;
- its change handler stores a real boolean and a full save sends an explicit boolean while preserving revision and credential mutation semantics;
- the checkbox and all sibling speech controls plus save/clear actions are disabled during saving, stale, unavailable, insecure, and parent gateway Settings loading;
- the retained-response reload case is safe: `SettingsDialog.loadConfig()` sets `loading=true` while the prior speech response remains present until the deferred reload resolves, so controls and mutation guards cannot act during that interval;
- stale revision, secure-context, password retention, credential clearing, reload, and successful-save cleanup remain intact;
- UI copy and both configuration documents agree on lightweight utility-model transfer, gateway/session-daemon scope regardless of selected coding machine, no Pi session or transcript/prompt persistence, no automatic submission, privacy/logging boundaries, and manual `pi-webui-sessiond.service` restart guidance;
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

Inspect final status. Write exactly one report at the controller-provided report path. Use `STATUS: DONE` when the audit completed, even when findings exist. Include the exact candidate range, scope result, every requirement finding, actual command outcomes, and an explicit statement that no source files, tests, package metadata, plan files, index, or `HEAD` were modified and no commit was created. Do not write any other deliverable.

### Step 5: Defer all corrections and approval to the controller

The controller must independently review this exact candidate range. If it confirms a load-bearing finding, it must open the normal scoped fixer and fresh re-reviewer. After task approval it must dispatch a Frontier final reviewer over `780c3fc1d98e2533d166f694469deccfb93008b8..HEAD`, reconcile all findings, verify a clean product worktree, and complete only with final `SPEC: PASS` and `QUALITY: APPROVED`.
