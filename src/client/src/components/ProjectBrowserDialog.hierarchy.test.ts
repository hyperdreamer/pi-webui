import type { TemplateResult } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../api";
import { isTemplateResult, templateEventHandlerAfterValue, templateText, templateValueAfterMarker } from "../templateInspection.testSupport";
import { ProjectList } from "./ProjectList";
import { ProjectBrowserDialog } from "./ProjectBrowserDialog";
import type { ProjectTreeRow } from "./projectListProjection";

const family: Project[] = [
  { id: "root", name: "Root", path: "/work", createdAt: "2026-08-07T00:00:00.000Z" },
  { id: "child", name: "Child", path: "/work/app1", createdAt: "2026-08-07T00:00:00.000Z" },
  { id: "standalone", name: "Standalone", path: "/elsewhere", createdAt: "2026-08-07T00:00:00.000Z" },
];

function dialogWith(projects: Project[]): ProjectBrowserDialog {
  const dialog = new ProjectBrowserDialog();
  dialog.projects = projects;
  return dialog;
}

type DialogRepeatValues = readonly [
  readonly ProjectTreeRow[][],
  (group: readonly ProjectTreeRow[]) => unknown,
  (group: readonly ProjectTreeRow[]) => TemplateResult,
];

function isDialogRepeatValues(value: unknown): value is DialogRepeatValues {
  return Array.isArray(value) && Array.isArray(value[0]) && Array.isArray(value[0][0]) && typeof value[1] === "function" && typeof value[2] === "function";
}

/**
 * The `repeat` directive's rendered groups are opaque to templateText (results
 * only materialize during a real render), so the dialog's row markup is reached
 * through the directive's own argument list — the same seam this component's
 * ProjectBrowserDialog.test.ts already uses for its row tests.
 */
function dialogRepeatParts(dialog: ProjectBrowserDialog): {
  groups: readonly ProjectTreeRow[][];
  render: (group: readonly ProjectTreeRow[]) => TemplateResult;
} {
  const method: unknown = Reflect.get(dialog, "renderResults");
  if (typeof method !== "function") throw new Error("Expected ProjectBrowserDialog.renderResults");
  const rendered: unknown = Reflect.apply(method, dialog, []);
  if (!isTemplateResult(rendered)) throw new Error("Expected ProjectBrowserDialog.renderResults to return a TemplateResult");
  const directive = templateValueAfterMarker(rendered, '<div class="project-list">');
  if (typeof directive !== "object" || directive === null) throw new Error("Expected project rows to use Lit repeat");
  const values: unknown = Reflect.get(directive, "values");
  if (!isDialogRepeatValues(values)) throw new Error("Expected project rows to use Lit repeat with row groups");
  return { groups: values[0], render: values[2] };
}

/** Flattened text of every rendered row group, in display order. */
function dialogResultsText(dialog: ProjectBrowserDialog): string {
  const { groups, render } = dialogRepeatParts(dialog);
  return groups.map((group) => templateText(render(group))).join("");
}

/** The row-group template for the `root` family, so tests can inspect and drive its disclosure control. */
function renderRootGroup(dialog: ProjectBrowserDialog): TemplateResult {
  const { groups, render } = dialogRepeatParts(dialog);
  const group = groups.find((candidate) => candidate[0]?.project.id === "root");
  if (group === undefined) throw new Error("Expected a root row group");
  return render(group);
}

function isStringSet(value: unknown): value is ReadonlySet<string> {
  return value instanceof Set;
}

function expandedIds(dialog: ProjectBrowserDialog): string[] {
  const expanded: unknown = Reflect.get(dialog, "expandedProjectIds");
  if (!isStringSet(expanded)) throw new Error("ProjectBrowserDialog.expandedProjectIds is unavailable");
  return [...expanded];
}

describe("expanded project browser hierarchy", () => {
  it("hides descendants until the family is expanded", () => {
    const rendered = dialogResultsText(dialogWith(family));

    expect(rendered).toContain("Root");
    expect(rendered).not.toContain("/work/app1");
  });

  it("renders a disclosure control for a parent", () => {
    const rendered = templateText(renderRootGroup(dialogWith(family)));

    expect(rendered).toContain("aria-label=Expand Root");
    expect(rendered).toContain("aria-expanded=false");
  });

  it("expands a family without selecting the project", () => {
    const dialog = dialogWith(family);
    const onSelect = vi.fn();
    dialog.onSelect = onSelect;
    const event = new Event("click");
    const stopPropagation = vi.spyOn(event, "stopPropagation");

    templateEventHandlerAfterValue(renderRootGroup(dialog), "Expand Root", "@click")(event);

    expect(onSelect).not.toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(expandedIds(dialog)).toEqual(["root"]);
    expect(dialogResultsText(dialog)).toContain("/work/app1");
  });

  it("collapses an expanded family", () => {
    const dialog = dialogWith(family);
    Reflect.set(dialog, "expandedProjectIds", new Set(["root"]));

    templateEventHandlerAfterValue(renderRootGroup(dialog), "Collapse Root", "@click")(new Event("click"));

    expect(expandedIds(dialog)).toEqual([]);
    expect(dialogResultsText(dialog)).not.toContain("/work/app1");
  });

  it("frames a family root", () => {
    expect(dialogResultsText(dialogWith(family))).toContain("session-family-frame");
  });

  it("marks descendants with the tree marker", () => {
    const dialog = dialogWith(family);
    Reflect.set(dialog, "expandedProjectIds", new Set(["root"]));

    expect(dialogResultsText(dialog)).toContain("↳");
  });

  it("shows a nested match with its ancestors during search and hides disclosure controls", () => {
    const dialog = dialogWith(family);
    Reflect.set(dialog, "searchQuery", "app1");

    const rendered = dialogResultsText(dialog);
    expect(rendered).toContain("/work/app1");
    expect(rendered).not.toContain("Standalone");
    expect(rendered).not.toContain("session-group-toggle");
  });

  it("keeps ancestor rows shown for context fully interactive", () => {
    const dialog = dialogWith(family);
    Reflect.set(dialog, "searchQuery", "app1");

    expect(dialogResultsText(dialog)).toContain("aria-label=Actions for Root");
  });

  it("reports no matches from visible rows rather than the flat count", () => {
    const dialog = dialogWith(family);
    Reflect.set(dialog, "searchQuery", "nothing-matches-this");

    expect(templateText(dialog.render())).toContain("No matching projects.");
  });

  it("keeps its expansion state independent from the sidebar", () => {
    const dialog = dialogWith(family);
    const list = new ProjectList();
    list.projects = family;
    Reflect.set(list, "expandedProjectIds", new Set(["root"]));

    expect(expandedIds(dialog)).toEqual([]);
    expect(dialogResultsText(dialog)).not.toContain("/work/app1");
  });
});
