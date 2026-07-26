import type { TemplateResult } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../api";
import { isTemplateResult, templateClickHandlerForText, templateText, templateValueAfterMarker } from "../templateInspection.testSupport";
import { ProjectBrowserDialog } from "./ProjectBrowserDialog";

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
 */
function isProjectRowsRepeatValues(value: unknown): value is readonly [
  readonly unknown[],
  (project: Project) => TemplateResult,
  (project: Project) => TemplateResult,
] {
  return Array.isArray(value) && Array.isArray(value[0]) && typeof value[1] === "function" && typeof value[2] === "function";
}

function projectRowsRepeatDirective(dialog: ProjectBrowserDialog): {
  items: readonly unknown[];
  key: (project: Project) => unknown;
  render: (project: Project) => TemplateResult;
} {
  const rendered = invokeReflectedMethod(dialog, "renderResults");
  if (!isTemplateResult(rendered)) throw new Error("Expected ProjectBrowserDialog.renderResults to return a TemplateResult");

  const directive = templateValueAfterMarker(rendered, '<div class="project-list">');
  if (typeof directive !== "object" || directive === null) throw new Error("Expected project rows to use Lit repeat");
  const values: unknown = Reflect.get(directive, "values");
  if (!isProjectRowsRepeatValues(values)) throw new Error("Expected project rows to use Lit repeat with items, key, and template callbacks");

  return { items: values[0], key: values[1], render: values[2] };
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

    templateClickHandlerForText(projectRowsRepeatDirective(dialog).render(clientProject), "Client App")(clickEvent([]));

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
});
