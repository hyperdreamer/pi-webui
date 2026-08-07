# Project directory hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show registered project directories as an expandable parent/child hierarchy in both project views, and add a close-with-subprojects action that removes a project family in one atomic registry write.

**Architecture:** A pure directory-ancestry rule in `src/shared/` is the single source of truth for "which project is whose parent", consumed by both the client tree projection and the server subtree-close operation. The client projection extends the existing `projectListProjection` boundary with depth, `hasChildren`, and fold state; `ProjectList` and `ProjectBrowserDialog` each own ephemeral expansion state and render family frames. The server adds one `POST /projects/:projectId/close-tree` route that computes descendants from its own registry snapshot inside the existing exclusive queue.

**Tech Stack:** TypeScript, Lit 3, Vitest, Fastify.

## Global Constraints

- The governing design is `docs/superpowers/specs/2026-08-07-project-directory-hierarchy-design.md`. Where this plan and that spec disagree, stop and report rather than choosing.
- No new runtime dependencies.
- Import Node built-ins with the `node:` prefix. Server files under `src/server/` use `.js` extensions in relative imports; client files under `src/client/` do not.
- Path comparison is case-sensitive, matching the existing `projectOwnsWorkspacePath` in `src/client/src/workspaceActivity.ts`. Do not add case folding.
- Visual indentation is capped at two levels, matching Sessions. Logical depth is never capped.
- Do not edit `CHANGELOG.md`. Release notes come from a Changeset.
- Do not bind fold toggling to arrow keys. `ArrowLeft`/`ArrowRight` already move between sidebar sections and `ArrowUp`/`ArrowDown`/`Home`/`End` move row focus, via `handleSelectableRowKeyboard` in `src/client/src/components/selectableRow.ts`.
- Every task's requirements implicitly include this section.

## Task 1: Shared directory-ancestry rule

**Implementer tier:** Standard

**Files:**

- Create: `src/shared/projectAncestry.ts`
- Test: `src/shared/projectAncestry.test.ts`

**Interfaces:**

- Consumes: nothing; this is the first task.
- Produces: `isDirectoryAncestor(parentPath: string, childPath: string): boolean`, true only when `parentPath` is a strict directory ancestor of `childPath`; and `projectDescendantIds(projects: readonly ProjectPathRef[], targetId: string): string[]` returning descendant IDs at any depth, where `ProjectPathRef = { id: string; path: string }`.

- [ ] **Step 1: Write the failing ancestry test**

Create `src/shared/projectAncestry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isDirectoryAncestor } from "./projectAncestry";

describe("isDirectoryAncestor", () => {
  it.each([
    ["direct parent", "/work", "/work/app", true],
    ["nested descendant", "/a", "/a/b/c", true],
    ["sibling", "/work/app", "/work/other", false],
    ["prefix that is not a directory boundary", "/work/app", "/work/application", false],
    ["prefix without separator", "/work", "/workspace", false],
    ["equal paths", "/work/app", "/work/app", false],
    ["trailing separator on parent", "/work/", "/work/app", true],
    ["trailing separator on child", "/work", "/work/app/", true],
    ["child equal to parent after normalization", "/work/", "/work", false],
    ["windows separators", "C:\\work", "C:\\work\\app", true],
    ["posix filesystem root", "/", "/work", true],
    ["windows drive root", "C:\\", "C:\\work", true],
    ["drive-relative path is not a child", "C:", "C:work", false],
    ["relative child under root", "/", "work", false],
    ["case sensitivity", "/Work", "/work/app", false],
  ])("%s", (_label, parentPath, childPath, expected) => {
    expect(isDirectoryAncestor(parentPath, childPath)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/shared/projectAncestry.test.ts`
Expected: FAIL, `Cannot find module './projectAncestry'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/shared/projectAncestry.ts`. Normalizing a bare root to the empty string is what lets the boundary check work without a special case for `/` or `C:\`:

```ts
export interface ProjectPathRef {
  id: string;
  path: string;
}

function isSeparator(character: string | undefined): boolean {
  return character === "/" || character === "\\";
}

/**
 * Strip one trailing separator so `/work/` and `/work` compare equal. A bare
 * root normalizes to `""`, which makes the separator-boundary check below work
 * for `/work` and `C:\work` without special-casing roots.
 */
function normalizeForComparison(path: string): string {
  if (path.length > 0 && isSeparator(path.at(-1))) return path.slice(0, -1);
  return path;
}

/** True when `parentPath` is a strict directory ancestor of `childPath`. Case-sensitive by design. */
export function isDirectoryAncestor(parentPath: string, childPath: string): boolean {
  const parent = normalizeForComparison(parentPath);
  const child = normalizeForComparison(childPath);
  if (parent === child) return false;
  if (!child.startsWith(parent)) return false;
  return isSeparator(child[parent.length]);
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/shared/projectAncestry.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Write the failing descendant test**

Append to `src/shared/projectAncestry.test.ts`:

```ts
import { projectDescendantIds } from "./projectAncestry";

describe("projectDescendantIds", () => {
  const projects = [
    { id: "root", path: "/work" },
    { id: "child-one", path: "/work/app1" },
    { id: "child-two", path: "/work/app2" },
    { id: "grandchild", path: "/work/app1/nested" },
    { id: "unrelated", path: "/other" },
    { id: "near-miss", path: "/workspace" },
  ];

  it("returns descendants at every depth", () => {
    expect(new Set(projectDescendantIds(projects, "root"))).toEqual(
      new Set(["child-one", "child-two", "grandchild"]),
    );
  });

  it("excludes the target itself", () => {
    expect(projectDescendantIds(projects, "root")).not.toContain("root");
  });

  it("excludes unrelated projects and directory-boundary near misses", () => {
    const descendants = projectDescendantIds(projects, "root");
    expect(descendants).not.toContain("unrelated");
    expect(descendants).not.toContain("near-miss");
  });

  it("returns an empty array for a leaf", () => {
    expect(projectDescendantIds(projects, "grandchild")).toEqual([]);
  });

  it("returns an empty array for an unknown target", () => {
    expect(projectDescendantIds(projects, "missing")).toEqual([]);
  });

  it("does not mutate the input", () => {
    const snapshot = structuredClone(projects);
    projectDescendantIds(projects, "root");
    expect(projects).toEqual(snapshot);
  });
});
```

- [ ] **Step 6: Run the test and confirm it fails**

Run: `npm test -- --run src/shared/projectAncestry.test.ts`
Expected: FAIL, `projectDescendantIds` is not exported.

- [ ] **Step 7: Implement projectDescendantIds**

Append to `src/shared/projectAncestry.ts`:

```ts
/**
 * Every descendant of `targetId` at any depth. Ancestry is transitive, so a
 * single pass over strict ancestors finds deep descendants without walking a
 * parent map.
 */
export function projectDescendantIds(
  projects: readonly ProjectPathRef[],
  targetId: string,
): string[] {
  const target = projects.find((project) => project.id === targetId);
  if (target === undefined) return [];
  return projects
    .filter((project) => project.id !== targetId && isDirectoryAncestor(target.path, project.path))
    .map((project) => project.id);
}
```

- [ ] **Step 8: Run the test and confirm it passes**

Run: `npm test -- --run src/shared/projectAncestry.test.ts`
Expected: PASS, 21 tests.

- [ ] **Step 9: Commit**

```bash
git add src/shared/projectAncestry.ts src/shared/projectAncestry.test.ts
git commit -m "feat(shared): add project directory-ancestry helpers"
```

## Task 2: Hierarchical tree-row projection

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/projectListProjection.ts:1-42`
- Test: `src/client/src/components/projectListProjection.test.ts`

**Interfaces:**

- Consumes: `isDirectoryAncestor(parentPath: string, childPath: string): boolean` from Task 1. From the file being modified: `filterProjects(projects: readonly Project[], queryText: string): Project[]` and `displayedProjects(projects: readonly Project[], queryText: string, workspacesByProjectId: Record<string, Workspace[]>, activities: Record<string, WorkspaceActivity>): Project[]`. `Project` and `WorkspaceActivity` come from `../api`; `Workspace` comes from `../api`.
- Produces: `projectTreeRows(projects: readonly Project[], options?: ProjectTreeOptions): ProjectTreeRow[]`, where `ProjectTreeRow = { project: Project; depth: number; hasChildren: boolean; folded: boolean }` and `ProjectTreeOptions = { queryText?: string; selectedProjectId?: string; expandedProjectIds?: ReadonlySet<string>; workspacesByProjectId?: Record<string, Workspace[]>; activities?: Record<string, WorkspaceActivity> }`. Also produces `projectSubtreeIds(projects: readonly Project[], targetId: string): string[]`, the target plus its descendants.

**Behavioral note the tests below pin:** forcing a selected project's ancestors open reveals each opened ancestor's full child group, exactly as Sessions does. Selecting `grandchild` therefore yields `root`, `child-one`, `grandchild`, `child-two` — not only the ancestor chain.

- [ ] **Step 1: Write the failing structure and ordering tests**

Append to `src/client/src/components/projectListProjection.test.ts`:

```ts
import { projectTreeRows } from "./projectListProjection";

const familyProjects: Project[] = [
  { id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" },
  { id: "child-one", name: "Child One", path: "/work/app1", createdAt: "2026-08-07T00:00:00.000Z" },
  { id: "child-two", name: "Child Two", path: "/work/app2", createdAt: "2026-08-07T00:00:00.000Z" },
  { id: "grandchild", name: "Grandchild", path: "/work/app1/nested", createdAt: "2026-08-07T00:00:00.000Z" },
];

const rowIds = (rows: readonly { project: Project }[]): string[] => rows.map((row) => row.project.id);

describe("projectTreeRows structure", () => {
  it("shows only family roots when nothing is expanded", () => {
    expect(rowIds(projectTreeRows(familyProjects))).toEqual(["root"]);
  });

  it("reveals direct children when a root is expanded", () => {
    const rows = projectTreeRows(familyProjects, { expandedProjectIds: new Set(["root"]) });
    expect(rowIds(rows)).toEqual(["root", "child-one", "child-two"]);
  });

  it("emits descendants in pre-order when a nested branch is expanded", () => {
    const rows = projectTreeRows(familyProjects, { expandedProjectIds: new Set(["root", "child-one"]) });
    expect(rowIds(rows)).toEqual(["root", "child-one", "grandchild", "child-two"]);
  });

  it("assigns depth from the nearest registered ancestor", () => {
    const rows = projectTreeRows(familyProjects, { expandedProjectIds: new Set(["root", "child-one"]) });
    expect(rows.map((row) => [row.project.id, row.depth])).toEqual([
      ["root", 0],
      ["child-one", 1],
      ["grandchild", 2],
      ["child-two", 1],
    ]);
  });

  it("reports hasChildren from the full catalog even while folded", () => {
    const [rootRow] = projectTreeRows(familyProjects);
    expect(rootRow?.hasChildren).toBe(true);
    expect(rootRow?.folded).toBe(true);
  });

  it("reports a leaf as neither parent nor folded", () => {
    const rows = projectTreeRows(familyProjects, { expandedProjectIds: new Set(["root", "child-one"]) });
    const leaf = rows.find((row) => row.project.id === "grandchild");
    expect(leaf?.hasChildren).toBe(false);
    expect(leaf?.folded).toBe(false);
  });

  it("reparents descendants onto the nearest remaining ancestor", () => {
    const gapped: Project[] = [
      { id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" },
      { id: "deep", name: "Deep", path: "/work/a/b/c", createdAt: "2026-08-07T00:00:00.000Z" },
    ];
    const rows = projectTreeRows(gapped, { expandedProjectIds: new Set(["root"]) });
    expect(rows.map((row) => [row.project.id, row.depth])).toEqual([["root", 0], ["deep", 1]]);
  });

  it("keeps directory-boundary near misses as separate roots", () => {
    const nearMiss: Project[] = [
      { id: "app", name: "App", path: "/work/app", createdAt: "2026-08-07T00:00:00.000Z" },
      { id: "application", name: "Application", path: "/work/application", createdAt: "2026-08-07T00:00:00.000Z" },
    ];
    const rows = projectTreeRows(nearMiss);
    expect(rows.every((row) => row.depth === 0)).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it("infers ancestry independently of catalog order", () => {
    const reversed = [...familyProjects].reverse();
    const rows = projectTreeRows(reversed, { expandedProjectIds: new Set(["root", "child-one"]) });
    expect(rows.find((row) => row.project.id === "grandchild")?.depth).toBe(2);
  });

  it("does not mutate its inputs", () => {
    const projectsSnapshot = structuredClone(familyProjects);
    const expandedProjectIds = new Set(["root"]);
    projectTreeRows(familyProjects, { expandedProjectIds });
    expect(familyProjects).toEqual(projectsSnapshot);
    expect([...expandedProjectIds]).toEqual(["root"]);
  });
});

describe("projectTreeRows ordering", () => {
  const siblings: Project[] = [
    { id: "parent", name: "Parent", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" },
    { id: "idle", name: "Idle", path: "/work/idle", createdAt: "2026-08-07T00:00:00.000Z" },
    { id: "active", name: "Active", path: "/work/active", createdAt: "2026-08-07T00:00:00.000Z" },
    { id: "pinned-child", name: "Pinned Child", path: "/work/pinned", createdAt: "2026-08-07T00:00:00.000Z", pinned: true },
  ];
  const activities: Record<string, WorkspaceActivity> = {
    "/work/active": { cwd: "/work/active", hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "2026-08-07T01:00:00.000Z" },
  };

  it("orders each sibling group pinned first, then active, then idle", () => {
    const rows = projectTreeRows(siblings, { expandedProjectIds: new Set(["parent"]), activities });
    expect(rowIds(rows)).toEqual(["parent", "pinned-child", "active", "idle"]);
  });

  it("keeps a pinned child under its parent instead of promoting it to a root", () => {
    const rows = projectTreeRows(siblings, { expandedProjectIds: new Set(["parent"]), activities });
    expect(rows.find((row) => row.project.id === "pinned-child")?.depth).toBe(1);
  });
});

describe("projectTreeRows selection and search", () => {
  it("reveals the selected project's ancestors and their sibling groups", () => {
    const rows = projectTreeRows(familyProjects, { selectedProjectId: "grandchild" });
    expect(rowIds(rows)).toEqual(["root", "child-one", "grandchild", "child-two"]);
  });

  it("does not force disclosure when the selected project is absent", () => {
    expect(rowIds(projectTreeRows(familyProjects, { selectedProjectId: "missing" }))).toEqual(["root"]);
  });

  it("shows a match with its ancestor chain during search", () => {
    expect(rowIds(projectTreeRows(familyProjects, { queryText: "nested" }))).toEqual([
      "root",
      "child-one",
      "grandchild",
    ]);
  });

  it("hides unrelated branches during search", () => {
    const rows = projectTreeRows(familyProjects, { queryText: "nested" });
    expect(rowIds(rows)).not.toContain("child-two");
  });

  it("suppresses folded state during search so no disclosure control renders", () => {
    const rows = projectTreeRows(familyProjects, { queryText: "nested" });
    expect(rows.every((row) => row.folded === false)).toBe(true);
  });

  it("still reports hasChildren during search", () => {
    const rows = projectTreeRows(familyProjects, { queryText: "nested" });
    expect(rows.find((row) => row.project.id === "root")?.hasChildren).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/client/src/components/projectListProjection.test.ts`
Expected: FAIL, `projectTreeRows` is not exported.

- [ ] **Step 3: Implement the projection**

Add to `src/client/src/components/projectListProjection.ts`. Keep the existing exports unchanged; the new code appends to the file, with the import added at the top:

```ts
import { isDirectoryAncestor } from "../../../shared/projectAncestry";

export interface ProjectTreeRow {
  project: Project;
  depth: number;
  hasChildren: boolean;
  folded: boolean;
}

export interface ProjectTreeOptions {
  queryText?: string;
  selectedProjectId?: string;
  expandedProjectIds?: ReadonlySet<string>;
  workspacesByProjectId?: Record<string, Workspace[]>;
  activities?: Record<string, WorkspaceActivity>;
}

interface ProjectHierarchy {
  parentIdByProjectId: Map<string, string>;
  childIdsByParentId: Map<string, string[]>;
}

/**
 * Nearest registered ancestor wins, so the longest matching ancestor path is
 * the parent. Strict ancestry guarantees a parent path is shorter than its
 * child's, so the relation cannot contain a cycle.
 */
function projectHierarchy(projects: readonly Project[]): ProjectHierarchy {
  const parentIdByProjectId = new Map<string, string>();
  const childIdsByParentId = new Map<string, string[]>();

  for (const project of projects) {
    let parent: Project | undefined;
    for (const candidate of projects) {
      if (candidate.id === project.id) continue;
      if (!isDirectoryAncestor(candidate.path, project.path)) continue;
      if (parent === undefined || candidate.path.length > parent.path.length) parent = candidate;
    }
    if (parent === undefined) continue;
    parentIdByProjectId.set(project.id, parent.id);
    childIdsByParentId.set(parent.id, [...(childIdsByParentId.get(parent.id) ?? []), project.id]);
  }

  return { parentIdByProjectId, childIdsByParentId };
}

function ancestorIds(projectId: string, parentIdByProjectId: ReadonlyMap<string, string>): string[] {
  const ancestors: string[] = [];
  const seen = new Set<string>([projectId]);
  let current = parentIdByProjectId.get(projectId);
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    ancestors.push(current);
    current = parentIdByProjectId.get(current);
  }
  return ancestors;
}

function depthByProjectId(
  projects: readonly Project[],
  parentIdByProjectId: ReadonlyMap<string, string>,
): Map<string, number> {
  const depths = new Map<string, number>();
  for (const project of projects) {
    depths.set(project.id, ancestorIds(project.id, parentIdByProjectId).length);
  }
  return depths;
}

/**
 * Visible rows under an active query: every match plus its registered
 * ancestors, so a nested match keeps its directory context. Fold state is
 * deliberately ignored here and left untouched by the caller.
 */
function searchVisibleIds(
  projects: readonly Project[],
  queryText: string,
  parentIdByProjectId: ReadonlyMap<string, string>,
): Set<string> {
  const visible = new Set<string>();
  for (const match of filterProjects(projects, queryText)) {
    visible.add(match.id);
    for (const ancestorId of ancestorIds(match.id, parentIdByProjectId)) visible.add(ancestorId);
  }
  return visible;
}

/**
 * Visible rows under normal fold state. Ancestors of the selected project are
 * treated as open for this projection only, which never writes back into the
 * caller's remembered expansion set.
 */
function foldVisibleIds(
  projects: readonly Project[],
  hierarchy: ProjectHierarchy,
  expandedProjectIds: ReadonlySet<string>,
  selectedProjectId: string | undefined,
): Set<string> {
  const forcedOpenIds = new Set(
    selectedProjectId === undefined
      ? []
      : ancestorIds(selectedProjectId, hierarchy.parentIdByProjectId),
  );

  const visible = new Set<string>();
  const visit = (projectId: string): void => {
    if (visible.has(projectId)) return;
    visible.add(projectId);
    if (!expandedProjectIds.has(projectId) && !forcedOpenIds.has(projectId)) return;
    for (const childId of hierarchy.childIdsByParentId.get(projectId) ?? []) visit(childId);
  };

  for (const project of projects) {
    if (hierarchy.parentIdByProjectId.has(project.id)) continue;
    visit(project.id);
  }
  return visible;
}

/**
 * Flatten the project catalog into pre-order display rows. Each sibling group
 * is ordered by the existing pinned/active/source rules, so directory
 * structure outranks pinning without changing how peers sort.
 */
export function projectTreeRows(
  projects: readonly Project[],
  options: ProjectTreeOptions = {},
): ProjectTreeRow[] {
  const {
    queryText = "",
    selectedProjectId,
    expandedProjectIds = new Set<string>(),
    workspacesByProjectId = {},
    activities = {},
  } = options;

  const hierarchy = projectHierarchy(projects);
  const searching = queryText.trim() !== "";
  const visibleIds = searching
    ? searchVisibleIds(projects, queryText, hierarchy.parentIdByProjectId)
    : foldVisibleIds(projects, hierarchy, expandedProjectIds, selectedProjectId);
  const depths = depthByProjectId(projects, hierarchy.parentIdByProjectId);
  const projectsById = new Map(projects.map((project) => [project.id, project]));

  const rows: ProjectTreeRow[] = [];
  const emitGroup = (group: readonly Project[]): void => {
    for (const project of displayedProjects(group, "", workspacesByProjectId, activities)) {
      if (!visibleIds.has(project.id)) continue;
      const childIds = hierarchy.childIdsByParentId.get(project.id) ?? [];
      const hasChildren = childIds.length > 0;
      const visibleChildren = childIds
        .map((childId) => projectsById.get(childId))
        .filter((child): child is Project => child !== undefined && visibleIds.has(child.id));
      rows.push({
        project,
        depth: depths.get(project.id) ?? 0,
        hasChildren,
        folded: !searching && hasChildren && visibleChildren.length === 0,
      });
      if (visibleChildren.length > 0) emitGroup(visibleChildren);
    }
  };

  emitGroup(projects.filter((project) => !hierarchy.parentIdByProjectId.has(project.id)));
  return rows;
}

/** The target plus every descendant, for confirmation counts and close-with-subprojects. */
export function projectSubtreeIds(projects: readonly Project[], targetId: string): string[] {
  const target = projects.find((project) => project.id === targetId);
  if (target === undefined) return [];
  return [
    target.id,
    ...projects
      .filter((project) => project.id !== targetId && isDirectoryAncestor(target.path, project.path))
      .map((project) => project.id),
  ];
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/components/projectListProjection.test.ts`
Expected: PASS, including every pre-existing flat-projection test.

- [ ] **Step 5: Add the subtree-id test**

Append to `src/client/src/components/projectListProjection.test.ts`:

```ts
import { projectSubtreeIds } from "./projectListProjection";

describe("projectSubtreeIds", () => {
  it("includes the target and every descendant", () => {
    expect(new Set(projectSubtreeIds(familyProjects, "root"))).toEqual(
      new Set(["root", "child-one", "child-two", "grandchild"]),
    );
  });

  it("returns only the target for a leaf", () => {
    expect(projectSubtreeIds(familyProjects, "grandchild")).toEqual(["grandchild"]);
  });

  it("returns an empty array for an unknown target", () => {
    expect(projectSubtreeIds(familyProjects, "missing")).toEqual([]);
  });
});
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/components/projectListProjection.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/client/src/components/projectListProjection.ts src/client/src/components/projectListProjection.test.ts
git commit -m "feat(projects): project hierarchy tree-row projection"
```
