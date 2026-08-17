import { createHash } from "node:crypto";
import type {
  GlobalCatalogExpectation,
  GlobalWorkspaceTasksResponse,
  MoveWorkspaceTaskDestination,
  MoveWorkspaceTaskRequest,
  MoveWorkspaceTaskSource,
  WorkspaceCatalogAddress,
  WorkspaceCatalogExpectation,
  WorkspaceTasksCatalogResponse,
} from "../../shared/apiTypes.js";
import {
  deriveWorkspaceTaskMove,
  isWorkspaceTaskId,
  parseWorkspaceTasksConfig,
  serializeWorkspaceTasksConfig,
  type WorkspaceTask,
  type WorkspaceTaskRef,
  type WorkspaceTasksConfig,
} from "../../shared/workspaceTasks.js";
import {
  WorkspaceTasksInvalidCatalogError,
  WorkspaceTasksRevisionConflictError,
  type WorkspaceTasksMoveWriteIntent,
} from "./workspaceTasksErrors.js";

export type WorkspaceTasksMovePairState =
  | "pristine"
  | "destination-applied"
  | "complete"
  | "unrecognized";

export interface WorkspaceTasksMoveCatalogPair {
  workspace: WorkspaceCatalogExpectation;
  global: GlobalCatalogExpectation;
}


interface WorkspaceTasksMoveObservationPair {
  workspace: WorkspaceTasksCatalogResponse;
  global: GlobalWorkspaceTasksResponse;
}

export interface WorkspaceTasksMovePlan {
  address: WorkspaceCatalogAddress;
  operationId: string;
  intent: MoveWorkspaceTaskRequest["intent"];
  request: MoveWorkspaceTaskRequest;
  source: MoveWorkspaceTaskSource;
  destination: MoveWorkspaceTaskDestination;
  pristine: WorkspaceTasksMoveCatalogPair;
  destinationApplied: WorkspaceTasksMoveCatalogPair;
  complete: WorkspaceTasksMoveCatalogPair;
  destinationWrite: WorkspaceTasksMoveWriteIntent;
  sourceRemoval: WorkspaceTasksMoveWriteIntent;
  readonly destinationIntent: WorkspaceTasksMoveWriteIntent;
  readonly sourceIntent: WorkspaceTasksMoveWriteIntent;
}

export class WorkspaceTasksMoveValidationError extends Error {
  readonly code = "WORKSPACE_TASKS_MOVE_VALIDATION";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceTasksMoveValidationError";
  }
}

/**
 * Derives every catalog state a destination-first move is allowed to publish.
 * The function only consumes already parsed wire data; filesystem and config
 * observations stay outside this protocol boundary.
 */
export function deriveWorkspaceTasksMovePlan(
  address: WorkspaceCatalogAddress,
  request: MoveWorkspaceTaskRequest,
): WorkspaceTasksMovePlan {
  assertAddress(address);
  const operationId: unknown = Reflect.get(request, "operationId");
  assertOperationId(operationId);
  const intent: unknown = Reflect.get(request, "intent");
  if (!isMoveIntent(intent)) throw new WorkspaceTasksMoveValidationError("Workspace task move intent is invalid");

  const source = normalizeSource(request.source);
  const destination = normalizeDestination(request.destination);
  if (source.ref.scope === destination.scope) {
    throw new WorkspaceTasksMoveValidationError("Workspace task moves must cross scopes");
  }

  const sourceTaskCount = source.expectedCatalog.config.tasks.filter((task) => task.id === source.ref.id).length;
  if (sourceTaskCount !== 1) {
    throw new WorkspaceTasksMoveValidationError(`Source task must resolve exactly once: ${source.ref.id}`);
  }

  const destinationCatalog = destination.expectedCatalog.kind === "missing"
    ? emptyCatalog()
    : destination.expectedCatalog.config;
  const transformed = deriveWorkspaceTaskMove({
    source: { ref: source.ref, config: source.expectedCatalog.config },
    destination: {
      scope: destination.scope,
      config: destinationCatalog,
      task: destination.task,
    },
  });

  const pristine = pairFor(source, destination);
  const destinationApplied = pairAfterDestination(source, destination, transformed.destinationAfter);
  const complete = pairAfterComplete(source, destination, transformed.sourceAfter, transformed.destinationAfter);
  const destinationWrite = destinationWriteIntent(address, destination, transformed.destinationAfter);
  const sourceRemoval = sourceRemovalIntent(address, source, transformed.sourceAfter);
  const normalizedRequest: MoveWorkspaceTaskRequest = {
    operationId,
    intent,
    source,
    destination,
  };

  return {
    address: { ...address },
    operationId,
    intent,
    request: normalizedRequest,
    source,
    destination,
    pristine,
    destinationApplied,
    complete,
    destinationWrite,
    sourceRemoval,
    destinationIntent: destinationWrite,
    sourceIntent: sourceRemoval,
  };
}

/**
 * Compares an authoritative observation with the three exact states derived
 * from a move. Invalid and unavailable observations are deliberately
 * unrecognized rather than being treated as an empty catalog.
 */
export function classifyWorkspaceTasksMovePair(
  plan: WorkspaceTasksMovePlan,
  observed: WorkspaceTasksMoveCatalogPair | WorkspaceTasksMoveObservationPair,
): WorkspaceTasksMovePairState {
  if (matchesPair(plan.pristine, observed)) return "pristine";
  if (matchesPair(plan.destinationApplied, observed)) return "destination-applied";
  if (matchesPair(plan.complete, observed)) return "complete";
  return "unrecognized";
}

/**
 * A retry changes only the request intent. This identity intentionally keeps
 * all semantic expectations, ordering, address, and derived publications.
 */
export function sameWorkspaceTasksMoveContext(
  left: WorkspaceTasksMovePlan,
  right: WorkspaceTasksMovePlan,
): boolean {
  return moveContextKey(left) === moveContextKey(right);
}

export function workspaceTasksGlobalCatalogRevision(config: WorkspaceTasksConfig): string {
  return createHash("sha256").update(serializeWorkspaceTasksConfig(config), "utf8").digest("hex");
}

export function workspaceTasksWorkspaceCatalogRevision(config: WorkspaceTasksConfig): string {
  const hash = createHash("sha256");
  hash.update("workspace-task-file:present\0", "utf8");
  hash.update(Buffer.from(serializeWorkspaceTasksConfig(config), "utf8"));
  return hash.digest("hex");
}


function normalizeSource(source: MoveWorkspaceTaskSource): MoveWorkspaceTaskSource {
  assertTaskRef(source.ref);
  if (source.ref.scope === "workspace") {
    const expectedCatalog = normalizeLoadedWorkspaceExpectation(source.expectedCatalog, "source");
    assertSourceTask(expectedCatalog.config, source.ref.id);
    return {
      ref: { scope: "workspace", id: source.ref.id },
      expectedCatalog,
    };
  }

  const expectedCatalog = normalizeGlobalExpectation(source.expectedCatalog, "source");
  assertSourceTask(expectedCatalog.config, source.ref.id);
  return {
    ref: { scope: "global", id: source.ref.id },
    expectedCatalog,
  };
}

function normalizeDestination(destination: MoveWorkspaceTaskDestination): MoveWorkspaceTaskDestination {
  if (destination.scope === "workspace") {
    return {
      scope: "workspace",
      expectedCatalog: normalizeWorkspaceExpectation(destination.expectedCatalog, "destination"),
      task: normalizeTask(destination.task),
    };
  }
  const expectedCatalog = normalizeGlobalExpectation(destination.expectedCatalog, "destination");
  return {
    scope: "global",
    expectedCatalog,
    task: normalizeTask(destination.task),
  };
}

function normalizeGlobalExpectation(
  expectation: unknown,
  label: string,
): GlobalCatalogExpectation {
  if (!isRecord(expectation) || expectation["kind"] !== "loaded" || typeof expectation["revision"] !== "string"
    || expectation["revision"].trim() === "") {
    throw new WorkspaceTasksMoveValidationError(`Workspace task ${label} expectation is invalid`);
  }
  const config = normalizeCatalog(expectation["config"], `${label} expectation`);
  const normalized: GlobalCatalogExpectation = { kind: "loaded", revision: expectation["revision"], config };
  if (normalized.revision !== workspaceTasksGlobalCatalogRevision(normalized.config)) {
    throw new WorkspaceTasksRevisionConflictError();
  }
  return normalized;
}

function normalizeLoadedWorkspaceExpectation(
  expectation: unknown,
  label: string,
): Extract<WorkspaceCatalogExpectation, { kind: "loaded" }> {
  if (!isRecord(expectation) || expectation["kind"] !== "loaded" || typeof expectation["revision"] !== "string"
    || expectation["revision"].trim() === "") {
    throw new WorkspaceTasksMoveValidationError(`Workspace task ${label} expectation is invalid`);
  }
  return {
    kind: "loaded",
    revision: expectation["revision"],
    config: normalizeCatalog(expectation["config"], `${label} expectation`),
  };
}

function normalizeWorkspaceExpectation(
  expectation: WorkspaceCatalogExpectation,
  label: string,
): WorkspaceCatalogExpectation {
  if (!isRecord(expectation) || typeof expectation.revision !== "string" || expectation.revision.trim() === "") {
    throw new WorkspaceTasksMoveValidationError(`Workspace task ${label} expectation is invalid`);
  }
  if (expectation.kind === "missing") return { kind: "missing", revision: expectation.revision };
  return normalizeLoadedWorkspaceExpectation(expectation, label);
}

function normalizeTask(task: WorkspaceTask): WorkspaceTask {
  const parsed = parseWorkspaceTasksConfig({ version: 1, tasks: [task] });
  if (!parsed.ok) throw new WorkspaceTasksInvalidCatalogError(parsed.error);
  const normalized = parsed.config.tasks[0];
  if (normalized === undefined) throw new WorkspaceTasksInvalidCatalogError("Move destination task is missing");
  return normalized;
}

function normalizeCatalog(value: unknown, label: string): WorkspaceTasksConfig {
  const parsed = parseWorkspaceTasksConfig(value);
  if (!parsed.ok) throw new WorkspaceTasksInvalidCatalogError(`${label}: ${parsed.error}`);
  return parsed.config;
}

function pairFor(
  source: MoveWorkspaceTaskSource,
  destination: MoveWorkspaceTaskDestination,
): WorkspaceTasksMoveCatalogPair {
  if (source.ref.scope === "workspace") {
    if (destination.scope !== "global") throw new WorkspaceTasksMoveValidationError("Workspace task moves must cross scopes");
    return { workspace: source.expectedCatalog, global: destination.expectedCatalog };
  }
  if (destination.scope !== "workspace") throw new WorkspaceTasksMoveValidationError("Workspace task moves must cross scopes");
  return { workspace: destination.expectedCatalog, global: source.expectedCatalog };
}

function pairAfterDestination(
  source: MoveWorkspaceTaskSource,
  destination: MoveWorkspaceTaskDestination,
  destinationAfter: WorkspaceTasksConfig,
): WorkspaceTasksMoveCatalogPair {
  const pristine = pairFor(source, destination);
  if (destination.scope === "workspace") {
    return {
      workspace: { kind: "loaded", config: destinationAfter, revision: workspaceTasksWorkspaceCatalogRevision(destinationAfter) },
      global: pristine.global,
    };
  }
  return {
    workspace: pristine.workspace,
    global: { kind: "loaded", config: destinationAfter, revision: workspaceTasksGlobalCatalogRevision(destinationAfter) },
  };
}

function pairAfterComplete(
  source: MoveWorkspaceTaskSource,
  destination: MoveWorkspaceTaskDestination,
  sourceAfter: WorkspaceTasksConfig,
  destinationAfter: WorkspaceTasksConfig,
): WorkspaceTasksMoveCatalogPair {
  const destinationPair = pairAfterDestination(source, destination, destinationAfter);
  if (source.ref.scope === "workspace") {
    return {
      workspace: { kind: "loaded", config: sourceAfter, revision: workspaceTasksWorkspaceCatalogRevision(sourceAfter) },
      global: destinationPair.global,
    };
  }
  return {
    workspace: destinationPair.workspace,
    global: { kind: "loaded", config: sourceAfter, revision: workspaceTasksGlobalCatalogRevision(sourceAfter) },
  };
}

function destinationWriteIntent(
  address: WorkspaceCatalogAddress,
  destination: MoveWorkspaceTaskDestination,
  destinationAfter: WorkspaceTasksConfig,
): WorkspaceTasksMoveWriteIntent {
  if (destination.scope === "workspace") {
    return {
      scope: "workspace",
      address: { ...address },
      expectedRevision: destination.expectedCatalog.revision,
      config: destinationAfter,
    };
  }
  return {
    scope: "global",
    expectedRevision: destination.expectedCatalog.revision,
    config: destinationAfter,
  };
}

function sourceRemovalIntent(
  address: WorkspaceCatalogAddress,
  source: MoveWorkspaceTaskSource,
  sourceAfter: WorkspaceTasksConfig,
): WorkspaceTasksMoveWriteIntent {
  if (source.ref.scope === "workspace") {
    return {
      scope: "workspace",
      address: { ...address },
      expectedRevision: source.expectedCatalog.revision,
      config: sourceAfter,
    };
  }
  return {
    scope: "global",
    expectedRevision: source.expectedCatalog.revision,
    config: sourceAfter,
  };
}

function matchesPair(
  expected: WorkspaceTasksMoveCatalogPair,
  observed: WorkspaceTasksMoveCatalogPair | WorkspaceTasksMoveObservationPair,
): boolean {
  return matchesWorkspaceExpectation(expected.workspace, observed.workspace)
    && matchesGlobalExpectation(expected.global, observed.global);
}

function matchesWorkspaceExpectation(
  expected: WorkspaceCatalogExpectation,
  observed: WorkspaceCatalogExpectation | WorkspaceTasksCatalogResponse,
): boolean {
  if (expected.kind === "missing") return observed.kind === "missing" && observed.revision === expected.revision;
  return observed.kind === "loaded"
    && observed.revision === expected.revision
    && semanticConfigEqual(expected.config, observed.config);
}

function matchesGlobalExpectation(
  expected: GlobalCatalogExpectation,
  observed: GlobalCatalogExpectation | GlobalWorkspaceTasksResponse,
): boolean {
  return observed.kind === "loaded"
    && observed.revision === expected.revision
    && semanticConfigEqual(expected.config, observed.config);
}

function semanticConfigEqual(left: WorkspaceTasksConfig, right: WorkspaceTasksConfig): boolean {
  try {
    const parsed = parseWorkspaceTasksConfig(right);
    return parsed.ok && serializeWorkspaceTasksConfig(left) === serializeWorkspaceTasksConfig(parsed.config);
  } catch {
    return false;
  }
}

function moveContextKey(plan: WorkspaceTasksMovePlan): string {
  return JSON.stringify({
    address: plan.address,
    operationId: plan.operationId,
    source: plan.source,
    destination: plan.destination,
    pristine: plan.pristine,
    destinationApplied: plan.destinationApplied,
    complete: plan.complete,
    destinationWrite: plan.destinationWrite,
    sourceRemoval: plan.sourceRemoval,
  });
}

function assertAddress(address: WorkspaceCatalogAddress): void {
  if (!isRecord(address) || typeof address.projectId !== "string" || typeof address.workspaceId !== "string"
    || address.projectId.trim() === "" || address.workspaceId.trim() === "") {
    throw new WorkspaceTasksMoveValidationError("Workspace catalog address is invalid");
  }
}

function assertOperationId(operationId: unknown): asserts operationId is string {
  if (typeof operationId !== "string" || operationId.trim() === "") {
    throw new WorkspaceTasksMoveValidationError("Workspace task move operation ID is invalid");
  }
}

function assertTaskRef(value: unknown): asserts value is WorkspaceTaskRef {
  if (!isRecord(value) || (value["scope"] !== "global" && value["scope"] !== "workspace")
    || typeof value["id"] !== "string" || !isWorkspaceTaskId(value["id"])) {
    throw new WorkspaceTasksMoveValidationError("Workspace task move source reference is invalid");
  }
}

function assertSourceTask(config: WorkspaceTasksConfig, id: string): void {
  const count = config.tasks.filter((task) => task.id === id).length;
  if (count !== 1) throw new WorkspaceTasksMoveValidationError(`Source task must resolve exactly once: ${id}`);
}

function isMoveIntent(value: unknown): value is MoveWorkspaceTaskRequest["intent"] {
  return value === "start" || value === "retry";
}

function emptyCatalog(): WorkspaceTasksConfig {
  return { version: 1, tasks: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
