import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  MoveWorkspaceTaskResult,
  ReplaceGlobalWorkspaceTasksRequest,
  ReplaceWorkspaceTasksRequest,
  WorkspaceTasksConflictReason,
} from "../../shared/apiTypes.js";
import {
  parseMoveWorkspaceTaskRequest,
  parseReplaceGlobalWorkspaceTasksRequest,
  parseReplaceWorkspaceTasksRequest,
  WORKSPACE_TASKS_MOVE_BODY_LIMIT_BYTES,
  WORKSPACE_TASKS_REPLACE_BODY_LIMIT_BYTES,
} from "../../shared/workspaceTasksApi.js";
import {
  WorkspaceTasksInvalidCatalogError,
  WorkspaceTasksRevisionConflictError,
  WorkspaceTasksUnavailableError,
  WorkspaceTasksUnknownOutcomeError,
} from "./workspaceTasksErrors.js";
import {
  WorkspaceTasksMoveAuthorizationError,
  WorkspaceTasksMoveConflictError,
  WorkspaceTasksMoveInProgressError,
  WorkspaceTasksMoveRecoveryPendingError,
} from "./workspaceTasksMoveRegistry.js";
import type { WorkspaceTasksCatalogService } from "./workspaceTasksCatalogService.js";

interface WorkspaceRouteParams {
  projectId: string;
  workspaceId: string;
}

const UNKNOWN_WRITE_MESSAGE = "Workspace task write outcome is unknown. Refresh before trying again.";
const UNAVAILABLE_MESSAGE = "Workspace task operation is unavailable. Try again.";
const INVALID_BODY_MESSAGE = "Workspace task request body is invalid.";
const BODY_TOO_LARGE_MESSAGE = "Workspace task request body is too large.";

export function registerWorkspaceTasksRoutes(
  app: FastifyInstance,
  service: WorkspaceTasksCatalogService,
  prefix = "/api",
): void {
  const workspacePath = `${prefix}/projects/:projectId/workspaces/:workspaceId/workspace-tasks`;

  app.get<{ Params: WorkspaceRouteParams }>(workspacePath, async (request, reply) => {
    try {
      return await service.readWorkspace({ projectId: request.params.projectId, workspaceId: request.params.workspaceId });
    } catch (error) {
      return sendReadError(reply, error);
    }
  });

  app.put<{ Params: WorkspaceRouteParams; Body: unknown }>(workspacePath, {
    bodyLimit: WORKSPACE_TASKS_REPLACE_BODY_LIMIT_BYTES,
    errorHandler: taskRouteBodyErrorHandler,
  }, async (request, reply) => {
    let input: ReplaceWorkspaceTasksRequest;
    try {
      input = parseReplaceWorkspaceTasksRequest(request.body);
    } catch (error) {
      return reply.code(400).send(validationFailure(errorMessage(error)));
    }
    try {
      return await service.replaceWorkspace({ projectId: request.params.projectId, workspaceId: request.params.workspaceId, ...input });
    } catch (error) {
      return sendWriteError(reply, error);
    }
  });

  app.post<{ Params: WorkspaceRouteParams; Body: unknown }>(`${workspacePath}/move`, {
    bodyLimit: WORKSPACE_TASKS_MOVE_BODY_LIMIT_BYTES,
    errorHandler: taskRouteBodyErrorHandler,
  }, async (request, reply) => {
    let input: ReturnType<typeof parseMoveWorkspaceTaskRequest>;
    try {
      input = parseMoveWorkspaceTaskRequest(request.body);
    } catch (error) {
      return reply.code(400).send(validationFailure(errorMessage(error)));
    }
    try {
      const result = await service.move({ projectId: request.params.projectId, workspaceId: request.params.workspaceId, ...input });
      return await sendMoveResult(reply, result);
    } catch (error) {
      return sendWriteError(reply, error);
    }
  });

  const globalPath = `${prefix}/workspace-tasks/global`;
  app.get(globalPath, async (_request, reply) => {
    try {
      return await service.readGlobal();
    } catch (error) {
      return sendReadError(reply, error);
    }
  });

  app.put<{ Body: unknown }>(globalPath, {
    bodyLimit: WORKSPACE_TASKS_REPLACE_BODY_LIMIT_BYTES,
    errorHandler: taskRouteBodyErrorHandler,
  }, async (request, reply) => {
    let input: ReplaceGlobalWorkspaceTasksRequest;
    try {
      input = parseReplaceGlobalWorkspaceTasksRequest(request.body);
    } catch (error) {
      return reply.code(400).send(validationFailure(errorMessage(error)));
    }
    try {
      return await service.replaceGlobal(input);
    } catch (error) {
      return sendWriteError(reply, error);
    }
  });
}

function sendReadError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof WorkspaceTasksMoveRecoveryPendingError || error instanceof WorkspaceTasksMoveInProgressError) {
    return reply.code(409).send(conflictFailure(
      error instanceof WorkspaceTasksMoveRecoveryPendingError ? "move-recovery-pending" : "move-in-progress",
      error.message,
    ));
  }
  return reply.code(503).send(unavailableFailure(error instanceof WorkspaceTasksUnavailableError ? error.message : UNAVAILABLE_MESSAGE));
}

function sendWriteError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof WorkspaceTasksRevisionConflictError) {
    return reply.code(409).send(conflictFailure("revision-conflict", error.message));
  }
  if (error instanceof WorkspaceTasksInvalidCatalogError) {
    return reply.code(409).send(conflictFailure("invalid-catalog", error.message));
  }
  if (error instanceof WorkspaceTasksMoveRecoveryPendingError) {
    return reply.code(409).send(conflictFailure("move-recovery-pending", error.message));
  }
  if (error instanceof WorkspaceTasksMoveInProgressError) {
    return reply.code(409).send(conflictFailure("move-in-progress", error.message));
  }
  if (error instanceof WorkspaceTasksMoveConflictError) {
    const reason: WorkspaceTasksConflictReason = error.reason === "unrecognized-state"
      ? "unowned-intermediate-state"
      : error.reason;
    return reply.code(409).send(conflictFailure(reason, error.message));
  }
  if (error instanceof WorkspaceTasksUnavailableError || error instanceof WorkspaceTasksMoveAuthorizationError) {
    return reply.code(503).send(unavailableFailure(error instanceof WorkspaceTasksUnavailableError ? error.message : UNAVAILABLE_MESSAGE));
  }
  if (error instanceof WorkspaceTasksUnknownOutcomeError) {
    return reply.code(500).send(unknownOutcomeFailure(error.message));
  }
  return reply.code(500).send(unknownOutcomeFailure(UNKNOWN_WRITE_MESSAGE));
}

function sendMoveResult(reply: FastifyReply, result: MoveWorkspaceTaskResult): FastifyReply | MoveWorkspaceTaskResult {
  switch (result.kind) {
    case "completed":
      return result;
    case "partial":
    case "conflict":
      return reply.code(409).send(result);
    case "validation":
      return reply.code(400).send(result);
    case "unavailable":
      return reply.code(503).send(result);
    case "unknown-outcome":
      return reply.code(500).send(result);
  }
}

function taskRouteBodyErrorHandler(error: FastifyError, _request: FastifyRequest, reply: FastifyReply): void {
  if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    reply.code(413).send(validationFailure(BODY_TOO_LARGE_MESSAGE));
    return;
  }
  reply.code(400).send(validationFailure(INVALID_BODY_MESSAGE));
}

function validationFailure(message: string): { kind: "validation"; message: string } {
  return { kind: "validation", message };
}

function conflictFailure(
  reason: WorkspaceTasksConflictReason,
  message: string,
): { kind: "conflict"; reason: WorkspaceTasksConflictReason; message: string } {
  return { kind: "conflict", reason, message };
}

function unavailableFailure(message: string): { kind: "unavailable"; message: string; retryable: true } {
  return { kind: "unavailable", message, retryable: true };
}

function unknownOutcomeFailure(message: string): { kind: "unknown-outcome"; message: string } {
  return { kind: "unknown-outcome", message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
