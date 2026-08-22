# Speech Input Transcript Polishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add default-enabled, user-configurable voice-transcript polishing through the gateway's configured lightweight utility model, with strict contracts, cancellation, raw fallback, and visible settings.

**Architecture:** Persist the preference in gateway speech settings, expose it through a versioned redacted settings contract, and send one-shot polish requests through a gateway-only route to the local session daemon. The daemon reuses its existing authenticated `ModelRuntime` and lightweight utility resolver without creating session state. The browser controller owns the polish phase, aborts stale work, and falls back to raw text only on genuine polish failure.

**Tech Stack:** TypeScript, Fastify, Lit, CodeMirror, Vitest, Pi `ModelRuntime`, existing PI WEBUI config mutation coordinator and session-daemon proxy.

## Global Constraints

- Polishing is enabled by default when `polishVoiceInput` is omitted from persisted configuration or a legacy version-1 response.
- A polish failure inserts the raw transcript only when the existing editor insertion callback reports `inserted`; otherwise the existing insertion outcome error is preserved.
- The gateway-only polish endpoint has a two-request admission limit, bounded JSON body/response sizes, `Cache-Control: no-store`, and a 30-second server/client deadline.
- Browser request cancellation and disconnect must propagate through the gateway proxy and session-daemon client to the daemon model call.
- The lightweight model call uses no retries, no prompt caching, a bounded output budget, and accepts only a normal `stop` result with text content.
- No new runtime dependencies may be added; do not expose transcript, prompt, provider response, or credential material in logs or error responses.
- Changes affecting session-daemon routes or code require informing the user that the long-lived session daemon needs a manual restart.

## Task 1: Extend the speech settings contract

**Implementer tier:** Advanced

**Files:**

- Modify: `src/shared/apiTypes.ts`
- Modify: `src/shared/speechInput.ts`
- Modify: `src/server/speechInput/speechInputSettingsService.ts`
- Modify: `src/client/src/api/parsers.ts`
- Modify: `src/client/src/components/settings/settingsConfigDraft.ts`
- Test: `src/shared/speechInput.test.ts`
- Test: `src/server/speechInput/speechInputSettingsService.test.ts`
- Test: `src/client/src/api/parsers.test.ts`
- Test: `src/client/src/components/settings/settingsConfigDraft.test.ts`

**Interfaces:**

- Consumes: existing `PiWebUiSpeechInputConfig`, `SpeechInputSettings`, `SpeechInputSettingsResponse`, and `SpeechInputSettingsUpdate` contracts plus `effectiveSpeechInputSettings()` and the revision-checked settings service.
- Produces: `polishVoiceInput?: boolean` in persisted config; `polishVoiceInput: boolean` in effective settings; version-2 settings responses; legacy version-1 response parsing with default `true`; optional update parsing whose omission preserves the current effective value; and draft/update conversion carrying the boolean explicitly.

- [ ] **Step 1: Write failing tests**

Add assertions for default `true`, explicit `false`, version-1 parser compatibility, strict version-2 boolean validation, draft round-trip, persistence of `false`, and an omitted update preserving a current explicit `false`.

- [ ] **Step 2: Run focused tests and confirm they fail for the missing contract**

Run: `npm test -- --run src/shared/speechInput.test.ts src/server/speechInput/speechInputSettingsService.test.ts src/client/src/api/parsers.test.ts src/client/src/components/settings/settingsConfigDraft.test.ts`

- [ ] **Step 3: Implement the smallest contract changes**

Add the optional persisted key, default it in the effective helper, version the response type/service to `2`, preserve the current value when an update omits the field, and update strict parsers/draft conversion without changing credential revision semantics.

- [ ] **Step 4: Re-run focused tests and typecheck**

Run the same Vitest command, then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/shared/apiTypes.ts src/shared/speechInput.ts src/server/speechInput/speechInputSettingsService.ts src/client/src/api/parsers.ts src/client/src/components/settings/settingsConfigDraft.ts src/shared/speechInput.test.ts src/server/speechInput/speechInputSettingsService.test.ts src/client/src/api/parsers.test.ts src/client/src/components/settings/settingsConfigDraft.test.ts
git commit -m "feat(speech): add transcript polishing setting contract"
```

## Task 2: Add the daemon polishing service

**Implementer tier:** Frontier

**Files:**

- Create: `src/server/speechInput/speechInputPolishingService.ts`
- Modify: `src/server/sessiond.ts`
- Test: `src/server/speechInput/speechInputPolishingService.test.ts`

**Interfaces:**

- Consumes: `UtilityModelResolver.configuredCandidates("lightweight")`, candidate `{ model, thinkingLevel }`, and a structural `ModelRuntime.completeSimple(model, context, options)` collaborator.
- Produces: `SpeechInputPolishingService.polish(text: string, signal?: AbortSignal): Promise<string>`; typed safe failures; a fixed conservative system prompt; bounded `completeSimple` options; and session-daemon construction using the existing `auth.runtime` and `utilityModelResolver`.

- [ ] **Step 1: Write failing service tests**

Cover lightweight candidate selection, exact system/user context, signal/options, text extraction while ignoring thinking blocks, rejection of tool calls and every non-`stop` reason, empty/oversized output, no candidates, and no session-manager interaction.

- [ ] **Step 2: Run the service test and confirm the module/behavior fails**

Run: `npm test -- --run src/server/speechInput/speechInputPolishingService.test.ts`

- [ ] **Step 3: Implement the service and daemon composition**

Use candidates in resolver order, return the first valid result, map failures to safe typed errors, and register the daemon route dependency in the existing startup runtime object without constructing a Pi session.

- [ ] **Step 4: Run focused service tests and typecheck**

Run the service test and `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/server/speechInput/speechInputPolishingService.ts src/server/sessiond.ts src/server/speechInput/speechInputPolishingService.test.ts
git commit -m "feat(speech): add daemon transcript polishing service"
```

## Task 3: Add gateway and daemon polish routes with abort propagation

**Implementer tier:** Frontier

**Files:**

- Create: `src/server/speechInput/speechInputPolishingRoutes.ts`
- Modify: `src/sessiond/sessionDaemonClient.ts`
- Modify: `src/server/sessiond/sessionProxyRoutes.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/sessiond.ts`
- Test: `src/server/speechInput/speechInputPolishingRoutes.test.ts`
- Test: `src/sessiond/sessionDaemonClient.test.ts`

**Interfaces:**

- Consumes: `SpeechInputPolishingService.polish()`, `SessionProxyDaemon.request()`, Fastify request/reply lifecycle events, and the session daemon client’s Unix/TCP transports.
- Produces: gateway-only `POST /api/speech-input/polish`, daemon `POST /speech-input/polish`, strict bounded `{ text }` request/response parsing, two-request pre-parse admission, safe status mapping, no-store headers, 30-second deadlines, and signal-aware `SessionDaemonClient.request()`.

- [ ] **Step 1: Write failing route/client tests**

Cover valid forwarding, exact path/body, no local-machine route, malformed/unknown/empty/oversized bodies, response validation, safe error mapping, pre-parse admission rejection, no-store headers, client disconnect/abort propagation, deadline cleanup, and Unix/TCP request signal behavior.

- [ ] **Step 2: Run focused route/client tests and confirm expected failures**

Run: `npm test -- --run src/server/speechInput/speechInputPolishingRoutes.test.ts src/sessiond/sessionDaemonClient.test.ts`

- [ ] **Step 3: Implement the route and signal-aware transport**

Add isolated route registration functions, lifecycle cleanup with exactly-once admission release, abort-aware fetch/http requests, strict parsers, and safe error responses. Register the daemon route only in sessiond and the gateway route only under `/api`.

- [ ] **Step 4: Run focused tests and typecheck**

Run the same Vitest command and `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/server/speechInput/speechInputPolishingRoutes.ts src/sessiond/sessionDaemonClient.ts src/server/sessiond/sessionProxyRoutes.ts src/server/app.ts src/server/sessiond.ts src/server/speechInput/speechInputPolishingRoutes.test.ts src/sessiond/sessionDaemonClient.test.ts
git commit -m "feat(speech): route transcript polishing through sessiond"
```

## Task 4: Integrate polishing into the speech controller and client API

**Implementer tier:** Frontier

**Files:**

- Modify: `src/client/src/api/clients.ts`
- Modify: `src/client/src/controllers/speechInputController.ts`
- Modify: `src/client/src/components/PromptEditor.ts`
- Test: `src/client/src/api/clients.test.ts`
- Test: `src/client/src/controllers/speechInputController.test.ts`
- Test: `src/client/src/components/PromptEditor.speechInput.test.ts`

**Interfaces:**

- Consumes: `speechInputApi.polish(text, signal)`, effective `SpeechInputSettings`, existing provider callbacks, and `onFinal()` outcomes.
- Produces: `SpeechInputControllerState` kind `polishing`; an injected polisher; per-run snapshot/abort/deadline ownership; successful polished insertion; disabled direct insertion; raw fallback with outcome-aware error; and stale/cancellation suppression for Browser and Cloud final results.

- [ ] **Step 1: Write failing controller/API/UI-boundary tests**

Cover exact request signal/body, successful Browser and Cloud polishing, disabled mode, state publication, timeout fallback, service failure fallback, explicit cancellation, late response suppression, settings snapshot, and non-inserted fallback outcomes.

- [ ] **Step 2: Run focused tests and confirm failures**

Run: `npm test -- --run src/client/src/api/clients.test.ts src/client/src/controllers/speechInputController.test.ts src/client/src/components/PromptEditor.speechInput.test.ts`

- [ ] **Step 3: Implement controller/API integration**

Add a production polisher dependency using the API client, retain the active run during polishing, invalidate before aborting, and map only a successful raw insertion to the requested fallback message.

- [ ] **Step 4: Run focused tests and typecheck**

Run the same Vitest command and `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/api/clients.ts src/client/src/controllers/speechInputController.ts src/client/src/components/PromptEditor.ts src/client/src/api/clients.test.ts src/client/src/controllers/speechInputController.test.ts src/client/src/components/PromptEditor.speechInput.test.ts
git commit -m "feat(speech): polish dictated transcripts before insertion"
```

## Task 5: Add the checkbox, documentation, changeset, and verification

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/settings/SettingsGeneralPanel.ts`
- Modify: `src/client/src/components/settings/SettingsGeneralPanel.test.ts`
- Modify: `docs/config.md`
- Modify: `docs/config.html`
- Create: `.changeset/speech-input-polishing.md`

**Interfaces:**

- Consumes: `SpeechInputSettingsDraft.polishVoiceInput`, `speechInputUpdateFromDraft()`, and the controller’s `polishing`/fallback state rendering.
- Produces: an accessible checked-by-default checkbox with accurate provider disclosure, persisted draft/save behavior, synchronized configuration documentation, and a minor user-facing Changeset.

- [ ] **Step 1: Write failing panel/documentation assertions**

Assert the checkbox, checked state, disclosure text, draft update, and outbound saved boolean; inspect paired documentation sections for the new default and provider boundary.

- [ ] **Step 2: Run focused UI/document checks and confirm failures**

Run: `npm test -- --run src/client/src/components/settings/SettingsGeneralPanel.test.ts`; inspect documentation links/content.

- [ ] **Step 3: Implement UI, docs, and Changeset**

Add the checkbox under Speech input, retain existing stale/credential behavior, update both config references without README expansion, and add a concise minor Changeset.

- [ ] **Step 4: Run full verification**

Run focused tests, `npm run typecheck`, targeted ESLint, `npm run verify:fast`, `git diff --check`, and finally `npm run verify` serially.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/settings/SettingsGeneralPanel.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts docs/config.md docs/config.html .changeset/speech-input-polishing.md
git commit -m "feat(speech): expose transcript polishing preference"
```
