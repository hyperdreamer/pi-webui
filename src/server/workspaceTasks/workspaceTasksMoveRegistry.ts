import { AsyncLocalStorage } from "node:async_hooks";
import type {
  GlobalWorkspaceTasksResponse,
  WorkspaceCatalogAddress,
  WorkspaceTasksCatalogResponse,
} from "../../shared/apiTypes.js";
import {
  serializeWorkspaceTasksConfig,
  type WorkspaceTasksConfig,
} from "../../shared/workspaceTasks.js";
import type {
  WorkspaceTasksMoveObservationPort,
  WorkspaceTasksMovePermit,
  WorkspaceTasksMoveWriteIntent,
  WorkspaceTasksMutationSubject,
} from "./workspaceTasksErrors.js";
import type { WorkspaceTasksWorkspaceMutationCoordinator } from "./workspaceTasksWorkspaceCatalogAdapter.js";
import {
  classifyWorkspaceTasksMovePair,
  sameWorkspaceTasksMoveContext,
  type WorkspaceTasksMovePlan,
} from "./workspaceTasksMoveProtocol.js";

export type { WorkspaceTasksWorkspaceMutationCoordinator } from "./workspaceTasksWorkspaceCatalogAdapter.js";

export class WorkspaceTasksMoveAuthorizationError extends Error {
  readonly code = "WORKSPACE_TASKS_MOVE_AUTHORIZATION";

  constructor(message = "Workspace task move permit does not authorize this exact publication.") {
    super(message);
    this.name = "WorkspaceTasksMoveAuthorizationError";
  }
}

export class WorkspaceTasksMoveInProgressError extends Error {
  readonly code = "WORKSPACE_TASKS_MOVE_IN_PROGRESS";

  constructor() {
    super("Another workspace task move is in progress.");
    this.name = "WorkspaceTasksMoveInProgressError";
  }
}

export class WorkspaceTasksMoveRecoveryPendingError extends Error {
  readonly code = "WORKSPACE_TASKS_MOVE_RECOVERY_PENDING";

  constructor() {
    super("Workspace task move recovery is pending. Refresh before changing the affected catalog.");
    this.name = "WorkspaceTasksMoveRecoveryPendingError";
  }
}

export type WorkspaceTasksMoveConflictReason = "unrecognized-state" | "unowned-intermediate-state";

export class WorkspaceTasksMoveConflictError extends Error {
  readonly code = "WORKSPACE_TASKS_MOVE_CONFLICT";
  readonly reason: WorkspaceTasksMoveConflictReason;

  constructor(reason: WorkspaceTasksMoveConflictReason, message = conflictMessage(reason)) {
    super(message);
    this.name = "WorkspaceTasksMoveConflictError";
    this.reason = reason;
  }
}

interface MoveClaim {
  operationId: string;
  address: WorkspaceCatalogAddress;
  plan: WorkspaceTasksMovePlan;
  phase: "destination-pending" | "destination-written";
  destinationOutcome: "pending" | "acknowledged" | "unknown";
  permits: Set<PermitRecord>;
}

interface PermitRecord {
  claim: MoveClaim;
  purpose: "start" | "retry";
  active: boolean;
}

const permitRecords = new WeakMap<object, PermitRecord>();

/**
 * Process-local authority for one machine-global destination-first move.
 * Claims are intentionally not persisted; a new registry instance has no move
 * provenance and therefore cannot authorize source removal.
 */
export class MachineGlobalTasksMoveRegistry implements WorkspaceTasksWorkspaceMutationCoordinator {
  private claim: MoveClaim | undefined;
  private moveTail: Promise<void> = Promise.resolve();
  private activeMoveOperationId: string | undefined;
  private activeMoveLockToken: object | undefined;
  private readonly moveLockContext = new AsyncLocalStorage<object>();
  private readonly workspaceTails = new Map<string, Promise<void>>();

  constructor(private readonly observationPort: WorkspaceTasksMoveObservationPort) {}

  async withMoveLock<T>(operationId: string, operation: () => Promise<T>): Promise<T> {
    if (typeof operationId !== "string" || operationId.trim() === "") {
      throw new WorkspaceTasksMoveAuthorizationError("A move lock requires an operation ID.");
    }
    let releaseLock!: () => void;
    const previous = this.moveTail;
    const current = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.moveTail = previous.then(() => current);
    await previous;

    const lockToken = {};
    this.activeMoveOperationId = operationId;
    this.activeMoveLockToken = lockToken;
    try {
      return await this.moveLockContext.run(lockToken, operation);
    } finally {
      this.clearPendingClaim(operationId);
      this.activeMoveOperationId = undefined;
      this.activeMoveLockToken = undefined;
      releaseLock();
    }
  }

  async run<T>(address: WorkspaceCatalogAddress, operation: () => Promise<T>): Promise<T> {
    const key = addressKey(address);
    const previous = this.workspaceTails.get(key) ?? Promise.resolve();
    let releaseQueue!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const queued = previous.then(() => current);
    this.workspaceTails.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      releaseQueue();
      if (this.workspaceTails.get(key) === queued) this.workspaceTails.delete(key);
    }
  }

  beginStart(plan: WorkspaceTasksMovePlan): WorkspaceTasksMovePermit {
    this.assertLock(plan, "start");
    const existing = this.claim;
    if (existing !== undefined) {
      if (existing.operationId !== plan.operationId) throw phaseError(existing);
      if (!sameWorkspaceTasksMoveContext(existing.plan, plan)) {
        throw new WorkspaceTasksMoveConflictError("unrecognized-state", "A live operation ID was reused for different move content.");
      }
      throw phaseError(existing);
    }

    const claimPlan = structuredClone(plan);
    const claim: MoveClaim = {
      operationId: claimPlan.operationId,
      address: { ...claimPlan.address },
      plan: claimPlan,
      phase: "destination-pending",
      destinationOutcome: "pending",
      permits: new Set(),
    };
    this.claim = claim;
    return this.createPermit(claim, "start");
  }

  beginRetry(plan: WorkspaceTasksMovePlan): WorkspaceTasksMovePermit {
    this.assertLock(plan, "retry");
    const claim = this.claim;
    if (claim === undefined) {
      throw new WorkspaceTasksMoveConflictError("unowned-intermediate-state", "The destination state has no live move claim.");
    }
    if (claim.operationId !== plan.operationId || !sameWorkspaceTasksMoveContext(claim.plan, plan)) {
      throw new WorkspaceTasksMoveConflictError("unowned-intermediate-state", "The retry does not match the live move claim.");
    }
    if (claim.phase === "destination-pending") throw new WorkspaceTasksMoveInProgressError();
    return this.createPermit(claim, "retry");
  }

  markDestinationWritten(permit: WorkspaceTasksMovePermit): void {
    const record = this.requirePermit(permit);
    if (record.purpose !== "start" || record.claim.phase !== "destination-pending") {
      throw new WorkspaceTasksMoveAuthorizationError("Only a start permit can acknowledge its pending destination publication.");
    }
    record.claim.phase = "destination-written";
    record.claim.destinationOutcome = "acknowledged";
  }

  markDestinationOutcomeUnknown(permit: WorkspaceTasksMovePermit): void {
    const record = this.requirePermit(permit);
    if (record.purpose === "start" && record.claim.phase === "destination-pending") {
      record.claim.phase = "destination-written";
    } else if (record.claim.phase !== "destination-written") {
      throw new WorkspaceTasksMoveAuthorizationError("An unknown move outcome requires a live destination-written claim.");
    }
    record.claim.destinationOutcome = "unknown";
  }

  release(permit: WorkspaceTasksMovePermit): void {
    const record = this.requirePermit(permit);
    const claim = record.claim;
    if (this.claim !== claim) {
      this.invalidatePermit(record);
      return;
    }
    if (claim.destinationOutcome === "unknown") return;
    this.clearClaim(claim);
  }

  /**
   * Clear a claim only after its owner has consumed an authoritative
   * non-destination observation. Ordinary release retains unknown outcomes
   * because it has no evidence that the destination write did not apply.
   */
  releaseAfterAuthoritativeObservation(permit: WorkspaceTasksMovePermit): void {
    const record = this.requirePermit(permit);
    const claim = record.claim;
    if (this.claim !== claim) {
      this.invalidatePermit(record);
      return;
    }
    this.clearClaim(claim);
  }

  async reconcileGlobalMoveClaim(
    subject: WorkspaceTasksMutationSubject,
    permit?: WorkspaceTasksMovePermit,
  ): Promise<void> {
    const claim = this.claim;
    if (claim === undefined) {
      if (permit !== undefined) this.requirePermit(permit);
      return;
    }

    const permitRecord = permit === undefined ? undefined : this.requirePermit(permit, claim);
    if (claim.phase === "destination-pending") return;
    if (!isRelevantSubject(subject, claim)) return;

    let observed: {
      workspace: WorkspaceTasksCatalogResponse;
      global: GlobalWorkspaceTasksResponse;
    };
    try {
      observed = await this.observationPort.observe(claim.address);
    } catch {
      throw new WorkspaceTasksMoveRecoveryPendingError();
    }

    // A concurrent completion/replacement is allowed to change the live claim
    // while observation is suspended, but an old read must never clear it.
    if (this.claim !== claim) {
      if (this.claim === undefined) return;
      throw new WorkspaceTasksMoveRecoveryPendingError();
    }
    if (!isAuthoritativePair(observed)) throw new WorkspaceTasksMoveRecoveryPendingError();

    const state = classifyWorkspaceTasksMovePair(claim.plan, observed);
    if (state === "complete") {
      this.clearClaim(claim);
      return;
    }
    if (state === "destination-applied") {
      if (permitRecord !== undefined) {
        claim.destinationOutcome = "acknowledged";
        return;
      }
      throw new WorkspaceTasksMoveRecoveryPendingError();
    }

    this.clearClaim(claim);
    throw new WorkspaceTasksMoveConflictError("unrecognized-state");
  }

  assertGlobalMutationAllowed(
    intent?: Extract<WorkspaceTasksMoveWriteIntent, { scope: "global" }>,
    permit?: WorkspaceTasksMovePermit,
  ): void {
    const claim = this.claim;
    if (permit !== undefined) {
      const record = this.requirePermit(permit, claim);
      if (intent === undefined) throw new WorkspaceTasksMoveAuthorizationError("A move permit requires an exact global write intent.");
      this.assertPermitIntent(record, intent);
      return;
    }
    if (intent !== undefined && claim !== undefined) throw phaseError(claim);
  }

  assertWorkspaceMutationAllowed(
    address: WorkspaceCatalogAddress,
    intent?: Extract<WorkspaceTasksMoveWriteIntent, { scope: "workspace" }>,
    permit?: WorkspaceTasksMovePermit,
  ): void {
    const claim = this.claim;
    if (permit !== undefined) {
      const record = this.requirePermit(permit, claim);
      if (intent === undefined) throw new WorkspaceTasksMoveAuthorizationError("A move permit requires an exact workspace write intent.");
      if (!sameAddress(intent.address, address)) {
        throw new WorkspaceTasksMoveAuthorizationError();
      }
      this.assertPermitIntent(record, intent);
      return;
    }
    if (intent !== undefined && claim !== undefined && sameAddress(claim.address, address)) throw phaseError(claim);
  }

  private createPermit(claim: MoveClaim, purpose: "start" | "retry"): WorkspaceTasksMovePermit {
    // The brand is declared in the server error contract and intentionally has no public runtime constructor.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const permit = Object.freeze({}) as WorkspaceTasksMovePermit;
    const record: PermitRecord = { claim, purpose, active: true };
    claim.permits.add(record);
    permitRecords.set(permit, record);
    return permit;
  }

  private requirePermit(permit: WorkspaceTasksMovePermit, claim?: MoveClaim): PermitRecord {
    const candidate: unknown = permit;
    if (typeof candidate !== "object" || candidate === null) throw new WorkspaceTasksMoveAuthorizationError();
    const record = permitRecords.get(candidate);
    if (record?.active !== true) {
      throw new WorkspaceTasksMoveAuthorizationError("The move permit is stale or belongs to another registry claim.");
    }
    if (record.claim !== this.claim || (claim !== undefined && record.claim !== claim)) {
      throw new WorkspaceTasksMoveAuthorizationError("The move permit is stale or belongs to another registry claim.");
    }
    return record;
  }

  private assertPermitIntent(record: PermitRecord, intent: WorkspaceTasksMoveWriteIntent): void {
    const claim = record.claim;
    const expected = claim.phase === "destination-pending"
      ? claim.plan.destinationWrite
      : claim.destinationOutcome === "acknowledged"
        ? claim.plan.sourceRemoval
        : undefined;
    if (expected === undefined || !sameIntent(expected, intent)) {
      if (claim.phase === "destination-written" && claim.destinationOutcome === "unknown") {
        throw new WorkspaceTasksMoveRecoveryPendingError();
      }
      throw new WorkspaceTasksMoveAuthorizationError();
    }
  }

  private assertLock(plan: WorkspaceTasksMovePlan, expectedIntent: "start" | "retry"): void {
    if (this.activeMoveOperationId === undefined || this.activeMoveOperationId !== plan.operationId
      || this.activeMoveLockToken === undefined || this.moveLockContext.getStore() !== this.activeMoveLockToken) {
      throw new WorkspaceTasksMoveAuthorizationError("Move permits can only be created inside their operation lock.");
    }
    if (plan.intent !== expectedIntent) {
      throw new WorkspaceTasksMoveAuthorizationError(`Expected a ${expectedIntent} move request.`);
    }
  }

  private clearPendingClaim(operationId: string): void {
    const claim = this.claim;
    if (claim?.operationId === operationId && claim.phase === "destination-pending") {
      this.clearClaim(claim);
    }
  }

  private clearClaim(claim: MoveClaim): void {
    if (this.claim !== claim) return;
    this.claim = undefined;
    for (const permit of claim.permits) this.invalidatePermit(permit);
    claim.permits.clear();
  }

  private invalidatePermit(record: PermitRecord): void {
    record.active = false;
    record.claim.permits.delete(record);
  }
}

function sameIntent(left: WorkspaceTasksMoveWriteIntent, right: WorkspaceTasksMoveWriteIntent): boolean {
  if (left.scope !== right.scope || left.expectedRevision !== right.expectedRevision) return false;
  if (left.scope === "workspace" && right.scope === "workspace" && !sameAddress(left.address, right.address)) return false;
  return canonicalConfig(left.config) === canonicalConfig(right.config);
}

function canonicalConfig(config: WorkspaceTasksConfig): string {
  return serializeWorkspaceTasksConfig(config);
}

function sameAddress(left: WorkspaceCatalogAddress, right: WorkspaceCatalogAddress): boolean {
  return left.projectId === right.projectId && left.workspaceId === right.workspaceId;
}

function addressKey(address: WorkspaceCatalogAddress): string {
  return JSON.stringify([address.projectId, address.workspaceId]);
}

function isRelevantSubject(subject: WorkspaceTasksMutationSubject, claim: MoveClaim): boolean {
  return subject.scope === "global" || sameAddress(subject.address, claim.address);
}

function isAuthoritativePair(value: {
  workspace: WorkspaceTasksCatalogResponse;
  global: GlobalWorkspaceTasksResponse;
}): boolean {
  return (value.workspace.kind === "loaded" || value.workspace.kind === "missing") && value.global.kind === "loaded";
}

function phaseError(claim: MoveClaim): WorkspaceTasksMoveInProgressError | WorkspaceTasksMoveRecoveryPendingError {
  return claim.phase === "destination-pending"
    ? new WorkspaceTasksMoveInProgressError()
    : new WorkspaceTasksMoveRecoveryPendingError();
}

function conflictMessage(reason: WorkspaceTasksMoveConflictReason): string {
  return reason === "unowned-intermediate-state"
    ? "The intermediate workspace task state has no live move claim and requires manual resolution."
    : "The live move claim no longer matches the observed catalogs and requires manual resolution.";
}
