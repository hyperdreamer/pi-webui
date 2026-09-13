import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  ModelConnectionTestResponse,
  ModelDiscoveryResponse,
  ModelsConfigDocument,
  ModelsConfigErrorCode,
  ModelsConfigErrorResponse,
  ModelsConfigLimitsStatusResponse,
  ModelsConfigSaveResponse,
} from "../../shared/apiTypes.js";
import { ModelsConfigServiceError } from "./modelsConfigService.js";

/** Narrow surface the routes need; `ModelsConfigService` satisfies it. */
export interface ModelsConfigRouteService {
  read(): Promise<ModelsConfigDocument>;
  readLimitsStatus(): ModelsConfigLimitsStatusResponse;
  save(value: unknown): Promise<ModelsConfigSaveResponse>;
  test(value: unknown): Promise<ModelConnectionTestResponse>;
  discover(value: unknown): Promise<ModelDiscoveryResponse>;
}

const HTTP_STATUS_BY_CODE: Record<ModelsConfigErrorCode, number> = {
  MODELS_CONFIG_PARSE_FAILED: 422,
  MODELS_CONFIG_IO_FAILED: 500,
  MODELS_CONFIG_SAVE_INVALID: 400,
  MODELS_CONFIG_INVALID_LIMITS: 400,
  MODELS_CONFIG_UNREADABLE: 409,
  MODELS_CONFIG_PERSIST_FAILED: 500,
  MODELS_CONFIG_REFRESH_FAILED: 502,
  MODELS_CONFIG_INTERNAL: 500,
};

/** Register daemon-owned models.json editing and connection-test endpoints. */
export function registerModelsConfigRoutes(app: FastifyInstance, models: ModelsConfigRouteService, prefix = ""): void {
  app.get(`${prefix}/models-config`, async (_request, reply) => {
    try {
      return await models.read();
    } catch (error) {
      return sendModelsConfigError(reply, error);
    }
  });

  app.get(`${prefix}/models-config/limits`, async (_request, reply) => {
    try {
      return models.readLimitsStatus();
    } catch (error) {
      return sendModelsConfigError(reply, error);
    }
  });

  app.put<{ Body: unknown }>(`${prefix}/models-config`, async (request, reply) => {
    try {
      return await models.save(request.body);
    } catch (error) {
      return sendModelsConfigError(reply, error);
    }
  });

  app.post<{ Body: unknown }>(`${prefix}/models-config/test`, async (request, reply) => {
    try {
      const result = await models.test(request.body);
      return await reply.code(result.ok ? 200 : 400).send(result);
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.post<{ Body: unknown }>(`${prefix}/models-config/discover`, async (request, reply) => {
    try {
      return await models.discover(request.body);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
}

/** Builds the additive structured error body, keeping the legacy `error` string. */
export function modelsConfigErrorBody(error: ModelsConfigServiceError): ModelsConfigErrorResponse {
  return { error: error.message, code: error.code, file: "models.json", ...error.details };
}

function sendModelsConfigError(reply: FastifyReply, error: unknown): FastifyReply {
  const structured = error instanceof ModelsConfigServiceError
    ? error
    : new ModelsConfigServiceError("MODELS_CONFIG_INTERNAL", "Models configuration operation failed.");
  return reply.code(HTTP_STATUS_BY_CODE[structured.code]).send(modelsConfigErrorBody(structured));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
