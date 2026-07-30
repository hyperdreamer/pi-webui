# Live project catalog reconciliation for agent-created worktrees and sessions — design

**Date:** 2026-07-30
**Status:** Approved design direction; awaiting review of this written specification.

## Goal

Keep the selected project's sidebar catalog current when an agent creates a Git worktree and starts a Pi session in it, without requiring a browser reload or switching away from and back to the project.

The change must make the following sequence converge in the open browser tab:

1. An agent creates a worktree for the selected project.
2. The agent starts or spawns a session in that worktree.
3. The new worktree appears in the **Workspaces** block.
4. The new session appears in the **Sessions** block with its live active indicator when it is working.

It must also discover an externally created idle worktree within a short bounded reconciliation interval.

## Current behavior and root cause

The runtime operations already succeed. The stale UI results from two disconnected browser catalog projections:

- `ProjectActivityOwnershipCoordinator` sees an unknown active CWD from a `workspace.activity` realtime event and refetches project workspace topology. Its current application step updates only `workspacesByProjectId`.
- `WorkspaceList` renders the selected project's separate `state.workspaces` projection. Since that projection is not updated, a new worktree remains absent until `WorkspaceController.selectProject()` runs again after a manual project switch or browser reload.
- A `session.created` event for the new worktree arrives before the browser knows that worktree. `SessionController` therefore cannot place the session into the current project/session catalog. Later `status.update` and `activity.update` events are retained by session ID, but there is no session row on which to render their activity.

Switching projects happens to repair both symptoms because it reloads the selected project's workspaces and sessions through the normal foreground selection path.

## Accepted behavior

### Active spawned-session path

1. A spawned session becoming active emits the existing `workspace.activity` event for its worktree.
2. Unknown-active-CWD handling immediately requests a fresh project workspace snapshot; it does not wait for the fallback polling interval.
3. The snapshot updates both the visible selected-project workspace list and the per-project workspace cache together.
4. Newly discovered workspaces receive a session-list lookup. The returned rows merge into the project session catalog without changing the user's selected workspace or session.
5. The active status/activity records already received over realtime are reused, so the new session row gains its active badge immediately after it is added.

### Idle/external worktree path

- While a project is selected, a short selected-project reconciliation poll discovers worktrees that have no active session or terminal and thus emit no `workspace.activity` signal.
- The proposed interval is five seconds. It is a fallback, not the normal active-spawn latency path.
- A newly discovered idle worktree appears in Workspaces without being auto-selected. Its sessions, if any, are added through the addition-only session lookup.

### Existing UI behavior retained

- A session created in an already known workspace continues to use the existing `session.created` fast path.
- Catalog reconciliation never automatically navigates to a newly created workspace or session.
- Existing foreground project/workspace selection loading and error behavior remain authoritative.
- If an externally removed workspace was selected, the existing safe fallback-workspace or clear-selection behavior applies.

## Architecture

### Deep module: selected-project catalog reconciler

Introduce a focused browser-side **selected-project catalog reconciler**. Its small caller-facing interface owns:

- beginning, retargeting, or stopping observation for the selected machine/project scope;
- requesting an immediate reconciliation after an activity/realtime hint or socket reconnect; and
- disposal when the app disconnects.

Its implementation hides:

- the selected scope key (`machineId`, `projectId`, and project path);
- the one-current-request policy;
- generations used to suppress stale results after machine/project changes;
- the fallback timer; and
- background-error retention and retry behavior.

The reconciler must use serial `setTimeout` scheduling, not `setInterval`: it schedules exactly one next request only after the current request settles. A same-scope trigger reuses or trails the current request instead of issuing overlapping catalog loads.

### One workspace-snapshot application seam

All background workspace snapshots must enter one application seam owned alongside the existing workspace/session catalog behavior. Both sources feed it:

1. the existing `ProjectActivityOwnershipCoordinator` path for an unknown active CWD; and
2. the selected-project catalog reconciler's fallback poll and realtime-reconnect refresh.

That seam must:

1. verify that the response still belongs to the current machine/project scope;
2. atomically update `state.workspaces` for the selected project and `workspacesByProjectId` for the same project;
3. diff additions and removals by stable workspace identity/path;
4. fetch sessions only for newly discovered workspaces and merge them into `projectSessions` without replacing current live state;
5. remove session rows belonging to removed workspaces; and
6. preserve the current selection unless the selected workspace no longer exists.

This makes the workspace catalog the single source for both the visible Workspaces block and the project topology used by background activity ownership. It removes the current cache-only update that allows the two projections to diverge.

### Session status and activity

`SessionController` remains the owner of live status/activity maps and normal `session.created` handling. The reconciliation seam does not poll every session's status.

For the new-worktree ordering race, it lists sessions after discovering the workspace. By the time those rows are merged into `projectSessions`, status/activity entries that arrived earlier are already indexed by session ID and render through the existing session activity logic. This avoids a second deferred-session state machine and preserves the normal direct event fast path for known workspaces.

### Existing activity ownership coordination

`ProjectActivityOwnershipCoordinator` remains responsible for identifying an active CWD whose project ownership is not yet known. Its successful workspace snapshot must be routed through the common snapshot-application seam rather than directly writing only `workspacesByProjectId`.

The selected-project reconciler supplies the broader idle-worktree fallback. It does not replace the coordinator's cross-project active-CWD attribution responsibilities.

## Data flow

```text
agent creates worktree + starts spawned session
  → session runtime publishes workspace.activity for the active CWD
  → ActivityController records the active workspace
  → unknown-active-CWD ownership handling requests workspace topology
  → common snapshot-application seam updates visible workspaces + topology cache
  → newly discovered workspace(s) receive session-list lookup(s)
  → projectSessions gains the spawned session row
  → existing status/activity map entry renders the active Session Block badge
```

```text
agent creates an idle worktree
  → no workspace.activity is emitted
  → selected-project reconciler's next serial poll fetches workspace topology
  → common snapshot-application seam adds the worktree to Workspaces
  → optional sessions for the new worktree are merged into projectSessions
```

```text
realtime socket reconnects
  → request immediate selected-project reconciliation
  → reconcile catalog without waiting for the next timer
```

## Concurrency, lifecycle, and errors

- The reconciliation scope includes all selected-state identity needed to reject stale results: machine ID, project ID, and project path.
- A project or machine switch clears the pending timer, increments the generation, and prevents an older request from applying data or scheduling a subsequent poll.
- Only the current scope may apply a background snapshot or a newly fetched session list.
- App disconnect disposes the reconciler and cancels its timer; no polling survives detached UI lifecycle.
- The foreground project-selection fetch seeds the same snapshot-application path and starts the scope without a duplicate initial background request.
- A background failure keeps the last successful Workspaces/Sessions catalog visible, records diagnostics through the established background-error path, and schedules a later retry. It does not overwrite the existing foreground error state.
- A realtime activity hint during an in-flight reconciliation marks a trailing refresh rather than starting a parallel request.

## Verification strategy

Follow TDD: write and run a focused failing regression test before each production change, implement the smallest behavior that makes it pass, then broaden verification.

### Selected-project reconciler tests

Use injected snapshot functions, deferred promises, and a fake timeout scheduler to verify:

1. an activity hint and realtime reconnect trigger an immediate same-scope reconciliation;
2. the next timer is scheduled only after request settlement and no overlapping requests occur;
3. a project/machine/path scope change invalidates an older response and timer;
4. disconnect cleanup cancels future polling;
5. a background failure retains the prior catalog and schedules retry; and
6. an idle worktree is discovered through the fallback poll.

### Catalog application and controller tests

Add or extend focused tests to verify:

1. one snapshot updates both `workspaces` and `workspacesByProjectId` for the selected project;
2. a newly added worktree produces an addition-only session lookup and merges its rows into `projectSessions`;
3. a known-workspace `session.created` event remains immediate and does not duplicate a catalog-loaded row;
4. status/activity received before the workspace/session catalog entry yields an active session indicator once the entry is merged;
5. a newly added worktree does not change the selected workspace/session; and
6. an externally removed selected workspace uses the existing fallback/clear-selection behavior safely.

### App integration and lifecycle tests

Cover that `PiWebUiApp`:

1. wires activity hints, realtime reconnects, selection changes, and disconnect to the reconciler;
2. does not continue catalog polling after the app disconnects; and
3. preserves current selected-session activity while the sidebar catalog gains an external worktree and spawned session.

Run focused Vitest files first, then:

```bash
npm run typecheck
npx eslint <changed-files>
git diff --check
npm run verify
```

## Operational and release impact

- The implementation is browser/client orchestration plus existing browser-facing HTTP calls. It does not change session ownership, the session-daemon protocol, or `src/server/sessiond.ts`.
- Development changes should follow the normal UI/API autoreload path; a manual `pi-webui-sessiond.service` restart is not expected.
- Add a patch Changeset when implementation begins. Its release note should tell users that agent-created worktrees and spawned sessions appear in the sidebar without manual refresh.
- Do not edit `CHANGELOG.md` directly; release preparation generates it from Changesets.

## Non-goals

- Do not add a filesystem watcher, server-side watch lifecycle, or a new session-daemon/realtime workspace-catalog protocol.
- Do not poll all session statuses on every catalog interval.
- Do not automatically select, navigate to, or focus a new worktree or spawned session.
- Do not alter normal session ownership, spawning permissions, workspace deletion semantics, or remote-machine protocol compatibility.
- Do not add a user configuration switch for the polling interval in this change.
- Do not expand `README.md`; this is internal design work until the user-visible implementation is complete.

## Expected implementation areas

- `src/client/src/controllers/`: selected-project catalog reconciliation timing/state, workspace snapshot application, and focused tests.
- `src/client/src/controllers/projectActivityOwnershipCoordinator.ts`: route active-CWD workspace snapshots through the common application seam.
- `src/client/src/components/PiWebUiApp.ts`: lifecycle wiring for selected scope, realtime reconnect, activity hints, and disconnect cleanup.
- `src/client/src/components/` and `src/client/src/sessionActivity.test.ts`: only the focused regression assertions needed to prove Workspaces and Sessions projections render the reconciled state.
- `.changeset/`: one patch-level user-facing release note during implementation.
