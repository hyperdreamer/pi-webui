import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WORKSPACE_TASKS_FEDERATED_HTTP_ROUTES } from "../../shared/federatedRoutes.js";
import {
  parseMoveWorkspaceTaskRequest,
  parseReplaceGlobalWorkspaceTasksRequest,
  parseReplaceWorkspaceTasksRequest,
  WORKSPACE_TASKS_MOVE_BODY_LIMIT_BYTES,
  WORKSPACE_TASKS_REPLACE_BODY_LIMIT_BYTES,
} from "../../shared/workspaceTasksApi.js";
import { proxyMachineHttpRequest } from "../machines/machineProxyRoutes.js";
import { MachineService } from "../machines/machineService.js";

interface WorkspaceTaskGatewayParams {
  machineId: string;
  projectId: string;
  workspaceId: string;
}

interface GlobalTaskGatewayParams {
  machineId: string;
}

const INVALID_BODY_MESSAGE = "Workspace task request body is invalid.";
const BODY_TOO_LARGE_MESSAGE = "Workspace task request body is too large.";

const [
  getWorkspaceTasksSpec,
  putWorkspaceTasksSpec,
  moveWorkspaceTasksSpec,
  getGlobalWorkspaceTasksSpec,
  putGlobalWorkspaceTasksSpec,
] = WORKSPACE_TASKS_FEDERATED_HTTP_ROUTES;

export function registerWorkspaceTasksProxyRoutes(app: FastifyInstance, machines = new MachineService()): void {
  const workspacePath = "/api/machines/:machineId/projects/:projectId/workspaces/:workspaceId/workspace-tasks";
  const globalPath = "/api/machines/:machineId/workspace-tasks/global";

  app.get<{ Params: WorkspaceTaskGatewayParams }>(workspacePath, (request, reply) => (
    proxyMachineHttpRequest(machines, getWorkspaceTasksSpec, request.params.machineId, request.method, request.url, undefined, request.headers["content-type"], reply)
  ));

  app.put<{ Params: WorkspaceTaskGatewayParams; Body: unknown }>(workspacePath, {
    bodyLimit: WORKSPACE_TASKS_REPLACE_BODY_LIMIT_BYTES,
    errorHandler: taskProxyBodyErrorHandler,
  }, (request, reply) => {
    try {
      const body = parseReplaceWorkspaceTasksRequest(request.body);
      return proxyMachineHttpRequest(machines, putWorkspaceTasksSpec, request.params.machineId, request.method, request.url, body, request.headers["content-type"], reply);
    } catch (error) {
      return reply.code(400).send(validationFailure(errorMessage(error)));
    }
  });

  app.post<{ Params: WorkspaceTaskGatewayParams; Body: unknown }>(`${workspacePath}/move`, {
    bodyLimit: WORKSPACE_TASKS_MOVE_BODY_LIMIT_BYTES,
    errorHandler: taskProxyBodyErrorHandler,
  }, (request, reply) => {
    try {
      const body = parseMoveWorkspaceTaskRequest(request.body);
      return proxyMachineHttpRequest(machines, moveWorkspaceTasksSpec, request.params.machineId, request.method, request.url, body, request.headers["content-type"], reply);
    } catch (error) {
      return reply.code(400).send(validationFailure(errorMessage(error)));
    }
  });

  app.get<{ Params: GlobalTaskGatewayParams }>(globalPath, (request, reply) => (
    proxyMachineHttpRequest(machines, getGlobalWorkspaceTasksSpec, request.params.machineId, request.method, request.url, undefined, request.headers["content-type"], reply)
  ));

  app.put<{ Params: GlobalTaskGatewayParams; Body: unknown }>(globalPath, {
    bodyLimit: WORKSPACE_TASKS_REPLACE_BODY_LIMIT_BYTES,
    errorHandler: taskProxyBodyErrorHandler,
  }, (request, reply) => {
    try {
      const body = parseReplaceGlobalWorkspaceTasksRequest(request.body);
      return proxyMachineHttpRequest(machines, putGlobalWorkspaceTasksSpec, request.params.machineId, request.method, request.url, body, request.headers["content-type"], reply);
    } catch (error) {
      return reply.code(400).send(validationFailure(errorMessage(error)));
    }
  });
}

function taskProxyBodyErrorHandler(error: FastifyError, _request: FastifyRequest, reply: FastifyReply): void {
  if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    reply.code(413).send(validationFailure(BODY_TOO_LARGE_MESSAGE));
    return;
  }
  reply.code(400).send(validationFailure(INVALID_BODY_MESSAGE));
}

function validationFailure(message: string): { kind: "validation"; message: string } {
  return { kind: "validation", message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
