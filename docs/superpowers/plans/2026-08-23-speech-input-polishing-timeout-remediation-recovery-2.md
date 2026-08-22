# Speech Input Polishing Timeout Remediation Recovery 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Establish a fresh admissible audit and review chain for the committed speech-input polishing feature and its provider-timeout correction after a terminal prompt-byte mismatch.

**Architecture:** Use one read-only Capable audit task over the current Git tree, then the controller's independent task-review and mandatory Frontier final-review gates. The audit treats Git and fresh source inspection as authority, preserves the existing correction commit, and never edits the product candidate.

**Tech Stack:** TypeScript, Vitest, Fastify, Lit, npm, Git, Changesets, deterministic SDD state machine.

## Global Constraints

- Preserve `.sdd/speech-input-polishing-timeout-remediation-20260823/` as terminal historical evidence only. Its child session `01a02bcb-a8ba-71c5-8d59-52decc0a112e` received prompt bytes that differ from the persisted prompt by one leading space; its report, status, and claims are inadmissible.
- Preserve all earlier speech-input polishing recovery roots, reports, prompts, transcripts, findings, and terminal state as historical evidence only; do not hand-edit or reopen them.
- Treat `d67ef99c18b7b3e095e928b123cd35b2e1891635` only as uncorrelated Git evidence and inspect it independently. Do not recreate, revert, amend, cherry-pick, or rewrite that correction commit.
- Audit exactly `780c3fc1d98e2533d166f694469deccfb93008b8..HEAD` and the timeout correction diff `07c8592087c805a17ebdff11f506d03621b74b03..HEAD`; do not infer correctness from any predecessor child report.
- The audit task is strictly read-only: do not modify, stage, stash, reset, check out, commit, or delete any product file, test, Changeset, documentation, plan, index, branch, `HEAD`, or generated artifact. Write exactly one report under the run root.
- Preserve the intentional unstaged amendment to `docs/superpowers/plans/2026-08-22-speech-input-polishing.md` byte-for-byte and unstaged. It is not part of the candidate correction.
- Verify that the timeout correction's shared module exports `SPEECH_INPUT_POLISHING_ROUTE_TIMEOUT_MS = 30_000` and `SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS = 25_000`, with the documented five-second margin; the service passes the model timeout, and the route imports and re-exports the route timeout.
- Verify that existing `signal`, `maxRetries: 0`, `cacheRetention: "none"`, bounded `maxTokens`, candidate fallback, extraction, error mapping, admission cleanup, and route deadline behavior remain intact.
- Do not modify or propose silent changes to browser speech/controller behavior, Settings behavior, daemon route registration, session transport, credentials, persistence, logging, dependencies, README, or `CHANGELOG.md`. Findings outside the committed timeout scope must be reported, not fixed in this run.
- Verify the patch Changeset has valid frontmatter for `"@hyperdreamer/pi-webui"` and that `npm run changelog:status` does not alter `CHANGELOG.md`.
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

- Consumes: the pinned Git range `780c3fc1d98e2533d166f694469deccfb93008b8..HEAD`, the correction range `07c8592087c805a17ebdff11f506d03621b74b03..HEAD`, `ModelsSimpleStreamOptions`, the existing speech-polishing service and route contracts, and the persisted task brief plus repository testing and architecture guidance.
- Produces: exactly one read-only audit report at the controller-provided `reportPath`, with independently observed requirements, findings, and verification results; produces no source commit.

### Step 1: Establish the evidence boundary

Run these commands before interpreting any report or source claim:

```bash
git status --short --untracked-files=all
git rev-parse HEAD
git merge-base HEAD main
git diff --name-status 780c3fc1d98e2533d166f694469deccfb93008b8 HEAD
git diff --name-status 07c8592087c805a17ebdff11f506d03621b74b03 HEAD
git diff --check 780c3fc1d98e2533d166f694469deccfb93008b8 HEAD
git diff --check 07c8592087c805a17ebdff11f506d03621b74b03 HEAD
git show --stat --oneline d67ef99c18b7b3e095e928b123cd35b2e1891635
```

Confirm that `HEAD` is the pinned current commit, the merge base is `780c3fc1d98e2533d166f694469deccfb93008b8`, the timeout correction changes exactly the six intended files, and the only pre-existing dirty source path is the protected original plan amendment. Do not stage, edit, or clean anything. Do not use predecessor reports or transcripts as correctness evidence.

### Step 2: Audit the timeout correction requirement by requirement

Read the current files and the exact Git diff. Verify all of these independently:

- `src/shared/speechInputPolishing.ts` exports exactly the route budget `30_000` and model budget `25_000`, and its comment explains the five-second margin for abort propagation, cleanup, and the HTTP response.
- `speechInputPolishingRoutes.ts` imports the shared route constant, uses it for the route deadline, and re-exports it without a duplicate literal or a route/service import cycle.
- `speechInputPolishingService.ts` passes `timeoutMs: SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS` to `completeSimple` for every candidate while retaining the caller `signal`, `maxRetries: 0`, `cacheRetention: "none"`, bounded `maxTokens`, candidate order/fallback, prompt construction, text extraction, typed cancellation, and safe error behavior.
- The service regression test observes the actual options object, asserts the model timeout, asserts it is strictly less than the route timeout, and retains the signal/cancellation assertion. The route regression test proves the route export is tied to the shared constant. Identify whether either test would pass under a reverted or disconnected implementation.
- `.changeset/speech-input-polishing-timeout.md` has valid package frontmatter and concise user-facing patch text. The original feature Changeset remains intact and `CHANGELOG.md` is untouched.

Record every defect with exact `file:line` evidence, consequence, and a concrete correction. Do not edit defects. Treat a load-bearing missing timeout or an out-of-scope product mutation as an Important finding.

### Step 3: Audit unchanged speech-input boundaries

Inspect the listed client, Settings, route, daemon, and documentation files and verify that the timeout commit did not alter unrelated behavior. Confirm, using current source and tests rather than predecessor reports, that:

- browser speech capture still inserts polished text only through the existing explicit flow and does not auto-submit, queue, steer, or start sessions;
- the daemon owns provider work and the gateway/session transport boundary remains intact;
- Settings preference defaults, explicit `false`, revision handling, credential mutation/clearing, selected-machine independence, and readiness guards remain unchanged;
- no session/archive/history/workspace/draft/transcript persistence or sensitive logging was introduced;
- visible configuration and Changeset disclosures remain coherent with the feature's lightweight utility-model and session-daemon-local behavior.

Report unrelated defects as findings with evidence; do not broaden or repair them in this read-only task.

### Step 4: Run read-only verification

Run the narrow focused tests first, then the broader speech-input tests, typecheck, scoped ESLint, Changeset status, package dry-run, staged validation, and diff checks. Use a temporary directory outside the repository for any generated test output. Record actual exit status, test counts, and whether failures are source defects or environment-only:

```bash
TMPDIR=/data/home/guest/tmp/pi-webui-speech-timeout-recovery-2 npm test -- --run src/server/speechInput/speechInputPolishingService.test.ts src/server/speechInput/speechInputPolishingRoutes.test.ts
TMPDIR=/data/home/guest/tmp/pi-webui-speech-timeout-recovery-2 npm test -- --run src/client/src/controllers/speechInputController.test.ts src/client/src/components/PromptEditor.speechInput.test.ts src/client/src/components/SettingsDialog.general.test.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts src/server/app.speechInput.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/sessiond/sessionDaemonClient.test.ts src/server/speechInput/speechInputSettingsRoutes.test.ts
TMPDIR=/data/home/guest/tmp/pi-webui-speech-timeout-recovery-2 npm run typecheck
TMPDIR=/data/home/guest/tmp/pi-webui-speech-timeout-recovery-2 npx eslint src/shared/speechInputPolishing.ts src/server/speechInput/speechInputPolishingService.ts src/server/speechInput/speechInputPolishingService.test.ts src/server/speechInput/speechInputPolishingRoutes.ts src/server/speechInput/speechInputPolishingRoutes.test.ts
npm run changelog:status
npm run pack:dry
npm run verify:staged
git diff --check 780c3fc1d98e2533d166f694469deccfb93008b HEAD
git diff --check
```

Do not run commands that modify the index or worktree. After packaging, verify no generated `dist` or `CHANGELOG.md` modification is present and re-run `git status --short --untracked-files=all`.

### Step 5: Write the audit report

Write exactly one report at the controller-provided `reportPath` and return exactly one status token:

```text
STATUS: DONE

SCOPE:
- Range: 780c3fc1d98e2533d166f694469deccfb93008b8..HEAD
- Timeout correction: d67ef99c18b7b3e095e928b123cd35b2e1891635
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
- <explicit statement about HEAD, protected dirty amendment, six-file timeout diff, and no source commit>
```

Use an empty `FINDINGS:` list when no defect is found. Do not write a `COMMIT:` line because this task is read-only. Do not modify any other artifact or source path. The final evidence must state that `F-001` is resolved only if the current source and regression tests prove the named five-second model-to-route timeout margin.

### Step 6: Defer decisions to the controller

The controller independently admits the report only after prompt-byte correlation. A fresh task reviewer must inspect the exact range and report `SPEC: PASS` / `QUALITY: APPROVED` or concrete findings. After task approval, the controller must dispatch a Frontier final reviewer over `780c3fc1d98e2533d166f694469deccfb93008b8..HEAD`, reconcile all findings, preserve the protected amendment, and complete only with final `SPEC: PASS` and `QUALITY: APPROVED`. If a load-bearing finding requires a product edit, stop this run and author a separate remediation plan; never violate this task's read-only constraint.
