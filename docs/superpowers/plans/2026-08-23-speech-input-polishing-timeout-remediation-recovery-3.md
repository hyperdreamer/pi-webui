# Speech Input Polishing Timeout Remediation Recovery 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Establish a fresh admissible audit and review chain for the committed speech-input polishing feature and provider-timeout correction after a terminal dispatch mismatch.

**Architecture:** Use one read-only Capable audit task over current Git and source, then the controller's independent task-review and mandatory Frontier final-review gates. Preserve the existing product candidate and correction commit; this run produces no source changes.

**Tech Stack:** TypeScript, Vitest, Fastify, Lit, npm, Git, Changesets, deterministic SDD state machine.

## Global Constraints

- Preserve `.sdd/speech-input-polishing-timeout-remediation-20260823/` and `.sdd/speech-input-polishing-timeout-remediation-recovery-2-20260823/` as terminal historical evidence only. Their child sessions received prompt bytes that differ from persisted prompts; their reports, statuses, and claims are inadmissible. Preserve all earlier speech-input polishing recovery roots as well.
- Treat `d67ef99c18b7b3e095e928b123cd35b2e1891635` only as uncorrelated Git evidence and inspect its exact parent-to-commit diff independently. Do not recreate, revert, amend, cherry-pick, or rewrite it.
- Audit exactly the feature range `780c3fc1d98e2533d166f694469deccfb93008b8..HEAD` and the exact timeout correction commit range `d67ef99c18b7b3e095e928b123cd35b2e1891635^..d67ef99c18b7b3e095e928b123cd35b2e1891635`. Do not infer correctness from predecessor reports, transcripts, or status tokens.
- The audit task is strictly read-only: do not modify, stage, stash, reset, check out, commit, or delete any product file, test, Changeset, documentation, plan, index, branch, `HEAD`, or generated artifact. Write exactly one report under the run root.
- Preserve the intentional unstaged amendment to `docs/superpowers/plans/2026-08-22-speech-input-polishing.md` byte-for-byte and unstaged.
- Verify `src/shared/speechInputPolishing.ts` exports `SPEECH_INPUT_POLISHING_ROUTE_TIMEOUT_MS = 30_000` and `SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS = 25_000`, with a documented five-second margin; verify the service passes the model timeout and the route imports and re-exports the route timeout.
- Verify existing `signal`, `maxRetries: 0`, `cacheRetention: "none"`, bounded `maxTokens`, candidate fallback, extraction, error mapping, admission cleanup, and route deadline behavior remain intact.
- Do not modify or silently broaden browser speech/controller, Settings, daemon registration, session transport, credentials, persistence, logging, dependency, README, or `CHANGELOG.md` behavior. Report unrelated defects as findings.
- Verify `.changeset/speech-input-polishing-timeout.md` has valid frontmatter for `"@hyperdreamer/pi-webui"` and that `CHANGELOG.md` remains untouched.
- The final handoff must tell the user to manually restart `pi-webui-sessiond.service` because the audited service is loaded by the long-lived session daemon.

## Scope Check

This plan has one audit task. The controller derives the independent task reviewer, any finding decision, and the mandatory Frontier final reviewer.

## Task 1: Audit The Committed Timeout Correction

**Implementer tier:** Capable

### Files

- Inspect: `src/shared/speechInputPolishing.ts`
- Inspect: `src/server/speechInput/speechInputPolishingService.ts`
- Inspect: `src/server/speechInput/speechInputPolishingService.test.ts`
- Inspect: `src/server/speechInput/speechInputPolishingRoutes.ts`
- Inspect: `src/server/speechInput/speechInputPolishingRoutes.test.ts`
- Inspect: `.changeset/speech-input-polishing-timeout.md`
- Inspect: `src/client/src/controllers/speechInputController.ts`
- Inspect: `src/client/src/controllers/speechInputController.test.ts`
- Inspect: `src/client/src/components/PromptEditor.ts`
- Inspect: `src/client/src/components/PromptEditor.speechInput.test.ts`
- Inspect: `src/client/src/components/SettingsDialog.ts`
- Inspect: `src/client/src/components/SettingsDialog.general.test.ts`
- Inspect: `src/client/src/components/settings/SettingsGeneralPanel.ts`
- Inspect: `src/client/src/components/settings/SettingsGeneralPanel.test.ts`
- Inspect: `src/server/sessiond.ts`
- Inspect: `src/server/sessiond/sessionProxyRoutes.ts`
- Inspect: `src/sessiond/sessionDaemonClient.ts`
- Inspect: `src/server/speechInput/speechInputSettingsService.ts`
- Inspect: `src/server/speechInput/speechInputSettingsRoutes.ts`
- Inspect: `src/shared/speechInput.ts`
- Inspect: `docs/config.md`
- Inspect: `docs/config.html`
- Inspect: `.changeset/speech-input-polishing.md`
- Test: `src/server/speechInput/speechInputPolishingService.test.ts`
- Test: `src/server/speechInput/speechInputPolishingRoutes.test.ts`
- Test: `src/client/src/controllers/speechInputController.test.ts`
- Test: `src/client/src/components/PromptEditor.speechInput.test.ts`
- Test: `src/client/src/components/SettingsDialog.general.test.ts`
- Test: `src/client/src/components/settings/SettingsGeneralPanel.test.ts`
- Test: `src/server/app.speechInput.test.ts`
- Test: `src/server/sessiond/sessionProxyRoutes.test.ts`
- Test: `src/sessiond/sessionDaemonClient.test.ts`
- Test: `src/server/speechInput/speechInputSettingsRoutes.test.ts`

### Interfaces

- Consumes: feature range `780c3fc1d98e2533d166f694469deccfb93008b8..HEAD`, exact correction range `d67ef99c18b7b3e095e928b123cd35b2e1891635^..d67ef99c18b7b3e095e928b123cd35b2e1891635`, `ModelsSimpleStreamOptions`, existing speech-polishing service and route contracts, and repository testing and architecture guidance.
- Produces: exactly one read-only audit report at the controller-provided `reportPath`, with independently observed requirements, findings, and verification results; produces no source commit.

### Step 1: Establish the evidence boundary

Run these commands before interpreting any report or source claim:

```bash
git status --short --untracked-files=all
git rev-parse HEAD
git merge-base HEAD main
git diff --name-status 780c3fc1d98e2533d166f694469deccfb93008b8 HEAD
git diff --name-status d67ef99c18b7b3e095e928b123cd35b2e1891635^ d67ef99c18b7b3e095e928b123cd35b2e1891635
git diff --check 780c3fc1d98e2533d166f694469deccfb93008b8 HEAD
git diff --check d67ef99c18b7b3e095e928b123cd35b2e1891635^ d67ef99c18b7b3e095e928b123cd35b2e1891635
git show --stat --oneline d67ef99c18b7b3e095e928b123cd35b2e1891635
```

Confirm `HEAD` is current, its merge base is `780c3fc1d98e2533d166f694469deccfb93008b8`, the parent-to-`d67ef99` diff contains exactly the six intended correction paths, and the protected original plan amendment is the only expected dirty source path. Do not stage, edit, clean, or use predecessor evidence.

### Step 2: Audit the timeout correction requirement by requirement

Read the current files and exact parent-to-commit diff. Verify all of these independently:

- `src/shared/speechInputPolishing.ts` exports exactly route `30_000` and model `25_000` budgets, and its comment explains the five-second reserve for abort propagation, cleanup, and HTTP response handling.
- `speechInputPolishingRoutes.ts` imports the shared route constant, uses it for the route deadline, and re-exports that binding without a duplicate literal or route/service cycle.
- `speechInputPolishingService.ts` passes `timeoutMs: SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS` to every `completeSimple` call while preserving caller `signal`, `maxRetries: 0`, `cacheRetention: "none"`, bounded `maxTokens`, candidate order/fallback, prompt construction, extraction, typed cancellation, and safe error mapping.
- The service test observes the real options object, asserts the model timeout, asserts it is strictly below the route timeout, and retains signal/cancellation coverage. The route test proves the route export is tied to the shared constant. Explain whether each test would fail under reverted or disconnected timeout wiring.
- `.changeset/speech-input-polishing-timeout.md` has valid package frontmatter and concise user-facing patch text; the original feature Changeset remains intact; `CHANGELOG.md` is untouched.

Record every defect with exact `file:line`, observed evidence, impact, and concrete correction. Do not edit defects. Treat a missing load-bearing timeout or out-of-scope product mutation as Important.

### Step 3: Audit unchanged speech-input boundaries

Inspect the listed client, Settings, daemon, route, persistence, and documentation files and verify from current source and tests that:

- browser speech capture still inserts polished text only through the existing explicit flow and does not auto-submit, queue, steer, or start sessions;
- the daemon owns provider work and the gateway/session transport boundary remains intact;
- Settings preference defaults, explicit `false`, revision handling, credential mutation/clearing, selected-machine independence, and readiness guards remain unchanged;
- no session/archive/history/workspace/draft/transcript persistence or sensitive logging was introduced;
- visible configuration and Changesets remain coherent with lightweight utility-model and session-daemon-local behavior.

Report unrelated defects as findings; do not broaden or repair them in this read-only task.

### Step 4: Run read-only verification

Run the focused tests first, then the broader speech-input tests, typecheck, scoped ESLint, Changeset status, package dry-run, staged validation, and diff checks. Use a temporary directory outside the repository for generated test output and record actual exit status, counts, and source-versus-environment failures:

```bash
TMPDIR=/data/home/guest/tmp/pi-webui-speech-timeout-recovery-3 npm test -- --run src/server/speechInput/speechInputPolishingService.test.ts src/server/speechInput/speechInputPolishingRoutes.test.ts
TMPDIR=/data/home/guest/tmp/pi-webui-speech-timeout-recovery-3 npm test -- --run src/client/src/controllers/speechInputController.test.ts src/client/src/components/PromptEditor.speechInput.test.ts src/client/src/components/SettingsDialog.general.test.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts src/server/app.speechInput.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/sessiond/sessionDaemonClient.test.ts src/server/speechInput/speechInputSettingsRoutes.test.ts
TMPDIR=/data/home/guest/tmp/pi-webui-speech-timeout-recovery-3 npm run typecheck
TMPDIR=/data/home/guest/tmp/pi-webui-speech-timeout-recovery-3 npx eslint src/shared/speechInputPolishing.ts src/server/speechInput/speechInputPolishingService.ts src/server/speechInput/speechInputPolishingService.test.ts src/server/speechInput/speechInputPolishingRoutes.ts src/server/speechInput/speechInputPolishingRoutes.test.ts
npm run changelog:status
npm run pack:dry
npm run verify:staged
git diff --check 780c3fc1d98e2533d166f694469deccfb93008b8 HEAD
git diff --check
```

After packaging, verify no generated `dist` or `CHANGELOG.md` modification exists and rerun `git status --short --untracked-files=all`. Do not run commands that modify the index or worktree.

### Step 5: Write exactly one audit report

Write exactly one report at the controller-provided `reportPath` and return exactly one status token:

```text
STATUS: DONE

SCOPE:
- Feature range: 780c3fc1d98e2533d166f694469deccfb93008b8..HEAD
- Timeout correction: d67ef99c18b7b3e095e928b123cd35b2e1891635^..d67ef99c18b7b3e095e928b123cd35b2e1891635
- Source changes: none made by this audit

FINDINGS:
- id: F-<n>
  severity: Critical | Important | Minor
  location: path/to/file.ts:42
  evidence: <what was observed>
  impact: <consequence>
  correction: <what would resolve it>

VERIFICATION:
- <command>: <actual result>

EVIDENCE:
- <explicit statement about HEAD, protected dirty amendment, six-file correction diff, and no source commit>
```

Use an empty `FINDINGS:` list when no defect is found. Do not include a `COMMIT:` line because this task is read-only. State that `F-001` is resolved only if current source and regression tests prove the named five-second model-to-route margin. Write no other deliverable.

### Step 6: Defer decisions to the controller

The controller must compare the child’s first user message byte-for-byte with the persisted rendered prompt before recording `dispatch-started` or admitting its report. A fresh task reviewer must inspect the exact ranges and report `SPEC: PASS` / `QUALITY: APPROVED` or concrete findings. After task approval, a Frontier final reviewer must inspect the feature range, reconcile all findings, preserve the protected amendment, and complete only with final `SPEC: PASS` and `QUALITY: APPROVED`. If a load-bearing finding requires product edits, terminate this audit run and author a separate remediation plan; never violate this task's read-only constraint.
