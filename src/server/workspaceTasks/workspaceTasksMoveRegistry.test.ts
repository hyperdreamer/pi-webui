import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  GlobalWorkspaceTasksResponse,
  MoveWorkspaceTaskRequest,
  WorkspaceCatalogAddress,
  WorkspaceCatalogExpectation,
  WorkspaceTasksCatalogResponse,
} from "../../shared/apiTypes.js";
import {
  serializeWorkspaceTasksConfig,
  type WorkspaceTask,
  type WorkspaceTasksConfig,
} from "../../shared/workspaceTasks.js";
import {
  deriveWorkspaceTasksMovePlan,
  type WorkspaceTasksMovePlan,
} from "./workspaceTasksMoveProtocol.js";
import {
  MachineGlobalTasksMoveRegistry,
  WorkspaceTasksMoveAuthorizationError,
  WorkspaceTasksMoveConflictError,
  WorkspaceTasksMoveInProgressError,
  WorkspaceTasksMoveRecoveryPendingError,
} from "./workspaceTasksMoveRegistry.js";
import type {
  WorkspaceTasksMoveObservationPort,
  WorkspaceTasksMovePermit,
  WorkspaceTasksMoveWriteIntent,
} from "./workspaceTasksErrors.js";

type GlobalMoveWriteIntent = Extract<WorkspaceTasksMoveWriteIntent, { scope: "global" }>;
type WorkspaceMoveWriteIntent = Extract<WorkspaceTasksMoveWriteIntent, { scope: "workspace" }>;

describe("MachineGlobalTasksMoveRegistry", () => {
  it("only creates permits inside the matching move lock and rejects a permit from another registry", async () => {
    const registry = new MachineGlobalTasksMoveRegistry(new ObservationPort());
    const otherRegistry = new MachineGlobalTasksMoveRegistry(new ObservationPort());
    const plan = promotionPlan();

    expect(() => registry.beginStart(plan)).toThrow(WorkspaceTasksMoveAuthorizationError);
    const otherPermit = await startAndMarkDestination(otherRegistry, plan);

    let permit: WorkspaceTasksMovePermit | undefined;
    await registry.withMoveLock(plan.operationId, () => {
      permit = registry.beginStart(plan);
      expect(permit).toBeDefined();
      expect(() => { registry.assertGlobalMutationAllowed(globalIntent(plan.destinationWrite)); })
        .toThrow(WorkspaceTasksMoveInProgressError);
      expect(() => { registry.assertGlobalMutationAllowed(globalIntent(plan.destinationWrite), otherPermit); })
        .toThrow(WorkspaceTasksMoveAuthorizationError);
      registry.release(requirePermit(permit));
      return Promise.resolve();
    });
  });

  it("blocks global and participating-workspace writes during a pending claim but permits reads and unrelated workspaces", async () => {
    const registry = new MachineGlobalTasksMoveRegistry(new ObservationPort());
    const plan = promotionPlan();
    const gate = deferred<undefined>();
    const entered = deferred<WorkspaceTasksMovePermit>();
    const operation = registry.withMoveLock(plan.operationId, async () => {
      const permit = registry.beginStart(plan);
      entered.resolve(permit);
      await gate.promise;
    });
    const permit = await entered.promise;

    expect(() => { registry.assertGlobalMutationAllowed(globalIntent(plan.destinationWrite)); })
      .toThrow(WorkspaceTasksMoveInProgressError);
    expect(() => { registry.assertWorkspaceMutationAllowed(plan.address, workspaceIntent(plan.sourceRemoval)); })
      .toThrow(WorkspaceTasksMoveInProgressError);
    expect(() => { registry.assertWorkspaceMutationAllowed(addressFor("unrelated")); }).not.toThrow();
    await expect(registry.reconcileGlobalMoveClaim({ scope: "global" })).resolves.toBeUndefined();
    await expect(registry.reconcileGlobalMoveClaim({ scope: "workspace", address: addressFor("unrelated") })).resolves.toBeUndefined();
    expect(() => { registry.assertGlobalMutationAllowed(globalIntent(plan.destinationWrite), permit); }).not.toThrow();

    registry.release(permit);
    gate.resolve(undefined);
    await operation;
    expect(() => { registry.assertGlobalMutationAllowed(); }).not.toThrow();
  });

  it("shares one FIFO workspace queue for the adapter and explorer gate", async () => {
    const registry = new MachineGlobalTasksMoveRegistry(new ObservationPort());
    const first = addressFor("first");
    const other = addressFor("other");
    const firstGate = deferred<undefined>();
    const firstStarted = deferred<undefined>();
    const otherStarted = deferred<undefined>();
    const order: string[] = [];

    const firstOperation = registry.run(first, () => {
      order.push("first:start");
      firstStarted.resolve(undefined);
      return firstGate.promise.then(() => {
        order.push("first:end");
      });
    });
    await firstStarted.promise;

    const secondOperation = registry.run(first, () => Promise.resolve().then(() => {
      order.push("second:start");
      order.push("second:end");
    }));
    const unrelatedOperation = registry.run(other, () => Promise.resolve().then(() => {
      order.push("other:start");
      otherStarted.resolve(undefined);
    }));

    await otherStarted.promise;
    expect(order).toEqual(["first:start", "other:start"]);
    firstGate.resolve(undefined);
    await Promise.all([firstOperation, secondOperation, unrelatedOperation]);
    expect(order).toEqual(["first:start", "other:start", "first:end", "second:start", "second:end"]);
  });

  it("keeps a destination-written claim for partial recovery and allows only its exact retry publication", async () => {
    const observation = new ObservationPort();
    const registry = new MachineGlobalTasksMoveRegistry(observation);
    const plan = promotionPlan();
    const startPermit = await startAndMarkDestination(registry, plan);
    const retryPlan = withIntent(plan, "retry");

    expect(() => { registry.assertWorkspaceMutationAllowed(plan.address, workspaceIntent(plan.sourceRemoval), startPermit); }).not.toThrow();
    expect(() => { registry.assertGlobalMutationAllowed(globalIntent(plan.destinationWrite), startPermit); })
      .toThrow(WorkspaceTasksMoveAuthorizationError);

    let retryPermit: WorkspaceTasksMovePermit | undefined;
    await registry.withMoveLock(plan.operationId, () => {
      retryPermit = registry.beginRetry(retryPlan);
      return Promise.resolve();
    });
    const liveRetryPermit = requirePermit(retryPermit);
    expect(() => { registry.assertWorkspaceMutationAllowed(plan.address, workspaceIntent(plan.sourceRemoval), liveRetryPermit); })
      .not.toThrow();
    registry.release(liveRetryPermit);
    expect(() => { registry.assertGlobalMutationAllowed(); }).not.toThrow();
  });

  it("rejects operation content reuse, wrong operation IDs, and every mismatched permit intent", async () => {
    const registry = new MachineGlobalTasksMoveRegistry(new ObservationPort());
    const plan = promotionPlan();
    const permit = await startAndMarkDestination(registry, plan);
    const changedPlan = promotionPlan({ destinationId: "different" });
    const otherOperationPlan = promotionPlan({ operationId: "33333333-3333-4333-8333-333333333333" });

    await expect(registry.withMoveLock(otherOperationPlan.operationId, () => {
      registry.beginStart(otherOperationPlan);
      return Promise.resolve();
    })).rejects.toThrow(WorkspaceTasksMoveRecoveryPendingError);

    await expect(registry.withMoveLock(plan.operationId, () => {
      registry.beginStart(changedPlan);
      return Promise.resolve();
    })).rejects.toThrow(WorkspaceTasksMoveConflictError);

    await expect(registry.withMoveLock(plan.operationId, () => {
      registry.beginRetry(withIntent(changedPlan, "retry"));
      return Promise.resolve();
    })).rejects.toThrow(WorkspaceTasksMoveConflictError);

    const wrongWorkspaceRevision: WorkspaceMoveWriteIntent = {
      ...workspaceIntent(plan.sourceRemoval),
      expectedRevision: "wrong",
    };
    expect(() => { registry.assertWorkspaceMutationAllowed(plan.address, wrongWorkspaceRevision, permit); })
      .toThrow(WorkspaceTasksMoveAuthorizationError);
    const wrongGlobalRevision: GlobalMoveWriteIntent = {
      ...globalIntent(plan.destinationWrite),
      expectedRevision: "wrong",
    };
    expect(() => { registry.assertGlobalMutationAllowed(wrongGlobalRevision, permit); })
      .toThrow(WorkspaceTasksMoveAuthorizationError);
    const arbitraryGlobalIntent: GlobalMoveWriteIntent = {
      scope: "global",
      expectedRevision: globalIntent(plan.destinationWrite).expectedRevision,
      config: catalogWithTask("arbitrary"),
    };
    expect(() => { registry.assertGlobalMutationAllowed(arbitraryGlobalIntent, permit); })
      .toThrow(WorkspaceTasksMoveAuthorizationError);
    expect(() => { registry.assertWorkspaceMutationAllowed(addressFor("other"), workspaceIntent(plan.sourceRemoval), permit); })
      .toThrow(WorkspaceTasksMoveAuthorizationError);
    expect(() => { registry.assertGlobalMutationAllowed(undefined, permit); }).toThrow(WorkspaceTasksMoveAuthorizationError);
  });

  it("retains recovery blocking claims for unavailable or invalid relevant observations", async () => {
    const observation = new ObservationPort();
    const registry = new MachineGlobalTasksMoveRegistry(observation);
    const plan = promotionPlan();
    const permit = await startAndMarkDestination(registry, plan);
    observation.result = {
      workspace: { kind: "unavailable", message: "unavailable", hint: "refresh" },
      global: { kind: "loaded", config: emptyCatalog(), revision: "global" },
    };

    await expect(registry.reconcileGlobalMoveClaim({ scope: "global" })).rejects.toBeInstanceOf(WorkspaceTasksMoveRecoveryPendingError);
    expect(observation.calls).toEqual([plan.address]);
    await expect(registry.reconcileGlobalMoveClaim({ scope: "workspace", address: plan.address }, permit))
      .rejects.toBeInstanceOf(WorkspaceTasksMoveRecoveryPendingError);
    expect(observation.calls).toEqual([plan.address, plan.address]);

    await expect(registry.reconcileGlobalMoveClaim({ scope: "workspace", address: addressFor("unrelated") })).resolves.toBeUndefined();
    expect(observation.calls).toHaveLength(2);
    expect(() => { registry.assertGlobalMutationAllowed(globalIntent(plan.destinationWrite)); })
      .toThrow(WorkspaceTasksMoveRecoveryPendingError);
    expect(() => { registry.assertWorkspaceMutationAllowed(addressFor("unrelated")); }).not.toThrow();
    registry.release(permit);
  });

  it("acknowledges an exact destination pair, clears a complete claim, and never observes unrelated workspaces", async () => {
    const observation = new ObservationPort();
    const registry = new MachineGlobalTasksMoveRegistry(observation);
    const plan = promotionPlan();
    const permit = await startAndMarkDestination(registry, plan);
    observation.result = responsePair(plan, "destination-applied");

    await expect(registry.reconcileGlobalMoveClaim({ scope: "global" }, permit)).resolves.toBeUndefined();
    expect(() => { registry.assertWorkspaceMutationAllowed(plan.address, workspaceIntent(plan.sourceRemoval), permit); }).not.toThrow();

    observation.result = responsePair(plan, "complete");
    await expect(registry.reconcileGlobalMoveClaim({ scope: "workspace", address: plan.address }, permit)).resolves.toBeUndefined();
    expect(() => { registry.assertGlobalMutationAllowed(); }).not.toThrow();

    const callsBeforeUnrelated = observation.calls.length;
    await expect(registry.reconcileGlobalMoveClaim({ scope: "workspace", address: addressFor("unrelated") })).resolves.toBeUndefined();
    expect(observation.calls).toHaveLength(callsBeforeUnrelated);
  });

  it("clears an unrecognized claim only while returning a manual-resolution conflict", async () => {
    const observation = new ObservationPort();
    const registry = new MachineGlobalTasksMoveRegistry(observation);
    const plan = promotionPlan();
    const permit = await startAndMarkDestination(registry, plan);
    observation.result = responsePair(plan, "unrecognized");

    await expect(registry.reconcileGlobalMoveClaim({ scope: "global" }, permit)).rejects.toMatchObject({
      code: "WORKSPACE_TASKS_MOVE_CONFLICT",
      reason: "unrecognized-state",
    });
    expect(() => { registry.assertGlobalMutationAllowed(); }).not.toThrow();
  });

  it("marks an uncertain destination outcome as blocking until an exact observation proves it", async () => {
    const observation = new ObservationPort();
    const registry = new MachineGlobalTasksMoveRegistry(observation);
    const plan = promotionPlan();
    const permit = await startAndMarkDestination(registry, plan, true);

    expect(() => { registry.assertWorkspaceMutationAllowed(plan.address, workspaceIntent(plan.sourceRemoval), permit); })
      .toThrow(WorkspaceTasksMoveRecoveryPendingError);
    observation.result = responsePair(plan, "destination-applied");
    await registry.reconcileGlobalMoveClaim({ scope: "global" }, permit);
    expect(() => { registry.assertWorkspaceMutationAllowed(plan.address, workspaceIntent(plan.sourceRemoval), permit); }).not.toThrow();
    registry.release(permit);
  });

  it("loses claims on process restart and refuses retry of an unowned intermediate pair", async () => {
    const oldRegistry = new MachineGlobalTasksMoveRegistry(new ObservationPort());
    const plan = promotionPlan();
    await startAndMarkDestination(oldRegistry, plan);

    const restartedRegistry = new MachineGlobalTasksMoveRegistry(new ObservationPort());
    await expect(restartedRegistry.withMoveLock(plan.operationId, () => {
      restartedRegistry.beginRetry(withIntent(plan, "retry"));
      return Promise.resolve();
    })).rejects.toMatchObject({
      code: "WORKSPACE_TASKS_MOVE_CONFLICT",
      reason: "unowned-intermediate-state",
    });
    expect(() => { restartedRegistry.assertGlobalMutationAllowed(); }).not.toThrow();
  });

  it("does not let a late reconciliation clear a newer claim", async () => {
    const observation = new ObservationPort();
    const registry = new MachineGlobalTasksMoveRegistry(observation);
    const firstPlan = promotionPlan();
    const firstPermit = await startAndMarkDestination(registry, firstPlan);
    const responseReady = deferred<undefined>();
    observation.waitForResponse = responseReady.promise;
    const reconciliation = registry.reconcileGlobalMoveClaim({ scope: "global" }, firstPermit);
    await observation.observationStarted.promise;

    registry.release(firstPermit);
    const secondPlan = promotionPlan({ operationId: "33333333-3333-4333-8333-333333333333", destinationId: "second" });
    const secondPermit = await startAndMarkDestination(registry, secondPlan);
    responseReady.resolve(undefined);
    await expect(reconciliation).rejects.toBeInstanceOf(WorkspaceTasksMoveRecoveryPendingError);
    expect(() => { registry.assertGlobalMutationAllowed(globalIntent(secondPlan.destinationWrite)); })
      .toThrow(WorkspaceTasksMoveRecoveryPendingError);
    registry.release(secondPermit);
  });
});

class ObservationPort implements WorkspaceTasksMoveObservationPort {
  calls: WorkspaceCatalogAddress[] = [];
  result: { workspace: WorkspaceTasksCatalogResponse; global: GlobalWorkspaceTasksResponse } = {
    workspace: { kind: "loaded", config: catalogWithTask("build"), revision: "workspace-source" },
    global: { kind: "loaded", config: emptyCatalog(), revision: "global" },
  };
  waitForResponse: Promise<undefined> | undefined;
  observationStarted = deferred<undefined>();

  async observe(address: WorkspaceCatalogAddress): Promise<{ workspace: WorkspaceTasksCatalogResponse; global: GlobalWorkspaceTasksResponse }> {
    this.calls.push(address);
    this.observationStarted.resolve(undefined);
    await this.waitForResponse;
    return this.result;
  }
}

function promotionPlan(options: { operationId?: string; destinationId?: string } = {}): WorkspaceTasksMovePlan {
  const source = catalogWithTask("build");
  const destination = emptyCatalog();
  const destinationTask = task(options.destinationId ?? "release");
  const request: MoveWorkspaceTaskRequest = {
    operationId: options.operationId ?? "11111111-1111-4111-8111-111111111111",
    intent: "start",
    source: {
      ref: { scope: "workspace", id: "build" },
      expectedCatalog: { kind: "loaded", revision: "workspace-source", config: source },
    },
    destination: {
      scope: "global",
      expectedCatalog: { kind: "loaded", revision: globalRevision(destination), config: destination },
      task: destinationTask,
    },
  };
  return deriveWorkspaceTasksMovePlan(addressFor("workspace"), request);
}

async function startAndMarkDestination(
  registry: MachineGlobalTasksMoveRegistry,
  plan: WorkspaceTasksMovePlan,
  outcomeUnknown = false,
): Promise<WorkspaceTasksMovePermit> {
  let permit: WorkspaceTasksMovePermit | undefined;
  await registry.withMoveLock(plan.operationId, () => {
    permit = registry.beginStart(plan);
    if (outcomeUnknown) registry.markDestinationOutcomeUnknown(requirePermit(permit));
    else registry.markDestinationWritten(requirePermit(permit));
    return Promise.resolve();
  });
  return requirePermit(permit);
}

function withIntent(plan: WorkspaceTasksMovePlan, intent: "start" | "retry"): WorkspaceTasksMovePlan {
  return {
    ...plan,
    intent,
    request: { ...plan.request, intent },
  };
}

function responsePair(
  plan: WorkspaceTasksMovePlan,
  state: "destination-applied" | "complete" | "unrecognized",
): { workspace: WorkspaceTasksCatalogResponse; global: GlobalWorkspaceTasksResponse } {
  if (state === "unrecognized") {
    return {
      workspace: { kind: "loaded", config: catalogWithTask("other"), revision: "other" },
      global: { kind: "loaded", config: emptyCatalog(), revision: "other" },
    };
  }

  const pair = state === "destination-applied" ? plan.destinationApplied : plan.complete;
  return {
    workspace: workspaceResponse(pair.workspace),
    global: { kind: "loaded", config: pair.global.config, revision: pair.global.revision },
  };
}

function workspaceResponse(expectation: WorkspaceCatalogExpectation): WorkspaceTasksCatalogResponse {
  if (expectation.kind === "missing") {
    return { kind: "missing", message: "missing", hint: "missing", revision: expectation.revision };
  }
  return { kind: "loaded", config: expectation.config, revision: expectation.revision };
}

function globalIntent(intent: WorkspaceTasksMoveWriteIntent): GlobalMoveWriteIntent {
  if (intent.scope !== "global") throw new Error("Expected a global move intent");
  return intent;
}

function workspaceIntent(intent: WorkspaceTasksMoveWriteIntent): WorkspaceMoveWriteIntent {
  if (intent.scope !== "workspace") throw new Error("Expected a workspace move intent");
  return intent;
}

function requirePermit(permit: WorkspaceTasksMovePermit | undefined): WorkspaceTasksMovePermit {
  if (permit === undefined) throw new Error("Expected a live move permit");
  return permit;
}

function addressFor(workspaceId: string): WorkspaceCatalogAddress {
  return { projectId: "project", workspaceId };
}

function task(id: string): WorkspaceTask {
  return { id, title: `${id} task`, command: `npm run ${id}`, confirm: false };
}

function catalogWithTask(id: string): WorkspaceTasksConfig {
  return { version: 1, tasks: [task(id)] };
}

function emptyCatalog(): WorkspaceTasksConfig {
  return { version: 1, tasks: [] };
}

function globalRevision(config: WorkspaceTasksConfig): string {
  return createHash("sha256").update(serializeWorkspaceTasksConfig(config), "utf8").digest("hex");
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolveValue: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolveValue === undefined) throw new Error("Deferred promise resolver is unavailable");
      resolveValue(value);
    },
  };
}
