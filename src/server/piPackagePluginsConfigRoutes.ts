import type { FastifyInstance, FastifyReply } from "fastify";
import type { PiPackagePluginAction, PiPackagePluginMutationRequest, PiPackagePluginScope } from "../shared/apiTypes.js";
import { ActiveAgentProfileAccessError } from "./activeAgentProfileProvider.js";
import type { PiPackagePluginsConfigService } from "./piPackagePluginsConfigService.js";

class PiPackagePluginsRequestError extends Error {}

/** Register workspace-aware Pi package Plugins routes at the browser/API edge. */
export function registerPiPackagePluginsConfigRoutes(app: FastifyInstance, service: PiPackagePluginsConfigService, prefix = "/api"): void {
  const routePrefix = normalizeRoutePrefix(prefix);

  app.get<{ Querystring: { cwd?: string } }>(`${routePrefix}/package-plugins`, async (request, reply) => {
    try {
      return await service.list(requiredCwd(request.query.cwd));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Body: unknown }>(`${routePrefix}/package-plugins`, async (request, reply) => {
    try {
      return await service.mutate(parseMutationRequest(request.body));
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

function normalizeRoutePrefix(prefix: string): string {
  const normalized = prefix.replace(/\/+$/u, "");
  return normalized === "" ? "/api" : normalized;
}

function parseMutationRequest(value: unknown): PiPackagePluginMutationRequest {
  const body = requireObject(value);
  const actionValue = body["action"];
  if (!isPiPackagePluginAction(actionValue)) {
    throw new PiPackagePluginsRequestError(`Unsupported Pi package plugin action: ${typeof actionValue === "string" ? actionValue : String(actionValue)}`);
  }
  const source = optionalSource(body["source"]);
  if (actionValue !== "update" && source === undefined) throw new PiPackagePluginsRequestError("source is required");
  const scope = parseScope(body["scope"]);
  return {
    action: actionValue,
    cwd: requiredCwd(body["cwd"]),
    scope,
    ...(source === undefined ? {} : { source }),
  };
}

function requiredCwd(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new PiPackagePluginsRequestError("cwd is required");
  return value;
}

function optionalSource(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new PiPackagePluginsRequestError("source is required");
  return value.trim();
}

function parseScope(value: unknown): PiPackagePluginScope {
  if (value === undefined) return "global";
  if (value === "global" || value === "project") return value;
  throw new PiPackagePluginsRequestError("Pi package plugin scope must be \"global\" or \"project\"");
}

function isPiPackagePluginAction(value: unknown): value is PiPackagePluginAction {
  return value === "install" || value === "remove" || value === "update" || value === "disable" || value === "enable";
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new PiPackagePluginsRequestError("Pi package plugin request body must be an object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  const status = error instanceof PiPackagePluginsRequestError
    ? 400
    : error instanceof ActiveAgentProfileAccessError
      ? 503
      : 500;
  return reply.code(status).send({ error: errorMessage(error) });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
