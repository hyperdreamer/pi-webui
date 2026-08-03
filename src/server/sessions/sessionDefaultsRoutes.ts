import type { FastifyInstance } from "fastify";
import {
  MODEL_TIERS,
  type LegacyStarterModelPolicyPreference,
  type ModelTier,
  type SessionDefaultsUpdate,
} from "../../shared/apiTypes.js";
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
  requireAllowedFields(
    body,
    ["cwd", "model", "thinkingLevel", "starterModelPolicyPreference"],
    "session defaults update",
  );
  const cwd = normalizeRequestCwd(requireString(body["cwd"], "cwd"));
  if (body["starterModelPolicyPreference"] !== undefined) {
    if (body["model"] !== undefined || body["thinkingLevel"] !== undefined) {
      throw new Error("A starter model policy preference update cannot include model or thinkingLevel");
    }
    return {
      cwd,
      update: {
        starterModelPolicyPreference: parseStarterModelPolicyPreference(
          body["starterModelPolicyPreference"],
        ),
      },
    };
  }

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

function parseStarterModelPolicyPreference(value: unknown): LegacyStarterModelPolicyPreference {
  const preference = requireRecord(value);
  requireAllowedFields(
    preference,
    ["mode", "tier"],
    "starterModelPolicyPreference",
  );
  const mode = preference["mode"];
  if (mode !== "exact" && mode !== "tiered") {
    throw new Error("starterModelPolicyPreference mode must be exact or tiered");
  }
  const tier = preference["tier"];
  if (tier !== undefined && !isModelTier(tier)) {
    throw new Error(`starterModelPolicyPreference tier must be one of: ${MODEL_TIERS.join(", ")}`);
  }
  if (mode === "tiered" && tier === undefined) {
    throw new Error("starterModelPolicyPreference tier is required in Tiered mode");
  }
  return tier === undefined ? { mode } : { mode, tier };
}

function isModelTier(value: unknown): value is ModelTier {
  return typeof value === "string" && MODEL_TIERS.some((tier) => tier === value);
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

function requireAllowedFields(
  record: Record<string, unknown>,
  allowedFields: readonly string[],
  field: string,
): void {
  const allowed = new Set(allowedFields);
  const unknownField = Object.keys(record).find((key) => !allowed.has(key));
  if (unknownField !== undefined) {
    throw new Error(`${field} has unknown field ${JSON.stringify(unknownField)}`);
  }
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
