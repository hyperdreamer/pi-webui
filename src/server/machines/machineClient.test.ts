import { getEventListeners, once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createSessionDaemonApp } from "../sessiond/sessionDaemonApp.js";
import {
  DEFAULT_REMOTE_HEALTH_TIMEOUT_MS,
  DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
  RemoteMachineClient,
  type MachineRequestOptions,
} from "./machineClient.js";

describe("RemoteMachineClient", () => {
  it("forwards raw binary request bodies with the provided content type", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response("ok", { status: 200 })));
    const client = new RemoteMachineClient({ baseUrl: "https://remote.example.test/" }, fetchImpl);
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    await client.request("PUT", "/api/projects/p1/workspaces/w1/file?path=image.png", payload, { contentType: "image/png" });

    const { input, init } = onlyFetchCall(fetchImpl);
    expect(fetchInputUrl(input)).toBe("https://remote.example.test/api/projects/p1/workspaces/w1/file?path=image.png");
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).get("content-type")).toBe("image/png");
    if (!(init.body instanceof ArrayBuffer)) throw new Error("Expected binary request body");
    expect(Array.from(new Uint8Array(init.body))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("serializes structured request bodies as JSON by default", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response("ok", { status: 200 })));
    const client = new RemoteMachineClient({ baseUrl: "https://remote.example.test/base/", token: "secret" }, fetchImpl);

    await client.request("POST", "/api/sessions", { cwd: "/repo" });

    const { input, init } = onlyFetchCall(fetchImpl);
    expect(fetchInputUrl(input)).toBe("https://remote.example.test/base/api/sessions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ cwd: "/repo" }));
  });

  it("requests compression for the remote hop even when configured headers use different casing", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response("ok", { status: 200 })));
    const client = new RemoteMachineClient({
      baseUrl: "https://remote.example.test/",
      headers: { "Accept-Encoding": "identity" },
    }, fetchImpl);

    await client.request("GET", "/api/projects");

    const { init } = onlyFetchCall(fetchImpl);
    expect(new Headers(init.headers).get("accept-encoding")).toBe("gzip, deflate");
  });

  it("removes stale representation headers after Fetch decodes a compressed response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": "31",
      },
    })));
    const client = new RemoteMachineClient({ baseUrl: "https://remote.example.test/" }, fetchImpl);

    const response = await client.requestJson("GET", "/api/projects");

    expect(response.body).toEqual({ ok: true });
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers["content-length"]).toBeUndefined();
  });
});

describe("RemoteMachineClient request deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    settleDeferredBodies();
    vi.useRealTimers();
  });

  it("keeps the shared 120 second default and the separate three second health budget", () => {
    expect(DEFAULT_REMOTE_REQUEST_TIMEOUT_MS).toBe(120_000);
    expect(DEFAULT_REMOTE_HEALTH_TIMEOUT_MS).toBe(3_000);
  });

  it("resolves call override then machine timeout then 120 second default", async () => {
    const cases: { machine: { requestTimeoutMs?: number }; options: MachineRequestOptions; deadline: number }[] = [
      { machine: { requestTimeoutMs: 90_000 }, options: {}, deadline: 90_000 },
      { machine: {}, options: {}, deadline: 120_000 },
      { machine: { requestTimeoutMs: 90_000 }, options: { timeoutMs: 300_000 }, deadline: 300_000 },
    ];

    for (const testCase of cases) {
      const fetchImpl = new DeferredFetch();
      const client = new RemoteMachineClient(remoteMachine(testCase.machine.requestTimeoutMs), fetchImpl.fetchImpl);
      const pending = client.request("GET", "/api/sessions?cwd=%2Frepo", undefined, testCase.options);
      const rejection = expect(pending).rejects.toMatchObject({ statusCode: 504, message: "Remote machine request timed out" });

      await vi.advanceTimersByTimeAsync(testCase.deadline - 1);
      expect(fetchImpl.signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await rejection;

      expect(fetchImpl.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("clears its deadline at headers while preserving caller body cancellation", async () => {
    const body = deferredReadableBody(500);
    const caller = new AbortController();
    const fetchImpl = new DeferredFetch();
    const client = new RemoteMachineClient(remoteMachine(5_000), fetchImpl.fetchImpl);

    const pending = client.request("GET", "/sessions", undefined, { signal: caller.signal });
    fetchImpl.resolveHeaders(body.response);
    const response = await pending;
    expect(response.statusCode).toBe(500);
    const readable = response.body;
    if (readable === undefined) throw new Error("Expected a response body");
    const failure = onceStreamError(readable);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(fetchImpl.signal?.aborted).toBe(false);

    const reason = new Error("caller stopped");
    caller.abort(reason);

    await expect(failure).resolves.toBe(reason);
    expect(body.cancelled).toBe(true);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });

  it("distinguishes caller abort from its own header deadline", async () => {
    const fetchImpl = new DeferredFetch();
    const client = new RemoteMachineClient(remoteMachine(), fetchImpl.fetchImpl);
    const preAborted = new AbortController();
    preAborted.abort(new Error("already stopped"));

    await expect(client.request("GET", "/sessions", undefined, { signal: preAborted.signal })).rejects.toThrow("already stopped");
    expect(fetchImpl.callCount).toBe(0);

    const caller = new AbortController();
    const callerReason = new Error("caller stopped");
    const callerPending = client.request("GET", "/sessions", undefined, { signal: caller.signal });
    caller.abort(callerReason);

    await expect(callerPending).rejects.toBe(callerReason);
    expect(vi.getTimerCount()).toBe(0);

    const deadlinePending = client.request("GET", "/sessions");
    const deadlineRejection = expect(deadlinePending).rejects.toMatchObject({ statusCode: 504 });
    await vi.advanceTimersByTimeAsync(DEFAULT_REMOTE_REQUEST_TIMEOUT_MS);
    await deadlineRejection;
    expect(vi.getTimerCount()).toBe(0);

    const networkPending = client.request("GET", "/sessions");
    fetchImpl.rejectLatest(new Error("connection refused"));
    await expect(networkPending).rejects.toMatchObject({ statusCode: 502, message: "connection refused" });

    // A transport abort nobody in this client owns is not this client's deadline.
    const unownedPending = client.request("GET", "/sessions");
    fetchImpl.rejectLatest(new DOMException("transport aborted independently", "AbortError"));
    await expect(unownedPending).rejects.toMatchObject({ statusCode: 502, message: "transport aborted independently" });
  });

  it("stops before reading a JSON body when the caller already cancelled", async () => {
    const body = deferredTextBody();
    const caller = new AbortController();
    const fetchImpl = new DeferredFetch();
    const client = new RemoteMachineClient(remoteMachine(), fetchImpl.fetchImpl);
    const pending = client.requestJson("GET", "/config", undefined, { signal: caller.signal });

    // The abort lands after the client's header continuation but before requestJson
    // starts consuming the body, so the body read must never begin.
    fetchImpl.resolveHeaders(body.response);
    await Promise.resolve();
    const reason = new Error("cancel before read");
    caller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(body.textStarted).toBe(false);
    expect(body.cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });

  it("disposes a response body that arrives after cancellation already won", async () => {
    const body = deferredReadableBody();
    const caller = new AbortController();
    let deliver: ((response: Response) => void) | undefined;
    // This fetch ignores the abort signal, so headers can land after cancellation.
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { deliver = resolve; }));
    const client = new RemoteMachineClient(remoteMachine(5_000), fetchImpl);
    const pending = client.request("GET", "/sessions", undefined, { signal: caller.signal });

    const reason = new Error("caller stopped");
    caller.abort(reason);
    deliver?.(body.response);

    await expect(pending).rejects.toBe(reason);
    expect(body.cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });

  it("keeps the caller reason when a late response body refuses cleanup", async () => {
    const body = deferredReadableBody(200, { rejectCancel: true });
    const caller = new AbortController();
    let deliver: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { deliver = resolve; }));
    const client = new RemoteMachineClient(remoteMachine(), fetchImpl);
    const pending = client.request("GET", "/sessions", undefined, { signal: caller.signal });

    const reason = new Error("caller stopped");
    caller.abort(reason);
    deliver?.(body.response);

    await expect(pending).rejects.toBe(reason);
    expect(body.cancelled).toBe(true);
  });

  it("propagates the owned reason at late headers without waiting for body cleanup", async () => {
    const body = deferredReadableBody(200, { pendingCancel: true });
    const caller = new AbortController();
    let deliver: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { deliver = resolve; }));
    const client = new RemoteMachineClient(remoteMachine(5_000), fetchImpl);
    const pending = client.request("GET", "/sessions", undefined, { signal: caller.signal });
    const outcome = observeSettlement(pending);

    const reason = new Error("caller stopped");
    caller.abort(reason);
    deliver?.(body.response);

    await flushPromises();

    // Cleanup is only started; it may stay pending forever behind a tee'd sibling.
    expect(outcome.value()).toStrictEqual({ status: "rejected", value: reason });
    expect(body.cancelled).toBe(true);
    expect(body.cancelSettled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });

  it("propagates the owned reason at the JSON handoff without waiting for body cleanup", async () => {
    const body = deferredTextBody({ pendingCancel: true });
    const caller = new AbortController();
    const fetchImpl = new DeferredFetch();
    const client = new RemoteMachineClient(remoteMachine(), fetchImpl.fetchImpl);
    const pending = client.requestJson("GET", "/config", undefined, { signal: caller.signal });
    const outcome = observeSettlement(pending);

    fetchImpl.resolveHeaders(body.response);
    await Promise.resolve();
    const reason = new Error("cancel before read");
    caller.abort(reason);

    await flushPromises();

    expect(outcome.value()).toStrictEqual({ status: "rejected", value: reason });
    expect(body.textStarted).toBe(false);
    expect(body.cancelled).toBe(true);
    expect(body.cancelSettled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });

  it("propagates the owned reason for a native cloned response with an unfinished sibling", async () => {
    const source = new Response(new ReadableStream<Uint8Array>(), { status: 200 });
    const sibling = source.clone();
    const caller = new AbortController();
    let deliver: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { deliver = resolve; }));
    const client = new RemoteMachineClient(remoteMachine(), fetchImpl);
    const pending = client.request("GET", "/sessions", undefined, { signal: caller.signal });
    const outcome = observeSettlement(pending);

    const reason = new Error("caller stopped");
    caller.abort(reason);
    deliver?.(source);

    await flushPromises();

    // A tee branch's cancel resolves only once its sibling cancels too.
    expect(outcome.value()).toStrictEqual({ status: "rejected", value: reason });
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);

    await sibling.body?.cancel();
  });

  it("keeps requestJson caller cancellation until body completion", async () => {
    const body = deferredTextBody();
    const caller = new AbortController();
    const fetchImpl = new DeferredFetch();
    const client = new RemoteMachineClient(remoteMachine(), fetchImpl.fetchImpl);
    const pending = client.requestJson("GET", "/config", undefined, { signal: caller.signal });
    fetchImpl.resolveHeaders(body.response);
    await flushPromises();

    expect(body.textStarted).toBe(true);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(1);

    const reason = new Error("cancel json");
    caller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });

  it("detaches the caller listener after a completed JSON response", async () => {
    const body = deferredTextBody();
    const caller = new AbortController();
    const fetchImpl = new DeferredFetch();
    const client = new RemoteMachineClient(remoteMachine(5_000), fetchImpl.fetchImpl);
    const pending = client.requestJson("GET", "/config", undefined, { signal: caller.signal });
    fetchImpl.resolveHeaders(body.response);
    body.write("{\"ok\":true}");

    await expect(pending).resolves.toMatchObject({ body: { ok: true } });
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });

  it("cleans up no body and failed body adapters", async () => {
    await assertNoOwnedResourcesAfterNoBodyResponse();
    await assertNoOwnedResourcesAfterReadableAdapterFailure();
    await assertNoOwnedResourcesAfterBodyFailure();
  });
});

type RemoteMachineClientMachine = ConstructorParameters<typeof RemoteMachineClient>[0];

interface DeferredFetchCall {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (response: Response) => void;
  readonly reject: (error: unknown) => void;
}

class DeferredFetch {
  private readonly calls: DeferredFetchCall[] = [];

  readonly fetchImpl = vi.fn<typeof fetch>((input, init = {}) => new Promise<Response>((resolve, reject) => {
    const signal = init.signal ?? undefined;
    this.calls.push({ input, init, signal, resolve, reject });
    signal?.addEventListener("abort", () => { reject(new DOMException("The operation was aborted", "AbortError")); }, { once: true });
  }));

  get callCount(): number {
    return this.calls.length;
  }

  get signal(): AbortSignal | undefined {
    return this.latest().signal;
  }

  resolveHeaders(response: Response): void {
    this.latest().resolve(response);
  }

  rejectLatest(error: unknown): void {
    this.latest().reject(error);
  }

  private latest(): DeferredFetchCall {
    const call = this.calls[this.calls.length - 1];
    if (call === undefined) throw new Error("Expected a fetch call");
    return call;
  }
}

function remoteMachine(requestTimeoutMs?: number): RemoteMachineClientMachine {
  return {
    baseUrl: "https://remote.example.test/",
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  };
}

const deferredBodyCleanups: (() => void)[] = [];

function settleDeferredBodies(): void {
  for (const cleanup of deferredBodyCleanups.splice(0)) cleanup();
}

interface DeferredBodyOptions {
  rejectCancel?: boolean;
  /** Leaves the source cancel promise pending until test cleanup releases it. */
  pendingCancel?: boolean;
}

function deferredReadableBody(status = 200, options: DeferredBodyOptions = {}) {
  const state: { controller?: ReadableStreamDefaultController<Uint8Array>; releaseCancel?: () => void } = {};
  let cancelled = false;
  let cancelSettled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { state.controller = controller; },
    cancel() {
      cancelled = true;
      if (options.pendingCancel === true) {
        return new Promise<void>((resolve) => {
          state.releaseCancel = () => {
            cancelSettled = true;
            resolve();
          };
        });
      }
      if (options.rejectCancel === true) throw new Error("body cleanup refused");
      return undefined;
    },
  });
  const settle = (): void => {
    try {
      state.controller?.close();
    } catch {
      // The stream already settled or was cancelled.
    }
    state.releaseCancel?.();
  };
  deferredBodyCleanups.push(settle);
  return {
    response: new Response(stream, { status, headers: { "content-type": "application/octet-stream" } }),
    get cancelled() { return cancelled; },
    get cancelSettled() { return cancelSettled; },
    fail(error: Error) {
      state.controller?.error(error);
    },
  };
}

function deferredTextBody(options: DeferredBodyOptions = {}) {
  const state: { controller?: ReadableStreamDefaultController<Uint8Array>; releaseCancel?: () => void } = {};
  let cancelled = false;
  let cancelSettled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { state.controller = controller; },
    cancel() {
      cancelled = true;
      if (options.pendingCancel === true) {
        return new Promise<void>((resolve) => {
          state.releaseCancel = () => {
            cancelSettled = true;
            resolve();
          };
        });
      }
      return undefined;
    },
  });
  const response = new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
  let textStarted = false;
  const readText = response.text.bind(response);
  response.text = () => {
    textStarted = true;
    return readText();
  };
  const settle = (): void => {
    try {
      state.controller?.close();
    } catch {
      // The stream already settled or was cancelled.
    }
    state.releaseCancel?.();
  };
  deferredBodyCleanups.push(settle);
  return {
    response,
    get textStarted() { return textStarted; },
    get cancelled() { return cancelled; },
    get cancelSettled() { return cancelSettled; },
    write(text: string) {
      state.controller?.enqueue(new TextEncoder().encode(text));
      settle();
    },
  };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

interface Settlement {
  status: "fulfilled" | "rejected";
  value: unknown;
}

/** Records a promise's outcome without awaiting it, so a hang stays observable. */
function observeSettlement<T>(promise: Promise<T>): { value: () => Settlement | undefined } {
  let settlement: Settlement | undefined;
  void promise.then(
    (value) => { settlement = { status: "fulfilled", value }; },
    (error: unknown) => { settlement = { status: "rejected", value: error }; },
  );
  return { value: () => settlement };
}

function onceStreamError(stream: NodeJS.ReadableStream): Promise<unknown> {
  return new Promise((resolve) => { stream.once("error", resolve); });
}

async function assertNoOwnedResourcesAfterNoBodyResponse(): Promise<void> {
  const caller = new AbortController();
  const fetchImpl = new DeferredFetch();
  const client = new RemoteMachineClient(remoteMachine(5_000), fetchImpl.fetchImpl);
  const pending = client.request("GET", "/api/sessions", undefined, { signal: caller.signal });

  expect(getEventListeners(caller.signal, "abort")).toHaveLength(1);
  fetchImpl.resolveHeaders(new Response(null, { status: 204 }));
  const response = await pending;

  expect(response).not.toHaveProperty("body");
  expect(vi.getTimerCount()).toBe(0);
  expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
}

async function assertNoOwnedResourcesAfterReadableAdapterFailure(): Promise<void> {
  const caller = new AbortController();
  const fetchImpl = new DeferredFetch();
  const client = new RemoteMachineClient(remoteMachine(), fetchImpl.fetchImpl);
  const pending = client.request("GET", "/api/sessions", undefined, { signal: caller.signal });

  fetchImpl.resolveHeaders(responseWithUnusableBody());
  await expect(pending).rejects.toBeInstanceOf(TypeError);

  expect(vi.getTimerCount()).toBe(0);
  expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
}

async function assertNoOwnedResourcesAfterBodyFailure(): Promise<void> {
  const body = deferredReadableBody();
  const caller = new AbortController();
  const fetchImpl = new DeferredFetch();
  const client = new RemoteMachineClient(remoteMachine(), fetchImpl.fetchImpl);
  const pending = client.request("GET", "/api/sessions", undefined, { signal: caller.signal });

  fetchImpl.resolveHeaders(body.response);
  const response = await pending;
  const readable = response.body;
  if (readable === undefined) throw new Error("Expected a response body");
  const failure = onceStreamError(readable);
  const bodyError = new Error("body broke");
  body.fail(bodyError);

  await expect(failure).resolves.toBe(bodyError);
  expect(vi.getTimerCount()).toBe(0);
  expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
}

function responseWithUnusableBody(): Response {
  const response = new Response(null, { status: 200, headers: { "content-type": "application/octet-stream" } });
  // A faked fetch can hand back a body the Node response adapter cannot wrap.
  Object.defineProperty(response, "body", { value: { unusable: true } });
  return response;
}

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function onlyFetchCall(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>): { input: RequestInfo | URL; init: RequestInit } {
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const call = fetchImpl.mock.calls[0];
  if (call === undefined) throw new Error("Expected fetch call");
  const [input, init] = call;
  if (init === undefined) throw new Error("Expected fetch init");
  return { input, init };
}

async function awaitMachineMessage(socket: WebSocket): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      once(socket, "message"),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error("Machine socket deadline")); }, 2000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    socket.terminate();
  }
}

it("sends no Origin by default for machine HTTP and WebSocket traffic", async () => {
  const fetcher = vi.fn<typeof fetch>((_input, init) => { expect(new Headers(init?.headers).has("origin")).toBe(false); return Promise.resolve(new Response("{}")); });
  const app = await createSessionDaemonApp({ logger: false }); const seen: (string | undefined)[] = [];
  app.get("/socket", { websocket: true }, (s, r) => { seen.push(r.headers.origin); s.send("ready"); });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const client = new RemoteMachineClient({ baseUrl }, fetcher); await client.requestJson("POST", "/action", {});
    const socket = client.connectWebSocket("/socket"); await awaitMachineMessage(socket);
    expect(seen).toEqual([undefined]);
  } finally { await app.close(); }
});

it("preserves a configured machine Origin for HTTP and WebSocket traffic", async () => {
  const configured = "https://public.example:8443";
  const fetcher = vi.fn<typeof fetch>((_input, init) => { const h = new Headers(init?.headers); expect(h.get("origin")).toBe(configured); expect(h.has("cookie")).toBe(false); expect(h.get("authorization")).toBe("Bearer machine-token"); return Promise.resolve(new Response("{}")); });
  const app = await createSessionDaemonApp({ logger: false, allowedOrigins: [configured] }); const seen: (string | undefined)[] = [];
  app.get("/socket", { websocket: true }, (s, r) => { seen.push(r.headers.origin); expect(r.headers.cookie).toBeUndefined(); s.send("ready"); });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const client = new RemoteMachineClient({ baseUrl, token: "machine-token", headers: { oRiGiN: configured, Cookie: "blocked", Authorization: "blocked" } }, fetcher);
    await client.requestJson("POST", "/action", {});
    const socket = client.connectWebSocket("/socket"); await awaitMachineMessage(socket); expect(seen).toEqual([configured]);
  } finally { await app.close(); }
});

function observeMachineSocket(socket: WebSocket): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let complete = false; const timer = setTimeout(() => { socket.terminate(); reject(new Error("Machine handshake deadline")); }, 2000);
    const finish = (status: number, body: string) => { if (complete) return; complete = true; clearTimeout(timer); socket.terminate(); resolve({ status, body }); };
    socket.once("message", () => { finish(101, ""); });
    socket.once("unexpected-response", (_request, response) => { const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => { chunks.push(chunk); }); response.once("end", () => { finish(response.statusCode ?? 0, Buffer.concat(chunks).toString()); }); });
    socket.on("error", (error) => { if (!complete) { clearTimeout(timer); reject(error); } });
  });
}

async function guardedMachine(allowedOrigins: string[]) {
  const app = await createSessionDaemonApp({ allowedOrigins, logger: false }); const calls = { action: 0, socket: 0 };
  app.post("/action", () => { calls.action++; return { ok: true }; });
  app.get("/socket", { websocket: true }, (socket) => { calls.socket++; socket.send("ready"); });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 }); return { app, baseUrl, calls };
}

it("configured matching Origin works against an empty remote allowlist", async () => {
  const f = await guardedMachine([]);
  try {
    const client = new RemoteMachineClient({ baseUrl: f.baseUrl, headers: { oRiGiN: f.baseUrl } });
    expect((await client.requestJson("POST", "/action", {})).statusCode).toBe(200);
    expect((await observeMachineSocket(client.connectWebSocket("/socket"))).status).toBe(101);
    expect(f.calls).toEqual({ action: 1, socket: 1 });
  } finally { await f.app.close(); }
});

it("configured foreign Origin requires the remote startup allowlist", async () => {
  const configured = "https://public.example:8443";
  for (const allowedOrigins of [[], [configured]]) {
    const f = await guardedMachine(allowedOrigins);
    try {
      for (const origin of [configured, "https://public.example:8444", "%%%", "null"]) {
        const expected = allowedOrigins.length && origin === configured ? 200 : 403; const before = { ...f.calls };
        const client = new RemoteMachineClient({ baseUrl: f.baseUrl, headers: { Origin: origin } });
        const response = await client.requestJson("POST", "/action", {}); expect(response.statusCode).toBe(expected);
        const socket = await observeMachineSocket(client.connectWebSocket("/socket")); expect(socket.status).toBe(expected === 200 ? 101 : 403);
        if (expected === 403) { expect(response.body).toEqual({ error: "Cross-origin request rejected" }); expect(socket.body).toBe('{"error":"Cross-origin request rejected"}'); expect(f.calls).toEqual(before); }
        else expect(f.calls).toEqual({ action: before.action + 1, socket: before.socket + 1 });
      }
    } finally { await f.app.close(); }
  }
});
