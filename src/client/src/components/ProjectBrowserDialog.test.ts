import { describe, expect, it, vi } from "vitest";
import type { Project } from "../api";
import { templateClickHandlerForText, templateText } from "../templateInspection.testSupport";
import { ProjectBrowserDialog } from "./ProjectBrowserDialog";

const projects: Project[] = [
  { id: "server", name: "Server Console", path: "/very/long/path/to/server-console", createdAt: "2026-07-26T00:00:00.000Z" },
  { id: "client", name: "Client App", path: "/very/long/path/to/client-app", createdAt: "2026-07-26T00:00:00.000Z" },
];

function invokeReflectedVoidMethod(target: object, name: string, ...args: unknown[]): void {
  const method: unknown = Reflect.get(target, name);
  if (typeof method !== "function") throw new Error(`Expected ProjectBrowserDialog.${name}`);
  Reflect.apply(method, target, args);
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

    const rendered = templateText(dialog.render());
    expect(rendered).toContain("Client App");
    expect(rendered).toContain("/very/long/path/to/client-app");
    expect(rendered).not.toContain("Server Console");
    expect(ProjectBrowserDialog.styles.cssText).toMatch(/\.project-path\s*\{[^}]*overflow-wrap:\s*anywhere;/);
  });

  it("delegates a selected row through the supplied callback", () => {
    const dialog = new ProjectBrowserDialog();
    dialog.projects = projects;
    const onSelect = vi.fn();
    dialog.onSelect = onSelect;

    templateClickHandlerForText(dialog.render(), "Client App")(clickEvent([]));

    expect(onSelect).toHaveBeenCalledWith(projects[1]);
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

  it("closes when the backdrop is activated", () => {
    const dialog = new ProjectBrowserDialog();
    const onClose = vi.fn();
    dialog.onClose = onClose;
    const backdrop = {};

    invokeReflectedVoidMethod(dialog, "handleBackdropMouseDown", {
      target: backdrop,
      currentTarget: backdrop,
    });

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
