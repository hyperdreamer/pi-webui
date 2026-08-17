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
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) throw error;
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
    return classifyMoveResponse(await requestJson(path, { method: "POST", body: JSON.stringify(body) }));
  } catch {
    return moveUnknownOutcome();
  }
}

function classifyReadResponse<T>(response: HttpJsonResponse, parse: (value: unknown) => T): WorkspaceTasksRequestResult<T> {
  if (response.status === 200) return { kind: "success", value: parse(response.body) };
  if (response.status === 404) return routeUnavailable();
  return parseFailureForStatus<T>(response, readUnavailable);
}

function classifyWriteResponse<T>(response: HttpJsonResponse, parse: (value: unknown) => T): WorkspaceTasksRequestResult<T> {
  if (response.status === 200) return { kind: "success", value: parse(response.body) };
  if (response.status === 404) return routeUnavailable();
  return parseFailureForStatus<T>(response, unknownOutcome);
}

function classifyMoveResponse(response: HttpJsonResponse): MoveWorkspaceTaskResult | WorkspaceTasksFailureResponse {
  if (response.status === 404) return { kind: "unavailable", message: ROUTE_UNAVAILABLE_MESSAGE };
  switch (response.status) {
    case 200:
      return parseMoveResultForStatus(response.body, ["completed"]);
    case 400:
    case 413:
      return parseMoveResultForStatus(response.body, ["validation"]);
    case 409:
      return parseMoveResultForStatus(response.body, ["partial", "conflict"]);
    case 500:
      return parseMoveResultForStatus(response.body, ["unknown-outcome"]);
    case 503:
      return parseMoveResultForStatus(response.body, ["unavailable"]);
    default:
      return moveUnknownOutcome();
  }
}

function parseFailureForStatus<T>(
  response: HttpJsonResponse,
  fallback: () => WorkspaceTasksRequestResult<T>,
): WorkspaceTasksRequestResult<T> {
  const expectedKind = expectedFailureKind(response.status);
  if (expectedKind === undefined) return fallback();
  const failure = parseWorkspaceTasksFailureResponse(response.body);
  return failure.kind === expectedKind ? failure : fallback();
}

function expectedFailureKind(status: number): WorkspaceTasksFailureResponse["kind"] | undefined {
  switch (status) {
    case 400:
    case 413:
      return "validation";
    case 409:
      return "conflict";
    case 500:
      return "unknown-outcome";
    case 503:
      return "unavailable";
    default:
      return undefined;
  }
}

function parseMoveResultForStatus(
  body: unknown,
  expectedKinds: readonly MoveWorkspaceTaskResult["kind"][],
): MoveWorkspaceTaskResult {
  const result = parseMoveWorkspaceTaskResult(body);
  return expectedKinds.includes(result.kind) ? result : moveUnknownOutcome();
}

function abortable(signal: AbortSignal | undefined): RequestInit | undefined {
  return signal === undefined ? undefined : { signal };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
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
