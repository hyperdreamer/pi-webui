import type { FastifyInstance } from "fastify";
import type { ModelsConfigService } from "./modelsConfigService.js";

/** Register daemon-owned models.json editing and connection-test endpoints. */
export function registerModelsConfigRoutes(app: FastifyInstance, models: ModelsConfigService, prefix = ""): void {
  app.get(`${prefix}/models-config`, async (_request, reply) => {
    try {
      return await models.read();
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Body: unknown }>(`${prefix}/models-config`, async (request, reply) => {
    try {
      return await models.save(request.body);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
