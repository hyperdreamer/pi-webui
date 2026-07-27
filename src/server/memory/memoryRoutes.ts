import { type FastifyInstance } from "fastify";
import { ActiveAgentProfileAccessError, requireActiveAgentProfile, type ActiveAgentProfileProvider } from "../activeAgentProfileProvider.js";
import { MemoryService } from "./memoryService.js";
import type { MemoryEntriesResponse } from "../../shared/apiTypes.js";

export function registerMemoryRoutes(
  app: FastifyInstance,
  agentProfileProvider: ActiveAgentProfileProvider,
  prefix: string,
): void {
  app.get(`${prefix}/agent-memory/global`, async (request, reply) => {
    try {
      const profile = await requireActiveAgentProfile(agentProfileProvider);
      const service = new MemoryService(profile.dir);
      const entries = await service.globalEntries();
      const response: MemoryEntriesResponse = { entries };
      return response;
    } catch (error) {
      if (error instanceof ActiveAgentProfileAccessError) {
        return reply.code(503).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get<{ Querystring: { projectPath?: string } }>(
    `${prefix}/agent-memory/project`,
    async (request, reply) => {
      const projectPath = request.query.projectPath;

      if (projectPath === undefined || projectPath === "") {
        return reply.code(400).send({ error: "projectPath query parameter is required" });
      }

      try {
        const profile = await requireActiveAgentProfile(agentProfileProvider);
        const service = new MemoryService(profile.dir);
        const entries = await service.projectEntries(projectPath);
        const response: MemoryEntriesResponse = { entries };
        return response;
      } catch (error) {
        if (error instanceof ActiveAgentProfileAccessError) {
          return reply.code(503).send({ error: error.message });
        }
        throw error;
      }
    },
  );
}
