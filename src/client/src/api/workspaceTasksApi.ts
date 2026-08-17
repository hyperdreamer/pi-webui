import type {
  GlobalWorkspaceTasksResponse,
  MoveWorkspaceTaskRequest,
  MoveWorkspaceTaskResult,
  ReplaceGlobalWorkspaceTasksRequest,
  ReplaceWorkspaceTasksRequest,
  WorkspaceCatalogAddress,
  WorkspaceTasksCatalogResponse,
  WorkspaceTasksFailureResponse,
  WorkspaceTasksRequestResult,
} from "../../../shared/apiTypes";
import {
  parseGlobalWorkspaceTasksResponse,
  parseMoveWorkspaceTaskResult,
  parseWorkspaceTasksCatalogResponse,
  parseWorkspaceTasksFailureResponse,
} from "../../../shared/workspaceTasksApi";
import { requestJson, type HttpJsonResponse } from "./http";

export interface WorkspaceTasksClient {
  readWorkspace(input: WorkspaceCatalogAddress & { machineId: string }, signal?: AbortSignal): Promise<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>;
  replaceWorkspace(input: WorkspaceCatalogAddress & ReplaceWorkspaceTasksRequest & { machineId: string }): Promise<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>;
  readGlobal(machineId: string, signal?: AbortSignal): Promise<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>;
  replaceGlobal(input: ReplaceGlobalWorkspaceTasksRequest & { machineId: string }): Promise<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>;
  move(input: WorkspaceCatalogAddress & MoveWorkspaceTaskRequest & { machineId: string }): Promise<MoveWorkspaceTaskResult | WorkspaceTasksFailureResponse>;
}

const ROUTE_UNAVAILABLE_MESSAGE = "Workspace Tasks are unavailable on the selected machine.";
const READ_UNAVAILABLE_MESSAGE = "Workspace Tasks could not be loaded. Refresh and try again.";
const UNKNOWN_OUTCOME_MESSAGE = "Workspace task write outcome is unknown. Refresh before trying again.";

const KNOWN_FAILURE_STATUSES = new Set([400, 409, 413, 500, 503]);

export const workspaceTasksApi: WorkspaceTasksClient = {
  readWorkspace(input, signal) {
    return readRequest(workspaceTasksPath(input), parseWorkspaceTasksCatalogResponse, signal);
  },

  replaceWorkspace(input) {
    return writeRequest(
      workspaceTasksPath(input),
      { expectedRevision: input.expectedRevision, config: input.config },
      parseWorkspaceTasksCatalogResponse,
    );
  },

  readGlobal(machineId, signal) {
    return readRequest(globalWorkspaceTasksPath(machineId), parseGlobalWorkspaceTasksResponse, signal);
  },

  replaceGlobal(input) {
    return writeRequest(
      globalWorkspaceTasksPath(input.machineId),
      { expectedRevision: input.expectedRevision, config: input.config },
      parseGlobalWorkspaceTasksResponse,
    );
  },

  move(input) {
    return moveRequest(workspaceTasksMovePath(input), {
      operationId: input.operationId,
      intent: input.intent,
      source: input.source,
      destination: input.destination,
    });
  },
};

async function readRequest<T>(path: string, parse: (value: unknown) => T, signal: AbortSignal | undefined): Promise<WorkspaceTasksRequestResult<T>> {
  try {
    return classifyReadResponse(await requestJson(path, abortable(signal)), parse);
  } catch {
    return readUnavailable();
  }
}

async function writeRequest<T>(path: string, body: unknown, parse: (value: unknown) => T): Promise<WorkspaceTasksRequestResult<T>> {
  try {
    return classifyWriteResponse(await requestJson(path, { method: "PUT", body: JSON.stringify(body) }), parse);
  } catch {
    return unknownOutcome();
  }
}

async function moveRequest(path: string, body: MoveWorkspaceTaskRequest): Promise<MoveWorkspaceTaskResult | WorkspaceTasksFailureResponse> {
  try {
    const response = await requestJson(path, { method: "POST", body: JSON.stringify(body) });
    if (response.status === 404) return { kind: "unavailable", message: ROUTE_UNAVAILABLE_MESSAGE };
    if (response.status === 200 || KNOWN_FAILURE_STATUSES.has(response.status)) return parseMoveWorkspaceTaskResult(response.body);
    return moveUnknownOutcome();
  } catch {
    return moveUnknownOutcome();
  }
}

function classifyReadResponse<T>(response: HttpJsonResponse, parse: (value: unknown) => T): WorkspaceTasksRequestResult<T> {
  if (response.status === 200) return { kind: "success", value: parse(response.body) };
  if (response.status === 404) return routeUnavailable();
  if (KNOWN_FAILURE_STATUSES.has(response.status)) return parseWorkspaceTasksFailureResponse(response.body);
  return readUnavailable();
}

function classifyWriteResponse<T>(response: HttpJsonResponse, parse: (value: unknown) => T): WorkspaceTasksRequestResult<T> {
  if (response.status === 200) return { kind: "success", value: parse(response.body) };
  if (response.status === 404) return routeUnavailable();
  if (KNOWN_FAILURE_STATUSES.has(response.status)) return parseWorkspaceTasksFailureResponse(response.body);
  return unknownOutcome();
}

function abortable(signal: AbortSignal | undefined): RequestInit | undefined {
  return signal === undefined ? undefined : { signal };
}

function machinePrefixPath(machineId: string): string {
  return `api/machines/${encodeURIComponent(machineId)}`;
}

function workspaceTasksPath(input: WorkspaceCatalogAddress & { machineId: string }): string {
  return `${machinePrefixPath(input.machineId)}/projects/${encodeURIComponent(input.projectId)}/workspaces/${encodeURIComponent(input.workspaceId)}/workspace-tasks`;
}

function workspaceTasksMovePath(input: WorkspaceCatalogAddress & { machineId: string }): string {
  return `${workspaceTasksPath(input)}/move`;
}

function globalWorkspaceTasksPath(machineId: string): string {
  return `${machinePrefixPath(machineId)}/workspace-tasks/global`;
}

function readUnavailable<T>(): WorkspaceTasksRequestResult<T> {
  return { kind: "unavailable", message: READ_UNAVAILABLE_MESSAGE, retryable: true };
}

function routeUnavailable<T>(): WorkspaceTasksRequestResult<T> {
  return { kind: "unavailable", message: ROUTE_UNAVAILABLE_MESSAGE, retryable: false };
}

function unknownOutcome<T>(): WorkspaceTasksRequestResult<T> {
  return { kind: "unknown-outcome", message: UNKNOWN_OUTCOME_MESSAGE };
}

function moveUnknownOutcome(): Extract<MoveWorkspaceTaskResult, { kind: "unknown-outcome" }> {
  return { kind: "unknown-outcome", message: UNKNOWN_OUTCOME_MESSAGE };
}
