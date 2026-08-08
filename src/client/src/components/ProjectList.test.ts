import { describe, expect, it, vi } from "vitest";
import type { TemplateResult } from "lit";
import type { Project, WorkspaceActivity } from "../api";
import { findOptionalTemplateEventHandlerNearMarker, templateEventHandlerAfterMarker, templateEventHandlerNearMarker, templateText } from "../templateInspection.testSupport";
import { clickOutsideActionMenu } from "./actionMenu.testSupport";
import { ProjectList, shouldCloseProjectMenuForOrderChange } from "./ProjectList";
import { displayedProjects, type ProjectTreeRow } from "./projectListProjection";

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

describe("project pin controls", () => {
  const pinnedProject: Project = { id: "client", name: "Client App", path: "/work/client-app", createdAt: "2026-08-06T00:00:00.000Z", pinned: true };

  // Project rows render inside the `repeat` directive, so the shared
  // TemplateResult inspection helpers cannot reach them through render().
  // Like the ChatView per-message action seam, these tests render one row
  // through the private per-row method and anchor to stable button markers.
  it("renders a star that unpins a pinned project without selecting the row", () => {
    const list = new ProjectList();
    list.projects = [pinnedProject];
    const onUnpin = vi.fn();
    const onSelect = vi.fn();
    list.onUnpin = onUnpin;
    list.onSelect = onSelect;
    const event = new Event("click");
    const stopPropagation = vi.spyOn(event, "stopPropagation");

    templateEventHandlerAfterMarker(renderProjectRow(list, pinnedProject), 'title="Click to unpin project"')(event);

    expect(onUnpin).toHaveBeenCalledWith(pinnedProject);
    expect(onSelect).not.toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("does not render a star for an unpinned project", () => {
    const list = new ProjectList();
    const unpinnedProject: Project = { id: "server", name: "Server Console", path: "/work/server-console", createdAt: "2026-08-06T00:00:00.000Z" };
    list.projects = [unpinnedProject];

    expect(templateText(renderProjectRow(list, unpinnedProject))).not.toContain("Click to unpin project");
  });

  it("offers Pin in the action menu for an unpinned project", () => {
    const list = new ProjectList();
    const unpinnedProject: Project = { id: "server", name: "Server Console", path: "/work/server-console", createdAt: "2026-08-06T00:00:00.000Z" };
    list.projects = [unpinnedProject];
    Reflect.set(list, "openMenuProjectId", unpinnedProject.id);
    const onPin = vi.fn();
    list.onPin = onPin;

    templateEventHandlerNearMarker(renderProjectRow(list, unpinnedProject), 'title="Pin project to keep it at the top of the list"')(new Event("click"));

    expect(onPin).toHaveBeenCalledWith(unpinnedProject);
    expect(Reflect.get(list, "openMenuProjectId")).toBeUndefined();
  });

  it("offers Unpin in the action menu for a pinned project", () => {
    const list = new ProjectList();
    list.projects = [pinnedProject];
    Reflect.set(list, "openMenuProjectId", pinnedProject.id);
    const onUnpin = vi.fn();
    list.onUnpin = onUnpin;

    templateEventHandlerNearMarker(renderProjectRow(list, pinnedProject), 'title="Unpin project"')(new Event("click"));

    expect(onUnpin).toHaveBeenCalledWith(pinnedProject);
  });
});

/** Render a single project row through ProjectList's private per-row seam. */
type RenderProjectRow = (this: ProjectList, row: ProjectTreeRow) => TemplateResult;

function isRenderProjectRow(value: unknown): value is RenderProjectRow {
  return typeof value === "function";
}

function renderProjectRow(list: ProjectList, project: Project): TemplateResult {
  const method: unknown = Reflect.get(list, "renderProjectRow");
  if (!isRenderProjectRow(method)) throw new Error("ProjectList.renderProjectRow is not callable");
  return method.call(list, { project, depth: 0, hasChildren: false, folded: false });
}
