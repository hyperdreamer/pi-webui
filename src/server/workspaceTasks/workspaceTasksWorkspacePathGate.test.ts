import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { WorkspaceCatalogAddress } from "../../shared/apiTypes.js";
import { ProjectService } from "../projects/projectService.js";
import { ProjectStore } from "../storage/projectStore.js";
import { registerWorkspaceExplorerRoutes } from "../workspaceExplorerRoutes.js";
import { WorkspaceService } from "../workspaces/workspaceService.js";
import type { WorkspaceTasksMutationAuthorizer } from "./workspaceTasksErrors.js";
import { WorkspaceTasksMoveInProgressError, WorkspaceTasksMoveRecoveryPendingError } from "./workspaceTasksMoveRegistry.js";
import type { WorkspaceTasksWorkspaceMutationCoordinator } from "./workspaceTasksWorkspaceCatalogAdapter.js";
import type { WorkspaceTasksWorkspaceFileResolver } from "./workspaceTasksWorkspaceFile.js";
import { WorkspaceTasksWorkspacePathGate } from "./workspaceTasksWorkspacePathGate.js";

const address: WorkspaceCatalogAddress = { projectId: "project", workspaceId: "workspace" };
const taskPath = ".pi-webui/tasks.json";

interface GateDependencies {
  authorizer: WorkspaceTasksMutationAuthorizer;
  coordinator: WorkspaceTasksWorkspaceMutationCoordinator;
  events: string[];
  reconciliationError: Error | undefined;
  finalAssertionError: Error | undefined;
  reconcileCalls: WorkspaceCatalogAddress[];
  workspaceAssertionCalls: number;
  queueCalls: number;
}

function fakeGateDependencies(): GateDependencies {
  const state: {
    reconciliationError: Error | undefined;
    finalAssertionError: Error | undefined;
    reconcileCalls: WorkspaceCatalogAddress[];
    workspaceAssertionCalls: number;
    queueCalls: number;
  } = {
    reconciliationError: undefined,
    finalAssertionError: undefined,
    reconcileCalls: [],
    workspaceAssertionCalls: 0,
    queueCalls: 0,
  };
  const events: string[] = [];
  const authorizer: WorkspaceTasksMutationAuthorizer = {
    reconcileGlobalMoveClaim: (subject) => {
      events.push("reconcile");
      if (subject.scope === "workspace") state.reconcileCalls.push(subject.address);
      return state.reconciliationError === undefined
        ? Promise.resolve()
        : Promise.reject(state.reconciliationError);
    },
    assertGlobalMutationAllowed: () => undefined,
    assertWorkspaceMutationAllowed: () => {
      events.push("assert");
      state.workspaceAssertionCalls += 1;
      if (state.finalAssertionError !== undefined) throw state.finalAssertionError;
    },
  };
  const coordinator: WorkspaceTasksWorkspaceMutationCoordinator = {
    run: (_address, operation) => {
      events.push("queue");
      state.queueCalls += 1;
      return operation();
    },
  };
  return {
    authorizer,
    coordinator,
    events,
    get reconciliationError() { return state.reconciliationError; },
    set reconciliationError(value) { state.reconciliationError = value; },
    get finalAssertionError() { return state.finalAssertionError; },
    set finalAssertionError(value) { state.finalAssertionError = value; },
    get reconcileCalls() { return state.reconcileCalls; },
    get workspaceAssertionCalls() { return state.workspaceAssertionCalls; },
    get queueCalls() { return state.queueCalls; },
  };
}

describe("WorkspaceTasksWorkspacePathGate", () => {
  it("reconciles before the shared workspace queue and asserts immediately before the operation", async () => {
    const dependencies = fakeGateDependencies();
    const gate = new WorkspaceTasksWorkspacePathGate(dependencies.authorizer, dependencies.coordinator);
    let operationCalls = 0;
    const operation = () => {
      operationCalls += 1;
      dependencies.events.push("operation");
      return Promise.resolve("written");
    };

    await expect(gate.run(address, [taskPath], operation)).resolves.toBe("written");
    expect(operationCalls).toBe(1);
    expect(dependencies.events).toEqual(["reconcile", "queue", "assert", "operation"]);
    expect(dependencies.workspaceAssertionCalls).toBe(1);
  });

  it("checks every normalized move target and recognizes a task file as either endpoint", async () => {
    const dependencies = fakeGateDependencies();
    const gate = new WorkspaceTasksWorkspacePathGate(dependencies.authorizer, dependencies.coordinator);

    await gate.run(address, ["source.txt", taskPath], () => Promise.resolve());

    expect(dependencies.reconcileCalls).toEqual([address]);
    expect(dependencies.workspaceAssertionCalls).toBe(1);
  });

  it("leaves unrelated workspace mutations outside task-claim observation", async () => {
    const dependencies = fakeGateDependencies();
    const gate = new WorkspaceTasksWorkspacePathGate(dependencies.authorizer, dependencies.coordinator);
    let operationCalls = 0;

    await expect(gate.run(address, ["notes.txt"], () => {
      operationCalls += 1;
      return Promise.resolve("unrelated");
    })).resolves.toBe("unrelated");
    expect(operationCalls).toBe(1);
    expect(dependencies.reconcileCalls).toEqual([]);
    expect(dependencies.queueCalls).toBe(0);
  });

  it("rejects a claim that appears after reconciliation but before the queued operation", async () => {
    const dependencies = fakeGateDependencies();
    const finalError = new WorkspaceTasksMoveInProgressError();
    dependencies.finalAssertionError = finalError;
    const gate = new WorkspaceTasksWorkspacePathGate(dependencies.authorizer, dependencies.coordinator);
    let operationCalls = 0;

    await expect(gate.run(address, [taskPath], () => {
      operationCalls += 1;
      return Promise.resolve();
    })).rejects.toBe(finalError);
    expect(dependencies.queueCalls).toBe(1);
    expect(operationCalls).toBe(0);
  });

  it("maps task-target explorer mutations to safe 409 responses while a claim is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-webui-task-path-gate-"));
    const projects = new ProjectService(new ProjectStore(join(root, "projects.json")));
    const project = await projects.add({ name: "Task gate", path: root });
    const workspaces = new WorkspaceService();
    const workspace = (await workspaces.list(project))[0];
    if (workspace === undefined) throw new Error("Expected workspace");
    const activeClaim = new WorkspaceTasksMoveInProgressError();
    const authorizer: WorkspaceTasksMutationAuthorizer = {
      reconcileGlobalMoveClaim: () => Promise.reject(activeClaim),
      assertGlobalMutationAllowed: () => undefined,
      assertWorkspaceMutationAllowed: () => undefined,
    };
    const taskFiles: WorkspaceTasksWorkspaceFileResolver = {
      readCatalog: () => Promise.resolve({ kind: "missing", revision: "missing" }),
      publishCatalog: () => Promise.resolve(),
      writeExplorerTaskFile: () => Promise.reject(new Error("task write should remain behind the gate")),
      deleteExplorerTaskFile: () => Promise.reject(new Error("task delete should remain behind the gate")),
      moveExplorerTaskFile: () => Promise.reject(new Error("task move should remain behind the gate")),
    };
    const app = Fastify({ logger: false });
    registerWorkspaceExplorerRoutes(app, projects, workspaces, "/api", {
      taskPathGate: new WorkspaceTasksWorkspacePathGate(authorizer, { run: (_address, operation) => operation() }),
      taskFiles,
    });
    await app.ready();
    const base = `/api/projects/${project.id}/workspaces/${workspace.id}/file`;

    try {
      const write = await app.inject({ method: "PUT", url: `${base}?path=${encodeURIComponent(taskPath)}`, payload: "{}", headers: { "content-type": "text/plain" } });
      const remove = await app.inject({ method: "DELETE", url: `${base}?path=${encodeURIComponent(taskPath)}` });
      const moveSource = await app.inject({ method: "POST", url: `${base}/move?fromPath=${encodeURIComponent(taskPath)}&toPath=${encodeURIComponent("renamed.json")}` });
      const moveDestination = await app.inject({ method: "POST", url: `${base}/move?fromPath=${encodeURIComponent("renamed.json")}&toPath=${encodeURIComponent(taskPath)}` });

      for (const response of [write, remove, moveSource, moveDestination]) {
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: activeClaim.message });
      }
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    new WorkspaceTasksMoveInProgressError(),
    new WorkspaceTasksMoveRecoveryPendingError(),
  ])("returns the registry's active-claim error before entering the queue", async (error) => {
    const dependencies = fakeGateDependencies();
    dependencies.reconciliationError = error;
    const gate = new WorkspaceTasksWorkspacePathGate(dependencies.authorizer, dependencies.coordinator);
    let operationCalls = 0;

    await expect(gate.run(address, [taskPath], () => {
      operationCalls += 1;
      return Promise.resolve();
    })).rejects.toBe(error);
    expect(operationCalls).toBe(0);
    expect(dependencies.queueCalls).toBe(0);
  });
});
