# Workspace Tasks Global Catalog Design

**Date:** 2026-08-16

## Goal

Extend the bundled Workspace Tasks plugin so users can promote selected tasks into a machine-global catalog. Global tasks are independently editable from every workspace on the same selected machine and execute in the currently selected workspace root.

The feature adds scope filters and expandable task groups to the Tasks panel. It preserves version 1 task files and stores the versioned global catalog in the selected machine's PI WEBUI configuration.

## Product Decisions

- A task marked **Available in all projects on this machine** is promoted: its workspace definition is removed and one machine-global definition is created.
- A global task is independently editable from any workspace on that machine. It is not a link to an originating workspace.
- Global and workspace catalogs are separate namespaces. Equal task IDs may coexist and remain independently actionable.
- Both scopes execute in the currently selected workspace root through the existing terminal runner.
- New tasks default to the workspace catalog.
- Changing scope for an existing task requires confirmation because the source definition is removed.
- A destination catalog containing the destination task ID blocks promotion or demotion before either catalog changes.
- A partial move offers **Retry move** and **Refresh**. Retry is enabled only after refresh confirms the destination-written phase for the retained original move context; the server must still confirm its live claim before it writes, so retry never guesses that a changed catalog belongs to the failed move.
- Task groups use native disclosure behavior. They start collapsed and retain open state in browser memory while the panel remains mounted.
- The list uses **All**, **Global**, and **Project** scope filters. The Project label is user-facing; its storage model is workspace-scoped, including separate Git worktree catalogs.
- The editor uses the compact **Available in all projects on this machine** checkbox rather than a second selector.
- The feature does not promise atomic conflict protection against arbitrary external editors. It protects coordinated PI WEBUI task mutations and detects observed external changes conservatively.

## Scope And Storage Model

### Workspace catalog

The local catalog is always rooted at the selected workspace:

```text
<selected-workspace>/.pi-webui/tasks.json
```

The main workspace normally makes this appear to be a project-root file. A Git worktree is a distinct workspace and therefore has its own `.pi-webui/tasks.json`. The service resolves the file from the route's `projectId` and `workspaceId`; it never substitutes the project root.

The UI continues to say **Project** because that is the familiar user-facing scope. Internal names, route contracts, cache keys, and mutation rules use **workspace** where storage identity matters.

### Task value and identity

The task value remains version 1 compatible:

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

Storage scope is outside the task value:

```typescript
type WorkspaceTaskScope = "global" | "workspace";

interface WorkspaceTaskRef {
  scope: WorkspaceTaskScope;
  id: string;
}
```

No scope field is written to workspace task files or individual task objects. Every panel action, focus target, running state, terminal metadata record, DOM attribute, and move request uses `WorkspaceTaskRef`, not a bare task ID.

String-only boundaries use `workspaceTaskRefKey(ref)`, defined as `` `${ref.scope}:${ref.id}` ``. The task ID grammar excludes `:`, so the key is collision-safe and reversibly parsed. DOM rows use this key in `data-task-ref`; focus and in-memory state retain the object form where practical. Terminal metadata stores separate `task.scope` and `task.id` fields rather than attempting to serialize an object.

### Global catalog

The global catalog is optional and lives in the selected machine's PI WEBUI config:

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

An absent `globalTasks` value is equivalent to the canonical empty version 1 catalog. If present, it must parse as a version 1 task catalog. Invalid global data is reported as invalid and is never replaced with an empty catalog by this feature.

The global service changes only `plugins.workspace-tasks.settings.globalTasks`. It preserves:

- plugin enablement and unknown fields on the `workspace-tasks` plugin entry;
- sibling Workspace Tasks settings;
- other plugin entries; and
- every unrelated global config setting.

### Shared task domain

The task schema, parser, canonical serializer, task-reference helpers, collision decisions, and move transformations have one source of truth: `src/shared/workspaceTasks.ts`.

The domain parser preserves the existing version 1 compatibility policy: unknown catalog or task fields may be accepted on read, but they are outside the semantic task projection and canonical writes drop them. Strict wire parsers reject unknown keys in newly owned request and result envelopes while delegating task values to this compatibility-preserving domain parser.

Server and core client code import `src/shared/workspaceTasks.ts` directly. Workspace Tasks plugin source imports `@pi-webui/workspace-tasks-domain`, a TypeScript path alias pointing to that canonical source. `scripts/build-plugins.mjs` explicitly transpiles the source to `dist/pi-webui-plugins/workspace-tasks/taskDomain.js` and rewrites the emitted alias import to `./taskDomain.js`. In watch mode it watches `src/shared/workspaceTasks.ts` and every declared shared-domain dependency in addition to plugin directories, rebuilding the colocated artifact before the plugin reloads. A structural build test verifies that the emitted plugin imports only its colocated artifact, and a watch-mode test proves a canonical-domain change regenerates that artifact before executing the shared parser fixtures. Server code never imports `pi-webui-plugins` source, and a runtime plugin module never imports into `src/` by relative path.

## Revisions And Conditional Writes

### Global revision

A successful global read returns an opaque `revision` that is a deterministic digest of the canonical semantic global catalog. It has these properties:

- absent and explicitly empty catalogs have the same revision;
- unchanged catalog content retains its revision across unrelated config writes;
- a semantic global catalog change produces a different revision; and
- a same-value replace is a no-op: it does not save config and retains the revision.

The revision is not the config mutation coordinator's speech-input revision or file fingerprint. The feature must not extend the coordinator's persisted schema solely to track global tasks. This avoids changing code shared with the long-lived session daemon and avoids a daemon restart requirement.

### Workspace revision

A loaded or missing workspace catalog returns an opaque exact-source revision. It represents the complete current source state, including missing versus present content. It is suitable for a workspace task replace or move precondition, but is not exposed as raw file content to the panel.

The workspace task service serializes PI WEBUI task mutations per selected workspace. Inside that authority it reads, validates the expected source revision, writes canonical content, and verifies the result before publishing it. This protects competing task operations issued through this feature.

The underlying filesystem does not provide a universal conditional rename against non-cooperating editors. A manual file change between the service's last check and write can still race. The service therefore treats failed verification as uncertain, refresh-gates the catalog, and the documentation states that external conflict detection is best-effort rather than atomic cross-process CAS.

## Architecture

### Server-owned task mutation module

A server-owned `WorkspaceTasksCatalogService` is the only authority used by Workspace Tasks UI mutations. It owns:

```typescript
interface WorkspaceCatalogAddress {
  projectId: string;
  workspaceId: string;
}

interface WorkspaceTasksCatalogService {
  readWorkspace(input: WorkspaceCatalogAddress): Promise<WorkspaceTasksCatalogResponse>;
  replaceWorkspace(input: ReplaceWorkspaceTasksInput): Promise<WorkspaceTasksCatalogResponse>;
  readGlobal(): Promise<GlobalWorkspaceTasksResponse>;
  replaceGlobal(input: ReplaceGlobalWorkspaceTasksInput): Promise<GlobalWorkspaceTasksResponse>;
  move(input: MoveWorkspaceTaskInput): Promise<MoveWorkspaceTaskResult>;
}
```

`WorkspaceCatalogAddress` resolves the selected workspace through `projectId` and `workspaceId`. The service uses the existing workspace path-safety and project/workspace resolution rules, rather than accepting a filesystem path from the browser.

The module has two internal adapters:

- a workspace-catalog adapter for safe workspace file reads, serialized PI WEBUI task writes, and post-write verification; and
- a global-catalog adapter using the shared `PiWebUiConfigMutationCoordinator` for each global read or mutation.

It also owns a process-local `MachineGlobalTasksMoveRegistry`. A registry claim is keyed by the managed global catalog identity and protects the whole global task catalog plus the participating workspace catalog while a move is in progress. The claim records an operation ID, workspace address, original and derived catalog pairs, and its phase. Reusing an operation ID with different request content is rejected only while its live claim exists. A `destination-pending` claim exists only while the operation lock holds the in-flight destination write; any competing mutation receives `move-in-progress`. Once the write resolves, the claim becomes `destination-written`; reads remain available so recovery can refresh authoritative state. A different move, any global mutation, and any mutation of the participating workspace are rejected while either phase is active; a retry with the same operation ID may reconcile its destination-written phase. Unrelated workspace mutations remain available.

Before rejecting a mutation blocked by a destination-written claim, the registry reconciles its claim against both stores. It clears a completed claim, and it clears an unrecognized claim after returning a manual-resolution conflict because that claim can no longer be resumed automatically. A pending claim is cleared on every operation exit unless its destination write resolved and transitioned it. The registry retains across requests only an exact owned destination-written/source-intact phase. Consequently an abandoned recoverable move deliberately blocks global mutations and participating-workspace mutations until it is retried, manually changed into a non-resumable state, completed, or the server process restarts; the UI surfaces this as move recovery pending rather than a generic busy state.

This protocol assumes the existing deployment model of one active PI WEBUI web/API route owner for a machine's config. Multiple web/API processes must not concurrently serve mutations for the same config: the process-local registry is deliberately not a distributed lock, and the no-journal design does not claim cross-process move serialization.

### Generic config mutation gate

A `WorkspaceTasksGlobalMutationGate` prevents first-party generic config writes from bypassing an active claim. `buildApp` creates it from the same registry and decorates the `PiWebUiConfigService` passed to both `registerConfigRoutes` and `registerLocalMachineConfigRoutes`. Before it calls the shared coordinator, the decorator asynchronously reconciles a destination-written claim against both stores so completed and unrecognized claims receive their defined recovery result. Inside the coordinator's synchronous mutation callback, it compares the before and proposed after canonical global-task projections and performs a final synchronous in-memory claim assertion immediately before `savePiWebUiConfig`. It permits unrelated config changes that preserve that projection, but while either move phase is active it rejects a changed global-task projection with a safe `409` `WorkspaceTasksMoveRecoveryPendingError`. Both generic config route families map that error to their existing safe config-error envelope; remote callers receive the target's same `409` through the machine proxy.

The Workspace Tasks global adapter performs the same asynchronous recovery reconciliation before requesting the coordinator and is the only privileged writer allowed to change the projection for its matching move operation. Authorization checks are not preflight-only: the generic gate and global adapter make a final synchronous registry assertion in the coordinator mutation callback immediately before save, while the workspace adapter makes its final assertion inside its per-workspace write serialization. Every future first-party config route or service that can change `plugins.workspace-tasks.settings.globalTasks` must use the same gate; external file edits remain outside this guarantee. The gate is in-memory and adds no coordinator schema or session-daemon protocol change.

### Workspace file mutation gate

A `WorkspaceTasksWorkspacePathGate` prevents the first-party workspace file explorer from bypassing a claim through `PUT`, `DELETE`, or `POST .../file/move` on a participating `<workspace>/.pi-webui/tasks.json`. `registerWorkspaceExplorerRoutes` receives the gate for ordinary and `/api/machines/local` registrations. After the existing safe workspace-path resolver canonicalizes the requested target, the route delegates a task-catalog-targeting operation to the gate's shared per-workspace mutation serialization; a move checks both its resolved source and destination. Inside that serialization, the gate performs any needed reconciliation and makes its final claim assertion immediately before the filesystem operation. Reads remain available, and mutations of any other file or workspace remain available.

The gate must not compare untrusted path strings. It uses the same safe path-resolution and workspace-address rules as the task adapter, maps an active pending claim to a safe `409` `move-in-progress` response and a destination-written claim to a safe `409` recovery-pending response, and runs after route identity resolution. The task adapter is the matching privileged writer. Existing external editors, Git operations, and any direct filesystem change remain best-effort external writers rather than a bypass the server claims to serialize.

The coordinator transaction protects only the global config phase. It is never held across an asynchronous workspace file operation. A move is therefore a controlled reconciliation protocol, not a database transaction.

### Global catalog service

The global adapter parses, validates, projects, and mutates `plugins.workspace-tasks.settings.globalTasks`. It uses the shared config coordinator for every compare-and-save operation. Its supported semantic projection has the same 512 KiB canonical JSON ceiling as a submitted task catalog; an oversized existing global catalog is an invalid read result and cannot be mutated through this feature.

A replace compares `expectedRevision` inside the coordinator transaction before constructing the next config. A mismatch returns a typed conflict and performs no config write. A malformed existing global catalog returns an invalid read result and blocks all global writes, including moves, until repaired outside the panel.

Global parser and route errors are safe. They never expose a config path, raw config object, stack trace, or unrelated settings.

### Move protocol

A scope change is a server-owned move. The browser never independently writes a workspace file and global config as two unrelated operations.

The wire body contains a source reference distinct from the editable destination value and includes the original semantic catalog projections needed to derive exact post-states:

```typescript
type WorkspaceCatalogExpectation =
  | { kind: "loaded"; revision: string; config: WorkspaceTasksConfig }
  | { kind: "missing"; revision: string };

type GlobalCatalogExpectation = {
  kind: "loaded";
  revision: string;
  config: WorkspaceTasksConfig;
};

type MoveWorkspaceTaskSource =
  | {
      ref: { scope: "workspace"; id: string };
      expectedCatalog: Extract<WorkspaceCatalogExpectation, { kind: "loaded" }>;
    }
  | {
      ref: { scope: "global"; id: string };
      expectedCatalog: GlobalCatalogExpectation;
    };

type MoveWorkspaceTaskDestination =
  | { scope: "workspace"; expectedCatalog: WorkspaceCatalogExpectation; task: WorkspaceTask }
  | { scope: "global"; expectedCatalog: GlobalCatalogExpectation; task: WorkspaceTask };

type MoveWorkspaceTaskIntent = "start" | "retry";

interface MoveWorkspaceTaskRequest {
  operationId: string;
  intent: MoveWorkspaceTaskIntent;
  source: MoveWorkspaceTaskSource;
  destination: MoveWorkspaceTaskDestination;
}

type MoveWorkspaceTaskInput = WorkspaceCatalogAddress & MoveWorkspaceTaskRequest;
```

The HTTP route supplies `projectId` and `workspaceId`; they are not duplicated in the JSON body. The route adapter combines them with the parsed request before calling the service. `operationId` is a canonical UUID generated for `intent: "start"`; the controller retains it only for a same-operation `intent: "retry"`. Expectations contain supported semantic task data and opaque revisions, not raw file bytes, filesystem paths, or global config objects. Every submitted task catalog config is limited to 512 KiB of UTF-8 JSON. Replace routes have a 576 KiB body limit; the move route has a 1.75 MiB body limit for its two bounded expectations, destination task, and envelope. The wire parser rejects an oversized destination task, and the move service rejects a derived post-write catalog whose canonical JSON would exceed 512 KiB. A workspace expectation must also fit the existing 512 KiB readable-task-file limit; binary, truncated, invalid, or unavailable workspace files cannot enter a move. `source.ref.id` must resolve to exactly one task in its expected source catalog, and source and destination scopes must differ because same-scope edits use replace rather than move.

Before writing, the service validates that each expected revision describes its submitted expectation. It applies pure move transformations to those expectations to derive the one permitted destination-after catalog and source-after catalog, including their deterministic post-write revisions. This gives a repeated request enough evidence to reject unrelated edits without a durable journal.

The service then follows one fixed destination-first protocol:

1. Parse the request, acquire the registry's short-lived operation lock, derive the exact expected pristine, destination-applied, and complete catalog pairs, and validate `intent` against the requested transition.
2. Read both authoritative catalogs and compare their full supported projections and revisions with those derived pairs.
3. For a pristine pair, accept only `intent: "start"` with no live claim for that operation ID: reject a destination ID already present in the expected destination catalog; otherwise create a `destination-pending` claim and issue the destination write. Once that write resolves successfully, transition the claim to `destination-written` before verification. A known pre-write failure clears the pending claim and returns unavailable; an uncertain write result or unreadable verification returns unknown-outcome without source removal. An exact verification preserves the destination-written claim.
4. For a destination-applied pair, a retransmitted `start` with the same live `destination-written` claim returns `partial` without writing. Only `intent: "retry"` with that same live claim removes the source and verifies the exact complete pair. A pair without the live matching claim is an unowned intermediate state and receives zero writes.
5. For a complete pair, either intent returns `completed` without writing and clears a matching live claim.
6. A `retry` observing the pristine pair returns `retry-pristine` with zero writes and clears any live claim for that operation. A retransmitted `start` observing pristine with a live claim returns `unrecognized-state`, clears that stale claim, and performs zero writes. Every other pair, including any unrelated catalog edit, is a refresh-gated conflict with zero further writes. Do not create a claim for an unowned intermediate state, and clear any stale mismatched claim before returning the conflict.

A repeated request is a reconciliation, not a second move attempt. Its intent and authoritative state recognize only these cases:

| Observed catalog pair | Intent and claim state | Result |
| --- | --- | --- |
| exact original source, exact original destination | `start`, no live claim for that operation | create pending claim and perform destination-first move |
| exact original source, exact original destination | `start`, live claim for that operation | `unrecognized-state` conflict; clear stale claim; no write |
| exact original source, exact original destination | `retry`, any claim state | `retry-pristine` conflict; no write |
| exact original source, exact derived destination-after state | `start`, live matching `destination-written` claim | return `partial`; no write |
| exact original source, exact derived destination-after state | `retry`, live matching `destination-written` claim | resume source removal |
| exact original source, exact derived destination-after state | either intent, no matching `destination-written` claim | unowned intermediate state; manual resolution only |
| exact derived source-after state, exact derived destination-after state | either intent, any claim state | return completed idempotently without writing |
| any other combination | either intent, any claim state | return refresh-gated conflict; do not write |

Promotion writes the global destination first and then removes the workspace source. Demotion writes the workspace destination first and then removes the global source. This avoids a partial state in which neither catalog contains the task.

After the destination write is confirmed, a failed source write or either verification always rereads both catalogs before choosing a result. An exact complete pair returns `completed`; an exact destination-written/source-intact pair with the live matching claim returns `partial`; an unavailable reread returns `unknown-outcome`; and every other pair returns a zero-write refresh-gated conflict and clears any mismatched claim. The panel retains the original draft and request context for `partial` and unknown outcomes. A guarded retry sends the same semantic input with `intent: "retry"` and the server performs the phase reconciliation above.

A browser, gateway, or remote transport failure after dispatch is an **unknown outcome**. The controller does not retry automatically or assume failure. It refreshes both catalogs and retains the move context. If that refresh proves the exact complete pair, the controller resolves the move locally, publishes the authoritative catalogs, clears recovery state, and closes the editor without sending another write. If it proves the destination-written phase for the retained context, the controller offers `intent: "retry"`; that request is the server-authoritative claim check and performs source removal only when its live matching claim exists. If it proves the pristine pair, the controller keeps the draft, ends recovery for that operation ID, and requires the user to reconfirm a new `intent: "start"` move. Any other pair, including a server-reported unowned intermediate state, remains refresh-gated and requires manual resolution.

No durable move journal is introduced. The live process-local claim supplies provenance for an intermediate state; exact catalog states supply the remaining reconciliation proof. A process restart loses claims. After restart, the original controller may still offer one guarded Retry for its retained destination-written/source-intact context, but the server rejects it as an unowned intermediate state with zero writes because no live claim remains. A fresh client with no original move context sees only the authoritative catalogs and may resolve duplicate or missing definitions manually through ordinary task edits. A complete pair can still be reported as already completed because doing so performs no write. Operation IDs have no provenance meaning after their live claim is cleared or the process restarts. External changes that produce any other pair also stop automatic recovery rather than guessing.

Move validation failures and a known unavailable result before destination-write acknowledgement retain the draft and show an inline scoped error; they create no recovery record because the service proved it did not remove the source. `invalid-catalog` and every write `unknown-outcome` trigger an authoritative refresh before the controller decides whether the editor is writable. Source changes, destination collisions, retry-pristine, and unowned states never cause automatic compensation or a second start request.

### Wire results and HTTP status handling

All new wire types live with shared API types and have strict parsers at the transport boundary. Owned request and result envelopes reject unknown keys; outer envelopes remain additive where compatibility requires it. Task values retain the version 1 domain compatibility policy described above.

Replace requests are explicit CAS contracts:

```typescript
interface ReplaceWorkspaceTasksRequest {
  expectedRevision: string;
  config: WorkspaceTasksConfig;
}

type ReplaceWorkspaceTasksInput = WorkspaceCatalogAddress & ReplaceWorkspaceTasksRequest;

interface ReplaceGlobalWorkspaceTasksInput {
  expectedRevision: string;
  config: WorkspaceTasksConfig;
}
```

Workspace route parameters are combined with `ReplaceWorkspaceTasksRequest` by the route adapter; they are not duplicated in its JSON body.

Successful reads use explicit catalog states:

```typescript
type GlobalWorkspaceTasksResponse =
  | { kind: "loaded"; config: WorkspaceTasksConfig; revision: string }
  | { kind: "invalid"; message: string; hint: string; detail: string };

type WorkspaceTasksCatalogResponse =
  | { kind: "loaded"; config: WorkspaceTasksConfig; revision: string }
  | { kind: "missing"; message: string; hint: string; revision: string }
  | { kind: "invalid"; message: string; hint: string; detail: string }
  | { kind: "unavailable"; message: string; hint: string; detail?: string };
```

A global missing value projects as `loaded` with an empty catalog and a required revision. A workspace missing file remains a distinct `missing` state because creation is a supported workspace action.

Move results use a status-aware discriminated contract:

```typescript
type MoveWorkspaceTaskResult =
  | { kind: "completed"; operationId: string; workspace: WorkspaceTasksCatalogResponse; global: GlobalWorkspaceTasksResponse }
  | { kind: "partial"; operationId: string; phase: "destination-written"; workspace: WorkspaceTasksCatalogResponse; global: GlobalWorkspaceTasksResponse }
  | { kind: "conflict"; reason: "source-changed" | "destination-collision" | "invalid-catalog" | "unrecognized-state" | "unowned-intermediate-state" | "move-in-progress" | "retry-pristine"; message: string }
  | { kind: "validation"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "unknown-outcome"; message: string };

type WorkspaceTasksConflictReason =
  | "revision-conflict"
  | "invalid-catalog"
  | "move-in-progress"
  | "move-recovery-pending"
  | "unowned-intermediate-state";

type WorkspaceTasksFailureResponse =
  | { kind: "validation"; message: string }
  | { kind: "conflict"; reason: WorkspaceTasksConflictReason; message: string }
  | { kind: "unavailable"; message: string; retryable: boolean }
  | { kind: "unknown-outcome"; message: string };

type WorkspaceTasksRequestResult<T> =
  | { kind: "success"; value: T }
  | WorkspaceTasksFailureResponse;
```

Service methods throw typed domain errors for known failures. Routes map those errors to `WorkspaceTasksFailureResponse`; a move route may instead return its typed `partial` or `conflict` body. The core client uses one status-aware JSON request helper for read, replace, and move calls. It returns `WorkspaceTasksRequestResult<T>` for reads and replaces and parses `MoveWorkspaceTaskResult` on every known move status. The controller maps read failures to the affected source's unavailable/error state, direct revision conflicts to refresh-gated UI state, direct `invalid-catalog` conflicts to an authoritative refresh, `move-in-progress` and `move-recovery-pending` to a scoped recovery-pending message, and `unowned-intermediate-state` to manual-resolution guidance. Every write `unknown-outcome` triggers an authoritative refresh with no automatic retry. The bundled plugin never receives arbitrary HTTP access and never imports `src/client` internals.

Status mapping is:

- `200`: successful read, replace, or completed move response;
- `400`: `validation` failure with a safe parsed body;
- `413`: typed `validation` failure for a route or gateway body-cap breach, with no service write attempted;
- `409`: direct replace conflict with a typed `WorkspaceTasksConflictReason`, destination collision, invalid catalog, partial move, unowned intermediate state, or other move conflict with a typed safe body;
- `404`: selected route or remote capability unavailable;
- `503`: a typed busy/unavailable result known to have performed no write; and
- `502`, `504`, network failure, or unexpected `5xx`: unavailable for reads but `unknown-outcome` for any dispatched write, followed by authoritative refresh and never automatic retry.

### Core WorkspaceTasksController

A core-owned `WorkspaceTasksController` owns selected machine/project/workspace scope, asynchronous loads, stale-result suppression, command callbacks, and catalog state. It is the only browser-side module that talks to Workspace Tasks HTTP clients.

The controller has separate cache identities:

- workspace catalog state is keyed by machine ID, project ID, workspace ID, and workspace path;
- global catalog state is keyed by machine ID only; and
- an active selection combines both keys for panel publication and stale-result checks.

The controller exposes a bundled-only state shape. It keeps source revisions, move preconditions, request generations, and operation bookkeeping private.

```typescript
type WorkspaceTasksCatalogState =
  | { kind: "loading" }
  | { kind: "loaded"; config: WorkspaceTasksConfig; refreshing: boolean; refreshError?: string }
  | { kind: "missing"; message: string; hint: string; refreshing: boolean; refreshError?: string }
  | { kind: "invalid"; message: string; hint: string; detail: string }
  | { kind: "unavailable"; message: string; hint: string; detail?: string }
  | { kind: "error"; message: string };

type GlobalTasksCatalogState =
  | { kind: "loading" }
  | { kind: "loaded"; config: WorkspaceTasksConfig; refreshing: boolean; refreshError?: string }
  | { kind: "invalid"; message: string; hint: string; detail: string }
  | { kind: "unavailable"; message: string; hint: string; detail?: string }
  | { kind: "error"; message: string };

interface WorkspaceTasksWorkspaceState {
  workspace: WorkspaceTasksCatalogState;
  global: GlobalTasksCatalogState;
  move?: {
    kind: "partial" | "unknown-outcome" | "conflict";
    message: string;
    retryAllowed: boolean;
  };
}
```

A background refresh retains loaded tasks and marks that source as refreshing. A failure after a successful load retains the source's data with its own `refreshError`. The other source remains independently usable. Initial loading and unavailable states do not fabricate catalog data. If an unknown-outcome refresh proves the exact complete move pair, it clears the move state and closes the editor without requiring a live claim. If it proves the pristine pair, it ends recovery but retains the editor draft for a new confirmation. A `retryAllowed` move state means only that the retained context and destination-written pair justify a guarded `intent: "retry"` request; the server decides whether a live claim authorizes the write.

The controller:

- coalesces an in-flight refresh for the same selected scope;
- invalidates request generations on machine/workspace/path changes and disposal;
- never publishes a stale response;
- keeps one in-flight request per source key;
- publishes state after each asynchronous change;
- exposes callbacks for workspace CRUD, global CRUD, moves, Retry move, and Refresh; and
- does not poll in the background. Loads occur when the enabled Tasks contribution becomes observable, on selected-scope changes, and on explicit Refresh.

`PiWebUiApp` wires controller lifecycle similarly to other selected-workspace controllers. It observes the active bundled Workspace Tasks contribution, starts a selected-scope load only while that contribution is enabled and a workspace is selected, and disposes the controller on app disconnect.

### Bundled plugin bridge

The public `WorkspacePanelContext` remains unchanged. Core-only fields are added to the internal client plugin context and shaped by a local type in the bundled plugin, following the existing bundled Memory pattern.

The Workspace Tasks contribution passes explicit reactive properties to the custom element:

```typescript
<pi-webui-workspace-tasks-panel
  .context=${context}
  .workspaceTasksState=${tasks.state}
  .workspaceTasksActions=${tasks.actions}
></pi-webui-workspace-tasks-panel>
```

The element rerenders when either state or actions change, even when the selected workspace key is unchanged. It no longer owns a parallel plugin-local workspace task cache or writes through `WorkspaceFiles` for task CRUD. It continues to use the public terminal adapter for task execution.

The bridge exposes only the state snapshot and typed controller callbacks needed by this bundled plugin. It does not expose a generic request function, raw revisions, source snapshots, global config, or client internals.

## HTTP, Local Aliases, And Federation

### Local routes

Workspace routes carry workspace identity in their path:

```text
GET  /api/projects/:projectId/workspaces/:workspaceId/workspace-tasks
PUT  /api/projects/:projectId/workspaces/:workspaceId/workspace-tasks
POST /api/projects/:projectId/workspaces/:workspaceId/workspace-tasks/move

GET  /api/workspace-tasks/global
PUT  /api/workspace-tasks/global
```

The explicit local-machine aliases provide the same behavior:

```text
GET  /api/machines/local/projects/:projectId/workspaces/:workspaceId/workspace-tasks
PUT  /api/machines/local/projects/:projectId/workspaces/:workspaceId/workspace-tasks
POST /api/machines/local/projects/:projectId/workspaces/:workspaceId/workspace-tasks/move

GET  /api/machines/local/workspace-tasks/global
PUT  /api/machines/local/workspace-tasks/global
```

Both local registrations use the same service instances and are registered before generic machine proxy routes. The generic proxy's rejection of an unregistered `machineId === "local"` must not handle these explicit aliases.

### Remote routes

The shared federated HTTP allowlist includes all of these target paths:

```text
GET  /projects/:projectId/workspaces/:workspaceId/workspace-tasks
PUT  /projects/:projectId/workspaces/:workspaceId/workspace-tasks
POST /projects/:projectId/workspaces/:workspaceId/workspace-tasks/move
GET  /workspace-tasks/global
PUT  /workspace-tasks/global
```

The gateway exposes them under `/api/machines/:machineId/...` and forwards them to the selected machine's ordinary `/api/...` routes. It registers explicit Workspace Tasks proxy routes before the generic machine proxy so the 576 KiB replace and 1.75 MiB move limits, typed `413` envelope, and strict mutation parser apply before forwarding. The selected machine owns its workspace file and config mutation; the gateway never writes a remote machine's global config locally.

The gateway validates portable Workspace Tasks JSON through the shared strict parser before forwarding mutation bodies. The selected machine validates again. Both gateway and target apply the same path-specific replace and move body caps before parsing or forwarding. Target routes map all errors to safe envelopes, including typed conflict reasons, before the generic proxy forwards their status and body.

The move route has an explicit 30-second proxy timeout. A timeout is an unknown move outcome and follows the controller recovery rules above.

### Client URL rules

Core clients create application-relative paths only. They:

- use path helpers ending in `Path`;
- encode every dynamic machine, project, and workspace segment with `encodeURIComponent`;
- use `URLSearchParams` for queries;
- send normal JSON through the existing request boundary or its status-aware extension; and
- resolve a URL exactly once at the browser boundary.

No Workspace Tasks plugin source calls `fetch`, constructs an origin-root `/api` URL, or imports core client modules. Remote machines that do not support these routes surface a scoped unavailable state without hiding usable workspace tasks.

## Panel Behavior

### Scope filters and catalogs

The toolbar retains Add Task, Refresh, and Open Terminal. Beneath the helper text, it renders All, Global, and Project filter buttons inside a labeled `role="group"`. Each button uses `aria-pressed`; the controls are filters rather than WAI-ARIA tab widgets and retain ordinary button keyboard behavior.

- **All** renders explicit Global tasks and Project tasks headings.
- **Global** renders only the global catalog.
- **Project** renders only the workspace catalog for the selected workspace.

Each filter shows the count of currently loaded tasks in that scope. An unavailable, invalid, or refreshing source has an explicit scoped message. A global failure does not hide workspace tasks, and a workspace failure does not hide global tasks.

Task rows always carry a visible scope badge in All. Button accessible names include the task title and scope, for example `Edit Build (Global)`. Equal IDs render as separate rows and remain independently executable, editable, and deletable.

A source's loaded tasks remain runnable during its background refresh. Mutation controls are disabled only for the affected source while its write is active; a cross-catalog move disables both participating catalogs. Run is disabled only while an existing terminal dispatch is active.

### Expandable groups

Tasks are grouped by optional `group`, preserving first-seen order within each catalog. Ungrouped tasks retain the existing ungrouped presentation. Named groups use native `<details>` elements with:

- a semantic `<summary>`;
- a decorative `aria-hidden` disclosure chevron;
- group title and count; and
- a bounded body containing task rows.

The panel stores disclosure state in a persistent in-memory map keyed by a collision-safe serialization of `{ scope, group }`. Native `toggle` events update the map. Filtering to another scope does not remove keys for hidden groups. Refresh and mutation prune only keys whose scoped group no longer exists. The map is not serialized or synchronized across browser tabs.

### Editor and scope checkbox

The Add/Edit form includes:

```text
[ ] Available in all projects on this machine
```

The checkbox is unchecked for new tasks, checked for global tasks, and has explanatory help text that a global definition runs in the currently selected workspace root. The editor header displays a Project task or Global task badge.

For a new task:

- unchecked creates a workspace task through the server-owned workspace replace path;
- checked creates a global task through the server-owned global replace path; and
- no move confirmation is needed because no source exists.

For an existing task:

- leaving the checkbox unchanged edits within its catalog;
- changing it opens a confirmation that names the source and destination scope; and
- confirmation invokes the server-owned destination-first move.

Changing an ID during a scope move is supported. The source reference remains the original `{scope,id,task}` while the destination task carries the edited ID and content.

### Move recovery

After `partial` or unknown-outcome treatment, the editor remains visible with the original draft and source reference while recovery is unresolved. If an authoritative refresh proves the exact complete pair, it closes the editor and reports completion without another write. If it proves the pristine pair, it keeps the draft but requires a new confirmation rather than retrying the old operation. Otherwise, the status area offers:

- **Retry move**, enabled only after a refresh confirms the destination-written phase for the retained original context; it sends `intent: "retry"`, and its server response either resumes the owned move or returns a zero-write unowned-intermediate-state conflict;
- **Refresh**, which warns before discarding a dirty draft and reloads both authoritative catalogs; and
- **Cancel**, which leaves the affected catalogs refresh-gated rather than making stale state writable.

A destination collision and a source revision conflict leave both catalogs unchanged. An unrecognized state never receives automatic compensation or overwrite.

## Testing

### Shared domain and parser tests

Add pure tests for:

- workspace/global task references, `workspaceTaskRefKey` round trips, and collision-safe identifiers;
- version 1 parsing, canonical serialization, 512 KiB catalog and derived-move-result limits, invalid catalog diagnostics, and unknown-field policy;
- absent global catalog equivalence to empty catalog;
- global revision stability for no-op and unrelated config changes;
- workspace revision behavior for loaded and missing files;
- order-preserving create, edit, promotion, and demotion transformations;
- source-ID changes during moves; and
- persistent group-key behavior for duplicate group names across scopes.

### Server and route tests

Use injected config coordinators, workspace adapters, project/workspace services, and controllable write failures. Never use the real user config or data directory.

Cover:

- main-workspace and Git-worktree paths resolving different workspace catalog files;
- missing and valid global catalog reads, oversized or invalid global diagnostics, and blocked invalid writes;
- deep preservation of plugin enablement, sibling settings, unrelated plugins, and unrelated global config;
- revision-checked global and workspace replacements with zero writes on conflict;
- no-op global replacements retaining the revision;
- local ordinary and `/api/machines/local` aliases returning equivalent results;
- federated allowlist entries, explicit gateway proxy registration before the generic machine proxy, path translation, portable request validation, safe errors including typed `413`, and status forwarding;
- generic `/api/config` and `/api/machines/local/config` attempts to change global tasks during each move phase being rejected before save, while unrelated config updates remain allowed, including a claim that appears after asynchronous reconciliation but before the coordinator callback;
- workspace file-explorer `PUT`, `DELETE`, and source-or-destination `file/move` operations targeting the participating task catalog returning safe `409` during each move phase, including races with task-adapter writes, while reads and unrelated paths/workspaces remain allowed;
- route-specific 576 KiB replace and 1.75 MiB move body limits, plus destination-task and derived-catalog size rejection;
- encoded remote path segments and the explicit move timeout;
- destination collisions with zero writes;
- completed promotion and demotion with independent ordering;
- every move phase: start-pristine, retry-pristine, retransmitted-start destination-written, owned retry destination-written/source-intact, complete replay, source conflict, destination conflict, unowned intermediate state after restart, and unrecognized state;
- pending-claim cleanup after a known destination-write failure, uncertain destination-write and verification outcomes, source-write failure, response lost after completed server work, direct replace unknown outcomes, typed `413` failures, and gateway timeout treatment;
- concurrent Workspace Tasks operations for one workspace, concurrent identical-task promotions from two workspaces, concurrent demotions of one global task to two workspaces, blocked global and participating-workspace mutations while a move claim is active, allowed reads and unrelated-workspace mutations, claim release after completion, and claim release after an unrecognized manual-resolution state; and
- documented best-effort behavior when an external writer races the workspace file.

### Controller and app wiring tests

Use controllable promises, fake clients, and no sleeps. Cover:

- independent workspace and global initial loads;
- machine-only global cache reuse and workspace key changes including a changed worktree path;
- in-flight refresh coalescing, stale scope results, disposal, and selected-plugin enablement;
- loaded data retained through a per-source refresh error;
- global revision updates and no-op stability;
- direct workspace/global CRUD, completed moves, conflicts including typed move-recovery reasons, partial recovery, unknown outcomes that resolve a complete pair after refresh, guarded Retry behavior with and without a live claim, and Refresh gating;
- same-scope reactive publication into the mounted Tasks custom element; and
- no stale panel completion after disconnect or context replacement.

### Panel and accessibility tests

Use real shadow-DOM interaction where practical. Cover:

- All, Global, and Project filter labels, counts, `aria-pressed`, and keyboard focus;
- explicit headings and independently actionable duplicate IDs, including terminal metadata scope;
- native group disclosure, initial collapse, counts, and All -> Global -> Project -> All expansion persistence;
- separate group expansion for equal group names in different scopes;
- checkbox defaults, scope badges, new global creation, promotion, demotion, and ID changes during a move;
- destination collision, partial move, unknown outcome, unknown-outcome completion after refresh, guarded Retry rejected after a lost claim, unowned intermediate state, Refresh, Cancel, and dirty-draft protection;
- workspace usability while global state fails and global usability while workspace state fails;
- existing multiline command rendering, run confirmation, focus restoration, and responsive narrow-panel behavior; and
- accessible button names that include task title and scope.

### Client, browser, and repository verification

Add client parser and URL tests under a nested `BASE_URL`. Assert exact methods, portable JSON bodies, encoded machine/project/workspace segments, local aliases, remote paths, bounded move expectations, typed direct conflict-reason preservation, status-aware partial/conflict parsing, and read-versus-write unknown-outcome mapping. Extend the federated route contract test so every machine-scoped Workspace Tasks client call matches the shared allowlist.

Perform a Chromium/CDP acceptance probe with long global and workspace catalogs at desktop and narrow widths. Exercise scope filters, disclosure groups, duplicate IDs, scope changes, destination collision, partial recovery, keyboard focus, and classic/dark/light theme tokens.

Finish implementation with:

```text
npm run verify:fast
npm run verify
npm run build
npm run pack:dry
npm run changelog:status
git diff --check
```

The package dry run must contain the compiled Workspace Tasks plugin, `docs/plugins.md`, and `docs/config.md`. The paired repository HTML documentation is verified separately because `docs/plugins.html` and `docs/config.html` are not packaged.

## Documentation And Release

Update these paired user-facing documents:

- `docs/plugins.md` and `docs/plugins.html` for scope filters, workspace versus global storage, worktree behavior, groups, checkbox behavior, promotion/demotion, task execution root, conflict recovery, trusted-shell guidance, and multiline terminal behavior;
- `docs/config.md` and `docs/config.html` for `plugins.workspace-tasks.settings.globalTasks`, versioning, absent/default behavior, invalid-data repair, revision/conflict semantics, and the single web/API route-owner requirement for guarded moves.

Keep `README.md` unchanged. Do not manually edit `CHANGELOG.md`.

Add a minor Changeset for `@hyperdreamer/pi-webui` describing machine-global Workspace Tasks, scope-aware browsing and editing, workspace-aware local catalogs, and guarded promotion/demotion recovery.

## Scope Boundaries

- Keep task file schema version 1 and do not add a per-task scope field.
- Do not add task search, templates, import/export, duplication, drag reorder, group-management UI, per-line status, command-execution retries, or a command timeout model.
- Do not add arbitrary HTTP access to the stable public plugin API.
- Do not create a global task file outside PI WEBUI global config.
- Do not claim atomic protection from arbitrary external file writers or cross-process move serialization.
- Do not let first-party generic config or workspace file APIs bypass a live move claim.
- Do not silently merge, compensate, or overwrite an unrecognized or unowned intermediate move state.
- Do not persist a move journal; process-local claims intentionally become manual-resolution-only after restart.
- Do not change session-daemon protocol or runtime ownership.
- Do not manually edit the changelog.
