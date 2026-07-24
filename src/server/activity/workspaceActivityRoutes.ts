import type { FastifyInstance } from "fastify";
import type { WorkspaceActivityResponse } from "../../shared/apiTypes.js";

export interface WorkspaceActivityRouteService {
  snapshot(): WorkspaceActivityResponse;
}

export function registerWorkspaceActivityRoutes(app: FastifyInstance, activity: WorkspaceActivityRouteService, prefix = ""): void {
  app.get(`${prefix}/activity`, () => activity.snapshot());
}
