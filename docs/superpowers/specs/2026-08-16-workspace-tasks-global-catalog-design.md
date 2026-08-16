# Workspace Tasks Global Catalog Design

**Date:** 2026-08-16

## Goal

Extend the bundled Workspace Tasks plugin so users can promote selected tasks into a machine-global catalog. Global tasks are independently editable from every project on the same machine and run in the currently selected workspace root. Project-local tasks remain stored in `<project>/.pi-webui/tasks.json`.

The feature also adds scope tabs and expandable task groups to the existing Tasks panel. It preserves the version 1 task schema for project files and uses a versioned global catalog nested under the machine's PI WEBUI configuration.

## Approved Product Decisions

- A task marked **Available in all projects on this machine** is promoted: the project definition is removed and one machine-global definition is created.
- A global task is independently editable from any project on that machine; it is not a link to an originating project.
- Global and project tasks are separate namespaces. Equal IDs may coexist, but the UI always identifies scope.
- Both scopes execute in the currently selected workspace root through the existing terminal runner.
- New tasks default to project scope.
- Scope changes on an existing task require confirmation because the source definition is removed.
- Promotion or demotion is blocked when the destination namespace already contains the same task ID. The source remains untouched.
- A partial move failure offers **Retry move** and **Refresh**. The original source snapshot is retained for retry; a retry never silently overwrites later edits.
- Task groups use native disclosure behavior like Workspace Memory. Groups start collapsed and retain their open state in browser memory while the panel remains mounted.
- The list uses **All**, **Global**, and **Project** tabs. The All tab shows explicit Global and Project headings.
- The editor uses the compact **Available in all projects on this machine** checkbox rather than a second selector control.

## Scope And Identity Model

The existing task value remains:

```typescript
interface WorkspaceTask {
  id: string;
  title: string;
  command: string;
  description?: string;
  group?: string;
  confirm: boolean;
}
```

The storage scope is represented outside the task value:

```typescript
type WorkspaceTaskScope = "global" | "project";

type WorkspaceTaskRef = {
  scope: WorkspaceTaskScope;
  id: string;
};
```

No scope field is written into `.pi-webui/tasks.json` or into individual task objects. This keeps existing project files valid and lets the two namespaces use the same parser and serializer.

The global catalog is stored in machine-global PI WEBUI config under the Workspace Tasks plugin settings:

```json
{
  "plugins": {
    "workspace-tasks": {
      "settings": {
        "globalTasks": {
          "version": 1,
          "tasks": []
        }
      }
    }
  }
}
```

`globalTasks` is optional. An absent value is equivalent to an empty version 1 catalog. If present, it must be an object with `version: 1` and a valid task array. The global catalog has its own namespace and ordering; project-file task order remains independent.

## Architecture

### Core WorkspaceTasksController

A core-owned `WorkspaceTasksController` follows the existing Memory and Learned Skills controller pattern. It owns selected machine/project/workspace scope, asynchronous loading, stale-result suppression, and callbacks for global catalog mutations. The controller is the only browser-side module that talks to the global-task client API.

The controller exposes a typed, bundled-only state shape to the Task Plugin. The public plugin API does not gain arbitrary HTTP access and the plugin does not import `src/client` internals. The adapter is analogous to the existing bundled Memory context: a local type describes the subset of core state and callbacks consumed by the bundled plugin.

The controller state has independent source states so one catalog can remain usable when the other fails:

```typescript
type WorkspaceTasksCatalogState =
  | { kind: "loading" }
  | { kind: "loaded"; config: WorkspaceTasksConfig; revision?: string }
  | { kind: "missing"; message: string; hint: string }
  | { kind: "invalid"; message: string; hint: string; detail: string }
  | { kind: "unavailable"; message: string; hint: string; detail?: string }
  | { kind: "error"; message: string };

interface WorkspaceTasksWorkspaceState {
  project: WorkspaceTasksCatalogState;
  global: WorkspaceTasksCatalogState;
  refreshError?: string;
}
```

The controller exposes this shape to the bundled adapter. Internal request generations and operation bookkeeping remain private, but the adapter always receives independent project and global states with these five observable categories.

The controller:

- keys requests by machine ID, project ID, workspace ID, and workspace path;
- coalesces an in-flight refresh for the same selected scope;
- invalidates generations on machine/workspace changes and disposal;
- never publishes a response captured for a stale scope;
- provides `refresh()` and global-catalog mutation callbacks to the panel;
- requests a host render after async state changes;
- keeps expansion state out of the controller because it is panel presentation state.

Project loading continues through the existing `WorkspaceFiles` adapter and `workspaceTasksClient.ts`. Global loading uses the dedicated machine-scoped API client described below. Existing project-task conflict guards remain in force.

### Server global-catalog module

A server module owns parsing, validation, projection, and mutation of `plugins.workspace-tasks.settings.globalTasks`. Its interface is small:

```typescript
interface GlobalWorkspaceTasksService {
  read(): Promise<GlobalWorkspaceTasksResponse>;
  replace(input: ReplaceGlobalWorkspaceTasksInput): Promise<GlobalWorkspaceTasksResponse>;
}
```

The concrete implementation receives the shared `PiWebUiConfigMutationCoordinator`. Reads return the catalog and an opaque revision. Writes compare `expectedRevision` inside the coordinated transaction before constructing or saving the next config. A mismatch throws a typed conflict and performs no write. The service preserves all unrelated global config and all unrelated Workspace Tasks settings.

The revision is opaque to clients. It may be derived from the coordinator's persisted revision/fingerprint or a dedicated catalog revision, but clients must only echo it. It must change after a successful global-catalog mutation and remain stable for an unchanged catalog. The response never exposes filesystem paths or raw config internals.

The global parser reuses the task-domain parser and rejects malformed task values with a safe validation response. A malformed global catalog is reported as invalid and is not silently replaced by an empty catalog. This prevents a bad config from being destroyed by a later project edit.

### HTTP and federation

Register local routes under both the ordinary local API and the explicit local-machine alias:

```text
GET /api/workspace-tasks/global
PUT /api/workspace-tasks/global
GET /api/machines/local/workspace-tasks/global
PUT /api/machines/local/workspace-tasks/global
```

The machine proxy exposes the corresponding remote paths:

```text
GET /api/machines/:machineId/workspace-tasks/global
PUT /api/machines/:machineId/workspace-tasks/global
```

The paths are added to the shared federated HTTP allowlist. The gateway validates and forwards portable JSON; the selected machine performs the actual config mutation using its own coordinator. Remote errors preserve status classification without leaking local filesystem details.

The client creates application-relative paths, encodes dynamic machine IDs, and resolves each URL once through the existing HTTP request boundary. No plugin source uses raw absolute `/api` references or direct `fetch`.

### Global catalog client

A typed client module parses the global response and exposes:

```typescript
read(machineId: string): Promise<GlobalWorkspaceTasksResponse>;
replace(machineId: string, input: ReplaceGlobalWorkspaceTasksInput): Promise<GlobalWorkspaceTasksResponse>;
```

It maps HTTP 409 to a typed revision conflict and 400/404/5xx to scoped unavailable or validation errors. It does not retry writes automatically. The controller owns refresh-after-failure and Retry move behavior.

## Cross-Catalog Moves

A scope change is a move, not a copy. The browser must never independently write the project file and global config as two unrelated UI operations.

The move operation uses one server-owned `POST /api/workspace-tasks/move` endpoint, plus the `/api/machines/local/workspace-tasks/move` alias and the federated `/api/machines/:machineId/workspace-tasks/move` proxy route. Its request carries the selected project/workspace identity, source scope, source snapshot/revision, destination task value, and the expected destination namespace state. The external behavior is fixed:

1. Validate the task value and source identity.
2. Re-read and verify the project source snapshot when the source is project scope.
3. Read and verify the global revision when the source or destination is global.
4. Check destination ID uniqueness before changing either catalog.
5. Apply the source removal and destination insertion/replacement in a controlled sequence.
6. Verify both resulting catalogs.
7. Return both authoritative catalog states and the new global revision only after verification succeeds.

A successful move publishes one authoritative snapshot for each catalog and closes the editor. A destination collision returns a typed conflict before any write. The error names the destination scope and ID; the source remains unchanged.

The two underlying persistence stores do not provide one physical transaction. Therefore, a second-write failure is treated as an uncertain move, never as success. The server returns a typed partial-failure result that identifies which side was confirmed and which side needs recovery without exposing secrets or raw stack traces. The controller then:

- refreshes both catalogs;
- retains the original source snapshot and task draft;
- displays **Move incomplete** with **Retry move** and **Refresh**;
- allows Retry only when the retained source and destination revisions/snapshots still match what the move originally observed;
- blocks Retry after any intervening change and requires a new Refresh/review;
- never overwrites a newer task definition automatically.

If recovery cannot safely determine the source/destination state, the panel remains mutation-blocked until Refresh establishes authoritative states. The user can then resolve the catalogs manually. A failed move never affects terminal runs.

## Panel Behavior

### Tabs and catalogs

The toolbar retains Add Task, Refresh, and Open Terminal. Below the helper text, the panel renders three scope tabs:

- **All**: both catalogs, with `Global tasks` and `Project tasks` headings;
- **Global**: only the machine-global catalog;
- **Project**: only the selected project's catalog.

Each tab shows a count for the currently available tasks. If one source is unavailable, the other source remains visible and the affected tab/catalog shows a scoped error. A global unavailable state does not hide project tasks; a project invalid or missing state does not hide global tasks.

Task rows show a scope badge where scope could otherwise be ambiguous, especially in All. Equal IDs are rendered as separate rows and remain independently actionable.

### Expandable groups

Tasks are grouped by their optional `group` value, preserving first-seen group order within each catalog. Ungrouped tasks use the existing ungrouped presentation. Each group is a native `<details>` element with:

- a semantic `<summary>`;
- a disclosure chevron matching Workspace Memory;
- the group title;
- a task count;
- a bounded body containing task rows.

Groups start collapsed. The panel captures open groups before rerender and restores them by `{ scope, group }`; duplicate group names in Global and Project therefore retain independent state. A group with no tasks is not rendered. Expansion is browser-local and is not serialized or synchronized between tabs.

Changing scope tabs filters the same in-memory group state rather than resetting all disclosures. Refresh, editor open/close, status updates, and successful mutations preserve expansion for groups whose scoped identity still exists; removed groups naturally disappear.

### Editor and scope checkbox

The existing Add/Edit form gains:

```text
[ ] Available in all projects on this machine
```

The checkbox is unchecked for a new task and checked when editing a global task. The editor header also displays a compact `Project task` or `Global task` badge.

For a new task:

- unchecked saves to the selected project file;
- checked saves directly to the global catalog;
- no promotion confirmation is needed because there is no source task to remove.

For an existing project task:

- leaving it unchecked edits the project catalog;
- checking it opens a confirmation explaining that the project definition will be removed and one machine-global definition created;
- confirmation starts the guarded move.

For an existing global task:

- leaving it checked edits the global catalog;
- unchecking it opens a confirmation explaining that the global definition will be removed and inserted into the selected project;
- confirmation starts the guarded move.

A global task always executes in the selected workspace root, so the editor help text and documentation must state that its definition is machine-global but its working directory is selection-dependent.

### Retry and Refresh

After a partial move failure, the editor remains visible with the original task draft. The status area explains that the move was incomplete and presents:

- **Retry move**: retries only against the retained source snapshot/revision;
- **Refresh**: discards the retained move context after confirmation when the draft is dirty, then loads authoritative catalogs;
- **Cancel**: leaves the panel refresh-gated and does not make the old state writable.

A normal global revision conflict uses the same refresh-gated conflict treatment as project task file conflicts. No stale draft is silently rebased.

## Async Ownership And Failure States

The controller and panel use separate generations:

- controller scope generation rejects responses from a prior machine/project/workspace;
- panel selection generation rejects completions after disconnect or context replacement;
- per-catalog request generation prevents an older refresh from overwriting a newer result;
- move generation prevents late success/failure from acting on a newer editor state.

All mutation buttons and Refresh are disabled during active writes or reads. Run remains available for a loaded task unless an existing terminal dispatch is active.

Failure states are scoped and explicit:

- `global unavailable`: project tasks remain usable; global creation/editing/moves are disabled with a retry path;
- `project unavailable`: global tasks remain usable; project creation/editing/moves are disabled with the existing workspace-file diagnostic;
- `global invalid`: global tasks are read-only until the global config is repaired outside this panel; this feature provides no global reset action, and the panel must not overwrite invalid global data with an empty catalog;
- revision conflict: no global write occurs; Refresh is required;
- destination collision: no source or destination write occurs; the editor remains open with the conflicting ID message;
- partial move: Retry move plus Refresh, retaining original snapshots;
- unexpected server error: scoped safe message, no automatic retry.

## Testing

### Pure domain tests

Extend task-domain tests for:

- scope-qualified task references;
- global catalog defaults and version validation;
- duplicate detection independently within each namespace;
- destination collision decisions;
- promotion/demotion transformations that preserve each catalog's order;
- group keys and expansion-state capture/restore for duplicate group names across scopes;
- editor draft normalization with the compact scope checkbox.

### Server tests

Add service and route tests for:

- missing global settings returning an empty version-1 catalog;
- valid global catalog parsing and canonical projection;
- invalid global catalog diagnostics without destructive fallback;
- successful revision-checked replacement;
- stale revision returning 409 with zero config mutation;
- preservation of plugin enablement, unrelated plugin settings, and unrelated global config;
- local and `/api/machines/local` aliases returning equivalent behavior;
- remote proxy allowlisting, path translation, status forwarding, and safe error mapping;
- destination ID collisions with no writes;
- successful promotion and demotion;
- source snapshot conflicts with no writes;
- second-write/verification failures classified as partial moves and never reported as success;
- retry rejection after an intervening source or destination change.

Use injected config coordinators and file adapters. Do not use the real user config or data directory in tests.

### Controller tests

Cover:

- loading project and global catalogs independently;
- stale machine/workspace responses;
- in-flight refresh coalescing;
- preserving usable tasks when the other source fails;
- global refresh and revision updates;
- move success, collision, revision conflict, partial failure, Retry move, and Refresh gating;
- no stale callback after disposal or panel disconnect.

Use controllable promises and fake client/file adapters. Do not use sleeps.

### Panel tests

Use real shadow-DOM interaction where practical. Cover:

- All/Global/Project tab rendering and counts;
- explicit scope headings and badges for duplicate IDs;
- native expandable groups, initial collapsed state, counts, and preserved `{scope, group}` expansion across rerenders;
- independent expansion for same group names in both scopes;
- compact checkbox defaults and global-task edit state;
- new global task creation;
- promotion and demotion confirmations;
- destination collision messages with source preservation;
- partial move status, Retry move, Refresh, and dirty-draft protection;
- independent availability of project tasks when global state fails and vice versa;
- existing project CRUD, run confirmation, multiline rendering, and focus/ARIA behavior.

### Browser and repository verification

Run focused task/domain, controller, route, and panel tests first. Then run typecheck and targeted ESLint for changed files. Perform a Chromium/CDP acceptance probe with long global and project task lists at desktop and narrow panel widths, exercising tabs, group disclosures, duplicate IDs, editor scope checkbox, promotion failure/retry, keyboard focus, and classic/dark/light theme tokens.

Finish with:

```text
npm run verify:fast
npm run verify
npm run build
npm run pack:dry
npm run changelog:status
git diff --check
```

The package dry run must include the compiled Workspace Tasks plugin and the synchronized Workspace Tasks documentation.

## Documentation And Release

Update the canonical Workspace Tasks sections in `docs/plugins.md` and `docs/plugins.html` to explain:

- project versus machine-global task scope;
- the All/Global/Project tabs;
- expandable task groups and retained browser-local expansion;
- the compact availability checkbox;
- promotion/demotion confirmation and destination ID conflicts;
- independent editing from any project on the selected machine;
- execution in the currently selected workspace root;
- revision conflicts, partial move Retry/Refresh behavior, and no silent overwrite;
- the existing trusted-shell warning and multiline one-terminal behavior.

Keep `README.md` unchanged and do not edit `CHANGELOG.md` manually.

Add a minor Changeset for `@hyperdreamer/pi-webui` describing machine-global Workspace Tasks, scope-aware browsing/editing, and guarded promotion/demotion recovery.

## Scope Boundaries

- Keep task config version 1; do not add a per-task scope field.
- No task search, templates, import/export, duplication, drag reorder, group-management surface, per-line status, retries for command execution, or timeout model.
- No arbitrary HTTP access added to the stable public plugin API.
- No global-task file outside PI WEBUI global config.
- No automatic last-write-wins behavior or silent conflict merging.
- No session-daemon protocol or runtime-ownership changes.
- No manual changelog editing.
