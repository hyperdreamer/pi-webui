import { describe, expect, it, vi } from "vitest";
import type { MoveWorkspaceTaskRequest } from "../../shared/apiTypes.js";
import { ProjectService } from "../projects/projectService.js";
import { ProjectStore } from "../storage/projectStore.js";
import { WorkspaceService } from "../workspaces/workspaceService.js";
import type { WorkspaceTasksMoveObservationPort } from "./workspaceTasksErrors.js";
import {
  WorkspaceTasksUnknownOutcomeError,
} from "./workspaceTasksErrors.js";
import {
  MachineGlobalTasksMoveRegistry,
  WorkspaceTasksMoveRecoveryPendingError,
} from "./workspaceTasksMoveRegistry.js";
import {
  createWorkspaceTasksComposition,
  type WorkspaceTasksComposition,
} from "./workspaceTasksComposition.js";
import type { WorkspaceTasksCatalogService } from "./workspaceTasksCatalogService.js";
import {
  ControlledConfigCoordinator,
  ControlledGlobalCatalogAdapter,
  ControlledWorkspaceCatalogAdapter,
  ControlledWorkspaceFileResolver,
  TEST_ADDRESS,
  catalogWithTasks,
  emptyCatalog,
  loadedGlobal,
  loadedWorkspace,
  missingWorkspace,
  task,
} from "./workspaceTasks.testSupport.js";

describe("WorkspaceTasksCatalogService", () => {
  it("wires one composition and observes both adapters only after assignment", async () => {
    const fixture = createFixture();

    const observed = await fixture.observer.observe(TEST_ADDRESS);

    expect(observed).toEqual({ workspace: fixture.workspace.response, global: fixture.global.response });
    expect(fixture.creation).toEqual(["registry", "resolver", "global", "workspace"]);
    expect(fixture.composition.registry).toBe(fixture.composition.workspaceMutations);
    expect(fixture.composition.globalAdapter).toBe(fixture.global);
    expect(fixture.composition.workspaceAdapter).toBe(fixture.workspace);
  });

  it("delegates direct replacements, preserves CAS conflicts, and keeps global no-ops write-free", async () => {
    const fixture = createFixture();
    const global = loadedGlobal(catalogWithTasks("build"));
    fixture.global.response = global;
    const workspace = loadedWorkspace(emptyCatalog());
    fixture.workspace.response = workspace;

    await expect(fixture.service.replaceGlobal({ expectedRevision: global.revision, config: global.config })).resolves.toEqual(global);
    await expect(fixture.service.replaceWorkspace({
      ...TEST_ADDRESS,
      expectedRevision: workspace.revision,
      config: catalogWithTasks("local"),
    })).resolves.toMatchObject({ kind: "loaded" });

    await expect(fixture.service.replaceGlobal({ expectedRevision: "stale", config: emptyCatalog() }))
      .rejects.toThrow("revision conflict");
    expect(fixture.global.writes).toBe(0);
    expect(fixture.workspace.writes).toBe(1);
  });

  it("passes canonical direct write intents through the final authorizer boundary", async () => {
    const fixture = createFixture();
    const currentGlobal = loadedGlobal(emptyCatalog());
    const currentWorkspace = loadedWorkspace(emptyCatalog());
    fixture.global.response = currentGlobal;
    fixture.workspace.response = currentWorkspace;

    const nextGlobal = catalogWithTasks("global-next");
    const nextWorkspace = catalogWithTasks("workspace-next");
    await fixture.service.replaceGlobal({ expectedRevision: currentGlobal.revision, config: nextGlobal });
    await fixture.service.replaceWorkspace({
      ...TEST_ADDRESS,
      expectedRevision: currentWorkspace.revision,
      config: nextWorkspace,
    });

    expect(fixture.global.intents).toEqual([{ scope: "global", expectedRevision: currentGlobal.revision, config: nextGlobal }]);
    expect(fixture.workspace.intents).toEqual([{
      scope: "workspace",
      address: TEST_ADDRESS,
      expectedRevision: currentWorkspace.revision,
      config: nextWorkspace,
    }]);
  });

  it("blocks invalid catalogs before a move write", async () => {
    const fixture = createFixture();
    fixture.workspace.response = {
      kind: "invalid",
      message: "invalid",
      hint: "refresh",
      detail: "broken",
    };
    const request = promotionRequest(catalogWithTasks("build"), emptyCatalog(), "release");

    await expect(fixture.service.move({ ...TEST_ADDRESS, ...request })).resolves.toMatchObject({
      kind: "conflict",
      reason: "invalid-catalog",
    });
    expect(fixture.global.writes).toBe(0);
    expect(fixture.workspace.writes).toBe(0);
  });

  it("returns a destination collision without touching either catalog", async () => {
    const fixture = createFixture();
    const source = catalogWithTasks("build");
    const destination = catalogWithTasks("release");
    const request = promotionRequest(source, destination, "release");

    await expect(fixture.service.move({ ...TEST_ADDRESS, ...request })).resolves.toMatchObject({
      kind: "conflict",
      reason: "destination-collision",
    });
    expect(fixture.global.replaceCalls).toHaveLength(0);
    expect(fixture.workspace.replaceCalls).toHaveLength(0);
  });

  it("promotes with destination-first writes and exact plan-derived permits", async () => {
    const fixture = createFixture();
    const source = catalogWithTasks("first", "build", "last");
    const destination = catalogWithTasks("global");
    fixture.workspace.response = loadedWorkspace(source);
    fixture.global.response = loadedGlobal(destination);
    const request = promotionRequest(source, destination, "renamed-global", "start", "build");

    const result = await fixture.service.move({ ...TEST_ADDRESS, ...request });

    expect(result).toMatchObject({ kind: "completed", operationId: request.operationId });
    expect(fixture.global.replaceCalls).toEqual([{
      expectedRevision: fixture.global.replaceCalls[0]?.expectedRevision,
      config: { version: 1, tasks: [...destination.tasks, task("renamed-global")] },
    }]);
    expect(fixture.workspace.replaceCalls).toHaveLength(1);
    expect(fixture.workspace.replaceCalls[0]?.input.config.tasks.map((entry) => entry.id)).toEqual(["first", "last"]);
    expect(fixture.global.writeOptions[0]?.permit).toBeDefined();
    expect(fixture.workspace.writeOptions[0]?.permit).toBeDefined();
    expect(fixture.workspace.writeOptions[0]?.onWriteAcknowledged).toBeUndefined();
    expect(fixture.workspace.writeOptions[0]?.onWriteOutcomeUnknown).toBeUndefined();
    expect(fixture.global.intents[0]).toEqual({
      scope: "global",
      expectedRevision: loadedGlobal(destination).revision,
      config: { version: 1, tasks: [...destination.tasks, task("renamed-global")] },
    });
    expect(fixture.global.readCalls).toBe(5);
    expect(fixture.workspace.readCalls).toHaveLength(5);
  });

  it("demotes with workspace destination first and removes the global source second", async () => {
    const fixture = createFixture();
    const source = catalogWithTasks("global-build");
    const destination = emptyCatalog();
    fixture.global.response = loadedGlobal(source);
    fixture.workspace.response = missingWorkspace("workspace-missing");
    const request = demotionRequest(source, destination, "local-build");

    const result = await fixture.service.move({ ...TEST_ADDRESS, ...request });

    expect(result).toMatchObject({ kind: "completed", operationId: request.operationId });
    expect(fixture.workspace.replaceCalls).toHaveLength(1);
    expect(fixture.global.replaceCalls).toHaveLength(1);
    expect(fixture.workspace.replaceCalls[0]?.input.config.tasks.map((entry) => entry.id)).toEqual(["local-build"]);
    expect(fixture.global.replaceCalls[0]?.config.tasks).toEqual([]);
    expect(fixture.workspace.writeOptions[0]?.permit).toBeDefined();
    expect(fixture.global.writeOptions[0]?.permit).toBeDefined();
    expect(fixture.global.writeOptions[0]?.onWriteAcknowledged).toBeUndefined();
  });

  it("keeps a completed move authoritative when a direct no-op writer races settlement", async () => {
    const fixture = createFixture();
    const source = catalogWithTasks("build");
    const destination = emptyCatalog();
    const request = promotionRequest(source, destination, "release");
    fixture.workspace.response = loadedWorkspace(source);
    fixture.global.response = loadedGlobal(destination);

    const releaseDirectWriter = deferred<undefined>();
    const directWriter = releaseDirectWriter.promise.then(() => fixture.service.replaceGlobal({
      expectedRevision: loadedGlobal(catalogWithTasks("release")).revision,
      config: catalogWithTasks("release"),
    }));
    let raced = false;
    const originalReconcile = fixture.composition.registry.reconcileGlobalMoveClaim.bind(fixture.composition.registry);
    vi.spyOn(fixture.composition.registry, "reconcileGlobalMoveClaim").mockImplementation(async (subject, permit) => {
      if (!raced && permit !== undefined && fixture.workspace.writes === 1) {
        raced = true;
        releaseDirectWriter.resolve(undefined);
        await directWriter.catch(() => undefined);
      }
      return originalReconcile(subject, permit);
    });

    const result = await fixture.service.move({ ...TEST_ADDRESS, ...request });

    expect(raced).toBe(true);
    await expect(directWriter).rejects.toBeInstanceOf(WorkspaceTasksMoveRecoveryPendingError);
    expect(result).toMatchObject({ kind: "completed", operationId: request.operationId });
    await expect(fixture.service.replaceGlobal({
      expectedRevision: loadedGlobal(catalogWithTasks("release")).revision,
      config: catalogWithTasks("release"),
    })).resolves.toMatchObject({ kind: "loaded" });
  });


  it("keeps a destination-written claim after a known source failure and reconciles it before direct writes", async () => {
    const fixture = createFixture();
    const source = catalogWithTasks("build");
    const destination = emptyCatalog();
    fixture.workspace.response = loadedWorkspace(source);
    fixture.global.response = loadedGlobal(destination);
    fixture.workspace.writeFailure = { phase: "before-publication", error: new Error("source unavailable") };
    const request = promotionRequest(source, destination, "release");

    await expect(fixture.service.move({ ...TEST_ADDRESS, ...request })).resolves.toMatchObject({
      kind: "partial",
      phase: "destination-written",
    });
    expect(fixture.global.writes).toBe(1);
    expect(fixture.workspace.writes).toBe(0);
    expect(fixture.workspace.readCalls).toHaveLength(4);
    expect(fixture.global.readCalls).toBe(4);

    await expect(fixture.service.replaceGlobal({
      expectedRevision: loadedGlobal({ version: 1, tasks: [task("release")] }).revision,
      config: catalogWithTasks("blocked"),
    })).rejects.toBeInstanceOf(WorkspaceTasksMoveRecoveryPendingError);
    expect(fixture.global.writes).toBe(1);

    fixture.workspace.writeFailure = undefined;
    fixture.workspace.response = loadedWorkspace(emptyCatalog());
    await expect(fixture.service.replaceGlobal({
      expectedRevision: loadedGlobal({ version: 1, tasks: [task("release")] }).revision,
      config: catalogWithTasks("after-recovery"),
    })).resolves.toMatchObject({ kind: "loaded" });
    expect(fixture.global.writes).toBe(2);
  });

  it("clears a pending claim on a known destination failure without retrying source removal", async () => {
    const fixture = createFixture();
    const source = catalogWithTasks("build");
    const destination = emptyCatalog();
    fixture.workspace.response = loadedWorkspace(source);
    fixture.global.response = loadedGlobal(destination);
    fixture.global.writeFailure = { phase: "before-publication", error: new Error("destination unavailable") };
    const request = promotionRequest(source, destination, "release");

    await expect(fixture.service.move({ ...TEST_ADDRESS, ...request })).resolves.toMatchObject({ kind: "unavailable" });
    expect(fixture.workspace.replaceCalls).toHaveLength(0);
    fixture.global.writeFailure = undefined;

    await expect(fixture.service.move({ ...TEST_ADDRESS, ...request })).resolves.toMatchObject({ kind: "completed" });
    expect(fixture.global.writes).toBe(1);
    expect(fixture.workspace.writes).toBe(1);
  });

  it("returns unknown outcome for an ambiguous destination publication and performs no source write", async () => {
    const fixture = createFixture();
    const source = catalogWithTasks("build");
    const destination = emptyCatalog();
    fixture.workspace.response = loadedWorkspace(source);
    fixture.global.response = loadedGlobal(destination);
    fixture.global.writeFailure = {
      phase: "unknown",
      error: new WorkspaceTasksUnknownOutcomeError(),
    };
    fixture.global.readResponses = [loadedGlobal(destination), new Error("verification unavailable")];
    const request = promotionRequest(source, destination, "release");

    await expect(fixture.service.move({ ...TEST_ADDRESS, ...request })).resolves.toMatchObject({ kind: "unknown-outcome" });
    expect(fixture.global.writes).toBe(1);
    expect(fixture.workspace.writes).toBe(0);
    expect(fixture.global.writeEvents).toEqual(["unknown"]);
    expect(fixture.global.readCalls).toBe(2);
    expect(fixture.workspace.readCalls).toHaveLength(2);
    expect(fixture.global.writeOptions[0]?.onWriteAcknowledged).toBeTypeOf("function");
    expect(fixture.global.writeOptions[0]?.onWriteOutcomeUnknown).toBeTypeOf("function");
  });

  it("reconciles a post-destination pristine observation before returning and releases the claim for direct writers", async () => {
    const fixture = createFixture();
    const source = catalogWithTasks("build");
    const destination = emptyCatalog();
    const request = promotionRequest(source, destination, "release");
    fixture.workspace.response = loadedWorkspace(source);
    fixture.global.response = loadedGlobal(destination);
    fixture.global.readResponses = [loadedGlobal(destination), loadedGlobal(destination), loadedGlobal(catalogWithTasks("release"))];

    await expect(fixture.service.move({ ...TEST_ADDRESS, ...request })).resolves.toMatchObject({
      kind: "conflict",
      reason: "unrecognized-state",
    });
    expect(fixture.global.writes).toBe(1);

    const applied = loadedGlobal(catalogWithTasks("release"));
    await expect(fixture.service.replaceGlobal({
      expectedRevision: applied.revision,
      config: catalogWithTasks("after-recovery"),
    })).resolves.toMatchObject({ kind: "loaded" });
    expect(fixture.global.writes).toBe(2);
  });

  it("consumes an authoritative pristine observation after an unknown destination publication before direct writers proceed", async () => {
    const fixture = createFixture();
    const source = catalogWithTasks("build");
    const destination = emptyCatalog();
    const request = promotionRequest(source, destination, "release");
    fixture.workspace.response = loadedWorkspace(source);
    fixture.global.response = loadedGlobal(destination);
    fixture.global.writeFailure = {
      phase: "unknown",
      error: new WorkspaceTasksUnknownOutcomeError(),
    };
    fixture.global.readResponses = [loadedGlobal(destination), loadedGlobal(destination), loadedGlobal(catalogWithTasks("release"))];

    await expect(fixture.service.move({ ...TEST_ADDRESS, ...request })).resolves.toMatchObject({
      kind: "conflict",
      reason: "unrecognized-state",
    });
    expect(fixture.global.writeEvents).toEqual(["unknown"]);
    expect(fixture.global.writes).toBe(1);

    fixture.global.writeFailure = undefined;
    const applied = loadedGlobal(catalogWithTasks("release"));
    await expect(fixture.service.replaceGlobal({
      expectedRevision: applied.revision,
      config: catalogWithTasks("after-recovery"),
    })).resolves.toMatchObject({ kind: "loaded" });
    expect(fixture.global.writes).toBe(2);
  });

  it("returns partial for a retransmitted start with the matching live destination claim", async () => {
    const fixture = createFixture();
    const source = catalogWithTasks("build");
    const destination = emptyCatalog();
    const request = promotionRequest(source, destination, "release");
    fixture.workspace.response = loadedWorkspace(source);
    fixture.global.response = loadedGlobal(destination);
    fixture.workspace.writeFailure = { phase: "before-publication", error: new Error("source unavailable") };

    await expect(fixture.service.move({ ...TEST_ADDRESS, ...request })).resolves.toMatchObject({ kind: "partial" });
    fixture.workspace.writeFailure = undefined;

    await expect(fixture.service.move({ ...TEST_ADDRESS, ...request })).resolves.toMatchObject({
      kind: "partial",
      phase: "destination-written",
    });
    expect(fixture.global.writes).toBe(1);
    expect(fixture.workspace.writes).toBe(0);
  });

  it("retries only the source removal for an owned destination-applied phase", async () => {
    const fixture = createFixture();
    const source = catalogWithTasks("build");
    const destination = emptyCatalog();
    const start = promotionRequest(source, destination, "release");
    fixture.workspace.response = loadedWorkspace(source);
    fixture.global.response = loadedGlobal(destination);
    fixture.workspace.writeFailure = { phase: "before-publication", error: new Error("source unavailable") };

    await fixture.service.move({ ...TEST_ADDRESS, ...start });
    fixture.workspace.writeFailure = undefined;
    const retry = { ...start, intent: "retry" as const };

    await expect(fixture.service.move({ ...TEST_ADDRESS, ...retry })).resolves.toMatchObject({ kind: "completed" });
    expect(fixture.global.writes).toBe(1);
    expect(fixture.workspace.writes).toBe(1);
  });

  it("returns partial when an authoritative reread proves the source intact after an unknown source removal", async () => {
    const fixture = createFixture();
    const source = catalogWithTasks("build");
    const destination = emptyCatalog();
    fixture.workspace.response = loadedWorkspace(source);
    fixture.global.response = loadedGlobal(destination);
    const start = promotionRequest(source, destination, "release");
    fixture.workspace.writeFailure = {
      phase: "unknown",
      published: false,
      error: new WorkspaceTasksUnknownOutcomeError(),
    };

    await expect(fixture.service.move({ ...TEST_ADDRESS, ...start })).resolves.toMatchObject({
      kind: "partial",
      phase: "destination-written",
    });
    expect(fixture.global.writes).toBe(1);
    expect(fixture.workspace.writes).toBe(1);
    expect(fixture.global.replaceCalls).toHaveLength(1);
    expect(fixture.workspace.replaceCalls).toHaveLength(1);
    expect(fixture.global.readCalls).toBe(4);
    expect(fixture.workspace.readCalls).toHaveLength(4);
  });

  it("does not mint a retry permit for a retransmitted start in the destination-applied phase", async () => {
    const fixture = createFixture();
    const source = catalogWithTasks("build");
    const destination = emptyCatalog();
    const request = promotionRequest(source, destination, "release");
    fixture.workspace.response = loadedWorkspace(source);
    fixture.global.response = loadedGlobal(destination);
    fixture.workspace.writeFailure = { phase: "before-publication", error: new Error("source unavailable") };

    await expect(fixture.service.move({ ...TEST_ADDRESS, ...request })).resolves.toMatchObject({ kind: "partial" });
    fixture.workspace.writeFailure = undefined;
    const beginRetry = vi.spyOn(fixture.composition.registry, "beginRetry");

    await expect(fixture.service.move({ ...TEST_ADDRESS, ...request })).resolves.toMatchObject({
      kind: "partial",
      phase: "destination-written",
    });

    expect(beginRetry).not.toHaveBeenCalled();
  });

  it("reconciles a stale claim before entering the shared workspace mutation queue", async () => {
    const fixture = createFixture();
    const source = catalogWithTasks("build");
    const destination = emptyCatalog();
    const request = promotionRequest(source, destination, "release");
    fixture.workspace.response = loadedWorkspace(source);
    fixture.global.response = loadedGlobal(destination);
    fixture.workspace.writeFailure = { phase: "before-publication", error: new Error("source unavailable") };

    await expect(fixture.service.move({ ...TEST_ADDRESS, ...request })).resolves.toMatchObject({ kind: "partial" });
    fixture.workspace.writeFailure = undefined;
    fixture.workspace.response = loadedWorkspace(emptyCatalog());
    const reconcile = vi.spyOn(fixture.composition.registry, "reconcileGlobalMoveClaim");
    const queue = vi.spyOn(fixture.composition.registry, "run");

    await expect(fixture.service.replaceWorkspace({
      ...TEST_ADDRESS,
      expectedRevision: fixture.workspace.response.revision,
      config: catalogWithTasks("after-recovery"),
    })).resolves.toMatchObject({ kind: "loaded" });

    expect(reconcile).toHaveBeenCalledWith({ scope: "workspace", address: TEST_ADDRESS }, undefined);
    expect(queue).toHaveBeenCalledWith(TEST_ADDRESS, expect.any(Function));
    expect(reconcile.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY)
      .toBeLessThan(queue.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY);
    expect(fixture.workspace.readCalls).toHaveLength(5);
    expect(fixture.global.readCalls).toBe(5);
  });

  it("returns a refresh-gated conflict for an authoritative unexpected source-removal pair", async () => {
    const fixture = createFixture();
    const source = catalogWithTasks("build");
    const destination = emptyCatalog();
    const applied = catalogWithTasks("release");
    const changed = catalogWithTasks("changed");
    const request = promotionRequest(source, destination, "release");
    fixture.workspace.response = loadedWorkspace(source);
    fixture.global.response = loadedGlobal(destination);
    fixture.workspace.readResponses = [
      loadedWorkspace(source),
      loadedWorkspace(source),
      loadedWorkspace(source),
      loadedWorkspace(changed),
      loadedWorkspace(changed),
    ];
    fixture.global.readResponses = [
      loadedGlobal(destination),
      loadedGlobal(applied),
      loadedGlobal(applied),
      loadedGlobal(applied),
      loadedGlobal(applied),
    ];
    fixture.workspace.writeFailure = {
      phase: "unknown",
      published: false,
      error: new WorkspaceTasksUnknownOutcomeError(),
    };

    await expect(fixture.service.move({ ...TEST_ADDRESS, ...request })).resolves.toMatchObject({
      kind: "conflict",
      reason: "unrecognized-state",
    });
    expect(fixture.global.writes).toBe(1);
    expect(fixture.workspace.writes).toBe(1);
    expect(fixture.global.readCalls).toBe(5);
    expect(fixture.workspace.readCalls).toHaveLength(5);
  });

  it("treats an exact complete pair as an idempotent replay with zero writes", async () => {
    const fixture = createFixture();
    const source = catalogWithTasks("build");
    const destination = emptyCatalog();
    const request = promotionRequest(source, destination, "release");
    fixture.workspace.response = loadedWorkspace(emptyCatalog());
    fixture.global.response = loadedGlobal(catalogWithTasks("release"));

    await expect(fixture.service.move({ ...TEST_ADDRESS, ...request })).resolves.toMatchObject({ kind: "completed" });
    expect(fixture.global.writes).toBe(0);
    expect(fixture.workspace.writes).toBe(0);
  });

  it("keeps an unowned intermediate state write-free", async () => {
    const fixture = createFixture();
    const source = catalogWithTasks("build");
    const destination = emptyCatalog();
    const request = promotionRequest(source, destination, "release");
    fixture.workspace.response = loadedWorkspace(source);
    fixture.global.response = loadedGlobal(catalogWithTasks("release"));

    await expect(fixture.service.move({ ...TEST_ADDRESS, ...request })).resolves.toMatchObject({
      kind: "conflict",
      reason: "unowned-intermediate-state",
    });
    expect(fixture.global.writes).toBe(0);
    expect(fixture.workspace.writes).toBe(0);
  });
});

interface Fixture {
  service: WorkspaceTasksCatalogService;
  composition: WorkspaceTasksComposition;
  global: ControlledGlobalCatalogAdapter;
  workspace: ControlledWorkspaceCatalogAdapter;
  observer: WorkspaceTasksMoveObservationPort;
  creation: string[];
}

function createFixture(): Fixture {
  const global = new ControlledGlobalCatalogAdapter();
  const workspace = new ControlledWorkspaceCatalogAdapter();
  const resolver = new ControlledWorkspaceFileResolver();
  const creation: string[] = [];
  let observer: WorkspaceTasksMoveObservationPort | undefined;

  const composition = createWorkspaceTasksComposition({
    configMutationCoordinator: new ControlledConfigCoordinator(),
    projects: new ProjectService(new ProjectStore("/tmp/pi-webui-workspace-tasks-test-projects.json")),
    workspaces: new WorkspaceService(),
    factories: {
      createRegistry: ({ observe }) => {
        creation.push("registry");
        observer = observe;
        return new MachineGlobalTasksMoveRegistry(observe);
      },
      createWorkspaceFileResolver: () => {
        creation.push("resolver");
        return resolver;
      },
      createGlobalAdapter: ({ authorizer }) => {
        creation.push("global");
        global.authorizer = authorizer;
        return global;
      },
      createWorkspaceAdapter: ({ authorizer, workspaceMutations }) => {
        creation.push("workspace");
        workspace.authorizer = authorizer;
        workspace.workspaceMutations = workspaceMutations;
        return workspace;
      },
    },
  });
  if (observer === undefined) throw new Error("composition did not expose its observer");
  return {
    service: composition.service,
    composition,
    global,
    workspace,
    observer,
    creation,
  };
}

function promotionRequest(
  source: ReturnType<typeof catalogWithTasks>,
  destination: ReturnType<typeof catalogWithTasks>,
  destinationId: string,
  intent: "start" | "retry" = "start",
  sourceId: string = source.tasks[0]?.id ?? "missing",
): MoveWorkspaceTaskRequest {
  return {
    operationId: "11111111-1111-4111-8111-111111111111",
    intent,
    source: {
      ref: { scope: "workspace", id: sourceId },
      expectedCatalog: loadedWorkspace(source),
    },
    destination: {
      scope: "global",
      expectedCatalog: loadedGlobal(destination),
      task: task(destinationId),
    },
  };
}

function demotionRequest(
  source: ReturnType<typeof catalogWithTasks>,
  destination: ReturnType<typeof emptyCatalog>,
  destinationId: string,
): MoveWorkspaceTaskRequest {
  return {
    operationId: "22222222-2222-4222-8222-222222222222",
    intent: "start",
    source: {
      ref: { scope: "global", id: source.tasks[0]?.id ?? "missing" },
      expectedCatalog: loadedGlobal(source),
    },
    destination: {
      scope: "workspace",
      expectedCatalog: destination.tasks.length === 0
        ? missingWorkspace("workspace-missing")
        : loadedWorkspace(destination),
      task: task(destinationId),
    },
  };
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
