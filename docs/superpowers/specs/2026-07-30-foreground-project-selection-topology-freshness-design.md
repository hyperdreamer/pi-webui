# Foreground project-selection topology freshness — design

**Date:** 2026-07-30

**Status:** Approved design direction; awaiting review of this written specification.

## Goal

Prevent a delayed foreground `WorkspaceController.selectProject()` workspace response from replacing a newer, valid project-catalog snapshot for the same selected project.

The selected project's newest successfully applied topology must remain authoritative for both visible `workspaces` and `workspacesByProjectId`. This includes a project whose ID is unchanged but whose path has been replaced.

## Problem

`selectProject()` currently clears the selected workspace, marks workspace loading, and awaits `api.workspaces()`. Its completion guard checks only the selected machine and project ID before directly replacing the workspace projections.

Background activity ownership can begin a newer topology request while that foreground request is pending. When the background request applies first, its snapshot correctly adds a new worktree and its sessions. A late foreground response can then overwrite that newer topology with its older workspace list. It can also choose an obsolete workspace or publish stale navigation/session state.

The selected-project polling controller does not normally race this path while `isLoadingWorkspaces` is true, but activity-driven ownership discovery does. The correctness rule therefore belongs in `WorkspaceController`, where both foreground and background topology converge.

## Accepted behavior

1. A successful current catalog snapshot supersedes an older pending foreground topology response for the same selection scope.
2. A foreground selection still chooses its preferred workspace from the newest available topology. If a newer catalog snapshot arrives first, it may satisfy the pending foreground selection using that fresh snapshot rather than waiting for the older response.
3. A later-started catalog request that fails does not discard a still-current foreground response merely because it was started later. Only a successfully applied newer snapshot supersedes the foreground response.
4. Stale foreground success and failure completions do not replace workspaces, change selection, clear newer loading state, publish an error, or navigate.
5. Current scope means the same selected machine, project ID, and project path, plus the currently active foreground selection generation.
6. Existing background behavior remains unchanged for projects that are not being foreground-selected. No session-daemon ownership, protocol, or restart behavior changes.

## Alternatives considered

### 1. Add only a topology-order check after the foreground fetch

This is small, but it rejects a foreground response as soon as a newer background request starts—even if that request later fails. It also leaves no owner to select a workspace when a background snapshot successfully arrives before the foreground response. This can strand the initial selection in a loading or unselected state.

**Rejected:** it conflates a newer request with a newer successfully applied topology.

### 2. Queue background snapshots until foreground selection finishes

This preserves the existing foreground flow, but delays live worktree/session discovery precisely when a newly active worktree needs to become visible. It contradicts the agreed rule that a newer valid catalog snapshot wins.

**Rejected:** it retains stale foreground authority and harms the live-update path.

### 3. Use a controller-owned pending foreground-selection context and satisfy it through the shared snapshot seam

`WorkspaceController` retains a small, generation-scoped foreground selection context while `selectProject()` is loading. Both the foreground response and a validated background snapshot can complete that context exactly once. The completion helper selects from the topology it receives; a background snapshot uses its current catalog scope so later topology changes suppress stale session publication.

**Recommended:** it preserves user intent and route targets, keeps topology application in one seam, and distinguishes a successful newer snapshot from a merely newer in-flight request.

## Architecture

### Controller-owned foreground selection context

Add a private, monotonic foreground project-selection generation in `WorkspaceController`. Starting `selectProject()` captures:

- the generation;
- selected machine ID;
- project ID and path; and
- the optional `RouteTarget` used to choose and navigate to the preferred workspace/session.

`clearSelection()` and any newer foreground project selection invalidate the prior context. A helper verifies that a context still matches the selected machine, selected project ID/path, and current project catalog entry before it may mutate state.

The context is intentionally private controller state rather than a new `AppState` field. It describes an in-flight effect, not durable UI data, and keeping it local makes ownership and cleanup explicit.

### One completion helper

Introduce one private helper that completes a current pending foreground selection from a supplied workspace list:

1. verify the context is current;
2. consume it exactly once;
3. update the two workspace projections through the existing projection seam only when the supplied topology is the foreground response;
4. choose `selectPreferredWorkspace()` with the stored route target and remembered workspace ID;
5. select that workspace or finish workspace loading and update the URL when no workspace exists.

When a validated catalog snapshot supplies the list, the snapshot has already updated the projections. The helper only resolves foreground workspace/session selection from that fresh list; it does not reapply topology.

### Foreground response behavior

After `selectProject()` receives its workspace response, it first verifies that its foreground context is still current.

- If no newer valid catalog snapshot has completed the context, the foreground response applies its own projection and completes the context.
- If a newer valid catalog snapshot already completed the context, the delayed response does nothing.
- If a newer catalog request is merely in flight, the still-current foreground response remains allowed to complete selection. A future successful catalog snapshot may then reconcile over it normally.
- A foreground failure reports an error and clears loading only while its context remains current and has not been completed by a newer valid snapshot.

### Catalog snapshot behavior

After `reconcileProjectCatalog()` validates and applies a snapshot for the selected machine/project/path, it checks for a matching pending foreground context before ordinary discovered-workspace hydration/fallback work.

If matched, it completes the foreground selection from the just-applied snapshot and returns through the established workspace/session selection path. This avoids waiting for a stale fetch and avoids duplicate initial session hydration. If unmatched, the existing background catalog behavior continues unchanged.

The existing request-order token remains responsible for rejecting older background snapshots. The new foreground context answers the different question of whether an initial user selection still needs to be completed.

## Data flow

```text
selectProject(project) starts
  → capture foreground generation + machine/project ID/path + route target
  → enter workspace-loading state
  → await foreground workspace list

activity-driven catalog snapshot succeeds first
  → existing topology token validates it
  → shared projection seam updates workspaces and per-project cache
  → matching pending foreground context selects from this fresh list
  → delayed foreground list later resolves and is ignored
```

```text
selectProject(project) starts
  → a newer catalog request starts but has not succeeded
  → foreground list succeeds while its context remains current
  → foreground projection/selection completes normally
  → later successful catalog snapshot reconciles the newer topology
```

## Error handling and invariants

- Do not surface an error from a foreground request after its context was invalidated by a newer foreground selection, a clear-selection action, machine change, project change, path replacement, or successful catalog completion.
- Do not clear `isLoadingWorkspaces` for a newer foreground selection. The completion helper owns that state only for its matching context.
- A selected project path mismatch is a hard stale boundary even if project IDs match.
- Do not add a second topology cache or mutate `workspaces` and `workspacesByProjectId` independently.
- Do not change the session-daemon protocol, `src/server/sessiond.ts`, active-session ownership, or browser URL conventions.

## Verification strategy

Follow TDD in `src/client/src/controllers/workspaceController.test.ts`.

1. Add a deferred foreground `selectProject()` test. Start it with an older workspace list, apply a newer valid catalog snapshot containing a newly discovered worktree, then resolve the foreground request. Assert that both workspace projections, the selected workspace/session behavior, and navigation remain based on the newer snapshot.
2. Add a same-project-ID/path-replacement variant. Retarget both the project catalog and selected project to the replacement path, apply its newer snapshot, then resolve the old-path foreground response. Assert that no old-path topology or selection is restored.
3. Add a stale foreground rejection variant. After a matching valid catalog snapshot completes the foreground context, reject the older foreground request and assert that it does not replace state or add an error.
4. Run the focused controller test file, then the plan’s catalog/memory/session focused suite, `npm run verify`, `npm run build`, `npm run pack:dry`, and `git diff --check` before regenerating the release metadata.

## Release and operational impact

This is a browser/client controller correction. It needs no manual restart of `pi-webui-sessiond.service`; the UI/API development service’s normal autoreload path is sufficient.

Add a patch Changeset for the correction before regenerating `v1.10.3`, with a user-facing note that live worktree/session discovery no longer reverts to stale project topology during an in-flight project load.

This specification is internal engineering documentation. It does not require README or published user-documentation expansion.
