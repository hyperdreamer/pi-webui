import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  HostSpeechSpeakRequest,
  HostSpeechStatus,
  HostSpeechTerminalResult,
  HostSpeechStopResponse,
} from "../../shared/apiTypes.js";
import { isHostSpeechRunId, truncateHostSpeechText } from "../../shared/hostSpeech.js";
import { HostSpeechUnavailableError } from "./hostSpeech.js";

export interface TtsRouteService {
  status(): Promise<HostSpeechStatus>;
  speak(input: HostSpeechSpeakRequest): Promise<HostSpeechTerminalResult>;
  stop(runId: string): Promise<HostSpeechTerminalResult | undefined>;
}

const DEFAULT_PREFIX = "/api";
const SPEAK_BODY_KEYS = new Set(["runId", "text", "voice", "rate"]);
const UNAVAILABLE_MESSAGE = "Host speech is unavailable.";
const UNEXPECTED_FAILURE_MESSAGE = "Host speech failed. Try again.";

export function registerTtsRoutes(app: FastifyInstance, speech: TtsRouteService, prefix = DEFAULT_PREFIX): void {
  app.get(`${prefix}/tts`, async (_request, reply) => {
    try {
      return await speech.status();
    } catch (error) {
      return mapSpeechError(reply, error);
    }
  });

  app.post<{ Body: unknown }>(`${prefix}/tts/speak`, async (request, reply) => {
    const input = parseSpeakBody(request.body);
    if (input === undefined) return reply.code(400).send({ error: "Invalid speak request" });

    // The speak response stays open until the run reaches a terminal state, so a
    // client disconnect must cancel the matching run instead of leaving it
    // speaking. `reply.raw` emits "close" both for a client disconnect (with
    // `writableEnded` false) and after a normal response write; only the former
    // should stop the run, and only once. The flag lives on an object so the
    // event callback's mutation stays visible to the handler. The listener is
    // installed before the first await so an abort during the status lookup
    // still cancels the run instead of letting it start speaking later.
    const settled = { value: false };
    const onClose = () => {
      if (settled.value || reply.raw.writableEnded) return;
      settled.value = true;
      void speech.stop(input.runId).catch(() => undefined);
    };
    reply.raw.on("close", onClose);
    const isSettled = (): boolean => settled.value;
    try {
      const status = await speech.status();
      if (isSettled()) return undefined;
      if (!status.available) return await reply.code(503).send({ error: status.reason ?? UNAVAILABLE_MESSAGE });
      if (input.voice !== undefined && !status.voices.some((voice) => voice.name === input.voice)) {
        return await reply.code(400).send({ error: `Unknown speech voice: ${input.voice}` });
      }
      const result = await speech.speak(input);
      if (isSettled()) return undefined;
      return result;
    } catch (error) {
      if (isSettled()) return undefined;
      return await mapSpeechError(reply, error);
    } finally {
      reply.raw.removeListener("close", onClose);
    }
  });

  app.post<{ Body: unknown }>(`${prefix}/tts/stop`, async (request, reply) => {
    const runId = parseStopBody(request.body);
    if (runId === undefined) return reply.code(400).send({ error: "Invalid stop request" });
    try {
      const result = await speech.stop(runId);
      const response: HostSpeechStopResponse = { runId, stopped: result !== undefined };
      return response;
    } catch (error) {
      return mapSpeechError(reply, error);
    }
  });
}

function parseSpeakBody(body: unknown): HostSpeechSpeakRequest | undefined {
  if (!isRecord(body)) return undefined;
  for (const key of Object.keys(body)) {
    if (!SPEAK_BODY_KEYS.has(key)) return undefined;
  }
  const { runId, text, voice, rate } = body;
  if (typeof runId !== "string" || !isHostSpeechRunId(runId)) return undefined;
  if (typeof text !== "string") return undefined;
  const truncatedText = truncateHostSpeechText(text);
  if (truncatedText === "") return undefined;
  if (voice !== undefined && (typeof voice !== "string" || voice === "" || /[\r\n]/u.test(voice))) return undefined;
  if (typeof rate !== "number" || !Number.isInteger(rate) || rate < -100 || rate > 100) return undefined;
  return { runId, text: truncatedText, ...(voice === undefined ? {} : { voice }), rate };
}

function parseStopBody(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  for (const key of Object.keys(body)) {
    if (key !== "runId") return undefined;
  }
  const { runId } = body;
  if (typeof runId !== "string" || !isHostSpeechRunId(runId)) return undefined;
  return runId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapSpeechError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof HostSpeechUnavailableError) {
    return reply.code(503).send({ error: error.message });
  }
  return reply.code(500).send({ error: UNEXPECTED_FAILURE_MESSAGE });
}
