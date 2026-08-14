import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PiWebUiConfigMutationBusyError } from "../../configMutationCoordinator.js";
import {
  SPEECH_INPUT_MAX_AUDIO_BYTES,
  SPEECH_INPUT_MAX_TRANSCRIPT_BYTES,
  SPEECH_INPUT_UPLOAD_TIMEOUT_MS,
  parseSpeechInputAudioMimeType,
} from "../../shared/speechInputAudio.js";
import {
  SpeechInputProviderError,
  SpeechInputProviderTimeoutError,
} from "./openAiCompatibleTranscriptionProvider.js";
import {
  SpeechInputAudioValidationError,
  SpeechInputCredentialUnavailableError,
  type SpeechInputTranscriptionRequest,
} from "./speechTranscriptionService.js";

export interface SpeechInputTranscriptionRouteService {
  transcribe(request: SpeechInputTranscriptionRequest): Promise<string>;
}

export type SpeechInputUploadDeadlineScheduler = (callback: () => void, delayMs: number) => () => void;

export interface SpeechInputTranscriptionRouteOptions {
  /** Injectable only for deterministic route tests; production uses 20 MiB. */
  bodyLimit?: number;
  /** Injectable only for deterministic route tests; production admits two. */
  admissionLimit?: number;
  scheduleDeadline?: SpeechInputUploadDeadlineScheduler;
}

interface ActiveRequest {
  controller: AbortController;
  releaseAdmission: () => void;
  cancelUploadDeadline: () => void;
  rawRequest: FastifyRequest["raw"];
  reply: FastifyReply;
  onEnd: () => void;
  onAborted: () => void;
  onClose: () => void;
  cleaned: boolean;
}

const TRANSCRIBE_PATH = "/api/speech-input/transcribe";
const ADMISSION_REJECTED_MESSAGE = "Speech transcription is busy. Try again.";
const INVALID_AUDIO_MESSAGE = "Invalid speech audio.";
const CONFIG_BUSY_MESSAGE = "PI WEBUI config is busy. Try again.";
const CREDENTIAL_UNAVAILABLE_MESSAGE = "Speech transcription is unavailable.";
const PROVIDER_FAILURE_MESSAGE = "Speech transcription provider request failed.";
const PROVIDER_TIMEOUT_MESSAGE = "Speech transcription provider timed out.";
const UNEXPECTED_FAILURE_MESSAGE = "Speech transcription failed.";

/**
 * Registers a gateway-only raw-audio endpoint in an encapsulated plugin. Its
 * parsers intentionally do not escape into general API route ownership.
 */
export function registerSpeechInputTranscriptionRoutes(
  app: FastifyInstance,
  service: SpeechInputTranscriptionRouteService,
  options: SpeechInputTranscriptionRouteOptions = {},
): void {
  const bodyLimit = options.bodyLimit ?? SPEECH_INPUT_MAX_AUDIO_BYTES;
  const admission = createAdmission(options.admissionLimit ?? 2);
  const scheduleDeadline = options.scheduleDeadline ?? defaultScheduleDeadline;
  const active = new WeakMap<FastifyRequest, ActiveRequest>();
  const activeRequests = new Set<FastifyRequest>();

  app.register((scope, _pluginOptions, done) => {
    registerAudioBufferParsers(scope);

    const cleanup = (request: FastifyRequest): void => {
      const state = active.get(request);
      if (state === undefined || state.cleaned) return;
      state.cleaned = true;
      active.delete(request);
      activeRequests.delete(request);
      try {
        state.cancelUploadDeadline();
      } catch {
        // Cleanup has already taken ownership of this request.
      }
      state.rawRequest.removeListener("end", state.onEnd);
      state.rawRequest.removeListener("aborted", state.onAborted);
      state.reply.raw.removeListener("close", state.onClose);
      try {
        state.controller.abort();
      } catch {
        // Abort is best effort after this request's terminal state is fixed.
      }
      state.releaseAdmission();
    };

    scope.addHook("onRequest", (request, reply, hookDone) => {
      const releaseAdmission = admission.acquire();
      if (releaseAdmission === undefined) {
        reply.code(429).send({ error: ADMISSION_REJECTED_MESSAGE });
        hookDone();
        return;
      }

      const controller = new AbortController();
      const scheduledDeadline: { cancel: () => void } = { cancel: () => undefined };
      const state: ActiveRequest = {
        controller,
        releaseAdmission,
        cancelUploadDeadline: (): void => undefined,
        rawRequest: request.raw,
        reply,
        onEnd: () => undefined,
        onAborted: () => undefined,
        onClose: () => undefined,
        cleaned: false,
      };
      let uploadDeadlineCancelled = false;
      state.cancelUploadDeadline = () => {
        if (uploadDeadlineCancelled) return;
        uploadDeadlineCancelled = true;
        scheduledDeadline.cancel();
      };
      state.onEnd = () => {
        // This timer covers admission through body completion only. Provider
        // work remains admitted after the upload finishes.
        try {
          state.cancelUploadDeadline();
        } catch {
          // A callback already owns terminal cleanup.
        }
      };
      state.onAborted = () => {
        cleanup(request);
      };
      state.onClose = () => {
        // ServerResponse also closes after a successful response. Only a
        // still-writable response means the client actually disconnected.
        if (reply.raw.writableEnded) return;
        cleanup(request);
      };
      active.set(request, state);
      activeRequests.add(request);
      request.raw.once("end", state.onEnd);
      request.raw.once("aborted", state.onAborted);
      reply.raw.once("close", state.onClose);
      scheduledDeadline.cancel = scheduleDeadline(() => {
        if (uploadDeadlineCancelled) return;
        cleanup(request);
        if (!request.raw.destroyed) {
          try {
            request.raw.destroy();
          } catch {
            // A concurrently closed socket has the same terminal result.
          }
        }
      }, SPEECH_INPUT_UPLOAD_TIMEOUT_MS);
      if (request.raw.destroyed) cleanup(request);
      hookDone();
    });

    scope.addHook("onError", (request, _reply, _error, hookDone) => {
      cleanup(request);
      hookDone();
    });
    scope.addHook("onResponse", (request, _reply, hookDone) => {
      cleanup(request);
      hookDone();
    });
    scope.addHook("onClose", (_instance, hookDone) => {
      for (const request of activeRequests) cleanup(request);
      hookDone();
    });

    scope.post<{ Body: unknown }>(TRANSCRIBE_PATH, { bodyLimit }, async (request, reply) => {
      const state = active.get(request);
      if (state === undefined || isAborted(state.controller.signal)) return undefined;
      const mimeType = parseSpeechInputAudioMimeType(contentTypeHeader(request));
      if (mimeType === undefined || !Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
        return reply.code(400).send({ error: INVALID_AUDIO_MESSAGE });
      }

      try {
        const text = await service.transcribe({
          audio: request.body,
          mimeType,
          signal: state.controller.signal,
        });
        if (isAborted(state.controller.signal)) return undefined;
        if (!isValidTranscript(text)) return await reply.code(500).send({ error: UNEXPECTED_FAILURE_MESSAGE });
        return { text };
      } catch (error) {
        if (isAborted(state.controller.signal)) return undefined;
        return await mapTranscriptionError(reply, error);
      }
    });
    done();
  });
}

function registerAudioBufferParsers(app: FastifyInstance): void {
  const parser = (_request: FastifyRequest, body: Buffer, done: (error: Error | null, value?: Buffer) => void) => {
    done(null, body);
  };
  // Exact codecs retain Fastify's normal exact-match precedence. Base media
  // parsers then admit header spelling variants so the strict shared parser can
  // make the allowlist decision from the original header value.
  app.addContentTypeParser("audio/webm;codecs=opus", { parseAs: "buffer" }, parser);
  app.addContentTypeParser("audio/ogg;codecs=opus", { parseAs: "buffer" }, parser);
  app.addContentTypeParser("audio/mp4;codecs=mp4a.40.2", { parseAs: "buffer" }, parser);
  app.addContentTypeParser("audio/webm", { parseAs: "buffer" }, parser);
  app.addContentTypeParser("audio/ogg", { parseAs: "buffer" }, parser);
  app.addContentTypeParser("audio/mp4", { parseAs: "buffer" }, parser);
  app.addContentTypeParser("*", { parseAs: "buffer" }, parser);
}

function contentTypeHeader(request: FastifyRequest): string | undefined {
  const value = request.headers["content-type"];
  return typeof value === "string" ? value : undefined;
}

function isValidTranscript(value: unknown): value is string {
  return typeof value === "string"
    && value.trim() !== ""
    && Buffer.byteLength(value, "utf8") <= SPEECH_INPUT_MAX_TRANSCRIPT_BYTES;
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function mapTranscriptionError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof SpeechInputAudioValidationError) {
    return reply.code(400).send({ error: INVALID_AUDIO_MESSAGE });
  }
  if (error instanceof PiWebUiConfigMutationBusyError) {
    return reply.code(503).send({ error: CONFIG_BUSY_MESSAGE });
  }
  if (error instanceof SpeechInputCredentialUnavailableError) {
    return reply.code(503).send({ error: CREDENTIAL_UNAVAILABLE_MESSAGE });
  }
  if (error instanceof SpeechInputProviderTimeoutError) {
    return reply.code(504).send({ error: PROVIDER_TIMEOUT_MESSAGE });
  }
  if (error instanceof SpeechInputProviderError) {
    return reply.code(502).send({ error: PROVIDER_FAILURE_MESSAGE });
  }
  return reply.code(500).send({ error: UNEXPECTED_FAILURE_MESSAGE });
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
