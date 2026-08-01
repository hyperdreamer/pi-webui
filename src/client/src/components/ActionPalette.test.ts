import { describe, expect, it } from "vitest";
import type { AppAction } from "../actions";
import { closesActionPaletteAfterRun } from "../actions";
import { filterActionPaletteActions } from "./ActionPalette";

describe("filterActionPaletteActions", () => {
  it("keeps disabled actions visible when they have an explanation", () => {
    const actions: AppAction[] = [
      action("enabled", "Enabled action"),
      action("hidden", "Disabled without reason", { enabled: false }),
      action("explained", "Disabled with reason", { enabled: false, disabledReason: "Update and restart the selected machine." }),
    ];

    expect(filterActionPaletteActions(actions, "").map((item) => item.id)).toEqual(["enabled", "explained"]);
  });

  it("matches disabled reasons in search", () => {
    const actions: AppAction[] = [
      action("cleanup", "Clean Up Sessions", { enabled: false, disabledReason: "Selected server does not support cleanup." }),
    ];

    expect(filterActionPaletteActions(actions, "support cleanup").map((item) => item.id)).toEqual(["cleanup"]);
  });
});

describe("closesActionPaletteAfterRun", () => {
  it("keeps the palette open for actions that do not opt in", () => {
    expect(closesActionPaletteAfterRun(action("refresh", "Refresh Files"))).toBe(false);
  });

  it("closes the palette when the action opts in", () => {
    expect(closesActionPaletteAfterRun(action("focus", "Focus Prompt", { closesActionPalette: true }))).toBe(true);
  });

  it("keeps the palette open when the action opts out explicitly", () => {
    expect(closesActionPaletteAfterRun(action("toggle", "Hide Info Tab", { closesActionPalette: false }))).toBe(false);
  });
});

function action(id: string, title: string, patch: Partial<AppAction> = {}): AppAction {
  return { id, title, run: () => undefined, ...patch };
}
