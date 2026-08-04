import type { FastifyInstance } from "fastify";
import { parseUtilityModelsConfig } from "../../config.js";
import { UTILITY_MODEL_SLOTS, type UtilityModelSettingsUpdate, type UtilityModelSlot } from "../../shared/apiTypes.js";
import type { UtilityModelSettingsService } from "./utilityModelSettingsService.js";

export interface UtilityModelSettingsRouteService {
  inspect(): ReturnType<UtilityModelSettingsService["inspect"]>;
  update(patch: UtilityModelSettingsUpdate): ReturnType<UtilityModelSettingsService["update"]>;
}

export function registerUtilityModelSettingsRoutes(app: FastifyInstance, service: UtilityModelSettingsRouteService, prefix = ""): void {
  app.get(`${prefix}/utility-models`, async (_request, reply) => {
    try {
      return await service.inspect();
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Body: unknown }>(`${prefix}/utility-models`, async (request, reply) => {
    try {
      return await service.update(parseUpdate(request.body));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
}

function parseUpdate(value: unknown): UtilityModelSettingsUpdate {
  if (!isRecord(value)) throw new Error("Expected object body");
  const unknownField = Object.keys(value).find((key) => key !== "settings");
  if (unknownField !== undefined) throw new Error(`unknown field ${JSON.stringify(unknownField)}; expected exactly settings`);
  if (!Object.prototype.hasOwnProperty.call(value, "settings")) throw new Error("settings is required");
  return parseSettingsUpdate(value["settings"]);
}

function parseSettingsUpdate(value: unknown): UtilityModelSettingsUpdate {
  if (!isRecord(value)) throw new Error("settings must be an object");
  const unknownSlot = Object.keys(value).find((key) => !isUtilityModelSlot(key));
  if (unknownSlot !== undefined) throw new Error(`unknown utility model slot ${JSON.stringify(unknownSlot)}`);

  const update: UtilityModelSettingsUpdate = {};
  for (const slot of UTILITY_MODEL_SLOTS) {
    if (!Object.prototype.hasOwnProperty.call(value, slot)) continue;
    if (value[slot] === null) {
      update[slot] = null;
      continue;
    }

    const parsed = parseUtilityModelsConfig({ [slot]: value[slot] }, "request body settings");
    const reference = parsed[slot];
    if (reference === undefined) throw new Error(`${slot} utility model reference is required`);
    update[slot] = reference;
  }
  return update;
}

function isUtilityModelSlot(value: string): value is UtilityModelSlot {
  return UTILITY_MODEL_SLOTS.some((slot) => slot === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
