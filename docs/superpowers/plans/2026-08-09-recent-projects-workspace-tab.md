# Recent Projects Workspace Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a machine-level Recent Projects tab to the workspace panel, backed by a persistent per-machine most-recently-used project history that is independent of project registration.

**Architecture:** The machine-local project registry document gains an optional `recentProjects` collection whose invariants (server clock, path dedupe, move-to-front, 20-entry cap, quarantine of malformed history) are owned by `ProjectStore` inside its existing serialized write queue. Three new HTTP routes are registered for `/api` and `/api/machines/local` and added to the federation allowlist. A focused client controller owns machine-scoped loading and mutation serialization, and the app shell resolves workspace-panel tabs into a presentation model so a machine-level tab can exist with no selected workspace.

**Tech Stack:** TypeScript, Node 22, Fastify, Lit 3, Vitest.

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-08-09-recent-projects-workspace-tab-design.md`. It is authoritative; do not add behavior it excludes.
- The history limit is exactly 20 entries per machine, newest first. It is not user-configurable.
- Selection, browsing, polling, reconnects, assistant streaming, terminal output, and activity-indicator changes must never add or reorder history.
- History paths must use the same identity rule the registry uses for registration dedupe: `ProjectService.add` resolves the path with `realpath`, and `ProjectStore` dedupes by exact equality on that resolved value. Never persist an unresolved client-supplied path, and never introduce a new path-comparison rule.
- Every project-registry write path must round-trip `recentProjects`. The current writer serializes only `{ projects }`, so any missed path silently destroys history.
- Malformed `recentProjects` must never fail a registered-project read and must never be replaced with an empty collection; preserve the raw value.
- Unregistering a project or project tree must leave history untouched.
- The persisted tab id is exactly `core:recent-projects`; it is stored in URL routes and per-machine navigation memory.
- No new runtime dependencies. No session-daemon protocol, session-runtime ownership, or session-lifecycle change. No public plugin API change.
- Do not edit `CHANGELOG.md`; user-visible work ships via a Changeset.
- Do not expand `README.md`.
- Client browser URLs stay application-relative (no leading slash) and encode each dynamic segment exactly once with `encodeURIComponent`.
- Run the narrowest test first: `npm test -- --run <file>`. Test counts in steps are the counts at authoring time; treat "PASS with no failures" as the gate.
- Every task's requirements implicitly include this section.

## Task 1: Recent-project history invariants in the project store

**Implementer tier:** Advanced

**Files:**

- Modify: `src/shared/apiTypes.ts:506-513`
- Modify: `src/server/storage/projectStore.ts:1-16`
- Modify: `src/server/storage/projectStore.ts:88-247`
- Test: `src/server/storage/projectStore.recentProjects.test.ts`

**Interfaces:**

- Consumes: nothing; this is the first task.
- Produces, exported from `src/shared/apiTypes.ts`:
  - `interface RecentProjectEntry { id: string; name: string; path: string; lastUsedAt: string }`
  - `const RECENT_PROJECT_LIMIT = 20`
- Produces, on `ProjectStore` in `src/server/storage/projectStore.ts`:
  - `constructor(filePath?: string, now?: () => Date)`
  - `listRecent(): Promise<RecentProjectEntry[]>` — rejects when stored history is malformed.
  - `touchRecent(projectId: string): Promise<RecentProjectEntry[] | undefined>` — `undefined` when the project id is unknown.
  - `removeRecent(entryId: string): Promise<RecentRemoval>` where
    `type RecentRemoval = { kind: "removed"; entries: RecentProjectEntry[] } | { kind: "not-found" } | { kind: "registered" }`
- Produces, unchanged in signature but now history-preserving: `add`, `remove`, `removeTree`, `setPinned`.

- [ ] **Step 1: Add the shared type and limit**

In `src/shared/apiTypes.ts`, directly after the existing `Project` interface (which ends with `pinned?: boolean;` and its closing brace), add:

```ts
/** Maximum number of remembered recent projects per machine. */
export const RECENT_PROJECT_LIMIT = 20;

/**
 * One remembered project in a machine's most-recently-used history. Independent
 * of registration: an entry survives closing the project, and `path` (not a
 * project id) is the durable identity because reopening can mint a new id.
 */
export interface RecentProjectEntry {
  id: string;
  name: string;
  path: string;
  lastUsedAt: string;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/server/storage/projectStore.recentProjects.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RECENT_PROJECT_LIMIT } from "../../shared/apiTypes.js";
import { ProjectStore } from "./projectStore.js";

let tempDir = "";
let filePath = "";
let clock = 0;

function storeWithClock(): ProjectStore {
  clock = 0;
  return new ProjectStore(filePath, () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++clock)));
}

async function readRaw(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-webui-recent-projects-"));
  filePath = join(tempDir, "projects.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});
```

Append these suites to the same file:

```ts
describe("ProjectStore recent history", () => {
  it("starts empty and loads a document that has no history field", async () => {
    await writeFile(filePath, `${JSON.stringify({ projects: [] })}\n`, "utf8");
    expect(await storeWithClock().listRecent()).toEqual([]);
  });

  it("records a newly added project at the top with a server timestamp", async () => {
    const store = storeWithClock();
    await store.add({ path: "/work/alpha" });
    const beta = await store.add({ path: "/work/beta" });

    const entries = await store.listRecent();

    expect(entries.map((entry) => entry.path)).toEqual(["/work/beta", "/work/alpha"]);
    expect(entries[0]).toMatchObject({ name: "beta", lastUsedAt: "2026-01-01T00:00:02.000Z" });
    expect(entries[0]?.id).not.toBe(beta.id);
  });

  it("re-adding a registered path keeps one entry and moves it to the top", async () => {
    const store = storeWithClock();
    const alpha = await store.add({ path: "/work/alpha" });
    await store.add({ path: "/work/beta" });
    const first = await store.listRecent();

    const readded = await store.add({ path: "/work/alpha" });
    const entries = await store.listRecent();

    expect(readded.id).toBe(alpha.id);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.path)).toEqual(["/work/alpha", "/work/beta"]);
    expect(entries[0]?.id).toBe(first.find((entry) => entry.path === "/work/alpha")?.id);
  });

  it("touches a registered project, preserving the entry id and updating the name", async () => {
    const store = storeWithClock();
    const alpha = await store.add({ name: "Alpha", path: "/work/alpha" });
    await store.add({ path: "/work/beta" });
    const before = await store.listRecent();

    const entries = await store.touchRecent(alpha.id);

    expect(entries?.map((entry) => entry.path)).toEqual(["/work/alpha", "/work/beta"]);
    expect(entries?.[0]?.id).toBe(before.find((entry) => entry.path === "/work/alpha")?.id);
    expect(entries?.[0]?.name).toBe("Alpha");
    expect(await store.listRecent()).toEqual(entries);
  });

  it("returns undefined when touching an unknown project", async () => {
    expect(await storeWithClock().touchRecent("missing")).toBeUndefined();
  });
});
```

Append the remaining suites to the same file:

```ts
describe("ProjectStore recent history retention", () => {
  it(`keeps at most ${String(RECENT_PROJECT_LIMIT)} entries and evicts the oldest`, async () => {
    const store = storeWithClock();
    for (let index = 0; index <= RECENT_PROJECT_LIMIT; index += 1) {
      await store.add({ path: `/work/project-${String(index)}` });
    }

    const entries = await store.listRecent();

    expect(entries).toHaveLength(RECENT_PROJECT_LIMIT);
    expect(entries[0]?.path).toBe(`/work/project-${String(RECENT_PROJECT_LIMIT)}`);
    expect(entries.some((entry) => entry.path === "/work/project-0")).toBe(false);
  });

  it("keeps history when a project, a tree, or a pin state changes", async () => {
    const store = storeWithClock();
    const root = await store.add({ path: "/work/root" });
    const child = await store.add({ path: "/work/root/child" });
    const other = await store.add({ path: "/work/other" });

    await store.setPinned(other.id, true);
    expect((await store.listRecent()).map((entry) => entry.path)).toEqual(["/work/other", "/work/root/child", "/work/root"]);

    await store.remove(other.id);
    await store.removeTree(root.id);

    expect(await store.list()).toEqual([]);
    expect((await store.listRecent()).map((entry) => entry.path)).toEqual(["/work/other", "/work/root/child", "/work/root"]);
    expect(child.id).not.toBe(root.id);
  });

  it("removes a closed entry but refuses to remove a registered one", async () => {
    const store = storeWithClock();
    const alpha = await store.add({ path: "/work/alpha" });
    await store.add({ path: "/work/beta" });
    const registeredEntry = (await store.listRecent()).find((entry) => entry.path === "/work/alpha");
    if (registeredEntry === undefined) throw new Error("expected an entry for the registered project");

    expect(await store.removeRecent(registeredEntry.id)).toEqual({ kind: "registered" });
    expect(await store.removeRecent("missing")).toEqual({ kind: "not-found" });

    await store.remove(alpha.id);
    const removal = await store.removeRecent(registeredEntry.id);

    expect(removal.kind).toBe("removed");
    expect((await store.listRecent()).map((entry) => entry.path)).toEqual(["/work/beta"]);
  });
});
```

Append the quarantine suite to the same file:

```ts
describe("ProjectStore malformed recent history", () => {
  const corrupt = { projects: [{ id: "p1", name: "alpha", path: "/work/alpha", createdAt: "2026-01-01T00:00:00.000Z" }], recentProjects: "not-an-array" };

  it("still reads registered projects", async () => {
    await writeFile(filePath, `${JSON.stringify(corrupt)}\n`, "utf8");

    expect((await storeWithClock().list()).map((project) => project.path)).toEqual(["/work/alpha"]);
  });

  it("reports the history failure instead of returning an empty list", async () => {
    await writeFile(filePath, `${JSON.stringify(corrupt)}\n`, "utf8");

    await expect(storeWithClock().listRecent()).rejects.toThrow(/recent/i);
  });

  it("preserves the quarantined value through a later registry write", async () => {
    await writeFile(filePath, `${JSON.stringify(corrupt)}\n`, "utf8");
    const store = storeWithClock();

    await store.add({ path: "/work/beta" });

    const raw = await readRaw();
    expect(raw["recentProjects"]).toBe("not-an-array");
    expect((raw["projects"] as { path: string }[]).map((project) => project.path)).toEqual(["/work/alpha", "/work/beta"]);
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npm test -- --run src/server/storage/projectStore.recentProjects.test.ts`
Expected: FAIL, `store.listRecent is not a function`.

- [ ] **Step 4: Extend the parsed document shape and the clock**

In `src/server/storage/projectStore.ts`, add `RecentProjectEntry` and `RECENT_PROJECT_LIMIT` to the existing `../../shared/apiTypes.js` import if one exists, otherwise add `import { RECENT_PROJECT_LIMIT, type RecentProjectEntry } from "../../shared/apiTypes.js";` beside the existing `Project` type import.

Replace the `ProjectFile` interface with:

```ts
interface ProjectFile {
  projects: Project[];
  /** Parsed history, empty when the stored value was absent or malformed. */
  recentProjects: RecentProjectEntry[];
  /**
   * The raw stored history when it could not be parsed. Preserved verbatim on
   * every write so a parser defect cannot destroy a user's history, and used to
   * fail `listRecent` loudly instead of reporting an empty list.
   */
  invalidRecentProjects?: unknown;
}
```

Replace `parseProjectFile` and add a history parser beside the existing `parseProject`:

```ts
function parseProjectFile(value: unknown): ProjectFile {
  if (!isRecord(value) || !Array.isArray(value["projects"])) throw new Error("Invalid project file");
  // Registered projects are parsed independently of history so a corrupt
  // optional history can never fail or hide a registry read.
  const projects = value["projects"].map(parseProject);
  const storedRecent = value["recentProjects"];
  if (storedRecent === undefined) return { projects, recentProjects: [] };
  try {
    return { projects, recentProjects: parseRecentProjects(storedRecent) };
  } catch {
    return { projects, recentProjects: [], invalidRecentProjects: storedRecent };
  }
}

function parseRecentProjects(value: unknown): RecentProjectEntry[] {
  if (!Array.isArray(value)) throw new Error("Invalid recent projects");
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error("Invalid recent project");
    const id = entry["id"];
    const name = entry["name"];
    const path = entry["path"];
    const lastUsedAt = entry["lastUsedAt"];
    if (typeof id !== "string" || typeof name !== "string" || typeof path !== "string" || typeof lastUsedAt !== "string") throw new Error("Invalid recent project");
    return { id, name, path, lastUsedAt };
  });
}
```

- [ ] **Step 5: Own the history invariants in the store**

Replace the `ProjectStore` constructor and add the history members. Keep every existing method body except where noted:

```ts
export type RecentRemoval =
  | { kind: "removed"; entries: RecentProjectEntry[] }
  | { kind: "not-found" }
  | { kind: "registered" };

export class ProjectStore {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = projectStorePath(), private readonly now: () => Date = () => new Date()) {}

  async listRecent(): Promise<RecentProjectEntry[]> {
    const data = await this.read();
    if (data.invalidRecentProjects !== undefined) throw new Error("Stored recent projects are malformed");
    return data.recentProjects;
  }

  /**
   * Record meaningful work on a registered project. Path identity comes from the
   * registry itself, so history can never disagree with registration dedupe.
   */
  async touchRecent(projectId: string): Promise<RecentProjectEntry[] | undefined> {
    return await this.exclusive(async () => {
      const data = await this.read();
      const project = data.projects.find((candidate) => candidate.id === projectId);
      if (project === undefined) return undefined;
      const recentProjects = this.promote(data.recentProjects, project);
      await this.write({ ...data, recentProjects });
      return recentProjects;
    });
  }

  async removeRecent(entryId: string): Promise<RecentRemoval> {
    return await this.exclusive(async () => {
      const data = await this.read();
      const target = data.recentProjects.find((entry) => entry.id === entryId);
      if (target === undefined) return { kind: "not-found" };
      if (data.projects.some((project) => project.path === target.path)) return { kind: "registered" };
      const recentProjects = data.recentProjects.filter((entry) => entry.id !== entryId);
      await this.write({ ...data, recentProjects });
      return { kind: "removed", entries: recentProjects };
    });
  }

  /** Move `project` to the front of history, reusing any entry for the same registry path. */
  private promote(entries: readonly RecentProjectEntry[], project: Project): RecentProjectEntry[] {
    const existing = entries.find((entry) => entry.path === project.path);
    const promoted: RecentProjectEntry = {
      id: existing?.id ?? randomUUID(),
      name: project.name,
      path: project.path,
      lastUsedAt: this.now().toISOString(),
    };
    return [promoted, ...entries.filter((entry) => entry.path !== project.path)].slice(0, RECENT_PROJECT_LIMIT);
  }
}
```

- [ ] **Step 6: Make every existing write history-preserving**

In the same file, update the four existing mutators so history round-trips. `read()` now returns history, and `write()` must receive it.

In `add`, record the project after resolving the existing-or-new project, so re-adding a registered path promotes its entry:

```ts
  async add(input: { name?: string; path: string }): Promise<Project> {
    return await this.exclusive(async () => {
      const data = await this.read();
      const path = input.path;
      const existing = data.projects.find((p) => p.path === path);
      if (existing) {
        await this.write({ ...data, recentProjects: this.promote(data.recentProjects, existing) });
        return existing;
      }

      const trimmedName = input.name?.trim();
      const leafName = path.split("/").filter((part) => part !== "").at(-1);
      const project: Project = {
        id: randomUUID(),
        name: trimmedName !== undefined && trimmedName !== "" ? trimmedName : leafName ?? path,
        path,
        createdAt: this.now().toISOString(),
      };
      data.projects.push(project);
      await this.write({ ...data, recentProjects: this.promote(data.recentProjects, project) });
      return project;
    });
  }
```

In `remove`, `removeTree`, and `setPinned`, change each `this.write({ projects })` call to spread the read document so `recentProjects` and any quarantined value survive. For example, `remove` becomes `await this.write({ ...data, projects });`, and `setPinned` becomes `await this.write({ ...data, projects });`. Do not otherwise change their logic: unregistering must leave history untouched.

In `write`, serialize history only when it is present, preferring a quarantined raw value:

```ts
  private async write(data: ProjectFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const target = await resolveWriteTarget(this.filePath);
    const tempPath = join(dirname(target.path), `.${basename(target.path)}.${String(process.pid)}.${Date.now().toString()}.${randomUUID()}.tmp`);
    // A quarantined history is written back verbatim: a parser defect must never
    // silently replace a user's history with an empty list.
    const recentProjects = data.invalidRecentProjects ?? data.recentProjects;
    const document = data.invalidRecentProjects === undefined && data.recentProjects.length === 0
      ? { projects: data.projects }
      : { projects: data.projects, recentProjects };
    try {
      const content = `${JSON.stringify(document, null, 2)}\n`;
      if (target.mode === undefined) {
        await writeFile(tempPath, content, "utf8");
      } else {
        await writeFile(tempPath, content, { encoding: "utf8", mode: target.mode });
        await chmod(tempPath, target.mode);
      }
      await rename(tempPath, target.path);
    } catch (error: unknown) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
```

Also update `read()`'s ENOENT branch to return `{ projects: [], recentProjects: [] }`.

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `npm test -- --run src/server/storage/projectStore.recentProjects.test.ts src/server/storage/projectStore.test.ts`
Expected: PASS with no failures (13 new tests, plus the existing store suite unchanged).

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/shared/apiTypes.ts src/server/storage/projectStore.ts src/server/storage/projectStore.recentProjects.test.ts
git commit -m "feat(projects): own recent-project history invariants in the project store"
```

## Task 2: Recent-project service operations

**Implementer tier:** Standard

**Files:**

- Modify: `src/server/projects/projectService.ts:1-59`
- Test: `src/server/projects/projectService.recentProjects.test.ts`

**Interfaces:**

- Consumes from Task 1: `ProjectStore` with `listRecent(): Promise<RecentProjectEntry[]>`, `touchRecent(projectId: string): Promise<RecentProjectEntry[] | undefined>`, `removeRecent(entryId: string): Promise<RecentRemoval>` where `RecentRemoval = { kind: "removed"; entries: RecentProjectEntry[] } | { kind: "not-found" } | { kind: "registered" }`; and `RecentProjectEntry = { id: string; name: string; path: string; lastUsedAt: string }` from `src/shared/apiTypes.ts`.
- Produces on `ProjectService`:
  - `listRecent(): Promise<RecentProjectEntry[]>`
  - `recordRecent(projectId: string): Promise<RecentProjectEntry[]>` — throws `ProjectNotFoundError` for an unknown project.
  - `removeRecent(entryId: string): Promise<RecentProjectEntry[]>` — throws `ProjectNotFoundError` when absent, `RecentProjectRegisteredError` when still registered.
- Produces: `class RecentProjectRegisteredError extends Error` exported from the same module.

- [ ] **Step 1: Write the failing test**

Create `src/server/projects/projectService.recentProjects.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../storage/projectStore.js";
import { ProjectNotFoundError, ProjectService, RecentProjectRegisteredError } from "./projectService.js";

let tempDir = "";
let service: ProjectService;
let store: ProjectStore;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-webui-recent-service-"));
  store = new ProjectStore(join(tempDir, "projects.json"));
  service = new ProjectService(store);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("ProjectService recent history", () => {
  it("lists history recorded by registration", async () => {
    const project = await store.add({ path: "/work/alpha" });

    expect((await service.listRecent()).map((entry) => entry.path)).toEqual(["/work/alpha"]);
    expect(project.path).toBe("/work/alpha");
  });

  it("records work on a registered project and returns the new order", async () => {
    const alpha = await store.add({ path: "/work/alpha" });
    await store.add({ path: "/work/beta" });

    expect((await service.recordRecent(alpha.id)).map((entry) => entry.path)).toEqual(["/work/alpha", "/work/beta"]);
  });

  it("rejects recording work for an unknown project", async () => {
    await expect(service.recordRecent("missing")).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it("removes a closed entry and rejects removing a registered or unknown one", async () => {
    const alpha = await store.add({ path: "/work/alpha" });
    await store.add({ path: "/work/beta" });
    const entry = (await service.listRecent()).find((candidate) => candidate.path === "/work/alpha");
    if (entry === undefined) throw new Error("expected an entry for the registered project");

    await expect(service.removeRecent(entry.id)).rejects.toBeInstanceOf(RecentProjectRegisteredError);
    await expect(service.removeRecent("missing")).rejects.toBeInstanceOf(ProjectNotFoundError);

    await service.close(alpha.id);

    expect((await service.removeRecent(entry.id)).map((candidate) => candidate.path)).toEqual(["/work/beta"]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/server/projects/projectService.recentProjects.test.ts`
Expected: FAIL, `RecentProjectRegisteredError` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/server/projects/projectService.ts`, add `import type { RecentProjectEntry } from "../../shared/apiTypes.js";` beside the existing type imports, then add the error class after `ProjectNotFoundError`:

```ts
/** Thrown when a history entry cannot be removed because its path is registered again. */
export class RecentProjectRegisteredError extends Error {
  constructor() {
    super("Recent project is registered");
    this.name = "RecentProjectRegisteredError";
  }
}
```

Add these methods to `ProjectService`, after `closeTree`:

```ts
  listRecent(): Promise<RecentProjectEntry[]> {
    return this.store.listRecent();
  }

  /** Record meaningful user work. The store resolves the project and owns ordering. */
  async recordRecent(projectId: string): Promise<RecentProjectEntry[]> {
    const entries = await this.store.touchRecent(projectId);
    if (entries === undefined) throw new ProjectNotFoundError();
    return entries;
  }

  async removeRecent(entryId: string): Promise<RecentProjectEntry[]> {
    const removal = await this.store.removeRecent(entryId);
    if (removal.kind === "not-found") throw new ProjectNotFoundError();
    if (removal.kind === "registered") throw new RecentProjectRegisteredError();
    return removal.entries;
  }
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- --run src/server/projects/projectService.recentProjects.test.ts src/server/projects/projectService.test.ts`
Expected: PASS with no failures (4 new tests, plus the existing service suite unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/server/projects/projectService.ts src/server/projects/projectService.recentProjects.test.ts
git commit -m "feat(projects): add recent-project service operations"
```

## Task 3: HTTP routes and the federation allowlist

**Implementer tier:** Advanced

**Files:**

- Modify: `src/server/app.ts:66-127`
- Modify: `src/shared/federatedRoutes.ts:45-51`
- Test: `src/server/app.recentProjects.test.ts`
- Test: `src/client/src/api/federatedRouteContract.test.ts`

**Interfaces:**

- Consumes from Task 2: `ProjectService` with `listRecent(): Promise<RecentProjectEntry[]>`, `recordRecent(projectId: string): Promise<RecentProjectEntry[]>`, `removeRecent(entryId: string): Promise<RecentProjectEntry[]>`; and the errors `ProjectNotFoundError` and `RecentProjectRegisteredError` from `src/server/projects/projectService.js`.
- Produces these HTTP routes, registered for both `/api` and `/api/machines/local`:
  - `GET <prefix>/recent-projects` → `RecentProjectEntry[]`
  - `POST <prefix>/projects/:projectId/recent` → `RecentProjectEntry[]`, `404` for an unknown project
  - `DELETE <prefix>/recent-projects/:entryId` → `RecentProjectEntry[]`, `404` unknown entry, `409` registered path
- Produces: the same three paths added to `FEDERATED_HTTP_ROUTES` in `src/shared/federatedRoutes.ts`.

- [ ] **Step 1: Write the failing route test**

Create `src/server/app.recentProjects.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Project, RecentProjectEntry } from "../shared/apiTypes.js";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();

async function addProject(): Promise<Project> {
  const response = await appTestContext.app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "Example", path: appTestContext.projectDir, create: true },
  });
  expect(response.statusCode).toBe(200);
  return response.json<Project>();
}

async function listRecent(url = "/api/recent-projects"): Promise<RecentProjectEntry[]> {
  const response = await appTestContext.app.inject({ method: "GET", url });
  expect(response.statusCode).toBe(200);
  return response.json<RecentProjectEntry[]>();
}

describe("recent project routes", () => {
  it("records a registered project and lists it", async () => {
    const project = await addProject();

    expect((await listRecent()).map((entry) => entry.path)).toEqual([appTestContext.projectDir]);

    const touch = await appTestContext.app.inject({ method: "POST", url: `/api/projects/${project.id}/recent` });

    expect(touch.statusCode).toBe(200);
    expect(touch.json<RecentProjectEntry[]>().map((entry) => entry.path)).toEqual([appTestContext.projectDir]);
  });

  it("serves the explicit local machine prefix", async () => {
    await addProject();

    expect((await listRecent("/api/machines/local/recent-projects")).map((entry) => entry.name)).toEqual(["Example"]);
  });

  it("answers 404 when recording work for an unknown project", async () => {
    const response = await appTestContext.app.inject({ method: "POST", url: "/api/projects/missing/recent" });

    expect(response.statusCode).toBe(404);
  });

  it("answers 409 while the entry path is registered and 404 for an unknown entry", async () => {
    const project = await addProject();
    const [entry] = await listRecent();
    if (entry === undefined) throw new Error("expected a recorded entry");

    const conflict = await appTestContext.app.inject({ method: "DELETE", url: `/api/recent-projects/${entry.id}` });
    expect(conflict.statusCode).toBe(409);

    const missing = await appTestContext.app.inject({ method: "DELETE", url: "/api/recent-projects/missing" });
    expect(missing.statusCode).toBe(404);

    await appTestContext.app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });

    const removed = await appTestContext.app.inject({ method: "DELETE", url: `/api/recent-projects/${entry.id}` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json<RecentProjectEntry[]>()).toEqual([]);
  });

  it("keeps history after the project is closed", async () => {
    const project = await addProject();

    await appTestContext.app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });

    expect((await listRecent()).map((entry) => entry.path)).toEqual([appTestContext.projectDir]);
  });
});
```

- [ ] **Step 2: Write the failing allowlist test**

In `src/client/src/api/federatedRouteContract.test.ts`, inside the existing `describe("federated route contract", ...)` block, add:

```ts
  it("allowlists the recent-project history routes without adding a socket", () => {
    expect(FEDERATED_HTTP_ROUTES.filter((route) => route.path.includes("recent"))).toEqual([
      { method: "GET", path: "/recent-projects" },
      { method: "POST", path: "/projects/:projectId/recent" },
      { method: "DELETE", path: "/recent-projects/:entryId" },
    ]);
    expect(FEDERATED_WEBSOCKET_ROUTES.some((path) => path.includes("recent"))).toBe(false);
  });
```

- [ ] **Step 3: Run both tests and confirm they fail**

Run: `npm test -- --run src/server/app.recentProjects.test.ts src/client/src/api/federatedRouteContract.test.ts`
Expected: FAIL. The route test reports 404s; the contract test reports an empty array.

- [ ] **Step 4: Register the routes**

In `src/server/app.ts`, extend the import from `./projects/projectService.js` to `import { ProjectNotFoundError, ProjectService, RecentProjectRegisteredError } from "./projects/projectService.js";`.

Inside `registerLocalProjectRoutes`, after the existing `close-tree` route, add:

```ts
  app.get(`${prefix}/recent-projects`, async (_request, reply) => {
    try {
      return await projects.listRecent();
    } catch (error) {
      return sendProjectRouteError(reply, error);
    }
  });

  app.post<{ Params: { projectId: string } }>(`${prefix}/projects/:projectId/recent`, async (request, reply) => {
    try {
      return await projects.recordRecent(request.params.projectId);
    } catch (error) {
      return sendProjectRouteError(reply, error);
    }
  });

  app.delete<{ Params: { entryId: string } }>(`${prefix}/recent-projects/:entryId`, async (request, reply) => {
    try {
      return await projects.removeRecent(request.params.entryId);
    } catch (error) {
      return sendProjectRouteError(reply, error);
    }
  });
```

Extend `sendProjectRouteError` so a re-registered path is a conflict rather than a server error:

```ts
function sendProjectRouteError(reply: FastifyReply, error: unknown): FastifyReply {
  // Only unknown project ids answer 404. Genuine store or workspace failures
  // (git, filesystem) answer 500 so clients can distinguish them. The wider
  // resolveWorkspaceContext consumers (git, workspace explorer, terminal, and
  // workspace deletion routes) deliberately keep their own catch-all mapping
  // instead of this instanceof split, so the asymmetry is not an oversight.
  // A history entry whose path was registered again is a conflict, not a
  // failure: the client refreshes and renders it as registered.
  const status = error instanceof ProjectNotFoundError ? 404 : error instanceof RecentProjectRegisteredError ? 409 : 500;
  return reply.code(status).send({ error: error instanceof Error ? error.message : String(error) });
}
```

- [ ] **Step 5: Add the federation allowlist entries**

In `src/shared/federatedRoutes.ts`, inside `FEDERATED_HTTP_ROUTES`, immediately after the `{ method: "POST", path: "/projects/:projectId/close-tree" },` entry, add:

```ts
  { method: "GET", path: "/recent-projects" },
  { method: "POST", path: "/projects/:projectId/recent" },
  { method: "DELETE", path: "/recent-projects/:entryId" },
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npm test -- --run src/server/app.recentProjects.test.ts src/client/src/api/federatedRouteContract.test.ts src/server/app.projects.test.ts`
Expected: PASS with no failures (5 new route tests, 1 new contract test, existing suites unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/server/app.ts src/shared/federatedRoutes.ts src/server/app.recentProjects.test.ts src/client/src/api/federatedRouteContract.test.ts
git commit -m "feat(projects): expose recent-project history routes with federation support"
```

## Task 4: Browser API client and strict parser

**Implementer tier:** Standard

**Files:**

- Modify: `src/client/src/api/parsers.ts:204-214`
- Modify: `src/client/src/api/clients.ts:309-314`
- Modify: `src/client/src/api/clients.ts:524-542`
- Modify: `src/client/src/api.ts:1`
- Test: `src/client/src/api/parsers.recentProjects.test.ts`
- Test: `src/client/src/api/clients.recentProjects.test.ts`

**Interfaces:**

- Consumes from Task 3: `GET api/machines/<machineId>/recent-projects`, `POST api/machines/<machineId>/projects/<projectId>/recent`, `DELETE api/machines/<machineId>/recent-projects/<entryId>`, each returning `RecentProjectEntry[]`; and `RecentProjectEntry = { id: string; name: string; path: string; lastUsedAt: string }` from `src/shared/apiTypes.ts`.
- Produces, exported from `src/client/src/api/parsers.ts`: `parseRecentProjectEntry(value: unknown): RecentProjectEntry`.
- Produces, exported from `src/client/src/api/clients.ts` and re-exported from `src/client/src/api.ts`:

```ts
export const recentProjectsApi = {
  recentProjects: (machineId?: string) => Promise<RecentProjectEntry[]>,
  recordRecentProject: (projectId: string, machineId?: string) => Promise<RecentProjectEntry[]>,
  removeRecentProject: (entryId: string, machineId?: string) => Promise<RecentProjectEntry[]>,
};
```

- Produces: `recentProjectsApi` spread into the aggregate `api` object in `src/client/src/api/clients.ts`.

- [ ] **Step 1: Write the failing parser test**

Create `src/client/src/api/parsers.recentProjects.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { arrayOf, parseRecentProjectEntry } from "./parsers";

const entry = { id: "e1", name: "alpha", path: "/work/alpha", lastUsedAt: "2026-01-01T00:00:00.000Z" };

describe("parseRecentProjectEntry", () => {
  it("parses a complete entry", () => {
    expect(parseRecentProjectEntry(entry)).toEqual(entry);
  });

  it("parses an ordered collection", () => {
    expect(arrayOf(parseRecentProjectEntry)([entry])).toEqual([entry]);
  });

  it.each(["id", "name", "path", "lastUsedAt"])("rejects a missing %s", (key) => {
    const invalid: Record<string, unknown> = { ...entry };
    delete invalid[key];

    expect(() => parseRecentProjectEntry(invalid)).toThrow();
  });

  it("rejects a non-string timestamp and a non-object entry", () => {
    expect(() => parseRecentProjectEntry({ ...entry, lastUsedAt: 0 })).toThrow();
    expect(() => parseRecentProjectEntry("nope")).toThrow();
  });

  it("rejects a non-array collection", () => {
    expect(() => arrayOf(parseRecentProjectEntry)({})).toThrow();
  });
});
```

- [ ] **Step 2: Write the failing client test**

Create `src/client/src/api/clients.recentProjects.test.ts`. Follow the local convention: read an existing `fetch`-stubbing test in `src/client/src/api/clients.test.ts` and reuse its stub style.

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recentProjectsApi } from "./clients";

const entry = { id: "e 1", name: "alpha", path: "/work/alpha", lastUsedAt: "2026-01-01T00:00:00.000Z" };

function stubJson(body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(body) });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestedUrl(fetchMock: ReturnType<typeof vi.fn>): string {
  const [input] = fetchMock.mock.calls[0] ?? [];
  return typeof input === "string" ? input : String((input as { url: string }).url);
}

beforeEach(() => {
  vi.stubGlobal("document", { baseURI: "https://pi.example.test/" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recentProjectsApi", () => {
  it("lists history for the local machine", async () => {
    const fetchMock = stubJson([entry]);

    await expect(recentProjectsApi.recentProjects()).resolves.toEqual([entry]);
    expect(requestedUrl(fetchMock)).toContain("api/machines/local/recent-projects");
  });

  it("encodes the project id when recording work on a remote machine", async () => {
    const fetchMock = stubJson([entry]);

    await recentProjectsApi.recordRecentProject("p 1", "remote a");

    expect(requestedUrl(fetchMock)).toContain("api/machines/remote%20a/projects/p%201/recent");
  });

  it("encodes the entry id when removing history", async () => {
    const fetchMock = stubJson([]);

    await expect(recentProjectsApi.removeRecentProject("e 1")).resolves.toEqual([]);
    expect(requestedUrl(fetchMock)).toContain("api/machines/local/recent-projects/e%201");
  });

  it("rejects a malformed response", async () => {
    stubJson([{ id: "e1" }]);

    await expect(recentProjectsApi.recentProjects()).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run both tests and confirm they fail**

Run: `npm test -- --run src/client/src/api/parsers.recentProjects.test.ts src/client/src/api/clients.recentProjects.test.ts`
Expected: FAIL, `parseRecentProjectEntry` and `recentProjectsApi` are not exported.

- [ ] **Step 4: Add the parser**

In `src/client/src/api/parsers.ts`, add `RecentProjectEntry` to the existing `type Project` import group from `../../../shared/apiTypes`, then add after `parseProject`:

```ts
export function parseRecentProjectEntry(value: unknown): RecentProjectEntry {
  const record = requireRecord(value);
  return {
    id: requireString(record, "id"),
    name: requireString(record, "name"),
    path: requireString(record, "path"),
    lastUsedAt: requireString(record, "lastUsedAt"),
  };
}
```

- [ ] **Step 5: Add the API client**

In `src/client/src/api/clients.ts`, import `parseRecentProjectEntry` from `./parsers` alongside the existing parser imports, and add `RecentProjectEntry` to the shared type imports. After the existing `projectsApi` object, add:

```ts
export const recentProjectsApi = {
  recentProjects: (machineId = "local") => request(`${machinePrefix(machineId)}/recent-projects`, arrayOf(parseRecentProjectEntry)),
  recordRecentProject: (projectId: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/recent`, arrayOf(parseRecentProjectEntry), { method: "POST" }),
  removeRecentProject: (entryId: string, machineId = "local") => request(`${machinePrefix(machineId)}/recent-projects/${encodeURIComponent(entryId)}`, arrayOf(parseRecentProjectEntry), { method: "DELETE" }),
};
```

Add `...recentProjectsApi,` to the aggregate `api` object immediately after `...projectsApi,`.

In `src/client/src/api.ts`, add `recentProjectsApi` to the existing alphabetical export list from `./api/clients` (between `pluginsApi` and `sessionsApi`), and export the type by adding `RecentProjectEntry` wherever that module re-exports shared API types; if it does not re-export types, add `export type { RecentProjectEntry } from "../../shared/apiTypes";`.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/api/parsers.recentProjects.test.ts src/client/src/api/clients.recentProjects.test.ts src/client/src/api/federatedRouteContract.test.ts`
Expected: PASS with no failures (10 parser tests, 4 client tests, contract suite unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/client/src/api/parsers.ts src/client/src/api/clients.ts src/client/src/api.ts src/client/src/api/parsers.recentProjects.test.ts src/client/src/api/clients.recentProjects.test.ts
git commit -m "feat(client): add recent-project history API client and parser"
```

## Task 5: Machine-scoped recent-project controller

**Implementer tier:** Advanced

**Files:**

- Create: `src/client/src/controllers/recentProjectController.ts`
- Test: `src/client/src/controllers/recentProjectController.test.ts`

**Interfaces:**

- Consumes from Task 4: `recentProjectsApi` with `recentProjects(machineId?: string)`, `recordRecentProject(projectId: string, machineId?: string)`, `removeRecentProject(entryId: string, machineId?: string)`, each resolving to `RecentProjectEntry[]`; and `RecentProjectEntry = { id: string; name: string; path: string; lastUsedAt: string }`.
- Produces in `src/client/src/controllers/recentProjectController.ts`:

```ts
export type RecentProjectsState =
  | { kind: "loading" }
  | { kind: "ready"; entries: RecentProjectEntry[] }
  | { kind: "failed"; message: string };

export interface RecentProjectApi {
  recentProjects(machineId?: string): Promise<RecentProjectEntry[]>;
  recordRecentProject(projectId: string, machineId?: string): Promise<RecentProjectEntry[]>;
  removeRecentProject(entryId: string, machineId?: string): Promise<RecentProjectEntry[]>;
}

export interface RecentProjectControllerDependencies {
  api?: RecentProjectApi;
  machineId: () => string;
  onChange: (state: RecentProjectsState) => void;
  onBackgroundError?: (operation: string, error: unknown) => void;
}

export class RecentProjectController {
  constructor(deps: RecentProjectControllerDependencies);
  get state(): RecentProjectsState;
  load(): Promise<void>;
  retry(): Promise<void>;
  recordWork(projectId: string): void;
  removeEntry(entryId: string): Promise<void>;
}
```

- [ ] **Step 1: Write the failing test**

Create `src/client/src/controllers/recentProjectController.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { RecentProjectEntry } from "../../../shared/apiTypes";
import { RecentProjectController, type RecentProjectsState } from "./recentProjectController";

function entry(path: string, id = path): RecentProjectEntry {
  return { id, name: path.split("/").at(-1) ?? path, path, lastUsedAt: "2026-01-01T00:00:00.000Z" };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness(overrides: Partial<{
  recentProjects: (machineId?: string) => Promise<RecentProjectEntry[]>;
  recordRecentProject: (projectId: string, machineId?: string) => Promise<RecentProjectEntry[]>;
  removeRecentProject: (entryId: string, machineId?: string) => Promise<RecentProjectEntry[]>;
}> = {}, machineId = "local") {
  const states: RecentProjectsState[] = [];
  const errors: string[] = [];
  let current = machineId;
  const api = {
    recentProjects: overrides.recentProjects ?? (() => Promise.resolve([])),
    recordRecentProject: overrides.recordRecentProject ?? (() => Promise.resolve([])),
    removeRecentProject: overrides.removeRecentProject ?? (() => Promise.resolve([])),
  };
  const controller = new RecentProjectController({
    api,
    machineId: () => current,
    onChange: (state) => { states.push(state); },
    onBackgroundError: (operation) => { errors.push(operation); },
  });
  return { api, controller, errors, states, selectMachine: (next: string) => { current = next; } };
}
```

Append the suites to the same file:

```ts
describe("RecentProjectController loading", () => {
  it("loads history for the selected machine", async () => {
    const recentProjects = vi.fn().mockResolvedValue([entry("/work/alpha")]);
    const { controller, states } = harness({ recentProjects }, "remote-a");

    await controller.load();

    expect(recentProjects).toHaveBeenCalledWith("remote-a");
    expect(states[0]).toEqual({ kind: "loading" });
    expect(controller.state).toEqual({ kind: "ready", entries: [entry("/work/alpha")] });
  });

  it("exposes a failure message and recovers on retry", async () => {
    const recentProjects = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([entry("/work/alpha")]);
    const { controller } = harness({ recentProjects });

    await controller.load();
    expect(controller.state).toEqual({ kind: "failed", message: "offline" });

    await controller.retry();
    expect(controller.state).toEqual({ kind: "ready", entries: [entry("/work/alpha")] });
  });

  it("discards a response that resolves after the machine changed", async () => {
    const pending = deferred<RecentProjectEntry[]>();
    const { controller, selectMachine } = harness({ recentProjects: () => pending.promise });

    const load = controller.load();
    selectMachine("remote-b");
    pending.resolve([entry("/work/stale")]);
    await load;

    expect(controller.state).toEqual({ kind: "loading" });
  });
});
```

Append the mutation suites to the same file:

```ts
describe("RecentProjectController recording work", () => {
  it("records work and applies the authoritative order", async () => {
    const recordRecentProject = vi.fn().mockResolvedValue([entry("/work/beta"), entry("/work/alpha")]);
    const { controller } = harness({
      recentProjects: () => Promise.resolve([entry("/work/alpha"), entry("/work/beta")]),
      recordRecentProject,
    });
    await controller.load();

    controller.recordWork("project-beta");
    await vi.waitFor(() => {
      expect(controller.state).toEqual({ kind: "ready", entries: [entry("/work/beta"), entry("/work/alpha")] });
    });
    expect(recordRecentProject).toHaveBeenCalledWith("project-beta", "local");
  });

  it("issues no request when the project is already newest", async () => {
    const recordRecentProject = vi.fn().mockResolvedValue([]);
    const { controller } = harness({
      recentProjects: () => Promise.resolve([entry("/work/alpha", "entry-alpha")]),
      recordRecentProject,
    });
    await controller.load();

    controller.recordWork("project-alpha");
    controller.recordWork("project-alpha");

    await vi.waitFor(() => { expect(recordRecentProject).toHaveBeenCalledTimes(1); });
    expect(recordRecentProject).toHaveBeenCalledWith("project-alpha", "local");
  });

  it("reports a failed touch as a background error and keeps the current order", async () => {
    const { controller, errors } = harness({
      recentProjects: () => Promise.resolve([entry("/work/alpha")]),
      recordRecentProject: () => Promise.reject(new Error("boom")),
    });
    await controller.load();

    controller.recordWork("project-beta");

    await vi.waitFor(() => { expect(errors).toEqual(["record recent project"]); });
    expect(controller.state).toEqual({ kind: "ready", entries: [entry("/work/alpha")] });
  });

  it("serializes mutations so an earlier response cannot overwrite a later one", async () => {
    const first = deferred<RecentProjectEntry[]>();
    const second = deferred<RecentProjectEntry[]>();
    const recordRecentProject = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { controller } = harness({
      recentProjects: () => Promise.resolve([entry("/work/alpha"), entry("/work/beta")]),
      recordRecentProject,
    });
    await controller.load();

    controller.recordWork("project-beta");
    controller.recordWork("project-alpha");
    second.resolve([entry("/work/alpha"), entry("/work/beta")]);
    first.resolve([entry("/work/beta"), entry("/work/alpha")]);

    await vi.waitFor(() => { expect(recordRecentProject).toHaveBeenCalledTimes(2); });
    expect(controller.state).toEqual({ kind: "ready", entries: [entry("/work/alpha"), entry("/work/beta")] });
  });
});

describe("RecentProjectController removing entries", () => {
  it("applies the authoritative list after removal", async () => {
    const removeRecentProject = vi.fn().mockResolvedValue([entry("/work/beta")]);
    const { controller } = harness({
      recentProjects: () => Promise.resolve([entry("/work/alpha"), entry("/work/beta")]),
      removeRecentProject,
    });
    await controller.load();

    await controller.removeEntry("/work/alpha");

    expect(removeRecentProject).toHaveBeenCalledWith("/work/alpha", "local");
    expect(controller.state).toEqual({ kind: "ready", entries: [entry("/work/beta")] });
  });

  it("refreshes and rethrows when removal conflicts with a registration", async () => {
    const { controller } = harness({
      recentProjects: () => Promise.resolve([entry("/work/alpha")]),
      removeRecentProject: () => Promise.reject(new Error("Recent project is registered")),
    });
    await controller.load();

    await expect(controller.removeEntry("/work/alpha")).rejects.toThrow(/registered/i);
    expect(controller.state).toEqual({ kind: "ready", entries: [entry("/work/alpha")] });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/client/src/controllers/recentProjectController.test.ts`
Expected: FAIL, `Cannot find module './recentProjectController'`.

- [ ] **Step 3: Write the implementation**

Create `src/client/src/controllers/recentProjectController.ts`:

```ts
import { recentProjectsApi as defaultApi } from "../api";
import type { RecentProjectEntry } from "../../../shared/apiTypes";

const RECORD_OPERATION = "record recent project";

export type RecentProjectsState =
  | { kind: "loading" }
  | { kind: "ready"; entries: RecentProjectEntry[] }
  | { kind: "failed"; message: string };

export interface RecentProjectApi {
  recentProjects(machineId?: string): Promise<RecentProjectEntry[]>;
  recordRecentProject(projectId: string, machineId?: string): Promise<RecentProjectEntry[]>;
  removeRecentProject(entryId: string, machineId?: string): Promise<RecentProjectEntry[]>;
}

export interface RecentProjectControllerDependencies {
  api?: RecentProjectApi;
  machineId: () => string;
  onChange: (state: RecentProjectsState) => void;
  onBackgroundError?: (operation: string, error: unknown) => void;
}

/**
 * Owns per-machine recent-project history: loading, mutation serialization, and
 * stale-response suppression. The server is authoritative for order, so every
 * mutation response replaces local state rather than being merged.
 */
export class RecentProjectController {
  private readonly api: RecentProjectApi;
  private current: RecentProjectsState = { kind: "loading" };
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(private readonly deps: RecentProjectControllerDependencies) {
    this.api = deps.api ?? defaultApi;
  }

  get state(): RecentProjectsState {
    return this.current;
  }

  async load(): Promise<void> {
    const machineId = this.deps.machineId();
    const generation = ++this.generation;
    this.publish({ kind: "loading" });
    try {
      const entries = await this.api.recentProjects(machineId);
      if (this.isStale(generation, machineId)) return;
      this.publish({ kind: "ready", entries });
    } catch (error) {
      if (this.isStale(generation, machineId)) return;
      this.publish({ kind: "failed", message: errorMessage(error) });
    }
  }

  retry(): Promise<void> {
    return this.load();
  }

  /**
   * Record meaningful user work. Terminal input calls this per keystroke, so the
   * newest-entry check is synchronous and happens before any request. The check
   * is only an optimization: the store dedupes by path when this belief is stale.
   */
  recordWork(projectId: string): void {
    if (this.isAlreadyNewest(projectId)) return;
    const machineId = this.deps.machineId();
    const generation = this.generation;
    this.enqueue(async () => {
      try {
        const entries = await this.api.recordRecentProject(projectId, machineId);
        if (this.isStale(generation, machineId)) return;
        this.publish({ kind: "ready", entries });
      } catch (error) {
        // Recording is secondary to the work that succeeded; never surface it as
        // a blocking failure or discard the order we already have.
        this.deps.onBackgroundError?.(RECORD_OPERATION, error);
      }
    });
  }

  async removeEntry(entryId: string): Promise<void> {
    const machineId = this.deps.machineId();
    const generation = this.generation;
    let failure: unknown;
    await this.enqueue(async () => {
      try {
        const entries = await this.api.removeRecentProject(entryId, machineId);
        if (this.isStale(generation, machineId)) return;
        this.publish({ kind: "ready", entries });
      } catch (error) {
        failure = error;
      }
    });
    if (failure !== undefined) throw failure;
  }

  private isAlreadyNewest(projectId: string): boolean {
    return this.newestProjectId === projectId;
  }

  private newestProjectId: string | undefined;

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private isStale(generation: number, machineId: string): boolean {
    return generation !== this.generation || machineId !== this.deps.machineId();
  }

  private publish(state: RecentProjectsState): void {
    this.current = state;
    this.newestProjectId = undefined;
    this.deps.onChange(state);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

The newest-entry guard needs the project id that produced the newest entry, and history stores paths rather than project ids. Resolve this by having `recordWork` remember the last project id it successfully recorded: set `this.newestProjectId = projectId` right after a successful `recordRecentProject` response is published, and clear it in `publish` for any other transition (as written above). Order the class members so `newestProjectId` is declared with the other fields at the top rather than mid-class.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/controllers/recentProjectController.test.ts`
Expected: PASS with no failures (9 tests).

- [ ] **Step 5: Lint the new files**

Run: `npx eslint src/client/src/controllers/recentProjectController.ts src/client/src/controllers/recentProjectController.test.ts`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/client/src/controllers/recentProjectController.ts src/client/src/controllers/recentProjectController.test.ts
git commit -m "feat(client): add machine-scoped recent-project controller"
```

## Task 6: Recent Projects panel component

**Implementer tier:** Advanced

**Files:**

- Create: `src/client/src/components/RecentProjectsPanel.ts`
- Modify: `src/client/src/components/tabIcons.ts:1-12`
- Test: `src/client/src/components/RecentProjectsPanel.test.ts`

**Interfaces:**

- Consumes from Task 5: `RecentProjectsState = { kind: "loading" } | { kind: "ready"; entries: RecentProjectEntry[] } | { kind: "failed"; message: string }` from `../controllers/recentProjectController`, and `RecentProjectEntry = { id: string; name: string; path: string; lastUsedAt: string }`.
- Consumes existing helpers: `projectActivityIndicator(project: Project, knownWorkspaces: Workspace[], activities: Record<string, WorkspaceActivity>): ActivityIndicatorKind | undefined` from `../workspaceActivity`; `renderActionActivityIndicator(kind: ActivityIndicatorKind | undefined, label?: string): TemplateResult | undefined` from `./activityBadge`; `listStyles` from `./shared`.
- Produces the `recent-projects-panel` custom element with these properties:

```ts
@property({ attribute: false }) state: RecentProjectsState = { kind: "loading" };
@property({ attribute: false }) projects: Project[] = [];
@property({ attribute: false }) workspacesByProjectId: Record<string, Workspace[]> = {};
@property({ attribute: false }) activities: Record<string, WorkspaceActivity> = {};
@property({ attribute: false }) selectedProjectId: string | undefined;
@property({ attribute: false }) onOpenRegistered?: (project: Project) => void;
@property({ attribute: false }) onOpenClosed?: (entry: RecentProjectEntry) => void;
@property({ attribute: false }) onRetry?: () => void;
```

- Produces, exported from the same module: `registeredProjectForEntry(entry: RecentProjectEntry, projects: readonly Project[]): Project | undefined`.
- Produces, added to `renderBuiltinTabIcon` in `src/client/src/components/tabIcons.ts`: the `"history"` icon, with `AppTabBuiltinIcon` extended to include `"history"`.

- [ ] **Step 1: Write the failing test**

Create `src/client/src/components/RecentProjectsPanel.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { Project, RecentProjectEntry, Workspace } from "../../../shared/apiTypes";
import { RecentProjectsPanel, registeredProjectForEntry } from "./RecentProjectsPanel";

function entry(path: string, id = `entry-${path}`): RecentProjectEntry {
  return { id, name: path.split("/").at(-1) ?? path, path, lastUsedAt: "2026-01-01T00:00:00.000Z" };
}

function project(id: string, path: string): Project {
  return { id, name: path.split("/").at(-1) ?? path, path, createdAt: "2026-01-01T00:00:00.000Z" };
}

function workspace(projectId: string, path: string): Workspace {
  return { id: `w-${projectId}`, projectId, path, label: "main", isMain: true, isGitRepo: true, isGitWorktree: false };
}

function renderedText(panel: RecentProjectsPanel): string {
  return JSON.stringify(panel.render());
}

describe("registeredProjectForEntry", () => {
  it("matches a registered project by path", () => {
    const alpha = project("p1", "/work/alpha");

    expect(registeredProjectForEntry(entry("/work/alpha"), [alpha])).toEqual(alpha);
  });

  it("returns undefined when no registered project has that path", () => {
    expect(registeredProjectForEntry(entry("/work/alpha"), [project("p1", "/work/beta")])).toBeUndefined();
  });
});
```

Append the rendering and interaction suites to the same file. These use real DOM interaction through the custom element, following the repository's preference for DOM over template inspection:

```ts
async function mount(overrides: Partial<RecentProjectsPanel>): Promise<{ panel: RecentProjectsPanel; teardown: () => void }> {
  await import("./RecentProjectsPanel");
  const panel = document.createElement("recent-projects-panel") as RecentProjectsPanel;
  Object.assign(panel, overrides);
  document.body.append(panel);
  await panel.updateComplete;
  return { panel, teardown: () => { panel.remove(); } };
}

function rows(panel: RecentProjectsPanel): HTMLElement[] {
  return [...panel.renderRoot.querySelectorAll<HTMLElement>(".recent-project-row")];
}

describe("recent-projects-panel rendering", () => {
  it("renders entries in server order with name and full path", async () => {
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/beta"), entry("/work/alpha")] },
      projects: [project("p1", "/work/alpha"), project("p2", "/work/beta")],
    });

    expect(rows(panel).map((row) => row.textContent?.includes("/work/beta"))).toEqual([true, false]);
    expect(panel.renderRoot.textContent).toContain("/work/alpha");

    teardown();
  });

  it("marks an entry with no registered project as Closed", async () => {
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha")] },
      projects: [],
    });

    expect(panel.renderRoot.textContent).toContain("Closed");

    teardown();
  });

  it("shows an activity indicator for a registered project with active work", async () => {
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha")] },
      projects: [project("p1", "/work/alpha")],
      workspacesByProjectId: { p1: [workspace("p1", "/work/alpha")] },
      activities: { "/work/alpha": { cwd: "/work/alpha", hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "2026-01-01T00:00:00.000Z" } },
    });

    expect(panel.renderRoot.querySelector(".activity-indicator")).not.toBeNull();

    teardown();
  });

  it("renders loading, empty, and failed states", async () => {
    const loading = await mount({ state: { kind: "loading" } });
    expect(loading.panel.renderRoot.textContent).toContain("Loading");
    loading.teardown();

    const empty = await mount({ state: { kind: "ready", entries: [] } });
    expect(empty.panel.renderRoot.textContent).toContain("No recent projects");
    empty.teardown();

    const failed = await mount({ state: { kind: "failed", message: "offline" } });
    expect(failed.panel.renderRoot.textContent).toContain("offline");
    expect(failed.panel.renderRoot.querySelector("button.recent-projects-retry")).not.toBeNull();
    failed.teardown();
  });

  it("renders no per-row removal control", async () => {
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha")] },
      projects: [project("p1", "/work/alpha")],
    });

    expect(panel.renderRoot.querySelectorAll(".action-menu-toggle")).toHaveLength(0);
    expect(panel.renderRoot.querySelectorAll("button")).toHaveLength(0);
    expect(panel.renderRoot.textContent).not.toContain("Remove");
    expect(renderedText(panel)).not.toContain("Remove");

    teardown();
  });
});
```

Append the activation suite to the same file:

```ts
describe("recent-projects-panel activation", () => {
  it("opens a registered project through the supplied callback", async () => {
    const onOpenRegistered = vi.fn();
    const alpha = project("p1", "/work/alpha");
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha")] },
      projects: [alpha],
      onOpenRegistered,
    });

    rows(panel)[0]?.click();

    expect(onOpenRegistered).toHaveBeenCalledWith(alpha);
    teardown();
  });

  it("routes a closed entry to the closed handler instead", async () => {
    const onOpenRegistered = vi.fn();
    const onOpenClosed = vi.fn();
    const closed = entry("/work/alpha");
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [closed] },
      projects: [],
      onOpenClosed,
      onOpenRegistered,
    });

    rows(panel)[0]?.click();

    expect(onOpenClosed).toHaveBeenCalledWith(closed);
    expect(onOpenRegistered).not.toHaveBeenCalled();
    teardown();
  });

  it("activates a row from the keyboard and retries from the failed state", async () => {
    const onOpenRegistered = vi.fn();
    const alpha = project("p1", "/work/alpha");
    const opened = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha")] },
      projects: [alpha],
      onOpenRegistered,
    });

    rows(opened.panel)[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onOpenRegistered).toHaveBeenCalledWith(alpha);
    opened.teardown();

    const onRetry = vi.fn();
    const failed = await mount({ state: { kind: "failed", message: "offline" }, onRetry });

    failed.panel.renderRoot.querySelector<HTMLButtonElement>("button.recent-projects-retry")?.click();

    expect(onRetry).toHaveBeenCalledTimes(1);
    failed.teardown();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/client/src/components/RecentProjectsPanel.test.ts`
Expected: FAIL, `Cannot find module './RecentProjectsPanel'`.

- [ ] **Step 3: Add the history tab icon**

In `src/client/src/components/tabIcons.ts`, extend the union to `export type AppTabBuiltinIcon = "navigation" | "chat" | "files" | "git" | "terminal" | "info" | "history";` and add this case to `renderBuiltinTabIcon`, matching the existing outline style:

```ts
    case "history":
      return svg`
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M3.5 12a8.5 8.5 0 1 0 2.8-6.3"></path>
          <path d="M3 4.5V9h4.5"></path>
          <path d="M12 8v4.5l3 2"></path>
        </svg>
      `;
```

- [ ] **Step 4: Write the panel component**

Create `src/client/src/components/RecentProjectsPanel.ts`:

```ts
import { LitElement, html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { Project, RecentProjectEntry, Workspace, WorkspaceActivity } from "../api";
import type { RecentProjectsState } from "../controllers/recentProjectController";
import { projectActivityIndicator } from "../workspaceActivity";
import { renderActionActivityIndicator } from "./activityBadge";
import { listStyles } from "./shared";

/**
 * The registered project for a history entry, matched on the resolved path the
 * registry itself dedupes by. History deliberately stores no project id, because
 * closing and reopening a path can mint a new one.
 */
export function registeredProjectForEntry(entry: RecentProjectEntry, projects: readonly Project[]): Project | undefined {
  return projects.find((project) => project.path === entry.path);
}

@customElement("recent-projects-panel")
export class RecentProjectsPanel extends LitElement {
  @property({ attribute: false }) state: RecentProjectsState = { kind: "loading" };
  @property({ attribute: false }) projects: Project[] = [];
  @property({ attribute: false }) workspacesByProjectId: Record<string, Workspace[]> = {};
  @property({ attribute: false }) activities: Record<string, WorkspaceActivity> = {};
  @property({ attribute: false }) selectedProjectId: string | undefined;
  @property({ attribute: false }) onOpenRegistered?: (project: Project) => void;
  @property({ attribute: false }) onOpenClosed?: (entry: RecentProjectEntry) => void;
  @property({ attribute: false }) onRetry?: () => void;

  override render(): TemplateResult {
    if (this.state.kind === "loading") return html`<p class="muted" role="status">Loading recent projects…</p>`;
    if (this.state.kind === "failed") return this.renderFailure(this.state.message);
    if (this.state.entries.length === 0) return html`<p class="muted" role="status">No recent projects</p>`;
    return html`
      <div class="list-body recent-projects-list">
        ${this.state.entries.map((entry) => this.renderEntry(entry))}
      </div>
    `;
  }

  private renderFailure(message: string): TemplateResult {
    return html`
      <div class="recent-projects-failure" role="status">
        <p class="muted">Recent projects could not be loaded: ${message}</p>
        <button class="recent-projects-retry" type="button" @click=${() => { this.onRetry?.(); }}>Retry</button>
      </div>
    `;
  }

  private renderEntry(entry: RecentProjectEntry): TemplateResult {
    const project = registeredProjectForEntry(entry, this.projects);
    const selected = project !== undefined && project.id === this.selectedProjectId;
    return html`
      <div
        class=${`action-row recent-project-row ${selected ? "selected" : ""}`}
        tabindex="0"
        role="button"
        title=${entry.path}
        aria-label=${project === undefined ? `${entry.name}, closed, ${entry.path}` : `${entry.name}, ${entry.path}`}
        @click=${() => { this.open(entry, project); }}
        @keydown=${(event: KeyboardEvent) => { this.handleKeydown(event, entry, project); }}
      >
        <div class="action-main">
          <span class="recent-project-primary">
            <span class="recent-project-name">${entry.name}</span>
            ${project === undefined ? html`<span class="recent-project-status">Closed</span>` : null}
          </span>
          <small class="recent-project-path">${entry.path}</small>
          ${project === undefined ? null : this.renderActivity(project)}
        </div>
      </div>
    `;
  }

  private renderActivity(project: Project): TemplateResult | undefined {
    const kind = projectActivityIndicator(project, this.workspacesByProjectId[project.id] ?? [], this.activities);
    return renderActionActivityIndicator(kind, kind === "terminal" ? "Project terminal active" : "Project active");
  }

  private handleKeydown(event: KeyboardEvent, entry: RecentProjectEntry, project: Project | undefined): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    this.open(entry, project);
  }

  private open(entry: RecentProjectEntry, project: Project | undefined): void {
    if (project === undefined) this.onOpenClosed?.(entry);
    else this.onOpenRegistered?.(project);
  }

  static override styles = listStyles;
}
```

If `listStyles` does not already provide readable wrapping for the path and status, add a small component-scoped `css` block after it rather than editing shared styles: constrain `.recent-project-path` with `overflow-wrap: anywhere;` so long paths wrap instead of scrolling horizontally, and give `.recent-project-status` the muted token treatment used by `.workspace-status`.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/components/RecentProjectsPanel.test.ts`
Expected: PASS with no failures (11 tests).

- [ ] **Step 6: Lint the changed files**

Run: `npx eslint src/client/src/components/RecentProjectsPanel.ts src/client/src/components/RecentProjectsPanel.test.ts src/client/src/components/tabIcons.ts`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/client/src/components/RecentProjectsPanel.ts src/client/src/components/RecentProjectsPanel.test.ts src/client/src/components/tabIcons.ts
git commit -m "feat(client): add the recent projects panel component"
```

## Task 7: Closed-entry decision dialog

**Implementer tier:** Advanced

**Files:**

- Create: `src/client/src/components/ClosedRecentProjectDialog.ts`
- Test: `src/client/src/components/ClosedRecentProjectDialog.test.ts`

**Interfaces:**

- Consumes from Task 1: `RecentProjectEntry = { id: string; name: string; path: string; lastUsedAt: string }` from `../api`.
- Produces the `closed-recent-project-dialog` custom element:

```ts
@property({ attribute: false }) entry!: RecentProjectEntry;
@property({ attribute: false }) onReopen!: (entry: RecentProjectEntry) => Promise<void>;
@property({ attribute: false }) onRemove!: (entry: RecentProjectEntry) => Promise<void>;
@property({ attribute: false }) onClose!: () => void;
```

Behavior: `onReopen` and `onRemove` are awaited. On rejection the dialog stays open and renders the error message; on success it calls `onClose`. Escape, the close affordance, and a backdrop click call `onClose` without mutating. Focus starts on Reopen. While an action is in flight both action buttons are disabled.

- [ ] **Step 1: Write the failing test**

Create `src/client/src/components/ClosedRecentProjectDialog.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { RecentProjectEntry } from "../../../shared/apiTypes";
import { ClosedRecentProjectDialog } from "./ClosedRecentProjectDialog";

const entry: RecentProjectEntry = { id: "e1", name: "alpha", path: "/work/alpha", lastUsedAt: "2026-01-01T00:00:00.000Z" };

async function mount(overrides: Partial<ClosedRecentProjectDialog> = {}): Promise<{ dialog: ClosedRecentProjectDialog; teardown: () => void }> {
  await import("./ClosedRecentProjectDialog");
  const dialog = document.createElement("closed-recent-project-dialog") as ClosedRecentProjectDialog;
  Object.assign(dialog, {
    entry,
    onReopen: () => Promise.resolve(),
    onRemove: () => Promise.resolve(),
    onClose: () => undefined,
    ...overrides,
  });
  document.body.append(dialog);
  await dialog.updateComplete;
  return { dialog, teardown: () => { dialog.remove(); } };
}

function button(dialog: ClosedRecentProjectDialog, selector: string): HTMLButtonElement {
  const found = dialog.renderRoot.querySelector<HTMLButtonElement>(selector);
  if (found === null) throw new Error(`expected ${selector}`);
  return found;
}

describe("closed-recent-project-dialog", () => {
  it("identifies the project without claiming the directory is missing", async () => {
    const { dialog, teardown } = await mount();

    expect(dialog.renderRoot.textContent).toContain("alpha");
    expect(dialog.renderRoot.textContent).toContain("/work/alpha");
    expect(dialog.renderRoot.textContent).toContain("no longer registered");
    expect(dialog.renderRoot.textContent).not.toContain("missing");
    expect(dialog.renderRoot.querySelector("[role=dialog], dialog")).not.toBeNull();

    teardown();
  });

  it("focuses Reopen first", async () => {
    const { dialog, teardown } = await mount();

    expect(dialog.renderRoot.activeElement ?? document.activeElement).toBe(button(dialog, ".closed-recent-reopen"));

    teardown();
  });

  it("reopens and closes on success", async () => {
    const onReopen = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const { dialog, teardown } = await mount({ onReopen, onClose });

    button(dialog, ".closed-recent-reopen").click();
    await vi.waitFor(() => { expect(onClose).toHaveBeenCalledTimes(1); });

    expect(onReopen).toHaveBeenCalledWith(entry);
    teardown();
  });
});
```

Append the failure and dismissal suites to the same file:

```ts
describe("closed-recent-project-dialog failures", () => {
  it("keeps the dialog open and shows the error when reopening fails", async () => {
    const onClose = vi.fn();
    const { dialog, teardown } = await mount({
      onReopen: () => Promise.reject(new Error("Project path must be a directory")),
      onClose,
    });

    button(dialog, ".closed-recent-reopen").click();
    await vi.waitFor(() => {
      expect(dialog.renderRoot.textContent).toContain("Project path must be a directory");
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(button(dialog, ".closed-recent-reopen").disabled).toBe(false);
    teardown();
  });

  it("removes history and closes, and reports a removal conflict without closing", async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const removed = await mount({ onRemove, onClose });

    button(removed.dialog, ".closed-recent-remove").click();
    await vi.waitFor(() => { expect(onClose).toHaveBeenCalledTimes(1); });
    expect(onRemove).toHaveBeenCalledWith(entry);
    removed.teardown();

    const conflictClose = vi.fn();
    const conflict = await mount({
      onRemove: () => Promise.reject(new Error("Recent project is registered")),
      onClose: conflictClose,
    });

    button(conflict.dialog, ".closed-recent-remove").click();
    await vi.waitFor(() => {
      expect(conflict.dialog.renderRoot.textContent).toContain("Recent project is registered");
    });

    expect(conflictClose).not.toHaveBeenCalled();
    conflict.teardown();
  });

  it("cancels without mutating on button, Escape, and backdrop", async () => {
    const onReopen = vi.fn();
    const onRemove = vi.fn();

    const cancelled = await mount({ onReopen, onRemove, onClose: vi.fn() });
    button(cancelled.dialog, ".closed-recent-cancel").click();
    expect(cancelled.dialog.onClose).toBeDefined();
    cancelled.teardown();

    const escaped = await mount({ onReopen, onRemove });
    const escapeClose = vi.fn();
    escaped.dialog.onClose = escapeClose;
    escaped.dialog.renderRoot.querySelector("dialog")?.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(escapeClose).toHaveBeenCalledTimes(1);
    escaped.teardown();

    expect(onReopen).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/client/src/components/ClosedRecentProjectDialog.test.ts`
Expected: FAIL, `Cannot find module './ClosedRecentProjectDialog'`.

- [ ] **Step 3: Write the dialog**

Create `src/client/src/components/ClosedRecentProjectDialog.ts`. Model the modal shell, backdrop behavior, focus handling, and styles on the existing `src/client/src/components/PluginActivityDialog.ts`, which already implements the repository's native `<dialog>` pattern with `showModal()`, a `cancel` handler, and a backdrop click check. Reuse that structure rather than inventing a new modal.

```ts
import { LitElement, css, html, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { RecentProjectEntry } from "../api";

@customElement("closed-recent-project-dialog")
export class ClosedRecentProjectDialog extends LitElement {
  @property({ attribute: false }) entry!: RecentProjectEntry;
  @property({ attribute: false }) onReopen!: (entry: RecentProjectEntry) => Promise<void>;
  @property({ attribute: false }) onRemove!: (entry: RecentProjectEntry) => Promise<void>;
  @property({ attribute: false }) onClose!: () => void;

  @query("dialog") private nativeDialog?: HTMLDialogElement;
  @query(".closed-recent-reopen") private reopenButton?: HTMLButtonElement;
  @state() private busy = false;
  @state() private failure: string | undefined;

  override firstUpdated(): void {
    const dialog = this.nativeDialog;
    if (dialog?.isConnected !== true) return;
    dialog.showModal();
    this.reopenButton?.focus();
  }

  override disconnectedCallback(): void {
    const dialog = this.nativeDialog;
    if (dialog?.open === true) dialog.close();
    super.disconnectedCallback();
  }

  override render(): TemplateResult {
    return html`
      <dialog
        class="closed-recent-backdrop"
        aria-modal="true"
        aria-label=${`Recent project ${this.entry.name}`}
        @cancel=${this.handleCancel}
        @click=${this.handleBackdropClick}
      >
        <section class="closed-recent-frame">
          <h2>${this.entry.name}</h2>
          <p class="closed-recent-path">${this.entry.path}</p>
          <p class="muted">This project is no longer registered in PI WEBUI.</p>
          ${this.failure === undefined ? null : html`<p class="closed-recent-error" role="status">${this.failure}</p>`}
          <div class="closed-recent-actions">
            <button class="closed-recent-reopen" type="button" ?disabled=${this.busy} @click=${() => { void this.run(this.onReopen); }}>Reopen</button>
            <button class="closed-recent-remove" type="button" ?disabled=${this.busy} @click=${() => { void this.run(this.onRemove); }}>Remove from history</button>
            <button class="closed-recent-cancel" type="button" @click=${() => { this.onClose(); }}>Cancel</button>
          </div>
        </section>
      </dialog>
    `;
  }

  private readonly handleCancel = (event: Event): void => {
    event.preventDefault();
    this.onClose();
  };

  private readonly handleBackdropClick = (event: MouseEvent): void => {
    if (event.target === event.currentTarget) this.onClose();
  };

  /**
   * Both actions can fail for reasons the user must see: a missing directory, an
   * unavailable machine, denied access, or a path that was registered again. The
   * dialog therefore stays open on failure and only closes on success.
   */
  private async run(action: (entry: RecentProjectEntry) => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.failure = undefined;
    try {
      await action(this.entry);
      this.onClose();
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 70; display: block; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    dialog { border: 0; padding: 0; background: transparent; }
    dialog::backdrop { background: var(--pi-overlay); }
    .closed-recent-frame { width: min(480px, 92vw); display: grid; gap: 12px; padding: 20px; border: 1px solid var(--pi-border); border-radius: 12px; background: var(--pi-bg); box-shadow: 0 20px 64px var(--pi-shadow-strong); }
    h2, p { margin: 0; }
    .closed-recent-path { overflow-wrap: anywhere; color: var(--pi-muted); }
    .closed-recent-error { color: var(--pi-danger); }
    .closed-recent-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    button:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
  `;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/components/ClosedRecentProjectDialog.test.ts`
Expected: PASS with no failures (6 tests).

- [ ] **Step 5: Lint the new files**

Run: `npx eslint src/client/src/components/ClosedRecentProjectDialog.ts src/client/src/components/ClosedRecentProjectDialog.test.ts`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/client/src/components/ClosedRecentProjectDialog.ts src/client/src/components/ClosedRecentProjectDialog.test.ts
git commit -m "feat(client): add the closed recent project decision dialog"
```

## Task 8: Resolve workspace-panel tabs so a machine-level tab can exist

**Implementer tier:** Capable

**Files:**

- Modify: `src/client/src/components/WorkspacePanel.ts:1-96`
- Modify: `src/client/src/components/PiWebUiApp.ts:1457-1473`
- Modify: `src/client/src/components/PiWebUiApp.ts:2350-2356`
- Modify: `src/client/src/components/PiWebUiApp.ts:2403-2412`
- Test: `src/client/src/components/WorkspacePanel.resolvedTabs.test.ts`
- Test: `src/client/src/components/PiWebUiApp.recentProjects.test.ts`

**Interfaces:**

- Consumes from Task 6: the `recent-projects-panel` element with properties `state`, `projects`, `workspacesByProjectId`, `activities`, `selectedProjectId`, `onOpenRegistered`, `onOpenClosed`, `onRetry`; and `registeredProjectForEntry(entry, projects)`.
- Consumes from Task 7: the `closed-recent-project-dialog` element with properties `entry`, `onReopen`, `onRemove`, `onClose`.
- Consumes from Task 5: `RecentProjectController` with `state`, `load()`, `retry()`, `recordWork(projectId)`, `removeEntry(entryId)`, and `RecentProjectsState`.
- Produces, exported from `src/client/src/components/WorkspacePanel.ts`:

```ts
export interface ResolvedWorkspacePanelTab {
  id: QualifiedContributionId;
  title: string;
  icon?: TemplateResult;
  badge?: string | number | TemplateResult;
  render: () => TemplateResult;
}
```

- Produces on `WorkspacePanel`: a new `@property({ attribute: false }) tabs: ResolvedWorkspacePanelTab[] = []` that fully replaces the `panels`, `panelContext`, and `workspace`-driven rendering path inside `render()`. Keep `emptyState`, `tool`, `hiddenTools`, `hideToolTabs`, and `onSelectTool` behavior, and keep the existing header scroll logic untouched.
- Produces on `PiWebUiApp`: `private resolvedWorkspacePanelTabs(): ResolvedWorkspacePanelTab[]`, which always includes the `core:recent-projects` tab first when a machine is selected, then maps each visible workspace panel contribution to a resolved tab by binding the existing `WorkspacePanelContext`.

- [ ] **Step 1: Write the failing panel test**

Create `src/client/src/components/WorkspacePanel.resolvedTabs.test.ts`:

```ts
import { html } from "lit";
import { describe, expect, it, vi } from "vitest";
import { WorkspacePanel, type ResolvedWorkspacePanelTab } from "./WorkspacePanel";

function tab(id: string, title: string, render = () => html`<p>${title} body</p>`): ResolvedWorkspacePanelTab {
  return { id: id as ResolvedWorkspacePanelTab["id"], title, render };
}

async function mount(overrides: Partial<WorkspacePanel>): Promise<{ panel: WorkspacePanel; teardown: () => void }> {
  await import("./WorkspacePanel");
  const panel = document.createElement("workspace-panel") as WorkspacePanel;
  Object.assign(panel, overrides);
  document.body.append(panel);
  await panel.updateComplete;
  return { panel, teardown: () => { panel.remove(); } };
}

function tabButtons(panel: WorkspacePanel): HTMLButtonElement[] {
  return [...panel.renderRoot.querySelectorAll<HTMLButtonElement>(".tabs button")];
}

describe("workspace-panel resolved tabs", () => {
  it("renders a machine-level tab with no workspace and no panel context", async () => {
    const { panel, teardown } = await mount({
      tabs: [tab("core:recent-projects", "Recent Projects")],
      tool: "core:recent-projects" as WorkspacePanel["tool"],
    });

    expect(tabButtons(panel).map((button) => button.textContent?.trim())).toEqual(["Recent Projects"]);
    expect(panel.renderRoot.textContent).toContain("Recent Projects body");

    teardown();
  });

  it("falls back to the first available tab when the remembered tool is absent", async () => {
    const { panel, teardown } = await mount({
      tabs: [tab("core:recent-projects", "Recent Projects")],
      tool: "core:workspace.files" as WorkspacePanel["tool"],
    });

    expect(panel.renderRoot.textContent).toContain("Recent Projects body");

    teardown();
  });

  it("omits a hidden tab from the header while keeping the visible ones", async () => {
    const { panel, teardown } = await mount({
      tabs: [tab("core:recent-projects", "Recent Projects"), tab("core:workspace.info", "Info")],
      hiddenTools: ["core:workspace.info" as WorkspacePanel["tool"]],
      tool: "core:recent-projects" as WorkspacePanel["tool"],
    });

    expect(tabButtons(panel).map((button) => button.textContent?.trim())).toEqual(["Recent Projects"]);
    expect(panel.renderRoot.textContent).toContain("Recent Projects body");
    expect(panel.renderRoot.textContent).not.toContain("Info body");

    teardown();
  });

  it("reports selection through onSelectTool and renders the empty state with no tabs", async () => {
    const onSelectTool = vi.fn();
    const selected = await mount({
      tabs: [tab("core:recent-projects", "Recent Projects"), tab("core:workspace.files", "Files")],
      tool: "core:recent-projects" as WorkspacePanel["tool"],
      onSelectTool,
    });

    tabButtons(selected.panel)[1]?.click();
    expect(onSelectTool).toHaveBeenCalledWith("core:workspace.files");
    selected.teardown();

    const empty = await mount({ tabs: [], emptyState: { title: "Select a workspace" } });
    expect(empty.panel.renderRoot.textContent).toContain("Select a workspace");
    empty.teardown();
  });
});
```

- [ ] **Step 2: Write the failing host test**

Create `src/client/src/components/PiWebUiApp.recentProjects.test.ts`. Read `src/client/src/components/PiWebUiApp.infoTab.test.ts` first and reuse its harness for constructing the app element and reaching private members; follow that file's existing accessor conventions rather than inventing new ones.

```ts
import { describe, expect, it } from "vitest";
import { PiWebUiApp } from "./PiWebUiApp";
import type { ResolvedWorkspacePanelTab } from "./WorkspacePanel";

function resolvedTabs(app: PiWebUiApp): ResolvedWorkspacePanelTab[] {
  const resolve = Reflect.get(app, "resolvedWorkspacePanelTabs");
  if (typeof resolve !== "function") throw new Error("Expected resolvedWorkspacePanelTabs");
  const tabs: unknown = resolve.call(app);
  if (!Array.isArray(tabs)) throw new Error("Expected an array of resolved tabs");
  return tabs as ResolvedWorkspacePanelTab[];
}

describe("PiWebUiApp recent projects tab", () => {
  it("offers Recent Projects first when no workspace is selected", () => {
    const app = new PiWebUiApp();

    const tabs = resolvedTabs(app);

    expect(tabs[0]?.id).toBe("core:recent-projects");
    expect(tabs[0]?.title).toBe("Recent Projects");
    expect(tabs.every((tab) => tab.id === "core:recent-projects")).toBe(true);
  });

  it("renders the Recent Projects body without a workspace context", () => {
    const app = new PiWebUiApp();

    expect(() => resolvedTabs(app)[0]?.render()).not.toThrow();
  });
});
```

- [ ] **Step 3: Run both tests and confirm they fail**

Run: `npm test -- --run src/client/src/components/WorkspacePanel.resolvedTabs.test.ts src/client/src/components/PiWebUiApp.recentProjects.test.ts`
Expected: FAIL. `tabs` is not a property of `WorkspacePanel`, and `resolvedWorkspacePanelTabs` does not exist.

- [ ] **Step 4: Render resolved tabs in the workspace panel**

In `src/client/src/components/WorkspacePanel.ts`, export the resolved-tab type and replace the context-driven render path. Add the type beside `WorkspacePanelEmptyState`:

```ts
/**
 * A workspace-panel tab with its rendering already bound by the app shell. This
 * exists so a machine-level tab (Recent Projects) can appear with no selected
 * workspace, instead of the panel having to fabricate a WorkspacePanelContext.
 */
export interface ResolvedWorkspacePanelTab {
  id: QualifiedContributionId;
  title: string;
  icon?: TemplateResult;
  badge?: string | number | TemplateResult;
  render: () => TemplateResult;
}
```

Add `@property({ attribute: false }) tabs: ResolvedWorkspacePanelTab[] = [];` beside the existing properties, and remove the now-unused `workspace`, `panelContext`, and `panels` properties along with their imports if nothing else in the file uses them. Replace `render()` with:

```ts
  override render() {
    const tabs = this.tabs;
    if (tabs.length === 0) {
      return this.renderEmptyState(this.emptyState ?? {
        title: "Select a workspace",
        body: "Choose a workspace to inspect files, Git, or terminals.",
      });
    }
    const visibleTabs = tabs.filter((tab) => !this.hiddenTools.includes(tab.id));
    const selectedTab = tabs.find((tab) => tab.id === this.tool) ?? visibleTabs[0] ?? tabs[0];
    return html`
      ${this.hideToolTabs ? null : html`
        <header>
          <div class=${this.workspaceHeaderFrameClass()}>
            <div class="workspace-header-strip" @scroll=${this.onWorkspaceHeaderScroll}>
              <div class="tabs">
                ${visibleTabs.map((tab) => {
                  const selected = selectedTab?.id === tab.id;
                  const ariaLabel = this.panelTabAriaLabel(tab, tab.badge);
                  return html`
                    <button class=${this.panelTabClass(tab, selected)} title=${ariaLabel} aria-label=${ariaLabel} aria-pressed=${String(selected)} @click=${() => { this.onSelectTool(tab.id); }}>
                      ${this.renderPanelTabContent(tab, tab.badge)}
                    </button>
                  `;
                })}
              </div>
            </div>
          </div>
        </header>
      `}
      ${selectedTab === undefined ? this.renderEmptyState({
        title: "No workspace tools available",
        body: "No tools are available for this workspace.",
      }) : html`
        <div class="panel-content">
          ${selectedTab.render()}
        </div>
      `}
    `;
  }
```

Change the three private helpers to accept the resolved shape: `panelTabClass(tab: Pick<ResolvedWorkspacePanelTab, "icon">, selected: boolean)`, `panelTabAriaLabel(tab: Pick<ResolvedWorkspacePanelTab, "title">, badge: WorkspacePanelBadge)`, and `renderPanelTabContent(tab: Pick<ResolvedWorkspacePanelTab, "icon" | "title">, badge: WorkspacePanelBadge)`. Their bodies are unchanged apart from the parameter name.

- [ ] **Step 5: Resolve the tabs in the app shell**

In `src/client/src/components/PiWebUiApp.ts`, add `import "./RecentProjectsPanel";` and `import "./ClosedRecentProjectDialog";` beside the existing component imports, import `RecentProjectController` from `../controllers/recentProjectController`, and import `type ResolvedWorkspacePanelTab` from `./WorkspacePanel`.

Add the controller and its dialog state as fields, wiring it to the existing selected-machine accessor and background-error reporter used by the other controllers in this class (match how `git`, `memory`, and `projects` are constructed and how their background errors are reported):

```ts
  private readonly recentProjects = new RecentProjectController({
    machineId: () => selectedMachineId(this.state),
    onChange: () => { this.requestUpdate(); },
    onBackgroundError: (operation, error) => { this.reportBackgroundError(operation, error); },
  });

  @state() private closedRecentProjectEntry: RecentProjectEntry | undefined;
```

If this class has no `reportBackgroundError`, use the same background-error channel the other controllers in this file already pass; do not introduce a second error surface.

Replace `renderWorkspacePanel` with a resolved-tab version:

```ts
  private renderWorkspacePanel() {
    const emptyState = this.state.selectedWorkspace === undefined ? this.workspacePanelEmptyState() : undefined;
    return html`
      <workspace-panel
        id="workspace-panel"
        .emptyState=${emptyState}
        .tool=${this.state.workspaceTool}
        .tabs=${this.resolvedWorkspacePanelTabs()}
        .hiddenTools=${this.hiddenWorkspacePanelTools()}
        .onSelectTool=${(tool: QualifiedContributionId) => { this.openWorkspaceTool(tool); }}
      ></workspace-panel>
    `;
  }

  /**
   * Recent Projects is machine-level, so it is offered whenever a machine is
   * selected and must not depend on a WorkspacePanelContext. Workspace and plugin
   * tabs still require a selected workspace and keep their existing context.
   */
  private resolvedWorkspacePanelTabs(): ResolvedWorkspacePanelTab[] {
    const tabs: ResolvedWorkspacePanelTab[] = [{
      id: "core:recent-projects",
      title: "Recent Projects",
      icon: renderBuiltinTabIcon("history"),
      render: () => this.renderRecentProjectsTab(),
    }];
    const workspace = this.state.selectedWorkspace;
    if (workspace === undefined) return tabs;
    const context = this.createWorkspacePanelContext(workspace);
    for (const panel of this.plugins.getWorkspacePanels()) {
      if (!(panel.visible?.(context) ?? true)) continue;
      const badge = panel.badge?.(context);
      tabs.push({
        id: panel.id,
        title: panel.title,
        ...(panel.icon === undefined ? {} : { icon: panel.icon }),
        ...(badge === undefined ? {} : { badge }),
        render: () => panel.render(context),
      });
    }
    return tabs;
  }

  private renderRecentProjectsTab(): TemplateResult {
    return html`
      <recent-projects-panel
        .state=${this.recentProjects.state}
        .projects=${this.state.projects}
        .workspacesByProjectId=${this.state.workspacesByProjectId}
        .activities=${this.state.workspaceActivities}
        .selectedProjectId=${this.state.selectedProject?.id}
        .onOpenRegistered=${(project: Project) => { void this.workspaces.selectProject(project); }}
        .onOpenClosed=${(entry: RecentProjectEntry) => { this.closedRecentProjectEntry = entry; }}
        .onRetry=${() => { void this.recentProjects.retry(); }}
      ></recent-projects-panel>
    `;
  }
```

Keep `workspacePanels()` if other call sites still use it; otherwise delete it along with its now-unused imports so Knip stays clean.

Render the dialog alongside the app's other overlays, and include it in `isChatObscured()` next to the existing overlay checks:

```ts
  private renderClosedRecentProjectDialog(): TemplateResult | null {
    const entry = this.closedRecentProjectEntry;
    if (entry === undefined) return null;
    return html`
      <closed-recent-project-dialog
        .entry=${entry}
        .onReopen=${async (target: RecentProjectEntry) => {
          await this.projects.addProject(target.path, target.name);
          await this.recentProjects.load();
        }}
        .onRemove=${(target: RecentProjectEntry) => this.recentProjects.removeEntry(target.id)}
        .onClose=${() => { this.closedRecentProjectEntry = undefined; }}
      ></closed-recent-project-dialog>
    `;
  }
```

Use whatever the existing `ProjectController` add-project method is actually named and whatever signature it exposes for `(path, name)`; read `src/client/src/controllers/projectController.ts` and call it exactly, without adding a new API path. After a successful reopen, also select the newly registered project through the same selection flow `onOpenRegistered` uses, so reopening navigates like a normal project selection.

Load history when the app connects and whenever the selected machine changes, using the same lifecycle hooks the other machine-scoped controllers in this file use (`load()` on connect and on machine change).

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/components/WorkspacePanel.resolvedTabs.test.ts src/client/src/components/PiWebUiApp.recentProjects.test.ts src/client/src/components/WorkspacePanel.test.ts src/client/src/components/PiWebUiApp.infoTab.test.ts`
Expected: PASS with no failures (4 new panel tests, 2 new host tests, existing suites unchanged).

- [ ] **Step 7: Update every other call site and verify broadly**

Run: `npm run typecheck`
Expected: exit 0. Fix any remaining `workspace-panel` usages that still pass `panels`, `panelContext`, or `workspace`, including test files, by giving them `tabs` instead.

Run: `npm run verify:fast`
Expected: PASS with no failures.

- [ ] **Step 8: Commit**

```bash
git add src/client/src/components/WorkspacePanel.ts src/client/src/components/PiWebUiApp.ts src/client/src/components/WorkspacePanel.resolvedTabs.test.ts src/client/src/components/PiWebUiApp.recentProjects.test.ts
git commit -m "feat(client): show the Recent Projects tab without a selected workspace"
```

## Task 9: Record meaningful work at the user-action boundaries

**Implementer tier:** Capable

**Files:**

- Modify: `src/client/src/components/PiWebUiApp.ts:2784-2792`
- Modify: `src/client/src/components/TerminalPanel.ts:440-475`
- Test: `src/client/src/components/PiWebUiApp.recordProjectWork.test.ts`

**Interfaces:**

- Consumes from Task 5: `RecentProjectController.recordWork(projectId: string): void`, which returns immediately, performs a synchronous newest-entry check, and never rejects.
- Consumes from Task 8: the `recentProjects` controller field on `PiWebUiApp`.
- Produces on `PiWebUiApp`: `private recordProjectWork(): void`, which resolves the currently selected project id and calls `recordWork` only when one exists.
- Produces on `TerminalPanel`: `@property({ attribute: false }) onInput?: () => void`, invoked once per input message the panel sends to its socket.

- [ ] **Step 1: Write the failing test**

Create `src/client/src/components/PiWebUiApp.recordProjectWork.test.ts`. Reuse the harness conventions from `PiWebUiApp.recentProjects.test.ts` (Task 8) for reaching private members.

```ts
import { describe, expect, it } from "vitest";
import { PiWebUiApp } from "./PiWebUiApp";

function installRecorder(app: PiWebUiApp): string[] {
  const recorded: string[] = [];
  const controller = Reflect.get(app, "recentProjects");
  if (typeof controller !== "object" || controller === null) throw new Error("Expected the recentProjects controller");
  Reflect.set(controller, "recordWork", (projectId: string) => { recorded.push(projectId); });
  return recorded;
}

function recordProjectWork(app: PiWebUiApp): void {
  const record = Reflect.get(app, "recordProjectWork");
  if (typeof record !== "function") throw new Error("Expected recordProjectWork");
  record.call(app);
}

describe("PiWebUiApp.recordProjectWork", () => {
  it("records the selected project", () => {
    const app = new PiWebUiApp();
    const recorded = installRecorder(app);
    Reflect.set(app, "state", { ...Reflect.get(app, "state"), selectedProject: { id: "p1", name: "alpha", path: "/work/alpha", createdAt: "2026-01-01T00:00:00.000Z" } });

    recordProjectWork(app);

    expect(recorded).toEqual(["p1"]);
  });

  it("records nothing when no project is selected", () => {
    const app = new PiWebUiApp();
    const recorded = installRecorder(app);

    recordProjectWork(app);

    expect(recorded).toEqual([]);
  });

  it("does not record when only the selected project changes", () => {
    const app = new PiWebUiApp();
    const recorded = installRecorder(app);
    const project = { id: "p1", name: "alpha", path: "/work/alpha", createdAt: "2026-01-01T00:00:00.000Z" };

    Reflect.set(app, "state", { ...Reflect.get(app, "state"), selectedProject: project });
    Reflect.set(app, "state", { ...Reflect.get(app, "state"), selectedWorkspace: { id: "w1", projectId: "p1", path: "/work/alpha", label: "main", isMain: true, isGitRepo: true, isGitWorktree: false } });

    expect(recorded).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/client/src/components/PiWebUiApp.recordProjectWork.test.ts`
Expected: FAIL, `Expected recordProjectWork`.

- [ ] **Step 3: Add the recording boundary**

In `src/client/src/components/PiWebUiApp.ts`, add:

```ts
  /**
   * Record meaningful user work on the selected project. Called only from
   * user-initiated boundaries: prompt submission, terminal start, terminal input,
   * and task or terminal-command dispatch. Selection, browsing, polling, and
   * streaming must never call this.
   */
  private recordProjectWork(): void {
    const projectId = this.state.selectedProject?.id;
    if (projectId === undefined) return;
    this.recentProjects.recordWork(projectId);
  }
```

Call it from exactly these places, after the primary action has been accepted so a history failure can never affect it:

1. The prompt-submission path that calls `this.sessions.send(...)` (or the app method that wraps it), immediately after the send call is issued.
2. `openRuntimeTerminal`, after the terminal open request is issued.
3. `createWorkspacePanelTerminal`, inside both `open` and `runCommand`, so plugin tasks and terminal commands record work through the existing host wrapper rather than calling history themselves.
4. The `onInput` callback passed to `terminal-panel` in the terminal tab render path.

Do not add calls anywhere else. In particular, do not call it from `selectProject`, `selectWorkspace`, `selectSession`, `openWorkspaceTool`, file or Git selection, polling, reconnect, or any event handler.

- [ ] **Step 4: Report terminal input from the terminal panel**

In `src/client/src/components/TerminalPanel.ts`, add `@property({ attribute: false }) onInput?: () => void;` beside the existing properties. In the `send` path, invoke it for input messages only:

```ts
  private send(message: { type: "input"; data: string } | { type: "resize"; cols: number; rows: number }): void {
    if (message.type === "input") this.onInput?.();
```

Keep the rest of `send` unchanged. This fires per keystroke by design; the controller's synchronous newest-entry check makes the common case free.

In the terminal tab render in `src/client/src/plugins/core/panels.ts`, pass the callback through from the context so the app shell owns the recording decision: add an optional `onTerminalInput?: () => void` to the workspace panel context creation in `PiWebUiApp` and bind it as `.onInput=${context.onTerminalInput}` on `terminal-panel`. If adding a context field would widen the public plugin contract, instead bind `onInput` in the app shell's own terminal render path and leave the plugin context untouched; prefer whichever keeps `src/client/src/plugins/types.ts` unchanged.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/components/PiWebUiApp.recordProjectWork.test.ts src/client/src/components/TerminalPanel.tabs.test.ts`
Expected: PASS with no failures (3 new tests, existing terminal suite unchanged).

- [ ] **Step 6: Verify broadly**

Run: `npm run verify:fast`
Expected: PASS with no failures.

- [ ] **Step 7: Commit**

```bash
git add src/client/src/components/PiWebUiApp.ts src/client/src/components/TerminalPanel.ts src/client/src/components/PiWebUiApp.recordProjectWork.test.ts
git commit -m "feat(client): record recent-project work at user-action boundaries"
```

## Task 10: Release note and final verification

**Implementer tier:** Fast

**Files:**

- Create: `.changeset/recent-projects-workspace-tab.md`

**Interfaces:**

- Consumes: the shipped behavior from Tasks 1 through 9. No code interface.
- Produces: one Changeset fragment declaring a `minor` bump for `@hyperdreamer/pi-webui`.

- [ ] **Step 1: Write the Changeset**

Create `.changeset/recent-projects-workspace-tab.md` with exactly this content:

````markdown
---
"@hyperdreamer/pi-webui": minor
---

Add a Recent Projects tab to the workspace panel. It lists the projects you have most recently registered or worked in on the selected machine, keeps up to 20 of them across restarts, and stays available when no workspace is selected. Selecting an entry whose project is no longer registered offers to reopen it or remove it from the history.
````

- [ ] **Step 2: Confirm the changelog was not hand-edited**

Run: `git status --short CHANGELOG.md`
Expected: no output, because `CHANGELOG.md` is generated during release preparation.

- [ ] **Step 3: Run the full serial verification**

Run: `npm run verify`
Expected: PASS with no failures.

If a test times out, re-run that file alone with `npm run test:serial -- --run <file>` on an idle machine before concluding anything; this suite is load-sensitive.

- [ ] **Step 4: Commit**

```bash
git add .changeset/recent-projects-workspace-tab.md
git commit -m "docs: add changeset for the recent projects workspace tab"
```
