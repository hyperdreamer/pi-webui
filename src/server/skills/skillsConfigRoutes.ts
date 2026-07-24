import type { FastifyInstance, FastifyReply } from "fastify";
import { SkillsConfigNotFoundError, SkillsConfigRequestError, type SkillsConfigService } from "./skillsConfigService.js";

/** Register daemon-owned skills management endpoints for a Pi agent profile. */
export function registerSkillsConfigRoutes(app: FastifyInstance, skills: SkillsConfigService, prefix = ""): void {
  app.get<{ Querystring: { cwd?: string } }>(`${prefix}/skills`, async (request, reply) => {
    try {
      return await skills.list(request.query.cwd ?? "");
    } catch (error) {
      return sendSkillsError(reply, error);
    }
  });

  app.patch<{ Body: unknown }>(`${prefix}/skills`, async (request, reply) => {
    try {
      return await skills.toggle(request.body);
    } catch (error) {
      return sendSkillsError(reply, error);
    }
  });

  app.post<{ Body: unknown }>(`${prefix}/skills/search`, async (request, reply) => {
    try {
      return await skills.search(request.body);
    } catch (error) {
      return sendSkillsError(reply, error);
    }
  });

  app.post<{ Body: unknown }>(`${prefix}/skills/install`, async (request, reply) => {
    try {
      return await skills.install(request.body);
    } catch (error) {
      return sendSkillsError(reply, error);
    }
  });

  app.post<{ Body: unknown }>(`${prefix}/skills/check`, async (request, reply) => {
    try {
      return await skills.check(request.body);
    } catch (error) {
      return sendSkillsError(reply, error);
    }
  });

  app.post<{ Body: unknown }>(`${prefix}/skills/update`, async (request, reply) => {
    try {
      return await skills.update(request.body);
    } catch (error) {
      return sendSkillsError(reply, error);
    }
  });
}

function sendSkillsError(reply: FastifyReply, error: unknown): FastifyReply {
  const status = error instanceof SkillsConfigRequestError
    ? 400
    : error instanceof SkillsConfigNotFoundError
      ? 404
      : 500;
  return reply.code(status).send({ error: errorMessage(error) });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
