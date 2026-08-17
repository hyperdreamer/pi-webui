import { describe, expect, it, vi } from "vitest";
import type {
  GlobalWorkspaceTasksResponse,
  MoveWorkspaceTaskResult,
  WorkspaceTasksCatalogResponse,
  WorkspaceTasksFailureResponse,
  WorkspaceTasksRequestResult,
} from "../../../shared/apiTypes";
import type { WorkspaceTask, WorkspaceTasksConfig } from "../../../shared/workspaceTasks";
import type { WorkspaceTasksClient } from "../api/workspaceTasksApi";
import {
  WorkspaceTasksController,
  type WorkspaceTasksControllerDependencies,
  type WorkspaceTasksSelection,
  type WorkspaceTasksWorkspaceState,
} from "./workspaceTasksController";

const buildTask: WorkspaceTask = {
  id: "build",
  title: "Build",
  command: "npm run build",
  confirm: false,
};

const deployTask: WorkspaceTask = {
  id: "deploy",
  title: "Deploy",
  command: "npm run deploy",
  confirm: true,
};

const editedBuildTask: WorkspaceTask = {
  ...buildTask,
  title: "Build release",
};

const extraTask: WorkspaceTask = {
  id: "lint",
  title: "Lint",
  command: "npm run lint",
  confirm: false,
};

const workspaceA = selection("machine-a", "project-a", "workspace-a", "/projects/a");
const workspaceB = selection("machine-a", "project-a", "workspace-b", "/projects/a/worktrees/b");
const workspaceBAtNewPath = selection("machine-a", "project-a", "workspace-b", "/projects/a/worktrees/b-renamed");
const remoteWorkspace = selection("machine-b", "project-b", "workspace-r", "/projects/b");

describe("WorkspaceTasksController", () => {
  it("loads both catalogs only after an enabled contribution is observed", async () => {
    const workspaceRead = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const globalRead = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const harness = createHarness({
      workspaceReads: [workspaceRead.promise],
      globalReads: [globalRead.promise],
    });

    harness.controller.observe(false);
    expect(harness.client.readWorkspace).not.toHaveBeenCalled();
    expect(harness.client.readGlobal).not.toHaveBeenCalled();

    harness.controller.observe(true);
    const loading = harness.controller.refresh();
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(1);
    expect(harness.client.readGlobal).toHaveBeenCalledTimes(1);

    globalRead.resolve(success(globalLoaded("global-1", [deployTask])));
    await settle();
    expect(harness.controller.state.workspace).toEqual({ kind: "loading" });
    expect(harness.controller.state.global).toEqual({
      kind: "loaded",
      config: config([deployTask]),
      refreshing: false,
    });

    workspaceRead.resolve(success(workspaceLoaded("workspace-1", [buildTask])));
    await loading;
    expect(harness.controller.state).toEqual({
      workspace: { kind: "loaded", config: config([buildTask]), refreshing: false },
      global: { kind: "loaded", config: config([deployTask]), refreshing: false },
    });
  });

  it("reuses the machine-global cache while invalidating workspace data for an ID or path change", async () => {
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-a-1", [buildTask])),
        success(workspaceLoaded("workspace-b-1", [deployTask])),
        success(workspaceLoaded("workspace-b-2", [editedBuildTask])),
      ],
      globalReads: [success(globalLoaded("global-1", [deployTask]))],
    });

    harness.controller.observe(true);
    await settle();
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(1);
    expect(harness.client.readGlobal).toHaveBeenCalledTimes(1);

    harness.setSelection(workspaceB);
    harness.controller.observe(true);
    await settle();
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(2);
    expect(harness.client.readGlobal).toHaveBeenCalledTimes(1);
    expect(harness.controller.state).toEqual({
      workspace: { kind: "loaded", config: config([deployTask]), refreshing: false },
      global: { kind: "loaded", config: config([deployTask]), refreshing: false },
    });

    harness.setSelection(workspaceBAtNewPath);
    harness.controller.observe(true);
    await settle();
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(3);
    expect(harness.client.readGlobal).toHaveBeenCalledTimes(1);
    expect(harness.controller.state.workspace).toEqual({
      kind: "loaded",
      config: config([editedBuildTask]),
      refreshing: false,
    });
  });

  it("coalesces same-selection refreshes into one request per source", async () => {
    const workspaceRefresh = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const globalRefresh = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const harness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask])), workspaceRefresh.promise],
      globalReads: [success(globalLoaded("global-1", [deployTask])), globalRefresh.promise],
    });

    harness.controller.observe(true);
    await settle();

    const firstRefresh = harness.controller.refresh();
    const secondRefresh = harness.controller.refresh();
    expect(firstRefresh).toBe(secondRefresh);
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(2);
    expect(harness.client.readGlobal).toHaveBeenCalledTimes(2);
    expect(harness.controller.state.workspace).toEqual({
      kind: "loaded",
      config: config([buildTask]),
      refreshing: true,
    });
    expect(harness.controller.state.global).toEqual({
      kind: "loaded",
      config: config([deployTask]),
      refreshing: true,
    });

    workspaceRefresh.resolve(success(workspaceLoaded("workspace-2", [editedBuildTask])));
    globalRefresh.resolve(success(globalLoaded("global-2", [buildTask])));
    await firstRefresh;
    expect(harness.controller.state).toEqual({
      workspace: { kind: "loaded", config: config([editedBuildTask]), refreshing: false },
      global: { kind: "loaded", config: config([buildTask]), refreshing: false },
    });
  });

  it("suppresses stale selection completions even when a transport ignores cancellation", async () => {
    const staleWorkspaceRead = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const staleGlobalRead = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const harness = createHarness({
      workspaceReads: [staleWorkspaceRead.promise, success(workspaceLoaded("remote-1", [deployTask]))],
      globalReads: [staleGlobalRead.promise, success(globalLoaded("remote-global-1", [buildTask]))],
    });

    harness.controller.observe(true);
    harness.setSelection(remoteWorkspace);
    harness.controller.observe(true);
    await settle();
    expect(harness.controller.state).toEqual({
      workspace: { kind: "loaded", config: config([deployTask]), refreshing: false },
      global: { kind: "loaded", config: config([buildTask]), refreshing: false },
    });

    const publicationCount = harness.published.length;
    staleWorkspaceRead.resolve(success(workspaceLoaded("stale-1", [buildTask])));
    staleGlobalRead.resolve(success(globalLoaded("stale-global-1", [deployTask])));
    await settle();

    expect(harness.published).toHaveLength(publicationCount);
    expect(harness.controller.state.workspace).toEqual({
      kind: "loaded",
      config: config([deployTask]),
      refreshing: false,
    });
  });

  it("suppresses completions after disposal", async () => {
    const workspaceRead = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const globalRead = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const harness = createHarness({ workspaceReads: [workspaceRead.promise], globalReads: [globalRead.promise] });

    harness.controller.observe(true);
    const publicationCount = harness.published.length;
    harness.controller.dispose();
    workspaceRead.resolve(success(workspaceLoaded("workspace-1", [buildTask])));
    globalRead.resolve(success(globalLoaded("global-1", [deployTask])));
    await settle();

    expect(harness.published).toHaveLength(publicationCount);
  });

  it("retains loaded data with a source-specific refresh error and leaves the other source usable", async () => {
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-1", [buildTask])),
        failure({ kind: "unavailable", message: "Workspace offline", retryable: true }),
      ],
      globalReads: [
        success(globalLoaded("global-1", [deployTask])),
        success(globalLoaded("global-2", [editedBuildTask])),
      ],
    });

    harness.controller.observe(true);
    await settle();
    await harness.controller.refresh();

    expect(harness.controller.state.workspace).toEqual({
      kind: "loaded",
      config: config([buildTask]),
      refreshing: false,
      refreshError: "Workspace offline",
    });
    expect(harness.controller.state.global).toEqual({
      kind: "loaded",
      config: config([editedBuildTask]),
      refreshing: false,
    });

    await harness.controller.actions.create("global", buildTask);
    expect(harness.client.replaceGlobal).toHaveBeenCalledTimes(1);
  });

  it("keeps workspace and global mutations independently usable when the other source is unavailable or invalid", async () => {
    const workspaceHarness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask]))],
      globalReads: [failure({ kind: "unavailable", message: "Global unavailable", retryable: true })],
      workspaceReplacements: [success(workspaceLoaded("workspace-2", [buildTask, deployTask]))],
    });
    workspaceHarness.controller.observe(true);
    await settle();
    await workspaceHarness.controller.actions.create("workspace", deployTask);
    expect(workspaceHarness.client.replaceWorkspace).toHaveBeenCalledTimes(1);
    expect(workspaceHarness.controller.state.global).toEqual({
      kind: "unavailable",
      message: "Global unavailable",
      hint: "Refresh and try again.",
    });

    const globalHarness = createHarness({
      workspaceReads: [success(workspaceInvalid())],
      globalReads: [success(globalLoaded("global-1", [deployTask]))],
      globalReplacements: [success(globalLoaded("global-2", [deployTask, buildTask]))],
    });
    globalHarness.controller.observe(true);
    await settle();
    await globalHarness.controller.actions.create("global", buildTask);
    expect(globalHarness.client.replaceGlobal).toHaveBeenCalledTimes(1);
    expect(globalHarness.controller.state.workspace).toEqual(workspaceInvalid());
  });

  it("uses private revisions for workspace and global CAS CRUD and replaces them from each successful response", async () => {
    const harness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask]))],
      globalReads: [success(globalLoaded("global-1", [deployTask]))],
      workspaceReplacements: [
        success(workspaceLoaded("workspace-2", [buildTask, deployTask])),
        success(workspaceLoaded("workspace-3", [editedBuildTask, deployTask])),
        success(workspaceLoaded("workspace-4", [deployTask])),
      ],
      globalReplacements: [
        success(globalLoaded("global-2", [deployTask, buildTask])),
        success(globalLoaded("global-3", [deployTask, editedBuildTask])),
        success(globalLoaded("global-4", [deployTask])),
      ],
    });
    harness.controller.observe(true);
    await settle();

    await harness.controller.actions.create("workspace", deployTask);
    await harness.controller.actions.update({ scope: "workspace", id: "build" }, editedBuildTask);
    await harness.controller.actions.remove({ scope: "workspace", id: "build" });
    expect(harness.client.replaceWorkspace.mock.calls.map(([input]) => input.expectedRevision)).toEqual([
      "workspace-1",
      "workspace-2",
      "workspace-3",
    ]);
    expect(harness.client.replaceWorkspace.mock.calls.map(([input]) => input.config)).toEqual([
      config([buildTask, deployTask]),
      config([editedBuildTask, deployTask]),
      config([deployTask]),
    ]);

    await harness.controller.actions.create("global", buildTask);
    await harness.controller.actions.update({ scope: "global", id: "build" }, editedBuildTask);
    await harness.controller.actions.remove({ scope: "global", id: "build" });
    expect(harness.client.replaceGlobal.mock.calls.map(([input]) => input.expectedRevision)).toEqual([
      "global-1",
      "global-2",
      "global-3",
    ]);
    expect(harness.client.replaceGlobal.mock.calls.map(([input]) => input.config)).toEqual([
      config([deployTask, buildTask]),
      config([deployTask, editedBuildTask]),
      config([deployTask]),
    ]);
  });

  it("gates direct revision conflicts until an explicit successful refresh", async () => {
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-1", [buildTask])),
        success(workspaceLoaded("workspace-2", [buildTask])),
      ],
      globalReads: [success(globalLoaded("global-1", [deployTask])), success(globalLoaded("global-2", [deployTask]))],
      workspaceReplacements: [failure({ kind: "conflict", reason: "revision-conflict", message: "Workspace changed" })],
    });
    harness.controller.observe(true);
    await settle();

    await harness.controller.actions.create("workspace", deployTask);
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(1);
    expect(harness.client.readGlobal).toHaveBeenCalledTimes(1);
    expect(harness.controller.state.mutationGate).toEqual({
      scopes: ["workspace"],
      message: "Workspace changed",
    });

    await harness.controller.actions.refresh();
    expect(harness.controller.state.mutationGate).toBeUndefined();
  });

  it("does not turn a background refresh error into a write-blocking conflict", async () => {
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-1", [buildTask])),
        failure({ kind: "unavailable", message: "Temporary workspace error", retryable: true }),
      ],
      globalReads: [success(globalLoaded("global-1", [deployTask])), success(globalLoaded("global-2", [deployTask]))],
      workspaceReplacements: [success(workspaceLoaded("workspace-2", [buildTask, deployTask]))],
    });
    harness.controller.observe(true);
    await settle();
    await harness.controller.refresh();

    expect(harness.controller.state.mutationGate).toBeUndefined();
    await harness.controller.actions.create("workspace", deployTask);
    expect(harness.client.replaceWorkspace).toHaveBeenCalledTimes(1);
  });

  it("publishes completed promotion results without exposing move bookkeeping", async () => {
    const completed: MoveWorkspaceTaskResult = {
      kind: "completed",
      operationId: "11111111-1111-4111-8111-111111111111",
      workspace: workspaceLoaded("workspace-2", []),
      global: globalLoaded("global-2", [deployTask]),
    };
    const harness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask]))],
      globalReads: [success(globalLoaded("global-1", []))],
      moves: [completed],
      uuids: ["11111111-1111-4111-8111-111111111111"],
    });
    harness.controller.observe(true);
    await settle();

    await harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);

    expect(harness.client.move).toHaveBeenCalledWith(expect.objectContaining({
      machineId: "machine-a",
      projectId: "project-a",
      workspaceId: "workspace-a",
      operationId: "11111111-1111-4111-8111-111111111111",
      intent: "start",
      source: {
        ref: { scope: "workspace", id: "build" },
        expectedCatalog: { kind: "loaded", revision: "workspace-1", config: config([buildTask]) },
      },
      destination: {
        scope: "global",
        expectedCatalog: { kind: "loaded", revision: "global-1", config: config([]) },
        task: deployTask,
      },
    }));
    expect(harness.controller.state).toEqual({
      workspace: { kind: "loaded", config: config([]), refreshing: false },
      global: { kind: "loaded", config: config([deployTask]), refreshing: false },
    });
    expect(Object.keys(harness.controller.state)).not.toContain("operationId");
  });

  it("does not let a later unrelated refresh revive a completed move context", async () => {
    const operationId = "23232323-2323-4232-8232-232323232323";
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-1", [buildTask])),
        success(workspaceLoaded("workspace-3", [extraTask])),
      ],
      globalReads: [success(globalLoaded("global-1", [])), success(globalLoaded("global-3", [deployTask]))],
      moves: [{
        kind: "completed",
        operationId,
        workspace: workspaceLoaded("workspace-2", []),
        global: globalLoaded("global-2", [deployTask]),
      }],
      uuids: [operationId],
    });
    harness.controller.observe(true);
    await settle();
    await harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);
    await harness.controller.actions.refresh();

    expect(harness.controller.state.move).toBeUndefined();
    expect(harness.controller.state.mutationGate).toBeUndefined();
  });

  it("publishes known move validation errors without creating recovery context", async () => {
    const harness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask]))],
      globalReads: [success(globalLoaded("global-1", []))],
      moves: [{ kind: "validation", message: "Task is invalid" }],
      uuids: ["34343434-3434-4343-8343-343434343434"],
    });
    harness.controller.observe(true);
    await settle();

    await harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);

    expect(harness.controller.state.move).toEqual({
      kind: "conflict",
      message: "Task is invalid",
      retryAllowed: false,
    });
    await harness.controller.actions.retryMove();
    expect(harness.client.move).toHaveBeenCalledTimes(1);
  });

  it("publishes completed demotion results", async () => {
    const harness = createHarness({
      workspaceReads: [success(workspaceMissing("workspace-missing"))],
      globalReads: [success(globalLoaded("global-1", [buildTask]))],
      moves: [{
        kind: "completed",
        operationId: "22222222-2222-4222-8222-222222222222",
        workspace: workspaceLoaded("workspace-1", [deployTask]),
        global: globalLoaded("global-2", []),
      }],
      uuids: ["22222222-2222-4222-8222-222222222222"],
    });
    harness.controller.observe(true);
    await settle();

    await harness.controller.actions.move({ scope: "global", id: "build" }, deployTask);

    expect(harness.client.move).toHaveBeenCalledWith(expect.objectContaining({
      intent: "start",
      source: {
        ref: { scope: "global", id: "build" },
        expectedCatalog: { kind: "loaded", revision: "global-1", config: config([buildTask]) },
      },
      destination: {
        scope: "workspace",
        expectedCatalog: { kind: "missing", revision: "workspace-missing" },
        task: deployTask,
      },
    }));
    expect(harness.controller.state).toEqual({
      workspace: { kind: "loaded", config: config([deployTask]), refreshing: false },
      global: { kind: "loaded", config: config([]), refreshing: false },
    });
  });

  it.each(["destination-collision", "source-changed"] as const)("refresh-gates a %s move conflict without writing again", async (reason) => {
    const harness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask]))],
      globalReads: [success(globalLoaded("global-1", []))],
      moves: [{ kind: "conflict", reason, message: `Move ${reason}` }],
    });
    harness.controller.observe(true);
    await settle();

    await harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);
    expect(harness.controller.state.move).toEqual({
      kind: "conflict",
      message: `Move ${reason}`,
      retryAllowed: false,
    });
    expect(harness.controller.state.mutationGate).toEqual({
      scopes: ["workspace", "global"],
      message: `Move ${reason}`,
    });

    await harness.controller.actions.retryMove();
    expect(harness.client.move).toHaveBeenCalledTimes(1);
  });

  it("retains a partial move context and retries the same operation only when the destination state is known", async () => {
    const operationId = "33333333-3333-4333-8333-333333333333";
    const harness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask]))],
      globalReads: [success(globalLoaded("global-1", []))],
      moves: [
        {
          kind: "partial",
          operationId,
          phase: "destination-written",
          workspace: workspaceLoaded("workspace-1", [buildTask]),
          global: globalLoaded("global-2", [deployTask]),
        },
        {
          kind: "completed",
          operationId,
          workspace: workspaceLoaded("workspace-2", []),
          global: globalLoaded("global-2", [deployTask]),
        },
      ],
      uuids: [operationId],
    });
    harness.controller.observe(true);
    await settle();

    await harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);
    expect(harness.controller.state.move).toEqual({
      kind: "partial",
      message: "Move is partially complete. Refresh before retrying.",
      retryAllowed: true,
    });

    await harness.controller.actions.retryMove();
    expect(harness.client.move).toHaveBeenCalledTimes(2);
    expect(harness.client.move.mock.calls[1]?.[0]).toMatchObject({
      operationId,
      intent: "retry",
      source: {
        ref: { scope: "workspace", id: "build" },
        expectedCatalog: { kind: "loaded", revision: "workspace-1", config: config([buildTask]) },
      },
    });
    expect(harness.controller.state.move).toBeUndefined();
  });

  it("does not downgrade a proven partial move when the enabled contribution is observed again", async () => {
    const operationId = "99999999-9999-4999-8999-999999999999";
    const harness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask]))],
      globalReads: [success(globalLoaded("global-1", []))],
      moves: [{
        kind: "partial",
        operationId,
        phase: "destination-written",
        workspace: workspaceLoaded("workspace-1", [buildTask]),
        global: globalLoaded("global-2", [deployTask]),
      }],
      uuids: [operationId],
    });
    harness.controller.observe(true);
    await settle();
    await harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);

    harness.controller.observe(true);
    await settle();

    expect(harness.controller.state.move).toEqual({
      kind: "partial",
      message: "Move is partially complete. Refresh before retrying.",
      retryAllowed: true,
    });
  });

  it("invalidates an older source refresh when a newer CAS response is accepted", async () => {
    const staleWorkspace = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const harness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask])), staleWorkspace.promise],
      globalReads: [success(globalLoaded("global-1", [])), success(globalLoaded("global-2", []))],
      workspaceReplacements: [success(workspaceLoaded("workspace-2", [buildTask, deployTask]))],
    });
    harness.controller.observe(true);
    await settle();

    const refreshing = harness.controller.refresh();
    await settle();
    await harness.controller.actions.create("workspace", deployTask);
    expect(harness.controller.state.workspace).toEqual({
      kind: "loaded",
      config: config([buildTask, deployTask]),
      refreshing: false,
    });

    staleWorkspace.resolve(success(workspaceLoaded("stale", [buildTask])));
    await refreshing;
    expect(harness.controller.state.workspace).toEqual({
      kind: "loaded",
      config: config([buildTask, deployTask]),
      refreshing: false,
    });
  });

  it("keeps a lost-claim result manual-resolution-only after a matching refresh", async () => {
    const operationId = "88888888-8888-4888-8888-888888888888";
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-1", [buildTask])),
        success(workspaceLoaded("workspace-1", [buildTask])),
      ],
      globalReads: [
        success(globalLoaded("global-1", [])),
        success(globalLoaded("global-2", [deployTask])),
      ],
      moves: [
        {
          kind: "partial",
          operationId,
          phase: "destination-written",
          workspace: workspaceLoaded("workspace-1", [buildTask]),
          global: globalLoaded("global-2", [deployTask]),
        },
        {
          kind: "conflict",
          reason: "unowned-intermediate-state",
          message: "The move claim was lost",
        },
      ],
      uuids: [operationId],
    });
    harness.controller.observe(true);
    await settle();
    await harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);
    await harness.controller.actions.retryMove();
    await harness.controller.actions.refresh();

    expect(harness.controller.state.move).toEqual({
      kind: "conflict",
      message: "The move claim was lost",
      retryAllowed: false,
    });
    await harness.controller.actions.retryMove();
    expect(harness.client.move).toHaveBeenCalledTimes(2);
  });

  it("does not authorize Retry from a partial response that is not the exact destination-applied pair", async () => {
    const operationId = "12121212-1212-4121-8121-121212121212";
    const harness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask]))],
      globalReads: [success(globalLoaded("global-1", []))],
      moves: [{
        kind: "partial",
        operationId,
        phase: "destination-written",
        workspace: workspaceLoaded("workspace-1", [buildTask]),
        global: globalLoaded("global-2", [deployTask, extraTask]),
      }],
      uuids: [operationId],
    });
    harness.controller.observe(true);
    await settle();

    await harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);

    expect(harness.controller.state.move).toEqual({
      kind: "conflict",
      message: "The move could not be verified. Refresh and resolve it manually.",
      retryAllowed: false,
    });
    await harness.controller.actions.retryMove();
    expect(harness.client.move).toHaveBeenCalledTimes(1);
  });

  it("refreshes an unknown move outcome to complete without sending a second write", async () => {
    const operationId = "44444444-4444-4444-8444-444444444444";
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-1", [buildTask])),
        success(workspaceLoaded("workspace-2", [])),
      ],
      globalReads: [success(globalLoaded("global-1", [])), success(globalLoaded("global-2", [deployTask]))],
      moves: [{ kind: "unknown-outcome", message: "Connection lost" }],
      uuids: [operationId],
    });
    harness.controller.observe(true);
    await settle();

    await harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);

    expect(harness.client.move).toHaveBeenCalledTimes(1);
    expect(harness.controller.state.move).toBeUndefined();
    expect(harness.controller.state).toEqual({
      workspace: { kind: "loaded", config: config([]), refreshing: false },
      global: { kind: "loaded", config: config([deployTask]), refreshing: false },
    });
  });

  it("requires a new confirmation when unknown-outcome recovery proves the pristine pair", async () => {
    const firstOperationId = "55555555-5555-4555-8555-555555555555";
    const secondOperationId = "66666666-6666-4666-8666-666666666666";
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-1", [buildTask])),
        success(workspaceLoaded("workspace-1", [buildTask])),
      ],
      globalReads: [success(globalLoaded("global-1", [])), success(globalLoaded("global-1", []))],
      moves: [
        { kind: "unknown-outcome", message: "Connection lost" },
        {
          kind: "completed",
          operationId: secondOperationId,
          workspace: workspaceLoaded("workspace-2", []),
          global: globalLoaded("global-2", [deployTask]),
        },
      ],
      uuids: [firstOperationId, secondOperationId],
    });
    harness.controller.observe(true);
    await settle();

    await harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);
    expect(harness.controller.state.move).toBeUndefined();

    await harness.controller.actions.retryMove();
    expect(harness.client.move).toHaveBeenCalledTimes(1);

    await harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);
    expect(harness.client.move.mock.calls.map(([input]) => input.operationId)).toEqual([firstOperationId, secondOperationId]);
    expect(harness.client.move.mock.calls.map(([input]) => input.intent)).toEqual(["start", "start"]);
  });

  it("does not retry an unknown outcome until a refresh proves the exact destination-written pair", async () => {
    const operationId = "77777777-7777-4777-8777-777777777777";
    const refreshedWorkspace = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const refreshedGlobal = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const harness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask])), refreshedWorkspace.promise],
      globalReads: [success(globalLoaded("global-1", [])), refreshedGlobal.promise],
      moves: [
        { kind: "unknown-outcome", message: "Connection lost" },
        {
          kind: "completed",
          operationId,
          workspace: workspaceLoaded("workspace-2", []),
          global: globalLoaded("global-2", [deployTask]),
        },
      ],
      uuids: [operationId],
    });
    harness.controller.observe(true);
    await settle();

    const moving = harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);
    await settle();
    expect(harness.controller.state.move).toEqual({
      kind: "unknown-outcome",
      message: "Connection lost",
      retryAllowed: false,
    });

    await harness.controller.actions.retryMove();
    expect(harness.client.move).toHaveBeenCalledTimes(1);

    refreshedWorkspace.resolve(success(workspaceLoaded("workspace-1", [buildTask])));
    refreshedGlobal.resolve(success(globalLoaded("global-2", [deployTask])));
    await moving;
    expect(harness.controller.state.move).toEqual({
      kind: "partial",
      message: "Move is partially complete. Refresh before retrying.",
      retryAllowed: true,
    });

    await harness.controller.actions.retryMove();
    expect(harness.client.move).toHaveBeenCalledTimes(2);
    expect(harness.client.move.mock.calls[1]?.[0]).toMatchObject({ operationId, intent: "retry" });
  });

  it("leaves a lost server claim manual-resolution-only with zero automatic retry", async () => {
    const operationId = "88888888-8888-4888-8888-888888888888";
    const harness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask]))],
      globalReads: [success(globalLoaded("global-1", []))],
      moves: [
        {
          kind: "partial",
          operationId,
          phase: "destination-written",
          workspace: workspaceLoaded("workspace-1", [buildTask]),
          global: globalLoaded("global-2", [deployTask]),
        },
        {
          kind: "conflict",
          reason: "unowned-intermediate-state",
          message: "The move claim was lost",
        },
      ],
      uuids: [operationId],
    });
    harness.controller.observe(true);
    await settle();

    await harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);
    await harness.controller.actions.retryMove();
    expect(harness.controller.state.move).toEqual({
      kind: "conflict",
      message: "The move claim was lost",
      retryAllowed: false,
    });
    expect(harness.controller.state.mutationGate).toEqual({
      scopes: ["workspace", "global"],
      message: "The move claim was lost",
    });

    await harness.controller.actions.retryMove();
    expect(harness.client.move).toHaveBeenCalledTimes(2);
  });
});

interface HarnessOptions {
  initialSelection?: WorkspaceTasksSelection;
  workspaceReads?: Pending<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>[];
  globalReads?: Pending<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>[];
  workspaceReplacements?: Pending<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>[];
  globalReplacements?: Pending<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>[];
  moves?: Pending<MoveWorkspaceTaskResult | WorkspaceTasksFailureResponse>[];
  uuids?: string[];
}

type Pending<T> = T | Promise<T>;
interface FakeClient {
  readWorkspace: ReturnType<typeof vi.fn<WorkspaceTasksClient["readWorkspace"]>>;
  replaceWorkspace: ReturnType<typeof vi.fn<WorkspaceTasksClient["replaceWorkspace"]>>;
  readGlobal: ReturnType<typeof vi.fn<WorkspaceTasksClient["readGlobal"]>>;
  replaceGlobal: ReturnType<typeof vi.fn<WorkspaceTasksClient["replaceGlobal"]>>;
  move: ReturnType<typeof vi.fn<WorkspaceTasksClient["move"]>>;
}

function createHarness(options: HarnessOptions = {}) {
  let selected = options.initialSelection ?? workspaceA;
  const workspaceReads: Pending<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>[] = [
    ...(options.workspaceReads ?? [success(workspaceLoaded("workspace-default", []))]),
  ];
  const globalReads: Pending<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>[] = [
    ...(options.globalReads ?? [success(globalLoaded("global-default", []))]),
  ];
  const workspaceReplacements: Pending<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>[] = [
    ...(options.workspaceReplacements ?? [success(workspaceLoaded("workspace-default-next", []))]),
  ];
  const globalReplacements: Pending<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>[] = [
    ...(options.globalReplacements ?? [success(globalLoaded("global-default-next", []))]),
  ];
  const moves: Pending<MoveWorkspaceTaskResult | WorkspaceTasksFailureResponse>[] = [
    ...(options.moves ?? [{ kind: "validation", message: "No move fixture" }]),
  ];
  const uuids = [...(options.uuids ?? ["99999999-9999-4999-8999-999999999999"] )];
  const published: WorkspaceTasksWorkspaceState[] = [];

  const client: FakeClient = {
    readWorkspace: vi.fn<WorkspaceTasksClient["readWorkspace"]>((input, signal) => {
      void input;
      void signal;
      return next(workspaceReads, "workspace read");
    }),
    replaceWorkspace: vi.fn<WorkspaceTasksClient["replaceWorkspace"]>((input) => {
      void input;
      return next(workspaceReplacements, "workspace replacement");
    }),
    readGlobal: vi.fn<WorkspaceTasksClient["readGlobal"]>((machineId, signal) => {
      void machineId;
      void signal;
      return next(globalReads, "global read");
    }),
    replaceGlobal: vi.fn<WorkspaceTasksClient["replaceGlobal"]>((input) => {
      void input;
      return next(globalReplacements, "global replacement");
    }),
    move: vi.fn<WorkspaceTasksClient["move"]>((input) => {
      void input;
      return next(moves, "move");
    }),
  };
  const dependencies: WorkspaceTasksControllerDependencies = {
    client,
    selectedScope: () => selected,
    createUuid: () => uuids.shift() ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    onChange: (state) => { published.push(state); },
  };
  const controller = new WorkspaceTasksController(dependencies);

  return {
    client,
    controller,
    published,
    setSelection: (nextSelection: WorkspaceTasksSelection) => { selected = nextSelection; },
  };
}

function selection(machineId: string, projectId: string, workspaceId: string, workspacePath: string): WorkspaceTasksSelection {
  return { machineId, projectId, workspaceId, workspacePath };
}

function config(tasks: WorkspaceTask[]): WorkspaceTasksConfig {
  return { version: 1, tasks };
}

function workspaceLoaded(revision: string, tasks: WorkspaceTask[]): WorkspaceTasksCatalogResponse {
  return { kind: "loaded", revision, config: config(tasks) };
}

function workspaceMissing(revision: string): WorkspaceTasksCatalogResponse {
  return { kind: "missing", revision, message: "No Project tasks", hint: "Create a Project task." };
}

function workspaceInvalid(): WorkspaceTasksCatalogResponse {
  return { kind: "invalid", message: "Project tasks are invalid", hint: "Repair the file.", detail: "Invalid task JSON" };
}

function globalLoaded(revision: string, tasks: WorkspaceTask[]): GlobalWorkspaceTasksResponse {
  return { kind: "loaded", revision, config: config(tasks) };
}

function success<T>(value: T): WorkspaceTasksRequestResult<T> {
  return { kind: "success", value };
}

function failure(value: WorkspaceTasksFailureResponse): WorkspaceTasksFailureResponse {
  return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function next<T>(items: Pending<T>[], label: string): Promise<T> {
  const value = items.shift();
  if (value === undefined) throw new Error(`Missing ${label} fixture`);
  return Promise.resolve(value);
}
