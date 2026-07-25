import { describe, expect, it, vi } from "vitest";
import type { Machine } from "../../api";
import { templateText, templateValueAfterMarker } from "../../templateInspection.testSupport";
import { AppNavigationPanel, NAVIGATION_RESOURCE_UNDERBAR_ITEMS, navigationResourceUnderbarItemIsEnabled, shouldShowMachinesSection } from "./AppNavigationPanel";

describe("app-navigation-panel wordmark", () => {
  it("renders a large pi symbol beside the WebUI name", () => {
    const markup = templateText(new AppNavigationPanel().render());

    expect(markup).toContain('class="brand" aria-label="Pi WebUI"');
    expect(markup).toContain('class="brand-symbol" aria-hidden="true">π</span>');
    expect(markup).toContain(">WebUI</span>");
    expect(markup).not.toContain(">PI WEBUI<");
    expect(AppNavigationPanel.styles.cssText).toMatch(/\.brand-symbol\s*\{[^}]*font-size:\s*28px;/);
  });
});

describe("app-navigation-panel resource underbar", () => {
  it("defines the static Models, Skills, and Plugins controls in display order", () => {
    expect(NAVIGATION_RESOURCE_UNDERBAR_ITEMS).toEqual([
      { id: "models", label: "Models" },
      { id: "skills", label: "Skills" },
      { id: "plugins", label: "Plugins" },
    ]);
    expect(AppNavigationPanel.styles.cssText).toMatch(/grid-template-columns:\s*repeat\(3,/);
  });

  it("keeps the resource underbar pinned when Sessions is collapsed", () => {
    expect(AppNavigationPanel.styles.cssText).toMatch(/\.resource-underbar\s*\{[^}]*margin-top:\s*auto;/);
  });

  it("enables Models and enables workspace-scoped Skills and Plugins", () => {
    expect(navigationResourceUnderbarItemIsEnabled("models", false)).toBe(true);
    expect(navigationResourceUnderbarItemIsEnabled("skills", true)).toBe(true);
    expect(navigationResourceUnderbarItemIsEnabled("skills", false)).toBe(false);
    expect(navigationResourceUnderbarItemIsEnabled("plugins", true)).toBe(true);
    expect(navigationResourceUnderbarItemIsEnabled("plugins", false)).toBe(false);
  });

});

describe("app-navigation-panel project creation", () => {
  // The Node test environment has no DOM harness, so inspect the custom-element
  // callback boundary rather than testing Lit internals or layout.
  it("forwards the Projects section add action to the application", () => {
    const panel = new AppNavigationPanel();
    const onAddProject = vi.fn();
    panel.onAddProject = onAddProject;

    const onAdd = templateValueAfterMarker(panel.render(), ".onAdd=");
    if (!isCallback(onAdd)) throw new Error("Expected ProjectList add callback");
    onAdd();

    expect(onAddProject).toHaveBeenCalledOnce();
  });
});

describe("shouldShowMachinesSection", () => {
  it("hides machine navigation when there is no machine choice", () => {
    expect(shouldShowMachinesSection([])).toBe(false);
    expect(shouldShowMachinesSection([machine("local")])).toBe(false);
  });

  it("shows machine navigation when there are multiple machines", () => {
    expect(shouldShowMachinesSection([machine("local"), machine("remote-a")])).toBe(true);
  });
});

function isCallback(value: unknown): value is () => void {
  return typeof value === "function";
}

function machine(id: string): Machine {
  return {
    id,
    name: id,
    kind: id === "local" ? "local" : "remote",
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}
