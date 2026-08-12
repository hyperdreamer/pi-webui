# Local Gateway OS Text-to-Speech Design

**Date:** 2026-08-12

## Goal

Add an opt-in, host-audio text-to-speech capability for finalized PI WEBUI assistant replies. A user can manually start or stop speech from an assistant message, and can optionally have completed replies from the currently selected session read automatically.

Audio is synthesized and played by the operating-system speech service on the machine running the local PI WEBUI gateway. The browser is only the control surface; it neither synthesizes nor receives audio.

## Accepted behavior

### Scope and ownership

- V1 supports the **local gateway machine only**. It does not expose TTS for configured remote machines, remote sessions, or remote selected-machine settings.
- The web/API process owns host speech. The session daemon does not own it and receives no new route, protocol, lifecycle, or runtime responsibility.
- TTS is presented as an opaque **OS voice** capability. PI WEBUI does not attempt to classify whether an operating-system backend is offline or network-backed.
- V1 supports the Linux Speech Dispatcher OS interface. Other host interfaces can become adapters later without changing the browser interaction or persisted configuration contract.
- There is no engine picker, user-configurable command template, provider account, API key, browser synthesis, browser audio, audio-file generation, or audio persistence.
- Host volume remains an OS responsibility and is not a PI WEBUI setting.

### Manual message action

- Readable assistant replies have an icon-only **Listen to assistant reply** action alongside existing message actions. It has a tooltip and accessible label.
- The action is not rendered for user, tool, system, shell, skill, image-only, or prose-empty messages.
- While the matching utterance is active, the speaker icon becomes a **Stop reading assistant reply** icon in the same fixed action position.
- Manual Listen starts immediately and replaces any current PI WEBUI utterance.
- Stop cancels only the active PI WEBUI utterance. It does not disable automatic reading and it does not issue a global operating-system speech cancel.
- If OS speech is unavailable, the action remains discoverable but is disabled with the availability reason in its tooltip and accessible description.
- A speech failure after an initially successful availability check leaves Listen enabled for retry and produces a concise transient error.

### Automatic reading

- The gateway config has an **Automatically read assistant replies** checkbox. It defaults to unchecked.
- Automatic reading starts only after a selected session receives a durable finalized assistant `message.end` event. It never reads history during selection, initial load, reconnect, refresh, compaction, branch summaries, streamed deltas, thinking, tool calls/results, shell output, notifications, or background sessions.
- Eligibility is evaluated at completion time. A reply whose session is not currently selected when it completes is ignored.
- Automatic runs use latest-completed-reply-wins semantics: a newly eligible automatic reply cancels and replaces the current automatic run. There is no queue or backlog.
- Manual runs take precedence. Starting a manual Listen action replaces any active run; an automatic completion while a manual run is active is dropped rather than queued or allowed to interrupt it.
- Changing the selected session cancels either a manual or automatic run before the new transcript is shown. A page request closing or gateway web/API process stopping also cancels its matching host run so speech cannot become orphaned from the browser control surface.

### Spoken content

Speech uses a pure prose projection of assistant text parts:

- retain headings, paragraphs, readable list content, and Markdown link labels;
- remove fenced and indented code blocks, table rows, image syntax, link destinations, and raw URLs;
- exclude all non-text assistant parts, including thinking and tool data;
- preserve paragraph boundaries where useful for natural speech;
- return no text when no readable prose remains.

The projection is silently truncated to a safe host limit before the request is sent. This protects the operating-system service from malformed or exceptionally large replies while ensuring Listen remains usable for long responses. Truncation is not surfaced as an error; the user hears the bounded prefix.

## Feasibility findings

The target development host has an active Speech Dispatcher user service and a functioning audio sink. The following tests were performed before this design:

- Voice discovery through `spd-say -L` returned installed OS speech voices.
- A real named-voice `spd-say --wait` synthesis request completed in roughly four seconds.
- A direct local SSIP Unix-socket probe successfully set a PI WEBUI-specific client identity and listed synthesis voices.
- A direct SSIP playback probe enqueued a PI WEBUI-owned utterance, issued `CANCEL self`, received `213 OK CANCELED`, and observed the matching `703 ... CANCELED` terminal event.

The currently configured Speech Dispatcher output module delegates to an Edge-TTS bridge, but that is intentionally treated as an implementation detail of the OS speech service. PI WEBUI neither detects nor labels that distinction.

Chromium's Web Speech API exists on this Linux host but returned zero available voices after its normal voice-loading interval. Browser-native synthesis is therefore not a reliable primary implementation for this product model.

The feasibility checks establish host integration, voice discovery, playback, and connection-scoped cancellation. They do not claim subjective voice quality for every installed OS backend. Release verification includes a short real-speaker check on the target gateway.

## Architecture

### Host speech module

Add a gateway web/API-side `HostSpeech` module. Its external interface is intentionally small:

```typescript
interface HostSpeech {
  status(): Promise<HostSpeechStatus>;
  speak(input: HostSpeechSpeakRequest): Promise<HostSpeechTerminalResult>;
  stop(runId: string): Promise<HostSpeechTerminalResult | undefined>;
  close(): Promise<void>;
}
```

`HostSpeech` owns exactly one active PI WEBUI run for the gateway. The service hides connection state, command serialization, generated state, replacement, cancellation, terminal events, reconnection, and deadlines behind that interface.

A browser-generated opaque `runId` identifies every request. The client creates it before starting `POST api/tts/speak`, and includes it in `POST api/tts/stop`. This is required because the speak request intentionally remains pending until speech reaches a terminal state:

- the client can render the matching message active as soon as it starts the request;
- the server atomically replaces the previous run with the new `runId`;
- a terminal response only clears the client state when its captured `runId` is still current;
- a stale Stop can never cancel a newer run because the service stops only when its input matches the active `runId`;
- if Stop reaches the gateway before its matching Speak request, the service records a bounded canceled-run tombstone. The later Speak request resolves as canceled without beginning host audio.

The service retains only a bounded recent-cancellation set, so out-of-order request protection cannot grow unboundedly.

A new automatic run replaces only an active automatic run. A manual run replaces either kind. An automatic request arriving while a manual run remains active resolves as skipped/canceled without queuing. The browser never needs to infer ordering from request completion timing.

### Speech Dispatcher adapter

V1 uses an internal Linux Speech Dispatcher SSIP adapter, not shell commands such as `spd-say --stop` or `spd-say --cancel`.

The command-line stop and cancel flags target other Speech Dispatcher clients as well as PI WEBUI. They violate the product requirement that Stop affect only speech PI WEBUI started. The SSIP protocol instead supports `CANCEL self`, which is scoped to the current client connection.

The adapter keeps one persistent local Unix-socket connection with a fixed PI WEBUI identity, such as `pi-webui:tts:main`. It:

1. connects to the local Speech Dispatcher socket using the standard runtime path or documented address override;
2. sends the required client identity and enables terminal notifications;
3. discovers voices with `LIST SYNTHESIS_VOICES` and normalizes each reported name, language, and variant;
4. sets the selected voice when present, otherwise leaves the OS default in effect;
5. sets the selected rate, uses Speech Dispatcher text priority, and submits the prose with `SPEAK`;
6. captures the SSIP message ID from the `SPEAK` reply and maps `END` and `CANCELED` notifications by that ID to the corresponding `runId`, not by active-run position, because Speech Dispatcher's text priority self-interrupts and a replaced message's terminal frame routinely arrives after the new run has started;
7. sends `CANCEL self` only for the matching active run;
8. closes and reconnects after a transport or protocol failure.

SSIP commands and asynchronous notification frames share a synchronous connection. The adapter owns a serialized command queue and one parser that demultiplexes command replies from `BEGIN`, `END`, and `CANCELED` frames. No route handler accesses the socket directly.

All connection, command, cancellation-acknowledgment, and terminal-wait paths have explicit monotonic deadlines. A failed or stalled connection is reset and reported as unavailable or failed rather than indefinitely retaining an HTTP request. The speech text bound provides a finite maximum work size; the implementation also applies a deliberate terminal deadline proportional to permitted content, with a fixed upper cap. Cancellation never waits indefinitely for a process, socket, or completion callback.

The adapter treats every text and voice field as untrusted data:

- rate is a validated integer from `-100` through `100`;
- a nonempty voice must exactly match the current discovered voice list;
- speech text is normalized to SSIP line endings and dot-stuffed so a line containing `.` cannot terminate `SPEAK` data early;
- control characters are rejected or normalized before serialization;
- fixed protocol commands are never assembled from arbitrary browser strings.

A gateway web/API restart calls `HostSpeech.close()`, which cancels or disconnects the PI WEBUI-owned SSIP connection and clears the active run. It does not affect the independent session daemon or active Pi sessions.

### API contract

Add gateway-only HTTP routes under `/api/tts`; do not add `/api/machines/local/tts`, federated allowlist entries, or remote proxy routes.

```typescript
interface HostSpeechVoice {
  name: string;
  language: string;
  variant?: string;
}

interface HostSpeechStatus {
  available: boolean;
  reason?: string;
  voices: HostSpeechVoice[];
}

interface HostSpeechSpeakRequest {
  runId: string;
  text: string;
  voice?: string;
  rate: number;
  source: "manual" | "automatic";
}

interface HostSpeechTerminalResult {
  runId: string;
  outcome: "ended" | "canceled" | "skipped";
}
```

- `GET /api/tts` returns `HostSpeechStatus`. It checks the local host interface and lists normalized voices when available.
- `POST /api/tts/speak` validates a bounded request, atomically starts/replaces the specified run, and keeps the response open until that run reaches `ended`, `canceled`, `skipped`, or a bounded failure state.
- `POST /api/tts/stop` receives `{ runId }`, cancels only a matching current run, and returns promptly after the cancellation command is accepted. The matching pending Speak response resolves after the associated terminal result.

Use the repository's application-relative browser paths (`api/tts`) and existing `request()` boundary. No raw browser `fetch` call, leading-root application URL, or client WebSocket is introduced.

Response and error semantics are:

- malformed body, unknown voice, invalid rate, or invalid run ID: `400`; over-limit text is silently truncated before the request, so it never produces `400`;
- unavailable local host speech interface: `503` with a stable explanatory error;
- a request whose ID was stopped before it began, or automatic speech skipped for an active manual run: a normal terminal response with `canceled` or `skipped` outcome;
- unexpected operating-system, connection, or synthesis failure: `500`, with a safe retryable message;
- a stale Stop ID: successful no-op, never an error and never a cancellation of the current run.

The long-lived Speak HTTP request is tied to the browser request lifecycle: if the request closes before its run reaches a terminal result, the route calls matching `stop(runId)` without waiting indefinitely. This prevents an abandoned tab or navigation from leaving host audio running.

This pending-response pattern is novel in this repository—the existing precedent for async work (terminal command runs) returns a run record immediately and reports completion elsewhere. The pending response avoids polling and a second socket but depends on Fastify request-close hooks (`request.raw.on('close')`) that have no current usage in the codebase. Verification must prove request-abort cancellation and confirm the design remains safe under reverse-proxy read timeouts.

### Gateway configuration

Add an additive global configuration type:

```typescript
interface PiWebUiTtsConfig {
  /** Omitted means use the OS default voice. */
  voice?: string;
  /** Omitted means Speech Dispatcher's neutral rate, 0. */
  rate?: number;
  /** Omitted and false both disable automatic reading. */
  autoReadAssistantReplies?: boolean;
}

interface PiWebUiConfigValues {
  // existing fields
  tts?: PiWebUiTtsConfig;
}
```

The value belongs only in `$PI_WEBUI_CONFIG` or `~/.config/pi-webui/config.json`, through the existing global `/api/config` route. It is deliberately excluded from `SELECTED_MACHINE_CONFIG_KEYS`, selected-machine config parsing, local-machine config responses, and remote machine proxy behavior.

Validation accepts only `voice`, `rate`, and `autoReadAssistantReplies`; it rejects unknown keys. `rate` is an integer between `-100` and `100`; voice is an optional nonempty string; automatic reading is an optional boolean. Existing configurations with no `tts` object remain valid and resolve to system voice, rate `0`, and automatic reading off.

A saved voice that no longer appears in the current OS voice list remains configured but is not sent to the speech service. The host remains available and manual Listen continues with the OS default. The settings card marks that saved named voice unavailable and explains that the system default will be used until the user chooses another voice. If the voice returns later, it becomes eligible again. Explicitly choosing System default clears the saved voice.

Saving a gateway-server setting must preserve `tts`; saving TTS settings must preserve unrelated gateway settings. Existing config parse/save round trips must retain the new object.

### Client ownership

Introduce a focused client `HostSpeechController` at the app-shell level. It owns:

- current availability and normalized voice list;
- the active local run ID, source, session ID, and message action key;
- request start, replacement, matching stop, and terminal cleanup;
- current transient TTS error;
- config-derived voice, rate, and automatic-reading settings;
- cancellation on selection change and component disposal.

It does not parse Pi transcript events or render message markup. `SessionController` remains the owner of selected-session stream handling. Add a narrow injected callback invoked only after its existing selection/watermark checks process a durable `message.end` whose normalized final line is an ordinary assistant response. The app-shell callback uses the prose helper and asks `HostSpeechController` whether it should auto-read that final response.

The callback verifies all of the following at invocation time:

- automatic reading is enabled;
- local host speech is available;
- the event still belongs to the selected local-gateway session;
- the final line is assistant prose, not compaction or branch-summary content;
- the prose projection is nonempty;
- no manual run is active.

A session switch calls the controller's matching stop operation before replacing the selected transcript. A late terminal response, availability refresh, or failed prior request cannot clear a newer run because every operation compares its captured run ID and selection identity with current controller state.

No history load, transcript reconciliation, or `agent.end` refresh can invoke the automatic callback. This prevents the browser from reading old replies during initial load, reconnect, or recovery.

### UI

The existing `ChatView` message-actions area gains the speaker/Stop icon. It receives only narrowly scoped properties/callbacks from the app shell: availability, current message action key, and a start/stop callback. Layout dimensions remain stable so active-state text or icons cannot move metadata or adjacent actions.

The General settings surface gains a compact **Text to speech** card only while the local gateway is selected. It contains:

- an **OS voice** select with System default and discovered voice names;
- a rate range control plus an exact numeric value constrained to `-100..100`;
- the unchecked-by-default **Automatically read assistant replies** checkbox;
- a concise local-host note that audio plays on the local gateway rather than in the browser;
- the existing style of save action and success/error notice.

When host speech is unavailable, the card remains visible but its controls are disabled and the availability reason is shown. When a configured named voice is no longer reported, the card shows the saved value as unavailable and states that the system default will be used until the user chooses another voice.

The approved visual composition is:

- a small speaker icon beside Copy in assistant message headers;
- the same fixed icon position becoming Stop while active;
- a restrained, un-nested settings card under General configuration, matching the existing operational Settings dialog rather than creating a separate modal or navigation section.

Saving config does not alter an utterance already in progress. A later utterance uses the current saved selection.

## Error handling and operational behavior

- The browser displays an unavailable reason before user action when the local OS speech service cannot be reached or no compatible adapter exists.
- A user-triggered synthesis failure reports a retryable transient error at the app level and returns the message action to Listen.
- A normal cancellation, automatic skip, session change, browser request closure, or replacement is not shown as an error.
- A broken Speech Dispatcher socket clears availability, resolves the affected run safely, and causes the next availability refresh or user action to attempt a fresh connection.
- The TTS service must never call global Speech Dispatcher `STOP all` or `CANCEL all`, and must never explicitly target another client's speech.
- Speech Dispatcher's shared priority system still produces cross-client effects that PI WEBUI cannot avoid while using a normal `text`-priority message. Submitting PI WEBUI speech cancels other clients' queued or speaking `notification` and `progress` messages, and a higher-priority message from another client (such as a screen reader) can cancel PI WEBUI speech. That arriving `CANCELED` frame is treated as an ordinary terminal result, so the message action returns to Listen rather than reporting an error. This is documented as accepted behavior, not a defect.
- PI WEBUI has no authentication layer, so anyone who can reach the gateway HTTP surface can cause audible speech on the host machine and enumerate its installed voices. That matches the existing documented security model, which requires a trusted network, VPN, tunnel, or authenticated reverse proxy before exposure, and it is why this feature is opt-in for automatic reading and remains local-gateway-only.
- Web/API restart intentionally ends PI WEBUI host speech but does not stop active Pi sessions. This feature changes no `sessiond` code, so it requires no manual session-daemon restart.

## Verification

Use test-driven development and the smallest layer that proves each behavior. Follow the repository testing guide for focused tests, real DOM component cases, and broad verification ordering.

### Pure helpers and config

- parse legacy config with no `tts` object and resolve system default/rate `0`/automatic false;
- accept valid `tts` settings and reject unknown keys, empty voice, fractional/out-of-range rate, and nonboolean automatic values;
- preserve `tts` through global config save and unrelated gateway-setting saves;
- prove selected-machine config parsing, merging, and responses exclude `tts`;
- derive readable prose from headings, paragraphs, links, lists, code blocks, indented code, tables, images, raw URLs, mixed text parts, and empty input;
- enforce post-projection truncation bounds without raising an error;
- cover auto-read eligibility for selected/local/final ordinary assistant messages only;
- cover manual-over-automatic precedence, automatic latest-wins replacement, and no queue behavior.

### Host speech module and SSIP adapter

Use a fake SSIP transport with controllable replies/events, clocks, and connection failures. Cover:

- client identity, voice discovery normalization, selected/default voice commands, rate commands, text priority, and SSIP data escaping;
- one active run, atomic replacement, manual precedence, and terminal mapping;
- terminal frames routed by captured SSIP message ID, proving a replaced run's late `CANCELED` cannot terminate the newer run that superseded it;
- an externally originated `CANCELED` (higher-priority speech from another client) resolves that run as canceled rather than as an error;
- `CANCEL self` for matching run only, with no global cancellation command;
- Stop-before-Speak tombstone behavior, stale Stop no-op behavior, and stale terminal notifications;
- serialized command/reply/event parsing without an external call under an owned command lock;
- connection, command, cancellation, and terminal deadlines using deterministic barriers rather than sleeps;
- reconnect after failed connection, protocol error, or dropped socket;
- `close()` cancellation and cleanup without hanging or affecting another client.

### Routes and browser API

- strict response parsing for availability, voices, and terminal results;
- `GET api/tts`, `POST api/tts/speak`, and `POST api/tts/stop` happy paths;
- `400`, `503`, and retryable `500` mapping;
- voice, rate, run-ID, and malformed-body validation, and that over-limit text is truncated rather than rejected;
- long-lived Speak response resolves only after matching terminal result;
- request-close cancellation is run-ID scoped, using an aborted client request rather than only a direct service call;
- prove no `/api/machines/local/tts`, remote proxy route, federated HTTP allowlist entry, or TTS WebSocket exists;
- verify application-relative browser path resolution through existing API helpers.

### Client and component behavior

- render Listen only for eligible assistant prose and preserve existing message actions;
- render Stop only for the matching active message action key;
- disable actions and settings with the host availability reason;
- manual start/replacement/stop behavior and stale promise suppression;
- session-switch and component-disposal cancellation;
- automatic start only after the selected session's finalized ordinary assistant message, never from history, delta, tool, thinking, background, compaction, or branch-summary events;
- automatic latest-wins behavior and drop automatic completion while manual speech is active;
- render/save System default, discovered voice, rate, automatic checkbox default false, and stale saved-voice fallback;
- keep TTS controls/actions absent for a remote selected machine;
- use real DOM interaction for icons, controls, accessibility labels, keyboard/focus behavior, and disabled states where practical.

### Manual host check

Before release, test the actual target local gateway with audible output:

1. enumerate voices;
2. play a short reply with the system default and a selected voice;
3. verify a rate change;
4. start a long reply and Stop it;
5. start a second reply while the first is active and confirm replacement;
6. enable automatic reading, complete a reply in the selected session, and confirm it reads once after completion;
7. switch sessions during manual and automatic playback and confirm host audio stops;
8. stop or disable the OS speech service and confirm the disabled/retryable unavailable state;
9. with a screen reader or another Speech Dispatcher client active, confirm cross-client priority interaction behaves as documented and PI WEBUI reports no error when its speech is canceled externally.

Run focused tests first, then typecheck/lint as appropriate, `npm run verify:fast`, and serial `npm run verify` before merge. Run `git diff --check` before commit.

## Release and documentation

This is a backward-compatible user-facing capability and requires a **minor Changeset** for `@hyperdreamer/pi-webui` when implementation begins. Do not edit `CHANGELOG.md` manually.

Implementation should add canonical user-facing configuration and operational guidance to `docs/config.md`, which ships in the published npm `files` allowlist, and to its paired `docs/config.html` surface. That work must add a `tts` row to the existing configuration matrix, leave the matrix's selected-machine-safe key sentence accurate by not listing `tts` among selected-machine keys, and cover the local-gateway-only scope, OS speech-service prerequisite, defaults, host-audio side effects, and unavailable-state troubleshooting. Keep `README.md` unchanged unless the feature changes the shortest supported successful start.

## Scope boundaries

- No remote-machine TTS or remote-machine settings/action support.
- No browser-native synthesis or browser audio playback.
- No online-provider integration, account, API key, or provider picker.
- No engine picker or arbitrary command configuration.
- No host volume control.
- No queued playback, replay history, automatic history reading, partial streaming speech, or cross-session automatic reading.
- No reading of tool output, thinking, code blocks, tables, image syntax, or raw URLs.
- No generated audio files, downloads, caching, or playback history.
- No modification to session-daemon ownership, session protocol, session lifecycle, or active Pi-session persistence.
- No global Speech Dispatcher control of another application's speech, beyond the unavoidable shared-priority effects documented above.
