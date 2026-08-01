import type { FastifyInstance } from "fastify";
import { parseModelTiersConfig } from "../../config.js";
import type { ModelTierLadder } from "../../shared/apiTypes.js";
import type { ModelTierSettingsService } from "./modelTierSettingsService.js";

export interface ModelTierSettingsRouteService {
  inspect(): ReturnType<ModelTierSettingsService["inspect"]>;
  replace(ladder: ModelTierLadder): ReturnType<ModelTierSettingsService["replace"]>;
}

export function registerModelTierSettingsRoutes(app: FastifyInstance, service: ModelTierSettingsRouteService, prefix = ""): void {
  app.get(`${prefix}/model-tiers`, async (_request, reply) => {
    try {
      return await service.inspect();
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Body: unknown }>(`${prefix}/model-tiers`, async (request, reply) => {
    try {
      return await service.replace(parseReplacement(request.body));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
}

function parseReplacement(value: unknown): ModelTierLadder {
  if (!isRecord(value)) throw new Error("Expected object body");
  const unknownField = Object.keys(value).find((key) => key !== "ladder");
  if (unknownField !== undefined) throw new Error(`unknown field ${JSON.stringify(unknownField)}; expected exactly ladder`);
  if (!Object.prototype.hasOwnProperty.call(value, "ladder")) throw new Error("ladder is required");
  return parseModelTiersConfig(value["ladder"], "request body ladder");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
