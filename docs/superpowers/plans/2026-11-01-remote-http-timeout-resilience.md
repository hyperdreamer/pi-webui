# Remote HTTP Timeout Resilience Implementation Plan

**Goal:** Add configurable remote header-wait budgets, disconnect-aware streaming and daemon cancellation, explicit foreground/background read intent, typed session-list progress and failures, list-only retry, and machine editing without changing local-machine behavior or daemon enumeration.

**Architecture:** Keep timeout validation and machine-record shape in shared code, preserve optional storage absence, and resolve the effective gateway deadline at the `RemoteMachineClient` boundary. Give cancellable GETs reply-owned signals through both gateway hops, flush compression-adjusted stream headers from the raw `pipe` event, and classify only header deadlines as timeout failures. Carry an explicit read intent through the existing controller queues, use a bounded browser helper only for enumerated background reads, and let `WorkspaceController` own selected-list provenance and typed outcomes. The UI renders that state through the navigation session section and uses the same guarded machine dialog for editing and raising a limit.

**Tech Stack:** TypeScript, Fastify, Vitest, Lit, browser `AbortController`/`AbortSignal`, Node readable streams, `@fastify/compress`, JSONL machine persistence, and Changesets. No new runtime dependency.

## Global Constraints

- Node 22.19 is the version floor; do not use APIs newer than that.
- No new runtime dependencies.
- The remote request timeout default is **120 000 ms** and the accepted machine-setting bounds are **5 000–180 000 ms**. Do not coerce, round, clamp, or materialize an absent value.
- Remote background reads bow out after **20 000 ms**; the helper covers fetch and body consumption and reports cancellation rather than a native timeout error.
- The session-list notice delay is **5 s** and its rendering tick is **1 s**.
- Health and runtime probe calls retain their separate **3 s** budgets regardless of the stored machine value.
- The plugin-manifest route retains its separate **10 s** budget regardless of the stored machine value.
- Format elapsed milliseconds as `floor(max(0, ms) / 1000)` whole seconds, with unpadded minutes and two-digit seconds: the **`m:ss` format rule** (`0:05`, `2:00`, `3:00`).
- Keep the local machine free of the new timeout setting, notice/failure records, and 20-second browser helper.
- Keep all application-owned browser paths application-relative, encode dynamic path segments, and resolve each path exactly once at the browser boundary.
- Keep existing operation-specific 300 000 ms route overrides, except remove the workspace-task move override; omitted route overrides must allow the stored machine/default budget to resolve.
- Keep body transfer unbounded after successful upstream headers; there is no replacement body timer.
- Use the existing `LoadCancelledError`/`isLoadCancellation` cancellation classifier and preserve accepted mutation semantics, daemon enumeration behavior, sessiond protocol, WebSocket lifetimes, probe caches, and unrelated error reporting.
- Tests use injected fetches, clocks, streams, `app.inject`, fake timers, and temporary registry files only. No test opens a real network connection, loopback listener, or real Unix socket. Every deferred stream, listener, timer, global, and DOM fixture is restored or settled.
- Every task is test-first. A task's first implementation steps add real failing tests, run them red, then add the smallest implementation and run the focused tests green.

## Task 1: Establish Shared Timeout Contracts

**Implementer tier:** Standard
**Lane:** shared-machine-contract
**Depends on:** none

**Files:**

- Create: `src/shared/machineRequestTimeout.ts:1-24`
- Create: `src/shared/machineRequestTimeout.test.ts:1-80`
- Modify: `src/shared/apiTypes.ts:1-220`

**Interfaces:**

- Produces `DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 120_000`, `MIN_REMOTE_REQUEST_TIMEOUT_MS = 5_000`, `MAX_REMOTE_REQUEST_TIMEOUT_MS = 180_000`, and `REMOTE_BACKGROUND_REQUEST_TIMEOUT_MS = 20_000` from `src/shared/machineRequestTimeout.ts`.
- Produces `validateMachineRequestTimeoutMs(value: unknown): number`, accepting only finite integer numbers in the inclusive range and throwing the exact message `requestTimeoutMs must be an integer between 5000 and 180000 milliseconds` otherwise.
- Produces `effectiveMachineRequestTimeoutMs(machine: { requestTimeoutMs?: number }): number`, returning the stored value or `120_000` without mutating the object.
- Produces `MachineCreateRequest { name?: string; baseUrl?: string; token?: string; headers?: Record<string, string>; requestTimeoutMs?: number }` and `type MachineUpdateRequest = Partial<MachineCreateRequest>` from `src/shared/apiTypes.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
  effectiveMachineRequestTimeoutMs,
  validateMachineRequestTimeoutMs,
} from "./machineRequestTimeout";

describe("machine request timeout", () => {
  it("accepts inclusive machine timeout bounds without coercion", () => {
    expect(validateMachineRequestTimeoutMs(5_000)).toBe(5_000);
    expect(validateMachineRequestTimeoutMs(180_000)).toBe(180_000);
    for (const value of ["120000", null, true, 120_000.5, NaN, Infinity, 4_999, 180_001, undefined]) {
      expect(() => validateMachineRequestTimeoutMs(value)).toThrow(
        "requestTimeoutMs must be an integer between 5000 and 180000 milliseconds",
      );
    }
  });

  it("resolves an absent machine timeout without materializing it", () => {
    const machine: { baseUrl: string; requestTimeoutMs?: number } = { baseUrl: "https://remote.example.test" };
    expect(effectiveMachineRequestTimeoutMs(machine)).toBe(DEFAULT_REMOTE_REQUEST_TIMEOUT_MS);
    expect(Object.hasOwn(machine, "requestTimeoutMs")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `npm test -- --run src/shared/machineRequestTimeout.test.ts`

Expected: FAIL because the new module and exports do not exist.

- [ ] **Step 3: Write the implementation and shared request types**

```ts
export const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 120_000;
export const MIN_REMOTE_REQUEST_TIMEOUT_MS = 5_000;
export const MAX_REMOTE_REQUEST_TIMEOUT_MS = 180_000;
export const REMOTE_BACKGROUND_REQUEST_TIMEOUT_MS = 20_000;

const INVALID_TIMEOUT_MESSAGE = "requestTimeoutMs must be an integer between 5000 and 180000 milliseconds";

export function validateMachineRequestTimeoutMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= MIN_REMOTE_REQUEST_TIMEOUT_MS && value <= MAX_REMOTE_REQUEST_TIMEOUT_MS) {
    return value;
  }
  throw new Error(INVALID_TIMEOUT_MESSAGE);
}

export function effectiveMachineRequestTimeoutMs(machine: { requestTimeoutMs?: number }): number {
  return machine.requestTimeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS;
}
```

Add the two shared request shapes beside the existing machine API types without making `requestTimeoutMs` required. Do not add a default during parsing or serialization.

- [ ] **Step 4: Run the focused test and typecheck the changed contract**

Run: `npm test -- --run src/shared/machineRequestTimeout.test.ts`

Expected: PASS, 2 tests. Then run: `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/shared/machineRequestTimeout.ts src/shared/machineRequestTimeout.test.ts src/shared/apiTypes.ts
git commit -m "feat(shared): define remote request timeout contracts"
```

## Task 2: Persist and Validate Machine Patience

**Implementer tier:** Capable
**Lane:** machine-registry
**Depends on:** 1

**Files:**

- Modify: `src/server/machines/machineStore.ts:6-142`
- Create: `src/server/machines/machineStore.test.ts:1-220`
- Modify: `src/server/machines/machineService.ts:1-256`
- Modify: `src/server/machines/machineService.test.ts:1-360`
- Modify: `src/server/machines/machineRoutes.ts:1-190`

**Interfaces:**

- Consumes `MachineCreateRequest`, `MachineUpdateRequest`, `validateMachineRequestTimeoutMs`, and `effectiveMachineRequestTimeoutMs` from Task 1.
- Produces `StoredMachine.requestTimeoutMs?: number`, store add/update support for the optional field, and malformed-present-value rejection during store reads.
- Keeps `CreateMachineInput` and `UpdateMachineInput` exported from `machineService.ts` as aliases of the shared request shapes.
- Extends the public machine projection with only a supplied `requestTimeoutMs`; it never exposes `token` or `headers` and never adds the field to the synthesized local machine.
- Preserves validation-before-write, timestamps, cache invalidation, `PI_WEBUI_MACHINES_FILE`, default data-directory location, and mode `0o600`.
- Keeps health/runtime calls explicitly at `DEFAULT_REMOTE_HEALTH_TIMEOUT_MS = 3_000`; the client re-export and deadline implementation belong to Task 3.

- [ ] **Step 1: Write the failing persistence/service tests**

```ts
it("round trips an optional requestTimeoutMs without migrating old records", async () => {
  const path = await writeOldRegistryFixture();
  const store = new MachineStore(path);
  expect(store.list()[0]).not.toHaveProperty("requestTimeoutMs");
  const added = store.add({ name: "Remote Lab", baseUrl: "https://remote.example.test/base", requestTimeoutMs: 5_000 });
  store.update(added.id, { requestTimeoutMs: 180_000 });
  const reopened = new MachineStore(path);
  expect(reopened.get(added.id)?.requestTimeoutMs).toBe(180_000);
  expect(reopened.list()[0]).not.toHaveProperty("requestTimeoutMs");
  expect(reopened.get(added.id)).toMatchObject({ token: undefined });
});

it("rejects a malformed stored requestTimeoutMs", async () => {
  await writeRegistryFixture({ requestTimeoutMs: "120000" });
  expect(() => new MachineStore(registryPath)).toThrow(
    "requestTimeoutMs must be an integer between 5000 and 180000 milliseconds",
  );
});

it("validates requestTimeoutMs before add or update writes", async () => {
  const service = makeMachineServiceWithTrackedStore();
  const before = await service.list();
  await expect(service.add({ name: "Remote Lab", baseUrl: "https://remote.example.test", requestTimeoutMs: 120_000.5 })).rejects.toThrow(
    "requestTimeoutMs must be an integer between 5000 and 180000 milliseconds",
  );
  await expect(service.update("remote-lab", { requestTimeoutMs: undefined })).rejects.toThrow(
    "requestTimeoutMs must be an integer between 5000 and 180000 milliseconds",
  );
  expect(await service.list()).toEqual(before);
  expect(trackedStore.writes).toBe(0);
});

it("projects requestTimeoutMs publicly without exposing secrets", async () => {
  const service = makeMachineServiceWithRemote({ token: "secret", headers: { Authorization: "hidden" }, requestTimeoutMs: 90_000 });
  expect(await service.get("remote-lab")).toMatchObject({ id: "remote-lab", requestTimeoutMs: 90_000 });
  expect(await service.get("remote-lab")).not.toHaveProperty("token");
  expect(await service.get("remote-lab")).not.toHaveProperty("headers");
  expect((await service.get("local"))?.requestTimeoutMs).toBeUndefined();
});

it("keeps health and runtime probes at three seconds", async () => {
  const remoteClient = makeTrackedRemoteClient();
  const service = makeMachineServiceWithRemoteClient(remoteClient, { requestTimeoutMs: 180_000 });
  await service.health("remote-lab");
  await service.runtime("remote-lab");
  expect(remoteClient.requestOptions.map((options) => options.timeoutMs)).toEqual([3_000, 3_000]);
});
```

- [ ] **Step 2: Run the new and existing service tests and confirm they fail**

Run: `npm test -- --run src/server/machines/machineStore.test.ts src/server/machines/machineService.test.ts`

Expected: FAIL at the missing stored field, validation, or service projection assertions before any production implementation is added.

- [ ] **Step 3: Implement optional-field parsing, merge, and service validation**

```ts
function optionalRequestTimeout(record: Record<string, unknown>): number | undefined {
  if (!Object.hasOwn(record, "requestTimeoutMs")) return undefined;
  return validateMachineRequestTimeoutMs(record.requestTimeoutMs);
}

function machineFromRecord(record: Record<string, unknown>): StoredMachine {
  const requestTimeoutMs = optionalRequestTimeout(record);
  return {
    id: requireString(record, "id"),
    name: requireString(record, "name"),
    kind: "remote",
    baseUrl: requireString(record, "baseUrl"),
    ...(record.token === undefined ? {} : { token: requireString(record, "token") }),
    ...(record.headers === undefined ? {} : { headers: parseHeaders(record.headers) }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    createdAt: requireString(record, "createdAt"),
    updatedAt: requireString(record, "updatedAt"),
  };
}
```

Use an own-property check in both `MachineStore` patch handling and `MachineService.add/update`. An own `undefined` is invalid; omission leaves an existing value or absence unchanged. Call the shared validator before the first store write or timestamp/cache mutation. Extend the machine route body types and PATCH forwarding without wrapping or dropping the optional field.

- [ ] **Step 4: Run the focused persistence/service tests and typecheck**

Run: `npm test -- --run src/server/machines/machineStore.test.ts src/server/machines/machineService.test.ts`

Expected: PASS, including old-record absence, valid round trips, invalid no-write behavior, secret omission, and 3-second probes. Run `npm run typecheck` and confirm the existing machine route tests remain green.

- [ ] **Step 5: Commit**

```bash
git add src/server/machines/machineStore.ts src/server/machines/machineStore.test.ts src/server/machines/machineService.ts src/server/machines/machineService.test.ts src/server/machines/machineRoutes.ts
git commit -m "feat(machines): persist validated remote request patience"
```

## Task 3: Enforce Remote Header Deadlines

**Implementer tier:** Capable
**Lane:** remote-client
**Depends on:** 2

**Files:**

- Modify: `src/server/machines/machineClient.ts:1-190`
- Modify: `src/server/machines/machineClient.test.ts:1-420`

**Interfaces:**

- Consumes `StoredMachine.requestTimeoutMs` and the shared default/validation contract from Tasks 1–2.
- Produces `MachineRequestOptions { timeoutMs?: number; contentType?: string; signal?: AbortSignal }` while preserving existing positional request arguments.
- Keeps `MachineClient.request`, `requestJson`, and `connectWebSocket` public signatures otherwise unchanged.
- Keeps `DEFAULT_REMOTE_HEALTH_TIMEOUT_MS = 3_000` and re-exports `DEFAULT_REMOTE_REQUEST_TIMEOUT_MS` from the shared module; removes the old local `30_000` definition.
- Resolves `options.timeoutMs ?? machine.requestTimeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS`, without clamping a per-call override such as `300_000`.
- Produces caller/deadline ownership semantics, header-only timer scope, body cancellation ownership, and cleanup for readable and JSON responses.

- [ ] **Step 1: Write the failing deadline and body-lifecycle tests**

```ts
it("resolves call override then machine timeout then 120 second default", async () => {
  const cases = [
    { machine: { requestTimeoutMs: 90_000 }, options: {}, deadline: 90_000 },
    { machine: {}, options: {}, deadline: 120_000 },
    { machine: { requestTimeoutMs: 90_000 }, options: { timeoutMs: 300_000 }, deadline: 300_000 },
  ];
  for (const testCase of cases) {
    const fetchImpl = deferredHeaderFetch();
    const client = new RemoteMachineClient(testCase.machine, fetchImpl);
    const pending = client.request("GET", "/api/sessions?cwd=%2Frepo", undefined, testCase.options);
    advanceTimersByTime(testCase.deadline - 1);
    expect(fetchImpl.signal.aborted).toBe(false);
    advanceTimersByTime(1);
    await expect(pending).rejects.toMatchObject({ statusCode: 504 });
  }
});

it("clears its deadline at headers while preserving caller body cancellation", async () => {
  const body = deferredReadableBody();
  const caller = new AbortController();
  const fetchImpl = deferredHeaderFetch({ body, signal: caller.signal });
  const client = new RemoteMachineClient({ requestTimeoutMs: 5_000 }, fetchImpl);
  const pending = client.request("GET", "/sessions", undefined, { signal: caller.signal });
  fetchImpl.resolveHeaders(body.response);
  await flushPromises();
  advanceTimersByTime(6_000);
  expect(fetchImpl.signal.aborted).toBe(false);
  caller.abort(new Error("caller stopped"));
  await expect(pending).rejects.toThrow("caller stopped");
  expect(body.destroyed).toBe(true);
});

it("distinguishes caller abort from its own header deadline", async () => {
  const caller = new AbortController();
  const preAborted = new AbortController();
  preAborted.abort(new Error("already stopped"));
  const fetchImpl = deferredHeaderFetch();
  const client = new RemoteMachineClient({}, fetchImpl);
  await expect(client.request("GET", "/sessions", undefined, { signal: preAborted.signal })).rejects.toThrow("already stopped");
  expect(fetchImpl.calls).toBe(0);
  const callerPending = client.request("GET", "/sessions", undefined, { signal: caller.signal });
  caller.abort(new Error("caller stopped"));
  await expect(callerPending).rejects.toThrow("caller stopped");
  await expect(client.request("GET", "/sessions")).rejects.toMatchObject({ statusCode: 504 });
  fetchImpl.reject(new Error("connection refused"));
  await expect(client.request("GET", "/sessions")).rejects.toMatchObject({ statusCode: 502 });
});

it("keeps requestJson caller cancellation until body completion", async () => {
  const body = deferredTextBody();
  const caller = new AbortController();
  const fetchImpl = deferredHeaderFetch({ response: body.response });
  const client = new RemoteMachineClient({}, fetchImpl);
  const pending = client.requestJson("GET", "/config", undefined, { signal: caller.signal });
  fetchImpl.resolveHeaders(body.response);
  caller.abort(new Error("cancel json"));
  await expect(pending).rejects.toThrow("cancel json");
  expect(body.listenerCount).toBe(0);
});

it("cleans up no body and failed body adapters", async () => {
  await assertNoOwnedResourcesAfterNoBodyResponse();
  await assertNoOwnedResourcesAfterReadableAdapterFailure();
  await assertNoOwnedResourcesAfterBodyFailure();
});
```

- [ ] **Step 2: Run the client tests and confirm they fail**

Run: `npm test -- --run src/server/machines/machineClient.test.ts`

Expected: FAIL because the current client still defaults to 30 seconds, lacks caller signals, and maps every `AbortError` as a deadline.

- [ ] **Step 3: Implement one per-request controller and header timer**

```ts
function resolveRequestTimeout(machine: Pick<StoredMachine, "requestTimeoutMs">, options: MachineRequestOptions): number {
  return options.timeoutMs ?? machine.requestTimeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS;
}

async function fetchResponse(path: string, init: RequestInit, options: MachineRequestOptions): Promise<Response> {
  const caller = options.signal;
  if (caller?.aborted) throw caller.reason instanceof Error ? caller.reason : new DOMException("The operation was aborted", "AbortError");
  const combined = new AbortController();
  let owner: "caller" | "deadline" | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onCallerAbort = () => {
    if (owner !== undefined) return;
    owner = "caller";
    combined.abort(caller?.reason instanceof Error ? caller.reason : new DOMException("The operation was aborted", "AbortError"));
  };
  if (caller !== undefined) {
    caller.addEventListener("abort", onCallerAbort, { once: true });
    if (caller.aborted) onCallerAbort();
  }
  if (!combined.signal.aborted) {
    timer = setTimeout(() => {
      if (owner !== undefined) return;
      owner = "deadline";
      combined.abort(new Error("Remote machine request timed out"));
    }, resolveRequestTimeout(this.machine, options));
  }
  try {
    const response = await this.fetchImpl(resolveRemoteUrl(this.machine.baseUrl, path), { ...init, signal: combined.signal });
    if (timer !== undefined) clearTimeout(timer);
    if (owner === "deadline") throw new RemoteMachineRequestError("Remote machine request timed out", 504);
    return response;
  } catch (error) {
    if (timer !== undefined) clearTimeout(timer);
    if (owner === "deadline") throw new RemoteMachineRequestError("Remote machine request timed out", 504);
    if (owner === "caller") throw caller?.reason instanceof Error ? caller.reason : error;
    throw mapRemoteFetchFailure(error);
  } finally {
    if (caller !== undefined) caller.removeEventListener("abort", onCallerAbort);
  }
}
```

Adapt the returned readable so the caller listener remains attached until end/error/close/destroy, and dispose it for null bodies, adapter failures, and JSON text/parse completion. Clear the timer immediately when a `Response` arrives, including non-2xx responses. Never classify a body error as a timeout and never replace a caller-owned reason with 502/504.

- [ ] **Step 4: Run the focused client tests and verify the existing binary/JSON coverage**

Run: `npm test -- --run src/server/machines/machineClient.test.ts`

Expected: PASS, including the existing binary body, header filtering, remote compression request, JSON, and WebSocket tests. Run `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/server/machines/machineClient.ts src/server/machines/machineClient.test.ts
git commit -m "feat(server): make remote request deadlines caller-aware"
```

## Task 4: Provide Reply and Plugin Disconnect Ownership

**Implementer tier:** Capable
**Lane:** proxy-streaming
**Depends on:** 3

**Files:**

- Modify: `src/shared/federatedRoutes.ts:1-163`
- Create: `src/server/http/replyDisconnect.ts:1-80`
- Create: `src/server/http/replyDisconnect.test.ts:1-180`
- Modify: `src/server/machines/machinePluginProxyRoutes.ts:1-120`
- Modify: `src/server/app.plugins.test.ts:1-180`

**Interfaces:**

- Consumes `MachineClient` request options from Task 3 and the shared machine timeout contract from Tasks 1–2.
- Produces `ReplyDisconnectScope { readonly signal: AbortSignal; dispose(): void }` and `createReplyDisconnectScope(reply: FastifyReply)` from `src/server/http/replyDisconnect.ts`.
- Produces reply-owned cancellation for the plugin-manifest GET while preserving the separate 10 000 ms budget; the federated machine proxy boundary and stream flushing are implemented by Task 5.
- Removes `WORKSPACE_TASKS_MOVE_PROXY_TIMEOUT_MS` and the move route override, preserves all other 300 000 ms operation overrides, and retains the 10 000 ms plugin-manifest override.
- Keeps the reply scope idempotent, observes `reply.raw` finish/close, and leaves normal completion un-aborted.
- Keeps status/header allowlists and the existing `@fastify/compress` registration untouched.

- [ ] **Step 1: Write the failing reply-scope and plugin tests**

```ts
it("owns reply finish and close listeners until response completion", () => {
  const raw = new EventEmitter() as RawReply;
  raw.writableFinished = false;
  raw.destroyed = false;
  const scope = createReplyDisconnectScope({ raw } as FastifyReply);
  raw.emit("finish");
  expect(scope.signal.aborted).toBe(false);
  raw.emit("close");
  expect(scope.signal.aborted).toBe(false);
  const second = createReplyDisconnectScope({ raw: newRawReply() } as FastifyReply);
  second.raw.destroyed = true;
  second.raw.writableFinished = false;
  second.dispose();
  second.raw.emit("close");
  expect(second.signal.aborted).toBe(false);
});

it("cancels a disconnected manifest read while keeping its own budget", async () => {
  const manifest = deferredManifestRequest();
  const reply = injectReplyObserver();
  const pending = invokeManifestRoute(reply, manifest);
  expect(manifest.options).toMatchObject({ timeoutMs: 10_000 });
  expect(manifest.options.signal).toBeInstanceOf(AbortSignal);
  reply.raw.emit("close");
  await expect(pending).resolves.toBe(reply);
  expect(manifest.signal.aborted).toBe(true);
});
```

- [ ] **Step 2: Run the focused reply-scope/plugin tests and confirm they fail**

Run: `npm test -- --run src/server/http/replyDisconnect.test.ts src/server/app.plugins.test.ts`

Expected: FAIL because there is no reply-owned scope and the plugin manifest has no lifecycle signal.

- [ ] **Step 3: Implement reply ownership and plugin-manifest signal propagation**

```ts
export interface ReplyDisconnectScope {
  readonly signal: AbortSignal;
  dispose(): void;
}

export function createReplyDisconnectScope(reply: FastifyReply): ReplyDisconnectScope {
  const controller = new AbortController();
  let completed = false;
  let disposed = false;
  const onFinish = () => {
    completed = true;
    dispose();
  };
  const onClose = () => {
    if (!completed && reply.raw.writableFinished !== true && !controller.signal.aborted) {
      controller.abort(new DOMException("The response was disconnected", "AbortError"));
    }
    dispose();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    reply.raw.removeListener("finish", onFinish);
    reply.raw.removeListener("close", onClose);
  };
  reply.raw.once("finish", onFinish);
  reply.raw.once("close", onClose);
  if (reply.raw.writableFinished === true) onFinish();
  else if (reply.raw.destroyed === true) onClose();
  return { signal: controller.signal, dispose };
}
```

In the plugin-manifest route, create the scope for the remote GET before machine lookup, check it before sending, pass its signal alongside `{ timeoutMs: 10_000 }`, and dispose no-body/buffered terminal paths. Update the existing assertion at `src/server/app.plugins.test.ts:80` to assert the unchanged 10-second budget; do not loosen that assertion. Do not attach the scope to mutations or local requests. Remove the workspace-task move timeout override while retaining all other route budgets and keep the existing compression registration untouched; Task 5 owns the federated proxy's GET signal and eager `pipe` flush.

- [ ] **Step 4: Run all server proxy tests and inspect the required observable evidence**

Run: `npm test -- --run src/server/http/replyDisconnect.test.ts src/server/app.plugins.test.ts`

Expected: PASS, with finish/close cleanup, exact 10-second manifest timeout, and no abort on normal finish. Run `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/shared/federatedRoutes.ts src/server/http/replyDisconnect.ts src/server/http/replyDisconnect.test.ts src/server/machines/machinePluginProxyRoutes.ts src/server/app.plugins.test.ts
git commit -m "feat(proxy): cancel remote reads on disconnect"
```

## Task 5: Propagate Session-List Cancellation to the Daemon Hop

**Implementer tier:** Advanced
**Lane:** daemon-cancellation
**Depends on:** 4

**Files:**

- Modify: `src/server/machines/machineProxyRoutes.ts:1-190`
- Modify: `src/server/machines/machineProxyRoutes.test.ts:1-500`
- Modify: `src/server/sessiond/sessionProxyRoutes.ts:1-180`
- Modify: `src/server/sessiond/sessionProxyRoutes.test.ts:1-330`
- Modify: `src/sessiond/sessionDaemonClient.ts:1-150`
- Modify: `src/sessiond/sessionDaemonClient.test.ts:1-240`
- Modify: `src/server/app.compression.test.ts:1-260`

**Interfaces:**

- Consumes `createReplyDisconnectScope` from Task 4 and the existing fourth `signal?: AbortSignal` parameter of `SessionProxyDaemon.request`/`SessionDaemonClient.request`.
- Consumes `MachineClient` request options from Task 3 and the shared route table; produces GET-only lifecycle cancellation in `proxyMachineHttpRequest`, config GET signal forwarding, and preserved mutation signal omission.
- Produces route-budget resolution with stored/default values for ordinary entries, the four 300 000 ms operation overrides, and no workspace-task move override.
- Produces one-shot eager header flushing immediately before `reply.send(upstream.body)`, post-header raw response destruction, pre-header ordinary error handling, and cleanup of the flush listener on finish/close/send throw.
- Produces cancellation only for `prefix === "/api"`, method `GET`, stripped pathname exactly `/sessions`, and a nonempty `cwd` query value at the receiving daemon hop.
- Keeps local-prefixed requests, generic requests, notifications, probes, auth, `/sessions` without `cwd`, and all mutations on the existing `undefined` signal path.
- Preserves daemon request body argument three as `undefined`, forwards safe headers/status/JSON as before, buffers the daemon body until completion, and suppresses `requestFailed` after a downstream disconnect.
- Keeps daemon enumeration signal-free; only the HTTP/Unix transport and its buffering stop when the signal aborts.

- [ ] **Step 1: Write the failing proxy, receiving-gateway, and transport tests**

```ts
it("preserves meaningful route overrides and removes the workspace move override", async () => {
  const calls = await proxyEachRouteWithStoredTimeout(90_000);
  expect(calls["/skills/search"].timeoutMs).toBe(300_000);
  expect(calls["/package-plugins"].timeoutMs).toBe(300_000);
  expect(calls["/pi-packages/install"].timeoutMs).toBe(300_000);
  expect(calls["/sessions/tree/navigate"].timeoutMs).toBe(300_000);
  expect(calls["/workspace-tasks/move"].timeoutMs).toBe(90_000);
  expect(calls["/config"].signal).toBeInstanceOf(AbortSignal);
  expect(calls["/config"].put.signal).toBeUndefined();
});

it("cancels an unfinished remote read when the downstream reply closes", async () => {
  const deferred = deferredRemoteResponse();
  const reply = injectReplyObserver();
  const pending = invokeRemoteGet("/api/machines/remote-lab/sessions?cwd=%2Frepo", reply, deferred);
  reply.raw.emit("close");
  await expect(pending).resolves.toBe(reply);
  expect(deferred.signal.aborted).toBe(true);
  deferred.releaseBodyError();
});

it("cleans disconnect listeners for replies that never stream", async () => {
  await assertNoOwnedListenersAfterMissingMachine();
  await assertNoOwnedListenersAfterRejectedFetch();
  await assertNoOwnedListenersAfterEmptyBody();
  await assertNoOwnedListenersAfterBufferedConfig();
  await assertNormalFinishDoesNotAbort();
});

it("cancels config GET buffering without cancelling config PUT", async () => {
  const get = invokeConfigGetWithDeferredJson();
  get.reply.raw.emit("close");
  await expect(get.pending).resolves.toBe(get.reply);
  expect(get.options.signal?.aborted).toBe(true);
  const put = invokeConfigPutWithDeferredJson();
  put.reply.raw.emit("close");
  expect(put.options.signal).toBeUndefined();
  put.resolve({ sessiond: { enabled: true }, sessiondUrl: "http://sessiond" });
  await expect(put.pending).resolves.toBeDefined();
});

it("returns the same timeout validation error from machine POST and PATCH", async () => {
  const post = await app.inject({ method: "POST", url: "/api/machines", payload: invalidMachinePayload() });
  const patch = await app.inject({ method: "PATCH", url: "/api/machines/remote-lab", payload: { requestTimeoutMs: 120_000.5 } });
  expect(post.statusCode).toBe(400);
  expect(patch.statusCode).toBe(400);
  expect(post.json()).toEqual({ error: "requestTimeoutMs must be an integer between 5000 and 180000 milliseconds" });
  expect(patch.json()).toEqual(post.json());
  expect(await readMachineRecord("remote-lab")).toEqual(beforeMachineRecord);
});

it("flushes upstream headers before the first body chunk", async () => {
  const source = deferredReadableBody();
  const observed = await invokeStreamRouteWithSource(source);
  expect(observed.firstChunkCountAtFlush).toBe(0);
  expect(observed.statusAtFlush).toBe(200);
  expect(observed.safeHeadersAtFlush).toMatchObject({ "content-type": "application/json" });
  source.releaseFirstChunk();
  await observed.complete;
  expect(observed.bodyReadCount).toBe(1);
});

it("destroys a streamed reply on upstream error after header flush", async () => {
  const source = deferredReadableBody();
  const observed = await invokeStreamRouteWithSource(source);
  expect(observed.flushCount).toBe(1);
  source.fail(new Error("upstream body failed"));
  await observed.complete;
  expect(observed.raw.destroyed).toBe(true);
  expect(observed.errorResponses).toHaveLength(0);
});

it("removes the flush listener when the streamed send throws before piping", async () => {
  const observed = await invokeStreamRouteWithSendThrowBeforePipe();
  expect(observed.pipeListenerCount).toBe(0);
  expect(observed.errorResponse.statusCode).toBe(502);
});

it("forwards disconnect cancellation only to the remote session list read", async () => {
  const list = deferredDaemonRequest();
  const mutation = deferredDaemonRequest();
  const app = makeSessionProxyApp({ daemon: { list, mutation } });
  const listReply = makeRawReply();
  const listPending = app.handle({ prefix: "/api", method: "GET", url: "/sessions?cwd=%2Frepo" }, listReply);
  listReply.emit("close");
  await expect(listPending).resolves.toBe(listReply);
  expect(list.signal).toBeInstanceOf(AbortSignal);
  expect(list.signal.aborted).toBe(true);
  await app.handle({ prefix: "/api", method: "POST", url: "/sessions/%2Frepo/notifications/dismiss" }, makeRawReply(), mutation);
  expect(mutation.signal).toBeUndefined();
  expect(app.daemon.requestSignals).toContain(undefined);
});

it("does not turn a cancelled list transport into a daemon error response", async () => {
  const requestFailed = vi.fn();
  const reply = makeRawReply({ destroyed: true, writableFinished: false });
  const pending = handleRemoteList({ reply, requestFailed, daemon: abortingDaemon() });
  reply.emit("close");
  await expect(pending).resolves.toBe(reply);
  expect(requestFailed).not.toHaveBeenCalled();
  expect(reply.send).not.toHaveBeenCalled();
});

it("cancelling a list does not cancel an accepted notification mutation", async () => {
  const list = deferredDaemonRequest();
  const dismissal = deferredDaemonRequest();
  const app = makeSessionProxyApp({ daemon: { list, dismissal } });
  const listReply = makeRawReply();
  const mutationReply = makeRawReply();
  const listPending = app.handle({ prefix: "/api", method: "GET", url: "/sessions?cwd=%2Frepo" }, listReply);
  const mutationPending = app.handle({ prefix: "/api", method: "POST", url: "/sessions/%2Frepo/notifications/dismiss" }, mutationReply);
  listReply.emit("close");
  dismissal.resolve({ statusCode: 200, body: "{}" });
  await mutationPending;
  expect(dismissal.signal).toBeUndefined();
  expect(dismissal.completed).toBe(true);
  await listPending;
});

it("propagates browser bow out through both gateways to the daemon transport", async () => {
  const fixture = composeGatewayCancellationChain();
  const pending = fixture.startRemoteList();
  fixture.originReply.raw.emit("close");
  await pending;
  expect(fixture.originSignal.aborted).toBe(true);
  expect(fixture.receivingSignal.aborted).toBe(true);
  expect(fixture.daemonSignal.aborted).toBe(true);
  expect(fixture.errorResponses).toHaveLength(0);
  await fixture.acceptedMutation;
});

it("flushes delayed remote headers after compression negotiation", async () => {
  const source = deferredReadableBody({ compressible: true });
  const observed = await invokeRealCompressedAppStream(source);
  expect(observed.firstChunkCountAtFlush).toBe(0);
  expect(observed.headersAtFlush["content-encoding"]).toBe("gzip");
  expect(observed.headersAtFlush.vary).toContain("Accept-Encoding");
  expect(observed.headersAtFlush["content-length"]).toBeUndefined();
  source.releaseAll();
  expect(await observed.decodedBody).toEqual(expectedRows);
});

it("preserves identity negotiation with an eagerly flushed stream", async () => {
  const observed = await invokeIdentityStreamWithSource(deferredReadableBody());
  expect(observed.headersAtFlush["content-encoding"]).toBeUndefined();
  expect(observed.headersAtFlush["x-content-type-options"]).toBe("nosniff");
});

it("aborts HTTP and Unix daemon transports while leaving enumeration independent", async () => {
  const http = stubHttpRequestWithoutOpeningSocket();
  const unix = stubUnixRequestWithoutOpeningSocket();
  const enumeration = deferredEnumeration();
  const client = makeSessionDaemonClient({ http, unix, sessions: { list: () => enumeration.promise } });
  const controller = new AbortController();
  const pending = client.request("GET", "/sessions?cwd=%2Frepo", undefined, controller.signal);
  controller.abort(new Error("browser disconnected"));
  await expect(pending).rejects.toThrow("browser disconnected");
  expect(http.destroyed).toBe(true);
  expect(unix.destroyed).toBe(true);
  enumeration.resolve([]);
  await expect(enumeration.promise).resolves.toEqual([]);
});
```

- [ ] **Step 2: Run the proxy, receiving-gateway, compression, and daemon tests and confirm they fail**

Run: `npm test -- --run src/server/machines/machineProxyRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/sessiond/sessionDaemonClient.test.ts src/server/app.compression.test.ts`

Expected: FAIL because the machine proxy has no reply-owned signal/eager flush, compression cannot observe the delayed header flush, and the receiving session proxy currently forwards no list-only signal.

- [ ] **Step 3: Implement proxy route ownership, eager streaming, exact session-list classification, and transport cleanup**

```ts
function shouldCancelRemoteSessionList(prefix: string, method: string, pathname: string, cwd: string | null): boolean {
  return prefix === "/api" && method === "GET" && pathname === "/sessions" && cwd !== null && cwd !== "";
}

async function proxyMachineHttpRequest(request: ProxyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const scope = request.method === "GET" ? createReplyDisconnectScope(reply) : undefined;
  let flushed = false;
  const flush = () => {
    if (!flushed) {
      flushed = true;
      reply.raw.flushHeaders();
    }
  };
  try {
    const machine = await resolveMachine(request.machineId);
    if (scope?.signal.aborted) return reply;
    const upstream = await machineClient.request(request.method, remoteApiPath(request), {
      signal: scope?.signal,
      timeoutMs: resolveRouteTimeout(request, machine),
      headers: request.headers,
    });
    if (scope?.signal.aborted) return reply;
    if (upstream.body === undefined) {
      return reply.send(upstream.payload);
    }
    reply.raw.once("pipe", flush);
    try {
      return await reply.send(upstream.body);
    } catch (error) {
      reply.raw.removeListener("pipe", flush);
      if (flushed) reply.raw.destroy(error as Error);
      throw error;
    } finally {
      reply.raw.removeListener("pipe", flush);
    }
  } catch (error) {
    if (scope?.signal.aborted || reply.raw.destroyed) return reply;
    return sendProxyError(reply, error);
  } finally {
    scope?.dispose();
  }
}

async function proxySessionRequest(request: ProxyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const parsed = new URL(request.url, "http://sessiond.invalid");
  const scope = shouldCancelRemoteSessionList(request.prefix, request.method, parsed.pathname, parsed.searchParams.get("cwd"))
    ? createReplyDisconnectScope(reply)
    : undefined;
  try {
    const result = await daemon.request(request.method, stripSessionPrefix(parsed), undefined, scope?.signal);
    if (scope?.signal.aborted || reply.raw.destroyed) return reply;
    return sendDaemonResponse(reply, result);
  } catch (error) {
    if (scope?.signal.aborted || reply.raw.destroyed) return reply;
    return requestFailed(reply, error);
  } finally {
    scope?.dispose();
  }
}
```

In `proxyMachineHttpRequest`, create the reply scope for remote GETs before machine lookup, check it after lookup and before each send, merge only its `signal` into existing timeout/content-type options, and dispose terminal non-stream paths. Arm and remove a local one-shot `pipe` listener immediately around `reply.send(upstream.body)`. On a post-flush failure destroy `reply.raw`; on a pre-flush send throw remove the listener and use the existing gateway error mapping. Keep `/config` GET signal-aware and PUT unsignalled. Preserve content/header validation and the stored/default route budget resolution.

Then implement the receiving hop with the exact `/api` + `GET` + `/sessions` + nonempty `cwd` predicate, pass its scope as daemon argument four with body argument three `undefined`, and suppress errors after disconnect. Retain the signal through HTTP/Unix response buffering and remove it on every terminal path. Do not pass it to daemon enumeration or accepted mutations.

- [ ] **Step 4: Run the focused tests and typecheck**

Run: `npm test -- --run src/server/machines/machineProxyRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/sessiond/sessionDaemonClient.test.ts src/server/http/replyDisconnect.test.ts src/server/app.plugins.test.ts src/server/app.compression.test.ts`

Expected: PASS, including delayed first-chunk header flush after compression, exact route overrides, no-body/send-throw cleanup, full browser-to-daemon cancellation with a separate accepted mutation, the existing unsignalled mutation/generic regressions, and independent enumeration. Run `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/server/machines/machineProxyRoutes.ts src/server/machines/machineProxyRoutes.test.ts src/server/sessiond/sessionProxyRoutes.ts src/server/sessiond/sessionProxyRoutes.test.ts src/sessiond/sessionDaemonClient.ts src/sessiond/sessionDaemonClient.test.ts src/server/app.compression.test.ts
git commit -m "feat(proxy): cancel remote reads through the daemon hop"
```

## Task 6: Add Browser Transport Phases and Background Reads

**Implementer tier:** Capable
**Lane:** browser-transport
**Depends on:** 1

**Files:**

- Modify: `src/client/src/api/http.ts:1-80`
- Modify: `src/client/src/api/http.test.ts:1-220`
- Modify: `src/client/src/api/clients.ts:1-641`
- Modify: `src/client/src/api/clients.test.ts:1-260`
- Modify: `src/client/src/api/parsers.ts:1-2749`
- Modify: `src/client/src/api/parsers.test.ts:1-300`
- Modify: `src/client/src/controllers/cancellableLoadScope.ts:1-75`
- Create: `src/client/src/controllers/backgroundRead.ts:1-150`
- Create: `src/client/src/controllers/backgroundRead.test.ts:1-300`

**Interfaces:**

- Consumes the shared timeout validator and `MachineCreateRequest`/`MachineUpdateRequest` from Task 1.
- Produces `ResponseStarted`, the optional fourth `request` callback, and `HttpResponseBodyError` with `status`, `cause`, name `HttpResponseBodyError`, and message `Failed to receive response body`.
- Produces `machinesApi.updateMachine(machineId, patch)` using an encoded application-relative PATCH path and exact JSON payload.
- Extends `sessionsApi.sessions(cwd, machineId?, signal?, onResponse?)`; adds optional final signals to memory, learned-skills, and Git read adapters without installing global timers.
- Produces `ReadIntent = "background" | "foreground"` and `runBackgroundRead<T>(machineId, read, signal?)` with a 20 000 ms remote deadline, local direct delegation, native-timeout normalization, `AbortSignal.any` fallback, and complete cleanup.
- Extends `LoadCancelledError(message = "Load cancelled because the selection changed")` without changing no-argument behavior.

- [ ] **Step 1: Write the failing HTTP/API/helper tests**

```ts
it("parses optional machine patience additively and rejects malformed presence", () => {
  expect(parseMachine({ ...remoteMachineJson, requestTimeoutMs: 5_000 })).toHaveProperty("requestTimeoutMs", 5_000);
  expect(parseMachine(remoteMachineJson)).not.toHaveProperty("requestTimeoutMs");
  expect(parseMachine({ ...remoteMachineJson, requestTimeoutMs: undefined, extra: true })).toThrow();
  expect(parseMachine({ ...remoteMachineJson, requestTimeoutMs: 180_001 })).toThrow();
  expect(parseMachine({ ...remoteMachineJson, extra: "accepted" })).toMatchObject({ id: "remote-lab" });
});

it("patches a machine through an encoded application relative path", async () => {
  const fetchMock = installFetchMock({ body: remoteMachineJson });
  await machinesApi.updateMachine("lab/with space", { name: "Remote Lab", requestTimeoutMs: 90_000 });
  expect(fetchMock.last()).toMatchObject({
    url: "/tools/pi/api/machines/lab%2Fwith%20space",
    method: "PATCH",
    body: JSON.stringify({ name: "Remote Lab", requestTimeoutMs: 90_000 }),
  });
});

it("forwards read signals and session response start without applying global deadlines", async () => {
  const signal = new AbortController().signal;
  const onResponse = vi.fn();
  await sessionsApi.sessions("/repo", "remote-lab", signal, onResponse);
  await memoryApi.snapshot("/repo", "remote-lab", signal);
  await learnedSkillsApi.snapshot("/repo", "remote-lab", signal);
  await gitApi.gitStatus("/repo", "remote-lab", signal);
  await gitApi.gitDiff("/repo", "remote-lab", "file.ts", signal);
  expect(fetchRequests.every((request) => request.init.signal === signal)).toBe(true);
  expect(setTimeout).not.toHaveBeenCalled();
});

it("reports response start before reading a delayed first body chunk", async () => {
  const body = deferredResponseBody();
  const onResponse = vi.fn();
  const pending = request("api/sessions?cwd=%2Frepo", parseSessionRows, {}, onResponse);
  resolveFetchWithResponse(body.response);
  await flushPromises();
  expect(onResponse).toHaveBeenCalledTimes(1);
  expect(body.readStarted).toBe(false);
  body.release();
  await pending;
});

it("separates successful body transport failure from JSON and schema failure", async () => {
  await expect(request("api/sessions", parseSessionRows, {}, vi.fn(), rejectedTextResponse())).rejects.toMatchObject({ name: "HttpResponseBodyError", status: 200 });
  await expect(request("api/sessions", parseSessionRows, {}, vi.fn(), invalidJsonResponse())).rejects.not.toHaveProperty("name", "HttpResponseBodyError");
  await expect(request("api/sessions", parseSessionRows, {}, vi.fn(), invalidSchemaResponse())).rejects.not.toHaveProperty("name", "HttpResponseBodyError");
  await expect(request("api/sessions", parseSessionRows, {}, vi.fn(), abortingTextResponse())).rejects.toMatchObject({ name: "AbortError" });
});
```

Add the exact helper cases:

```ts
it("normalizes a native timeout source to LoadCancelledError", async () => {
  const read = deferredRead();
  const pending = runBackgroundRead("remote-lab", read.fn);
  advanceTimersByTime(20_000);
  await expect(pending).rejects.toSatisfy(isLoadCancellation);
  await expect(pending).rejects.toMatchObject({ name: "LoadCancelledError", message: "Background read exceeded 20000 milliseconds" });
});

it("bows out with the same marker when AbortSignal timeout is unavailable", async () => {
  stubAbortSignalTimeout(undefined);
  const read = deferredRead();
  const pending = runBackgroundRead("remote-lab", read.fn);
  advanceTimersByTime(19_999);
  expect(read.signal?.aborted).toBe(false);
  advanceTimersByTime(1);
  await expect(pending).rejects.toMatchObject({ name: "LoadCancelledError" });
  expect(ownedTimers()).toHaveLength(0);
});

it("combines supersession with or without AbortSignal any", async () => {
  for (const hasAny of [true, false]) {
    stubAbortSignalAny(hasAny ? AbortSignal.any : undefined);
    const parent = new AbortController();
    const read = deferredRead();
    const pending = runBackgroundRead("remote-lab", read.fn, parent.signal);
    parent.abort(new LoadCancelledError("superseded"));
    await expect(pending).rejects.toMatchObject({ message: "superseded" });
    expect(read.listenerCount).toBe(0);
  }
  const pre = new AbortController();
  pre.abort(new LoadCancelledError("pre-aborted"));
  await expect(runBackgroundRead("remote-lab", vi.fn(), pre.signal)).rejects.toThrow("pre-aborted");
});

it("leaves local and foreground reads untimed", async () => {
  const local = deferredRead();
  const localPending = runBackgroundRead("local", local.fn);
  advanceTimersByTime(20_001);
  local.resolve("local");
  await expect(localPending).resolves.toBe("local");
  expect(local.signal).toBeUndefined();
  expect(hasForegroundCallSiteDeadline()).toBe(false);
});

it("does not disguise a genuine read failure as cancellation", async () => {
  const error = new Error("real read failure");
  await expect(runBackgroundRead("remote-lab", () => Promise.reject(error))).rejects.toBe(error);
  expect(ownedListeners()).toHaveLength(0);
});
```

- [ ] **Step 2: Run the browser adapter/helper tests and confirm they fail**

Run: `npm test -- --run src/client/src/api/http.test.ts src/client/src/api/clients.test.ts src/client/src/api/parsers.test.ts src/client/src/controllers/backgroundRead.test.ts`

Expected: FAIL because the optional timeout parser/API, response callback/body error, and background helper do not exist.

- [ ] **Step 3: Implement the adapter and helper contracts**

```ts
export type ResponseStarted = (response: Response) => void;

export class HttpResponseBodyError extends Error {
  readonly status: number;
  readonly cause: unknown;
  constructor(status: number, cause: unknown) {
    super("Failed to receive response body");
    this.name = "HttpResponseBodyError";
    this.status = status;
    this.cause = cause;
  }
}

export async function request<T>(url: string, parse: (value: unknown) => T, init?: RequestInit, onResponse?: ResponseStarted): Promise<T> {
  const response = await fetch(resolveAppUrl(url), withJsonHeaders(init));
  onResponse?.(response);
  if (!response.ok) {
    const body: unknown = await response.json().catch((): unknown => ({}));
    throw new HttpRequestError(errorMessage(body) ?? response.statusText, response.status);
  }
  let text: string;
  try {
    text = onResponse === undefined ? await response.text() : await response.text();
  } catch (cause) {
    if (init?.signal?.aborted || isAbortError(cause)) throw cause;
    throw new HttpResponseBodyError(response.status, cause);
  }
  return parse(JSON.parse(text));
}
```

Preserve current non-opted-in `response.json()` semantics where required by existing callers; the opted-in path must read successful bodies exactly once and catch only `response.text()`. Extend `parseMachine` with an own-property check and the shared validator. Add `updateMachine` exactly as `request(\`api/machines/${encodeURIComponent(machineId)}\`, parseMachine, { method: "PATCH", body: JSON.stringify(patch) })`. Implement `runBackgroundRead` with an owned controller, a marker-bearing 20-second deadline source, independent feature detection for `AbortSignal.timeout` and `.any`, first-reason-wins forwarding, pre-abort short-circuit, and `finally` cleanup.

- [ ] **Step 4: Run the focused browser tests and typecheck**

Run: `npm test -- --run src/client/src/api/http.test.ts src/client/src/api/clients.test.ts src/client/src/api/parsers.test.ts src/client/src/controllers/backgroundRead.test.ts`

Expected: PASS, including nested-base URL encoding, no optimistic machine field, response-start ordering, body-vs-JSON/schema classification, both AbortSignal feature combinations, exact 20 000 ms fallback, local direct delegation, and genuine-error preservation. Run `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/api/http.ts src/client/src/api/http.test.ts src/client/src/api/clients.ts src/client/src/api/clients.test.ts src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts src/client/src/controllers/cancellableLoadScope.ts src/client/src/controllers/backgroundRead.ts src/client/src/controllers/backgroundRead.test.ts
git commit -m "feat(client): expose response phases and bounded background reads"
```

## Task 7: Add Selection Provenance and List-Only Retry

**Implementer tier:** Capable
**Lane:** selection-retry
**Depends on:** 6

**Files:**

- Modify: `src/client/src/appState.ts:1-220`
- Modify: `src/client/src/controllers/workspaceController.ts:1-792`
- Modify: `src/client/src/controllers/workspaceController.test.ts:1-900`
- Modify: `src/client/src/controllers/workspaceController.cancellation.test.ts:1-420`
- Modify: `src/client/src/controllers/workspaceController.sessionLists.test.ts:1-220`
- Modify: `src/client/src/controllers/sessionController.ts:1-2792`
- Modify: `src/client/src/controllers/sessionController.refresh.test.ts:1-500`

**Interfaces:**

- Consumes `ReadIntent`, `runBackgroundRead`, `HttpRequestError`, `HttpResponseBodyError`, `isLoadCancellation`, and the response-start callback from Task 6.
- Produces `SessionListLoadScope`, `SessionListLoad`, and `SessionListFailure` in `appState.ts`, plus optional `sessionListLoad`/`sessionListFailure` reset with workspace-scoped state.
- Produces `WorkspaceController.refreshSessionLists(cwds?, machineId?, intent: ReadIntent = "foreground")` with per-cwd foreground precedence and `retrySessionList(): Promise<void>`.
- Produces `WorkspaceController` clock dependency `now?: () => number`, captured operation identity/path/machine/budget guards, typed timeout/transfer classification, and silent cancellation publication.
- Produces `SessionController.applyRefreshedSessionLists(..., options?: { preserveSelection?: boolean })`; the default remains current behavior and retry uses list-only reconciliation with no select/deselect/rejoin/detach/stream changes.

- [ ] **Step 1: Write the failing provenance, overlap, retry, and preserve-selection tests**

```ts
it("publishes captured remote selection and receiving provenance", async () => {
  const clock = fakeClock(1_000_000);
  const fixture = makeSelectedRemoteWorkspace({ now: clock.now });
  const pending = fixture.controller.selectWorkspace(fixture.workspace);
  expect(fixture.state.sessionListLoad).toMatchObject({
    owner: "selection",
    scope: { machineId: "remote-lab", projectId: "project-1", workspaceId: "workspace-1", workspacePath: "/repo" },
    startedAt: 1_000_000,
    budgetMs: 120_000,
    phase: "waiting",
  });
  fixture.resolveHeaders();
  expect(fixture.state.sessionListLoad?.phase).toBe("receiving");
  fixture.resolveRows([fixture.session]);
  await pending;
  expect(fixture.state.sessionListLoad).toBeUndefined();
  expect(fixture.state.sessionListFailure).toBeUndefined();
  expect(makeLocalWorkspaceFixture().state.sessionListLoad).toBeUndefined();
});

it("keeps catalog fallback silent while bounding its remote read", async () => {
  const fixture = makeCatalogFallbackFixture();
  const pending = fixture.runFallback();
  advanceTimersByTime(20_000);
  await pending;
  expect(fixture.state.sessionListLoad).toBeUndefined();
  expect(fixture.state.sessionListFailure).toBeUndefined();
  expect(fixture.state.error).toBe("");
});

it("publishes timeout and transfer failures without writing state error", async () => {
  const timeout = makeSelectedRemoteWorkspace();
  timeout.reject(new HttpRequestError("gateway timeout", 504));
  await timeout.pending;
  expect(timeout.state.sessionListFailure).toMatchObject({ kind: "timeout", elapsedMs: 2_000, budgetMs: 120_000 });
  expect(timeout.state.error).toBe("");
  const transfer = makeSelectedRemoteWorkspace();
  transfer.resolveHeaders();
  transfer.reject(new HttpResponseBodyError(200, new Error("body stopped")));
  await transfer.pending;
  expect(transfer.state.sessionListFailure).toMatchObject({ kind: "transfer", elapsedMs: 3_000 });
  const ordinary = makeSelectedRemoteWorkspace();
  ordinary.reject(new HttpRequestError("bad gateway", 502));
  await ordinary.pending;
  expect(ordinary.state.sessionListFailure).toBeUndefined();
  expect(ordinary.state.error).toContain("bad gateway");
});

it("retries only the current list without selecting or detaching a session", async () => {
  const fixture = makeFailedSelectedWorkspace({ selectedSessionId: "session-1" });
  const retry = fixture.controller.retrySessionList();
  expect(fixture.api.sessions).toHaveBeenCalledTimes(1);
  expect(fixture.selectionCalls).toEqual([]);
  expect(fixture.streamCalls).toEqual([]);
  expect(fixture.state.sessionListLoad?.owner).toBe("retry");
  fixture.resolveRows([{ ...fixture.session, archived: true }]);
  await retry;
  expect(fixture.state.selectedSession?.id).toBe("session-1");
  expect(fixture.state.sessionListFailure).toBeUndefined();
  expect(fixture.urlChanges).toHaveLength(0);
  expect(fixture.draftState).toEqual(fixture.initialDraftState);
});

it("a superseded load cannot advance or clear a newer load in the same scope", async () => {
  const fixture = makeTwoDeferredLoadsInOneWorkspace();
  const original = fixture.startOriginal();
  const retry = fixture.startRetry();
  fixture.resolveOriginalHeaders();
  fixture.resolveOriginalError(new HttpRequestError("old", 504));
  fixture.resolveOriginalFinally();
  expect(fixture.state.sessionListLoad?.owner).toBe("retry");
  expect(fixture.state.sessionListFailure).toBeUndefined();
  fixture.switchWorkspaceAndResolveOriginalLate();
  await Promise.allSettled([original, retry]);
});

it("foreground mutation refresh survives later background invalidations in the queue", async () => {
  const fixture = makeRefreshQueueFixture();
  const foreground = fixture.refreshSessionLists(["/repo"], "remote-lab", "foreground");
  fixture.requestBackgroundInvalidation("/repo");
  fixture.resolveRunningBackgroundWithBowOut();
  fixture.resolveForegroundAfterTwentySeconds();
  await foreground;
  expect(fixture.calls).toEqual([{ cwd: "/repo", intent: "background" }, { cwd: "/repo", intent: "foreground" }]);
  expect(fixture.foregroundReadWasFullBudget).toBe(true);
});

it("preserves per cwd intent and deferred dirty work behind selection", async () => {
  const fixture = makeMixedCwdRefreshFixture();
  const foreground = fixture.deferSelectionThenRequest("/repo");
  fixture.requestBackgroundInvalidation("/repo-two");
  fixture.releaseSelection();
  await foreground;
  expect(fixture.completedIntents).toEqual({ "/repo": "foreground", "/repo-two": "background" });
});

it("keeps cancelled discovery hydration eligible for a later snapshot", async () => {
  const fixture = makeDiscoveryFixture();
  await fixture.cancelHydration();
  expect(fixture.hydrated).toBe(false);
  await fixture.runLaterSnapshot();
  expect(fixture.hydrated).toBe(true);
});

it("preserveSelection list application reconciles rows without session lifecycle effects", async () => {
  const fixture = makeSessionControllerFixture({ selected: "session-1" });
  await fixture.controller.applyRefreshedSessionLists(fixture.rowsMissingOrArchivedSelected, { preserveSelection: true });
  expect(fixture.selectedSessionId()).toBe("session-1");
  expect(fixture.lifecycleCalls).toEqual([]);
  await fixture.controller.applyRefreshedSessionLists(fixture.normalRows);
  expect(fixture.defaultModeLifecycleCalls).not.toEqual([]);
});

it("post mutation reconciliation uses foreground intent even when fire and forget", async () => {
  const fixture = makeMutationRevalidationFixture();
  fixture.controller.revalidateSessionListsAfterCommit();
  await fixture.flush();
  expect(fixture.refreshCalls).toContainEqual({ intent: "foreground" });
  advanceTimersByTime(20_000);
  expect(fixture.acceptedMutationRefreshCompleted).toBe(true);
});
```

- [ ] **Step 2: Run the controller tests and confirm they fail**

- [ ] **Update the calibration invalidation to declare background intent**

`workspaceController.sessionLists.test.ts` calls `refreshSessionLists([main.path])`
while `selectWorkspace` is loading and awaits it. That call is an invalidation, so
under the completion contract it is `background` and must say so, otherwise a
foreground call would have to wait for a replay that selection is blocking:

```ts
await settle(h.controller.refreshSessionLists([main.path], undefined, "background"));
```

The test's calibration assertions are unchanged.

Run: `npm test -- --run src/client/src/controllers/workspaceController.test.ts src/client/src/controllers/workspaceController.cancellation.test.ts src/client/src/controllers/workspaceController.sessionLists.test.ts src/client/src/controllers/sessionController.refresh.test.ts`

Expected: FAIL because state has no provenance records, refresh queues have no intent priority, retry does not exist, and refreshed-list application always has selection side effects.

- [ ] **Step 3: Implement guarded operation ownership and list-only application**

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
  scope: { machineId: string; machineName: string; projectId: string; workspaceId: string };
  kind: "timeout" | "transfer";
  elapsedMs: number;
  budgetMs: number;
}
```

Store dirty intent per cwd. At each pass atomically claim `{ cwd, intent }`; foreground wins over background and a foreground arrival during a running background pass creates a trailing foreground read. Capture a selected-workspace operation token, scope, machine name/path, effective budget, and `startedAt` immediately before `api.sessions`. Pass `onResponse` to publish `receiving` only when all current-selection, token, topology, and non-aborted-signal guards hold. In every catch/reporting boundary check `isLoadCancellation(error)` first; cancellation only performs guarded loading cleanup.

Implement retry as a fresh same-scope operation that calls only `api.sessions(currentWorkspace.path, machineId, signal, onResponse)` and then `applyRefreshedSessionLists(rows, { preserveSelection: true })`. In preserve mode, update authoritative rows, pending-start/cache reconciliation, and row metadata, but skip `selectSession`, `deselectSession`, `clearActiveSession`, stream joins/detaches, preferred-session selection, URL changes, drafts, attachments, queued sends, transcript, and scroll state. Leave the existing default mode unchanged.

- [ ] **Step 4: Run the focused controller tests and typecheck**

Run: `npm test -- --run src/client/src/controllers/workspaceController.test.ts src/client/src/controllers/workspaceController.cancellation.test.ts src/client/src/controllers/workspaceController.sessionLists.test.ts src/client/src/controllers/sessionController.refresh.test.ts`

Expected: PASS, including same-scope stale callbacks, exact elapsed/budget capture, silent catalog fallback, list-only retry with an open session, foreground queue precedence after a 20-second background bow-out, per-cwd deferred intent, and normal mutation reconciliation. Run `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/appState.ts src/client/src/controllers/workspaceController.ts src/client/src/controllers/workspaceController.test.ts src/client/src/controllers/workspaceController.cancellation.test.ts src/client/src/controllers/workspaceController.sessionLists.test.ts src/client/src/controllers/sessionController.ts src/client/src/controllers/sessionController.refresh.test.ts
git commit -m "feat(client): add session-list provenance and list-only retry"
```

## Task 8: Bound Background Reconciliation by Intent

**Implementer tier:** Capable
**Lane:** background-reconciliation
**Depends on:** 6, 7

**Files:**

- Modify: `src/client/src/controllers/projectCatalogController.ts:1-260`
- Modify: `src/client/src/controllers/projectCatalogController.test.ts:1-300`
- Modify: `src/client/src/controllers/projectActivityOwnershipCoordinator.ts:1-300`
- Modify: `src/client/src/controllers/projectActivityOwnershipCoordinator.test.ts:1-300`
- Modify: `src/client/src/controllers/gitController.ts:1-260`
- Modify: `src/client/src/controllers/gitController.test.ts:1-360`
- Modify: `src/client/src/controllers/memoryController.ts:1-220`
- Modify: `src/client/src/controllers/memoryController.test.ts:1-300`
- Modify: `src/client/src/controllers/learnedSkillsController.ts:1-220`
- Modify: `src/client/src/controllers/learnedSkillsController.test.ts:1-300`
- Modify: `src/client/src/components/GitUpdateManagerPanel.ts:1-280`

**Interfaces:**

- Consumes `ReadIntent` and `runBackgroundRead` from Task 6 plus the controller publication/cancellation rules from Task 7.
- Produces explicit background intent for catalog polling, ownership discovery, Git polling, scheduled memory/skills polls, and realtime invalidation callers; explicit foreground intent for manual refresh, initial/selected loads, statistics, explicit Git reads, and mutation consequences.
- Keeps one background helper scope for Git status plus consequential selected diffs, cancels only an active background Git pass before a foreground read, skips polling while foreground Git work is pending, and preserves request-id guards.
- Keeps memory/learned-skills foreground priority over a running background read, without changing local behavior, poll cadence, stale-data handling, or genuine-error callbacks.
- Keeps project catalog single-flight/topology-order behavior and leaves cancelled ownership discovery eligible for later reconciliation.

- [ ] **Step 1: Write the failing call-site classification tests**

```ts
it("catalog bow out is silent and the next scheduled pass can succeed", async () => {
  const fixture = makeCatalogPollingFixture();
  const first = fixture.runScheduledPass();
  advanceTimersByTime(20_000);
  await first;
  expect(fixture.errorReports).toHaveLength(0);
  expect(fixture.topologyCaptureCount).toBe(1);
  await fixture.runNextScheduledPassSuccessfully();
  expect(fixture.projects).toEqual(fixture.nextProjects);
});

it("cancelled ownership discovery remains eligible without reporting an error", async () => {
  const fixture = makeOwnershipFixture();
  await fixture.cancelRunPass();
  expect(fixture.attemptedActivations).not.toContain("/repo");
  expect(fixture.errorReports).toHaveLength(0);
  await fixture.runNextReconciliation();
  expect(fixture.attemptedActivations).toContain("/repo");
});

it("bounds polling status and consequential diffs without shortening manual refresh", async () => {
  const fixture = makeGitFixture();
  const poll = fixture.startPollingPass();
  advanceTimersByTime(20_000);
  await poll;
  expect(fixture.backgroundStatus.signal.aborted).toBe(true);
  expect(fixture.backgroundDiff.signal.aborted).toBe(true);
  const manual = fixture.manualRefresh();
  advanceTimersByTime(20_001);
  fixture.resolveManual();
  await manual;
  expect(fixture.manualRequestWasNotTimedOut).toBe(true);
  expect(fixture.errorReports).toEqual(fixture.expectedGenuineErrors);
});

it("only polling snapshots bow out and a manual refresh retains foreground priority", async () => {
  const fixture = makeMemoryControllerFixture();
  const initial = fixture.initialLoad();
  advanceTimersByTime(20_001);
  fixture.resolveInitial();
  await initial;
  const poll = fixture.scheduledPoll();
  const manual = fixture.manualRefreshWhilePollRuns();
  advanceTimersByTime(20_000);
  await poll;
  fixture.resolveManual();
  await manual;
  expect(fixture.reads.map((read) => read.intent)).toEqual(["foreground", "background", "foreground"]);
  expect(fixture.errorState).toEqual(fixture.expectedErrorState);
});

it("only polling skill snapshots bow out and a manual refresh retains foreground priority", async () => {
  const fixture = makeLearnedSkillsControllerFixture();
  await fixture.initialLoad();
  const poll = fixture.scheduledPoll();
  const manual = fixture.manualRefreshWhilePollRuns();
  advanceTimersByTime(20_000);
  await poll;
  fixture.resolveManual();
  await manual;
  expect(fixture.reads.map((read) => read.intent)).toEqual(["foreground", "background", "foreground"]);
  expect(fixture.errorState).toEqual(fixture.expectedErrorState);
});
```

- [ ] **Step 2: Run the background controller tests and confirm they fail**

Run: `npm test -- --run src/client/src/controllers/projectCatalogController.test.ts src/client/src/controllers/projectActivityOwnershipCoordinator.test.ts src/client/src/controllers/gitController.test.ts src/client/src/controllers/memoryController.test.ts src/client/src/controllers/learnedSkillsController.test.ts`

Expected: FAIL because these reads currently have no explicit background scope, no 20-second cancellation, and no foreground promotion rule.

- [ ] **Step 3: Implement intent-specific helper ownership at each enumerated call site**

```ts
async function loadScheduledSnapshot(intent: ReadIntent): Promise<void> {
  const read = (signal?: AbortSignal) => this.fetchSnapshot(signal);
  try {
    const snapshot = this.machineId === "local" || intent === "foreground"
      ? await read(this.scope.signal)
      : await runBackgroundRead(this.machineId, read, this.scope.signal);
    if (this.scope.isCurrent(this.generation)) this.publish(snapshot);
  } catch (error) {
    if (isLoadCancellation(error)) return;
    this.reportError(error);
  }
}
```

Apply the same boundary deliberately rather than inferring intent from `void`, `reportError: false`, or `await`: scheduled 5-second catalog and 30-second memory/skills polls, realtime recovery, ownership discovery, and Git polling use `runBackgroundRead`; initial/explicit/manual/statistics/mutation-revalidation reads remain foreground. Add one explicit background scope around Git status plus consequential diffs, cancel it only when a foreground status/diff starts, invalidate its continuation, and skip polling during foreground work. Preserve the existing `CancellableLoadScope`, request IDs, topology capture, `Promise.allSettled`, stale-data, and poll cadence behavior.

- [ ] **Step 4: Run the focused background tests, then typecheck**

Run: `npm test -- --run src/client/src/controllers/projectCatalogController.test.ts src/client/src/controllers/projectActivityOwnershipCoordinator.test.ts src/client/src/controllers/gitController.test.ts src/client/src/controllers/memoryController.test.ts src/client/src/controllers/learnedSkillsController.test.ts`

Expected: PASS, including silent bow-out, later eligibility, one-scope Git status/diff behavior, full-budget manual reads, and foreground priority. Run `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/controllers/projectCatalogController.ts src/client/src/controllers/projectCatalogController.test.ts src/client/src/controllers/projectActivityOwnershipCoordinator.ts src/client/src/controllers/projectActivityOwnershipCoordinator.test.ts src/client/src/controllers/gitController.ts src/client/src/controllers/gitController.test.ts src/client/src/controllers/memoryController.ts src/client/src/controllers/memoryController.test.ts src/client/src/controllers/learnedSkillsController.ts src/client/src/controllers/learnedSkillsController.test.ts src/client/src/components/GitUpdateManagerPanel.ts
git commit -m "feat(client): bound background reconciliation reads"
```

## Task 9: Render Session-List Load Feedback

**Implementer tier:** Advanced
**Lane:** session-list-notice
**Depends on:** 7

**Files:**

- Create: `src/client/src/components/SessionListLoadNotice.ts:1-260`
- Create: `src/client/src/components/SessionListLoadNotice.test.ts:1-360`
- Modify: `src/client/src/components/SessionList.ts:1-1342`
- Modify: `src/client/src/components/SessionList.test.ts:1-360`

**Interfaces:**

- Consumes `Machine`, `SessionListLoad`, and `SessionListFailure` from Tasks 1 and 7.
- Produces `SESSION_LIST_NOTICE_DELAY_MS = 5_000`, `SESSION_LIST_NOTICE_TICK_MS = 1_000`, and `SessionListLoadNotice` with `machine?`, `load?`, `failure?`, `onRetry?`, `onRaiseLimit?`, and injectable `now`.
- Renders only for a matching human remote and owners `selection`/`retry`; catalog fallback, local, mismatch, and absent records render nothing.
- Uses a status region for waiting/receiving and an alert for failures, exact `m:ss` elapsed formatting, escaped machine text, scoped actions, and one owner clock that stops on terminal/scope/disconnect states.
- Places the notice in the existing navigation session-list section below its heading without altering rows, search, collapsed behavior, keyboard navigation, or main-pane/start-screen composition.

- [ ] **Step 1: Write the failing component tests**

```ts
it("shows a human remote wait at five seconds and updates once per second", async () => {
  const clock = fakeClock(1_000_000);
  const element = renderNotice({ machine: remoteMachine, load: selectionLoad(1_000_000), now: clock.now });
  expect(element.textContent).toBe("");
  clock.advance(4_999);
  await element.updateComplete;
  expect(element.textContent).toBe("");
  clock.advance(1);
  await element.updateComplete;
  expect(element.textContent).toContain("Loading sessions from Remote Lab… 0:05 of 2:00");
  expect(renderNotice({ machine: localMachine, load: selectionLoad(1_000_000) }).textContent).toBe("");
  expect(renderNotice({ machine: remoteMachine, load: catalogFallbackLoad(1_000_000) }).textContent).toBe("");
  expect(renderNotice({ machine: remoteMachine, load: selectionLoad(1_000_000, "/other") }).textContent).toBe("");
});

it("shows receiving before any body byte without a budget countdown", async () => {
  const clock = fakeClock(1_000_000);
  const element = renderNotice({ machine: remoteMachine, load: selectionLoad(1_000_000, "/repo", "receiving"), now: clock.now });
  await element.updateComplete;
  expect(element.getAttribute("role")).toBe("status");
  expect(element.textContent).toContain("Receiving sessions from Remote Lab…");
  clock.advance(200_000);
  await element.updateComplete;
  expect(element.textContent).not.toContain("of");
  element.failure = timeoutFailure(1_200_000);
  await element.updateComplete;
  expect(activeIntervals()).toHaveLength(0);
});

it("renders both typed failures with elapsed and the two scoped actions", async () => {
  const retry = vi.fn();
  const raise = vi.fn();
  const timeout = renderNotice({ machine: remoteMachine, failure: timeoutFailure(1_002_000), onRetry: retry, onRaiseLimit: raise });
  expect(timeout.getAttribute("role")).toBe("alert");
  expect(timeout.textContent).toContain("Remote Lab didn't answer within 2:00");
  expect(timeout.textContent).toContain("Waited 0:02.");
  clickButton(timeout, "Try again");
  clickButton(timeout, "Raise limit");
  expect(retry).toHaveBeenCalledOnce();
  expect(raise).toHaveBeenCalledOnce();
  const transfer = renderNotice({ machine: remoteMachine, failure: transferFailure(1_003_000, "Remote <Lab>") });
  expect(transfer.textContent).toContain("stopped responding while sending sessions");
  expect(transfer.innerHTML).not.toContain("<Lab>");
  expect(activeIntervals()).toHaveLength(0);
});

it("renders remote load feedback inside the navigation session section", async () => {
  const list = renderSessionList({ sessionListLoad: selectionLoad(1_000_000), machine: remoteMachine, rows: existingRows });
  expect(list.querySelector("session-list-load-notice")).not.toBeNull();
  expect(list.querySelectorAll(".session-row")).toHaveLength(existingRows.length);
  expect(list.querySelector(".main-pane-only-notice")).toBeNull();
});
```

- [ ] **Step 2: Run the component tests and confirm they fail**

Run: `npm test -- --run src/client/src/components/SessionListLoadNotice.test.ts src/client/src/components/SessionList.test.ts`

Expected: FAIL because the notice element and SessionList props/render branch do not exist.

- [ ] **Step 3: Implement the clock-owned notice and SessionList placement**

```ts
export const SESSION_LIST_NOTICE_DELAY_MS = 5_000;
export const SESSION_LIST_NOTICE_TICK_MS = 1_000;

@customElement("session-list-load-notice")
export class SessionListLoadNotice extends LitElement {
  @property({ attribute: false }) machine?: Machine;
  @property({ attribute: false }) load?: SessionListLoad;
  @property({ attribute: false }) failure?: SessionListFailure;
  @property({ attribute: false }) onRetry?: () => void | Promise<void>;
  @property({ attribute: false }) onRaiseLimit?: () => void;
  @property({ attribute: false }) now: () => number = Date.now;
  private interval?: number;

  connectedCallback(): void { super.connectedCallback(); this.syncClock(); }
  disconnectedCallback(): void { this.stopClock(); super.disconnectedCallback(); }
  protected updated(): void { this.syncClock(); }

  private syncClock(): void {
    const visible = this.machine?.kind === "remote" && this.load?.owner !== "catalog-fallback" && this.load !== undefined && this.failure === undefined;
    if (visible && this.interval === undefined) {
      this.interval = window.setInterval(() => this.requestUpdate(), SESSION_LIST_NOTICE_TICK_MS);
    } else if (!visible && this.interval !== undefined) this.stopClock();
  }

  private stopClock(): void {
    if (this.interval !== undefined) window.clearInterval(this.interval);
    this.interval = undefined;
  }

  protected render(): TemplateResult {
    if (this.failure !== undefined) return html`<div role="alert">...</div>`;
    if (!this.isDisplayableLoad()) return nothing;
    if (this.load!.phase === "receiving") return html`<div role="status">Receiving sessions from ${this.machine!.name}…</div>`;
    const elapsed = Math.max(0, this.now() - this.load!.startedAt);
    return elapsed < SESSION_LIST_NOTICE_DELAY_MS ? nothing : html`<div role="status">Loading sessions from ${this.machine!.name}… ${formatElapsed(elapsed)} of ${formatElapsed(this.load!.budgetMs)}</div>`;
  }
}
```

Use Lit interpolation for machine names and exact failure/action wording. In `SessionList`, accept the notice properties and render `<session-list-load-notice>` below the section heading before ordinary rows. Do not move feedback into `sessionEmptyMessage` or add a stale-list branch.

- [ ] **Step 4: Run the focused component tests and typecheck**

Run: `npm test -- --run src/client/src/components/SessionListLoadNotice.test.ts src/client/src/components/SessionList.test.ts`

Expected: PASS, with immediate receiving visibility, correct delayed waiting text/ticks, no failure timer, scope filtering, escaped text, both actions, and unchanged rows. Run `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/SessionListLoadNotice.ts src/client/src/components/SessionListLoadNotice.test.ts src/client/src/components/SessionList.ts src/client/src/components/SessionList.test.ts
git commit -m "feat(ui): show remote session-list progress and failures"
```

## Task 10: Add Machine Editing and Wire the App

**Implementer tier:** Capable
**Lane:** machine-edit-and-app
**Depends on:** 6, 7, 9

**Files:**

- Modify: `src/client/src/controllers/machineController.ts:1-190`
- Modify: `src/client/src/components/MachineDialog.ts:1-192`
- Modify: `src/client/src/components/MachineDialog.test.ts:1-420`
- Modify: `src/client/src/components/MachineList.ts:1-168`
- Modify: `src/client/src/components/MachineList.test.ts:1-260`
- Modify: `src/client/src/components/MachineSwitcher.ts:1-363`
- Modify: `src/client/src/components/MachineSwitcher.test.ts:1-260`
- Modify: `src/client/src/components/appShell/AppNavigationPanel.ts:1-368`
- Modify: `src/client/src/components/PiWebUiApp.ts:1-5262`
- Create: `src/client/src/components/PiWebUiApp.remoteTimeout.test.ts:1-500`

**Interfaces:**

- Consumes `machinesApi.updateMachine`, shared machine request types/validator, `effectiveMachineRequestTimeoutMs`, app-state records, `WorkspaceController.retrySessionList`, and `SessionListLoadNotice` props from Tasks 1, 6, 7, and 9.
- Produces `MachineController.updateMachine(machineId, patch): Promise<Machine>` that replaces one public machine in state without selecting/resetting workspace/session state.
- Extends `MachineDialogSubmit` with required `requestTimeoutMs`, adds `machine?` and `focusRequestTimeout`, parses decimal seconds with one-to-three fractional digits exactly, and omits a blank unchanged token on edit.
- Adds independent `onEdit` actions to both machine menus, excludes local edit/remove actions, closes the menu, stops row selection propagation, and forwards the actual remote machine.
- Wires load/failure/retry/raise-limit records through `PiWebUiApp` → `AppNavigationPanel` → `SessionList`; preserves the start-screen predicate requiring no `sessionListFailure`, keeps unrelated `state.error` visible, and uses guarded dialog generation for create/edit/raise-limit submits.
- Keeps statistics, explicit snapshot refreshes, selected-machine behavior, session/draft/attachment state, and edit of an unselected machine unchanged.

- [ ] **Step 1: Write the failing dialog/menu/app integration tests**

```ts
it("edits patience in seconds and retains rejected input", async () => {
  const element = renderMachineDialog({ machine: remoteMachine, focusRequestTimeout: true });
  expect(inputValue(element, "requestTimeoutMs")).toBe("120");
  expect(inputValue(element, "requestTimeoutMs").selectionStart).toBeDefined();
  setInput(element, "requestTimeoutMs", "5.001");
  await submit(element);
  expect(submitted).toMatchObject({ requestTimeoutMs: 5_001 });
  setInput(element, "requestTimeoutMs", "1e2");
  await submit(element);
  expect(element.textContent).toContain("Request timeout");
  expect(inputValue(element, "requestTimeoutMs")).toBe("1e2");
  expect(element.textContent).toContain("requestTimeoutMs must be an integer between 5000 and 180000 milliseconds");
  expect(element.querySelector("input[name=requestTimeoutMs]")?.matches(":focus")).toBe(true);
  expect(lastPatch).not.toHaveProperty("token");
});

it("edits the menu machine without selecting it", async () => {
  const edit = vi.fn();
  const select = vi.fn();
  const list = renderMachineList({ machines: [localMachine, remoteMachine], onEdit: edit, onSelect: select });
  clickMenuAction(list, remoteMachine, "Edit");
  expect(edit).toHaveBeenCalledWith(remoteMachine);
  expect(select).not.toHaveBeenCalled();
  expect(renderedAction(list, localMachine, "Edit")).toBeNull();
});

it("edits from the switcher actions menu through the shared callback", async () => {
  const edit = vi.fn();
  const select = vi.fn();
  const switcher = renderMachineSwitcher({ machines: [localMachine, remoteMachine], onEdit: edit, onSelect: select });
  clickMenuAction(switcher, remoteMachine, "Edit");
  expect(edit).toHaveBeenCalledWith(remoteMachine);
  expect(select).not.toHaveBeenCalled();
  expect(menuIsOpen(switcher)).toBe(false);
  expect(renderedAction(switcher, localMachine, "Edit")).toBeNull();
});

it("shows retry failure with a session open and keeps the start screen hidden", async () => {
  const app = renderAppWithOpenSession({ sessionListFailure: timeoutFailure(1_002_000) });
  expect(app.querySelector("session-list-load-notice")?.textContent).toContain("Try again");
  expect(app.querySelector("main-session-pane")).not.toBeNull();
  expect(app.shouldShowSessionStartScreen()).toBe(false);
});

it("an unrelated error after a timeout still appears in the banner", async () => {
  const app = renderAppWithState({ sessionListFailure: timeoutFailure(1_002_000), error: "unrelated error" });
  expect(app.querySelector("[role=alert]")?.textContent).toContain("unrelated error");
  clickButton(app, "Try again");
  expect(app.querySelector("[role=alert]")?.textContent).toContain("unrelated error");
});

it("routes Raise limit and both Edit actions to the same guarded dialog", async () => {
  const app = renderAppWithFailure({ selectedMachine: remoteMachine });
  clickButton(app, "Raise limit");
  expect(app.machineDialogTarget?.id).toBe("remote-lab");
  expect(app.machineDialogFocusRequestTimeout).toBe(true);
  const stale = app.submitOldDialogLater();
  app.openNewMachineDialog();
  await stale;
  expect(app.state.machineDialogOpen).toBe(true);
  await app.saveCurrentEdit({ requestTimeoutMs: 90_000 });
  expect(app.state.selectedMachine?.id).toBe("remote-lab");
  expect(app.workspaceResetCount).toBe(0);
});

it("keeps statistics deletion refresh and explicit snapshot refresh untimed", async () => {
  const app = renderAppWithCallSiteSpies();
  await app.showProjectStatistics();
  await app.onRefreshMemory();
  app.emitRealtimeInvalidation("/repo");
  expect(app.foregroundCalls.every((call) => call.usesBackgroundHelper === false)).toBe(true);
  expect(app.realtimeCalls.every((call) => call.intent === "background")).toBe(true);
});
```

- [ ] **Step 2: Run the component/app tests and confirm they fail**

Run: `npm test -- --run src/client/src/components/MachineDialog.test.ts src/client/src/components/MachineList.test.ts src/client/src/components/MachineSwitcher.test.ts src/client/src/components/PiWebUiApp.remoteTimeout.test.ts`

Expected: FAIL because the timeout field, update action, menu edit callbacks, navigation props, and app-owned guarded wiring do not exist.

- [ ] **Step 3: Implement decimal timeout editing and guarded app wiring**

```ts
const TIMEOUT_SECONDS_PATTERN = /^(?:\d+)(?:\.\d{1,3})?$/u;

function parseTimeoutSeconds(raw: string): number {
  const value = raw.trim();
  if (!TIMEOUT_SECONDS_PATTERN.test(value)) throw new Error("Invalid request timeout");
  const [whole, fraction = ""] = value.split(".");
  const milliseconds = Number(whole) * 1_000 + Number(fraction.padEnd(3, "0"));
  return validateMachineRequestTimeoutMs(milliseconds);
}

async updateMachine(machineId: string, patch: MachineUpdateRequest): Promise<Machine> {
  this.setState({ error: "" });
  try {
    const machine = await api.updateMachine(machineId, patch);
    this.setState({ machines: this.getState().machines.map((candidate) => candidate.id === machine.id ? machine : candidate) });
    return machine;
  } catch (error) {
    this.setState({ error: String(error) });
    throw error;
  }
}
```

Seed the dialog only when the edit/create identity changes: existing machine values use `effectiveMachineRequestTimeoutMs(machine) / 1000`, create uses `120`; `focusRequestTimeout` focuses the timeout DOM input after rendering. Preserve rejected values on ordinary rerenders. Send `{ name, baseUrl, requestTimeoutMs, ...(token.trim() === "" ? {} : { token }) }` on create; on edit omit blank token and call `updateMachine`. Keep generation checks around every async close/error result. Wire both menu `onEdit` callbacks independently of `onRemove`, and pass `sessionListLoad`, `sessionListFailure`, `onRetrySessionList`, and `onRaiseSessionListLimit` through the navigation hierarchy. Ensure raise-limit validates the captured failure scope before opening the same dialog.

- [ ] **Step 4: Run the focused UI tests and typecheck**

Run: `npm test -- --run src/client/src/components/MachineDialog.test.ts src/client/src/components/MachineList.test.ts src/client/src/components/MachineSwitcher.test.ts src/client/src/components/PiWebUiApp.remoteTimeout.test.ts`

Expected: PASS, including DOM focus, millisecond-precise decimal parsing, rejected-input retention/exact server error, independent menu edit actions, selected-session preservation, start-screen gating, unrelated banner errors, stale dialog generation protection, and explicit foreground/background call-site classification. Run `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/controllers/machineController.ts src/client/src/components/MachineDialog.ts src/client/src/components/MachineDialog.test.ts src/client/src/components/MachineList.ts src/client/src/components/MachineList.test.ts src/client/src/components/MachineSwitcher.ts src/client/src/components/MachineSwitcher.test.ts src/client/src/components/appShell/AppNavigationPanel.ts src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.remoteTimeout.test.ts
git commit -m "feat(ui): edit remote machine patience and show retry state"
```

## Task 11: Document Operational Limits and Release Notes

**Implementer tier:** Standard
**Lane:** docs-release
**Depends on:** 10

**Files:**

- Modify: `docs/machines.html:1-306`
- Modify: `docs/config.md:173-210`
- Modify: `docs/config.html:536-590`
- Create: `.changeset/remote-http-timeout-resilience.md:1-6`

**Interfaces:**

- Consumes the implemented user-facing behavior from Tasks 1–10; this task does not change runtime or client code.
- Documents the gateway-owned remote-record setting, absent-value default of 120 000 ms, allowed range, both machine edit entry points, session-list Retry/Raise limit, 20 000 ms background bow-out, 10 000 ms plugin-manifest limit, unbounded post-header body transfer, uncancellable daemon enumeration, reverse-proxy/old-gateway/nested-federation limits, and next-request/no-session-restart refresh semantics.
- Keeps `README.md` concise and does not present the managed registry as a user-editable core config API.
- Keeps `docs/config.md` and `docs/config.html` synchronized when describing the setting, with scope `gateway-owned remote record`, absence `120,000 ms`, precedence `probes/operation overrides before machine default`, and refresh `next request; no session restart`.
- Produces one `.changeset/remote-http-timeout-resilience.md` fragment with a `minor` bump for `@hyperdreamer/pi-webui`; do not edit `CHANGELOG.md`, package versions, or publish.

- [ ] **Step 1: Write documentation assertions and the changeset content**

```md
---
"@hyperdreamer/pi-webui": minor
---

Add configurable remote request patience, session-list progress and Retry/Raise limit controls, machine editing, and bounded background reads.
```

Use the existing documentation test/inspection conventions to assert the rendered and Markdown representations contain the same setting facts. The authored sections must state that a remote machine's `requestTimeoutMs` is a gateway-owned record field, absent means `120,000 ms`, valid values are `5–180 seconds`, explicit `120000` resets to the default, probes and operation-specific overrides take precedence, and changes apply to the next request without a session restart. Cover both edit menus and the patience field, human session-list waiting/receiving/typed failure actions, Retry preserving an open session, 20-second background bow-out, 10-second plugin manifest, body transfer after headers, daemon enumeration continuing, and shorter reverse proxies/old gateways/nested federation limiting the result.

- [ ] **Step 2: Run the documentation checks before editing and confirm the required statements are absent or incomplete**

Run: `npm run typecheck` and the repository's documentation/lint check used for `docs/`.

Expected: the runtime suite remains unaffected, while the new documentation assertions or manual content review identifies the missing operational guidance.

- [ ] **Step 3: Update only the three documentation representations and add one changeset**

Add concise sections to `docs/machines.html`, and keep the corresponding config reference paragraphs synchronized in `docs/config.md` and `docs/config.html`. Preserve the existing HTML structure and links. Create only `.changeset/remote-http-timeout-resilience.md` with the exact package name and minor bump shown above. Do not create a second fragment or manually edit generated changelog/version files.

- [ ] **Step 4: Run documentation checks and the complete implementation acceptance commands**

Run:

```bash
npm test -- --run src/shared/machineRequestTimeout.test.ts src/server/machines/machineStore.test.ts src/server/machines/machineService.test.ts src/server/machines/machineClient.test.ts
npm test -- --run src/server/http/replyDisconnect.test.ts src/server/machines/machineProxyRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/sessiond/sessionDaemonClient.test.ts src/server/app.compression.test.ts
npm test -- --run src/client/src/api/http.test.ts src/client/src/api/clients.test.ts src/client/src/api/parsers.test.ts src/client/src/controllers/backgroundRead.test.ts
npm test -- --run src/client/src/controllers/workspaceController.test.ts src/client/src/controllers/workspaceController.cancellation.test.ts src/client/src/controllers/sessionController.refresh.test.ts src/client/src/controllers/projectCatalogController.test.ts src/client/src/controllers/projectActivityOwnershipCoordinator.test.ts src/client/src/controllers/gitController.test.ts src/client/src/controllers/memoryController.test.ts src/client/src/controllers/learnedSkillsController.test.ts
npm test -- --run src/client/src/components/SessionListLoadNotice.test.ts src/client/src/components/SessionList.test.ts src/client/src/components/MachineDialog.test.ts src/client/src/components/MachineList.test.ts src/client/src/components/MachineSwitcher.test.ts src/client/src/components/PiWebUiApp.remoteTimeout.test.ts
npm run typecheck
npm run verify
```

Expected: all focused layers, type checking, full verification, and documentation checks pass. Confirm the evidence includes delayed first-body-chunk flush under real compression, full cancellation chain with a separate accepted mutation, foreground queue precedence, same-scope supersession, list-only Retry, and unrelated-error-after-timeout behavior.

- [ ] **Step 5: Commit**

```bash
git add docs/machines.html docs/config.md docs/config.html .changeset/remote-http-timeout-resilience.md
git commit -m "docs: document remote timeout resilience"
```
