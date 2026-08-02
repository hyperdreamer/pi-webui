import { describe, expect, it } from "vitest";
import plugin from "./pi-webui-plugin.js";

describe("pi-webui workspace-memory activity-rail plugin", () => {
  it("exports a PiWebUiPlugin object with apiVersion 1", () => {
    expect(plugin.apiVersion).toBe(1);
  });

  it("has a name", () => {
    expect(typeof plugin.name).toBe("string");
    expect(plugin.name.length).toBeGreaterThan(0);
  });

  it("has an activate function", () => {
    expect(typeof plugin.activate).toBe("function");
  });

  describe("activate", () => {
    // Non-browser test stub. Lit's TemplateResult cannot be constructed in
    // a plain Node environment, so we provide callable stubs that return a
    // dummy value and cast the context shape once.
    function stubTag(strings: TemplateStringsArray, ...values: unknown[]) {
      return { _$: "stub", strings, values };
    }

    function getStubbedTemplateMarkup(template: unknown): string {
      if (
        typeof template !== "object"
        || template === null
        || !("strings" in template)
        || !Array.isArray(template.strings)
        || !template.strings.every((part) => typeof part === "string")
      ) {
        throw new Error("Expected a stubbed SVG template");
      }

      return template.strings.join("");
    }

    /* eslint-disable @typescript-eslint/consistent-type-assertions --
       TemplateResult is not constructable in this test env */
    const ctx = {
      apiVersion: 1,
      pluginId: "workspace-memory",
      html: stubTag,
      svg: stubTag,
    } as unknown as Parameters<typeof plugin.activate>[0];
    /* eslint-enable @typescript-eslint/consistent-type-assertions */

    const result = plugin.activate(ctx);

    it("returns contributions", () => {
      expect(result).toHaveProperty("contributions");
    });

    it("contributes exactly one activity-Rail item and no workspace panel", () => {
      expect(result.contributions.workspacePanels).toBeUndefined();
      expect(result.contributions.activityRailItems).toHaveLength(1);
      expect(memoryActivity().id).toBe("workspace.memory");
      expect(memoryActivity()).toMatchObject({
        id: "workspace.memory",
        title: "Memory",
        order: 50,
      });
    });

    it("activity has an outlined brain SVG icon without robot eyes", () => {
      const markup = getStubbedTemplateMarkup(memoryActivity().icon);

      expect(markup).toContain('data-icon="brain"');
      expect(markup).not.toContain("<circle");
    });

    it("activity has a render function", () => {
      expect(typeof memoryActivity().render).toBe("function");
    });

    it("activity declares visible and badge callbacks", () => {
      expect(typeof memoryActivity().visible).toBe("function");
      expect(typeof memoryActivity().badge).toBe("function");
    });

    it("badge returns undefined for loading state", () => {
      const badge = memoryActivity().badge;
      if (typeof badge !== "function") throw new Error("Expected badge function");
      // The context shape matches the core BundledMemoryContext; cast for test.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      expect(badge({ state: { memory: { kind: "loading" } } } as unknown as Parameters<typeof badge>[0])).toBeUndefined();
    });

    it("badge returns a positive number for populated data", () => {
      const badge = memoryActivity().badge;
      if (typeof badge !== "function") throw new Error("Expected badge function");
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      expect(badge({
        state: {
          memory: {
            kind: "data",
            globalEntries: [{ id: "g", content: "global" }],
            projectEntries: [{ id: "p", content: "project" }],
          },
        },
      } as unknown as Parameters<typeof badge>[0])).toBe(2);
    });

    it("hides the activity when no workspace scope is selected", () => {
      const visible = memoryActivity().visible;
      if (typeof visible !== "function") throw new Error("Expected visible function");
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      expect(visible({ state: { memory: { kind: "loading" } } } as unknown as Parameters<typeof visible>[0])).toBe(false);
    });

    it("keeps loading Memory visible only with a workspace scope and hides confirmed unavailability", () => {
      const visible = memoryActivity().visible;
      if (typeof visible !== "function") throw new Error("Expected visible function");
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      expect(visible({
        state: { memory: { kind: "loading" } },
        workspaceScope: {},
      } as unknown as Parameters<typeof visible>[0])).toBe(true);
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      expect(visible({
        state: { memory: { kind: "unavailable" } },
        workspaceScope: {},
      } as unknown as Parameters<typeof visible>[0])).toBe(false);
    });

    function memoryActivity() {
      const activity = result.contributions.activityRailItems?.[0];
      if (activity === undefined) throw new Error("Expected a Memory activity-Rail contribution");
      return activity;
    }
  });
});
