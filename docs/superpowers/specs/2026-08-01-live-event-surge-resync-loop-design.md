# Live event surge resync loop

## Problem

A surge of concurrent live events — several `bash` tools streaming long output at
once — freezes the browser tab. The freeze is not a slow render. It is a
positive-feedback loop in which the client's overload mitigation is the most
expensive operation the client performs.

### Mechanism

`StreamEventBuffer.enqueue` merges an incoming event only against the
immediately previous run (`this.runs.at(-1)`). One tool streaming alone
collapses all of its `tool.update` events into a single run. Two or more
concurrent tools interleave, so no adjacent merge ever succeeds and every
update becomes its own run.

Each run holds a full cumulative snapshot. Upstream `bash` emits `onUpdate`
with `output.snapshot()` — all output so far, throttled to 100ms, capped at
50KB (`DEFAULT_MAX_BYTES`). The buffer's 256KB budget is therefore crossed
almost immediately.

Measured `tool.update` events accepted before `resyncRequired` flips, at 50KB
snapshots:

| concurrency | events before resync |
| --- | --- |
| 1 | 2001+ (never trips; adjacent merge works) |
| 2 | 6 |
| 4 | 8 |
| 6 | 6 |
| 8 | 8 |

At a 100ms emit throttle, two concurrent long-output commands trip the cap
roughly every 300ms.

`resyncRequired` then drives `refreshSelectedSession()`, the heaviest path in
the client: three parallel HTTP requests, `normalizeMessages` over the page,
`mergeChatHistory`, and a synchronous `JSON.stringify` into `sessionStorage`.
For a realistic 100-tool-call page that is 1.70 MiB serialized and ~8.5ms of
main-thread CPU (2.6ms normalize + 5.6ms stringify), excluding network and DOM.
It also replaces the whole `messages` array, so `ChatView` re-renders
everything and `_measureMinimapMarkers` forces a reflow across every article.

Resync does nothing to reduce the incoming event rate, so the cap trips again
within a few hundred milliseconds. `TrailingRefreshCoordinator` tightens the
loop further: a resync requested while one is in flight sets `trailing` and
re-runs immediately on completion.

### Root cause

The byte budget exists to detect *the client falling behind*, which is
unbounded growth over time. A latest-wins snapshot per `toolCallId` does not
grow with time; it grows only with concurrency, and it is replace-only.
Charging self-limiting state against a falling-behind budget produces a false
positive.

`toolCallId` keying alone does not fix this. If keyed runs still charge the
additive byte budget — including with net-delta accounting, where only the
difference is charged — the ceiling merely moves:

| concurrency | pending bytes (latest per key) | cap 262,144 |
| --- | --- | --- |
| 2 | 102,536 | ok |
| 4 | 205,072 | ok |
| 5 | 256,340 | ok |
| 6 | 307,608 | trips |
| 8 | 307,608 | trips |

Six concurrent tools is not exotic; sub-agents and parallel tool calls reach
it. Net-delta accounting fixes temporal growth but not concurrency scaling, so
concurrency 1 and concurrency 8 do not become equivalent.

## Design

### Primary fix: split the limits by what they protect against

In `src/client/src/streamEventBuffer.ts`:

- **Accumulating runs** (`assistant.delta`, `assistant.thinking.delta`,
  `shell.chunk`) keep the additive byte budget. These genuinely grow while the
  client is behind, so the budget is the correct signal.
- **`tool.update` runs** become keyed by `toolCallId` in a map, latest-wins,
  and are bounded by a distinct-key count cap
  (`DEFAULT_MAX_PENDING_TOOL_UPDATE_KEYS`, 64) rather than by bytes. More than
  64 concurrently streaming tools is a genuine anomaly where resync is the
  honest response.

`tool.update` runs leave the positional `runs` list, so they no longer consume
the 128-run cap either. That cap was the trigger observed at 2000-byte
snapshots (128 interleaved events), and the byte cap was the trigger at 50KB
snapshots. Both stop firing for ordinary concurrency.

### Byte measurement

`serializedEventBytes` currently runs `JSON.stringify` plus
`TextEncoder.encode` over a cumulative 50KB snapshot on every enqueue.

- Keyed `tool.update` runs need no byte measurement, so that cost disappears.
- Accumulating runs measure only the newly arrived chunk and add it to the
  run's running total, instead of re-serializing the merged run.

`String.length` is not used as a byte proxy: it counts UTF-16 code units, so
non-ASCII output undercounts real bytes (measured ratios — accented 1.25x,
emoji 2.0x, CJK 3.0x) and would silently weaken the remaining guard.

### Ordering

`drain()` materializes accumulating runs in arrival order, then keyed
`tool.update` runs in first-seen order.

Reordering `tool.update` relative to other buffered events is safe.
`applyTranscriptEvent` resolves `tool.update` by `toolCallId` through
`updateToolExecution`, independent of position, and every event that depends on
ordering (`tool.start`, `tool.end`, `shell.start`, `shell.end`,
`message.append`, `message.end`) is not buffered — `applyEvent` calls
`flushPendingUpdates()` before applying it. Within a buffer window only
buffered events can reorder, and text/thinking/shell runs keep their relative
order.

Text, thinking, and shell runs are deliberately *not* keyed. Keying them would
reorder interleaved parts of the same message and corrupt part sequence.

`drain`, `clear`, and `resyncRequired` semantics are otherwise unchanged, so
`sessionController` needs no change for the primary fix.

### Defense in depth

**Throttle the resync trigger, not `refreshSelectedSession`.** That method also
serves tree navigation, `agent.end`, and error recovery; throttling all callers
risks correctness. The overload path in `flushPendingUpdates` gets its own
minimum-interval guard, so repeated cap trips collapse into one refresh per
interval. The clock is injected.

**Coalesce the transcript cache write.** `ChatTranscriptStore.mergeHistory`
stringifies ~1.7 MiB synchronously on every merge. It becomes a scheduled
latest-wins write behind an injected scheduler, so a burst of merges produces
one serialization. The in-memory `rawHistoryPages` view stays synchronous, so
no downstream reader observes a delay.

## Testing

The freeze reduces to a pure data-structure contract, so coverage belongs at
the `StreamEventBuffer` layer:

- interleaved `tool.update` from 2, 6, and 12 concurrent tools at 50KB
  snapshots does not set `resyncRequired`
- a keyed run retains only the latest snapshot per `toolCallId` and preserves
  the highest `seq`
- accumulating text/shell runs still trip the byte cap (guards against
  over-relaxing the limit)
- exceeding the distinct-key cap does trip resync
- non-ASCII accumulating chunks are charged actual UTF-8 bytes
- resync trigger throttling collapses repeated trips, with an injected clock
- transcript cache write coalescing issues one write per burst, with an
  injected scheduler

## Scope and limits

Two things this design does not establish:

- Render cost measurements were taken in jsdom, which performs no layout or
  paint. There is no trustworthy figure for real browser cost with many
  expanded tool cards. If a freeze persists after this change, that is the next
  place to look, and it requires real browser profiling.
- The freeze was not reproduced in a live browser tab. The loop is confirmed by
  reading the code and measuring its parts, not by observing the tab lock up.

## Out of scope

- Virtualizing or truncating the live-events group.
- Changing upstream `bash` snapshot emission or its 100ms throttle.
- Server-side coalescing of `tool.update` (currently only `status.update` and
  `activity.update` are coalesced in `sessionEventHub`).
