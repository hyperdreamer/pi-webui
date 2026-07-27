import { describe, expect, it } from "vitest";
import plugin from "./pi-webui-plugin.js";

describe("pi-webui workspace-memory plugin", () => {
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
    // Non-browser test stub.  Lit's TemplateResult cannot be constructed in
    // a plain Node environment, so we provide callable stubs that return a
    // dummy value and cast the context shape once.
    function stubTag(strings: TemplateStringsArray, ...values: unknown[]) {
      return { _$: "stub", strings, values };
    }

    function getStubbedTemplateMarkup(template: unknown): string {
      if (
        typeof template !== "object" ||
        template === null ||
        !("strings" in template) ||
        !Array.isArray(template.strings) ||
        !template.strings.every((part) => typeof part === "string")
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

    it("contributes exactly one workspace panel", () => {
      expect(result.contributions.workspacePanels).toHaveLength(1);
    });

    it("panel has correct id", () => {
      expect(result.contributions.workspacePanels?.[0]?.id).toBe("workspace.memory");
    });

    it("panel has title 'Memory'", () => {
      expect(result.contributions.workspacePanels?.[0]?.title).toBe("Memory");
    });

    it("panel has order 50", () => {
      expect(result.contributions.workspacePanels?.[0]?.order).toBe(50);
    });

    it("panel has an outlined brain SVG icon without robot eyes", () => {
      const icon = result.contributions.workspacePanels?.[0]?.icon;
      const markup = getStubbedTemplateMarkup(icon);

      expect(markup).toContain('data-icon="brain"');
      expect(markup).not.toContain("<circle");
    });

    it("panel has a render function", () => {
      expect(typeof result.contributions.workspacePanels?.[0]?.render).toBe("function");
    });
  });
});
