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
  WorkspaceTasksInvalidCatalogError,
  WorkspaceTasksRevisionConflictError,
  WorkspaceTasksUnavailableError,
  WorkspaceTasksUnknownOutcomeError,
  type WorkspaceTasksCatalogWriteOptions,
  type WorkspaceTasksMovePermit,
} from "./workspaceTasksErrors.js";
import {
  MachineGlobalTasksMoveRegistry,
  WorkspaceTasksMoveConflictError,
  WorkspaceTasksMoveInProgressError,
  WorkspaceTasksMoveRecoveryPendingError,
} from "./workspaceTasksMoveRegistry.js";
import {
  classifyWorkspaceTasksMovePair,
  deriveWorkspaceTasksMovePlan,
  WorkspaceTasksMoveValidationError,
  type WorkspaceTasksMovePlan,
} from "./workspaceTasksMoveProtocol.js";
import {
  type WorkspaceTasksGlobalCatalogAdapter,
} from "./workspaceTasksGlobalCatalogAdapter.js";
import {
  type WorkspaceTasksWorkspaceCatalogAdapter,
} from "./workspaceTasksWorkspaceCatalogAdapter.js";

export interface WorkspaceTasksCatalogService {
  readWorkspace(input: WorkspaceCatalogAddress): Promise<WorkspaceTasksCatalogResponse>;
  replaceWorkspace(input: WorkspaceCatalogAddress & ReplaceWorkspaceTasksRequest): Promise<WorkspaceTasksCatalogResponse>;
  readGlobal(): Promise<GlobalWorkspaceTasksResponse>;
  replaceGlobal(input: ReplaceGlobalWorkspaceTasksRequest): Promise<GlobalWorkspaceTasksResponse>;
  move(input: WorkspaceCatalogAddress & MoveWorkspaceTaskRequest): Promise<MoveWorkspaceTaskResult>;
}

export interface WorkspaceTasksCatalogServiceDependencies {
  globalAdapter: WorkspaceTasksGlobalCatalogAdapter;
  workspaceAdapter: WorkspaceTasksWorkspaceCatalogAdapter;
  registry: MachineGlobalTasksMoveRegistry;
}

type MoveConflictReason = Extract<MoveWorkspaceTaskResult, { kind: "conflict" }>["reason"];

interface MoveObservation {
  workspace: WorkspaceTasksCatalogResponse;
  global: GlobalWorkspaceTasksResponse;
}

type ReadMoveResult =
  | { kind: "observation"; observed: MoveObservation }
  | { kind: "result"; result: MoveWorkspaceTaskResult };

type ClaimReconciliation =
  | { kind: "clear" }
  | { kind: "recovery-pending"; error: WorkspaceTasksMoveRecoveryPendingError }
  | { kind: "conflict"; error: WorkspaceTasksMoveConflictError };

const UNKNOWN_OUTCOME_MESSAGE = new WorkspaceTasksUnknownOutcomeError().message;

export function createWorkspaceTasksCatalogService(
  deps: WorkspaceTasksCatalogServiceDependencies,
): WorkspaceTasksCatalogService {
  const { globalAdapter, workspaceAdapter, registry } = deps;

  return {
    readWorkspace(address) {
      return workspaceAdapter.read(address);
    },

    replaceWorkspace(input) {
      const { projectId, workspaceId, expectedRevision, config } = input;
      return workspaceAdapter.replace({ projectId, workspaceId }, { expectedRevision, config });
    },

    readGlobal() {
      return globalAdapter.read();
    },

    replaceGlobal(input) {
      return globalAdapter.replace(input);
    },

    async move(input) {
      let plan: WorkspaceTasksMovePlan;
      try {
        plan = deriveWorkspaceTasksMovePlan(
          { projectId: input.projectId, workspaceId: input.workspaceId },
          {
            operationId: input.operationId,
            intent: input.intent,
            source: input.source,
            destination: input.destination,
          },
        );
      } catch (error) {
        return resultFromMoveError(error);
      }

      try {
        return await registry.withMoveLock(plan.operationId, () => executeMove(plan));
      } catch (error) {
        return resultFromMoveError(error);
      }
    },
  };

  async function executeMove(plan: WorkspaceTasksMovePlan): Promise<MoveWorkspaceTaskResult> {
    const reconciliation = await reconcileExistingClaim();
    const before = await readBeforeMove(plan.address);
    if (before.kind === "result") return before.result;
    const state = classifyWorkspaceTasksMovePair(plan, before.observed);

    if (reconciliation.kind === "conflict") {
      if (plan.intent === "retry" && state === "pristine") return retryPristineResult();
      return conflictResult(reconciliation.error.reason, reconciliation.error.message);
    }

    if (reconciliation.kind === "recovery-pending") {
      if (state === "destination-applied") {
        if (plan.intent === "start") return partialResult(plan, before.observed);
        let permit: WorkspaceTasksMovePermit;
        try {
          permit = registry.beginRetry(asRetryPlan(plan));
        } catch (error) {
          return resultFromMoveError(error);
        }
        return removeSource(plan, permit);
      }
      if (state === "complete") {
        try {
          await registry.reconcileGlobalMoveClaim({ scope: "global" });
          return completedResult(plan, before.observed);
        } catch (error) {
          return resultFromMoveError(error);
        }
      }
      return conflictResult("move-in-progress", reconciliation.error.message);
    }

    switch (state) {
      case "complete":
        return completedResult(plan, before.observed);
      case "pristine":
        if (plan.intent === "retry") return retryPristineResult();
        return startMove(plan);
      case "destination-applied":
        return conflictResult(
          "unowned-intermediate-state",
          "The destination state has no live move claim.",
        );
      case "unrecognized":
        return hasDestinationCollision(plan, before.observed)
          ? conflictResult("destination-collision", "The destination task ID is already in use.")
          : conflictResult("source-changed", "Workspace task catalogs changed. Refresh before moving this task.");
    }
  }

  async function reconcileExistingClaim(): Promise<ClaimReconciliation> {
    try {
      await registry.reconcileGlobalMoveClaim({ scope: "global" });
      return { kind: "clear" };
    } catch (error) {
      if (error instanceof WorkspaceTasksMoveRecoveryPendingError) {
        return { kind: "recovery-pending", error };
      }
      if (error instanceof WorkspaceTasksMoveConflictError) {
        return { kind: "conflict", error };
      }
      throw error;
    }
  }

  async function startMove(plan: WorkspaceTasksMovePlan): Promise<MoveWorkspaceTaskResult> {
    const permit = registry.beginStart(plan);
    const destinationState: { value: string } = { value: "pending" };
    const options: WorkspaceTasksCatalogWriteOptions = {
      permit,
      onWriteAcknowledged: () => {
        destinationState.value = "acknowledged";
        registry.markDestinationWritten(permit);
      },
      onWriteOutcomeUnknown: () => {
        destinationState.value = "unknown";
        registry.markDestinationOutcomeUnknown(permit);
      },
    };

    try {
      await writeIntent(plan.destinationWrite, options);
    } catch (error) {
      if (destinationState.value === "pending") return resultFromMoveError(error);
      return handleDestinationFailure(plan, permit, destinationState.value === "unknown");
    }

    const verification = await readAfterWrite(plan.address);
    if (verification.kind === "result") return verification.result;
    const state = classifyWorkspaceTasksMovePair(plan, verification.observed);
    if (state === "complete") return completeWithPermit(plan, permit, verification.observed);
    if (state !== "destination-applied") return reconcileDestinationObservation(permit);
    return removeSource(plan, permit);
  }

  async function handleDestinationFailure(
    plan: WorkspaceTasksMovePlan,
    permit: WorkspaceTasksMovePermit,
    destinationOutcomeUnknown: boolean,
  ): Promise<MoveWorkspaceTaskResult> {
    const verification = await readAfterWrite(plan.address);
    if (verification.kind === "result") return verification.result;
    const state = classifyWorkspaceTasksMovePair(plan, verification.observed);
    if (state === "complete") return completeWithPermit(plan, permit, verification.observed);
    if (state === "destination-applied" && !destinationOutcomeUnknown) {
      return partialResult(plan, verification.observed);
    }
    if (state !== "destination-applied") return reconcileDestinationObservation(permit);
    return unknownOutcomeResult(UNKNOWN_OUTCOME_MESSAGE);
  }

  async function reconcileDestinationObservation(permit: WorkspaceTasksMovePermit): Promise<MoveWorkspaceTaskResult> {
    try {
      await registry.reconcileGlobalMoveClaim({ scope: "global" }, permit);
    } catch (error) {
      if (error instanceof WorkspaceTasksMoveConflictError) {
        return conflictResult(error.reason, error.message);
      }
      return resultFromMoveError(error);
    }
    return conflictResult("unrecognized-state", "The move state no longer matches its live claim.");
  }
  async function removeSource(
    plan: WorkspaceTasksMovePlan,
    permit: WorkspaceTasksMovePermit,
  ): Promise<MoveWorkspaceTaskResult> {
    try {
      await writeIntent(plan.sourceRemoval, { permit });
    } catch {
      return handleSourceFailure(plan, permit);
    }

    const verification = await readAfterWrite(plan.address);
    if (verification.kind === "result") return verification.result;
    return settleSourceObservation(plan, permit, verification.observed);
  }

  async function handleSourceFailure(
    plan: WorkspaceTasksMovePlan,
    permit: WorkspaceTasksMovePermit,
  ): Promise<MoveWorkspaceTaskResult> {
    const verification = await readAfterWrite(plan.address);
    if (verification.kind === "result") return verification.result;
    return settleSourceObservation(plan, permit, verification.observed);
  }

  async function settleSourceObservation(
    plan: WorkspaceTasksMovePlan,
    permit: WorkspaceTasksMovePermit,
    observed: MoveObservation,
  ): Promise<MoveWorkspaceTaskResult> {
    const state = classifyWorkspaceTasksMovePair(plan, observed);
    if (state === "complete") return completeWithPermit(plan, permit, observed);
    if (state === "destination-applied") return partialResult(plan, observed);

    try {
      await registry.reconcileGlobalMoveClaim({ scope: "global" }, permit);
    } catch (error) {
      if (error instanceof WorkspaceTasksMoveConflictError) {
        return conflictResult(error.reason, error.message);
      }
      return resultFromMoveError(error);
    }
    return conflictResult("unrecognized-state", "The move state no longer matches its live claim.");
  }

  async function completeWithPermit(
    plan: WorkspaceTasksMovePlan,
    permit: WorkspaceTasksMovePermit,
    observed: MoveObservation,
  ): Promise<MoveWorkspaceTaskResult> {
    try {
      await registry.reconcileGlobalMoveClaim({ scope: "global" }, permit);
      return completedResult(plan, observed);
    } catch (error) {
      if (error instanceof WorkspaceTasksMoveRecoveryPendingError) return unknownOutcomeResult(UNKNOWN_OUTCOME_MESSAGE);
      return resultFromMoveError(error);
    }
  }

  async function writeIntent(
    intent: WorkspaceTasksMovePlan["destinationWrite"],
    options: WorkspaceTasksCatalogWriteOptions,
  ): Promise<void> {
    if (intent.scope === "global") {
      await globalAdapter.replace({ expectedRevision: intent.expectedRevision, config: intent.config }, options);
      return;
    }
    await workspaceAdapter.replace(
      intent.address,
      { expectedRevision: intent.expectedRevision, config: intent.config },
      options,
    );
  }

  async function readBeforeMove(address: WorkspaceCatalogAddress): Promise<ReadMoveResult> {
    try {
      const observed = await observe(address);
      if (observed.workspace.kind === "invalid" || observed.global.kind === "invalid") {
        return { kind: "result", result: conflictResult("invalid-catalog", "A workspace task catalog is invalid.") };
      }
      if (observed.workspace.kind === "unavailable") {
        return { kind: "result", result: unavailableResult("The workspace task catalog is unavailable.") };
      }
      return { kind: "observation", observed };
    } catch (error) {
      return { kind: "result", result: resultFromMoveError(error) };
    }
  }

  async function readAfterWrite(address: WorkspaceCatalogAddress): Promise<ReadMoveResult> {
    try {
      const observed = await observe(address);
      if (observed.workspace.kind !== "loaded" && observed.workspace.kind !== "missing") {
        return { kind: "result", result: unknownOutcomeResult(UNKNOWN_OUTCOME_MESSAGE) };
      }
      if (observed.global.kind !== "loaded") {
        return { kind: "result", result: unknownOutcomeResult(UNKNOWN_OUTCOME_MESSAGE) };
      }
      return { kind: "observation", observed };
    } catch {
      return { kind: "result", result: unknownOutcomeResult(UNKNOWN_OUTCOME_MESSAGE) };
    }
  }

  async function observe(address: WorkspaceCatalogAddress): Promise<MoveObservation> {
    const workspace = await workspaceAdapter.read(address);
    const global = await globalAdapter.read();
    return { workspace, global };
  }
}

function asRetryPlan(plan: WorkspaceTasksMovePlan): WorkspaceTasksMovePlan {
  if (plan.intent === "retry") return plan;
  return {
    ...plan,
    intent: "retry",
    request: { ...plan.request, intent: "retry" },
  };
}

function completedResult(plan: WorkspaceTasksMovePlan, observed: MoveObservation): MoveWorkspaceTaskResult {
  return {
    kind: "completed",
    operationId: plan.operationId,
    workspace: observed.workspace,
    global: observed.global,
  };
}

function partialResult(plan: WorkspaceTasksMovePlan, observed: MoveObservation): MoveWorkspaceTaskResult {
  return {
    kind: "partial",
    operationId: plan.operationId,
    phase: "destination-written",
    workspace: observed.workspace,
    global: observed.global,
  };
}

function retryPristineResult(): MoveWorkspaceTaskResult {
  return conflictResult("retry-pristine", "The original move is still pristine. Confirm the move again.");
}

function hasDestinationCollision(plan: WorkspaceTasksMovePlan, observed: MoveObservation): boolean {
  const destination = plan.destination.scope === "global" ? observed.global : observed.workspace;
  return destination.kind === "loaded"
    && destination.config.tasks.some((task) => task.id === plan.destination.task.id);
}

function conflictResult(reason: MoveConflictReason, message: string): MoveWorkspaceTaskResult {
  return { kind: "conflict", reason, message };
}

function unavailableResult(message: string): MoveWorkspaceTaskResult {
  return { kind: "unavailable", message };
}

function unknownOutcomeResult(message: string): MoveWorkspaceTaskResult {
  return { kind: "unknown-outcome", message };
}

function resultFromMoveError(error: unknown): MoveWorkspaceTaskResult {
  if (error instanceof WorkspaceTasksMoveValidationError) {
    return { kind: "validation", message: error.message };
  }
  if (error instanceof WorkspaceTasksMoveConflictError) {
    return conflictResult(error.reason, error.message);
  }
  if (error instanceof WorkspaceTasksMoveInProgressError || error instanceof WorkspaceTasksMoveRecoveryPendingError) {
    return conflictResult("move-in-progress", error.message);
  }
  if (error instanceof WorkspaceTasksInvalidCatalogError) {
    return conflictResult("invalid-catalog", error.message);
  }
  if (error instanceof WorkspaceTasksRevisionConflictError) {
    return conflictResult("source-changed", error.message);
  }
  if (error instanceof WorkspaceTasksUnknownOutcomeError) {
    return unknownOutcomeResult(error.message);
  }
  if (error instanceof WorkspaceTasksUnavailableError) {
    return unavailableResult(error.message);
  }
  if (error instanceof Error && error.message.includes("already exists")) {
    return conflictResult("destination-collision", error.message);
  }
  return unavailableResult("Workspace task move is unavailable.");
}
