import type { FastifyInstance, FastifyReply } from "fastify";
import { PiWebUiConfigMutationBusyError } from "../../configMutationCoordinator.js";
import {
  SpeechInputSettingsConflictError,
  SpeechInputSettingsValidationError,
  type SpeechInputSettingsService,
} from "./speechInputSettingsService.js";

const CONFLICT_MESSAGE = "Speech input settings changed. Reload and try again.";
const BUSY_MESSAGE = "PI WEBUI config is busy. Try again.";
const UNEXPECTED_MESSAGE = "Speech input settings request failed.";

/** Gateway-only redacted speech input settings surface; no machine alias exists. */
export function registerSpeechInputSettingsRoutes(app: FastifyInstance, service: SpeechInputSettingsService): void {
  app.get("/api/speech-input/settings", async (_request, reply) => {
    try {
      return await service.read();
    } catch (error) {
      return mapSpeechInputSettingsError(reply, error);
    }
  });

  app.put<{ Body: unknown }>("/api/speech-input/settings", async (request, reply) => {
    try {
      return await service.update(request.body);
    } catch (error) {
      return mapSpeechInputSettingsError(reply, error);
    }
  });
}

function mapSpeechInputSettingsError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof SpeechInputSettingsValidationError) {
    return reply.code(400).send({ error: error.message });
  }
  if (error instanceof SpeechInputSettingsConflictError) {
    // Stable safe text; never echoes the current revision or settings.
    return reply.code(409).send({ error: CONFLICT_MESSAGE });
  }
  if (error instanceof PiWebUiConfigMutationBusyError) {
    return reply.code(503).send({ error: BUSY_MESSAGE });
  }
  // Never forward unexpected error text: it could carry credential material.
  return reply.code(500).send({ error: UNEXPECTED_MESSAGE });
}
