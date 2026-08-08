import type { TemplateResult } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../api";
import { findOptionalTemplateEventHandlerNearMarker, isTemplateResult, templateEventHandlerNearMarker } from "../templateInspection.testSupport";
import { ProjectBrowserDialog } from "./ProjectBrowserDialog";
import type { ProjectTreeRow } from "./projectListProjection";

const project: Project = { id: "p1", name: "app", path: "/dev/app", createdAt: "2026-08-01T00:00:00.000Z" };

const row: ProjectTreeRow = { project, depth: 0, hasChildren: false, folded: false };

/** Rows render inside the repeat directive, so reach the private row template directly. */
function renderProjectRow(dialog: ProjectBrowserDialog): TemplateResult {
  const method: unknown = Reflect.get(dialog, "renderProjectRow");
  if (typeof method !== "function") throw new Error("Expected ProjectBrowserDialog.renderProjectRow");
  const rendered: unknown = Reflect.apply(method, dialog, [row]);
  if (!isTemplateResult(rendered)) throw new Error("Expected ProjectBrowserDialog.renderProjectRow to return a TemplateResult");
  return rendered;
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
