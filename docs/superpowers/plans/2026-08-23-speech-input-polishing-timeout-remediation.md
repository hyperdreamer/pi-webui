# Speech Input Polishing Timeout Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Resolve carried finding `F-001` by bounding each speech-polishing provider request below the route deadline while preserving cancellation and retry/cache behavior.

**Architecture:** Introduce one shared module for the speech-polishing route and provider budgets. Keep the Fastify route as the owner of HTTP lifecycle cleanup and the service as the owner of model-call options; neither imports the other. Re-export the route budget from its existing server module so current consumers remain source-compatible.

**Tech Stack:** TypeScript, Vitest, Fastify, Pi `ModelRuntime`, Changesets, deterministic SDD state machine.

## Global Constraints

- This is a successor remediation for `F-001` from `.sdd/speech-input-polishing-review-recovery-5-20260822`; preserve that run, all predecessor recovery roots, their reports, receipts, prompts, transcripts, and terminal state as historical evidence only.
- Preserve the intentional unstaged amendment to `docs/superpowers/plans/2026-08-22-speech-input-polishing.md`; do not stage, overwrite, stash, reset, or commit it.
- The shared constants must be `SPEECH_INPUT_POLISHING_ROUTE_TIMEOUT_MS = 30_000` and `SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS = 25_000`; the model budget must remain strictly below the route budget and the five-second margin must be documented in a concise code comment.
- `SpeechInputPolishingService` must pass `timeoutMs: SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS` while retaining the caller `signal`, `maxRetries: 0`, `cacheRetention: "none"`, and bounded `maxTokens` behavior.
- Do not modify browser speech/controller code, Settings code, daemon route registration, session transport, credentials, persistence, logging, dependencies, README, `CHANGELOG.md`, or unrelated configuration.
- Add one patch Changeset for the bounded speech-polishing request lifecycle; do not manually edit `CHANGELOG.md`.
- The implementer must use test-first order: add the timeout regression assertion, run it red for the missing behavior, then implement the smallest correction and run it green.
- Any change to `src/server/speechInput/speechInputPolishingService.ts` is loaded by the long-lived session daemon; the final handoff must tell the user to manually restart `pi-webui-sessiond.service`.

## Task 1: Bound Speech Polishing Provider Requests

**Implementer tier:** Advanced

**Files:**

- Create: `src/shared/speechInputPolishing.ts`
- Modify: `src/server/speechInput/speechInputPolishingService.ts`
- Modify: `src/server/speechInput/speechInputPolishingRoutes.ts`
- Modify: `src/server/speechInput/speechInputPolishingService.test.ts`
- Modify: `src/server/speechInput/speechInputPolishingRoutes.test.ts`
- Create: `.changeset/speech-input-polishing-timeout.md`

**Interfaces:**

- Consumes: the existing `SpeechInputPolishingService.polish(text: string, signal?: AbortSignal): Promise<string>` contract, `ModelRuntime.completeSimple(model, context, options)`, the existing `SPEECH_INPUT_POLISHING_ROUTE_TIMEOUT_MS` export from `speechInputPolishingRoutes.ts`, and `ModelsSimpleStreamOptions` provider options.
- Produces: `SPEECH_INPUT_POLISHING_ROUTE_TIMEOUT_MS` and `SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS` from `src/shared/speechInputPolishing.ts`; an existing-route re-export of the route budget; and a service call that passes the explicit model timeout while preserving all existing safe extraction, fallback, signal, retry, and cache semantics.

### Step 1: Add the failing regression assertions

In `src/server/speechInput/speechInputPolishingService.test.ts`, extend the existing bounded-options test so it imports `SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS` and expects `received.options` to contain `timeoutMs` equal to that constant. Also assert that the model timeout is less than the route timeout by importing `SPEECH_INPUT_POLISHING_ROUTE_TIMEOUT_MS` from the existing route module. In `src/server/speechInput/speechInputPolishingRoutes.test.ts`, import the shared route budget directly and assert that the existing route export equals it. Keep the existing cancellation test and signal assertion unchanged so the regression covers both finite provider timeout and caller cancellation.

### Step 2: Run the focused tests and observe the intended red failure

Run:

```bash
npm test -- --run src/server/speechInput/speechInputPolishingService.test.ts src/server/speechInput/speechInputPolishingRoutes.test.ts
```

The run must fail because the shared module and explicit service timeout are not present yet. If it fails for an unrelated import, assertion, or environment error, correct the test setup and rerun until the missing-timeout failure is the observed cause.

### Step 3: Implement the shared budget and service wiring

Create `src/shared/speechInputPolishing.ts` with exactly these exported budgets and a short reason for the margin:

```ts
export const SPEECH_INPUT_POLISHING_ROUTE_TIMEOUT_MS = 30_000;
// Reserve five seconds for abort propagation, cleanup, and the HTTP response after the provider deadline.
export const SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS = 25_000;
```

Update `src/server/speechInput/speechInputPolishingRoutes.ts` to import the shared route budget for its deadline and re-export that symbol so existing imports remain valid. Update `src/server/speechInput/speechInputPolishingService.ts` to import the shared model budget and add `timeoutMs: SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS` to the existing `ModelsSimpleStreamOptions` object. Do not import the route module into the service, duplicate the timeout literal, alter `raceWithAbort`, add retries, or change error text and candidate fallback behavior.

Create `.changeset/speech-input-polishing-timeout.md` with valid frontmatter for `"@hyperdreamer/pi-webui": patch` and a concise user-facing note explaining that speech-polishing requests now stop within the bounded gateway lifecycle.

### Step 4: Verify the correction and unchanged boundaries

Run the focused service/route tests again, then run:

```bash
npm run typecheck
npx eslint src/shared/speechInputPolishing.ts src/server/speechInput/speechInputPolishingService.ts src/server/speechInput/speechInputPolishingRoutes.ts src/server/speechInput/speechInputPolishingService.test.ts src/server/speechInput/speechInputPolishingRoutes.test.ts
npm run changelog:status
npm run pack:dry
npm run verify:staged
npm run verify:fast
git diff --check
```

Confirm the diff contains only the six files listed for this task, aside from the new successor SDD artifacts outside the product correction. Confirm the intentional dirty original plan amendment remains unstaged and unchanged, the historical recovery roots are untouched, and no generated `dist` artifact or `CHANGELOG.md` modification remains.

### Step 5: Commit the correction

```bash
git add src/shared/speechInputPolishing.ts src/server/speechInput/speechInputPolishingService.ts src/server/speechInput/speechInputPolishingRoutes.ts src/server/speechInput/speechInputPolishingService.test.ts src/server/speechInput/speechInputPolishingRoutes.test.ts .changeset/speech-input-polishing-timeout.md
git commit -m "fix(speech): bound polishing provider requests"
```

The implementer report must include the correction commit SHA, focused and broad verification results, and an explicit statement that `F-001` is addressed by the shared five-second timeout margin.
