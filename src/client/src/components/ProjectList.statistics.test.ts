import type { TemplateResult } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../api";
import { findOptionalTemplateEventHandlerNearMarker, templateEventHandlerNearMarker, templateValueAfterMarker } from "../templateInspection.testSupport";
import { ProjectList } from "./ProjectList";
import type { ProjectTreeRow } from "./projectListProjection";

const project: Project = { id: "p1", name: "app", path: "/dev/app", createdAt: "2026-08-01T00:00:00.000Z" };

// Direct handler extraction: this asserts only that the menu entry is wired to
// the callback and that the menu closes, which a full DOM harness would not
// make clearer.
function openMenu(list: ProjectList): void {
  list.projects = [project];
  Reflect.set(list, "openMenuProjectId", project.id);
}

function renderProjectRow(list: ProjectList): TemplateResult {
  const directive = templateValueAfterMarker(list.render(), '<div class="list-body">');
  const values: unknown = typeof directive === "object" && directive !== null ? Reflect.get(directive, "values") : undefined;
  if (!isProjectRowsRepeatValues(values)) throw new Error("Expected project rows to use Lit repeat");
  return values[2]([{ project, depth: 0, hasChildren: false, folded: false }]);
}

function isProjectRowsRepeatValues(value: unknown): value is readonly [readonly ProjectTreeRow[][], (group: readonly ProjectTreeRow[]) => unknown, (group: readonly ProjectTreeRow[]) => TemplateResult] {
  return Array.isArray(value) && Array.isArray(value[0]) && typeof value[1] === "function" && typeof value[2] === "function";
}

describe("project list statistics entry", () => {
  it("invokes the callback and closes the menu", () => {
    const list = new ProjectList();
    const onShowStatistics = vi.fn();
    list.statisticsAvailable = true;
    list.onShowStatistics = onShowStatistics;
    openMenu(list);

    templateEventHandlerNearMarker(renderProjectRow(list), "Statistics")(new Event("click"));

    expect(onShowStatistics).toHaveBeenCalledWith(project);
    expect(Reflect.get(list, "openMenuProjectId")).toBeUndefined();
  });

  it("omits the entry when the capability is unavailable", () => {
    const list = new ProjectList();
    list.statisticsAvailable = false;
    list.onShowStatistics = vi.fn();
    openMenu(list);

    expect(findOptionalTemplateEventHandlerNearMarker(renderProjectRow(list), "Statistics")).toBeUndefined();
  });
});
