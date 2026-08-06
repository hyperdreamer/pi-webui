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
