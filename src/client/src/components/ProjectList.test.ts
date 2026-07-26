import { describe, expect, it, vi } from "vitest";
import type { Project, WorkspaceActivity } from "../api";
import { findOptionalTemplateEventHandlerNearMarker, templateEventHandlerNearMarker, templateText } from "../templateInspection.testSupport";
import { clickOutsideActionMenu } from "./actionMenu.testSupport";
import { ProjectList, shouldCloseProjectMenuForOrderChange } from "./ProjectList";
import { displayedProjects } from "./projectListProjection";

const projects: Project[] = [
  { id: "server", name: "Server Console", path: "/work/server-console", createdAt: "2026-07-24T00:00:00.000Z" },
  { id: "client", name: "Client App", path: "/work/client-app", createdAt: "2026-07-24T00:00:00.000Z" },
  { id: "docs", name: "Documentation", path: "/work/client-guides", createdAt: "2026-07-24T00:00:00.000Z" },
];

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

describe("expanded project browser interaction", () => {
  // The Node test environment has no DOM harness, so inspect the stable
  // accessible button marker to narrowly exercise Lit's click wiring.
  it("forwards the expanded project browser action from the Projects heading", () => {
    const list = new ProjectList();
    list.collapsed = true;
    const onOpenExpanded = vi.fn();
    list.onOpenExpanded = onOpenExpanded;

    templateEventHandlerNearMarker(list.render(), 'aria-label="Open expanded project browser"')(new Event("click"));

    expect(onOpenExpanded).toHaveBeenCalledOnce();
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
