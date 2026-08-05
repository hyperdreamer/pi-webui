import type { FastifyInstance } from "fastify";
import type { ProjectUsageRequest, ProjectUsageResponse } from "../../shared/apiTypes.js";

export interface ProjectUsageReporter {
  report(scope: { projectPath: string; liveCwds: readonly string[] }): Promise<ProjectUsageResponse>;
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

export function registerProjectUsageRoutes(app: FastifyInstance, usage: ProjectUsageReporter, prefix = ""): void {
  app.post<{ Body: ProjectUsageBody | undefined }>(`${prefix}/sessions/project-usage`, async (request, reply) => {
    const body = request.body ?? {};
    const projectPath = body.projectPath;
    if (typeof projectPath !== "string" || projectPath === "") {
      return reply.code(400).send({ error: "projectPath is required" });
    }

    const rawCwds = body.liveCwds;
    if (rawCwds !== undefined && !isStringArray(rawCwds)) {
      return reply.code(400).send({ error: "liveCwds must be an array of strings" });
    }
    const liveCwds = rawCwds ?? [];
    const scope: ProjectUsageRequest = { projectPath, liveCwds };

    try {
      return await usage.report(scope);
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });
}
