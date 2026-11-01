# Remote HTTP Timeout Resilience Design

**Date:** 2026-11-01
**Status:** approved design, awaiting implementation plan

## Background

A session list load for a selected remote machine traverses four hops:

```
browser → local gateway (registerMachineProxyRoutes)
        → RemoteMachineClient (server/machines/machineClient.ts)
        → remote gateway (registerSessionProxyRoutes)
        → remote session daemon
```

Four properties of that path explain the reported timeouts.

1. **One fixed ceiling.** `DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 30_000`
   (`src/server/machines/machineClient.ts:28`) is the fallback budget for every
   federated route that does not name its own. In `src/shared/federatedRoutes.ts`
   only these name one: skills search/install/check/update, package-plugins
   mutation, pi-package install/remove/update, session
   tree-navigate/edit-from-here/fork (5 minutes each), and workspace-task move
   (30 seconds). `GET /sessions` names none, so a session list inherits 30
   seconds.
2. **The ceiling measures time-to-headers only.** `fetchResponse` clears the
   timer in `finally` the moment `fetch` resolves, i.e. when response headers
   arrive (`machineClient.ts:86-99`). A long body keeps streaming with no clock.
   So the budget is consumed by the far side's think-time plus link round trips,
   not by payload size.
3. **Nothing retries.** The proxy turns one abort into a 504
   (`sendGatewayError` in `machineProxyRoutes.ts`); the session-daemon proxy
   forwards no signal at all (`sessionProxyRoutes.ts`); the browser client throws
   on the first failure (`request()` in `src/client/src/api/http.ts`).
4. **The ceiling is not adjustable.** It is a compile-time constant.
   `StoredMachine` (`machineStore.ts`) holds name, base URL, token, headers, and
   timestamps — no timing field — so a machine on a poor link cannot be granted
   patience that a fast machine is spared.

What the operator sees today: a 504 becomes `HttpRequestError: Remote machine
timeout` in a single red banner (`PiWebUiApp.ts:4945`) — no machine named, no
elapsed time, no way to retry short of re-selecting the workspace.

## Success criteria

1. A session list the far side completes in up to two minutes loads without an
   error.
2. When the budget is exhausted, the user sees which machine, how long it waited,
   and can retry in one click.
3. A slow remote never blocks unrelated work in the tab — local-machine actions,
   other panes, and continuing session loads.
4. Patience is adjustable per machine between 5 seconds and 3 minutes, without
   hand-editing `machines.json`.
5. The local machine behaves exactly as it does today.

## Goals

- Per-machine patience for remote reads, defaulting to two minutes.
- A legible waiting state and an attributable failure state for a slow session
  list, with retry and a jump to the setting.
- A machine edit path, because patience is worthless if it can only be set once.

## Non-goals

See "Out of scope" for the full list. The two that matter most: no automatic
retry-with-backoff, and no stale-list rendering while a slow load runs.

## Decisions

| ID | Decision | Rationale |
| --- | --- | --- |
| D1 | Patience is a per-machine setting, default 120 s, bounds 5 s–180 s. | The bad thing is the link to a particular machine, not the app. A global constant can only be tuned once for all machines. |
| D2 | The wait is accompanied by an in-place status line, and failure names the machine with **Try again** and **Raise limit**. | A longer wait without a signal of life makes the felt problem worse. |
| D3 | The machine budget applies to every federated request to that machine; background refreshes abandon at ~20 s, silently, and retry on their next tick. | A browser keeps six connections per origin. Background refreshes must not hold them for minutes. |
| D4 | Feedback shape A: the existing empty-state slot, showing elapsed against the budget. | Reuses a surface that already says "Loading sessions…"; keeps the retry target unambiguous (there is one error string today and no operation provenance); cannot flash placeholders over a loaded list. |

The chosen UI shape and the two rejected alternatives are recorded in
[`assets/2026-11-01-remote-http-timeout-feedback-shapes.png`](assets/2026-11-01-remote-http-timeout-feedback-shapes.png).

## Design

### 1. Budget resolution

Precedence, most specific first. Only the second row is new.

| Call site | Budget |
| --- | --- |
| The remote health and runtime probes (3 s) | 3 s, unchanged — these measure liveness, not transfer, and must stay short |
| The federated routes that name 5 minutes (skills, package-plugin, pi-package, and session tree operations) | That value, unchanged — their duration is unrelated to link quality |
| Every other federated proxy route | The machine's `requestTimeoutMs`, else 120 000 |
| Browser background refresh to a remote machine | Abandoned at 20 000 by the client |
| Browser foreground read | No client timer; the gateway decides, and the existing selection signal still cancels on supersession |

One override disappears as part of this change. `WORKSPACE_TASKS_MOVE_PROXY_TIMEOUT_MS`
(`federatedRoutes.ts`) names 30 000, which is exactly today's default; an
override that duplicates the default expresses nothing, and while it stays it
would pin that route to 30 seconds on a machine granted two minutes. The route
drops the override and follows the machine budget. The two rows that remain — the
3-second probes and the 5-minute operations — are the ones whose number carries
meaning.

### 2. Machine record and API contract

- `StoredMachine` gains `requestTimeoutMs?: number`. Absent means the default;
  nothing rewrites existing registries.
- Server-side validation in `MachineService.add`/`update`, in the style of
  `validateBaseUrl`: an integer within 5 000–180 000 ms, rejected otherwise with a
  400 and a message naming the field and the range.
- The public `Machine` type carries it, so the browser can display the budget it
  is waiting against.
- The browser parser reads it additively: absent → `undefined`; present must be
  an integer in range, otherwise the response is invalid. A machine record with
  an unknown extra key stays valid.
- `PATCH /api/machines/:machineId` already exists and accepts a partial update;
  the browser client gains `machinesApi.updateMachine`, built through
  `request()` with the machine segment encoded, and typed against the shared
  update type.
- 180 s is deliberately below Node's 300 s server `requestTimeout`, so no server
  option has to change.

### 3. Background abandonment

The client gives background refreshes a short leash and lets the existing
cancellation semantics do the quiet part: `isLoadCancellation`
(`cancellableLoadScope.ts:59`) already classifies an abort as *cancelled, not
failed*, so an abandoned refresh is silent by construction and the next tick
simply tries again.

Two rules the implementation must state explicitly, because both directions are
easy to get wrong:

- A bow-out is never reported as a background error.
- A non-cancellation failure from a background refresh keeps reporting exactly as
  it does today.

The exact call sites are pinned by the specification after inspecting each one.
Current candidates, all of which pass no signal today:
`workspaceController.ts:151` (invalidation refresh), `:454`, `:584`;
`sessionController.ts:1165`; `projectActivityOwnershipCoordinator.ts:145`;
`PiWebUiApp.ts:3845`; the project catalog poller
(`projectCatalogController.ts`, 5 s); the git status refresh (8 s); the memory and
learned-skills snapshots (30 s). The spec must classify each as background or
foreground rather than applying a blanket rule, because
`workspaceController.refreshProjectSessions` and the `selectWorkspace` reads are
foreground and already carry a signal.

`AbortSignal.timeout` needs a small fallback for browsers that lack it; the
existing `AbortError` handling is the shared classifier.

### 4. Waiting and failure states

Applies only when the selected machine is remote, and only to a foreground
session-list load (`state.isLoadingSessions`).

| Elapsed | List area |
| --- | --- |
| under 5 s | "Loading sessions…" — unchanged |
| 5 s or more | "Loading sessions from *<machine>*… 0:12 of 2:00" |
| budget exhausted | "*<machine>* didn't answer in 2:00" with **Try again** and **Raise limit** |
| answered | the session rows |

The clock ticks once a second only while a foreground load is in flight, and
stops on completion, failure, or selection change. Elapsed minutes and seconds
come from the load's start time; the budget shown is the machine's
`requestTimeoutMs`, so the second number is real and not decoration.

### 5. Failure attribution and retry

Today `state.error` is one string with no provenance. Rather than match on its
text, the foreground session-list read records a typed failure for the current
scope: machine id and name, elapsed, and budget.

- `state.error` is still set, so every existing rule that keys off "there is an
  error" — including the start-screen gate — keeps its present behaviour.
- The generic banner steps aside while a typed session-list failure is present,
  so the user reads one message, not two.
- **Try again** calls a dedicated `retrySessionList()` that re-reads only the
  session list for the current *(machine, project, workspace)* scope under the
  same supersession guards as the original load, keeps the selected session, and
  re-arms the notice clock.
- **Raise limit** opens the machine dialog prefilled for that machine with the
  patience field focused.

### 6. Machine edit path

The dialog is create-only today and no browser code calls the update route, so
this part is genuinely new surface:

- `MachineDialog` gains an edit mode: prefilled fields, a patience field (number,
  in seconds, bounded), and a submit payload that includes `requestTimeoutMs`.
- `MachineList`'s existing "⋯" menu gains **Edit** above **Remove**.
- `machinesApi.updateMachine(id, patch)` → `PATCH /api/machines/:machineId`.
- A failed update shows the server's validation message in the dialog; the
  dialog stays open with the entered values.

### 7. Invariants to preserve

- The remote timer is cleared when response headers arrive, never after the body.
  Extending it to body streaming would guillotine large responses; this design
  keeps the current placement and states it as an invariant.
- The remote health and runtime probes keep their 3-second budget.
- Browser paths stay application-relative and are resolved once at the browser
  boundary, per the project's URL convention.
- The local machine has no budget, no notice, and no behaviour change.

## Error handling

| Situation | Today | After |
| --- | --- | --- |
| Remote answers within budget | rows appear | unchanged |
| Remote slower than the machine budget | 504, generic banner | 504, list slot names the machine and elapsed time, banner suppressed, retry offered |
| Background refresh slower than 20 s | held to the 30 s ceiling, then a background error | abandoned at 20 s, silent, retried next tick |
| Machine unreachable (DNS, refused) | 502 banner | unchanged — this is not a timeout |
| Machine deleted mid-flight | 404 | unchanged |
| Invalid patience value saved | n/a | 400 with the field and range named; nothing persisted |
| Local machine load fails | banner | unchanged |

## Edge cases and risks

1. **Six connections per origin.** Long-held foreground reads compete with other
   traffic to the same origin. The 20 s bow-out bounds background refreshes; two
   or three concurrent foreground reads remain possible and acceptable.
2. **A reverse proxy in front may cut earlier.** Many deployments default to a
   60 s read timeout. Raising the machine budget above the deployment's proxy
   timeout has no effect, and the documentation must say so.
3. **Version skew.** An older remote gateway keeps its own 30 s ceiling. A newer
   local gateway asking patiently still receives the older gateway's 504 after
   30 seconds. The setting governs this gateway's patience *toward* the remote;
   it cannot extend patience on the far side. Documented, not engineered around.
4. **A dead machine now takes longer to fail.** Two minutes instead of 30
   seconds. This is the accepted cost of the chosen approach, mitigated by
   showing the clock; **Raise limit** is the remedy for a machine that is
   habitually slow rather than dead.
5. **Poll cadence degrades before it piles up.** The catalog poller is
   single-flight (`inFlight` plus a queue), so a slow machine reduces refresh
   cadence rather than accumulating requests.
6. **Retry storms.** **Try again** is a user action, not a timer; no automatic
   retry exists, so repeated slow loads cannot self-amplify.

## Test strategy

By layer, narrowest first:

1. **Machine client:** an explicit per-call budget wins; absent a per-call
   budget the machine's value applies; absent both the 120 s default applies; the
   timer still covers only time-to-headers.
2. **Machine service:** bounds accepted at 5 000 and 180 000, rejected below,
   above, non-integer, and non-numeric; the value survives a store round trip and
   its absence does not.
3. **Machine store:** a registry without the field parses, and an update that
   omits the field leaves it absent rather than writing a default.
4. **Proxy contract:** the budget reaching `RemoteMachineClient` for a federated
   route comes from the machine record, a 5-minute route is unaffected, and the
   workspace-task move route follows the machine budget rather than a redundant
   30 s override.
5. **Browser parser and client:** additive parse with the field absent, present,
   and malformed; `updateMachine` sends `PATCH` with the encoded machine segment
   and the exact outbound body; a nested base path stays correct.
6. **Session-list notice:** the clock appears only after 5 s, only for a remote
   machine, only for a foreground load; the displayed budget comes from the
   machine; the clock stops on completion, failure, and selection change.
7. **Failure slot:** one message not two; the banner is suppressed only for this
   failure; the typed failure clears on success and on selection change.
8. **Retry:** re-reads only the session list, keeps the selected session, and
   respects supersession so an older response cannot overwrite a newer selection.
9. **Background bow-out:** an abandoned refresh reports nothing; a genuine
   background failure still reports.

Fake timers and injected clocks throughout; no test touches a real network. Final
validation is `npm run verify`.

## Documentation plan

- The machine federation page gains a short section on slow-link patience: what
  the default is, how to raise it per machine, and the two limits — a reverse
  proxy in front of this gateway, and an older remote gateway's own 30 s ceiling.
- The configuration reference already documents the machine registry file; if it
  mentions machine fields, the new field joins that table. Placement follows the
  repository documentation guide, which keeps detail under `docs/` and the README
  short.
- A Changeset entry, because a user-visible behaviour and a new setting change.

## Out of scope

Automatic retry with backoff; showing the last known list while a slow load runs;
paging or streaming the session list; per-route patience lists; any change to the
health or runtime probes; any change for the local machine; request coalescing or
circuit breakers; compressing or reshaping the session-list payload (the deadline
covers time-to-headers, so payload is not the bottleneck).

## UI record

Three shapes were drawn and compared as one composite; shape A was chosen.

| Option | Shape | Outcome |
| --- | --- | --- |
| A | In-place line in the existing empty-state slot, elapsed against budget, Try again plus Raise limit | **chosen** |
| B | Status strip under the header spanning the content, with Keep waiting and Cancel | rejected — needs machine-wide in-flight state the app does not have, and the retry target becomes ambiguous |
| C | Skeleton placeholder rows plus a budget progress bar | rejected — needs a placeholder branch in the list and can flash over a loaded list; its two useful ideas (elapsed-of-budget, Raise limit) were folded into A |

![Three feedback shapes for a slow remote load](assets/2026-11-01-remote-http-timeout-feedback-shapes.png)
