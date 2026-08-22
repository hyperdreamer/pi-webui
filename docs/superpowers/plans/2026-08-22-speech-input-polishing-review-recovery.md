# Speech Input Polishing Review Recovery Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Obtain admissible independent review of the committed Speech input polishing Settings task, repair only verified findings, and complete a whole-branch Frontier review.

**Architecture:** The predecessor review dispatch is excluded because its child received repository-root `.sdd` paths instead of the stored worktree run-root paths. A fresh read-only audit reviews the exact committed Settings/documentation/Changeset range. Any load-bearing finding goes through the controller's normal scoped fix and re-review loop; no source edit is made by the audit child. The final reviewer covers the complete feature branch from the original feature base.

**Tech Stack:** Git, deterministic SDD state machine, Vitest, TypeScript, ESLint, Changesets, npm packaging, Lit Settings components.

## Global Constraints

- The predecessor run `.sdd/speech-input-polishing-browser-recovery-20260822/` remains historical evidence only; its prompt-mismatched reviewer transcript, missing report, and all claims are inadmissible.
- The exact candidate Settings task range is `265b97081b6b0871ccb8aa024061e2625402e8ac..1d11c29c4235d5aedcf305c2604e5c18f4abeb22`; inspect it from Git rather than trusting any predecessor report.
- The candidate range contains exactly `.changeset/speech-input-polishing.md`, `docs/config.html`, `docs/config.md`, `src/client/src/components/settings/SettingsGeneralPanel.test.ts`, and `src/client/src/components/settings/SettingsGeneralPanel.ts`.
- The intentional uncommitted amendment to `docs/superpowers/plans/2026-08-22-speech-input-polishing.md` must remain untouched, unstaged, and outside every product correction.
- The initial audit child is read-only and must not modify product files, tests, package metadata, plan files, the index, or `HEAD`; a correction may occur only in a controller-dispatched fix round and only for adjudicated finding IDs.
- The Settings checkbox must remain default-on when omitted, preserve explicit `false`, disclose the configured lightweight utility-model transfer, and preserve stale, credential, secure-context, save, and reload behavior.
- No selected-machine polishing route, Local speech provider, session/archive/history/workspace/draft/transcript persistence, credential/provider/prompt/transcript logging, dependency, README, or `CHANGELOG.md` change is allowed.
- Any correction must add or update a deterministic regression, demonstrate the expected RED failure before the production change, run focused GREEN verification, and commit only the authorized Settings/test files.
- Changes affecting the already-committed session-daemon routes or code require a manual `pi-webui-sessiond.service` restart notice; this continuation must not modify those daemon files.
- Every new child prompt must be rendered and persisted before dispatch, and its initial user message must be compared byte-for-byte with the stored rendered prompt before correlation or report admission.

## Scope Check

This continuation is intentionally one reviewable audit task. The committed feature implementation is already present; the task review and controller fix loop provide the only source-correction path. A final Frontier review is required after the task is complete.

## Task 1: Audit The Settings Candidate And Establish Fresh Review Evidence

**Implementer tier:** Capable

**Files:**

- Inspect: `src/client/src/components/settings/SettingsGeneralPanel.ts`
- Inspect: `src/client/src/components/settings/SettingsGeneralPanel.test.ts`
- Inspect: `docs/config.md`
- Inspect: `docs/config.html`
- Inspect: `.changeset/speech-input-polishing.md`
- Test: `src/client/src/components/settings/SettingsGeneralPanel.test.ts`
- Test: `src/client/src/components/settings/settingsConfigDraft.test.ts`
- Test: `src/client/src/controllers/speechInputController.test.ts`
- Test: `src/server/speechInput/speechInputPolishingService.test.ts`
- Test: `src/server/speechInput/speechInputPolishingRoutes.test.ts`
- Test: `src/server/app.speechInput.test.ts`
- Test: `src/server/sessiond/sessionProxyRoutes.test.ts`
- Test: `src/sessiond/sessionDaemonClient.test.ts`
- Test: `src/server/speechInput/speechInputSettingsRoutes.test.ts`

**Interfaces:**

- Consumes: candidate Git range `265b97081b6b0871ccb8aa024061e2625402e8ac..1d11c29c4235d5aedcf305c2604e5c18f4abeb22`, the `SettingsDialog.loading` parent property passed to `SettingsGeneralPanel.loading`, `speechInputDraftFromResponse()`, `speechInputUpdateFromDraft()`, and the repository testing/documentation/Changesets guidance.
- Produces: a read-only implementer report with independently verified scope, requirement-by-requirement findings, actual test/package results, and the exact candidate SHA range. It produces no product commit and no source change.

### Step 1: Establish the evidence boundary

Read this task brief and the repository guidance. Do not read the sealed predecessor reviewer report as correctness evidence. Inspect exactly the candidate range with:

```bash
git status --short --untracked-files=all
git diff --name-status 265b97081b6b0871ccb8aa024061e2625402e8ac 1d11c29c4235d5aedcf305c2604e5c18f4abeb22
git diff --check 265b97081b6b0871ccb8aa024061e2625402e8ac 1d11c29c4235d5aedcf305c2604e5c18f4abeb22
git diff --check
```

Confirm that only the five listed candidate files changed and that the only dirty source-adjacent path is the intentional predecessor-plan amendment. Treat any other product change as a scope finding.

### Step 2: Audit the Settings behavior directly

Read the component, draft conversion, parent SettingsDialog loading/save lifecycle, and tests. Verify all of the following from observable behavior or a narrowly justified component seam:

- the checkbox is under the Speech input card, has an accessible label, and is checked for omitted/legacy settings and unchecked for explicit `false`;
- a change event writes a real boolean into the draft and a full save emits an explicit boolean while preserving the revision and credential mutation contract;
- the checkbox and sibling speech controls are disabled while saving, stale, unavailable, insecure, or the parent gateway Settings load is active; in particular, test the reload case where `SettingsDialog.loadConfig()` retains an existing speech response while setting `loading=true`;
- existing credential clearing, stale revision handling, draft/password retention, secure-context gating, and successful-save cleanup remain intact;
- UI disclosure and both configuration documents accurately describe lightweight utility-model transfer, default-on/explicit-off behavior, gateway/local session-daemon scope, no persistence or automatic submission, privacy boundaries, and the required daemon restart note;
- the Changeset names `@hyperdreamer/pi-webui`, requests `minor`, and has concise valid frontmatter.

If a defect is observed, record exact file/line evidence in the audit report; do not edit it in this task.

### Step 3: Run fresh verification

Use a data-backed temporary directory if the environment's `/tmp` is constrained. Run the narrow checks first and record actual outcomes:

```bash
npm test -- --run src/client/src/components/settings/SettingsGeneralPanel.test.ts
npm test -- --run src/client/src/controllers/speechInputController.test.ts src/server/speechInput/speechInputPolishingService.test.ts src/server/speechInput/speechInputPolishingRoutes.test.ts src/server/app.speechInput.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/sessiond/sessionDaemonClient.test.ts src/server/speechInput/speechInputSettingsRoutes.test.ts
npm run typecheck
npx eslint src/client/src/components/settings/SettingsGeneralPanel.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts
npm run changelog:status
npm run pack:dry
npm run verify:staged
git diff --check
```

Separate source failures from environment-only storage, Vite, or dependency-layout failures. Do not claim a workaround unless it is independently verified and leaves no product artifact.

### Step 4: Write the read-only handoff

Inspect status again and write exactly one implementer report at the controller-provided report path. Use `STATUS: DONE` when the audit itself completed, even when it reports review findings. State explicitly that no source files were modified and no commit was created. Include every finding as concrete evidence for the independent task reviewer; do not include claims from the sealed predecessor run.

Do not stage, commit, or alter any product or SDD artifact outside the controller-provided report path.

### Step 5: Preserve the candidate for review

The task reviewer must independently inspect the same exact candidate range. The controller, not this task, decides whether findings open a fix round, whether a minor finding can be parked, and when the task is complete. After task approval, the controller must dispatch a Frontier final reviewer over `780c3fc1d98e2533d166f694469deccfb93008b8..HEAD`, reconciling all findings and verifying a clean worktree.
