import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SPEECH_INPUT_MAX_TRANSCRIPT_BYTES } from "../../shared/speechInputAudio.js";
import { SPEECH_INPUT_POLISHING_ROUTE_TIMEOUT_MS } from "../../shared/speechInputPolishing.js";
import {
  SpeechInputPolishingAbortedError,
  SpeechInputPolishingUnavailableError,
} from "./speechInputPolishingService.js";

export { SPEECH_INPUT_POLISHING_ROUTE_TIMEOUT_MS };

// JSON escaping can expand a valid UTF-8 transcript by up to six bytes per
// source byte. This route-local limit leaves room for the JSON envelope without
// changing the process-wide Fastify body limit.
const DEFAULT_BODY_LIMIT = SPEECH_INPUT_MAX_TRANSCRIPT_BYTES * 6 + 1024;
const POLISHING_PATH = "/speech-input/polish";
const GATEWAY_POLISHING_PATH = "/api/speech-input/polish";
const INVALID_REQUEST_MESSAGE = "Invalid speech input polishing request.";
const ADMISSION_REJECTED_MESSAGE = "Speech input polishing is busy. Try again.";
const UNAVAILABLE_MESSAGE = "Speech input polishing is unavailable.";
const DAEMON_FAILURE_MESSAGE = "Speech input polishing daemon unavailable.";
const TIMEOUT_MESSAGE = "Speech input polishing timed out.";
const UNEXPECTED_FAILURE_MESSAGE = "Speech input polishing failed.";
const NO_STORE = "no-store";

export interface SpeechInputPolishingRouteService {
  polish(text: string, signal?: AbortSignal): Promise<string>;
}

export interface SpeechInputPolishingResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface SpeechInputPolishingDaemon {
  request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<SpeechInputPolishingResponse>;
}

export type SpeechInputPolishingDeadlineScheduler = (callback: () => void, delayMs: number) => () => void;

export interface SpeechInputPolishingRouteOptions {
  /** Injectable only for deterministic tests; production admits two. */
  admissionLimit?: number;
  /** Injectable only for deterministic tests; production uses the bounded JSON envelope. */
  bodyLimit?: number;
  /** Injectable only for deterministic tests; production uses a monotonic timer. */
  scheduleDeadline?: SpeechInputPolishingDeadlineScheduler;
}

interface ActiveRequest {
  request: FastifyRequest;
  reply: FastifyReply;
  controller: AbortController;
  releaseAdmission: () => void;
  cancelDeadline: () => void;
  onRawAborted: () => void;
  onResponseClose: () => void;
  cleanup: () => void;
  active: boolean;
  responseStarted: boolean;
  rawAborted: boolean;
}

type PolishingRequest = FastifyRequest<{ Body: unknown }>;
type PolishingHandler = (request: PolishingRequest, state: ActiveRequest) => Promise<void>;

export function registerSpeechInputPolishingRoutes(
  app: FastifyInstance,
  service: SpeechInputPolishingRouteService,
  options: SpeechInputPolishingRouteOptions = {},
): void {
  registerPolishingHttpRoute(app, POLISHING_PATH, options, async (request, state) => {
    const input = parsePolishingRequest(request.body);
    if (input === undefined) {
      sendResponse(state, 400, { error: INVALID_REQUEST_MESSAGE });
      return undefined;
    }

    try {
      const text = await service.polish(input.text, state.controller.signal);
      if (!isCurrent(state)) {
        state.cleanup();
        return undefined;
      }
      if (!isValidTranscript(text)) {
        sendResponse(state, 500, { error: UNEXPECTED_FAILURE_MESSAGE });
        return undefined;
      }
      sendResponse(state, 200, { text });
      return undefined;
    } catch (error) {
      if (!isCurrent(state)) {
        state.cleanup();
        return undefined;
      }
      mapDaemonServiceError(state, error);
      return undefined;
    }
  });
}

/** Registers only the gateway-owned, local-sessiond polishing endpoint. */
export function registerSpeechInputPolishingGatewayRoute(
  app: FastifyInstance,
  daemon: SpeechInputPolishingDaemon,
  options: SpeechInputPolishingRouteOptions = {},
): void {
  registerPolishingHttpRoute(app, GATEWAY_POLISHING_PATH, options, async (request, state) => {
    const input = parsePolishingRequest(request.body);
    if (input === undefined) {
      sendResponse(state, 400, { error: INVALID_REQUEST_MESSAGE });
      return undefined;
    }

    try {
      const upstream = await daemon.request("POST", POLISHING_PATH, { text: input.text }, state.controller.signal);
      if (!isSuccessfulStatus(upstream.statusCode)) {
        sendResponse(state, statusForUpstream(upstream.statusCode), { error: messageForUpstream(upstream.statusCode) });
        return undefined;
      }
      if (!isJsonContentType(headerValue(upstream.headers, "content-type"))) {
        sendResponse(state, 500, { error: UNEXPECTED_FAILURE_MESSAGE });
        return undefined;
      }
      const text = parsePolishingResponse(upstream.body);
      if (text === undefined) {
        sendResponse(state, 500, { error: UNEXPECTED_FAILURE_MESSAGE });
        return undefined;
      }
      sendResponse(state, 200, { text });
      return undefined;
    } catch {
      if (!isCurrent(state)) {
        state.cleanup();
        return undefined;
      }
      sendResponse(state, 502, { error: DAEMON_FAILURE_MESSAGE });
      return undefined;
    }
  });
}

function registerPolishingHttpRoute(
  app: FastifyInstance,
  path: string,
  options: SpeechInputPolishingRouteOptions,
  handler: PolishingHandler,
): void {
  const admissionLimit = options.admissionLimit ?? 2;
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
  const scheduleDeadline = options.scheduleDeadline ?? defaultScheduleDeadline;

  app.register((scope, _pluginOptions, done) => {
    const admission = createAdmission(admissionLimit);
    const active = new WeakMap<FastifyRequest, ActiveRequest>();
    const activeRequests = new Set<ActiveRequest>();

    scope.setErrorHandler((error, request, reply) => {
      const state = active.get(request);
      const statusCode = isContentParsingError(error) ? 400 : 500;
      const body = { error: statusCode === 400 ? INVALID_REQUEST_MESSAGE : UNEXPECTED_FAILURE_MESSAGE };
      reply.header("cache-control", NO_STORE);
      if (state === undefined) return reply.code(statusCode).send(body);
      if (!isCurrent(state)) {
        state.cleanup();
        return undefined;
      }
      return sendResponse(state, statusCode, body);
    });

    scope.addHook("onRequest", (request, reply, hookDone) => {
      reply.header("cache-control", NO_STORE);
      const releaseAdmission = admission.acquire();
      if (releaseAdmission === undefined) {
        reply.code(429).send({ error: ADMISSION_REJECTED_MESSAGE });
        hookDone();
        return;
      }

      const state = createActiveRequest(request, reply, releaseAdmission);
      active.set(request, state);
      activeRequests.add(state);
      state.cleanup = () => { cleanup(state); };

      request.raw.once("aborted", state.onRawAborted);
      reply.raw.once("close", state.onResponseClose);

      let deadlineCancelled = false;
      const scheduled: { cancel: () => void } = { cancel: () => undefined };
      state.cancelDeadline = () => {
        if (deadlineCancelled) return;
        deadlineCancelled = true;
        scheduled.cancel();
      };
      scheduled.cancel = scheduleDeadline(() => {
        if (!state.active) return;
        const canWrite = canWriteResponse(state);
        cleanup(state);
        if (canWrite) {
          state.responseStarted = true;
          try {
            state.reply.code(504).header("cache-control", NO_STORE).send({ error: TIMEOUT_MESSAGE });
          } catch {
            // A concurrent close has already made the response unwritable.
          }
          return;
        }
        if (!state.rawAborted && !state.request.raw.destroyed) {
          try {
            state.request.raw.destroy();
          } catch {
            // A concurrent disconnect has the same terminal result.
          }
        }
      }, SPEECH_INPUT_POLISHING_ROUTE_TIMEOUT_MS);
      if (!state.active) scheduled.cancel();

      if (request.raw.destroyed || reply.raw.destroyed) cleanup(state);
      hookDone();
    });

    scope.addHook("onResponse", (request, _reply, hookDone) => {
      const state = active.get(request);
      if (state !== undefined) cleanup(state);
      hookDone();
    });

    scope.addHook("onClose", (_instance, hookDone) => {
      for (const state of activeRequests) cleanup(state);
      hookDone();
    });

    scope.post<{ Body: unknown }>(path, { bodyLimit }, async (request) => {
      const state = active.get(request);
      if (state === undefined || !isCurrent(state)) {
        state?.cleanup();
        return undefined;
      }
      return handler(request, state);
    });
    done();

    function cleanup(state: ActiveRequest): void {
      if (!state.active) return;
      state.active = false;
      active.delete(state.request);
      activeRequests.delete(state);
      try {
        state.cancelDeadline();
      } catch {
        // Admission and downstream cancellation must still happen.
      }
      state.request.raw.removeListener("aborted", state.onRawAborted);
      state.reply.raw.removeListener("close", state.onResponseClose);
      try {
        if (!state.controller.signal.aborted) state.controller.abort();
      } finally {
        state.releaseAdmission();
      }
    }
  });
}

function createActiveRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  releaseAdmission: () => void,
): ActiveRequest {
  const controller = new AbortController();
  const state: ActiveRequest = {
    request,
    reply,
    controller,
    releaseAdmission,
    cancelDeadline: () => undefined,
    onRawAborted: () => undefined,
    onResponseClose: () => undefined,
    cleanup: () => undefined,
    active: true,
    responseStarted: false,
    rawAborted: false,
  };
  state.onRawAborted = () => {
    state.rawAborted = true;
    state.cleanup();
  };
  state.onResponseClose = () => {
    if (!state.active || state.responseStarted || state.reply.sent || state.reply.raw.writableEnded) return;
    state.cleanup();
  };
  return state;
}

function parsePolishingRequest(value: unknown): { text: string } | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "text") return undefined;
  const text = value["text"];
  return isValidTranscript(text) ? { text } : undefined;
}

function parsePolishingResponse(body: string): string | undefined {
  if (Buffer.byteLength(body, "utf8") > DEFAULT_BODY_LIMIT) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "text") return undefined;
  const text = value["text"];
  return isValidTranscript(text) ? text : undefined;
}

function isValidTranscript(value: unknown): value is string {
  return typeof value === "string"
    && value.trim() !== ""
    && Buffer.byteLength(value, "utf8") <= SPEECH_INPUT_MAX_TRANSCRIPT_BYTES;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapDaemonServiceError(state: ActiveRequest, error: unknown): FastifyReply | undefined {
  if (error instanceof SpeechInputPolishingUnavailableError) {
    return sendResponse(state, 503, { error: UNAVAILABLE_MESSAGE });
  }
  if (error instanceof SpeechInputPolishingAbortedError) {
    return sendResponse(state, 500, { error: UNEXPECTED_FAILURE_MESSAGE });
  }
  // Do not inspect or serialize unexpected service errors at this boundary.
  void error;
  return sendResponse(state, 500, { error: UNEXPECTED_FAILURE_MESSAGE });
}

function isSuccessfulStatus(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

function statusForUpstream(statusCode: number): 400 | 429 | 502 | 503 | 504 {
  if (statusCode === 400) return 400;
  if (statusCode === 429) return 429;
  if (statusCode === 503) return 503;
  if (statusCode === 504) return 504;
  return 502;
}

function messageForUpstream(statusCode: number): string {
  const mapped = statusForUpstream(statusCode);
  if (mapped === 400) return INVALID_REQUEST_MESSAGE;
  if (mapped === 429) return ADMISSION_REJECTED_MESSAGE;
  if (mapped === 503) return UNAVAILABLE_MESSAGE;
  if (mapped === 504) return TIMEOUT_MESSAGE;
  return DAEMON_FAILURE_MESSAGE;
}

function isContentParsingError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code = error["code"];
  return typeof code === "string" && code.startsWith("FST_ERR_CTP_");
}

function isJsonContentType(contentType: string | undefined): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function isCurrent(state: ActiveRequest): boolean {
  return state.active
    && !state.controller.signal.aborted
    && !state.rawAborted
    && !state.reply.raw.destroyed;
}

function canWriteResponse(state: ActiveRequest): boolean {
  return isCurrent(state)
    && !state.responseStarted
    && !state.reply.sent
    && !state.reply.raw.destroyed
    && !state.reply.raw.writableEnded;
}

function sendResponse(state: ActiveRequest, statusCode: number, body: Record<string, string>): FastifyReply | undefined {
  if (!canWriteResponse(state)) {
    state.cleanup();
    return undefined;
  }
  state.responseStarted = true;
  try {
    return state.reply.code(statusCode).header("cache-control", NO_STORE).send(body);
  } catch {
    return undefined;
  } finally {
    // The operation is terminal once the response has been handed to Fastify.
    // The lifecycle hook remains an idempotent backstop for parser/close paths.
    state.cleanup();
  }
}

function createAdmission(limit: number): { acquire(): (() => void) | undefined } {
  let active = 0;
  return {
    acquire() {
      if (active >= limit) return undefined;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
      };
    },
  };
}

function defaultScheduleDeadline(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => { clearTimeout(timer); };
}
