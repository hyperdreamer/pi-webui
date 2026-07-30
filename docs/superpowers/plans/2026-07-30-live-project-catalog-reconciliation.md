# Live Project Catalog Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent-created worktrees and their spawned sessions appear in the selected project's sidebar without a browser refresh, while reconciling idle external worktrees with a bounded selected-project poll.

**Architecture:** Add a serial, scope-safe `ProjectCatalogController` that polls only the selected project and accepts explicit refresh requests. Route both its snapshots and existing unknown-active-CWD topology discoveries through one `WorkspaceController` reconciliation seam that updates visible and cached workspaces atomically, then hydrates sessions only for newly discovered workspaces.

**Tech Stack:** TypeScript 6, Lit 3, Vitest 4, existing browser `workspacesApi` / `sessionsApi`, existing `ActivityController`, `ProjectActivityOwnershipCoordinator`, and `WorkspaceController`.

## Global Constraints

- Scope identity is exactly selected `machineId`, `projectId`, and project path; stale results for any changed field must be ignored.
- Use a serial `setTimeout` scheduler at `5_000` ms; never use `setInterval` or overlapping catalog requests.
- Retain foreground project/workspace selection behavior; a newly discovered workspace/session must never become selected automatically.
- Apply every background workspace snapshot through one reconciliation seam that updates both `workspaces` and `workspacesByProjectId` together.
- Fetch session lists only for newly discovered or previously unhydrated workspaces; do not poll every session status.
- Preserve the existing known-workspace `session.created` fast path and existing realtime status/activity maps.
- Background failures retain the last successful catalog, report through `console.warn`/the injected background-error seam, and do not overwrite `AppState.error`.
- Do not modify `src/server/sessiond.ts`, session ownership, daemon protocol, server-side watchers, or the README.
- Add a patch Changeset; do not edit `CHANGELOG.md`.
- This implementation is client/UI-side only and does not require a manual `pi-webui-sessiond.service` restart.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/client/src/controllers/projectCatalogController.ts` | Deep module for selected-project scope, serial timer scheduling, stale-result suppression, immediate refresh, and background-error reporting. |
| `src/client/src/controllers/projectCatalogController.test.ts` | Deterministic tests for controller scope, timers, trailing refreshes, stale requests, and errors. |
| `src/client/src/controllers/workspaceController.ts` | Single workspace-snapshot application seam; updates visible/cache projections, hydrates added workspaces’ session rows, and handles selected-workspace removal. |
| `src/client/src/controllers/workspaceController.test.ts` | Tests snapshot projection, addition-only session hydration, the session/status ordering regression, selection preservation, and removal fallback. |
| `src/client/src/controllers/projectActivityOwnershipCoordinator.ts` | Emits validated active-CWD workspace snapshots through an injected callback instead of owning a cache-only state mutation. |
| `src/client/src/controllers/projectActivityOwnershipCoordinator.test.ts` | Tests callback routing, awaiting callback completion, stale safeguards, and fallback compatibility. |
| `src/client/src/components/PiWebUiApp.ts` | Constructs/wires the controller, starts/stops observation, routes reconnect refreshes, and supplies the shared snapshot callback. |
| `src/client/src/components/PiWebUiApp.projectCatalog.test.ts` | Tests app lifecycle wiring for observation, reconnect refresh, and disconnect cleanup. |
| `.changeset/live-project-catalog-reconciliation.md` | Patch release note for the user-visible sidebar refresh behavior. |

No changes are required in `WorkspaceList.ts` or `SessionList.ts`: both already render reactive state supplied by `PiWebUiApp`. The regression is catalog state propagation, not Lit rendering markup.

---

### Task 1: Add the selected-project catalog polling module

**Files:**
- Create: `src/client/src/controllers/projectCatalogController.ts`
- Create: `src/client/src/controllers/projectCatalogController.test.ts`

**Interfaces:**
- Consumes: `AppState`, `Project`, `Workspace`, `GetState`, `selectedMachineId`, `workspacesApi.workspaces`.
- Produces:

```ts
export interface ProjectCatalogSnapshot {
  machineId: string;
  project: Project;
  workspaces: Workspace[];
}

export interface ProjectCatalogTimer {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
}

export interface ProjectCatalogControllerDependencies {
  workspaces?: (projectId: string, machineId: string) => Promise<Workspace[]>;
  applySnapshot: (snapshot: ProjectCatalogSnapshot) => Promise<void> | void;
  timer?: ProjectCatalogTimer;
  pollIntervalMs?: number;
  onBackgroundError?: (operation: string, error: unknown) => void;
}

export class ProjectCatalogController {
  updatePolling(observed?: boolean): void;
  refresh(): Promise<void>;
  dispose(): void;
}
```

`updatePolling()` begins or retargets observation. A newly selected project with `isLoadingWorkspaces === false` is seeded by the foreground selection result and receives its first **timer**, not a duplicate immediate workspace request. `refresh()` is the explicit immediate path used after realtime reconnects. Both methods reuse the same in-flight request for the same scope.

- [ ] **Step 1: Write failing timer and scope tests**

Create `projectCatalogController.test.ts` with a controllable timer and a state harness. Start with these scenarios:

```ts
it("uses the foreground project snapshot as a seed and schedules one fallback poll", () => {
  const timers = fakeTimers();
  const workspaces = vi.fn<(projectId: string, machineId: string) => Promise<Workspace[]>>();
  const applySnapshot = vi.fn<(snapshot: ProjectCatalogSnapshot) => void>();
  const harness = controllerFor({ workspaces, applySnapshot, timers });

  harness.controller.updatePolling();

  expect(workspaces).not.toHaveBeenCalled();
  expect(timers.delays).toEqual([5_000]);
});

it("refreshes immediately and schedules the next poll only after the request settles", async () => {
  const timers = fakeTimers();
  const response = deferred<Workspace[]>();
  const workspaces = vi.fn(() => response.promise);
  const applySnapshot = vi.fn();
  const harness = controllerFor({ workspaces, applySnapshot, timers });
  harness.controller.updatePolling();

  const refreshing = harness.controller.refresh();
  expect(workspaces).toHaveBeenCalledOnce();
  expect(timers.pendingCallbacks()).toHaveLength(0);

  response.resolve([featureWorkspace]);
  await refreshing;

  expect(applySnapshot).toHaveBeenCalledWith({
    machineId: "local",
    project,
    workspaces: [featureWorkspace],
  });
  expect(timers.delays).toEqual([5_000, 5_000]);
});

it("serializes a changed-scope refresh behind the stale in-flight request", async () => {
  const first = deferred<Workspace[]>();
  const second = deferred<Workspace[]>();
  const workspaces = vi.fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const applySnapshot = vi.fn();
  const harness = controllerFor({ workspaces, applySnapshot, timers: fakeTimers() });
  harness.controller.updatePolling();

  const staleRefresh = harness.controller.refresh();
  harness.apply({ selectedProject: otherProject, isLoadingWorkspaces: false });
  harness.controller.updatePolling();
  const currentRefresh = harness.controller.refresh();

  expect(workspaces).toHaveBeenCalledOnce();
  first.resolve([mainWorkspace]);
  await Promise.resolve();
  expect(workspaces).toHaveBeenCalledTimes(2);

  second.resolve([otherWorkspace]);
  await Promise.all([staleRefresh, currentRefresh]);

  expect(applySnapshot).toHaveBeenCalledTimes(1);
  expect(applySnapshot).toHaveBeenCalledWith({
    machineId: "local",
    project: otherProject,
    workspaces: [otherWorkspace],
  });
});
```

Also cover: a same-scope `refresh()` while in flight returns the existing promise; a changed-scope `refresh()` queues one trailing immediate request rather than overlapping the stale request; `dispose()` clears the timer; a background fetch error calls `onBackgroundError("reconcile selected project catalog", error)` and schedules a retry; and a scope with `isLoadingWorkspaces === true` has no timer/request.

- [ ] **Step 2: Run the new test file to verify failure**

Run:

```bash
npm test -- --run src/client/src/controllers/projectCatalogController.test.ts
```

Expected: FAIL because `projectCatalogController.ts` does not exist.

- [ ] **Step 3: Implement `ProjectCatalogController`**

Create the controller using the `MemoryController` serial-polling pattern, adapted for a project scope:

```ts
const DEFAULT_PROJECT_CATALOG_POLL_INTERVAL_MS = 5_000;

interface ProjectCatalogScope {
  key: string;
  machineId: string;
  project: Project;
}

private currentScope(): ProjectCatalogScope | undefined {
  const state = this.getState();
  const project = state.selectedProject;
  if (project === undefined || state.isLoadingWorkspaces) return undefined;
  const machineId = selectedMachineId(state);
  return {
    key: JSON.stringify([machineId, project.id, project.path]),
    machineId,
    project,
  };
}
```

Implement these invariants:

- Maintain one physical `inFlight` request for the controller instance plus a generation-tagged `queuedImmediateRefresh` record (including a shared promise for callers). Never discard the physical in-flight record merely because the selected scope changes: its result may become stale, but it still serializes the next request.
- `updatePolling(true)` stores a new valid scope and invalidates the prior generation/timer when the scope changes. If no request is in flight, it schedules that scope's first timer without fetching; otherwise it lets the in-flight request's `finally` schedule the current scope after it settles.
- `refresh()` clears a pending timer. It returns the matching in-flight promise for the same scope; if another scope is physically in flight, it creates/reuses one trailing immediate-refresh promise for the current generation rather than issuing an overlapping request.
- `startRequest()` registers the in-flight record before calling async work so synchronously thrown collaborators cannot leave an untracked request. It may only start when no physical request is in flight.
- The load path calls the injected workspace listing function, checks `isCurrent(scope, generation)`, then awaits `applySnapshot({ machineId, project, workspaces })`.
- In `finally`, clear only the matching physical request. If a queued immediate refresh still matches the observed current scope/generation, start it exactly once; otherwise schedule exactly one next timer when a valid scope remains observed. Resolve all queued callers after that trailing request settles.
- `dispose()` marks observation false, clears the timer, invalidates scope/generation and queued refreshes, but permits an already-started request to settle and clear itself without applying its stale result.

- [ ] **Step 4: Run the focused controller tests**

Run:

```bash
npm test -- --run src/client/src/controllers/projectCatalogController.test.ts
```

Expected: PASS with deterministic timer, stale-result, error, and disposal coverage.

- [ ] **Step 5: Commit the standalone module**

```bash
git add src/client/src/controllers/projectCatalogController.ts \
  src/client/src/controllers/projectCatalogController.test.ts
git commit -m "feat: add selected project catalog reconciler"
```

---

### Task 2: Make `WorkspaceController` the common snapshot-application seam

**Files:**
- Modify: `src/client/src/controllers/workspaceController.ts:9-122`
- Modify: `src/client/src/controllers/workspaceController.test.ts:1-109`

**Interfaces:**
- Consumes: `ProjectCatalogSnapshot` from Task 1, `sessionsApi.sessions`, `mergeCachedNewSessions`, `SessionController`’s existing selection methods.
- Produces:

```ts
async reconcileProjectCatalog(snapshot: ProjectCatalogSnapshot): Promise<void>
```

Extend `WorkspaceControllerDependencies` with:

```ts
onBackgroundError?: (operation: string, error: unknown) => void;
```

This is the only background path that may apply a workspace topology snapshot. It retains existing foreground `selectProject()` behavior while using the same projection helper.

- [ ] **Step 1: Write failing workspace/catalog regression tests**

Extend `workspaceController.test.ts` with fixtures for `mainWorkspace`, `featureWorkspace`, `parentSession`, and `spawnedSession`.

Write a snapshot-projection test:

```ts
it("applies a selected-project topology snapshot to both workspace projections and hydrates only added workspaces", async () => {
  const listSessions = vi.fn((cwd: string) => Promise.resolve(cwd === featureWorkspace.path ? [spawnedSession] : []));
  const harness = controllerForCatalog({
    selectedProject: project,
    selectedWorkspace: mainWorkspace,
    workspaces: [mainWorkspace],
    workspacesByProjectId: { [project.id]: [mainWorkspace] },
    projectSessions: [parentSession],
    listSessions,
  });

  await harness.controller.reconcileProjectCatalog({
    machineId: "local",
    project,
    workspaces: [mainWorkspace, featureWorkspace],
  });

  expect(harness.state.workspaces).toEqual([mainWorkspace, featureWorkspace]);
  expect(harness.state.workspacesByProjectId[project.id]).toEqual([mainWorkspace, featureWorkspace]);
  expect(listSessions).toHaveBeenCalledTimes(1);
  expect(listSessions).toHaveBeenCalledWith(featureWorkspace.path, "local");
  expect(harness.state.projectSessions).toEqual(expect.arrayContaining([parentSession, spawnedSession]));
  expect(harness.state.selectedWorkspace).toEqual(mainWorkspace);
});
```

Write the reported ordering regression using a real `SessionController` and its test socket:

```ts
it("renders activity after a session event preceded discovery of its worktree", async () => {
  const { controller, sessionController, state } = catalogHarnessWithLiveSessionController({
    workspaces: [mainWorkspace],
    projectSessions: [parentSession],
  });

  sessionController.applyGlobalEvent({ type: "session.created", session: spawnedSession });
  sessionController.applyGlobalEvent({
    type: "activity.update",
    activity: { sessionId: spawnedSession.id, phase: "active", label: "prompt accepted", at: "now" },
  });
  sessionController.flushPendingUpdates();

  expect(state.projectSessions).not.toContainEqual(spawnedSession);

  await controller.reconcileProjectCatalog({
    machineId: "local",
    project,
    workspaces: [mainWorkspace, featureWorkspace],
  });

  const indicators = sessionActivityIndicators(spawnedSession, state.projectSessions, {
    statuses: state.sessionStatuses,
    activities: state.sessionActivities,
  });
  expect(indicators).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "session", label: "This session is working" }),
  ]));
});
```

Add removal coverage: when a selected workspace is absent from a snapshot, the controller chooses the existing main/first fallback or clears selection when no workspace remains. Add a non-selected-project snapshot test proving it updates only `workspacesByProjectId` and does not disturb selected-project UI state. Add a failed session-list test proving the workspace remains visible, `AppState.error` is unchanged, the background callback receives the failure, and the next identical snapshot retries that workspace.

- [ ] **Step 2: Run the workspace controller tests to verify failure**

Run:

```bash
npm test -- --run src/client/src/controllers/workspaceController.test.ts
```

Expected: FAIL because `reconcileProjectCatalog` does not exist.

- [ ] **Step 3: Implement atomic projection, diffing, and addition-only session hydration**

Refactor `WorkspaceController` into three contained operations:

```ts
private applyProjectWorkspaceProjection(
  project: Project,
  workspaces: Workspace[],
  machineId: string,
): { added: Workspace[]; selectedWorkspaceRemoved: boolean }

async reconcileProjectCatalog(snapshot: ProjectCatalogSnapshot): Promise<void>

private async hydrateDiscoveredWorkspaceSessions(
  project: Project,
  workspacesToHydrate: Workspace[],
  machineId: string,
): Promise<void>
```

Implement the following rules:

1. Reject a snapshot when `selectedMachineId(this.getState()) !== snapshot.machineId`, the project is no longer registered, or its current path differs from `snapshot.project.path`.
2. Derive the old topology from `workspacesByProjectId[project.id]`; for the selected project, fall back to `state.workspaces` when the cache is absent.
3. Diff workspaces with an identity containing both `workspace.id` and `workspace.path`.
4. Apply the new topology in one `setState` patch:

```ts
const workspacesByProjectId = { ...state.workspacesByProjectId, [project.id]: workspaces };
this.setState({
  workspacesByProjectId,
  ...(state.selectedProject?.id === project.id ? { workspaces } : {}),
  ...(selectedWorkspaceStillExists ? { selectedWorkspace: refreshedSelectedWorkspace } : {}),
  ...(state.selectedProject?.id === project.id ? {
    projectSessions: state.projectSessions.filter((session) => workspacePaths.has(session.cwd)),
  } : {}),
});
```

5. Maintain `private readonly unhydratedWorkspaceKeys = new Set<string>()`, where each key is `JSON.stringify([machineId, project.id, workspace.id, workspace.path])`. Before listing sessions, remove keys for workspaces absent from the latest snapshot.
6. For a selected-project snapshot, hydrate the union of newly added workspaces and workspaces whose key remains in `unhydratedWorkspaceKeys`. Use `Promise.allSettled()` so one failed workspace cannot discard successful sibling session lists, and wrap each successful list with `mergeCachedNewSessions(workspace.path, sessions, machineId)`.
7. Delete a workspace key only after its session list has succeeded. If a list fails, keep that key for the next catalog snapshot, call `onBackgroundError("reconcile discovered workspace sessions", error)`, and leave `AppState.error` unchanged.
8. After every `await`, repeat the machine/project/path guard. Merge hydrated rows with the latest `projectSessions` using `uniqueSessionsByPath`, preserving any live event row that appeared while the lookup was running.
9. If the selected workspace disappeared, call the existing `selectFallbackWorkspace()` result through `selectWorkspace()`; when no fallback exists, call `clearSelection()`. Do not navigate for a mere addition.
10. Update `refreshProjectWorkspaces()` to fetch a current `ProjectCatalogSnapshot`, delegate to `reconcileProjectCatalog()`, and still return the fetched `Workspace[]` so `PiWebUiApp.workspaceForCommandRun()` retains its existing contract. Keep `refreshAfterWorkspaceDeleted()` as a compatibility wrapper: after reconciliation has selected a fallback, its existing selected-workspace guard returns without a second navigation.

- [ ] **Step 4: Run the focused workspace tests**

Run:

```bash
npm test -- --run src/client/src/controllers/workspaceController.test.ts src/client/src/controllers/sessionController.liveEvents.test.ts src/client/src/sessionActivity.test.ts
```

Expected: PASS, including the session-event-before-worktree regression and existing known-session behavior.

- [ ] **Step 5: Commit workspace reconciliation behavior**

```bash
git add src/client/src/controllers/workspaceController.ts \
  src/client/src/controllers/workspaceController.test.ts
git commit -m "fix(workspaces): reconcile external project catalog"
```

---

### Task 3: Route active-CWD topology discovery through the common seam

**Files:**
- Modify: `src/client/src/controllers/projectActivityOwnershipCoordinator.ts:6-198`
- Modify: `src/client/src/controllers/projectActivityOwnershipCoordinator.test.ts:1-650`

**Interfaces:**
- Consumes: `WorkspaceController.reconcileProjectCatalog(snapshot)` from Task 2 through an injected callback.
- Produces:

```ts
export interface ProjectWorkspaceTopologySnapshot {
  machineId: string;
  projectId: string;
  projectPath: string;
  workspaces: Workspace[];
}

export interface ProjectActivityOwnershipCoordinatorDependencies {
  api?: Pick<typeof defaultApi, "workspaces">;
  onProjectTopology?: (snapshot: ProjectWorkspaceTopologySnapshot) => Promise<void> | void;
  onError?: (failure: ProjectActivityOwnershipFailure) => void;
}
```

- [ ] **Step 1: Write failing callback-routing tests**

Add a coordinator test that selects a project, marks a sibling worktree active, and supplies `onProjectTopology`:

```ts
it("forwards a current selected-project discovery snapshot to the common catalog seam", async () => {
  const received: ProjectWorkspaceTopologySnapshot[] = [];
  const coordinator = new ProjectActivityOwnershipCoordinator(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    {
      api: { workspaces: () => Promise.resolve([mainWorkspace, featureWorkspace]) },
      onProjectTopology: async (snapshot) => { received.push(snapshot); },
    },
  );

  await coordinator.handleActivityApplied("local");

  expect(received).toEqual([{
    machineId: "local",
    projectId: project.id,
    projectPath: project.path,
    workspaces: [mainWorkspace, featureWorkspace],
  }]);
});
```

Add tests proving that:

- a callback is awaited before the pass completes;
- stale machine/project/cache responses invoke neither the callback nor a cache mutation;
- existing callers without `onProjectTopology` retain the current cache-only fallback behavior; and
- a callback failure is reported through `onError` without changing selection or `AppState.error`.

- [ ] **Step 2: Run coordinator tests to verify failure**

Run:

```bash
npm test -- --run src/client/src/controllers/projectActivityOwnershipCoordinator.test.ts
```

Expected: FAIL because the callback and snapshot type do not exist.

- [ ] **Step 3: Implement callback-based snapshot handoff**

Refactor `runPass()` and `applyProjectWorkspaces()` so the current stale guards remain before state effects:

```ts
private async applyProjectWorkspaces(
  pass: OwnershipPass,
  project: ProjectTopologySnapshot,
  workspaces: Workspace[],
): Promise<void> {
  if (this.activePass !== pass || !this.isPassScopeCurrent(pass)) return;
  const currentProject = this.getState().projects.find((candidate) => candidate.id === project.id);
  if (currentProject?.path !== project.path) return;
  if (this.getState().workspacesByProjectId[project.id] !== project.startingWorkspaces) return;

  if (this.onProjectTopology !== undefined) {
    await this.onProjectTopology({
      machineId: pass.machineId,
      projectId: project.id,
      projectPath: project.path,
      workspaces,
    });
    return;
  }

  this.setState({
    workspacesByProjectId: { ...this.getState().workspacesByProjectId, [project.id]: workspaces },
  });
}
```

Make `runPass()` await each application call. Preserve the existing per-project `try`/`catch` so one failing project cannot block ownership reconciliation for the others.

- [ ] **Step 4: Run coordinator and workspace regression tests**

Run:

```bash
npm test -- --run src/client/src/controllers/projectActivityOwnershipCoordinator.test.ts src/client/src/controllers/workspaceController.test.ts
```

Expected: PASS. The old cache-only fallback tests remain green; callback tests prove the application seam is used when wired.

- [ ] **Step 5: Commit activity discovery integration**

```bash
git add src/client/src/controllers/projectActivityOwnershipCoordinator.ts \
  src/client/src/controllers/projectActivityOwnershipCoordinator.test.ts
git commit -m "fix(activity): share project topology reconciliation"
```

---

### Task 4: Wire lifecycle, reconnects, and the active-spawn path in `PiWebUiApp`

**Files:**
- Modify: `src/client/src/components/PiWebUiApp.ts:175-258, 442-512, 537-543, 1095-1107, 1196-1208`
- Create: `src/client/src/components/PiWebUiApp.projectCatalog.test.ts`

**Interfaces:**
- Consumes: `ProjectCatalogController` from Task 1, `WorkspaceController.reconcileProjectCatalog()` from Task 2, and `ProjectActivityOwnershipCoordinator.onProjectTopology` from Task 3.
- Produces: app-owned lifecycle wiring; no new browser route, plugin contract, server contract, or session-daemon protocol.

- [ ] **Step 1: Write failing app wiring tests**

Create `PiWebUiApp.projectCatalog.test.ts` using the existing `PiWebUiApp.memory.test.ts` reflection helpers as the local test style.

Cover lifecycle behavior:

```ts
it("observes the selected project after foreground workspace loading and disposes on disconnect", () => {
  const app = createApp();
  const catalog = projectCatalogController(app);
  const updatePolling = vi.spyOn(catalog, "updatePolling").mockImplementation(() => undefined);
  const dispose = vi.spyOn(catalog, "dispose").mockImplementation(() => undefined);

  invokeConnected(app);
  applyAppState(app, {
    ...initialAppState(),
    selectedProject: project,
    workspaces: [mainWorkspace],
    isLoadingWorkspaces: false,
  });

  expect(updatePolling).toHaveBeenCalledWith(true);

  invokeDisconnected(app);
  expect(dispose).toHaveBeenCalledOnce();
});

it("requests immediate catalog reconciliation when the selected realtime socket opens", () => {
  const app = createApp();
  const catalog = projectCatalogController(app);
  const refresh = vi.spyOn(catalog, "refresh").mockResolvedValue(undefined);

  invokeRealtimeConnected(app);

  expect(refresh).toHaveBeenCalledOnce();
});
```

Add an integration test that invokes the active-CWD coordinator callback supplied by the app with a `featureWorkspace`, stubs only `sessionsApi.sessions` at the `WorkspaceController` seam, and asserts:

- `state.workspaces` includes the feature worktree;
- `state.projectSessions` contains the spawned session; and
- a pre-existing active `sessionActivities[spawnedSession.id]` entry remains available for `sessionActivityIndicators()`.

- [ ] **Step 2: Run app wiring tests to verify failure**

Run:

```bash
npm test -- --run src/client/src/components/PiWebUiApp.projectCatalog.test.ts
```

Expected: FAIL because the catalog controller is not constructed or wired into the app lifecycle.

- [ ] **Step 3: Wire the controllers in `PiWebUiApp`**

Reorder field initialization so `WorkspaceController` is constructed immediately after `SessionController`, before the catalog controller and activity-ownership coordinator. Pass its new background-error dependency as:

```ts
{
  onBackgroundError: (operation, error) => {
    console.warn(`Failed to ${operation}`, error);
  },
}
```

Construct the catalog controller with:

```ts
private readonly projectCatalog = new ProjectCatalogController(
  () => this.state,
  {
    workspaces: workspacesApi.workspaces,
    applySnapshot: async (snapshot) => {
      await this.workspaces.reconcileProjectCatalog(snapshot);
    },
    onBackgroundError: (operation, error) => {
      console.warn(`Failed to ${operation}`, error);
    },
  },
);
```

Construct `ProjectActivityOwnershipCoordinator` with an `onProjectTopology` callback that resolves the still-current project by ID/path and forwards a `ProjectCatalogSnapshot` to `this.workspaces.reconcileProjectCatalog()`.

Add a small app-private lifecycle method:

```ts
private synchronizeProjectCatalogPolling(): void {
  this.projectCatalog.updatePolling(this.isConnected);
}
```

Call it after state transitions in `setState()`, once in `connectedCallback()`, and let it invalidate observation when no selected project exists or foreground workspace loading is in progress. Call `this.projectCatalog.dispose()` in `disconnectedCallback()`.

Extend the selected realtime socket open callback and browser-resume refresh path:

```ts
void this.projectCatalog.refresh();
```

Keep the existing unread, terminal, workspace activity, and session-refresh calls intact. The catalog refresh must be additive, not a replacement for those recovery operations.

- [ ] **Step 4: Run focused integration tests**

Run:

```bash
npm test -- --run \
  src/client/src/components/PiWebUiApp.projectCatalog.test.ts \
  src/client/src/controllers/projectCatalogController.test.ts \
  src/client/src/controllers/workspaceController.test.ts \
  src/client/src/controllers/projectActivityOwnershipCoordinator.test.ts
```

Expected: PASS. The active-spawn regression demonstrates that a newly discovered worktree and session appear without selection changes, and lifecycle tests prove no detached polling survives.

- [ ] **Step 5: Commit app lifecycle wiring**

```bash
git add src/client/src/components/PiWebUiApp.ts \
  src/client/src/components/PiWebUiApp.projectCatalog.test.ts
git commit -m "fix(ui): reconcile live project catalog"
```

---

### Task 5: Add the release note and run final verification

**Files:**
- Create: `.changeset/live-project-catalog-reconciliation.md`

**Interfaces:**
- Consumes: completed client-only sidebar reconciliation behavior.
- Produces: patch release metadata only; it does not change source runtime behavior.

- [ ] **Step 1: Add the patch Changeset**

Create `.changeset/live-project-catalog-reconciliation.md`:

```md
---
"@hyperdreamer/pi-webui": patch
---

Show agent-created worktrees and their spawned sessions in the sidebar without requiring a browser refresh or project switch.
```

- [ ] **Step 2: Run the focused release-impact checks**

Run:

```bash
git diff --check
npm test -- --run \
  src/client/src/controllers/projectCatalogController.test.ts \
  src/client/src/controllers/workspaceController.test.ts \
  src/client/src/controllers/projectActivityOwnershipCoordinator.test.ts \
  src/client/src/components/PiWebUiApp.projectCatalog.test.ts
npm run typecheck
npx eslint \
  src/client/src/controllers/projectCatalogController.ts \
  src/client/src/controllers/workspaceController.ts \
  src/client/src/controllers/projectActivityOwnershipCoordinator.ts \
  src/client/src/components/PiWebUiApp.ts
```

Expected: all focused tests, typechecking, lint, and whitespace checks pass.

- [ ] **Step 3: Run the complete repository verification**

Run:

```bash
npm run verify
```

Expected: typecheck, lint, Knip, and the complete Vitest suite pass.

- [ ] **Step 4: Commit the release metadata**

```bash
git add .changeset/live-project-catalog-reconciliation.md
git commit -m "chore: add project catalog reconciliation changeset"
```

---

## Plan self-review

### Spec coverage

| Approved requirement | Plan coverage |
| --- | --- |
| Immediate active worktree/session discovery | Tasks 2–4: active-CWD snapshot callback, added-workspace session hydration, app wiring. |
| Idle external worktree discovery | Task 1: five-second serial poll; Task 2: topology application. |
| One visible/cache workspace projection seam | Task 2 common reconciliation method; Task 3 routes activity discovery through it. |
| Preserve live session badge after catalog race | Task 2 ordering regression test and session-map-preserving merge. |
| No automatic selection | Task 2 selection-preservation test and method rules. |
| Safe machine/project/path races | Task 1 generation/scope tests; Task 2 post-await guards; Task 3 existing stale guards. |
| Reconnect/disconnect lifecycle | Task 4 tests and wiring. |
| Background failure behavior | Tasks 1 and 2 failure/reporting rules. |
| Client-only operational constraint | Global constraints and Task 4; no server/sessiond files listed. |
| User-visible release note | Task 5 Changeset. |

### Placeholder scan

The plan contains concrete file paths, symbols, method signatures, test cases, commands, and commit commands for every task. It contains no deferred implementation markers.

### Type consistency

- `ProjectCatalogSnapshot` is defined in Task 1 and consumed by Tasks 2 and 4.
- `WorkspaceController.reconcileProjectCatalog(snapshot)` is produced in Task 2 and consumed by Tasks 3 and 4.
- `ProjectWorkspaceTopologySnapshot` is defined in Task 3 and adapted to `ProjectCatalogSnapshot` only in `PiWebUiApp` during Task 4.
- `ProjectCatalogController.updatePolling()`, `refresh()`, and `dispose()` are defined in Task 1 and used only in Task 4.
