import { describe, expect, it } from "vitest";
import type { Project, Workspace, WorkspaceActivity } from "../api";
import { displayedProjects, filterProjects, prioritizeActiveProjects } from "./projectListProjection";

const projects: Project[] = [
  { id: "server", name: "Server Console", path: "/work/server-console", createdAt: "2026-07-26T00:00:00.000Z" },
  { id: "client", name: "Client App", path: "/work/client-app", createdAt: "2026-07-26T00:00:00.000Z" },
  { id: "docs", name: "Documentation", path: "/work/client-guides", createdAt: "2026-07-26T00:00:00.000Z" },
];

describe("project list projection", () => {
  it("filters case-insensitively by both name and full path", () => {
    expect(filterProjects(projects, "  CLIENT  ").map((project) => project.id)).toEqual(["client", "docs"]);
  });

  it("keeps active projects first without mutating the incoming list", () => {
    const activities: Record<string, WorkspaceActivity> = {
      "/work/client-app": { cwd: "/work/client-app", hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "2026-07-26T01:00:00.000Z" },
    };

    expect(prioritizeActiveProjects(projects, {}, activities).map((project) => project.id)).toEqual(["client", "server", "docs"]);
    expect(projects.map((project) => project.id)).toEqual(["server", "client", "docs"]);
  });

  it("filters before it applies active-first ordering", () => {
    const activities: Record<string, WorkspaceActivity> = {
      "/work/client-guides": { cwd: "/work/client-guides", hasSessionActivity: false, hasTerminalActivity: true, updatedAt: "2026-07-26T01:00:00.000Z" },
    };

    expect(displayedProjects(projects, "client", {}, activities).map((project) => project.id)).toEqual(["docs", "client"]);
  });

  it("prioritizes visible projects with activity from a known worktree", () => {
    const worktree: Workspace = {
      id: "docs-feature",
      projectId: "docs",
      path: "/tmp/client-guides-feature",
      label: "docs-feature",
      isMain: false,
      isGitRepo: true,
      isGitWorktree: true,
    };
    const activities: Record<string, WorkspaceActivity> = {
      [worktree.path]: { cwd: worktree.path, hasSessionActivity: false, hasTerminalActivity: true, updatedAt: "2026-07-26T01:00:00.000Z" },
    };

    expect(displayedProjects(projects, "client", { docs: [worktree] }, activities).map((project) => project.id)).toEqual(["docs", "client"]);
  });
});

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
    expect(rows.every((row) => !row.folded)).toBe(true);
  });

  it("still reports hasChildren during search", () => {
    const rows = projectTreeRows(familyProjects, { queryText: "nested" });
    expect(rows.find((row) => row.project.id === "root")?.hasChildren).toBe(true);
  });
});
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
