# Project Pinning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users pin projects so pinned projects sort above unpinned ones in the Projects sidebar and expanded browser, with running projects first inside each group.

**Architecture:** A new optional `pinned` flag on `Project` is persisted in `projects.json` by `ProjectStore`, which also moves a project to the front of its array whenever pin state changes. Two new POST routes return the full reordered project list, so the server stays the single owner of order. The client's existing `displayedProjects` projection gains a pinned/unpinned split layered over the existing activity partition, and three components gain star toggles.

**Tech Stack:** TypeScript, Node 22, Fastify, Lit 3, Vitest, Changesets.

## Global Constraints

- Design source of truth: `docs/superpowers/specs/2026-08-06-project-pinning-design.md`.
- `tsconfig.json` sets `exactOptionalPropertyTypes: true`. Never assign `undefined` to an optional property; build objects with conditional spreads like `...(pinned === undefined ? {} : { pinned })`.
- Optional booleans are omitted when false, never serialized as `false`. This matches `SessionInfo.pinned`.
- Client browser paths are application-relative with no leading slash (`api/...`) and every dynamic segment goes through `encodeURIComponent`. Never introduce a leading-slash `/api` literal in client code.
- Run tests with `npm test -- --run <path>`. Never run the full suite inside a task; the final verification task owns `npm run verify`.
- Repository test guidance is `.agents/skills/testing-guide/SKILL.md`. Prefer the smallest layer that proves the behavior. Lit `TemplateResult` handler extraction is an escape hatch, allowed only for event-wiring assertions, and must use the shared helpers in `src/client/src/templateInspection.testSupport.ts` anchored to a stable user-facing marker.
- Do not edit `CHANGELOG.md`. User-visible changes get a `.changeset/*.md` fragment with package name `@hyperdreamer/pi-webui` and bump type `patch`.
- Commit with Conventional Commit messages. Pre-commit runs `npm run verify:staged`, which typechecks, runs Knip, and runs related tests; a commit that fails it must be fixed, not bypassed.
- Never export a symbol no other module imports yet. Knip runs on every commit and fails on unused exports.
- "Running" means live activity from `projectActivityIndicator`, never the selected project.

## Task 1: Persist the pinned flag in ProjectStore

**Implementer tier:** Standard

**Files:**

- Modify: `src/server/storage/projectStore.ts:1-100`
- Modify: `src/shared/apiTypes.ts:506-511`
- Test: `src/server/storage/projectStore.test.ts`

**Interfaces:**

- Consumes: nothing; this is the first task.
- Produces: `Project` in `src/shared/apiTypes.ts` gains `pinned?: boolean`. `ProjectStore.setPinned(id: string, pinned: boolean): Promise<Project[] | undefined>` resolves to the full project list in new order, or `undefined` when `id` is unknown. `ProjectStore` also serializes `add`, `remove`, and `setPinned` through a private `exclusive` queue.

- [ ] **Step 1: Add the optional flag to the shared Project type**

In `src/shared/apiTypes.ts`, the existing interface is:

```ts
export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}
```

Replace it with:

```ts
export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  /** True when the user has pinned this project so it sorts above unpinned projects. */
  pinned?: boolean;
}
```

- [ ] **Step 2: Write the failing tests**

Replace the whole contents of `src/server/storage/projectStore.test.ts` with:

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore, projectStorePath } from "./projectStore.js";

describe("projectStorePath", () => {
  it("uses PI_WEBUI_DATA_DIR by default", () => {
    expect(projectStorePath({ PI_WEBUI_DATA_DIR: "demo-data" }, "/tmp/pi-webui")).toBe(resolve("/tmp/pi-webui", "demo-data", "projects.json"));
  });

  it("uses PI_WEBUI_PROJECTS_FILE when configured", () => {
    expect(projectStorePath({ PI_WEBUI_PROJECTS_FILE: "demo/projects.json" }, "/tmp/pi-webui")).toBe(resolve("/tmp/pi-webui", "demo/projects.json"));
  });
});

describe("ProjectStore pin state", () => {
  let tempDir = "";
  let filePath = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-webui-project-store-"));
    filePath = join(tempDir, "projects.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("omits pinned for a newly added project", async () => {
    const store = new ProjectStore(filePath);

    const added = await store.add({ path: "/work/alpha" });

    expect(added).not.toHaveProperty("pinned");
    expect(await store.list()).toEqual([added]);
  });

  it("pins a project, moves it to the front, and returns the new order", async () => {
    const store = new ProjectStore(filePath);
    await store.add({ path: "/work/alpha" });
    await store.add({ path: "/work/beta" });
    const gamma = await store.add({ path: "/work/gamma" });

    const ordered = await store.setPinned(gamma.id, true);

    expect(ordered?.map((project) => project.path)).toEqual(["/work/gamma", "/work/alpha", "/work/beta"]);
    expect(ordered?.[0]).toMatchObject({ id: gamma.id, pinned: true });
    expect(await store.list()).toEqual(ordered);
  });

  it("unpins a project by omitting the flag and still moves it to the front", async () => {
    const store = new ProjectStore(filePath);
    const alpha = await store.add({ path: "/work/alpha" });
    const beta = await store.add({ path: "/work/beta" });
    await store.setPinned(alpha.id, true);
    await store.setPinned(beta.id, true);

    const ordered = await store.setPinned(alpha.id, false);

    expect(ordered?.map((project) => project.id)).toEqual([alpha.id, beta.id]);
    expect(ordered?.[0]).not.toHaveProperty("pinned");
    expect(ordered?.[1]).toMatchObject({ id: beta.id, pinned: true });
  });

  it("resolves to undefined for an unknown project id", async () => {
    const store = new ProjectStore(filePath);
    await store.add({ path: "/work/alpha" });

    expect(await store.setPinned("missing", true)).toBeUndefined();
  });

  it("reads and preserves a pinned flag already present on disk", async () => {
    await writeFile(filePath, `${JSON.stringify({
      projects: [
        { id: "a", name: "alpha", path: "/work/alpha", createdAt: "2026-08-06T00:00:00.000Z" },
        { id: "b", name: "beta", path: "/work/beta", createdAt: "2026-08-06T00:00:00.000Z", pinned: true },
      ],
    })}\n`, "utf8");
    const store = new ProjectStore(filePath);

    expect(await store.list()).toEqual([
      { id: "a", name: "alpha", path: "/work/alpha", createdAt: "2026-08-06T00:00:00.000Z" },
      { id: "b", name: "beta", path: "/work/beta", createdAt: "2026-08-06T00:00:00.000Z", pinned: true },
    ]);
  });

  it("rejects a non-boolean pinned value", async () => {
    await writeFile(filePath, `${JSON.stringify({
      projects: [{ id: "a", name: "alpha", path: "/work/alpha", createdAt: "2026-08-06T00:00:00.000Z", pinned: "yes" }],
    })}\n`, "utf8");
    const store = new ProjectStore(filePath);

    await expect(store.list()).rejects.toThrow("Invalid project");
  });

  it("does not lose an update when two mutations overlap", async () => {
    const store = new ProjectStore(filePath);
    const alpha = await store.add({ path: "/work/alpha" });
    const beta = await store.add({ path: "/work/beta" });

    await Promise.all([store.setPinned(alpha.id, true), store.setPinned(beta.id, true)]);

    const persisted: unknown = JSON.parse(await readFile(filePath, "utf8"));
    expect(persisted).toEqual({ projects: await store.list() });
    expect(await store.list()).toHaveLength(2);
    expect((await store.list()).every((project) => project.pinned === true)).toBe(true);
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npm test -- --run src/server/storage/projectStore.test.ts`
Expected: FAIL, `store.setPinned is not a function`.

- [ ] **Step 4: Parse and preserve the pinned flag**

In `src/server/storage/projectStore.ts`, replace the existing `parseProject` function:

```ts
function parseProject(value: unknown): Project {
  if (!isRecord(value)) throw new Error("Invalid project");
  const id = value["id"];
  const name = value["name"];
  const path = value["path"];
  const createdAt = value["createdAt"];
  if (typeof id !== "string" || typeof name !== "string" || typeof path !== "string" || typeof createdAt !== "string") throw new Error("Invalid project");
  return { id, name, path, createdAt };
}
```

with:

```ts
function parseProject(value: unknown): Project {
  if (!isRecord(value)) throw new Error("Invalid project");
  const id = value["id"];
  const name = value["name"];
  const path = value["path"];
  const createdAt = value["createdAt"];
  const pinned = value["pinned"];
  if (typeof id !== "string" || typeof name !== "string" || typeof path !== "string" || typeof createdAt !== "string") throw new Error("Invalid project");
  if (pinned !== undefined && typeof pinned !== "boolean") throw new Error("Invalid project");
  return { id, name, path, createdAt, ...(pinned === true ? { pinned: true } : {}) };
}
```

- [ ] **Step 5: Add the serialization queue and setPinned**

In `src/server/storage/projectStore.ts`, the class currently starts:

```ts
export class ProjectStore {
  constructor(private readonly filePath = projectStorePath()) {}
```

Add the queue field:

```ts
export class ProjectStore {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = projectStorePath()) {}
```

Wrap the two existing mutations in `exclusive` by replacing the bodies of `add` and `remove`. `add` becomes:

```ts
  async add(input: { name?: string; path: string }): Promise<Project> {
    return await this.exclusive(async () => {
      const data = await this.read();
      const path = input.path;
      const existing = data.projects.find((p) => p.path === path);
      if (existing) return existing;

      const trimmedName = input.name?.trim();
      const leafName = path.split("/").filter((part) => part !== "").at(-1);
      const project: Project = {
        id: randomUUID(),
        name: trimmedName !== undefined && trimmedName !== "" ? trimmedName : leafName ?? path,
        path,
        createdAt: new Date().toISOString(),
      };
      data.projects.push(project);
      await this.write(data);
      return project;
    });
  }
```

`remove` becomes:

```ts
  async remove(id: string): Promise<boolean> {
    return await this.exclusive(async () => {
      const data = await this.read();
      const projects = data.projects.filter((p) => p.id !== id);
      if (projects.length === data.projects.length) return false;
      await this.write({ projects });
      return true;
    });
  }
```

Then add `setPinned` immediately after `remove`:

```ts
  /**
   * Set pin state and move the project to the front of the list in one write.
   * Front-of-array placement is what makes a pinned or unpinned project appear
   * at the top of its display group, so ordering needs no separate order field.
   */
  async setPinned(id: string, pinned: boolean): Promise<Project[] | undefined> {
    return await this.exclusive(async () => {
      const data = await this.read();
      const target = data.projects.find((p) => p.id === id);
      if (target === undefined) return undefined;
      const updated: Project = {
        id: target.id,
        name: target.name,
        path: target.path,
        createdAt: target.createdAt,
        ...(pinned ? { pinned: true } : {}),
      };
      const projects = [updated, ...data.projects.filter((p) => p.id !== id)];
      await this.write({ projects });
      return projects;
    });
  }
```

Finally add the private helper next to `read` and `write`:

```ts
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release = (): void => undefined;
    this.operationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npm test -- --run src/server/storage/projectStore.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 7: Commit**

```bash
git add src/shared/apiTypes.ts src/server/storage/projectStore.ts src/server/storage/projectStore.test.ts
git commit -m "feat(projects): persist project pin state in projects.json"
```

## Task 2: Expose pin and unpin through ProjectService and HTTP routes

**Implementer tier:** Advanced

**Files:**

- Modify: `src/server/projects/projectService.ts:1-31`
- Modify: `src/server/app.ts:66-92`
- Modify: `src/shared/federatedRoutes.ts:44-47`
- Create: `src/server/projects/projectService.test.ts`
- Test: `src/server/app.projects.test.ts`

**Interfaces:**

- Consumes: `ProjectStore.setPinned(id: string, pinned: boolean): Promise<Project[] | undefined>` from Task 1, resolving to the full reordered list or `undefined` for an unknown id. `Project` is `{ id: string; name: string; path: string; createdAt: string; pinned?: boolean }`.
- Produces: `ProjectService.pin(id: string): Promise<Project[]>` and `ProjectService.unpin(id: string): Promise<Project[]>`, both throwing `Error("Project not found")` on a miss. HTTP `POST /api/projects/:projectId/pin` and `POST /api/projects/:projectId/unpin`, each returning `Project[]` in new order with 404 `{ error: "Project not found" }` for an unknown id, registered under both the `/api` and `/api/machines/local` prefixes and forwarded for remote machines. `Project` is re-exported from `src/server/types.ts`, which is the import path server modules use.

- [ ] **Step 1: Write the failing service test**

Create `src/server/projects/projectService.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ProjectService } from "./projectService.js";
import type { ProjectStore } from "../storage/projectStore.js";
import type { Project } from "../types.js";

function project(id: string, pinned?: true): Project {
  return { id, name: id, path: `/work/${id}`, createdAt: "2026-08-06T00:00:00.000Z", ...(pinned === undefined ? {} : { pinned }) };
}

function fakeStore(setPinned: ProjectStore["setPinned"]): ProjectStore {
  return { setPinned } as unknown as ProjectStore;
}

describe("ProjectService pin state", () => {
  it("returns the reordered list when pinning succeeds", async () => {
    const ordered = [project("beta", true), project("alpha")];
    const setPinned = vi.fn().mockResolvedValue(ordered);
    const service = new ProjectService(fakeStore(setPinned));

    await expect(service.pin("beta")).resolves.toEqual(ordered);
    expect(setPinned).toHaveBeenCalledWith("beta", true);
  });

  it("returns the reordered list when unpinning succeeds", async () => {
    const ordered = [project("beta"), project("alpha", true)];
    const setPinned = vi.fn().mockResolvedValue(ordered);
    const service = new ProjectService(fakeStore(setPinned));

    await expect(service.unpin("beta")).resolves.toEqual(ordered);
    expect(setPinned).toHaveBeenCalledWith("beta", false);
  });

  it("throws Project not found when the store reports an unknown id", async () => {
    const service = new ProjectService(fakeStore(vi.fn().mockResolvedValue(undefined)));

    await expect(service.pin("missing")).rejects.toThrow("Project not found");
    await expect(service.unpin("missing")).rejects.toThrow("Project not found");
  });
});
```

The `as unknown as ProjectStore` cast is deliberate and narrow: these three cases exercise only the pin path, so faking the one method that path uses keeps the fixture honest about its scope. Task 1's store tests cover real persistence.

- [ ] **Step 2: Write the failing route tests**

Append to `src/server/app.projects.test.ts`, inside the existing `describe("buildApp project routes", ...)` block:

```ts
  it("pins a project, returning the reordered list", async () => {
    const first = (await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "First", path: join(appTestContext.tempDir, "first"), create: true },
    })).json<Project>();
    const second = (await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Second", path: join(appTestContext.tempDir, "second"), create: true },
    })).json<Project>();

    const pinResponse = await appTestContext.app.inject({ method: "POST", url: `/api/projects/${second.id}/pin` });

    expect(pinResponse.statusCode).toBe(200);
    expect(pinResponse.json<Project[]>()).toEqual([{ ...second, pinned: true }, first]);
    expect((await appTestContext.app.inject({ method: "GET", url: "/api/projects" })).json<Project[]>()).toEqual([{ ...second, pinned: true }, first]);
  });

  it("unpins a project and moves it to the front of the list", async () => {
    const first = (await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "First", path: join(appTestContext.tempDir, "first"), create: true },
    })).json<Project>();
    const second = (await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Second", path: join(appTestContext.tempDir, "second"), create: true },
    })).json<Project>();
    await appTestContext.app.inject({ method: "POST", url: `/api/projects/${first.id}/pin` });

    const unpinResponse = await appTestContext.app.inject({ method: "POST", url: `/api/projects/${second.id}/unpin` });

    expect(unpinResponse.statusCode).toBe(200);
    expect(unpinResponse.json<Project[]>()).toEqual([second, { ...first, pinned: true }]);
  });

  it("returns 404 when pinning or unpinning an unknown project", async () => {
    const pinResponse = await appTestContext.app.inject({ method: "POST", url: "/api/projects/does-not-exist/pin" });
    const unpinResponse = await appTestContext.app.inject({ method: "POST", url: "/api/projects/does-not-exist/unpin" });

    expect(pinResponse.statusCode).toBe(404);
    expect(pinResponse.json()).toEqual({ error: "Project not found" });
    expect(unpinResponse.statusCode).toBe(404);
    expect(unpinResponse.json()).toEqual({ error: "Project not found" });
  });

  it("serves pin and unpin under the local machine prefix", async () => {
    const project = (await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Local", path: appTestContext.projectDir, create: true },
    })).json<Project>();

    const pinResponse = await appTestContext.app.inject({ method: "POST", url: `/api/machines/local/projects/${project.id}/pin` });
    const unpinResponse = await appTestContext.app.inject({ method: "POST", url: `/api/machines/local/projects/${project.id}/unpin` });

    expect(pinResponse.json<Project[]>()).toEqual([{ ...project, pinned: true }]);
    expect(unpinResponse.json<Project[]>()).toEqual([project]);
  });
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npm test -- --run src/server/projects/projectService.test.ts src/server/app.projects.test.ts`
Expected: FAIL. The service tests fail with `service.pin is not a function`; the route tests fail because the pin requests return 404 from Fastify's default not-found handler, since no such route exists.

- [ ] **Step 4: Add pin and unpin to ProjectService**

In `src/server/projects/projectService.ts`, add these two methods immediately after the existing `close` method:

```ts
  async pin(id: string): Promise<Project[]> {
    return await this.setPinned(id, true);
  }

  async unpin(id: string): Promise<Project[]> {
    return await this.setPinned(id, false);
  }

  private async setPinned(id: string, pinned: boolean): Promise<Project[]> {
    const projects = await this.store.setPinned(id, pinned);
    if (projects === undefined) throw new Error("Project not found");
    return projects;
  }
```

- [ ] **Step 5: Register the routes**

In `src/server/app.ts`, inside `registerLocalProjectRoutes`, add these two routes immediately after the existing `app.delete<{ Params: { projectId: string } }>(`${prefix}/projects/:projectId`, ...)` handler:

```ts
  app.post<{ Params: { projectId: string } }>(`${prefix}/projects/:projectId/pin`, async (request, reply) => {
    try {
      return await projects.pin(request.params.projectId);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { projectId: string } }>(`${prefix}/projects/:projectId/unpin`, async (request, reply) => {
    try {
      return await projects.unpin(request.params.projectId);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
```

- [ ] **Step 6: Allow the routes to reach remote machines**

In `src/shared/federatedRoutes.ts`, find this existing run of entries:

```ts
  { method: "DELETE", path: "/projects/:projectId" },
```

and add the two new entries directly beneath it:

```ts
  { method: "DELETE", path: "/projects/:projectId" },
  { method: "POST", path: "/projects/:projectId/pin" },
  { method: "POST", path: "/projects/:projectId/unpin" },
```

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `npm test -- --run src/server/projects/projectService.test.ts src/server/app.projects.test.ts`
Expected: PASS, 3 service tests plus all tests in `app.projects.test.ts` including the 4 new ones.

- [ ] **Step 8: Confirm the proxy contract tests still pass**

Run: `npm test -- --run src/server/app.remoteProxy.test.ts src/client/src/api/federatedRouteContract.test.ts`
Expected: PASS. If `federatedRouteContract.test.ts` fails because it asserts every federated route has a client caller, leave it failing and fix it in Task 4, which adds those callers. Note the failure in the commit body if so.

- [ ] **Step 9: Commit**

```bash
git add src/server/projects/projectService.ts src/server/projects/projectService.test.ts src/server/app.ts src/shared/federatedRoutes.ts src/server/app.projects.test.ts
git commit -m "feat(projects): add pin and unpin project routes"
```

## Task 3: Order pinned projects above unpinned ones

**Implementer tier:** Standard

**Files:**

- Modify: `src/client/src/components/projectListProjection.ts:24-31`
- Test: `src/client/src/components/projectListProjection.test.ts`

**Interfaces:**

- Consumes: `Project` with optional `pinned?: boolean` from Task 1. Existing `filterProjects(projects: readonly Project[], queryText: string): Project[]` and `prioritizeActiveProjects(projects: readonly Project[], workspacesByProjectId: Record<string, Workspace[]>, activities: Record<string, WorkspaceActivity>): Project[]` in the same file, both already exported and both stable partitions.
- Produces: `displayedProjects(projects, queryText, workspacesByProjectId, activities): Project[]` keeps its existing signature and now returns four groups in order: pinned+running, pinned+idle, unpinned+running, unpinned+idle.

- [ ] **Step 1: Write the failing tests**

Append to `src/client/src/components/projectListProjection.test.ts`, after the existing `describe("project list projection", ...)` block:

```ts
describe("project pin ordering", () => {
  const running: Record<string, WorkspaceActivity> = {
    "/work/server-console": { cwd: "/work/server-console", hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "2026-08-06T01:00:00.000Z" },
    "/work/client-guides": { cwd: "/work/client-guides", hasSessionActivity: false, hasTerminalActivity: true, updatedAt: "2026-08-06T01:00:00.000Z" },
  };

  it("groups pinned above unpinned and running above idle within each group", () => {
    const mixed: Project[] = [
      { id: "server", name: "Server Console", path: "/work/server-console", createdAt: "2026-08-06T00:00:00.000Z" },
      { id: "client", name: "Client App", path: "/work/client-app", createdAt: "2026-08-06T00:00:00.000Z", pinned: true },
      { id: "docs", name: "Documentation", path: "/work/client-guides", createdAt: "2026-08-06T00:00:00.000Z", pinned: true },
    ];

    expect(displayedProjects(mixed, "", {}, running).map((project) => project.id)).toEqual(["docs", "client", "server"]);
  });

  it("places a freshly unpinned running project first among unpinned projects", () => {
    const afterUnpin: Project[] = [
      { id: "server", name: "Server Console", path: "/work/server-console", createdAt: "2026-08-06T00:00:00.000Z" },
      { id: "docs", name: "Documentation", path: "/work/client-guides", createdAt: "2026-08-06T00:00:00.000Z" },
      { id: "client", name: "Client App", path: "/work/client-app", createdAt: "2026-08-06T00:00:00.000Z" },
    ];

    expect(displayedProjects(afterUnpin, "", {}, running).map((project) => project.id)).toEqual(["server", "docs", "client"]);
  });

  it("places a freshly unpinned idle project above other idle projects but below running ones", () => {
    const afterUnpin: Project[] = [
      { id: "client", name: "Client App", path: "/work/client-app", createdAt: "2026-08-06T00:00:00.000Z" },
      { id: "server", name: "Server Console", path: "/work/server-console", createdAt: "2026-08-06T00:00:00.000Z" },
      { id: "extra", name: "Extra", path: "/work/extra", createdAt: "2026-08-06T00:00:00.000Z" },
    ];

    expect(displayedProjects(afterUnpin, "", {}, running).map((project) => project.id)).toEqual(["server", "client", "extra"]);
  });

  it("keeps pinned grouping inside filtered results", () => {
    const mixed: Project[] = [
      { id: "server", name: "Server Console", path: "/work/server-console", createdAt: "2026-08-06T00:00:00.000Z" },
      { id: "client", name: "Client App", path: "/work/client-app", createdAt: "2026-08-06T00:00:00.000Z" },
      { id: "docs", name: "Documentation", path: "/work/client-guides", createdAt: "2026-08-06T00:00:00.000Z", pinned: true },
    ];

    expect(displayedProjects(mixed, "client", {}, {}).map((project) => project.id)).toEqual(["docs", "client"]);
  });

  it("does not mutate the incoming list", () => {
    const mixed: Project[] = [
      { id: "client", name: "Client App", path: "/work/client-app", createdAt: "2026-08-06T00:00:00.000Z" },
      { id: "docs", name: "Documentation", path: "/work/client-guides", createdAt: "2026-08-06T00:00:00.000Z", pinned: true },
    ];

    displayedProjects(mixed, "", {}, running);

    expect(mixed.map((project) => project.id)).toEqual(["client", "docs"]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/client/src/components/projectListProjection.test.ts`
Expected: FAIL on the first new test, which receives `["server", "docs", "client"]` because pin state is ignored.

- [ ] **Step 3: Add the pinned split**

In `src/client/src/components/projectListProjection.ts`, replace the existing `displayedProjects`:

```ts
export function displayedProjects(
  projects: readonly Project[],
  queryText: string,
  workspacesByProjectId: Record<string, Workspace[]>,
  activities: Record<string, WorkspaceActivity>,
): Project[] {
  return prioritizeActiveProjects(filterProjects(projects, queryText), workspacesByProjectId, activities);
}
```

with:

```ts
/**
 * Order projects for display: pinned above unpinned, and within each cohort
 * running above idle. Source order is preserved inside each of the four
 * resulting groups, so a project moved to the front of `projects.json` by a
 * pin or unpin lands at the top of whichever group it belongs to.
 */
export function displayedProjects(
  projects: readonly Project[],
  queryText: string,
  workspacesByProjectId: Record<string, Workspace[]>,
  activities: Record<string, WorkspaceActivity>,
): Project[] {
  const visible = filterProjects(projects, queryText);
  const prioritizeCohort = (cohort: readonly Project[]): Project[] => prioritizeActiveProjects(cohort, workspacesByProjectId, activities);
  return [
    ...prioritizeCohort(visible.filter((project) => project.pinned === true)),
    ...prioritizeCohort(visible.filter((project) => project.pinned !== true)),
  ];
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/components/projectListProjection.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Confirm the components that share the projection still pass**

Run: `npm test -- --run src/client/src/components/ProjectList.test.ts src/client/src/components/ProjectBrowserDialog.test.ts`
Expected: PASS. Both read ordering through `displayedProjects`, and no existing fixture sets `pinned`, so behavior is unchanged for them.

- [ ] **Step 6: Commit**

```bash
git add src/client/src/components/projectListProjection.ts src/client/src/components/projectListProjection.test.ts
git commit -m "feat(projects): sort pinned projects above unpinned ones"
```

## Task 4: Add the client API and controller methods

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/api/parsers.ts:166-169`
- Modify: `src/client/src/api/clients.ts:297-301`
- Modify: `src/client/src/controllers/projectController.ts:1-25`
- Test: `src/client/src/controllers/projectController.test.ts`
- Test: `src/client/src/api/clients.test.ts`

**Interfaces:**

- Consumes: HTTP `POST /api/projects/:projectId/pin` and `POST /api/projects/:projectId/unpin` from Task 2, both returning `Project[]` in new order, 404 on unknown id. `Project` is `{ id: string; name: string; path: string; createdAt: string; pinned?: boolean }`.
- Produces: `parseProject` accepts optional `pinned`. `projectsApi.pinProject(projectId: string, machineId?: string): Promise<Project[]>` and `projectsApi.unpinProject(projectId: string, machineId?: string): Promise<Project[]>`. `ProjectController.pinProject(projectId: string): Promise<void>` and `ProjectController.unpinProject(projectId: string): Promise<void>`, each replacing `state.projects` with the returned order, discarding the response when the selected machine changed mid-flight, and writing `String(error)` to `state.error` on failure.

- [ ] **Step 1: Write the failing client API test**

Append to `src/client/src/api/clients.test.ts`, after the existing `describe("project usage API", ...)` block:

```ts
describe("project pin API", () => {
  it("posts pin and unpin to encoded selected-machine routes", async () => {
    const pinned = [{ id: "p 1", name: "Repo", path: "/repo", createdAt: "2026-08-06T00:00:00.000Z", pinned: true }];
    const pinFetch = stubJsonFetch(pinned);

    await expect(projectsApi.pinProject("p 1", "remote /?")).resolves.toEqual(pinned);

    const [pinUrl, pinInit] = fetchCall(pinFetch, 0);
    expect(pinUrl).toBe("https://pi.example.test/api/machines/remote%20%2F%3F/projects/p%201/pin");
    expect(pinInit?.method).toBe("POST");

    const unpinned = [{ id: "p 1", name: "Repo", path: "/repo", createdAt: "2026-08-06T00:00:00.000Z" }];
    const unpinFetch = stubJsonFetch(unpinned);

    await expect(projectsApi.unpinProject("p 1", "remote /?")).resolves.toEqual(unpinned);

    const [unpinUrl, unpinInit] = fetchCall(unpinFetch, 0);
    expect(unpinUrl).toBe("https://pi.example.test/api/machines/remote%20%2F%3F/projects/p%201/unpin");
    expect(unpinInit?.method).toBe("POST");
  });
});
```

The file already defines the `stubJsonFetch` and `fetchCall` helpers and imports `projectsApi`. The `beforeEach` already stubs `document.baseURI` to `https://pi.example.test/`.

- [ ] **Step 2: Write the failing controller tests**

Append to `src/client/src/controllers/projectController.test.ts`, inside the existing `describe("ProjectController", ...)` block:

```ts
  it("replaces the project list with the order returned by pinning", async () => {
    const alpha = project("alpha", "/alpha");
    const beta = project("beta", "/beta");
    let state: AppState = { ...initialAppState(), projects: [alpha, beta] };
    const pinProject = vi.fn().mockResolvedValue([{ ...beta, pinned: true }, alpha]);
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      { api: { projects: vi.fn(), addProject: vi.fn(), closeProject: vi.fn(), pinProject, unpinProject: vi.fn() } },
    );

    await controller.pinProject(beta.id);

    expect(pinProject).toHaveBeenCalledWith(beta.id, "local");
    expect(state.projects).toEqual([{ ...beta, pinned: true }, alpha]);
  });

  it("replaces the project list with the order returned by unpinning", async () => {
    const alpha = project("alpha", "/alpha");
    const beta = { ...project("beta", "/beta"), pinned: true };
    let state: AppState = { ...initialAppState(), projects: [beta, alpha] };
    const unpinProject = vi.fn().mockResolvedValue([project("beta", "/beta"), alpha]);
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      { api: { projects: vi.fn(), addProject: vi.fn(), closeProject: vi.fn(), pinProject: vi.fn(), unpinProject } },
    );

    await controller.unpinProject(beta.id);

    expect(unpinProject).toHaveBeenCalledWith(beta.id, "local");
    expect(state.projects).toEqual([project("beta", "/beta"), alpha]);
  });

  it("reports a failed pin through app state without changing the project list", async () => {
    const alpha = project("alpha", "/alpha");
    let state: AppState = { ...initialAppState(), projects: [alpha] };
    const controller = new ProjectController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { selectProject: vi.fn(), forgetProject: vi.fn(), clearSelection: vi.fn() },
      {
        api: {
          projects: vi.fn(),
          addProject: vi.fn(),
          closeProject: vi.fn(),
          pinProject: vi.fn().mockRejectedValue(new Error("Project not found")),
          unpinProject: vi.fn(),
        },
      },
    );

    await controller.pinProject(alpha.id);

    expect(state.projects).toEqual([alpha]);
    expect(state.error).toContain("Project not found");
  });
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npm test -- --run src/client/src/controllers/projectController.test.ts src/client/src/api/clients.test.ts`
Expected: FAIL, `controller.pinProject is not a function` and `projectsApi.pinProject is not a function`.

- [ ] **Step 4: Parse the optional pinned flag**

In `src/client/src/api/parsers.ts`, replace the existing `parseProject`:

```ts
export function parseProject(value: unknown): Project {
  const record = requireRecord(value);
  return { id: requireString(record, "id"), name: requireString(record, "name"), path: requireString(record, "path"), createdAt: requireString(record, "createdAt") };
}
```

with:

```ts
export function parseProject(value: unknown): Project {
  const record = requireRecord(value);
  const pinned = parseOptionalBoolean(record["pinned"], "pinned");
  return {
    id: requireString(record, "id"),
    name: requireString(record, "name"),
    path: requireString(record, "path"),
    createdAt: requireString(record, "createdAt"),
    ...(pinned === undefined ? {} : { pinned }),
  };
}
```

`parseOptionalBoolean` already exists in this file and returns `boolean | undefined`, throwing when the value is neither a boolean nor `undefined`. If it is declared below `parseProject`, no change is needed; function declarations hoist.

- [ ] **Step 5: Add the API clients**

In `src/client/src/api/clients.ts`, the existing `projectsApi` starts:

```ts
export const projectsApi = {
  projects: (machineId = "local") => request(`${machinePrefix(machineId)}/projects`, arrayOf(parseProject)),
```

Add these two entries immediately after the existing `closeProject` entry, keeping the surrounding entries unchanged:

```ts
  pinProject: (projectId: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/pin`, arrayOf(parseProject), { method: "POST" }),
  unpinProject: (projectId: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/unpin`, arrayOf(parseProject), { method: "POST" }),
```

- [ ] **Step 6: Register the new calls in the federated route contract test**

In `src/client/src/api/federatedRouteContract.test.ts`, find the existing line:

```ts
      ignoreParseFailure(projectsApi.closeProject("p 1", machineId)),
```

and add the two new calls directly beneath it:

```ts
      ignoreParseFailure(projectsApi.closeProject("p 1", machineId)),
      ignoreParseFailure(projectsApi.pinProject("p 1", machineId)),
      ignoreParseFailure(projectsApi.unpinProject("p 1", machineId)),
```

- [ ] **Step 7: Add the controller methods**

In `src/client/src/controllers/projectController.ts`, widen both api types. The two existing declarations are:

```ts
  api?: Pick<typeof defaultApi, "projects" | "addProject" | "closeProject">;
```

and

```ts
  private readonly api: Pick<typeof defaultApi, "projects" | "addProject" | "closeProject">;
```

Change both occurrences to:

```ts
  api?: Pick<typeof defaultApi, "projects" | "addProject" | "closeProject" | "pinProject" | "unpinProject">;
```

and

```ts
  private readonly api: Pick<typeof defaultApi, "projects" | "addProject" | "closeProject" | "pinProject" | "unpinProject">;
```

Then add these methods after the existing `closeProject` method:

```ts
  async pinProject(projectId: string): Promise<void> {
    await this.applyPinChange(projectId, (machineId) => this.api.pinProject(projectId, machineId));
  }

  async unpinProject(projectId: string): Promise<void> {
    await this.applyPinChange(projectId, (machineId) => this.api.unpinProject(projectId, machineId));
  }

  /**
   * The server owns project order, so the whole returned list replaces state.
   * `onProjectsApplied` is deliberately not called: the project set is
   * unchanged, so activity ownership does not need to re-resolve.
   */
  private async applyPinChange(projectId: string, mutate: (machineId: string) => Promise<Project[]>): Promise<void> {
    const machineId = selectedMachineId(this.getState());
    try {
      const projects = await mutate(machineId);
      if (selectedMachineId(this.getState()) !== machineId) return;
      this.setState({ projects });
    } catch (error) {
      if (selectedMachineId(this.getState()) === machineId) this.setState({ error: String(error) });
    }
  }
```

Add the `Project` type import at the top of the file, next to the existing imports:

```ts
import type { Project } from "../api";
```

- [ ] **Step 8: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/controllers/projectController.test.ts src/client/src/api/clients.test.ts src/client/src/api/federatedRouteContract.test.ts`
Expected: PASS. Existing `projectController.test.ts` cases construct `api` objects without the two new keys; add `pinProject: vi.fn(), unpinProject: vi.fn()` to any that fail to typecheck.

- [ ] **Step 9: Commit**

```bash
git add src/client/src/api/parsers.ts src/client/src/api/clients.ts src/client/src/api/federatedRouteContract.test.ts src/client/src/controllers/projectController.ts src/client/src/controllers/projectController.test.ts
git commit -m "feat(projects): add pin and unpin project API and controller methods"
```

## Task 5: Add the pin control to the Projects sidebar

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/ProjectList.ts:13-110`
- Modify: `src/client/src/components/appShell/AppNavigationPanel.ts:76-78`
- Modify: `src/client/src/components/PiWebUiApp.ts:2136-2145`
- Test: `src/client/src/components/ProjectList.test.ts`

**Interfaces:**

- Consumes: `ProjectController.pinProject(projectId: string): Promise<void>` and `unpinProject(projectId: string): Promise<void>` from Task 4. `Project` with `pinned?: boolean` from Task 1. `displayedProjects` ordering from Task 3.
- Produces: `ProjectList` properties `onPin?: (project: Project) => void` and `onUnpin?: (project: Project) => void`. `AppNavigationPanel` properties `onPinProject?: (project: Project) => void | Promise<void>` and `onUnpinProject?: (project: Project) => void | Promise<void>`, forwarded to `project-list`.

- [ ] **Step 1: Write the failing tests**

Append to `src/client/src/components/ProjectList.test.ts`:

```ts
describe("project pin controls", () => {
  const pinnedProject: Project = { id: "client", name: "Client App", path: "/work/client-app", createdAt: "2026-08-06T00:00:00.000Z", pinned: true };

  it("renders a star that unpins a pinned project without selecting the row", () => {
    const list = new ProjectList();
    list.projects = [pinnedProject];
    const onUnpin = vi.fn();
    const onSelect = vi.fn();
    list.onUnpin = onUnpin;
    list.onSelect = onSelect;
    const event = new Event("click");
    const stopPropagation = vi.spyOn(event, "stopPropagation");

    templateEventHandlerNearMarker(list.render(), 'title="Click to unpin project"')(event);

    expect(onUnpin).toHaveBeenCalledWith(pinnedProject);
    expect(onSelect).not.toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("does not render a star for an unpinned project", () => {
    const list = new ProjectList();
    list.projects = [{ id: "server", name: "Server Console", path: "/work/server-console", createdAt: "2026-08-06T00:00:00.000Z" }];

    expect(templateText(list.render())).not.toContain("Click to unpin project");
  });

  it("offers Pin in the action menu for an unpinned project", () => {
    const list = new ProjectList();
    const unpinnedProject: Project = { id: "server", name: "Server Console", path: "/work/server-console", createdAt: "2026-08-06T00:00:00.000Z" };
    list.projects = [unpinnedProject];
    Reflect.set(list, "openMenuProjectId", unpinnedProject.id);
    const onPin = vi.fn();
    list.onPin = onPin;

    templateEventHandlerNearMarker(list.render(), 'title="Pin project to keep it at the top of the list"')(new Event("click"));

    expect(onPin).toHaveBeenCalledWith(unpinnedProject);
    expect(Reflect.get(list, "openMenuProjectId")).toBeUndefined();
  });

  it("offers Unpin in the action menu for a pinned project", () => {
    const list = new ProjectList();
    list.projects = [pinnedProject];
    Reflect.set(list, "openMenuProjectId", pinnedProject.id);
    const onUnpin = vi.fn();
    list.onUnpin = onUnpin;

    templateEventHandlerNearMarker(list.render(), 'title="Unpin project"')(new Event("click"));

    expect(onUnpin).toHaveBeenCalledWith(pinnedProject);
  });
});
```

The file already imports `templateEventHandlerNearMarker` and `templateText` from `../templateInspection.testSupport`, and `Project` from `../api`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/client/src/components/ProjectList.test.ts`
Expected: FAIL, the marker `title="Click to unpin project"` is not found in the rendered template.

- [ ] **Step 3: Add the pin properties and row star**

In `src/client/src/components/ProjectList.ts`, add two properties next to the existing `onClose` property:

```ts
  @property({ attribute: false }) onPin?: (project: Project) => void;
  @property({ attribute: false }) onUnpin?: (project: Project) => void;
```

In `render`, the row's name span is currently:

```ts
                  <span class="workspace-primary"><span class="workspace-primary-label">${project.name}</span></span><small>${project.path}</small>
```

Replace it with:

```ts
                  <span class="workspace-primary">${project.pinned === true ? html`<button class="pinned-star" type="button" title="Click to unpin project" aria-label=${`Unpin ${project.name}`} aria-pressed="true" @click=${(event: MouseEvent) => { event.stopPropagation(); this.onUnpin?.(project); }}>★</button> ` : null}<span class="workspace-primary-label">${project.name}</span></span><small>${project.path}</small>
```

- [ ] **Step 4: Add the menu entry**

In the same `render` method, the action menu panel currently contains:

```ts
                      ${this.statisticsAvailable ? html`<button title="Project statistics" @click=${() => { this.showStatistics(project); }}>Statistics</button>` : null}
                      <button title="Close project" @click=${() => { this.close(project); }}>Close</button>
```

Replace that pair with:

```ts
                      ${this.statisticsAvailable ? html`<button title="Project statistics" @click=${() => { this.showStatistics(project); }}>Statistics</button>` : null}
                      ${project.pinned === true
                        ? html`<button title="Unpin project" @click=${() => { this.openMenuProjectId = undefined; this.onUnpin?.(project); }}>Unpin</button>`
                        : html`<button title="Pin project to keep it at the top of the list" @click=${() => { this.openMenuProjectId = undefined; this.onPin?.(project); }}>Pin</button>`}
                      <button title="Close project" @click=${() => { this.close(project); }}>Close</button>
```

- [ ] **Step 5: Add the star styles**

In the `static override styles` array in `ProjectList.ts`, add these three rules inside the existing `css` block, matching the session star treatment in `SessionList.ts`:

```css
      .pinned-star { flex: 0 0 auto; border: 0; background: transparent; color: #d4a017; padding: 0; font: inherit; font-size: 14px; line-height: 1; cursor: pointer; }
      .pinned-star:hover { border-radius: 4px; background: var(--pi-surface); box-shadow: 0 0 0 1px var(--pi-border); transform: scale(1.25); }
      .pinned-star:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; border-radius: 2px; }
```

- [ ] **Step 6: Run the component tests and confirm they pass**

Run: `npm test -- --run src/client/src/components/ProjectList.test.ts`
Expected: PASS, including the 4 new tests.

- [ ] **Step 7: Wire the panel and app**

In `src/client/src/components/appShell/AppNavigationPanel.ts`, add two properties next to the existing `onCloseProject` property:

```ts
  @property({ attribute: false }) onPinProject?: (project: Project) => void | Promise<void>;
  @property({ attribute: false }) onUnpinProject?: (project: Project) => void | Promise<void>;
```

In the same file, the `<project-list>` template currently includes:

```ts
        .onClose=${(project: Project) => this.onCloseProject?.(project)}
```

Add the two forwards directly beneath it:

```ts
        .onClose=${(project: Project) => this.onCloseProject?.(project)}
        .onPin=${(project: Project) => this.onPinProject?.(project)}
        .onUnpin=${(project: Project) => this.onUnpinProject?.(project)}
```

In `src/client/src/components/PiWebUiApp.ts`, the navigation panel template currently includes:

```ts
        .onCloseProject=${(project: Project) => this.projects.closeProject(project.id)}
```

Add the two bindings directly beneath that line:

```ts
        .onCloseProject=${(project: Project) => this.projects.closeProject(project.id)}
        .onPinProject=${(project: Project) => this.projects.pinProject(project.id)}
        .onUnpinProject=${(project: Project) => this.projects.unpinProject(project.id)}
```

- [ ] **Step 8: Run the affected app-shell tests**

Run: `npm test -- --run src/client/src/components/appShell/AppNavigationPanel.test.ts src/client/src/components/ProjectList.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/client/src/components/ProjectList.ts src/client/src/components/ProjectList.test.ts src/client/src/components/appShell/AppNavigationPanel.ts src/client/src/components/PiWebUiApp.ts
git commit -m "feat(projects): add pin controls to the projects sidebar"
```

## Task 6: Add the pin control to the expanded project browser

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/ProjectBrowserDialog.ts:11-160`
- Modify: `src/client/src/components/PiWebUiApp.ts:4328-4342`
- Test: `src/client/src/components/ProjectBrowserDialog.test.ts`

**Interfaces:**

- Consumes: `ProjectController.pinProject(projectId: string): Promise<void>` and `unpinProject(projectId: string): Promise<void>` from Task 4. `Project` with `pinned?: boolean` from Task 1.
- Produces: `ProjectBrowserDialog` properties `onPinProject?: (project: Project) => void | Promise<void>` and `onUnpinProject?: (project: Project) => void | Promise<void>`. Every row renders a star toggle: `★` with `aria-pressed="true"` when pinned, `☆` with `aria-pressed="false"` when not.

- [ ] **Step 1: Write the failing tests**

Append to `src/client/src/components/ProjectBrowserDialog.test.ts`:

```ts
describe("project browser pin controls", () => {
  const pinned: Project = { id: "client", name: "Client App", path: "/work/client-app", createdAt: "2026-08-06T00:00:00.000Z", pinned: true };
  const unpinned: Project = { id: "server", name: "Server Console", path: "/work/server-console", createdAt: "2026-08-06T00:00:00.000Z" };

  it("pins an unpinned project from its row star without selecting the row", () => {
    const dialog = new ProjectBrowserDialog();
    dialog.projects = [unpinned];
    const onPinProject = vi.fn();
    const onSelect = vi.fn();
    dialog.onPinProject = onPinProject;
    dialog.onSelect = onSelect;
    const event = new Event("click");
    const stopPropagation = vi.spyOn(event, "stopPropagation");

    templateEventHandlerNearMarker(dialog.render(), `aria-label="Pin ${unpinned.name}"`)(event);

    expect(onPinProject).toHaveBeenCalledWith(unpinned);
    expect(onSelect).not.toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("unpins a pinned project from its row star", () => {
    const dialog = new ProjectBrowserDialog();
    dialog.projects = [pinned];
    const onUnpinProject = vi.fn();
    dialog.onUnpinProject = onUnpinProject;

    templateEventHandlerNearMarker(dialog.render(), `aria-label="Unpin ${pinned.name}"`)(new Event("click"));

    expect(onUnpinProject).toHaveBeenCalledWith(pinned);
  });

  it("offers Pin and Unpin in the row action menu", () => {
    const pinDialog = new ProjectBrowserDialog();
    pinDialog.projects = [unpinned];
    Reflect.set(pinDialog, "openMenuProjectId", unpinned.id);
    const onPinProject = vi.fn();
    pinDialog.onPinProject = onPinProject;

    templateEventHandlerNearMarker(pinDialog.render(), 'title="Pin project to keep it at the top of the list"')(new Event("click"));

    expect(onPinProject).toHaveBeenCalledWith(unpinned);
    expect(Reflect.get(pinDialog, "openMenuProjectId")).toBeUndefined();

    const unpinDialog = new ProjectBrowserDialog();
    unpinDialog.projects = [pinned];
    Reflect.set(unpinDialog, "openMenuProjectId", pinned.id);
    const onUnpinProject = vi.fn();
    unpinDialog.onUnpinProject = onUnpinProject;

    templateEventHandlerNearMarker(unpinDialog.render(), 'title="Unpin project"')(new Event("click"));

    expect(onUnpinProject).toHaveBeenCalledWith(pinned);
  });
});
```

If `templateEventHandlerNearMarker`, `vi`, or `Project` are not already imported in this file, add them: `templateEventHandlerNearMarker` from `../templateInspection.testSupport`, `vi` from `vitest`, and `type Project` from `../api`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/client/src/components/ProjectBrowserDialog.test.ts`
Expected: FAIL, the `aria-label="Pin Server Console"` marker is not found.

- [ ] **Step 3: Add the properties and row star**

In `src/client/src/components/ProjectBrowserDialog.ts`, add two properties next to the existing `onCloseProject` property:

```ts
  @property({ attribute: false }) onPinProject?: (project: Project) => void | Promise<void>;
  @property({ attribute: false }) onUnpinProject?: (project: Project) => void | Promise<void>;
```

In `renderResults`, the row's main block is currently:

```ts
            <div class="project-main">
              <span class="project-name">${project.name}</span>
```

Replace those two lines with:

```ts
            <div class="project-main">
              <span class="project-name">${this.renderPinToggle(project)}${project.name}</span>
```

Add the toggle renderer as a private method, next to `renderActivity`:

```ts
  private renderPinToggle(project: Project): TemplateResult {
    const isPinned = project.pinned === true;
    const label = `${isPinned ? "Unpin" : "Pin"} ${project.name}`;
    return html`<button
      class=${`pin-toggle ${isPinned ? "pinned" : ""}`}
      type="button"
      title=${isPinned ? "Click to unpin project" : "Click to pin project"}
      aria-label=${label}
      aria-pressed=${String(isPinned)}
      @click=${(event: MouseEvent) => {
        event.stopPropagation();
        void (isPinned ? this.onUnpinProject?.(project) : this.onPinProject?.(project));
      }}
    >${isPinned ? "★" : "☆"}</button> `;
  }
```

- [ ] **Step 4: Add the menu entry**

In `renderResults`, the action menu panel currently contains:

```ts
                  ${this.statisticsAvailable ? html`<button type="button" title="Project statistics" @click=${() => { this.showStatistics(project); }}>Statistics</button>` : null}
                  <button type="button" title="Close project" @click=${() => { this.closeProject(project); }}>Close</button>
```

Replace that pair with:

```ts
                  ${this.statisticsAvailable ? html`<button type="button" title="Project statistics" @click=${() => { this.showStatistics(project); }}>Statistics</button>` : null}
                  ${project.pinned === true
                    ? html`<button type="button" title="Unpin project" @click=${() => { this.openMenuProjectId = undefined; void this.onUnpinProject?.(project); }}>Unpin</button>`
                    : html`<button type="button" title="Pin project to keep it at the top of the list" @click=${() => { this.openMenuProjectId = undefined; void this.onPinProject?.(project); }}>Pin</button>`}
                  <button type="button" title="Close project" @click=${() => { this.closeProject(project); }}>Close</button>
```

- [ ] **Step 5: Add the toggle styles**

In the `static override styles` block of `ProjectBrowserDialog.ts`, add:

```css
    .pin-toggle { flex: 0 0 auto; border: 0; background: transparent; color: var(--pi-muted); padding: 0; font: inherit; font-size: 14px; line-height: 1; cursor: pointer; }
    .pin-toggle.pinned { color: #d4a017; }
    .pin-toggle:hover { border-radius: 4px; background: var(--pi-surface); box-shadow: 0 0 0 1px var(--pi-border); transform: scale(1.25); }
    .pin-toggle:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; border-radius: 2px; }
```

- [ ] **Step 6: Wire the dialog in the app**

In `src/client/src/components/PiWebUiApp.ts`, the `<project-browser-dialog>` template includes:

```ts
          .onCloseProject=${(project: Project) => this.projects.closeProject(project.id)}
```

Add the two bindings directly beneath it:

```ts
          .onCloseProject=${(project: Project) => this.projects.closeProject(project.id)}
          .onPinProject=${(project: Project) => this.projects.pinProject(project.id)}
          .onUnpinProject=${(project: Project) => this.projects.unpinProject(project.id)}
```

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/components/ProjectBrowserDialog.test.ts src/client/src/components/ProjectBrowserDialog.statistics.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/client/src/components/ProjectBrowserDialog.ts src/client/src/components/ProjectBrowserDialog.test.ts src/client/src/components/PiWebUiApp.ts
git commit -m "feat(projects): add pin controls to the expanded project browser"
```

## Task 7: Add a session pin toggle to the expanded session browser

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/SessionBrowserDialog.ts:13-125`
- Modify: `src/client/src/components/PiWebUiApp.ts:4353-4363`
- Test: `src/client/src/components/SessionBrowserDialog.test.ts`

**Interfaces:**

- Consumes: existing `SessionController.pinSession(session?: SessionInfo): Promise<void>` and `unpinSession(session?: SessionInfo): Promise<void>`, already wired in `PiWebUiApp` as `this.sessions.pinSession(session)`. `SessionInfo.pinned?: boolean` already exists. This task adds no server or controller code.
- Produces: `SessionBrowserDialog` properties `onPinSession?: (session: SessionInfo) => void | Promise<void>` and `onUnpinSession?: (session: SessionInfo) => void | Promise<void>`. Every row renders a star toggle: `★` with `aria-pressed="true"` when pinned, `☆` when not.

- [ ] **Step 1: Write the failing tests**

Append to `src/client/src/components/SessionBrowserDialog.test.ts`:

```ts
describe("session browser pin controls", () => {
  it("pins an unpinned session from its row star without selecting the row", () => {
    const dialog = new SessionBrowserDialog();
    const target = session("plain");
    dialog.sessions = [target];
    const onPinSession = vi.fn();
    const onSelect = vi.fn();
    dialog.onPinSession = onPinSession;
    dialog.onSelect = onSelect;
    const event = new Event("click");
    const stopPropagation = vi.spyOn(event, "stopPropagation");

    templateEventHandlerNearMarker(dialog.render(), 'title="Click to pin session"')(event);

    expect(onPinSession).toHaveBeenCalledWith(target);
    expect(onSelect).not.toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("unpins a pinned session from its row star", () => {
    const dialog = new SessionBrowserDialog();
    const target = session("starred", { pinned: true });
    dialog.sessions = [target];
    const onUnpinSession = vi.fn();
    dialog.onUnpinSession = onUnpinSession;

    templateEventHandlerNearMarker(dialog.render(), 'title="Click to unpin session"')(new Event("click"));

    expect(onUnpinSession).toHaveBeenCalledWith(target);
  });
});
```

The file already defines the fixture factory `session(id, patch)` at the top, which spreads `patch` over the required `SessionInfo` fields, so `session("starred", { pinned: true })` works without changes. Add `templateEventHandlerNearMarker` to the existing import from `../templateInspection.testSupport`; `vi` and `SessionInfo` are already imported.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/client/src/components/SessionBrowserDialog.test.ts`
Expected: FAIL, the `title="Click to pin session"` marker is not found.

- [ ] **Step 3: Add the properties and the row toggle**

In `src/client/src/components/SessionBrowserDialog.ts`, add two properties next to the existing `onSelect` property:

```ts
  @property({ attribute: false }) onPinSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onUnpinSession?: (session: SessionInfo) => void | Promise<void>;
```

In `renderSession`, the name line is currently:

```ts
          <span class="action-name-line">${this.renderSessionGroupToggle(row)}<span class="action-name" dir="auto">${row.depth > 0 ? html`<span class="tree-marker">↳</span>` : null}${sessionLabel(session)}
```

Insert the toggle immediately before `${sessionLabel(session)}`, so the line reads:

```ts
          <span class="action-name-line">${this.renderSessionGroupToggle(row)}<span class="action-name" dir="auto">${row.depth > 0 ? html`<span class="tree-marker">↳</span>` : null}${this.renderPinToggle(session)}${sessionLabel(session)}
```

Leave the rest of that line, including the depth badge and missing-parent badge, unchanged.

Add the renderer as a private method next to `renderSessionGroupToggle`:

```ts
  private renderPinToggle(session: SessionInfo): TemplateResult {
    const isPinned = session.pinned === true;
    return html`<button
      class=${`pin-toggle ${isPinned ? "pinned" : ""}`}
      type="button"
      title=${isPinned ? "Click to unpin session" : "Click to pin session"}
      aria-label=${`${isPinned ? "Unpin" : "Pin"} ${sessionLabel(session)}`}
      aria-pressed=${String(isPinned)}
      @click=${(event: MouseEvent) => {
        event.stopPropagation();
        void (isPinned ? this.onUnpinSession?.(session) : this.onPinSession?.(session));
      }}
    >${isPinned ? "★" : "☆"}</button> `;
  }
```

- [ ] **Step 4: Add the toggle styles**

In the `static override styles` block of `SessionBrowserDialog.ts`, add:

```css
    .pin-toggle { flex: 0 0 auto; border: 0; background: transparent; color: var(--pi-muted); padding: 0; font: inherit; font-size: 14px; line-height: 1; cursor: pointer; }
    .pin-toggle.pinned { color: #d4a017; }
    .pin-toggle:hover { border-radius: 4px; background: var(--pi-surface); box-shadow: 0 0 0 1px var(--pi-border); transform: scale(1.25); }
    .pin-toggle:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; border-radius: 2px; }
```

- [ ] **Step 5: Wire the dialog in the app**

In `src/client/src/components/PiWebUiApp.ts`, the `<session-browser-dialog>` template includes:

```ts
          .onSelect=${(session: SessionInfo) => { this.selectSessionFromBrowser(session); }}
```

Add the two bindings directly beneath it:

```ts
          .onSelect=${(session: SessionInfo) => { this.selectSessionFromBrowser(session); }}
          .onPinSession=${(session: SessionInfo) => this.sessions.pinSession(session)}
          .onUnpinSession=${(session: SessionInfo) => this.sessions.unpinSession(session)}
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/components/SessionBrowserDialog.test.ts`
Expected: PASS, including the 2 new tests.

- [ ] **Step 7: Commit**

```bash
git add src/client/src/components/SessionBrowserDialog.ts src/client/src/components/SessionBrowserDialog.test.ts src/client/src/components/PiWebUiApp.ts
git commit -m "feat(sessions): add a pin toggle to the expanded session browser"
```

## Task 8: Document, add the changeset, and verify the whole feature

**Implementer tier:** Standard

**Files:**

- Create: `.changeset/project-pinning.md`
- Modify: `docs/` page covering the navigation sidebar, if one exists
- Test: whole suite via `npm run verify`

**Interfaces:**

- Consumes: everything from Tasks 1 through 7. Pin state is `Project.pinned?: boolean` in `projects.json`; routes are `POST /api/projects/:projectId/pin` and `.../unpin` returning `Project[]`; ordering is pinned+running, pinned+idle, unpinned+running, unpinned+idle from `displayedProjects`; controls are a star plus an action-menu item in `ProjectList` and `ProjectBrowserDialog`, and a star toggle in `SessionBrowserDialog`.
- Produces: a `patch` changeset and passing whole-suite verification. No source behavior changes.

- [ ] **Step 1: Write the changeset**

Create `.changeset/project-pinning.md`:

```md
---
"@hyperdreamer/pi-webui": patch
---

Pin projects to keep them at the top of the Projects list. Pinned projects sort above unpinned ones, and projects with running sessions or terminals stay first within each group. Pin and unpin from the star on a project row or from the row's actions menu, in both the sidebar and the expanded project browser. The expanded session browser also gained the pin toggle it was missing.
```

- [ ] **Step 2: Check whether user-facing docs mention the projects list**

Run: `rg -l -i "projects section|projects list|sidebar" docs/`

If a page documents the navigation sidebar's Projects section, add two or three sentences there describing pin, unpin, and the resulting order. Per `.agents/skills/documentation-guide/SKILL.md`, detail belongs under `docs/` and not in `README.md`; do not add a README section for this. If no such page exists, skip this step rather than creating a new page.

- [ ] **Step 3: Verify the whole suite**

Run: `npm run verify`
Expected: PASS for typecheck, lint, Knip, and all tests. Fix any failure before continuing; do not commit a red verify.

- [ ] **Step 4: Manually confirm the persisted shape**

Run: `rg -n "pinned" ~/.pi-webui/projects.json || echo "no pinned projects yet"`

This is a read-only sanity check that the running instance's file is unaffected until a user pins something. Do not edit that file.

- [ ] **Step 5: Commit**

```bash
git add .changeset/project-pinning.md docs
git commit -m "docs(projects): document project pinning and add changeset"
```
