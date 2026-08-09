# Recent Projects workspace tab - design

## Goal

Add a machine-level **Recent Projects** tab to the workspace panel. It gives users a durable, most-recently-used history of projects where they have performed meaningful work, while keeping project registration and recent history as separate concepts.

The tab must remain usable when no project or workspace is selected so a previously unregistered project can be reopened from history.

## Accepted behavior

- History is scoped to the currently selected machine and persisted as PI WEBUI-managed state on that machine.
- The history contains at most 20 entries, newest first. Adding a twenty-first entry evicts the least recently used entry.
- Registering a new project inserts it at the top immediately.
- Successful user-initiated work inserts or moves a project to the top.
- Merely selecting or browsing a project, workspace, or session does not add or reorder history.
- Background activity does not reorder history.
- Unregistering a project leaves its history entry intact.
- There is no per-row close, remove, or overflow control. Registered entries cannot be removed manually.
- Selecting an unregistered history entry opens a decision dialog with **Reopen**, **Remove from history**, and **Cancel**.
- Recent Projects remains available without a selected workspace. Existing workspace and plugin tabs remain workspace-scoped.

## Domain semantics

A **registered project** is an entry in the selected machine's project registry.

A **recent project entry** is independent historical state containing the last known name and canonical machine-local path. It may refer to either a registered or an unregistered project.

A **closed entry** is a recent project entry whose canonical path does not match any currently registered project on that machine. Closed does not imply that the directory is missing, deleted, or inaccessible. PI WEBUI does not probe every historical path merely to render the list.

**Meaningful work** is a successful user action that changes or initiates work in the project:

- submitting a prompt that starts or continues session work;
- starting a workspace terminal;
- entering input in an existing workspace terminal when the project is not already the newest history entry;
- launching a workspace task or terminal command.

The first meaningful terminal input after another project becomes newest may touch history again. The controller skips a touch when the project is already the newest entry, preventing one persistence write per keystroke.

The following are explicitly not meaningful-work triggers:

- selecting a machine, project, workspace, session, terminal tab, or panel tab;
- browsing files, Git state, project details, or session history;
- polling, refreshes, reconnects, and catalog reconciliation;
- assistant streaming, background session events, and terminal output;
- activity-indicator changes without a corresponding user action.

## Data model and persistence

Add a shared additive API type:

```typescript
interface RecentProjectEntry {
  id: string;
  name: string;
  path: string;
  lastUsedAt: string;
}
```

The history ID identifies the historical record for API mutations. The canonical project path is the durable matching key. A current project ID is deliberately not persisted in history because unregistering and reopening may produce a different project ID.

### Path identity

History must reuse the project registry's own registration-dedupe rule for path identity rather than introducing a fourth comparison. Today the project service resolves an incoming path with `realpath` before delegating to the store, and the store dedupes registered projects by exact equality on that already-resolved value. History stores that same resolved value and matches it the same way, so a history write must never persist an unresolved client-supplied path.

This is a load-bearing constraint. The repository contains three different path rules: `cwdPathsEqual` in `src/server/workingDirectory.ts`, the separator-normalized case-sensitive ancestry comparison in `src/shared/projectAncestry.ts`, and exact-equality dedupe on a service-resolved path in `ProjectStore.add`. If history matching and registration dedupe disagree, an entry can render **Closed** while its project is registered, or Reopen can create a second registered project for a path already present. Registered-versus-Closed rendering therefore compares the same resolved path values the registry itself compares.

Extend the existing machine-local project registry document with an optional `recentProjects` array. Existing documents without this field load with empty history. The web/API process remains the writer; the session daemon continues to read only the existing `projects` collection and requires no protocol or runtime-ownership change.

An upgrade does not infer or backfill history from existing projects, sessions, or terminal output. An absent collection starts empty and populates from subsequent registrations and meaningful user actions. This preserves the rule that selection and background activity cannot manufacture recency.

Accepted consequence: immediately after upgrading, the tab shows **No recent projects** even when sessions or terminals are already running, until the next registration or user action. This is preferred over inferring recency that the user never expressed.

The project store owns all history invariants inside its existing serialized write boundary:

- use the server clock for `lastUsedAt`;
- deduplicate by canonical path;
- preserve the existing history ID when a path is touched or reopened;
- update the stored name from the current registered project;
- move the touched entry to index zero;
- truncate to 20 entries;
- leave history unchanged when a project or project tree is unregistered;
- preserve history through pin and unpin writes.

Every write path must round-trip history. The store currently serializes only its parsed `{ projects }` shape, so any write that ignores `recentProjects` silently destroys it. Add, close, close-tree, pin, unpin, touch, and history removal all persist both collections.

Malformed optional history is quarantined rather than allowed to fail a registry read or to be silently overwritten. Registered-project parsing must not depend on history parsing, so a corrupt `recentProjects` value still yields valid `projects` results, and the history API reports its own failure. Because the current reader throws for any invalid document and only tolerates a missing file, this separation is an explicit implementation requirement rather than existing behavior. Quarantined history is preserved on the next registry write instead of being replaced with an empty collection, so a parser defect cannot destroy user history.

## Server and API boundary

Add machine-prefix-compatible routes:

- `GET <prefix>/recent-projects` lists the ordered `RecentProjectEntry[]`;
- `POST <prefix>/projects/:projectId/recent` touches a registered project and returns the resulting ordered `RecentProjectEntry[]`;
- `DELETE <prefix>/recent-projects/:entryId` removes a closed entry and returns the resulting ordered `RecentProjectEntry[]`.

Each route is registered locally twice, for `/api` and `/api/machines/local`, matching how the existing local project routes are registered. All browser references follow the repository's application-relative URL convention and use the existing machine prefix helper. Dynamic route segments are encoded once at the browser boundary. The browser client strictly parses every recent-history response.

Registration remains on the existing Add Project operation. A successful new registration updates the project registry and its history entry in the same serialized store operation. The existing project response remains compatible; the client then refreshes recent history.

A touch resolves the current registered project on the server rather than accepting an arbitrary path or name from the browser. It returns the authoritative ordered history collection. Unknown project IDs return 404.

Removal is allowed only while the history path is unregistered. If another client registers the path before removal reaches the server, the server rejects removal with `409`. An unknown history ID returns `404`. The client refreshes history and renders the entry as registered.

Reopening does not need a separate server operation. It uses the existing Add Project API with the stored path and name and without directory creation. Registration canonicalizes and validates the path as it does today.

### Federation allowlist

All three routes must be added to `FEDERATED_HTTP_ROUTES` in `src/shared/federatedRoutes.ts`. That constant is an explicit allowlist, and the machine proxy only forwards paths it contains, so omitting them makes Recent Projects return 404 on every remote machine while local behavior still looks correct. Because per-machine history is a core guarantee of this feature, the allowlist entries are required, not optional follow-up work.

The existing federated route contract test must be extended to cover the new recent-history entries, in the same style it already uses for other route families. No new WebSocket route is introduced.

With those entries present, remote requests use the existing machine federation boundary, so each remote PI WEBUI instance reads and writes its own machine-local history.

## Client ownership and concurrency

Introduce a focused recent-project controller. It owns:

- loading history for the selected machine;
- `loading`, `ready`, and `failed` state;
- serializing client-originated touches and removals;
- skipping a touch when the target is already newest;
- applying authoritative mutation responses;
- refreshing after registration and reopening;
- suppressing responses from a previously selected machine;
- reporting non-blocking background touch failures.

Touching history is secondary to the action that caused it. The controller records work only after the primary session, terminal, or task action has been accepted. A history failure must not cancel, fail, or roll back that successful work. It is reported through the existing background-error surface, and a later touch or reload can reconcile state.

The controller serializes mutations per selected-machine scope. This prevents an older full-list response from overwriting a newer client mutation. Server-side store serialization remains authoritative across clients.

`PiWebUiApp` supplies one intention-revealing `recordProjectWork(projectId)` callback at the relevant user-action boundaries. Workspace task and terminal-command contributions receive the behavior through their existing host wrappers rather than writing history directly.

Terminal keystrokes are a hot path: the terminal panel sends one input message per keystroke over its WebSocket. `recordProjectWork` therefore begins with a cheap synchronous check against the controller's last known order and returns immediately when the project is already newest, so typing performs no request and no persistence write. That client check is an optimization only; the store's path dedupe remains the authority when client state is stale.

## Workspace-panel architecture

The current workspace panel assumes every tab has a `WorkspacePanelContext`, which cannot represent a machine-level history tab when no workspace exists. Resolve tabs at the app-shell boundary into an internal presentation model with already-bound rendering and badge callbacks:

```typescript
interface ResolvedWorkspacePanelTab {
  id: QualifiedContributionId;
  title: string;
  icon?: TemplateResult;
  badge?: string | number | TemplateResult;
  render(): TemplateResult;
}
```

`PiWebUiApp` always contributes Recent Projects when a machine is selected. When a workspace is selected, it additionally resolves existing core and plugin workspace contributions against the normal `WorkspacePanelContext`. `WorkspacePanel` renders only the resolved tab model and no longer has to fabricate a workspace context for global content.

This is an internal host adaptation. It does not change the public plugin contribution contract.

Recent Projects is ordered first. If no workspace exists and the remembered tool refers to a workspace-only panel, the host displays Recent Projects as the available fallback without overwriting the remembered workspace tool. Selecting Recent Projects explicitly stores its qualified tool ID through the existing selection path.

Its tab ID is `core:recent-projects`. This is a durable value rather than an implementation detail: the selected tool is persisted in the URL route and in per-machine navigation memory, and the app shell mirrors the selected tool into `mainView`. Changing it later would invalidate stored routes and remembered navigation.

Existing controllers deliberately force the workspace tool during file and diff selection, so opening a file or a diff switches away from Recent Projects to Files or Git. That behavior is expected and unchanged.

## Panel interaction

The tab uses the familiar History icon (a counterclockwise arrow around a clock) with the tooltip and accessible name **Recent Projects**.

The panel body is a compact, vertically scrollable list. Each row shows:

- project name as the primary label;
- full machine-local path as secondary text, constrained without horizontal overflow and available in full through its title;
- the existing project activity indicator when the matching registered project has active session or terminal work;
- a subtle **Closed** status when no registered project matches the path.

The server-provided MRU order is rendered directly. Activity indicators never create a second client-side ordering rule. There are no cards and no per-row action controls.

The list supports pointer and keyboard activation with visible focus. An empty ready state says **No recent projects**. A failed load shows a compact error and **Retry** action. Loading does not replace the tab or resize the panel header.

Selecting a registered entry delegates to the existing project-selection and navigation flow. That selection does not touch history.

## Closed-entry dialog

Selecting a closed entry opens an accessible modal decision dialog. It identifies the project by name and path and explains only that it is no longer registered; it does not claim that the directory is missing.

The actions are:

- **Reopen** - primary action; register the saved path and name without creating a missing directory.
- **Remove from history** - remove this closed history entry.
- **Cancel** - dismiss without mutation.

Escape and the dialog close affordance behave as Cancel. Focus starts on Reopen, remains contained while the modal is open, and returns to the activated history row when the dialog closes and that row still exists.

On successful reopen, PI WEBUI reuses the history record matched by canonical path, moves it to the top as a registration event, closes the dialog, and follows the existing project-selection flow. If another client already reopened the same path, Add Project resolves to that registered project and the outcome is still successful.

If reopening fails because the machine is unavailable, the directory is missing, access is denied, or registration validation fails, the dialog stays open, retains the entry, and shows the specific error. The user can retry, remove the entry, or cancel.

Removing an entry from this explicit dialog needs no second confirmation or Undo. If removal loses a race with registration, the dialog closes only after refreshing the entry into its registered state and reporting that it can no longer be removed as closed history.

## Error handling

- A remote-machine history load failure affects only the Recent Projects body and exposes Retry.
- Registration remains authoritative for path existence, canonicalization, directory checks, and permissions.
- History-touch failures are non-blocking secondary failures and use the existing background-error reporting surface.
- Registration and reopen failures remain blocking for those explicit operations and are shown at the interaction boundary that initiated them.
- Stale machine-scoped responses cannot replace history for the newly selected machine.
- A project catalog update immediately reconciles registered versus Closed rendering by canonical path without rewriting history.

## Verification

Follow test-driven development and use the smallest test layer that proves each contract.

### Store and service tests

- load existing project documents with no history field;
- insert a newly registered project at the top atomically;
- preserve IDs and deduplicate touches by canonical path;
- use an injected clock for deterministic timestamps;
- update names, reorder entries, and evict entry 21;
- preserve history through single-project close, close-tree, pin, and unpin;
- relink a reopened path without duplicating history;
- match history paths with the same rule that dedupes registration, including a trailing-separator variant and a symlinked path that resolves to an already-registered directory;
- round-trip history through every write path, proving add, close, close-tree, pin, and unpin cannot drop it;
- isolate malformed optional history from valid registered-project reads, and preserve quarantined history through a later registry write;
- reject touch for an unknown project and removal for a currently registered path.

### Route and browser API tests

- map list, touch, remove, `404` for unknown project or history ID, `409` for removing a registered path, and persistence failures to strict contracts;
- register each route for both `/api` and `/api/machines/local`;
- extend the federated route contract test so the three recent-history routes are allowlisted and no recent-history WebSocket is added;
- encode project and history IDs at the browser boundary;
- cover local, explicit-local-machine, and federated remote paths;
- reject malformed response fields, timestamps, and collection shapes.

### Controller tests

- load and reset state per selected machine;
- suppress stale loads and mutations after machine changes;
- serialize mutation responses and apply authoritative order;
- skip redundant touches while the target is newest, proving repeated terminal input issues no request;
- still reorder correctly when the client's newest-entry belief is stale, leaving the store authoritative;
- refresh after registration and reopening;
- preserve successful primary work when a touch fails;
- expose load failure and Retry without losing machine scope.

### Component and host tests

- render MRU name, path, activity, and Closed state without row action controls;
- activate registered entries through the supplied selection callback;
- open the closed-entry dialog and cover Reopen, Remove from history, Cancel, Escape, focus, and error retention;
- render loading, empty, and failed states accessibly;
- keep Recent Projects available without a workspace;
- keep `core:recent-projects` as the persisted tool ID through route and navigation-memory round-trips;
- switch away to Files or Git when file or diff selection forces the workspace tool;
- keep existing plugin visibility and workspace-context behavior unchanged;
- preserve remembered workspace-tool selection when Recent Projects is only a fallback.

Use real DOM interaction for focus, keyboard, dialog, and accessible-name behavior where practical. TemplateResult handler extraction is only appropriate for narrow event-wiring checks where a DOM harness would be disproportionate.

Check rendered geometry with a headless Chromium CDP probe at desktop and narrow viewports, following the repository's existing CDP layout-probe practice. Verify tab overflow, long paths, list scrolling, dialog geometry, focus visibility, and absence of overlapping text or controls. `npm run capture:screenshots` is a documentation-asset generator with fixed viewports and a fixed demo session; it is not a per-feature layout harness and does not verify this panel.

Run focused tests first, followed by typecheck and lint, `npm run verify:fast`, and the serial `npm run verify` before merge.

## Release and documentation

This is a backward-compatible new user-facing capability and requires a **minor Changeset** for `@hyperdreamer/pi-webui`. Do not edit `CHANGELOG.md` manually.

The feature adds no user-editable configuration. Keep `README.md` unchanged. The design and implementation plan belong under `docs/superpowers`; no separate user guide is required for this self-explanatory interaction unless implementation uncovers an operational caveat that users must know.

## Scope boundaries

- No combined cross-machine history view.
- No user-configurable history limit; the limit is 20.
- No migration backfill from projects, sessions, terminals, or activity state that predates this feature.
- No per-row close button, remove button, overflow menu, pinning, search, or sorting control.
- No reorder on selection, browsing, assistant output, terminal output, polling, or activity-indicator changes.
- No filesystem deletion, session shutdown, terminal shutdown, or workspace deletion.
- No automatic recreation of a missing directory during reopen.
- No public plugin API change.
- No session-daemon protocol, session-runtime ownership, or session lifecycle change.
- No README expansion or manual changelog editing.
