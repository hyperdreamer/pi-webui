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
      sourceGenerations: { workspace: 1, global: 1 },
    });
  });

  it("retries a canceled initial load after observation resumes", async () => {
    const staleWorkspaceRead = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const staleGlobalRead = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const harness = createHarness({
      workspaceReads: [staleWorkspaceRead.promise, success(workspaceLoaded("workspace-2", [buildTask]))],
      globalReads: [staleGlobalRead.promise, success(globalLoaded("global-2", [deployTask]))],
    });

    harness.controller.observe(true);
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(1);
    expect(harness.client.readGlobal).toHaveBeenCalledTimes(1);

    harness.controller.observe(false);
    harness.controller.observe(true);
    await settle();

    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(2);
    expect(harness.client.readGlobal).toHaveBeenCalledTimes(2);
    expect(harness.controller.state).toEqual({
      workspace: { kind: "loaded", config: config([buildTask]), refreshing: false },
      global: { kind: "loaded", config: config([deployTask]), refreshing: false },
      sourceGenerations: { workspace: 1, global: 1 },
    });
  });

  it("does not repeat a failed observation load until refresh or a selection change", async () => {
    const harness = createHarness({
      workspaceReads: [
        failure({ kind: "unavailable", message: "Workspace offline", retryable: true }),
        success(workspaceLoaded("workspace-b-1", [deployTask])),
        failure({ kind: "unavailable", message: "Workspace still offline", retryable: true }),
        success(workspaceLoaded("workspace-a-2", [extraTask])),
      ],
      globalReads: [
        success(globalLoaded("global-1", [])),
        success(globalLoaded("global-2", [])),
      ],
    });

    harness.controller.observe(true);
    await settle();
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(1);

    harness.controller.observe(true);
    await settle();
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(1);

    harness.setSelection(workspaceB);
    harness.controller.observe(true);
    await settle();
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(2);

    harness.setSelection(workspaceA);
    harness.controller.observe(true);
    await settle();
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(3);

    await harness.controller.actions.refresh();
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(4);
    expect(harness.controller.state.workspace).toEqual({
      kind: "loaded",
      config: config([extraTask]),
      refreshing: false,
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
      sourceGenerations: { workspace: 1, global: 1 },
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
      sourceGenerations: { workspace: 2, global: 2 },
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
      sourceGenerations: { workspace: 1, global: 1 },
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

  it("publishes a source-scoped generation for a canonical no-op direct response", async () => {
    let tracking = false;
    let updateResolved = false;
    let publicationBeforeResolution = false;
    let initialWorkspaceGeneration = 0;
    const harness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask]))],
      globalReads: [success(globalLoaded("global-1", [deployTask]))],
      workspaceReplacements: [success(workspaceLoaded("workspace-1", [buildTask]))],
      onChange: (state) => {
        if (!tracking) return;
        const workspaceGeneration = readSourceGeneration(state, "workspace");
        if (workspaceGeneration > initialWorkspaceGeneration) publicationBeforeResolution ||= !updateResolved;
      },
    });
    harness.controller.observe(true);
    await settle();
    initialWorkspaceGeneration = readSourceGeneration(harness.controller.state, "workspace");
    const initialGlobalGeneration = readSourceGeneration(harness.controller.state, "global");
    tracking = true;

    const saving = harness.controller.actions.update({ scope: "workspace", id: "build" }, buildTask).then(() => {
      updateResolved = true;
    });
    await saving;

    expect(readSourceGeneration(harness.controller.state, "workspace")).toBe(initialWorkspaceGeneration + 1);
    expect(readSourceGeneration(harness.controller.state, "global")).toBe(initialGlobalGeneration);
    expect(publicationBeforeResolution).toBe(true);
  });

  it("allows workspace mutations for different cache identities to run concurrently", async () => {
    const firstWrite = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-a-1", [buildTask])),
        success(workspaceLoaded("workspace-b-1", [])),
      ],
      globalReads: [success(globalLoaded("global-1", []))],
      workspaceReplacements: [
        firstWrite.promise,
        success(workspaceLoaded("workspace-b-2", [deployTask])),
      ],
    });
    harness.controller.observe(true);
    await settle();

    const savingA = harness.controller.actions.create("workspace", extraTask);
    await settle();
    expect(harness.client.replaceWorkspace).toHaveBeenCalledTimes(1);

    harness.setSelection(workspaceB);
    harness.controller.observe(true);
    await settle();
    const savingB = harness.controller.actions.create("workspace", deployTask);
    await settle();

    expect(harness.client.replaceWorkspace).toHaveBeenCalledTimes(2);
    expect(harness.client.replaceWorkspace.mock.calls[1]?.[0]).toMatchObject({
      workspaceId: "workspace-b",
      expectedRevision: "workspace-b-1",
    });

    firstWrite.resolve(success(workspaceLoaded("workspace-a-2", [buildTask, extraTask])));
    await Promise.all([savingA, savingB]);
  });

  it("serializes global mutations for a machine across workspace selection changes", async () => {
    const firstWrite = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-a-1", [buildTask])),
        success(workspaceLoaded("workspace-b-1", [buildTask])),
      ],
      globalReads: [success(globalLoaded("global-1", []))],
      globalReplacements: [firstWrite.promise],
    });
    harness.controller.observe(true);
    await settle();

    const savingA = harness.controller.actions.create("global", extraTask);
    await settle();
    expect(harness.client.replaceGlobal).toHaveBeenCalledTimes(1);

    harness.setSelection(workspaceB);
    harness.controller.observe(true);
    await settle();
    await expect(harness.controller.actions.create("global", deployTask)).rejects.toThrow("already in progress");
    expect(harness.client.replaceGlobal).toHaveBeenCalledTimes(1);

    firstWrite.resolve(success(globalLoaded("global-2", [extraTask])));
    await savingA;
  });

  it("serializes a move against an in-flight global mutation", async () => {
    const globalWrite = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const harness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask]))],
      globalReads: [success(globalLoaded("global-1", []))],
      globalReplacements: [globalWrite.promise],
    });
    harness.controller.observe(true);
    await settle();

    const saving = harness.controller.actions.create("global", extraTask);
    await settle();
    await expect(harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask)).rejects.toThrow("already in progress");
    expect(harness.client.move).not.toHaveBeenCalled();

    globalWrite.resolve(success(globalLoaded("global-2", [extraTask])));
    await saving;
  });

  it("rejects a second mutation for the same cache instead of silently dropping it", async () => {
    const firstWrite = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const harness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask]))],
      globalReads: [success(globalLoaded("global-1", []))],
      workspaceReplacements: [firstWrite.promise],
    });
    harness.controller.observe(true);
    await settle();

    const first = harness.controller.actions.create("workspace", extraTask);
    const second = harness.controller.actions.create("workspace", deployTask);
    await expect(second).rejects.toThrow("already in progress");
    expect(harness.client.replaceWorkspace).toHaveBeenCalledTimes(1);

    firstWrite.resolve(success(workspaceLoaded("workspace-2", [buildTask, extraTask])));
    await first;
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

  it("does not repeat a failed recovery refresh on repeated observation", async () => {
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-1", [buildTask])),
        failure({ kind: "unavailable", message: "Recovery unavailable", retryable: true }),
        success(workspaceLoaded("workspace-2", [buildTask, deployTask])),
      ],
      globalReads: [
        success(globalLoaded("global-1", [])),
        success(globalLoaded("global-2", [])),
        success(globalLoaded("global-3", [])),
        success(globalLoaded("global-4", [])),
      ],
      workspaceReplacements: [{ kind: "unknown-outcome", message: "Workspace write response lost" }],
    });
    harness.controller.observe(true);
    await settle();

    await harness.controller.actions.create("workspace", deployTask);
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(2);

    harness.controller.observe(true);
    await settle();
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(2);

    await harness.controller.actions.refresh();
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(3);
    expect(harness.controller.state.mutationGate).toBeUndefined();
  });

  it("does not retry a failed in-flight global recovery after a workspace switch", async () => {
    const recoveryGlobal = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-a-1", [buildTask])),
        success(workspaceLoaded("workspace-a-2", [buildTask])),
        success(workspaceLoaded("workspace-b-1", [buildTask])),
      ],
      globalReads: [success(globalLoaded("global-1", [])), recoveryGlobal.promise],
      globalReplacements: [{ kind: "unknown-outcome", message: "Global write response lost" }],
    });
    harness.controller.observe(true);
    await settle();

    const saving = harness.controller.actions.create("global", extraTask);
    await settle();
    expect(harness.client.readGlobal).toHaveBeenCalledTimes(2);

    harness.setSelection(workspaceB);
    harness.controller.observe(true);
    await settle();
    recoveryGlobal.resolve(failure({ kind: "unavailable", message: "Global recovery unavailable", retryable: true }));
    await saving;

    harness.controller.observe(true);
    await settle();
    expect(harness.client.readGlobal).toHaveBeenCalledTimes(2);
  });

  it("does not let an older refresh satisfy unknown move recovery", async () => {
    const oldWorkspaceRead = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const oldGlobalRead = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const freshWorkspaceRead = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const freshGlobalRead = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const operationId = "10101010-1010-4010-8010-101010101010";
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-1", [buildTask])),
        oldWorkspaceRead.promise,
        freshWorkspaceRead.promise,
      ],
      globalReads: [
        success(globalLoaded("global-1", [])),
        oldGlobalRead.promise,
        freshGlobalRead.promise,
      ],
      moves: [{ kind: "unknown-outcome", message: "Connection lost" }],
      uuids: [operationId],
    });
    harness.controller.observe(true);
    await settle();

    const preBarrierRefresh = harness.controller.actions.refresh();
    await settle();
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(2);
    expect(harness.client.readGlobal).toHaveBeenCalledTimes(2);

    const moving = harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);
    await settle();
    expect(harness.controller.state.move).toEqual({
      kind: "unknown-outcome",
      message: "Connection lost",
      retryAllowed: false,
    });
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(3);
    expect(harness.client.readGlobal).toHaveBeenCalledTimes(3);

    oldWorkspaceRead.resolve(success(workspaceLoaded("workspace-1", [buildTask])));
    oldGlobalRead.resolve(success(globalLoaded("global-1", [])));
    await settle();
    expect(harness.controller.state.move).toEqual({
      kind: "unknown-outcome",
      message: "Connection lost",
      retryAllowed: false,
    });
    expect(harness.client.move).toHaveBeenCalledTimes(1);

    freshWorkspaceRead.resolve(success(workspaceLoaded("workspace-2", [])));
    freshGlobalRead.resolve(success(globalLoaded("global-2", [deployTask])));
    await Promise.all([preBarrierRefresh, moving]);
    expect(harness.controller.state.move).toBeUndefined();
  });

  it("uses a post-result dual-source barrier for a direct unknown outcome", async () => {
    const oldWorkspaceRead = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const oldGlobalRead = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const freshWorkspaceRead = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const freshGlobalRead = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const write = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-1", [buildTask])),
        oldWorkspaceRead.promise,
        freshWorkspaceRead.promise,
      ],
      globalReads: [
        success(globalLoaded("global-1", [])),
        oldGlobalRead.promise,
        freshGlobalRead.promise,
      ],
      workspaceReplacements: [write.promise],
    });
    harness.controller.observe(true);
    await settle();

    const preBarrierRefresh = harness.controller.actions.refresh();
    await settle();
    const saving = harness.controller.actions.create("workspace", deployTask);
    await settle();

    write.resolve({ kind: "unknown-outcome", message: "Write response lost" });
    await settle();
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(3);
    expect(harness.client.readGlobal).toHaveBeenCalledTimes(3);

    oldWorkspaceRead.resolve(success(workspaceLoaded("workspace-1", [buildTask])));
    oldGlobalRead.resolve(success(globalLoaded("global-1", [])));
    await settle();
    expect(harness.controller.state.mutationGate).toEqual({
      scopes: ["workspace"],
      message: "Write response lost",
    });
    expect(harness.client.replaceWorkspace).toHaveBeenCalledTimes(1);

    freshWorkspaceRead.resolve(success(workspaceLoaded("workspace-2", [buildTask, deployTask])));
    freshGlobalRead.resolve(success(globalLoaded("global-2", [])));
    await Promise.all([preBarrierRefresh, saving]);
    expect(harness.controller.state.mutationGate).toBeUndefined();
  });

  it("uses a post-result dual-source barrier for a direct invalid-catalog conflict", async () => {
    const oldWorkspaceRead = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const oldGlobalRead = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const freshWorkspaceRead = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const freshGlobalRead = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-1", [buildTask])),
        oldWorkspaceRead.promise,
        freshWorkspaceRead.promise,
      ],
      globalReads: [
        success(globalLoaded("global-1", [])),
        oldGlobalRead.promise,
        freshGlobalRead.promise,
      ],
      workspaceReplacements: [{
        kind: "conflict",
        reason: "invalid-catalog",
        message: "Workspace catalog is invalid",
      }],
    });
    harness.controller.observe(true);
    await settle();

    const preBarrierRefresh = harness.controller.actions.refresh();
    await settle();
    const saving = harness.controller.actions.create("workspace", deployTask);
    await settle();
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(3);
    expect(harness.client.readGlobal).toHaveBeenCalledTimes(3);

    oldWorkspaceRead.resolve(success(workspaceLoaded("workspace-1", [buildTask])));
    oldGlobalRead.resolve(success(globalLoaded("global-1", [])));
    await settle();
    expect(harness.controller.state.mutationGate).toEqual({
      scopes: ["workspace"],
      message: "Workspace catalog is invalid",
    });

    freshWorkspaceRead.resolve(success(workspaceLoaded("workspace-2", [buildTask])));
    freshGlobalRead.resolve(success(globalLoaded("global-2", [])));
    await Promise.all([preBarrierRefresh, saving]);
    expect(harness.controller.state.mutationGate).toBeUndefined();
  });

  it("replaces an in-flight recovery pair after a second direct unknown outcome", async () => {
    const firstRecoveryWorkspace = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const firstRecoveryGlobal = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const secondRecoveryWorkspace = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const secondRecoveryGlobal = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const workspaceWrite = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const globalWrite = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-1", [buildTask])),
        firstRecoveryWorkspace.promise,
        secondRecoveryWorkspace.promise,
      ],
      globalReads: [
        success(globalLoaded("global-1", [])),
        firstRecoveryGlobal.promise,
        secondRecoveryGlobal.promise,
      ],
      workspaceReplacements: [workspaceWrite.promise],
      globalReplacements: [globalWrite.promise],
    });
    harness.controller.observe(true);
    await settle();

    const workspaceSaving = harness.controller.actions.create("workspace", deployTask);
    const globalSaving = harness.controller.actions.create("global", buildTask);
    await settle();
    workspaceWrite.resolve({ kind: "unknown-outcome", message: "Workspace write response lost" });
    await settle();
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(2);
    expect(harness.client.readGlobal).toHaveBeenCalledTimes(2);

    globalWrite.resolve({ kind: "unknown-outcome", message: "Global write response lost" });
    await settle();
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(3);
    expect(harness.client.readGlobal).toHaveBeenCalledTimes(3);

    firstRecoveryWorkspace.resolve(success(workspaceLoaded("workspace-1", [buildTask])));
    firstRecoveryGlobal.resolve(success(globalLoaded("global-1", [])));
    secondRecoveryWorkspace.resolve(success(workspaceLoaded("workspace-2", [buildTask, deployTask])));
    secondRecoveryGlobal.resolve(success(globalLoaded("global-2", [buildTask])));
    await Promise.all([workspaceSaving, globalSaving]);
    expect(harness.controller.state.mutationGate).toBeUndefined();
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
      sourceGenerations: { workspace: 2, global: 2 },
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

  it.each([
    ["validation", { kind: "validation", message: "Task is invalid" }],
    ["unavailable", { kind: "unavailable", message: "Task service is unavailable", retryable: true }],
  ] as const)("publishes a nonblocking known move %s error that Refresh clears", async (kind, result) => {
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-1", [buildTask])),
        success(workspaceLoaded("workspace-3", [buildTask, extraTask])),
      ],
      globalReads: [
        success(globalLoaded("global-1", [])),
        success(globalLoaded("global-2", [])),
      ],
      workspaceReplacements: [success(workspaceLoaded("workspace-2", [buildTask, extraTask]))],
      moves: [result],
    });
    harness.controller.observe(true);
    await settle();

    await harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);

    expect(harness.controller.state.move).toBeUndefined();
    expect(harness.controller.state.mutationGate).toBeUndefined();
    expect(Reflect.get(harness.controller.state, "moveError")).toEqual({ kind, message: result.message });

    await harness.controller.actions.create("workspace", extraTask);
    expect(harness.client.replaceWorkspace).toHaveBeenCalledTimes(1);

    await harness.controller.actions.refresh();
    expect(Reflect.get(harness.controller.state, "moveError")).toBeUndefined();
  });

  it.each([
    ["validation", { kind: "validation", message: "Task is invalid" }],
    ["unavailable", { kind: "unavailable", message: "Task service is unavailable", retryable: true }],
  ] as const)("clears a known move %s error after its authoritative refresh completes", async (kind, result) => {
    const refreshedWorkspace = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const refreshedGlobal = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const harness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask])), refreshedWorkspace.promise],
      globalReads: [success(globalLoaded("global-1", [])), refreshedGlobal.promise],
      moves: [result],
    });
    harness.controller.observe(true);
    await settle();

    const initialWorkspaceGeneration = readSourceGeneration(harness.controller.state, "workspace");
    const initialGlobalGeneration = readSourceGeneration(harness.controller.state, "global");
    const refreshing = harness.controller.actions.refresh();
    await settle();

    await harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);
    expect(Reflect.get(harness.controller.state, "moveError")).toEqual({ kind, message: result.message });
    expect(harness.controller.state.move).toBeUndefined();
    expect(harness.controller.state.mutationGate).toBeUndefined();

    refreshedWorkspace.resolve(success(workspaceLoaded("workspace-2", [buildTask, extraTask])));
    refreshedGlobal.resolve(success(globalLoaded("global-2", [])));
    await refreshing;

    expect(Reflect.get(harness.controller.state, "moveError")).toBeUndefined();
    expect(harness.controller.state.move).toBeUndefined();
    expect(harness.controller.state.mutationGate).toBeUndefined();
    expect(readSourceGeneration(harness.controller.state, "workspace")).toBe(initialWorkspaceGeneration + 1);
    expect(readSourceGeneration(harness.controller.state, "global")).toBe(initialGlobalGeneration + 1);
  });

  it.each([
    ["validation", { kind: "validation", message: "First validation error" }, { kind: "validation", message: "Second validation error" }],
    ["unavailable", { kind: "unavailable", message: "First unavailable error", retryable: true }, { kind: "unavailable", message: "Second unavailable error", retryable: true }],
  ] as const)("keeps the newer known move %s error accepted during one refresh", async (kind, firstResult, secondResult) => {
    const refreshedWorkspace = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const refreshedGlobal = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const harness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask])), refreshedWorkspace.promise],
      globalReads: [success(globalLoaded("global-1", [])), refreshedGlobal.promise],
      moves: [firstResult, secondResult],
    });
    harness.controller.observe(true);
    await settle();

    const refreshing = harness.controller.actions.refresh();
    await settle();

    await harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);
    expect(Reflect.get(harness.controller.state, "moveError")).toEqual({ kind, message: firstResult.message });

    await harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);
    expect(Reflect.get(harness.controller.state, "moveError")).toEqual({ kind, message: secondResult.message });

    refreshedWorkspace.resolve(success(workspaceLoaded("workspace-2", [buildTask, extraTask])));
    refreshedGlobal.resolve(success(globalLoaded("global-2", [])));
    await refreshing;

    expect(Reflect.get(harness.controller.state, "moveError")).toEqual({ kind, message: secondResult.message });
  });

  it("keeps a known move error accepted after an authoritative refresh completes", async () => {
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-1", [buildTask])),
        success(workspaceLoaded("workspace-2", [extraTask])),
      ],
      globalReads: [
        success(globalLoaded("global-1", [])),
        success(globalLoaded("global-2", [])),
      ],
      moves: [{ kind: "validation", message: "Task is invalid" }],
    });
    harness.controller.observe(true);
    await settle();

    await harness.controller.actions.refresh();
    await harness.controller.actions.move({ scope: "workspace", id: "lint" }, deployTask);

    expect(Reflect.get(harness.controller.state, "moveError")).toEqual({
      kind: "validation",
      message: "Task is invalid",
    });
  });

  it("keeps a known move error when refresh cannot authoritatively load both sources", async () => {
    const refreshedWorkspace = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const refreshedGlobal = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const harness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask])), refreshedWorkspace.promise],
      globalReads: [success(globalLoaded("global-1", [])), refreshedGlobal.promise],
      moves: [{ kind: "validation", message: "Task is invalid" }],
    });
    harness.controller.observe(true);
    await settle();

    const refreshing = harness.controller.actions.refresh();
    await settle();
    await harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);
    expect(Reflect.get(harness.controller.state, "moveError")).toEqual({
      kind: "validation",
      message: "Task is invalid",
    });

    refreshedWorkspace.resolve(success(workspaceLoaded("workspace-2", [buildTask, extraTask])));
    refreshedGlobal.resolve(failure({ kind: "unavailable", message: "Global service is unavailable", retryable: true }));
    await refreshing;

    expect(Reflect.get(harness.controller.state, "moveError")).toEqual({
      kind: "validation",
      message: "Task is invalid",
    });
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
      sourceGenerations: { workspace: 2, global: 2 },
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
    const refreshedWorkspace = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const refreshedGlobal = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const harness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask])), refreshedWorkspace.promise],
      globalReads: [success(globalLoaded("global-1", [])), refreshedGlobal.promise],
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

    const moving = harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);
    await settle();
    expect(harness.controller.state.move).toEqual({
      kind: "partial",
      message: "Move is partially complete. Refresh before retrying.",
      retryAllowed: false,
    });
    expect(harness.client.move).toHaveBeenCalledTimes(1);

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
      workspaceReads: [
        success(workspaceLoaded("workspace-1", [buildTask])),
        success(workspaceLoaded("workspace-1", [buildTask])),
      ],
      globalReads: [
        success(globalLoaded("global-1", [])),
        success(globalLoaded("global-2", [deployTask])),
      ],
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
        success(workspaceLoaded("workspace-1", [buildTask])),
      ],
      globalReads: [
        success(globalLoaded("global-1", [])),
        success(globalLoaded("global-2", [deployTask])),
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
      sourceGenerations: { workspace: 2, global: 2 },
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

  it("refreshes an invalid-catalog move conflict before choosing a recovery state", async () => {
    const oldWorkspaceRead = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const oldGlobalRead = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const freshWorkspaceRead = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const freshGlobalRead = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const operationId = "13131313-1313-4313-8313-131313131313";
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-1", [buildTask])),
        oldWorkspaceRead.promise,
        freshWorkspaceRead.promise,
      ],
      globalReads: [
        success(globalLoaded("global-1", [])),
        oldGlobalRead.promise,
        freshGlobalRead.promise,
      ],
      moves: [{ kind: "conflict", reason: "invalid-catalog", message: "Catalog changed" }],
      uuids: [operationId],
    });
    harness.controller.observe(true);
    await settle();

    const preBarrierRefresh = harness.controller.actions.refresh();
    await settle();
    const moving = harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);
    await settle();

    expect(harness.client.move).toHaveBeenCalledTimes(1);
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(3);
    expect(harness.client.readGlobal).toHaveBeenCalledTimes(3);
    expect(harness.controller.state.move).toEqual({
      kind: "unknown-outcome",
      message: "Catalog changed",
      retryAllowed: false,
    });

    oldWorkspaceRead.resolve(success(workspaceLoaded("workspace-1", [buildTask])));
    oldGlobalRead.resolve(success(globalLoaded("global-1", [])));
    await settle();
    expect(harness.controller.state.move).toEqual({
      kind: "unknown-outcome",
      message: "Catalog changed",
      retryAllowed: false,
    });

    freshWorkspaceRead.resolve(success(workspaceLoaded("workspace-2", [])));
    freshGlobalRead.resolve(success(globalLoaded("global-2", [deployTask])));
    await Promise.all([preBarrierRefresh, moving]);
    expect(harness.controller.state.move).toBeUndefined();
    expect(harness.client.move).toHaveBeenCalledTimes(1);
  });

  it("does not expose a gate-free publication during lost-claim recovery", async () => {
    const refreshedWorkspace = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const refreshedGlobal = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    let observedGate = false;
    const harness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask])), refreshedWorkspace.promise],
      globalReads: [success(globalLoaded("global-1", [])), refreshedGlobal.promise],
      moves: [{ kind: "conflict", reason: "unowned-intermediate-state", message: "The move claim was lost" }],
      onChange: (state, controller) => {
        if (state.mutationGate !== undefined) {
          observedGate = true;
          return;
        }
        if (observedGate) void controller.actions.create("workspace", extraTask);
      },
    });
    harness.controller.observe(true);
    await settle();

    await harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);
    const refreshing = harness.controller.actions.refresh();
    await settle();
    refreshedWorkspace.resolve(success(workspaceLoaded("workspace-1", [buildTask])));
    refreshedGlobal.resolve(success(globalLoaded("global-2", [deployTask])));
    await refreshing;
    await settle();

    expect(observedGate).toBe(true);
    expect(harness.client.replaceWorkspace).toHaveBeenCalledTimes(0);
    expect(harness.controller.state.mutationGate).toEqual({
      scopes: ["workspace", "global"],
      message: "The move claim was lost",
    });
  });

  it.each(["workspace-first", "global-first"] as const)("keeps concurrent direct gates independent (%s)", async (first) => {
    const workspaceConflict = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const globalConflict = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-1", [buildTask])),
        success(workspaceLoaded("workspace-b-1", [])),
      ],
      globalReads: [success(globalLoaded("global-1", [deployTask]))],
      workspaceReplacements: [workspaceConflict.promise],
      globalReplacements: [globalConflict.promise],
    });
    harness.controller.observe(true);
    await settle();

    const workspaceWrite = harness.controller.actions.create("workspace", deployTask);
    const globalWrite = harness.controller.actions.create("global", buildTask);
    await settle();

    const resolveWorkspace = () => {
      workspaceConflict.resolve({
        kind: "conflict",
        reason: "revision-conflict",
        message: "Workspace changed",
      });
    };
    const resolveGlobal = () => {
      globalConflict.resolve({
        kind: "conflict",
        reason: "revision-conflict",
        message: "Global changed",
      });
    };
    if (first === "workspace-first") {
      resolveWorkspace();
      await settle();
      expect(harness.controller.state.mutationGate).toEqual({
        scopes: ["workspace"],
        message: "Workspace changed",
      });
      resolveGlobal();
    } else {
      resolveGlobal();
      await settle();
      expect(harness.controller.state.mutationGate).toEqual({
        scopes: ["global"],
        message: "Global changed",
      });
      resolveWorkspace();
    }
    await Promise.all([workspaceWrite, globalWrite]);
    expect(harness.controller.state.mutationGate).toEqual({
      scopes: ["workspace", "global"],
      message: "Workspace changed Global changed",
    });

    await harness.controller.actions.create("workspace", extraTask);
    await harness.controller.actions.create("global", extraTask);
    expect(harness.client.replaceWorkspace).toHaveBeenCalledTimes(1);
    expect(harness.client.replaceGlobal).toHaveBeenCalledTimes(1);

    harness.setSelection(workspaceB);
    harness.controller.observe(true);
    await settle();
    expect(harness.controller.state.mutationGate).toEqual({
      scopes: ["global"],
      message: "Global changed",
    });
  });

  it("clears only the source whose keyed gate has a successful refresh", async () => {
    const workspaceConflict = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const globalConflict = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const workspaceRefresh = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const globalRefresh = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const harness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask])), workspaceRefresh.promise],
      globalReads: [success(globalLoaded("global-1", [deployTask])), globalRefresh.promise],
      workspaceReplacements: [workspaceConflict.promise, success(workspaceLoaded("workspace-2", [buildTask, extraTask]))],
      globalReplacements: [globalConflict.promise],
    });
    harness.controller.observe(true);
    await settle();

    const workspaceWrite = harness.controller.actions.create("workspace", extraTask);
    const globalWrite = harness.controller.actions.create("global", buildTask);
    await settle();
    workspaceConflict.resolve({ kind: "conflict", reason: "revision-conflict", message: "Workspace changed" });
    globalConflict.resolve({ kind: "conflict", reason: "revision-conflict", message: "Global changed" });
    await Promise.all([workspaceWrite, globalWrite]);
    expect(harness.controller.state.mutationGate).toEqual({
      scopes: ["workspace", "global"],
      message: "Workspace changed Global changed",
    });

    const refreshing = harness.controller.actions.refresh();
    await settle();
    workspaceRefresh.resolve(success(workspaceLoaded("workspace-2", [buildTask, extraTask])));
    globalRefresh.resolve(failure({ kind: "unavailable", message: "Global refresh failed", retryable: true }));
    await refreshing;

    expect(harness.controller.state.mutationGate).toEqual({
      scopes: ["global"],
      message: "Global changed",
    });
    await harness.controller.actions.create("workspace", deployTask);
    await harness.controller.actions.create("global", extraTask);
    expect(harness.client.replaceWorkspace).toHaveBeenCalledTimes(2);
    expect(harness.client.replaceGlobal).toHaveBeenCalledTimes(1);
  });

  it("keeps loaded catalogs actionable for direct validation and unavailable results", async () => {
    const cases: readonly [WorkspaceTaskScopeFixture, WorkspaceTasksFailureResponse][] = [
      ["workspace", { kind: "validation", message: "Workspace task is invalid" }],
      ["workspace", { kind: "unavailable", message: "Workspace write unavailable", retryable: true }],
      ["global", { kind: "validation", message: "Global task is invalid" }],
      ["global", { kind: "unavailable", message: "Global write unavailable", retryable: true }],
    ];

    for (const [scope, result] of cases) {
      const options: HarnessOptions = {
        workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask]))],
        globalReads: [success(globalLoaded("global-1", [deployTask]))],
      };
      if (scope === "workspace") options.workspaceReplacements = [failure(result)];
      else options.globalReplacements = [failure(result)];
      const harness = createHarness(options);
      harness.controller.observe(true);
      await settle();

      await harness.controller.actions.create(scope, extraTask);

      const source = scope === "workspace" ? harness.controller.state.workspace : harness.controller.state.global;
      expect(source).toMatchObject({
        kind: "loaded",
        config: scope === "workspace" ? config([buildTask]) : config([deployTask]),
        refreshing: false,
        refreshError: result.message,
      });
      expect(harness.controller.state.mutationGate).toBeUndefined();
      expect(harness.controller.state.move).toBeUndefined();
    }
  });

  it("preserves a newer catalog while a delayed direct write is causally reconciled", async () => {
    const write = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const newerWorkspace = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const newerGlobal = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const reconciledWorkspace = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const reconciledGlobal = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-1", [buildTask])),
        newerWorkspace.promise,
        reconciledWorkspace.promise,
      ],
      globalReads: [
        success(globalLoaded("global-1", [deployTask])),
        newerGlobal.promise,
        reconciledGlobal.promise,
      ],
      workspaceReplacements: [write.promise],
    });
    harness.controller.observe(true);
    await settle();

    const saving = harness.controller.actions.create("workspace", deployTask);
    const refreshing = harness.controller.actions.refresh();
    await settle();
    newerWorkspace.resolve(success(workspaceLoaded("workspace-newer", [buildTask, extraTask])));
    newerGlobal.resolve(success(globalLoaded("global-newer", [deployTask])));
    await refreshing;

    write.resolve(success(workspaceLoaded("workspace-write", [buildTask, deployTask])));
    await settle();
    expect(harness.controller.state.workspace).toEqual({
      kind: "loaded",
      config: config([buildTask, extraTask]),
      refreshing: true,
    });
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(3);
    expect(harness.client.readGlobal).toHaveBeenCalledTimes(3);

    reconciledWorkspace.resolve(success(workspaceLoaded("workspace-reconciled", [buildTask, extraTask, deployTask])));
    reconciledGlobal.resolve(success(globalLoaded("global-reconciled", [deployTask])));
    await saving;
    expect(harness.controller.state.workspace).toEqual({
      kind: "loaded",
      config: config([buildTask, extraTask, deployTask]),
      refreshing: false,
    });
  });

  it.each(["write-first", "refresh-first"] as const)("keeps delayed direct writes keyed across selection changes (%s)", async (order) => {
    const write = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const newerWorkspace = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const newerGlobal = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const reconciledWorkspace = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const reconciledGlobal = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-a-1", [buildTask])),
        success(workspaceLoaded("workspace-b-1", [])),
        newerWorkspace.promise,
        reconciledWorkspace.promise,
      ],
      globalReads: [
        success(globalLoaded("global-1", [deployTask])),
        newerGlobal.promise,
        reconciledGlobal.promise,
      ],
      workspaceReplacements: [write.promise],
    });
    harness.controller.observe(true);
    await settle();

    const saving = harness.controller.actions.create("workspace", deployTask);
    await settle();
    harness.setSelection(workspaceB);
    harness.controller.observe(true);
    await settle();

    if (order === "write-first") {
      write.resolve(success(workspaceLoaded("workspace-a-2", [buildTask, deployTask])));
      await saving;
      harness.setSelection(workspaceA);
      harness.controller.observe(true);
      await settle();
      expect(harness.controller.state.workspace).toEqual({
        kind: "loaded",
        config: config([buildTask, deployTask]),
        refreshing: false,
      });
      return;
    }

    harness.setSelection(workspaceA);
    harness.controller.observe(true);
    const refreshing = harness.controller.actions.refresh();
    await settle();
    newerWorkspace.resolve(success(workspaceLoaded("workspace-a-newer", [buildTask, extraTask])));
    newerGlobal.resolve(success(globalLoaded("global-newer", [deployTask])));
    await refreshing;

    write.resolve(success(workspaceLoaded("workspace-a-write", [buildTask, deployTask])));
    await settle();
    expect(harness.controller.state.workspace).toEqual({
      kind: "loaded",
      config: config([buildTask, extraTask]),
      refreshing: true,
    });
    reconciledWorkspace.resolve(success(workspaceLoaded("workspace-a-reconciled", [buildTask, extraTask, deployTask])));
    reconciledGlobal.resolve(success(globalLoaded("global-reconciled", [deployTask])));
    await saving;
    expect(harness.controller.state.workspace).toEqual({
      kind: "loaded",
      config: config([buildTask, extraTask, deployTask]),
      refreshing: false,
    });
  });

  it("reconciles an inactive direct unknown outcome when its dirty cache is selected again", async () => {
    const write = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const reenteredWorkspace = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const reenteredGlobal = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const harness = createHarness({
      workspaceReads: [
        success(workspaceLoaded("workspace-a-1", [buildTask])),
        success(workspaceLoaded("workspace-b-1", [])),
        reenteredWorkspace.promise,
      ],
      globalReads: [success(globalLoaded("global-1", [deployTask])), reenteredGlobal.promise],
      workspaceReplacements: [write.promise],
    });
    harness.controller.observe(true);
    await settle();

    const saving = harness.controller.actions.create("workspace", deployTask);
    harness.setSelection(workspaceB);
    harness.controller.observe(true);
    await settle();
    write.resolve({ kind: "unknown-outcome", message: "Workspace write response lost" });
    await saving;
    expect(harness.controller.state.mutationGate).toBeUndefined();

    harness.setSelection(workspaceA);
    harness.controller.observe(true);
    await settle();
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(3);
    expect(harness.client.readGlobal).toHaveBeenCalledTimes(2);
    reenteredWorkspace.resolve(success(workspaceLoaded("workspace-a-2", [buildTask, deployTask])));
    await settle();
    expect(harness.controller.state.mutationGate).toEqual({
      scopes: ["workspace"],
      message: "Workspace write response lost",
    });
    reenteredGlobal.resolve(success(globalLoaded("global-2", [deployTask])));
    await settle();
    expect(harness.controller.state.workspace).toEqual({
      kind: "loaded",
      config: config([buildTask, deployTask]),
      refreshing: false,
    });
    expect(harness.controller.state.mutationGate).toBeUndefined();
  });

  it("keeps both CRUD scopes gated while a partial move is retryable", async () => {
    const operationId = "15151515-1515-4515-8515-151515151515";
    let attemptedSynchronousCrud = false;
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
          kind: "completed",
          operationId,
          workspace: workspaceLoaded("workspace-2", []),
          global: globalLoaded("global-2", [deployTask]),
        },
      ],
      uuids: [operationId],
      onChange: (state, controller) => {
        if (attemptedSynchronousCrud || state.move?.kind !== "partial" || !state.move.retryAllowed) return;
        attemptedSynchronousCrud = true;
        void controller.actions.create("workspace", extraTask);
      },
    });
    harness.controller.observe(true);
    await settle();

    await harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);
    await settle();

    expect(attemptedSynchronousCrud).toBe(true);
    expect(harness.controller.state.move).toEqual({
      kind: "partial",
      message: "Move is partially complete. Refresh before retrying.",
      retryAllowed: true,
    });
    expect(harness.controller.state.mutationGate).toEqual({
      scopes: ["workspace", "global"],
      message: "Move is partially complete. Refresh before retrying.",
    });
    expect(harness.client.replaceWorkspace).not.toHaveBeenCalled();
    expect(harness.client.replaceGlobal).not.toHaveBeenCalled();

    await harness.controller.actions.create("workspace", extraTask);
    await harness.controller.actions.update({ scope: "workspace", id: "build" }, editedBuildTask);
    await harness.controller.actions.remove({ scope: "workspace", id: "build" });
    await harness.controller.actions.create("global", extraTask);
    await harness.controller.actions.update({ scope: "global", id: "deploy" }, { ...deployTask, title: "Deploy release" });
    await harness.controller.actions.remove({ scope: "global", id: "deploy" });
    await harness.controller.actions.move({ scope: "workspace", id: "build" }, extraTask);

    expect(harness.client.replaceWorkspace).not.toHaveBeenCalled();
    expect(harness.client.replaceGlobal).not.toHaveBeenCalled();
    expect(harness.client.move).toHaveBeenCalledTimes(1);

    await harness.controller.actions.retryMove();

    expect(harness.client.move.mock.calls.map(([input]) => ({ operationId: input.operationId, intent: input.intent }))).toEqual([
      { operationId, intent: "start" },
      { operationId, intent: "retry" },
    ]);
    expect(harness.controller.state.move).toBeUndefined();
    expect(harness.controller.state.mutationGate).toBeUndefined();
  });

  it.each([
    ["workspace", "validation", { kind: "validation", message: "Workspace task is invalid" }],
    ["workspace", "unavailable", { kind: "unavailable", message: "Workspace write unavailable", retryable: true }],
    ["global", "validation", { kind: "validation", message: "Global task is invalid" }],
    ["global", "unavailable", { kind: "unavailable", message: "Global write unavailable", retryable: true }],
  ] as const)("publishes a newer active %s catalog error after a delayed %s result", async (scope, _kind, result) => {
    const workspaceWrite = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const globalWrite = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const newerWorkspace = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const newerGlobal = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const options: HarnessOptions = {
      workspaceReads: [
        success(workspaceLoaded("workspace-1", [buildTask])),
        newerWorkspace.promise,
      ],
      globalReads: [
        success(globalLoaded("global-1", [deployTask])),
        newerGlobal.promise,
      ],
    };
    if (scope === "workspace") options.workspaceReplacements = [workspaceWrite.promise];
    else options.globalReplacements = [globalWrite.promise];
    const harness = createHarness(options);
    harness.controller.observe(true);
    await settle();

    const saving = harness.controller.actions.create(scope, extraTask);
    await settle();
    const refreshing = harness.controller.actions.refresh();
    await settle();
    newerWorkspace.resolve(success(workspaceLoaded("workspace-newer", [editedBuildTask])));
    newerGlobal.resolve(success(globalLoaded("global-newer", [deployTask, buildTask])));
    await refreshing;
    const publicationsBeforeResult = harness.published.length;

    if (scope === "workspace") workspaceWrite.resolve(failure(result));
    else globalWrite.resolve(failure(result));
    await saving;

    const source = scope === "workspace" ? harness.controller.state.workspace : harness.controller.state.global;
    expect(source).toEqual({
      kind: "loaded",
      config: scope === "workspace" ? config([editedBuildTask]) : config([deployTask, buildTask]),
      refreshing: false,
      refreshError: result.message,
    });
    expect(harness.published).toHaveLength(publicationsBeforeResult + 1);
    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(2);
    expect(harness.client.readGlobal).toHaveBeenCalledTimes(2);
    expect(harness.controller.state.mutationGate).toBeUndefined();
    expect(harness.controller.state.move).toBeUndefined();
  });

  it.each([
    ["workspace", "validation", { kind: "validation", message: "Workspace task is invalid" }],
    ["workspace", "unavailable", { kind: "unavailable", message: "Workspace write unavailable", retryable: true }],
    ["global", "validation", { kind: "validation", message: "Global task is invalid" }],
    ["global", "unavailable", { kind: "unavailable", message: "Global write unavailable", retryable: true }],
  ] as const)("retains a delayed %s %s result on its inactive keyed cache", async (scope, _kind, result) => {
    const workspaceWrite = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const globalWrite = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const newerWorkspace = deferred<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>();
    const newerGlobal = deferred<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>();
    const inactiveSelection = scope === "workspace" ? workspaceB : remoteWorkspace;
    const options: HarnessOptions = {
      workspaceReads: [
        success(workspaceLoaded("workspace-a-1", [buildTask])),
        newerWorkspace.promise,
        success(workspaceLoaded(scope === "workspace" ? "workspace-b-1" : "workspace-remote-1", [extraTask])),
      ],
      globalReads: [
        success(globalLoaded("global-a-1", [deployTask])),
        newerGlobal.promise,
        ...(scope === "workspace" ? [] : [success(globalLoaded("global-remote-1", [extraTask]))]),
      ],
    };
    if (scope === "workspace") options.workspaceReplacements = [workspaceWrite.promise];
    else options.globalReplacements = [globalWrite.promise];
    const harness = createHarness(options);
    harness.controller.observe(true);
    await settle();

    const saving = harness.controller.actions.create(scope, extraTask);
    await settle();
    const refreshing = harness.controller.actions.refresh();
    await settle();
    newerWorkspace.resolve(success(workspaceLoaded("workspace-a-newer", [editedBuildTask])));
    newerGlobal.resolve(success(globalLoaded("global-a-newer", [deployTask, buildTask])));
    await refreshing;

    harness.setSelection(inactiveSelection);
    harness.controller.observe(true);
    await settle();
    const publicationsBeforeResult = harness.published.length;
    if (scope === "workspace") workspaceWrite.resolve(failure(result));
    else globalWrite.resolve(failure(result));
    await saving;

    const activeSource = scope === "workspace" ? harness.controller.state.workspace : harness.controller.state.global;
    expect(activeSource).toEqual({
      kind: "loaded",
      config: config([extraTask]),
      refreshing: false,
    });
    expect(harness.published).toHaveLength(publicationsBeforeResult);

    const workspaceReadCount = harness.client.readWorkspace.mock.calls.length;
    const globalReadCount = harness.client.readGlobal.mock.calls.length;
    harness.setSelection(workspaceA);
    harness.controller.observe(true);
    await settle();

    expect(harness.client.readWorkspace).toHaveBeenCalledTimes(workspaceReadCount);
    expect(harness.client.readGlobal).toHaveBeenCalledTimes(globalReadCount);
    const source = scope === "workspace" ? harness.controller.state.workspace : harness.controller.state.global;
    expect(source).toEqual({
      kind: "loaded",
      config: scope === "workspace" ? config([editedBuildTask]) : config([deployTask, buildTask]),
      refreshing: false,
      refreshError: result.message,
    });
    expect(harness.controller.state.mutationGate).toBeUndefined();
    expect(harness.controller.state.move).toBeUndefined();
  });

  it("keeps public catalog snapshots isolated from later CAS and move inputs", async () => {
    const operationId = "14141414-1414-4414-8414-141414141414";
    const harness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask]))],
      globalReads: [success(globalLoaded("global-1", []))],
      workspaceReplacements: [success(workspaceLoaded("workspace-2", [buildTask, extraTask]))],
      moves: [{
        kind: "completed",
        operationId,
        workspace: workspaceLoaded("workspace-3", [extraTask]),
        global: globalLoaded("global-2", [deployTask]),
      }],
      uuids: [operationId],
    });
    harness.controller.observe(true);
    await settle();

    const snapshot = harness.controller.state;
    const workspace = snapshot.workspace;
    if (workspace.kind !== "loaded") throw new Error("Expected a loaded workspace snapshot");
    const task = workspace.config.tasks[0];
    if (task === undefined) throw new Error("Expected a task in the workspace snapshot");
    expect(Reflect.set(snapshot, "workspace", { kind: "loading" })).toBe(false);
    expect(Reflect.set(workspace.config, "tasks", [])).toBe(false);
    expect(Reflect.set(task, "title", "Tampered build")).toBe(false);

    await harness.controller.actions.create("workspace", extraTask);
    expect(harness.client.replaceWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: "workspace-1",
      config: config([buildTask, extraTask]),
    }));

    await harness.controller.actions.move({ scope: "workspace", id: "build" }, deployTask);
    expect(harness.client.move).toHaveBeenCalledWith(expect.objectContaining({
      source: {
        ref: { scope: "workspace", id: "build" },
        expectedCatalog: { kind: "loaded", revision: "workspace-2", config: config([buildTask, extraTask]) },
      },
      destination: {
        scope: "global",
        expectedCatalog: { kind: "loaded", revision: "global-1", config: config([]) },
        task: deployTask,
      },
    }));
  });

  it("keeps immutable mutation-gate scopes from reopening a blocked source", async () => {
    const harness = createHarness({
      workspaceReads: [success(workspaceLoaded("workspace-1", [buildTask]))],
      globalReads: [success(globalLoaded("global-1", [deployTask]))],
      workspaceReplacements: [failure({ kind: "conflict", reason: "revision-conflict", message: "Workspace changed" })],
    });
    harness.controller.observe(true);
    await settle();
    await harness.controller.actions.create("workspace", extraTask);

    const gate = harness.controller.state.mutationGate;
    if (gate === undefined) throw new Error("Expected a mutation gate");
    expect(Reflect.set(gate, "scopes", [])).toBe(false);
    expect(Reflect.set(gate.scopes, 0, "global")).toBe(false);

    await harness.controller.actions.create("workspace", deployTask);
    expect(harness.client.replaceWorkspace).toHaveBeenCalledTimes(1);
    expect(harness.controller.state.mutationGate).toEqual({
      scopes: ["workspace"],
      message: "Workspace changed",
    });
  });
});

type WorkspaceTaskScopeFixture = "workspace" | "global";

interface HarnessOptions {
  initialSelection?: WorkspaceTasksSelection;
  workspaceReads?: Pending<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>[];
  globalReads?: Pending<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>[];
  workspaceReplacements?: Pending<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>[];
  globalReplacements?: Pending<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>[];
  moves?: Pending<MoveWorkspaceTaskResult | WorkspaceTasksFailureResponse>[];
  uuids?: string[];
  onChange?: (state: WorkspaceTasksWorkspaceState, controller: WorkspaceTasksController) => void;
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
    onChange: (state) => {
      published.push(state);
      options.onChange?.(state, controller);
    },
  };
  const controller = new WorkspaceTasksController(dependencies);

  return {
    client,
    controller,
    published,
    setSelection: (nextSelection: WorkspaceTasksSelection) => { selected = nextSelection; },
  };
}

function readSourceGeneration(state: WorkspaceTasksWorkspaceState, scope: "workspace" | "global"): number {
  const generation = state.sourceGenerations?.[scope];
  if (generation === undefined) throw new Error(`Expected ${scope} source generation.`);
  return generation;
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
