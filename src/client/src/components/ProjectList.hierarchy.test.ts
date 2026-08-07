import { describe, expect, it, vi } from "vitest";
import type { PropertyValues, TemplateResult } from "lit";
import type { Project } from "../api";
import { templateEventHandlerAfterValue, templateText, templateValueAfterMarker } from "../templateInspection.testSupport";
import { ProjectList } from "./ProjectList";
import { projectTreeRows, type ProjectTreeRow } from "./projectListProjection";

const family: Project[] = [
  { id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" },
  { id: "child", name: "Child", path: "/work/app1", createdAt: "2026-08-07T00:00:00.000Z" },
  { id: "standalone", name: "Standalone", path: "/elsewhere", createdAt: "2026-08-07T00:00:00.000Z" },
];

/**
 * Project rows render inside the `repeat` directive, so the shared
 * TemplateResult helpers cannot reach them through render(). This follows the
 * existing per-row seam already used by ProjectList.test.ts.
 */
type RenderProjectRow = (this: ProjectList, row: ProjectTreeRow) => TemplateResult;

function renderRow(list: ProjectList, row: ProjectTreeRow): TemplateResult {
  const method: unknown = Reflect.get(list, "renderProjectRow");
  if (!isRenderProjectRow(method)) throw new Error("ProjectList.renderProjectRow is not callable");
  return method.call(list, row);
}

function isRenderProjectRow(value: unknown): value is RenderProjectRow {
  return typeof value === "function";
}

function rowFor(projects: Project[], id: string, expanded: string[] = []): ProjectTreeRow {
  const rows = projectTreeRows(projects, { expandedProjectIds: new Set(expanded) });
  const row = rows.find((candidate) => candidate.project.id === id);
  if (row === undefined) throw new Error(`No visible row for ${id}`);
  return row;
}

/**
 * The `repeat` directive's rendered groups are opaque to templateText (its
 * results only materialize during a real render), so a group's template is
 * reached through the directive's own argument list (items, key function,
 * group template) — the same seam ProjectList.statistics.test.ts uses to reach
 * one row's template.
 */
function renderGroup(list: ProjectList, find: (group: readonly ProjectTreeRow[]) => boolean): TemplateResult {
  const directive = templateValueAfterMarker(list.render(), '<div class="list-body">');
  const values: unknown = typeof directive === "object" && directive !== null ? Reflect.get(directive, "values") : undefined;
  if (!isProjectRowGroupsRepeatValues(values)) throw new Error("Expected project rows to use Lit repeat");
  const group = values[0].find(find);
  if (group === undefined) throw new Error("Expected a matching project row group");
  return values[2](group);
}

function isProjectRowGroupsRepeatValues(value: unknown): value is readonly [readonly ProjectTreeRow[][], (group: readonly ProjectTreeRow[]) => unknown, (group: readonly ProjectTreeRow[]) => TemplateResult] {
  return Array.isArray(value) && Array.isArray(value[0]) && typeof value[1] === "function" && typeof value[2] === "function";
}

function isStringSet(value: unknown): value is ReadonlySet<string> {
  return value instanceof Set;
}

function isUpdatedMethod(value: unknown): value is (this: ProjectList, changed: PropertyValues<ProjectList>) => void {
  return typeof value === "function";
}

describe("project list hierarchy rendering", () => {
  it("renders a disclosure control that reports collapsed state for a parent", () => {
    const list = new ProjectList();
    list.projects = family;
    const rendered = templateText(renderRow(list, rowFor(family, "root")));

    expect(rendered).toContain("aria-label=Expand Root");
    expect(rendered).toContain("aria-expanded=false");
    expect(rendered).toContain("▸");
  });

  it("reports expanded state once the family is open", () => {
    const list = new ProjectList();
    list.projects = family;
    const rendered = templateText(renderRow(list, rowFor(family, "root", ["root"])));

    expect(rendered).toContain("aria-label=Collapse Root");
    expect(rendered).toContain("aria-expanded=true");
    expect(rendered).toContain("▾");
  });

  it("does not render a disclosure control for a project without children", () => {
    const list = new ProjectList();
    list.projects = family;
    const rendered = templateText(renderRow(list, rowFor(family, "standalone")));

    expect(rendered).not.toContain("session-group-toggle");
  });

  it("expands a family without selecting the project", () => {
    const list = new ProjectList();
    list.projects = family;
    const onSelect = vi.fn();
    list.onSelect = onSelect;
    const event = new Event("click");
    const stopPropagation = vi.spyOn(event, "stopPropagation");

    templateEventHandlerAfterValue(renderRow(list, rowFor(family, "root")), "Expand Root", "@click")(event);

    expect(onSelect).not.toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalledOnce();
    const expanded: unknown = Reflect.get(list, "expandedProjectIds");
    if (!isStringSet(expanded)) throw new Error("ProjectList.expandedProjectIds is unavailable");
    expect([...expanded]).toEqual(["root"]);
    expect(projectTreeRows(family, { expandedProjectIds: expanded }).some((row) => row.project.id === "child")).toBe(true);
  });

  it("collapses an open family back to its root", () => {
    const list = new ProjectList();
    list.projects = family;
    Reflect.set(list, "expandedProjectIds", new Set(["root"]));

    templateEventHandlerAfterValue(renderRow(list, rowFor(family, "root", ["root"])), "Collapse Root", "@click")(new Event("click"));

    const collapsed: unknown = Reflect.get(list, "expandedProjectIds");
    if (!isStringSet(collapsed)) throw new Error("ProjectList.expandedProjectIds is unavailable");
    expect([...collapsed]).toEqual([]);
    expect(projectTreeRows(family, { expandedProjectIds: collapsed }).map((row) => row.project.id)).toEqual(["root", "standalone"]);
  });

  it("marks a descendant row with the tree marker and capped depth", () => {
    const list = new ProjectList();
    list.projects = family;
    const rendered = templateText(renderRow(list, rowFor(family, "child", ["root"])));

    expect(rendered).toContain("↳");
    expect(rendered).toContain("--depth:1");
  });

  it("caps visual indentation at two levels", () => {
    const deep: Project[] = [
      { id: "a", name: "A", path: "/a", createdAt: "2026-08-07T00:00:00.000Z" },
      { id: "b", name: "B", path: "/a/b", createdAt: "2026-08-07T00:00:00.000Z" },
      { id: "c", name: "C", path: "/a/b/c", createdAt: "2026-08-07T00:00:00.000Z" },
      { id: "d", name: "D", path: "/a/b/c/d", createdAt: "2026-08-07T00:00:00.000Z" },
    ];
    const list = new ProjectList();
    list.projects = deep;
    const rendered = templateText(renderRow(list, rowFor(deep, "d", ["a", "b", "c"])));

    expect(rendered).toContain("--depth:2");
  });

  it("frames a family root and leaves a standalone project unframed", () => {
    const list = new ProjectList();
    list.projects = family;

    const familyRendered = templateText(renderGroup(list, (group) => group[0]?.hasChildren === true));
    expect(familyRendered).toContain("session-family-frame");

    const standaloneRendered = templateText(renderGroup(list, (group) => group[0]?.hasChildren !== true));
    expect(standaloneRendered).toContain("Standalone");
    expect(standaloneRendered).not.toContain("session-family-frame");
  });

  it("keeps the heading count at the registered project total while folded", () => {
    const list = new ProjectList();
    list.collapsible = true;
    list.projects = family;

    expect(templateText(list.render())).toContain(">3<");
  });

  it("prunes expansion state for projects that disappear", () => {
    const list = new ProjectList();
    list.projects = family;
    Reflect.set(list, "expandedProjectIds", new Set(["root"]));

    list.projects = [{ id: "standalone", name: "Standalone", path: "/elsewhere", createdAt: "2026-08-07T00:00:00.000Z" }];
    const updated: unknown = Reflect.get(list, "updated");
    if (!isUpdatedMethod(updated)) throw new Error("ProjectList.updated is not callable");
    const changed: PropertyValues<ProjectList> = new Map();
    changed.set("projects", family);
    updated.call(list, changed);

    const pruned: unknown = Reflect.get(list, "expandedProjectIds");
    if (!isStringSet(pruned)) throw new Error("ProjectList.expandedProjectIds is unavailable");
    expect([...pruned]).toEqual([]);
  });
});
