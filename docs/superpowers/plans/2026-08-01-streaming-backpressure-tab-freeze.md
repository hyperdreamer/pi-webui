# Streaming Backpressure Tab-Freeze Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the browser tab from freezing when a provider streams output quickly, by coalescing high-frequency stream events and by never Markdown-caching intermediate streaming text.

**Architecture:** Three independent layers each get a bounded-work seam. (1) A new pure `coalesceTranscriptEvents` helper merges runs of adjacent `assistant.delta` / `assistant.thinking.delta` / `shell.chunk` events before they are applied, so one animation frame does O(1) immutable transcript rebuilds instead of O(n). (2) `toSafeMarkdownHtml` gains an explicit `cache` option so live streaming renders parse without polluting the 300-entry prefix cache, and `FormattedText` gains a `live` property that the chat view sets for the streaming tail. (3) `SessionEventHub` gains per-session coalescing of `status.update` / `activity.update` so the server stops sending up to five messages per provider token. Every layer keeps existing exactly-once `seq` watermark semantics.

**Tech Stack:** TypeScript, Lit 3, Vitest 4 (node environment by default, `// @vitest-environment jsdom` opt-in), Fastify + `ws` on the server, `marked` for Markdown.

## Global Constraints

- Package manager is npm (`npm@11.11.0`). Node `>=22.19.0`.
- Do not manually edit `CHANGELOG.md`. User-visible changes get a `.changeset/*.md` fragment with bump type `patch` and package name `@hyperdreamer/pi-webui`.
- Tests run serially (`maxWorkers: 1` in `vitest.config.ts`). Default test environment is node; add `// @vitest-environment jsdom` as the **first line** of a test file when it needs DOM.
- Follow `.agents/skills/testing-guide/SKILL.md`: prefer the smallest layer that proves the behavior; pure helpers first, then controllers, then components.
- Follow `.agents/skills/code-quality-architecture/SKILL.md`: dependencies injected, side effects at boundaries, no new abstraction without a reason.
- Preserve the `seq` watermark contract documented at `src/shared/apiTypes.ts:1240-1246` and implemented in `SessionController.isStreamEventBelowWatermark` (`src/client/src/controllers/sessionController.ts:1478-1483`). Coalescing must keep the **highest** `seq` of a merged run.
- Never reorder transcript events. Only merge **adjacent** events of the same mergeable type.
- `src/server/sessiond.ts` and session-daemon code paths require a manual daemon restart. Task 5 touches `SessionEventHub`, which the daemon loads — flag this in the final summary.
- Knip runs in `npm run verify`. Every new exported symbol must be imported by production code or a test, or knip fails.

## Approved Pre-flight Corrections (2026-08-01)

This section was approved by the user after the initial plan and **overrides conflicting snippets in Tasks 1, 2, 3, 4, and 5** below.

### Client ingress must be actually bounded

Replace the planned `coalesceTranscriptEvents([...pendingTranscriptEvents, event])` implementation with a new pure `StreamEventBuffer` in `src/client/src/streamEventBuffer.ts`; do not retain the old array-copying implementation.

- It accepts only `assistant.delta`, `assistant.thinking.delta`, `shell.chunk`, and `tool.update` events.
- It merges only adjacent compatible events while preserving their order and uses the highest `seq` in every materialized run.
- For text/thinking/shell runs, it stores incoming chunks in an internal array and joins them only in `drain()`. Enqueue must not re-concatenate the growing whole response on every token.
- For same-`toolCallId` tool updates, retain only the latest event, matching the existing `mergeToolExecutionUpdate` behavior (`src/client/src/chatTranscript.ts:121-130`).
- The defaults are **128 materialized event runs** and **262,144 UTF-8 payload bytes**. Both limits are constructor-injectable for tests.
- On either limit, it clears pending events, sets a one-shot `resyncRequired` marker, and ignores additional buffered events until `drain()` consumes that marker. It must never grow past either limit.
- `SessionController.flushPendingUpdates()` applies the drained events, then invokes the existing deduplicated `refreshSelectedSession()` once when `resyncRequired` is true. That route fetches the authoritative committed history plus `streamSnapshot` and establishes a new sequence watermark.
- `clearPendingUpdates()` must clear the buffer and its marker. Test-only queue observability should be a read-only buffer count, not a mutable controller field.
- Add a shell regression: when `shell.end.output` is present, it is authoritative and replaces any partial shell output after the command prefix. This guarantees a complete final shell message if overload dropped intermediate chunks. Preserve the exit/cancel/truncation annotations.

### Server status/activity coalescing must preserve the final update

Replace the Task 5 drop-only 100 ms policy with a trailing-latest scheduler.

- The first event for a key sends immediately.
- A status update sends immediately when any control field changes: `isStreaming`, `isCompacting`, `isBashRunning`, `pendingMessageCount`, `queuedMessages`, `model`, `thinkingLevel`, `persisted`, or `warnings`.
- An activity update sends immediately when its `phase`, `label`, or `detail` changes. Its timestamp (`at`) alone is not meaningful.
- Other updates inside the 100 ms interval replace one pending latest event and schedule exactly one timer for the remaining interval. The timer emits that newest event; no terminal/latest snapshot is silently dropped.
- Keep separate coalescing state for the per-session and global WebSocket channels. A delayed per-session event receives its `seq` only at actual send time, so `currentSeq()` remains the highest delivered sequence.
- Inject `now`, `setTimeout`, and `clearTimeout` in `SessionEventHubOptions`/the pure coalescer for deterministic tests. Add fake-clock/fake-timer tests for immediate control transitions, one trailing latest update, independent keys, and sequence stamping of a delayed send.

### Tests must prove the real rendering behavior

- Correct the Markdown sanitizer test: raw HTML is escaped by the custom `marked` renderer, so do not assert that the literal word `script` disappears. Instead assert that a Markdown link with a `javascript:` URL has no unsafe `href` in the result.
- Test cache bypass through `FormattedText.live` in a jsdom test: rendering a unique text with `live = true` must not change `markdownHtmlCacheSize()`, and rendering the same text with `live = false` must add exactly one entry.
- Test `ChatView` through a jsdom custom-element render: with a streaming status, its trailing `formatted-text` element has `.live === true`; with an idle status, it has `.live === false`.

---

## Problem Being Fixed

Evidence gathered before writing this plan:

1. **Server fan-out.** `src/server/sessions/piSessionService.ts:2821-2829` subscribes to every Pi event and, per event, calls `this.events.publish(...)` (transcript), `publishActivityForEvent(...)`, and `publishStatus(...)`. `publishActivity` (`:3192-3200`) publishes both per-session and global; `publishStatus` (`:3203-3210`) does the same. One provider `message_update` therefore produces up to five WebSocket JSON messages.
2. **No server backpressure.** `SessionEventHub.sendToSockets` (`src/server/realtime/sessionEventHub.ts:65-80`) writes immediately with no queue bound or coalescing. `createBufferedSender` (`src/server/webSocketBridge.ts:14-31`) only buffers while `CONNECTING`.
3. **Unbounded client frame work.** `SessionController.queueTranscriptEvent` (`src/client/src/controllers/sessionController.ts:1415-1418`) pushes into an unbounded array; `flushPendingUpdates` (`:1444-1451`) then applies **every** queued event in one synchronous loop. `appendText` (`src/client/src/chatMessages.ts:25-36`) and `appendShellChunk` (`src/client/src/shellMessages.ts:9-15`) each rebuild the growing message immutably, so N buffered deltas cost O(N × text length).
4. **Markdown prefix cache blowup.** Each live render calls `toSafeMarkdownHtml(this.text)` (`src/client/src/components/FormattedText.ts:12-14`), which caches by full text in a 300-entry `Map` (`src/client/src/formatting/markdown.ts:6-19`). During streaming every partial answer is a distinct key, so hundreds of progressively larger copies plus their generated HTML are retained.

Measured in isolation with the current code (jsdom, 180 progressive 8 KiB Markdown snapshots, 1.4 MiB final text): **19.65 s and +265.4 MiB retained**, versus **236 ms and +7.6 MiB** for parsing the final text once. That measurement excludes Lit DOM work, layout, scrolling, and WebSocket parsing, so a real tab can be worse.

`tool.update` is deliberately added to the mergeable/high-frequency set in Task 3 because a chatty tool currently forces an immediate synchronous render per update (it is absent from `isHighFrequencyTranscriptEvent` at `:1664-1666`).

---

## File Structure

**Created:**
- `src/client/src/streamEventCoalescing.ts` — pure helper: merge adjacent high-frequency transcript events, preserving order and max `seq`.
- `src/client/src/streamEventCoalescing.test.ts` — unit tests for the helper.
- `src/client/src/formatting/markdown.test.ts` — tests for cache-bypass behavior (needs jsdom; `sanitizeHtml` uses `document`).
- `src/server/realtime/sessionStatusCoalescer.ts` — pure helper deciding whether a status/activity publish should be sent now or deferred.
- `src/server/realtime/sessionStatusCoalescer.test.ts` — unit tests for that helper.
- `.changeset/streaming-backpressure-tab-freeze.md` — user-facing release note.

**Modified:**
- `src/client/src/formatting/markdown.ts` — add an options parameter so callers can skip the cache.
- `src/client/src/components/FormattedText.ts` — add a `live` property that bypasses the Markdown cache.
- `src/client/src/components/ChatView.ts:1271-1301` (`renderPart`) — pass `live` for the streaming tail message.
- `src/client/src/controllers/sessionController.ts` — coalesce before applying; include `tool.update` in the high-frequency set; expose queue depth for tests.
- `src/client/src/controllers/sessionController.liveEvents.test.ts` — add flood regression tests.
- `src/server/realtime/sessionEventHub.ts` — coalesce per-session `status.update`/`activity.update` bursts.
- `src/server/realtime/sessionEventHub.test.ts` — add coalescing tests.

Responsibility split rationale: the client coalescer is transport-agnostic and pure, so it is testable without a socket, a controller, or a DOM. The server coalescer is separated from `SessionEventHub` so the timing policy is unit-testable with an injected clock instead of real timers.

---

### Task 1: Pure client-side stream event coalescing helper

**Files:**
- Create: `src/client/src/streamEventCoalescing.ts`
- Test: `src/client/src/streamEventCoalescing.test.ts`

**Interfaces:**
- Consumes: `SessionUiEvent` from `src/client/src/sessionSocket.ts` (re-exported from `src/shared/apiTypes.ts`).
- Produces:
  - `export function isMergeableStreamEvent(event: SessionUiEvent): boolean`
  - `export function coalesceTranscriptEvents(events: readonly SessionUiEvent[]): SessionUiEvent[]`

Merge rules (exact):
- `assistant.delta` merges with an adjacent `assistant.delta` by concatenating `text`.
- `assistant.thinking.delta` merges with an adjacent `assistant.thinking.delta` by concatenating `text`.
- `shell.chunk` merges with an adjacent `shell.chunk` by concatenating `chunk`.
- `tool.update` merges with an adjacent `tool.update` **only when `toolCallId` matches**; the later event wins entirely (it carries the latest cumulative partial result), so keep the last event's `text`, `content`, and `details`.
- Any other event type is a barrier: it is copied through unchanged and ends the current run.
- A merged event carries the **maximum** `seq` present in its run. If no event in the run has a `seq`, the merged event has no `seq` property.

- [ ] **Step 1: Write the failing test**

Create `src/client/src/streamEventCoalescing.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { SessionUiEvent } from "./sessionSocket";
import { coalesceTranscriptEvents, isMergeableStreamEvent } from "./streamEventCoalescing";

describe("isMergeableStreamEvent", () => {
  it("accepts high-frequency stream events", () => {
    expect(isMergeableStreamEvent({ type: "assistant.delta", text: "a" })).toBe(true);
    expect(isMergeableStreamEvent({ type: "assistant.thinking.delta", text: "a" })).toBe(true);
    expect(isMergeableStreamEvent({ type: "shell.chunk", chunk: "a" })).toBe(true);
    expect(isMergeableStreamEvent({ type: "tool.update", toolName: "read", toolCallId: "c1", text: "a" })).toBe(true);
  });

  it("rejects structural events", () => {
    expect(isMergeableStreamEvent({ type: "agent.end" })).toBe(false);
    expect(isMergeableStreamEvent({ type: "tool.start", toolName: "read", toolCallId: "c1", summary: "" })).toBe(false);
    expect(isMergeableStreamEvent({ type: "message.end" })).toBe(false);
  });
});

describe("coalesceTranscriptEvents", () => {
  it("merges a run of assistant deltas into one event carrying the highest seq", () => {
    const events: SessionUiEvent[] = [
      { type: "assistant.delta", text: "Hel", seq: 4 },
      { type: "assistant.delta", text: "lo ", seq: 5 },
      { type: "assistant.delta", text: "world", seq: 6 },
    ];

    expect(coalesceTranscriptEvents(events)).toEqual([
      { type: "assistant.delta", text: "Hello world", seq: 6 },
    ]);
  });

  it("keeps thinking deltas separate from text deltas and preserves order", () => {
    const events: SessionUiEvent[] = [
      { type: "assistant.thinking.delta", text: "pla" },
      { type: "assistant.thinking.delta", text: "n" },
      { type: "assistant.delta", text: "ans" },
      { type: "assistant.delta", text: "wer" },
    ];

    expect(coalesceTranscriptEvents(events)).toEqual([
      { type: "assistant.thinking.delta", text: "plan" },
      { type: "assistant.delta", text: "answer" },
    ]);
  });

  it("treats structural events as barriers", () => {
    const events: SessionUiEvent[] = [
      { type: "assistant.delta", text: "a", seq: 1 },
      { type: "assistant.delta", text: "b", seq: 2 },
      { type: "tool.start", toolName: "read", toolCallId: "c1", summary: "read file", seq: 3 },
      { type: "assistant.delta", text: "c", seq: 4 },
    ];

    expect(coalesceTranscriptEvents(events)).toEqual([
      { type: "assistant.delta", text: "ab", seq: 2 },
      { type: "tool.start", toolName: "read", toolCallId: "c1", summary: "read file", seq: 3 },
      { type: "assistant.delta", text: "c", seq: 4 },
    ]);
  });

  it("merges shell chunks and concatenates their raw text", () => {
    const events: SessionUiEvent[] = [
      { type: "shell.chunk", chunk: "line1\n" },
      { type: "shell.chunk", chunk: "line2\n" },
    ];

    expect(coalesceTranscriptEvents(events)).toEqual([
      { type: "shell.chunk", chunk: "line1\nline2\n" },
    ]);
  });

  it("keeps only the latest tool update per tool call and does not merge across tool calls", () => {
    const events: SessionUiEvent[] = [
      { type: "tool.update", toolName: "bash", toolCallId: "c1", text: "partial 1", seq: 1 },
      { type: "tool.update", toolName: "bash", toolCallId: "c1", text: "partial 2", seq: 2 },
      { type: "tool.update", toolName: "bash", toolCallId: "c2", text: "other", seq: 3 },
    ];

    expect(coalesceTranscriptEvents(events)).toEqual([
      { type: "tool.update", toolName: "bash", toolCallId: "c1", text: "partial 2", seq: 2 },
      { type: "tool.update", toolName: "bash", toolCallId: "c2", text: "other", seq: 3 },
    ]);
  });

  it("omits seq entirely when no event in the merged run carried one", () => {
    const merged = coalesceTranscriptEvents([
      { type: "assistant.delta", text: "a" },
      { type: "assistant.delta", text: "b" },
    ]);

    expect(merged).toEqual([{ type: "assistant.delta", text: "ab" }]);
    expect(Object.hasOwn(merged[0] ?? {}, "seq")).toBe(false);
  });

  it("returns an empty array unchanged", () => {
    expect(coalesceTranscriptEvents([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/client/src/streamEventCoalescing.test.ts`
Expected: FAIL — cannot resolve module `./streamEventCoalescing`.

- [ ] **Step 3: Write minimal implementation**

Create `src/client/src/streamEventCoalescing.ts`:

```typescript
import type { SessionUiEvent } from "./sessionSocket";

type AssistantDelta = Extract<SessionUiEvent, { type: "assistant.delta" }>;
type ThinkingDelta = Extract<SessionUiEvent, { type: "assistant.thinking.delta" }>;
type ShellChunk = Extract<SessionUiEvent, { type: "shell.chunk" }>;
type ToolUpdate = Extract<SessionUiEvent, { type: "tool.update" }>;

/**
 * High-frequency stream events. A fast provider can emit thousands of these per
 * turn; each one applied separately rebuilds the growing immutable transcript,
 * so they are merged before application.
 */
export function isMergeableStreamEvent(event: SessionUiEvent): boolean {
  return event.type === "assistant.delta"
    || event.type === "assistant.thinking.delta"
    || event.type === "shell.chunk"
    || event.type === "tool.update";
}

/**
 * Merge runs of adjacent same-kind stream events. Order is never changed and
 * non-mergeable events act as barriers, so the applied sequence stays
 * equivalent to applying every original event one by one. A merged event keeps
 * the highest `seq` in its run so the join-time watermark stays correct.
 */
export function coalesceTranscriptEvents(events: readonly SessionUiEvent[]): SessionUiEvent[] {
  const merged: SessionUiEvent[] = [];
  for (const event of events) {
    const previous = merged[merged.length - 1];
    const combined = previous === undefined ? undefined : mergePair(previous, event);
    if (combined === undefined) merged.push(event);
    else merged[merged.length - 1] = combined;
  }
  return merged;
}

function mergePair(previous: SessionUiEvent, next: SessionUiEvent): SessionUiEvent | undefined {
  if (previous.type !== next.type) return undefined;
  if (previous.type === "assistant.delta" && next.type === "assistant.delta") {
    return withSeq<AssistantDelta>({ type: "assistant.delta", text: previous.text + next.text }, previous, next);
  }
  if (previous.type === "assistant.thinking.delta" && next.type === "assistant.thinking.delta") {
    return withSeq<ThinkingDelta>({ type: "assistant.thinking.delta", text: previous.text + next.text }, previous, next);
  }
  if (previous.type === "shell.chunk" && next.type === "shell.chunk") {
    return withSeq<ShellChunk>({ type: "shell.chunk", chunk: previous.chunk + next.chunk }, previous, next);
  }
  if (previous.type === "tool.update" && next.type === "tool.update" && previous.toolCallId === next.toolCallId) {
    // Tool updates carry the latest cumulative partial result, so the newer
    // event fully supersedes the older one.
    const { seq: _ignoredSeq, ...latest } = next;
    return withSeq<ToolUpdate>(latest, previous, next);
  }
  return undefined;
}

function withSeq<T extends SessionUiEvent>(body: Omit<T, "seq">, previous: SessionUiEvent, next: SessionUiEvent): SessionUiEvent {
  const seq = highestSeq(previous.seq, next.seq);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- `body` is the same variant as T minus the optional seq field, which is re-attached here.
  const event = { ...body } as T;
  return seq === undefined ? event : { ...event, seq };
}

function highestSeq(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/client/src/streamEventCoalescing.test.ts`
Expected: PASS (all 9 tests).

- [ ] **Step 5: Typecheck and lint the new files**

Run: `npm run typecheck && npx eslint src/client/src/streamEventCoalescing.ts src/client/src/streamEventCoalescing.test.ts`
Expected: exit 0 for both. If the `withSeq` type assertion trips a lint rule, keep the existing `eslint-disable-next-line` comment style used elsewhere in this repo (see `src/server/machines/machineClient.ts:192`).

- [ ] **Step 6: Commit**

```bash
git add src/client/src/streamEventCoalescing.ts src/client/src/streamEventCoalescing.test.ts
git commit -m "feat(client): add stream event coalescing helper"
```

---

### Task 2: Apply coalescing in SessionController and bound per-frame work

**Files:**
- Modify: `src/client/src/controllers/sessionController.ts:1395-1398` (high-frequency check), `:1415-1418` (`queueTranscriptEvent`), `:1444-1451` (`flushPendingUpdates`)
- Test: `src/client/src/controllers/sessionController.liveEvents.test.ts`

**Interfaces:**
- Consumes: `coalesceTranscriptEvents`, `isMergeableStreamEvent` from Task 1.
- Produces: `SessionController.pendingTranscriptEventCount(): number` — a public read-only accessor used by tests to assert the queue drains. No other production caller.

- [ ] **Step 1: Write the failing test**

Append to `src/client/src/controllers/sessionController.liveEvents.test.ts`, inside the existing top-level `describe("SessionController live events", ...)` block:

```typescript
  it("coalesces a flood of assistant deltas into a single transcript write per frame", async () => {
    const socket = new EmitSocket();
    const setStateCalls: Partial<AppState>[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => Promise.resolve(emptyPage),
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { setStateCalls.push(patch); state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket },
    );
    await controller.selectSession(oldSession, { updateUrl: false });
    setStateCalls.length = 0;

    for (let index = 0; index < 500; index += 1) {
      socket.emit({ type: "assistant.delta", text: "x", seq: index + 1 });
    }

    expect(controller.pendingTranscriptEventCount()).toBe(1);

    runPendingAnimationFrames();

    expect(controller.pendingTranscriptEventCount()).toBe(0);
    const messageWrites = setStateCalls.filter((patch) => patch.messages !== undefined);
    expect(messageWrites).toHaveLength(1);
    expect(state.messages).toEqual([{ role: "assistant", parts: [{ type: "text", text: "x".repeat(500) }] }]);
  });

  it("keeps structural events ordered relative to coalesced deltas", async () => {
    const socket = new EmitSocket();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => Promise.resolve(emptyPage),
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket },
    );
    await controller.selectSession(oldSession, { updateUrl: false });

    socket.emit({ type: "assistant.delta", text: "before ", seq: 1 });
    socket.emit({ type: "assistant.delta", text: "barrier", seq: 2 });
    socket.emit({ type: "shell.start", command: "ls", seq: 3 });
    socket.emit({ type: "shell.chunk", chunk: "a", seq: 4 });
    socket.emit({ type: "shell.chunk", chunk: "b", seq: 5 });
    runPendingAnimationFrames();

    expect(state.messages).toEqual([
      { role: "assistant", parts: [{ type: "text", text: "before barrier" }] },
      { role: "bash", parts: [{ type: "text", text: "$ ls\n\nab" }] },
    ]);
  });

  it("coalesces repeated tool updates for the same tool call", async () => {
    const socket = new EmitSocket();
    const setStateCalls: Partial<AppState>[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages: () => Promise.resolve(emptyPage),
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { setStateCalls.push(patch); state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket },
    );
    await controller.selectSession(oldSession, { updateUrl: false });
    setStateCalls.length = 0;

    socket.emit({ type: "tool.start", toolName: "bash", toolCallId: "c1", summary: "ls", seq: 1 });
    for (let index = 0; index < 200; index += 1) {
      socket.emit({ type: "tool.update", toolName: "bash", toolCallId: "c1", text: `partial ${String(index)}`, seq: index + 2 });
    }
    runPendingAnimationFrames();

    const messageWrites = setStateCalls.filter((patch) => patch.messages !== undefined);
    expect(messageWrites.length).toBeLessThanOrEqual(2);
    expect(JSON.stringify(state.messages)).toContain("partial 199");
    expect(JSON.stringify(state.messages)).not.toContain("partial 198");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/client/src/controllers/sessionController.liveEvents.test.ts`
Expected: FAIL — `controller.pendingTranscriptEventCount is not a function`, and the tool-update test fails because `tool.update` currently bypasses buffering and writes immediately.

- [ ] **Step 3: Write minimal implementation**

In `src/client/src/controllers/sessionController.ts`, add the import next to the other local imports near the top of the file:

```typescript
import { coalesceTranscriptEvents, isMergeableStreamEvent } from "../streamEventCoalescing";
```

Replace the high-frequency branch in `applyEvent` (currently `:1395-1398`):

```typescript
    if (isHighFrequencyTranscriptEvent(event)) {
      this.queueTranscriptEvent(event);
      return;
    }
```

with:

```typescript
    if (isMergeableStreamEvent(event)) {
      this.queueTranscriptEvent(event);
      return;
    }
```

Replace `queueTranscriptEvent` (`:1415-1418`) so merging happens on arrival, keeping the pending queue O(distinct runs) instead of O(events):

```typescript
  private queueTranscriptEvent(event: SessionUiEvent): void {
    // Merge on arrival so a fast provider cannot grow this queue without bound
    // and so one frame performs O(runs) immutable transcript rebuilds instead
    // of one per token.
    this.pendingTranscriptEvents = coalesceTranscriptEvents([...this.pendingTranscriptEvents, event]);
    this.schedulePendingFlush();
  }

  /** Buffered transcript-event count after coalescing. Exposed for tests. */
  pendingTranscriptEventCount(): number {
    return this.pendingTranscriptEvents.length;
  }
```

In `flushPendingUpdates` (`:1444-1451`), coalesce once more before applying, because `clearPendingUpdates`/reconnect paths can concatenate batches:

```typescript
    if (this.pendingTranscriptEvents.length > 0) {
      const events = coalesceTranscriptEvents(this.pendingTranscriptEvents);
      this.pendingTranscriptEvents = [];
      let messages = this.getState().messages;
      for (const event of events) messages = this.transcripts.applyLiveEvent(messages, event) ?? messages;
      if (messages !== this.getState().messages) this.setState({ messages });
    }
```

Delete the now-unused `isHighFrequencyTranscriptEvent` function at `:1664-1666` (knip will flag it otherwise).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run src/client/src/controllers/sessionController.liveEvents.test.ts src/client/src/controllers/sessionController.streamSeed.test.ts`
Expected: PASS. `sessionController.streamSeed.test.ts` must stay green — it proves the `seq` watermark still drops already-seeded events, which is why merged events keep the maximum `seq`.

- [ ] **Step 5: Run the full client controller and transcript suites**

Run: `npm test -- --run src/client/src/controllers src/client/src/chatTranscript.test.ts src/client/src/chatTranscriptStore.test.ts`
Expected: PASS with 0 failures.

- [ ] **Step 6: Typecheck, lint, knip**

Run: `npm run typecheck && npx eslint src/client/src/controllers/sessionController.ts && npm run knip`
Expected: exit 0. If knip reports `isHighFrequencyTranscriptEvent` as unused, it was not deleted in Step 3.

- [ ] **Step 7: Commit**

```bash
git add src/client/src/controllers/sessionController.ts src/client/src/controllers/sessionController.liveEvents.test.ts
git commit -m "fix(client): coalesce streamed transcript events before applying them"
```

---

### Task 3: Stop caching intermediate streaming Markdown

**Files:**
- Modify: `src/client/src/formatting/markdown.ts:9-19`
- Create: `src/client/src/formatting/markdown.test.ts`

**Interfaces:**
- Produces:
  - `export interface MarkdownRenderOptions { cache?: boolean }`
  - `export function toSafeMarkdownHtml(text: string, options?: MarkdownRenderOptions): string`
  - `export function markdownHtmlCacheSize(): number` — test-only observability, imported by the new test.
- Consumed by: Task 4 (`FormattedText`).

Behavior: `cache` defaults to `true`, preserving every existing call site. With `cache: false`, the function parses and sanitizes but neither reads nor writes the cache.

- [ ] **Step 1: Write the failing test**

Create `src/client/src/formatting/markdown.test.ts` (jsdom is required because `sanitizeHtml` uses `document.createElement`):

```typescript
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { markdownHtmlCacheSize, toSafeMarkdownHtml } from "./markdown";

describe("toSafeMarkdownHtml", () => {
  it("renders markdown to sanitized html", () => {
    const html = toSafeMarkdownHtml("**bold**", { cache: false });

    expect(html).toContain("<strong>bold</strong>");
  });

  it("strips script elements and inline event handlers", () => {
    const html = toSafeMarkdownHtml("<script>alert(1)</script><p onclick=\"steal()\">hi</p>", { cache: false });

    expect(html).not.toContain("script");
    expect(html).not.toContain("onclick");
  });

  it("does not grow the cache when rendering streaming prefixes", () => {
    const before = markdownHtmlCacheSize();

    for (let index = 1; index <= 200; index += 1) {
      toSafeMarkdownHtml(`streaming answer ${"x".repeat(index)}`, { cache: false });
    }

    expect(markdownHtmlCacheSize()).toBe(before);
  });

  it("still caches finalized text by default", () => {
    const unique = `finalized ${String(Date.now())} ${Math.random().toString(36).slice(2)}`;
    const before = markdownHtmlCacheSize();

    const first = toSafeMarkdownHtml(unique);
    const second = toSafeMarkdownHtml(unique);

    expect(second).toBe(first);
    expect(markdownHtmlCacheSize()).toBe(before + 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/client/src/formatting/markdown.test.ts`
Expected: FAIL — `markdownHtmlCacheSize` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/client/src/formatting/markdown.ts`, replace lines 9-19 with:

```typescript
export interface MarkdownRenderOptions {
  /**
   * Whether the rendered HTML may be cached. Streaming text must pass `false`:
   * every partial answer is a distinct cache key, so caching prefixes retains
   * hundreds of progressively larger copies of the same response and can freeze
   * the tab under fast provider output.
   */
  cache?: boolean;
}

export function toSafeMarkdownHtml(text: string, options: MarkdownRenderOptions = {}): string {
  const useCache = options.cache !== false;
  if (useCache) {
    const cached = markdownHtmlCache.get(text);
    if (cached !== undefined) return cached;
  }
  const html = marked.parse(text, { async: false, breaks: true, gfm: true, renderer });
  const safeHtml = sanitizeHtml(html);
  if (!useCache) return safeHtml;
  markdownHtmlCache.set(text, safeHtml);
  if (markdownHtmlCache.size > MAX_MARKDOWN_CACHE_ENTRIES) {
    const oldest = markdownHtmlCache.keys().next().value;
    if (oldest !== undefined) markdownHtmlCache.delete(oldest);
  }
  return safeHtml;
}

/** Current cached-entry count. Exposed so tests can assert cache growth. */
export function markdownHtmlCacheSize(): number {
  return markdownHtmlCache.size;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/client/src/formatting/markdown.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npx eslint src/client/src/formatting/markdown.ts src/client/src/formatting/markdown.test.ts`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/client/src/formatting/markdown.ts src/client/src/formatting/markdown.test.ts
git commit -m "feat(client): allow markdown rendering without cache writes"
```

---

### Task 4: Render the streaming tail without cache pollution

**Files:**
- Modify: `src/client/src/components/FormattedText.ts:9-14`
- Modify: `src/client/src/components/ChatView.ts:1271-1301` (`renderPart`), `:1089-1109` (`renderMessage` / `renderToolImageOutput` call sites), `:1115-1145` (`renderMessageGroup` / `renderMessageGroupBody` call sites)
- Test: `src/client/src/components/ChatView.test.ts`

**Interfaces:**
- Consumes: `MarkdownRenderOptions` behavior from Task 3.
- Produces:
  - `FormattedText.live: boolean` (Lit property, default `false`). When `true`, `render()` calls `toSafeMarkdownHtml(this.text, { cache: false })`.
  - `ChatView.renderPart(part: ChatPart, message?: ChatLine, live = false)` — third parameter marks the live streaming tail.

Only the **last** rendered group/message may be live, and only while the session is streaming. `ChatView` already computes exactly that condition in `isLiveTailGroup` (`:869-871`) and `isSessionLive` (`:873-880`).

- [ ] **Step 1: Write the failing test**

Append to `src/client/src/components/ChatView.test.ts`:

```typescript
describe("ChatView live streaming tail", () => {
  it("marks the trailing assistant message live while the session is streaming", () => {
    const view = new ChatView();
    view.messages = [
      { role: "user", parts: [{ type: "text", text: "Question" }] },
      { role: "assistant", parts: [{ type: "text", text: "Partial answer" }] },
    ];
    view.status = { ...streamingStatus, isStreaming: true };

    const rendered = templateText(view.render());

    expect(rendered).toContain("live");
  });

  it("does not mark messages live when the session is idle", () => {
    const view = new ChatView();
    view.messages = [
      { role: "assistant", parts: [{ type: "text", text: "Final answer" }] },
    ];
    view.status = { ...streamingStatus, isStreaming: false };

    const values = JSON.stringify(view.render().values);

    expect(values).not.toContain("\"live\":true");
  });
});
```

Add this fixture near the top of the file, after the existing imports:

```typescript
const streamingStatus: SessionStatus = {
  sessionId: "s1",
  isStreaming: false,
  isCompacting: false,
  isBashRunning: false,
  pendingMessageCount: 0,
  queuedMessages: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
};
```

If the file already defines an equivalent status fixture, reuse it instead of adding a duplicate.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/client/src/components/ChatView.test.ts`
Expected: FAIL on the first new test — nothing renders a `live` binding yet.

- [ ] **Step 3: Add the `live` property to FormattedText**

In `src/client/src/components/FormattedText.ts`, change the class head and `render`:

```typescript
export class FormattedText extends LitElement {
  @property() text = "";
  /**
   * True while this text is the growing tail of a live response. Live text is
   * rendered without writing the markdown cache, because every streamed prefix
   * would otherwise be retained as a separate cache entry.
   */
  @property({ type: Boolean }) live = false;

  override render() {
    return html`<div class="formatted" dir="auto" @click=${this.onFormattedClick}>${unsafeHTML(toSafeMarkdownHtml(this.text, { cache: !this.live }))}</div>`;
  }
```

- [ ] **Step 4: Thread `live` through ChatView**

In `src/client/src/components/ChatView.ts`, change `renderPart`'s signature and its two text-bearing branches:

```typescript
  private renderPart(part: ChatPart, message?: ChatLine, live = false) {
    if (part.type === "text" && message?.role === "bash") return html`<pre class="part shell-output">${part.text}</pre>`;
    if (part.type === "text") return html`<formatted-text class="part" .text=${part.text} .live=${live}></formatted-text>`;
    if (part.type === "thinking") return html`<details class="part"><summary>thinking</summary><formatted-text .text=${part.text} .live=${live}></formatted-text></details>`;
```

Leave the remaining branches of `renderPart` unchanged.

Update `renderMessage` (`:1089-1098`) to accept and forward the flag:

```typescript
  private renderMessage(message: ChatLine, index: number, live = false) {
    const toolOnly = this.isToolExecutionOnlyMessage(message);
    return html`
      ${this.renderScrollMarker(this.messageScrollMarkerId(index))}
      <article class=${toolOnly ? "msg tool-execution-shell" : `msg ${message.role}`} data-index=${index} data-scroll-anchor-id=${this.messageAnchorKey(index)}>
        ${toolOnly ? null : this.renderMessageHeader(message, String(index))}
        ${message.parts.map((part) => this.renderPart(part, message, live))}
      </article>
    `;
  }
```

In `render` (`:589-597`), pass liveness for the final entry only:

```typescript
          ${repeat(
            groups,
            (group) => group.kind === "group" ? this.groupRenderKey(group.startIndex) : this.messageAnchorKey(group.index),
            (group, index) => {
              const live = this.isLiveTailGroup(groups, index);
              if (group.kind === "group") return this.renderMessageGroup(group.messages, group.startIndex, group.endIndex, live);
              if (group.kind === "tool-image") return this.renderToolImageOutput(group.message, group.index, group.toolName);
              return this.renderMessage(group.message, group.index, live);
            },
          )}
```

`renderMessageGroup` already receives that boolean as `defaultOpen`; do **not** repurpose it. Instead, forward liveness into the group body by giving `renderMessageGroupBody` a `live` parameter and passing `live` from `renderMessageGroup`:

```typescript
  private renderMessageGroup(messages: ChatLine[], startIndex: number, endIndex: number, defaultOpen: boolean) {
    const disclosureKey = this.groupDisclosureKey(startIndex, endIndex, defaultOpen);
    const open = this.disclosures.isOpen(disclosureKey, defaultOpen);
    return html`
      ${this.renderScrollMarker(this.groupScrollMarkerId(endIndex))}
      <details class=${chatMessageGroupClassName(defaultOpen)} data-index=${startIndex} data-scroll-anchor-id=${this.groupAnchorKey(startIndex)} ?open=${open} @toggle=${(event: Event) => { this.onGroupToggle(disclosureKey, event, defaultOpen); }}>
        <summary>
          <b class="label">${chatMessageGroupLabel(defaultOpen)}</b>
          <span>${summarizeChatGroup(messages)}</span>
        </summary>
        ${open ? this.renderMessageGroupBody(messages, startIndex, defaultOpen) : null}
      </details>
    `;
  }
```

Then read `renderMessageGroupBody` (`:1130-1145`) and add a trailing `live = false` parameter that it forwards to its `renderPart`/`renderMessage` calls. Do not change any other behavior in that method.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- --run src/client/src/components/ChatView.test.ts src/client/src/components/ChatView.image.test.ts`
Expected: PASS with 0 failures.

- [ ] **Step 6: Typecheck, lint, full suite**

Run: `npm run typecheck && npx eslint src/client/src/components/ChatView.ts src/client/src/components/FormattedText.ts && npm test`
Expected: exit 0 and 0 test failures.

- [ ] **Step 7: Commit**

```bash
git add src/client/src/components/ChatView.ts src/client/src/components/FormattedText.ts src/client/src/components/ChatView.test.ts
git commit -m "fix(client): render the live streaming tail without markdown cache writes"
```

---

### Task 5: Coalesce server status/activity fan-out

**Files:**
- Create: `src/server/realtime/sessionStatusCoalescer.ts`
- Create: `src/server/realtime/sessionStatusCoalescer.test.ts`
- Modify: `src/server/realtime/sessionEventHub.ts`
- Test: `src/server/realtime/sessionEventHub.test.ts`

**Interfaces:**
- Produces:
  - `export const STATUS_COALESCE_INTERVAL_MS = 100`
  - `export interface CoalesceDecision { send: boolean }`
  - `export class SessionStatusCoalescer { constructor(intervalMs?: number, now?: () => number); shouldSend(key: string): boolean; forget(key: string): void }`
- Consumed by: `SessionEventHub`, which calls `shouldSend` for `status.update` and `activity.update` only.

Policy: the first publish for a key always sends. A subsequent publish for the same key within `intervalMs` is dropped. Transcript events, notification events, `session.name`, and `session.created` are never dropped. Dropping intermediate status/activity frames is safe because both are last-write-wins snapshots on the client (`pendingStatusBySession` / `pendingActivityBySession` are `Map`s keyed by session id, `src/client/src/controllers/sessionController.ts:1420-1428`), and `PiSessionService` republishes status on a 2 s heartbeat (`src/server/sessions/piSessionService.ts:800`, `:3048-3062`), so the terminal state always arrives.

- [ ] **Step 1: Write the failing test**

Create `src/server/realtime/sessionStatusCoalescer.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { SessionStatusCoalescer } from "./sessionStatusCoalescer.js";

describe("SessionStatusCoalescer", () => {
  it("sends the first update for a key", () => {
    let now = 1_000;
    const coalescer = new SessionStatusCoalescer(100, () => now);

    expect(coalescer.shouldSend("s1:status")).toBe(true);
  });

  it("drops repeats inside the interval and sends again after it elapses", () => {
    let now = 1_000;
    const coalescer = new SessionStatusCoalescer(100, () => now);

    expect(coalescer.shouldSend("s1:status")).toBe(true);
    now = 1_050;
    expect(coalescer.shouldSend("s1:status")).toBe(false);
    now = 1_099;
    expect(coalescer.shouldSend("s1:status")).toBe(false);
    now = 1_100;
    expect(coalescer.shouldSend("s1:status")).toBe(true);
  });

  it("tracks keys independently", () => {
    let now = 1_000;
    const coalescer = new SessionStatusCoalescer(100, () => now);

    expect(coalescer.shouldSend("s1:status")).toBe(true);
    expect(coalescer.shouldSend("s1:activity")).toBe(true);
    expect(coalescer.shouldSend("s2:status")).toBe(true);
    now = 1_010;
    expect(coalescer.shouldSend("s1:status")).toBe(false);
    expect(coalescer.shouldSend("s2:status")).toBe(false);
  });

  it("forgets a key so its next update sends immediately", () => {
    let now = 1_000;
    const coalescer = new SessionStatusCoalescer(100, () => now);

    expect(coalescer.shouldSend("s1:status")).toBe(true);
    coalescer.forget("s1:status");
    now = 1_001;
    expect(coalescer.shouldSend("s1:status")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/server/realtime/sessionStatusCoalescer.test.ts`
Expected: FAIL — cannot resolve `./sessionStatusCoalescer.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/server/realtime/sessionStatusCoalescer.ts`:

```typescript
/**
 * Minimum gap between forwarded status/activity snapshots for one key. The
 * session service republishes status and activity on every provider event, so a
 * fast provider produces several per token; both are last-write-wins snapshots
 * on the client and are re-sent by the 2s heartbeat, so intermediate frames are
 * safe to drop.
 */
export const STATUS_COALESCE_INTERVAL_MS = 100;

export class SessionStatusCoalescer {
  private readonly lastSentAt = new Map<string, number>();

  constructor(
    private readonly intervalMs: number = STATUS_COALESCE_INTERVAL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  shouldSend(key: string): boolean {
    const timestamp = this.now();
    const previous = this.lastSentAt.get(key);
    if (previous !== undefined && timestamp - previous < this.intervalMs) return false;
    this.lastSentAt.set(key, timestamp);
    return true;
  }

  forget(key: string): void {
    this.lastSentAt.delete(key);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/server/realtime/sessionStatusCoalescer.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing hub test**

Append to `src/server/realtime/sessionEventHub.test.ts`, inside the existing `describe("SessionEventHub", ...)`:

```typescript
  it("coalesces rapid status updates per session while still stamping sequences", () => {
    let now = 1_000;
    const hub = new SessionEventHub({ intervalMs: 100, now: () => now });
    const socket = new FakeSocket();
    hub.add("s1", socket);
    const baseStatus = {
      sessionId: "s1",
      isStreaming: true,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    };

    hub.publish("s1", { type: "status.update", status: { ...baseStatus, messageCount: 1 } });
    hub.publish("s1", { type: "status.update", status: { ...baseStatus, messageCount: 2 } });
    hub.publish("s1", { type: "status.update", status: { ...baseStatus, messageCount: 3 } });

    expect(socket.send).toHaveBeenCalledTimes(1);

    now = 1_200;
    hub.publish("s1", { type: "status.update", status: { ...baseStatus, messageCount: 4 } });

    expect(socket.send).toHaveBeenCalledTimes(2);
  });

  it("never coalesces transcript events", () => {
    let now = 1_000;
    const hub = new SessionEventHub({ intervalMs: 100, now: () => now });
    const socket = new FakeSocket();
    hub.add("s1", socket);

    hub.publish("s1", { type: "assistant.delta", text: "a" });
    hub.publish("s1", { type: "assistant.delta", text: "b" });
    hub.publish("s1", { type: "assistant.delta", text: "c" });

    expect(socket.send).toHaveBeenCalledTimes(3);
  });
```

- [ ] **Step 6: Run hub test to verify it fails**

Run: `npm test -- --run src/server/realtime/sessionEventHub.test.ts`
Expected: FAIL — `SessionEventHub` takes no constructor argument, and status updates are not coalesced.

- [ ] **Step 7: Wire the coalescer into SessionEventHub**

In `src/server/realtime/sessionEventHub.ts`, add the import and an optional constructor:

```typescript
import { SessionStatusCoalescer } from "./sessionStatusCoalescer.js";

export interface SessionEventHubOptions {
  intervalMs?: number;
  now?: () => number;
}
```

Inside the class, add:

```typescript
  private readonly statusCoalescer: SessionStatusCoalescer;

  constructor(options: SessionEventHubOptions = {}) {
    this.statusCoalescer = new SessionStatusCoalescer(options.intervalMs, options.now);
  }
```

Change `publish` so coalescing happens **before** a sequence number is consumed, keeping `currentSeq` equal to the highest seq actually delivered:

```typescript
  publish(sessionId: string, event: SessionUiEvent): void {
    if (isCoalescableEvent(event) && !this.statusCoalescer.shouldSend(`${sessionId}:${event.type}`)) return;
    const seq = (this.seqBySession.get(sessionId) ?? 0) + 1;
    this.seqBySession.set(sessionId, seq);
    const payload = JSON.stringify({ ...projectBrowserSessionEvent(event), seq });
    this.sendToSockets(this.socketsBySession.get(sessionId), payload);
  }
```

Apply the same guard in `publishRealtime` so the global socket benefits too, keyed by session id when the event carries one:

```typescript
  publishRealtime(event: RealtimeEvent): void {
    if (isCoalescableEvent(event) && !this.statusCoalescer.shouldSend(`global:${globalCoalesceKey(event)}`)) return;
    const payload = JSON.stringify(event);
    this.sendToSockets(this.globalSockets, payload);
  }
```

Add these module-level helpers at the bottom of the file:

```typescript
function isCoalescableEvent(event: { type: string }): boolean {
  return event.type === "status.update" || event.type === "activity.update";
}

function globalCoalesceKey(event: RealtimeEvent): string {
  if (event.type === "status.update") return `status.update:${event.status.sessionId}`;
  if (event.type === "activity.update") return `activity.update:${event.activity.sessionId}`;
  return event.type;
}
```

Also call `this.statusCoalescer.forget(...)` for both keys inside `add`'s `socket.on("close", ...)` handler is **not** needed — the coalescer is keyed by session, not socket, and its entries are tiny. Do not add speculative cleanup.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test -- --run src/server/realtime`
Expected: PASS with 0 failures, including the pre-existing sequence-stamping tests.

- [ ] **Step 9: Run the server suites that construct a hub**

Run: `npm test -- --run src/server/sessions/sessionRoutes.test.ts src/server/terminals/terminalService.test.ts src/server/sessions/piSessionService.lifecycle.test.ts`
Expected: PASS. These construct `SessionEventHub` with no arguments, which the defaulted constructor keeps valid. Both subclasses were checked before this plan was written: `CapturingSessionEventHub` (`src/server/sessions/piSessionService.testSupport.ts:7`) overrides `publish` and `publishGlobal`, and `RecordingEventHub` (`src/server/terminals/terminalService.test.ts:244`) overrides `publishRealtime`. Both therefore bypass the coalescer, and neither declares a constructor, so no changes are needed in them.

- [ ] **Step 10: Typecheck, lint, knip**

Run: `npm run typecheck && npx eslint src/server/realtime/sessionEventHub.ts src/server/realtime/sessionStatusCoalescer.ts src/server/realtime/sessionStatusCoalescer.test.ts && npm run knip`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/server/realtime/sessionEventHub.ts src/server/realtime/sessionEventHub.test.ts src/server/realtime/sessionStatusCoalescer.ts src/server/realtime/sessionStatusCoalescer.test.ts
git commit -m "perf(server): coalesce rapid session status and activity fan-out"
```

---

### Task 6: Full verification and release note

**Files:**
- Create: `.changeset/streaming-backpressure-tab-freeze.md`

- [ ] **Step 1: Run the whole verification pipeline**

Run: `npm run verify`
Expected: exit 0 (`typecheck`, `lint`, `knip`, and the full test suite all pass). Fix any failure before continuing; do not proceed on a red pipeline.

- [ ] **Step 2: Write the changeset**

Create `.changeset/streaming-backpressure-tab-freeze.md`:

```md
---
"@hyperdreamer/pi-webui": patch
---

Fix browser tabs freezing when a provider streams output very quickly. Streamed text, thinking, shell, and tool-update events are now merged before the transcript is rebuilt, live streaming text no longer fills the markdown render cache with every partial response, and rapid session status/activity updates are coalesced before they are sent to the browser.
```

- [ ] **Step 3: Verify the changeset is recognized**

Run: `npm run changelog:status`
Expected: the new changeset is listed for `@hyperdreamer/pi-webui` as a patch.

- [ ] **Step 4: Commit**

```bash
git add .changeset/streaming-backpressure-tab-freeze.md
git commit -m "docs(changeset): note streaming backpressure freeze fix"
```

- [ ] **Step 5: Manual confirmation checklist**

Restart the session daemon first, because Task 5 changed `SessionEventHub`, which only the daemon loads:

```bash
systemctl --user restart pi-webui-sessiond.service
```

Then confirm in a browser, with DevTools Performance and Memory panels open:

- Send a prompt that produces a long, fast response (for example, ask for a large file to be printed). The tab stays interactive; no long task exceeds a few hundred milliseconds.
- Run a shell command with heavy output (`!find / -maxdepth 4 2>/dev/null | head -50000`). Scrolling stays responsive.
- Take a heap snapshot after several long streamed responses. Retained size does not grow by hundreds of MiB.
- Confirm the final transcript text is complete and correctly ordered, thinking blocks are intact, and tool results show their final content.
- Reload mid-stream and confirm the transcript resumes without duplicated or missing text (this exercises the `seq` watermark).

---

## Self-Review

**Spec coverage:** Every problem identified in the diagnosis has a task — unbounded client frame work and `tool.update` immediacy (Tasks 1–2), Markdown prefix-cache growth (Tasks 3–4), server fan-out (Task 5), verification and release notes (Task 6).

**Placeholder scan:** No TBDs. Every code step contains the actual code. The only "read the existing method first" instruction is `renderMessageGroupBody` in Task 4 Step 4, where the surrounding body is long and must not be blindly rewritten; the required change (add a trailing `live = false` parameter and forward it) is stated exactly.

**Type consistency:** `coalesceTranscriptEvents` / `isMergeableStreamEvent` (Task 1) are used with those exact names in Task 2. `toSafeMarkdownHtml(text, { cache })` and `markdownHtmlCacheSize()` (Task 3) are used with those exact signatures in Tasks 3–4. `SessionStatusCoalescer(intervalMs, now)` and `shouldSend(key)` (Task 5 Step 3) match the usage in Step 7. `SessionEventHubOptions` fields `intervalMs` / `now` match the test in Step 5.

**Known risk to watch:** Task 5 drops intermediate `status.update` frames. That is safe only because the client stores status per session as last-write-wins and the service republishes on a 2 s heartbeat. If a future change makes any status field incremental rather than a full snapshot, this coalescing must be revisited.
