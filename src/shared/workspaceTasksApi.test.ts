import { describe, expect, it } from "vitest";
import type { WorkspaceCatalogAddress, WorkspaceTasksRequestResult } from "./apiTypes";
import {
  WORKSPACE_TASKS_MOVE_BODY_LIMIT_BYTES,
  WORKSPACE_TASKS_REPLACE_BODY_LIMIT_BYTES,
  parseGlobalWorkspaceTasksResponse,
  parseMoveWorkspaceTaskRequest,
  parseMoveWorkspaceTaskResult,
  parseReplaceGlobalWorkspaceTasksRequest,
  parseReplaceWorkspaceTasksRequest,
  parseWorkspaceTasksCatalogResponse,
  parseWorkspaceTasksFailureResponse,
} from "./workspaceTasksApi";
import {
  WORKSPACE_TASKS_CATALOG_MAX_BYTES,
  serializeWorkspaceTasksConfig,
  type WorkspaceTasksConfig,
} from "./workspaceTasks";

type JsonRecord = Record<string, unknown>;

const operationId = "00000000-0000-4000-8000-000000000001";
const task = {
  id: "build",
  title: "Build",
  command: "npm run build",
  confirm: false,
};
const config: WorkspaceTasksConfig = { version: 1, tasks: [task] };
const emptyConfig: WorkspaceTasksConfig = { version: 1, tasks: [] };
const workspaceLoaded = {
  kind: "loaded" as const,
  revision: "workspace-revision",
  config,
};
const workspaceMissing = {
  kind: "missing" as const,
  revision: "workspace-missing-revision",
};
const globalLoaded = {
  kind: "loaded" as const,
  revision: "global-revision",
  config: emptyConfig,
};

const replaceWorkspaceRequest = {
  expectedRevision: "workspace-revision",
  config,
};
const replaceGlobalRequest = {
  expectedRevision: "global-revision",
  config,
};
const promoteRequest = {
  operationId,
  intent: "start" as const,
  source: {
    ref: { scope: "workspace" as const, id: "build" },
    expectedCatalog: workspaceLoaded,
  },
  destination: {
    scope: "global" as const,
    expectedCatalog: globalLoaded,
    task,
  },
};
const demoteRequest = {
  operationId,
  intent: "retry" as const,
  source: {
    ref: { scope: "global" as const, id: "build" },
    expectedCatalog: {
      kind: "loaded" as const,
      revision: "global-source-revision",
      config,
    },
  },
  destination: {
    scope: "workspace" as const,
    expectedCatalog: workspaceMissing,
    task,
  },
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function expectRejected(parse: (value: unknown) => unknown, value: unknown): void {
  expect(() => parse(value)).toThrow();
}

function oversizedConfig(): WorkspaceTasksConfig {
  return {
    version: 1,
    tasks: [{
      id: "large",
      title: "Large",
      command: "x".repeat(WORKSPACE_TASKS_CATALOG_MAX_BYTES),
      confirm: false,
    }],
  };
}

describe("workspace task wire requests", () => {
  it("parses replace requests and keeps the version-one domain projection", () => {
    const value = {
      expectedRevision: "workspace-revision",
      config: {
        version: 1,
        generatedAt: "ignored",
        tasks: [{ ...task, metadata: { owner: "platform" } }],
      },
    };

    expect(parseReplaceWorkspaceTasksRequest(value)).toEqual(replaceWorkspaceRequest);
    expect(parseReplaceGlobalWorkspaceTasksRequest({
      expectedRevision: "global-revision",
      config: {
        version: 1,
        unknownCatalogField: true,
        tasks: [{ ...task, unknownTaskField: true }],
      },
    })).toEqual(replaceGlobalRequest);
  });

  it("parses both cross-scope move directions with their exact expectation shapes", () => {
    expect(parseMoveWorkspaceTaskRequest(promoteRequest)).toEqual(promoteRequest);
    expect(parseMoveWorkspaceTaskRequest(demoteRequest)).toEqual(demoteRequest);
  });

  it.each([
    ["workspace replace", parseReplaceWorkspaceTasksRequest, replaceWorkspaceRequest],
    ["global replace", parseReplaceGlobalWorkspaceTasksRequest, replaceGlobalRequest],
    ["move", parseMoveWorkspaceTaskRequest, promoteRequest],
  ] as const)("rejects route identity duplicated in the %s body", (_label, parse, value) => {
    const duplicated = { ...clone(value), projectId: "project-route", workspaceId: "workspace-route" };
    expectRejected(parse, duplicated);
  });

  it("requires loaded workspace source expectations and loaded global expectations", () => {
    const missingWorkspaceSource = {
      ...promoteRequest,
      source: { ...promoteRequest.source, expectedCatalog: workspaceMissing },
    };
    expectRejected(parseMoveWorkspaceTaskRequest, missingWorkspaceSource);

    const missingGlobalSource = {
      ...demoteRequest,
      source: { ...demoteRequest.source, expectedCatalog: workspaceMissing },
    };
    expectRejected(parseMoveWorkspaceTaskRequest, missingGlobalSource);

    const missingGlobalDestination = {
      ...promoteRequest,
      destination: { ...promoteRequest.destination, expectedCatalog: workspaceMissing },
    };
    expectRejected(parseMoveWorkspaceTaskRequest, missingGlobalDestination);
  });

  it("requires a source task and different source and destination scopes", () => {
    const absentSource = {
      ...promoteRequest,
      source: { ...promoteRequest.source, ref: { ...promoteRequest.source.ref, id: "missing" } },
    };
    expectRejected(parseMoveWorkspaceTaskRequest, absentSource);

    const duplicateSource = {
      ...promoteRequest,
      source: {
        ...promoteRequest.source,
        expectedCatalog: {
          ...promoteRequest.source.expectedCatalog,
          config: {
            version: 1,
            tasks: [task, { ...task, title: "Duplicate" }],
          },
        },
      },
    };
    expectRejected(parseMoveWorkspaceTaskRequest, duplicateSource);

    const sameScope = {
      ...promoteRequest,
      destination: { ...promoteRequest.destination, scope: "workspace", expectedCatalog: workspaceMissing },
    };
    expectRejected(parseMoveWorkspaceTaskRequest, sameScope);
  });

  it("rejects malformed operation IDs, revisions, scopes, and intents", () => {
    for (const invalidOperationId of [
      "00000000-0000-0000-8000-000000000001",
      "00000000-0000-4000-8000-00000000000A",
      "not-a-uuid",
    ]) {
      expectRejected(parseMoveWorkspaceTaskRequest, { ...promoteRequest, operationId: invalidOperationId });
    }

    expectRejected(parseReplaceWorkspaceTasksRequest, { ...replaceWorkspaceRequest, expectedRevision: "" });
    expectRejected(parseReplaceGlobalWorkspaceTasksRequest, { ...replaceGlobalRequest, expectedRevision: "   " });
    expectRejected(parseMoveWorkspaceTaskRequest, {
      ...promoteRequest,
      intent: "resume",
    });
    expectRejected(parseMoveWorkspaceTaskRequest, {
      ...promoteRequest,
      source: { ...promoteRequest.source, ref: { scope: "project", id: "build" } },
    });
    expectRejected(parseMoveWorkspaceTaskRequest, {
      ...promoteRequest,
      destination: { ...promoteRequest.destination, scope: "project" },
    });
  });

  it("rejects a catalog or destination task over 512 KiB", () => {
    const oversized = oversizedConfig();
    expect(new TextEncoder().encode(serializeWorkspaceTasksConfig(oversized)).byteLength).toBeGreaterThan(WORKSPACE_TASKS_CATALOG_MAX_BYTES);
    expectRejected(parseReplaceWorkspaceTasksRequest, {
      ...replaceWorkspaceRequest,
      config: oversized,
    });
    expectRejected(parseMoveWorkspaceTaskRequest, {
      ...promoteRequest,
      destination: {
        ...promoteRequest.destination,
        task: oversized.tasks[0],
      },
    });
  });

  it("rejects request bodies over their transport limits", () => {
    const oversizedReplace = {
      ...replaceWorkspaceRequest,
      expectedRevision: "r".repeat(WORKSPACE_TASKS_REPLACE_BODY_LIMIT_BYTES),
    };
    expect(new TextEncoder().encode(JSON.stringify(oversizedReplace)).byteLength).toBeGreaterThan(WORKSPACE_TASKS_REPLACE_BODY_LIMIT_BYTES);
    expectRejected(parseReplaceWorkspaceTasksRequest, oversizedReplace);

    const oversizedMove = {
      ...promoteRequest,
      source: {
        ...promoteRequest.source,
        expectedCatalog: { ...promoteRequest.source.expectedCatalog, revision: "r".repeat(WORKSPACE_TASKS_MOVE_BODY_LIMIT_BYTES) },
      },
    };
    expect(new TextEncoder().encode(JSON.stringify(oversizedMove)).byteLength).toBeGreaterThan(WORKSPACE_TASKS_MOVE_BODY_LIMIT_BYTES);
    expectRejected(parseMoveWorkspaceTaskRequest, oversizedMove);
  });

  it("rejects every owned request envelope when it contains an unknown key", () => {
    const cases: [string, (value: unknown) => unknown, JsonRecord][] = [
      ["workspace replace", parseReplaceWorkspaceTasksRequest, { ...replaceWorkspaceRequest, extra: true }],
      ["global replace", parseReplaceGlobalWorkspaceTasksRequest, { ...replaceGlobalRequest, extra: true }],
      ["move", parseMoveWorkspaceTaskRequest, { ...promoteRequest, extra: true }],
      ["move source", parseMoveWorkspaceTaskRequest, { ...promoteRequest, source: { ...promoteRequest.source, extra: true } }],
      ["move source reference", parseMoveWorkspaceTaskRequest, { ...promoteRequest, source: { ...promoteRequest.source, ref: { ...promoteRequest.source.ref, extra: true } } }],
      ["move source expectation", parseMoveWorkspaceTaskRequest, { ...promoteRequest, source: { ...promoteRequest.source, expectedCatalog: { ...promoteRequest.source.expectedCatalog, extra: true } } }],
      ["move destination", parseMoveWorkspaceTaskRequest, { ...promoteRequest, destination: { ...promoteRequest.destination, extra: true } }],
      ["move destination expectation", parseMoveWorkspaceTaskRequest, { ...promoteRequest, destination: { ...promoteRequest.destination, expectedCatalog: { ...promoteRequest.destination.expectedCatalog, extra: true } } }],
    ];

    for (const [label, parse, value] of cases) {
      expect(() => parse(value), label).toThrow();
    }
  });
});

describe("workspace task wire responses", () => {
  it("parses each workspace catalog state and optional unavailable detail", () => {
    expect(parseWorkspaceTasksCatalogResponse({ kind: "loaded", config, revision: "revision" })).toEqual({ kind: "loaded", config, revision: "revision" });
    expect(parseWorkspaceTasksCatalogResponse({ kind: "missing", message: "Missing", hint: "Create it", revision: "missing" })).toEqual({
      kind: "missing",
      message: "Missing",
      hint: "Create it",
      revision: "missing",
    });
    expect(parseWorkspaceTasksCatalogResponse({ kind: "invalid", message: "Invalid", hint: "Repair", detail: "Bad version" })).toEqual({
      kind: "invalid",
      message: "Invalid",
      hint: "Repair",
      detail: "Bad version",
    });
    expect(parseWorkspaceTasksCatalogResponse({ kind: "unavailable", message: "Unavailable", hint: "Refresh" })).toEqual({
      kind: "unavailable",
      message: "Unavailable",
      hint: "Refresh",
    });
    expect(parseWorkspaceTasksCatalogResponse({ kind: "unavailable", message: "Unavailable", hint: "Refresh", detail: "Try again" })).toEqual({
      kind: "unavailable",
      message: "Unavailable",
      hint: "Refresh",
      detail: "Try again",
    });
  });

  it("parses the global loaded and invalid states", () => {
    expect(parseGlobalWorkspaceTasksResponse({ kind: "loaded", config: emptyConfig, revision: "revision" })).toEqual({
      kind: "loaded",
      config: emptyConfig,
      revision: "revision",
    });
    expect(parseGlobalWorkspaceTasksResponse({ kind: "invalid", message: "Invalid", hint: "Repair", detail: "Bad global catalog" })).toEqual({
      kind: "invalid",
      message: "Invalid",
      hint: "Repair",
      detail: "Bad global catalog",
    });
  });

  it("rejects unknown keys in every owned response envelope while preserving domain compatibility", () => {
    const catalogWithUnknowns = {
      kind: "loaded",
      revision: "revision",
      config: {
        version: 1,
        generatedAt: "ignored",
        tasks: [{ ...task, metadata: { source: "ignored" } }],
      },
    };
    expect(parseWorkspaceTasksCatalogResponse(catalogWithUnknowns)).toEqual({
      kind: "loaded",
      revision: "revision",
      config,
    });

    const cases: [string, (value: unknown) => unknown, JsonRecord][] = [
      ["workspace loaded", parseWorkspaceTasksCatalogResponse, { ...catalogWithUnknowns, extra: true }],
      ["global loaded", parseGlobalWorkspaceTasksResponse, { kind: "loaded", config: emptyConfig, revision: "revision", extra: true }],
      ["workspace missing", parseWorkspaceTasksCatalogResponse, { kind: "missing", message: "Missing", hint: "Create", revision: "revision", extra: true }],
      ["workspace invalid", parseWorkspaceTasksCatalogResponse, { kind: "invalid", message: "Invalid", hint: "Repair", detail: "Bad", extra: true }],
      ["workspace unavailable", parseWorkspaceTasksCatalogResponse, { kind: "unavailable", message: "Unavailable", hint: "Refresh", extra: true }],
      ["global invalid", parseGlobalWorkspaceTasksResponse, { kind: "invalid", message: "Invalid", hint: "Repair", detail: "Bad", extra: true }],
    ];

    for (const [label, parse, value] of cases) {
      expect(() => parse(value), label).toThrow();
    }
  });

  it("rejects invalid optional details, missing required fields, and non-empty revision violations", () => {
    expectRejected(parseWorkspaceTasksCatalogResponse, { kind: "unavailable", message: "Unavailable", hint: "Refresh", detail: "" });
    expectRejected(parseWorkspaceTasksCatalogResponse, { kind: "unavailable", message: "Unavailable", hint: "Refresh", detail: 1 });
    expectRejected(parseWorkspaceTasksCatalogResponse, { kind: "invalid", message: "Invalid", hint: "Repair" });
    expectRejected(parseWorkspaceTasksCatalogResponse, { kind: "loaded", config, revision: "" });
    expectRejected(parseGlobalWorkspaceTasksResponse, { kind: "loaded", config: emptyConfig, revision: " " });
  });
});

describe("workspace task move results", () => {
  const completed = {
    kind: "completed" as const,
    operationId,
    workspace: { kind: "loaded" as const, config: emptyConfig, revision: "workspace-after" },
    global: { kind: "loaded" as const, config, revision: "global-after" },
  };
  const partial = {
    kind: "partial" as const,
    operationId,
    phase: "destination-written" as const,
    workspace: { kind: "loaded" as const, config, revision: "workspace-before" },
    global: { kind: "loaded" as const, config, revision: "global-after" },
  };

  it("keeps completed, partial, validation, unavailable, unknown-outcome, and move conflicts distinct", () => {
    expect(parseMoveWorkspaceTaskResult(completed)).toEqual(completed);
    expect(parseMoveWorkspaceTaskResult(partial)).toEqual(partial);
    expect(parseMoveWorkspaceTaskResult({ kind: "validation", message: "Invalid move" })).toEqual({ kind: "validation", message: "Invalid move" });
    expect(parseMoveWorkspaceTaskResult({ kind: "unavailable", message: "Unavailable" })).toEqual({ kind: "unavailable", message: "Unavailable" });
    expect(parseMoveWorkspaceTaskResult({ kind: "unknown-outcome", message: "Outcome is unknown" })).toEqual({ kind: "unknown-outcome", message: "Outcome is unknown" });

    const reasons = [
      "source-changed",
      "destination-collision",
      "invalid-catalog",
      "unrecognized-state",
      "unowned-intermediate-state",
      "move-in-progress",
      "retry-pristine",
    ] as const;
    for (const reason of reasons) {
      expect(parseMoveWorkspaceTaskResult({ kind: "conflict", reason, message: `Conflict: ${reason}` })).toEqual({
        kind: "conflict",
        reason,
        message: `Conflict: ${reason}`,
      });
    }
  });

  it("rejects unknown move result reasons and owned result envelope keys", () => {
    expectRejected(parseMoveWorkspaceTaskResult, { kind: "conflict", reason: "revision-conflict", message: "Conflict" });
    expectRejected(parseMoveWorkspaceTaskResult, { kind: "partial", operationId, phase: "source-written", workspace: partial.workspace, global: partial.global });
    expectRejected(parseMoveWorkspaceTaskResult, { ...completed, extra: true });
    expectRejected(parseMoveWorkspaceTaskResult, { ...partial, workspace: { ...partial.workspace, extra: true } });
    expectRejected(parseMoveWorkspaceTaskResult, { ...partial, global: { ...partial.global, extra: true } });
    expectRejected(parseMoveWorkspaceTaskResult, { ...completed, operationId: "not-a-uuid" });
  });
});

describe("workspace task failure responses", () => {
  it("models successful and typed failure request outcomes", () => {
    const address: WorkspaceCatalogAddress = { projectId: "project", workspaceId: "workspace" };
    const success: WorkspaceTasksRequestResult<WorkspaceTasksConfig> = { kind: "success", value: config };
    const unknownOutcome: WorkspaceTasksRequestResult<WorkspaceTasksConfig> = {
      kind: "unknown-outcome",
      message: "Write may have completed",
    };

    expect(address).toEqual({ projectId: "project", workspaceId: "workspace" });
    expect(success).toEqual({ kind: "success", value: config });
    expect(unknownOutcome).toEqual({ kind: "unknown-outcome", message: "Write may have completed" });
  });

  it("parses direct failure reasons and the owned unknown-outcome body", () => {
    expect(parseWorkspaceTasksFailureResponse({ kind: "validation", message: "Invalid request" })).toEqual({ kind: "validation", message: "Invalid request" });
    for (const reason of [
      "revision-conflict",
      "invalid-catalog",
      "move-in-progress",
      "move-recovery-pending",
      "unowned-intermediate-state",
    ] as const) {
      expect(parseWorkspaceTasksFailureResponse({ kind: "conflict", reason, message: `Conflict: ${reason}` })).toEqual({
        kind: "conflict",
        reason,
        message: `Conflict: ${reason}`,
      });
    }
    expect(parseWorkspaceTasksFailureResponse({ kind: "unavailable", message: "Busy", retryable: false })).toEqual({
      kind: "unavailable",
      message: "Busy",
      retryable: false,
    });
    expect(parseWorkspaceTasksFailureResponse({ kind: "unknown-outcome", message: "Write may have completed" })).toEqual({
      kind: "unknown-outcome",
      message: "Write may have completed",
    });
  });

  it("rejects unknown failure reasons, keys, and missing unavailable retryability", () => {
    expectRejected(parseWorkspaceTasksFailureResponse, { kind: "conflict", reason: "destination-collision", message: "Conflict" });
    expectRejected(parseWorkspaceTasksFailureResponse, { kind: "unavailable", message: "Busy" });
    expectRejected(parseWorkspaceTasksFailureResponse, { kind: "unknown-outcome", message: "Unknown", extra: true });
  });
});
