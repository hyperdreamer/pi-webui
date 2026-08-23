# Speech Input Polishing Timeout Remediation Recovery 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Establish a fresh admissible audit and review chain for the committed six-file speech-polishing provider-timeout correction after prior terminal dispatch failures.

**Architecture:** Use one finite, read-only Advanced audit task over the exact correction commit and focused tests. The controller derives the task reviewer and mandatory Frontier final reviewer; the final reviewer audits the complete feature range before completion.

**Tech Stack:** TypeScript, Vitest, Fastify, npm, Git, Changesets, deterministic SDD state machine.

## Global Constraints

- Preserve all prior speech-input polishing SDD roots, prompts, reports, transcripts, receipts, findings, and terminal state as historical evidence only. In particular, never reopen `.sdd/speech-input-polishing-timeout-remediation-20260823/`, `.sdd/speech-input-polishing-timeout-remediation-recovery-2-20260823/`, or `.sdd/speech-input-polishing-timeout-remediation-recovery-3-20260823/`.
- Treat `d67ef99c18b7b3e095e928b123cd35b2e1891635` as durable Git evidence and inspect exactly its parent-to-commit diff. Do not recreate, revert, amend, cherry-pick, or rewrite it.
- The audit task is strictly read-only. Do not modify, stage, stash, reset, check out, commit, or delete product files, tests, Changesets, documentation, plans, the index, branch, `HEAD`, or generated artifacts. Write exactly one report under the run root.
- Preserve the intentional unstaged amendment to `docs/superpowers/plans/2026-08-22-speech-input-polishing.md` byte-for-byte and unstaged.
- The exact correction diff must contain six paths: `.changeset/speech-input-polishing-timeout.md`, the polishing route and route test, the polishing service and service test, and `src/shared/speechInputPolishing.ts`.
- Verify shared route/model budgets are exactly `30_000` and `25_000`, the comment documents the five-second reserve, the service passes the model timeout to every provider call, and the route imports and re-exports the shared route timeout.
- Verify existing signal, zero retries, no cache retention, bounded max tokens, candidate fallback, extraction, typed cancellation, safe errors, admission cleanup, and route deadline behavior remain intact.
- Do not silently alter or repair unrelated browser, Settings, daemon, transport, persistence, security, documentation, README, dependency, or `CHANGELOG.md` behavior. The Frontier final reviewer reports such defects.
- The final handoff must tell the user to manually restart `pi-webui-sessiond.service` because the audited service is loaded by the long-lived session daemon.

## Scope Check

This plan has one bounded audit task. The controller derives the independent task reviewer and mandatory Frontier final reviewer.

## Task 1: Audit The Six-File Timeout Correction

**Implementer tier:** Advanced

### Files

- Inspect: `src/shared/speechInputPolishing.ts`
- Inspect: `src/server/speechInput/speechInputPolishingService.ts`
- Inspect: `src/server/speechInput/speechInputPolishingService.test.ts`
- Inspect: `src/server/speechInput/speechInputPolishingRoutes.ts`
- Inspect: `src/server/speechInput/speechInputPolishingRoutes.test.ts`
- Inspect: `.changeset/speech-input-polishing-timeout.md`
- Test: `src/server/speechInput/speechInputPolishingService.test.ts`
- Test: `src/server/speechInput/speechInputPolishingRoutes.test.ts`

### Interfaces

- Consumes: exact Git range `d67ef99c18b7b3e095e928b123cd35b2e1891635^..d67ef99c18b7b3e095e928b123cd35b2e1891635`, `ModelsSimpleStreamOptions`, `SPEECH_INPUT_POLISHING_ROUTE_TIMEOUT_MS`, `SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS`, and the existing service/route contracts.
- Produces: exactly one read-only audit report at the controller-provided `reportPath`; produces no source commit or product mutation.

### Step 1: Establish the boundary

Run these commands first and record actual output:

```bash
git status --short --untracked-files=all
git rev-parse HEAD
git diff --name-status d67ef99c18b7b3e095e928b123cd35b2e1891635^ d67ef99c18b7b3e095e928b123cd35b2e1891635
git diff --check d67ef99c18b7b3e095e928b123cd35b2e1891635^ d67ef99c18b7b3e095e928b123cd35b2e1891635
git show --stat --oneline d67ef99c18b7b3e095e928b123cd35b2e1891635
```

Confirm the only pre-existing dirty source path is the protected original plan amendment and the correction diff has exactly six intended paths. Do not stage, edit, clean, stash, or use predecessor evidence.

### Step 2: Verify source wiring

Read the six current files and exact commit diff. Verify:

- `src/shared/speechInputPolishing.ts` exports route `30_000` and model `25_000`; the comment states the five-second reserve for abort propagation, cleanup, and HTTP response handling.
- `speechInputPolishingRoutes.ts` imports the shared route constant, re-exports the same binding, and uses it for the deadline without a duplicate literal or cycle.
- `speechInputPolishingService.ts` passes `timeoutMs: SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS` to its sole `completeSimple` call for every candidate while retaining the caller signal, `maxRetries: 0`, `cacheRetention: "none"`, bounded `maxTokens`, candidate order/fallback, prompt, extraction, typed cancellation, and safe error mapping.
- The service test captures the actual options object, asserts the model timeout, asserts strict inequality with the route timeout, and retains signal cancellation coverage. The route test proves its public timeout export equals the shared binding and retains deadline behavior. Explain whether removing or disconnecting the timeout would fail the tests.
- The timeout Changeset has valid frontmatter for `"@hyperdreamer/pi-webui"`, patch level, and concise user-facing text. The original feature Changeset and `CHANGELOG.md` remain untouched.

Record any defect as `F-<n>` with `Critical`, `Important`, or `Minor` severity, exact `file:line`, evidence, impact, and correction. Do not fix it.

### Step 3: Run focused verification

Run these commands without mutating the index or worktree:

```bash
TMPDIR=/data/home/guest/tmp/pi-webui-speech-timeout-recovery-4 npm test -- --run src/server/speechInput/speechInputPolishingService.test.ts src/server/speechInput/speechInputPolishingRoutes.test.ts
TMPDIR=/data/home/guest/tmp/pi-webui-speech-timeout-recovery-4 npm run typecheck
TMPDIR=/data/home/guest/tmp/pi-webui-speech-timeout-recovery-4 npx eslint src/shared/speechInputPolishing.ts src/server/speechInput/speechInputPolishingService.ts src/server/speechInput/speechInputPolishingService.test.ts src/server/speechInput/speechInputPolishingRoutes.ts src/server/speechInput/speechInputPolishingRoutes.test.ts
npm run changelog:status
npm run verify:staged
git diff --check d67ef99c18b7b3e095e928b123cd35b2e1891635^ d67ef99c18b7b3e095e928b123cd35b2e1891635
git diff --check
git status --short --untracked-files=all
```

Record test counts and actual exits. Do not run packaging if it would mutate generated files; if running `npm run pack:dry` is safe, verify no `dist` or `CHANGELOG.md` changes afterward.

### Step 4: Write the report immediately

Write exactly one report at the controller-provided `reportPath`, then return exactly one status token. Do not perform additional broad audits after writing it:

```text
STATUS: DONE

CHANGES:
- Source changes: none; this was a read-only audit.

TESTS:
- <command>: <actual result and counts>

FINDINGS:
- id: F-<n>
  severity: Critical | Important | Minor
  location: path/to/file.ts:42
  evidence: <observation>
  impact: <consequence>
  correction: <resolution>

EVIDENCE:
- <HEAD/status, exact six-file diff, 25_000 < 30_000, protected amendment, no commit>
```

Use an empty `FINDINGS:` list when no finding exists. Do not include a `COMMIT:` line. State F-001 is resolved only if the source and tests prove the five-second margin. Write no second deliverable.

### Step 5: Defer broader review

The controller compares the child’s first message byte-for-byte with the persisted rendered prompt before correlation or report admission. The derived task reviewer independently checks this exact correction range. After task approval, the mandatory Frontier final reviewer audits `780c3fc1d98e2533d166f694469deccfb93008b8..HEAD`, including browser, Settings, daemon, transport, persistence, security, documentation, and Changeset boundaries. Any load-bearing defect requires a separate remediation plan; this task never edits product files.
