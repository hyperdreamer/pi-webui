import { describe, expect, it, vi } from "vitest";
import type { Project, Workspace, WorkspaceActivity } from "../api";
import { findOptionalTemplateEventHandlerNearMarker, templateEventHandlerNearMarker, templateText } from "../templateInspection.testSupport";
import { clickOutsideActionMenu } from "./actionMenu.testSupport";
import { displayedProjects, filterProjects, prioritizeActiveProjects, ProjectList, shouldCloseProjectMenuForOrderChange } from "./ProjectList";

const projects: Project[] = [
  { id: "server", name: "Server Console", path: "/work/server-console", createdAt: "2026-07-24T00:00:00.000Z" },
  { id: "client", name: "Client App", path: "/work/client-app", createdAt: "2026-07-24T00:00:00.000Z" },
  { id: "docs", name: "Documentation", path: "/work/client-guides", createdAt: "2026-07-24T00:00:00.000Z" },
];

describe("project filtering", () => {
  it("matches project names and paths regardless of query casing", () => {
    expect(filterProjects(projects, "  CLIENT  ").map((project) => project.id)).toEqual(["client", "docs"]);
  });
});

describe("project activity ordering", () => {
  it("puts projects with live session or terminal activity first without mutating their existing order", () => {
    const projectsToOrder: Project[] = [
      { id: "idle-first", name: "Idle first", path: "/work/idle-first", createdAt: "2026-07-24T00:00:00.000Z" },
      { id: "session-active", name: "Session active", path: "/work/session-active", createdAt: "2026-07-24T00:00:00.000Z" },
      { id: "idle-second", name: "Idle second", path: "/work/idle-second", createdAt: "2026-07-24T00:00:00.000Z" },
      { id: "terminal-active", name: "Terminal active", path: "/work/terminal-active", createdAt: "2026-07-24T00:00:00.000Z" },
    ];
    const activities: Record<string, WorkspaceActivity> = {
      "/work/session-active": { cwd: "/work/session-active", hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "2026-07-24T01:00:00.000Z" },
      "/work/terminal-active": { cwd: "/work/terminal-active", hasSessionActivity: false, hasTerminalActivity: true, updatedAt: "2026-07-24T01:00:00.000Z" },
    };

    const orderedProjects = prioritizeActiveProjects(projectsToOrder, {}, activities);

    expect(orderedProjects.map((project) => project.id)).toEqual(["session-active", "terminal-active", "idle-first", "idle-second"]);
    expect(projectsToOrder.map((project) => project.id)).toEqual(["idle-first", "session-active", "idle-second", "terminal-active"]);
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
      [worktree.path]: { cwd: worktree.path, hasSessionActivity: false, hasTerminalActivity: true, updatedAt: "2026-07-24T01:00:00.000Z" },
    };

    const orderedProjects = displayedProjects(projects, "client", { docs: [worktree] }, activities);

    expect(orderedProjects.map((project) => project.id)).toEqual(["docs", "client"]);
  });
});

describe("project action menu dismissal", () => {
  it("closes an open menu when another part of the project list is clicked", () => {
    const list = new ProjectList();
    Reflect.set(list, "openMenuProjectId", "open-menu");

    clickOutsideActionMenu(list);

    expect(Reflect.get(list, "openMenuProjectId")).toBeUndefined();
  });

  it("closes an open menu only when activity ordering moves its project", () => {
    const nextActivities: Record<string, WorkspaceActivity> = {
      "/work/client-app": { cwd: "/work/client-app", hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "2026-07-24T01:00:00.000Z" },
    };

    expect(shouldCloseProjectMenuForOrderChange(
      "server",
      displayedProjects(projects, "", {}, {}),
      displayedProjects(projects, "", {}, nextActivities),
    )).toBe(true);
    expect(shouldCloseProjectMenuForOrderChange(
      "docs",
      displayedProjects(projects, "", {}, {}),
      displayedProjects(projects, "", {}, nextActivities),
    )).toBe(false);
  });

  it("keeps an open menu when hidden project activity does not move its visible row", () => {
    const nextActivities: Record<string, WorkspaceActivity> = {
      "/work/client-app": { cwd: "/work/client-app", hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "2026-07-24T01:00:00.000Z" },
    };

    expect(shouldCloseProjectMenuForOrderChange(
      "server",
      displayedProjects(projects, "server", {}, {}),
      displayedProjects(projects, "server", {}, nextActivities),
    )).toBe(false);
  });
});

describe("project search interaction", () => {
  // The Node test environment has no DOM harness, so this narrowly verifies
  // the header control's Lit click wiring at its stable ARIA boundary.
  it("reveals the project filter input when the header search control is activated", () => {
    const list = new ProjectList();
    const openSearch = findOptionalTemplateEventHandlerNearMarker(list.render(), 'aria-controls="project-search"');

    expect(openSearch).toBeTypeOf("function");
    if (openSearch === undefined) throw new Error("Expected project search control");
    openSearch(new Event("click"));

    expect(templateText(list.render())).toContain('id="project-search"');
  });
});

describe("project creation interaction", () => {
  // The Node test environment has no DOM harness, so inspect the stable
  // accessible button marker to narrowly exercise Lit's click wiring.
  it("opens project creation when the Projects section add button is activated", () => {
    const list = new ProjectList();
    const onAdd = vi.fn();
    list.onAdd = onAdd;

    templateEventHandlerNearMarker(list.render(), 'aria-label="Add project"')(new Event("click"));

    expect(onAdd).toHaveBeenCalledOnce();
  });
});
