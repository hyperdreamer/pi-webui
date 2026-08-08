import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../api";
import { isTemplateResult, templateClickHandlerForText, templateEventHandlerAfterMarker, templateEventHandlerAfterValue, templateEventHandlerNearMarker, templateText, templateValueAfterMarker } from "../templateInspection.testSupport";
import { ProjectBrowserDialog } from "./ProjectBrowserDialog";
import type { ProjectTreeRow } from "./projectListProjection";

afterEach(() => {
  vi.unstubAllGlobals();
});

const serverProject: Project = { id: "server", name: "Server Console", path: "/very/long/path/to/server-console", createdAt: "2026-07-26T00:00:00.000Z" };
const clientProject: Project = { id: "client", name: "Client App", path: "/very/long/path/to/client-app", createdAt: "2026-07-26T00:00:00.000Z" };
const projects = [serverProject, clientProject];

function invokeReflectedMethod(target: object, name: string, ...args: unknown[]): unknown {
  const method: unknown = Reflect.get(target, name);
  if (typeof method !== "function") throw new Error(`Expected ProjectBrowserDialog.${name}`);
  return Reflect.apply(method, target, args);
}

function invokeReflectedVoidMethod(target: object, name: string, ...args: unknown[]): void {
  void invokeReflectedMethod(target, name, ...args);
}

/**
 * Node-based component tests cannot mount Lit's keyed DOM. Inspect the repeat
 * directive at the rendering boundary to lock down its stable row identity.
 * Rows now render as depth-zero family groups, so the helper unwraps each
 * group to the single-row shape the assertions already expect.
 */
function isProjectRowsRepeatValues(value: unknown): value is readonly [
  readonly ProjectTreeRow[][],
  (group: readonly ProjectTreeRow[]) => unknown,
  (group: readonly ProjectTreeRow[]) => TemplateResult,
] {
  return Array.isArray(value) && Array.isArray(value[0]) && Array.isArray(value[0][0]) && typeof value[1] === "function" && typeof value[2] === "function";
}

function rowFor(project: Project): ProjectTreeRow {
  return { project, depth: 0, hasChildren: false, folded: false };
}

function projectRowsRepeatDirective(dialog: ProjectBrowserDialog): {
  items: readonly Project[];
  key: (project: Project) => unknown;
  render: (project: Project) => TemplateResult;
} {
  const rendered = invokeReflectedMethod(dialog, "renderResults");
  if (!isTemplateResult(rendered)) throw new Error("Expected ProjectBrowserDialog.renderResults to return a TemplateResult");

  const directive = templateValueAfterMarker(rendered, '<div class="project-list">');
  if (typeof directive !== "object" || directive === null) throw new Error("Expected project rows to use Lit repeat");
  const values: unknown = Reflect.get(directive, "values");
  if (!isProjectRowsRepeatValues(values)) throw new Error("Expected project rows to use Lit repeat with row groups");

  return {
    items: values[0].map((group) => group[0]?.project).filter((project): project is Project => project !== undefined),
    key: (project) => values[1]([rowFor(project)]),
    render: (project) => values[2]([rowFor(project)]),
  };
}

function clickEvent(path: EventTarget[]): Event {
  const event = new Event("click");
  Object.defineProperty(event, "composedPath", { value: () => path });
  return event;
}

describe("ProjectBrowserDialog", () => {
  it("renders a filtered project with its complete path", () => {
    const dialog = new ProjectBrowserDialog();
    dialog.projects = projects;
    Reflect.set(dialog, "searchQuery", "CLIENT");

    const rows = projectRowsRepeatDirective(dialog);
    const rendered = templateText(rows.render(clientProject));
    expect(rows.items).toEqual([clientProject]);
    expect(rendered).toContain("Client App");
    expect(rendered).toContain("/very/long/path/to/client-app");
    expect(rendered).not.toContain("Server Console");
    expect(ProjectBrowserDialog.styles.cssText).toMatch(/\.project-path\s*\{[^}]*overflow-wrap:\s*anywhere;/);
  });

  it("keys project rows by their stable project id", () => {
    const dialog = new ProjectBrowserDialog();
    dialog.projects = projects;

    const { key } = projectRowsRepeatDirective(dialog);

    expect(key(serverProject)).toBe("server");
    expect(key(clientProject)).toBe("client");
  });

  it("keeps the result area vertically scrollable without horizontal scrolling", () => {
    expect(ProjectBrowserDialog.styles.cssText).toMatch(/\.result-area\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/);
  });

  it("renders inline SVG icons for the close and action-menu controls", () => {
    const dialog = new ProjectBrowserDialog();
    dialog.projects = projects;

    const dialogMarkup = templateText(dialog.render());
    const rowMarkup = templateText(projectRowsRepeatDirective(dialog).render(serverProject));

    expect(dialogMarkup).toContain('<svg class="close-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">');
    expect(dialogMarkup).not.toContain("×");
    expect(rowMarkup).toContain('<svg class="action-menu-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"');
    expect(rowMarkup).not.toContain("⋯");
  });

  it("delegates a selected row through the supplied callback", () => {
    const dialog = new ProjectBrowserDialog();
    dialog.projects = projects;
    const onSelect = vi.fn();
    dialog.onSelect = onSelect;

    // Anchor on the row's path: the pin toggle's interpolated aria-label also contains the project name.
    templateClickHandlerForText(projectRowsRepeatDirective(dialog).render(clientProject), clientProject.path)(clickEvent([]));

    expect(onSelect).toHaveBeenCalledWith(clientProject);
  });

  it("renders an empty search message when no project matches", () => {
    const dialog = new ProjectBrowserDialog();
    dialog.projects = projects;
    Reflect.set(dialog, "searchQuery", "missing");

    expect(templateText(dialog.render())).toContain("No matching projects.");
  });

  it("closes when Escape is pressed in the dialog", () => {
    const dialog = new ProjectBrowserDialog();
    const onClose = vi.fn();
    dialog.onClose = onClose;
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    invokeReflectedVoidMethod(dialog, "handleDialogKeyDown", {
      key: "Escape",
      preventDefault,
      stopPropagation,
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("prevents focus transfer and closes for a physical backdrop mousedown", () => {
    const dialog = new ProjectBrowserDialog();
    const onClose = vi.fn();
    const preventDefault = vi.fn();
    dialog.onClose = onClose;
    const backdrop = new EventTarget();
    const event = {
      target: backdrop,
      currentTarget: backdrop,
      preventDefault,
    } satisfies Pick<MouseEvent, "target" | "currentTarget" | "preventDefault">;

    invokeReflectedVoidMethod(dialog, "handleBackdropMouseDown", event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("delegates the Add action through the supplied callback", () => {
    const dialog = new ProjectBrowserDialog();
    const onAdd = vi.fn();
    dialog.onAdd = onAdd;

    templateClickHandlerForText(dialog.render(), "Add project")(new Event("click"));

    expect(onAdd).toHaveBeenCalledOnce();
  });

  it("does not delegate Close when the exact confirmation is cancelled", () => {
    const dialog = new ProjectBrowserDialog();
    const confirm = vi.fn(() => false);
    const onCloseProject = vi.fn();
    dialog.projects = projects;
    dialog.onCloseProject = onCloseProject;
    vi.stubGlobal("confirm", confirm);

    invokeReflectedVoidMethod(dialog, "closeProject", clientProject);

    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith("Close Client App?\n\nThis only removes it from PI WEBUI; it will not change the project folder.");
    expect(onCloseProject).not.toHaveBeenCalled();
  });

  it("delegates Close with the live project only after the exact confirmation is accepted", () => {
    const dialog = new ProjectBrowserDialog();
    const confirm = vi.fn(() => true);
    const onCloseProject = vi.fn();
    dialog.projects = projects;
    dialog.onCloseProject = onCloseProject;
    vi.stubGlobal("confirm", confirm);

    invokeReflectedVoidMethod(dialog, "closeProject", clientProject);

    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith("Close Client App?\n\nThis only removes it from PI WEBUI; it will not change the project folder.");
    expect(onCloseProject).toHaveBeenCalledOnce();
    expect(onCloseProject).toHaveBeenCalledWith(clientProject);
  });

  it("does not confirm or delegate a direct Close for a stale project", () => {
    const dialog = new ProjectBrowserDialog();
    const confirm = vi.fn(() => true);
    const onCloseProject = vi.fn();
    dialog.projects = [serverProject];
    dialog.onCloseProject = onCloseProject;
    vi.stubGlobal("confirm", confirm);

    invokeReflectedVoidMethod(dialog, "closeProject", clientProject);

    expect(confirm).not.toHaveBeenCalled();
    expect(onCloseProject).not.toHaveBeenCalled();
  });

  it("renders modal semantics and a labelled close control", () => {
    const dialog = new ProjectBrowserDialog();

    const rendered = templateText(dialog.render());
    expect(rendered).toContain('role="dialog"');
    expect(rendered).toContain('aria-modal="true"');
    expect(rendered).toContain('aria-labelledby="project-browser-title"');
    expect(rendered).toContain('aria-label="Close expanded project browser"');
  });

  it("focuses the search input after first render", () => {
    const dialog = new ProjectBrowserDialog();
    const focus = vi.fn();
    const searchInput = { focus };
    Reflect.set(dialog, "searchInput", searchInput);
    // Lit's @query decorator exposes a read-only getter in the Node test environment.
    Object.defineProperty(dialog, "searchInput", { configurable: true, value: searchInput });

    invokeReflectedVoidMethod(dialog, "firstUpdated");

    expect(focus).toHaveBeenCalledOnce();
  });

  it("closes a stale action menu when its project is removed", () => {
    const dialog = new ProjectBrowserDialog();
    dialog.projects = projects;
    Reflect.set(dialog, "openMenuProjectId", "client");
    dialog.projects = projects.filter((project) => project.id === "server");

    invokeReflectedVoidMethod(dialog, "updated", new Map([["projects", projects]]));

    expect(Reflect.get(dialog, "openMenuProjectId")).toBeUndefined();
  });

  it("closes an open action menu when a same-index owner moves in visible project order", () => {
    const firstProject: Project = { ...serverProject, id: "first", path: "/projects/first" };
    const ownerProject: Project = { ...clientProject, id: "owner", path: "/projects/owner" };
    const lastProject: Project = { ...serverProject, id: "last", path: "/projects/last" };
    const previousProjects = [firstProject, ownerProject, lastProject];
    const currentProjects = [lastProject, ownerProject, firstProject];
    const dialog = new ProjectBrowserDialog();
    dialog.projects = previousProjects;
    Reflect.set(dialog, "openMenuProjectId", ownerProject.id);
    dialog.projects = currentProjects;

    invokeReflectedVoidMethod(dialog, "updated", new Map([["projects", previousProjects]]));

    expect(Reflect.get(dialog, "openMenuProjectId")).toBeUndefined();
  });

  it("closes an open action menu when an activity update changes visible project order", () => {
    const previousActivities = {};
    const currentActivities = {
      [clientProject.path]: { cwd: clientProject.path, hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "2026-07-26T01:00:00.000Z" },
    };
    const dialog = new ProjectBrowserDialog();
    dialog.projects = projects;
    dialog.activities = previousActivities;
    Reflect.set(dialog, "openMenuProjectId", clientProject.id);
    dialog.activities = currentActivities;

    invokeReflectedVoidMethod(dialog, "updated", new Map([["activities", previousActivities]]));

    expect(Reflect.get(dialog, "openMenuProjectId")).toBeUndefined();
  });

  it("closes an open action menu when a workspace update changes visible project order", () => {
    const activeWorktree = {
      id: "client-worktree",
      projectId: clientProject.id,
      path: "/tmp/client-worktree",
      label: "client-worktree",
      isMain: false,
      isGitRepo: true,
      isGitWorktree: true,
    };
    const activities = {
      [activeWorktree.path]: { cwd: activeWorktree.path, hasSessionActivity: false, hasTerminalActivity: true, updatedAt: "2026-07-26T01:00:00.000Z" },
    };
    const previousWorkspacesByProjectId = {};
    const currentWorkspacesByProjectId = { [clientProject.id]: [activeWorktree] };
    const dialog = new ProjectBrowserDialog();
    dialog.projects = projects;
    dialog.activities = activities;
    dialog.workspacesByProjectId = previousWorkspacesByProjectId;
    Reflect.set(dialog, "openMenuProjectId", clientProject.id);
    dialog.workspacesByProjectId = currentWorkspacesByProjectId;

    invokeReflectedVoidMethod(dialog, "updated", new Map([["workspacesByProjectId", previousWorkspacesByProjectId]]));

    expect(Reflect.get(dialog, "openMenuProjectId")).toBeUndefined();
  });

  it("keeps an open action menu when projection-input updates preserve visible project order", () => {
    const previousProjects = projects;
    const currentProjects = projects.map((project) => ({ ...project, name: `${project.name} updated` }));
    const previousActivities = {
      [clientProject.path]: { cwd: clientProject.path, hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "2026-07-26T01:00:00.000Z" },
    };
    const currentActivities = {
      [clientProject.path]: { cwd: clientProject.path, hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "2026-07-26T02:00:00.000Z" },
    };
    const previousWorkspacesByProjectId = {};
    const currentWorkspacesByProjectId = {
      [serverProject.id]: [{
        id: "server-worktree",
        projectId: serverProject.id,
        path: "/tmp/server-worktree",
        label: "server-worktree",
        isMain: false,
        isGitRepo: true,
        isGitWorktree: true,
      }],
    };
    const dialog = new ProjectBrowserDialog();
    dialog.projects = previousProjects;
    dialog.activities = previousActivities;
    dialog.workspacesByProjectId = previousWorkspacesByProjectId;
    Reflect.set(dialog, "openMenuProjectId", clientProject.id);
    dialog.projects = currentProjects;
    dialog.activities = currentActivities;
    dialog.workspacesByProjectId = currentWorkspacesByProjectId;

    invokeReflectedVoidMethod(dialog, "updated", new Map([
      ["projects", previousProjects],
      ["activities", previousActivities],
      ["workspacesByProjectId", previousWorkspacesByProjectId],
    ]));

    expect(Reflect.get(dialog, "openMenuProjectId")).toBe(clientProject.id);
  });

  it("closes an open action menu when the result area scrolls", () => {
    const dialog = new ProjectBrowserDialog();
    dialog.projects = projects;
    Reflect.set(dialog, "openMenuProjectId", clientProject.id);

    // Node tests cannot mount Lit, so inspect the stable result-area scroll wiring.
    templateEventHandlerAfterMarker(dialog.render(), '<div class="result-area"')(new Event("scroll"));

    expect(Reflect.get(dialog, "openMenuProjectId")).toBeUndefined();
  });
});

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
    const row = projectRowsRepeatDirective(dialog).render(unpinned);

    // Anchor the star's handler to its exact interpolated aria-label value, then pin down its visible state.
    templateEventHandlerAfterValue(row, `Pin ${unpinned.name}`, "@click=")(event);

    expect(onPinProject).toHaveBeenCalledWith(unpinned);
    expect(onSelect).not.toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(templateValueAfterMarker(row, "aria-pressed=")).toBe("false");
    expect(templateText(row)).toContain("☆");
  });

  it("unpins a pinned project from its row star", () => {
    const dialog = new ProjectBrowserDialog();
    dialog.projects = [pinned];
    const onUnpinProject = vi.fn();
    dialog.onUnpinProject = onUnpinProject;
    const row = projectRowsRepeatDirective(dialog).render(pinned);

    // Anchor the star's handler to its exact interpolated aria-label value, then pin down its visible state.
    templateEventHandlerAfterValue(row, `Unpin ${pinned.name}`, "@click=")(new Event("click"));

    expect(onUnpinProject).toHaveBeenCalledWith(pinned);
    expect(templateValueAfterMarker(row, "aria-pressed=")).toBe("true");
    expect(templateText(row)).toContain("★");
  });

  it("offers Pin and Unpin in the row action menu", () => {
    const pinDialog = new ProjectBrowserDialog();
    pinDialog.projects = [unpinned];
    Reflect.set(pinDialog, "openMenuProjectId", unpinned.id);
    const onPinProject = vi.fn();
    pinDialog.onPinProject = onPinProject;

    templateEventHandlerNearMarker(projectRowsRepeatDirective(pinDialog).render(unpinned), 'title="Pin project to keep it at the top of the list"')(new Event("click"));

    expect(onPinProject).toHaveBeenCalledWith(unpinned);
    expect(Reflect.get(pinDialog, "openMenuProjectId")).toBeUndefined();

    const unpinDialog = new ProjectBrowserDialog();
    unpinDialog.projects = [pinned];
    Reflect.set(unpinDialog, "openMenuProjectId", pinned.id);
    const onUnpinProject = vi.fn();
    unpinDialog.onUnpinProject = onUnpinProject;

    templateEventHandlerNearMarker(projectRowsRepeatDirective(unpinDialog).render(pinned), 'title="Unpin project"')(new Event("click"));

    expect(onUnpinProject).toHaveBeenCalledWith(pinned);
  });
});
