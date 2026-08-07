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

- Consumes: `isDirectoryAncestor(parentPath: string, childPath: string): boolean` and `projectDescendantIds(projects: readonly ProjectPathRef[], targetId: string): string[]` from Task 1, where `ProjectPathRef = { id: string; path: string }`. `Project` structurally satisfies `ProjectPathRef`. From the file being modified: `filterProjects(projects: readonly Project[], queryText: string): Project[]` and `displayedProjects(projects: readonly Project[], queryText: string, workspacesByProjectId: Record<string, Workspace[]>, activities: Record<string, WorkspaceActivity>): Project[]`. `Project` and `WorkspaceActivity` come from `../api`; `Workspace` comes from `../api`.
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
import { isDirectoryAncestor, projectDescendantIds } from "../../../shared/projectAncestry";

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

/** The target plus every descendant, for confirmation counts and close-with-subprojects. Delegates to the shared rule so the client count and the server removal set cannot diverge. */
export function projectSubtreeIds(projects: readonly Project[], targetId: string): string[] {
  if (!projects.some((project) => project.id === targetId)) return [];
  return [targetId, ...projectDescendantIds(projects, targetId)];
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

## Task 3: Render the hierarchy in the sidebar

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/ProjectList.ts:1-243`
- Test: `src/client/src/components/ProjectList.hierarchy.test.ts`

**Interfaces:**

- Consumes: `projectTreeRows(projects: readonly Project[], options?: ProjectTreeOptions): ProjectTreeRow[]` from Task 2, where `ProjectTreeRow = { project: Project; depth: number; hasChildren: boolean; folded: boolean }` and `ProjectTreeOptions = { queryText?: string; selectedProjectId?: string; expandedProjectIds?: ReadonlySet<string>; workspacesByProjectId?: Record<string, Workspace[]>; activities?: Record<string, WorkspaceActivity> }`. Existing in this file: `shouldCloseProjectMenuForOrderChange(projectId: string, previousProjects: readonly Project[], currentProjects: readonly Project[]): boolean`, and the private method `renderProjectRow(project: Project)`.
- Produces: `ProjectList` rendering family frames and disclosure controls. `renderProjectRow(row: ProjectTreeRow)` replaces the `Project` parameter. Exports `visibleProjectsFromRows(rows: readonly ProjectTreeRow[]): Project[]` so the menu-order check compares projected rows.

**Reference markup, copied from `SessionList`.** Match these class names exactly so the shared styles in `listStyles` apply: the frame is `<div class="session-family-frame">`, the row carries `style=${`--depth:${String(cappedDepth)}`}`, the disclosure button is `class="session-group-toggle"` rendering `▸` when folded and `▾` when open, and a descendant name is prefixed with `<span class="tree-marker">↳</span>`. `--depth` drives padding through `.action-main` in `src/client/src/components/shared.ts`, so depth must be capped at 2 before it reaches the style attribute.

- [ ] **Step 1: Write the failing hierarchy tests**

Create `src/client/src/components/ProjectList.hierarchy.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { TemplateResult } from "lit";
import type { Project } from "../api";
import { templateEventHandlerNearMarker, templateText } from "../templateInspection.testSupport";
import { ProjectList } from "./ProjectList";
import { projectTreeRows, type ProjectTreeRow } from "./projectListProjection";

const family: Project[] = [
  { id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" },
  { id: "child", name: "Child", path: "/work/app1", createdAt: "2026-08-07T00:00:00.000Z" },
  { id: "standalone", name: "Standalone", path: "/elsewhere", createdAt: "2026-08-07T00:00:00.000Z" },
];

/**
 * Project rows render inside the `repeat` directive, so the shared
 * TemplateResult helpers cannot reach them through render(). This follows the
 * existing per-row seam already used by ProjectList.test.ts.
 */
type RenderProjectRow = (this: ProjectList, row: ProjectTreeRow) => TemplateResult;

function renderRow(list: ProjectList, row: ProjectTreeRow): TemplateResult {
  const method: unknown = Reflect.get(list, "renderProjectRow");
  if (typeof method !== "function") throw new Error("ProjectList.renderProjectRow is not callable");
  return (method as RenderProjectRow).call(list, row);
}

function rowFor(projects: Project[], id: string, expanded: string[] = []): ProjectTreeRow {
  const rows = projectTreeRows(projects, { expandedProjectIds: new Set(expanded) });
  const row = rows.find((candidate) => candidate.project.id === id);
  if (row === undefined) throw new Error(`No visible row for ${id}`);
  return row;
}

describe("project list hierarchy rendering", () => {
  it("renders a disclosure control that reports collapsed state for a parent", () => {
    const list = new ProjectList();
    list.projects = family;
    const rendered = templateText(renderRow(list, rowFor(family, "root")));

    expect(rendered).toContain('aria-label="Expand Root"');
    expect(rendered).toContain('aria-expanded="false"');
  });

  it("reports expanded state once the family is open", () => {
    const list = new ProjectList();
    list.projects = family;
    const rendered = templateText(renderRow(list, rowFor(family, "root", ["root"])));

    expect(rendered).toContain('aria-label="Collapse Root"');
    expect(rendered).toContain('aria-expanded="true"');
  });

  it("does not render a disclosure control for a project without children", () => {
    const list = new ProjectList();
    list.projects = family;
    const rendered = templateText(renderRow(list, rowFor(family, "standalone")));

    expect(rendered).not.toContain("session-group-toggle");
  });

  it("expands a family without selecting the project", () => {
    const list = new ProjectList();
    list.projects = family;
    const onSelect = vi.fn();
    list.onSelect = onSelect;
    const event = new Event("click");
    const stopPropagation = vi.spyOn(event, "stopPropagation");

    templateEventHandlerNearMarker(renderRow(list, rowFor(family, "root")), 'aria-label="Expand Root"')(event);

    expect(onSelect).not.toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(templateText(list.render())).toContain("Child");
  });

  it("collapses an open family back to its root", () => {
    const list = new ProjectList();
    list.projects = family;
    Reflect.set(list, "expandedProjectIds", new Set(["root"]));

    templateEventHandlerNearMarker(renderRow(list, rowFor(family, "root", ["root"])), 'aria-label="Collapse Root"')(new Event("click"));

    expect(templateText(list.render())).not.toContain("/work/app1");
  });

  it("marks a descendant row with the tree marker and capped depth", () => {
    const list = new ProjectList();
    list.projects = family;
    const rendered = templateText(renderRow(list, rowFor(family, "child", ["root"])));

    expect(rendered).toContain("↳");
    expect(rendered).toContain("--depth:1");
  });

  it("caps visual indentation at two levels", () => {
    const deep: Project[] = [
      { id: "a", name: "A", path: "/a", createdAt: "2026-08-07T00:00:00.000Z" },
      { id: "b", name: "B", path: "/a/b", createdAt: "2026-08-07T00:00:00.000Z" },
      { id: "c", name: "C", path: "/a/b/c", createdAt: "2026-08-07T00:00:00.000Z" },
      { id: "d", name: "D", path: "/a/b/c/d", createdAt: "2026-08-07T00:00:00.000Z" },
    ];
    const list = new ProjectList();
    list.projects = deep;
    const rendered = templateText(renderRow(list, rowFor(deep, "d", ["a", "b", "c"])));

    expect(rendered).toContain("--depth:2");
  });

  it("frames a family root and leaves a standalone project unframed", () => {
    const list = new ProjectList();
    list.projects = family;

    const rendered = templateText(list.render());
    expect(rendered).toContain("session-family-frame");
    expect(rendered).toContain("Standalone");
  });

  it("keeps the heading count at the registered project total while folded", () => {
    const list = new ProjectList();
    list.collapsible = true;
    list.projects = family;

    expect(templateText(list.render())).toContain(">3<");
  });

  it("prunes expansion state for projects that disappear", async () => {
    const list = new ProjectList();
    list.projects = family;
    Reflect.set(list, "expandedProjectIds", new Set(["root"]));

    list.projects = [{ id: "standalone", name: "Standalone", path: "/elsewhere", createdAt: "2026-08-07T00:00:00.000Z" }];
    await list.updateComplete;

    expect([...(Reflect.get(list, "expandedProjectIds") as Set<string>)]).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/client/src/components/ProjectList.hierarchy.test.ts`
Expected: FAIL. `renderProjectRow` still takes a `Project`, so `row.project.id` is undefined and no disclosure control exists.

- [ ] **Step 3: Switch the render path to tree rows**

In `src/client/src/components/ProjectList.ts`, add the state field beside the existing `@state()` declarations:

```ts
  @state() private expandedProjectIds: ReadonlySet<string> = new Set();
```

Replace the `render()` body's project list with grouped rows. `visibleRows` is the single projection both `render()` and `updated()` read:

```ts
  private get visibleRows(): ProjectTreeRow[] {
    return projectTreeRows(this.projects, {
      queryText: this.searchQuery,
      ...(this.selected === undefined ? {} : { selectedProjectId: this.selected.id }),
      expandedProjectIds: this.expandedProjectIds,
      workspacesByProjectId: this.workspacesByProjectId,
      activities: this.activities,
    });
  }

  /** Group consecutive rows into depth-zero families so each root gets one frame. */
  private groupRows(rows: readonly ProjectTreeRow[]): ProjectTreeRow[][] {
    return rows.reduce<ProjectTreeRow[][]>((groups, row) => {
      if (row.depth === 0) groups.push([row]);
      else groups.at(-1)?.push(row);
      return groups;
    }, []);
  }
```

Then render the groups, framing any group whose root owns children:

```ts
  override render() {
    const rows = this.visibleRows;
    return html`
      <section>
        <h2>
          ${this.renderHeading()}
          ${this.renderExpandedBrowserButton()}
          ${this.collapsed ? null : this.renderSearchButton()}
          ${this.renderAddButton()}
        </h2>
        ${this.collapsed ? null : html`
          ${this.searchOpen ? this.renderSearchInput() : null}
          <div class="list-body">
            ${repeat(
              this.groupRows(rows),
              (group) => group[0]?.project.id ?? "",
              (group) => group[0]?.hasChildren === true
                ? html`<div class="session-family-frame">${group.map((row) => this.renderProjectRow(row))}</div>`
                : html`${group.map((row) => this.renderProjectRow(row))}`,
            )}
            ${rows.length === 0 && this.searchQuery.trim() !== "" ? html`<p class="project-search-empty">No matching projects.</p>` : null}
          </div>
        `}
      </section>
    `;
  }
```

- [ ] **Step 4: Take the row through ProjectTreeRow and add the disclosure control**

Change `renderProjectRow` to accept a row, capping depth for the style attribute and prefixing descendants with the tree marker. Keep the existing pinned star, activity, and action menu wiring intact:

```ts
  private renderProjectRow(row: ProjectTreeRow) {
    const project = row.project;
    const cappedDepth = Math.min(row.depth, 2);
    return html`
      <div
        class=${`action-row ${this.selected?.id === project.id ? "selected" : ""}`}
        style=${`--depth:${String(cappedDepth)}`}
        tabindex="0"
        title=${project.path}
        @click=${(event: MouseEvent) => { activateSelectableRow(event, () => this.onSelect?.(project)); }}
        @keydown=${(event: KeyboardEvent) => { this.handleProjectKeydown(event, project); }}
      >
        <div class="action-main">
          <span class="workspace-primary">${this.renderGroupToggle(row)}${row.depth > 0 ? html`<span class="tree-marker">↳</span>` : null}${project.pinned === true ? html`<button class="pinned-star" type="button" title="Click to unpin project" aria-label=${`Unpin ${project.name}`} aria-pressed="true" @click=${(event: MouseEvent) => { event.stopPropagation(); this.onUnpin?.(project); }}>★</button> ` : null}<span class="workspace-primary-label">${project.name}</span></span><small>${project.path}</small>
          ${this.renderActivity(project)}
        </div>
        <div class="action-menu">
          <button class="action-menu-toggle" title="Project actions" aria-label=${`Actions for ${project.name}`} @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(project.id, event.currentTarget); }}>⋯</button>
          ${this.openMenuProjectId === project.id ? html`
            <div class="action-menu-panel" style=${this.menuStyle}>
              ${this.statisticsAvailable ? html`<button title="Project statistics" @click=${() => { this.showStatistics(project); }}>Statistics</button>` : null}
              ${project.pinned === true
                ? html`<button title="Unpin project" @click=${() => { this.openMenuProjectId = undefined; this.onUnpin?.(project); }}>Unpin</button>`
                : html`<button title="Pin project to keep it at the top of the list" @click=${() => { this.openMenuProjectId = undefined; this.onPin?.(project); }}>Pin</button>`}
              <button title="Close project" @click=${() => { this.close(project); }}>Close</button>
            </div>
          ` : null}
        </div>
      </div>
    `;
  }

  /** Hidden while searching, because search decides visibility rather than fold state. */
  private renderGroupToggle(row: ProjectTreeRow) {
    if (!row.hasChildren || this.searchQuery.trim() !== "") return null;
    const action = row.folded ? "Expand" : "Collapse";
    return html`<button class="session-group-toggle" type="button" title=${`${action} ${row.project.name}`} aria-label=${`${action} ${row.project.name}`} aria-expanded=${String(!row.folded)} @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleProjectGroup(row.project.id, row.folded); }}>${row.folded ? "▸" : "▾"}</button>`;
  }

  private toggleProjectGroup(projectId: string, folded: boolean): void {
    const next = new Set(this.expandedProjectIds);
    if (folded) next.add(projectId);
    else next.delete(projectId);
    this.expandedProjectIds = next;
  }
```

- [ ] **Step 5: Reconcile expansion and menu state against projected rows**

Replace the body of `updated()` so the stale-menu check compares visible rows, and prune expansion IDs for projects that no longer exist:

```ts
  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("projects")) {
      const existingIds = new Set(this.projects.map((project) => project.id));
      const prunedExpansion = new Set([...this.expandedProjectIds].filter((id) => existingIds.has(id)));
      if (prunedExpansion.size !== this.expandedProjectIds.size) this.expandedProjectIds = prunedExpansion;
      if (this.openMenuProjectId !== undefined && !existingIds.has(this.openMenuProjectId)) this.openMenuProjectId = undefined;
    }
    if (this.openMenuProjectId !== undefined && (changed.has("projects") || changed.has("activities") || changed.has("workspacesByProjectId"))) {
      const previousProjects = changed.get("projects") ?? this.projects;
      const previousWorkspacesByProjectId = changed.get("workspacesByProjectId") ?? this.workspacesByProjectId;
      const previousActivities = changed.get("activities") ?? this.activities;
      const previousRows = projectTreeRows(previousProjects, {
        queryText: this.searchQuery,
        ...(this.selected === undefined ? {} : { selectedProjectId: this.selected.id }),
        expandedProjectIds: this.expandedProjectIds,
        workspacesByProjectId: previousWorkspacesByProjectId,
        activities: previousActivities,
      });
      if (shouldCloseProjectMenuForOrderChange(
        this.openMenuProjectId,
        visibleProjectsFromRows(previousRows),
        visibleProjectsFromRows(this.visibleRows),
      )) this.openMenuProjectId = undefined;
    }
    if (changed.has("collapsed") && this.collapsed) this.openMenuProjectId = undefined;
  }
```

Add the exported helper beside `shouldCloseProjectMenuForOrderChange` at the end of the file, and import `projectTreeRows` and `ProjectTreeRow` from `./projectListProjection`:

```ts
/** Projected rows reduced to projects, so menu-order checks account for folds and reparenting. */
export function visibleProjectsFromRows(rows: readonly ProjectTreeRow[]): Project[] {
  return rows.map((row) => row.project);
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/components/ProjectList.hierarchy.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 7: Run the existing ProjectList suites and repair call-site drift**

Run: `npm test -- --run src/client/src/components/ProjectList.test.ts src/client/src/components/ProjectList.statistics.test.ts src/client/src/components/actionMenuDismissal.test.ts`
Expected: PASS. Both existing suites call the private `renderProjectRow` with a bare `Project`; update those helpers to pass `{ project, depth: 0, hasChildren: false, folded: false }` so they match the new parameter. Do not change what those tests assert.

- [ ] **Step 8: Typecheck and lint**

Run: `npm run typecheck && npx eslint src/client/src/components/ProjectList.ts src/client/src/components/ProjectList.hierarchy.test.ts`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/client/src/components/ProjectList.ts src/client/src/components/ProjectList.hierarchy.test.ts src/client/src/components/ProjectList.test.ts src/client/src/components/ProjectList.statistics.test.ts src/client/src/components/actionMenuDismissal.test.ts
git commit -m "feat(projects): render project hierarchy in the sidebar"
```

## Task 4: Render the hierarchy in the expanded browser

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/ProjectBrowserDialog.ts:1-323`
- Test: `src/client/src/components/ProjectBrowserDialog.hierarchy.test.ts`

**Interfaces:**

- Consumes: `projectTreeRows(projects: readonly Project[], options?: ProjectTreeOptions): ProjectTreeRow[]` and `ProjectTreeRow = { project: Project; depth: number; hasChildren: boolean; folded: boolean }` from Task 2. `visibleProjectsFromRows(rows: readonly ProjectTreeRow[]): Project[]` from Task 3. Existing in this file: the private getter `visibleProjects`, the private method `renderResults()`, and the module function `visibleProjectOrderChanged(previousProjects: readonly Project[], currentProjects: readonly Project[]): boolean`.
- Produces: `ProjectBrowserDialog` rendering the same hierarchy with its own independent expansion state. No new exports.

**Independence requirement:** this component's expansion state must not be shared with `ProjectList`. Each holds its own `@state()` set, so opening a family in the sidebar leaves the dialog collapsed and vice versa. A test below pins this.

- [ ] **Step 1: Write the failing hierarchy tests**

Create `src/client/src/components/ProjectBrowserDialog.hierarchy.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../api";
import { templateEventHandlerNearMarker, templateText } from "../templateInspection.testSupport";
import { ProjectList } from "./ProjectList";
import { ProjectBrowserDialog } from "./ProjectBrowserDialog";

const family: Project[] = [
  { id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" },
  { id: "child", name: "Child", path: "/work/app1", createdAt: "2026-08-07T00:00:00.000Z" },
  { id: "standalone", name: "Standalone", path: "/elsewhere", createdAt: "2026-08-07T00:00:00.000Z" },
];

function dialogWith(projects: Project[]): ProjectBrowserDialog {
  const dialog = new ProjectBrowserDialog();
  dialog.projects = projects;
  return dialog;
}

describe("expanded project browser hierarchy", () => {
  it("hides descendants until the family is expanded", () => {
    const rendered = templateText(dialogWith(family).render());

    expect(rendered).toContain("Root");
    expect(rendered).not.toContain("/work/app1");
  });

  it("renders a disclosure control for a parent", () => {
    const rendered = templateText(dialogWith(family).render());

    expect(rendered).toContain('aria-label="Expand Root"');
    expect(rendered).toContain('aria-expanded="false"');
  });

  it("expands a family without selecting the project", () => {
    const dialog = dialogWith(family);
    const onSelect = vi.fn();
    dialog.onSelect = onSelect;
    const event = new Event("click");
    const stopPropagation = vi.spyOn(event, "stopPropagation");

    templateEventHandlerNearMarker(dialog.render(), 'aria-label="Expand Root"')(event);

    expect(onSelect).not.toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(templateText(dialog.render())).toContain("/work/app1");
  });

  it("collapses an expanded family", () => {
    const dialog = dialogWith(family);
    Reflect.set(dialog, "expandedProjectIds", new Set(["root"]));

    templateEventHandlerNearMarker(dialog.render(), 'aria-label="Collapse Root"')(new Event("click"));

    expect(templateText(dialog.render())).not.toContain("/work/app1");
  });

  it("frames a family root", () => {
    expect(templateText(dialogWith(family).render())).toContain("session-family-frame");
  });

  it("marks descendants with the tree marker", () => {
    const dialog = dialogWith(family);
    Reflect.set(dialog, "expandedProjectIds", new Set(["root"]));

    expect(templateText(dialog.render())).toContain("↳");
  });

  it("shows a nested match with its ancestors during search and hides disclosure controls", () => {
    const dialog = dialogWith(family);
    Reflect.set(dialog, "searchQuery", "app1");

    const rendered = templateText(dialog.render());
    expect(rendered).toContain("/work/app1");
    expect(rendered).not.toContain("Standalone");
    expect(rendered).not.toContain("session-group-toggle");
  });

  it("keeps ancestor rows shown for context fully interactive", () => {
    const dialog = dialogWith(family);
    Reflect.set(dialog, "searchQuery", "app1");
    const onSelect = vi.fn();
    dialog.onSelect = onSelect;

    const rendered = templateText(dialog.render());
    expect(rendered).toContain('aria-label="Actions for Root"');
  });

  it("reports no matches from visible rows rather than the flat count", () => {
    const dialog = dialogWith(family);
    Reflect.set(dialog, "searchQuery", "nothing-matches-this");

    expect(templateText(dialog.render())).toContain("No matching projects.");
  });

  it("keeps its expansion state independent from the sidebar", () => {
    const dialog = dialogWith(family);
    const list = new ProjectList();
    list.projects = family;
    Reflect.set(list, "expandedProjectIds", new Set(["root"]));

    expect([...(Reflect.get(dialog, "expandedProjectIds") as Set<string>)]).toEqual([]);
    expect(templateText(dialog.render())).not.toContain("/work/app1");
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/client/src/components/ProjectBrowserDialog.hierarchy.test.ts`
Expected: FAIL. The dialog still renders a flat list with no disclosure control.

- [ ] **Step 3: Add expansion state and swap the projection**

In `src/client/src/components/ProjectBrowserDialog.ts`, add the state field beside the existing `@state()` declarations and import `projectTreeRows`, `type ProjectTreeRow`, plus `visibleProjectsFromRows` from `./ProjectList`:

```ts
  @state() private expandedProjectIds: ReadonlySet<string> = new Set();
```

Replace the `visibleProjects` getter with a row-based one, keeping the name `visibleProjects` for the existing `updated()` comparison and adding `visibleRows` for rendering:

```ts
  private get visibleRows(): ProjectTreeRow[] {
    return projectTreeRows(this.projects, {
      queryText: this.searchQuery,
      ...(this.selected === undefined ? {} : { selectedProjectId: this.selected.id }),
      expandedProjectIds: this.expandedProjectIds,
      workspacesByProjectId: this.workspacesByProjectId,
      activities: this.activities,
    });
  }

  private get visibleProjects(): Project[] {
    return visibleProjectsFromRows(this.visibleRows);
  }
```

In `updated()`, replace the `displayedProjects(...)` call used for the previous snapshot with the equivalent `projectTreeRows(...)` call reduced through `visibleProjectsFromRows`, so the stale-menu check compares projected rows:

```ts
    const previousRows = projectTreeRows(previousProjects, {
      queryText: this.searchQuery,
      ...(this.selected === undefined ? {} : { selectedProjectId: this.selected.id }),
      expandedProjectIds: this.expandedProjectIds,
      workspacesByProjectId: previousWorkspacesByProjectId,
      activities: previousActivities,
    });
    if (visibleProjectOrderChanged(visibleProjectsFromRows(previousRows), this.visibleProjects)) this.openMenuProjectId = undefined;
```

Also prune expansion IDs when projects disappear, inside the existing `changed.has("projects")` branch:

```ts
      const existingIds = new Set(this.projects.map((project) => project.id));
      const prunedExpansion = new Set([...this.expandedProjectIds].filter((id) => existingIds.has(id)));
      if (prunedExpansion.size !== this.expandedProjectIds.size) this.expandedProjectIds = prunedExpansion;
```

- [ ] **Step 4: Render grouped rows with disclosure controls**

Replace `renderResults()` so it groups depth-zero families and renders rows from `ProjectTreeRow`. The existing pin toggle, activity indicator, and action menu markup is preserved; only the row wrapper, the toggle, the tree marker, and `--depth` are new:

```ts
  private renderResults(): TemplateResult {
    if (this.projects.length === 0) {
      return html`
        <div class="empty-state">
          <p>No projects are open.</p>
          <button class="add-empty-button" type="button" @click=${() => { this.onAdd?.(); }}>Add project</button>
        </div>
      `;
    }

    const rows = this.visibleRows;
    if (rows.length === 0) return html`<p class="empty-state">No matching projects.</p>`;

    return html`
      <div class="project-list">
        ${repeat(
          this.groupRows(rows),
          (group) => group[0]?.project.id ?? "",
          (group) => group[0]?.hasChildren === true
            ? html`<div class="session-family-frame">${group.map((row) => this.renderProjectRow(row))}</div>`
            : html`${group.map((row) => this.renderProjectRow(row))}`,
        )}
      </div>
    `;
  }

  private groupRows(rows: readonly ProjectTreeRow[]): ProjectTreeRow[][] {
    return rows.reduce<ProjectTreeRow[][]>((groups, row) => {
      if (row.depth === 0) groups.push([row]);
      else groups.at(-1)?.push(row);
      return groups;
    }, []);
  }

  private renderProjectRow(row: ProjectTreeRow): TemplateResult {
    const project = row.project;
    const cappedDepth = Math.min(row.depth, 2);
    return html`
      <div
        class=${`project-row action-row ${this.selected?.id === project.id ? "selected" : ""}`}
        style=${`--depth:${String(cappedDepth)}`}
        tabindex="0"
        title=${project.path}
        @click=${(event: MouseEvent) => { activateSelectableRow(event, () => { this.select(project); }); }}
        @keydown=${(event: KeyboardEvent) => { this.handleProjectKeydown(event, project); }}
      >
        <div class="project-main">
          <span class="project-name">${this.renderGroupToggle(row)}${row.depth > 0 ? html`<span class="tree-marker">↳</span>` : null}${this.renderPinToggle(project)}${project.name}</span>
          <span class="project-path">${project.path}</span>
          ${this.renderActivity(project)}
        </div>
        <div class="action-menu">
          <button class="action-menu-toggle" type="button" title="Project actions" aria-label=${`Actions for ${project.name}`} @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(project.id, event.currentTarget); }}>
            <svg class="action-menu-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor"><circle cx="5" cy="12" r="1.5"></circle><circle cx="12" cy="12" r="1.5"></circle><circle cx="19" cy="12" r="1.5"></circle></svg>
          </button>
          ${this.openMenuProjectId === project.id ? html`
            <div class="action-menu-panel" style=${this.menuStyle}>
              ${this.statisticsAvailable ? html`<button type="button" title="Project statistics" @click=${() => { this.showStatistics(project); }}>Statistics</button>` : null}
              ${project.pinned === true
                ? html`<button type="button" title="Unpin project" @click=${() => { this.openMenuProjectId = undefined; void this.onUnpinProject?.(project); }}>Unpin</button>`
                : html`<button type="button" title="Pin project to keep it at the top of the list" @click=${() => { this.openMenuProjectId = undefined; void this.onPinProject?.(project); }}>Pin</button>`}
              <button type="button" title="Close project" @click=${() => { this.closeProject(project); }}>Close</button>
            </div>
          ` : null}
        </div>
      </div>
    `;
  }

  /** Hidden while searching, because search decides visibility rather than fold state. */
  private renderGroupToggle(row: ProjectTreeRow): TemplateResult | null {
    if (!row.hasChildren || this.searchQuery.trim() !== "") return null;
    const action = row.folded ? "Expand" : "Collapse";
    return html`<button class="session-group-toggle" type="button" title=${`${action} ${row.project.name}`} aria-label=${`${action} ${row.project.name}`} aria-expanded=${String(!row.folded)} @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleProjectGroup(row.project.id, row.folded); }}>${row.folded ? "▸" : "▾"}</button>`;
  }

  private toggleProjectGroup(projectId: string, folded: boolean): void {
    const next = new Set(this.expandedProjectIds);
    if (folded) next.add(projectId);
    else next.delete(projectId);
    this.expandedProjectIds = next;
  }
```

- [ ] **Step 5: Add the frame and toggle styles to this component**

This dialog does not import `SessionList`'s styles, so add the two selectors it now uses to its own `static override styles` block. Reuse the same token values as `SessionList` so the two surfaces match:

```css
    .session-family-frame { box-sizing: border-box; margin: 6px 0; border: 1px solid var(--pi-danger); border-radius: 10px; background: color-mix(in srgb, var(--pi-surface) 52%, transparent); padding: 5px 6px; }
    .session-family-frame > .action-row { margin: 4px 0; }
    .session-family-frame > .action-row:first-child { margin-top: 0; }
    .session-family-frame > .action-row:last-child { margin-bottom: 0; }
    .session-group-toggle { flex: 0 0 auto; display: inline-grid; place-items: center; width: 24px; min-width: 24px; height: 24px; margin: 0; border: 0; border-radius: 4px; background: transparent; color: var(--pi-muted); padding: 0; font: inherit; line-height: 1; cursor: pointer; }
    .session-group-toggle:hover { background: var(--pi-surface); box-shadow: 0 0 0 1px var(--pi-border); color: var(--pi-text); }
    .session-group-toggle:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    .tree-marker { color: var(--pi-dim); margin-right: 5px; }
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/components/ProjectBrowserDialog.hierarchy.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 7: Run the existing dialog suites and repair call-site drift**

Run: `npm test -- --run src/client/src/components/ProjectBrowserDialog.test.ts src/client/src/components/ProjectBrowserDialog.statistics.test.ts`
Expected: PASS. `ProjectBrowserDialog.statistics.test.ts` reaches the private `renderProjectRow`; pass `{ project, depth: 0, hasChildren: false, folded: false }`. `ProjectBrowserDialog.test.ts` inspects the results `repeat` directive; update its helper to read the grouped structure without changing its assertions.

- [ ] **Step 8: Typecheck and lint**

Run: `npm run typecheck && npx eslint src/client/src/components/ProjectBrowserDialog.ts src/client/src/components/ProjectBrowserDialog.hierarchy.test.ts`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/client/src/components/ProjectBrowserDialog.ts src/client/src/components/ProjectBrowserDialog.hierarchy.test.ts src/client/src/components/ProjectBrowserDialog.test.ts src/client/src/components/ProjectBrowserDialog.statistics.test.ts
git commit -m "feat(projects): render project hierarchy in the expanded browser"
```

## Task 5: Atomic subtree removal in the project store

**Implementer tier:** Standard

**Files:**

- Modify: `src/server/storage/projectStore.ts:118-183`
- Modify: `src/server/projects/projectService.ts:30-52`
- Test: `src/server/storage/projectStore.test.ts`
- Test: `src/server/projects/projectService.test.ts`

**Interfaces:**

- Consumes: `projectDescendantIds(projects: readonly ProjectPathRef[], targetId: string): string[]` from Task 1, where `ProjectPathRef = { id: string; path: string }`. Import it as `../../shared/projectAncestry.js` from server files. Existing in these files: `ProjectStore` with its private `read()`, `write(data)`, and `exclusive(operation)` members; `ProjectService` with `close(id)` and the private `setPinned`; and `ProjectNotFoundError`.
- Produces: `ProjectStore.removeTree(id: string): Promise<string[] | undefined>` returning the removed IDs, target first, or `undefined` when the target does not exist. `ProjectService.closeTree(id: string): Promise<{ closedProjectIds: string[] }>` throwing `ProjectNotFoundError` for an unknown target.

**Concurrency requirement:** read, descendant computation, and write must all happen inside one `this.exclusive(...)` callback. Computing descendants outside it would let a concurrent add or pin change the registry between snapshot and write, producing a lost update or a stale removal set.

- [ ] **Step 1: Write the failing store tests**

Append to `src/server/storage/projectStore.test.ts`, following the existing fixture style in that file for creating a temporary store:

```ts
describe("ProjectStore.removeTree", () => {
  it("removes the target and every descendant in one write", async () => {
    const store = await storeWithProjects([
      { name: "Root", path: "/work" },
      { name: "Child", path: "/work/app1" },
      { name: "Grandchild", path: "/work/app1/nested" },
      { name: "Unrelated", path: "/other" },
    ]);
    const projects = await store.list();
    const root = projects.find((project) => project.path === "/work");
    if (root === undefined) throw new Error("fixture missing root");

    const removed = await store.removeTree(root.id);

    expect(removed).toHaveLength(3);
    expect(removed?.[0]).toBe(root.id);
    expect((await store.list()).map((project) => project.path)).toEqual(["/other"]);
  });

  it("leaves directory-boundary near misses untouched", async () => {
    const store = await storeWithProjects([
      { name: "App", path: "/work/app" },
      { name: "Application", path: "/work/application" },
    ]);
    const projects = await store.list();
    const app = projects.find((project) => project.path === "/work/app");
    if (app === undefined) throw new Error("fixture missing app");

    await store.removeTree(app.id);

    expect((await store.list()).map((project) => project.path)).toEqual(["/work/application"]);
  });

  it("removes only the target when it has no descendants", async () => {
    const store = await storeWithProjects([
      { name: "Root", path: "/work" },
      { name: "Leaf", path: "/work/leaf" },
    ]);
    const projects = await store.list();
    const leaf = projects.find((project) => project.path === "/work/leaf");
    if (leaf === undefined) throw new Error("fixture missing leaf");

    expect(await store.removeTree(leaf.id)).toEqual([leaf.id]);
    expect((await store.list()).map((project) => project.path)).toEqual(["/work"]);
  });

  it("reports an unknown target distinctly from an empty removal", async () => {
    const store = await storeWithProjects([{ name: "Root", path: "/work" }]);

    expect(await store.removeTree("missing")).toBeUndefined();
    expect(await store.list()).toHaveLength(1);
  });
});
```

Add the fixture helper if the file does not already provide an equivalent:

```ts
async function storeWithProjects(inputs: readonly { name: string; path: string }[]): Promise<ProjectStore> {
  const store = new ProjectStore(join(await mkdtemp(join(tmpdir(), "pi-webui-projects-")), "projects.json"));
  for (const input of inputs) await store.add(input);
  return store;
}
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/server/storage/projectStore.test.ts`
Expected: FAIL, `store.removeTree is not a function`.

- [ ] **Step 3: Implement removeTree**

In `src/server/storage/projectStore.ts`, import the shared rule and add the method beside `remove`:

```ts
import { projectDescendantIds } from "../../shared/projectAncestry.js";
```

```ts
  /**
   * Remove a project together with every registered descendant in a single
   * write. The snapshot is read, the removal set computed, and the result
   * written inside one exclusive turn, so a concurrent add or pin cannot make
   * the removal set stale or lose an update.
   */
  async removeTree(id: string): Promise<string[] | undefined> {
    return await this.exclusive(async () => {
      const data = await this.read();
      if (!data.projects.some((project) => project.id === id)) return undefined;
      const removedIds = [id, ...projectDescendantIds(data.projects, id)];
      const removedIdSet = new Set(removedIds);
      await this.write({ projects: data.projects.filter((project) => !removedIdSet.has(project.id)) });
      return removedIds;
    });
  }
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- --run src/server/storage/projectStore.test.ts`
Expected: PASS, including the pre-existing store tests.

- [ ] **Step 5: Write the failing service test**

Append to `src/server/projects/projectService.test.ts`, matching that file's existing fake-store pattern:

```ts
describe("ProjectService.closeTree", () => {
  it("returns the closed project ids", async () => {
    const store = fakeStoreWith([
      { id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" },
      { id: "child", name: "Child", path: "/work/app1", createdAt: "2026-08-07T00:00:00.000Z" },
    ]);
    const service = new ProjectService(store);

    await expect(service.closeTree("root")).resolves.toEqual({ closedProjectIds: ["root", "child"] });
  });

  it("throws ProjectNotFoundError for an unknown target", async () => {
    const service = new ProjectService(fakeStoreWith([]));

    await expect(service.closeTree("missing")).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
```

- [ ] **Step 6: Run the test and confirm it fails**

Run: `npm test -- --run src/server/projects/projectService.test.ts`
Expected: FAIL, `service.closeTree is not a function`.

- [ ] **Step 7: Implement closeTree**

In `src/server/projects/projectService.ts`, add the method beside `close`:

```ts
  /** Close a project and its registered descendants. The store owns the removal set. */
  async closeTree(id: string): Promise<{ closedProjectIds: string[] }> {
    const closedProjectIds = await this.store.removeTree(id);
    if (closedProjectIds === undefined) throw new ProjectNotFoundError();
    return { closedProjectIds };
  }
```

The `ProjectStore` type this service consumes is structural, so add `removeTree` to whatever `Pick<...>` or interface the constructor parameter uses if it is not the full class.

- [ ] **Step 8: Run the test and confirm it passes**

Run: `npm test -- --run src/server/projects/projectService.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck and commit**

```bash
npm run typecheck
git add src/server/storage/projectStore.ts src/server/storage/projectStore.test.ts src/server/projects/projectService.ts src/server/projects/projectService.test.ts
git commit -m "feat(projects): atomic project subtree removal in the registry"
```

## Task 6: Expose the close-tree route

**Implementer tier:** Standard

**Files:**

- Modify: `src/server/app.ts:78-101`
- Modify: `src/shared/federatedRoutes.ts:45-52`
- Test: `src/server/app.projects.test.ts`
- Test: `src/client/src/api/federatedRouteContract.test.ts`

**Interfaces:**

- Consumes: `ProjectService.closeTree(id: string): Promise<{ closedProjectIds: string[] }>` from Task 5, throwing `ProjectNotFoundError` for an unknown target. Existing in `src/server/app.ts`: the `prefix` template variable, the `projects` service instance, and `sendProjectRouteError(reply, error)` which maps `ProjectNotFoundError` to 404 and everything else to 500.
- Produces: `POST {prefix}/projects/:projectId/close-tree` responding `{ closedProjectIds: string[] }`, and the same path registered in the federated route list.

- [ ] **Step 1: Write the failing route tests**

Append to `src/server/app.projects.test.ts`, following that file's existing app-build and injection helpers:

```ts
describe("POST /projects/:projectId/close-tree", () => {
  it("closes a project family and reports the closed ids", async () => {
    const app = await buildTestApp();
    const root = await addTestProject(app, "/work");
    await addTestProject(app, "/work/app1");
    await addTestProject(app, "/other");

    const response = await app.inject({ method: "POST", url: `/api/projects/${root.id}/close-tree` });

    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(body).toMatchObject({ closedProjectIds: expect.arrayContaining([root.id]) });

    const remaining = await app.inject({ method: "GET", url: "/api/projects" });
    expect(remaining.json()).toHaveLength(1);
  });

  it("answers 404 for an unknown project", async () => {
    const app = await buildTestApp();

    const response = await app.inject({ method: "POST", url: "/api/projects/missing/close-tree" });

    expect(response.statusCode).toBe(404);
  });
});
```

Use the file's existing helpers rather than new ones if it already provides equivalents for building the app and adding a project.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/server/app.projects.test.ts`
Expected: FAIL with 404 on the success case, because the route does not exist yet.

- [ ] **Step 3: Register the route**

In `src/server/app.ts`, add the route immediately after the existing `unpin` route so the project routes stay grouped:

```ts
  app.post<{ Params: { projectId: string } }>(`${prefix}/projects/:projectId/close-tree`, async (request, reply) => {
    try {
      return await projects.closeTree(request.params.projectId);
    } catch (error) {
      return sendProjectRouteError(reply, error);
    }
  });
```

- [ ] **Step 4: Add the federated route entry**

In `src/shared/federatedRoutes.ts`, add the path beside the other project mutations:

```ts
  { method: "POST", path: "/projects/:projectId/close-tree" },
```

- [ ] **Step 5: Run the route and contract tests**

Run: `npm test -- --run src/server/app.projects.test.ts src/client/src/api/federatedRouteContract.test.ts`
Expected: PASS. If the contract test enumerates client API methods against the route list, it will keep failing until Task 7 adds the client method; in that case note the expected failure and let Task 7 close it.

- [ ] **Step 6: Commit**

```bash
npm run typecheck
git add src/server/app.ts src/shared/federatedRoutes.ts src/server/app.projects.test.ts
git commit -m "feat(projects): add the project close-tree route"
```

## Task 7: Client API and controller for closing a family

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/api/parsers.ts:2199-2203`
- Modify: `src/client/src/api/clients.ts:308-314`
- Modify: `src/client/src/controllers/projectController.ts:1-30`
- Modify: `src/client/src/controllers/projectController.ts:74-87`
- Test: `src/client/src/api/clients.test.ts`
- Test: `src/client/src/controllers/projectController.test.ts`

**Interfaces:**

- Consumes: `POST {machinePrefix}/projects/:projectId/close-tree` responding `{ closedProjectIds: string[] }` from Task 6. Existing helpers in `parsers.ts`: `requireRecord(value)`, `requireString(record, key)`, and `arrayOf(parse)`. Existing in `clients.ts`: `machinePrefix(machineId)`, `request(path, parse, init?)`, and the `projectsApi` object spread into `api`. Existing in `projectController.ts`: `selectedMachineId(state)`, `this.workspaces.forgetProject(projectId)`, `this.workspaces.clearSelection()`, `this.onProjectsApplied?.(machineId)`, and `this.setState({ error: String(error) })`.
- Produces: `parseClosedProjectTree(value: unknown): { closedProjectIds: string[] }`; `projectsApi.closeProjectTree(projectId: string, machineId?: string): Promise<{ closedProjectIds: string[] }>`; and `ProjectController.closeProjectTree(projectId: string): Promise<void>`.

**Authoritative-response requirement:** the controller must reconcile against `closedProjectIds` from the response, not against a locally computed subtree. The catalog may have changed between render and confirmation, so the server's set is the only correct one.

- [ ] **Step 1: Write the failing parser and client tests**

Append to `src/client/src/api/clients.test.ts`, following the existing fetch-stub pattern in that file:

```ts
describe("closeProjectTree", () => {
  it("posts to the close-tree path and parses the closed ids", async () => {
    const fetchMock = stubFetchJson({ closedProjectIds: ["root", "child"] });

    await expect(projectsApi.closeProjectTree("root")).resolves.toEqual({ closedProjectIds: ["root", "child"] });
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/projects/root/close-tree");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("encodes the project id", async () => {
    const fetchMock = stubFetchJson({ closedProjectIds: ["a/b"] });

    await projectsApi.closeProjectTree("a/b");

    expect(fetchMock.mock.calls[0]?.[0]).toContain("/projects/a%2Fb/close-tree");
  });

  it("rejects a response without closedProjectIds", async () => {
    stubFetchJson({ closed: true });

    await expect(projectsApi.closeProjectTree("root")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/client/src/api/clients.test.ts`
Expected: FAIL, `projectsApi.closeProjectTree is not a function`.

- [ ] **Step 3: Add the parser and client method**

In `src/client/src/api/parsers.ts`, add beside `parseClosed`:

```ts
export function parseClosedProjectTree(value: unknown): { closedProjectIds: string[] } {
  const record = requireRecord(value);
  return { closedProjectIds: arrayOf(requireStringValue)(record["closedProjectIds"]) };
}
```

If the file has no bare-string array parser, add this small helper next to it rather than loosening `requireString`:

```ts
function requireStringValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string value");
  return value;
}
```

In `src/client/src/api/clients.ts`, add to `projectsApi` beside `closeProject`:

```ts
  closeProjectTree: (projectId: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/close-tree`, parseClosedProjectTree, { method: "POST" }),
```

Import `parseClosedProjectTree` alongside the other parsers already imported in that file.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/api/clients.test.ts src/client/src/api/federatedRouteContract.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing controller tests**

Append to `src/client/src/controllers/projectController.test.ts`, using that file's existing harness:

```ts
describe("closeProjectTree", () => {
  it("removes every closed project from the catalog", async () => {
    const harness = createHarness({
      projects: [
        { id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" },
        { id: "child", name: "Child", path: "/work/app1", createdAt: "2026-08-07T00:00:00.000Z" },
        { id: "other", name: "Other", path: "/other", createdAt: "2026-08-07T00:00:00.000Z" },
      ],
      api: { closeProjectTree: () => Promise.resolve({ closedProjectIds: ["root", "child"] }) },
    });

    await harness.controller.closeProjectTree("root");

    expect(harness.state().projects.map((project) => project.id)).toEqual(["other"]);
  });

  it("forgets workspace state for every closed project", async () => {
    const harness = createHarness({
      projects: [
        { id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" },
        { id: "child", name: "Child", path: "/work/app1", createdAt: "2026-08-07T00:00:00.000Z" },
      ],
      api: { closeProjectTree: () => Promise.resolve({ closedProjectIds: ["root", "child"] }) },
    });

    await harness.controller.closeProjectTree("root");

    expect(harness.forgottenProjectIds).toEqual(["root", "child"]);
  });

  it("clears the selection when the selected project was a closed descendant", async () => {
    const child = { id: "child", name: "Child", path: "/work/app1", createdAt: "2026-08-07T00:00:00.000Z" };
    const harness = createHarness({
      projects: [{ id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" }, child],
      selectedProject: child,
      api: { closeProjectTree: () => Promise.resolve({ closedProjectIds: ["root", "child"] }) },
    });

    await harness.controller.closeProjectTree("root");

    expect(harness.clearSelectionCalls).toBe(1);
  });

  it("keeps the selection when it was not closed", async () => {
    const other = { id: "other", name: "Other", path: "/other", createdAt: "2026-08-07T00:00:00.000Z" };
    const harness = createHarness({
      projects: [{ id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" }, other],
      selectedProject: other,
      api: { closeProjectTree: () => Promise.resolve({ closedProjectIds: ["root"] }) },
    });

    await harness.controller.closeProjectTree("root");

    expect(harness.clearSelectionCalls).toBe(0);
  });

  it("reconciles against the returned ids rather than a locally computed subtree", async () => {
    const harness = createHarness({
      projects: [
        { id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" },
        { id: "child", name: "Child", path: "/work/app1", createdAt: "2026-08-07T00:00:00.000Z" },
      ],
      api: { closeProjectTree: () => Promise.resolve({ closedProjectIds: ["root"] }) },
    });

    await harness.controller.closeProjectTree("root");

    expect(harness.state().projects.map((project) => project.id)).toEqual(["child"]);
  });

  it("surfaces a failure through the error state and leaves the catalog intact", async () => {
    const harness = createHarness({
      projects: [{ id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" }],
      api: { closeProjectTree: () => Promise.reject(new Error("boom")) },
    });

    await harness.controller.closeProjectTree("root");

    expect(harness.state().error).toContain("boom");
    expect(harness.state().projects).toHaveLength(1);
  });

  it("ignores a result that arrives after the machine changed", async () => {
    const harness = createHarness({
      projects: [{ id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" }],
      api: { closeProjectTree: () => Promise.resolve({ closedProjectIds: ["root"] }) },
      onBeforeResolve: () => { harness.switchMachine("other-machine"); },
    });

    await harness.controller.closeProjectTree("root");

    expect(harness.state().projects).toHaveLength(1);
  });
});
```

Extend the harness with `forgottenProjectIds`, `clearSelectionCalls`, `switchMachine`, and `onBeforeResolve` only if it does not already expose equivalents. Prefer the file's existing spies.

- [ ] **Step 6: Run the tests and confirm they fail**

Run: `npm test -- --run src/client/src/controllers/projectController.test.ts`
Expected: FAIL, `controller.closeProjectTree is not a function`.

- [ ] **Step 7: Implement the controller method**

In `src/client/src/controllers/projectController.ts`, widen both `Pick<...>` API types to include `closeProjectTree`, then add the method beside `closeProject`:

```ts
  /**
   * Close a project family. The response is authoritative: the catalog may have
   * changed since the confirmation dialog rendered, so reconcile against the
   * ids the server actually removed rather than a locally computed subtree.
   */
  async closeProjectTree(projectId: string): Promise<void> {
    const machineId = selectedMachineId(this.getState());
    try {
      const { closedProjectIds } = await this.api.closeProjectTree(projectId, machineId);
      if (selectedMachineId(this.getState()) !== machineId) return;
      for (const closedProjectId of closedProjectIds) this.workspaces.forgetProject(closedProjectId);
      const state = this.getState();
      const closedIdSet = new Set(closedProjectIds);
      this.setState({ projects: state.projects.filter((project) => !closedIdSet.has(project.id)) });
      this.onProjectsApplied?.(machineId);
      if (state.selectedProject !== undefined && closedIdSet.has(state.selectedProject.id)) this.workspaces.clearSelection();
    } catch (error) {
      if (selectedMachineId(this.getState()) === machineId) this.setState({ error: String(error) });
    }
  }
```

- [ ] **Step 8: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/controllers/projectController.test.ts`
Expected: PASS, including the pre-existing controller tests.

- [ ] **Step 9: Typecheck, lint, and commit**

```bash
npm run typecheck
npx eslint src/client/src/api/clients.ts src/client/src/api/parsers.ts src/client/src/controllers/projectController.ts
git add src/client/src/api/parsers.ts src/client/src/api/clients.ts src/client/src/api/clients.test.ts src/client/src/controllers/projectController.ts src/client/src/controllers/projectController.test.ts
git commit -m "feat(projects): add close-project-tree API and controller"
```

## Task 8: Wire the close-with-subprojects menu entry

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/ProjectList.ts:1-243`
- Modify: `src/client/src/components/ProjectBrowserDialog.ts:1-323`
- Modify: `src/client/src/components/appShell/AppNavigationPanel.ts:1-60`
- Modify: `src/client/src/components/PiWebUiApp.ts:2157-2159`
- Modify: `src/client/src/components/PiWebUiApp.ts:4383-4385`
- Create: `.changeset/project-directory-hierarchy.md`
- Test: `src/client/src/components/ProjectList.hierarchy.test.ts`
- Test: `src/client/src/components/ProjectBrowserDialog.hierarchy.test.ts`

**Interfaces:**

- Consumes: `projectSubtreeIds(projects: readonly Project[], targetId: string): string[]` from Task 2, which returns the target plus its descendants. `ProjectController.closeProjectTree(projectId: string): Promise<void>` from Task 7. Existing patterns: `ProjectList` exposes callbacks as `@property({ attribute: false }) onClose?: (project: Project) => void` and confirms destructive actions with `confirm(...)` inside a private method; `ProjectBrowserDialog` uses `onCloseProject?: (project: Project) => void | Promise<void>`; `PiWebUiApp` wires `.onCloseProject=${(project: Project) => this.projects.closeProject(project.id)}` for both surfaces; `AppNavigationPanel` forwards project callbacks through to `ProjectList`.
- Produces: `onCloseTree?: (project: Project) => void` on `ProjectList`, `onCloseProjectTree?: (project: Project) => void | Promise<void>` on `ProjectBrowserDialog`, `onCloseProjectTree` forwarded by `AppNavigationPanel`, and both surfaces wired to `this.projects.closeProjectTree(project.id)` in `PiWebUiApp`.

**Count semantics:** the entry's `N` is the descendant count, so it is `projectSubtreeIds(...).length - 1`. It must be computed from the full `projects` catalog, never from visible rows, so a folded family still reports the true number.

- [ ] **Step 1: Write the failing sidebar menu tests**

Append to `src/client/src/components/ProjectList.hierarchy.test.ts`:

```ts
describe("close with subprojects", () => {
  it("offers the entry with a descendant count for a parent", () => {
    const list = new ProjectList();
    list.projects = family;
    Reflect.set(list, "openMenuProjectId", "root");

    expect(templateText(renderRow(list, rowFor(family, "root")))).toContain("Close with subprojects (1)");
  });

  it("counts descendants at every depth from the full catalog while folded", () => {
    const deep: Project[] = [
      { id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" },
      { id: "child", name: "Child", path: "/work/app1", createdAt: "2026-08-07T00:00:00.000Z" },
      { id: "grandchild", name: "Grandchild", path: "/work/app1/nested", createdAt: "2026-08-07T00:00:00.000Z" },
    ];
    const list = new ProjectList();
    list.projects = deep;
    Reflect.set(list, "openMenuProjectId", "root");

    expect(templateText(renderRow(list, rowFor(deep, "root")))).toContain("Close with subprojects (2)");
  });

  it("does not offer the entry for a project without descendants", () => {
    const list = new ProjectList();
    list.projects = family;
    Reflect.set(list, "openMenuProjectId", "standalone");

    expect(templateText(renderRow(list, rowFor(family, "standalone")))).not.toContain("Close with subprojects");
  });

  it("closes the family after confirmation", () => {
    const list = new ProjectList();
    list.projects = family;
    Reflect.set(list, "openMenuProjectId", "root");
    const onCloseTree = vi.fn();
    list.onCloseTree = onCloseTree;
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(true);

    templateEventHandlerNearMarker(renderRow(list, rowFor(family, "root")), "Close with subprojects (1)")(new Event("click"));

    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(String(confirmSpy.mock.calls[0]?.[0])).toContain("Root");
    expect(String(confirmSpy.mock.calls[0]?.[0])).toContain("will not change");
    expect(onCloseTree).toHaveBeenCalledWith(family[0]);
    confirmSpy.mockRestore();
  });

  it("issues no request when confirmation is declined", () => {
    const list = new ProjectList();
    list.projects = family;
    Reflect.set(list, "openMenuProjectId", "root");
    const onCloseTree = vi.fn();
    list.onCloseTree = onCloseTree;
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(false);

    templateEventHandlerNearMarker(renderRow(list, rowFor(family, "root")), "Close with subprojects (1)")(new Event("click"));

    expect(onCloseTree).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/client/src/components/ProjectList.hierarchy.test.ts`
Expected: FAIL, the menu entry does not exist.

- [ ] **Step 3: Add the sidebar menu entry**

In `src/client/src/components/ProjectList.ts`, add the callback property beside `onClose`:

```ts
  @property({ attribute: false }) onCloseTree?: (project: Project) => void;
```

Inside `renderProjectRow`'s action menu, add the entry immediately after the existing Close button:

```ts
              ${this.renderCloseTreeEntry(project)}
```

Then add the two private members, importing `projectSubtreeIds` from `./projectListProjection`:

```ts
  /** Descendant count comes from the whole catalog, so a folded family still reports honestly. */
  private renderCloseTreeEntry(project: Project) {
    const descendantCount = projectSubtreeIds(this.projects, project.id).length - 1;
    if (descendantCount < 1) return null;
    return html`<button title="Close this project and its subprojects" @click=${() => { this.closeTree(project, descendantCount); }}>Close with subprojects (${descendantCount})</button>`;
  }

  private closeTree(project: Project, descendantCount: number): void {
    this.openMenuProjectId = undefined;
    const noun = descendantCount === 1 ? "subproject" : "subprojects";
    if (confirm(`Close ${project.name} and ${String(descendantCount)} ${noun}?\n\nThis only removes them from PI WEBUI; it will not change the project folders.`)) {
      this.onCloseTree?.(project);
    }
  }
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/components/ProjectList.hierarchy.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Write the failing dialog menu tests**

Append to `src/client/src/components/ProjectBrowserDialog.hierarchy.test.ts`:

```ts
describe("expanded browser close with subprojects", () => {
  it("offers the entry with a descendant count", () => {
    const dialog = dialogWith(family);
    Reflect.set(dialog, "openMenuProjectId", "root");

    expect(templateText(dialog.render())).toContain("Close with subprojects (1)");
  });

  it("does not offer the entry for a project without descendants", () => {
    const dialog = dialogWith(family);
    Reflect.set(dialog, "openMenuProjectId", "standalone");

    expect(templateText(dialog.render())).not.toContain("Close with subprojects");
  });

  it("closes the family after confirmation", () => {
    const dialog = dialogWith(family);
    Reflect.set(dialog, "openMenuProjectId", "root");
    const onCloseProjectTree = vi.fn();
    dialog.onCloseProjectTree = onCloseProjectTree;
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(true);

    templateEventHandlerNearMarker(dialog.render(), "Close with subprojects (1)")(new Event("click"));

    expect(onCloseProjectTree).toHaveBeenCalledWith(family[0]);
    confirmSpy.mockRestore();
  });

  it("issues no request when confirmation is declined", () => {
    const dialog = dialogWith(family);
    Reflect.set(dialog, "openMenuProjectId", "root");
    const onCloseProjectTree = vi.fn();
    dialog.onCloseProjectTree = onCloseProjectTree;
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(false);

    templateEventHandlerNearMarker(dialog.render(), "Close with subprojects (1)")(new Event("click"));

    expect(onCloseProjectTree).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
```

- [ ] **Step 6: Run the tests and confirm they fail, then add the dialog entry**

Run: `npm test -- --run src/client/src/components/ProjectBrowserDialog.hierarchy.test.ts`
Expected: FAIL, the entry does not exist.

In `src/client/src/components/ProjectBrowserDialog.ts`, add the property beside `onCloseProject`:

```ts
  @property({ attribute: false }) onCloseProjectTree?: (project: Project) => void | Promise<void>;
```

Add `${this.renderCloseTreeEntry(project)}` after the existing Close button in `renderProjectRow`, then add the members, importing `projectSubtreeIds` from `./projectListProjection`:

```ts
  private renderCloseTreeEntry(project: Project): TemplateResult | null {
    const descendantCount = projectSubtreeIds(this.projects, project.id).length - 1;
    if (descendantCount < 1) return null;
    return html`<button type="button" title="Close this project and its subprojects" @click=${() => { this.closeProjectTree(project, descendantCount); }}>Close with subprojects (${descendantCount})</button>`;
  }

  private closeProjectTree(project: Project, descendantCount: number): void {
    this.openMenuProjectId = undefined;
    if (!this.hasProject(project.id)) return;
    const noun = descendantCount === 1 ? "subproject" : "subprojects";
    if (confirm(`Close ${project.name} and ${String(descendantCount)} ${noun}?\n\nThis only removes them from PI WEBUI; it will not change the project folders.`)) {
      void this.onCloseProjectTree?.(project);
    }
  }
```

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/components/ProjectBrowserDialog.hierarchy.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 8: Forward the callback through the app shell**

In `src/client/src/components/appShell/AppNavigationPanel.ts`, add a property mirroring the existing project callbacks and pass it to `project-list`:

```ts
  @property({ attribute: false }) onCloseProjectTree?: (project: Project) => void;
```

```ts
        .onCloseTree=${(project: Project) => this.onCloseProjectTree?.(project)}
```

In `src/client/src/components/PiWebUiApp.ts`, wire both surfaces beside their existing `onCloseProject` lines. In the navigation panel binding:

```ts
        .onCloseProjectTree=${(project: Project) => this.projects.closeProjectTree(project.id)}
```

And in the `project-browser-dialog` binding:

```ts
          .onCloseProjectTree=${(project: Project) => this.projects.closeProjectTree(project.id)}
```

- [ ] **Step 9: Add the Changeset**

Create `.changeset/project-directory-hierarchy.md`:

```md
---
"@hyperdreamer/pi-webui": patch
---

Show registered project directories as an expandable hierarchy in the Projects sidebar and the expanded project browser. A project added inside another project's folder now appears as a subproject of its nearest registered parent, with expand and collapse controls, and project families are grouped visually like parent and child sessions. Project action menus gained "Close with subprojects" for closing a project together with everything registered beneath it, which only removes them from PI WEBUI and never changes the folders on disk.
```

- [ ] **Step 10: Run the full verification**

Run: `npm run verify`
Expected: PASS. Run it on an otherwise idle machine; the suite is timing-sensitive and unrelated timeouts under load are environmental rather than defects.

- [ ] **Step 11: Commit**

```bash
git add src/client/src/components/ProjectList.ts src/client/src/components/ProjectList.hierarchy.test.ts src/client/src/components/ProjectBrowserDialog.ts src/client/src/components/ProjectBrowserDialog.hierarchy.test.ts src/client/src/components/appShell/AppNavigationPanel.ts src/client/src/components/PiWebUiApp.ts .changeset/project-directory-hierarchy.md
git commit -m "feat(projects): add close-with-subprojects to both project menus"
```
