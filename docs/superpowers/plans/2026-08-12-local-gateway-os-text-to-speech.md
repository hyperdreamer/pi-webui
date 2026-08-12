# Local Gateway OS Text-to-Speech Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in host-audio text-to-speech for finalized PI WEBUI assistant replies on the local gateway machine through Linux Speech Dispatcher.

**Architecture:** The web/API process owns one injected `HostSpeech` service, backed in V1 by a direct SSIP adapter over a local Unix socket. Gateway-only HTTP routes expose status, a long-lived speak operation, and run-scoped stop; a browser `HostSpeechController` owns request/run state for manual per-reply actions and General settings. The browser is only a control surface and never synthesizes, receives, stores, or plays audio.

**Tech Stack:** TypeScript with strict optional-property semantics, Node.js `node:net`, Speech Dispatcher SSIP, Fastify 5, Lit 3, `marked` 18, Vitest 4, and Changesets.

## Global Constraints

- Implement `docs/superpowers/specs/2026-08-12-local-gateway-os-text-to-speech-design.md` except for automatic reading, which this implementation plan explicitly defers. V1 is manual Listen/Stop only: do not add `autoReadAssistantReplies`, an automatic-reading checkbox, finalized-reply handoff, automatic run sources, skip outcomes, or background speech starts.
- V1 is local-gateway-only. Do not add a selected-machine alias, remote-machine proxy, federated HTTP/WebSocket entry, capability negotiation, or any `sessiond` route, protocol, lifecycle, or source change.
- V1 supports Linux Speech Dispatcher through one `HostSpeechProvider` adapter. Do not add an adapter registry, cloud provider, browser speech synthesis, engine picker, arbitrary command template, API key, audio file, cache, or volume setting.
- No new runtime dependencies. Reuse the installed `marked` package for Markdown tokenization and Node's built-in `node:net` API for SSIP.
- Spoken prose is capped at exactly 4,000 UTF-16 code units after projection. Truncate silently; never return a validation error merely because projected prose exceeds the cap.
- Persist speech rate in Speech Dispatcher's native integer range `-100` through `100`; omitted rate resolves to `0`, and omitted voice resolves to the OS default.
- Every browser run ID is an opaque bounded string created before Speak starts. Server stop and terminal handling must compare the exact run ID; stale stop and stale terminal events must never affect a newer run.
- PI WEBUI may send only connection-scoped `CANCEL self`. Never send `STOP all`, `CANCEL all`, another client ID, or any other global Speech Dispatcher control.
- Use application-relative browser paths `api/tts`, `api/tts/speak`, and `api/tts/stop` through the existing `request()` boundary. Do not add raw browser `fetch`, leading-root application URLs, or a TTS WebSocket.
- Manual Listen replaces any active PI WEBUI run. A session, machine selection, or transcript compaction synchronously abandons the browser run and its pending Speak request before the new state is presented. Request-close cancellation and exact run-ID guards make the server cancellation race-safe.
- Message action keys are index-based (`assistant-index:<absoluteIndex>`); transcript compaction during playback stops audio cleanly and requires re-clicking Listen if desired.
- `tsconfig.json` enables `strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess`. Omit optional properties rather than assigning `undefined`; use type guards rather than type assertions.
- Follow red-green TDD at the narrowest useful layer. Use injected transports, clocks, timers, IDs, and deferred promises; do not use sleeps in automated tests.
- Run focused tests first, then typecheck/ESLint/Knip for each task. Never use `git commit --no-verify`.
- Keep `README.md` unchanged. Synchronize `docs/config.md` and `docs/config.html`, add one minor Changeset for `@hyperdreamer/pi-webui`, and never edit `CHANGELOG.md` directly.
- This feature changes only the web/API/client side. A session-daemon restart is not required; the `pi-webui-ui-dev.service` autoreload/restart path is sufficient during development.

## Task 1: Shared speech contracts and gateway config pipeline

**Implementer tier:** Advanced

**Files:**

- Create: `src/shared/hostSpeech.ts`
- Test: `src/shared/hostSpeech.test.ts`
- Modify: `src/shared/apiTypes.ts:249-276`
- Modify: `src/config.ts:20-32,147-203,226-290,429-449`
- Test: `src/config.test.ts:1-410`
- Modify: `src/server/configRoutes.ts:1-180`
- Test: `src/server/configRoutes.test.ts:1-290`
- Modify: `src/client/src/api/parsers.ts:1703-1795`
- Test: `src/client/src/api/parsers.test.ts`
- Modify: `src/client/src/components/settings/settingsConfigDraft.ts:95-106`
- Test: `src/client/src/components/settings/settingsConfigDraft.test.ts:45-90`

**Interfaces:**

- Consumes: the existing `PiWebUiConfigValues` contract, `loadPiWebUiConfig(testOptions())` temp-file test harness, `parseConfigRequest` HTTP parser, and strict client `parsePiWebUiConfigValues` parser.
- Produces from `src/shared/apiTypes.ts`:

```ts
export interface PiWebUiTtsConfig {
  voice?: string;
  rate?: number;
}
```

- Produces `tts?: PiWebUiTtsConfig` on `PiWebUiConfigValues`. Host speech route/status/run types are deliberately deferred until the tasks that consume them, so this task remains Knip-clean.
- Produces from `src/shared/hostSpeech.ts`:

```ts
export const HOST_SPEECH_MAX_TEXT_CHARS = 4_000;
export const HOST_SPEECH_MAX_RUN_ID_CHARS = 128;
export function truncateHostSpeechText(text: string): string;
export function isHostSpeechRunId(value: string): boolean;
export function effectivePiWebUiTtsConfig(config: PiWebUiTtsConfig | undefined): {
  voice?: string;
  rate: number;
};
```

`isHostSpeechRunId` accepts `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`; `truncateHostSpeechText` normalizes CRLF/CR to LF, removes NUL/control characters other than LF and tab, slices to 4,000 code units, and trims trailing whitespace.

- Produces exported `parseTtsConfig(value: unknown, path: string): PiWebUiTtsConfig` from `src/config.ts`.
- Preserves `tts` through a gateway-server form save by adding it to `preservedGatewayConfigRemainder`; deliberately leaves `SELECTED_MACHINE_CONFIG_KEYS` and `pickSelectedMachineConfig` unchanged.

- [ ] **Step 1: Write failing shared-helper and config tests**

Create `src/shared/hostSpeech.test.ts` with these exact behaviors:

```ts
import { describe, expect, it } from "vitest";
import {
  HOST_SPEECH_MAX_RUN_ID_CHARS,
  HOST_SPEECH_MAX_TEXT_CHARS,
  effectivePiWebUiTtsConfig,
  isHostSpeechRunId,
  truncateHostSpeechText,
} from "./hostSpeech";

describe("host speech contracts", () => {
  it("resolves omitted TTS settings to OS defaults", () => {
    expect(effectivePiWebUiTtsConfig(undefined)).toEqual({ rate: 0 });
  });

  it("copies explicit settings without inventing an optional voice", () => {
    expect(effectivePiWebUiTtsConfig({ voice: "en-US-Test", rate: -25 })).toEqual({
      voice: "en-US-Test",
      rate: -25,
    });
  });

  it("normalizes controls and silently truncates host speech text", () => {
    const text = `first\r\nsecond\u0000${"x".repeat(HOST_SPEECH_MAX_TEXT_CHARS)}`;
    const result = truncateHostSpeechText(text);
    expect(result).toMatch(/^first\nsecondx/u);
    expect(result).not.toContain("\u0000");
    expect(result).toHaveLength(HOST_SPEECH_MAX_TEXT_CHARS);
  });

  it.each(["run-1", "550e8400-e29b-41d4-a716-446655440000", "tab:run_2.3"])("accepts opaque run id %s", (runId) => {
    expect(isHostSpeechRunId(runId)).toBe(true);
  });

  it.each(["", " leading", "line\nbreak", "x".repeat(HOST_SPEECH_MAX_RUN_ID_CHARS + 1)])("rejects invalid run id %s", (runId) => {
    expect(isHostSpeechRunId(runId)).toBe(false);
  });
});
```

Append temp-file cases to `src/config.test.ts`. Use the file's existing `configPath`, `writeFile`, `loadPiWebUiConfig(testOptions())`, `savePiWebUiConfig`, and `effectivePiWebUiConfig(testOptions())`; do not invent an in-memory `files` option. Cover:

```ts
await writeFile(configPath, `${JSON.stringify({
  tts: { voice: "en-US-Test", rate: 35 },
})}\n`, "utf8");
expect(loadPiWebUiConfig(testOptions()).config.tts).toEqual({
  voice: "en-US-Test",
  rate: 35,
});
expect(effectivePiWebUiConfig(testOptions()).config.tts).toEqual({
  voice: "en-US-Test",
  rate: 35,
});
```

Also assert omitted config resolves through `effectivePiWebUiTtsConfig` to rate `0`; an unrelated `savePiWebUiConfig({ port: 9000 }, testOptions())` preserves an existing `tts`; `savePiWebUiConfig({ tts: {} }, testOptions())` replaces a prior object with `{}`; and file parsing rejects unknown keys, empty voice, fractional rate, and rates below `-100` or above `100`.

Extend `src/server/configRoutes.test.ts` so `fullConfig()` contains `tts: { voice: "en-US-Test", rate: 20 }`, while `selectedMachineConfig()` does not. Assert:

- gateway `PUT /api/config` accepts and retains valid `tts`;
- gateway `PUT` rejects malformed `tts` before `service.write`;
- `GET /api/machines/local/config` excludes `tts` from both `config` and `effectiveConfig`;
- `PUT /api/machines/local/config` with `{ tts: {} }` returns `400` containing `selected-machine config key is not allowed: tts`;
- an unrelated selected-machine update leaves the gateway's existing `tts` unchanged.

Extend the existing config-response parser cases in `src/client/src/api/parsers.test.ts` to parse all TTS fields and reject malformed nested field types/ranges.

Extend the gateway draft preservation assertion in `settingsConfigDraft.test.ts` with a `tts` input and identical expected output.

- [ ] **Step 2: Run focused tests and confirm they fail for missing TTS contracts**

Run:

```bash
npm test -- --run src/shared/hostSpeech.test.ts src/config.test.ts src/server/configRoutes.test.ts src/client/src/api/parsers.test.ts src/client/src/components/settings/settingsConfigDraft.test.ts
```

Expected: FAIL because `hostSpeech.ts`, TTS types, config parsers, and preservation do not exist. Confirm at least one assertion would fail if `tts` were dropped from each of the file parser, route parser, client response parser, and General-panel preservation helper.

- [ ] **Step 3: Add shared contracts and strict config parsing**

Add the interfaces above to `apiTypes.ts`. Implement `hostSpeech.ts` exactly to the contracts above without importing browser or server modules.

In `config.ts`:

- add `tts` to `piWebUiConfigRecord`;
- parse it in `parsePiWebUiConfig` with `parseTtsConfig`;
- make `EffectivePiWebUiConfig` retain the existing optional `tts` shape; do not materialize a new default object into every legacy `effectiveConfig` response. Consumers call `effectivePiWebUiTtsConfig(config.tts)` at the boundary;
- in `savePiWebUiConfig`, delete `existing["tts"]` only when `normalized.tts !== undefined`. An omitted key means an unrelated partial save and must preserve existing TTS; `{ tts: {} }` is the explicit reset representation.

Implement `parseTtsConfig` with the exact allowed-key set `voice`, `rate`. Reject unknown keys, including `autoReadAssistantReplies`. Trim voice and reject blank values. Require rate to be an integer in `-100..100`. Return only present keys.

In `configRoutes.ts`, import and call the same `parseTtsConfig` from `parseConfigRequest`; do not add `tts` to selected-machine keys or projections.

In the client parser, add `optionalTts(value)` with the same strict leaf validation and range.

Add `tts` to `preservedGatewayConfigRemainder`.

- [ ] **Step 4: Run focused tests and static checks**

Run:

```bash
npm test -- --run src/shared/hostSpeech.test.ts src/config.test.ts src/server/configRoutes.test.ts src/client/src/api/parsers.test.ts src/client/src/components/settings/settingsConfigDraft.test.ts
npm run typecheck
npx eslint src/shared/hostSpeech.ts src/shared/hostSpeech.test.ts src/shared/apiTypes.ts src/config.ts src/config.test.ts src/server/configRoutes.ts src/server/configRoutes.test.ts src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts src/client/src/components/settings/settingsConfigDraft.ts src/client/src/components/settings/settingsConfigDraft.test.ts
npx knip
```

Expected: focused tests pass with no failures; TypeScript and ESLint pass; Knip reports only the repository's existing configuration hints and no unused TTS exports.

- [ ] **Step 5: Commit**

```bash
git add src/shared/hostSpeech.ts src/shared/hostSpeech.test.ts src/shared/apiTypes.ts src/config.ts src/config.test.ts src/server/configRoutes.ts src/server/configRoutes.test.ts src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts src/client/src/components/settings/settingsConfigDraft.ts src/client/src/components/settings/settingsConfigDraft.test.ts
git commit -m "feat(tts): add gateway speech config contracts"
```

## Task 2: Assistant spoken-prose projection

**Implementer tier:** Standard

**Files:**

- Create: `src/client/src/hostSpeechText.ts`
- Test: `src/client/src/hostSpeechText.test.ts`

**Interfaces:**

- Consumes: `ChatLine` and `ChatPart` from `src/client/src/components/shared.ts`; `marked.lexer(text, { gfm: true, breaks: true })`; `truncateHostSpeechText(text)` and `HOST_SPEECH_MAX_TEXT_CHARS` from Task 1.
- Produces:

```ts
export function assistantSpeechText(message: ChatLine): string;
export function assistantSpeechMessageKey(message: ChatLine, absoluteIndex: number): string;
```

`assistantSpeechMessageKey` returns `assistant-index:<absoluteIndex>` for every assistant line. Assistant lines never carry an `entryId`: `historyMessages()` in `src/server/sessions/piSessionService.ts` annotates `entryId`, `previousAssistantEntryId`, and `canFork` only when `role === "user"`. Do not add an entry-id branch; it would be unreachable. ChatView is the single owner of key derivation, and the index it already holds is absolute (see Task 7).

- `assistantSpeechText` returns `""` unless `message.role === "assistant"`, `message.source` is neither `compaction` nor `branch_summary`, and at least one text part yields readable prose.
- It parses each text part through `marked.lexer`; never parse Markdown with ad hoc regexes.
- Block projection keeps heading, paragraph, blockquote, and list-item prose separated by useful newlines. It drops `code` tokens (fenced and indented), `table`, HTML blocks/tags, definitions, horizontal rules, and image tokens.
- Inline projection keeps text, escaped text, emphasis, strong, deletion, inline code text, line breaks, and Markdown link labels. It drops image syntax and drops a link when its visible label is the same raw URL as its destination; link destinations are never included.
- Final output normalizes horizontal whitespace per line, removes empty leading/trailing lines, preserves at most one blank line between prose blocks, joins separate text parts with a paragraph break, then silently truncates through `truncateHostSpeechText`.

- [ ] **Step 1: Write the failing projection test**

Create `src/client/src/hostSpeechText.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HOST_SPEECH_MAX_TEXT_CHARS } from "../../shared/hostSpeech";
import type { ChatLine } from "./components/shared";
import { assistantSpeechMessageKey, assistantSpeechText } from "./hostSpeechText";

function assistant(text: string): ChatLine {
  return { role: "assistant", parts: [{ type: "text", text }] };
}

describe("assistantSpeechText", () => {
  it("keeps headings, paragraphs, list content, and link labels", () => {
    expect(assistantSpeechText(assistant([
      "# Result",
      "",
      "Read the [configuration guide](https://example.test/config).",
      "",
      "- First item",
      "- Second **important** item",
    ].join("\n")))).toBe([
      "Result",
      "",
      "Read the configuration guide.",
      "",
      "First item",
      "Second important item",
    ].join("\n"));
  });

  it("drops fenced code, indented code, tables, images, destinations, and raw URLs", () => {
    expect(assistantSpeechText(assistant([
      "Before.",
      "",
      "```ts",
      "const secret = 1;",
      "```",
      "",
      "    indented()",
      "",
      "| A | B |",
      "| - | - |",
      "| x | y |",
      "",
      "![diagram](image.png)",
      "Visit https://example.test/raw then [the label](https://example.test/label).",
      "",
      "After.",
    ].join("\n")))).toBe("Before.\n\nVisit then the label.\n\nAfter.");
  });

  it("uses only text parts and keeps separate text parts readable", () => {
    const message: ChatLine = {
      role: "assistant",
      parts: [
        { type: "thinking", text: "private reasoning" },
        { type: "text", text: "First paragraph." },
        { type: "image", mimeType: "image/png", data: "AAAA" },
        { type: "text", text: "Second paragraph." },
      ],
    };
    expect(assistantSpeechText(message)).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it.each([
    { role: "user" as const, parts: [{ type: "text" as const, text: "user" }] },
    { role: "assistant" as const, source: "compaction" as const, parts: [{ type: "text" as const, text: "summary" }] },
    { role: "assistant" as const, source: "branch_summary" as const, parts: [{ type: "text" as const, text: "summary" }] },
    { role: "assistant" as const, parts: [{ type: "image" as const, mimeType: "image/png", data: "AAAA" }] },
  ])("returns empty for ineligible message %#", (message) => {
    expect(assistantSpeechText(message)).toBe("");
  });

  it("silently caps the projected prefix", () => {
    const result = assistantSpeechText(assistant(`Start ${"word ".repeat(2_000)}`));
    expect(result.length).toBe(HOST_SPEECH_MAX_TEXT_CHARS);
    expect(result.startsWith("Start word")).toBe(true);
  });

  it("derives an index-based key regardless of any entry metadata", () => {
    expect(assistantSpeechMessageKey(assistant("reply"), 12)).toBe("assistant-index:12");
    expect(assistantSpeechMessageKey({ role: "assistant", entryId: "reply-7", parts: [{ type: "text", text: "reply" }] }, 12)).toBe("assistant-index:12");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails because the helper is missing**

Run: `npm test -- --run src/client/src/hostSpeechText.test.ts`

Expected: FAIL with `Cannot find module './hostSpeechText'`.

- [ ] **Step 3: Implement token-based projection**

Create `hostSpeechText.ts`. Import `marked` and its `Token` type. Implement small exhaustive helpers `blockProse(token: Token): string[]` and `inlineProse(tokens: Token[]): string`. For `Tokens.Generic`, recurse only through an actual `tokens` array; otherwise return no text. For lists, project each `item.tokens` to one or more readable lines without speaking bullet punctuation or ordinal markers. Recognize raw URL links with this predicate:

```ts
function isRawUrlLabel(label: string, href: string): boolean {
  const normalized = label.trim();
  return normalized === href || /^https?:\/\/\S+$/u.test(normalized);
}
```

Do not use DOM rendering or `toSafeMarkdownHtml`; this helper must remain pure and usable in Node tests.

- [ ] **Step 4: Run focused tests and static checks**

Run:

```bash
npm test -- --run src/client/src/hostSpeechText.test.ts
npm run typecheck
npx eslint src/client/src/hostSpeechText.ts src/client/src/hostSpeechText.test.ts
npx knip
```

Expected: all projection tests pass, including exact code/table/URL exclusion and the 4,000-character cap; no unused export finding.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/hostSpeechText.ts src/client/src/hostSpeechText.test.ts
git commit -m "feat(tts): project assistant replies to spoken prose"
```

## Task 3: Speech Dispatcher SSIP adapter

**Implementer tier:** Capable

**Files:**

- Modify: `src/shared/apiTypes.ts:249-276,1611`
- Create: `src/server/tts/hostSpeech.ts`
- Create: `src/server/tts/ssipProtocol.ts`
- Test: `src/server/tts/ssipProtocol.test.ts`
- Create: `src/server/tts/speechDispatcherAdapter.ts`
- Test: `src/server/tts/speechDispatcherAdapter.test.ts`

**Interfaces:**

- Consumes from Task 1: `truncateHostSpeechText` and `HOST_SPEECH_MAX_TEXT_CHARS`.
- Produces these shared status types appended to `src/shared/apiTypes.ts`:

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

Speak, terminal, and stop wire types are deliberately deferred to Tasks 4 and 5, where they first have production consumers. Whole-project Knip fails on exported types that nothing references yet.

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

- `SsipFrameParser` buffers partial CRLF-delimited chunks. Every line is `DDD-...` continuation or `DDD ...` terminal; a frame's continuation lines share one three-digit code. Reject malformed/mixed-code frames and cap retained input at 64 KiB for replies.
- `ssipDataPayload` normalizes through `truncateHostSpeechText`, changes line endings to CRLF, dot-stuffs every line beginning with `.`, and appends exactly `\r\n.\r\n`.
- `ssipMessageId` reads the first `225-<id>` data line from the post-data `SPEAK` reply. Terminal events map `702` to `ended` and `703` to `canceled`, reading message ID and client ID from the first two continuation lines.
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

- Exact duration limits are `2_000` ms connect, `3_000` ms command/data reply, `3_000` ms cancel acknowledgment, and terminal `min(300_000, 30_000 + text.length * 75)` ms. All use injected `scheduleDeadline`; timeout closes the transport and rejects all pending work.
- The default socket is `$XDG_RUNTIME_DIR/speech-dispatcher/speechd.sock`, falling back to `$XDG_CACHE_HOME` or `~/.cache`. An upstream `SPEECHD_ADDRESS` override is accepted only as `unix:/absolute/path` or `unix_socket:/absolute/path`; reject inet or relative addresses so audio remains local-gateway-owned.
- The adapter is lazy. On first connection it sends, in order: `SET SELF CLIENT_NAME pi-webui:tts:main`, `HISTORY GET CLIENT_ID`, `SET SELF NOTIFICATION BEGIN on`, `SET SELF NOTIFICATION END on`, and `SET SELF NOTIFICATION CANCEL on`.
- Commands use one serialized promise chain. The parser routes `7xx` events independently and routes every other frame to the one pending command reply. No external callback or provider method runs while parser state is being mutated.
- `status()` and the first named-voice `enqueue` obtain a fresh `LIST SYNTHESIS_VOICES` result through the serialized command queue; cache that immutable normalized list only until the connection is reset. A later named-voice enqueue validates against that connection-scoped cache. Thus a status refresh sees the current OS voice list without racing command replies, while a connection drop cannot leave a stale list authoritative.
- `enqueue` sets `PRIORITY text`, validates and sets rate, optionally validates exact voice membership from the connection-scoped voice list and sets `SYNTHESIS_VOICE`, sends `SPEAK`, waits for `230`, sends dot-stuffed data, captures the message ID from `225`, and returns its terminal promise.
- If a terminal frame arrives before the `225` message ID is registered, retain it in a bounded 64-entry early-terminal map and consume it immediately after registration. Late terminal events are keyed only by message ID.
- A request with no voice uses the OS default. If the persistent connection previously set a named voice, reconnect before the next default-voice utterance because SSIP has no portable command to clear `SYNTHESIS_VOICE`.
- `cancelSelf` emits only `CANCEL self` and waits for its `213` command acknowledgment; utterance completion still comes from the matching `703` event.

- [ ] **Step 1: Write failing pure SSIP protocol tests**

Create `ssipProtocol.test.ts` covering:

- one complete `249` voice-list frame and frames split across arbitrary chunks;
- two frames in one chunk, including a `702` event interleaved with a command response;
- rejection of non-three-digit codes, invalid separators, mixed continuation codes, invalid event IDs, and over-budget unterminated input;
- `225-42 / 225 OK MESSAGE QUEUED` yields message ID `42`;
- `702-42 / 702-7 / 702 END` and `703` map to exact message/client IDs and outcomes;
- text beginning with `.`, an internal `\n.\n` line, CRLF input, NUL, and a long input are normalized/dot-stuffed/capped before exactly one closing dot line.

Use literal CRLF strings so the test proves wire bytes, for example:

```ts
expect(ssipDataPayload("first\n.\n..third")).toBe("first\r\n..\r\n...third\r\n.\r\n");
```

- [ ] **Step 2: Write failing adapter tests with a scripted transport**

In `speechDispatcherAdapter.test.ts`, define a file-local `ScriptedSsipTransport` implementing the exact interface above. It records writes, exposes `feed(frameText)`, and supports deterministic close. Its factory returns a deferred transport so connect timeout is testable. Use a manually controlled `DeadlineScheduler` that stores callbacks instead of sleeping.

Cover all of these behaviors:

- non-Linux `status()` returns unavailable without opening a transport;
- Linux connection uses the default path and the fixed initialization commands in order;
- only Unix `SPEECHD_ADDRESS` overrides are accepted;
- every `status()` refreshes the voice list over the current connection, while repeated named-voice enqueue calls reuse that list until transport reset;
- voice-list rows split by tabs normalize `none`/empty variant to omitted `variant`, retain name/language, and preserve stable order;
- `enqueue` emits fixed priority/rate/voice commands, `SPEAK`, and dot-stuffed data;
- a default-voice request after a named voice closes/reconnects before speaking;
- unknown voice and invalid rate are rejected without serializing untrusted values;
- a `703` arriving before the `225` reply still resolves the correct utterance as canceled;
- a late `703` for message 4 does not resolve message 11; only `702`/`703` for 11 resolves it;
- an externally caused `703` resolves canceled, not rejected;
- `cancelSelf` writes exactly `CANCEL self`, never a global command;
- command, connect, cancel, and terminal deadline callbacks close the connection and reject deterministically;
- a dropped socket rejects pending commands/utterances and the next `status` or `enqueue` reconnects;
- `close()` is idempotent, settles pending utterances, removes listeners, and never writes a global cancellation command.

- [ ] **Step 3: Run both tests and confirm RED**

Run:

```bash
npm test -- --run src/server/tts/ssipProtocol.test.ts src/server/tts/speechDispatcherAdapter.test.ts
```

Expected: FAIL because all three production modules are missing.

- [ ] **Step 4: Implement the parser and adapter**

Implement the public contracts exactly. Wrap the real `node:net` socket behind `SsipTransport`; resolve the factory only after the socket `connect` event and reject on pre-connect error. Decode socket data as UTF-8 with `StringDecoder` so a multi-byte character split across buffers is not corrupted.

Use small internal helpers for `sendCommand`, `sendData`, `ensureConnected`, `resetConnection`, `listVoices`, and `withDeadline`. The serialized queue may await only internal transport replies. Dispatch terminal resolution with `queueMicrotask` after parser routing so a consumer cannot re-enter command serialization from an event callback.

When `status()` cannot connect/list voices, reset the connection and return:

```ts
{
  available: false,
  reason: "Speech Dispatcher is unavailable on the local gateway.",
  voices: [],
}
```

Do not expose socket paths or raw protocol errors in the browser-facing reason. `enqueue` for the same condition throws `HostSpeechUnavailableError` with that stable message.

- [ ] **Step 5: Run focused tests and static checks**

Run:

```bash
npm test -- --run src/server/tts/ssipProtocol.test.ts src/server/tts/speechDispatcherAdapter.test.ts
npm run typecheck
npx eslint src/server/tts/hostSpeech.ts src/server/tts/ssipProtocol.ts src/server/tts/ssipProtocol.test.ts src/server/tts/speechDispatcherAdapter.ts src/server/tts/speechDispatcherAdapter.test.ts
npx knip
```

Expected: both suites pass with no pending timers/promises; TypeScript/ESLint pass; Knip has no unused TTS interface/export finding.

- [ ] **Step 6: Commit**

```bash
git add src/server/tts/hostSpeech.ts src/server/tts/ssipProtocol.ts src/server/tts/ssipProtocol.test.ts src/server/tts/speechDispatcherAdapter.ts src/server/tts/speechDispatcherAdapter.test.ts
git commit -m "feat(tts): add Speech Dispatcher SSIP adapter"
```

## Task 4: Gateway speech run arbitration

**Implementer tier:** Capable

**Files:**

- Modify: `src/shared/apiTypes.ts:1611`
- Modify: `src/server/tts/hostSpeech.ts`
- Create: `src/server/tts/hostSpeechService.ts`
- Test: `src/server/tts/hostSpeechService.test.ts`

**Interfaces:**

- Consumes from Task 3: `HostSpeechProvider`, `HostSpeechProviderUtterance`, `HostSpeechProviderSpeakRequest`, `HostSpeechUnavailableError`, and `HostSpeechStatus` with the exact signatures stated there.
- Consumes from Task 1: `truncateHostSpeechText`.
- Produces these shared manual-speech wire types appended to `src/shared/apiTypes.ts`:

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

- Produces this service contract appended to `src/server/tts/hostSpeech.ts`:

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

- The default canceled-run tombstone limit is exactly 64. Tombstones are a FIFO `Set`; adding the 65th evicts the oldest. They are retained rather than consumed, so duplicate delayed Speak calls for a stopped ID remain canceled until bounded eviction.
- Control transitions are serialized through one internal promise chain, but `speak()` never holds that chain while waiting for an utterance terminal event.
- Active state is one object containing request, provider message ID once accepted, and a deferred result. Every terminal handler captures that exact object and clears global state only if it is still active.
- `speak` behavior under the serialized transition:
  - a tombstoned ID returns `{ outcome: "canceled" }` without provider work;
  - replacement sends `cancelSelf`, then enqueues the new run without waiting for the old terminal frame;
  - provider terminal `ended`/`canceled` maps to the same API outcome and resolves only its run;
  - provider failure rejects its run and clears it only when still active.
- `stop` on a matching active run tombstones the ID, waits only for `cancelSelf` acknowledgment, and promptly returns `{ runId, outcome: "canceled" }`; the pending Speak resolves when its provider terminal arrives. `stop` on an unmatched ID also records the bounded tombstone to close the Stop-before-Speak race, but returns `undefined` so the HTTP API exposes it as a successful `stopped: false` no-op. It never changes another active run.
- `close` is idempotent, marks closed before external work, cancels/settles the active run as canceled, then closes the provider. A later `speak` rejects; `status` returns unavailable.

- [ ] **Step 1: Write the failing service test using a fake provider**

Create a file-local fake implementing `HostSpeechProvider`. Each `enqueue` returns a distinct message ID and deferred terminal promise; `cancelSelf`, `status`, and `close` are `vi.fn` methods. Add tests for:

1. status passthrough and text truncation before provider enqueue;
2. one run ending normally;
3. manual replacement;
4. stop-before-speak tombstone and stale-stop no-op safety;
5. FIFO tombstone bound at an injected limit of 2;
6. a replaced run's late canceled terminal resolving only the old Speak while the new run remains active;
7. a stale terminal and stale Stop never clearing/canceling the new run;
8. provider enqueue/cancel/terminal failure propagation and same-run cleanup;
9. `close()` canceling the active run, closing once, and making later calls bounded.

The late-terminal regression must explicitly create message IDs 4 and 11 and resolve 4 after 11 is active.

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm test -- --run src/server/tts/hostSpeechService.test.ts`

Expected: FAIL because `HostSpeechService` does not exist.

- [ ] **Step 3: Implement atomic run ownership**

Implement a private `serializeControl<T>(operation: () => Promise<T>): Promise<T>` that advances the chain even when an operation rejects. Create the active object and its deferred result before awaiting provider enqueue so concurrent Stop observes the run. Attach terminal handlers after enqueue returns; compare object identity, never merely run ID, before clearing current state.

Do not call `provider.enqueue`, `provider.cancelSelf`, or `provider.close` from inside a `Map`/parser callback. The service owns run arbitration only; protocol IDs/events remain hidden in the provider.

- [ ] **Step 4: Run focused tests and static checks**

Run:

```bash
npm test -- --run src/server/tts/hostSpeechService.test.ts src/server/tts/speechDispatcherAdapter.test.ts
npm run typecheck
npx eslint src/shared/apiTypes.ts src/server/tts/hostSpeech.ts src/server/tts/hostSpeechService.ts src/server/tts/hostSpeechService.test.ts
npx knip
```

Expected: all race/precedence/tombstone tests pass deterministically and no pending promises leak.

- [ ] **Step 5: Commit**

```bash
git add src/shared/apiTypes.ts src/server/tts/hostSpeech.ts src/server/tts/hostSpeechService.ts src/server/tts/hostSpeechService.test.ts
git commit -m "feat(tts): arbitrate gateway speech runs"
```

## Task 5: Gateway-only TTS routes and web-process lifecycle

**Implementer tier:** Advanced

**Files:**

- Modify: `src/shared/apiTypes.ts:1611`
- Create: `src/server/tts/ttsRoutes.ts`
- Test: `src/server/tts/ttsRoutes.test.ts`
- Modify: `src/server/app.ts:1-65,225-338`
- Modify: `src/server/app.testSupport.ts:1-240`
- Create: `src/server/app.tts.test.ts`
- Test: `src/server/app.removedBrowserRoutes.test.ts`

**Interfaces:**

- Consumes from Task 3: `HostSpeechUnavailableError`, `HostSpeechStatus`, and `SpeechDispatcherAdapter`.
- Consumes from Task 4: `HostSpeech`, `HostSpeechService`, `HostSpeechSpeakRequest`, and `HostSpeechTerminalResult`.
- Consumes from Task 1: `isHostSpeechRunId` and `truncateHostSpeechText`.
- Produces this shared wire type appended to `src/shared/apiTypes.ts`, deferred until this task because this is its first consumer:

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

export function registerTtsRoutes(
  app: FastifyInstance,
  speech: TtsRouteService,
  prefix?: string,
): void;
```

`prefix` defaults to `"/api"`; only `registerTtsRoutes(app, hostSpeech)` is called in production.

- Adds `hostSpeech?: HostSpeech` to `AppDependencies`. Default construction is `new HostSpeechService(new SpeechDispatcherAdapter())`; the adapter's Unix-socket connection and voice discovery remain lazy until a status/speak request uses them.
- Registers `GET /api/tts`, `POST /api/tts/speak`, and `POST /api/tts/stop` exactly once. Adds `app.addHook("onClose", () => hostSpeech.close())`.
- Does not register `/api/machines/local/tts`, `/api/machines/:machineId/tts`, a federated route, or a socket.
- Speak body validation requires an exact object with only `runId`, `text`, `voice`, and `rate`; validates run ID, nonempty text, optional nonempty voice without CR/LF, and integer rate `-100..100`. It silently truncates text. Before speaking, status must be available and any named voice must exactly match `status.voices[].name`.
- Error mapping is: validation `400`; `HostSpeechUnavailableError` or unavailable status `503`; unexpected provider/OS failure `500` with `Host speech failed. Try again.`; normal ended/canceled outcomes remain `200`.
- Stop body is exact `{ runId }`; converts an internal stale `undefined` to `{ runId, stopped: false }`, and a matching/tombstoned result to `{ runId, stopped: true }`.
- Long-lived Speak cancellation listens to the response socket's `close` event. It calls matching `stop(runId)` only while Speak has not settled and the response did not end normally. Remove the listener in `finally`. Do not listen to the request stream's normal `close` event merely because request-body reading completed.

- [ ] **Step 1: Write failing standalone route tests**

Use `Fastify({ logger: false })`, a hand-written `TtsRouteService` fake, and `app.inject` for ordinary cases. Cover status, ended/canceled Speak, matching/stale Stop, every malformed field, unknown voice, unavailable `503`, safe `500`, and a 6,000-character text accepted/truncated to exactly 4,000 before `service.speak`.

For connection teardown, start the Fastify instance on `127.0.0.1` port `0` as existing real-HTTP tests do. Make fake `speak` signal that it entered and remain pending. Send a real `fetch` with an `AbortController`, abort after entry, and assert `service.stop` is called exactly with the captured run ID. Add a control test where `speak` resolves normally and neither request nor response close calls Stop.

- [ ] **Step 2: Write failing app lifecycle and negative-scope tests**

Extend `app.testSupport.ts` with an injected fake `HostSpeech`, captured speak/stop calls, mutable status, and an idempotent `close` spy exposed through `appTestContext`. In `app.tts.test.ts`, use `registerAppTestHooks()` and prove:

- the three gateway routes reach the injected service;
- `/api/machines/local/tts` and `/api/machines/remote-a/tts` return `404`;
- closing a separately built app invokes `hostSpeech.close()` once.

In `app.removedBrowserRoutes.test.ts` or the existing route-contract negative test, assert no TTS path exists in `FEDERATED_HTTP_ROUTES` or `FEDERATED_WEBSOCKET_ROUTES`.

- [ ] **Step 3: Run focused tests and confirm RED**

Run:

```bash
npm test -- --run src/server/tts/ttsRoutes.test.ts src/server/app.tts.test.ts src/server/app.removedBrowserRoutes.test.ts
```

Expected: FAIL because routes, dependency wiring, and shutdown ownership are missing.

- [ ] **Step 4: Implement thin routes and app registration**

Implement route-local exact-object parsers; do not expose the concrete adapter to handlers. Use this lifecycle shape for Speak:

```ts
let settled = false;
const cancelAbandonedRun = (): void => {
  if (!settled && !reply.raw.writableEnded) void speech.stop(input.runId);
};
reply.raw.once("close", cancelAbandonedRun);
try {
  const result = await speech.speak(input);
  settled = true;
  return result;
} finally {
  settled = true;
  reply.raw.off("close", cancelAbandonedRun);
}
```

Do not use `request.raw.once("aborted", ...)`: the `aborted` event is deprecated on `IncomingMessage` (Node >= 17, and this repository requires Node >= 22.19.0). Do not use `request.raw.once("close", ...)` either, because a normal completed request body may close while the long-lived response is still pending.

If Fastify/Node emits a different close sequence in the real-HTTP control test, adjust the guard using `reply.raw.destroyed` and `reply.raw.writableEnded`; do not remove the aborted-client test and do not cancel on a normally completed response.

Wire one service in `buildApp`, register routes once near other gateway-only routes, and close it through Fastify. Do not edit `src/server/sessiond.ts`.

- [ ] **Step 5: Run focused and broad server checks**

Run:

```bash
npm test -- --run src/server/tts/ttsRoutes.test.ts src/server/app.tts.test.ts src/server/app.removedBrowserRoutes.test.ts src/server/configRoutes.test.ts
npm run typecheck
npx eslint src/shared/apiTypes.ts src/server/tts/ttsRoutes.ts src/server/tts/ttsRoutes.test.ts src/server/app.ts src/server/app.testSupport.ts src/server/app.tts.test.ts src/server/app.removedBrowserRoutes.test.ts
npx knip
```

Expected: all tests pass; the abort case proves exact run-scoped cleanup; no sessiond or federated file is modified.

- [ ] **Step 6: Commit**

```bash
git add src/shared/apiTypes.ts src/server/tts/ttsRoutes.ts src/server/tts/ttsRoutes.test.ts src/server/app.ts src/server/app.testSupport.ts src/server/app.tts.test.ts src/server/app.removedBrowserRoutes.test.ts
git commit -m "feat(tts): expose gateway host speech routes"
```

## Task 6: Strict browser API and speech lifecycle controller

**Implementer tier:** Capable

**Files:**

- Modify: `src/client/src/api/parsers.ts`
- Test: `src/client/src/api/parsers.test.ts`
- Modify: `src/client/src/api/clients.ts:150-205,538-575`
- Test: `src/client/src/api/clients.test.ts`
- Modify: `src/client/src/api.ts:1-8`
- Create: `src/client/src/controllers/hostSpeechController.ts`
- Test: `src/client/src/controllers/hostSpeechController.test.ts`

**Interfaces:**

- Consumes from Task 1: `truncateHostSpeechText`, `HOST_SPEECH_MAX_TEXT_CHARS`, `isHostSpeechRunId`, and `PiWebUiTtsConfig`.
- Consumes `HostSpeechStatus` and `HostSpeechVoice` from Task 3, `HostSpeechSpeakRequest` and `HostSpeechTerminalResult` from Task 4, and `HostSpeechStopResponse` from Task 5.
- Produces strict parsers:

```ts
export function parseHostSpeechStatus(value: unknown): HostSpeechStatus;
export function parseHostSpeechTerminalResult(value: unknown): HostSpeechTerminalResult;
export function parseHostSpeechStopResponse(value: unknown): HostSpeechStopResponse;
```

Each parser rejects unknown keys, missing required fields, bad enums, malformed voices, duplicate voice names, and an unavailable status without a nonempty reason. An available status may have zero voices because the OS default can still work.

- Produces `ttsApi` from `clients.ts`, re-exported by `api.ts`:

```ts
export const ttsApi: {
  status(): Promise<HostSpeechStatus>;
  speak(input: HostSpeechSpeakRequest, signal?: AbortSignal): Promise<HostSpeechTerminalResult>;
  stop(runId: string): Promise<HostSpeechStopResponse>;
};
```

Paths are exactly `api/tts`, `api/tts/speak`, `api/tts/stop`; status uses `{ cache: "no-store" }`.

- Produces from `hostSpeechController.ts`:

```ts
export interface HostSpeechSelection {
  machineId: string;
  sessionId: string;
}

export interface HostSpeechMessageTarget {
  machineId: string;
  sessionId: string;
  messageKey: string;
  text: string;
}

export interface HostSpeechControllerSnapshot {
  status: HostSpeechStatus;
  loadingStatus: boolean;
  active?: {
    runId: string;
    sessionId: string;
    messageKey: string;
  };
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

V1 has no `startAutomatic` and the Speak request has no source field.

- The initial status is unavailable with reason `Checking OS speech availability.` and an empty voice list.
- Only `machineId === "local"` selections can start. `select` compares machine/session identity; a change synchronously clears active state, aborts its pending Speak request, and asynchronously sends exact Stop. Same-selection calls are no-ops.
- `configure` resolves defaults. A configured voice is sent only when it exactly matches the current status voice list; a stale saved voice falls back to omitted/system default without making status unavailable.
- Start creates the run ID before issuing the API call, makes it active immediately, and captures selection/run identity. A new `startManual` aborts and replaces any current run.
- Abort is a normal cancellation and never creates an error. Terminal completion or failure clears state only when its run ID is still active. A stale result cannot clear a newer run.
- Retryable failure creates a controller-local error for exactly 5,000 ms. A `503` also replaces status with unavailable and its safe error message; `500` leaves Listen retryable and triggers a background status refresh.
- `stop` clears active UI synchronously, aborts Speak, and sends Stop; Stop failure is ignored as an error only when abort already closed the pending request, otherwise report a retryable error.
- `dispose` is idempotent, cancels error timers, and performs the same active-run abandonment without future state callbacks.

- [ ] **Step 1: Write failing strict parser and URL tests**

Add parser cases for valid available/unavailable status, voice variants, ended/canceled terminal outcomes, Stop true/false, and every malformed/unknown nested field.

Add client tests under a nested app base. Assert the three exact absolute fetch URLs after one `resolveAppUrl`, JSON bodies, method, status cache mode, and that the exact `AbortSignal` reaches Speak. Assert `ttsApi` has no machine ID parameter/path and never constructs `/api/machines/.../tts`.

- [ ] **Step 2: Write failing controller orchestration tests**

Use a fake `HostSpeechClientApi`, deferred Speak promises, deterministic IDs `run-1`, `run-2`, controllable abort signals, and a captured error-clear callback. Cover:

1. stale status refresh cannot replace a newer refresh;
2. config defaults and stale-voice fallback;
3. manual active state before the Speak promise settles;
4. a second `startManual` aborts the previous signal and replaces the active run;
5. matching terminal clears, stale terminal does not;
6. session/local-to-remote selection changes synchronously abort and Stop;
7. same selection does not Stop;
8. explicit Stop and dispose are idempotent;
9. AbortError and canceled outcomes are non-errors;
10. retryable `500` error remains retryable and clears after 5 seconds;
11. `503` makes availability disabled with the server reason.

- [ ] **Step 3: Run focused tests and confirm RED**

Run:

```bash
npm test -- --run src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts src/client/src/controllers/hostSpeechController.test.ts
```

Expected: FAIL because parsers, `ttsApi`, and the controller are missing.

- [ ] **Step 4: Implement strict API and controller state machine**

Use the existing `request()` function only. Detect abort with a type guard checking `error instanceof DOMException && error.name === "AbortError"` plus the cross-runtime `Error.name` fallback; do not assume browser globals exist in Node tests.

Keep `HostSpeechController` independent of Lit, `AppState`, transcript parsing, and rendering. `onStateChange` is the sole host notification. Return defensive snapshot objects so callers cannot mutate controller state.

- [ ] **Step 5: Run focused tests and static checks**

Run:

```bash
npm test -- --run src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts src/client/src/controllers/hostSpeechController.test.ts
npm run typecheck
npx eslint src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.ts src/client/src/api/clients.test.ts src/client/src/api.ts src/client/src/controllers/hostSpeechController.ts src/client/src/controllers/hostSpeechController.test.ts
npx knip
```

Expected: all tests pass and no raw `fetch` or root-relative TTS URL appears.

- [ ] **Step 6: Commit**

```bash
git add src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.ts src/client/src/api/clients.test.ts src/client/src/api.ts src/client/src/controllers/hostSpeechController.ts src/client/src/controllers/hostSpeechController.test.ts
git commit -m "feat(tts): control host speech from the browser"
```

## Task 7: Per-reply Listen and Stop controls

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/ChatView.ts:279-310,317-365,580-655,1223-1310,1760-1864`
- Test: `src/client/src/components/ChatView.test.ts:1-115`
- Create: `src/client/src/components/ChatView.hostSpeech.test.ts`

**Interfaces:**

- Consumes `HostSpeechStatus` from Task 3, plus `assistantSpeechText(message: ChatLine): string` and `assistantSpeechMessageKey(message: ChatLine, absoluteIndex: number): string` from Task 2.
- Produces:

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

- Adds `ChatView` properties:

```ts
@property({ attribute: false }) hostSpeechStatus?: HostSpeechStatus;
@property() activeHostSpeechMessageKey = "";
@property() hostSpeechError = "";
@property({ attribute: false }) onToggleHostSpeech?: (
  target: { message: ChatLine; messageKey: string; text: string },
) => void;
```

- A Listen action exists only when the callback is present (local-gateway selected), the message is finalized, and `assistantSpeechText` is nonempty. A message is **finalized** when it is not the last message in the transcript OR when it is the last message and the session is not actively streaming (`status?.isStreaming !== true`). This is a local render-time check; no `SessionController` modification is needed.
- The exact active action remains rendered as enabled Stop whenever the callback is present and the projected text is nonempty, even if the message is no longer finalized or host status has become unavailable. This preserves the user's cancellation control until the app shell explicitly invalidates the run.
- The exact active key renders Stop in the same fixed button position and remains enabled so it can cancel. Every other speakable reply renders Listen.
- Use an icon-only button with `data-message-action="host-speech"`, a 24 by 24 stable hit area, tooltip, and accessible label. Reuse local inline SVG conventions because no icon library is installed; do not add a dependency.
- A nonempty `hostSpeechError` renders a concise `role="status"` transient error near the chat top, not through `AppState.error`.
- Existing Copy/Edit/Fork controls and message metadata behavior remain unchanged.

- [ ] **Step 1: Write failing pure action and template-wiring tests**

Add pure cases for ordinary finalized assistant prose, a live (`finalized: false`) assistant line, code/image-only assistant, other roles, compaction/branch summary, unavailable status/reason, and exact active key. Use `assistantSpeechMessageKey` for the absolute-index fallback and assert the same key is used by the action template.

Add narrow TemplateResult handler-extraction tests following the existing documented escape hatch. Anchor to `data-message-action="host-speech"`; assert Listen calls `onToggleHostSpeech` with message, key, and projected prose, active calls the same callback with the active target, and a disabled unavailable handler does not invoke the callback. Add the guide-required comment explaining why direct handler extraction is proportionate for template wiring only.

Create `ChatView.hostSpeech.test.ts` with literal first line `// @vitest-environment jsdom`. Render the real custom element and use real button clicks/focus to assert the icon-only control's accessible label/title, unavailable reason and disabled state, enabled active Stop state, stable 24 by 24 class/markup contract, and `hostSpeechError` `role="status"` notice. Also assert remote/no callback omits Listen and Stop occurs only on the active key. Do not use TemplateResult extraction for these accessibility or focus assertions.

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm test -- --run src/client/src/components/ChatView.test.ts`

Expected: FAIL because speech action helpers/properties/markup are missing.

- [ ] **Step 3: Implement the fixed-position action and transient notice**

Update the early return in `renderMessageActions` so a speech-only action still creates the action container. Compute `finalized` locally: a message is finalized unless it's the last in `this.messages` and `this.status?.isStreaming === true`. Pass the action's explicit active-key match separately so active Stop bypasses finalized/availability gating. Use `assistantSpeechMessageKey(message, absoluteIndex)` for assistant message keys, where `absoluteIndex` is the index ChatView already holds (which includes `this.messageStart` from `groupChatMessages`). Use dedicated speaker and square Stop SVG helpers with `aria-hidden="true"` and `focusable="false"`. Stop propagation in the click handler before invoking the callback.

Add CSS that fixes `.msg-action[data-message-action="host-speech"]` inline/block size and centers its SVG; do not let title, loading state, or icon changes resize `.msg-header-trailing`.

Extend `renderTopNotices` to include the controller-local speech error as an unframed notice alongside existing top notices without nesting cards.

- [ ] **Step 4: Run focused tests and static checks**

Run:

```bash
npm test -- --run src/client/src/components/ChatView.test.ts src/client/src/components/ChatView.hostSpeech.test.ts src/client/src/hostSpeechText.test.ts
npm run typecheck
npx eslint src/client/src/components/ChatView.ts src/client/src/components/ChatView.test.ts src/client/src/components/ChatView.hostSpeech.test.ts
npx knip
```

Expected: all action/accessibility/state tests pass and existing action tests remain green.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/ChatView.ts src/client/src/components/ChatView.test.ts src/client/src/components/ChatView.hostSpeech.test.ts
git commit -m "feat(tts): add Listen controls to assistant replies"
```

## Task 8: App-shell lifecycle and Text to speech settings

**Implementer tier:** Capable

**Files:**

- Modify: `src/client/src/components/PiWebUiApp.ts:185-355,390-430,640-815,4337-4341,4609`
- Create: `src/client/src/components/PiWebUiApp.hostSpeech.test.ts`
- Modify: `src/client/src/components/SettingsDialog.ts:21-125,252-268`
- Test: `src/client/src/components/SettingsDialog.general.test.ts`
- Modify: `src/client/src/components/settings/settingsConfigDraft.ts:1-106`
- Test: `src/client/src/components/settings/settingsConfigDraft.test.ts`
- Modify: `src/client/src/components/settings/SettingsGeneralPanel.ts:1-318`
- Test: `src/client/src/components/settings/SettingsGeneralPanel.test.ts`

**Interfaces:**

- Consumes from Task 6: `HostSpeechController` and its exact `snapshot`, `configure`, `refreshStatus`, `select`, `startManual`, `stop`, and `dispose` methods.
- Consumes from Task 7: the four ChatView speech properties and callback.
- Consumes `HostSpeechStatus` from Task 3 for Settings properties.
- Produces from `settingsConfigDraft.ts`:

```ts
export interface HostSpeechConfigDraft {
  voice: string;
  rate: string;
}

export function emptyHostSpeechConfigDraft(): HostSpeechConfigDraft;
export function hostSpeechDraftFromConfig(config: PiWebUiConfigValues): HostSpeechConfigDraft;
export function hostSpeechConfigFromDraft(
  draft: HostSpeechConfigDraft,
  baseConfig?: PiWebUiConfigValues,
): PiWebUiConfigValues;
export function hostSpeechDraftMatchesConfig(
  draft: HostSpeechConfigDraft,
  config: PiWebUiConfigValues,
): boolean;
```

`hostSpeechConfigFromDraft` spreads the complete base config and writes `tts: {}` for explicit all-default reset. It trims optional voice, omits rate when zero, and rejects non-integer/out-of-range rate with `Speech rate must be an integer from -100 to 100.`.

- Adds `SettingsGeneralPanel` properties:

```ts
@property({ type: Boolean }) showHostSpeechSettings = false;
@property({ attribute: false }) hostSpeechStatus?: HostSpeechStatus;
@property({ type: Boolean }) hostSpeechStatusLoading = false;
@property({ attribute: false }) onReloadHostSpeech?: () => void | Promise<void>;
```

- Adds matching `SettingsDialog` properties and passes them only to General. `showHostSpeechSettings` is `settingsTarget().kind === "local"`; remote selection renders no TTS card even though gateway server settings remain present.
- The TTS card is a sibling of existing cards, not nested. It contains OS voice select (System default first) and range plus numeric rate input. It says audio plays on the local gateway, not the browser.
- Unavailable status keeps the card visible but disables all controls and save with the reason. A configured voice missing from `status.voices` appears as `<saved voice> (unavailable)` and shows that System default will be used until another choice is saved.
- Draft is dirty-aware: status refresh never resets edits; config response rehydrates only when not dirty or when the saved config matches the draft.
- Saving does not stop or mutate an in-progress run. `PiWebUiApp.applyClientConfig` configures only future runs.

- [ ] **Step 1: Write failing settings draft and panel tests**

Extend `settingsConfigDraft.test.ts` for default/full/stale voice drafts, all-default `{ tts: {} }` reset, base-config preservation, trimming, and rate rejection.

Extend `SettingsGeneralPanel.test.ts` to assert:

- local enabled status renders System default, normalized voices, and rate controls;
- unavailable status leaves the card visible, disabled, and shows its reason;
- stale configured voice renders an unavailable option and default-fallback message;
- remote `showHostSpeechSettings=false` omits the card;
- a submit calls only gateway `onSave` with complete base config plus normalized `tts`;
- dirty draft survives status/config republish until matching saved config arrives;
- gateway server saves continue preserving existing `tts`.

Extend `SettingsDialog.general.test.ts` template-boundary assertions to prove local passes status/reload/show=true and remote passes show=false without calling any remote TTS API.

- [ ] **Step 2: Write failing app-shell integration tests**

Create `PiWebUiApp.hostSpeech.test.ts` using the established `Reflect`/TemplateResult seams. Inject or spy on the private `HostSpeechController` boundary. Prove:

1. connect refreshes status and initial/saved config calls `configure`;
2. disconnect disposes speech;
3. selected session/machine identity changes call `select`, including local-to-remote, before the state assignment presents the new transcript;
4. `status.isCompacting` becoming true stops speech before the state assignment presents compaction state;
6. ChatView receives status, active key, transient error, and manual toggle delegates to start/stop;
7. SettingsDialog receives gateway speech snapshot/reload and a saved config updates future controller settings only;
8. speech failures never write `state.error` or unmount the session start/chat surface.

- [ ] **Step 3: Run focused tests and confirm RED**

Run:

```bash
npm test -- --run src/client/src/components/settings/settingsConfigDraft.test.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts src/client/src/components/SettingsDialog.general.test.ts src/client/src/components/PiWebUiApp.hostSpeech.test.ts
```

Expected: FAIL because app/settings speech wiring and TTS drafts do not exist.

- [ ] **Step 4: Implement app-shell ownership**

Construct `HostSpeechController` before `SessionController` with `onStateChange: () => this.requestUpdate()`.

In `PiWebUiApp.setState`, compute `next = { ...this.state, ...patch }` without assigning it yet. Derive the previous and next `{ machineId, sessionId }` speech selections. If identity changed, call `hostSpeech.select(nextSelection)` (or `undefined`) before assigning `this.state = next`; `select` synchronously clears/aborts the old run before it sends asynchronous Stop, and same-selection calls are no-ops. If identity did not change but `next.status?.isCompacting === true` while the previous status was not compacting, call `void hostSpeech.stop()` before assigning `this.state = next`. Then continue the existing post-assignment transition handlers unchanged.

Call `refreshStatus` on connect and `dispose` before `super.disconnectedCallback()`.

In `renderChatView`, pass speech props only when selected machine ID is `local`. ChatView already owns message-key derivation using its absolute indices (which include `messageStart` from `groupChatMessages`); do not recompute keys in the app shell—just pass the callback. The callback calls `stop()` when its target key is active, otherwise calls `startManual({ ...target, machineId: "local", sessionId: state.selectedSession.id })`.

In `applyClientConfig`, call `hostSpeech.configure(config.tts)` after existing shortcut/upload updates.

- [ ] **Step 5: Implement the settings card and save flow**

Add draft helpers and dirty-state handling. Build the voice options from unique status names; show language/variant in labels but persist only exact name. Keep slider and numeric input synchronized through one `updateHostSpeechDraft` method. Use rate `min="-100"`, `max="100"`, `step="1"` on both.

Add `reloadAll` host-status refresh only when `showHostSpeechSettings` is true. TTS submit calls existing gateway `onSave`, so `SettingsDialog.saveConfig` and `onConfigSaved` remain the single persistence/application path.

Pass controller snapshot into `SettingsDialog` from `PiWebUiApp`. Do not make `SettingsDialog` call `ttsApi` directly and do not add a TTS settings route for remote machines.

- [ ] **Step 6: Run focused UI/controller regressions and static checks**

Run:

```bash
npm test -- --run src/client/src/controllers/hostSpeechController.test.ts src/client/src/components/ChatView.test.ts src/client/src/components/ChatView.hostSpeech.test.ts src/client/src/components/settings/settingsConfigDraft.test.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts src/client/src/components/SettingsDialog.general.test.ts src/client/src/components/PiWebUiApp.hostSpeech.test.ts
npm run typecheck
npx eslint src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.hostSpeech.test.ts src/client/src/components/SettingsDialog.ts src/client/src/components/SettingsDialog.general.test.ts src/client/src/components/settings/settingsConfigDraft.ts src/client/src/components/settings/settingsConfigDraft.test.ts src/client/src/components/settings/SettingsGeneralPanel.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts
npx knip
```

Expected: all manual/local-only/settings tests pass; no selected-machine TTS request exists; no global app error is used.

- [ ] **Step 7: Commit**

```bash
git add src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.hostSpeech.test.ts src/client/src/components/SettingsDialog.ts src/client/src/components/SettingsDialog.general.test.ts src/client/src/components/settings/settingsConfigDraft.ts src/client/src/components/settings/settingsConfigDraft.test.ts src/client/src/components/settings/SettingsGeneralPanel.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts
git commit -m "feat(tts): integrate host speech settings and lifecycle"
```

## Task 9: User documentation, release note, and end-to-end verification

**Implementer tier:** Advanced

**Files:**

- Modify: `docs/config.md:1-334`
- Modify: `docs/config.html:1-808`
- Create: `.changeset/local-gateway-os-text-to-speech.md`

**Interfaces:**

- Consumes: the complete behavior from Tasks 1-8 and the accepted cross-client/security disclosures in the design spec.
- Produces synchronized user-facing configuration/operation documentation and this exact Changeset shape:

```md
---
"@hyperdreamer/pi-webui": minor
---

Add local-gateway OS text-to-speech controls for assistant replies, including OS voice/rate settings.
```

- `docs/config.md` adds `tts` to the global config example and Configuration matrix. The matrix scope is Global; selected-machine-safe-key prose remains unchanged and must not list `tts`; runtime effect is the next utterance without a service restart.
- A canonical `Local gateway text-to-speech` key-details section documents Linux Speech Dispatcher prerequisite, local host audio, System default/voice/rate defaults, local-only scope, unavailable/stale-voice behavior, `SPEECHD_ADDRESS` Unix-only override, shared-priority interaction, and no-auth host-audio risk.
- `docs/config.html` gets matching nav, matrix, example, and detail claims. Do not claim that synthesis is offline; OS modules may use network-backed services.
- `README.md` and `CHANGELOG.md` remain unchanged.

- [ ] **Step 1: Write synchronized documentation and the minor Changeset**

Add a JSON example under `tts`:

```json
"tts": {
  "voice": "en-US-Test",
  "rate": 20
}
```

Document that omitting the object or its fields means System default and rate 0. State that the browser only sends controls and audio is audible on the gateway host. Include the warning that any client able to reach an unauthenticated PI WEBUI gateway can trigger host audio; point to the existing trusted-network/reverse-proxy security guidance instead of duplicating it.

Document accepted Speech Dispatcher priority behavior: PI WEBUI `text` priority may cancel other clients' lower-priority notification/progress speech, and higher-priority speech such as a screen reader may cancel PI WEBUI speech without a PI WEBUI error.

- [ ] **Step 2: Run focused automated contract checks**

Run:

```bash
npm test -- --run src/shared/hostSpeech.test.ts src/config.test.ts src/server/configRoutes.test.ts src/server/tts/ssipProtocol.test.ts src/server/tts/speechDispatcherAdapter.test.ts src/server/tts/hostSpeechService.test.ts src/server/tts/ttsRoutes.test.ts src/server/app.tts.test.ts src/client/src/hostSpeechText.test.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts src/client/src/controllers/hostSpeechController.test.ts src/client/src/components/ChatView.test.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts src/client/src/components/SettingsDialog.general.test.ts src/client/src/components/PiWebUiApp.hostSpeech.test.ts
```

Expected: all focused tests pass with no failures.

- [ ] **Step 3: Run boundary scans and documentation/package checks**

Run:

```bash
rg -n 'api/machines/.*/tts|machines/local/tts|FEDERATED_.*tts|WebSocket.*tts|speechSynthesis|spd-say|CANCEL all|STOP all' src
rg -n 'request\.raw|reply\.raw' src/server/tts/ttsRoutes.ts
rg -n 'raw fetch|fetch\(' src/client/src --glob '*.ts'
git diff --check
npm run pack:dry
```

Expected:

- the first scan finds only negative tests/comments where appropriate, no production remote/browser/global-cancel implementation;
- lifecycle hooks are confined to the TTS route and guarded by the request-abort test;
- no new raw browser fetch appears;
- diff check passes;
- the dry package includes `docs/config.md` and the built source path after normal packaging, without requiring `docs/config.html` to be in the npm allowlist.

- [ ] **Step 4: Run broad verification on an otherwise idle machine**

Run:

```bash
npm run verify:fast
npm run verify
```

Run these serially, with no subsession or other full suite active. Expected: typecheck, ESLint, Knip, and serial Vitest all pass.

- [ ] **Step 5: Perform the real local-gateway host check**

With the UI/API service running and Speech Dispatcher active, open PI WEBUI on the local gateway and have the operator confirm audible output. Exercise:

1. status and voice enumeration;
2. Listen with System default and one named voice;
3. rates below and above zero;
4. Stop during a long reply;
5. manual replacement;
6. session switch stopping audio;
7. disabled state after stopping Speech Dispatcher, then recovery after restarting it;
8. another Speech Dispatcher client or screen reader canceling PI WEBUI speech as an ordinary canceled terminal result.

If the operator cannot hear the gateway host, record this manual check as not performed rather than claiming success. Do not use `spd-say --stop` or `spd-say --cancel` during the check because those are global controls.

- [ ] **Step 6: Review final scope and service ownership**

Run `git status --short` and `git diff --stat` from the feature branch. Confirm no `src/server/sessiond.ts`, session-daemon protocol, federated route, remote-machine TTS route, README, or CHANGELOG change exists. State in the handoff that only the web/API/UI service needs autoreload/restart and no manual session-daemon restart is required.

- [ ] **Step 7: Commit**

```bash
git add docs/config.md docs/config.html .changeset/local-gateway-os-text-to-speech.md
git commit -m "docs(tts): document local gateway host speech"
```
