# Memory Workspace Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a provider-aware, Terminal-style Memory tab count for global plus project-specific entries, with an immediate selected-scope refresh and a 30-second refresh cadence.

**Architecture:** The server owns memory-provider detection and aggregation behind `MemoryCatalog`; the browser receives one typed snapshot route. During plan decomposition, the approved behavior is retained but the polling state moves from a plugin-local lifecycle element to a focused core `MemoryController`, alongside `GitController`. This is necessary because `WorkspacePanel` renders badges synchronously: a core state value lets the bundled plugin return a primitive number, preserving the generic zero-badge suppression and accessible `Memory, N` label exactly as Terminal does. The Workspace Memory plugin remains a thin, disableable renderer over that state.

**Tech Stack:** TypeScript, Fastify, Lit, Vitest, Node filesystem APIs, existing PI WEBUI federated-route infrastructure.

## Global Constraints

- Fetch immediately for each new machine + project id + workspace id + workspace path scope, then refresh no more often than every **30,000 ms** after the preceding request settles.
- Show a primitive numeric badge only when the total is greater than zero; zero, loading, unavailable, and error states return `undefined`.
- A confirmed unavailable provider hides the Memory workspace tab; an available provider with no entries leaves the tab visible without a number.
- Continue to aggregate global and project entries, including `failures.md`; project-only errors retain global entries and use the existing scoped-unavailable presentation.
- Treat `ENOENT` as a missing optional memory file only. Surface permission and other I/O failures at the appropriate global or project boundary.
- Preserve the existing application-relative URL rule: use `request()` and `URLSearchParams`; do not introduce raw `fetch`, leading `/api`, filesystem watchers, polling WebSockets, or new realtime events.
- Add the snapshot route to `FEDERATED_HTTP_ROUTES` and use the selected machine id so local and remote selected machines behave consistently.
- Do not edit `src/server/sessiond.ts`, alter session ownership, or require a session-daemon restart. This is web/API/client-plugin work.
- Keep the Memory tab read-only. Do not create, write, migrate, or delete memory files.
- Keep `README.md` unchanged. Synchronize user-facing Memory behavior in both `docs/plugins.md` and `docs/plugins.html`.
- Follow TDD: write and run each focused failing test before its production implementation, then commit each independently verifiable task.

---

## File structure

| Path | Responsibility |
| --- | --- |
| `src/shared/apiTypes.ts` | Shared `MemorySnapshotResponse` wire contract used by the route and typed client parser. |
| `src/server/memory/memoryProvider.ts` | Private provider input/result/interface types. |
| `src/server/memory/piHermesMemoryProvider.ts` | The `pi-hermes-memory` state-root probe and safe scoped file reads. |
| `src/server/memory/memoryCatalog.ts` | Deep aggregation module: provider availability, entry id namespacing, and scoped-error combination. |
| `src/server/memory/memoryService.ts` | Compatibility façade for the existing scope-specific routes, delegated to the Hermes provider rather than directly owning file-layout rules. |
| `src/server/memory/memoryRoutes.ts` | Combined snapshot route while retaining the existing two private scope routes. |
| `src/client/src/api/parsers.ts` / `clients.ts` / `api.ts` | Validate and expose `memoryApi.snapshot(projectPath, machineId)`. |
| `src/shared/federatedRoutes.ts` | Allowlist the selected-machine snapshot GET proxy route. |
| `src/client/src/controllers/memoryController.ts` | Selected-workspace lifecycle, stale-result guard, serialized timer scheduling, and retry behavior. |
| `src/client/src/appState.ts` | Store the browser-visible `MemoryWorkspaceState` in `AppState` and reset it with workspace-scoped state. |
| `src/client/src/components/PiWebUiApp.ts` | Construct, update, and dispose `MemoryController`; expose the bundled panel retry callback in the internal workspace context. |
| `pi-webui-plugins/workspace-memory/*` | Replace direct route loading with a thin state-driven panel, synchronous visibility/badge callbacks, and targeted rendering tests. |
| `docs/plugins.md` / `docs/plugins.html` | Canonical paired user documentation for provider visibility and refresh semantics. |
| `.changeset/memory-workspace-badge.md` | Patch-level user-facing release note. |

## Task 1: Add the provider-backed memory snapshot domain

**Files:**
- Create: `src/server/memory/memoryProvider.ts`
- Create: `src/server/memory/piHermesMemoryProvider.ts`
- Create: `src/server/memory/memoryCatalog.ts`
- Create: `src/server/memory/piHermesMemoryProvider.test.ts`
- Create: `src/server/memory/memoryCatalog.test.ts`
- Modify: `src/server/memory/memoryService.ts`
- Modify: `src/server/memory/memoryService.test.ts`
- Modify: `src/shared/apiTypes.ts`

**Interfaces:**
- Produces `MemorySnapshotResponse`, `MemoryProvider`, `MemoryProviderResult`, `PiHermesMemoryProvider`, and `MemoryCatalog` for Tasks 2 and 3.
- Preserves `MemoryService.globalEntries()` and `MemoryService.projectEntries(projectPath)` so the existing private routes stay compatible during this release.

- [ ] **Step 1: Add failing provider and catalog tests.**

Create `piHermesMemoryProvider.test.ts` with a temporary agent directory and tests for an absent provider root, an empty `pi-hermes-memory/` directory, global `MEMORY.md` plus `failures.md`, a project-only root, a project read failure, and a non-`ENOENT` global read failure. Use an injected file-access adapter for the failure cases so the tests do not depend on host permissions.

```ts
it("reports an empty Hermes root as available without inventing entries", async () => {
  await mkdir(join(agentDir, "pi-hermes-memory"));
  const result = await new PiHermesMemoryProvider(agentDir).read({ projectPath: "/work/repo" });

  expect(result).toEqual({ kind: "data", globalEntries: [], projectEntries: [] });
});

it("keeps global entries when only the project read fails", async () => {
  const provider = new PiHermesMemoryProvider(agentDir, {
    readFile: async (path) => {
      if (path === join(agentDir, "pi-hermes-memory", "MEMORY.md")) return "[insight] Global entry";
      if (path === join(agentDir, "pi-hermes-memory", "failures.md")) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
    isDirectory: async () => true,
  });

  await expect(provider.read({ projectPath: "/work/repo" })).resolves.toMatchObject({
    kind: "data",
    globalEntries: [{ content: "[insight] Global entry" }],
    projectEntries: [],
    projectUnavailableMessage: "Project-specific memory could not be loaded.",
  });
});

it("rejects a non-ENOENT global file failure", async () => {
  const provider = new PiHermesMemoryProvider(agentDir, {
    readFile: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    isDirectory: async () => true,
  });

  await expect(provider.read({ projectPath: "/work/repo" })).rejects.toThrow("denied");
});
```

Create `memoryCatalog.test.ts` with fake providers to prove that no available provider produces `unavailable`, available provider ids namespace entry ids, and two available providers aggregate counts by scope.

```ts
it("returns unavailable only when every provider reports unavailable", async () => {
  const catalog = new MemoryCatalog([{ id: "one", read: async () => ({ kind: "unavailable" }) }]);

  await expect(catalog.read("/work/repo")).resolves.toEqual({ kind: "unavailable" });
});

it("prefixes provider-local ids while aggregating scopes", async () => {
  const catalog = new MemoryCatalog([
    { id: "one", read: async () => ({ kind: "data", globalEntries: [{ id: "a", content: "one" }], projectEntries: [] }) },
    { id: "two", read: async () => ({ kind: "data", globalEntries: [], projectEntries: [{ id: "a", content: "two" }] }) },
  ]);

  await expect(catalog.read("/work/repo")).resolves.toEqual({
    kind: "data",
    globalEntries: [{ id: "one:a", content: "one" }],
    projectEntries: [{ id: "two:a", content: "two" }],
  });
});
```

Add a failing `memoryService.test.ts` assertion that the existing scope helpers still return an empty array when no provider root exists.

- [ ] **Step 2: Run the focused server tests and verify the expected failures.**

Run:

```bash
npm test -- --run src/server/memory/piHermesMemoryProvider.test.ts src/server/memory/memoryCatalog.test.ts src/server/memory/memoryService.test.ts
```

Expected: FAIL because the provider/catalog modules and snapshot contract do not exist yet.

- [ ] **Step 3: Define the shared and private contracts, then implement the smallest provider/catalog behavior.**

Add this exact wire union beside `MemoryEntry` in `src/shared/apiTypes.ts`:

```ts
export type MemorySnapshotResponse =
  | { kind: "unavailable" }
  | {
      kind: "data";
      globalEntries: MemoryEntry[];
      projectEntries: MemoryEntry[];
      projectUnavailableMessage?: string;
    };
```

In `memoryProvider.ts`, define the internal seam with a provider id and a single scoped read operation:

```ts
import type { MemoryEntry } from "../../shared/apiTypes.js";

export interface MemoryProviderInput {
  readonly projectPath?: string;
}

export type MemoryProviderResult =
  | { kind: "unavailable" }
  | {
      kind: "data";
      globalEntries: MemoryEntry[];
      projectEntries: MemoryEntry[];
      projectUnavailableMessage?: string;
    };

export interface MemoryProvider {
  readonly id: string;
  read(input: MemoryProviderInput): Promise<MemoryProviderResult>;
}
```

Implement `PiHermesMemoryProvider` with these invariants:

- it considers `join(agentDir, "pi-hermes-memory")` or, when `projectPath` is present, `join(agentDir, "projects-memory", basename(projectPath))` being a directory to be provider availability evidence;
- it loads global entries whether or not `projectPath` is present, and returns an empty project scope when the compatibility façade omits it;
- it rejects unsafe `basename(projectPath)` values (`"."`, `".."`, a slash, or a backslash) as a project-scope failure without discarding usable global memory;
- it reads missing optional files as `[]` only when the error code is `ENOENT`;
- it lets non-`ENOENT` global read errors reject and maps non-`ENOENT` project read errors to the existing generic project-unavailable message;
- it reuses `parseMemoryFile()` for every successful file read.

Implement `MemoryCatalog.read(projectPath)` as the only aggregation point. It calls every registered provider, ignores unavailable providers, prefixes loaded entry ids with `${provider.id}:`, joins global/project arrays, and returns the first project-unavailable message if any available provider reports one. Do not catch provider global failures here; preserving the rejected request distinguishes an operational failure from confirmed unavailability.

Refactor `MemoryService` into a small compatibility façade around `PiHermesMemoryProvider`: `globalEntries()` calls `provider.read({})` and returns `globalEntries` from a data result (or `[]` when unavailable), while `projectEntries(projectPath)` calls `provider.read({ projectPath })` and returns `projectEntries` from a data result (or `[]` when unavailable). Do not duplicate path or file-read logic in this façade.

- [ ] **Step 4: Run the focused server tests and verify they pass.**

Run:

```bash
npm test -- --run src/server/memory/piHermesMemoryProvider.test.ts src/server/memory/memoryCatalog.test.ts src/server/memory/memoryService.test.ts
```

Expected: PASS. The tests prove absent versus empty provider detection, safe errors, aggregation, id namespacing, and legacy helper compatibility.

- [ ] **Step 5: Commit the provider/catalog domain.**

```bash
git add src/shared/apiTypes.ts src/server/memory/memoryProvider.ts src/server/memory/piHermesMemoryProvider.ts src/server/memory/memoryCatalog.ts src/server/memory/memoryService.ts src/server/memory/piHermesMemoryProvider.test.ts src/server/memory/memoryCatalog.test.ts src/server/memory/memoryService.test.ts
git commit -m "feat(memory): add provider-backed memory catalog"
```

## Task 2: Expose one typed snapshot route across local and federated machines

**Files:**
- Modify: `src/server/memory/memoryRoutes.ts`
- Modify: `src/server/memory/memoryRoutes.test.ts`
- Modify: `src/shared/federatedRoutes.ts`
- Modify: `src/client/src/api/parsers.ts`
- Modify: `src/client/src/api/parsers.test.ts`
- Modify: `src/client/src/api/clients.ts`
- Modify: `src/client/src/api/clients.test.ts`
- Modify: `src/client/src/api.ts`
- Modify: `src/client/src/api/federatedRouteContract.test.ts`

**Interfaces:**
- Consumes `MemoryCatalog.read(projectPath): Promise<MemorySnapshotResponse>` from Task 1.
- Produces `memoryApi.snapshot(projectPath: string, machineId?: string): Promise<MemorySnapshotResponse>` for Task 3.
- Retains `GET api/agent-memory/global` and `GET api/agent-memory/project` as private compatibility routes; the new bundled UI must not call them.

- [ ] **Step 1: Add failing route, parser, and federated-contract tests.**

Add `GET /api/agent-memory/snapshot` cases to `memoryRoutes.test.ts`:

```ts
it("returns unavailable when no compatible provider root exists", async () => {
  app = await buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/api/agent-memory/snapshot?projectPath=%2Fwork%2Frepo",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ kind: "unavailable" });
});

it("returns global and project scopes in one snapshot", async () => {
  await mkdir(join(agentDir, "pi-hermes-memory"), { recursive: true });
  await writeMemoryFile("pi-hermes-memory/MEMORY.md", "Global entry");
  await writeMemoryFile("projects-memory/repo/MEMORY.md", "Project entry");
  app = await buildApp();

  const response = await app.inject({
    method: "GET",
    url: "/api/agent-memory/snapshot?projectPath=%2Fwork%2Frepo",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ kind: "data", globalEntries: [{ content: "Global entry" }], projectEntries: [{ content: "Project entry" }] });
});
```

Add an explicit `400` snapshot-route test for a missing `projectPath`, then add parser tests that reject a missing `kind`, reject malformed entry arrays, preserve a `projectUnavailableMessage`, and accept the `unavailable` branch. Add a client test proving the new request is application-relative, uses `URLSearchParams`, and maps a remote machine to `api/machines/<encoded-id>/agent-memory/snapshot`.

Add this expected federated route and call to `federatedRouteContract.test.ts`:

```ts
expect(FEDERATED_HTTP_ROUTES).toContainEqual({ method: "GET", path: "/agent-memory/snapshot" });
await ignoreParseFailure(memoryApi.snapshot(workspace.path, machineId));
```

- [ ] **Step 2: Run focused transport tests and verify the expected failures.**

Run:

```bash
npm test -- --run src/server/memory/memoryRoutes.test.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts src/client/src/api/federatedRouteContract.test.ts
```

Expected: FAIL because the snapshot route, parser, selected-machine client, and federated allowlist do not yet exist.

- [ ] **Step 3: Implement the combined route and typed selected-machine client.**

In `memoryRoutes.ts`, add a snapshot GET route for both registered prefixes. Require a non-empty `projectPath`, obtain the active profile using the existing `requireActiveAgentProfile()` boundary, construct `MemoryCatalog([new PiHermesMemoryProvider(profile.dir)])`, and return `catalog.read(projectPath)`. Map `ActiveAgentProfileAccessError` to the existing 503 response exactly as the old scope routes do.

In `parsers.ts`, add a strict parser with these exact branch rules:

```ts
export function parseMemorySnapshotResponse(value: unknown): MemorySnapshotResponse {
  if (!isRecord(value) || typeof value["kind"] !== "string") throw new Error("Invalid memory snapshot response");
  if (value["kind"] === "unavailable") return { kind: "unavailable" };
  if (value["kind"] !== "data") throw new Error("Invalid memory snapshot response");
  return {
    kind: "data",
    globalEntries: parseMemoryEntries(value["globalEntries"]),
    projectEntries: parseMemoryEntries(value["projectEntries"]),
    ...(typeof value["projectUnavailableMessage"] === "string" ? { projectUnavailableMessage: value["projectUnavailableMessage"] } : {}),
  };
}

function parseMemoryEntries(value: unknown): MemoryEntry[] {
  if (!Array.isArray(value)) throw new Error("Invalid memory snapshot response");
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry["id"] !== "string" || typeof entry["content"] !== "string") {
      throw new Error("Invalid memory snapshot response");
    }
    return {
      id: entry["id"],
      content: entry["content"],
      ...(typeof entry["category"] === "string" ? { category: entry["category"] } : {}),
      ...(typeof entry["created"] === "string" ? { created: entry["created"] } : {}),
      ...(typeof entry["last"] === "string" ? { last: entry["last"] } : {}),
      ...(typeof entry["failureReason"] === "string" ? { failureReason: entry["failureReason"] } : {}),
    };
  });
}
```

Reuse the strict entry validation above rather than accepting malformed entries silently at this new boundary.

In `clients.ts`, add a private path helper and public API object:

```ts
function memorySnapshotPath(projectPath: string, machineId = "local"): string {
  const params = new URLSearchParams({ projectPath });
  return `${machinePrefix(machineId)}/agent-memory/snapshot?${params.toString()}`;
}

export const memoryApi = {
  snapshot: (projectPath: string, machineId = "local") => request(memorySnapshotPath(projectPath, machineId), parseMemorySnapshotResponse),
};
```

Export `memoryApi` from `api.ts`, include it in the aggregate `api` object, and add `{ method: "GET", path: "/agent-memory/snapshot" }` to `FEDERATED_HTTP_ROUTES`. This causes the existing machine proxy to forward the request to the selected remote machine without adding a bespoke proxy.

- [ ] **Step 4: Run focused transport tests and verify they pass.**

Run:

```bash
npm test -- --run src/server/memory/memoryRoutes.test.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts src/client/src/api/federatedRouteContract.test.ts
```

Expected: PASS. The snapshot contract is strict, local/remote paths are deployment-relative and encoded, and federation explicitly allowlists the read-only route.

- [ ] **Step 5: Commit the snapshot transport layer.**

```bash
git add src/server/memory/memoryRoutes.ts src/server/memory/memoryRoutes.test.ts src/shared/federatedRoutes.ts src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.ts src/client/src/api/clients.test.ts src/client/src/api.ts src/client/src/api/federatedRouteContract.test.ts
git commit -m "feat(memory): expose federated snapshot route"
```

## Task 3: Add a scoped core Memory controller with serialized 30-second refreshes

**Files:**
- Create: `src/client/src/controllers/memoryController.ts`
- Create: `src/client/src/controllers/memoryController.test.ts`
- Create: `src/client/src/components/PiWebUiApp.memory.test.ts`
- Modify: `src/client/src/appState.ts`
- Modify: `src/client/src/components/PiWebUiApp.ts`
- Modify: `src/client/src/plugins/types.ts`

**Interfaces:**
- Consumes `memoryApi.snapshot(projectPath, machineId)` from Task 2.
- Produces `MemoryWorkspaceState`, `MemoryController.updatePolling()`, `MemoryController.refresh()`, and the internal `WorkspacePanelContext.onRefreshMemory()` callback used by Task 4.
- Owns all browser timer creation, cleanup, scope switching, and stale-response suppression; the workspace plugin must not call timers or network APIs directly.

- [ ] **Step 1: Add failing controller and app-state tests.**

Define the desired state union in `appState.ts` and exercise it through a controller harness, following the existing `GitController` test style:

```ts
export type MemoryWorkspaceState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | {
      kind: "data";
      globalEntries: MemoryEntry[];
      projectEntries: MemoryEntry[];
      projectUnavailableMessage?: string;
      refreshError?: string;
    }
  | { kind: "error"; message: string };
```

Add these controller tests with an injected fetcher and timer scheduler:

```ts
it("loads immediately and schedules the next poll only after the request settles", async () => {
  const snapshot = vi.fn().mockResolvedValue({ kind: "data", globalEntries: [entry("g")], projectEntries: [entry("p")] });
  const timers = fakeTimers();
  const harness = controllerFor({ snapshot, timers });

  harness.controller.updatePolling();
  await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce());

  expect(harness.state.memory).toMatchObject({ kind: "data" });
  expect(timers.delays).toEqual([30_000]);
});

it("does not schedule an overlapping poll while the current poll is unresolved", async () => {
  const pending = deferred<MemorySnapshotResponse>();
  const snapshot = vi.fn()
    .mockResolvedValueOnce(dataSnapshot("initial"))
    .mockReturnValueOnce(pending.promise);
  const harness = controllerFor({ snapshot, timers: fakeTimers() });

  harness.controller.updatePolling();
  await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
  harness.timers.fireLatest();
  await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));

  expect(harness.timers.pendingCallbacks()).toHaveLength(0);
  expect(snapshot).toHaveBeenCalledTimes(2);
});

it("drops a late workspace-A snapshot after workspace-B becomes current", async () => {
  const first = deferred<MemorySnapshotResponse>();
  const second = deferred<MemorySnapshotResponse>();
  const harness = controllerFor({ snapshot: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) });

  harness.controller.updatePolling();
  harness.apply({ selectedWorkspace: { ...workspace, id: "workspace-b", path: "/work/b" } });
  harness.controller.updatePolling();
  second.resolve(dataSnapshot("b"));
  await vi.waitFor(() => expect(harness.state.memory).toMatchObject({ kind: "data", globalEntries: [{ content: "b" }] }));
  first.resolve(dataSnapshot("a"));
  await Promise.resolve();

  expect(harness.state.memory).toMatchObject({ kind: "data", globalEntries: [{ content: "b" }] });
});
```

Use these deterministic test helpers in the same file so no test depends on wall-clock time:

```ts
interface FakeTimers {
  readonly delays: number[];
  fireLatest(): void;
  pendingCallbacks(): Array<() => void>;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
}

function fakeTimers(): FakeTimers {
  const callbacks = new Map<number, () => void>();
  const delays: number[] = [];
  let nextId = 1;
  return {
    delays,
    setTimeout(callback, delayMs) {
      const id = nextId++;
      delays.push(delayMs);
      callbacks.set(id, callback);
      return id;
    },
    clearTimeout(id) { callbacks.delete(id); },
    fireLatest() {
      const entry = [...callbacks.entries()].at(-1);
      if (entry === undefined) throw new Error("Expected a pending timer");
      callbacks.delete(entry[0]);
      entry[1]();
    },
    pendingCallbacks: () => [...callbacks.values()],
  };
}

function entry(id: string): MemoryEntry {
  return { id, content: id };
}

function dataSnapshot(label: string): Extract<MemorySnapshotResponse, { kind: "data" }> {
  return { kind: "data", globalEntries: [{ id: label, content: label }], projectEntries: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}

function controllerFor(input: { snapshot: MemoryControllerDependencies["snapshot"]; timers: FakeTimers }) {
  let state = { ...initialAppState(), selectedProject: project, selectedWorkspace: workspace };
  const controller = new MemoryController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    { snapshot: input.snapshot, timer: input.timers },
  );
  return {
    controller,
    timers: input.timers,
    get state() { return state; },
    apply: (patch: Partial<AppState>) => { state = { ...state, ...patch }; },
  };
}
```

Also test confirmed unavailability, an available zero-entry snapshot, project-only errors, retention of a prior data value plus `refreshError` after a background failure, `dispose()` timer cleanup, and a changed workspace path with the same project id.

Add an app-level test that `handleWorkspaceChange` starts memory polling and that `disconnectedCallback` disposes it. Add a test that `resetWorkspaceScopedState()` restores `memory` to `{ kind: "loading" }`.

- [ ] **Step 2: Run the focused controller tests and verify the expected failures.**

Run:

```bash
npm test -- --run src/client/src/controllers/memoryController.test.ts src/client/src/components/PiWebUiApp.memory.test.ts
```

Expected: FAIL because no memory app state or controller exists.

- [ ] **Step 3: Implement the controller and wire it into application lifecycle.**

Create `MemoryController` with explicit injected dependencies:

```ts
export interface MemoryTimer {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
}

export interface MemoryControllerDependencies {
  snapshot?: (projectPath: string, machineId: string) => Promise<MemorySnapshotResponse>;
  timer?: MemoryTimer;
  pollIntervalMs?: number;
}

const defaultMemoryTimer: MemoryTimer = {
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (id) => { window.clearTimeout(id); },
};

export class MemoryController {
  private readonly fetchSnapshot: NonNullable<MemoryControllerDependencies["snapshot"]>;
  private readonly timer: MemoryTimer;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    deps: MemoryControllerDependencies = {},
  ) {
    this.fetchSnapshot = deps.snapshot ?? memoryApi.snapshot;
    this.timer = deps.timer ?? defaultMemoryTimer;
    this.pollIntervalMs = deps.pollIntervalMs ?? 30_000;
  }
}
```

Use `30_000` as the default interval. `updatePolling()` must derive a JSON scope key from selected machine id, selected project id, selected workspace id, and selected workspace path. On a new key it must invalidate the prior generation, clear the prior timeout, set `memory` to loading, start one request, and schedule only the next current-generation request after that request resolves or rejects. A request already in flight for the current generation must be reused rather than duplicated.

`refresh()` must run a foreground request for the current scope without changing the scope key. On initial failure, set `{ kind: "error", message }`; when the previous state is `data`, retain its entries and set `refreshError` instead. A successful snapshot clears `refreshError`. A result is applied only when the selected machine/project/workspace/path still matches the captured scope.

Add `memory: MemoryWorkspaceState` to `AppState`, its initial state, and `resetWorkspaceScopedState()`. In `PiWebUiApp`:

- construct `MemoryController` beside `GitController`;
- call `this.memory.updatePolling()` after a selected workspace becomes current in `handleWorkspaceChange()`;
- call `this.memory.dispose()` in `disconnectedCallback()`;
- expose `onRefreshMemory: () => { void this.memory.refresh(); }` from `createWorkspacePanelContext()`;
- add `onRefreshMemory` to the internal client `WorkspacePanelContext` only. Do not expand the documented public plugin API for this bundled implementation detail.

The bundled plugin will use a local narrowed context type in Task 4 rather than an untyped `any` cast.

- [ ] **Step 4: Run focused controller and application lifecycle tests and verify they pass.**

Run:

```bash
npm test -- --run src/client/src/controllers/memoryController.test.ts src/client/src/components/PiWebUiApp.memory.test.ts
npm run typecheck
```

Expected: PASS. The controller owns scope changes, serial refreshes, stale suppression, background error retention, retry, and cleanup without a session-daemon change.

- [ ] **Step 5: Commit the core memory polling state.**

```bash
git add src/client/src/controllers/memoryController.ts src/client/src/controllers/memoryController.test.ts src/client/src/appState.ts src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.memory.test.ts src/client/src/plugins/types.ts
git commit -m "feat(memory): poll selected workspace memory state"
```

## Task 4: Make the bundled Memory plugin a thin synchronous tab renderer

**Files:**
- Delete: `pi-webui-plugins/workspace-memory/memoryClient.ts`
- Delete: `pi-webui-plugins/workspace-memory/memoryClient.test.ts`
- Delete: `pi-webui-plugins/workspace-memory/memoryLoadController.ts`
- Delete: `pi-webui-plugins/workspace-memory/memoryLoadController.test.ts`
- Modify: `pi-webui-plugins/workspace-memory/memoryData.ts`
- Modify: `pi-webui-plugins/workspace-memory/memoryPanelElement.ts`
- Modify: `pi-webui-plugins/workspace-memory/memoryPanelElement.test.ts`
- Modify: `pi-webui-plugins/workspace-memory/pi-webui-plugin.ts`
- Modify: `pi-webui-plugins/workspace-memory/pi-webui-plugin.test.ts`
- Modify: `src/client/src/components/WorkspacePanel.test.ts`

**Interfaces:**
- Consumes `MemoryWorkspaceState` and `onRefreshMemory()` from Task 3.
- Produces synchronous `visible(context)` and `badge(context)` behavior for the generic `WorkspacePanel`.
- Preserves the existing read-only entry/group rendering, category styles, empty states, project-unavailable message, and manual Retry button.

- [ ] **Step 1: Add failing plugin and rendering tests.**

Add focused pure helper tests in `memoryPanelElement.test.ts`:

```ts
it("returns no tab count for loading, unavailable, error, or empty data", () => {
  expect(memoryBadge({ kind: "loading" })).toBeUndefined();
  expect(memoryBadge({ kind: "unavailable" })).toBeUndefined();
  expect(memoryBadge({ kind: "error", message: "offline" })).toBeUndefined();
  expect(memoryBadge({ kind: "data", globalEntries: [], projectEntries: [] })).toBeUndefined();
});

it("sums global and project entries for a positive tab count", () => {
  expect(memoryBadge({
    kind: "data",
    globalEntries: [{ id: "g", content: "global" }],
    projectEntries: [{ id: "p1", content: "one" }, { id: "p2", content: "two" }],
  })).toBe(3);
});

it("hides only a confirmed unavailable provider", () => {
  expect(isMemoryPanelVisible({ kind: "unavailable" })).toBe(false);
  expect(isMemoryPanelVisible({ kind: "loading" })).toBe(true);
  expect(isMemoryPanelVisible({ kind: "data", globalEntries: [], projectEntries: [] })).toBe(true);
  expect(isMemoryPanelVisible({ kind: "error", message: "offline" })).toBe(true);
});
```

Update panel lifecycle tests so setting a new `memoryState` renders data without invoking network mocks, and pressing Retry calls the supplied callback once. Update plugin activation tests to assert it declares both `visible` and `badge` callbacks and that they return the helpers' primitive values.

Add a generic `WorkspacePanel` test that supplies a Memory panel with `badge: () => 3` and asserts the rendered template includes `tab-badge` and a button `aria-label`/`title` of `Memory, 3`. Add the zero case and assert no `tab-badge` is rendered.

- [ ] **Step 2: Run focused plugin and workspace-tab tests and verify the expected failures.**

Run:

```bash
npm test -- --run pi-webui-plugins/workspace-memory/memoryPanelElement.test.ts pi-webui-plugins/workspace-memory/pi-webui-plugin.test.ts src/client/src/components/WorkspacePanel.test.ts
```

Expected: FAIL because the current plugin still fetches its own two routes and has no visibility/count helpers.

- [ ] **Step 3: Replace direct loading with core-state rendering.**

Delete the old direct browser client and `MemoryLoadController`; the core typed client/controller from Tasks 2–3 is the sole network and timer owner.

Keep `memoryData.ts` as the entry-shape home for entry rendering, but make `memoryPanelElement.ts` accept state and retry inputs instead of owning a fetch controller:

```ts
set memoryState(value: MemoryWorkspaceState) {
  this.state = toMemoryPanelState(value);
  this.render();
}

set onRetry(value: () => void) {
  this.retry = value;
}
```

`toMemoryPanelState()` must preserve the existing `loading`, `data`, and `error` render states. It must render `unavailable` as the existing empty/no-workspace-compatible state defensively, even though a confirmed unavailable contribution is normally filtered before its panel renders. When `refreshError` accompanies `data`, retain the scope groups and render a non-destructive status plus the existing Retry control.

Add type-only imports in both bundled plugin files that need the state shape:

```ts
import type { AppState, MemoryWorkspaceState } from "../../src/client/src/appState.js";
```

In `pi-webui-plugin.ts`, define one local narrowed type without `any`:

```ts
type BundledMemoryContext = WorkspacePanelContext & {
  readonly state: AppState;
  readonly onRefreshMemory: () => void;
};

function bundledMemoryContext(context: WorkspacePanelContext): BundledMemoryContext {
  return context as BundledMemoryContext;
}
```

Use that helper in the contribution:

```ts
visible: (context) => isMemoryPanelVisible(bundledMemoryContext(context).state.memory),
badge: (context) => memoryBadge(bundledMemoryContext(context).state.memory),
render: (context) => {
  const memory = bundledMemoryContext(context);
  return html`<pi-webui-memory-panel .context=${context} .memoryState=${memory.state.memory} .onRetry=${memory.onRefreshMemory}></pi-webui-memory-panel>`;
},
```

This leaves `WorkspacePanel` unchanged in production: its existing primitive badge logic hides zero values and produces accessible numeric labels. Do not return a `TemplateResult` badge or add an empty badge wrapper.

- [ ] **Step 4: Run focused plugin and workspace-tab tests and verify they pass.**

Run:

```bash
npm test -- --run pi-webui-plugins/workspace-memory/memoryPanelElement.test.ts pi-webui-plugins/workspace-memory/pi-webui-plugin.test.ts src/client/src/components/WorkspacePanel.test.ts
npm run build:plugins
```

Expected: PASS. The plugin has no raw memory fetch/timer code, zero has no visual badge, positive totals use the shared terminal-style badge, unavailable hides the tab, and retry returns to the core controller.

- [ ] **Step 5: Commit the state-driven Memory plugin.**

```bash
git add -A pi-webui-plugins/workspace-memory src/client/src/components/WorkspacePanel.test.ts
git commit -m "feat(memory): show provider-aware workspace badge"
```

Before committing, inspect `git diff --cached --name-status` and confirm that only the four obsolete direct-loading files are deleted; do not accidentally stage `dist/` or worktree artifacts.

## Task 5: Document behavior, add the release note, and verify the shipped change

**Files:**
- Modify: `docs/plugins.md`
- Modify: `docs/plugins.html`
- Create: `.changeset/memory-workspace-badge.md`

**Interfaces:**
- Documents the implemented behavior from Tasks 1–4; does not introduce a configuration option or a separate provider-registration protocol.
- Produces a patch Changeset for release preparation.

- [ ] **Step 1: Add the paired documentation and Changeset.**

Extend the Memory section in both documentation files with the same user-visible claims:

- the Memory tab is shown only when a compatible memory provider is detected for the active agent profile/project scope;
- a compatible provider with zero entries still shows the tab, while the badge is omitted;
- a positive badge totals global and project-specific entries;
- PI WEBUI refreshes immediately after a selected project/workspace change and then checks approximately every 30 seconds;
- this is polling, not a promise of instant realtime updates.

Create this exact Changeset:

```md
---
"@hyperdreamer/pi-webui": patch
---

Show the effective global and project memory entry count on the Memory workspace tab.
```

Do not add a new brittle documentation parser test. Step 2 verifies the paired content directly and the full build/verification suite covers packaged source integrity.

- [ ] **Step 2: Run documentation and packaging-oriented checks.**

Run:

```bash
node scripts/projectIdentity.test.mjs
npm run build:plugins
git diff --check
```

Expected: PASS. Confirm `docs/plugins.md` and `docs/plugins.html` make the same claims and `README.md` is unchanged.

- [ ] **Step 3: Perform a manual development-service smoke check.**

With the UI/API development service running, verify these observable states:

1. Select a workspace with an available Hermes root and two global plus one project entry; the Memory tab shows `3` and its accessible label includes `Memory, 3`.
2. Add a new entry through the external memory tool; the badge and open panel update within 30 seconds without switching tabs.
3. Switch to another project/worktree; the old count disappears while loading and the new scope replaces it without a stale result.
4. Use an available but empty provider root; the tab remains present with no badge.
5. Use an agent profile with no provider roots; the Memory tab disappears after its availability check.
6. Simulate a project-only read failure; global count remains visible and the panel reports project memory unavailable.

Do not restart `pi-webui-sessiond.service`; the implementation changes only web/API/client-plugin paths. The normal UI/API development service reload path is sufficient.

- [ ] **Step 4: Run final repository verification.**

Run:

```bash
npm run verify
git diff --check
git status --short
```

Expected: `npm run verify` passes; the remaining changes are only the intended documentation and Changeset files before their commit.

- [ ] **Step 5: Commit documentation and release metadata.**

```bash
git add docs/plugins.md docs/plugins.html .changeset/memory-workspace-badge.md
git commit -m "docs: describe memory workspace badge"
```

Do not edit `CHANGELOG.md`; release preparation generates it from the Changeset.

## Plan self-review

### Spec coverage

- **Global plus project count / Terminal-style rendering:** Tasks 3–4 produce a primitive count in `AppState` and pass it through the existing `WorkspacePanel` badge path.
- **Immediate and 30-second refresh:** Task 3 owns immediate scope loads, serialized 30,000 ms scheduling, stale suppression, manual retry, and teardown.
- **Unavailable versus empty provider:** Tasks 1–2 establish typed availability; Task 4 uses it only for panel visibility.
- **Hermes compatibility and future adapters:** Task 1 isolates all format and filesystem rules behind `MemoryProvider` and `MemoryCatalog`.
- **No watcher/realtime/sessiond work:** Global constraints and Task 3 use client timeout scheduling only; Task 5 explicitly verifies no daemon restart is needed.
- **Federation and URL conventions:** Task 2 adds the selected-machine client call and federated allowlist with contract coverage.
- **Error handling:** Tasks 1, 3, and 4 cover `ENOENT`, I/O failures, partial project errors, retained values, and retry UI.
- **Documentation and release process:** Task 5 updates only the canonical plugin pages and adds a patch Changeset.

### Placeholder scan

The plan contains no unresolved task markers, deferred implementation notes, or unspecified test cases. All created types, public method names, route paths, state names, timer values, test commands, and commit messages are defined in the task that introduces them.

### Type consistency

- Task 1 defines `MemorySnapshotResponse`, `MemoryProvider`, `MemoryProviderResult`, `PiHermesMemoryProvider`, and `MemoryCatalog` before Task 2 consumes the snapshot response.
- Task 2 defines `memoryApi.snapshot(projectPath, machineId)` before Task 3 constructs `MemoryController` around it.
- Task 3 defines `MemoryWorkspaceState` and `onRefreshMemory` before Task 4 reads them through `BundledMemoryContext`.
- Task 4's `memoryBadge()` returns `number | undefined`, exactly matching the existing `WorkspacePanelContribution.badge` contract.
