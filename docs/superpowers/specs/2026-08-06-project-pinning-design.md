# Project pinning

**Date:** 2026-08-06
**Status:** Approved design

## Problem

The Projects section orders entries by `projects.json` array order, partitioned so that projects with live activity float above idle ones (`prioritizeActiveProjects` in `src/client/src/components/projectListProjection.ts`). There is no way to keep a frequently used project near the top when it is idle, and no project-level ordering concept exists anywhere in the codebase.

Sessions already solve the equivalent problem: `SessionMetadataStore` persists a per-session `pinned` flag, `POST /sessions/:sessionId/pin|unpin` mutates it, `SessionInfo.pinned` carries it to the client, `sessionTreeRows.ts` orders a pinned cohort above an unpinned one, and `SessionList` renders a star toggle plus a Pin/Unpin action-menu item.

Projects should gain the same capability, with ordering rules that compose pin state with the existing activity partition.

## Decision

Add a durable per-project `pinned` flag owned by the machine that owns the project, and order the Projects list by pin state first and activity second.

### Ordering

`displayedProjects` filters by the search query, splits the result into pinned and unpinned cohorts, applies the existing `prioritizeActiveProjects` within each cohort, and concatenates pinned first. This yields four groups in fixed order:

1. pinned and running
2. pinned and idle
3. unpinned and running
4. unpinned and idle

Within each group, `projects.json` array order is preserved. `prioritizeActiveProjects` is already a stable partition, so no sort key is introduced.

"Running" means live activity as detected by `projectActivityIndicator` (a running session or terminal in any workspace the project owns), not the currently selected project. Ordering by selection would move rows under the pointer; sessions deliberately do not do this either.

### Position on pin and unpin

Both pin and unpin move the project to the front of the `projects` array in the same durable write that changes the flag.

This satisfies the requirement that an unpinned project appears first in the unpinned cohort when it is running, and at the top of the idle projects when it is not: front-of-array places it first within whichever group it belongs to. Pin behaves symmetrically, so the action visibly confirms itself and pinning projects in reverse order of importance is a usable way to hand-order the pinned group.

## Data model

`Project` in `src/shared/apiTypes.ts` gains `pinned?: boolean`, omitted when false, matching `SessionInfo.pinned`. Existing `projects.json` files remain valid; an absent flag means unpinned.

## Server

`ProjectStore` (`src/server/storage/projectStore.ts`):

- `parseProject` accepts an optional boolean `pinned` and preserves it. Values of the wrong type still throw.
- `setPinned(id: string, pinned: boolean): Promise<Project | undefined>` sets the flag and moves the entry to the front of the array in one write. Returns the updated project, or `undefined` for an unknown id.
- A promise-chain lock serializes `add`, `remove`, and `setPinned`. `write` is a plain `writeFile` with no temp-file rename and no queue, unlike `SessionArchiveStore`; pin adds a second mutation path, so overlapping read-modify-write cycles could otherwise lose an update.

`ProjectService` gains `pin(id)` and `unpin(id)`, delegating to `setPinned` and throwing `Error("Project not found")` on a miss, mirroring `close(id)`.

Routes in `registerLocalProjectRoutes` (`src/server/app.ts`):

- `POST ${prefix}/projects/:projectId/pin`
- `POST ${prefix}/projects/:projectId/unpin`

Both return the full `Project[]` in new order and respond 404 for an unknown id. Both are registered under the `/api` and `/api/machines/local` prefixes like the neighbouring project routes, and added to `FEDERATED_HTTP_ROUTES` in `src/shared/federatedRoutes.ts` so `registerMachineProxyRoutes` forwards them to remote machines without further change.

Returning the whole ordered list keeps the server the single owner of order. Returning only the mutated project would force the client to reproduce the move-to-front rule, putting the ordering contract in two places.

## Client

- `parseProject` in `src/client/src/api/parsers.ts` accepts optional `pinned`; the new responses parse through `arrayOf(parseProject)`.
- `projectsApi` gains `pinProject(projectId, machineId)` and `unpinProject(projectId, machineId)`, built as application-relative `api/...` references with `encodeURIComponent` on the id, per the client URL convention.
- `ProjectController` gains `pinProject(projectId)` and `unpinProject(projectId)`. Each awaits the call, discards the result when the selected machine changed mid-flight, then replaces `state.projects`. Neither calls `onProjectsApplied`: the project set is unchanged, so activity ownership does not re-resolve.

## UI surfaces

- `ProjectList`: a filled star before the project name on pinned rows only, click unpins, plus a Pin/Unpin item in the existing action menu. Direct mirror of `SessionList`.
- `ProjectBrowserDialog`: a star toggle on every row, filled when pinned and outline when not, plus a Pin/Unpin item in its existing action menu.
- `SessionBrowserDialog`: a star toggle on every row, wired to `SessionController.pinSession` and `unpinSession`. This dialog has no action menu today and none is added.

The dense sidebar keeps a star on pinned rows only. The dialogs show an outline star on unpinned rows because they have room and it is a clearer discovery path than a hidden menu item.

Star toggles carry `aria-pressed` and an explicit label ("Pin project X" / "Unpin project X"), and stop event propagation so activating one does not select the row.

## Edge cases

- Pinning from the action menu changes the row index, so the existing `shouldCloseProjectMenuForOrderChange` check closes the menu. This is the intended behavior and needs no new code.
- A project gaining or losing activity moves between groups without touching pin state, because activity is evaluated at render time from `workspaceActivities`.
- Search results are grouped by pin state as well, so a query shows pinned matches first.
- Pin state belongs to the machine owning `projects.json`. Switching machines shows that machine's pins; there is no cross-machine sync.
- Pinning a project closed in another tab returns 404, surfaced through the controller's existing `setState({ error })` path.
- `ProjectBrowserDialog` keyboard navigation is unaffected; the star is a separate focusable button within the row.
- `SessionController.pinSession` already ignores archived sessions, so the dialog toggle inherits that guard.

## Alternatives

### Client-local pin state

Storing pins in `localStorage` keyed by machine and project id needs no server work, but pins become per-browser and drift between devices. Project state otherwise lives on the owning machine.

### Global user config

`~/.config/pi-webui/config.json` would share pins across machines, but project ids are machine-scoped, so the mapping is awkward and the file is the user-editable config API rather than a store for UI state.

### Explicit order field

A per-project `order` or `pinnedAt` value would make position independent of array order. It is unnecessary: front-of-array on mutation already produces the required placement, and adding an order field invites a manual reordering UI that was not requested.

### Leave array position unchanged on pin

Less surprising when pinning several projects at once, but it leaves the pinned group in creation order with no way to influence it.

## Testing

Smallest layer that proves each behavior, per the repository testing guide.

- `projectStore.test.ts`: `pinned` round-trips; an absent flag stays absent; `setPinned` moves the entry to the front; unknown id returns `undefined`; two overlapping `setPinned` calls both persist, covering the lock.
- `projectService` coverage for the not-found throw.
- `app.projects.test.ts`: both routes return the reordered list, 404 for an unknown id, and are reachable under `/api` and `/api/machines/local`.
- `federatedRouteContract.test.ts` and `app.remoteProxy.test.ts`: the two new routes proxy to remote machines.
- `parsers` and `clients.test.ts`: optional `pinned` parsing, path construction, and id encoding.
- `projectListProjection.test.ts`: the four-group ordering; unpinning a running project places it first in the unpinned cohort; unpinning an idle project places it above other idle unpinned projects but below running ones.
- `projectController` tests: state replacement, stale-machine guard, error path.
- Component tests for all three surfaces: the star reflects pin state, activating it calls the correct handler without selecting the row, and the menu item label flips with state.

A changeset is required; the change is user-visible.

## Out of scope

- Manual drag reordering of projects.
- Cross-machine pin synchronization.
- An action-menu in `SessionBrowserDialog` beyond the star toggle.
- Converting `ProjectStore.write` to temp-file-plus-rename durability. The lock addresses lost updates; crash-atomicity is a separate concern.
