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

The redacted settings response and update settings object include the effective boolean:

```typescript
interface SpeechInputSettings {
  provider: "auto" | "browser" | "cloud";
  language?: string;
  polishVoiceInput: boolean;
  cloud: { baseUrl: string; model: string };
}
```

The server update parser accepts an omitted `polishVoiceInput` field as `true` for older browser clients, rejects a present non-boolean value, and continues rejecting unknown fields. The browser response parser likewise accepts legacy omission and projects `true`. The contract version remains `1` because this is an additive optional field with a defined legacy default.

The Settings General panel renders a checkbox under **Speech input**. It is checked when the effective value is true and participates in the existing draft, optimistic revision, stale-form, credential, and save behavior. The disclosure states that enabling the option sends the captured transcript to the configured lightweight utility model on the local gateway for conservative cleanup.

## Polishing HTTP Contract

The browser uses:

```text
POST api/speech-input/polish
Content-Type: application/json

{ "text": "raw dictated transcript" }
```

The gateway proxies the request to the local session daemon as `/speech-input/polish`. There is no selected-machine or federated equivalent.

The request text must be a nonempty string no larger than `SPEECH_INPUT_MAX_TRANSCRIPT_BYTES` in UTF-8 bytes. The route applies a bounded JSON body limit and strict object parsing. The successful response is:

```json
{ "text": "polished plain text" }
```

The response text must be nonempty and no larger than the same transcript limit. Model unavailable, model resolution failure, authentication/provider failure, aborted request, empty output, invalid output, and oversized output are failures. The route maps failures to safe status messages without forwarding provider bodies or model details.

The browser API method uses `request()` with an `AbortSignal` and parses the response at the transport boundary. It returns only the validated text.

## Model Prompt Contract

The one-shot system prompt requires the utility model to:

- return only polished plain text;
- preserve meaning, intent, technical tokens, and explicit requirements;
- correct capitalization, punctuation, spacing, and obvious disfluencies only when unambiguous;
- avoid adding, deleting, or inferring requirements;
- avoid explanations, markdown, quotation wrappers, labels, and commentary.

The raw transcript is passed as one user message. The service treats an assistant error stop reason, an empty text result, any non-text content result, or a size violation as a failure.

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
6. On a current non-cancellation failure, apply the original raw transcript through `onFinal` and publish the exact visible error `Voice input polishing failed; inserted the raw transcript.`

The active run owns the polish `AbortController`. `cancel()`, `dispose()`, a newer run, composer replacement, and navigation invalidate the generation before aborting. An explicit cancellation during polishing inserts nothing and does not show the fallback error. A late response cannot invoke `onFinal`.

Polishing has a hard client deadline. Deadline expiry follows the non-cancellation failure path: raw text is inserted and the exact fallback error is displayed. Settings changes do not affect an active run.

The PromptEditor renders the `polishing` state as bounded status feedback, keeps editor-mutating actions disabled as it does for other active dictation phases, and displays the fallback message through its existing speech error/`aria-live` path.

## Failure And Privacy Rules

Raw fallback is used only after a real polish failure, including timeout. Empty raw text follows the existing **No speech detected** path and does not issue a model request. A changed or stale draft follows the existing insertion outcome and never writes model output into a different document.

Server logs may record a generic operation failure and model slot, but must not include the transcript, prompt, response text, credential source, resolved credential, or provider response body. Client-visible errors are stable and concise.

## Testing

Add focused tests at the smallest meaningful boundaries:

- shared/config and speech-settings service tests for default `true`, explicit `false`, persistence, clear-credential preservation, and legacy omitted updates;
- browser parser and client tests for legacy omission, strict boolean validation, exact polish request body, nested deployment URL resolution, abort signal propagation, and response validation;
- session-daemon polishing service tests for lightweight-slot selection, prompt shape, plain-text extraction, empty/error/oversized output rejection, and no session-manager calls;
- polishing route/proxy tests for request limits, strict body parsing, safe error mapping, and gateway-to-daemon path forwarding;
- controller tests for successful polishing, disabled polishing, Browser and Cloud convergence, visible raw fallback, timeout fallback, explicit cancellation, stale late responses, and settings snapshot behavior;
- Settings General panel and PromptEditor tests for checkbox rendering, draft/save conversion, disclosure text, polishing status, and fallback error visibility.

Run focused Vitest files first, then `npm run typecheck`, targeted ESLint, `npm run verify:fast`, and finally the serial `npm run verify`. Because the session daemon gains a new route and service dependency, a manually running `pi-webui-sessiond.service` must be restarted after installation or source deployment.
