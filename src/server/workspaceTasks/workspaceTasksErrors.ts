import type {
  GlobalWorkspaceTasksResponse,
  WorkspaceCatalogAddress,
  WorkspaceTasksCatalogResponse,
} from "../../shared/apiTypes.js";
import type { WorkspaceTasksConfig } from "../../shared/workspaceTasks.js";

const REVISION_CONFLICT_MESSAGE = "Workspace tasks changed. Refresh and try again.";
const INVALID_CATALOG_MESSAGE = "The global workspace tasks catalog is invalid.";
const UNAVAILABLE_MESSAGE = "The global workspace tasks catalog is unavailable.";
const UNKNOWN_OUTCOME_MESSAGE = "The global workspace tasks write may have completed. Refresh before trying again.";

export class WorkspaceTasksRevisionConflictError extends Error {
  readonly code = "WORKSPACE_TASKS_REVISION_CONFLICT";

  constructor() {
    super(REVISION_CONFLICT_MESSAGE);
    this.name = "WorkspaceTasksRevisionConflictError";
  }
}

export class WorkspaceTasksInvalidCatalogError extends Error {
  readonly code = "WORKSPACE_TASKS_INVALID_CATALOG";
  readonly detail: string;

  constructor(detail: string) {
    super(INVALID_CATALOG_MESSAGE);
    this.name = "WorkspaceTasksInvalidCatalogError";
    this.detail = detail;
  }
}

export class WorkspaceTasksUnavailableError extends Error {
  readonly code = "WORKSPACE_TASKS_UNAVAILABLE";

  constructor() {
    super(UNAVAILABLE_MESSAGE);
    this.name = "WorkspaceTasksUnavailableError";
  }
}

export class WorkspaceTasksUnknownOutcomeError extends Error {
  readonly code = "WORKSPACE_TASKS_UNKNOWN_OUTCOME";

  constructor() {
    super(UNKNOWN_OUTCOME_MESSAGE);
    this.name = "WorkspaceTasksUnknownOutcomeError";
  }
}

declare const workspaceTasksMovePermitBrand: unique symbol;

/**
 * Opaque server-only capability. The move registry is the sole producer; task
 * adapters only receive it to authorize one exact derived publication.
 */
export interface WorkspaceTasksMovePermit {
  readonly [workspaceTasksMovePermitBrand]: true;
}

export interface GlobalWorkspaceTasksMutationSubject {
  scope: "global";
}

export interface WorkspaceTasksMutationSubjectForWorkspace {
  scope: "workspace";
  address: WorkspaceCatalogAddress;
}

export type WorkspaceTasksMutationSubject =
  | GlobalWorkspaceTasksMutationSubject
  | WorkspaceTasksMutationSubjectForWorkspace;

export interface GlobalWorkspaceTasksMoveWriteIntent {
  scope: "global";
  expectedRevision: string;
  config: WorkspaceTasksConfig;
}

export interface WorkspaceTasksMoveWriteIntentForWorkspace {
  scope: "workspace";
  address: WorkspaceCatalogAddress;
  expectedRevision: string;
  config: WorkspaceTasksConfig;
}

export type WorkspaceTasksMoveWriteIntent =
  | GlobalWorkspaceTasksMoveWriteIntent
  | WorkspaceTasksMoveWriteIntentForWorkspace;

export interface WorkspaceTasksMoveObservationPort {
  observe(address: WorkspaceCatalogAddress): Promise<{
    workspace: WorkspaceTasksCatalogResponse;
    global: GlobalWorkspaceTasksResponse;
  }>;
}

export interface WorkspaceTasksMutationAuthorizer {
  reconcileGlobalMoveClaim(subject: WorkspaceTasksMutationSubject, permit?: WorkspaceTasksMovePermit): Promise<void>;
  assertGlobalMutationAllowed(
    intent?: Extract<WorkspaceTasksMoveWriteIntent, { scope: "global" }>,
    permit?: WorkspaceTasksMovePermit,
  ): void;
  assertWorkspaceMutationAllowed(
    address: WorkspaceCatalogAddress,
    intent?: Extract<WorkspaceTasksMoveWriteIntent, { scope: "workspace" }>,
    permit?: WorkspaceTasksMovePermit,
  ): void;
}

export interface WorkspaceTasksCatalogWriteOptions {
  permit?: WorkspaceTasksMovePermit;
  onWriteAcknowledged?: () => void;
  onWriteOutcomeUnknown?: () => void;
}
