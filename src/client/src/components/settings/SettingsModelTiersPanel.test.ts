import { describe, expect, it, vi } from "vitest";
import type { ModelTierLadder, ModelTierModelOption, ModelTierSettingsResponse, TierModelRef } from "../../../../shared/apiTypes";
import { templateText } from "../../templateInspection.testSupport";
import { SettingsModelTiersPanel } from "./SettingsModelTiersPanel";

const smallModel: TierModelRef = { provider: "openai", id: "gpt-small" };
const largeModel: TierModelRef = { provider: "openai", id: "org/gpt-large/model" };
const staleModel: TierModelRef = { provider: "missing-provider", id: "org/stale/model" };

const smallModelOption: ModelTierModelOption = { model: smallModel, name: "Small", thinkingLevels: ["off"] };
const largeModelOption: ModelTierModelOption = {
  model: largeModel,
  name: "Large",
  thinkingLevels: ["off", "low", "medium", "high", "max"],
};
const models: ModelTierModelOption[] = [smallModelOption, largeModelOption];

function validLadder(): ModelTierLadder {
  return {
    economy: { model: smallModel, thinkingLevel: "off" },
    fast: { model: smallModel, thinkingLevel: "off" },
    standard: { model: largeModel, thinkingLevel: "medium" },
    advanced: { model: largeModel, thinkingLevel: "high" },
    capable: { model: largeModel, thinkingLevel: "max" },
    frontier: { model: largeModel, thinkingLevel: "max" },
  };
}

function validResponse(): ModelTierSettingsResponse {
  return {
    contractVersion: 1,
    ladder: validLadder(),
    models,
    rows: {
      economy: { valid: true },
      fast: { valid: true },
      standard: { valid: true },
      advanced: { valid: true },
      capable: { valid: true },
      frontier: { valid: true },
    },
    valid: true,
  };
}

describe("SettingsModelTiersPanel", () => {
  it("renders six ordered rows with labels Economy through Frontier and step indicators", () => {
    const panel = new SettingsModelTiersPanel();
    panel.response = validResponse();
    callWillUpdate(panel);

    const rendered = templateText(panel.render());
    expect(rendered).toContain("Model tiers");
    expect(rendered).toContain("Economy");
    expect(rendered).toContain("Fast");
    expect(rendered).toContain("Standard");
    expect(rendered).toContain("Advanced");
    expect(rendered).toContain("Capable");
    expect(rendered).toContain("Frontier");
    expect(rendered).toContain("1");
    expect(rendered).toContain("6");
  });

  it("assigns header cells to the same named grid areas as tier rows", () => {
    const styles = SettingsModelTiersPanel.styles.cssText;

    expect(styles).toMatch(/\.table-header\s*\{[^}]*grid-template-areas:\s*"step tier model thinking";/);
    expect(styles).toMatch(/\.tier-row\s*\{[^}]*grid-template-areas:\s*"step tier model thinking";/);
  });

  it("populates model options and thinking levels for valid response", () => {
    const panel = new SettingsModelTiersPanel();
    panel.response = validResponse();
    callWillUpdate(panel);

    const template = panel.render();
    const rendered = templateText(template);

    expect(rendered).toContain("Small (openai/gpt-small)");
    expect(rendered).toContain("Large (openai/org/gpt-large/model)");
  });

  it("shows an unavailable configured model as selected stale value with invalid state", () => {
    const panel = new SettingsModelTiersPanel();
    const ladder = validLadder();
    ladder.economy = { model: staleModel, thinkingLevel: "off" };
    panel.response = {
      ...validResponse(),
      ladder,
    };
    callWillUpdate(panel);

    const rendered = templateText(panel.render());
    expect(rendered).toContain("missing-provider/org/stale/model (unavailable)");
    expect(rendered).toContain("tier economy names unavailable model missing-provider/org/stale/model");

    expect(panel.canSave).toBe(false);
  });

  it("clears incompatible thinking value when model changes and disables save until thinking is reselected", () => {
    const panel = new SettingsModelTiersPanel();
    panel.response = validResponse();
    callWillUpdate(panel);

    expect(panel.canSave).toBe(true);

    // Change standard tier to smallModel (which only supports "off")
    // Standard was medium thinking level
    panel.handleModelChange("standard", smallModelOption);

    // Thinking level should clear, row invalid
    expect(panel.draft.standard.model).toEqual(smallModel);
    expect(panel.draft.standard.thinkingLevel).toBe("");
    expect(panel.canSave).toBe(false);

    // Select valid thinking level
    panel.handleThinkingChange("standard", "off");

    expect(panel.draft.standard.thinkingLevel).toBe("off");
    expect(panel.canSave).toBe(true);
  });

  it("disables Save for invalid ladder and enables Save for valid ladder", () => {
    const panel = new SettingsModelTiersPanel();
    panel.response = validResponse();
    callWillUpdate(panel);

    expect(panel.canSave).toBe(true);

    panel.handleThinkingChange("economy", "");
    expect(panel.canSave).toBe(false);
  });

  it("emits exactly one complete ladder to onSave when save action is invoked", () => {
    const panel = new SettingsModelTiersPanel();
    const onSave = vi.fn();
    panel.onSave = onSave;
    panel.response = validResponse();
    callWillUpdate(panel);

    panel.handleSave();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(validLadder());
  });

  it("invokes reload callback and displays server and config errors in notice region while draft is preserved", () => {
    const panel = new SettingsModelTiersPanel();
    const onReload = vi.fn();
    panel.onReload = onReload;
    panel.response = {
      ...validResponse(),
      configError: "Invalid tier config detected in settings.json",
    };
    panel.error = "Failed to connect to gateway";
    callWillUpdate(panel);

    panel.handleReload();
    expect(onReload).toHaveBeenCalledTimes(1);

    const notices = panel.panelNotices();
    expect(notices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "error", content: "Failed to connect to gateway" }),
        expect.objectContaining({ type: "error", title: "Configuration error", content: "Invalid tier config detected in settings.json" }),
      ]),
    );

    // Modify standard thinking level
    panel.handleThinkingChange("standard", "low");

    // Updating error shouldn't wipe user draft
    panel.error = "Another error";
    callWillUpdate(panel, new Map([["error", "Failed to connect to gateway"]]));

    expect(panel.draft.standard.thinkingLevel).toBe("low");
  });

  it("renders upgrade/unavailable message and disables editing when support state is unsupported", () => {
    const panel = new SettingsModelTiersPanel();
    panel.response = validResponse();
    panel.support = {
      state: "unsupported",
      message: "Model tier configuration is unavailable on Lab Mac. Update and restart Pi-Web on that machine, then try again.",
    };
    callWillUpdate(panel);

    const notices = panel.panelNotices();
    expect(notices).toEqual([
      {
        type: "availability",
        tone: "error",
        content: "Model tier configuration is unavailable on Lab Mac. Update and restart Pi-Web on that machine, then try again.",
      },
    ]);
    expect(panel.canSave).toBe(false);
  });
});

function callWillUpdate(panel: SettingsModelTiersPanel, changed = new Map<string, unknown>([["response", undefined]])): void {
  // Simulate Lit willUpdate lifecycle
  const method: unknown = Reflect.get(panel, "willUpdate");
  if (typeof method === "function") {
    Reflect.apply(method, panel, [changed]);
  }
}
