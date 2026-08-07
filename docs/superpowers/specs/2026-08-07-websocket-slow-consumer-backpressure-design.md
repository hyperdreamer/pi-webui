# Browser WebSocket slow-consumer backpressure

**Status:** approved design, pending implementation plan
**Date:** 2026-08-07

## Problem

A PI WEBUI browser tab left idle for hours becomes unresponsive on return, showing
Chrome's native "Page Unresponsive" dialog. Switching to a busy project or session
after a long idle period reproduces it, because the tab-lifetime global event stream
keeps accumulating while nothing consumes it.

This is a fourth freeze path, distinct from the three already fixed (streaming
backpressure, live-event surge resync loop, session-switch throttle bypass). Version
1.11.2 contains all three, so this is not a stale deployment.

### Measured evidence

Captured from the live hung instance on `localhost:8808` (PI WEBUI 1.11.2):

| Measurement | Value |
| --- | --- |
| `ws.bufferedAmount` on one browser-facing socket | 125,900,595 bytes |
| Server TCP `Send-Q` for that socket | 3,374,839 bytes |
| Browser TCP `Recv-Q` for that socket | 1,040,604 bytes |
| Total forwarded to that socket | 192.7 MB over ~8.8 h (~6 KB/s) |
| Time the peer had stopped reading | ~3.2 h (`rwnd_limited` 99.7%) |
| Web server process RSS | 1.79 GB, `arrayBuffers` 140 MB |

The stalled socket was the global `/events` stream, confirmed through its paired
upstream URL `ws+unix:/home/henry/.pi-webui/sessiond.sock:/events`.

### Root cause

Both browser-facing WebSocket bridges forward whenever the socket reports `OPEN` and
never inspect `bufferedAmount`:

- `src/server/sessiond/sessionProxyRoutes.ts` — `sendIfOpen()` checks only `readyState`.
- `src/server/webSocketBridge.ts` — `createBufferedSender()` queues only while
  `CONNECTING`, then sends unconditionally while `OPEN`.
- `src/server/realtime/sessionEventHub.ts` — `sendToSockets()` checks only `readyState`.

A frozen tab stops reading, TCP flow control closes, and `ws` accumulates the
backlog in user-space memory without bound. When the tab resumes, Chrome delivers
that entire backlog to the renderer. JavaScript cannot preempt this: the messages
are already queued, so `StreamEventBuffer` and every other client-side coalescer run
only *after* each frame is dispatched and parsed. The bound must exist server-side.

## Revision to the earlier recommendation

I earlier proposed "coalesce first, cap as a backstop," on the assumption that
server-side coalescing of last-write-wins events was missing. Reading the code
showed that assumption was wrong, in two ways that matter.

**1. Coalescing already exists, and adding more would not have fixed this.**
`SessionEventHub` already routes `status.update` and `activity.update` through
`SessionStatusCoalescer` (100 ms trailing edge, per `sessionId:type` key) for both
per-session and global streams. So the measured 125.9 MB accumulated *despite*
coalescing, for two reasons:

- The coalescer is keyed per session with no notion of a subscriber. It bounds the
  *rate* of snapshots produced, not the *depth* of any one consumer's queue.
- `isImmediateStatusUpdate` bypasses the interval whenever a semantically important
  field changes (`isStreaming`, `isBashRunning`, `pendingMessageCount`, `warnings`,
  and others). A busy session flips these constantly, so a large share of traffic is
  deliberately immediate and not coalescable at all.

Adding a second coalescing layer would therefore duplicate existing machinery while
leaving the actual defect, unbounded per-consumer depth, untouched. Coalescing is
the wrong axis: this is a per-consumer queue-depth problem.

**2. Terminals are safe to cap, and must be capped.** `TerminalService.attach()`
replays a 200,000-character buffer (`MAX_REPLAY_BUFFER`) with `replay: true` on every
attach, and `TerminalPanel.writeTerminalOutput` resets the pane for replayed output.
Reattaching restores a coherent screen. Capping is also *required* rather than merely
permitted, because pty output is an ordered byte stream: dropping a middle chunk
would corrupt escape sequences and leave the pane wedged. Terminate-and-reattach is
the only correct recovery.

## Approach

Bound per-consumer queue depth at the browser-facing hop; on breach, terminate that
one connection and let existing reconnect paths reload authoritative state.

Recovery is deliberately *authoritative-state-over-stale-replay*, as confirmed with
the user: obsolete queued events are discarded rather than replayed.

### Why terminate rather than drop messages

Every browser-facing stream is order-sensitive somewhere: transcript deltas
(`assistant.delta`, `tool.*`) and pty output cannot tolerate a hole. Selectively
dropping would require per-message-type knowledge inside a byte-level bridge, and
would silently desynchronise clients. Terminating is honest: the client observes a
closed socket, which it already knows how to recover from.

### Why the existing client recovery is sufficient

No client change is required for correctness, because each socket already reconnects
and refreshes authoritative state:

| Stream | Reconnect | State recovery on reopen |
| --- | --- | --- |
| `/sessions/:id/events` | `SessionSocket.scheduleReconnect` (500 ms → 5 s, ×1.6) | `onReconnect` → `refreshSelectedSession` |
| `/events` | `RealtimeSocket.scheduleReconnect` (same policy) | `onOpen` → project catalog refresh, unread renegotiation, workspace activity, active terminals |
| terminal `/socket` | none today | server replays 200 KB buffer on attach |

The terminal row is the one gap, and is addressed below.

### Threshold policy

Trigger on **stall duration together with queue depth**, never depth alone. A healthy
tab joining a busy session legitimately spikes `bufferedAmount` for a moment; only a
consumer that is both deep and not draining is dead. Concretely: a connection is
terminated when its buffered depth exceeds a byte ceiling *and* has not decreased for
a stall window.

Exact values are deliberately not fixed in this design. They will be measured from a
real join burst and steady-state rate using the CDP probe, then set well above the
observed burst. Starting hypothesis, to be confirmed or corrected by measurement: a
few MB, with a stall window of several seconds. Both must be injectable for tests.

### Scope

Bound all three send sites, since all are reachable by a browser and the incident
proved the bridge path alone can retain 125.9 MB:

1. `sessionProxyRoutes.ts` — the `/events`, `/sessions/events`, and
   `/sessions/:id/events` bridges (the measured path).
2. `webSocketBridge.ts` — shared by terminal sockets and machine proxying, so a
   federated remote machine cannot stall the gateway either.
3. `sessionEventHub.ts` — so a stalled bridge cannot grow the session daemon. This
   requires adding `bufferedAmount` to the `RealtimeSocket` interface; existing test
   fakes must gain the field.

### Client change: terminal reconnect

`TerminalPanel.connectSocket` does register a `close` handler, but it only clears the
socket reference (`if (this.socket === socket) this.socket = undefined;`). It never
reconnects, unlike `SessionSocket` and `RealtimeSocket`, which both schedule backoff
reconnects. So a terminated terminal socket leaves a pane that renders nothing further
and silently discards keystrokes, since `sendTerminalInput` has no socket to write to.

Add backoff reconnect to that existing `close` handler, mirroring the 500 ms → 5 s ×1.6
policy already used by the other two sockets. Reconnecting reassigns `this.socket`, which
restores input, and the server's replay buffer restores the visible screen. Do not
reconnect when the pane was closed deliberately or the process exited.

The guard for "deliberate" already exists: `disposeTerminalView()` assigns
`this.socket = undefined` before calling `close()`, so the existing
`if (this.socket === socket)` identity check in the close handler is already false for
deliberate teardown. Reconnect only inside that identity-matched branch, and skip it
when the terminal is known to have exited.

## Non-goals

- **Interest-scoped subscriptions.** Today every tab receives status for every session
  on the machine. Narrowing that is the strategic fix and would have prevented this,
  but it is a protocol change; tracked as follow-up, not part of this fix.
- **Closing the global socket while hidden.** Would break background unread badges and
  window-title activity.
- **A server-to-client resync event.** Older federated clients would ignore it and
  silently diverge; closing the socket is understood by every existing client.
- **Client-side-only mitigation.** Cannot work, as established above.

## Testing

- **Server unit tests** with a fake socket whose `bufferedAmount` is controllable:
  proves depth stays bounded, that a deep-but-draining consumer is never terminated,
  that a deep-and-stalled one is, and that upstream cleanup still runs on termination.
- **Terminal reconnect test** at the component boundary: socket close schedules a
  reconnect; replayed output resets the pane.
- **Browser probe** on the production bundle, pinned to a real project/workspace/session,
  driving enough event volume to breach the threshold. Asserts the tab stays
  responsive and reconnects authoritatively.
- **Mutation verification:** removing the cap must fail the slow-consumer test;
  removing the stall condition must fail the draining-consumer test.
- `npm run verify` and a patch changeset (user-visible fix).

## Operational note

This touches `SessionEventHub`, which only the session daemon loads, so it requires a
manual `pi-webui-sessiond` restart per `AGENTS.md`, not just the UI autoreload.
