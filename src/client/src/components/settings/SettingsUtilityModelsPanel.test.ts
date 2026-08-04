import { describe, expect, it, vi } from "vitest";
import type { TierModelRef, UtilityModelOption, UtilityModelSettingsResponse } from "../../../../shared/apiTypes";
import { templateText } from "../../templateInspection.testSupport";
import { SettingsUtilityModelsPanel } from "./SettingsUtilityModelsPanel";

const smallModel: TierModelRef = { provider: "openai", id: "gpt-small" };
const contextModel: TierModelRef = { provider: "anthropic", id: "claude-context" };
const staleModel: TierModelRef = { provider: "retired", id: "model" };

const models: UtilityModelOption[] = [
  { model: smallModel, name: "Small" },
  { model: contextModel, name: "Context" },
];

function response(overrides: Partial<UtilityModelSettingsResponse> = {}): UtilityModelSettingsResponse {
  return {
    contractVersion: 1,
    settings: { lightweight: smallModel, context: contextModel },
    models,
    slots: {
      lightweight: { valid: true },
      context: { valid: true },
    },
    valid: true,
    ...overrides,
  };
}

describe("SettingsUtilityModelsPanel", () => {
  it("renders two labeled utility model rows with task-specific copy", () => {
    const panel = new SettingsUtilityModelsPanel();
    panel.response = response();
    callWillUpdate(panel);

    const rendered = templateText(panel.render());
    expect(rendered).toContain("Utility models");
    expect((rendered.match(/class="field-row/g) ?? []).length).toBe(2);
    expect(rendered).toContain("Lightweight");
    expect(rendered).toContain("Titles and branch summaries");
    expect(rendered).toContain("Context");
    expect(rendered).toContain("Compaction and context summaries");
  });

  it("renders each empty slot's fallback behavior", () => {
    const panel = new SettingsUtilityModelsPanel();
    panel.response = response({ settings: {} });
    callWillUpdate(panel);

    const rendered = templateText(panel.render());
    expect(rendered).toContain("Use active session model");
    expect(rendered).toContain("Use lightweight, then active session model");
  });

  it("shows names and unambiguous provider/id values for catalog models", () => {
    const panel = new SettingsUtilityModelsPanel();
    panel.response = response({
      models: [
        { model: { provider: "provider-a", id: "same-id" }, name: "Provider A" },
        { model: { provider: "provider-b", id: "same-id" }, name: "Provider B" },
      ],
      settings: {},
    });
    callWillUpdate(panel);

    const rendered = templateText(panel.render());
    expect(rendered).toContain("Provider A (provider-a/same-id)");
    expect(rendered).toContain("Provider B (provider-b/same-id)");
    expect(rendered).toContain(JSON.stringify(["provider-a", "same-id"]));
    expect(rendered).toContain(JSON.stringify(["provider-b", "same-id"]));
  });

  it("keeps a stale selection visible and blocks save until it is repaired", () => {
    const panel = new SettingsUtilityModelsPanel();
    panel.response = response({ settings: { lightweight: staleModel, context: contextModel } });
    callWillUpdate(panel);

    const rendered = templateText(panel.render());
    expect(rendered).toContain("retired/model (unavailable)");
    expect(panel.canSave).toBe(false);
  });

  it("sends one explicit empty decision when both utility models are cleared", () => {
    const panel = new SettingsUtilityModelsPanel();
    const onSave = vi.fn();
    panel.onSave = onSave;
    panel.response = response();
    callWillUpdate(panel);

    panel.handleModelChange("lightweight", undefined);
    panel.handleModelChange("context", undefined);
    panel.handleSave();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ lightweight: null, context: null });
  });

  it("disables editing and save while support is unavailable, loading, or saving", () => {
    const panel = new SettingsUtilityModelsPanel();
    panel.response = response();
    callWillUpdate(panel);

    expect(panel.canSave).toBe(true);
    expect(panel.editingDisabled).toBe(false);

    panel.loading = true;
    expect(panel.canSave).toBe(false);
    expect(panel.editingDisabled).toBe(true);

    panel.loading = false;
    panel.saving = true;
    expect(panel.canSave).toBe(false);
    expect(panel.editingDisabled).toBe(true);

    panel.saving = false;
    panel.support = { state: "unsupported", message: "Upgrade required" };
    expect(panel.canSave).toBe(false);
    expect(panel.editingDisabled).toBe(true);
  });

  it("passes network, configuration, availability, and success notices through SettingsPanelFrame", () => {
    const panel = new SettingsUtilityModelsPanel();
    panel.response = response({ configError: "Configured utility model is malformed" });
    panel.error = "Failed to load utility model settings";
    panel.savedMessage = "Config saved.";
    panel.support = { state: "unknown", message: "Runtime support is still loading" };
    callWillUpdate(panel);

    expect(templateText(panel.render())).toContain("settings-panel-frame");
    expect(panel.panelNotices()).toEqual([
      { type: "availability", tone: "warning", content: "Runtime support is still loading" },
      { type: "error", content: "Failed to load utility model settings" },
      { type: "error", title: "Configuration error", content: "Configured utility model is malformed" },
      { type: "success", content: "Config saved." },
    ]);
  });
});

function callWillUpdate(panel: SettingsUtilityModelsPanel, changed = new Map<string, unknown>([["response", undefined]])): void {
  // Simulate Lit's response-driven draft synchronization without a DOM harness.
  const method: unknown = Reflect.get(panel, "willUpdate");
  if (typeof method === "function") Reflect.apply(method, panel, [changed]);
}
