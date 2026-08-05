import type { TemplateResult } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../api";
import { findOptionalTemplateEventHandlerNearMarker, templateEventHandlerNearMarker, templateValueAfterMarker } from "../templateInspection.testSupport";
import { ProjectBrowserDialog } from "./ProjectBrowserDialog";

const project: Project = { id: "p1", name: "app", path: "/dev/app", createdAt: "2026-08-01T00:00:00.000Z" };

function renderProjectRow(dialog: ProjectBrowserDialog): TemplateResult {
  const directive = templateValueAfterMarker(dialog.render(), '<div class="project-list">');
  const values: unknown = typeof directive === "object" && directive !== null ? Reflect.get(directive, "values") : undefined;
  if (!isProjectRowsRepeatValues(values)) throw new Error("Expected project rows to use Lit repeat");
  return values[2](project);
}

function isProjectRowsRepeatValues(value: unknown): value is readonly [readonly unknown[], (project: Project) => unknown, (project: Project) => TemplateResult] {
  return Array.isArray(value) && Array.isArray(value[0]) && typeof value[1] === "function" && typeof value[2] === "function";
}

describe("project browser statistics entry", () => {
  it("invokes the callback and closes the menu", () => {
    const dialog = new ProjectBrowserDialog();
    const onShowProjectStatistics = vi.fn();
    dialog.projects = [project];
    dialog.statisticsAvailable = true;
    dialog.onShowProjectStatistics = onShowProjectStatistics;
    Reflect.set(dialog, "openMenuProjectId", project.id);

    templateEventHandlerNearMarker(renderProjectRow(dialog), "Statistics")(new Event("click"));

    expect(onShowProjectStatistics).toHaveBeenCalledWith(project);
    expect(Reflect.get(dialog, "openMenuProjectId")).toBeUndefined();
  });

  it("omits the entry when the capability is unavailable", () => {
    const dialog = new ProjectBrowserDialog();
    dialog.projects = [project];
    dialog.statisticsAvailable = false;
    dialog.onShowProjectStatistics = vi.fn();
    Reflect.set(dialog, "openMenuProjectId", project.id);

    expect(findOptionalTemplateEventHandlerNearMarker(renderProjectRow(dialog), "Statistics")).toBeUndefined();
  });
});
