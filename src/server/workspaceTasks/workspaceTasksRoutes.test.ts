import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  GlobalWorkspaceTasksResponse,
  MoveWorkspaceTaskRequest,
  MoveWorkspaceTaskResult,
  ReplaceGlobalWorkspaceTasksRequest,
  ReplaceWorkspaceTasksRequest,
  WorkspaceCatalogAddress,
  WorkspaceTasksCatalogResponse,
} from "../../shared/apiTypes.js";
import {
  WORKSPACE_TASKS_MOVE_BODY_LIMIT_BYTES,
  WORKSPACE_TASKS_REPLACE_BODY_LIMIT_BYTES,
} from "../../shared/workspaceTasksApi.js";
import {
  WorkspaceTasksInvalidCatalogError,
  WorkspaceTasksRevisionConflictError,
  WorkspaceTasksUnavailableError,
  WorkspaceTasksUnknownOutcomeError,
} from "./workspaceTasksErrors.js";
import type { WorkspaceTasksCatalogService } from "./workspaceTasksCatalogService.js";
import { WorkspaceTasksMoveConflictError } from "./workspaceTasksMoveRegistry.js";
import { registerWorkspaceTasksRoutes } from "./workspaceTasksRoutes.js";

const address: WorkspaceCatalogAddress = { projectId: "project-1", workspaceId: "workspace-1" };
const catalog = { version: 1 as const, tasks: [] };
const workspace: WorkspaceTasksCatalogResponse = { kind: "loaded", config: catalog, revision: "workspace-revision" };
const global: GlobalWorkspaceTasksResponse = { kind: "loaded", config: catalog, revision: "global-revision" };
const completed = { kind: "completed", operationId: "00000000-0000-4000-8000-000000000001", workspace, global } satisfies Extract<MoveWorkspaceTaskResult, { kind: "completed" }>;

class ControlledService implements WorkspaceTasksCatalogService {
  readonly readWorkspaceCalls: WorkspaceCatalogAddress[] = [];
  readonly replaceWorkspaceCalls: (WorkspaceCatalogAddress & ReplaceWorkspaceTasksRequest)[] = [];
  readonly readGlobalCalls: undefined[] = [];
  readonly replaceGlobalCalls: ReplaceGlobalWorkspaceTasksRequest[] = [];
  readonly moveCalls: (WorkspaceCatalogAddress & MoveWorkspaceTaskRequest)[] = [];
  replaceWorkspaceError: Error | undefined;
  replaceGlobalError: Error | undefined;
  moveResult: MoveWorkspaceTaskResult = completed;

  readWorkspace(input: WorkspaceCatalogAddress): Promise<WorkspaceTasksCatalogResponse> {
    this.readWorkspaceCalls.push(input);
    return Promise.resolve(workspace);
  }

  replaceWorkspace(input: WorkspaceCatalogAddress & ReplaceWorkspaceTasksRequest): Promise<WorkspaceTasksCatalogResponse> {
    this.replaceWorkspaceCalls.push(input);
    return this.replaceWorkspaceError === undefined
      ? Promise.resolve(workspace)
      : Promise.reject(this.replaceWorkspaceError);
  }

  readGlobal(): Promise<GlobalWorkspaceTasksResponse> {
    this.readGlobalCalls.push(undefined);
    return Promise.resolve(global);
  }

  replaceGlobal(input: ReplaceGlobalWorkspaceTasksRequest): Promise<GlobalWorkspaceTasksResponse> {
    this.replaceGlobalCalls.push(input);
    return this.replaceGlobalError === undefined
      ? Promise.resolve(global)
      : Promise.reject(this.replaceGlobalError);
  }

  move(input: WorkspaceCatalogAddress & MoveWorkspaceTaskRequest): Promise<MoveWorkspaceTaskResult> {
    this.moveCalls.push(input);
    return Promise.resolve(this.moveResult);
  }
}

let app: FastifyInstance;
let service: ControlledService;

beforeEach(async () => {
  service = new ControlledService();
  app = Fastify({ logger: false });
  registerWorkspaceTasksRoutes(app, service);
  registerWorkspaceTasksRoutes(app, service, "/api/machines/local");
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("workspace task local routes", () => {
  it("registers all ordinary routes and their explicit local aliases against one service", async () => {
    const replace: ReplaceWorkspaceTasksRequest = { expectedRevision: "workspace-revision", config: catalog };
    const move = moveRequest();
    const ordinary = [
      await app.inject({ method: "GET", url: `/api/projects/${address.projectId}/workspaces/${address.workspaceId}/workspace-tasks` }),
      await app.inject({ method: "PUT", url: `/api/projects/${address.projectId}/workspaces/${address.workspaceId}/workspace-tasks`, payload: replace }),
      await app.inject({ method: "POST", url: `/api/projects/${address.projectId}/workspaces/${address.workspaceId}/workspace-tasks/move`, payload: move }),
      await app.inject({ method: "GET", url: "/api/workspace-tasks/global" }),
      await app.inject({ method: "PUT", url: "/api/workspace-tasks/global", payload: { expectedRevision: "global-revision", config: catalog } }),
    ];
    const aliases = [
      await app.inject({ method: "GET", url: `/api/machines/local/projects/${address.projectId}/workspaces/${address.workspaceId}/workspace-tasks` }),
      await app.inject({ method: "PUT", url: `/api/machines/local/projects/${address.projectId}/workspaces/${address.workspaceId}/workspace-tasks`, payload: replace }),
      await app.inject({ method: "POST", url: `/api/machines/local/projects/${address.projectId}/workspaces/${address.workspaceId}/workspace-tasks/move`, payload: move }),
      await app.inject({ method: "GET", url: "/api/machines/local/workspace-tasks/global" }),
      await app.inject({ method: "PUT", url: "/api/machines/local/workspace-tasks/global", payload: { expectedRevision: "global-revision", config: catalog } }),
    ];

    expect(ordinary.map((response) => response.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect(aliases.map((response) => response.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect(service.readWorkspaceCalls).toContainEqual(address);
    expect(service.readGlobalCalls).toHaveLength(2);
    expect(service.replaceWorkspaceCalls).toContainEqual({ ...address, ...replace });
    expect(service.moveCalls).toHaveLength(2);
    expect(service.replaceGlobalCalls).toHaveLength(2);
  });

  it("strictly parses mutation bodies and maps typed failures to safe status envelopes", async () => {
    const invalid = await app.inject({ method: "PUT", url: "/api/workspace-tasks/global", payload: { expectedRevision: "only" } });
    expect(invalid.statusCode).toBe(400);
    expectValidationFailure(invalid.json<unknown>());
    expect(service.replaceGlobalCalls).toHaveLength(0);

    const errors: readonly [Error, number, Record<string, unknown>][] = [
      [new WorkspaceTasksRevisionConflictError(), 409, { kind: "conflict", reason: "revision-conflict" }],
      [new WorkspaceTasksInvalidCatalogError("detail must stay server-safe"), 409, { kind: "conflict", reason: "invalid-catalog" }],
      [new WorkspaceTasksUnknownOutcomeError(), 500, { kind: "unknown-outcome" }],
      [new WorkspaceTasksUnavailableError(), 503, { kind: "unavailable", retryable: true }],
    ];
    for (const [error, status, expected] of errors) {
      service.replaceGlobalError = error;
      const response = await app.inject({ method: "PUT", url: "/api/workspace-tasks/global", payload: { expectedRevision: "global-revision", config: catalog } });
      expect(response.statusCode).toBe(status);
      expect(response.json<unknown>()).toMatchObject(expected);
      expect(response.body).not.toContain("detail must stay server-safe");
    }
  });

  it("returns a known unavailable response for an unknown workspace identity", async () => {
    service.replaceWorkspaceError = new WorkspaceTasksUnavailableError();
    const response = await app.inject({
      method: "PUT",
      url: `/api/projects/${address.projectId}/workspaces/${address.workspaceId}/workspace-tasks`,
      payload: { expectedRevision: "workspace-revision", config: catalog },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json<unknown>()).toMatchObject({ kind: "unavailable", retryable: true });
    expect(response.json<unknown>()).not.toMatchObject({ kind: "unknown-outcome" });
  });
  it("maps a recovered unrecognized registry state to the public manual-resolution conflict reason", async () => {
    service.replaceGlobalError = new WorkspaceTasksMoveConflictError("unrecognized-state");

    const response = await app.inject({ method: "PUT", url: "/api/workspace-tasks/global", payload: { expectedRevision: "global-revision", config: catalog } });

    expect(response.statusCode).toBe(409);
    expect(response.json<unknown>()).toMatchObject({ kind: "conflict", reason: "unowned-intermediate-state" });
  });

  it("returns typed validation envelopes for route-specific replace and move body caps before dispatch", async () => {
    const oversizedReplace = { expectedRevision: "r".repeat(WORKSPACE_TASKS_REPLACE_BODY_LIMIT_BYTES), config: catalog };
    const replaceResponse = await app.inject({ method: "PUT", url: "/api/workspace-tasks/global", payload: oversizedReplace });
    expect(replaceResponse.statusCode).toBe(413);
    expectValidationFailure(replaceResponse.json<unknown>());
    expect(service.replaceGlobalCalls).toHaveLength(0);

    const oversizedMove = {
      ...moveRequest(),
      source: {
        ref: { scope: "workspace" as const, id: "build" },
        expectedCatalog: { kind: "loaded" as const, revision: "r".repeat(WORKSPACE_TASKS_MOVE_BODY_LIMIT_BYTES), config: catalog },
      },
    };
    const moveResponse = await app.inject({ method: "POST", url: `/api/projects/${address.projectId}/workspaces/${address.workspaceId}/workspace-tasks/move`, payload: oversizedMove });
    expect(moveResponse.statusCode).toBe(413);
    expectValidationFailure(moveResponse.json<unknown>());
    expect(service.moveCalls).toHaveLength(0);
  });

  it("maps move result conflicts without exposing raw errors", async () => {
    service.moveResult = { kind: "partial", operationId: completed.operationId, phase: "destination-written", workspace, global };
    const partial = await app.inject({ method: "POST", url: `/api/projects/${address.projectId}/workspaces/${address.workspaceId}/workspace-tasks/move`, payload: moveRequest() });

    expect(partial.statusCode).toBe(409);
    expect(partial.json()).toMatchObject({ kind: "partial", phase: "destination-written" });
  });
});

function expectValidationFailure(value: unknown): void {
  expect(value).toMatchObject({ kind: "validation" });
  if (!isRecord(value)) throw new Error("Expected validation response object");
  expect(typeof value["message"]).toBe("string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function moveRequest(): MoveWorkspaceTaskRequest {
  return {
    operationId: completed.operationId,
    intent: "start",
    source: {
      ref: { scope: "workspace", id: "build" },
      expectedCatalog: {
        kind: "loaded",
        revision: "workspace-revision",
        config: { version: 1, tasks: [{ id: "build", title: "Build", command: "npm run build", confirm: false }] },
      },
    },
    destination: {
      scope: "global",
      expectedCatalog: { kind: "loaded", revision: "global-revision", config: catalog },
      task: { id: "build", title: "Build", command: "npm run build", confirm: false },
    },
  };
}
