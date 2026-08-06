import { describe, expect, it, vi } from "vitest";
import type { ActivityRailContext } from "@hyperdreamer/pi-webui/plugin-api";
import type { LearnedSkillsWorkspaceState } from "./learnedSkillsData.js";
import plugin from "./pi-webui-plugin.js";

interface StubTemplate {
  strings: readonly string[];
  values: readonly unknown[];
}

function stubTag(strings: TemplateStringsArray, ...values: unknown[]): unknown {
  return { strings: [...strings], values };
}

function stubTemplate(value: unknown): StubTemplate {
  if (
    typeof value !== "object"
    || value === null
    || !("strings" in value)
    || !("values" in value)
    || !Array.isArray(value.strings)
    || !Array.isArray(value.values)
  ) {
    throw new Error("Expected a stubbed template");
  }
  return { strings: value.strings, values: value.values };
}

function activityContext(
  learnedSkills: LearnedSkillsWorkspaceState,
  options: { workspace?: boolean; retry?: () => void } = {},
): ActivityRailContext {
  const context = {
    state: { learnedSkills },
    onRefreshLearnedSkills: options.retry ?? vi.fn(),
    ...(options.workspace === false ? {} : { workspaceScope: {} }),
  };
  // This test exercises the private bundled-context boundary without creating
  // unrelated public runtime collaborators.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return context as unknown as ActivityRailContext;
}

describe("pi-webui workspace-learned-skills activity-Rail plugin", () => {
  // TemplateResult is not constructable in the Node test environment.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const activationContext = {
    apiVersion: 1,
    pluginId: "workspace-learned-skills",
    html: stubTag,
    svg: stubTag,
  } as unknown as Parameters<typeof plugin.activate>[0];
  const result = plugin.activate(activationContext);
  const activity = result.contributions.activityRailItems?.[0];

  if (activity === undefined) throw new Error("Expected Learned Skills activity contribution");

  it("contributes exactly one Rail item and no workspace panel", () => {
    expect(result.contributions.activityRailItems).toHaveLength(1);
    expect(result.contributions.workspacePanels).toBeUndefined();
    expect(activity).toMatchObject({
      id: "workspace.learned-skills",
      title: "Learned Skills",
      order: 51,
    });
  });

  it("uses a 24px currentColor outlined lightbulb icon", () => {
    const markup = stubTemplate(activity.icon).strings.join("");

    expect(markup).toContain('data-icon="lightbulb"');
    expect(markup).toContain('width="24"');
    expect(markup).toContain('height="24"');
    expect(markup).toContain('fill="none"');
    expect(markup).toContain('stroke="currentColor"');
  });

  it("is hidden without workspace scope", () => {
    expect(activity.visible?.(activityContext({ kind: "loading" }, { workspace: false }))).toBe(false);
  });

  it.each<LearnedSkillsWorkspaceState>([
    { kind: "loading" },
    { kind: "error", message: "offline" },
    { kind: "data", globalSkills: [], projectSkills: [] },
  ])("keeps $kind state visible with workspace scope", (state) => {
    expect(activity.visible?.(activityContext(state))).toBe(true);
  });

  it("hides confirmed provider unavailability", () => {
    expect(activity.visible?.(activityContext({ kind: "unavailable" }))).toBe(false);
  });

  it("omits a zero badge and totals populated global plus project skills", () => {
    expect(activity.badge?.(activityContext({ kind: "data", globalSkills: [], projectSkills: [] }))).toBeUndefined();
    expect(activity.badge?.(activityContext({
      kind: "data",
      globalSkills: [{ id: "g", name: "Global", description: "g", filePath: "/g" }],
      projectSkills: [
        { id: "p1", name: "One", description: "one", filePath: "/p1" },
        { id: "p2", name: "Two", description: "two", filePath: "/p2" },
      ],
    }))).toBe(3);
  });

  it("renders the panel with core state and retry callback properties", () => {
    const learnedSkills: LearnedSkillsWorkspaceState = {
      kind: "data",
      globalSkills: [{ id: "g", name: "Global", description: "g", filePath: "/g" }],
      projectSkills: [],
    };
    const retry = vi.fn();
    const context = activityContext(learnedSkills, { retry });

    const rendered = stubTemplate(activity.render(context));

    expect(rendered.strings.join("")).toContain("<pi-webui-learned-skills-panel");
    expect(rendered.strings.join("")).toContain(".learnedSkillsState=");
    expect(rendered.strings.join("")).toContain(".onRetry=");
    expect(rendered.values).toEqual([context, learnedSkills, retry]);
  });
});
