# WebSocket Slow-Consumer Backpressure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Stop an idle or frozen browser tab from accumulating an unbounded WebSocket
send queue on the server, which freezes the tab when it resumes or when the user
switches to a busy project or session.

**Architecture:** Add one shared, injectable slow-consumer guard that watches a
socket's `bufferedAmount` and terminates only a consumer that is both deep and not
draining. Apply it at all three browser-reachable send sites (the sessiond proxy
bridges, the generic web-socket bridge, and `SessionEventHub`). Recovery relies on the
reconnect-and-refresh paths clients already have; the one client change adds the
missing terminal reconnect so a terminated terminal socket cannot leave a dead pane.

**Tech Stack:** TypeScript, Node, `ws`, Fastify, Lit, Vitest.

Design: `docs/superpowers/specs/2026-08-07-websocket-slow-consumer-backpressure-design.md`

## Global Constraints

- Recovery contract: prefer authoritative state over stale replay. On breach, terminate the one offending connection; never replay its queued backlog.
- Never drop or reorder messages inside a stream. Streams carry order-sensitive data (`assistant.delta`, `tool.*`, pty bytes); partial delivery corrupts them.
- No protocol changes. Do not add new server-to-client event types; older federated clients would ignore them and silently diverge.
- Terminate only on depth **and** stall together. Depth alone would kill healthy tabs during a legitimate join burst.
- All thresholds and clocks must be injectable for tests. No bare `Date.now()` or bare `setTimeout` in guard logic.
- Do not weaken existing behavior: `SessionEventHub` must keep its per-session sequence watermark (`currentSeq`) and its existing `SessionStatusCoalescer` coalescing intact.
- Run `npx eslint <changed-files>` and `npm test -- --run <test-file>` for touched areas; run `npm run verify` before the final commit.
- `SessionEventHub` is loaded only by the session daemon. State in the final summary that a manual `pi-webui-sessiond` restart is required per `AGENTS.md`.

## Task 1: Measure real traffic to choose thresholds

**Implementer tier:** Standard

**Files:**
- Create: `/tmp/pi-webui-ws-burst-probe.mjs` (throwaway, delete in step 5)

**Interfaces:**
- Produces: two numbers recorded in this plan's task 2 brief by the human operator — `SOFT_LIMIT_BYTES` and `STALL_WINDOW_MS` — chosen from measured data.

Thresholds must come from measurement, not guesswork. A value below a real join burst
would disconnect healthy tabs.

- [ ] Write `/tmp/pi-webui-ws-burst-probe.mjs`: open a `ws` client to
      `ws://127.0.0.1:8808/api/machines/local/sessions/<id>/events?cwd=<encoded-cwd>` for a
      **busy, streaming** session, and separately to `ws://127.0.0.1:8808/api/machines/local/events`.
      For each, record total bytes and message count in 1-second buckets for 60 seconds.
      Print peak bytes-per-second and peak bytes in any single second.
- [ ] Run it against the running instance. Record: peak 1-second bytes for the session
      stream, peak 1-second bytes for the global stream, and the steady-state average.
- [ ] Measure a join burst: reload a tab pinned to a busy session with DevTools Network
      open, or run the probe while calling
      `GET /api/machines/local/sessions/<id>/messages?limit=100`. Record the largest
      single-second WebSocket volume observed during join.
- [ ] Choose `SOFT_LIMIT_BYTES` at least 20× the peak single-second volume, and
      `STALL_WINDOW_MS` at least 10× the coalescer interval (`STATUS_COALESCE_INTERVAL_MS`
      is 100 ms). Record both numbers, with the measured values that justify them, in a
      comment you will paste into task 2.
- [ ] Delete `/tmp/pi-webui-ws-burst-probe.mjs`.
- [ ] Commit nothing (no repository files changed by this task).

## Task 2: Slow-consumer guard module

**Implementer tier:** Standard

**Files:**
- Create: `src/server/realtime/slowConsumerGuard.ts`
- Test: `src/server/realtime/slowConsumerGuard.test.ts`

**Interfaces:**
- Consumes: `SOFT_LIMIT_BYTES` and `STALL_WINDOW_MS` from Task 1.
- Produces:
  ```ts
  export interface GuardedSocket {
    bufferedAmount: number;
    terminate(): void;
  }
  export interface SlowConsumerGuardOptions {
    softLimitBytes?: number;
    stallWindowMs?: number;
    now?: () => number;
    onTerminate?: (info: { bufferedAmount: number; stalledForMs: number }) => void;
  }
  export declare const SLOW_CONSUMER_SOFT_LIMIT_BYTES: number;
  export declare const SLOW_CONSUMER_STALL_WINDOW_MS: number;
  export declare class SlowConsumerGuard {
    constructor(socket: GuardedSocket, options?: SlowConsumerGuardOptions);
    /** Call immediately after every send. Returns true if the socket was terminated. */
    afterSend(): boolean;
    get terminated(): boolean;
  }
  ```

Semantics: a socket is terminated only when `bufferedAmount` exceeds the soft limit
**and** has not decreased below its previous high-water mark for `stallWindowMs`. Any
observed decrease resets the stall clock, so a deep-but-draining consumer survives.

- [ ] Write `src/server/realtime/slowConsumerGuard.test.ts` with a fake socket:
      ```ts
      import { describe, expect, it, vi } from "vitest";
      import { SlowConsumerGuard, type GuardedSocket } from "./slowConsumerGuard";

      function fakeSocket(): GuardedSocket & { terminate: ReturnType<typeof vi.fn> } {
        return { bufferedAmount: 0, terminate: vi.fn() };
      }

      describe("SlowConsumerGuard", () => {
        it("leaves a socket under the soft limit alone", () => {
          const socket = fakeSocket();
          let clock = 0;
          const guard = new SlowConsumerGuard(socket, { softLimitBytes: 1000, stallWindowMs: 100, now: () => clock });
          socket.bufferedAmount = 999;
          clock = 10_000;
          expect(guard.afterSend()).toBe(false);
          expect(socket.terminate).not.toHaveBeenCalled();
        });

        it("does not terminate a deep consumer that is still draining", () => {
          const socket = fakeSocket();
          let clock = 0;
          const guard = new SlowConsumerGuard(socket, { softLimitBytes: 1000, stallWindowMs: 100, now: () => clock });
          socket.bufferedAmount = 5000;
          guard.afterSend();
          for (let step = 0; step < 20; step += 1) {
            clock += 90;
            socket.bufferedAmount = 5000 - (step + 1) * 100;
            expect(guard.afterSend()).toBe(false);
          }
          expect(socket.terminate).not.toHaveBeenCalled();
        });

        it("terminates a consumer that stays above the soft limit without draining", () => {
          const socket = fakeSocket();
          let clock = 0;
          const onTerminate = vi.fn();
          const guard = new SlowConsumerGuard(socket, { softLimitBytes: 1000, stallWindowMs: 100, now: () => clock, onTerminate });
          socket.bufferedAmount = 5000;
          expect(guard.afterSend()).toBe(false);
          clock = 101;
          socket.bufferedAmount = 5001;
          expect(guard.afterSend()).toBe(true);
          expect(socket.terminate).toHaveBeenCalledOnce();
          expect(onTerminate).toHaveBeenCalledWith({ bufferedAmount: 5001, stalledForMs: 101 });
        });

        it("terminates only once and reports terminated state", () => {
          const socket = fakeSocket();
          let clock = 0;
          const guard = new SlowConsumerGuard(socket, { softLimitBytes: 10, stallWindowMs: 0, now: () => clock });
          socket.bufferedAmount = 100;
          guard.afterSend();
          clock = 1;
          guard.afterSend();
          expect(guard.terminated).toBe(true);
          expect(socket.terminate).toHaveBeenCalledOnce();
        });

        it("survives a terminate() that throws", () => {
          const socket = fakeSocket();
          socket.terminate.mockImplementation(() => { throw new Error("already gone"); });
          let clock = 0;
          const guard = new SlowConsumerGuard(socket, { softLimitBytes: 10, stallWindowMs: 0, now: () => clock });
          socket.bufferedAmount = 100;
          expect(() => guard.afterSend()).not.toThrow();
          expect(guard.terminated).toBe(true);
        });
      });
      ```
- [ ] Run `npm test -- --run src/server/realtime/slowConsumerGuard.test.ts` and confirm it
      fails because the module does not exist.
- [ ] Write `src/server/realtime/slowConsumerGuard.ts`. Export
      `SLOW_CONSUMER_SOFT_LIMIT_BYTES` and `SLOW_CONSUMER_STALL_WINDOW_MS` set to the values
      measured in Task 1, each with a comment stating the measured peak that justifies it.
      Track a high-water mark plus the timestamp it was first observed; reset both whenever
      `bufferedAmount` drops below the mark. Terminate inside `try`/`catch`, set a
      `terminated` flag first so termination happens at most once, and invoke `onTerminate`
      with `{ bufferedAmount, stalledForMs }`.
- [ ] Run `npm test -- --run src/server/realtime/slowConsumerGuard.test.ts` and confirm all
      five tests pass.
- [ ] Run `npx eslint src/server/realtime/slowConsumerGuard.ts src/server/realtime/slowConsumerGuard.test.ts`.
- [ ] Commit: `feat(server): add slow-consumer guard for browser websockets`.

## Task 3: Bound the sessiond proxy bridges

**Implementer tier:** Standard

**Files:**
- Modify: `src/server/sessiond/sessionProxyRoutes.ts:92-105`
- Test: `src/server/sessiond/sessionProxyRoutes.slowConsumer.test.ts`

**Interfaces:**
- Consumes: `SlowConsumerGuard` from Task 2, constructed as
  `new SlowConsumerGuard(socket, options?)`, with `afterSend(): boolean` called after each
  send and a `terminated` getter. Also `GuardedSocket = { bufferedAmount: number; terminate(): void }`.
- Produces: no new exports. `bridgeSockets(client, upstream)` keeps its existing signature.

This is the measured path: the incident's 125.9 MB queue was on a `/events` bridge here.

- [ ] Write `src/server/sessiond/sessionProxyRoutes.slowConsumer.test.ts`. Use real `ws`
      sockets over a local `WebSocketServer` so `bufferedAmount` is genuine. Simulate a dead
      consumer by pausing the client's underlying stream so it stops reading:
      ```ts
      import { afterEach, describe, expect, it } from "vitest";
      import { WebSocket, WebSocketServer } from "ws";
      import Fastify, { type FastifyInstance } from "fastify";
      import fastifyWebsocket from "@fastify/websocket";
      import { registerSessionProxyRoutes } from "./sessionProxyRoutes.js";
      ```
      Build a fake `SessionProxyDaemon` whose `connectWebSocket()` returns a `ws` client
      connected to a local upstream server that floods 64 KB payloads on demand. Register the
      routes on a Fastify instance with `fastifyWebsocket`, connect a browser-side client,
      then `client._socket.pause()` to stop reading. Flood until the server-side socket is
      terminated, and assert: the browser-facing socket ends up closed/terminated, and the
      upstream socket is also closed (cleanup ran). Track sockets in an array and close them
      all in `afterEach`.
- [ ] Run `npm test -- --run src/server/sessiond/sessionProxyRoutes.slowConsumer.test.ts` and
      confirm it fails, hanging or timing out because nothing bounds the queue today.
- [ ] Modify `bridgeSockets` in `src/server/sessiond/sessionProxyRoutes.ts`: construct one
      `SlowConsumerGuard` for the browser-facing `client` socket only (the upstream is the
      local daemon and drains fast). Replace the `upstream.on("message")` handler body so it
      calls `sendIfOpen(client, data)` and then `guard.afterSend()`; when `afterSend()`
      returns true, also `upstream.close()` so the daemon subscription is released. Leave the
      `client.on("message")` → upstream direction unguarded (browser→server traffic is tiny
      and control-only).
- [ ] Run `npm test -- --run src/server/sessiond/sessionProxyRoutes.slowConsumer.test.ts` and
      confirm it passes.
- [ ] Run the existing suite for this area:
      `npm test -- --run src/server/sessiond` and confirm no regressions.
- [ ] Run `npx eslint src/server/sessiond/sessionProxyRoutes.ts src/server/sessiond/sessionProxyRoutes.slowConsumer.test.ts`.
- [ ] Commit: `fix(server): bound browser event queues on sessiond proxy bridges`.

## Task 4: Bound the shared web socket bridge

**Implementer tier:** Standard

**Files:**
- Modify: `src/server/webSocketBridge.ts:1-31`
- Test: `src/server/webSocketBridge.test.ts`

**Interfaces:**
- Consumes: `SlowConsumerGuard` from Task 2 (`new SlowConsumerGuard(socket, options?)`,
  `afterSend(): boolean`, `terminated` getter).
- Produces: `bridgeSockets(client: WebSocket, upstream: WebSocket): void` and
  `createBufferedSender(socket: WebSocket): (data: Data) => void`, both keeping their
  current signatures so existing callers in `terminalProxyRoutes.ts` and
  `machines/machineProxyRoutes.ts` are unchanged.

This bridge carries terminal sockets and federated machine proxying. Terminal panes are
safe to terminate because `TerminalService.attach()` replays a 200,000-character buffer
on reattach; Task 6 adds the client reconnect that makes this recovery visible.

- [ ] Add a test to `src/server/webSocketBridge.test.ts` following the existing file's
      setup conventions: bridge a real client and upstream, pause the client's underlying
      stream, flood 64 KB frames from upstream, and assert the client socket is terminated
      and the upstream socket closed. Reuse the file's existing socket-tracking and
      `afterEach` cleanup.
- [ ] Run `npm test -- --run src/server/webSocketBridge.test.ts` and confirm the new test
      fails while the existing tests still pass.
- [ ] Modify `bridgeSockets` in `src/server/webSocketBridge.ts` to guard the
      `upstream.on("message")` → client direction: send via the existing
      `sendToClient(data)`, then call `guard.afterSend()`; on `true`, call `upstream.close()`.
      Do not guard the client→upstream direction. Leave `createBufferedSender` semantics for
      the `CONNECTING` queue unchanged.
- [ ] Run `npm test -- --run src/server/webSocketBridge.test.ts` and confirm all tests pass.
- [ ] Run `npm test -- --run src/server/machines` to confirm the unchanged
      `machineProxyRoutes` caller still passes. Note that `terminalProxyRoutes.ts` has no
      dedicated test file, so its bridge usage is covered only by the shared
      `webSocketBridge.test.ts` above plus the terminal reconnect work in Task 6; do not
      invent a new proxy-route test here.
- [ ] Run `npx eslint src/server/webSocketBridge.ts src/server/webSocketBridge.test.ts`.
- [ ] Commit: `fix(server): bound browser event queues on the shared socket bridge`.

## Task 5: Bound SessionEventHub fan-out

**Implementer tier:** Advanced

**Files:**
- Modify: `src/server/realtime/sessionEventHub.ts:5-11,103-118`
- Modify: `src/server/realtime/sessionEventHub.test.ts`

**Interfaces:**
- Consumes: `SlowConsumerGuard` from Task 2 (`new SlowConsumerGuard(socket, options?)`,
  `afterSend(): boolean`, `terminated` getter), and
  `SlowConsumerGuardOptions = { softLimitBytes?, stallWindowMs?, now?, onTerminate? }`.
- Produces: `RealtimeSocket` gains one required field:
  ```ts
  export interface RealtimeSocket {
    readonly OPEN: number;
    readyState: number;
    bufferedAmount: number;   // added
    send(payload: string): void;
    terminate(): void;
    on(event: "close", listener: () => void): unknown;
  }
  ```
  `SessionEventHubOptions` gains `slowConsumer?: SlowConsumerGuardOptions` so tests can
  inject thresholds and a clock.

Defense in depth: if a bridge ever stalls, the daemon must not grow either. This must not
disturb the existing `SessionStatusCoalescer` behavior or the `currentSeq` watermark.

- [ ] Add `bufferedAmount = 0` to the fake socket class in
      `src/server/realtime/sessionEventHub.test.ts` so existing tests still compile.
- [ ] Add a test asserting a stalled global socket is removed and terminated while a healthy
      socket keeps receiving: construct the hub with
      `{ slowConsumer: { softLimitBytes: 10, stallWindowMs: 0, now: () => clock } }`, register
      two global sockets, set one's `bufferedAmount` above the limit, publish twice advancing
      the clock, then assert the stalled socket's `terminate` was called once, that it stops
      receiving payloads, and that the healthy socket received every payload.
- [ ] Add a test asserting the per-session sequence watermark is unaffected when a slow
      session socket is dropped: after termination, `currentSeq(sessionId)` still increments
      by exactly one per published event.
- [ ] Run `npm test -- --run src/server/realtime/sessionEventHub.test.ts` and confirm the two
      new tests fail while existing tests pass.
- [ ] Modify `src/server/realtime/sessionEventHub.ts`: add `bufferedAmount` to
      `RealtimeSocket`, add `slowConsumer?: SlowConsumerGuardOptions` to
      `SessionEventHubOptions`, keep one guard per socket in a
      `WeakMap<RealtimeSocket, SlowConsumerGuard>` created on `add`/`addGlobal`, and in
      `sendToSockets` call `guard.afterSend()` after a successful `send`; when it returns
      true, `sockets.delete(socket)`. Keep the existing `catch` branch that deletes and
      terminates on send failure. Do not change coalescing or sequence numbering.
- [ ] Run `npm test -- --run src/server/realtime` and confirm all tests pass.
- [ ] Run `npm run typecheck` to catch any other implementer of `RealtimeSocket` that now
      needs `bufferedAmount`, and fix any such implementations.
- [ ] Run `npx eslint src/server/realtime/sessionEventHub.ts src/server/realtime/sessionEventHub.test.ts`.
- [ ] Commit: `fix(server): drop stalled realtime subscribers in the session event hub`.

## Task 6: Reconnect terminal sockets after termination

**Implementer tier:** Advanced

**Files:**
- Modify: `src/client/src/components/TerminalPanel.ts:342-353`
- Test: `src/client/src/components/TerminalPanel.reconnect.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. This is client-side and independent.
- Produces: no new exports. `TerminalPanel` gains private reconnect state only.

Today the `close` handler only clears the reference:
`socket.addEventListener("close", () => { if (this.socket === socket) this.socket = undefined; });`
Because `send()` is a no-op unless `this.socket?.readyState === WebSocket.OPEN`, a
terminated socket leaves a pane that renders nothing further and silently drops
keystrokes. Deliberate teardown is already distinguishable: `disposeTerminalView()`
assigns `this.socket = undefined` *before* calling `close()`, so the existing identity
check is already false in that case.

- [ ] Write `src/client/src/components/TerminalPanel.reconnect.test.ts`. Stub the
      `terminalSocket` factory from `../api` with `vi.mock` to return a controllable fake
      socket exposing `addEventListener`, `readyState`, `send`, `close`, and `binaryType`.
      Assert three behaviors: (1) an unexpected `close` while `this.socket === socket`
      schedules exactly one reconnect and calls the factory again after the backoff timer
      fires, using `vi.useFakeTimers()`; (2) `disposeTerminalView()` followed by `close` does
      **not** reconnect; (3) a `close` after an `exit` message does **not** reconnect.
      Drive private members with `Reflect.get`/`Reflect.set` as the sibling
      `PiWebUiApp.*.test.ts` files do, and follow the TemplateResult/handler conventions in
      `.agents/skills/testing-guide/SKILL.md`.
- [ ] Run `npm test -- --run src/client/src/components/TerminalPanel.reconnect.test.ts` and
      confirm all three tests fail.
- [ ] Modify `connectSocket` in `src/client/src/components/TerminalPanel.ts`: inside the
      existing identity-matched `close` branch, schedule a reconnect via
      `window.setTimeout`, reusing the 500 ms → 5 s ×1.6 backoff policy from
      `SessionSocket.scheduleReconnect`. Reset the delay to 500 ms on `open`. Skip the
      reconnect when the terminal has exited. Store the timer handle and clear it in
      `disposeTerminalView()` so a disposed pane cannot reconnect.
- [ ] Run `npm test -- --run src/client/src/components/TerminalPanel.reconnect.test.ts` and
      confirm all three tests pass.
- [ ] Run `npm test -- --run src/client/src/components` and confirm no regressions.
- [ ] Run `npx eslint src/client/src/components/TerminalPanel.ts src/client/src/components/TerminalPanel.reconnect.test.ts`.
- [ ] Commit: `fix(client): reconnect terminal sockets after an unexpected close`.

## Task 7: Mutation-verify, browser-probe, and finalize

**Implementer tier:** Advanced

**Files:**
- Create: `.changeset/websocket-slow-consumer-backpressure.md`
- Create: `/tmp/pi-webui-idle-freeze-probe.mjs` (throwaway, delete in step 6)

**Interfaces:**
- Consumes: everything from Tasks 2–6. No new interfaces.
- Produces: a patch changeset and a recorded probe result.

A passing new test proves little here; each assertion must be shown to fail against the
pre-fix behavior.

- [ ] Mutation 1: in `src/server/realtime/slowConsumerGuard.ts`, temporarily make
      `afterSend()` always return `false`. Run
      `npm test -- --run src/server/realtime src/server/sessiond src/server/webSocketBridge.test.ts`.
      Confirm the three slow-consumer tests fail for the intended reason (queue never
      bounded), then restore the file.
- [ ] Mutation 2: temporarily remove the stall condition so depth alone terminates. Run
      `npm test -- --run src/server/realtime/slowConsumerGuard.test.ts` and confirm only the
      "does not terminate a deep consumer that is still draining" test fails, then restore.
- [ ] Mutation 3: temporarily revert the `TerminalPanel` reconnect to the original
      reference-clearing close handler. Run
      `npm test -- --run src/client/src/components/TerminalPanel.reconnect.test.ts`, confirm
      the reconnect test fails while the two negative tests still pass, then restore.
- [ ] Write `/tmp/pi-webui-idle-freeze-probe.mjs`: launch an isolated headless Chromium
      profile over CDP against a production build (`npm run build`, then
      `PI_WEBUI_PORT=<free-port> node dist/server/index.js` pointed at the running daemon via
      `PI_WEBUI_SESSIOND_URL`), pinned with `?project=&workspace=&session=` to a busy
      streaming session. Capture baseline event-loop latency, then
      `Page.setWebLifecycleState({state:"frozen"})`, hold long enough to exceed
      `SLOW_CONSUMER_SOFT_LIMIT_BYTES` at the measured rate from Task 1, restore `active`,
      and re-measure. Assert: the tab responds, a real UI control still works, no uncaught
      exception, and the socket reconnected rather than replaying the whole backlog.
- [ ] Run the probe and record: server-side peak `bufferedAmount`, whether termination
      fired, post-resume event-loop latency, largest post-resume Long Task, and reconnect
      count. Confirm peak `bufferedAmount` stayed near the soft limit rather than growing
      unbounded.
- [ ] Delete `/tmp/pi-webui-idle-freeze-probe.mjs`.
- [ ] Create `.changeset/websocket-slow-consumer-backpressure.md`:
      ```md
      ---
      "@hyperdreamer/pi-webui": patch
      ---

      Keep the browser responsive after long idle periods by bounding per-connection
      WebSocket event queues on the server. A tab that stops reading events is now
      disconnected and reconnected with fresh state instead of replaying hours of
      accumulated updates, which could freeze the tab when returning to it or when
      switching to a busy project or session. Terminal panes now reconnect automatically
      after an unexpected socket close.
      ```
- [ ] Run `npm run verify` and confirm typecheck, lint, knip, and the full suite pass.
- [ ] Commit: `test(server): mutation-verify websocket backpressure and add changeset`.
- [ ] In the final summary, state that `SessionEventHub` changed and a manual
      `pi-webui-sessiond` restart is required per `AGENTS.md`, and report the probe numbers.
