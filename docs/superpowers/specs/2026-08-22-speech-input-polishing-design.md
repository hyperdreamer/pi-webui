# Speech Input Transcript Polishing Design

**Date:** 2026-08-22

## Goal

Add a persistent Speech Input preference that lets users choose whether Browser and Cloud dictation transcripts are cleaned up by the configured lightweight utility model before insertion into the prompt editor.

Polishing is enabled by default, including when the preference is absent from an existing configuration.

## Non-Goals

- Do not add a Local speech capture provider.
- Do not route the polish request through a selected remote coding machine.
- Do not create a Pi session, session archive, prompt history entry, workspace file, draft entry, or transcript record for polishing.
- Do not expose credential sources, resolved credentials, transcript text, or model prompt content in browser responses or logs.
- Do not perform broad rewriting, summarization, requirement inference, or automatic prompt submission.

## Architecture

Speech polishing is gateway-scoped. The browser calls a gateway-owned application-relative endpoint, and the web/API process proxies that request to the local session daemon. The session daemon already owns the authenticated `ModelRuntime` and utility-model resolver, so it performs the model call without duplicating credential or model configuration ownership in the web process.

The session daemon creates a small in-memory `SpeechInputPolishingService` during startup from the existing `ModelRuntime` and `UtilityModelResolver`. Its only model candidate source is `configuredCandidates("lightweight")`; it never uses the active coding-session model or the `context` utility slot. The service calls `ModelRuntime.completeSimple` with a system prompt and one user message, then returns plain text extracted from the assistant response. No Pi session APIs are used.

The browser `SpeechInputController` owns the asynchronous polish phase. The capture adapters remain provider-specific and report raw final text. The controller captures the effective polish preference when a run starts, waits for polishing after a final transcript arrives, and performs the existing editor insertion callback only after polishing succeeds or falls back to raw text.

## Configuration And Settings API

The persisted gateway config accepts an optional boolean:

```typescript
interface PiWebUiSpeechInputConfig {
  polishVoiceInput?: boolean;
}
```

`effectiveSpeechInputSettings` returns a required boolean with `true` as the default. Existing config files are not migrated merely to materialize the default. A successful settings save may persist the explicit value.

The redacted settings response uses contract version 2 and includes the effective boolean. The browser parser continues to accept a version-1 response and supplies `true` when the legacy field is absent. The update body keeps the field optional for older clients; when it is omitted, the revision-checked server mutation preserves the current effective value rather than assuming `true`. New clients always submit the field explicitly. A version-1 server response remains readable by a new client, while a version-2 response is intentionally not claimed to be readable by an un-upgraded strict client.

```typescript
interface SpeechInputSettings {
  provider: "auto" | "browser" | "cloud";
  language?: string;
  polishVoiceInput: boolean;
  cloud: { baseUrl: string; model: string };
}

interface SpeechInputSettingsResponse {
  contractVersion: 2;
  revision: string;
  settings: SpeechInputSettings;
  credential: SpeechInputCredentialStatus;
}
```

The server update parser accepts an omitted `polishVoiceInput` field as an optional legacy value, rejects a present non-boolean value, and continues rejecting unknown fields. The browser response parser accepts contract version 1 with default `true` and version 2 with a required boolean. The Settings General panel renders a checkbox under **Speech input**. It is checked when the effective value is true and participates in the existing draft, optimistic revision, stale-form, credential, and save behavior. The disclosure states that enabling the option sends the captured transcript to the configured lightweight utility model for conservative cleanup; that model may be hosted by the configured provider rather than running locally on the gateway.

## Polishing HTTP Contract

The browser uses:

```text
POST api/speech-input/polish
Content-Type: application/json

{ "text": "raw dictated transcript" }
```

The gateway proxies the request to the local session daemon as `/speech-input/polish`. There is no selected-machine or federated equivalent.

The successful response intentionally returns the polished text to the requesting browser so it can insert the result. Privacy restrictions apply to errors, unrelated API responses, persistence, telemetry, and logs: none may echo the raw transcript, polished transcript, model prompt, provider response body, credential source, or resolved credential. The UI disclosure must accurately state that the gateway sends transcript text to the configured lightweight-model provider when polishing is enabled.

The endpoint is gateway-only and remains an administrative surface under PI WEBUI's existing access model. It has a bounded admission limit of two requests before body parsing, a JSON body limit slightly above `SPEECH_INPUT_MAX_TRANSCRIPT_BYTES` for framing, `Cache-Control: no-store`, and a 30-second monotonic server deadline. The gateway binds browser request close/abort to the proxy signal; the session-daemon client forwards that signal over HTTP or its Unix socket; and the daemon route binds disconnect, shutdown, and its own deadline to the model call. The model request uses `timeoutMs` below the route deadline and `maxRetries: 0`.

## Model Prompt Contract

The one-shot system prompt requires the utility model to:

- return only polished plain text;
- preserve meaning, intent, technical tokens, and explicit requirements;
- correct capitalization, punctuation, spacing, and obvious disfluencies only when unambiguous;
- avoid adding, deleting, or inferring requirements;
- avoid explanations, markdown, quotation wrappers, labels, and commentary.

The raw transcript is passed as one user message. The service uses the resolver's configured `lightweight` candidates in order, with the candidate thinking level, `maxTokens` set to a bounded response budget, `maxRetries: 0`, `cacheRetention: "none"`, and the request signal/deadline. It accepts only an assistant result with `stopReason === "stop"` and at least one text content block. Thinking blocks are ignored for extraction; tool calls, missing text, `length`, `toolUse`, `deferred`, `aborted`, and `error` stop reasons are failures. Empty or oversized text is a failure. If no lightweight candidate is configured or available, the service reports the same typed unavailable failure as other polish failures; the controller inserts raw text and shows the fallback error.

## Controller Flow

The controller state adds:

```typescript
| { kind: "polishing"; runId: string; provider: SpeechInputProviderId }
```

At `start()`, the controller snapshots `settings.settings.polishVoiceInput` into the active run. Browser and Cloud final callbacks both enter the same finalization path:

1. Ignore the callback if the generation is stale or the run has been canceled.
2. Clear capture/transcription timers and interim decorations.
3. If polishing is disabled or the raw transcript is empty, apply the raw transcript through `onFinal`.
4. If polishing is enabled and the raw transcript is nonempty, retain the active run, publish `polishing`, and invoke the injected polisher with a per-run abort signal.
5. On a current successful result, apply the polished text through `onFinal` and publish terminal idle state.
6. On a current non-cancellation failure, attempt raw insertion. Show `Voice input polishing failed; inserted the raw transcript.` only when raw insertion returns `inserted`; otherwise preserve the existing `changed`, `empty`, or `too-large` outcome error.

The active run owns the polish `AbortController`. `cancel()`, `dispose()`, a newer run, composer replacement, and navigation invalidate the generation before aborting. An explicit cancellation during polishing inserts nothing and does not show the fallback error. A late response cannot invoke `onFinal`.

Polishing has a hard 30-second client deadline. Deadline expiry is a distinct non-cancellation terminal cause: invalidate the run, abort the request, attempt raw insertion, and report the same fallback message only when insertion succeeds. Settings changes do not affect an active run.

The PromptEditor renders the `polishing` state as bounded status feedback, keeps editor-mutating actions disabled as it does for other active dictation phases, and displays the fallback error through its existing speech error/`aria-live` path.

## Failure And Privacy Rules

Raw fallback is used only after a real polish failure, including timeout or no configured lightweight candidate. Empty raw text follows the existing **No speech detected** path and does not issue a model request. A changed or stale draft follows the existing insertion outcome and never writes model output into a different document.

Server logs may record a generic operation failure and model slot, but must not include the transcript, prompt, response text, credential source, resolved credential, or provider response body. Client-visible errors are stable and concise. The polish response and all related responses use `Cache-Control: no-store`; no transcript is persisted or sent to telemetry.

## Testing

Add focused tests at the smallest meaningful boundaries:

- shared/config and speech-settings service tests for default `true`, explicit `false`, persistence, clear-credential preservation, and omitted updates preserving an existing explicit `false`;
- browser parser and client tests for version-1 compatibility, version-2 strict boolean validation, exact polish request body, nested deployment URL resolution, abort signal propagation, and response validation;
- session-daemon polishing service tests for lightweight-slot selection, prompt/options shape, thinking/text extraction, every non-stop reason, no-candidate fallback, and no session-manager calls;
- polishing route/proxy tests for pre-parse admission, request limits, strict body parsing, safe error mapping, no-store headers, browser disconnect propagation, server deadlines, admission recovery, and the absence of a selected-machine polishing route;
- controller tests for successful polishing, disabled polishing, Browser and Cloud convergence, visible raw fallback, timeout fallback, explicit cancellation, stale late responses, changed/too-large raw insertion outcomes, and settings snapshot behavior;
- Settings General panel and PromptEditor tests for checkbox rendering, draft/save conversion, disclosure text, polishing status, and fallback error visibility;
- synchronized configuration documentation under `docs/config.md` and `docs/config.html`, plus a minor Changeset for the user-visible feature.
