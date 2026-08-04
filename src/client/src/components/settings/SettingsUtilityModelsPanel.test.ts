// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TierModelRef, UtilityModelOption, UtilityModelSettingsResponse } from "../../../../shared/apiTypes";
import { templateText } from "../../templateInspection.testSupport";
import { SettingsPanelFrame } from "./SettingsPanelFrame";
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

afterEach(() => {
  document.body.replaceChildren();
});

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

  it("keeps a stale selection disabled and repairs it through the enabled empty option", async () => {
    const onSave = vi.fn();
    const panel = await mountPanel((element) => {
      element.response = response({ settings: { lightweight: staleModel, context: contextModel } });
      element.onSave = onSave;
    });

    const staleKey = JSON.stringify([staleModel.provider, staleModel.id]);
    const lightweightSelect = utilitySelect(panel, "lightweight");
    const staleOption = [...lightweightSelect.options].find((option) => option.value === staleKey);
    const emptyOption = [...lightweightSelect.options].find((option) => option.value === "");
    expect(staleOption?.selected).toBe(true);
    expect(staleOption?.disabled).toBe(true);
    expect(emptyOption?.disabled).toBe(false);
    expect(saveButton(panel).disabled).toBe(true);

    lightweightSelect.value = "";
    lightweightSelect.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await panel.updateComplete;

    expect(utilitySelect(panel, "lightweight").value).toBe("");
    expect(saveButton(panel).disabled).toBe(false);
    saveButton(panel).click();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ lightweight: null, context: contextModel });
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

  it("binds support, loading, saving, stale-validity, and ready states to the rendered controls", async () => {
    const panel = await mountPanel((element) => {
      element.response = response();
    });

    expectRenderedDisabledState(panel, false, false);

    panel.loading = true;
    await panel.updateComplete;
    expectRenderedDisabledState(panel, true, true);

    panel.loading = false;
    panel.saving = true;
    await panel.updateComplete;
    expectRenderedDisabledState(panel, true, true);

    panel.saving = false;
    panel.support = { state: "unsupported", message: "Upgrade required" };
    await panel.updateComplete;
    expectRenderedDisabledState(panel, true, true);

    panel.support = { state: "supported" };
    panel.response = response({ settings: { lightweight: staleModel, context: contextModel } });
    await panel.updateComplete;
    expectRenderedDisabledState(panel, false, true);

    panel.response = response();
    await panel.updateComplete;
    expectRenderedDisabledState(panel, false, false);
  });

  it("passes network, configuration, availability, and success notices to the rendered frame", async () => {
    const panel = await mountPanel((element) => {
      element.response = response({ configError: "Configured utility model is malformed" });
      element.error = "Failed to load utility model settings";
      element.savedMessage = "Config saved.";
      element.support = { state: "unknown", message: "Runtime support is still loading" };
    });
    const frame = settingsFrame(panel);
    await frame.updateComplete;

    expect(frame.notices).toEqual([
      { type: "availability", tone: "warning", content: "Runtime support is still loading" },
      { type: "error", content: "Failed to load utility model settings" },
      { type: "error", title: "Configuration error", content: "Configured utility model is malformed" },
      { type: "success", content: "Config saved." },
    ]);
    const frameRoot = requireShadowRoot(frame);
    expect(frameRoot.querySelectorAll(".notice")).toHaveLength(4);
    expect(frameRoot.textContent).toContain("Runtime support is still loading");
    expect(frameRoot.textContent).toContain("Failed to load utility model settings");
    expect(frameRoot.textContent).toContain("Configured utility model is malformed");
    expect(frameRoot.textContent).toContain("Config saved.");
  });
});

function callWillUpdate(panel: SettingsUtilityModelsPanel, changed = new Map<string, unknown>([["response", undefined]])): void {
  // Simulate Lit's response-driven draft synchronization without a DOM harness.
  const method: unknown = Reflect.get(panel, "willUpdate");
  if (typeof method === "function") Reflect.apply(method, panel, [changed]);
}

async function mountPanel(configure: (panel: SettingsUtilityModelsPanel) => void): Promise<SettingsUtilityModelsPanel> {
  const panel = new SettingsUtilityModelsPanel();
  configure(panel);
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

function utilitySelect(panel: SettingsUtilityModelsPanel, slot: "lightweight" | "context"): HTMLSelectElement {
  const select = requireShadowRoot(panel).querySelector<HTMLSelectElement>(`#select-utility-model-${slot}`);
  if (select === null) throw new Error(`Expected the ${slot} utility model select`);
  return select;
}

function saveButton(panel: SettingsUtilityModelsPanel): HTMLButtonElement {
  const button = requireShadowRoot(panel).querySelector<HTMLButtonElement>("button.primary");
  if (button === null) throw new Error("Expected the utility model Save button");
  return button;
}

function settingsFrame(panel: SettingsUtilityModelsPanel): SettingsPanelFrame {
  const frame = requireShadowRoot(panel).querySelector<SettingsPanelFrame>("settings-panel-frame");
  if (frame === null) throw new Error("Expected the settings panel frame");
  return frame;
}

function requireShadowRoot(element: Element): ShadowRoot {
  const root = element.shadowRoot;
  if (root === null) throw new Error("Expected an open shadow root");
  return root;
}

function expectRenderedDisabledState(panel: SettingsUtilityModelsPanel, selectDisabled: boolean, saveDisabled: boolean): void {
  expect(utilitySelect(panel, "lightweight").disabled).toBe(selectDisabled);
  expect(utilitySelect(panel, "context").disabled).toBe(selectDisabled);
  expect(saveButton(panel).disabled).toBe(saveDisabled);
}
