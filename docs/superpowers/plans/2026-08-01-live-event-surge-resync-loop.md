# Live Event Surge Resync Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the browser tab freezing during a surge of concurrent live tool events by keying `tool.update` coalescing on `toolCallId` under a distinct-key cap, so the client stops falsely detecting overload and looping on full session resync.

**Architecture:** `StreamEventBuffer` currently merges an incoming event only against the immediately previous run, so concurrent tools never merge and each 50KB cumulative snapshot consumes budget. The fix splits the buffer's two limits by what they protect against: accumulating runs (text/thinking/shell) keep the additive UTF-8 byte budget because they genuinely grow while the client falls behind; `tool.update` runs move to a `Map` keyed by `toolCallId` with latest-wins replacement, bounded by a distinct-key count cap instead of bytes. Two contained hardening changes follow: a minimum-interval guard on the overload-triggered resync inside `flushPendingUpdates`, and latest-wins coalescing of the synchronous `sessionStorage` transcript write.

**Tech Stack:** TypeScript, Lit, Vitest, Node. Client code under `src/client/src/`.

## Global Constraints

- Target file for the primary fix: `src/client/src/streamEventBuffer.ts`.
- Preserve the existing public surface of `StreamEventBuffer`: `enqueue`, `drain`, `clear`, `eventCount`, `pendingBytes`, and the exported `isBufferedStreamEvent`. All 13 existing tests in `src/client/src/streamEventBuffer.test.ts` must keep passing except the two that assert byte-budget behavior for `tool.update`, which Task 2 intentionally replaces.
- `DEFAULT_MAX_PENDING_STREAM_EVENT_RUNS = 128` and `DEFAULT_MAX_PENDING_STREAM_BYTES = 262_144` keep their exported names and values.
- New export: `DEFAULT_MAX_PENDING_TOOL_UPDATE_KEYS = 64`.
- `StreamEventBufferLimits` gains one optional field, `maxToolUpdateKeys?: number`. Existing callers passing `{ maxEventRuns, maxBytes }` must keep compiling; `src/client/src/controllers/sessionController.liveEvents.test.ts:401` constructs `new StreamEventBuffer({ maxEventRuns: 1, maxBytes: 262_144 })` and must not need changes.
- Never use `String.length` as a UTF-8 byte proxy. Measured undercounts: accented 1.25x, emoji 2.0x, CJK 3.0x. Use `TextEncoder` when a byte count is required.
- Byte accounting stays UTF-8 exact for accumulating runs. The existing test "resyncs when a multibyte input is one UTF-8 byte over the byte limit" pins this and must keep passing.
- Inject clocks and schedulers rather than reading `Date.now()` or calling `setTimeout` inline, per `.agents/skills/code-quality-architecture/SKILL.md`.
- Run the narrowest check first per `.agents/skills/testing-guide/SKILL.md`: `npm test -- --run <file>`, then `npm run typecheck` for source/type changes.
- Use Conventional Commit messages. A user-visible fix needs a `.changeset/*.md` fragment; never hand-edit `CHANGELOG.md`.

---

### Task 1: Extract byte accounting so accumulating runs stop re-encoding

**Files:**
- Modify: `src/client/src/streamEventBuffer.ts` (`serializedEventBytes`, `AssistantDeltaRun`/`ThinkingDeltaRun`/`ShellRun` byte handling, `mergedRunBytes`, `mergeIntoRun`, `enqueue`)
- Test: `src/client/src/streamEventBuffer.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `serializedEventBytes(event: SessionUiEvent): number` stays exported-internal (module-private) and unchanged in meaning. New module-private helper `textByteLength(text: string): number` returning exact UTF-8 byte length via the shared module-level `textEncoder`.

This task is behavior-preserving. It removes the per-event re-encode of the whole merged run so a 50KB snapshot no longer costs a 50KB encode on every enqueue. Byte totals must come out identical, which the existing tests verify.

- [ ] **Step 1: Write the failing test**

Add to `src/client/src/streamEventBuffer.test.ts` inside the existing `describe("StreamEventBuffer", ...)` block:

```ts
  it("charges accumulating runs exact UTF-8 bytes for multibyte chunks", () => {
    const first: BufferedStreamEvent = { type: "shell.chunk", chunk: "日本語" };
    const second: BufferedStreamEvent = { type: "shell.chunk", chunk: "café" };
    const buffer = new StreamEventBuffer();

    buffer.enqueue(first);
    const afterFirst = buffer.pendingBytes;
    buffer.enqueue(second);

    // 日本語 is 9 UTF-8 bytes and café is 5, so the run total must grow by
    // exactly the second chunk's byte length, not its UTF-16 length of 4.
    expect(afterFirst).toBe(utf8ByteLength(first));
    expect(buffer.pendingBytes - afterFirst).toBe(utf8ByteLength(second));
    expect(buffer.drain()).toEqual({
      events: [{ type: "shell.chunk", chunk: "日本語café" }],
      resyncRequired: false,
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/client/src/streamEventBuffer.test.ts -t "exact UTF-8 bytes for multibyte"`

Expected: FAIL. Current `mergedRunBytes` returns `run.bytes + eventBytes`, where `eventBytes` is the whole serialized event including its JSON envelope (`{"type":"shell.chunk","chunk":...}`), so the delta is much larger than the chunk's byte length.

- [ ] **Step 3: Write minimal implementation**

In `src/client/src/streamEventBuffer.ts`, add next to `serializedEventBytes`:

```ts
function textByteLength(text: string): number {
  return textEncoder.encode(text).byteLength;
}
```

Change accumulating-run byte accounting to charge only the payload text. Replace `mergedRunBytes` and the accumulating branches of `createRun` so a run's `bytes` is the envelope cost measured once at creation plus the byte length of each appended chunk.

In `createRun`, for the three accumulating types keep `bytes` as the full `serializedEventBytes(event)` (envelope + first chunk) exactly as today.

In `mergedRunBytes`, keep the signature `(run: BufferedRun, event: BufferedStreamEvent, eventBytes: number)` for this task so the existing `tool.update` branch still compiles, and change only the accumulating branches to charge the payload text:

```ts
function mergedRunBytes(run: BufferedRun, event: BufferedStreamEvent, eventBytes: number): number {
  if (run.type === "tool.update" && event.type === "tool.update") {
    const retained = withSeq(toolUpdatePayload(event), highestSeq(run.seq, event.seq));
    return serializedEventBytes(retained);
  }
  if (event.type === "assistant.delta" || event.type === "assistant.thinking.delta") {
    return run.bytes + textByteLength(event.text);
  }
  if (event.type === "shell.chunk") {
    return run.bytes + textByteLength(event.chunk);
  }
  return run.bytes + eventBytes;
}
```

The `tool.update` branch stays as-is in this task; Task 2 deletes it along with the `eventBytes` parameter.

In `enqueue`, `eventBytes` is now needed only for the non-merging path and for `tool.update`. A merging `tool.update` still requires it to be passed, but that branch ignores the argument, so pass `0` when merging and serialize only when creating a new run:

```ts
    const previous = this.runs.at(-1);
    const mergesWithPrevious = previous !== undefined && canMerge(previous, event);
    const nextEventCount = this.runs.length + (mergesWithPrevious ? 0 : 1);
    const nextRunBytes = mergesWithPrevious && previous !== undefined
      ? mergedRunBytes(previous, event, 0)
      : serializedEventBytes(event);
    const bytesToReplace = mergesWithPrevious && previous !== undefined ? previous.bytes : 0;
    const nextBytes = this.pendingByteCount - bytesToReplace + nextRunBytes;
```

Pass `nextRunBytes` to `createRun` at its call site.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run src/client/src/streamEventBuffer.test.ts`

Expected: PASS, all 14 tests. The pre-existing byte-limit tests ("resyncs when a multibyte input is one UTF-8 byte over the byte limit", "returns one resync marker on byte overflow and ignores inputs until drain", "accepts a same-tool replacement exactly at the byte limit") must still pass unchanged — they are the guard that this refactor did not alter totals.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/streamEventBuffer.ts src/client/src/streamEventBuffer.test.ts
git commit -m "perf(client): charge accumulating stream runs per-chunk bytes"
```

---

### Task 2: Key `tool.update` coalescing by `toolCallId` under a distinct-key cap

**Files:**
- Modify: `src/client/src/streamEventBuffer.ts` (`StreamEventBufferLimits`, limits constants, `runs`/`toolUpdateRuns` state, `enqueue`, `drain`, `clear`, `eventCount`, `canMerge`, `createRun`, `mergeIntoRun`, `mergedRunBytes`, `materializeRun`)
- Test: `src/client/src/streamEventBuffer.test.ts`

**Interfaces:**
- Consumes: `textByteLength` from Task 1.
- Produces:
  - `export const DEFAULT_MAX_PENDING_TOOL_UPDATE_KEYS = 64;`
  - `StreamEventBufferLimits` becomes `{ maxEventRuns?: number; maxBytes?: number; maxToolUpdateKeys?: number }`.
  - `eventCount` returns `this.runs.length + this.toolUpdateRuns.size`.
  - `pendingBytes` returns only accumulating-run bytes; keyed `tool.update` runs contribute 0.
  - `drain()` returns `{ events, resyncRequired }` with accumulating runs first in arrival order, then keyed `tool.update` runs in first-seen insertion order.

This is the root-cause fix. `tool.update` runs leave the positional `runs` list entirely, so they consume neither the 128-run cap nor the byte budget.

- [ ] **Step 1: Write the failing tests**

Replace the two existing byte-budget-on-`tool.update` tests — "resyncs rather than retaining a same-tool replacement larger than the byte limit" (line 96) and "accepts a same-tool replacement exactly at the byte limit" (line 133) — with the tests below. Those two encode the old contract that a `tool.update` is charged bytes, which is exactly the false positive being removed.

Also update the existing "keeps the latest same-tool update and treats different tools as barriers" test (line 77): under keyed coalescing there are no barriers, so `c1`'s fourth update replaces its earlier one. Its new expectation is `eventCount` of 2 and drained events `[c1 "after barrier" seq 4, c2 "other" seq 3]` — `c1` first because it was seen first.

Add to `describe("StreamEventBuffer defaults", ...)`:

```ts
  it("exports the tool-update key limit", () => {
    expect(DEFAULT_MAX_PENDING_TOOL_UPDATE_KEYS).toBe(64);
  });
```

Add to `describe("StreamEventBuffer", ...)`:

```ts
  const bashSnapshot = (toolCallId: string, bytes: number): BufferedStreamEvent => ({
    type: "tool.update",
    toolName: "bash",
    toolCallId,
    text: "x".repeat(bytes),
  });

  it("does not resync when concurrent tools interleave full-size snapshots", () => {
    // Reproduces the tab-freeze surge: upstream bash emits a cumulative 50KB
    // snapshot per update, so interleaved tools used to cross the 256KB budget
    // after 6-8 events and trigger a full session resync loop.
    for (const concurrency of [2, 6, 12]) {
      const buffer = new StreamEventBuffer();
      for (let round = 0; round < 40; round++) {
        for (let tool = 0; tool < concurrency; tool++) {
          buffer.enqueue(bashSnapshot(`c${String(tool)}`, 50 * 1024));
        }
      }
      const drained = buffer.drain();
      expect(drained.resyncRequired).toBe(false);
      expect(drained.events).toHaveLength(concurrency);
    }
  });

  it("retains only the latest snapshot per tool call and the highest seq", () => {
    const buffer = new StreamEventBuffer();

    buffer.enqueue({ type: "tool.update", toolName: "bash", toolCallId: "c1", text: "first", seq: 7 });
    buffer.enqueue({ type: "tool.update", toolName: "bash", toolCallId: "c2", text: "other", seq: 8 });
    buffer.enqueue({ type: "tool.update", toolName: "bash", toolCallId: "c1", text: "latest", content: "new", details: { step: 2 }, seq: 3 });

    expect(buffer.eventCount).toBe(2);
    expect(buffer.drain()).toEqual({
      events: [
        { type: "tool.update", toolName: "bash", toolCallId: "c1", text: "latest", content: "new", details: { step: 2 }, seq: 7 },
        { type: "tool.update", toolName: "bash", toolCallId: "c2", text: "other", seq: 8 },
      ],
      resyncRequired: false,
    });
  });

  it("does not charge keyed tool updates against the accumulating byte budget", () => {
    const buffer = new StreamEventBuffer({ maxBytes: 200 });

    buffer.enqueue(bashSnapshot("c1", 50 * 1024));
    buffer.enqueue(bashSnapshot("c2", 50 * 1024));

    expect(buffer.pendingBytes).toBe(0);
    expect(buffer.drain().resyncRequired).toBe(false);
  });

  it("does not charge keyed tool updates against the event-run limit", () => {
    const buffer = new StreamEventBuffer({ maxEventRuns: 2, maxBytes: 10_000 });

    buffer.enqueue({ type: "assistant.delta", text: "a" });
    buffer.enqueue({ type: "shell.chunk", chunk: "s" });
    for (let tool = 0; tool < 10; tool++) buffer.enqueue(bashSnapshot(`c${String(tool)}`, 16));

    expect(buffer.drain().resyncRequired).toBe(false);
  });

  it("resyncs when distinct streaming tool calls exceed the key limit", () => {
    const buffer = new StreamEventBuffer({ maxToolUpdateKeys: 3 });

    for (let tool = 0; tool < 4; tool++) buffer.enqueue(bashSnapshot(`c${String(tool)}`, 16));

    expect(buffer.eventCount).toBe(0);
    expect(buffer.drain()).toEqual({ events: [], resyncRequired: true });
    expect(buffer.drain()).toEqual({ events: [], resyncRequired: false });
  });

  it("accepts exactly the configured tool-update key limit", () => {
    const buffer = new StreamEventBuffer({ maxToolUpdateKeys: 3 });

    for (let tool = 0; tool < 3; tool++) buffer.enqueue(bashSnapshot(`c${String(tool)}`, 16));

    expect(buffer.eventCount).toBe(3);
    expect(buffer.drain().resyncRequired).toBe(false);
  });

  it("drains accumulating runs before keyed tool updates", () => {
    const buffer = new StreamEventBuffer();

    buffer.enqueue({ type: "tool.update", toolName: "bash", toolCallId: "c1", text: "tool", seq: 1 });
    buffer.enqueue({ type: "assistant.delta", text: "text", seq: 2 });
    buffer.enqueue({ type: "shell.chunk", chunk: "shell", seq: 3 });

    expect(buffer.drain()).toEqual({
      events: [
        { type: "assistant.delta", text: "text", seq: 2 },
        { type: "shell.chunk", chunk: "shell", seq: 3 },
        { type: "tool.update", toolName: "bash", toolCallId: "c1", text: "tool", seq: 1 },
      ],
      resyncRequired: false,
    });
  });

  it("clear removes keyed tool updates", () => {
    const buffer = new StreamEventBuffer();

    buffer.enqueue(bashSnapshot("c1", 16));
    buffer.clear();

    expect(buffer.eventCount).toBe(0);
    expect(buffer.drain()).toEqual({ events: [], resyncRequired: false });
  });
```

Add `DEFAULT_MAX_PENDING_TOOL_UPDATE_KEYS` to the existing import block at the top of the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/client/src/streamEventBuffer.test.ts`

Expected: FAIL. "does not resync when concurrent tools interleave full-size snapshots" fails because interleaved updates never merge and cross `maxBytes`; `DEFAULT_MAX_PENDING_TOOL_UPDATE_KEYS` is not exported; `maxToolUpdateKeys` is not a valid option.

- [ ] **Step 3: Write the implementation**

In `src/client/src/streamEventBuffer.ts`:

Add the constant and limits field:

```ts
export const DEFAULT_MAX_PENDING_TOOL_UPDATE_KEYS = 64;

export interface StreamEventBufferLimits {
  maxEventRuns?: number;
  maxBytes?: number;
  maxToolUpdateKeys?: number;
}
```

Narrow the positional run union to accumulating runs only and keep `ToolRun` for the keyed map. `ToolRun` no longer needs `bytes`:

```ts
type AccumulatingRun = TextRun | ShellRun;

interface ToolRun {
  type: "tool.update";
  toolCallId: string;
  latest: Omit<ToolUpdateEvent, "seq">;
  seq: number | undefined;
}
```

Replace `private runs: BufferedRun[]` with:

```ts
  private runs: AccumulatingRun[] = [];
  private readonly toolUpdateRuns = new Map<string, ToolRun>();
```

Add the third limit in the constructor:

```ts
    this.maxToolUpdateKeys = limits.maxToolUpdateKeys ?? DEFAULT_MAX_PENDING_TOOL_UPDATE_KEYS;
```

Split `enqueue` so `tool.update` takes the keyed path and never touches bytes or the run list:

```ts
  enqueue(event: BufferedStreamEvent): void {
    if (this.resyncRequired || !isBufferedStreamEvent(event)) return;
    if (event.type === "tool.update") {
      this.enqueueToolUpdate(event);
      return;
    }
    this.enqueueAccumulating(event);
  }

  /**
   * `tool.update` carries a cumulative snapshot, so only the newest one per
   * tool call matters. Replacement is bounded by distinct concurrently
   * streaming tool calls, not by elapsed time, so it is capped by key count
   * rather than charged against the falling-behind byte budget. Charging bytes
   * here caused a false overload at ~6 concurrent tools, and the resulting
   * resync loop froze the tab.
   */
  private enqueueToolUpdate(event: ToolUpdateEvent): void {
    const existing = this.toolUpdateRuns.get(event.toolCallId);
    if (existing !== undefined) {
      existing.latest = toolUpdatePayload(event);
      existing.seq = highestSeq(existing.seq, event.seq);
      return;
    }
    if (this.toolUpdateRuns.size + 1 > this.maxToolUpdateKeys) {
      this.markResyncRequired();
      return;
    }
    this.toolUpdateRuns.set(event.toolCallId, {
      type: "tool.update",
      toolCallId: event.toolCallId,
      latest: toolUpdatePayload(event),
      seq: event.seq,
    });
  }

  private enqueueAccumulating(event: Exclude<BufferedStreamEvent, ToolUpdateEvent>): void {
    const previous = this.runs.at(-1);
    const mergesWithPrevious = previous !== undefined && canMerge(previous, event);
    const nextEventCount = this.runs.length + (mergesWithPrevious ? 0 : 1);
    const nextRunBytes = mergesWithPrevious && previous !== undefined
      ? mergedRunBytes(previous, event)
      : serializedEventBytes(event);
    // `mergedRunBytes` loses its `eventBytes` parameter here, because only
    // accumulating runs remain and they charge per-chunk bytes.
    const bytesToReplace = mergesWithPrevious && previous !== undefined ? previous.bytes : 0;
    const nextBytes = this.pendingByteCount - bytesToReplace + nextRunBytes;

    if (nextEventCount > this.maxEventRuns || nextBytes > this.maxBytes) {
      this.markResyncRequired();
      return;
    }

    if (mergesWithPrevious && previous !== undefined) {
      mergeIntoRun(previous, event, nextRunBytes);
      this.pendingByteCount = nextBytes;
      return;
    }

    this.runs.push(createRun(event, nextRunBytes));
    this.pendingByteCount = nextBytes;
  }
```

Update the accessors, `drain`, `clear`, and `markResyncRequired`:

```ts
  get eventCount(): number {
    return this.runs.length + this.toolUpdateRuns.size;
  }

  drain(): DrainedStreamEvents {
    if (this.resyncRequired) {
      this.resyncRequired = false;
      return { events: [], resyncRequired: true };
    }

    const events: SessionUiEvent[] = [];
    for (const run of this.runs) events.push(materializeRun(run));
    // Keyed tool updates drain after accumulating runs. Reordering is safe:
    // `applyTranscriptEvent` resolves `tool.update` by `toolCallId`, and every
    // order-dependent event (`tool.start`, `tool.end`, `shell.start`,
    // `shell.end`, `message.append`, `message.end`) is unbuffered and forces a
    // flush before it applies.
    for (const run of this.toolUpdateRuns.values()) events.push(withSeq(run.latest, run.seq));
    this.reset();
    return { events, resyncRequired: false };
  }

  clear(): void {
    this.reset();
    this.resyncRequired = false;
  }

  private reset(): void {
    this.runs = [];
    this.toolUpdateRuns.clear();
    this.pendingByteCount = 0;
  }

  private markResyncRequired(): void {
    this.reset();
    this.resyncRequired = true;
  }
```

Narrow the free functions: `canMerge`, `createRun`, `mergeIntoRun`, and `materializeRun` now take `AccumulatingRun` and `Exclude<BufferedStreamEvent, ToolUpdateEvent>`, so their `tool.update` branches and the now-unreachable `throw new Error("unreachable buffered stream run")` in `materializeRun` are deleted. `mergedRunBytes` loses its `eventBytes` parameter and its `tool.update` branch. Keep `toolUpdatePayload`, `withSeq`, `highestSeq`, `serializedEventBytes`, and `textByteLength`.

Text, thinking, and shell runs stay positional and unkeyed. Keying them would reorder interleaved parts of the same message and corrupt part sequence.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run src/client/src/streamEventBuffer.test.ts`

Expected: PASS.

Run: `npm test -- --run src/client/src/controllers/sessionController.liveEvents.test.ts`

Expected: PASS without edits — that suite's buffer is constructed with `{ maxEventRuns: 1, maxBytes: 262_144 }` and overflows via `assistant.delta`/`assistant.thinking.delta`, which remain accumulating runs.

Run: `npm run typecheck && npx eslint src/client/src/streamEventBuffer.ts src/client/src/streamEventBuffer.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/streamEventBuffer.ts src/client/src/streamEventBuffer.test.ts
git commit -m "fix(client): coalesce tool updates by call id under a key cap"
```

---

### Task 3: Throttle the overload-triggered resync

**Files:**
- Modify: `src/client/src/controllers/sessionController.ts` (`SessionControllerDependencies` ~line 54-62, private fields ~line 115-123, constructor ~line 130-138, `flushPendingUpdates` ~line 1452, `clearPendingUpdates` ~line 1471)
- Test: `src/client/src/controllers/sessionController.liveEvents.test.ts`

**Interfaces:**
- Consumes: `drain()`'s `resyncRequired` flag from Task 2.
- Produces: `SessionControllerDependencies` gains `now?: () => number`. New module constant `const OVERLOAD_RESYNC_MIN_INTERVAL_MS = 1_000;`. Private field `private lastOverloadResyncAt: number | undefined;`.

Throttle only the overload path. `refreshSelectedSession()` also serves tree navigation, `agent.end`, and error recovery; throttling all callers would risk correctness.

- [ ] **Step 1: Write the failing test**

Add to `src/client/src/controllers/sessionController.liveEvents.test.ts`. Mirror the existing overflow test at line ~381 ("requests one authoritative refresh when the stream buffer overflows") for setup. Note the session fixture in this suite is named `oldSession`, and `api.messages` there is a plain arrow function, so this test needs its own `vi.fn` to count refreshes:

```ts
  it("throttles repeated overload resyncs to one per interval", async () => {
    const socket = new EmitSocket();
    const setStateCalls: Partial<AppState>[] = [];
    const messages = vi.fn<typeof defaultApi.messages>(() => Promise.resolve(emptyPage));
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      messages,
      status: () => Promise.resolve(status(oldSession.id)),
      streamSnapshot: () => Promise.resolve({ seq: 0, partial: null }),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    };
    let clock = 10_000;
    const controller = new SessionController(
      () => state,
      (patch) => { setStateCalls.push(patch); state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      {
        api,
        socket,
        now: () => clock,
        streamEventBuffer: new StreamEventBuffer({ maxEventRuns: 1, maxBytes: 262_144 }),
      },
    );
    await controller.selectSession(oldSession, { updateUrl: false });
    const baseline = messages.mock.calls.length;

    // Each pair overflows the 1-run cap, so every flush reports resyncRequired.
    for (let burst = 0; burst < 4; burst++) {
      socket.emit({ type: "assistant.delta", text: "a", seq: 1 + burst * 2 });
      socket.emit({ type: "assistant.thinking.delta", text: "t", seq: 2 + burst * 2 });
      runPendingAnimationFrames();
      clock += 100;
    }
    await vi.waitFor(() => { expect(messages.mock.calls.length).toBe(baseline + 1); });
    expect(messages.mock.calls.length).toBe(baseline + 1);

    clock += 1_000;
    socket.emit({ type: "assistant.delta", text: "a", seq: 99 });
    socket.emit({ type: "assistant.thinking.delta", text: "t", seq: 100 });
    runPendingAnimationFrames();
    await vi.waitFor(() => { expect(messages.mock.calls.length).toBe(baseline + 2); });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/client/src/controllers/sessionController.liveEvents.test.ts -t "throttles repeated overload resyncs"`

Expected: FAIL — `now` is not a recognized dependency (type error), and every flush calls `refreshSelectedSession()`, so the count exceeds `baseline + 1`.

- [ ] **Step 3: Write the implementation**

In `src/client/src/controllers/sessionController.ts`, add near `MESSAGE_PAGE_SIZE` (line 20):

```ts
const OVERLOAD_RESYNC_MIN_INTERVAL_MS = 1_000;
```

Add to `SessionControllerDependencies`:

```ts
  now?: () => number;
```

Add the field and constructor wiring alongside `streamEventBuffer`:

```ts
  private readonly now: () => number;
  private lastOverloadResyncAt: number | undefined;
```

```ts
    this.now = deps.now ?? (() => Date.now());
```

In `flushPendingUpdates`, replace `if (resyncRequired) void this.refreshSelectedSession();` with:

```ts
    if (resyncRequired) this.requestOverloadResync();
```

Add the guard method:

```ts
  /**
   * Buffer overflow means the client is behind, and the recovery refetch is the
   * most expensive operation available. Without a floor between attempts, a
   * sustained surge trips the cap again within a few hundred milliseconds and
   * the refetch becomes a self-sustaining loop that freezes the tab.
   */
  private requestOverloadResync(): void {
    const now = this.now();
    const last = this.lastOverloadResyncAt;
    if (last !== undefined && now - last < OVERLOAD_RESYNC_MIN_INTERVAL_MS) return;
    this.lastOverloadResyncAt = now;
    void this.refreshSelectedSession();
  }
```

In `clearPendingUpdates`, reset the throttle so a new selection is never blocked by a previous session's timestamp:

```ts
    this.lastOverloadResyncAt = undefined;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run src/client/src/controllers/sessionController.liveEvents.test.ts`

Expected: PASS, including the pre-existing overflow test, which still sees exactly one resync.

Run: `npm run typecheck && npx eslint src/client/src/controllers/sessionController.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/controllers/sessionController.ts src/client/src/controllers/sessionController.liveEvents.test.ts
git commit -m "fix(client): throttle overload-triggered session resync"
```

---

### Task 4: Coalesce the transcript cache write

**Files:**
- Modify: `src/client/src/chatTranscriptStore.ts` (`ChatTranscriptStore` constructor, `mergeHistory`, `discard`)
- Test: `src/client/src/chatTranscriptStore.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: new exported type `export type ChatHistoryWriteScheduler = (write: () => void) => void;`. `ChatTranscriptStore`'s constructor becomes `constructor(cache?: ChatHistoryCacheAdapter, scheduleWrite?: ChatHistoryWriteScheduler)`. `mergeHistory` keeps its signature `(sessionId: string, page: RawMessagePage) => ChatTranscriptView` and still returns the merged view synchronously.

`mergeHistory` currently runs a ~1.7 MiB synchronous `JSON.stringify` on every call. Coalescing makes a burst produce one serialization. The in-memory `rawHistoryPages` view stays synchronous so no reader observes a delay.

- [ ] **Step 1: Write the failing test**

Add to `src/client/src/chatTranscriptStore.test.ts`:

```ts
  it("coalesces cache writes for a burst of merges", () => {
    const writes: string[] = [];
    const cache: ChatHistoryCacheAdapter = {
      read: () => undefined,
      write: (sessionId) => { writes.push(sessionId); },
      remove: () => undefined,
    };
    const scheduled: (() => void)[] = [];
    const store = new ChatTranscriptStore(cache, (write) => { scheduled.push(write); });

    store.mergeHistory("s1", { messages: [{ role: "user", content: "a" }], start: 0, total: 1 });
    const view = store.mergeHistory("s1", { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }], start: 0, total: 2 });

    // The merged view is available immediately; only the storage write defers.
    expect(view.messages).toHaveLength(2);
    expect(writes).toEqual([]);

    for (const write of scheduled.splice(0)) write();

    expect(writes).toEqual(["s1"]);
  });

  it("writes the latest page when a coalesced write runs", () => {
    const written: RawMessagePage[] = [];
    const cache: ChatHistoryCacheAdapter = {
      read: () => undefined,
      write: (_sessionId, page) => { written.push(page); },
      remove: () => undefined,
    };
    const scheduled: (() => void)[] = [];
    const store = new ChatTranscriptStore(cache, (write) => { scheduled.push(write); });

    store.mergeHistory("s1", { messages: [{ role: "user", content: "a" }], start: 0, total: 1 });
    store.mergeHistory("s1", { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }], start: 0, total: 2 });
    for (const write of scheduled.splice(0)) write();

    expect(written).toHaveLength(1);
    expect(written[0]?.messages).toHaveLength(2);
  });

  it("cancels a pending write when the session is discarded", () => {
    const writes: string[] = [];
    const removed: string[] = [];
    const cache: ChatHistoryCacheAdapter = {
      read: () => undefined,
      write: (sessionId) => { writes.push(sessionId); },
      remove: (sessionId) => { removed.push(sessionId); },
    };
    const scheduled: (() => void)[] = [];
    const store = new ChatTranscriptStore(cache, (write) => { scheduled.push(write); });

    store.mergeHistory("s1", { messages: [{ role: "user", content: "a" }], start: 0, total: 1 });
    store.discard("s1");
    for (const write of scheduled.splice(0)) write();

    expect(removed).toEqual(["s1"]);
    expect(writes).toEqual([]);
  });
```

Import `RawMessagePage` from `./chatHistoryCache` in the test file if it is not already imported.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/client/src/chatTranscriptStore.test.ts -t "coalesces cache writes"`

Expected: FAIL — the constructor takes no second argument, so the write happens synchronously and `writes` is `["s1", "s1"]` before the scheduler runs.

- [ ] **Step 3: Write the implementation**

In `src/client/src/chatTranscriptStore.ts`:

```ts
export type ChatHistoryWriteScheduler = (write: () => void) => void;

const browserChatHistoryWriteScheduler: ChatHistoryWriteScheduler = (write) => {
  // Serializing a large transcript blocks the main thread, so the write is
  // deferred to a macrotask and only the latest page is persisted. A burst of
  // merges during a live surge therefore costs one serialization, not one per
  // merge.
  setTimeout(write, 0);
};
```

Replace the class state and `mergeHistory`/`discard`:

```ts
export class ChatTranscriptStore {
  private readonly rawHistoryPages = new Map<string, RawMessagePage>();
  private readonly pendingWrites = new Set<string>();

  constructor(
    private readonly cache: ChatHistoryCacheAdapter = browserChatHistoryCache,
    private readonly scheduleWrite: ChatHistoryWriteScheduler = browserChatHistoryWriteScheduler,
  ) {}

  mergeHistory(sessionId: string, page: RawMessagePage): ChatTranscriptView {
    const history = mergeChatHistory(this.rawHistoryPage(sessionId), page);
    this.rawHistoryPages.set(sessionId, history);
    this.queueCacheWrite(sessionId);
    return transcriptViewFromHistory(history);
  }

  discard(sessionId: string): void {
    this.rawHistoryPages.delete(sessionId);
    this.pendingWrites.delete(sessionId);
    this.cache.remove?.(sessionId);
  }

  private queueCacheWrite(sessionId: string): void {
    if (this.pendingWrites.has(sessionId)) return;
    this.pendingWrites.add(sessionId);
    this.scheduleWrite(() => { this.flushCacheWrite(sessionId); });
  }

  private flushCacheWrite(sessionId: string): void {
    if (!this.pendingWrites.delete(sessionId)) return;
    const history = this.rawHistoryPages.get(sessionId);
    if (history === undefined) return;
    this.cache.write(sessionId, history);
  }
```

Leave `cachedView`, `applyLiveEvent`, `seedStreamingPartial`, `rawHistoryPage`, and `transcriptViewFromHistory` unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run src/client/src/chatTranscriptStore.test.ts`

Expected: PASS, including the pre-existing tests.

Run: `npm test -- --run src/client/src/controllers/sessionController.reloadSelection.test.ts && npm test -- --run src/client/src/controllers/sessionController.tree.test.ts`

Expected: PASS. These construct `ChatTranscriptStore` with a cache only, so they now use the default deferred scheduler. If either asserts a cache write synchronously after selection, change that assertion to run the scheduled write via `vi.runAllTimers()` with `vi.useFakeTimers()`, or await a macrotask — do not revert the coalescing.

Run: `npm run typecheck && npx eslint src/client/src/chatTranscriptStore.ts src/client/src/chatTranscriptStore.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/chatTranscriptStore.ts src/client/src/chatTranscriptStore.test.ts
git commit -m "perf(client): coalesce transcript history cache writes"
```

---

### Task 5: Changeset and full verification

**Files:**
- Create: `.changeset/live-event-surge-resync-loop.md`
- Test: whole suite via `npm run verify`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: no code surface.

- [ ] **Step 1: Write the changeset**

Create `.changeset/live-event-surge-resync-loop.md`. This is a user-visible fix in published client code, so it needs a fragment; `CHANGELOG.md` stays untouched.

```markdown
---
"@hyperdreamer/pi-webui": patch
---

Fix the browser tab freezing during a surge of concurrent live tool events. Updates from several tools running at once are now coalesced per tool call, so the client no longer mistakes normal concurrency for overload and stops repeatedly refetching the whole session. Recovery refetches are also rate-limited and transcript cache writes are batched.
```

- [ ] **Step 2: Run the full verification**

Run: `npm run verify`

Expected: PASS — typecheck, lint, knip, and the full Vitest suite.

- [ ] **Step 3: Commit**

```bash
git add .changeset/live-event-surge-resync-loop.md
git commit -m "docs(changeset): note live event surge freeze fix"
```

---

## Verification notes for the reviewer

Two limits are inherited from the spec and are not closed by this plan:

- Render cost was measured in jsdom, which performs no layout or paint. There is no trustworthy figure for real browser cost with many expanded tool cards. If a freeze persists after this change, real browser profiling is the next step.
- The freeze was never reproduced in a live browser tab. The loop is confirmed by reading the code and measuring its parts. Task 2's interleaving test is the regression guard for the mechanism, not proof that the tab no longer freezes.

Out of scope: virtualizing or truncating the live-events group, changing upstream `bash` snapshot emission or its 100ms throttle, and server-side coalescing of `tool.update` in `sessionEventHub`.
