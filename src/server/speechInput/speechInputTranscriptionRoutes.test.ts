import net from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiWebUiConfigMutationBusyError } from "../../configMutationCoordinator.js";
import {
  SpeechInputProviderError,
  SpeechInputProviderTimeoutError,
  SpeechInputTranscriptionAbortedError,
} from "./openAiCompatibleTranscriptionProvider.js";
import {
  SpeechInputCredentialUnavailableError,
  type SpeechInputTranscriptionRequest,
} from "./speechTranscriptionService.js";
import {
  registerSpeechInputTranscriptionRoutes,
  type SpeechInputTranscriptionRouteService,
} from "./speechInputTranscriptionRoutes.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface ControlledDeadline {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
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
  const deadlines: ControlledDeadline[] = [];
  return {
    deadlines,
    scheduleDeadline: (callback: () => void, delayMs: number): (() => void) => {
      const deadline = { callback, delayMs, cancelled: false, cancelCalls: 0 };
      deadlines.push(deadline);
      return () => {
        deadline.cancelled = true;
        deadline.cancelCalls += 1;
      };
    },
  };
}

interface CapturedTranscriptionService {
  service: SpeechInputTranscriptionRouteService;
  calls: SpeechInputTranscriptionRequest[];
}

function serviceWithText(text = "transcript"): CapturedTranscriptionService {
  const calls: SpeechInputTranscriptionRequest[] = [];
  return {
    calls,
    service: {
      transcribe: (request) => {
        calls.push(request);
        return Promise.resolve(text);
      },
    },
  };
}

async function createApp(
  service: SpeechInputTranscriptionRouteService,
  options: Parameters<typeof registerSpeechInputTranscriptionRoutes>[2] = {},
  bodyLimit?: number,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, ...(bodyLimit === undefined ? {} : { bodyLimit }) });
  registerSpeechInputTranscriptionRoutes(app, service, options);
  await app.ready();
  return app;
}

function audioRequest(payload: Buffer | string = "abc", contentType = "audio/webm;codecs=opus") {
  return {
    method: "POST" as const,
    url: "/api/speech-input/transcribe",
    payload,
    headers: { "content-type": contentType },
  };
}

describe("speech input transcription routes", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("passes an accepted raw Buffer and normalized MIME to the gateway service", async () => {
    const transcription = serviceWithText();
    const app = await createApp(transcription.service);
    apps.push(app);
    const payload = Buffer.from([1, 2, 3]);

    const response = await app.inject(audioRequest(payload, " AUDIO/WEBM ; CODECS = OPUS "));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ text: "transcript" });
    expect(transcription.calls).toHaveLength(1);
    const call = transcription.calls[0];
    if (call === undefined) throw new Error("Expected transcription call");
    expect(call.audio).toEqual(payload);
    expect(call.mimeType).toBe("audio/webm;codecs=opus");
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps missing, empty, and syntactically valid unsupported media safely while Fastify rejects invalid headers", async () => {
    const transcription = serviceWithText();
    const app = await createApp(transcription.service);
    apps.push(app);

    const missing = await app.inject({ method: "POST", url: "/api/speech-input/transcribe", payload: Buffer.from("abc") });
    const empty = await app.inject(audioRequest(Buffer.alloc(0)));
    const unparameterized = await app.inject(audioRequest("abc", "application/octet-stream"));
    const parameterized = await app.inject(audioRequest("abc", "video/webm;codecs=vp9"));
    const invalid = await app.inject(audioRequest("abc", "audio"));

    expect(missing.statusCode).toBe(400);
    expect(empty.statusCode).toBe(400);
    expect(unparameterized.statusCode).toBe(400);
    expect(parameterized.statusCode).toBe(400);
    expect(unparameterized.json()).toEqual(parameterized.json());
    expect(invalid.statusCode).toBe(415);
    expect(transcription.calls).toHaveLength(0);
  });

  it("uses its own body limit rather than the Fastify global limit", async () => {
    const smallGlobal = serviceWithText();
    const app = await createApp(smallGlobal.service, { bodyLimit: 5 }, 2);
    apps.push(app);

    expect((await app.inject(audioRequest("abc"))).statusCode).toBe(200);
    expect((await app.inject(audioRequest("abcdef"))).statusCode).toBe(413);

    const largeGlobal = serviceWithText();
    const second = await createApp(largeGlobal.service, { bodyLimit: 5 }, 100);
    apps.push(second);
    expect((await second.inject(audioRequest("abcdef"))).statusCode).toBe(413);
  });

  it("admits only two in-flight requests before parsing and recovers after completion", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const third = deferred<string>();
    const queue = [first, second, third];
    const calls: SpeechInputTranscriptionRequest[] = [];
    const service: SpeechInputTranscriptionRouteService = {
      transcribe: (request) => {
        calls.push(request);
        const next = queue.shift();
        if (next === undefined) throw new Error("Unexpected request");
        return next.promise;
      },
    };
    const app = await createApp(service);
    apps.push(app);

    const one = app.inject(audioRequest("one"));
    await vi.waitFor(() => { expect(calls).toHaveLength(1); });
    const two = app.inject(audioRequest("two"));
    await vi.waitFor(() => { expect(calls).toHaveLength(2); });
    const rejected = await app.inject(audioRequest("three"));

    expect(rejected.statusCode).toBe(429);
    expect(calls).toHaveLength(2);

    first.resolve("one");
    expect((await one).statusCode).toBe(200);
    const admittedAgain = app.inject(audioRequest("four"));
    await vi.waitFor(() => { expect(calls).toHaveLength(3); });
    second.resolve("two");
    third.resolve("four");
    expect((await two).statusCode).toBe(200);
    expect((await admittedAgain).json()).toEqual({ text: "four" });
  });

  it("releases admission after parser and service failures without forwarding secrets", async () => {
    let calls = 0;
    const service: SpeechInputTranscriptionRouteService = {
      transcribe: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("provider body: secret-api-key"));
        return Promise.resolve("recovered");
      },
    };
    const app = await createApp(service, { admissionLimit: 1, bodyLimit: 5 });
    apps.push(app);

    const handlerFailure = await app.inject(audioRequest("abc"));
    const bodyLimit = await app.inject(audioRequest("abcdef"));
    const invalidContentType = await app.inject(audioRequest("abc", "audio"));
    const recovered = await app.inject(audioRequest("abc"));

    expect(handlerFailure.statusCode).toBe(500);
    expect(handlerFailure.body).not.toContain("secret-api-key");
    expect(bodyLimit.statusCode).toBe(413);
    expect(invalidContentType.statusCode).toBe(415);
    expect(recovered.statusCode).toBe(200);
    expect(calls).toBe(2);
  });

  it("maps typed service failures to stable safe statuses", async () => {
    const errors = [
      [new SpeechInputCredentialUnavailableError(), 503],
      [new SpeechInputProviderError(), 502],
      [new SpeechInputProviderTimeoutError(), 504],
    ] as const;

    for (const [error, statusCode] of errors) {
      const service: SpeechInputTranscriptionRouteService = { transcribe: () => Promise.reject(error) };
      const app = await createApp(service);
      apps.push(app);
      const response = await app.inject(audioRequest("abc"));
      expect(response.statusCode).toBe(statusCode);
      expect(response.body).not.toContain("secret-api-key");
    }

    const busy = await createApp({ transcribe: () => Promise.reject(new PiWebUiConfigMutationBusyError()) });
    apps.push(busy);
    const busyResponse = await busy.inject(audioRequest("abc"));
    expect(busyResponse.statusCode).toBe(503);
    expect(busyResponse.json()).toEqual({ error: "PI WEBUI config is busy. Try again." });
  });

  it("maps an invalid service transcript to a generic failure instead of emitting an empty success", async () => {
    const service: SpeechInputTranscriptionRouteService = { transcribe: () => Promise.resolve("   ") };
    const app = await createApp(service);
    apps.push(app);

    const response = await app.inject(audioRequest("abc"));

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Speech transcription failed." });
  });

  it("maps an unexpected internal cancellation to a generic failure while the request remains connected", async () => {
    const service: SpeechInputTranscriptionRouteService = {
      transcribe: () => Promise.reject(new SpeechInputTranscriptionAbortedError()),
    };
    const app = await createApp(service);
    apps.push(app);

    const response = await app.inject(audioRequest("abc"));

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Speech transcription failed." });
  });

  it("keeps admission after request-stream completion while deferred provider work continues", async () => {
    const pending = deferred<string>();
    const scheduler = controlledScheduler();
    const calls: SpeechInputTranscriptionRequest[] = [];
    const service: SpeechInputTranscriptionRouteService = {
      transcribe: (request) => {
        calls.push(request);
        return pending.promise;
      },
    };
    const app = await createApp(service, { admissionLimit: 1, scheduleDeadline: scheduler.scheduleDeadline });
    apps.push(app);

    const first = app.inject(audioRequest("abc"));
    await vi.waitFor(() => { expect(calls).toHaveLength(1); });
    expect(scheduler.deadlines).toEqual([expect.objectContaining({ delayMs: 130_000, cancelled: true })]);
    const activeRequest = calls[0];
    if (activeRequest === undefined) throw new Error("Expected active transcription request");
    scheduler.deadlines[0]?.callback();
    expect(activeRequest.signal.aborted).toBe(false);
    const rejected = await app.inject(audioRequest("next"));
    expect(rejected.statusCode).toBe(429);

    pending.resolve("finished");
    expect((await first).statusCode).toBe(200);
    expect(scheduler.deadlines[0]?.cancelCalls).toBe(1);
  });

  it("destroys a trickled partial upload when its one admission-to-body deadline fires and frees its slot", async () => {
    const scheduler = controlledScheduler();
    const transcription = serviceWithText();
    const app = await createApp(transcription.service, { admissionLimit: 1, scheduleDeadline: scheduler.scheduleDeadline });
    apps.push(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP server address");

    const socket = net.createConnection({ host: "127.0.0.1", port: address.port });
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    socket.write(
      "POST /api/speech-input/transcribe HTTP/1.1\r\n"
      + "Host: 127.0.0.1\r\n"
      + "Content-Type: audio/webm;codecs=opus\r\n"
      + "Content-Length: 10\r\n\r\nabc",
    );
    await vi.waitFor(() => { expect(scheduler.deadlines).toHaveLength(1); });

    scheduler.deadlines[0]?.callback();
    await closed;
    expect(scheduler.deadlines[0]?.cancelled).toBe(true);

    const recovered = await app.inject(audioRequest("abc"));
    expect(recovered.statusCode).toBe(200);
    expect(transcription.calls).toHaveLength(1);
  });

  it("aborts provider work once after a response disconnect and does not hold admission", async () => {
    let active: SpeechInputTranscriptionRequest | undefined;
    let calls = 0;
    const service: SpeechInputTranscriptionRouteService = {
      transcribe: (request) => {
        calls += 1;
        if (calls > 1) return Promise.resolve("recovered");
        return new Promise<string>((resolve, reject) => {
        active = request;
        request.signal.addEventListener("abort", () => { reject(new SpeechInputTranscriptionAbortedError()); }, { once: true });
        void resolve;
        });
      },
    };
    const app = await createApp(service, { admissionLimit: 1 });
    apps.push(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP server address");

    const controller = new AbortController();
    const inFlight = fetch(`http://127.0.0.1:${String(address.port)}/api/speech-input/transcribe`, {
      method: "POST",
      headers: { "content-type": "audio/webm;codecs=opus" },
      body: "abc",
      signal: controller.signal,
    });
    await vi.waitFor(() => { expect(active).toBeDefined(); });
    controller.abort();
    await expect(inFlight).rejects.toBeInstanceOf(DOMException);
    await vi.waitFor(() => { expect(active?.signal.aborted).toBe(true); });

    const recovered = await app.inject(audioRequest("abc"));
    expect(recovered.statusCode).toBe(200);
  });
});
