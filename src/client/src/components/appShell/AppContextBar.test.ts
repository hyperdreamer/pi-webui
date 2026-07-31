import { describe, expect, it, vi } from "vitest";
import type { Machine } from "../../api";
import { templateClickHandlerForText, templateText } from "../../templateInspection.testSupport";
import { AppContextBar, shouldShowMachineContext } from "./AppContextBar";

describe("shouldShowMachineContext", () => {
  it("hides the machine crumb when there is no machine choice", () => {
    expect(shouldShowMachineContext([])).toBe(false);
    expect(shouldShowMachineContext([machine("local")])).toBe(false);
  });

  it("shows the machine crumb when multiple machines exist", () => {
    expect(shouldShowMachineContext([machine("local"), machine("remote-a")])).toBe(true);
  });
});

describe("AppContextBar activity rail launcher", () => {
  it("invokes the activity rail callback from its labelled launcher", () => {
    const contextBar = new AppContextBar();
    const onToggleActivityRail = vi.fn();
    contextBar.onToggleActivityRail = onToggleActivityRail;

    const template = contextBar.render();
    expect(templateText(template)).toContain('aria-label="Open activity rail"');
    // The node test environment has no DOM; this narrowly exercises the labelled
    // public template callback rather than a component implementation detail.
    templateClickHandlerForText(template, "Open activity rail")(new Event("click"));

    expect(onToggleActivityRail).toHaveBeenCalledOnce();
  });

  it("labels the launcher to close an open activity rail", () => {
    const contextBar = new AppContextBar();
    contextBar.onToggleActivityRail = vi.fn();
    contextBar.activityRailOpen = true;

    expect(templateText(contextBar.render())).toContain('aria-label="Close activity rail"');
  });
});

function machine(id: string): Machine {
  return {
    id,
    name: id,
    kind: id === "local" ? "local" : "remote",
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}
