import type { FastifyInstance } from "fastify";
import type { ProjectUsageCountRequest, ProjectUsageCountResponse, ProjectUsageRequest, ProjectUsageResponse } from "../../shared/apiTypes.js";

export interface ProjectUsageReporter {
  report(scope: ProjectUsageRequest): Promise<ProjectUsageResponse>;
  count(scope: ProjectUsageCountRequest): Promise<number>;
}

interface ProjectUsageBody {
  projectPath?: unknown;
  liveCwds?: unknown;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseProjectUsageScope(body: ProjectUsageBody | undefined): ProjectUsageRequest | { error: string } {
  const value = body ?? {};
  const projectPath = value.projectPath;
  if (typeof projectPath !== "string" || projectPath === "") return { error: "projectPath is required" };

  const rawCwds = value.liveCwds;
  if (rawCwds !== undefined && !isStringArray(rawCwds)) return { error: "liveCwds must be an array of strings" };
  return { projectPath, liveCwds: rawCwds ?? [] };
}

export function registerProjectUsageRoutes(app: FastifyInstance, usage: ProjectUsageReporter, prefix = ""): void {
  app.post<{ Body: ProjectUsageBody | undefined }>(`${prefix}/sessions/project-usage/count`, async (request, reply) => {
    const scope = parseProjectUsageScope(request.body);
    if ("error" in scope) return reply.code(400).send(scope);

    try {
      return { sessionCount: await usage.count(scope) } satisfies ProjectUsageCountResponse;
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: ProjectUsageBody | undefined }>(`${prefix}/sessions/project-usage`, async (request, reply) => {
    const scope = parseProjectUsageScope(request.body);
    if ("error" in scope) return reply.code(400).send(scope);

    try {
      return await usage.report(scope);
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });
}
