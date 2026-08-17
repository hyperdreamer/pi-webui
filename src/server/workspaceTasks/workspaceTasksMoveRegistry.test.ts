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
  classifyWorkspaceTasksMovePair,
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

  it("binds start and retry permit minting to the callback that owns a deferred move lock", async () => {
    const startRegistry = new MachineGlobalTasksMoveRegistry(new ObservationPort());
    const startPlan = promotionPlan();
    const startGate = deferred<undefined>();
    const startEntered = deferred<undefined>();
    const heldStartLock = startRegistry.withMoveLock(startPlan.operationId, async () => {
      startEntered.resolve(undefined);
      await startGate.promise;
    });
    await startEntered.promise;

    let externallyMintedStart: WorkspaceTasksMovePermit | undefined;
    let startError: unknown;
    try {
      externallyMintedStart = startRegistry.beginStart(startPlan);
    } catch (error) {
      startError = error;
    }
    expect(externallyMintedStart).toBeUndefined();
    expect(startError).toBeInstanceOf(WorkspaceTasksMoveAuthorizationError);
    startGate.resolve(undefined);
    await heldStartLock;

    const retryRegistry = new MachineGlobalTasksMoveRegistry(new ObservationPort());
    const retryPlan = promotionPlan();
    const startPermit = await startAndMarkDestination(retryRegistry, retryPlan);
    const heldRetryGate = deferred<undefined>();
    const retryEntered = deferred<undefined>();
    const heldRetryLock = retryRegistry.withMoveLock(retryPlan.operationId, async () => {
      retryEntered.resolve(undefined);
      await heldRetryGate.promise;
    });
    await retryEntered.promise;

    let externallyMintedRetry: WorkspaceTasksMovePermit | undefined;
    let retryError: unknown;
    try {
      externallyMintedRetry = retryRegistry.beginRetry(withIntent(retryPlan, "retry"));
    } catch (error) {
      retryError = error;
    }
    expect(externallyMintedRetry).toBeUndefined();
    expect(retryError).toBeInstanceOf(WorkspaceTasksMoveAuthorizationError);
    heldRetryGate.resolve(undefined);
    await heldRetryLock;
    retryRegistry.release(startPermit);
  });

  it("retains callback ownership across its own deferred work", async () => {
    const registry = new MachineGlobalTasksMoveRegistry(new ObservationPort());
    const plan = promotionPlan();
    const gate = deferred<undefined>();
    const permitFromCallback = registry.withMoveLock(plan.operationId, async () => {
      await gate.promise;
      const permit = registry.beginStart(plan);
      registry.release(permit);
      return permit;
    });

    gate.resolve(undefined);
    await expect(permitFromCallback).resolves.toBeDefined();
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

  it("clears a pending claim after a known destination failure without observing it", async () => {
    const observation = new ObservationPort();
    const registry = new MachineGlobalTasksMoveRegistry(observation);
    const plan = promotionPlan();

    await registry.withMoveLock(plan.operationId, async () => {
      registry.beginStart(plan);
      await expect(registry.reconcileGlobalMoveClaim({ scope: "global" })).resolves.toBeUndefined();
      expect(observation.calls).toEqual([]);
    });

    let retryStartPermit: WorkspaceTasksMovePermit | undefined;
    await registry.withMoveLock(plan.operationId, () => {
      retryStartPermit = registry.beginStart(plan);
      registry.assertGlobalMutationAllowed(globalIntent(plan.destinationWrite), requirePermit(retryStartPermit));
      registry.release(requirePermit(retryStartPermit));
      return Promise.resolve();
    });
    expect(retryStartPermit).toBeDefined();
    expect(() => { registry.assertGlobalMutationAllowed(globalIntent(plan.destinationWrite), retryStartPermit); })
      .toThrow(WorkspaceTasksMoveAuthorizationError);
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

  it("keeps an owned destination-applied retransmitted start from publishing a second destination", async () => {
    const observation = new ObservationPort();
    const registry = new MachineGlobalTasksMoveRegistry(observation);
    const plan = promotionPlan();
    const startPermit = await startAndMarkDestination(registry, plan);
    observation.result = responsePair(plan, "destination-applied");
    let duplicateDestinationWrites = 0;

    expect(classifyWorkspaceTasksMovePair(plan, observation.result)).toBe("destination-applied");
    await expect(registry.withMoveLock(plan.operationId, () => {
      const duplicatePermit = registry.beginStart(plan);
      authorizePublication(registry, plan.destinationWrite, duplicatePermit);
      duplicateDestinationWrites += 1;
      return Promise.resolve();
    })).rejects.toBeInstanceOf(WorkspaceTasksMoveRecoveryPendingError);
    expect(duplicateDestinationWrites).toBe(0);
    registry.release(startPermit);
  });

  it("permits only phase-correct publications and leaves blocked write counters at zero", async () => {
    const registry = new MachineGlobalTasksMoveRegistry(new ObservationPort());
    const plan = promotionPlan();
    let globalWrites = 0;
    let workspaceWrites = 0;

    await registry.withMoveLock(plan.operationId, () => {
      const permit = registry.beginStart(plan);
      registry.assertGlobalMutationAllowed(globalIntent(plan.destinationWrite), permit);
      globalWrites += 1;
      expect(() => {
        registry.assertWorkspaceMutationAllowed(plan.address, workspaceIntent(plan.sourceRemoval), permit);
        workspaceWrites += 1;
      }).toThrow(WorkspaceTasksMoveAuthorizationError);
      expect(workspaceWrites).toBe(0);

      registry.markDestinationWritten(permit);
      expect(() => {
        registry.assertGlobalMutationAllowed(globalIntent(plan.destinationWrite), permit);
        globalWrites += 1;
      }).toThrow(WorkspaceTasksMoveAuthorizationError);
      expect(globalWrites).toBe(1);
      registry.assertWorkspaceMutationAllowed(plan.address, workspaceIntent(plan.sourceRemoval), permit);
      workspaceWrites += 1;
      registry.release(permit);
      return Promise.resolve();
    });

    expect(workspaceWrites).toBe(1);
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

  it("retains an invalid-observation claim for relevant writers without blocking unrelated workspaces", async () => {
    const observation = new ObservationPort();
    const registry = new MachineGlobalTasksMoveRegistry(observation);
    const plan = promotionPlan();
    const permit = await startAndMarkDestination(registry, plan);
    observation.result = {
      workspace: { kind: "invalid", message: "invalid", hint: "refresh", detail: "broken tasks file" },
      global: { kind: "loaded", config: emptyCatalog(), revision: globalRevision(emptyCatalog()) },
    };
    let blockedGlobalWrites = 0;
    let blockedWorkspaceWrites = 0;

    await expect(registry.reconcileGlobalMoveClaim({ scope: "global" }, permit))
      .rejects.toBeInstanceOf(WorkspaceTasksMoveRecoveryPendingError);
    expect(observation.calls).toEqual([plan.address]);
    expect(() => {
      registry.assertGlobalMutationAllowed(globalIntent(plan.destinationWrite));
      blockedGlobalWrites += 1;
    }).toThrow(WorkspaceTasksMoveRecoveryPendingError);
    expect(() => {
      registry.assertWorkspaceMutationAllowed(plan.address, workspaceIntent(plan.sourceRemoval));
      blockedWorkspaceWrites += 1;
    }).toThrow(WorkspaceTasksMoveRecoveryPendingError);
    expect(blockedGlobalWrites).toBe(0);
    expect(blockedWorkspaceWrites).toBe(0);
    await expect(registry.reconcileGlobalMoveClaim({ scope: "workspace", address: addressFor("unrelated") }))
      .resolves.toBeUndefined();
    expect(observation.calls).toEqual([plan.address]);
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

  it("clears a stale destination-written claim after a pristine observation before a new start publishes", async () => {
    const observation = new ObservationPort();
    const registry = new MachineGlobalTasksMoveRegistry(observation);
    const plan = promotionPlan();
    const stalePermit = await startAndMarkDestination(registry, plan);
    observation.result = responsePair(plan, "pristine");
    let destinationWrites = 0;

    expect(classifyWorkspaceTasksMovePair(plan, observation.result)).toBe("pristine");
    await expect(registry.reconcileGlobalMoveClaim({ scope: "global" }, stalePermit)).rejects.toMatchObject({
      code: "WORKSPACE_TASKS_MOVE_CONFLICT",
      reason: "unrecognized-state",
    });
    expect(destinationWrites).toBe(0);

    await registry.withMoveLock(plan.operationId, () => {
      const freshPermit = registry.beginStart(plan);
      authorizePublication(registry, plan.destinationWrite, freshPermit);
      destinationWrites += 1;
      registry.release(freshPermit);
      return Promise.resolve();
    });
    expect(destinationWrites).toBe(1);
  });

  it("keeps pristine retries and unowned destination-applied retries from writing the source", async () => {
    const plan = promotionPlan();
    const retryPlan = withIntent(plan, "retry");
    let sourceWrites = 0;

    expect(classifyWorkspaceTasksMovePair(plan, plan.pristine)).toBe("pristine");
    const pristineRegistry = new MachineGlobalTasksMoveRegistry(new ObservationPort());
    await expect(pristineRegistry.withMoveLock(plan.operationId, () => {
      const permit = pristineRegistry.beginRetry(retryPlan);
      pristineRegistry.assertWorkspaceMutationAllowed(plan.address, workspaceIntent(plan.sourceRemoval), permit);
      sourceWrites += 1;
      return Promise.resolve();
    })).rejects.toMatchObject({
      code: "WORKSPACE_TASKS_MOVE_CONFLICT",
      reason: "unowned-intermediate-state",
    });
    expect(sourceWrites).toBe(0);

    expect(classifyWorkspaceTasksMovePair(plan, plan.destinationApplied)).toBe("destination-applied");
    const unownedRegistry = new MachineGlobalTasksMoveRegistry(new ObservationPort());
    await expect(unownedRegistry.withMoveLock(plan.operationId, () => {
      const permit = unownedRegistry.beginRetry(retryPlan);
      unownedRegistry.assertWorkspaceMutationAllowed(plan.address, workspaceIntent(plan.sourceRemoval), permit);
      sourceWrites += 1;
      return Promise.resolve();
    })).rejects.toMatchObject({
      code: "WORKSPACE_TASKS_MOVE_CONFLICT",
      reason: "unowned-intermediate-state",
    });
    expect(sourceWrites).toBe(0);
  });

  it("lets a fresh matching retry prove an unknown destination outcome before it removes the source", async () => {
    const observation = new ObservationPort();
    const registry = new MachineGlobalTasksMoveRegistry(observation);
    const plan = promotionPlan();

    await registry.withMoveLock(plan.operationId, () => {
      const startPermit = registry.beginStart(plan);
      registry.markDestinationOutcomeUnknown(startPermit);
      return Promise.resolve();
    });

    let retryPermit: WorkspaceTasksMovePermit | undefined;
    await registry.withMoveLock(plan.operationId, () => {
      retryPermit = registry.beginRetry(withIntent(plan, "retry"));
      return Promise.resolve();
    });
    const liveRetryPermit = requirePermit(retryPermit);
    expect(() => { registry.assertWorkspaceMutationAllowed(plan.address, workspaceIntent(plan.sourceRemoval), liveRetryPermit); })
      .toThrow(WorkspaceTasksMoveRecoveryPendingError);

    observation.result = responsePair(plan, "destination-applied");
    await expect(registry.reconcileGlobalMoveClaim({ scope: "global" }, liveRetryPermit)).resolves.toBeUndefined();
    expect(() => { registry.assertWorkspaceMutationAllowed(plan.address, workspaceIntent(plan.sourceRemoval), liveRetryPermit); }).not.toThrow();
    registry.release(liveRetryPermit);
  });

  it("retains an acknowledged destination claim after an ambiguous source publication", async () => {
    const registry = new MachineGlobalTasksMoveRegistry(new ObservationPort());
    const plan = promotionPlan();
    const startPermit = await startAndMarkDestination(registry, plan);
    let sourceWrites = 0;

    registry.markDestinationOutcomeUnknown(startPermit);
    registry.release(startPermit);
    expect(() => {
      registry.assertWorkspaceMutationAllowed(plan.address, workspaceIntent(plan.sourceRemoval));
      sourceWrites += 1;
    }).toThrow(WorkspaceTasksMoveRecoveryPendingError);
    expect(sourceWrites).toBe(0);
    expect(() => { registry.assertGlobalMutationAllowed(globalIntent(plan.destinationWrite)); })
      .toThrow(WorkspaceTasksMoveRecoveryPendingError);
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

  it("serializes concurrent promotions and demotions before a second destination publication", async () => {
    const scenarios: { name: string; first: WorkspaceTasksMovePlan; second: WorkspaceTasksMovePlan }[] = [
      {
        name: "promotion",
        first: promotionPlan({ operationId: "33333333-3333-4333-8333-333333333333", workspaceId: "promotion-one" }),
        second: promotionPlan({ operationId: "44444444-4444-4444-8444-444444444444", workspaceId: "promotion-two" }),
      },
      {
        name: "demotion",
        first: demotionPlan({ operationId: "55555555-5555-4555-8555-555555555555", workspaceId: "demotion-one" }),
        second: demotionPlan({ operationId: "66666666-6666-4666-8666-666666666666", workspaceId: "demotion-two" }),
      },
    ];

    for (const scenario of scenarios) {
      const registry = new MachineGlobalTasksMoveRegistry(new ObservationPort());
      const firstEntered = deferred<undefined>();
      const releaseFirst = deferred<undefined>();
      const writes: string[] = [];
      let firstPermit: WorkspaceTasksMovePermit | undefined;
      const firstMove = registry.withMoveLock(scenario.first.operationId, async () => {
        firstPermit = registry.beginStart(scenario.first);
        firstEntered.resolve(undefined);
        await releaseFirst.promise;
        authorizePublication(registry, scenario.first.destinationWrite, requirePermit(firstPermit));
        writes.push(`${scenario.name}:first`);
        registry.markDestinationWritten(requirePermit(firstPermit));
      });
      await firstEntered.promise;

      const secondMove = registry.withMoveLock(scenario.second.operationId, () => {
        const secondPermit = registry.beginStart(scenario.second);
        authorizePublication(registry, scenario.second.destinationWrite, secondPermit);
        writes.push(`${scenario.name}:second`);
        return Promise.resolve();
      });
      releaseFirst.resolve(undefined);
      await firstMove;
      await expect(secondMove).rejects.toBeInstanceOf(WorkspaceTasksMoveRecoveryPendingError);
      expect(writes).toEqual([`${scenario.name}:first`]);
      registry.release(requirePermit(firstPermit));
    }
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
    let finalAssertionWrites = 0;
    expect(() => {
      registry.assertGlobalMutationAllowed(globalIntent(secondPlan.destinationWrite));
      finalAssertionWrites += 1;
    })
      .toThrow(WorkspaceTasksMoveRecoveryPendingError);
    expect(finalAssertionWrites).toBe(0);
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

function promotionPlan(options: { operationId?: string; destinationId?: string; workspaceId?: string } = {}): WorkspaceTasksMovePlan {
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
  return deriveWorkspaceTasksMovePlan(addressFor(options.workspaceId ?? "workspace"), request);
}

function demotionPlan(options: { operationId?: string; destinationId?: string; workspaceId?: string } = {}): WorkspaceTasksMovePlan {
  const workspaceId = options.workspaceId ?? "workspace";
  const source = catalogWithTask("global-build");
  const request: MoveWorkspaceTaskRequest = {
    operationId: options.operationId ?? "22222222-2222-4222-8222-222222222222",
    intent: "start",
    source: {
      ref: { scope: "global", id: "global-build" },
      expectedCatalog: { kind: "loaded", revision: globalRevision(source), config: source },
    },
    destination: {
      scope: "workspace",
      expectedCatalog: { kind: "missing", revision: `workspace-missing-${workspaceId}` },
      task: task(options.destinationId ?? "local-build"),
    },
  };
  return deriveWorkspaceTasksMovePlan(addressFor(workspaceId), request);
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
  state: "pristine" | "destination-applied" | "complete" | "unrecognized",
): { workspace: WorkspaceTasksCatalogResponse; global: GlobalWorkspaceTasksResponse } {
  if (state === "unrecognized") {
    return {
      workspace: { kind: "loaded", config: catalogWithTask("other"), revision: "other" },
      global: { kind: "loaded", config: emptyCatalog(), revision: "other" },
    };
  }

  const pair = state === "pristine"
    ? plan.pristine
    : state === "destination-applied"
      ? plan.destinationApplied
      : plan.complete;
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

function authorizePublication(
  registry: MachineGlobalTasksMoveRegistry,
  intent: WorkspaceTasksMoveWriteIntent,
  permit: WorkspaceTasksMovePermit,
): void {
  if (intent.scope === "global") {
    registry.assertGlobalMutationAllowed(intent, permit);
    return;
  }
  registry.assertWorkspaceMutationAllowed(intent.address, intent, permit);
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
