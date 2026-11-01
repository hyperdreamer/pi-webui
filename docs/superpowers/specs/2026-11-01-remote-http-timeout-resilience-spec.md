# Remote HTTP Timeout Resilience Specification

**Date:** 2026-11-01  
**Status:** technical specification; implementation pending  
**Source of truth:** [Remote HTTP Timeout Resilience Design](2026-11-01-remote-http-timeout-resilience-design.md) (approved, revision 3)

## Background

A remote session-list read goes through the browser, this gateway's machine proxy, `RemoteMachineClient`, the remote gateway's session proxy, and the remote daemon. The machine proxy forwards the machine-scoped URL through `remoteApiPath` (defined at `src/server/machines/machineProxyRoutes.ts:135`, called at `:50`); the receiving session proxy strips its prefix and awaits the daemon's complete body (`src/server/sessiond/sessionProxyRoutes.ts:19`). The daemon's list operation awaits enumeration, archives, and metadata before constructing its response (`src/server/sessions/piSessionService.ts:1772`).

The current remote fallback is 30,000 ms, and `fetchResponse` clears its timer as soon as `fetch` resolves with headers (`src/server/machines/machineClient.ts:28`, `:84`). The receiving gateway buffers the daemon response before answering, so daemon processing and that buffering count against the outward gateway's header deadline. Transfer after the remote gateway's headers does not (`src/server/sessiond/sessionProxyRoutes.ts:22`, `src/server/machines/machineClient.ts:67`). This specification preserves that boundary while raising and exposing the machine budget.

The existing selected-workspace load clears the active session before loading and may select a preferred session afterward (`src/client/src/controllers/workspaceController.ts:233`). The existing refreshed-list application may also rejoin, select a replacement, or deselect a session (`src/client/src/controllers/sessionController.ts:1174`). Neither complete path is a suitable implementation of list-only Retry.

## Goal and scope

A remote machine has a configurable header-wait budget of 120 seconds by default, bounded to 5–180 seconds. Human session-list loads show an attributable waiting/receiving state and typed timeout/transfer failures in the navigation session-list section. Retry reads that list without changing session selection. Background reads identified below abandon after 20 seconds, silently, with transport cancellation through current gateways.

The implementation includes shared types and validation, machine persistence/service/API changes, the federated HTTP and daemon-proxy boundaries, browser HTTP/API adapters, controller cancellation and load provenance, the session-list notice, both machine menus, the create/edit dialog, focused tests, user documentation, and one Changeset. The local machine receives no new timer, notice, setting, or selection behavior. No runtime dependency is required.

This drafting task creates only this specification. All other files and commands described below are future implementation work.

## Constants and exported contracts

### Budgets and validation

Add `src/shared/machineRequestTimeout.ts` with these exact exports:

```ts
export const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 120_000;
export const MIN_REMOTE_REQUEST_TIMEOUT_MS = 5_000;
export const MAX_REMOTE_REQUEST_TIMEOUT_MS = 180_000;
export const REMOTE_BACKGROUND_REQUEST_TIMEOUT_MS = 20_000;

export function validateMachineRequestTimeoutMs(value: unknown): number;
export function effectiveMachineRequestTimeoutMs(
  machine: { requestTimeoutMs?: number },
): number;
```

These are declaration contracts; implementations supply bodies. Validation accepts only a finite JavaScript number for which `Number.isInteger(value)` is true and `5_000 <= value <= 180_000`. It returns that number unchanged. Every invalid supplied value throws `Error("requestTimeoutMs must be an integer between 5000 and 180000 milliseconds")`. Do not coerce strings, round fractions, clamp, or interpret `null` as reset. `effectiveMachineRequestTimeoutMs` returns `machine.requestTimeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS` for an already validated machine.

Keep `DEFAULT_REMOTE_REQUEST_TIMEOUT_MS` import-compatible by re-exporting it from `src/server/machines/machineClient.ts`; remove its old local definition. Keep that module's `DEFAULT_REMOTE_HEALTH_TIMEOUT_MS = 3_000`. The current health and runtime callers explicitly pass that constant (`src/server/machines/machineService.ts:129`, `:153`).

Export these constants from the new `src/client/src/components/SessionListLoadNotice.ts`:

```ts
export const SESSION_LIST_NOTICE_DELAY_MS = 5_000;
export const SESSION_LIST_NOTICE_TICK_MS = 1_000;
```

### Machine types

In `src/shared/apiTypes.ts`, add `requestTimeoutMs?: number` to `Machine` and export the shared request shapes:

```ts
export interface MachineCreateRequest {
  name?: string;
  baseUrl?: string;
  token?: string;
  headers?: Record<string, string>;
  requestTimeoutMs?: number;
}
export type MachineUpdateRequest = Partial<MachineCreateRequest>;
```

The optional name/base URL preserve service-side validation. Keep `CreateMachineInput` and `UpdateMachineInput` exported from `machineService.ts` as aliases of these respective shared types, so existing server imports remain valid. They currently live in that server module (`src/server/machines/machineService.ts:7`). A public machine never exposes its token or configured headers; extend the existing public projection with only the optional timeout (`src/server/machines/machineService.ts:175`).

### Machine client and reply ownership

Extend, without changing the existing positional request arguments:

```ts
export interface MachineRequestOptions {
  timeoutMs?: number;
  contentType?: string;
  signal?: AbortSignal;
}
```

`MachineClient.request`, `requestJson`, and `connectWebSocket` otherwise retain their signatures. Widen the `RemoteMachineClient` constructor's machine parameter to `Pick<StoredMachine, "baseUrl" | "token" | "headers" | "requestTimeoutMs">`; retain its injected `fetchImpl: typeof fetch` parameter. The present interfaces and constructor are at `src/server/machines/machineClient.ts:17`, `:22`, `:55`.

Add `src/server/http/replyDisconnect.ts` with:

```ts
export interface ReplyDisconnectScope {
  readonly signal: AbortSignal;
  dispose(): void;
}
export function createReplyDisconnectScope(
  reply: import("fastify").FastifyReply,
): ReplyDisconnectScope;
```

This helper owns only reply lifecycle listeners and its controller. It has no timer, does not send a response, and is not used for mutations.

### Browser transport and background helper

Extend `src/client/src/api/http.ts` as follows:

```ts
export type ResponseStarted = (response: Response) => void;

export async function request<T>(
  url: string,
  parse: (value: unknown) => T,
  init?: RequestInit,
  onResponse?: ResponseStarted,
): Promise<T>;

export class HttpResponseBodyError extends Error {
  readonly status: number;
  readonly cause: unknown;
  constructor(status: number, cause: unknown);
}
```

`HttpResponseBodyError.name` is `"HttpResponseBodyError"` and its message is `"Failed to receive response body"`. Existing `HttpRequestError` and `requestJson` retain their public contracts (`src/client/src/api/http.ts:3`, `:27`). The callback is opt-in; unrelated HTTP callers retain their current body/error handling.

Add `src/client/src/controllers/backgroundRead.ts` with these exports:

```ts
export type ReadIntent = "background" | "foreground";
export async function runBackgroundRead<T>(
  machineId: string,
  read: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T>;
```

Use the existing `LoadCancelledError` and `isLoadCancellation` exports from `cancellableLoadScope.ts`; do not introduce a second cancellation classifier. Its current classifier accepts the load marker and `AbortError`, not native `TimeoutError` (`src/client/src/controllers/cancellableLoadScope.ts:59`). Extend the existing marker's constructor from `constructor()` to `constructor(message = "Load cancelled because the selection changed")`, forwarding `message` to `super` and retaining `name = "LoadCancelledError"`. Existing no-argument callers keep their current message; the background helper supplies the exact deadline message below (`src/client/src/controllers/cancellableLoadScope.ts:45`).

## Server budget resolution

Two steps establish the budget. Route adapters supply a meaningful explicit override, if any. `RemoteMachineClient` then resolves exactly:

```ts
options.timeoutMs
  ?? machine.requestTimeoutMs
  ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS
```

A per-call override is not constrained to the machine setting's 180-second maximum. In particular, never clamp 300,000 ms to that maximum.

| Request | Value supplied as `options.timeoutMs` | Effective header deadline |
| --- | --- | --- |
| Machine-service remote health and runtime probes | `DEFAULT_REMOTE_HEALTH_TIMEOUT_MS` | 3,000 ms regardless of machine setting |
| `/skills/search`, `/skills/install`, `/skills/check`, `/skills/update` POST operations | `SKILLS_OPERATION_PROXY_TIMEOUT_MS` | 300,000 ms |
| `/package-plugins` POST | `PI_PACKAGE_PLUGINS_OPERATION_PROXY_TIMEOUT_MS` | 300,000 ms |
| `/pi-packages/install`, `/pi-packages/remove`, `/pi-packages/update` POST | `PI_PACKAGE_MUTATION_PROXY_TIMEOUT_MS` | 300,000 ms |
| Session `/tree/navigate`, `/messages/edit-from-here`, `/messages/fork` POST operations | `SESSION_TREE_NAVIGATION_PROXY_TIMEOUT_MS` | 300,000 ms |
| All other entries in `FEDERATED_HTTP_ROUTES`, including workspace-task move and `/config` GET/PUT | Omitted | Stored machine value, otherwise 120,000 ms |
| Identified remote browser background reads | No server override | Same gateway rule; browser independently abandons after 20,000 ms |

The four operation constants and their route assignments already exist (`src/shared/federatedRoutes.ts:3`, `:45`, `:51`, `:53`, `:127`). Remove `WORKSPACE_TASKS_MOVE_PROXY_TIMEOUT_MS` and the move route's `timeoutMs` property (`src/shared/federatedRoutes.ts:14`, `:19`). Keep all other operation overrides as listed. Route handlers must not substitute the 120-second default into `options.timeoutMs`, since that would mask a stored machine value.

The plugin manifest has a separate 10-second budget outside this federated table (`src/server/machines/machinePluginProxyRoutes.ts:23`, `:43`). Preserve it. This work does not change WebSocket lifetimes, probe caches, or introduce a body-transfer timeout. Existing JSON/config and raw-body serialization must continue to work; preserve the content-type forwarding in `proxyRequestOptions` (`src/server/machines/machineProxyRoutes.ts:142`).

### `RemoteMachineClient` deadline and caller signal

Each request owns one combined `AbortController`, one header timer, and, when supplied, one caller-abort listener. Do not use the browser-only background helper on the server.

1. Check a pre-aborted caller signal before starting fetch. Reject with its `Error` reason, or a `DOMException("The operation was aborted", "AbortError")` if the reason is not an `Error`. No fetch or deadline timer starts in this case.
2. Attach a once-only listener to the caller, forwarding its reason to the combined controller, then recheck `signal.aborted` to close the attach/check race. Start the resolved header timer only if still live. First abort source wins; record whether it was caller or deadline before aborting the combined controller.
3. Pass the combined signal to the injected fetch. Caller cancellation and the timer are independent of every other request, including mutations on the same machine.
4. When fetch resolves with a `Response`, clear the header timer immediately, before body adaptation or parsing. Do this for success and non-success HTTP statuses. There is no replacement body timer. If cancellation already won the race, cancel/dispose the response body and reject rather than publishing a live response.
5. Keep caller cancellation connected after headers. For `request`, its ownership transfers to the returned Node readable until end, error, close, or destruction. Caller abort must stop the underlying fetch/body and destroy the adapter. For `requestJson`, retain the caller listener through `response.text()` and JSON parsing; dispose in its outer `finally`. A null body disposes immediately.
6. Fetch rejection before headers clears the timer and listener. A deadline-owned rejection becomes `RemoteMachineRequestError("Remote machine request timed out", 504)`. A caller-owned rejection keeps the caller's cancellation reason; it must not become 504 or 502 merely because fetch uses `AbortError`. Other fetch failures retain the 502 mapping. Do not classify timeout solely by exception name.
7. Body failure after headers is a stream/JSON-read failure, never expiry of the cleared header deadline. Every success, failure, abort, no-body response, and adapter-construction failure releases its owned listeners. Cleanup is idempotent and removes no collaborator-owned listeners.

This deliberately changes the current blanket `AbortError`-to-504 mapping while retaining its timer-at-headers boundary (`src/server/machines/machineClient.ts:84`). A delayed body may run past the machine budget indefinitely until completion, cancellation, or transport error.

## Federated proxy lifecycle

### Disconnect ownership

At the entry to `proxyMachineHttpRequest`, after rejecting `machineId === "local"` but **before** awaiting machine lookup, create a reply disconnect scope for `method === "GET"` only. GET is the cancellable-read class at this proxy boundary. Other methods receive no browser lifecycle signal; their independent gateway deadline still applies. Do not attach this scope to workspace-task moves, configuration PUTs, notification dismissals, session creation, or any other mutation.

`createReplyDisconnectScope` performs the following exact lifecycle:

- Register `reply.raw.once("finish", onFinish)` and `reply.raw.once("close", onClose)`. Observe the outgoing `ServerResponse`, not `request.raw`'s ordinary `close` event or a reusable socket's lifetime.
- `onFinish` marks completion and calls `dispose()` without aborting. `onClose` aborts with a server `AbortError` only if completion has not occurred and `reply.raw.writableFinished !== true`, then disposes. A normal finish followed by close must not abort a completed request.
- After attaching, handle an already destroyed, unfinished reply as a disconnect and an already finished reply as completed. `dispose()` removes exactly these two listeners and is idempotent.
- Retain listeners while waiting for machine lookup, upstream headers, body streaming, and buffered JSON/config reads. Never dispose merely because `client.request()` returned headers or the handler called `reply.send(stream)`.
- For 404 lookup responses, no-body replies, rejected fetches, transformed config JSON, and other replies that never stream, normal reply finish/close still performs cleanup. If control exits without sending and the reply is not continuing asynchronously, explicitly dispose in that terminal path. There must be no orphan `pipe` listener or disconnect scope waiting for a stream that will never exist.

Check the scope after asynchronous machine lookup and before each send. If the client has disconnected, return the reply without fetching or sending another error. A request rejection caused by that disconnect is silent at the proxy boundary. If a separate error reaches a destroyed reply, dispose and return; if headers have already been sent, destroy the response instead of attempting `reply.code(...).send(...)`.

For GET, merge `signal` into the existing request options without losing `timeoutMs` or `contentType`; for other methods leave `signal` undefined. Keep `proxyMachineHttpRequest` as the common route boundary: workspace-task proxy registrations already delegate to it (`src/server/workspaceTasks/workspaceTasksProxyRoutes.ts:1`). The `/config` GET special case must pass this signal through `proxySelectedMachineConfigRequest` into `client.requestJson`; its PUT passes no lifecycle signal. Retain config response validation and machine-local config projection, including `sessiond`/`sessiondUrl`; do not turn it into an unvalidated byte stream (`src/server/machines/machineProxyRoutes.ts:72`, `:90`).

`/api/machines/:machineId/pi-webui-plugins/manifest.json` is a second route boundary that the machine proxy does not own. It calls `client.requestJson` with its own 10-second budget (`src/server/machines/machinePluginProxyRoutes.ts:23`, `:43`) and today passes no lifecycle signal. It is a GET read of the same class as the routes above, so it creates its own reply disconnect scope and passes that signal — while keeping the 10-second budget exactly as it is. A manifest read never widens to the machine budget, and the exempt-by-omission reading is not acceptable: either this scope exists, or the design's statement that federated proxy reads cancel on disconnect is false. The existing assertion in `src/server/app.plugins.test.ts:80` that pins `{ timeoutMs: 10000 }` must be extended to accept the reply-owned signal while still asserting the exact 10-second budget; do not replace it with a looser matcher.

### Eager streaming headers

For a returned upstream Node readable, forward the upstream status and existing safe-header allowlist, then arm a one-shot listener on **`reply.raw`'s `"pipe"` event immediately before `reply.send(upstream.body)`**. The callback calls `reply.raw.flushHeaders()` if the reply is neither destroyed nor already headers-sent. It neither reads nor writes a body byte. Keep a local handle for that one-shot listener and remove it on finish, close, **and** in the catch that surrounds `reply.send(upstream.body)` (`src/server/machines/machineProxyRoutes.ts:60-63`). A send that throws before the raw `pipe` event must not leave the listener armed; that failure takes the ordinary gateway error path because no headers were flushed.

This position is mandatory. In the installed Fastify stream path, final reply headers are copied onto the raw response immediately before `payload.pipe(res)` (`node_modules/fastify/lib/reply.js:842`). Node's destination `pipe` event occurs before source data flows. The compression hook sets `Content-Encoding`, `Vary`, and removes the upstream content length before that final stream reaches `sendStream` (`node_modules/@fastify/compress/index.js:246`). Consequently the listener flushes the compression-adjusted headers and status even when the **first** body chunk is delayed. Do not call `flushHeaders()` earlier in the handler or bypass the compression hook with `reply.hijack()`/manual raw piping.

Keep Fastify responsible for piping, backpressure, and source/destination destruction. If the source or compressor fails after the eager flush, **close/destroy `reply.raw`**; a replacement 502/504 body or a second header write is invalid. The existing Fastify source-error branch destroys the response after headers have been sent (`node_modules/fastify/lib/reply.js:842`); any new catch path must preserve that outcome. A failure before headers may still use the existing gateway error response.

No-body and buffered JSON/config responses do not arm this listener. Compression remains negotiated by the existing app registration (`src/server/app.ts:303`), and content/header security allowlists remain intact. No header advertises the machine budget and no synthetic body byte is inserted to force a flush.

## Receiving gateway and daemon hop

`SessionProxyDaemon.request` and `SessionDaemonClient.request` already accept a fourth `signal` argument, and the HTTP and Unix-socket implementations use it (`src/server/sessiond/sessionProxyRoutes.ts:6`, `src/sessiond/sessionDaemonClient.ts:26`, `:45`, `:59`). The missing work is the receiving session proxy's ownership and forwarding, not a new daemon protocol.

At this hop, opt in only when **all** of the following hold: registration `prefix === "/api"`, method `GET`, stripped pathname exactly `/sessions`, and a `cwd` query value exists and is not the empty string. Parse path/query separately; do not match `/sessions/*` by a string prefix. This is the remote machine client's ordinary `/api/sessions?cwd=...` list read. Keep `/api/machines/local` registrations and all other requests on the existing unsignalled path. Both registrations exist (`src/server/app.ts:407`). Do not attach lifecycle cancellation indiscriminately to the generic `app.all` proxy.

For the opted-in read, create `createReplyDisconnectScope(reply)` before `daemon.request`; pass its signal as argument four, retaining body argument three as `undefined`. Keep it active until the daemon body's complete buffering and the outgoing reply's finish/close. Suppress `requestFailed` when the downstream reply has disconnected. Forward success/error status, JSON handling, and safe headers as before. There is no eager response here while daemon enumeration is pending: this gateway still awaits the full daemon body.

For notification mutations, auth, probes, generic requests, `/sessions` without `cwd`, and local-prefixed requests, pass no lifecycle signal. Preserve the existing tests named `does not forward browser cancellation to notification mutations` and `does not forward Fastify lifecycle cancellation to generic daemon requests`, including `daemon.requestSignals === [undefined]` (`src/server/sessiond/sessionProxyRoutes.test.ts:212`, `:231`). A list's cancellation controller must never own a concurrent accepted mutation.

Cancellation chains as: browser fetch abort → this gateway's unfinished reply close → remote fetch abort → receiving gateway's unfinished reply close → `daemon.request(..., signal)` abort. The last step stops the HTTP/Unix request, reception, and gateway buffering; already-started enumeration and snapshot reads **continue**. The daemon route calls `sessions.list(cwd)` with no signal (`src/server/sessions/sessionRoutes.ts:71`), and its implementation takes no signal (`src/server/sessions/piSessionService.ts:1772`). Do not change daemon enumeration, session state, mutation queues, or the sessiond wire protocol. With an older receiving gateway, its daemon request/buffering can continue after our outward transport has stopped.

## Machine validation and persistence

`StoredMachine`, `MachineStore.add`'s input, and `MachineStore.update`'s patch whitelist gain the optional field. The current store's record, construction, update merge, and parser are at `src/server/machines/machineStore.ts:6`, `:40`, `:58`, `:104`.

| Boundary | Required behavior |
| --- | --- |
| POST `/api/machines` without field | Validate existing fields; persist no timeout key; public response omits it |
| POST with valid field | Validate before any write; persist and return the exact integer |
| PATCH without field | Do not include it in the store patch; retain an existing value or existing absence |
| PATCH with valid field | Replace the stored value; public response carries it; subsequent remote clients use it |
| POST/PATCH with an own `requestTimeoutMs` key containing an invalid value | HTTP 400 with `{ "error": "requestTimeoutMs must be an integer between 5000 and 180000 milliseconds" }`; no registry write, timestamp change, or cache invalidation |
| Store read with no field | Parse successfully; do not materialize or migrate the default |
| Store read with field | Validate it and preserve it; malformed stored values fail reading rather than silently falling back |
| Explicit reset to default | Save `120000`; there is no null/delete/reset API in this change |
| Local machine | Public record omits field; existing local update rejection remains |

Check presence with an own-property test, so `null`, `"120000"`, booleans, fractions, `NaN`, infinities, and a directly supplied `undefined` property cannot masquerade as omission. JSON omission remains omission. Service validation must occur on add and update even though TypeScript callers are typed. Reuse the shared validator in service, store parsing, and browser parsing; do not create subtly different ranges.

Preserve secrets, unrelated fields, registry location, and file permissions. The store uses `PI_WEBUI_MACHINES_FILE` or its data-directory default and mode `0o600` (`src/server/machines/machineStore.ts:21`, `:27`, `:91`). Its successful update merge and service cache invalidation remain otherwise unchanged (`src/server/machines/machineStore.ts:64`, `src/server/machines/machineService.ts:58`). A saved setting affects the next request on the gateway that owns this registry, without restarting or reconnecting sessions. In-flight requests and their captured UI budgets retain their original value.

## Browser API and phase reporting

`machinesApi.addMachine` accepts the shared `MachineCreateRequest`. Add `machinesApi.updateMachine(machineId: string, patch: MachineUpdateRequest): Promise<Machine>` using:

```ts
request(`api/machines/${encodeURIComponent(machineId)}`, parseMachine, {
  method: "PATCH",
  body: JSON.stringify(patch),
});
```

Do not wrap the payload in another object or send unspecified fields. This extends the existing machine API object (`src/client/src/api/clients.ts:224`). All app paths are application-relative and resolved once in `request`; dynamic segments and query values remain encoded. Nested deployment must work without a leading `/api` or double base-path resolution.

Extend `parseMachine` (`src/client/src/api/parsers.ts:218`) with these rules: absent own key produces no key/`undefined`; present own key is validated with the shared integer/range contract and returned unchanged; malformed presence invalidates the response. Unknown additional keys stay accepted. Do not fill the default in the parsed object. The local-machine API emits no field; the additive parser still validates any present timeout key rather than silently discarding malformed data based on `kind`.

Add an optional fourth `onResponse?: ResponseStarted` argument to `sessionsApi.sessions(cwd, machineId?, signal?, onResponse?)`, forwarding it to `request`. Add an optional final `signal?: AbortSignal` to `memoryApi.snapshot`, `learnedSkillsApi.snapshot`, `gitApi.gitStatus`, and `gitApi.gitDiff`, and to their injected controller collaborator types. Keep `workspacesApi.workspaces`' existing third signal argument (`src/client/src/api/clients.ts:420`, `:453`). No API adapter installs the background deadline globally.

For an opted-in response callback, `request` invokes it once immediately after fetch resolves, before status-body processing or reading the successful body. The controller enters `receiving` only for `response.ok === true`. Non-2xx responses never advance that phase. On successful opted-in responses, consume `response.text()` once, catch **only that body-read operation**, and then perform `JSON.parse` and the supplied parser outside that catch. A body-read rejection that is cancellation stays cancellation; any other body-read rejection becomes `HttpResponseBodyError(response.status, cause)`. Invalid JSON and invalid session records remain ordinary errors. Do not clone/read the response twice, wrap schema failures as transfer failures, or infer transfer failure from error-message text. Callers that omit the callback and `requestJson` retain their existing behavior.

The callback is the sole phase source. It reflects the machine proxy's eager upstream-header flush, not a guessed elapsed time, receipt of the first body chunk, daemon progress, or completion of JSON parsing. With network/proxy latency the browser observes headers later than the gateway, but it must not wait for a body byte to do so.

## Background read ownership

For `machineId === "local"`, `runBackgroundRead` delegates directly to `read(signal)` with no timer or additional controller. For remote IDs it owns a 20,000-ms deadline that covers fetch **and body consumption** until the read promise settles. This browser bow-out intentionally has a different boundary from the server header timer.

Use a controller whose deadline reason is `new LoadCancelledError("Background read exceeded 20000 milliseconds")`. Feature-detect the two static AbortSignal helpers independently:

- If `AbortSignal.timeout` exists, use it as a deadline event source, never as the signal passed directly to fetch. Translate its timeout abort into the marker-bearing controller abort. If unavailable, use `setTimeout` to abort that controller with the same marker at exactly 20,000 ms.
- If `AbortSignal.any` exists, it may combine the marker-bearing deadline signal and the supplied supersession signal. If unavailable, forward each into an owned controller using once-only listeners and recheck already-aborted sources. First reason wins. In neither path may a native `TimeoutError` escape as this helper's bow-out.
- Always dispose forwarding/deadline listeners on completion, error, abort, and synchronous collaborator throw; clear a fallback timer. A native timeout's internal timer is not cancellable, so remove its listener on settlement and leave it unable to act on the disposed request. Do not attach sources to a long-lived application signal after settlement.

A pre-aborted parent does not start the read. If the read settles concurrently with an abort, do not publish its result after the operation's signal is aborted. All controller publication guards still apply; signals do not replace generation, identity, topology-order, or revision checks.

Every reporting boundary which can observe this helper must first apply `isLoadCancellation(error)`. Marker/supersession cancellation performs no error publication or background-error callback. Genuine errors retain their existing reporting behavior, stale-data behavior, and ordinary retry cadence. For catalog fallback cancellation, use its guarded loading cleanup without applying a failure. Discovery hydration remains unhydrated after bow-out. Activity-ownership discovery must not permanently mark an unresolved activation as attempted because its pass bowed out; it remains eligible on a later reconciliation. No immediate retry loop is introduced.

### Exact call-site classification

Locations below refer to the inspected implementation before this change. **Background** means periodic reconciliation or unsolicited invalidation/discovery; **foreground** means an explicit load/action or reconciliation needed to reflect its accepted mutation. Fire-and-forget syntax does not decide the classification. Conditional rows state the caller intent that must reach the shared boundary.

| Existing call site | Classification and implementation rule |
| --- | --- |
| `workspaceController.ts:151`, `scheduleSessionListRefresh` → `api.sessions` | Background **only** for realtime/recovery invalidations; wrap each remote per-cwd read with the helper. Foreground callers of the same queue keep the full gateway budget. |
| `PiWebUiApp.ts:1587`, selected-machine realtime recovery → `refreshSessionLists` | Background; pass explicit `"background"` intent. |
| `PiWebUiApp.ts:1640`, `sessions.changed` → `refreshSessionLists` | Background; pass explicit `"background"` intent for affected cwd. |
| `workspaceController.ts:219`, project selection → `api.workspaces` | Foreground; retain its selection signal, no 20-second timer. |
| `workspaceController.ts:263`, selected workspace → `api.sessions` | Foreground for selection/route restoration; retain selection signal. For an actual `target.catalogScope` fallback use background bow-out and owner `catalog-fallback`. |
| `workspaceController.ts:337`, `refreshProjectSessions` → sibling `api.sessions` | Foreground when continuing the selection load; retain its inherited signal. When continuing a catalog fallback, inherit background intent and use the helper for each read. Do not infer background from `void` at line 284. |
| `workspaceController.ts:454`, `refreshProjectWorkspaces` → `api.workspaces` | Foreground. This serves `refreshAfterWorkspaceDeleted` at line 460 and command-run workspace resolution from `PiWebUiApp.ts:3756`; retain the full budget. |
| `workspaceController.ts:584`, `hydrateDiscoveredWorkspaceSessions` → `api.sessions` | Background catalog discovery; helper per workspace read; retain topology/revision guards and eligibility after cancellation. |
| `sessionController.ts:1160`, wired `refreshCurrentWorkspaceSessions`; `:1165`, direct fallback → `api.sessions` | Foreground post-mutation/cleanup/reorder reconciliation; no 20-second timer in either branch. |
| `sessionController.ts:2193`, `revalidateSessionListsAfterCommit` → `refreshSessionLists` | Foreground even though fire-and-forget. Pass explicit `"foreground"`; preserve nonblocking creation confirmation/model-policy writeback. |
| `PiWebUiApp.ts:267` and `:268`, SessionController refresh dependency wiring | Foreground from mutation reconciliation, including reorder recovery (`sessionController.ts:1251`). Forward explicit intent rather than defaulting these calls to background. |
| `projectActivityOwnershipCoordinator.ts:145`, `runPass` → `api.workspaces` | Background discovery; helper per project; cancellation is silent and cannot retire unresolved ownership permanently. |
| `projectCatalogController.ts:182`, `load` → `listWorkspaces` | Background for scope observation, 5-second poll, invalidation, recovery, and browser-resume reconciliation. Pass helper signal through the collaborator; retain single-flight and topology-order capture. |
| `gitController.ts:89` and `:90`, initial polling refresh and 8-second interval → `refreshGit`; network at `:35` | Background. Pass explicit background intent; one helper scope covers status plus any consequential selected diff reads at lines 72–73, so that pass cannot spend another 20 seconds per diff. |
| `gitController.ts:27`, manual `refreshGit`; direct `refreshDiff` network at `:72`–`:73` | Foreground unless called as the continuation of that background poll. Explicit toolbar/keyboard refresh and user diff selection keep full budget; `reportError: false` is not an intent classifier. |
| `memoryController.ts:124`, `load` → `fetchSnapshot` | Background only on the scheduled 30-second poll. Initial scope load and explicit `refresh()` at line 81 are foreground. Thread intent to this common network boundary. |
| `learnedSkillsController.ts:124`, `load` → `fetchSnapshot` | Same rule as memory: scheduled poll is background; initial scope load and explicit line-81 refresh are foreground. |
| `PiWebUiApp.ts:3372`, `onRefreshMemory`; `:3637`–`:3638`, learned-skills refresh callbacks | Foreground; keep default explicit-refresh behavior without bow-out. |
| `PiWebUiApp.ts:3845`, `showProjectStatistics` → `workspacesApi.workspaces` | Foreground, as are its subsequent usage/count requests; do not apply background bow-out to a statistics load. |
| `GitUpdateManagerPanel.ts:86`, `:232`, direct `gitStatus` and `gitDiff` reads | Foreground. These are explicit user-driven reads outside `gitController`; they keep the full gateway budget and never receive the background helper, even though they are `await`ed inside a render-triggered load. |
| New `WorkspaceController.retrySessionList()` | Foreground, current list only, no 20-second timer, owner `retry`. |
| `machineService.ts:129` and `:153`, health/runtime probes | Separate 3-second server probe class; no browser background helper and no longer machine override. |

This table is the exhaustive bow-out adoption list for this change. Its background branches receive the helper; its foreground branches explicitly do not. It does not authorize blanket timeouts on `api`, all GET requests in the browser, all `reportError: false` calls, all asynchronous refreshes, or mutations.

### Foreground precedence in shared queues

Extend `WorkspaceController.refreshSessionLists(cwds?, machineId?, intent: ReadIntent = "foreground")` and its SessionController dependency to carry intent. The existing refresh scope has a dirty cwd set and the existing coordinator replaces `latestRefresh` when callers overlap (`src/client/src/controllers/workspaceController.ts:117`, `src/client/src/controllers/trailingRefreshCoordinator.ts:15`). Therefore intent must be stored with dirty work, not captured only by the latest callback.

Maintain pending intent **per cwd** in the existing scope: foreground dominates background until the foreground dirty entry is claimed by a pass. The 50-ms coalescing window and existing `TrailingRefreshCoordinator` remain. A pass atomically captures and removes its dirty cwd/intent entries before fetching. New invalidations during the pass create entries for its trailing pass; background callers never downgrade a pending foreground entry.

If foreground work arrives while the same cwd is already running as background, schedule a full-budget foreground trailing read. Its caller's promise must not be satisfied solely by the background response or bow-out. There is no need to promote the running timer or cancel accepted mutations. Background invalidations that arrive afterward cannot replace that promised foreground read with another timed background pass. If a foreground read is already running, it keeps its full budget; unrelated trailing background work may still use 20 seconds. Preserve dirty work deferred behind an initial foreground selection (`workspaceController.ts:140`); do not clear its intent merely because loading prevented a pass.

Use the same priority rule for remote memory/learned-skills serialized reads: manual foreground refresh during a background read must get a full-budget foreground read, rather than returning only the background promise. Queue it after the running read settles; subsequent polls may share the queued foreground work and cannot downgrade it. Existing scope/generation invalidation and poll cadence remain. Their current same-scope request sharing is at `src/client/src/controllers/memoryController.ts:107` and `src/client/src/controllers/learnedSkillsController.ts:107`.

For remote Git reads, retain the existing request-id guards and give each background pass its own cancellation controller. Before a foreground status/diff read starts, cancel only an active background pass in that same scope and invalidate its continuation; the foreground read has no bow-out timer. While a foreground status/diff read is pending, skip polling ticks for that scope, so a poll cannot supersede its publication. Other polling ticks keep the existing cadence. Do not add a Git request queue or shared request broker, and preserve the existing local-machine behavior. These coordination changes only preserve budget intent; they introduce no cross-scope cache or general request coalescing.

## App state and controller publication

Add these exact exported types to `src/client/src/appState.ts` and optional properties to `AppState`:

```ts
export interface SessionListLoadScope {
  machineId: string;
  projectId: string;
  workspaceId: string;
  workspacePath: string;
}
export interface SessionListLoad {
  owner: "selection" | "catalog-fallback" | "retry";
  scope: SessionListLoadScope;
  startedAt: number;
  budgetMs: number;
  phase: "waiting" | "receiving";
}
export interface SessionListFailure {
  scope: {
    machineId: string;
    machineName: string;
    projectId: string;
    workspaceId: string;
  };
  kind: "timeout" | "transfer";
  elapsedMs: number;
  budgetMs: number;
}
// AppState additions:
// sessionListLoad?: SessionListLoad;
// sessionListFailure?: SessionListFailure;
```

The two records are initially undefined and are included in workspace-scope reset (`src/client/src/appState.ts:150`, `:177`). `WorkspaceController` is their sole asynchronous owner. Add `now?: () => number` to its existing dependency interface, defaulting to `Date.now`, and use it for start and terminal elapsed values. Retain a private request identity/token and captured machine name/workspace path; do not expose a new global in-flight registry.

For a remote selected-workspace session-list read, capture its scope, effective budget, name, and clock immediately before its network boundary. Publish load with `phase: "waiting"`, clearing an owned prior failure. Catalog fallback uses its declared owner but never human-visible notice/failure. Sibling/discovered-workspace hydration and ordinary invalidation refreshes do not replace this selected-workspace load record. Local reads do not publish either record.

Every publication, phase callback, success, catch, and finally cleanup checks all applicable guards:

1. Controller is live; captured machine, project ID/path, workspace ID/path still match the current selection.
2. The captured request/generation equals the current selected-workspace request (`isCurrentWorkspaceSessionRequest`/`isWorkspaceSelectionTargetCurrent`), and any catalog topology token/fallback guard remains current. Retain the existing additional hydration revision and topology-order checks on those paths (`src/client/src/controllers/workspaceController.ts:263`, `:584`).
3. The load being changed/cleared is the exact operation token owned by this continuation, not merely another load with the same scope. A new retry in the same workspace invalidates old callbacks just as a workspace switch does.
4. The operation's signal is not aborted when publishing a result. A superseded operation may dispose its own resources, but must not clear a newer load, failure, loading flag, or error.

On guarded successful headers, publish `receiving` through `onResponse`. On guarded success, apply rows and clear this operation's load/failure. On selection/machine change, clear records as part of the new scope reset and abort the superseded read. Dispose clears owned resources. A budget edit mid-flight does not change the captured load budget or its notice.

On a human remote load's terminal error, classify in this order:

| Error | Publication |
| --- | --- |
| `isLoadCancellation(error)` or an aborted supersession scope | Silent, no failure and no `state.error`; guarded owned loading cleanup only |
| `HttpRequestError` with `status === 504` | Failure `kind: "timeout"`; clear owned load; no write to `state.error` |
| `HttpResponseBodyError` on a successful begun response | Failure `kind: "transfer"`; clear owned load; no write to `state.error` |
| Any other error, including pre-response fetch rejection, HTTP 502/404/400, invalid JSON, or session schema failure | Existing `state.error` path; clear owned load; no typed timeout/transfer failure |

`elapsedMs = Math.max(0, now() - startedAt)` is captured at failure. A transfer is never relabeled timeout because elapsed exceeds the old budget. Catalog fallback and background failures retain their existing genuine-error paths; they do not get a human typed failure. Local failures keep their existing banner behavior. Clearing an owned typed failure does not clear an unrelated `state.error`; neither retry nor the notice hides the existing banner.

Extend `PiWebUiApp.shouldShowSessionStartScreen` with `state.sessionListFailure === undefined`. Preserve its other conditions (`src/client/src/components/PiWebUiApp.ts:2954`). A failed session-list read must not claim an empty workspace is ready to start a session.

## Session-list UI and Retry

Add and export `SessionListLoadNotice` (`session-list-load-notice`) from `SessionListLoadNotice.ts`. Its public properties are `machine?: Machine`, `load?: SessionListLoad`, `failure?: SessionListFailure`, `onRetry?: () => void | Promise<void>`, `onRaiseLimit?: () => void`, and injectable `now: () => number` defaulting to `Date.now`. It owns only its rendering clock; it does not fetch, select sessions, or own the request budget.

Wire `sessionListLoad`, `sessionListFailure`, `onRetrySessionList`, and `onRaiseSessionListLimit` from `PiWebUiApp` through `AppNavigationPanel` into `SessionList`, which renders this notice inside its session-list section below the heading. This is the section composed by the navigation panel (`src/client/src/components/appShell/AppNavigationPanel.ts:196`, `src/client/src/components/SessionList.ts:201`). The record must render even when a session is open in the main pane; do not put it only in `sessionEmptyMessage` or the start screen. Keep ordinary row rendering, search, collapsed-list behavior, keyboard navigation, and the approved shape A; add no skeleton rows or stale-list display branch.

A record is displayable only if its scope matches the current selected remote machine/project/workspace; the host validates path/private retry identity as well. Only load owners `selection` and `retry` are human-visible. A mismatch, local machine, or catalog fallback produces no notice. Failure and load are mutually exclusive in controller state; failure wins defensively if both are supplied.

Format milliseconds as `floor(max(0, ms) / 1000)` whole seconds, then unpadded minutes and two-digit seconds (`0:05`, `2:00`, `3:00`). Elapsed is not clamped to the budget. Use escaped text interpolation for machine names.

| Displayable state | Exact text and actions |
| --- | --- |
| Waiting, elapsed < 5,000 ms | No notice |
| Waiting, elapsed >= 5,000 ms | `Loading sessions from ${machine.name}… ${elapsed} of ${budget}` |
| Receiving, regardless of elapsed | `Receiving sessions from ${machine.name}…`; no elapsed-of-budget countdown |
| Timeout failure | `${failure.scope.machineName} didn't answer within ${budget}`; secondary `Waited ${elapsed}.`; **Try again**, **Raise limit** |
| Transfer failure | `${failure.scope.machineName} stopped responding while sending sessions`; secondary `Waited ${elapsed}.`; **Try again**, **Raise limit** |
| Success, cancellation, scope change, or no record | No notice/failure; existing list behavior |

Use a status region for waiting/receiving and an alert for failure. Only a connected, human remote in-flight load owns a 1,000-ms UI interval. Compute elapsed from the captured timestamp rather than incrementing a counter. Re-render immediately on phase changes; receiving before five seconds is visible immediately. Stop the interval on completion, failure, scope change, invisible owner/local scope, and disconnect. The interval may continue through receiving to preserve the single in-flight clock lifecycle, but renders no countdown there. There is no timer while only a failure is shown.

### `retrySessionList()`

Add `WorkspaceController.retrySessionList(): Promise<void>`. The app action uses the failure's captured scope and its private originating token/path to reject a stale click. It starts only when that failed remote machine/project/workspace still exists and is selected; a second click while its retry is running shares that retry, rather than creating another read.

Clear only the owned failure, create a fresh same-scope operation identity and cancellation scope, publish owner `retry` with a newly captured clock/budget, and read **only** `api.sessions(currentWorkspace.path, machineId, signal, onResponse)`. Foreground supersession cancels the retry. Do not call `selectProject`, `selectWorkspace`, `refreshProjectSessions`, or topology/statistics loaders, and do not change the URL or remembered selection.

Apply the successful list through a list-only mode of `SessionController.applyRefreshedSessionLists`: add an optional third argument `{ preserveSelection?: boolean }`, defaulting to its current behavior. Retry passes `{ preserveSelection: true }`. Reuse its authoritative-list/pending-start/cache reconciliation, but do not invoke `selectSession`, `deselectSession`, `clearActiveSession`, or rejoin/detach a stream in this mode. Preserve the selected session ID/object and active connection even if the refreshed list lacks that session or changes its archived flag. Updating row metadata must not select a preferred/replacement session. Preserve drafts, queued sends, attachment state, cached pending starts, transcript state, and scroll state. A later explicit selection or existing mutation reconciliation retains its normal behavior.

Retry may own the selected list's loading flag and use the existing loading treatment, but must not add a stale-list or placeholder rendering branch. It publishes its own terminal failure under the same rules even when a session is open. Do not reuse the existing full refreshed-list path without the preserve-selection argument: it has selection side effects (`src/client/src/controllers/sessionController.ts:1174`).

**Raise limit** validates the same failure scope and opens the shared edit dialog for its machine with the patience input focused. It does not automatically retry or change the budget of an existing load. Saving and then clicking **Try again** captures the new budget.

## Machine dialog and both menus

Extend `MachineDialogSubmit` with required `requestTimeoutMs: number`. Add public `machine?: Machine` (absent means create), and `focusRequestTimeout: boolean` (default false). On a new open/edit identity, initialize name/base URL from the machine and timeout seconds from `effectiveMachineRequestTimeoutMs(machine) / 1000`; create mode defaults to `120`. Do not reseed on ordinary error/property rerenders, since that would erase rejected input. Local machines never get edit or patience controls.

The field label is **Request timeout (seconds)** with `type="number"`, `min="5"`, `max="180"`, and `step="0.001"`. Parse the trimmed input as decimal whole seconds with an optional decimal point and one to three fractional digits: `^\d+(?:\.\d{1,3})?$`. Convert by multiplying the whole-seconds integer by 1,000 and adding the fractional digits right-padded to three places, then use the shared validator. This accepts `5.001` without a floating-point multiplication error. Reject empty input, signs, exponent notation, and greater precision rather than rounding them into range. Show the field hint `Default 120 seconds; allowed range 5–180 seconds.` The dialog defaults to name/base URL focus as before unless `focusRequestTimeout` is true, in which case focus the timeout input after the edit render. Use DOM focus, not template-handler extraction, to test this.

In create mode keep **Add machine** / **Adding…**; edit mode uses **Edit machine**, **Save changes** / **Saving…**. The create submission includes entered name/base URL, the integer timeout, and token if entered. Edit sends these entered fields and the timeout through `machinesApi.updateMachine`; an unchanged/blank token input is omitted to preserve the existing secret. A user-entered replacement token is sent. Do not prefill a public machine's secret, send hidden headers, or implement secret clearing as part of this change. Preserve the existing URL/name validation, URL-based name suggestion in create mode, form/Enter submission, Escape cancellation, and submitting guard (`src/client/src/components/MachineDialog.ts:1`).

`MachineController` gains `updateMachine(machineId, patch): Promise<Machine>` using the API adapter and replacing that public machine in state; keep a selected machine selected without resetting workspace/session state. The app owns create/edit target identity and generation, uses one submit callback to choose add/update, and closes only on success belonging to the current dialog generation. Editing an unselected machine does not select it. Saving must not run the machine-selection reset. A rejected HTTP update leaves the dialog open with entered fields intact and shows the server message in its existing `error` property. In particular, show the exact timeout validation error, without converting it to a generic app banner. Do not clear a newer dialog on an older submit's completion.

Add `onEdit?: (machine: Machine) => void | Promise<void>` to **both** `MachineList` and `MachineSwitcher`, forwarded by `AppNavigationPanel.onEditMachine` to one app-owned edit callback. Add **Edit** to each remote machine's existing actions menu alongside Remove. The action is available when editing is wired even if removing is not; do not gate all actions solely on `onRemove`. Close the menu, stop row selection propagation, and pass the actual machine. Their separate current menus/properties are at `src/client/src/components/MachineList.ts:20`, `:97`, and `src/client/src/components/MachineSwitcher.ts:17`, `:90`. Raise limit uses this same edit callback with the focus flag. The local machine has neither action.

## Status-to-outcome contract

| Upstream/browser outcome | Gateway/result | Human remote session-list display | Other reporting |
| --- | --- | --- | --- |
| Headers and valid list complete within budget | Upstream status and rows | Waiting notice if applicable, receiving, then rows | No error |
| Successful headers arrive before deadline; first body chunk is delayed past it | Headers eagerly flushed; deadline cleared | Receiving before the first chunk and for the remaining transfer | No timeout or body timer |
| No upstream headers before gateway deadline | Existing 504 error shape | Timeout failure, captured machine/budget/elapsed, both actions | Do not write `state.error` for this human list read |
| Successful body begins, then transport fails | Destroy response after headers; browser body-read error | Transfer failure, elapsed and both actions | Do not write `state.error` for this human list read |
| Body stalls indefinitely after successful headers | No transfer deadline | Receiving until completion, cancellation, or transport failure | No automatic retry |
| Remote DNS/refusal/unreachable before headers | Existing 502 mapping | Existing banner | `state.error` as before |
| Machine lookup returns missing | 404 `Machine not found` | Existing banner | No typed timeout/transfer failure |
| Upstream non-504 HTTP error | Preserve upstream status/body handling | Existing banner | Existing HTTP error path |
| Response completes but JSON/schema is invalid | Ordinary parse failure | Existing banner | Not transfer and not timeout |
| Remote background helper reaches 20 seconds, before or after headers | Browser cancellation; current gateways stop transport/buffering | No new notice/error | No background-error callback; eligible next normal tick |
| Selection supersedes read or browser disconnects | Abort the read's own transport | No stale publication | No synthetic 502/504 or effect on accepted mutations |
| Invalid machine timeout add/update | 400, exact validation message; no persistence | Dialog retains input and displays message | Existing machine record unchanged |
| Local list error or load | Existing local transport/result | Existing local UI/banner | No timeout setting, records, or 20-second helper |
| Unrelated error after a typed timeout | Ordinary error remains independent | Typed failure may remain until retry/scope reset | Banner displays the unrelated error normally |

HTTP 504 classification is based on `HttpRequestError.status`, not its text or a guessed timer firing in the browser. An older gateway or deployment proxy can return it earlier than the new nominal budget; keep the actual elapsed value and document that limitation.

## Compatibility and operational behavior

| Combination | Required behavior |
| --- | --- |
| Existing registry without `requestTimeoutMs` | Reads without migration; absent field remains absent after unrelated update; current gateway resolves 120,000 ms |
| New browser with old gateway | Optional parse accepts absent field and displays the nominal 120-second default. Old gateway may ignore the outbound setting and continue using its old 30-second budget. Use the returned machine unchanged, with no optimistic timeout field or assertion that the setting was honored. Timeout/elapsed display and Retry still work; lowering the displayed nominal budget requires an upgraded gateway that stores/returns it. |
| Old browser with current gateway | Its add/PATCH omits the setting and does not clear it. Current gateway applies stored/default budget independently; no new required request fields or capability handshake. Old browser retains its existing generic error UI. |
| Current originating gateway with old receiving gateway | Originating gateway enforces its new machine budget and can abort its own outward fetch. Old far-side buffering/daemon work may continue; cancellation is not promised across that hop. |
| Nested federation through an old intermediary | Each outward gateway owns its own registry/budget; an intermediary's old 30-second deadline can end the request before the originating machine budget. |
| Reverse proxy with shorter timeout | Its cutoff may win; raising PI WEBUI patience cannot extend that proxy's timeout. Actual elapsed may be shorter than nominal budget. |

The timeout is managed state for a remote record on the gateway being used. It is not a new core project/global config key and is not written into `<project>/.pi-webui/config.json`. Updating it takes effect on subsequent requests; it neither restarts a session nor changes model/provider HTTP budgets. No session daemon enumeration implementation or protocol changes are required. UI/API autoreload/restart loads the new gateway code; this implementation does not require a manual restart of `pi-webui-sessiond.service` unless implementation scope separately expands into daemon-loaded code.

## Test fixtures and named acceptance cases

Use Vitest, fake timers, injected clocks/fetch/clients, and `app.inject`. **No test may open a real network connection**, including loopback listeners or real Unix sockets. Temp registry files must live in test-owned temporary directories. Restore globals, finish/destroy deferred streams, settle promises, and clear owned listeners/timers after each test. Follow `.agents/skills/testing-guide/SKILL.md`; DOM interactions cover focus and menus, and controller tests cover orchestration.

Use one explicit machine fixture: id `remote-lab`, name `Remote Lab`, base URL `https://remote.example.test/base`, created/updated timestamps `2026-11-01T00:00:00.000Z`. Test absence, 5,000, 90,000, 120,000, and 180,000 ms as specified. Use project `project-1`, workspace `workspace-1`, path `/repo`, a second workspace `/repo-two`, and a selected persisted session `session-1`. Start the injected clock at `1_000_000`.

A controlled fetch fixture exposes its captured signal, a deferred header resolution, and a `ReadableStream` whose **first enqueue**, completion, and error are separately controlled. It must honor abort both before and after headers. Merely delaying the final body chunk does not exercise eager headers. A Fastify raw-response observer records `pipe`, `flushHeaders`, headers/status at flush, and finish/close listener cleanup. For injection tests, observe `flushHeaders` via the test reply's raw response before releasing the deferred body; do not wait for `app.inject`'s fully buffered result to infer header timing.

The following quoted strings are required test names, grouped by their owning existing or new test file. Each case asserts observable status, state, calls, cancellation, bytes, or rendered UI rather than only the presence of a helper call.

### Shared validation, store, and service

| File | Test name | Required assertion |
| --- | --- | --- |
| New `src/shared/machineRequestTimeout.test.ts` | `accepts inclusive machine timeout bounds without coercion` | Boundaries accepted; strings, null, booleans, fractions, nonfinite numbers, and out-of-range values rejected with exact message |
| Same | `resolves an absent machine timeout without materializing it` | Effective value 120,000; input object remains field-absent |
| New `src/server/machines/machineStore.test.ts` | `round trips an optional requestTimeoutMs without migrating old records` | Old file and unrelated update preserve absence; valid add/update survive reopening; other records/secrets intact |
| Same | `rejects a malformed stored requestTimeoutMs` | Invalid present registry value fails; no silent default rewrite |
| `src/server/machines/machineService.test.ts` | `validates requestTimeoutMs before add or update writes` | Both boundaries, invalid matrix, no write/cache/timestamp changes, omission preserves value |
| Same | `projects requestTimeoutMs publicly without exposing secrets` | List/get/add/update include only supplied field; local omits it |
| Same | `keeps health and runtime probes at three seconds` | Both probe calls get 3,000 despite machine value 180,000 |
| `src/server/machines/machineProxyRoutes.test.ts` | `returns the same timeout validation error from machine POST and PATCH` | 400 exact message for both; stored machine unchanged |

### Remote client and streaming proxy

| File | Test name | Required assertion |
| --- | --- | --- |
| `src/server/machines/machineClient.test.ts` | `resolves call override then machine timeout then 120 second default` | Controlled no-header fetch survives until each exact deadline; explicit 300,000 is not clamped |
| Same | `clears its deadline at headers while preserving caller body cancellation` | Resolve headers, keep first body chunk blocked, advance beyond budget: signal live; abort caller: body stops |
| Same | `distinguishes caller abort from its own header deadline` | Pre-abort prevents fetch; caller abort is cancellation; own timer yields 504; ordinary rejection yields 502; first abort wins |
| Same | `keeps requestJson caller cancellation until body completion` | Headers stop timer, caller still interrupts text buffering; success/error releases listener |
| Same | `cleans up no body and failed body adapters` | No timer/listener leak on null body, adapter construction failure, and stream failure |
| `src/server/machines/machineProxyRoutes.test.ts` | `preserves meaningful route overrides and removes the workspace move override` | Stored 90,000 reaches ordinary/move behavior; every listed 5-minute route keeps 300,000; mutations have no lifecycle signal |
| Same | `cancels an unfinished remote read when the downstream reply closes` | GET signal aborts pre-headers and mid-body; normal request-receive close does not cancel response |
| Same | `cleans disconnect listeners for replies that never stream` | Missing machine, rejected fetch, empty body, and buffered config finish/close leave no owned listeners; normal finish never aborts |
| Same | `cancels config GET buffering without cancelling config PUT` | GET signal reaches `requestJson`; PUT signal undefined; config projection and sessiond fields preserved |
| `src/server/app.plugins.test.ts` | `cancels a disconnected manifest read while keeping its own budget` | The manifest GET receives a reply-owned signal; the 10-second budget still applies instead of the machine budget; a disconnected read aborts without writing a gateway error |
| Same | `flushes upstream headers before the first body chunk` | Deferred source has emitted zero chunks when flush occurs; status/safe headers visible at flush; no duplicate body read |
| Same | `destroys a streamed reply on upstream error after header flush` | Flush then source error closes/destroys response; no second status or JSON error write |
| Same | `removes the flush listener when the streamed send throws before piping` | A `reply.send` failure raised before the raw `pipe` event leaves no armed flush listener and produces the ordinary gateway error |
| `src/server/app.compression.test.ts` | `flushes delayed remote headers after compression negotiation` | Use real registered compression hook, injected remote stream; before first source chunk, raw flushed headers have correct encoding/Vary and no stale length; released body decodes correctly |
| Same | `preserves identity negotiation with an eagerly flushed stream` | Identity response has no spurious content encoding; safe/security headers retained |

Keep existing binary body, header filtering, remote compression request, config round-trip, and compression negotiation coverage intact (`src/server/machines/machineClient.test.ts:1`, `src/server/machines/machineProxyRoutes.test.ts:1`, `src/server/app.compression.test.ts:1`).

### Cancellation chain and daemon boundary

| File | Test name | Required assertion |
| --- | --- | --- |
| New `src/server/http/replyDisconnect.test.ts` | `owns reply finish and close listeners until response completion` | Event-emitter raw reply: finish cleans without abort, premature close aborts once, already closed/finished states handled, double dispose safe |
| `src/server/sessiond/sessionProxyRoutes.test.ts` | `forwards disconnect cancellation only to the remote session list read` | `/api/sessions?cwd=%2Frepo` gets fourth signal; premature reply close aborts it; local prefix, missing cwd, probes, generic routes, and mutations get undefined |
| Same | `does not turn a cancelled list transport into a daemon error response` | No `requestFailed` write to a destroyed reply; no continued gateway buffering; cleanup after daemon failure/empty body |
| Same | `cancelling a list does not cancel an accepted notification mutation` | Concurrent separately controlled list and dismissal; list aborts, mutation signal stays undefined and it completes |
| `src/sessiond/sessionDaemonClient.test.ts` | `aborts HTTP and Unix daemon transports while leaving enumeration independent` | Stub global fetch and `http.request`, never open sockets; pre-header/mid-body abort rejects and stops buffering/listeners; independent enumeration promise can still settle |
| `src/server/machines/machineProxyRoutes.test.ts` | `propagates browser bow out through both gateways to the daemon transport` | Compose injected fetch/stream and reply-close events with the real proxy/client boundaries; assert both distinct gateway signals and daemon argument four abort; no error response after close; separate mutation completes |

The chain fixture must exercise propagation, not manually abort each hop's controller. Bridge one hop's fetch abort to the receiving reply-close event, as the transport would; expose the daemon signal as the final observation. No real server listener is necessary. Preserve the two existing unsignalled-request regression tests verbatim in intent.

### Browser adapters and background helper

| File | Test name | Required assertion |
| --- | --- | --- |
| `src/client/src/api/parsers.test.ts` | `parses optional machine patience additively and rejects malformed presence` | Absent, valid bounds, invalid values including explicit undefined, and unknown extra key |
| `src/client/src/api/clients.test.ts` | `patches a machine through an encoded application relative path` | Nested base `/tools/pi/`, machine ID containing slash/space, PATCH exact JSON, parsed returned machine, no optimistic field |
| Same | `forwards read signals and session response start without applying global deadlines` | New final arguments reach fetch; normal foreground adapters install no timer; old optional-argument calls remain valid |
| `src/client/src/api/http.test.ts` | `reports response start before reading a delayed first body chunk` | Callback once after fetch, before enqueue/read completion; parser still waits; non-ok response does not imply controller receiving |
| Same | `separates successful body transport failure from JSON and schema failure` | Only text-read rejection gets typed body error; cancellation preserved; invalid JSON/parser exceptions ordinary |
| New `src/client/src/controllers/backgroundRead.test.ts` | `normalizes a native timeout source to LoadCancelledError` | Controlled native-timeout source fires at 20,000; read signal/rejection is marker, classifier true, never native TimeoutError |
| Same | `bows out with the same marker when AbortSignal timeout is unavailable` | Fake-clock fallback survives 19,999, aborts at 20,000; timer disposed on early success/error |
| Same | `combines supersession with or without AbortSignal any` | Independently stub each feature combination; first reason wins, pre-abort skips read, no residual listeners |
| Same | `leaves local and foreground reads untimed` | Local helper preserves original signal; foreground call sites never invoke it; advancing clock does not abort |
| Same | `does not disguise a genuine read failure as cancellation` | Rejection before deadline preserved; resources removed after synchronous throw and async failure |

### Controllers, provenance, and overlap

| File | Test name | Required assertion |
| --- | --- | --- |
| `src/client/src/controllers/workspaceController.test.ts` | `publishes captured remote selection and receiving provenance` | Exact scope/start/budget/owner, header callback transition before body, success cleanup; local has no records |
| Same | `keeps catalog fallback silent while bounding its remote read` | Fallback owner hidden, 20-second cancel has no error/failure; genuine failure preserves existing handling |
| Same | `publishes timeout and transfer failures without writing state error` | 504 and successful-body error produce distinct typed records with exact elapsed; ordinary 502/404/invalid payload still banner |
| Same | `retries only the current list without selecting or detaching a session` | Selected session survives missing/archived-changed row; one list read, no topology/sibling/selection/socket/draft/URL effects; fresh captured budget |
| `src/client/src/controllers/workspaceController.cancellation.test.ts` | `a superseded load cannot advance or clear a newer load in the same scope` | Deferred original header/success/error/finally after new retry produce no stale publication; workspace/machine switch also guarded |
| `src/client/src/controllers/workspaceController.test.ts` | `foreground mutation refresh survives later background invalidations in the queue` | Both same-task and running-background overlap; a later background callback cannot replace pending foreground intent; full-budget read actually runs after 20 seconds |
| Same | `preserves per cwd intent and deferred dirty work behind selection` | Mixed cwds use correct budgets; foreground loading deferral does not lose requests/intent; final foreground promise awaits its foreground read |
| Same | `keeps cancelled discovery hydration eligible for a later snapshot` | No hydration mark on cancel; later normal pass succeeds; real error still reported |
| `src/client/src/controllers/sessionController.refresh.test.ts` | `preserveSelection list application reconciles rows without session lifecycle effects` | New optional mode preserves exact selection even if missing/archived flag changes; normal default retains existing behavior |
| Same | `post mutation reconciliation uses foreground intent even when fire and forget` | Wired and direct fallback full-budget; revalidate remains nonblocking; cleanup/reorder/start reconciliation not cancelled at 20 seconds |
| `src/client/src/controllers/projectCatalogController.test.ts` | `catalog bow out is silent and the next scheduled pass can succeed` | Real signal aborted; current single-flight/topology order preserved; genuine failure callback still fires |
| `src/client/src/controllers/projectActivityOwnershipCoordinator.test.ts` | `cancelled ownership discovery remains eligible without reporting an error` | No permanent attempted-activation mark from bow-out; next reconciliation retries; genuine failure still reported |
| `src/client/src/controllers/gitController.test.ts` | `bounds polling status and consequential diffs without shortening manual refresh` | Whole background pass has one 20-second scope; manual/toolbar diff survives; overlap cannot cancel foreground; real reporting behavior retained |
| `src/client/src/controllers/memoryController.test.ts` | `only polling snapshots bow out and a manual refresh retains foreground priority` | Initial/manual loads full-budget, scheduled poll silent at 20 seconds, overlapping manual gets full-budget trailing read, real failure preserves stale/error state |
| `src/client/src/controllers/learnedSkillsController.test.ts` | `only polling skill snapshots bow out and a manual refresh retains foreground priority` | Same obligations as memory, including both feature-fallback paths through shared helper tests |

### Components and app wiring

| File | Test name | Required assertion |
| --- | --- | --- |
| New `src/client/src/components/SessionListLoadNotice.test.ts` | `shows a human remote wait at five seconds and updates once per second` | No notice at 4,999; exact text at 5,000 with captured budget; no local/fallback/mismatched notice |
| Same | `shows receiving before any body byte without a budget countdown` | Immediate phase change before five seconds; survives clock beyond budget; no active clock after failure/success/disconnect |
| Same | `renders both typed failures with elapsed and the two scoped actions` | Exact wording/actions; no interval in failure-only state; escaped machine name |
| `src/client/src/components/SessionList.test.ts` | `renders remote load feedback inside the navigation session section` | Notice belongs to section and existing rows/actions are unaffected; no main-pane-only dependency |
| `src/client/src/components/MachineDialog.test.ts` | `edits patience in seconds and retains rejected input` | Initial values, inclusive bounds/millisecond precision, edit labels, token omission, exact server error, no reseed, DOM focus for Raise limit |
| `src/client/src/components/MachineList.test.ts` | `edits the menu machine without selecting it` | Remote Edit callback works independently of Remove; local omitted; row selection not invoked |
| `src/client/src/components/MachineSwitcher.test.ts` | `edits from the switcher actions menu through the shared callback` | Desktop path and local exclusion; menu closes, correct machine, no selection |
| New `src/client/src/components/PiWebUiApp.remoteTimeout.test.ts` | `shows retry failure with a session open and keeps the start screen hidden` | Actual navigation wiring receives record/actions; selected session main pane does not hide failure; start predicate requires no failure |
| Same | `an unrelated error after a timeout still appears in the banner` | Publish typed timeout, then unrelated state error; banner visible and unchanged by notice/Retry; no blanket suppression |
| Same | `routes Raise limit and both Edit actions to the same guarded dialog` | Correct machine and focus flag; failed submit stays open; stale submit cannot close newer dialog; success does not reset selection |
| Same | `keeps statistics deletion refresh and explicit snapshot refresh untimed` | Foreground call-site wiring retains full budget, realtime invalidations explicitly background, no blanket adapter timer |

## Implementation deliverables and acceptance

Update `docs/machines.html` with slow-link patience, default/range, both edit entry points, Retry/Raise limit, and limits imposed by reverse proxies, older gateways, nested federation, unbounded body transfer, and uncancellable daemon enumeration. Clearly state that older gateways can ignore the setting and continue their current default budget. Keep the README a landing page. `docs/config.md`/`docs/config.html` currently identify the registry/storage override rather than enumerate machine fields (`docs/config.md:173`, `docs/config.html:536`); if a setting reference is added, keep both representations synchronized with scope **gateway-owned remote record**, absence **120,000 ms**, precedence **probes/operation overrides before machine default**, and refresh **next request; no session restart**. Do not present the managed registry as a user-editable core config API.

The implemented behavior requires one `.changeset/*.md` fragment with a `minor` bump for `@hyperdreamer/pi-webui`, describing configurable remote request patience, session-list feedback/Retry, machine editing, and bounded background reads. It adds a setting and edit capability. Do not manually edit `CHANGELOG.md`, bump package versions, publish, or create that fragment during this specification-only task.

After implementation, run the named focused test files by layer, then type checking and the approved final validation:

```sh
npm test -- --run src/shared/machineRequestTimeout.test.ts src/server/machines/machineStore.test.ts src/server/machines/machineService.test.ts src/server/machines/machineClient.test.ts
npm test -- --run src/server/http/replyDisconnect.test.ts src/server/machines/machineProxyRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/sessiond/sessionDaemonClient.test.ts src/server/app.compression.test.ts
npm test -- --run src/client/src/api/http.test.ts src/client/src/api/clients.test.ts src/client/src/api/parsers.test.ts src/client/src/controllers/backgroundRead.test.ts
npm test -- --run src/client/src/controllers/workspaceController.test.ts src/client/src/controllers/workspaceController.cancellation.test.ts src/client/src/controllers/sessionController.refresh.test.ts src/client/src/controllers/projectCatalogController.test.ts src/client/src/controllers/projectActivityOwnershipCoordinator.test.ts src/client/src/controllers/gitController.test.ts src/client/src/controllers/memoryController.test.ts src/client/src/controllers/learnedSkillsController.test.ts
npm test -- --run src/client/src/components/SessionListLoadNotice.test.ts src/client/src/components/SessionList.test.ts src/client/src/components/MachineDialog.test.ts src/client/src/components/MachineList.test.ts src/client/src/components/MachineSwitcher.test.ts src/client/src/components/PiWebUiApp.remoteTimeout.test.ts
npm run typecheck
npm run verify
```

These commands are future implementation acceptance checks. Completion evidence must include delayed **first** body chunk/header flush under compression, the full cancellation chain with a separate accepted mutation, foreground queue precedence, same-scope supersession, list-only Retry, and the unrelated-error-after-timeout case. Passing body-completion tests alone is insufficient. Do not run full verification merely to draft this document.

## Non-goals

Automatic retries/backoff; stale-list rendering; pagination or streaming daemon session enumeration; circuit breakers or a general request broker; new route-specific patience settings; payload reshaping/compression changes; changes to liveness probes, model HTTP budgets, WebSockets, daemon enumeration, or mutation semantics; local-machine behavior changes; and deployment/release actions.

## Specification decisions

- Keep optional timeout absence in storage and public responses; use explicit `120000` to reset, and apply saved budgets only to subsequent requests.
- Preserve the separate plugin-manifest 10-second override outside the federated route table.
- Use reply finish/unfinished-close ownership for cancellable machine GETs; opt the receiving daemon hop into only `/api/sessions` GET with nonempty `cwd`, preserving local/generic/mutation signals as undefined.
- Flush streaming headers from a one-shot raw-response `pipe` listener after compression preparation, and destroy the response on any post-header stream failure.
- Expose response start as the optional fourth `request`/`sessions` callback and type successful body-read failures separately from HTTP, JSON, and schema errors.
- Carry explicit read intent through shared methods; per-cwd foreground priority survives coalescing and gets a full-budget trailing read when background work is already running.
- Treat post-mutation, statistics, deletion-resolution, initial snapshot, and manual refresh reads as foreground; only the table's background branches receive 20-second bow-out.
- Make Retry list-only through an opt-in preserve-selection application mode, including when the selected session disappears or its archive state changes.
- Display elapsed as whole-minute/second durations and add `Waited ${elapsed}.` to both failures without hiding unrelated banners.
- Keep millisecond precision through decimal seconds parsing and a field with step `0.001`; preserve an existing token when edit submits no replacement.
- Give `LoadCancelledError` an optional message while preserving its no-argument behavior; translate every background deadline to that existing marker.
- Preserve foreground Git reads by cancelling superseded background passes and skipping overlapping remote polling ticks, without introducing a request queue.
- Accept old gateways' absent field without optimistic persistence; document that they can ignore patience and retain their current 30-second deadline.
- Deliver the implementation with one minor Changeset and canonical machine documentation; this drafting task writes neither.
