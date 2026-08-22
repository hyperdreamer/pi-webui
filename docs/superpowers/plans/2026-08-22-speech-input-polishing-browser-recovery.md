# Speech Input Polishing Browser Recovery Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Independently audit the committed browser transcript-polishing integration after a sealed dispatch mismatch, then expose its persistent preference, documentation, and release evidence.

**Architecture:** The browser API client, SpeechInputController, and PromptEditor integration is carried forward as a Git candidate and must be independently audited before it is relied upon. The remaining implementation adds only the Settings General checkbox and disclosure, paired configuration documentation, and a minor Changeset; the gateway/session-daemon and browser runtime boundaries remain unchanged.

**Tech Stack:** TypeScript, Lit, Vitest, existing PI WEBUI settings drafts/API contracts, Markdown/HTML configuration docs, and Changesets.

## Global Constraints

- Work only in `/data/home/guest/Development/pi-webui/.worktrees/speech-input-polishing` on branch `speech-input-polishing`.
- Preserve the sealed run `.sdd/speech-input-polishing-recovery-20260822/` and the predecessor run `.sdd/speech-input-polishing-relocated-20260822/`; do not use the mismatched Task 3 child report or verdict as correctness evidence.
- The carried-forward browser candidate is `a8acf115e26779699db608b1f9d2111c56f785fb..207f8cc47c1f98945ea2f93fb763e1f92a70b962`; the complete candidate is `780c3fc1d98e2533d166f694469deccfb93008b8..207f8cc47c1f98945ea2f93fb763e1f92a70b962`.
- Polishing is enabled by default when `polishVoiceInput` is omitted, and explicit `false` must survive persisted config and settings updates.
- Browser and Cloud final transcripts use the same polishing path; no Local provider, selected-machine route, or federated polishing behavior exists.
- Polishing is gateway-scoped to the local WebUI/session-daemon machine; do not alter machine services or generate selected-machine polishing URLs.
- The browser endpoint remains the application-relative `api/speech-input/polish`; application-owned browser references resolve exactly once through repository URL helpers.
- Successful polishing returns only the bounded polished text required by the browser. Errors, logs, telemetry, persistence, and unrelated responses must not expose transcript text, polished text, prompts, provider bodies, credential sources, or resolved credentials.
- The exact user-visible fallback remains `Voice input polishing failed; inserted the raw transcript.` and appears only after a genuine current failure when raw insertion returns `inserted`.
- Polishing never creates a Pi session, archive, prompt history entry, workspace file, draft, transcript record, or automatic prompt submission.
- The Settings disclosure must accurately say that enabling polishing sends captured transcript text to the configured lightweight utility model for conservative cleanup and may use its configured provider; it must not claim the model is local or selected-machine scoped.
- User-facing configuration details belong in `docs/config.md` and `docs/config.html`; do not add feature detail to `README.md`.
- Add a Changeset for `@hyperdreamer/pi-webui` with a minor bump for this backward-compatible user-facing feature and do not edit `CHANGELOG.md`.
- No new runtime dependencies. Preserve unrelated settings, credential, revision, selected-machine, speech-provider, route, controller, and editor behavior.
- Every child prompt must be rendered and persisted before dispatch, the exact persisted bytes must be passed to the child, and the child's first user message must be compared byte-for-byte before admitting its report.
- Any change to `src/server/sessiond.ts`, session-daemon routes/protocol, or daemon-only code requires informing the user that `pi-webui-sessiond.service` needs a manual restart; this recovery plan must not change those files.

## Task 1: Audit The Committed Browser Integration

**Implementer tier:** Capable

**Files:**

- Verify: `a8acf115e26779699db608b1f9d2111c56f785fb..207f8cc47c1f98945ea2f93fb763e1f92a70b962`
- Verify: `780c3fc1d98e2533d166f694469deccfb93008b8..207f8cc47c1f98945ea2f93fb763e1f92a70b962`
- Verify: `src/client/src/api/clients.ts`
- Verify: `src/client/src/api/clients.test.ts`
- Verify: `src/client/src/controllers/speechInputController.ts`
- Verify: `src/client/src/controllers/speechInputController.test.ts`
- Verify: `src/client/src/components/PromptEditor.ts`
- Verify: `src/client/src/components/PromptEditor.speechInput.test.ts`
- Verify: existing carried-forward settings, daemon service, and route source as needed to confirm protected boundaries

**Interfaces:**

- Consumes: the exact browser candidate Git range, the approved recovery design, the committed settings/service/route contracts, and the repository client/controller/editor conventions.
- Produces: one independently evidenced read-only audit report with source identity, changed-file scope, browser API/controller/editor contract results, protected-path results, and fresh verification results.
- Produces no product source change, test change, package metadata change, documentation change, plan/spec change, index change, or commit.

- [ ] **Step 1: Establish the immutable audit boundary**

Run `git status --short`, verify both range endpoints and their ancestry, record the current branch and `HEAD`, list changed files for the browser and complete candidate ranges, and run `git diff --check` for both ranges and the working tree. Confirm the only pre-existing dirty source-adjacent file is the intentional unstaged amendment to `docs/superpowers/plans/2026-08-22-speech-input-polishing.md`.

- [ ] **Step 2: Independently inspect the browser contracts**

Read the source and tests directly. Verify that the API client sends exactly `{ text }` to application-relative `api/speech-input/polish`, passes the caller signal, validates the bounded response, and uses safe errors. Verify that Browser and Cloud final transcripts share one controller finalization path; `polishVoiceInput` is snapshotted per run; `polishing` is published; per-run deadline/cancellation invalidates stale generations before aborting; successful polish inserts only polished text; disabled and empty paths preserve existing behavior; genuine failures perform raw fallback with the exact message only after `inserted`; changed/empty/too-large/cancelled/stale outcomes remain distinct; no prompt is auto-submitted; and PromptEditor surfaces status/error without unrelated layout or provider changes.

- [ ] **Step 3: Run fresh audit verification**

Run:

```bash
npm test -- --run src/client/src/api/clients.test.ts src/client/src/controllers/speechInputController.test.ts src/client/src/components/PromptEditor.speechInput.test.ts
npm run typecheck
npx eslint src/client/src/api/clients.ts src/client/src/api/clients.test.ts src/client/src/controllers/speechInputController.ts src/client/src/controllers/speechInputController.test.ts src/client/src/components/PromptEditor.ts src/client/src/components/PromptEditor.speechInput.test.ts
git diff --check a8acf115e26779699db608b1f9d2111c56f785fb..207f8cc47c1f98945ea2f93fb763e1f92a70b962
git diff --check
```

Record actual results. Distinguish environment-only failures from candidate defects and do not modify source to make the audit pass.

- [ ] **Step 4: Write the read-only audit report**

Write exactly one implementer report with `STATUS: DONE` only when the audit completed. Include exact SHAs, changed-file lists, protected-path results, commands and results, and an explicit statement that the sealed mismatched child report and verdict were not used as correctness evidence. If a concrete concern exists, state its file and line without repairing it.

- [ ] **Step 5: Commit boundary**

Do not create a commit. Inspect `git status --porcelain` and the exact candidate diffs before reporting. Only ignored per-run artifacts may be created by this task.

## Task 2: Expose The Preference And Complete Release Evidence

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/settings/SettingsGeneralPanel.ts`
- Test: `src/client/src/components/settings/SettingsGeneralPanel.test.ts`
- Modify: `docs/config.md`
- Modify: `docs/config.html`
- Create: `.changeset/speech-input-polishing.md`

**Interfaces:**

- Consumes: `SpeechInputSettingsDraft.polishVoiceInput`, `speechInputUpdateFromDraft()`, the effective `SpeechInputSettings.polishVoiceInput` parser/service contract, the controller's `polishing` and exact fallback behavior, and the existing Settings General form/revision/credential conventions.
- Produces: an accessible checked-by-default Speech input checkbox, accurate lightweight-model provider disclosure, explicit boolean draft/save behavior, synchronized Markdown/HTML configuration documentation, and a valid minor Changeset.
- Does not produce: changes to server routes, daemon transport, model service, browser API client, SpeechInputController, PromptEditor, selected-machine behavior, README, or `CHANGELOG.md`.

- [ ] **Step 1: Write failing UI/documentation/release assertions**

Add or extend `SettingsGeneralPanel.test.ts` to assert that the Speech input card renders the transcript-polishing checkbox under its existing controls, reflects effective `true` and explicit `false`, updates the draft, includes an explicit boolean in save payloads, preserves stale/credential/save behavior, and discloses that enabling polishing sends captured transcript text to the configured lightweight utility model for conservative cleanup and may use the configured provider. Inspect paired documentation sections and Changeset/package conventions so assertions cover the new default, gateway scope, no-session/no-persistence boundary, and minor package release note.

- [ ] **Step 2: Run focused checks and confirm the missing behavior**

Run `npm test -- --run src/client/src/components/settings/SettingsGeneralPanel.test.ts`, inspect the paired `docs/config.md` and `docs/config.html` Speech input sections, and validate the expected Changeset shape against `package.json` and nearby fragments. Confirm the new UI assertions fail before production edits.

- [ ] **Step 3: Implement the Settings surface, documentation, and Changeset**

Add the checkbox under Speech input using existing Lit/settings form conventions. Keep it checked whenever the effective boolean is true, update the draft with a real boolean, and always include the boolean in new save payloads while preserving existing optimistic revision, stale-form, credential, clear, and save behavior. State plainly that polishing sends captured transcript text to the configured lightweight utility model for conservative cleanup; say that the model may use its configured provider, and do not call it local or selected-machine scoped. Update the corresponding Markdown and HTML configuration sections consistently with default-on, gateway scope, no session/transcript persistence, and manual daemon-restart guidance already required by the existing daemon change. Create `.changeset/speech-input-polishing.md` for `@hyperdreamer/pi-webui` with a minor bump and concise user-facing release text. Do not edit `README.md` or `CHANGELOG.md`.

- [ ] **Step 4: Run scoped verification**

Run the focused Settings suite, the relevant controller/route/service suites, `npm run typecheck`, targeted ESLint over every changed Settings source/test file, `git diff --check`, and the repository's Changeset/package validation. Confirm no production dependency was added, no transcript/model/provider content appears in logs/errors, and only the intentionally preserved predecessor-plan amendment remains uncommitted outside the feature commits. The long-lived session daemon is not changed by this task.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/settings/SettingsGeneralPanel.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts docs/config.md docs/config.html .changeset/speech-input-polishing.md
git commit -m "feat(speech): expose transcript polishing preference"
```

## Completion Boundary

After Task 2 receives independent review approval, dispatch a fresh Frontier final reviewer across `780c3fc1d98e2533d166f694469deccfb93008b8..HEAD`. The final review must verify the carried-forward settings/service ranges, daemon route/transport, browser API/controller/editor convergence, exact fallback semantics, default-on compatibility, Settings disclosure, synchronized docs, valid Changeset, no session/transcript persistence, no selected-machine route, and clean verification. Complete only with `SPEC: PASS`, `QUALITY: APPROVED`, no open load-bearing finding, a reconciled finding ledger, clean source state apart from the intentionally preserved predecessor-plan amendment, and audit status `OK`.
