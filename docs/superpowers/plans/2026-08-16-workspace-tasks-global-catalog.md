# Workspace Tasks Global Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Add machine-global Workspace Tasks, scope-aware browsing and editing, and guarded promotion/demotion while retaining workspace-rooted task catalogs for Git worktrees.

**Architecture:** Put version-one task semantics in a shared pure domain module and keep strict owned HTTP envelopes separate from compatibility-preserving task values. The server becomes the only catalog mutation authority, using revision-checked adapters, a process-local move registry, and gates around first-party generic config and file-explorer mutations. A core browser controller owns cached state, recovery, and transport; the bundled plugin receives only an internal state/action bridge and continues to own its DOM interaction and terminal dispatch.

**Tech Stack:** TypeScript, Node.js 22.19+, Fastify, SQLite-backed configuration mutation coordination, Vitest, jsdom, native custom elements and shadow DOM, Chromium/CDP, PI WEBUI plugin API, Changesets.

## Global Constraints

- The approved design in `docs/superpowers/specs/2026-08-16-workspace-tasks-global-catalog-design.md` is authoritative; resolve an implementation ambiguity by preserving its safety guarantees, not by weakening them.
- Node.js 22.19 is the minimum supported runtime; add no runtime dependencies.
- Follow test-driven development for each production behavior: add the focused regression, observe its RED failure where the behavior is new, make the minimum implementation, and observe GREEN.
- Keep workspace task storage at `<workspace>/.pi-webui/tasks.json`; user-facing copy says Project, while internal persistence keys and routes say workspace.
- Keep task file schema version 1 and do not add a scope field to `WorkspaceTask`; scope is represented only by `WorkspaceTaskRef`.
- Keep `src/plugin-api.ts` and the public `@hyperdreamer/pi-webui/plugin-api` contract unchanged. The bundled plugin may receive only internal, identity-scoped state/actions.
- All PI WEBUI browser paths are application-relative with no leading slash. Encode every dynamic path segment, resolve URLs exactly once at the browser boundary, and do not give plugin source arbitrary HTTP access.
- Do not add a durable move journal, automatic retries, automatic compensation, silent merges, or cross-process locking claims. Process-local claims become manual-resolution-only after a server restart.
- Do not alter session-daemon protocol, runtime ownership, or the coordinator's persisted schema. This feature is web/API and client/plugin work; it does not require a manual `pi-webui-sessiond.service` restart.
- Keep `README.md` and `CHANGELOG.md` unchanged. Keep `docs/plugins.md` and `docs/plugins.html` synchronized, and keep `docs/config.md` and `docs/config.html` synchronized.
- Add one minor Changeset for `@hyperdreamer/pi-webui`; do not run `npm publish` locally.
- Do not use real user config, data directories, projects, or workspaces in tests. Use injected adapters, temporary directories, and controllable promises.
- Finish with the exact verification sequence in the approved design, run the two full verification profiles serially, and report any unavailable browser tooling rather than claiming browser acceptance.

## Task 1: Extract The Shared Task Domain

**Implementer tier:** Advanced

**Files:**

- Create: `src/shared/workspaceTasks.ts`
- Create: `src/shared/workspaceTasks.test.ts`

**Interfaces:**

- Consumes: the existing version-one parsing, canonical serialization, and array-order behavior in `pi-webui-plugins/workspace-tasks/config.ts`.
- Produces the server- and browser-safe value module:

```ts
export const TASKS_CONFIG_PATH = ".pi-webui/tasks.json";
export const WORKSPACE_TASKS_CONFIG_VERSION = 1;
export const WORKSPACE_TASKS_CATALOG_MAX_BYTES = 512 * 1024;
export type WorkspaceTaskScope = "global" | "workspace";
export interface WorkspaceTaskRef { scope: WorkspaceTaskScope; id: string; }
export interface WorkspaceTask { id: string; title: string; command: string; description?: string; group?: string; confirm: boolean; }
export interface WorkspaceTasksConfig { version: 1; tasks: WorkspaceTask[]; }
export type ParseWorkspaceTasksConfigResult = { ok: true; config: WorkspaceTasksConfig } | { ok: false; error: string };
export function parseWorkspaceTasksConfig(value: unknown): ParseWorkspaceTasksConfigResult;
export function parseWorkspaceTasksConfigText(text: string): ParseWorkspaceTasksConfigResult;
export function serializeWorkspaceTasksConfig(config: WorkspaceTasksConfig): string;
export function workspaceTasksCanonicalByteLength(config: WorkspaceTasksConfig): number;
export function assertWorkspaceTasksCatalogSize(config: WorkspaceTasksConfig): void;
export function isWorkspaceTaskId(value: string): boolean;
export function workspaceTaskRefKey(ref: WorkspaceTaskRef): string;
export function parseWorkspaceTaskRefKey(key: string): WorkspaceTaskRef;
export function workspaceTaskGroupKey(scope: WorkspaceTaskScope, group: string): string;
export function appendWorkspaceTask(config: WorkspaceTasksConfig, task: WorkspaceTask): WorkspaceTasksConfig;
export function replaceWorkspaceTaskAt(config: WorkspaceTasksConfig, index: number, task: WorkspaceTask): WorkspaceTasksConfig;
export function removeWorkspaceTaskAt(config: WorkspaceTasksConfig, index: number): WorkspaceTasksConfig;
export function deriveWorkspaceTaskMove(input: {
  source: { ref: WorkspaceTaskRef; config: WorkspaceTasksConfig };
  destination: { scope: WorkspaceTaskScope; config: WorkspaceTasksConfig; task: WorkspaceTask };
}): { sourceAfter: WorkspaceTasksConfig; destinationAfter: WorkspaceTasksConfig };
```

- Leaves the existing plugin `config.ts` intact until Task 13, when the builder alias is available and the panel can migrate atomically away from duplicate task semantics.

- [ ] **Step 1: Write failing domain regressions**

Create `src/shared/workspaceTasks.test.ts` with literal catalog fixtures that prove the following:

```text
unknown catalog and task keys are accepted on read and omitted from the semantic projection
omitted confirm defaults false; duplicate IDs, blank required fields, invalid IDs, and non-boolean confirm are rejected
canonical JSON is version then tasks, task fields id/title/command/description/group/confirm, two-space indented, and newline terminated
multiline command bytes survive parse and canonical serialization exactly
global:build and workspace:build round-trip as separate refs; malformed keys and colon-containing IDs are rejected
scoped group keys for identical group labels are different and reversible
append, replace, and remove preserve untouched order and throw RangeError for a bad captured index
promotion and demotion append the editable destination task, remove the original source task, and allow a changed destination ID
same-scope moves, absent source tasks, destination collisions, and a derived catalog over 512 KiB are rejected
canonical UTF-8 JSON at 512 KiB is accepted and one byte beyond it is rejected
```

Cover the existing parser/serializer behavior independently in this new canonical-domain suite. Task 13 retires the duplicate plugin parser tests when the plugin imports the built alias.

- [ ] **Step 2: Run the domain tests and confirm RED**

Run:

```bash
npm test -- --run src/shared/workspaceTasks.test.ts
```

Expected: FAIL because `src/shared/workspaceTasks.ts` and its exports do not exist.

- [ ] **Step 3: Implement the pure module and thin editor adapter**

Implement the current compatibility parser once in `src/shared/workspaceTasks.ts` as the designated canonical source. Build canonical objects explicitly before `JSON.stringify`, calculate byte limits with `new TextEncoder().encode(serialized).byteLength` so the module runs in both browser and Node environments, and keep all transform functions pure. Define the reference key only after validating scope and ID. Use `JSON.stringify([scope, group])` for group keys so group punctuation cannot collide.

Do not change plugin imports in this task: the plugin builder cannot resolve the alias until Task 3. Keep the module free of server-only imports and use `TextEncoder`, which is available in both browser and Node runtimes.

- [ ] **Step 4: Run focused GREEN checks**

Run:

```bash
npm test -- --run src/shared/workspaceTasks.test.ts
npx eslint src/shared/workspaceTasks.ts src/shared/workspaceTasks.test.ts
npm run typecheck
```

Expected: all commands pass; no plugin source imports a task value from a server-only module.

- [ ] **Step 5: Commit the shared-domain task**

```bash
git add src/shared/workspaceTasks.ts src/shared/workspaceTasks.test.ts
git commit -m "feat(tasks): share task catalog domain"
```

## Task 2: Define Strict Workspace Tasks Wire Contracts

**Implementer tier:** Advanced

**Files:**

- Create: `src/shared/workspaceTasksApi.ts`
- Create: `src/shared/workspaceTasksApi.test.ts`
- Modify: `src/shared/apiTypes.ts:1-80`

**Interfaces:**

- Consumes from Task 1: `WorkspaceTask`, `WorkspaceTaskRef`, `WorkspaceTasksConfig`, `WorkspaceTaskScope`, and `parseWorkspaceTasksConfig()`.
- Produces shared API types: `WorkspaceCatalogAddress`, `WorkspaceCatalogExpectation`, `GlobalCatalogExpectation`, `ReplaceWorkspaceTasksRequest`, `ReplaceGlobalWorkspaceTasksRequest`, `MoveWorkspaceTaskIntent`, and `MoveWorkspaceTaskRequest` with the exact source/destination union in the approved design.
- Produces `WorkspaceTasksCatalogResponse`, `GlobalWorkspaceTasksResponse`, `MoveWorkspaceTaskResult`, `WorkspaceTasksConflictReason`, `WorkspaceTasksFailureResponse`, and `WorkspaceTasksRequestResult<T>` exactly as discriminated in the approved design.
- Defines the owned direct-write unknown outcome as a typed safe `500` body; `503` remains only for unavailable outcomes proven not to have written, while gateway/network/other unexpected `5xx` remain client-side ambiguous transport failures.
- Produces `WORKSPACE_TASKS_REPLACE_BODY_LIMIT_BYTES = 576 * 1024`, `WORKSPACE_TASKS_MOVE_BODY_LIMIT_BYTES = 1835008`, plus `parseReplaceWorkspaceTasksRequest`, `parseReplaceGlobalWorkspaceTasksRequest`, `parseMoveWorkspaceTaskRequest`, `parseWorkspaceTasksCatalogResponse`, `parseGlobalWorkspaceTasksResponse`, `parseMoveWorkspaceTaskResult`, and `parseWorkspaceTasksFailureResponse`.

- [ ] **Step 1: Write failing parser and envelope tests**

Create literal JSON-shaped request/result fixtures. Assert each request/result discriminator accepts a valid v1 catalog; every owned outer and nested envelope rejects an unknown key; unknown catalog/task keys remain accepted only because Task 1 projects them away; operation IDs must be canonical UUIDs; revisions must be non-empty opaque strings; scopes, intents, and reasons must be known literals; source/destination scopes must differ; a workspace source expectation must be loaded; global source/destination expectations must be loaded; route project/workspace IDs are rejected when duplicated in a JSON body; expectation catalogs and a one-task destination catalog over 512 KiB are rejected; optional error detail is accepted only when present; typed unknown-outcome is valid at its owned `500` boundary rather than `503`; and completed, partial, validation, unavailable, unknown-outcome, direct conflict, and every move-only conflict remain distinct unions.

- [ ] **Step 2: Run the wire tests and confirm RED**

Run:

```bash
npm test -- --run src/shared/workspaceTasksApi.test.ts
```

Expected: FAIL because the API type declarations and strict parser module do not exist.

- [ ] **Step 3: Implement typed envelopes and parsers**

Use one `requirePlainRecord()` helper that rejects arrays and unexpected own keys. Delegate catalog parsing to Task 1 instead of recreating task validation. Keep the broader move-result conflict reasons separate from direct replace/config `WorkspaceTasksConflictReason`. Parser errors contain only safe contract labels and never raw config or filesystem data.

- [ ] **Step 4: Run focused GREEN checks**

Run:

```bash
npm test -- --run src/shared/workspaceTasks.test.ts src/shared/workspaceTasksApi.test.ts
npx eslint src/shared/apiTypes.ts src/shared/workspaceTasksApi.ts src/shared/workspaceTasksApi.test.ts
npm run typecheck
```

Expected: all commands pass and owned envelopes are strict while task values retain v1 compatibility.

- [ ] **Step 5: Commit the wire-contract task**

```bash
git add src/shared/apiTypes.ts src/shared/workspaceTasksApi.ts src/shared/workspaceTasksApi.test.ts
git commit -m "feat(tasks): define catalog wire contracts"
```

## Task 3: Make Shared Domain Imports Buildable For Plugins

**Implementer tier:** Advanced

**Files:**

- Create: `scripts/build-plugins.test.mjs`
- Modify: `tsconfig.json:1-37`
- Modify: `scripts/build-plugins.mjs:1-end`
- Modify: `src/buildContents.test.ts:1-end`

**Interfaces:**

- Consumes from Task 1: the canonical source `src/shared/workspaceTasks.ts` and plugin imports from `@pi-webui/workspace-tasks-domain`.
- Produces the TypeScript path alias `@pi-webui/workspace-tasks-domain` mapped to `./src/shared/workspaceTasks.ts` in root `tsconfig.json`; `tsconfig.plugins.json` continues to inherit it unchanged.
- Produces `dist/pi-webui-plugins/workspace-tasks/taskDomain.js` before the Workspace Tasks plugin entry. Every emitted alias import becomes a colocated `./taskDomain.js` dependency; a content-version query may be appended only to prevent stale browser module-graph imports after a shared-domain edit. Runtime output contains neither the alias nor a `src/` path.
- Produces a testable builder entry with injected fixture root/output/watch collaborators while retaining `node scripts/build-plugins.mjs [--watch]` as production CLI behavior.

- [ ] **Step 1: Add structural build and watch tests**

Create a temporary fixture containing a Workspace Tasks plugin import of the alias, a domain source, and a fixture `tsconfig.json` extending the root configuration. Run `tsc -p` for that fixture, or an equivalent `ts.createProgram`, and require successful alias resolution so the assertion cannot pass merely because production source has not imported the alias yet. Also assert that one ordinary build emits `taskDomain.js` before the plugin entry; the emitted entry imports relative `taskDomain.js` and contains neither the alias nor `/src/`; `taskDomain.js` exports a real parser fixture result; an injected watcher reports the domain and declared relative dependencies as watched inputs; a queued domain edit rebuilds `taskDomain.js` and the entry in the same cycle before fixture import; and the existing package-content regression recognizes the extra asset. Use deferred callbacks or an injected watch factory, never sleeps or an infinite watcher.

- [ ] **Step 2: Run build tests and confirm RED**

Run:

```bash
npm test -- --run scripts/build-plugins.test.mjs src/buildContents.test.ts
```

Expected: FAIL because the builder does not emit, rewrite, or watch the shared domain.

- [ ] **Step 3: Refactor the builder and add the alias**

Refactor only enough to inject filesystem/watch seams. On each build, transpile the canonical domain to the Workspace Tasks output directory before plugin source, rewrite emitted alias imports, and include the domain plus declared relative TypeScript dependencies in the watch set. Preserve recursive plugin copying and test-source exclusion.

- [ ] **Step 4: Run focused GREEN checks and inspect output**

Run:

```bash
npm test -- --run scripts/build-plugins.test.mjs src/buildContents.test.ts
npm run typecheck
npm run build:plugins
npx eslint scripts/build-plugins.mjs src/buildContents.test.ts
if rg -n '@pi-webui/workspace-tasks-domain|(?:^|/)src/' dist/pi-webui-plugins/workspace-tasks; then exit 1; fi
```

Expected: tests, typecheck, build, and lint pass; the inverted final check finds no unresolved runtime import; `dist/pi-webui-plugins/workspace-tasks/taskDomain.js` exists.

- [ ] **Step 5: Commit the plugin-build task**

```bash
git add tsconfig.json scripts/build-plugins.mjs scripts/build-plugins.test.mjs src/buildContents.test.ts
git commit -m "build(tasks): bundle shared task domain for plugins"
```

## Task 4: Add Atomic Global Catalog Persistence

**Implementer tier:** Capable

**Files:**

- Create: `src/server/workspaceTasks/workspaceTasksErrors.ts`
- Create: `src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.ts`
- Create: `src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.test.ts`
- Modify: `src/config.ts:1-250`
- Modify: `src/config.test.ts:1-end`
- Modify: `src/configMutationCoordinator.ts:30-207`
- Modify: `src/configMutationCoordinator.test.ts:1-end`

**Interfaces:**

- Consumes from Tasks 1 and 2: canonical task serialization/size checking, `GlobalWorkspaceTasksResponse`, `ReplaceGlobalWorkspaceTasksRequest`, and strict request types.
- Produces an in-transaction conditional-save extension: `PiWebUiConfigMutationOptions.shouldSave(before: PiWebUiConfigMutationSnapshot, next: PiWebUiConfigValues): boolean`. It runs while the coordinator lock is held. A false result commits the lock transaction without calling `savePiWebUiConfig()` and returns the exact pre-mutation snapshot.
- Produces `SavePiWebUiConfigOptions extends LoadOptions` with `onPublicationAttempt(): void` and `onPersisted(): void`. `savePiWebUiConfig()` invokes the first immediately before final rename and the second synchronously immediately after successful rename and before its own internal `loadPiWebUiConfig()` call. Both callbacks are non-throwing state transitions. A failure before publication attempt is proven no-write; a final-rename exception after publication attempt is conservatively possibly persisted.
- Produces `PiWebUiConfigMutationOptions.onPublicationAttempt(): void` and `onSaved(): void`, forwarded by the coordinator into the two save hooks. `onSaved` fires after rename but before every in-save or coordinator reload/parsing step. Neither callback fires for a no-save branch; a known pre-rename failure fires neither.
- Produces the opaque server-only `WorkspaceTasksMovePermit` brand in `workspaceTasksErrors.ts`; Task 6's registry is its sole constructor, while Task 4 and Task 5 adapters accept it only as an optional privileged-writer capability.
- Produces server-only mutation binding types in `workspaceTasksErrors.ts`: `WorkspaceTasksMutationSubject = { scope: "global" } | { scope: "workspace"; address: WorkspaceCatalogAddress }` and `WorkspaceTasksMoveWriteIntent = { scope: "global"; expectedRevision: string; config: WorkspaceTasksConfig } | { scope: "workspace"; address: WorkspaceCatalogAddress; expectedRevision: string; config: WorkspaceTasksConfig }`. An intent is canonical semantic content, never a browser value, and lets a permit authorize only its exact derived publication.
- Produces `WorkspaceTasksMoveObservationPort.observe(address: WorkspaceCatalogAddress): Promise<{ workspace: WorkspaceTasksCatalogResponse; global: GlobalWorkspaceTasksResponse }>` and `WorkspaceTasksMutationAuthorizer` with `reconcileGlobalMoveClaim(subject: WorkspaceTasksMutationSubject, permit?: WorkspaceTasksMovePermit): Promise<void>`, `assertGlobalMutationAllowed(intent?: Extract<WorkspaceTasksMoveWriteIntent, { scope: "global" }>, permit?: WorkspaceTasksMovePermit): void`, and `assertWorkspaceMutationAllowed(address: WorkspaceCatalogAddress, intent?: Extract<WorkspaceTasksMoveWriteIntent, { scope: "workspace" }>, permit?: WorkspaceTasksMovePermit): void`. Task 6's registry implements the authorizer and receives this observation port during Task 7 composition.
- Produces `WorkspaceTasksCatalogWriteOptions = { permit?: WorkspaceTasksMovePermit; onWriteAcknowledged?: () => void; onWriteOutcomeUnknown?: () => void }` and `WorkspaceTasksGlobalCatalogAdapter.read(): Promise<GlobalWorkspaceTasksResponse>` plus `replace(input: ReplaceGlobalWorkspaceTasksRequest, options?: WorkspaceTasksCatalogWriteOptions): Promise<GlobalWorkspaceTasksResponse>`. Its injected authorizer reconciles with `{ scope: "global" }` and `options?.permit` before entering the coordinator, canonicalizes the exact proposed catalog into a global write intent, and calls `assertGlobalMutationAllowed(intent, options?.permit)` synchronously inside the coordinator callback immediately before save. A matching live move permit may resume only its exact destination-written transition; an ordinary caller receives recovery-pending. It forwards `onWriteAcknowledged` through `onSaved`, so a move claim is promoted before any post-save verification read. If a failure follows publication attempt but precedes successful acknowledgement, it invokes `onWriteOutcomeUnknown` and returns typed unknown-outcome rather than unavailable.
- Produces typed safe domain errors: `WorkspaceTasksRevisionConflictError`, `WorkspaceTasksInvalidCatalogError`, `WorkspaceTasksUnavailableError`, and `WorkspaceTasksUnknownOutcomeError`.
- The adapter computes a SHA-256 revision of canonical semantic catalog JSON. Absent `globalTasks` and explicit empty catalog have the same revision. It changes only `plugins.workspace-tasks.settings.globalTasks` and preserves every unrelated global config value.

- [ ] **Step 1: Add failing coordinator and global-adapter tests**

Add config persistence tests with controlled file operations proving publication attempt occurs before rename, `onPersisted` fires after rename but before an injected in-save reload failure, a pre-rename write failure fires neither hook, and a final-rename exception fires publication attempt but not persistence acknowledgement. Add coordinator tests with a `savePiWebUiConfig` spy proving `shouldSave: () => false` writes nothing, returns the original snapshot, releases the lock, and invokes neither callback; a successful rename invokes `onSaved` before an in-save reload failure; a known pre-rename failure invokes neither; and a rename exception is classified possibly persisted. Use a controlled coordinator/config snapshot plus injected authorizer to test that absent and explicit empty catalogs share a revision; unchanged semantic content survives unrelated config changes; malformed or oversized global data returns invalid and blocks replacement; a mismatched expected revision writes zero times; same-value replacement writes zero times and retains its revision; changed replacement preserves plugin enablement, unknown plugin fields, sibling settings, other plugins, and unrelated top-level config; an authorizer claim appearing after asynchronous reconciliation but before the coordinator callback blocks the write; a live permit paired with a changed canonical catalog or expected revision writes zero times; the adapter invokes acknowledgement before a post-save verification failure and invokes unknown-outcome callback after ambiguous rename failure; and busy, parse, write, and post-save reload errors map to typed safe errors.

- [ ] **Step 2: Run global persistence tests and confirm RED**

Run:

```bash
npm run test:serial -- --run src/config.test.ts src/configMutationCoordinator.test.ts src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.test.ts
```

Expected: FAIL because no no-save transaction option, typed errors, or global catalog adapter exists.

- [ ] **Step 3: Implement no-save coordination and the adapter**

Introduce `SavePiWebUiConfigOptions` without changing ordinary load callers. In `savePiWebUiConfig()`, call `onPublicationAttempt` immediately before `operations.rename`, then `onPersisted` immediately after successful rename and before its existing internal load. In the coordinator, evaluate `shouldSave` after the callback produces its next config and before save, retain existing speech-input revision behavior in both branches, and forward both callbacks while the transaction is held. Read and mutate only through the shared coordinator. Reconcile the injected authorizer for the global mutation subject before the transaction, then canonicalize the proposed catalog and invoke its final synchronous assertion with the exact global write intent inside the coordinator mutation callback immediately before save. Deeply preserve the existing plugin map and `workspace-tasks` entry before replacing `settings.globalTasks`; never construct a shallow replacement. Hash canonical semantic JSON, not a speech revision, config fingerprint, or raw formatting.

- [ ] **Step 4: Run focused GREEN checks**

Run:

```bash
npm run test:serial -- --run src/config.test.ts src/configMutationCoordinator.test.ts src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.test.ts
npx eslint src/config.ts src/config.test.ts src/configMutationCoordinator.ts src/configMutationCoordinator.test.ts src/server/workspaceTasks/workspaceTasksErrors.ts src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.ts src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.test.ts
npm run typecheck
```

Expected: all commands pass, including the no-save assertion inside a transaction-shaped test.

- [ ] **Step 5: Commit the global-persistence task**

```bash
git add src/config.ts src/config.test.ts src/configMutationCoordinator.ts src/configMutationCoordinator.test.ts src/server/workspaceTasks/workspaceTasksErrors.ts src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.ts src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.test.ts
git commit -m "feat(tasks): persist global task catalogs atomically"
```

## Task 5: Add Workspace Catalog Observations And CAS Writes

**Implementer tier:** Capable

**Files:**

- Create: `src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.ts`
- Create: `src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.test.ts`
- Create: `src/server/workspaceTasks/workspaceTasksWorkspaceFile.ts`
- Create: `src/server/workspaceTasks/workspaceTasksWorkspaceFile.test.ts`
- Create: `src/server/workspaces/fileContentService.workspaceTasks.test.ts`
- Modify: `src/shared/workspaceFiles.ts:1-end`
- Modify: `src/server/workspaces/fileContentService.ts:1-end`
- Modify: `src/server/workspaces/fileContentService.read.test.ts:1-end`

**Interfaces:**

- Consumes from Tasks 1, 2, and 4: `TASKS_CONFIG_PATH`, canonical parser/serializer, size limit, `WorkspaceCatalogAddress`, catalog response types, and typed task errors.
- Consumes `WorkspaceTasksCatalogWriteOptions` from Task 4 and produces `WorkspaceTasksWorkspaceCatalogAdapter.read(address: WorkspaceCatalogAddress): Promise<WorkspaceTasksCatalogResponse>` plus `replace(address: WorkspaceCatalogAddress, input: ReplaceWorkspaceTasksRequest, options?: WorkspaceTasksCatalogWriteOptions): Promise<WorkspaceTasksCatalogResponse>`.
- Produces `WorkspaceTasksWorkspaceFileResolver`, a fixed-path authority for only `.pi-webui/tasks.json`. It canonicalizes the workspace root, checks each required parent with `lstat` and `realpath`, rejects a final task-file symlink including dangling links, and never calls `mkdir`, reads, writes, or verifies before those checks. It uses existing `ensureInside` semantics but does not rely on `resolveParentInsideWorkspace()` alone for a missing/dangling path.
- Its public server-only operations are `readCatalog(address)`, `publishCatalog(address, bytes, hooks)`, `writeExplorerTaskFile(address, body, options)`, `deleteExplorerTaskFile(address)`, and `moveExplorerTaskFile(address, normalizedMove)`. Each owns fixed-path validation and staged publication for the task-file side of an explorer operation; no caller receives a raw filesystem target.
- Resolves `projectId` plus `workspaceId` with `resolveWorkspaceContext()` and delegates every read, write, and verification to that fixed-file resolver. Its opaque SHA-256 revision distinguishes missing from exact present source bytes.
- Produces the dependency interface `WorkspaceTasksWorkspaceMutationCoordinator.run(address, operation)`. The adapter requires an injected implementation, which Task 5 tests fake and Task 6's registry later implements before Task 7 composition wires production collaborators. Before entering that queue, it awaits `authorizer.reconcileGlobalMoveClaim({ scope: "workspace", address }, options?.permit)`; inside it canonicalizes the exact proposed catalog and invokes `assertWorkspaceMutationAllowed(address, intent, options?.permit)` immediately before publication. A matching live move permit may resume only its exact destination-written transition; a service preflight is not sufficient authorization.
- Workspace replacement stages canonical bytes in an exclusive temporary file in the resolved canonical `.pi-webui` directory, invokes an internal publication-attempt marker immediately before atomic final rename, then invokes `options?.onWriteAcknowledged()` immediately after successful rename and before verification. Failures before publication attempt are proven no-write and may be unavailable/`503`; a final-rename exception after attempt invokes `options?.onWriteOutcomeUnknown()` and is typed `500`; any error after acknowledgement, including verification or cleanup, is also unknown-outcome/typed `500`.
- Produces a shared raw, bounded, strict-UTF-8 workspace-file read primitive for the adapter while preserving existing browser explorer `readWorkspaceFile()` behavior.

- [ ] **Step 1: Add failing workspace-adapter and raw-read tests**

Use temporary project roots and a fake workspace resolver. Prove that a main workspace and Git worktree with one project ID resolve separate task files; missing and present revisions differ; different raw source bytes have different revisions; valid v1 text loads; invalid JSON/schema is invalid without a revision; binary, invalid UTF-8, oversized, permission, and I/O failures are unavailable; existing and dangling final task-file symlinks plus existing and dangling `.pi-webui` parent symlinks are rejected before any external `read`, `mkdir`, or write; a stale destination-written claim that now reads complete is cleared and one that is unrecognized is rejected before the queue; replace checks the revision and final authorizer assertion inside the shared per-workspace queue and writes zero times on conflict, a late claim, or a live permit paired with the wrong address/revision/canonical catalog; an exclusive temporary write, including a partial temporary write, fails unavailable with zero source-catalog change; a final-rename exception after publication attempt invokes unknown-outcome callback and returns typed `500`; atomic publication invokes acknowledgement before post-write verification; injected post-publication failures are unknown-outcome after acknowledgement; unreadable or nonmatching verification after acknowledgement is unknown-outcome; same-address operations are FIFO while different addresses proceed independently; and the existing explorer reader retains truncation/binary behavior while the raw primitive rejects malformed UTF-8 instead of decoding replacement characters.

- [ ] **Step 2: Run workspace persistence tests and confirm RED**

Run:

```bash
npm run test:serial -- --run src/server/workspaces/fileContentService.workspaceTasks.test.ts src/server/workspaces/fileContentService.read.test.ts src/server/workspaceTasks/workspaceTasksWorkspaceFile.test.ts src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.test.ts
```

Expected: FAIL because no raw strict reader or workspace catalog adapter exists.

- [ ] **Step 3: Implement bounded source observations and replacement**

Centralize the 512 KiB raw task-file limit in `src/shared/workspaceFiles.ts`. Implement the fixed-file resolver before the adapter: it accepts no browser path, builds only `.pi-webui/tasks.json` below a canonical workspace root, verifies real parents and rejects all final-file symlinks. Read raw bytes before decoding, reject invalid UTF-8 with a fatal decoder, and hash tagged missing/present input so missing cannot collide with an empty present file. Before entering the shared workspace mutation coordinator, await claim reconciliation for the addressed workspace; inside the queue canonicalize the requested publication and make the final authorizer assertion with that exact workspace write intent, stage canonical content to an exclusive temporary in the canonical parent, mark publication attempt immediately before atomic rename, acknowledge immediately after successful rename, then reread authoritative source before reporting success. Map errors before publication attempt to unavailable and every final-rename/post-publication failure to unknown-outcome.

- [ ] **Step 4: Run focused GREEN checks**

Run:

```bash
npm run test:serial -- --run src/server/workspaces/fileContentService.workspaceTasks.test.ts src/server/workspaces/fileContentService.read.test.ts src/server/workspaceTasks/workspaceTasksWorkspaceFile.test.ts src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.test.ts
npx eslint src/shared/workspaceFiles.ts src/server/workspaces/fileContentService.ts src/server/workspaces/fileContentService.workspaceTasks.test.ts src/server/workspaces/fileContentService.read.test.ts src/server/workspaceTasks/workspaceTasksWorkspaceFile.ts src/server/workspaceTasks/workspaceTasksWorkspaceFile.test.ts src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.ts src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.test.ts
npm run typecheck
```

Expected: all commands pass, including distinct worktree-path and post-write verification cases.

- [ ] **Step 5: Commit the workspace-persistence task**

```bash
git add src/shared/workspaceFiles.ts src/server/workspaces/fileContentService.ts src/server/workspaces/fileContentService.workspaceTasks.test.ts src/server/workspaces/fileContentService.read.test.ts src/server/workspaceTasks/workspaceTasksWorkspaceFile.ts src/server/workspaceTasks/workspaceTasksWorkspaceFile.test.ts src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.ts src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.test.ts
git commit -m "feat(tasks): add revisioned workspace task catalogs"
```

## Task 6: Model Move States And Live Claims

**Implementer tier:** Capable

**Files:**

- Create: `src/server/workspaceTasks/workspaceTasksMoveProtocol.ts`
- Create: `src/server/workspaceTasks/workspaceTasksMoveProtocol.test.ts`
- Create: `src/server/workspaceTasks/workspaceTasksMoveRegistry.ts`
- Create: `src/server/workspaceTasks/workspaceTasksMoveRegistry.test.ts`

**Interfaces:**

- Consumes from Tasks 1, 2, 4, and 5: catalog expectations, pure move derivation, workspace/global observations, and typed domain errors.
- Produces a pure `deriveWorkspaceTasksMovePlan(address, request)` that validates submitted expectation revisions/configs, derives pristine, destination-applied, and complete catalog pairs, and exposes `classifyWorkspaceTasksMovePair(plan, observed)` with exactly `pristine`, `destination-applied`, `complete`, or `unrecognized` outcomes.
- Consumes the branded server-only `WorkspaceTasksMovePermit`, `WorkspaceTasksMutationAuthorizer`, and `WorkspaceTasksMoveObservationPort` contracts from Task 4. Produces `WorkspaceTasksWorkspaceMutationCoordinator.run<T>(address: WorkspaceCatalogAddress, operation: () => Promise<T>): Promise<T>` and requires the registry to implement it. This is the one queue injected into the workspace adapter and Task 8 file gate.
- `MachineGlobalTasksMoveRegistry` is constructed with one `WorkspaceTasksMoveObservationPort` and is the sole permit factory and authorizer implementation. Its exact move operations are `withMoveLock<T>(operationId: string, operation: () => Promise<T>): Promise<T>`, `beginStart(plan: WorkspaceTasksMovePlan): WorkspaceTasksMovePermit`, `beginRetry(plan: WorkspaceTasksMovePlan): WorkspaceTasksMovePermit`, `markDestinationWritten(permit: WorkspaceTasksMovePermit): void`, `markDestinationOutcomeUnknown(permit: WorkspaceTasksMovePermit): void`, `release(permit: WorkspaceTasksMovePermit): void`, `reconcileGlobalMoveClaim(subject: WorkspaceTasksMutationSubject, permit?: WorkspaceTasksMovePermit): Promise<void>`, `assertGlobalMutationAllowed(intent?: Extract<WorkspaceTasksMoveWriteIntent, { scope: "global" }>, permit?: WorkspaceTasksMovePermit): void`, and `assertWorkspaceMutationAllowed(address: WorkspaceCatalogAddress, intent?: Extract<WorkspaceTasksMoveWriteIntent, { scope: "workspace" }>, permit?: WorkspaceTasksMovePermit): void`. The unknown-outcome marker retains a recovery-blocking destination-written claim without permitting source removal. Reconciliation is phase-aware: it is a no-op for destination-pending; for a destination-written claim it returns immediately without observation for an unrelated workspace subject, but reads the exact workspace/global pair for global or participating-workspace subjects. For a matching live permit it permits only the exact destination-applied transition; it clears a complete claim, retains the claim and reports recovery-pending on unavailable/invalid observations for a relevant subject, and clears an unrecognized claim only after returning the defined manual-resolution conflict. A provided permit requires a non-optional canonical intent. Final assertion compares that intent, expected revision, target scope/address, and current phase against the claim's exact derived destination or source publication; a live permit never authorizes an arbitrary replace. `beginStart` and `beginRetry` may run only inside `withMoveLock`; no permit may be constructed from a wire operation ID.
- A claim records operation ID, workspace address, exact plan, and phase. A matching claim is required for retry. Reads remain permitted; unrelated workspace mutation remains permitted; global mutation and mutation of the participating workspace are blocked while a claim is active.

- [ ] **Step 1: Write failing move-plan and registry tests**

Use pure catalog fixtures and controllable deferred promises. Cover every state-table row from the approved design: pristine plus start/no claim starts; pristine plus retry yields `retry-pristine`; pristine plus stale claim yields `unrecognized-state` and clears it; destination-applied plus matching start returns partial without write; matching retry resumes; destination-applied without matching live claim is unowned; complete returns completed and clears a matching claim; every other pair is refresh-gated conflict. Also cover that permits are returned only from begin operations inside the move lock; one shared workspace queue serializes adapter and explorer-gate operations for the same address; pending claim reconciliation performs no observation and does not block unrelated workspace; destination-written unavailable/invalid observations retain a recovery-pending claim for global and participating-workspace subjects but do not observe or block an unrelated workspace subject; changed destination ID, promotion and demotion ordering inputs, wrong operation ID/content reuse, a live permit paired with wrong canonical catalog/revision/transition side/address causing zero writes, pending claim cleanup after known destination failure, destination-written retention after successful acknowledgement or ambiguous final publication error, process-restart loss of claims, concurrent promotions from two workspaces, concurrent demotions of one global task, blocked global/participating-workspace writers, allowed reads/unrelated-workspace writers, late-claim final assertions, and claim clearing after complete or manual-resolution state.

- [ ] **Step 2: Run move-state tests and confirm RED**

Run:

```bash
npm test -- --run src/server/workspaceTasks/workspaceTasksMoveProtocol.test.ts src/server/workspaceTasks/workspaceTasksMoveRegistry.test.ts
```

Expected: FAIL because neither move plan derivation nor a claim registry exists.

- [ ] **Step 3: Implement pure classification and process-local claims**

Keep protocol derivation free of filesystem/config I/O. Compare full semantic configurations and revisions, not only task IDs. Derive and retain the two exact canonical write intents in each move plan: the destination publication valid during destination-pending, and the source-removal publication valid only during destination-written retry. The registry has no persistent backing and never treats an operation ID as provenance after restart. Its final assertions are synchronous and happen under its own relevant lock so an asynchronous reconciliation cannot introduce a time-of-check/time-of-use bypass.

- [ ] **Step 4: Run focused GREEN checks**

Run:

```bash
npm test -- --run src/server/workspaceTasks/workspaceTasksMoveProtocol.test.ts src/server/workspaceTasks/workspaceTasksMoveRegistry.test.ts
npx eslint src/server/workspaceTasks/workspaceTasksMoveProtocol.ts src/server/workspaceTasks/workspaceTasksMoveProtocol.test.ts src/server/workspaceTasks/workspaceTasksMoveRegistry.ts src/server/workspaceTasks/workspaceTasksMoveRegistry.test.ts
npm run typecheck
```

Expected: all transition and claim-race tests pass without timers or sleeps.

- [ ] **Step 5: Commit the move-state task**

```bash
git add src/server/workspaceTasks/workspaceTasksMoveProtocol.ts src/server/workspaceTasks/workspaceTasksMoveProtocol.test.ts src/server/workspaceTasks/workspaceTasksMoveRegistry.ts src/server/workspaceTasks/workspaceTasksMoveRegistry.test.ts
git commit -m "feat(tasks): coordinate recoverable task moves"
```

## Task 7: Implement The Server-Owned Catalog Service

**Implementer tier:** Capable

**Files:**

- Create: `src/server/workspaceTasks/workspaceTasksCatalogService.ts`
- Create: `src/server/workspaceTasks/workspaceTasksCatalogService.test.ts`
- Create: `src/server/workspaceTasks/workspaceTasksComposition.ts`
- Create: `src/server/workspaceTasks/workspaceTasks.testSupport.ts`

**Interfaces:**

- Consumes from Tasks 2 and 4 through 6: both adapters, move plan/registry, and all typed failures.
- Produces:

```ts
export interface WorkspaceTasksCatalogService {
  readWorkspace(input: WorkspaceCatalogAddress): Promise<WorkspaceTasksCatalogResponse>;
  replaceWorkspace(input: WorkspaceCatalogAddress & ReplaceWorkspaceTasksRequest): Promise<WorkspaceTasksCatalogResponse>;
  readGlobal(): Promise<GlobalWorkspaceTasksResponse>;
  replaceGlobal(input: ReplaceGlobalWorkspaceTasksRequest): Promise<GlobalWorkspaceTasksResponse>;
  move(input: WorkspaceCatalogAddress & MoveWorkspaceTaskRequest): Promise<MoveWorkspaceTaskResult>;
}
export interface WorkspaceTasksCompositionDependencies {
  configMutationCoordinator: PiWebUiConfigMutationCoordinator;
  projects: ProjectService;
  workspaces: WorkspaceService;
  factories?: Partial<WorkspaceTasksCompositionFactories>;
}
export interface WorkspaceTasksCompositionFactories {
  createRegistry(input: { observe: WorkspaceTasksMoveObservationPort }): MachineGlobalTasksMoveRegistry;
  createGlobalAdapter(input: { coordinator: PiWebUiConfigMutationCoordinator; authorizer: WorkspaceTasksMutationAuthorizer }): WorkspaceTasksGlobalCatalogAdapter;
  createWorkspaceFileResolver(input: { projects: ProjectService; workspaces: WorkspaceService }): WorkspaceTasksWorkspaceFileResolver;
  createWorkspaceAdapter(input: { projects: ProjectService; workspaces: WorkspaceService; files: WorkspaceTasksWorkspaceFileResolver; authorizer: WorkspaceTasksMutationAuthorizer; workspaceMutations: WorkspaceTasksWorkspaceMutationCoordinator }): WorkspaceTasksWorkspaceCatalogAdapter;
}
export interface WorkspaceTasksComposition {
  service: WorkspaceTasksCatalogService;
  registry: MachineGlobalTasksMoveRegistry;
  workspaceMutations: WorkspaceTasksWorkspaceMutationCoordinator;
  workspaceFiles: WorkspaceTasksWorkspaceFileResolver;
  globalAdapter: WorkspaceTasksGlobalCatalogAdapter;
  workspaceAdapter: WorkspaceTasksWorkspaceCatalogAdapter;
}
export function createWorkspaceTasksComposition(deps: WorkspaceTasksCompositionDependencies): WorkspaceTasksComposition;
```

- The composition creates exactly one global adapter, workspace adapter, fixed workspace-file resolver, registry, shared workspace mutation coordinator, and catalog service for an app. It accepts low-level factories, not independently assembled adapters/registry/queues, so it owns identity wiring. Construct it in this order: declare adapter references; create the registry with an observation-port closure that reads both references for its claimed address; create the fixed resolver; create both adapters with that exact registry as mutation authorizer and workspace mutation coordinator plus the same resolver; then create the service. The observation closure is called only after both adapter references are assigned. Task 8 constructs its two gates from this fixed composition rather than mutating its shape. Tests inject factories/low-level ports without touching user state.

- [ ] **Step 1: Add failing service tests**

Build a fake composition with observable adapter calls. Assert its observer port reads both adapters only after composition assignment and lets stale destination-written claims reconcile to complete or manual-resolution state before either direct adapter/gate write enters the shared queue. Assert direct workspace/global replacement performs CAS with zero write on revision conflict, global no-op does not save, invalid catalogs block mutation, and injected final authorizer assertions receive the canonical write intent at both write points. Assert move behavior: destination collision makes zero writes; promotion writes global then removes workspace source; demotion writes workspace then removes global source; source ID can change in destination; every privileged adapter call receives the plan-derived exact intent rather than a client-derived substitute; known destination pre-publication failure clears pending claim; successful destination-write acknowledgement immediately transitions the claim to destination-written before verification; ambiguous final publication failure promotes a recovery-blocking unknown-outcome claim, removes no source, and rereads authoritatively; unavailable/nonmatching destination verification retains that claim, removes no source, and returns unknown-outcome after authoritative rereads; source failure or verification failure rereads both stores; exact complete reread returns completed; exact destination-written/source-intact with matching claim returns partial; unreadable reread becomes unknown-outcome; unexpected states become zero-write refresh-gated conflict; retransmitted completed requests are idempotent; and no branch performs compensation or a second start.

- [ ] **Step 2: Run service tests and confirm RED**

Run:

```bash
npm test -- --run src/server/workspaceTasks/workspaceTasksCatalogService.test.ts
```

Expected: FAIL because the catalog service and composition do not exist.

- [ ] **Step 3: Implement service orchestration**

Make the service the only component deciding move outcomes. For a start request, derive the plan, call `withMoveLock`, reread both authorities, accept only pristine/no-live-claim, call `beginStart` for its permit, and issue only the plan-derived destination replace with `{ permit, onWriteAcknowledged: () => registry.markDestinationWritten(permit), onWriteOutcomeUnknown: () => registry.markDestinationOutcomeUnknown(permit) }`. Acknowledgement runs immediately after a successful destination publication and before verification; an ambiguous final publication error retains the same recovery-blocking claim before returning unknown-outcome. Keep its claim through every verification failure and remove no source until exact destination verification permits continuation. For retry, call `beginRetry` only for destination-applied with the matching live claim and pass its permit into only the plan-derived source-removal replacement. After every post-destination failure, reread both stores before classifying. `unknown-outcome` means the write may have happened and triggers no server retry. Wire the registry as both adapters' mutation authorizer and workspace mutation coordinator; adapters own final assertions and compare their canonical intents with the permit while the service owns only orchestration.

- [ ] **Step 4: Run focused GREEN checks**

Run:

```bash
npm test -- --run src/server/workspaceTasks/workspaceTasksGlobalCatalogAdapter.test.ts src/server/workspaceTasks/workspaceTasksWorkspaceCatalogAdapter.test.ts src/server/workspaceTasks/workspaceTasksMoveProtocol.test.ts src/server/workspaceTasks/workspaceTasksMoveRegistry.test.ts src/server/workspaceTasks/workspaceTasksCatalogService.test.ts
npx eslint src/server/workspaceTasks/workspaceTasksCatalogService.ts src/server/workspaceTasks/workspaceTasksCatalogService.test.ts src/server/workspaceTasks/workspaceTasksComposition.ts src/server/workspaceTasks/workspaceTasks.testSupport.ts
npm run typecheck
```

Expected: all adapter, move, and service tests pass with no real user config/filesystem access.

- [ ] **Step 5: Commit the catalog-service task**

```bash
git add src/server/workspaceTasks/workspaceTasksCatalogService.ts src/server/workspaceTasks/workspaceTasksCatalogService.test.ts src/server/workspaceTasks/workspaceTasksComposition.ts src/server/workspaceTasks/workspaceTasks.testSupport.ts
git commit -m "feat(tasks): centralize task catalog mutations"
```

## Task 8: Gate First-Party Bypasses And Register Local Routes

**Implementer tier:** Capable

**Files:**

- Create: `src/server/workspaceTasks/workspaceTasksGlobalMutationGate.ts`
- Create: `src/server/workspaceTasks/workspaceTasksGlobalMutationGate.test.ts`
- Create: `src/server/workspaceTasks/workspaceTasksWorkspacePathGate.ts`
- Create: `src/server/workspaceTasks/workspaceTasksWorkspacePathGate.test.ts`
- Create: `src/server/workspaceTasks/workspaceTasksRoutes.ts`
- Create: `src/server/workspaceTasks/workspaceTasksRoutes.test.ts`
- Create: `src/server/app.workspaceTasks.test.ts`
- Modify: `src/server/app.ts:48-413`
- Modify: `src/server/app.testSupport.ts:1-end`
- Modify: `src/server/configRoutes.ts:1-end`
- Modify: `src/server/configRoutes.test.ts:1-end`
- Modify: `src/server/workspaceExplorerRoutes.ts:1-end`
- Modify: `src/server/workspaces/fileContentService.ts:1-end`
- Modify: `src/server/workspaceTasks/workspaceTasksWorkspaceFile.ts:1-end`
- Modify: `src/server/workspaceTasks/workspaceTasksWorkspaceFile.test.ts:1-end`
- Modify: `src/server/app.localAliases.test.ts:1-end`
- Modify: `src/server/app.workspaceFiles.test.ts:1-end`

**Interfaces:**

- Consumes from Task 7: one fixed `WorkspaceTasksComposition` per app, including its service, registry, adapters, and shared workspace mutation coordinator.
- Extends `AppDependencies` with optional `workspaceTasks?: WorkspaceTasksComposition`, allowing `buildApp` tests to inject a composition backed by the same temporary coordinator/config state. Production creates the composition once from its existing projects, workspaces, and shared config coordinator.
- Produces `WorkspaceTasksGlobalMutationGate.decorate(config: PiWebUiConfigService): PiWebUiConfigService`. It asynchronously reconciles a destination-written claim for `{ scope: "global" }` before generic updates, then synchronously compares canonical global-task projections inside the coordinator callback immediately before save. Unrelated config writes remain permitted.
- Produces `WorkspaceTasksWorkspacePathGate.run(address, normalizedTargets, operation)`. It is called only after existing workspace path-safety resolution, awaits `registry.reconcileGlobalMoveClaim({ scope: "workspace", address })` before entering the composition's shared `workspaceMutations.run(address, operation)`, then makes the final synchronous assertion inside that queue. It wraps `PUT`, `DELETE`, and both source/destination sides of file move. Reads are not gated.
- For a normalized explorer target equal to `.pi-webui/tasks.json`, the route uses Task 5's `writeExplorerTaskFile`, `deleteExplorerTaskFile`, or `moveExplorerTaskFile` rather than generic `fileContentService` mutation functions. This check occurs before generic `mkdir`, final-leaf write, rename, or verification, so explorer operations cannot follow a dangling task-file or parent symlink.
- Produces `registerWorkspaceTasksRoutes(app, service, prefix)` for ordinary `/api` and explicit `/api/machines/local` aliases. It registers `GET/PUT workspace-tasks`, `POST workspace-tasks/move`, and `GET/PUT workspace-tasks/global` with 576 KiB replace and 1.75 MiB move caps, typed safe `413` response handling, and `500 { kind: "unknown-outcome", message }` only when a dispatched write cannot be proven not to have reached storage. `503` remains reserved for failures known to have performed no write.

- [ ] **Step 1: Add failing gate and local-route tests**

Use controllable claims and an injected temporary app. Extend `app.testSupport.ts` only to inject a composition wired to the same temporary coordinator/config state rather than the harness's unrelated fake config service. Prove that generic `/api/config` and `/api/machines/local/config` reject a changed global-task projection with safe `409` during both pending and destination-written phases, allow unrelated config updates, and still reject if a claim appears after async reconciliation but before the coordinator mutation callback. Prove explorer `PUT`, `DELETE`, and file move touching normalized `.pi-webui/tasks.json` reconcile a stale destination-written claim before queue entry, returning complete release or manual-resolution conflict as appropriate; return safe `409` during active claim phases; and use one shared workspace queue in a controlled race with task-adapter writes. With an unavailable destination-written observation, prove the participating workspace and global mutation return safe recovery-pending while an unrelated workspace explorer mutation proceeds without observation. Prove explorer existing/dangling final task-file and `.pi-webui` parent symlink cases fail before generic `mkdir`, read, write, or rename. Reads, unrelated paths, and unrelated workspaces remain usable. Prove raw forms such as `./.pi-webui/tasks.json` cannot evade the gate, and both source/destination paths are checked for a file move. Prove all five ordinary local routes and all five `/api/machines/local` aliases use the same service results, enforce strict body parsing, return typed `400`, `409`, `413`, `500 unknown-outcome`, and `503` envelopes, and never expose raw config, source content, or stack data. Assert invalid workspace catalog responses have no write/reset route; manual repair remains the explorer's responsibility.

- [ ] **Step 2: Run gate and local-route tests and confirm RED**

Run:

```bash
npm run test:serial -- --run src/server/workspaceTasks/workspaceTasksGlobalMutationGate.test.ts src/server/workspaceTasks/workspaceTasksWorkspacePathGate.test.ts src/server/workspaceTasks/workspaceTasksRoutes.test.ts src/server/app.workspaceTasks.test.ts src/server/configRoutes.test.ts src/server/app.localAliases.test.ts src/server/app.workspaceFiles.test.ts
```

Expected: FAIL because generic config and file routes can bypass a move claim and task routes do not exist.

- [ ] **Step 3: Implement gates, normalized file hooks, and local registration**

Use `deps.workspaceTasks` when injected or create the exact Task 7 composition once in `buildApp`, then construct both gates from it. Decorate the same config service passed to both generic config route families, and pass the path gate using that composition's shared workspace mutation coordinator to both explorer registrations. Make the global gate reconcile for the global subject, and make the path gate/direct workspace adapter reconcile for their addressed workspace before queue entry; retain only final assertions inside the queue. After existing route identity/path normalization identifies a task-file target, dispatch explorer write/delete/move through the composition's fixed resolver-specific operation instead of generic `fileContentService`; leave generic operations unchanged for all other paths. Map `WorkspaceTasksMoveRecoveryPendingError` to the existing safe config `409` envelope. Map `WorkspaceTasksUnknownOutcomeError` to the typed safe `500` response rather than `503`. Register task routes before generic machine proxy registration. Use route-level Fastify error handling for `FST_ERR_CTP_BODY_TOO_LARGE`, because a handler `try/catch` cannot see this error.

- [ ] **Step 4: Run focused GREEN checks**

Run:

```bash
npm run test:serial -- --run src/server/workspaceTasks/workspaceTasksGlobalMutationGate.test.ts src/server/workspaceTasks/workspaceTasksWorkspacePathGate.test.ts src/server/workspaceTasks/workspaceTasksRoutes.test.ts src/server/app.workspaceTasks.test.ts src/server/configRoutes.test.ts src/server/app.localAliases.test.ts src/server/app.workspaceFiles.test.ts
npx eslint src/server/app.ts src/server/app.testSupport.ts src/server/configRoutes.ts src/server/workspaceExplorerRoutes.ts src/server/workspaces/fileContentService.ts src/server/workspaceTasks/workspaceTasksWorkspaceFile.ts src/server/workspaceTasks/workspaceTasksWorkspaceFile.test.ts src/server/workspaceTasks/workspaceTasksGlobalMutationGate.ts src/server/workspaceTasks/workspaceTasksWorkspacePathGate.ts src/server/workspaceTasks/workspaceTasksRoutes.ts src/server/app.workspaceTasks.test.ts
npm run typecheck
```

Expected: all bypass and route-limit tests pass, with no first-party task writer outside the gate/service authority.

- [ ] **Step 5: Commit the gates and local routes task**

```bash
git add src/server/app.ts src/server/app.testSupport.ts src/server/app.workspaceTasks.test.ts src/server/configRoutes.ts src/server/configRoutes.test.ts src/server/workspaceExplorerRoutes.ts src/server/workspaces/fileContentService.ts src/server/app.localAliases.test.ts src/server/app.workspaceFiles.test.ts src/server/workspaceTasks/workspaceTasksWorkspaceFile.ts src/server/workspaceTasks/workspaceTasksWorkspaceFile.test.ts src/server/workspaceTasks/workspaceTasksGlobalMutationGate.ts src/server/workspaceTasks/workspaceTasksGlobalMutationGate.test.ts src/server/workspaceTasks/workspaceTasksWorkspacePathGate.ts src/server/workspaceTasks/workspaceTasksWorkspacePathGate.test.ts src/server/workspaceTasks/workspaceTasksRoutes.ts src/server/workspaceTasks/workspaceTasksRoutes.test.ts
git commit -m "feat(tasks): guard catalog moves at local routes"
```

## Task 9: Federate Workspace Tasks Routes Safely

**Implementer tier:** Advanced

**Files:**

- Create: `src/server/workspaceTasks/workspaceTasksProxyRoutes.ts`
- Modify: `src/shared/federatedRoutes.ts:1-end`
- Modify: `src/server/machines/machineProxyRoutes.ts:1-end`
- Modify: `src/server/app.ts:384-410`
- Modify: `src/server/app.remoteProxy.test.ts:1-end`

**Interfaces:**

- Consumes from Task 2: all strict request parsers and route body limits; from Task 8: local route status/body semantics.
- Produces five allowlisted target routes: workspace `GET`, `PUT`, and `POST move`, plus global `GET` and `PUT`. The move spec has `timeoutMs: 30_000`.
- Produces specialized gateway route registration before `registerMachineProxyRoutes`. It validates portable mutation JSON, applies the same path-specific limits and typed `413` envelopes, forwards to target ordinary `/api/...` paths, forwards target status/body/safe headers unchanged, and uses existing `remoteApiPath()` encoding behavior.
- Produces a generic proxy exclusion for these five specs so Fastify does not create duplicate routes or bypass specialized validation.

- [ ] **Step 1: Add failing federation tests**

Add remote-proxy tests for encoded machine/project/workspace segments, each method/path translation, portable request rejection before upstream request, typed local/gateway `413`, target `400/409/500 unknown-outcome/503` body/status forwarding, a move timeout becoming `504`, missing remote machine `404`, and an explicit local alias resolving locally rather than generic proxy `501`. Assert the specialized handlers register before and exclude themselves from the generic loop. Task 10 adds the browser-client-to-allowlist contract after that client exists.

- [ ] **Step 2: Run federation tests and confirm RED**

Run:

```bash
npm run test:serial -- --run src/server/app.remoteProxy.test.ts
```

Expected: FAIL because the routes are absent from the allowlist and only the generic proxy exists.

- [ ] **Step 3: Implement federated registration**

Add the five immutable route specs to `FEDERATED_HTTP_ROUTES`. Register the task-specific proxy module from `buildApp` before the generic proxy; make the generic loop skip those exact specs. Reuse shared parsers rather than duplicating portable validation. Apply the 30-second timeout only to move, and never mutate a remote machine's config/files from the gateway itself.

- [ ] **Step 4: Run focused GREEN checks**

Run:

```bash
npm run test:serial -- --run src/server/app.remoteProxy.test.ts
npx eslint src/shared/federatedRoutes.ts src/server/machines/machineProxyRoutes.ts src/server/workspaceTasks/workspaceTasksProxyRoutes.ts src/server/app.ts src/server/app.remoteProxy.test.ts
npm run typecheck
```

Expected: all federation contracts pass and task traffic never falls through the generic proxy.

- [ ] **Step 5: Commit the federation task**

```bash
git add src/shared/federatedRoutes.ts src/server/machines/machineProxyRoutes.ts src/server/workspaceTasks/workspaceTasksProxyRoutes.ts src/server/app.ts src/server/app.remoteProxy.test.ts
git commit -m "feat(tasks): federate task catalog routes"
```

## Task 10: Add Status-Aware Browser Transport

**Implementer tier:** Advanced

**Files:**

- Create: `src/client/src/api/workspaceTasksApi.ts`
- Create: `src/client/src/api/workspaceTasksApi.test.ts`
- Modify: `src/client/src/api/http.ts:1-end`
- Modify: `src/client/src/api/http.test.ts:1-end`
- Modify: `src/client/src/api.ts:1-end`
- Modify: `src/client/src/api/federatedRouteContract.test.ts:1-end`

**Interfaces:**

- Consumes from Task 2: request/result/failure types, strict parsers, and body limits; consumes Task 9's five federated route specs and `resolveAppUrl()` through the existing HTTP boundary.
- Produces a status-aware JSON request helper in `http.ts` that resolves an application-relative URL once, returns parsed JSON plus status for known non-2xx responses, and preserves existing throwing `request()` behavior for unrelated clients.
- Produces:

```ts
export interface WorkspaceTasksClient {
  readWorkspace(input: WorkspaceCatalogAddress & { machineId: string }, signal?: AbortSignal): Promise<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>;
  replaceWorkspace(input: WorkspaceCatalogAddress & ReplaceWorkspaceTasksRequest & { machineId: string }): Promise<WorkspaceTasksRequestResult<WorkspaceTasksCatalogResponse>>;
  readGlobal(machineId: string, signal?: AbortSignal): Promise<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>;
  replaceGlobal(input: ReplaceGlobalWorkspaceTasksRequest & { machineId: string }): Promise<WorkspaceTasksRequestResult<GlobalWorkspaceTasksResponse>>;
  move(input: WorkspaceCatalogAddress & MoveWorkspaceTaskRequest & { machineId: string }): Promise<MoveWorkspaceTaskResult | WorkspaceTasksFailureResponse>;
}
export const workspaceTasksApi: WorkspaceTasksClient;
```

- Paths are private helpers ending in `Path`; every call uses `api/machines/${encodeURIComponent(machineId)}/...`, including `local`, and encodes project/workspace IDs. The module has no raw `fetch` call outside `http.ts`.

- [ ] **Step 1: Add failing HTTP/client tests**

Mock `fetch` with a nested `BASE_URL`. Assert exact `GET`, `PUT`, and `POST` paths and JSON bodies for all five calls, including percent-encoded machine/project/workspace IDs. Extend the federated contract test to prove each machine-scoped client path/method has exactly one Task 9 allowlist spec. Assert `resolveAppUrl()` receives an application-relative reference once. Assert valid `200` results parse strictly; typed `400`, `409`, `413`, and `503` bodies become safe typed failures; a valid typed `500 unknown-outcome` body is parsed before generic fallback; `404` becomes scoped unavailable; reads map network, malformed JSON, `502`, `504`, and unexpected `5xx` to unavailable; dispatched replacements/moves map those same ambiguous outcomes to unknown-outcome; a move `409` partial/conflict body is parsed before classification; abort signals reach fetch; and legacy `request()` tests still throw `HttpRequestError` for unrelated non-2xx clients.

- [ ] **Step 2: Run transport tests and confirm RED**

Run:

```bash
npm test -- --run src/client/src/api/http.test.ts src/client/src/api/workspaceTasksApi.test.ts src/client/src/api/federatedRouteContract.test.ts
```

Expected: FAIL because the status-aware helper and Workspace Tasks client do not exist.

- [ ] **Step 3: Implement one transport boundary and feature client**

Do not recover typed bodies from `HttpRequestError`; add the status-aware helper beside `request()`. Parse every known success/error body through Task 2's strict parsers, including the route-defined typed `500 unknown-outcome` response before treating other `5xx` responses as transport ambiguity. Treat a transport failure after dispatch as unknown only for a write, never as proof that the server did nothing. Keep client URL helpers private and name them with `Path` suffix.

- [ ] **Step 4: Run focused GREEN checks**

Run:

```bash
npm test -- --run src/client/src/api/http.test.ts src/client/src/api/workspaceTasksApi.test.ts src/client/src/api/federatedRouteContract.test.ts
npx eslint src/client/src/api/http.ts src/client/src/api/http.test.ts src/client/src/api/workspaceTasksApi.ts src/client/src/api/workspaceTasksApi.test.ts src/client/src/api.ts
npm run typecheck
```

Expected: all client paths are nested-deployment-safe, strictly parsed, and status-aware.

- [ ] **Step 5: Commit the browser-transport task**

```bash
git add src/client/src/api/http.ts src/client/src/api/http.test.ts src/client/src/api/workspaceTasksApi.ts src/client/src/api/workspaceTasksApi.test.ts src/client/src/api.ts src/client/src/api/federatedRouteContract.test.ts
git commit -m "feat(tasks): add catalog browser transport"
```

## Task 11: Implement The Core Workspace Tasks Controller

**Implementer tier:** Capable

**Files:**

- Create: `src/client/src/controllers/workspaceTasksController.ts`
- Create: `src/client/src/controllers/workspaceTasksController.test.ts`

**Interfaces:**

- Consumes from Tasks 1, 2, and 10: `WorkspaceTaskRef`, task configs, catalog states/results, move request/result types, and `WorkspaceTasksClient`.
- Produces a private-cache controller with immutable public snapshot and actions:

```ts
export interface WorkspaceTasksWorkspaceState {
  workspace: WorkspaceTasksCatalogState;
  global: GlobalTasksCatalogState;
  move?: { kind: "partial" | "unknown-outcome" | "conflict"; message: string; retryAllowed: boolean };
  mutationGate?: { scopes: readonly WorkspaceTaskScope[]; message: string };
}
export interface WorkspaceTasksController {
  readonly state: WorkspaceTasksWorkspaceState;
  readonly actions: WorkspaceTasksActions;
  observe(enabled: boolean): void;
  refresh(): Promise<void>;
  dispose(): void;
}
export interface WorkspaceTasksActions {
  create(scope: WorkspaceTaskScope, task: WorkspaceTask): Promise<void>;
  update(ref: WorkspaceTaskRef, task: WorkspaceTask): Promise<void>;
  remove(ref: WorkspaceTaskRef): Promise<void>;
  move(ref: WorkspaceTaskRef, destinationTask: WorkspaceTask): Promise<void>;
  retryMove(): Promise<void>;
  refresh(): Promise<void>;
}
```

- `WorkspaceTasksActions` exposes `create(scope, task)`, `update(ref, task)`, `remove(ref)`, `move(ref, destinationTask)`, `retryMove()`, and `refresh()`. It does not expose raw revisions, generic HTTP, config objects, or filesystem paths.
- Workspace caches key on machine ID, project ID, workspace ID, and workspace path. Global caches key only on machine ID. A controller selection combines both keys and invalidates stale request generations on machine/workspace/path change or dispose.

- [ ] **Step 1: Write failing controller tests**

Use a fake client, UUID factory, selected-scope reader, publish callback, and controllable promises. Assert independent workspace/global loading; no load until observation of an enabled contribution; global cache reuse across workspace changes on the same machine; changed worktree path invalidates the workspace key; same-scope refresh coalescing; stale completion and disposal suppression; loaded data retained through a per-source refresh error; independent usability when the other source is unavailable/invalid; direct CRUD with revision updates and direct conflicts yielding an explicit mutation gate; completed moves; destination collision/source conflict; partial recovery; unknown outcome that refreshes to complete; unknown outcome that refreshes to pristine and requires reconfirmation; guarded retry only after refresh proves destination-written; retry after lost claim remaining manual-resolution-only; no automatic retry; and no stale publication after selection replacement.

- [ ] **Step 2: Run controller tests and confirm RED**

Run:

```bash
npm test -- --run src/client/src/controllers/workspaceTasksController.test.ts
```

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Implement selection-safe caching and recovery**

Keep revisions, expected catalog pairs, operation IDs, request generations, and in-flight requests private. Refresh both sources independently, retaining loaded data with only that source's `refreshError`. Generate one UUID only for a confirmed start move and retain its original semantic context for retry. On an ambiguous write, refresh authoritatively without sending another write; publish completion only when exact complete state is proven. Gate direct conflicts until explicit refresh; never let a background refresh error masquerade as a write-blocking conflict.

- [ ] **Step 4: Run focused GREEN checks**

Run:

```bash
npm test -- --run src/client/src/controllers/workspaceTasksController.test.ts
npx eslint src/client/src/controllers/workspaceTasksController.ts src/client/src/controllers/workspaceTasksController.test.ts
npm run typecheck
```

Expected: all cache, recovery, and stale-result tests pass without sleeps.

- [ ] **Step 5: Commit the controller task**

```bash
git add src/client/src/controllers/workspaceTasksController.ts src/client/src/controllers/workspaceTasksController.test.ts
git commit -m "feat(tasks): control scoped task catalogs"
```

## Task 12: Bridge The Controller Through Internal Plugin Context

**Implementer tier:** Capable

**Files:**

- Create: `src/client/src/components/PiWebUiApp.workspaceTasks.test.ts`
- Modify: `src/client/src/components/PiWebUiApp.ts:54-60`
- Modify: `src/client/src/components/PiWebUiApp.ts:330-370`
- Modify: `src/client/src/components/PiWebUiApp.ts:730-745`
- Modify: `src/client/src/components/PiWebUiApp.ts:1385-1430`
- Modify: `src/client/src/components/PiWebUiApp.ts:3156-3205`
- Modify: `src/client/src/plugins/types.ts:1-180`
- Modify: `src/client/src/plugins/registry.ts:1-end`
- Modify: `src/client/src/plugins/registry.test.ts:1-end`

**Interfaces:**

- Consumes from Task 11: `WorkspaceTasksController`, `WorkspaceTasksWorkspaceState`, and `WorkspaceTasksActions`.
- Produces internal-only `WorkspaceTasksPanelBridge = { state: WorkspaceTasksWorkspaceState; actions: WorkspaceTasksActions }` on the scoped `WorkspacePanelContext` only for the bundled `workspace-tasks` contribution whose local ID is `workspace.tasks`.
- Produces internal `PluginContributionIdentity = { pluginId: PluginId; sourcePluginId?: PluginId; localId: LocalContributionId; machineId?: string }`. `installWorkspacePanelScope()` and registry qualification pass this identity into the app-owned scope callback. The stable public `WorkspacePanelContext` and `src/plugin-api.ts` remain unchanged.
- `PiWebUiApp` creates one controller with a selected-state reader and `requestUpdate()` publish callback, synchronizes `observe()` when workspace selection, machine selection, plugin registration, or contribution visibility changes, and calls `dispose()` on disconnect. It does not add task state to `AppState`.

- [ ] **Step 1: Add failing registry and app-wiring tests**

Add registry tests for passing the full identity to a scoped context, including a remote contribution with a qualified runtime `pluginId` and original `sourcePluginId`. Add app tests with an injected/fake controller that prove only the local `workspace-tasks:workspace.tasks` contribution receives a bridge; unrelated panels receive no extra fields; remote identity matching uses `sourcePluginId`; observation starts only when the qualifying contribution is visible and a workspace is selected; workspace/machine/path changes resynchronize without leaking the old state; same-workspace controller publication rerenders the mounted panel context; and disconnect disables/disposes the controller. Use reflection helpers only to invoke private app lifecycle methods, as existing memory tests do, and do not use global `AppState` mutation to fake controller state.

- [ ] **Step 2: Run bridge tests and confirm RED**

Run:

```bash
npm test -- --run src/client/src/plugins/registry.test.ts src/client/src/components/PiWebUiApp.workspaceTasks.test.ts
```

Expected: FAIL because scope callbacks receive only a plugin string and no controller bridge is wired.

- [ ] **Step 3: Implement identity-scoped bridging and lifecycle wiring**

Extend internal scope callbacks with contribution identity, preserving their current behavior for all existing contributions. In `PiWebUiApp`, recognize `sourcePluginId ?? pluginId` equal to `workspace-tasks` plus `localId` equal to `workspace.tasks`; never use a bare qualified plugin string as the discriminator. Supply state/actions via an internal structural extension only there. Synchronize after external plugin registration and all selected scope transitions, and retain no task state in `AppState`.

- [ ] **Step 4: Run focused GREEN checks**

Run:

```bash
npm test -- --run src/client/src/plugins/registry.test.ts src/client/src/components/PiWebUiApp.workspaceTasks.test.ts src/client/src/components/PiWebUiApp.memory.test.ts
npx eslint src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.workspaceTasks.test.ts src/client/src/plugins/types.ts src/client/src/plugins/registry.ts src/client/src/plugins/registry.test.ts
npm run typecheck
```

Expected: all internal bridge tests pass and public plugin API type declarations remain untouched.

- [ ] **Step 5: Commit the bridge task**

```bash
git add src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.workspaceTasks.test.ts src/client/src/plugins/types.ts src/client/src/plugins/registry.ts src/client/src/plugins/registry.test.ts
git commit -m "feat(tasks): bridge catalog state to bundled panel"
```

## Task 13: Migrate The Bundled Tasks Panel To Scoped Catalogs

**Implementer tier:** Capable

**Files:**

- Create: `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts`
- Modify: `pi-webui-plugins/workspace-tasks/config.ts:1-end`
- Modify: `pi-webui-plugins/workspace-tasks/config.test.ts:1-end`
- Modify: `pi-webui-plugins/workspace-tasks/pi-webui-plugin.ts:1-end`
- Modify: `pi-webui-plugins/workspace-tasks/pi-webui-plugin.test.ts:1-end`
- Modify: `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts:1-end`
- Modify: `pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts:1-end`
- Modify: `pi-webui-plugins/workspace-tasks/taskRunner.ts:1-end`
- Modify: `pi-webui-plugins/workspace-tasks/taskRunner.test.ts:1-end`
- Delete: `pi-webui-plugins/workspace-tasks/workspaceTasksClient.ts`
- Delete: `pi-webui-plugins/workspace-tasks/workspaceTasksClient.test.ts`

**Interfaces:**

- Consumes from Tasks 1, 11, and 12: shared task-domain imports, `WorkspaceTasksPanelBridge`, scoped catalog state, and controller callbacks.
- Preserves `tasksPanelTagName`, `defineTasksPanelElement()`, and `tasksPanelBadge(context)`. The plugin uses a local structural cast for the internal bridge, following the bundled Memory pattern, and renders `.context`, `.workspaceTasksState`, and `.workspaceTasksActions` properties into the custom element.
- Changes runner input to `runWorkspaceTaskInTerminal(terminal, ref, task)`. It preserves one terminal command request and writes separate `"task.scope"` and `"task.id"` metadata.
- Removes all plugin-local task file cache and `WorkspaceFiles.readFile/writeFile/deleteFile` task mutation paths. Invalid workspace catalog UI has no Reset action because it has no CAS revision; the existing file explorer remains the manual repair path.
- Reduces `config.ts` to form draft types, `suggestWorkspaceTaskId()`, and `validateAndNormalizeDraft()`, importing canonical task values/ID validation from `@pi-webui/workspace-tasks-domain`. Move its parser/serializer/array-transform assertions into Task 1's domain test and delete duplicate local implementations.

- [ ] **Step 1: Add failing panel, editor, and terminal regressions**

Build typed shadow-DOM fixtures that inject state/actions rather than file adapters. In the new panel test cover All, Global, and Project filter buttons with counts, a labeled `role="group"`, `aria-pressed`, ordinary button keyboard behavior, scoped failures without hiding the usable source, duplicate global/workspace IDs as independently actionable rows, scope-inclusive accessible Edit/Delete/Run names, and running-state keyed by `WorkspaceTaskRef`. Cover native collapsed `<details>` groups with semantic summaries/counts, `toggle` persistence through All to Global to Project to All, and separate expansion keys for equal group names across scopes. In editor tests cover new task defaulting Project, checked Global creation, scope badge/help copy, unchanged-scope edit, confirmation on promotion/demotion, changed destination ID, destination collision, partial/unknown recovery, retry enabled only after authoritative destination-written refresh, retry rejected after lost claim, manual-resolution copy, dirty Refresh confirmation, Cancel leaving mutation gate intact, and focus restoration. In runner tests assert one command call with exact multiline text and `task.scope` plus `task.id` metadata for equal IDs in each scope.

- [ ] **Step 2: Run panel tests and confirm RED**

Run:

```bash
npm test -- --run pi-webui-plugins/pluginPublicApi.test.ts pi-webui-plugins/workspace-tasks/config.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts pi-webui-plugins/workspace-tasks/taskRunner.test.ts pi-webui-plugins/workspace-tasks/pi-webui-plugin.test.ts
```

Expected: FAIL because the panel owns a direct file cache, uses bare IDs, has no scope controls, and renders non-disclosure groups.

- [ ] **Step 3: Implement scoped presentation and controller actions**

Replace the file client with reactive properties and controller callbacks. Use `WorkspaceTaskRef` or `workspaceTaskRefKey()` for DOM attributes, focus targets, editor source capture, running state, and every action. Keep raw HTML construction escaped. Render explicit scope headings in All, visible scope badges, native details/summary groups, and filter buttons instead of ARIA tabs. Disable only an affected source during a direct write, both sources during a move, and Run only while its terminal dispatch is active. Preserve existing multiline rendering, confirmation, focus, and narrow panel behavior. Do not rerender on textarea input in a way that loses selection.

- [ ] **Step 4: Run focused GREEN checks**

Run:

```bash
npm test -- --run pi-webui-plugins/pluginPublicApi.test.ts pi-webui-plugins/workspace-tasks/config.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts pi-webui-plugins/workspace-tasks/taskRunner.test.ts pi-webui-plugins/workspace-tasks/pi-webui-plugin.test.ts
npx eslint pi-webui-plugins/workspace-tasks/config.ts pi-webui-plugins/workspace-tasks/config.test.ts pi-webui-plugins/workspace-tasks/pi-webui-plugin.ts pi-webui-plugins/workspace-tasks/pi-webui-plugin.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts pi-webui-plugins/workspace-tasks/taskRunner.ts pi-webui-plugins/workspace-tasks/taskRunner.test.ts
npm run typecheck
npm run build:plugins
```

Expected: all tests pass, plugin output builds, and no source file remains named `workspaceTasksClient`.

- [ ] **Step 5: Commit the bundled-panel migration**

```bash
git add pi-webui-plugins/workspace-tasks/config.ts pi-webui-plugins/workspace-tasks/config.test.ts pi-webui-plugins/workspace-tasks/pi-webui-plugin.ts pi-webui-plugins/workspace-tasks/pi-webui-plugin.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts pi-webui-plugins/workspace-tasks/taskRunner.ts pi-webui-plugins/workspace-tasks/taskRunner.test.ts
git rm pi-webui-plugins/workspace-tasks/workspaceTasksClient.ts pi-webui-plugins/workspace-tasks/workspaceTasksClient.test.ts
git commit -m "feat(tasks): add scoped global task panel"
```

## Task 14: Document Global Catalog Operation And Release Metadata

**Implementer tier:** Standard

**Files:**

- Create: `.changeset/workspace-tasks-global-catalog.md`
- Modify: `docs/plugins.md:1-end`
- Modify: `docs/plugins.html:1-end`
- Modify: `docs/config.md:1-end`
- Modify: `docs/config.html:1-end`

**Interfaces:**

- Consumes the completed user-visible behavior from Tasks 7 through 13.
- Produces paired Markdown/HTML guidance with identical semantic content. `docs/plugins.*` documents scope filters, native groups, Project workspace-rooted storage, Git worktree independence, global checkbox behavior, promotion/demotion confirmation and recovery, execution in selected workspace root, trusted shell warning, and multiline execution as one terminal request.
- Produces paired config guidance for `plugins.workspace-tasks.settings.globalTasks`, version-one shape, absent-as-empty behavior, invalid-data repair outside the Tasks panel, semantic revision/CAS behavior, external-writer limits, process-local claim/restart behavior, and the single web/API route-owner deployment requirement.
- Produces one minor Changeset for `@hyperdreamer/pi-webui`. It describes machine-global tasks, scope-aware browsing/editing, worktree-aware local catalogs, and guarded promotion/demotion recovery without claiming atomic protection from arbitrary external writers.

- [ ] **Step 1: Add documentation and Changeset content**

Update both plugin pages with one valid JSON example that has a version-one global catalog and a multiline command represented with escaped `\n`. State that a Project task is stored at the selected workspace's `.pi-webui/tasks.json`, so worktrees have separate catalogs; global tasks execute in the selected workspace root; equal IDs are independently scoped; browser writes canonicalize supported task fields and drop unknown fields; and collision/conflict/recovery paths require Refresh or guarded Retry rather than automatic merge/retry. Update both config pages with the exact nested config key and a safe repair instruction for malformed global values through normal configuration administration, not by panel reset. Keep no internal permit names or raw revisions in user copy.

- [ ] **Step 2: Validate documentation and Changeset status**

Run `npm run changelog:status`, then run `git diff --check -- docs/plugins.md docs/plugins.html docs/config.md docs/config.html .changeset/workspace-tasks-global-catalog.md`.

Expected: Changesets recognizes one minor `@hyperdreamer/pi-webui` change and whitespace validation passes.

- [ ] **Step 3: Review paired-document equivalence**

Compare each Markdown/HTML pair section-by-section. Verify Markdown pages remain package documentation artifacts and HTML pages are intentionally not added to `package.json.files`. Verify `README.md` and `CHANGELOG.md` are unchanged.

- [ ] **Step 4: Commit documentation and release metadata**

```bash
git add docs/plugins.md docs/plugins.html docs/config.md docs/config.html .changeset/workspace-tasks-global-catalog.md
git commit -m "docs(tasks): explain global task catalogs"
```

## Task 15: Verify Browser Behavior And The Complete Branch

**Implementer tier:** Advanced

**Files:**

- Create temporarily, then remove before commit: an ignored or `/tmp` Workspace Tasks browser probe fixture
- Modify only if a measured defect is found: `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts`
- Modify only with a deterministic regression: `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts` or `pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts`

**Interfaces:**

- Consumes the completed server routes, core controller, internal bridge, and real custom element.
- Produces no shipped fixture. The implementation report records exact commands, browser availability, viewport measurements, theme coverage, and any defect/fix evidence.
- Browser acceptance uses Chromium/CDP rather than jsdom geometry. It covers desktop and `430x844`, classic/light/dark tokens, filters, native disclosure state, equal IDs, scope changes, collision/partial recovery, keyboard/focus behavior, long commands, and no overflow/overlap.

- [ ] **Step 1: Run focused cross-layer regression suites**

Run:

```bash
npm test -- --run src/shared/workspaceTasks.test.ts src/shared/workspaceTasksApi.test.ts scripts/build-plugins.test.mjs src/client/src/api/http.test.ts src/client/src/api/workspaceTasksApi.test.ts src/client/src/controllers/workspaceTasksController.test.ts src/client/src/components/PiWebUiApp.workspaceTasks.test.ts src/client/src/plugins/registry.test.ts pi-webui-plugins/pluginPublicApi.test.ts pi-webui-plugins/workspace-tasks/config.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts pi-webui-plugins/workspace-tasks/taskRunner.test.ts pi-webui-plugins/workspace-tasks/pi-webui-plugin.test.ts
npm run test:serial -- --run src/config.test.ts src/configMutationCoordinator.test.ts src/server/workspaceTasks src/server/app.workspaceTasks.test.ts src/server/app.localAliases.test.ts src/server/app.workspaceFiles.test.ts src/server/app.remoteProxy.test.ts
```

Expected: all focused tests pass before browser probing.

- [ ] **Step 2: Run a Chromium/CDP acceptance probe**

Start the existing local web/API dev service only if one is not already running, using a free port and the project's split-service model. Mount the real panel with typed controller state/actions and deterministic catalog responses. At desktop and `430x844`, record panel/document `scrollWidth` versus `clientWidth`, details summary/body bounds, action wrapping, script bounds and vertical overflow, visible `:focus-visible` outline, accessible name of each duplicate-ID action, `aria-pressed` filter state, focus return after cancellation/confirmation, and keyboard Tab/Escape/Enter behavior. Inspect classic, light, and dark tokens. Do not report success if Chromium/CDP is unavailable; report that gap and preserve unit-test evidence.

- [ ] **Step 3: Correct only a measured browser defect**

When the probe finds a defect, add the narrowest deterministic regression first where jsdom can represent it, observe failure, make the minimal source fix, rerun the focused panel suite, then rerun the same browser measurement. Do not create a code change merely to produce a verification commit.

- [ ] **Step 4: Remove probe artifacts and inspect final scope**

Run:

```bash
git status --short
git diff --check
git diff --name-only 5eda56bbab1c295e04623ed156039c3ddc847072..HEAD
```

Expected: no probe artifact is tracked; `README.md`, `CHANGELOG.md`, `src/plugin-api.ts`, session-daemon protocol, and runtime ownership remain unchanged.

- [ ] **Step 5: Run full verification serially**

Run in this order on an otherwise idle machine:

```bash
npm run verify:fast
npm run verify
npm run build
npm run pack:dry
npm run changelog:status
git diff --check
```

Expected: every command exits zero. `pack:dry` lists the compiled Workspace Tasks plugin and `taskDomain.js`, `docs/plugins.md`, and `docs/config.md`; it is not evidence for un-packaged paired HTML pages.

- [ ] **Step 6: Commit only a measured verification fix**

If Step 3 changed source/tests, commit exactly those measured files with a behavior-specific conventional message. Otherwise create no empty verification commit. Do not merge, push, publish, tag, or create a GitHub release.
