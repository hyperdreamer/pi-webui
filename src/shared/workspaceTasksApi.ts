import type {
  GlobalCatalogExpectation,
  GlobalWorkspaceTasksResponse,
  MoveWorkspaceTaskDestination,
  MoveWorkspaceTaskRequest,
  MoveWorkspaceTaskResult,
  MoveWorkspaceTaskSource,
  MoveWorkspaceTaskIntent,
  ReplaceGlobalWorkspaceTasksRequest,
  ReplaceWorkspaceTasksRequest,
  WorkspaceCatalogExpectation,
  WorkspaceTasksCatalogResponse,
  WorkspaceTasksConflictReason,
  WorkspaceTasksFailureResponse,
} from "./apiTypes.js";
import {
  assertWorkspaceTasksCatalogSize,
  isWorkspaceTaskId,
  parseWorkspaceTasksConfig,
  type WorkspaceTask,
  type WorkspaceTaskScope,
  type WorkspaceTasksConfig,
} from "./workspaceTasks.js";
import { isCanonicalLowercaseUuid } from "./speechInput.js";

export const WORKSPACE_TASKS_REPLACE_BODY_LIMIT_BYTES = 576 * 1024;
export const WORKSPACE_TASKS_MOVE_BODY_LIMIT_BYTES = 1_835_008;

const WORKSPACE_TASKS_MOVE_CONFLICT_REASONS = [
  "source-changed",
  "destination-collision",
  "invalid-catalog",
  "unrecognized-state",
  "unowned-intermediate-state",
  "move-in-progress",
  "retry-pristine",
] as const;

type MoveWorkspaceTaskConflictReason = (typeof WORKSPACE_TASKS_MOVE_CONFLICT_REASONS)[number];

const WORKSPACE_TASKS_MOVE_CONFLICT_REASON_SET = new Set<string>(WORKSPACE_TASKS_MOVE_CONFLICT_REASONS);

const WORKSPACE_TASKS_CONFLICT_REASONS = [
  "revision-conflict",
  "invalid-catalog",
  "move-in-progress",
  "move-recovery-pending",
  "unowned-intermediate-state",
] as const satisfies readonly WorkspaceTasksConflictReason[];

const WORKSPACE_TASKS_CONFLICT_REASON_SET = new Set<string>(WORKSPACE_TASKS_CONFLICT_REASONS);

export function parseReplaceWorkspaceTasksRequest(value: unknown): ReplaceWorkspaceTasksRequest {
  assertJsonByteLimit(value, WORKSPACE_TASKS_REPLACE_BODY_LIMIT_BYTES, "workspace task replace request");
  const record = requirePlainRecord(value, ["expectedRevision", "config"], "workspace task replace request");
  return {
    expectedRevision: parseRevision(record, "expectedRevision", "workspace task replace request"),
    config: parseCatalog(record["config"], "workspace task replace request catalog"),
  };
}

export function parseReplaceGlobalWorkspaceTasksRequest(value: unknown): ReplaceGlobalWorkspaceTasksRequest {
  assertJsonByteLimit(value, WORKSPACE_TASKS_REPLACE_BODY_LIMIT_BYTES, "global workspace task replace request");
  const record = requirePlainRecord(value, ["expectedRevision", "config"], "global workspace task replace request");
  return {
    expectedRevision: parseRevision(record, "expectedRevision", "global workspace task replace request"),
    config: parseCatalog(record["config"], "global workspace task replace request catalog"),
  };
}

export function parseMoveWorkspaceTaskRequest(value: unknown): MoveWorkspaceTaskRequest {
  assertJsonByteLimit(value, WORKSPACE_TASKS_MOVE_BODY_LIMIT_BYTES, "workspace task move request");
  const record = requirePlainRecord(value, ["operationId", "intent", "source", "destination"], "workspace task move request");
  const source = parseMoveSource(record["source"]);
  const destination = parseMoveDestination(record["destination"]);
  if (source.ref.scope === destination.scope) throw invalid("workspace task move request");

  const sourceMatches = source.expectedCatalog.config.tasks.filter((task) => task.id === source.ref.id);
  if (sourceMatches.length !== 1) throw invalid("workspace task move request");

  return {
    operationId: parseOperationId(record, "operationId", "workspace task move request"),
    intent: parseMoveIntent(record["intent"]),
    source,
    destination,
  };
}

export function parseWorkspaceTasksCatalogResponse(value: unknown): WorkspaceTasksCatalogResponse {
  const record = requirePlainRecord(
    value,
    ["kind", "config", "revision", "message", "hint", "detail"],
    "workspace tasks catalog response",
  );
  switch (record["kind"]) {
    case "loaded": {
      const loaded = requirePlainRecord(value, ["kind", "config", "revision"], "workspace tasks loaded response");
      return {
        kind: "loaded",
        config: parseCatalog(loaded["config"], "workspace tasks loaded catalog"),
        revision: parseRevision(loaded, "revision", "workspace tasks loaded response"),
      };
    }
    case "missing": {
      const missing = requirePlainRecord(value, ["kind", "message", "hint", "revision"], "workspace tasks missing response");
      return {
        kind: "missing",
        message: parseMessage(missing, "message", "workspace tasks missing response"),
        hint: parseMessage(missing, "hint", "workspace tasks missing response"),
        revision: parseRevision(missing, "revision", "workspace tasks missing response"),
      };
    }
    case "invalid": {
      const invalidResponse = requirePlainRecord(value, ["kind", "message", "hint", "detail"], "workspace tasks invalid response");
      return {
        kind: "invalid",
        message: parseMessage(invalidResponse, "message", "workspace tasks invalid response"),
        hint: parseMessage(invalidResponse, "hint", "workspace tasks invalid response"),
        detail: parseMessage(invalidResponse, "detail", "workspace tasks invalid response"),
      };
    }
    case "unavailable": {
      const unavailable = requirePlainRecord(value, ["kind", "message", "hint", "detail"], "workspace tasks unavailable response");
      const detail = parseOptionalDetail(unavailable, "workspace tasks unavailable response");
      return {
        kind: "unavailable",
        message: parseMessage(unavailable, "message", "workspace tasks unavailable response"),
        hint: parseMessage(unavailable, "hint", "workspace tasks unavailable response"),
        ...(detail === undefined ? {} : { detail }),
      };
    }
    default:
      throw invalid("workspace tasks catalog response");
  }
}

export function parseGlobalWorkspaceTasksResponse(value: unknown): GlobalWorkspaceTasksResponse {
  const record = requirePlainRecord(
    value,
    ["kind", "config", "revision", "message", "hint", "detail"],
    "global workspace tasks response",
  );
  switch (record["kind"]) {
    case "loaded": {
      const loaded = requirePlainRecord(value, ["kind", "config", "revision"], "global workspace tasks loaded response");
      return {
        kind: "loaded",
        config: parseCatalog(loaded["config"], "global workspace tasks loaded catalog"),
        revision: parseRevision(loaded, "revision", "global workspace tasks loaded response"),
      };
    }
    case "invalid": {
      const invalidResponse = requirePlainRecord(value, ["kind", "message", "hint", "detail"], "global workspace tasks invalid response");
      return {
        kind: "invalid",
        message: parseMessage(invalidResponse, "message", "global workspace tasks invalid response"),
        hint: parseMessage(invalidResponse, "hint", "global workspace tasks invalid response"),
        detail: parseMessage(invalidResponse, "detail", "global workspace tasks invalid response"),
      };
    }
    default:
      throw invalid("global workspace tasks response");
  }
}

export function parseMoveWorkspaceTaskResult(value: unknown): MoveWorkspaceTaskResult {
  const record = requirePlainRecord(
    value,
    ["kind", "operationId", "phase", "workspace", "global", "reason", "message"],
    "workspace task move result",
  );
  switch (record["kind"]) {
    case "completed": {
      const completed = requirePlainRecord(value, ["kind", "operationId", "workspace", "global"], "workspace task completed result");
      return {
        kind: "completed",
        operationId: parseOperationId(completed, "operationId", "workspace task completed result"),
        workspace: parseWorkspaceTasksCatalogResponse(completed["workspace"]),
        global: parseGlobalWorkspaceTasksResponse(completed["global"]),
      };
    }
    case "partial": {
      const partial = requirePlainRecord(value, ["kind", "operationId", "phase", "workspace", "global"], "workspace task partial result");
      if (partial["phase"] !== "destination-written") throw invalid("workspace task partial result");
      return {
        kind: "partial",
        operationId: parseOperationId(partial, "operationId", "workspace task partial result"),
        phase: "destination-written",
        workspace: parseWorkspaceTasksCatalogResponse(partial["workspace"]),
        global: parseGlobalWorkspaceTasksResponse(partial["global"]),
      };
    }
    case "conflict": {
      const conflict = requirePlainRecord(value, ["kind", "reason", "message"], "workspace task move conflict result");
      return {
        kind: "conflict",
        reason: parseMoveConflictReason(conflict["reason"]),
        message: parseMessage(conflict, "message", "workspace task move conflict result"),
      };
    }
    case "validation": {
      const validation = requirePlainRecord(value, ["kind", "message"], "workspace task move validation result");
      return { kind: "validation", message: parseMessage(validation, "message", "workspace task move validation result") };
    }
    case "unavailable": {
      const unavailable = requirePlainRecord(value, ["kind", "message"], "workspace task move unavailable result");
      return { kind: "unavailable", message: parseMessage(unavailable, "message", "workspace task move unavailable result") };
    }
    case "unknown-outcome": {
      const unknownOutcome = requirePlainRecord(value, ["kind", "message"], "workspace task move unknown-outcome result");
      return { kind: "unknown-outcome", message: parseMessage(unknownOutcome, "message", "workspace task move unknown-outcome result") };
    }
    default:
      throw invalid("workspace task move result");
  }
}

export function parseWorkspaceTasksFailureResponse(value: unknown): WorkspaceTasksFailureResponse {
  const record = requirePlainRecord(
    value,
    ["kind", "reason", "message", "retryable"],
    "workspace tasks failure response",
  );
  switch (record["kind"]) {
    case "validation": {
      const validation = requirePlainRecord(value, ["kind", "message"], "workspace tasks validation failure");
      return { kind: "validation", message: parseMessage(validation, "message", "workspace tasks validation failure") };
    }
    case "conflict": {
      const conflict = requirePlainRecord(value, ["kind", "reason", "message"], "workspace tasks conflict failure");
      return {
        kind: "conflict",
        reason: parseConflictReason(conflict["reason"]),
        message: parseMessage(conflict, "message", "workspace tasks conflict failure"),
      };
    }
    case "unavailable": {
      const unavailable = requirePlainRecord(value, ["kind", "message", "retryable"], "workspace tasks unavailable failure");
      return {
        kind: "unavailable",
        message: parseMessage(unavailable, "message", "workspace tasks unavailable failure"),
        retryable: requireBoolean(unavailable, "retryable", "workspace tasks unavailable failure"),
      };
    }
    case "unknown-outcome": {
      const unknownOutcome = requirePlainRecord(value, ["kind", "message"], "workspace tasks unknown-outcome failure");
      return { kind: "unknown-outcome", message: parseMessage(unknownOutcome, "message", "workspace tasks unknown-outcome failure") };
    }
    default:
      throw invalid("workspace tasks failure response");
  }
}

function parseMoveSource(value: unknown): MoveWorkspaceTaskSource {
  const record = requirePlainRecord(value, ["ref", "expectedCatalog"], "workspace task move source");
  const ref = parseTaskRef(record["ref"], "workspace task move source reference");
  if (ref.scope === "workspace") {
    const expectedCatalog = parseWorkspaceCatalogExpectation(record["expectedCatalog"], "workspace task move source expectation", true);
    if (expectedCatalog.kind !== "loaded") throw invalid("workspace task move source expectation");
    return { ref, expectedCatalog };
  }
  return {
    ref,
    expectedCatalog: parseGlobalCatalogExpectation(record["expectedCatalog"], "global workspace task move source expectation"),
  };
}

function parseMoveDestination(value: unknown): MoveWorkspaceTaskDestination {
  const record = requirePlainRecord(value, ["scope", "expectedCatalog", "task"], "workspace task move destination");
  const scope = parseScope(record["scope"], "workspace task move destination");
  const task = parseTask(record["task"], "workspace task move destination task");
  if (scope === "workspace") {
    return {
      scope,
      expectedCatalog: parseWorkspaceCatalogExpectation(record["expectedCatalog"], "workspace task move destination expectation", false),
      task,
    };
  }
  return {
    scope,
    expectedCatalog: parseGlobalCatalogExpectation(record["expectedCatalog"], "global workspace task move destination expectation"),
    task,
  };
}

function parseWorkspaceCatalogExpectation(value: unknown, label: string, requireLoaded: boolean): WorkspaceCatalogExpectation {
  const record = requirePlainRecord(value, ["kind", "revision", "config"], label);
  switch (record["kind"]) {
    case "loaded": {
      const loaded = requirePlainRecord(value, ["kind", "revision", "config"], label);
      return {
        kind: "loaded",
        revision: parseRevision(loaded, "revision", label),
        config: parseCatalog(loaded["config"], `${label} catalog`),
      };
    }
    case "missing": {
      if (requireLoaded) throw invalid(label);
      const missing = requirePlainRecord(value, ["kind", "revision"], label);
      return { kind: "missing", revision: parseRevision(missing, "revision", label) };
    }
    default:
      throw invalid(label);
  }
}

function parseGlobalCatalogExpectation(value: unknown, label: string): GlobalCatalogExpectation {
  const record = requirePlainRecord(value, ["kind", "revision", "config"], label);
  if (record["kind"] !== "loaded") throw invalid(label);
  const loaded = requirePlainRecord(value, ["kind", "revision", "config"], label);
  return {
    kind: "loaded",
    revision: parseRevision(loaded, "revision", label),
    config: parseCatalog(loaded["config"], `${label} catalog`),
  };
}

type ParsedMoveTaskRef =
  | { scope: "workspace"; id: string }
  | { scope: "global"; id: string };

function parseTaskRef(value: unknown, label: string): ParsedMoveTaskRef {
  const record = requirePlainRecord(value, ["scope", "id"], label);
  const scope = parseScope(record["scope"], label);
  const id = requireNonBlankString(record, "id", label);
  if (!isWorkspaceTaskId(id)) throw invalid(label);
  if (scope === "workspace") return { scope: "workspace", id };
  return { scope: "global", id };
}

function parseTask(value: unknown, label: string): WorkspaceTask {
  const config = parseCatalog({ version: 1, tasks: [value] }, `${label} catalog`);
  const task = config.tasks[0];
  if (task === undefined) throw invalid(label);
  return task;
}

function parseCatalog(value: unknown, label: string): WorkspaceTasksConfig {
  const result = parseWorkspaceTasksConfig(value);
  if (!result.ok) throw invalid(label);
  try {
    assertWorkspaceTasksCatalogSize(result.config);
  } catch {
    throw invalid(label);
  }
  return result.config;
}

function parseOperationId(record: Record<string, unknown>, key: string, label: string): string {
  const operationId = requireNonBlankString(record, key, label);
  if (!isCanonicalLowercaseUuid(operationId)) throw invalid(label);
  return operationId;
}

function parseRevision(record: Record<string, unknown>, key: string, label: string): string {
  return requireNonBlankString(record, key, label);
}

function parseMoveIntent(value: unknown): MoveWorkspaceTaskIntent {
  if (value !== "start" && value !== "retry") throw invalid("workspace task move request");
  return value;
}

function parseScope(value: unknown, label: string): WorkspaceTaskScope {
  if (value !== "global" && value !== "workspace") throw invalid(label);
  return value;
}

function parseMoveConflictReason(value: unknown): MoveWorkspaceTaskConflictReason {
  if (!isMoveConflictReason(value)) throw invalid("workspace task move conflict result");
  return value;
}

function parseConflictReason(value: unknown): WorkspaceTasksConflictReason {
  if (!isConflictReason(value)) throw invalid("workspace tasks conflict failure");
  return value;
}

function isMoveConflictReason(value: unknown): value is MoveWorkspaceTaskConflictReason {
  return typeof value === "string" && WORKSPACE_TASKS_MOVE_CONFLICT_REASON_SET.has(value);
}

function isConflictReason(value: unknown): value is WorkspaceTasksConflictReason {
  return typeof value === "string" && WORKSPACE_TASKS_CONFLICT_REASON_SET.has(value);
}

function parseMessage(record: Record<string, unknown>, key: string, label: string): string {
  return requireNonBlankString(record, key, label);
}

function parseOptionalDetail(record: Record<string, unknown>, label: string): string | undefined {
  if (!Object.hasOwn(record, "detail")) return undefined;
  return requireNonBlankString(record, "detail", label);
}

function requireBoolean(record: Record<string, unknown>, key: string, label: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw invalid(label);
  return value;
}

function requireNonBlankString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") throw invalid(label);
  return value;
}

function requirePlainRecord(value: unknown, allowedFields: readonly string[], label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw invalid(label);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowedFields.includes(key))) throw invalid(label);
  return value;
}

function assertJsonByteLimit(value: unknown, limit: number, label: string): void {
  let serialized: string;
  try {
    const candidate = JSON.stringify(value);
    if (typeof candidate !== "string") throw new Error();
    serialized = candidate;
  } catch {
    throw invalid(label);
  }
  if (new TextEncoder().encode(serialized).byteLength > limit) throw invalid(label);
}

function invalid(label: string): Error {
  return new Error(`Invalid ${label}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
