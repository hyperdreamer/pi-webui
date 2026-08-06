import { type FastifyInstance } from "fastify";
import { ActiveAgentProfileAccessError, requireActiveAgentProfile, type ActiveAgentProfileProvider } from "../activeAgentProfileProvider.js";
import { LearnedSkillCatalog } from "./learnedSkillCatalog.js";
import { PiHermesLearnedSkillProvider } from "./piHermesLearnedSkillProvider.js";
import type { LearnedSkillsSnapshotResponse } from "../../shared/apiTypes.js";

export function registerLearnedSkillsRoutes(
  app: FastifyInstance,
  agentProfileProvider: ActiveAgentProfileProvider,
  prefix: string,
): void {
  app.get<{ Querystring: { projectPath?: string } }>(
    `${prefix}/agent-skills/snapshot`,
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const projectPath = request.query.projectPath;

      if (projectPath === undefined || projectPath === "") {
        return reply.code(400).send({ error: "projectPath query parameter is required" });
      }

      try {
        const profile = await requireActiveAgentProfile(agentProfileProvider);
        const catalog = new LearnedSkillCatalog([new PiHermesLearnedSkillProvider(profile.dir)]);
        const response: LearnedSkillsSnapshotResponse = await catalog.read(projectPath);
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
