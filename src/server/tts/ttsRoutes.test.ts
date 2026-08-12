import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type {
  HostSpeechSpeakRequest,
  HostSpeechStatus,
  HostSpeechTerminalResult,
  HostSpeechStopResponse,
} from "../../shared/apiTypes.js";
import { HostSpeechUnavailableError } from "./hostSpeech.js";
import { registerTtsRoutes, type TtsRouteService } from "./ttsRoutes.js";

interface MockedSpeech extends TtsRouteService {
  status: Mock<() => Promise<HostSpeechStatus>>;
  speak: Mock<(input: HostSpeechSpeakRequest) => Promise<HostSpeechTerminalResult>>;
  stop: Mock<(runId: string) => Promise<HostSpeechTerminalResult | undefined>>;
}

const DEFAULT_STATUS: HostSpeechStatus = {
  available: true,
  voices: [{ name: "default", language: "en" }],
};

let app: FastifyInstance;
let speech: MockedSpeech;
let statusResult: HostSpeechStatus;

beforeEach(async () => {
  statusResult = DEFAULT_STATUS;
  speech = {
    status: vi.fn(() => Promise.resolve(statusResult)),
    speak: vi.fn((input: HostSpeechSpeakRequest): Promise<HostSpeechTerminalResult> =>
      Promise.resolve({ runId: input.runId, outcome: "ended" })),
    stop: vi.fn((runId: string): Promise<HostSpeechTerminalResult | undefined> =>
      Promise.resolve(runId === "run-active" ? { runId, outcome: "canceled" } : undefined)),
  };
  app = Fastify({ logger: false });
  registerTtsRoutes(app, speech);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("registerTtsRoutes", () => {
  it("reports host speech status", async () => {
    statusResult = {
      available: true,
      voices: [
        { name: "default", language: "en" },
        { name: "marta", language: "de", variant: "female" },
      ],
    };

    const response = await app.inject({ method: "GET", url: "/api/tts" });

    expect(response.statusCode).toBe(200);
    expect(response.json<HostSpeechStatus>()).toEqual(statusResult);
  });

  it("reports an unavailable status document without failing", async () => {
    statusResult = { available: false, reason: "Speech Dispatcher is unavailable.", voices: [] };

    const response = await app.inject({ method: "GET", url: "/api/tts" });

    expect(response.statusCode).toBe(200);
    expect(response.json<HostSpeechStatus>()).toEqual(statusResult);
  });

  it("speaks a valid request and returns the terminal result", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/tts/speak",
      payload: { runId: "run-1", text: "Hello there", voice: "default", rate: 10 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<HostSpeechTerminalResult>()).toEqual({ runId: "run-1", outcome: "ended" });
    expect(speech.speak).toHaveBeenCalledWith({ runId: "run-1", text: "Hello there", voice: "default", rate: 10 });
  });

  it("accepts boundary rates and an omitted voice", async () => {
    for (const rate of [-100, 100]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/tts/speak",
        payload: { runId: "run-boundary", text: "ok", rate },
      });

      expect(response.statusCode).toBe(200);
      expect(speech.speak).toHaveBeenCalledWith({ runId: "run-boundary", text: "ok", rate });
    }
  });

  it("returns a canceled terminal result", async () => {
    speech.speak.mockResolvedValueOnce({ runId: "run-canceled", outcome: "canceled" });

    const response = await app.inject({
      method: "POST",
      url: "/api/tts/speak",
      payload: { runId: "run-canceled", text: "stop me", rate: 0 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<HostSpeechTerminalResult>()).toEqual({ runId: "run-canceled", outcome: "canceled" });
  });

  it("truncates long speak text silently", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/tts/speak",
      payload: { runId: "run-long", text: "a".repeat(6_000), rate: 0 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<HostSpeechTerminalResult>()).toEqual({ runId: "run-long", outcome: "ended" });
    expect(speech.speak).toHaveBeenCalledWith({ runId: "run-long", text: "a".repeat(4_000), rate: 0 });
  });

  it("rejects malformed speak bodies with 400", async () => {
    const invalidBodies = [
      { payload: "not-an-object", headers: { "content-type": "text/plain" } },
      { payload: [] },
      { payload: {} },
      { payload: { runId: 123, text: "hi", rate: 0 } },
      { payload: { runId: "bad id!", text: "hi", rate: 0 } },
      { payload: { runId: "", text: "hi", rate: 0 } },
      { payload: { runId: "r".repeat(129), text: "hi", rate: 0 } },
      { payload: { runId: "run-1", rate: 0 } },
      { payload: { runId: "run-1", text: "", rate: 0 } },
      { payload: { runId: "run-1", text: "   ", rate: 0 } },
      { payload: { runId: "run-1", text: 42, rate: 0 } },
      { payload: { runId: "run-1", text: "hi", voice: "", rate: 0 } },
      { payload: { runId: "run-1", text: "hi", voice: "a\nb", rate: 0 } },
      { payload: { runId: "run-1", text: "hi", voice: "a\rb", rate: 0 } },
      { payload: { runId: "run-1", text: "hi", voice: 7, rate: 0 } },
      { payload: { runId: "run-1", text: "hi", rate: -101 } },
      { payload: { runId: "run-1", text: "hi", rate: 101 } },
      { payload: { runId: "run-1", text: "hi", rate: 1.5 } },
      { payload: { runId: "run-1", text: "hi", rate: "5" } },
      { payload: { runId: "run-1", text: "hi", rate: 0, extra: true } },
    ] satisfies { payload: unknown; headers?: Record<string, string> }[];

    for (const { payload, headers } of invalidBodies) {
      const response = await app.inject({
        method: "POST",
        url: "/api/tts/speak",
        payload,
        ...(headers === undefined ? {} : { headers }),
      });
      expect(response.statusCode).toBe(400);
    }
    expect(speech.speak).not.toHaveBeenCalled();
  });

  it("rejects a named voice that is not in the current status voices", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/tts/speak",
      payload: { runId: "run-voice", text: "hi", voice: "missing", rate: 0 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Unknown speech voice: missing" });
    expect(speech.speak).not.toHaveBeenCalled();
  });

  it("answers 503 when host speech status is unavailable", async () => {
    statusResult = { available: false, reason: "Speech Dispatcher is unavailable on the local gateway.", voices: [] };

    const response = await app.inject({
      method: "POST",
      url: "/api/tts/speak",
      payload: { runId: "run-1", text: "hi", rate: 0 },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Speech Dispatcher is unavailable on the local gateway." });
    expect(speech.speak).not.toHaveBeenCalled();
  });

  it("answers 503 when status lookup fails as unavailable", async () => {
    speech.status.mockRejectedValueOnce(new HostSpeechUnavailableError("Speech Dispatcher is unreachable."));

    const response = await app.inject({
      method: "POST",
      url: "/api/tts/speak",
      payload: { runId: "run-1", text: "hi", rate: 0 },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Speech Dispatcher is unreachable." });
    expect(speech.speak).not.toHaveBeenCalled();
  });

  it("answers 503 when speaking fails as unavailable after the status check", async () => {
    speech.speak.mockRejectedValueOnce(new HostSpeechUnavailableError("Speech Dispatcher vanished."));

    const response = await app.inject({
      method: "POST",
      url: "/api/tts/speak",
      payload: { runId: "run-1", text: "hi", rate: 0 },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Speech Dispatcher vanished." });
  });

  it("answers 500 with a stable message on unexpected speak failure", async () => {
    speech.speak.mockRejectedValueOnce(new Error("boom"));

    const response = await app.inject({
      method: "POST",
      url: "/api/tts/speak",
      payload: { runId: "run-1", text: "hi", rate: 0 },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Host speech failed. Try again." });
  });

  it("answers 500 with a stable message on unexpected status failure", async () => {
    speech.status.mockRejectedValueOnce(new Error("boom"));

    const response = await app.inject({ method: "GET", url: "/api/tts" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Host speech failed. Try again." });
  });

  it("maps a matching stop result to stopped true and a stale stop to stopped false", async () => {
    speech.stop.mockResolvedValueOnce({ runId: "run-active", outcome: "canceled" });
    speech.stop.mockResolvedValueOnce(undefined);

    const matching = await app.inject({ method: "POST", url: "/api/tts/stop", payload: { runId: "run-active" } });
    const stale = await app.inject({ method: "POST", url: "/api/tts/stop", payload: { runId: "run-stale" } });

    expect(matching.statusCode).toBe(200);
    expect(matching.json<HostSpeechStopResponse>()).toEqual({ runId: "run-active", stopped: true });
    expect(stale.statusCode).toBe(200);
    expect(stale.json<HostSpeechStopResponse>()).toEqual({ runId: "run-stale", stopped: false });
    expect(speech.stop).toHaveBeenNthCalledWith(1, "run-active");
    expect(speech.stop).toHaveBeenNthCalledWith(2, "run-stale");
  });

  it("rejects malformed stop bodies with 400", async () => {
    const invalidBodies = [
      { payload: "not-an-object", headers: { "content-type": "text/plain" } },
      { payload: [] },
      { payload: {} },
      { payload: { runId: 123 } },
      { payload: { runId: "bad id!" } },
      { payload: { runId: "run-1", extra: true } },
    ] satisfies { payload: unknown; headers?: Record<string, string> }[];

    for (const { payload, headers } of invalidBodies) {
      const response = await app.inject({
        method: "POST",
        url: "/api/tts/stop",
        payload,
        ...(headers === undefined ? {} : { headers }),
      });
      expect(response.statusCode).toBe(400);
    }
    expect(speech.stop).not.toHaveBeenCalled();
  });

  it("answers 503 when stopping fails as unavailable", async () => {
    speech.stop.mockRejectedValueOnce(new HostSpeechUnavailableError("Speech Dispatcher is unreachable."));

    const response = await app.inject({ method: "POST", url: "/api/tts/stop", payload: { runId: "run-1" } });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Speech Dispatcher is unreachable." });
  });

  it("answers 500 with a stable message on unexpected stop failure", async () => {
    speech.stop.mockRejectedValueOnce(new Error("boom"));

    const response = await app.inject({ method: "POST", url: "/api/tts/stop", payload: { runId: "run-1" } });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Host speech failed. Try again." });
  });

  it("stops the exact run when a pending speak request disconnects", async () => {
    let resolveSpeak: ((result: HostSpeechTerminalResult) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const speakStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    speech.speak = vi.fn((): Promise<HostSpeechTerminalResult> => {
      markStarted?.();
      return new Promise<HostSpeechTerminalResult>((resolve) => {
        resolveSpeak = resolve;
      });
    });

    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP listener address");

    const controller = new AbortController();
    const requestPromise = fetch(`http://127.0.0.1:${String(address.port)}/api/tts/speak`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run-9", text: "hello", rate: 0 }),
      signal: controller.signal,
    });
    await speakStarted;
    controller.abort();
    await expect(requestPromise).rejects.toBeInstanceOf(DOMException);

    await vi.waitFor(() => {
      expect(speech.stop).toHaveBeenCalledTimes(1);
      expect(speech.stop).toHaveBeenCalledWith("run-9");
    });

    // Let the pending speak settle so the handler unwinds and drops its listener.
    resolveSpeak?.({ runId: "run-9", outcome: "canceled" });
    await vi.waitFor(() => {
      expect(speech.stop).toHaveBeenCalledTimes(1);
    });
  });

  it("does not stop a speak request that resolves normally", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP listener address");

    const response = await fetch(`http://127.0.0.1:${String(address.port)}/api/tts/speak`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run-normal", text: "hello", rate: 0 }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ runId: "run-normal", outcome: "ended" });
    expect(speech.stop).not.toHaveBeenCalled();
  });
});
