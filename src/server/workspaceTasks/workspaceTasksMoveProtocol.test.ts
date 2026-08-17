import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  GlobalCatalogExpectation,
  GlobalWorkspaceTasksResponse,
  MoveWorkspaceTaskRequest,
  WorkspaceCatalogAddress,
  WorkspaceCatalogExpectation,
  WorkspaceTasksCatalogResponse,
} from "../../shared/apiTypes.js";
import { serializeWorkspaceTasksConfig, type WorkspaceTask, type WorkspaceTasksConfig } from "../../shared/workspaceTasks.js";
import {
  WorkspaceTasksRevisionConflictError,
} from "./workspaceTasksErrors.js";
import {
  classifyWorkspaceTasksMovePair,
  deriveWorkspaceTasksMovePlan,
  type WorkspaceTasksMoveCatalogPair,
  type WorkspaceTasksMovePlan,
  type WorkspaceTasksMovePairState,
} from "./workspaceTasksMoveProtocol.js";

describe("workspace task move protocol", () => {
  it("derives promotion pairs and exact destination/source publications", () => {
    const address = addressFor("workspace");
    const source = catalogWithTask("build");
    const destination = catalogWithTask("test");
    const destinationTask = task("release");
    const request = promotionRequest(source, destination, destinationTask);

    const plan = deriveWorkspaceTasksMovePlan(address, request);

    expect(plan.pristine).toEqual({
      workspace: { kind: "loaded", revision: "workspace-source", config: source },
      global: loadedGlobal(destination, globalRevision(destination)),
    });
    expect(plan.destinationApplied).toEqual({
      workspace: { kind: "loaded", revision: "workspace-source", config: source },
      global: loadedGlobal(
        { version: 1, tasks: [...destination.tasks, destinationTask] },
        globalRevision({ version: 1, tasks: [...destination.tasks, destinationTask] }),
      ),
    });
    expect(plan.complete).toEqual({
      workspace: loadedWorkspace(emptyCatalog(), workspaceRevision(emptyCatalog())),
      global: loadedGlobal(
        { version: 1, tasks: [...destination.tasks, destinationTask] },
        globalRevision({ version: 1, tasks: [...destination.tasks, destinationTask] }),
      ),
    });
    expect(plan.destinationWrite).toEqual({
      scope: "global",
      expectedRevision: globalRevision(destination),
      config: { version: 1, tasks: [...destination.tasks, destinationTask] },
    });
    expect(plan.sourceRemoval).toEqual({
      scope: "workspace",
      address,
      expectedRevision: "workspace-source",
      config: emptyCatalog(),
    });
  });

  it("derives demotion into a missing workspace catalog with canonical post-write revisions", () => {
    const address = addressFor("worktree");
    const source = catalogWithTask("build");
    const destination = emptyCatalog();
    const destinationTask = task("build-local");
    const request = demotionRequest(source, destination, destinationTask);

    const plan = deriveWorkspaceTasksMovePlan(address, request);

    expect(plan.pristine.workspace).toEqual({ kind: "missing", revision: "workspace-missing" });
    expect(plan.destinationApplied.workspace).toEqual(
      loadedWorkspace({ version: 1, tasks: [destinationTask] }, workspaceRevision({ version: 1, tasks: [destinationTask] })),
    );
    expect(plan.complete.global).toEqual(loadedGlobal(emptyCatalog(), globalRevision(emptyCatalog())));
    expect(plan.destinationWrite).toEqual({
      scope: "workspace",
      address,
      expectedRevision: "workspace-missing",
      config: { version: 1, tasks: [destinationTask] },
    });
    expect(plan.sourceRemoval).toEqual({
      scope: "global",
      expectedRevision: globalRevision(source),
      config: emptyCatalog(),
    });
  });

  it("preserves removal and append ordering for both promotion and demotion", () => {
    const promotionSource = catalogWithTasks("first", "move", "last");
    const promotionDestination = catalogWithTasks("global-first", "global-last");
    const promotion = deriveWorkspaceTasksMovePlan(addressFor("promotion"), {
      operationId: "33333333-3333-4333-8333-333333333333",
      intent: "start",
      source: {
        ref: { scope: "workspace", id: "move" },
        expectedCatalog: { kind: "loaded", revision: "promotion-source", config: promotionSource },
      },
      destination: {
        scope: "global",
        expectedCatalog: loadedGlobal(promotionDestination, globalRevision(promotionDestination)),
        task: task("move-global"),
      },
    });

    expect(promotion.sourceRemoval.config.tasks.map((entry) => entry.id)).toEqual(["first", "last"]);
    expect(promotion.destinationWrite.config.tasks.map((entry) => entry.id))
      .toEqual(["global-first", "global-last", "move-global"]);

    const demotionSource = catalogWithTasks("global-first", "move", "global-last");
    const demotionDestination = catalogWithTasks("local-first", "local-last");
    const demotion = deriveWorkspaceTasksMovePlan(addressFor("demotion"), {
      operationId: "44444444-4444-4444-8444-444444444444",
      intent: "start",
      source: {
        ref: { scope: "global", id: "move" },
        expectedCatalog: loadedGlobal(demotionSource, globalRevision(demotionSource)),
      },
      destination: {
        scope: "workspace",
        expectedCatalog: loadedWorkspace(demotionDestination, workspaceRevision(demotionDestination)),
        task: task("move-local"),
      },
    });

    expect(demotion.sourceRemoval.config.tasks.map((entry) => entry.id)).toEqual(["global-first", "global-last"]);
    expect(demotion.destinationWrite.config.tasks.map((entry) => entry.id))
      .toEqual(["local-first", "local-last", "move-local"]);
  });

  it.each<WorkspaceTasksMovePairState>(["pristine", "destination-applied", "complete", "unrecognized"])(
    "classifies the %s pair using full configs and revisions",
    (state) => {
      const source = catalogWithTask("build");
      const destination = emptyCatalog();
      const plan = deriveWorkspaceTasksMovePlan(
        addressFor("workspace"),
        promotionRequest(source, destination, task("release")),
      );
      const observed = observedPair(plan, state);

      expect(classifyWorkspaceTasksMovePair(plan, observed)).toBe(state);
    },
  );

  it("does not classify a pair when an unrelated task, revision, or ordering changes", () => {
    const source = catalogWithTask("build");
    const destination = emptyCatalog();
    const plan = deriveWorkspaceTasksMovePlan(
      addressFor("workspace"),
      promotionRequest(source, destination, task("release")),
    );
    const changed: WorkspaceTasksMoveCatalogPair = {
      workspace: loadedWorkspace({ version: 1, tasks: [task("other")] }, "changed-source"),
      global: loadedGlobal({ version: 1, tasks: [task("release")] }, globalRevision({ version: 1, tasks: [task("release")] })),
    };

    expect(classifyWorkspaceTasksMovePair(plan, changed)).toBe("unrecognized");
  });

  it("rejects invalid revisions, source identity, same-scope moves, and destination collisions", () => {
    const source = catalogWithTask("build");
    const destination = emptyCatalog();
    const address = addressFor("workspace");

    const request = promotionRequest(source, destination, task("release"));
    expect(() => deriveWorkspaceTasksMovePlan(address, {
      ...request,
      destination: {
        ...request.destination,
        expectedCatalog: { kind: "loaded", revision: "wrong", config: destination },
      },
    })).toThrow(WorkspaceTasksRevisionConflictError);

    expect(() => deriveWorkspaceTasksMovePlan(address, {
      ...promotionRequest(source, destination, task("release")),
      source: {
        ref: { scope: "workspace", id: "missing" },
        expectedCatalog: { kind: "loaded", revision: "workspace-source", config: source },
      },
    })).toThrow("Source");

    expect(() => deriveWorkspaceTasksMovePlan(address, {
      ...promotionRequest(source, destination, task("release")),
      destination: { scope: "workspace", expectedCatalog: { kind: "loaded", revision: "workspace-source", config: source }, task: task("release") },
    })).toThrow("cross scopes");

    expect(() => deriveWorkspaceTasksMovePlan(address, promotionRequest(source, catalogWithTask("release"), task("release"))))
      .toThrow("already exists");
  });
});

function addressFor(workspaceId: string): WorkspaceCatalogAddress {
  return { projectId: "project", workspaceId };
}

function task(id: string): WorkspaceTask {
  return { id, title: `${id} task`, command: `npm run ${id}`, confirm: false };
}

function catalogWithTask(id: string): WorkspaceTasksConfig {
  return { version: 1, tasks: [task(id)] };
}

function catalogWithTasks(...ids: string[]): WorkspaceTasksConfig {
  return { version: 1, tasks: ids.map(task) };
}

function emptyCatalog(): WorkspaceTasksConfig {
  return { version: 1, tasks: [] };
}

function globalRevision(config: WorkspaceTasksConfig): string {
  return createHash("sha256").update(serializeWorkspaceTasksConfig(config), "utf8").digest("hex");
}

function workspaceRevision(config: WorkspaceTasksConfig): string {
  const hash = createHash("sha256");
  hash.update("workspace-task-file:present\0", "utf8");
  hash.update(Buffer.from(serializeWorkspaceTasksConfig(config), "utf8"));
  return hash.digest("hex");
}

function loadedGlobal(config: WorkspaceTasksConfig, revision: string): GlobalCatalogExpectation {
  return { kind: "loaded", config, revision };
}

function loadedWorkspace(config: WorkspaceTasksConfig, revision: string): Extract<WorkspaceCatalogExpectation, { kind: "loaded" }> {
  return { kind: "loaded", config, revision };
}

function promotionRequest(
  source: WorkspaceTasksConfig,
  destination: WorkspaceTasksConfig,
  destinationTask: WorkspaceTask,
): MoveWorkspaceTaskRequest {
  return {
    operationId: "11111111-1111-4111-8111-111111111111",
    intent: "start",
    source: {
      ref: { scope: "workspace", id: source.tasks[0]?.id ?? "missing" },
      expectedCatalog: { kind: "loaded", revision: "workspace-source", config: source },
    },
    destination: {
      scope: "global",
      expectedCatalog: loadedGlobal(destination, globalRevision(destination)),
      task: destinationTask,
    },
  };
}

function demotionRequest(
  source: WorkspaceTasksConfig,
  destination: WorkspaceTasksConfig,
  destinationTask: WorkspaceTask,
): MoveWorkspaceTaskRequest {
  return {
    operationId: "22222222-2222-4222-8222-222222222222",
    intent: "start",
    source: {
      ref: { scope: "global", id: source.tasks[0]?.id ?? "missing" },
      expectedCatalog: loadedGlobal(source, globalRevision(source)),
    },
    destination: {
      scope: "workspace",
      expectedCatalog: { kind: "missing", revision: "workspace-missing" },
      task: destinationTask,
    },
  };
}

function observedPair(
  plan: WorkspaceTasksMovePlan,
  state: WorkspaceTasksMovePairState,
): WorkspaceTasksMoveCatalogPair | { workspace: WorkspaceTasksCatalogResponse; global: GlobalWorkspaceTasksResponse } {
  if (state === "pristine") return plan.pristine;
  if (state === "destination-applied") return plan.destinationApplied;
  if (state === "complete") return plan.complete;
  return {
    workspace: { kind: "unavailable", message: "unavailable", hint: "refresh" },
    global: { kind: "loaded", config: emptyCatalog(), revision: "unrecognized" },
  };
}
