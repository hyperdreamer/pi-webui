# Speech Prompt Input Design

**Date:** 2026-08-13

## Goal

Allow users to dictate prompts into the PI WEBUI composer. Speech becomes editable draft text at the captured selection and is never sent automatically.

The first release supports browser speech recognition and gateway-mediated OpenAI-compatible cloud transcription. The design keeps provider orchestration independent of either transport so a local transcription adapter can be added later without changing composer behavior.

## Accepted Behavior

### Providers and preference order

- The available user choices are **Auto**, **Browser**, and **Cloud**.
- Auto is the default and evaluates providers once, immediately before a run starts, in this order: Browser, Cloud, future Local.
- Browser is eligible only when the page is a secure context and the browser exposes a usable standard or prefixed Web Speech recognition constructor.
- Cloud is eligible only when the page is a secure context, microphone capture and `MediaRecorder` are available with an accepted audio MIME type, and the gateway credential status is `resolved` or `unchecked`. A missing or unresolved literal/environment credential makes Cloud unavailable before capture; a command source remains eligible because routine availability checks must not execute it.
- An explicit Browser or Cloud choice never falls back to another provider.
- Auto never changes providers after microphone permission, capture, recognition, upload, or transcription has begun. A failure is shown for the selected provider and retry is user-initiated.
- The resolved provider is visible in the microphone tooltip before capture and in the composer status while active.
- The first release does not show a Local provider option, download a model, manage a Whisper process, or expose nonfunctional local settings.

### Composer interaction

- Both the starter composer and active-session composer show an icon-only microphone action immediately before Send.
- The idle control is **Start dictation**. One tap starts the selected provider.
- While requesting permission, the same fixed control cancels the request and invalidates any late permission result.
- While listening, the control is **Stop dictation**. Stopping asks the provider to finalize the current speech and then commits a nonempty final transcript.
- Browser recognition may finish naturally after silence; a nonempty accumulated final transcript is committed when it ends.
- While cloud audio is being uploaded or transcribed, the same control is **Cancel transcription**. This gives touch users the same cancellation path as keyboard users.
- `Escape` cancels permission, listening, or transcription, discards all interim/final output from that run, and restores the composer. While a run is active, dictation cancellation takes precedence over the editor's existing `Escape` completion-close binding and over global keyboard shortcuts; see Editor boundary for the required listener phase. Idle `Escape` behavior is unchanged.
- The UI shows `Listening · Browser`, `Listening · Cloud · mm:ss`, or `Transcribing · Cloud` in a bounded status area. Provider errors appear as concise wrapping composer feedback with `aria-live` semantics.
- Browser interim text is shown as a subdued CodeMirror decoration at the captured insertion range. It is never written to the document, draft storage, prompt history, or network by PI WEBUI.
- Only a final nonempty transcript changes the draft. Dictation never invokes Send, Queue, or Steer.
- While a run is active, the text editor is temporarily read-only and composer-mutating controls such as Attach, Compact, Send, and Steer are disabled. The dictation action, `Escape`, and the existing agent-work Stop control remain available with distinct labels.
- Completing or canceling dictation restores editing and focuses the composer. A successful insertion places the caret after the inserted transcript.

### Selection and insertion

The run captures all of the following before starting asynchronous work:

- composer identity;
- complete editor document text;
- selection `from` and `to` offsets;
- selected provider and language settings as observed at start; Browser applies the captured language directly, while Cloud uses the gateway's authoritative language when transcription begins because the raw audio request carries no settings override;
- a monotonically increasing run generation.

The run captures the language setting observed in the browser snapshot for availability/status and applies it directly to Browser recognition. Cloud is different by design: the upload carries only audio and MIME type, so the gateway reads its current authoritative language/model/base URL when transcription begins. A Settings save in another tab during recording can therefore affect that Cloud transcription; it never changes the already selected provider or causes fallback.

A final transcript is accepted only when the generation and composer identity still match and the editor document is byte-for-byte equal to the captured text. The editor is read-only during the run, but this additional comparison protects against plugin or programmatic draft replacement.

A successful result follows ordinary editor insertion semantics:

- trim provider-added outer whitespace while preserving internal whitespace, punctuation, and capitalization;
- replace the captured selected range when it was nonempty;
- otherwise insert at the captured caret;
- avoid duplicate boundary whitespace;
- add a single boundary space when adjacent non-whitespace text would otherwise join words;
- do not add a space after an opening delimiter or before closing punctuation.

The pure insertion helper treats `([{` as opening delimiters and `.,;:!?%)]}` as closing punctuation for boundary spacing. The result is applied through one CodeMirror document transaction so the existing draft update and persistence path observes it normally.

An empty result leaves the document unchanged and reports **No speech detected**. A changed document or stale identity leaves the current draft untouched and reports that dictation was canceled because the draft changed.

### Identity and cancellation

Composer identity includes machine, project, workspace, and session identity. For the starter composer it includes the starter machine/project/workspace identity even though no durable session exists yet.

Changing session, machine, project, or workspace cancels the active run and discards pending output before the new composer target is adopted. Disconnecting the component, replacing the starter composer, closing the page, or disposing the controller does the same. Every adapter completion is generation-checked, so an API that cannot be interrupted cannot insert a stale transcript later.

### Limits

- Every dictation capture/listening phase has a hard ten-minute wall-clock limit measured from the provider's successful listening/recording start; microphone-permission time is bounded by cancellation but is not charged against capture time.
- Browser recognition is stopped and finalized at the ten-minute capture limit.
- Cloud recording stops and proceeds to transcription at ten minutes or 20 MiB (`20 * 1024 * 1024` bytes), whichever happens first. After capture, credential command resolution is bounded to ten seconds and the provider request to 120 seconds, so a cloud run has a hard maximum of 12 minutes 10 seconds from successful recording start, excluding user-controlled permission time.
- Cloud recording starts `MediaRecorder` with a 1,000 ms timeslice so elapsed time and observed bytes update at least once per emitted chunk.
- The controller requests Stop when the retained total reaches 20 MiB. If any emitted or final chunk would make the retained blob exceed 20 MiB, it does not retain or upload that chunk; it discards the recording and reports the size limit. Encoded media is never byte-truncated because that can corrupt its container.
- The gateway admits at most two concurrent transcription requests. Admission happens in the route's `onRequest` hook before body parsing, so a third request receives `429` without buffering another 20 MiB body or resolving a credential. Response, error, and request-close paths release the admission exactly once.
- Provider credential command resolution has a ten-second deadline and captures at most 64 KiB of stdout. The deadline is one total monotonic budget, not a fresh timeout for subprocess startup, output collection, and cleanup.
- The cloud provider request has a 120-second total monotonic deadline and is also aborted when the browser request closes. Response headers and bounded body streaming share that one deadline rather than receiving separate 120-second windows.
- Every normalized final transcript, including Browser output, must be nonempty and no larger than 1 MiB of UTF-8 text. The gateway reads at most 1 MiB from a provider response before strict JSON parsing.

## Architecture

### Provider-neutral controller

The app shell owns the latest `SpeechInputSettingsResponse`. It loads that gateway snapshot at app startup, refreshes it on browser resume, and replaces it after a successful Settings save. It passes the same immutable snapshot into starter and active-session prompt editors, so composer remounts do not duplicate settings requests or retain stale credential availability. Browser capability checks remain local to each mounted editor because they depend on the current page APIs, not gateway configuration.

A focused client `SpeechInputController` owns exactly one active run for its mounted composer. `PromptEditor` owns the controller lifecycle but delegates browser APIs, cloud requests, state transitions, cancellation, and stale-result suppression to it.

The controller publishes a normalized snapshot:

```typescript
type SpeechInputProviderId = "browser" | "cloud";

type SpeechInputState =
  | { kind: "idle"; provider?: SpeechInputProviderId; unavailableReason?: string; error?: string }
  | { kind: "requesting-permission"; runId: string; provider: SpeechInputProviderId }
  | { kind: "listening"; runId: string; provider: SpeechInputProviderId; elapsedMs: number; interimText?: string }
  | { kind: "transcribing"; runId: string; provider: "cloud"; elapsedMs: number };
```

Provider adapters receive an immutable run context and callbacks for interim text, final text, natural completion, and normalized failure. They return a run handle with distinct `stop()` and `cancel()` operations:

- `stop()` finalizes usable speech and may produce a transcript;
- `cancel()` discards the run and must never commit a transcript.

The controller owns timers and generation checks rather than relying on provider callback order. Dependencies for constructors, clocks, timers, media capture, and cloud API calls are injected so tests do not require a real microphone or speech service.

### Editor boundary

`PromptEditor` exposes a narrow internal dictation target instead of exposing all CodeMirror internals to provider adapters. The boundary can:

- capture identity, text, and selection;
- apply or clear a non-document interim decoration;
- lock or unlock composer editing;
- verify and apply the final insertion transaction;
- focus the editor after terminal cleanup.

`Escape` already has two established owners that a naive listener would fight. `PromptEditor.createEditor` binds `{ key: "Escape", run: () => this.closeCompletions() }` inside its CodeMirror keymap, and `PiWebUiApp` registers a `window` keydown listener with `{ capture: true }` that dispatches user-configurable shortcuts, including a bindable `escape` token.

A PromptEditor listener registered later on the same target cannot outrank that existing capture-phase app listener. Dictation therefore integrates through the app's existing `PiWebUiApp.onKeyDown` owner:

- `PromptEditor.cancelSpeechInput(): boolean` returns `false` while idle; while active it cancels the run, performs terminal cleanup, and returns `true`;
- before global shortcut dispatch, `PiWebUiApp.onKeyDown` checks `event.key === "Escape"` and delegates to the currently mounted `promptEditor?.cancelSpeechInput()`;
- when delegation returns `true`, the app listener calls `preventDefault()` and `stopPropagation()` and returns, so neither a global shortcut nor the CodeMirror completion binding also acts on that keypress;
- when delegation returns `false`, the existing shortcut and CodeMirror paths continue unchanged.

No new global/document keydown listener is introduced, so there is no listener-order race or disposal obligation.

### Browser adapter

The browser adapter wraps either `globalThis.SpeechRecognition` or `globalThis.webkitSpeechRecognition` behind project-owned TypeScript interfaces. It does not assume those experimental types exist in the TypeScript DOM library.

For each run it:

1. creates a fresh recognition instance;
2. sets `continuous = true` and `interimResults = true` where supported;
3. applies the configured BCP 47 language tag, or leaves `lang` unset for Auto;
4. accumulates finalized result segments separately from the latest interim segment;
5. publishes interim decorations without mutating the draft;
6. calls `stop()` for user/time-limit finalization and `abort()` for cancellation;
7. treats natural `end` as completion only for the still-current, non-canceled run;
8. normalizes permission denial, no-match/no-speech, service/network failure, and unsupported behavior without falling back.

PI WEBUI does not record or upload browser-provider audio itself. The browser implementation may process audio through a browser-vendor service; Settings/help text and configuration documentation disclose that boundary.

### Cloud recording adapter

The cloud adapter uses `navigator.mediaDevices.getUserMedia({ audio: true })` and a fresh `MediaRecorder`. It chooses the first browser-supported value, in order, from this exact allowlist:

1. `audio/webm;codecs=opus` (`speech.webm`);
2. `audio/ogg;codecs=opus` (`speech.ogg`);
3. `audio/mp4;codecs=mp4a.40.2` (`speech.m4a`);
4. `audio/mp4` (`speech.m4a`).

The gateway accepts those exact MIME values after case-insensitive media-type normalization; arbitrary parameters or codecs are rejected. The client uses the recorder's actual resulting MIME type only when it remains in the allowlist.

It starts the recorder with a 1,000 ms timeslice, collects only chunks that keep the retained total at or below 20 MiB, updates elapsed status from the injected monotonic clock, and stops at user request, ten minutes, or the observed byte limit. An incoming chunk that crosses the hard bound terminates and discards the recording rather than storing or truncating it. It stops every `MediaStreamTrack` on successful recording, cancellation, permission failure, recorder failure, component disposal, and navigation. Once recording stops within the limit, it constructs one final `Blob` and calls the gateway API with the exact MIME type and an abort signal.

Cancellation during transcription aborts the browser request and suppresses any late response. No audio object URL, download, attachment, workspace file, IndexedDB record, browser storage entry, or session entry is created.

### Gateway transcription service

A gateway web/API-side `SpeechTranscriptionService` owns cloud configuration resolution and OpenAI-compatible requests. It is independent of the session daemon, selected coding machine, workspace, and Pi session runtime.

Its first adapter is `OpenAiCompatibleTranscriptionProvider`. The internal service/provider boundary accepts audio bytes, MIME type, model, optional language, resolved request authentication, and an abort signal, and returns normalized transcript text. Future named cloud or local providers can implement this boundary without changing the composer controller.

The OpenAI-compatible adapter:

1. parses and validates the configured HTTPS base URL, rejecting credentials in the URL, query strings, and fragments;
2. appends `/audio/transcriptions` to the configured base path with exactly one separator;
3. disables redirects so an authorization header and audio cannot be forwarded to another origin;
4. sends multipart fields `file`, `model`, and optional `language` with `Authorization: Bearer <resolved key>`;
5. maps a configured BCP 47 tag to its canonical primary language subtag for the cloud field;
6. applies the browser-abort and 120-second deadline signals;
7. reads at most 1 MiB of response bytes and accepts only a JSON object with a nonempty string `text` field whose UTF-8 representation is also at most 1 MiB;
8. returns safe normalized errors without exposing provider bodies, audio, transcript text, or credential values.

The service never writes audio to disk. Request, multipart, and response buffers live only in bounded process memory and their references are released in terminal cleanup. No claim is made that JavaScript can cryptographically zero every internal copy.

## Gateway Configuration

### Persisted shape

Speech input belongs to the gateway-global PI WEBUI config at `$PI_WEBUI_CONFIG` or `~/.config/pi-webui/config.json`. It is never project-local or selected-machine-scoped.

```typescript
interface PiWebUiSpeechInputConfig {
  /** Default: "auto". */
  provider?: "auto" | "browser" | "cloud";
  /** Omitted means Auto. Stored as a canonical BCP 47 tag. */
  language?: string;
  cloud?: {
    /** Default: "https://api.openai.com/v1". HTTPS only in V1. */
    baseUrl?: string;
    /** Default: "gpt-4o-mini-transcribe". */
    model?: string;
    /** Pi-compatible literal, environment template, or command source. */
    apiKey?: string;
  };
}
```

Unknown keys are rejected. The canonical stored limits are: language tag 128 characters, base URL 2,048 characters, model 256 characters, and credential source 8 KiB of UTF-8 text. Language validation uses `Intl.getCanonicalLocales` and persists its one canonical result. That check is syntactic only: it normalizes case and structure (`en-us` becomes `en-US`) but accepts well-formed tags for languages that do not exist, so a tag such as `qq-ZZ` is stored and forwarded to the provider, which decides whether it is usable. Provider and model strings must be nonempty after trimming. The cloud URL must use HTTPS and have no username, password, query, or fragment. HTTP loopback endpoints are reserved for a future explicit Local provider rather than weakening the cloud credential boundary.

### Pi-compatible credential values

The API key source accepts the same value language documented by Pi for provider configuration:

- literal: `sk-...`;
- environment interpolation: `$OPENAI_API_KEY`, `${OPENAI_API_KEY}`, or interpolation within a larger value;
- command: a leading `!command`, using trimmed stdout;
- escapes: `$$` produces a literal `$` and `$!` produces a literal `!` without command execution.

A plain `OPENAI_API_KEY` string is literal; the `$` is required to reference an environment variable. Missing or empty referenced variables make the source unresolved. Commands execute as the gateway service account only when a cloud transcription starts, are uncached, receive no audio or transcript data, capture at most 64 KiB of stdout, and are terminated after ten seconds or request cancellation.

Pi's current resolver implementation is an internal package subpath that is not part of its supported export map. PI WEBUI therefore implements a small asynchronous compatibility adapter rather than importing that private file. Compatibility tests pin literal, interpolation, escaping, missing-variable, command-success, empty-output, nonzero-exit, timeout, and cancellation behavior to Pi's documented contract. The asynchronous command runner must not block the gateway event loop.

### Secret projection and file safety

The raw `apiKey` source is write-only at the browser API boundary:

- generic `GET /api/config` and selected-machine config responses omit the entire persisted `speechInput` object;
- generic config saves preserve the current `speechInput` object and cannot set, clear, or echo its credential;
- the dedicated speech-input settings API is the canonical browser surface for all speech settings;
- no response includes the source text, literal key, resolved key, environment variable name, or command text;
- saving a nonempty credential source forces the gateway config file mode to `0600` on platforms with POSIX permissions; later writes preserve that restrictive mode;
- clearing a credential does not broaden file permissions.

The browser holds a newly entered source only in the password input and the in-flight same-origin settings request. It clears the input after a terminal save result and does not persist it in component state beyond that form lifecycle, browser storage, URL state, telemetry, or logs. Loopback HTTP retains the browser's secure-context exemption; any non-loopback deployment must use HTTPS before exposing this credential form or microphone controls.

### Credential status

Routine settings/status reads never execute a credential command. They return only:

```typescript
type SpeechInputCredentialStatus = {
  configured: boolean;
  source?: "literal" | "environment" | "command";
  resolution: "missing" | "resolved" | "unresolved" | "unchecked";
};
```

- no source is `missing`;
- a nonempty literal or fully resolvable environment template is `resolved`;
- a template with missing environment values is `unresolved`;
- a command is `unchecked` until transcription because checking it would execute arbitrary work during a read.

The Settings copy reflects these distinctions, such as **Environment credential resolved**, **Environment credential unresolved**, or **Command credential configured; checked when used**.

## HTTP API

Add gateway-only application-relative routes. Do not add selected-machine equivalents or federated route entries.

### Settings

`GET api/speech-input/settings` returns a strict versioned response:

```typescript
interface SpeechInputSettingsResponse {
  contractVersion: 1;
  settings: {
    provider: "auto" | "browser" | "cloud";
    language?: string;
    cloud: { baseUrl: string; model: string };
  };
  credential: SpeechInputCredentialStatus;
}
```

It performs no provider network request and no credential command execution.

`PUT api/speech-input/settings` accepts the complete non-secret settings plus exactly one explicit credential mutation:

```typescript
type SpeechInputCredentialMutation =
  | { action: "preserve" }
  | { action: "replace"; value: string }
  | { action: "clear" };

interface SpeechInputSettingsUpdate {
  settings: SpeechInputSettingsResponse["settings"];
  credential: SpeechInputCredentialMutation;
}
```

Blank password input maps to `preserve`. A nonblank input maps to `replace`. A separate confirmed **Clear credential** action maps to `clear`. The update reads the latest gateway config, replaces only `speechInput`, preserves all unrelated keys, writes synchronously/atomically within the service boundary, and returns the same redacted response shape.

### Transcription

`POST api/speech-input/transcribe` receives a raw audio body with an allowlisted `Content-Type`. It uses the persisted cloud settings and never accepts a base URL, model, language, or credential override from the request.

The route:

- has a two-request admission guard acquired in `onRequest` before body parsing and released exactly once on response, error, or request close; an unadmitted request returns `429` without credential resolution or provider work;
- sets its own Fastify per-route `bodyLimit` of 20 MiB, independent of the server-wide `bodyLimit` that `src/server/index.ts` derives from `maxUploadBytes`. A gateway configured with a smaller `maxUploadBytes` must not shrink the dictation limit, and a larger one must not raise it;
- rejects missing, empty, oversized, or unsupported audio with `400` or `413` as appropriate;
- resolves the credential only after request validation;
- forwards request cancellation to credential-command and provider operations;
- returns `{ "text": "..." }` only for a successful nonempty transcript;
- maps an unavailable/unresolved credential to `503`;
- maps provider authentication/rejection to a safe `502` response containing only a stable message and optional upstream status code;
- maps provider timeout to `504`;
- treats user/request cancellation as terminal cleanup rather than a retry or fallback trigger.

The client uses the existing application-relative `request()` boundary with an explicit audio content type and abort signal. It introduces no leading-root browser path and no raw browser `fetch` call.

## UI

### Composer

The approved visual direction keeps the existing compact PI WEBUI composer:

- the microphone uses the same stable dimensions as adjacent composer icon actions: 36 px on desktop/tablet and the existing 34 px size below the 430 px narrow breakpoint;
- idle uses the accent color without a persistent label;
- listening changes the same control to a clearly labeled red Stop action;
- transcribing uses a restrained processing state with a touch-accessible cancel action;
- active provider/status text occupies a bounded flex region without resizing icon controls;
- Browser interim text is visually provisional inside the editor;
- errors wrap below the editor rather than overlapping action controls;
- mobile layouts preserve fixed icon dimensions and allow status text to truncate before controls move.

The microphone remains visible but disabled with a precise tooltip when the selected provider cannot run. In Auto, it is disabled only when no candidate can start. The explicit provider's reason takes precedence over generic unsupported copy.

### Settings

General configuration gains a full-width **Speech input** card owned by the gateway and shown regardless of the selected coding machine. It appears with other gateway settings and contains:

- Provider select: Auto, Browser, Cloud;
- Language select/input: Auto or a canonical BCP 47 tag such as `en-US`;
- Cloud base URL;
- Cloud model;
- password-style **API key source** input with literal, `$ENV_VAR`, and `!command` placeholder guidance;
- redacted credential source/resolution status;
- separate **Clear credential** action;
- **Save speech input settings** action.

Cloud fields remain editable in Auto because Cloud may be the fallback candidate. The API key field is never prepopulated. Leaving it blank preserves the credential. Saving any replacement clears the field after completion. Settings explains that the feature runs on the UI gateway, not the selected coding machine.

## Privacy and Security

- PI WEBUI does not persist dictated audio, browser interim text, or cloud request bodies.
- Browser-provider processing may leave the device under the browser vendor's implementation and policy; the UI and docs state this clearly.
- Cloud audio leaves the gateway for the explicitly configured endpoint. No automatic provider fallback can change that privacy boundary mid-run.
- The configured endpoint is HTTPS-only, redirects are rejected, and credentials are never accepted from a transcription request.
- Audio, transcript text, credential sources, and resolved credentials are excluded from logs and error messages.
- Provider error bodies are not forwarded to the browser. Status codes may be exposed when useful.
- The `!command` form is explicitly documented as arbitrary command execution under the gateway account and should be used only with trusted commands.
- PI WEBUI has no authentication layer, and this feature adds none. Any client that can reach the gateway HTTP surface can call the transcription endpoint, which means a configured cloud credential becomes a network-reachable spending capability and a configured `!command` source becomes a network-reachable trigger for that command. Neither the credential value nor the command text is exposed, but their effects are. Configure cloud transcription only on a gateway restricted to a trusted network, VPN, tunnel, or authenticated reverse proxy, and prefer an environment or command source over a stored literal key when the gateway is shared.
- Microphone use requires a secure browser context. Non-loopback remote HTTP deployments must add HTTPS before Browser or Cloud input can be enabled.
- Cancellation stops media tracks, aborts browser/gateway work where possible, invalidates all callbacks, clears interim decorations, and releases buffered references.

## Error Handling

Normalized user-visible failures distinguish:

- speech input unsupported in this browser/context;
- microphone permission denied;
- microphone or recorder failure;
- no speech detected;
- recording time or size limit failure;
- draft or navigation changed during dictation;
- cloud credential missing, unresolved, or command resolution failed;
- gateway upload failure;
- provider rejected the request;
- provider or gateway timed out;
- malformed/empty provider response.

Failures never modify the draft, never send a prompt, never retry automatically, and never select another provider. A retry starts a fresh run and reevaluates Auto from current availability. Normal user cancellation is not displayed as an error.

## Testing and Verification

Implementation follows test-driven development at the narrowest meaningful layer.

### Pure tests

- Auto selection and explicit-provider behavior across browser/cloud availability.
- BCP 47 validation and cloud primary-language mapping.
- transcript insertion for selections, carets, whitespace, delimiters, punctuation, empty text, and stale document identity.
- credential classification, redaction, literals, multiple environment interpolations, missing/empty variables, `$$`, and `$!`.
- asynchronous command resolution success, empty stdout, bounded stdout, nonzero exit, timeout, and abort.
- MIME allowlist and filename-extension mapping.

### Controller and adapter tests

- requesting, listening, natural completion, stop/finalize, transcribing, cancellation, and retry transitions;
- interim results never changing the CodeMirror document or draft storage;
- late events after cancel, navigation, disposal, or a newer generation being ignored;
- browser result accumulation and no-speech/error normalization;
- cloud permission denial, media track cleanup on every terminal path, ten-minute capture/20 MiB limits, the 12-minute-10-second maximum after recording starts, upload abort, and stale completion;
- composer locking and restoration without changing the external disabled state.

### Component tests

- accessible microphone/Stop/Cancel labels, tooltips, disabled reasons, status text, and `aria-live` errors;
- `Escape` canceling an active run without closing completions or firing a global shortcut, and idle `Escape` still closing completions once dictation has ended;
- fixed action order immediately before Send and stable action dimensions;
- starter and active-session identity changes canceling an active run;
- captured selection replacement and caret placement;
- Settings load/save, Auto/Browser/Cloud choices, language, credential preserve/replace/clear, cleared password input, and redacted statuses.

### Gateway tests

- strict settings parsers, defaults, unknown-key rejection, merge preservation, generic config omission, and credential non-disclosure;
- syntactic-only language canonicalization, including `en-us` normalizing to `en-US` and a well-formed unknown tag being preserved rather than rejected;
- the audio route's 20 MiB limit holding when the server-wide `bodyLimit` is configured both below and above it;
- two admitted requests holding the gate while a third receives `429` before its body is parsed, followed by admission recovery after success, error, and request-close terminal paths;
- config mode `0600` after credential save on POSIX;
- raw body MIME/empty/size validation, the exact MIME-to-filename mapping, and the 20 MiB route limit;
- exact multipart fields and MIME-derived filename against an injected fake provider endpoint;
- HTTPS URL validation, redirect rejection, authorization placement, optional language, and strict bounded `{ text }` parsing;
- client abort, command deadline, provider deadline, safe `502`/`503`/`504` mapping, and no provider-body leakage.

### Browser and broad verification

Use the repository's Chromium/CDP tooling or an equivalent deterministic browser harness with injected fake recognition, media, and transcription boundaries. Verify desktop and narrow mobile widths for nonblank rendering, exact 36 px desktop and 34 px narrow microphone geometry matching adjacent icon actions, no overlapping controls, permission/listening/transcribing/error transitions, touch cancellation, and settings field containment. CI does not depend on live browser-vendor recognition or a real cloud API key.

Run focused Vitest files first, then typecheck and lint for changed sources, and finish with `npm run verify:fast`. A manual smoke check in a compatible secure-context browser may validate real microphone permission and browser recognition, but it is not a substitute for deterministic coverage.

## Documentation and Release

Update the canonical `docs/config.md` and `docs/config.html` configuration references, keeping their user-visible claims synchronized. Add a `speechInput` row to the `## Configuration matrix` table in `docs/config.md` alongside the existing `tts` row, using the established columns (JSON key, env var, scope, project-local behavior, applies/restart), and mirror it in `docs/config.html`. Then document:

- persisted keys, defaults, and gateway ownership;
- Browser versus Cloud processing/privacy boundaries;
- HTTPS and microphone-permission requirements;
- OpenAI-compatible endpoint behavior;
- Pi-compatible literal/environment/command credential examples and escapes;
- command-execution warning;
- Auto ordering and no mid-run fallback;
- ten-minute and 20 MiB limits;
- unsupported-browser, permission, credential, and provider troubleshooting;
- the unauthenticated-gateway consequence for a configured cloud credential and command source.

Add focused troubleshooting to `docs/faq.html` when it is not naturally configuration reference material. Keep `README.md` unchanged because detailed speech-provider setup is not part of the shortest install path.

This is a backward-compatible user-facing capability and receives a **minor** Changeset. It affects only the web/API/client side. It adds no session daemon protocol or runtime ownership, so no manual session daemon restart is required.

## Non-Goals

- Sending prompts automatically after transcription.
- Persisting or attaching recorded audio.
- Dictating directly into terminal input, Settings fields, auth dialogs, or plugin-owned editors.
- Streaming cloud transcription or cloud interim results in the first release.
- Named Deepgram, Google, Azure, or other cloud adapters in the first release.
- Bundled local models, model downloads, Whisper process management, or a visible Local provider option.
- Speaker diarization, timestamps, vocabulary hints, translation, audio editing, waveform display, or recording history.
- Public plugin registration APIs for speech providers.
- Federating speech settings or audio through selected remote coding machines.
