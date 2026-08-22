import net from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { SPEECH_INPUT_MAX_TRANSCRIPT_BYTES } from "../../shared/speechInputAudio.js";
import { SPEECH_INPUT_POLISHING_ROUTE_TIMEOUT_MS as SHARED_SPEECH_INPUT_POLISHING_ROUTE_TIMEOUT_MS } from "../../shared/speechInputPolishing.js";
import {
  SpeechInputPolishingAbortedError,
  SpeechInputPolishingUnavailableError,
} from "./speechInputPolishingService.js";
import {
  registerSpeechInputPolishingGatewayRoute,
  registerSpeechInputPolishingRoutes,
  SPEECH_INPUT_POLISHING_ROUTE_TIMEOUT_MS,
  type SpeechInputPolishingDaemon,
  type SpeechInputPolishingResponse,
  type SpeechInputPolishingRouteService,
} from "./speechInputPolishingRoutes.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface Deadline {
  callback: () => void;
  delayMs: number;
  cancelCalls: number;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function controlledScheduler() {
  const deadlines: Deadline[] = [];
  return {
    deadlines,
    scheduleDeadline: (callback: () => void, delayMs: number): (() => void) => {
      const deadline = { callback, delayMs, cancelCalls: 0 };
      deadlines.push(deadline);
      return () => { deadline.cancelCalls += 1; };
    },
  };
}

function serviceWith(result: string | Error | (() => Promise<string>)): {
  service: SpeechInputPolishingRouteService;
  calls: { text: string; signal: AbortSignal }[];
} {
  const calls: { text: string; signal: AbortSignal }[] = [];
  return {
    calls,
    service: {
      polish: (text, signal) => {
        if (signal === undefined) throw new Error("Expected a route signal");
        calls.push({ text, signal });
        if (typeof result === "function") return result();
        if (result instanceof Error) return Promise.reject(result);
        return Promise.resolve(result);
      },
    },
  };
}

async function createDaemonApp(
  service: SpeechInputPolishingRouteService,
  options: Parameters<typeof registerSpeechInputPolishingRoutes>[2] = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerSpeechInputPolishingRoutes(app, service, options);
  await app.ready();
  return app;
}

async function createGatewayApp(
  daemon: SpeechInputPolishingDaemon,
  options: Parameters<typeof registerSpeechInputPolishingGatewayRoute>[2] = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerSpeechInputPolishingGatewayRoute(app, daemon, options);
  await app.ready();
  return app;
}

describe("session-daemon speech input polishing route", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("keeps the route timeout tied to the shared speech-polishing budget", () => {
    expect(SPEECH_INPUT_POLISHING_ROUTE_TIMEOUT_MS).toBe(SHARED_SPEECH_INPUT_POLISHING_ROUTE_TIMEOUT_MS);
  });

  it("invokes the composed service with the exact raw transcript and a request signal", async () => {
    const polishing = serviceWith("  Keep  this raw spacing.  ");
    const app = await createDaemonApp(polishing.service);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/speech-input/polish",
      payload: { text: "  Keep  this raw spacing.  " },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ text: "  Keep  this raw spacing.  " });
    expect(polishing.calls).toHaveLength(1);
    expect(polishing.calls[0]?.text).toBe("  Keep  this raw spacing.  ");
    expect(polishing.calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [null, "null body"],
    [[], "array body"],
    ["text", "primitive body"],
    [{}, "missing text"],
    [{ text: 42 }, "non-string text"],
    [{ text: "   \n\t" }, "blank text"],
    [{ text: "ok", extra: true }, "unknown key"],
    [{ text: "x".repeat(SPEECH_INPUT_MAX_TRANSCRIPT_BYTES + 1) }, "oversized text"],
  ] as const)("rejects %s before invoking the service (%s)", async (body, description) => {
    void description;
    const polishing = serviceWith("must not run");
    const app = await createDaemonApp(polishing.service);
    apps.push(app);

    const response = await app.inject({ method: "POST", url: "/speech-input/polish", headers: { "content-type": "application/json" }, payload: body === null ? "null" : JSON.stringify(body) });

    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain("must not run");
    expect(polishing.calls).toHaveLength(0);
  });

  it("maps unavailable, unexpected, and internally aborted service failures safely", async () => {
    const cases: [Error, number][] = [
      [new SpeechInputPolishingUnavailableError(), 503],
      [new SpeechInputPolishingAbortedError(), 500],
      [new Error("provider response contains secret-key"), 500],
    ];

    for (const [error, statusCode] of cases) {
      const polishing = serviceWith(error);
      const app = await createDaemonApp(polishing.service);
      apps.push(app);
      const response = await app.inject({ method: "POST", url: "/speech-input/polish", headers: { "content-type": "application/json" }, payload: { text: "captured transcript" } });
      expect(response.statusCode).toBe(statusCode);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain("captured transcript");
      expect(response.body).not.toContain("secret-key");
    }
  });
  it("releases admission after a service failure", async () => {
    let calls = 0;
    const app = await createDaemonApp({
      polish: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("provider response contains secret")) : Promise.resolve("recovered");
      },
    }, { admissionLimit: 1 });
    apps.push(app);

    const failed = await app.inject({ method: "POST", url: "/speech-input/polish", payload: { text: "first" } });
    const recovered = await app.inject({ method: "POST", url: "/speech-input/polish", payload: { text: "second" } });

    expect(failed.statusCode).toBe(500);
    expect(failed.headers["cache-control"]).toBe("no-store");
    expect(failed.body).not.toContain("secret");
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toEqual({ text: "recovered" });
  });

  it("releases admission after the route body limit rejects a payload", async () => {
    let calls = 0;
    const app = await createDaemonApp({
      polish: () => {
        calls += 1;
        return Promise.resolve("recovered");
      },
    }, { admissionLimit: 1, bodyLimit: 32 });
    apps.push(app);

    const tooLarge = await app.inject({
      method: "POST",
      url: "/speech-input/polish",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ text: "x".repeat(100) }),
    });
    const recovered = await app.inject({ method: "POST", url: "/speech-input/polish", payload: { text: "ok" } });

    expect(tooLarge.statusCode).toBe(400);
    expect(tooLarge.headers["cache-control"]).toBe("no-store");
    expect(recovered.statusCode).toBe(200);
    expect(calls).toBe(1);
  });

  it("releases admission after JSON parsing rejects a malformed body", async () => {
    let calls = 0;
    const service: SpeechInputPolishingRouteService = {
      polish: () => {
        calls += 1;
        return Promise.resolve("recovered");
      },
    };
    const app = await createDaemonApp(service, { admissionLimit: 1 });
    apps.push(app);

    const malformed = await app.inject({
      method: "POST",
      url: "/speech-input/polish",
      headers: { "content-type": "application/json" },
      payload: '{"text":',
    });
    const recovered = await app.inject({
      method: "POST",
      url: "/speech-input/polish",
      payload: { text: "recovered" },
    });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.headers["cache-control"]).toBe("no-store");
    expect(recovered.statusCode).toBe(200);
    expect(calls).toBe(1);
  });

  it("releases admission and aborts service work after the response connection closes", async () => {
    const pending = deferred<string>();
    const scheduler = controlledScheduler();
    let signal: AbortSignal | undefined;
    let calls = 0;
    const service: SpeechInputPolishingRouteService = {
      polish: (_text, requestSignal) => {
        calls += 1;
        signal = requestSignal;
        if (calls === 1) return pending.promise;
        return Promise.resolve("recovered");
      },
    };
    const app = await createDaemonApp(service, { admissionLimit: 1, scheduleDeadline: scheduler.scheduleDeadline });
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP server address");

    const socket = net.createConnection({ host: "127.0.0.1", port: address.port });
    socket.once("error", () => { /* The client intentionally disconnects. */ });
    const body = JSON.stringify({ text: "pending" });
    socket.write(
      "POST /speech-input/polish HTTP/1.1\r\n"
      + "Host: 127.0.0.1\r\n"
      + "Content-Type: application/json\r\n"
      + `Content-Length: ${String(Buffer.byteLength(body))}\r\n\r\n`
      + body,
    );
    await waitFor(() => signal !== undefined);
    socket.destroy();
    await waitFor(() => signal?.aborted === true);
    expect(scheduler.deadlines[0]?.cancelCalls).toBe(1);

    const recovered = await app.inject({ method: "POST", url: "/speech-input/polish", payload: { text: "recovered" } });
    expect(recovered.statusCode).toBe(200);
    expect(calls).toBe(2);
    pending.resolve("late");
    await new Promise<void>((resolve) => setImmediate(() => { resolve(); }));
  });

  it("aborts admitted work and cancels its deadline when the application closes", async () => {
    const pending = deferred<string>();
    const scheduler = controlledScheduler();
    let signal: AbortSignal | undefined;
    const app = await createDaemonApp({
      polish: (_text, requestSignal) => {
        signal = requestSignal;
        return pending.promise;
      },
    }, { scheduleDeadline: scheduler.scheduleDeadline });

    const request = app.inject({ method: "POST", url: "/speech-input/polish", payload: { text: "pending" } });
    await waitFor(() => signal !== undefined);
    const closing = app.close();
    await waitFor(() => signal?.aborted === true);
    expect(scheduler.deadlines[0]?.cancelCalls).toBe(1);
    pending.resolve("late");
    await closing;
    await request;
  });

  it("aborts the admitted operation at the monotonic route deadline and cancels its timer once", async () => {
    const pending = deferred<string>();
    const scheduler = controlledScheduler();
    let capturedSignal: AbortSignal | undefined;
    const service: SpeechInputPolishingRouteService = {
      polish: (_text, signal) => {
        capturedSignal = signal;
        return pending.promise;
      },
    };
    const app = await createDaemonApp(service, { scheduleDeadline: scheduler.scheduleDeadline });
    apps.push(app);

    const request = app.inject({ method: "POST", url: "/speech-input/polish", headers: { "content-type": "application/json" }, payload: { text: "pending" } });
    await waitFor(() => scheduler.deadlines.length === 1 && capturedSignal !== undefined);
    expect(scheduler.deadlines[0]?.delayMs).toBe(SPEECH_INPUT_POLISHING_ROUTE_TIMEOUT_MS);

    scheduler.deadlines[0]?.callback();
    const response = await request;

    expect(response.statusCode).toBe(504);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(capturedSignal?.aborted).toBe(true);
    expect(scheduler.deadlines[0]?.cancelCalls).toBe(1);
    pending.resolve("late result");
  });

  it("rejects a third request before parsing and releases admission after completion", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const third = deferred<string>();
    const pending = [first, second, third];
    const calls: string[] = [];
    const service: SpeechInputPolishingRouteService = {
      polish: (text) => {
        calls.push(text);
        const next = pending.shift();
        if (next === undefined) throw new Error("unexpected call");
        return next.promise;
      },
    };
    const app = await createDaemonApp(service);
    apps.push(app);

    const one = app.inject({ method: "POST", url: "/speech-input/polish", headers: { "content-type": "application/json" }, payload: { text: "one" } });
    const two = app.inject({ method: "POST", url: "/speech-input/polish", headers: { "content-type": "application/json" }, payload: { text: "two" } });
    await waitFor(() => calls.length === 2);
    const rejected = await app.inject({ method: "POST", url: "/speech-input/polish", headers: { "content-type": "application/json" }, payload: "definitely not parsed" });

    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["cache-control"]).toBe("no-store");
    expect(calls).toEqual(["one", "two"]);

    first.resolve("one");
    second.resolve("two");
    expect((await one).statusCode).toBe(200);
    expect((await two).statusCode).toBe(200);

    const admitted = app.inject({ method: "POST", url: "/speech-input/polish", headers: { "content-type": "application/json" }, payload: { text: "three" } });
    await waitFor(() => calls.includes("three"));
    third.resolve("three");
    expect((await admitted).statusCode).toBe(200);
  });
});

describe("gateway speech input polishing route", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it.each([
    [null, "null body"],
    [[], "array body"],
    ["text", "primitive body"],
    [{}, "missing text"],
    [{ text: 7 }, "non-string text"],
    [{ text: "  " }, "blank text"],
    [{ text: "ok", extra: true }, "unknown key"],
  ] as const)("rejects invalid gateway input before daemon forwarding (%s, %s)", async (body, description) => {
    void description;
    const calls: unknown[] = [];
    const app = await createGatewayApp({
      request: (...args) => {
        calls.push(args);
        return Promise.resolve({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "must not run" }) });
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/speech-input/polish",
      headers: { "content-type": "application/json" },
      payload: body === null ? "null" : JSON.stringify(body),
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain("must not run");
    expect(calls).toHaveLength(0);
  });

  it("rejects a daemon response with a non-JSON content type as an invalid upstream response", async () => {
    const app = await createGatewayApp({
      request: () => Promise.resolve({ statusCode: 200, headers: { "content-type": "text/plain" }, body: JSON.stringify({ text: "polished" }) }),
    });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: "/api/speech-input/polish", payload: { text: "raw" } });

    expect(response.statusCode).toBe(500);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ error: "Speech input polishing failed." });
  });

  it("returns a gateway timeout and aborts the daemon request at the route deadline", async () => {
    const pending = deferred<SpeechInputPolishingResponse>();
    const scheduler = controlledScheduler();
    let signal: AbortSignal | undefined;
    const app = await createGatewayApp({
      request: (_method, _path, _body, requestSignal) => {
        signal = requestSignal;
        return pending.promise;
      },
    }, { scheduleDeadline: scheduler.scheduleDeadline });
    apps.push(app);

    const request = app.inject({ method: "POST", url: "/api/speech-input/polish", payload: { text: "pending" } });
    await waitFor(() => scheduler.deadlines.length === 1 && signal !== undefined);
    scheduler.deadlines[0]?.callback();
    const response = await request;

    expect(response.statusCode).toBe(504);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(signal?.aborted).toBe(true);
    expect(scheduler.deadlines[0]?.cancelCalls).toBe(1);
    pending.resolve({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "late" }) });
  });

  it("cancels the gateway deadline after a transport failure", async () => {
    const scheduler = controlledScheduler();
    const app = await createGatewayApp({
      request: () => Promise.reject(new Error("daemon body contains provider-secret")),
    }, { scheduleDeadline: scheduler.scheduleDeadline });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: "/api/speech-input/polish", payload: { text: "raw transcript" } });

    expect(response.statusCode).toBe(502);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain("provider-secret");
    expect(scheduler.deadlines[0]?.cancelCalls).toBe(1);
  });

  it("forwards the exact local daemon path and body and validates the bounded response", async () => {
    const calls: { method: string; path: string; body: unknown; signal: AbortSignal | undefined }[] = [];
    const daemon: SpeechInputPolishingDaemon = {
      request: (method, path, body, signal) => {
        calls.push({ method, path, body, signal });
        return Promise.resolve({
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "polished transcript" }),
        });
      },
    };
    const app = await createGatewayApp(daemon);
    apps.push(app);

    const response = await app.inject({ method: "POST", url: "/api/speech-input/polish", payload: { text: "raw transcript" } });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ text: "polished transcript" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/speech-input/polish", body: { text: "raw transcript" } });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [JSON.stringify({ text: "ok", extra: "no" }), "unknown response key"],
    [JSON.stringify({ text: "" }), "empty response"],
    [JSON.stringify({ text: "x".repeat(SPEECH_INPUT_MAX_TRANSCRIPT_BYTES + 1) }), "oversized response"],
    ["not-json", "malformed response"],
  ] as const)("turns %s into a safe 500 response (%s)", async (body, description) => {
    void description;
    const daemon: SpeechInputPolishingDaemon = {
      request: () => Promise.resolve({ statusCode: 200, headers: { "content-type": "application/json" }, body }),
    };
    const app = await createGatewayApp(daemon);
    apps.push(app);

    const response = await app.inject({ method: "POST", url: "/api/speech-input/polish", payload: { text: "secret transcript" } });

    expect(response.statusCode).toBe(500);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain("secret transcript");
    expect(response.body).not.toContain("not-json");
  });

  it.each([
    [503, "unavailable"],
    [504, "timeout"],
    [502, "transport failure"],
  ] as const)("maps daemon %s status safely (%s)", async (statusCode, description) => {
    void description;
    const daemon: SpeechInputPolishingDaemon = {
      request: () => Promise.resolve({ statusCode, headers: {}, body: "provider secret" }),
    };
    const app = await createGatewayApp(daemon);
    apps.push(app);

    const response = await app.inject({ method: "POST", url: "/api/speech-input/polish", payload: { text: "secret transcript" } });

    expect(response.statusCode).toBe(statusCode);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain("provider secret");
    expect(response.body).not.toContain("secret transcript");
  });

  it("propagates a real client disconnect to the daemon and does not write a stale response", async () => {
    const pending = deferred<{ statusCode: number; headers: Record<string, string>; body: string }>();
    let signal: AbortSignal | undefined;
    const daemon: SpeechInputPolishingDaemon = {
      request: (_method, _path, _body, requestSignal) => {
        signal = requestSignal;
        return pending.promise;
      },
    };
    const app = await createGatewayApp(daemon);
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const next = net.createConnection({ host: "127.0.0.1", port: address.port });
      next.once("connect", () => { resolve(next); });
      next.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => socket.once("close", () => { resolve(); }));
    const body = JSON.stringify({ text: "pending" });
    socket.write(
      "POST /api/speech-input/polish HTTP/1.1\r\n"
      + "Host: 127.0.0.1\r\n"
      + "Content-Type: application/json\r\n"
      + `Content-Length: ${String(Buffer.byteLength(body))}\r\n\r\n`
      + body,
    );
    await waitFor(() => signal !== undefined);
    socket.destroy();
    await waitFor(() => signal?.aborted === true);
    pending.resolve({ statusCode: 200, headers: {}, body: JSON.stringify({ text: "late" }) });
    await closed;
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for test state");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
