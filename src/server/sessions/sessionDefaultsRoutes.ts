import type { FastifyInstance } from "fastify";
import type { SessionDefaultsUpdate } from "../../shared/apiTypes.js";
import { isKnownThinkingLevel } from "../../shared/thinkingLevels.js";
import { normalizeRequestCwd } from "../workingDirectory.js";
import type { SessionDefaultsService } from "./sessionDefaultsService.js";

export interface SessionDefaultsRouteService {
  read(cwd: string): ReturnType<SessionDefaultsService["read"]>;
  update(cwd: string, update: SessionDefaultsUpdate): ReturnType<SessionDefaultsService["update"]>;
}

export function registerSessionDefaultsRoutes(app: FastifyInstance, service: SessionDefaultsRouteService, prefix = ""): void {
  app.get<{ Querystring: { cwd?: string } }>(`${prefix}/session-defaults`, async (request, reply) => {
    try {
      return await service.read(normalizeRequestCwd(requireString(request.query.cwd, "cwd")));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Body: unknown }>(`${prefix}/session-defaults`, async (request, reply) => {
    try {
      const { cwd, update } = parseUpdate(request.body);
      return await service.update(cwd, update);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
}

function parseUpdate(value: unknown): { cwd: string; update: SessionDefaultsUpdate } {
  const body = requireRecord(value);
  const cwd = normalizeRequestCwd(requireString(body["cwd"], "cwd"));
  const model = body["model"] === undefined ? undefined : parseModel(body["model"]);
  const thinkingLevel = body["thinkingLevel"] === undefined ? undefined : requireThinkingLevel(body["thinkingLevel"]);
  if (model === undefined && thinkingLevel === undefined) throw new Error("A default model or thinking level is required");
  return {
    cwd,
    update: {
      ...(model === undefined ? {} : { model }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    },
  };
}

function parseModel(value: unknown): NonNullable<SessionDefaultsUpdate["model"]> {
  const model = requireRecord(value);
  return {
    provider: requireString(model["provider"], "provider"),
    modelId: requireString(model["modelId"], "modelId"),
  };
}

function requireThinkingLevel(value: unknown): string {
  if (typeof value !== "string" || !isKnownThinkingLevel(value)) throw new Error("Invalid thinkingLevel");
  return value;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected object body");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${name} is required`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
