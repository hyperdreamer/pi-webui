# Local Gateway OS Text-to-Speech Recovery Plan

> Recovery execution plan for the terminal `DISPATCH_MISMATCH_BLOCKED` run
> `7065d15b...`. Recovery Tasks 1-7 correspond to original Tasks 3-9 in
> `docs/superpowers/plans/2026-08-12-local-gateway-os-text-to-speech.md`.

**Goal:** Complete the manual-only local-gateway OS text-to-speech feature from the verified branch state after original Tasks 1 and 2.

**Recovery basis:** The branch already contains the reviewed and verified commits `633eddc` (shared speech/config contracts), `6f05ecb` (Unicode-safe speech text sanitization), and `4e50f9a` (assistant spoken-prose projection). Do not reimplement or modify those completed task surfaces unless a later task's contract requires a consuming change.

**Final review basis:** The final reviewer must inspect the complete branch range from merge base `e7eec29b43e6322bd46ea9724a404de494888925` through the final branch HEAD, including the carried Task 1 and Task 2 commits.

## Global Constraints

- Implement the local-gateway OS text-to-speech design except automatic reading. V1 is manual Listen/Stop only: do not add `autoReadAssistantReplies`, an automatic-reading checkbox, finalized-reply handoff, automatic run sources, skip outcomes, or background speech starts.
- V1 is local-gateway-only. Do not add a selected-machine alias, remote-machine proxy, federated HTTP/WebSocket entry, capability negotiation, or any sessiond route, protocol, lifecycle, or source change.
- V1 supports Linux Speech Dispatcher through one `HostSpeechProvider` adapter. Do not add an adapter registry, cloud provider, browser speech synthesis, engine picker, arbitrary command template, API key, audio file, cache, or volume setting.
- No new runtime dependencies. Reuse the installed `marked` package and Node's built-in `node:net` API for SSIP.
- Spoken prose is capped at exactly 4,000 UTF-16 code units after projection. Truncate silently; never return a validation error merely because projected prose exceeds the cap.
- Persist speech rate in Speech Dispatcher's native integer range `-100` through `100`; omitted rate resolves to `0`, and omitted voice resolves to the OS default.
- Every browser run ID is an opaque bounded string created before Speak starts. Server stop and terminal handling must compare the exact run ID; stale stop and stale terminal events must never affect a newer run.
- PI WEBUI may send only connection-scoped `CANCEL self`. Never send `STOP all`, `CANCEL all`, another client ID, or any other global Speech Dispatcher control.
- Use application-relative browser paths `api/tts`, `api/tts/speak`, and `api/tts/stop` through the existing `request()` boundary. Do not add raw browser `fetch`, leading-root application URLs, or a TTS WebSocket.
- Manual Listen replaces any active PI WEBUI run. A session, machine selection, or transcript compaction synchronously abandons the browser run and its pending Speak request before the new state is presented. Request-close cancellation and exact run-ID guards make server cancellation race-safe.
- Message action keys are index-based (`assistant-index:<absoluteIndex>`); transcript compaction during playback stops audio cleanly and requires re-clicking Listen if desired.
- `tsconfig.json` enables `strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess`. Omit optional properties rather than assigning `undefined`; use type guards rather than type assertions.
- Follow red-green TDD at the narrowest useful layer. Use injected transports, clocks, timers, IDs, and deferred promises; do not use sleeps in automated tests.
- Run focused tests first, then typecheck/ESLint/Knip for each task. Never use `git commit --no-verify`.
- Keep `README.md` unchanged. Synchronize `docs/config.md` and `docs/config.html`, add one minor Changeset for `@hyperdreamer/pi-webui`, and never edit `CHANGELOG.md` directly.
- This feature changes only the web/API/client side. A session-daemon restart is not required; the `pi-webui-ui-dev.service` autoreload/restart path is sufficient during development.
- The carried Task 1 and Task 2 commits are trusted prerequisites. Recovery tasks must remain scoped to their own files and their consuming boundaries.

## Task 1: Speech Dispatcher SSIP adapter

**Implementer tier:** Capable

This is original Task 3. It consumes the carried shared speech contracts and spoken-prose projection.

**Files:**

- Modify: `src/shared/apiTypes.ts`
- Create: `src/server/tts/hostSpeech.ts`
- Create: `src/server/tts/ssipProtocol.ts`
- Test: `src/server/tts/ssipProtocol.test.ts`
- Create: `src/server/tts/speechDispatcherAdapter.ts`
- Test: `src/server/tts/speechDispatcherAdapter.test.ts`

**Interfaces:**

- Consumes from the carried Task 1: `truncateHostSpeechText` and `HOST_SPEECH_MAX_TEXT_CHARS`.
- Produces these shared status types in `src/shared/apiTypes.ts`:

```ts
export interface HostSpeechVoice {
  name: string;
  language: string;
  variant?: string;
}

export interface HostSpeechStatus {
  available: boolean;
  reason?: string;
  voices: HostSpeechVoice[];
}
```

- Produces from `src/server/tts/hostSpeech.ts`:

```ts
export type HostSpeechProviderTerminalOutcome = "ended" | "canceled";

export interface HostSpeechProviderUtterance {
  messageId: number;
  terminal: Promise<HostSpeechProviderTerminalOutcome>;
}

export interface HostSpeechProviderSpeakRequest {
  text: string;
  voice?: string;
  rate: number;
}

export interface HostSpeechProvider {
  status(): Promise<HostSpeechStatus>;
  enqueue(input: HostSpeechProviderSpeakRequest): Promise<HostSpeechProviderUtterance>;
  cancelSelf(): Promise<void>;
  close(): Promise<void>;
}

export class HostSpeechUnavailableError extends Error {}
```

- Produces from `ssipProtocol.ts`:

```ts
export interface SsipFrame {
  code: number;
  message: string;
  data: string[];
}

export class SsipFrameParser {
  push(chunk: string): SsipFrame[];
  reset(): void;
}

export function ssipDataPayload(text: string): string;
export function ssipMessageId(frame: SsipFrame): number;
export function ssipTerminalEvent(frame: SsipFrame): {
  messageId: number;
  clientId: number;
  outcome: HostSpeechProviderTerminalOutcome;
} | undefined;
```

- Produces from `speechDispatcherAdapter.ts`:

```ts
export interface SsipTransport {
  write(data: string): void;
  close(): void;
  onData(listener: (chunk: string) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
}

export type SsipTransportFactory = (socketPath: string) => Promise<SsipTransport>;
export type DeadlineScheduler = (callback: () => void, delayMs: number) => () => void;

export interface SpeechDispatcherAdapterOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  createTransport?: SsipTransportFactory;
  scheduleDeadline?: DeadlineScheduler;
}

export class SpeechDispatcherAdapter implements HostSpeechProvider {
  constructor(options?: SpeechDispatcherAdapterOptions);
  status(): Promise<HostSpeechStatus>;
  enqueue(input: HostSpeechProviderSpeakRequest): Promise<HostSpeechProviderUtterance>;
  cancelSelf(): Promise<void>;
  close(): Promise<void>;
}
```

**Behavior:**

- `SsipFrameParser` buffers partial CRLF-delimited chunks. Every line is `DDD-...` continuation or `DDD ...` terminal; a frame's continuation lines share one three-digit code. Reject malformed/mixed-code frames and cap retained input at 64 KiB for replies.
- `ssipDataPayload` normalizes through `truncateHostSpeechText`, changes line endings to CRLF, dot-stuffs every line beginning with `.`, and appends exactly `\r\n.\r\n`.
- `ssipMessageId` reads the first `225-<id>` data line from the post-data `SPEAK` reply. Terminal events map `702` to `ended` and `703` to `canceled`, reading message ID and client ID from the first two continuation lines.
- Exact duration limits are `2_000` ms connect, `3_000` ms command/data reply, `3_000` ms cancel acknowledgment, and terminal `min(300_000, 30_000 + text.length * 75)` ms. All use injected `scheduleDeadline`; timeout closes the transport and rejects all pending work.
- The default socket is `$XDG_RUNTIME_DIR/speech-dispatcher/speechd.sock`, falling back to `$XDG_CACHE_HOME` or `~/.cache`. An upstream `SPEECHD_ADDRESS` override is accepted only as `unix:/absolute/path` or `unix_socket:/absolute/path`; reject inet or relative addresses.
- The adapter is lazy. On first connection it sends, in order: `SET SELF CLIENT_NAME pi-webui:tts:main`, `HISTORY GET CLIENT_ID`, `SET SELF NOTIFICATION BEGIN on`, `SET SELF NOTIFICATION END on`, and `SET SELF NOTIFICATION CANCEL on`.
- Commands use one serialized promise chain. The parser routes `7xx` events independently and routes every other frame to the one pending command reply. No external callback or provider method runs while parser state is being mutated.
- `status()` and the first named-voice `enqueue` obtain a fresh `LIST SYNTHESIS_VOICES` result through the serialized command queue; cache that immutable normalized list only until the connection is reset. A later named-voice enqueue validates against that connection-scoped cache.
- `enqueue` sets `PRIORITY text`, validates and sets rate, optionally validates exact voice membership and sets `SYNTHESIS_VOICE`, sends `SPEAK`, waits for `230`, sends dot-stuffed data, captures the message ID from `225`, and returns its terminal promise.
- If a terminal frame arrives before the `225` message ID is registered, retain it in a bounded 64-entry early-terminal map and consume it immediately after registration. Late terminal events are keyed only by message ID.
- A request with no voice uses the OS default. If the persistent connection previously set a named voice, reconnect before the next default-voice utterance because SSIP has no portable command to clear `SYNTHESIS_VOICE`.
- `cancelSelf` emits only `CANCEL self` and waits for its `213` command acknowledgment; utterance completion still comes from the matching `703` event.
- When status cannot connect/list voices, return `{ available: false, reason: "Speech Dispatcher is unavailable on the local gateway.", voices: [] }`. `enqueue` for the same condition throws `HostSpeechUnavailableError` with that stable message.

- [ ] **Step 1: Write failing pure SSIP protocol tests**

Create `ssipProtocol.test.ts` covering one complete `249` voice-list frame and frames split across arbitrary chunks; two frames in one chunk including a `702` event interleaved with a command response; malformed codes/separators/mixed continuation codes/invalid event IDs/over-budget unterminated input; `225-42 / 225 OK MESSAGE QUEUED`; `702-42 / 702-7 / 702 END` and `703` mapping; and dot-stuffed payloads for leading dots, internal dot lines, CRLF, NUL, and long input.

Use literal CRLF strings, including:

```ts
expect(ssipDataPayload("first\n.\n..third")).toBe("first\r\n..\r\n...third\r\n.\r\n");
```

- [ ] **Step 2: Write failing adapter tests with a scripted transport**

In `speechDispatcherAdapter.test.ts`, define a file-local `ScriptedSsipTransport` implementing the exact interface. It records writes, exposes `feed(frameText)`, and supports deterministic close. Its factory returns a deferred transport so connect timeout is testable. Use a manually controlled `DeadlineScheduler`.

Cover non-Linux availability without opening transport; Linux default path and initialization command order; Unix-only `SPEECHD_ADDRESS`; fresh voice-list status refreshes and connection-scoped named-voice cache; voice normalization and order; enqueue priority/rate/voice/SPEAK/data writes; named-to-default reconnect; unknown voice and invalid rate rejection without serializing untrusted values; early and late `703` routing; external `703` cancellation; exact `CANCEL self`; command/connect/cancel/terminal deadlines; dropped-socket rejection and reconnect; and idempotent close without global cancellation.

- [ ] **Step 3: Run both tests and confirm RED**

Run:

```bash
npm test -- --run src/server/tts/ssipProtocol.test.ts src/server/tts/speechDispatcherAdapter.test.ts
```

Expected: FAIL because the production modules are missing.

- [ ] **Step 4: Implement the parser and adapter**

Wrap the real `node:net` socket behind `SsipTransport`; resolve the factory only after the socket `connect` event and reject on pre-connect error. Decode socket data as UTF-8 with `StringDecoder`. Use small helpers for command/data send, connection/reset, voice listing, and deadlines. Dispatch terminal resolution with `queueMicrotask` after parser routing. Keep all timeouts injected and deterministic.

- [ ] **Step 5: Run focused tests and static checks**

```bash
npm test -- --run src/server/tts/ssipProtocol.test.ts src/server/tts/speechDispatcherAdapter.test.ts
npm run typecheck
npx eslint src/server/tts/hostSpeech.ts src/server/tts/ssipProtocol.ts src/server/tts/ssipProtocol.test.ts src/server/tts/speechDispatcherAdapter.ts src/server/tts/speechDispatcherAdapter.test.ts
npx knip
```

- [ ] **Step 6: Commit**

```bash
git add src/shared/apiTypes.ts src/server/tts/hostSpeech.ts src/server/tts/ssipProtocol.ts src/server/tts/ssipProtocol.test.ts src/server/tts/speechDispatcherAdapter.ts src/server/tts/speechDispatcherAdapter.test.ts
git commit -m "feat(tts): add Speech Dispatcher SSIP adapter"
```

## Task 2: Gateway speech run arbitration

**Implementer tier:** Capable

This is original Task 4. It consumes Recovery Task 1 and the carried Task 1 shared helper.

**Files:**

- Modify: `src/shared/apiTypes.ts`
- Modify: `src/server/tts/hostSpeech.ts`
- Create: `src/server/tts/hostSpeechService.ts`
- Test: `src/server/tts/hostSpeechService.test.ts`

**Interfaces:**

- Consumes `HostSpeechProvider`, `HostSpeechProviderUtterance`, `HostSpeechProviderSpeakRequest`, `HostSpeechUnavailableError`, and `HostSpeechStatus` from Recovery Task 1, plus `truncateHostSpeechText` from the carried shared helper.
- Produces in `src/shared/apiTypes.ts`:

```ts
export interface HostSpeechSpeakRequest {
  runId: string;
  text: string;
  voice?: string;
  rate: number;
}

export interface HostSpeechTerminalResult {
  runId: string;
  outcome: "ended" | "canceled";
}
```

- Produces in `src/server/tts/hostSpeech.ts`:

```ts
export interface HostSpeech {
  status(): Promise<HostSpeechStatus>;
  speak(input: HostSpeechSpeakRequest): Promise<HostSpeechTerminalResult>;
  stop(runId: string): Promise<HostSpeechTerminalResult | undefined>;
  close(): Promise<void>;
}
```

- Produces:

```ts
export interface HostSpeechServiceOptions {
  canceledRunLimit?: number;
}

export class HostSpeechService implements HostSpeech {
  constructor(provider: HostSpeechProvider, options?: HostSpeechServiceOptions);
  status(): Promise<HostSpeechStatus>;
  speak(input: HostSpeechSpeakRequest): Promise<HostSpeechTerminalResult>;
  stop(runId: string): Promise<HostSpeechTerminalResult | undefined>;
  close(): Promise<void>;
}
```

**Behavior:**

- Default canceled-run tombstone limit is exactly 64. Tombstones are a FIFO `Set`; adding the 65th evicts the oldest. They are retained rather than consumed, so duplicate delayed Speak calls for a stopped ID remain canceled until bounded eviction.
- Control transitions are serialized through one internal promise chain, but `speak()` never holds that chain while waiting for terminal.
- Active state is one object containing request, provider message ID once accepted, and a deferred result. Every terminal handler captures that exact object and clears global state only if it is still active.
- Tombstoned Speak returns canceled without provider work. Replacement sends `cancelSelf`, then enqueues the new run without waiting for the old terminal frame. Provider terminal maps to the same API outcome and resolves only its run. Provider failure rejects its run and clears it only when still active.
- Matching Stop tombstones the ID, waits only for `cancelSelf` acknowledgment, and promptly returns canceled; pending Speak resolves when provider terminal arrives. Unmatched Stop records the bounded tombstone and returns `undefined`. It never changes another active run.
- Close is idempotent, marks closed before external work, cancels/settles active as canceled, then closes provider. Later Speak rejects; status returns unavailable.

- [ ] **Step 1: Write the failing service test using a fake provider**

Create a file-local fake provider with distinct message IDs and deferred terminal promises. Test status passthrough and truncation; normal ending; replacement; stop-before-speak and stale-stop safety; FIFO tombstone bound 2; late canceled terminal for message 4 after message 11 is active; stale terminal/stop safety; provider failures; and close behavior.

- [ ] **Step 2: Run the test and confirm RED**

```bash
npm test -- --run src/server/tts/hostSpeechService.test.ts
```

Expected: FAIL because `HostSpeechService` does not exist.

- [ ] **Step 3: Implement atomic run ownership**

Implement a private `serializeControl<T>(operation: () => Promise<T>): Promise<T>` that advances the chain on rejection. Create active state and deferred result before awaiting provider enqueue so concurrent Stop observes the run. Attach terminal handlers after enqueue; compare object identity, never merely run ID, before clearing state. Do not call provider methods inside parser/Map callbacks.

- [ ] **Step 4: Run focused tests and static checks**

```bash
npm test -- --run src/server/tts/hostSpeechService.test.ts src/server/tts/speechDispatcherAdapter.test.ts
npm run typecheck
npx eslint src/shared/apiTypes.ts src/server/tts/hostSpeech.ts src/server/tts/hostSpeechService.ts src/server/tts/hostSpeechService.test.ts
npx knip
```

- [ ] **Step 5: Commit**

```bash
git add src/shared/apiTypes.ts src/server/tts/hostSpeech.ts src/server/tts/hostSpeechService.ts src/server/tts/hostSpeechService.test.ts
git commit -m "feat(tts): arbitrate gateway speech runs"
```

## Task 3: Gateway-only TTS routes and web-process lifecycle

**Implementer tier:** Advanced

This is original Task 5.

**Files:**

- Modify: `src/shared/apiTypes.ts`
- Create: `src/server/tts/ttsRoutes.ts`
- Test: `src/server/tts/ttsRoutes.test.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/app.testSupport.ts`
- Create: `src/server/app.tts.test.ts`
- Test: `src/server/app.removedBrowserRoutes.test.ts`

**Interfaces:**

- Consumes `HostSpeechUnavailableError`, `HostSpeechStatus`, `SpeechDispatcherAdapter` from Recovery Task 1, and `HostSpeech`, `HostSpeechService`, `HostSpeechSpeakRequest`, `HostSpeechTerminalResult` from Recovery Task 2, plus `isHostSpeechRunId` and `truncateHostSpeechText` from carried Task 1.
- Produces in `src/shared/apiTypes.ts`:

```ts
export interface HostSpeechStopResponse {
  runId: string;
  stopped: boolean;
}
```

- Produces:

```ts
export interface TtsRouteService {
  status(): Promise<HostSpeechStatus>;
  speak(input: HostSpeechSpeakRequest): Promise<HostSpeechTerminalResult>;
  stop(runId: string): Promise<HostSpeechTerminalResult | undefined>;
}

export function registerTtsRoutes(app: FastifyInstance, speech: TtsRouteService, prefix?: string): void;
```

**Behavior and lifecycle:**

- Prefix defaults to `/api`; only `registerTtsRoutes(app, hostSpeech)` is called in production. Add optional `hostSpeech?: HostSpeech` to `AppDependencies`; default is `new HostSpeechService(new SpeechDispatcherAdapter())`. The adapter remains lazy.
- Register exactly `GET /api/tts`, `POST /api/tts/speak`, `POST /api/tts/stop` once. Add `app.addHook("onClose", () => hostSpeech.close())`.
- Never register selected-machine, federated, remote, or socket TTS routes.
- Speak body is exact object with only `runId`, `text`, `voice`, `rate`; validate run ID, nonempty text, optional nonempty voice without CR/LF, integer rate `-100..100`; silently truncate text. Before speaking status must be available and named voice must exactly match status voices.
- Error mapping: validation 400; unavailable error/status 503; unexpected failure 500 with `Host speech failed. Try again.`; normal outcomes 200.
- Stop body exact `{ runId }`; undefined maps to `{ runId, stopped: false }`, matching/tombstoned result to `stopped: true`.
- Long-lived Speak listens only to `reply.raw` `close`, guarded by `settled` and `writableEnded`; remove listener in finally. Do not use request `aborted` or request `close`.

- [ ] **Step 1: Write failing standalone route tests**

Use Fastify with a hand-written service fake and `app.inject`. Cover status; ended/canceled Speak; matching/stale Stop; malformed fields; unknown voice; unavailable 503; safe 500; and 6,000-character input accepted/truncated to 4,000. For teardown, use a real HTTP server, pending fake Speak, AbortController, and assert exact run-scoped Stop; add normal-resolution control with no Stop.

- [ ] **Step 2: Write failing app lifecycle and negative-scope tests**

Extend `app.testSupport.ts` with an injected fake HostSpeech, captured calls, mutable status, and idempotent close spy. Prove gateway routes, 404 selected-machine TTS paths, close once, and absence from federated route lists.

- [ ] **Step 3: Run focused tests and confirm RED**

```bash
npm test -- --run src/server/tts/ttsRoutes.test.ts src/server/app.tts.test.ts src/server/app.removedBrowserRoutes.test.ts
```

- [ ] **Step 4: Implement thin routes and app registration**

Use route-local exact-object parsers and the lifecycle shape above. Wire one service in `buildApp`; do not edit `src/server/sessiond.ts`.

- [ ] **Step 5: Run focused and broad server checks**

```bash
npm test -- --run src/server/tts/ttsRoutes.test.ts src/server/app.tts.test.ts src/server/app.removedBrowserRoutes.test.ts src/server/configRoutes.test.ts
npm run typecheck
npx eslint src/shared/apiTypes.ts src/server/tts/ttsRoutes.ts src/server/tts/ttsRoutes.test.ts src/server/app.ts src/server/app.testSupport.ts src/server/app.tts.test.ts src/server/app.removedBrowserRoutes.test.ts
npx knip
```

- [ ] **Step 6: Commit**

```bash
git add src/shared/apiTypes.ts src/server/tts/ttsRoutes.ts src/server/tts/ttsRoutes.test.ts src/server/app.ts src/server/app.testSupport.ts src/server/app.tts.test.ts src/server/app.removedBrowserRoutes.test.ts
git commit -m "feat(tts): expose gateway host speech routes"
```

## Task 4: Strict browser API and speech lifecycle controller

**Implementer tier:** Capable

This is original Task 6.

**Files:**

- Modify: `src/client/src/api/parsers.ts`
- Test: `src/client/src/api/parsers.test.ts`
- Modify: `src/client/src/api/clients.ts`
- Test: `src/client/src/api/clients.test.ts`
- Modify: `src/client/src/api.ts`
- Create: `src/client/src/controllers/hostSpeechController.ts`
- Test: `src/client/src/controllers/hostSpeechController.test.ts`

**Interfaces:**

- Consumes carried Task 1 helpers (`truncateHostSpeechText`, `HOST_SPEECH_MAX_TEXT_CHARS`, `isHostSpeechRunId`, `PiWebUiTtsConfig`), Recovery Task 1 status types, Recovery Task 2 speak/terminal types, and Recovery Task 3 stop response.
- Produces strict parsers:

```ts
export function parseHostSpeechStatus(value: unknown): HostSpeechStatus;
export function parseHostSpeechTerminalResult(value: unknown): HostSpeechTerminalResult;
export function parseHostSpeechStopResponse(value: unknown): HostSpeechStopResponse;
```

Each rejects unknown keys, missing required fields, bad enums, malformed voices, duplicate names, and unavailable status without a nonempty reason. Available status may have zero voices.

- Produces `ttsApi`:

```ts
export const ttsApi: {
  status(): Promise<HostSpeechStatus>;
  speak(input: HostSpeechSpeakRequest, signal?: AbortSignal): Promise<HostSpeechTerminalResult>;
  stop(runId: string): Promise<HostSpeechStopResponse>;
};
```

Paths are exactly `api/tts`, `api/tts/speak`, `api/tts/stop`; status uses `{ cache: "no-store" }`; use existing `request()` only; no machine ID.

- Produces `HostSpeechController` with:

```ts
export interface HostSpeechSelection { machineId: string; sessionId: string; }
export interface HostSpeechMessageTarget { machineId: string; sessionId: string; messageKey: string; text: string; }
export interface HostSpeechControllerSnapshot {
  status: HostSpeechStatus;
  loadingStatus: boolean;
  active?: { runId: string; sessionId: string; messageKey: string };
  error?: string;
}
export interface HostSpeechClientApi {
  status(): Promise<HostSpeechStatus>;
  speak(input: HostSpeechSpeakRequest, signal?: AbortSignal): Promise<HostSpeechTerminalResult>;
  stop(runId: string): Promise<HostSpeechStopResponse>;
}
export interface HostSpeechControllerOptions {
  api?: HostSpeechClientApi;
  createRunId?: () => string;
  onStateChange?: () => void;
  scheduleErrorClear?: (callback: () => void, delayMs: number) => () => void;
}
export class HostSpeechController {
  constructor(options?: HostSpeechControllerOptions);
  get snapshot(): HostSpeechControllerSnapshot;
  configure(config: PiWebUiTtsConfig | undefined): void;
  refreshStatus(): Promise<void>;
  select(selection: HostSpeechSelection | undefined): void;
  startManual(target: HostSpeechMessageTarget): Promise<void>;
  stop(): Promise<void>;
  dispose(): void;
}
```

No automatic source or `startAutomatic`.

**Behavior:**

- Initial status unavailable with `Checking OS speech availability.` and no voices. Only local machine selections start. Selection identity change synchronously clears active/aborts pending Speak and asynchronously sends exact Stop; same selection is no-op.
- Configure resolves defaults. Named configured voice is sent only if exactly present in current status voices; stale voice falls back to omitted/system default without making status unavailable.
- Start creates run ID before API, activates immediately, and captures selection/run identity. New manual start aborts/replaces current. Abort and canceled outcomes are non-errors. Terminal/failure clears only matching active run. 500 remains retryable and refreshes status; 503 makes status unavailable with server reason. Retryable errors clear after exactly 5,000 ms.
- Stop clears UI synchronously, aborts Speak, sends Stop; Stop failure is ignored when abort already closed request, otherwise reports retryable error. Dispose idempotently abandons active work, cancels timers, and suppresses future callbacks.

- [ ] **Step 1: Write failing strict parser and URL tests**

Cover valid available/unavailable status, voice variants, ended/canceled results, Stop true/false, all malformed/unknown nested fields, nested app-base absolute fetch URLs, exact bodies/methods/cache/signal, and absence of machine TTS paths.

- [ ] **Step 2: Write failing controller orchestration tests**

Use fake API, deferred Speak, deterministic run IDs `run-1` and `run-2`, controllable aborts, and captured error-clear callback. Cover stale status refresh, defaults/stale voice, immediate active state, replacement abort, stale terminal, selection changes, same-selection no-op, Stop/dispose idempotence, AbortError/canceled non-errors, 500 retryability, and 503 unavailability.

- [ ] **Step 3: Run focused tests and confirm RED**

```bash
npm test -- --run src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts src/client/src/controllers/hostSpeechController.test.ts
```

- [ ] **Step 4: Implement strict API and controller**

Use `request()` only. Detect abort with a DOMException/Error.name type guard that works in Node. Keep controller independent of Lit/AppState; `onStateChange` is the sole host notification; return defensive snapshots.

- [ ] **Step 5: Run focused tests and static checks**

```bash
npm test -- --run src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts src/client/src/controllers/hostSpeechController.test.ts
npm run typecheck
npx eslint src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.ts src/client/src/api/clients.test.ts src/client/src/api.ts src/client/src/controllers/hostSpeechController.ts src/client/src/controllers/hostSpeechController.test.ts
npx knip
```

- [ ] **Step 6: Commit**

```bash
git add src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.ts src/client/src/api/clients.test.ts src/client/src/api.ts src/client/src/controllers/hostSpeechController.ts src/client/src/controllers/hostSpeechController.test.ts
git commit -m "feat(tts): control host speech from the browser"
```

## Task 5: Per-reply Listen and Stop controls

**Implementer tier:** Advanced

This is original Task 7.

**Files:**

- Modify: `src/client/src/components/ChatView.ts`
- Test: `src/client/src/components/ChatView.test.ts`
- Create: `src/client/src/components/ChatView.hostSpeech.test.ts`

**Interfaces:**

```ts
export interface ChatAssistantSpeechAction {
  text: string;
  active: boolean;
  disabled: boolean;
  label: "Listen to assistant reply" | "Stop reading assistant reply";
  title: string;
}

export function chatAssistantSpeechAction(
  message: ChatLine,
  key: string,
  options: {
    enabled: boolean;
    finalized: boolean;
    status: HostSpeechStatus | undefined;
    activeMessageKey?: string;
  },
): ChatAssistantSpeechAction | undefined;
```

ChatView properties:

```ts
@property({ attribute: false }) hostSpeechStatus?: HostSpeechStatus;
@property() activeHostSpeechMessageKey = "";
@property() hostSpeechError = "";
@property({ attribute: false }) onToggleHostSpeech?: (
  target: { message: ChatLine; messageKey: string; text: string },
) => void;
```

**Behavior:**

- Listen exists only with callback, finalized message, and nonempty `assistantSpeechText`. Finalized means not last or last with `status?.isStreaming !== true`.
- Exact active action remains enabled Stop whenever callback and projected text exist, even if no longer finalized or status unavailable. Other speakable replies render Listen.
- Use icon-only `data-message-action="host-speech"` control with 24x24 stable hit area, title, accessible label, local inline SVG, and stop propagation. Existing actions stay unchanged. Nonempty error is an unframed `role="status"` notice near chat top.
- ChatView owns absolute index key derivation. Do not recompute messageStart in app shell.

- [ ] **Step 1: Write failing pure action, template-wiring, and real-DOM tests**

Cover ordinary finalized prose, live line, code/image-only, other roles, compaction/branch summary, unavailable status/reason, exact active key, handler extraction anchored to `data-message-action="host-speech"`, and real jsdom button click/focus/accessibility/disabled/size/error assertions. `ChatView.hostSpeech.test.ts` must have literal first line `// @vitest-environment jsdom`. Only handler wiring may use TemplateResult extraction and must include the documented escape-hatch comment.

- [ ] **Step 2: Run the test and confirm RED**

```bash
npm test -- --run src/client/src/components/ChatView.test.ts
```

- [ ] **Step 3: Implement the fixed-position action and notice**

Keep speech-only action containers, compute finalized locally, bypass gating for exact active Stop, derive keys from ChatView's already-absolute index, add speaker/Stop SVG helpers with hidden/focusable attributes, stop propagation, fix 24x24 CSS geometry, and add the unframed transient notice.

- [ ] **Step 4: Run focused tests and static checks**

```bash
npm test -- --run src/client/src/components/ChatView.test.ts src/client/src/components/ChatView.hostSpeech.test.ts src/client/src/hostSpeechText.test.ts
npm run typecheck
npx eslint src/client/src/components/ChatView.ts src/client/src/components/ChatView.test.ts src/client/src/components/ChatView.hostSpeech.test.ts
npx knip
```

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/ChatView.ts src/client/src/components/ChatView.test.ts src/client/src/components/ChatView.hostSpeech.test.ts
git commit -m "feat(tts): add Listen controls to assistant replies"
```

## Task 6: App-shell lifecycle and Text to speech settings

**Implementer tier:** Capable

This is original Task 8.

**Files:**

- Modify: `src/client/src/components/PiWebUiApp.ts`
- Create: `src/client/src/components/PiWebUiApp.hostSpeech.test.ts`
- Modify: `src/client/src/components/SettingsDialog.ts`
- Test: `src/client/src/components/SettingsDialog.general.test.ts`
- Modify: `src/client/src/components/settings/settingsConfigDraft.ts`
- Test: `src/client/src/components/settings/settingsConfigDraft.test.ts`
- Modify: `src/client/src/components/settings/SettingsGeneralPanel.ts`
- Test: `src/client/src/components/settings/SettingsGeneralPanel.test.ts`

**Interfaces:**

- Consumes Recovery Task 4 controller and Recovery Task 5 ChatView properties/actions, plus `HostSpeechStatus`.
- Produces from `settingsConfigDraft.ts`:

```ts
export interface HostSpeechConfigDraft { voice: string; rate: string; }
export function emptyHostSpeechConfigDraft(): HostSpeechConfigDraft;
export function hostSpeechDraftFromConfig(config: PiWebUiConfigValues): HostSpeechConfigDraft;
export function hostSpeechConfigFromDraft(draft: HostSpeechConfigDraft, baseConfig?: PiWebUiConfigValues): PiWebUiConfigValues;
export function hostSpeechDraftMatchesConfig(draft: HostSpeechConfigDraft, config: PiWebUiConfigValues): boolean;
```

`hostSpeechConfigFromDraft` spreads complete base config, writes `tts: {}` for explicit all-default reset, trims optional voice, omits zero rate, and rejects noninteger/out-of-range rate with `Speech rate must be an integer from -100 to 100.`

SettingsGeneralPanel properties:

```ts
@property({ type: Boolean }) showHostSpeechSettings = false;
@property({ attribute: false }) hostSpeechStatus?: HostSpeechStatus;
@property({ type: Boolean }) hostSpeechStatusLoading = false;
@property({ attribute: false }) onReloadHostSpeech?: () => void | Promise<void>;
```

Matching SettingsDialog properties pass them only to General. `showHostSpeechSettings` is local target only; remote renders no TTS card. The sibling TTS card has OS voice select, System default first, range and numeric rate controls, gateway-host-audio copy, disabled unavailable state/reason, stale-voice option/fallback copy, dirty-aware drafts, and no run mutation on save.

- [ ] **Step 1: Write failing settings and app-shell tests**

Cover draft defaults/full/stale voice, reset/preservation/trimming/rate rejection; enabled/unavailable/remote/stale voice card; complete gateway save and dirty republish; dialog local/remote prop forwarding; connect refresh/configure, disconnect dispose, selection identity ordering, compaction stop ordering, ChatView delegation, settings reload/save, and isolation from `state.error`.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
npm test -- --run src/client/src/components/settings/settingsConfigDraft.test.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts src/client/src/components/SettingsDialog.general.test.ts src/client/src/components/PiWebUiApp.hostSpeech.test.ts
```

- [ ] **Step 3: Implement app-shell ownership**

Construct HostSpeechController before SessionController with requestUpdate callback. In `setState`, compute next before assignment; on machine/session identity change call `select(nextSelection)` first; otherwise rising compaction calls `void stop()` first. Dispose before super disconnect. Pass local-only ChatView speech props; callback stops active key or starts a manual local target. Configure only future runs in applyClientConfig.

- [ ] **Step 4: Implement settings card/save flow**

Add draft helpers and dirty handling, unique voice options with language/variant labels, synchronized integer controls, conditional status reload, and existing gateway save path. Never call TTS API directly from SettingsDialog; no remote settings route.

- [ ] **Step 5: Run focused UI/controller regressions and static checks**

```bash
npm test -- --run src/client/src/controllers/hostSpeechController.test.ts src/client/src/components/ChatView.test.ts src/client/src/components/ChatView.hostSpeech.test.ts src/client/src/components/settings/settingsConfigDraft.test.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts src/client/src/components/SettingsDialog.general.test.ts src/client/src/components/PiWebUiApp.hostSpeech.test.ts
npm run typecheck
npx eslint src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.hostSpeech.test.ts src/client/src/components/SettingsDialog.ts src/client/src/components/SettingsDialog.general.test.ts src/client/src/components/settings/settingsConfigDraft.ts src/client/src/components/settings/settingsConfigDraft.test.ts src/client/src/components/settings/SettingsGeneralPanel.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts
npx knip
```

- [ ] **Step 6: Commit**

```bash
git add src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.hostSpeech.test.ts src/client/src/components/SettingsDialog.ts src/client/src/components/SettingsDialog.general.test.ts src/client/src/components/settings/settingsConfigDraft.ts src/client/src/components/settings/settingsConfigDraft.test.ts src/client/src/components/settings/SettingsGeneralPanel.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts
git commit -m "feat(tts): integrate host speech settings and lifecycle"
```

## Task 7: User documentation, release note, and end-to-end verification

**Implementer tier:** Advanced

This is original Task 9.

**Files:**

- Modify: `docs/config.md`
- Modify: `docs/config.html`
- Create: `.changeset/local-gateway-os-text-to-speech.md`

**Interfaces:**

- Consumes complete behavior from Recovery Tasks 1-6 and the accepted cross-client/security disclosures in the design spec.
- Produces synchronized documentation and exactly:

```md
---
"@hyperdreamer/pi-webui": minor
---

Add local-gateway OS text-to-speech controls for assistant replies, including OS voice/rate settings.
```

- `docs/config.md` adds the TTS JSON example and matrix row with Global scope, leaving selected-machine-safe-key prose unchanged. Runtime effect is the next utterance without service restart.
- A canonical `Local gateway text-to-speech` section documents Linux Speech Dispatcher prerequisite, local host audio, System default/voice/rate defaults, local-only scope, unavailable/stale-voice behavior, Unix-only `SPEECHD_ADDRESS`, shared-priority interaction, and unauthenticated gateway host-audio risk. `docs/config.html` must match. Do not claim synthesis is offline; OS modules may use network-backed services. README and CHANGELOG remain unchanged.

- [ ] **Step 1: Write synchronized documentation and Changeset**

Include the example:

```json
"tts": {
  "voice": "en-US-Test",
  "rate": 20
}
```

State omitted object/fields mean System default and rate 0; the browser sends controls and audio is audible on the gateway host; any client reaching an unauthenticated gateway can trigger audio; link existing trusted-network/reverse-proxy guidance. Document PI WEBUI `text` priority may cancel lower-priority notification/progress speech and higher-priority screen-reader speech may cancel PI WEBUI as ordinary cancellation.

- [ ] **Step 2: Run focused automated checks**

```bash
npm test -- --run src/shared/hostSpeech.test.ts src/config.test.ts src/server/configRoutes.test.ts src/server/tts/ssipProtocol.test.ts src/server/tts/speechDispatcherAdapter.test.ts src/server/tts/hostSpeechService.test.ts src/server/tts/ttsRoutes.test.ts src/server/app.tts.test.ts src/client/src/hostSpeechText.test.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts src/client/src/controllers/hostSpeechController.test.ts src/client/src/components/ChatView.test.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts src/client/src/components/SettingsDialog.general.test.ts src/client/src/components/PiWebUiApp.hostSpeech.test.ts
```

- [ ] **Step 3: Run boundary scans and package checks**

```bash
rg -n 'api/machines/.*/tts|machines/local/tts|FEDERATED_.*tts|WebSocket.*tts|speechSynthesis|spd-say|CANCEL all|STOP all' src
rg -n 'request\\.raw|reply\\.raw' src/server/tts/ttsRoutes.ts
rg -n 'raw fetch|fetch\\(' src/client/src --glob '*.ts'
git diff --check
npm run pack:dry
```

The first scan may find negative tests/comments only; production must not contain remote/browser/global-cancel implementation. Lifecycle hooks stay in TTS routes, no new raw browser fetch appears, diff check passes, and dry package is valid.

- [ ] **Step 4: Run broad verification serially**

```bash
npm run verify:fast
npm run verify
```

- [ ] **Step 5: Perform the real local-gateway host check**

With UI/API and Speech Dispatcher active, operator should exercise status/voices, default and named voice, negative/positive rates, Stop, replacement, session switch, unavailable/recovery, and external Speech Dispatcher cancellation. If no operator confirmation is available, record the manual check as not performed. Never use global `spd-say --stop` or `--cancel`.

- [ ] **Step 6: Review final scope and service ownership**

Confirm no sessiond, federated route, remote-machine route, README, or CHANGELOG change. State that only the web/API/UI service needs autoreload/restart; no session-daemon restart is required.

- [ ] **Step 7: Commit**

```bash
git add docs/config.md docs/config.html .changeset/local-gateway-os-text-to-speech.md
git commit -m "docs(tts): document local gateway host speech"
```
