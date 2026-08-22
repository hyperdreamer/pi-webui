# Speech Input Transcript Polishing Continuation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Independently audit the committed Speech Input settings and daemon service after the predecessor SDD mismatch, then complete gateway routing, browser insertion, settings UI, documentation, and release evidence.

**Architecture:** The predecessor run is sealed and its source commits are carried forward as a candidate. A first read-only task audits the exact existing settings and daemon ranges and establishes a fresh review boundary. Later tasks add a gateway-only polish route that proxies to the local session daemon, a cancellable browser controller phase, and the user-facing settings/documentation surfaces.

**Tech Stack:** TypeScript, Fastify, Lit, CodeMirror, Vitest, Node.js, the existing Pi `ModelRuntime`, Unix/TCP session-daemon transports, and Changesets.

## Global Constraints

- Work only in `/data/home/guest/Development/pi-webui/.worktrees/speech-input-polishing` on branch `speech-input-polishing`.
- The predecessor run at `.sdd/speech-input-polishing-relocated-20260822/` is terminal in `DISPATCH_MISMATCH_BLOCKED`; preserve its state, progress ledger, prompts, reports, packages, and receipts unchanged, and never use its mismatched child report or verdict as correctness evidence.
- The carried-forward candidate settings range is `780c3fc1d98e2533d166f694469deccfb93008b8..b8be7851c438eea2911346c1cc355ceb7e9582e7`.
- The carried-forward candidate daemon-service range is `b8be7851c438eea2911346c1cc355ceb7e9582e7..1885278e65eadc0f5c4a0f72cb1483fd8ef5cc40`.
- The complete carried-forward candidate range is `780c3fc1d98e2533d166f694469deccfb93008b8..1885278e65eadc0f5c4a0f72cb1483fd8ef5cc40`; Git source and fresh verification, not predecessor reports, are authoritative.
- Polishing is enabled by default when `polishVoiceInput` is omitted, and explicit `false` must survive persisted config and settings updates.
- Browser recognition and Cloud transcription final results use the same polishing path; no Local speech provider is added.
- Polishing is gateway-scoped to the local WebUI/session-daemon machine. Do not expose a selected-machine or federated polishing route.
- The gateway-owned browser endpoint is `POST api/speech-input/polish` with `{ text }`; the daemon endpoint is `POST /speech-input/polish` with the same bounded body. Resolve application-relative browser references exactly once through the repository URL helpers.
- The successful endpoint returns only the polished text required by the requesting browser. Errors, logs, telemetry, persistence, and unrelated responses must not expose transcript text, polished text, prompts, provider bodies, credential sources, or resolved credentials.
- The exact user-visible fallback message is `Voice input polishing failed; inserted the raw transcript.` and it is shown only after a genuine polish failure when the raw editor insertion result is `inserted`.
- The service accepts only a normal assistant `stop` result with nonempty bounded text, ignores thinking blocks, rejects tools and all other stop reasons, uses only configured `lightweight` candidates in resolver order, and uses no retries or prompt caching.
- The polish route has a two-request admission limit before body parsing, strict bounded JSON request/response validation, `Cache-Control: no-store`, and a 30-second monotonic deadline. Browser disconnect, gateway abort, transport abort, daemon disconnect, shutdown, and deadline cancellation must reach the model call and clean up listeners/timers exactly once.
- No polish operation creates a Pi session, session archive, prompt history entry, workspace file, draft, or transcript record, and no automatic prompt submission is added.
- No new runtime dependencies may be added. Preserve existing credential revision semantics, generic session proxy behavior, and unrelated selected-machine routes.
- Any change to `src/server/sessiond.ts`, session-daemon routes/protocol, or code loaded only by the long-lived daemon requires telling the user that `pi-webui-sessiond.service` needs a manual restart.
- Every child prompt must be rendered and persisted before dispatch, the exact persisted bytes must be passed to the child, and the child's first user message must be compared byte-for-byte with those bytes before admitting its report. Preserve each continuation run root and never hand-edit `state.json` or `progress.md`.

## Task 1: Audit The Carried-Forward Settings And Daemon Ranges

**Implementer tier:** Capable

**Files:**

- Verify: `780c3fc1d98e2533d166f694469deccfb93008b8..b8be7851c438eea2911346c1cc355ceb7e9582e7`
- Verify: `b8be7851c438eea2911346c1cc355ceb7e9582e7..1885278e65eadc0f5c4a0f72cb1483fd8ef5cc40`
- Verify: `src/config.ts`, `src/config.test.ts`, `src/shared/apiTypes.ts`, `src/shared/speechInput.ts`, `src/shared/speechInput.test.ts`
- Verify: `src/server/speechInput/speechInputSettingsService.ts`, `src/server/speechInput/speechInputSettingsService.test.ts`, `src/server/speechInput/speechInputSettingsRoutes.test.ts`, `src/server/app.speechInput.test.ts`
- Verify: `src/server/speechInput/speechInputPolishingService.ts`, `src/server/speechInput/speechInputPolishingService.test.ts`, `src/server/sessiond.ts`
- Verify: related client parser/draft/panel tests in `src/client/src/api/parsers.test.ts`, `src/client/src/components/settings/settingsConfigDraft.test.ts`, and `src/client/src/components/settings/SettingsGeneralPanel.test.ts`
- Do not modify product source, tests, package metadata, plans, specs, the index, or `HEAD`; create only the required report and other per-run artifacts under the continuation run root.

**Interfaces:**

- Consumes: the exact carried-forward Git ranges, the approved speech-polishing design, the existing settings/API contracts, and the daemon service contract.
- Produces: one independently evidenced implementer report with source identity, changed-file scope, protected-path results, fresh test/typecheck/lint results, and any concrete concern.
- Produces no product commit or source change. The daemon service's construction in `sessiond.ts` is an intentional dependency handoff for Task 2; absence of its HTTP route is not a Task 1 audit defect because the route is implemented later.

- [ ] **Step 1: Establish the immutable audit boundary**

Run `git status --short`, verify both range endpoints, verify that both ranges are descendants of the feature base, record the current branch and `HEAD`, list changed files for each range and the complete range, and run `git diff --check` for each range and the working tree. Confirm the only pre-existing dirty source-adjacent file is the intentional unstaged amendment to the predecessor plan and that no source file is modified by the audit.

- [ ] **Step 2: Independently inspect the settings contract and service**

Read the exact source and tests directly. Verify default-on effective settings, explicit-false persistence and omitted-update preservation, strict versioned browser contracts, credential redaction/revision behavior, lightweight-only candidate selection, conservative prompt context, bounded options, text/thinking extraction, rejection of tools/non-stop/empty/oversized outputs, typed unavailable/cancelled failures, and no session-manager/persistence interaction. Verify `sessiond.ts` constructs the service from `auth.runtime` and `utilityModelResolver` without creating a route or session state. Confirm the complete candidate range changes only the intended settings/service files and tests, with no dependency, release, selected-machine, or unrelated source changes.

- [ ] **Step 3: Run fresh audit verification**

Run:

```bash
npm run test:serial -- --run src/config.test.ts src/shared/speechInput.test.ts src/server/speechInput/speechInputSettingsService.test.ts src/server/speechInput/speechInputSettingsRoutes.test.ts src/server/app.speechInput.test.ts src/client/src/api/parsers.test.ts src/client/src/components/settings/settingsConfigDraft.test.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts src/server/speechInput/speechInputPolishingService.test.ts
npm run typecheck
npx eslint src/config.ts src/config.test.ts src/shared/apiTypes.ts src/shared/speechInput.ts src/shared/speechInput.test.ts src/server/speechInput/speechInputSettingsService.ts src/server/speechInput/speechInputSettingsService.test.ts src/server/speechInput/speechInputSettingsRoutes.test.ts src/server/app.speechInput.test.ts src/server/speechInput/speechInputPolishingService.ts src/server/speechInput/speechInputPolishingService.test.ts src/server/sessiond.ts
git diff --check 780c3fc1d98e2533d166f694469deccfb93008b8..1885278e65eadc0f5c4a0f72cb1483fd8ef5cc40
git diff --check
```

Record actual results and distinguish environment failures from candidate defects. Do not modify source to make the audit pass.

- [ ] **Step 4: Write the read-only audit report**

Write exactly one implementer report with `STATUS: DONE` only when the audit completed, including exact SHAs, changed-file lists, protected-path results, commands and results, and an explicit statement that the predecessor mismatched report and verdict were not used as correctness evidence. If a concrete concern exists, state its file and line; do not repair it in this task.

- [ ] **Step 5: Commit boundary**

Do not create a commit. Inspect `git status --porcelain` and the exact candidate diffs before reporting. Only ignored per-run artifacts may have been created by this task.

## Task 2: Add Gateway And Session-Daemon Polish Routes

**Implementer tier:** Frontier

**Files:**

- Create: `src/server/speechInput/speechInputPolishingRoutes.ts`
- Modify: `src/sessiond/sessionDaemonClient.ts`
- Modify: `src/server/sessiond/sessionProxyRoutes.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/sessiond.ts`
- Test: `src/server/speechInput/speechInputPolishingRoutes.test.ts`
- Test: `src/sessiond/sessionDaemonClient.test.ts`
- Test: `src/server/sessiond/sessionProxyRoutes.test.ts`
- Test: `src/server/app.speechInput.test.ts`

**Interfaces:**

- Consumes: `SpeechInputPolishingService.polish(text: string, signal?: AbortSignal): Promise<string>`, `SessionProxyDaemon.request(method, path, body?, signal?)`, Fastify request/reply lifecycle events, and the existing Unix/TCP daemon transports.
- Produces: gateway-only `POST /api/speech-input/polish`, daemon-only `POST /speech-input/polish`, strict bounded `{ text }` request/response parsing, signal-aware daemon transport, safe status mapping, no-store headers, two-request pre-parse admission, and a 30-second deadline.
- Does not produce: `/api/machines/local/speech-input/polish`, a selected-machine route, a new machine/federation proxy, a session API, or persisted transcript state.

- [ ] **Step 1: Write failing route and transport tests**

Add tests before production edits. Cover valid daemon invocation and gateway forwarding with exact path/body; rejection of malformed, unknown-key, empty, non-string, and oversized JSON; response validation and bounded output; safe mapping of unavailable, malformed, timeout, and transport failures without transcript/provider content; `Cache-Control: no-store`; two-request admission rejection before body parsing and admission release on success, failure, close, abort, and parse rejection; absence of the selected-machine polish route; request-close and explicit-abort propagation; 30-second deadline cleanup; and both Unix and TCP client request cancellation behavior.

- [ ] **Step 2: Run the focused tests and confirm the expected red failure**

Run `npm test -- --run src/server/speechInput/speechInputPolishingRoutes.test.ts src/sessiond/sessionDaemonClient.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/server/app.speechInput.test.ts` and confirm failure is caused by the missing route/signal contract rather than a test typo.

- [ ] **Step 3: Implement the daemon route, gateway route, and abort-aware transport**

Use a small strict parser that accepts exactly `{ text: string }`, enforces the existing transcript UTF-8 bound, rejects blank input, and never places input or provider output in errors. Register the daemon route only in the session-daemon route set and call the already-composed polishing service with a signal owned by the request lifecycle. Register the browser route only at `/api/speech-input/polish`, proxying to the local daemon path with the gateway request signal; do not add it to the `/api/machines/local` session proxy registration. Add the two-request admission guard before body parsing, no-store headers on success and failure, monotonic deadline timers below the route deadline, exactly-once cleanup, and stable status mapping. Extend `SessionDaemonClient.request()` and `SessionProxyDaemon.request()` with an optional `AbortSignal`; use it with `fetch` for TCP/HTTP and destroy the Node HTTP request on abort for Unix sockets, removing listeners after settlement.

- [ ] **Step 4: Run scoped verification**

Run the focused route/client suite again, then `npm run typecheck`, `npx eslint` over every changed route/client file, and `git diff --check`. Verify no response, log, or error path includes the request text or model/provider content.

- [ ] **Step 5: Commit**

```bash
git add src/server/speechInput/speechInputPolishingRoutes.ts src/sessiond/sessionDaemonClient.ts src/server/sessiond/sessionProxyRoutes.ts src/server/app.ts src/server/sessiond.ts src/server/speechInput/speechInputPolishingRoutes.test.ts src/sessiond/sessionDaemonClient.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/server/app.speechInput.test.ts
git commit -m "feat(speech): route transcript polishing through sessiond"
```

## Task 3: Integrate Polishing Into The Browser Controller

**Implementer tier:** Frontier

**Files:**

- Modify: `src/client/src/api/clients.ts`
- Modify: `src/client/src/controllers/speechInputController.ts`
- Modify: `src/client/src/components/PromptEditor.ts`
- Test: `src/client/src/api/clients.test.ts`
- Test: `src/client/src/controllers/speechInputController.test.ts`
- Test: `src/client/src/components/PromptEditor.speechInput.test.ts`

**Interfaces:**

- Consumes: the application-relative `api/speech-input/polish` endpoint, effective `SpeechInputSettings.polishVoiceInput`, existing Browser and Cloud final-transcript callbacks, and the existing `onFinal()` insertion outcome contract.
- Produces: `SpeechInputControllerState` kind `polishing`, an injected polisher/API client, per-run setting snapshots and abort/deadline ownership, successful polished insertion, disabled direct insertion, raw fallback, and stale/cancellation suppression.

- [ ] **Step 1: Write failing controller/API/UI-boundary tests**

Cover the exact application-relative polish request body and signal, response validation, successful Browser polishing, successful Cloud polishing through the same finalization path, disabled direct insertion, `polishing` state publication, a 30-second client deadline, service/unavailable fallback, explicit cancellation, newer-run and navigation invalidation, late-result suppression, settings snapshot behavior, empty raw transcript behavior, and changed/too-large/non-inserted raw insertion outcomes. Assert the exact fallback message only for a successful raw insertion.

- [ ] **Step 2: Run the focused tests and confirm failures**

Run `npm test -- --run src/client/src/api/clients.test.ts src/client/src/controllers/speechInputController.test.ts src/client/src/components/PromptEditor.speechInput.test.ts` and confirm the failures identify the missing polish API/controller/status behavior.

- [ ] **Step 3: Implement the controller and API integration**

Add a strict browser API client method that resolves the application-relative path once through the existing URL boundary and passes the caller signal. Add an injected polisher seam to the controller. Snapshot the effective setting at `start()`, retain the active run while polishing, publish `polishing`, and funnel Browser and Cloud final results through one finalization function. Invalidate the generation before aborting on cancel, dispose, replacement, navigation, a newer run, or deadline; never let late results call `onFinal()`. On a current successful polish, insert only the returned text. When disabled or raw text is empty, preserve the existing direct/no-speech path. On a genuine current failure, insert the original raw transcript and show `Voice input polishing failed; inserted the raw transcript.` only when insertion returns `inserted`; preserve existing changed, empty, and too-large errors otherwise. Do not submit the prompt automatically.

- [ ] **Step 4: Run scoped verification**

Run the focused client suite, `npm run typecheck`, `npx eslint` over changed client files, and `git diff --check`. Confirm the controller does not log or persist transcript/model content and that no selected-machine URL is generated.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/api/clients.ts src/client/src/controllers/speechInputController.ts src/client/src/components/PromptEditor.ts src/client/src/api/clients.test.ts src/client/src/controllers/speechInputController.test.ts src/client/src/components/PromptEditor.speechInput.test.ts
git commit -m "feat(speech): polish dictated transcripts before insertion"
```

## Task 4: Expose The Preference And Complete Verification

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/settings/SettingsGeneralPanel.ts`
- Modify: `src/client/src/components/settings/SettingsGeneralPanel.test.ts`
- Modify: `docs/config.md`
- Modify: `docs/config.html`
- Create: `.changeset/speech-input-polishing.md`

**Interfaces:**

- Consumes: `SpeechInputSettingsDraft.polishVoiceInput`, `speechInputUpdateFromDraft()`, the settings service/parser contract from the carried-forward candidate, and the controller's `polishing` and fallback states.
- Produces: an accessible checked-by-default Speech input checkbox, accurate lightweight-model provider disclosure, persisted draft/save behavior, synchronized configuration documentation, a minor user-facing Changeset, and final verification evidence.

- [ ] **Step 1: Write failing UI and documentation assertions**

Add or extend panel tests for the checkbox under Speech input, effective checked state, explicit boolean save payload, draft update, disclosure wording that enabling sends the captured transcript to the configured lightweight utility model and may use its provider, and existing stale/credential/save behavior. Inspect paired Markdown/HTML configuration sections for the new default, gateway scope, and no-session/no-persistence boundary.

- [ ] **Step 2: Run focused checks and confirm the missing UI/docs behavior**

Run `npm test -- --run src/client/src/components/settings/SettingsGeneralPanel.test.ts`, inspect the paired docs for matching claims and links, and confirm the new assertions fail before implementation.

- [ ] **Step 3: Implement the checkbox, disclosure, docs, and Changeset**

Add the checkbox under Speech input using the existing settings form conventions. Keep it checked when the effective boolean is true and always include the boolean in new save payloads. State plainly that polishing sends captured transcript text to the configured lightweight utility model for conservative cleanup; do not claim that the model is local or selected-machine scoped. Update `docs/config.md` and `docs/config.html` consistently without expanding `README.md`. Create `.changeset/speech-input-polishing.md` with a minor bump for the new user-facing feature and do not edit `CHANGELOG.md`.

- [ ] **Step 4: Run complete verification**

Run the focused settings/controller/route/service suites, `npm run typecheck`, targeted ESLint, `npm run verify:fast`, `git diff --check`, and finally `npm run verify` serially. Confirm the Changeset/package status is valid, no production dependency was added, no transcript content appears in logs/errors, and the only uncommitted file left is the intentionally preserved predecessor-plan amendment if it remains outside the committed feature changes.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/settings/SettingsGeneralPanel.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts docs/config.md docs/config.html .changeset/speech-input-polishing.md
git commit -m "feat(speech): expose transcript polishing preference"
```

## Completion Boundary

After Task 4 receives independent review approval, dispatch a fresh Frontier final reviewer across `780c3fc1d98e2533d166f694469deccfb93008b8..HEAD`. The final review must verify the carried-forward settings/service ranges from source, gateway-only route and abort propagation, controller Browser/Cloud convergence, exact fallback semantics, default-on compatibility, UI disclosure, docs/Changeset, no session/transcript persistence, no selected-machine route, and clean verification. Complete only with `SPEC: PASS`, `QUALITY: APPROVED`, no open load-bearing finding, a reconciled finding ledger, clean source state, and audit status `OK`.
