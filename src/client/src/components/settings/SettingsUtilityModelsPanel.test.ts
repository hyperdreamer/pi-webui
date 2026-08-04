// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TierModelRef,
  UtilityModelOptionV1,
  UtilityModelOptionV2,
  UtilityModelSettingsResponseV1,
  UtilityModelSettingsResponseV2,
} from "../../../../shared/apiTypes";
import { SettingsPanelFrame } from "./SettingsPanelFrame";
import { SettingsUtilityModelsPanel } from "./SettingsUtilityModelsPanel";

const smallModel: TierModelRef = { provider: "openai", id: "gpt-small" };
const contextModel: TierModelRef = { provider: "anthropic", id: "claude-context" };
const staleModel: TierModelRef = { provider: "retired", id: "model" };

function v2Models(): UtilityModelOptionV2[] {
  return [
    {
      model: { ...smallModel },
      name: "Small",
      thinkingLevels: ["max", "high", "off", "xhigh", "medium", "low", "minimal"],
    },
    {
      model: { ...contextModel },
      name: "Context",
      thinkingLevels: ["medium", "off", "low"],
    },
  ];
}

function v1Models(): UtilityModelOptionV1[] {
  return v2Models().map((option) => ({
    model: option.model,
    ...(option.name === undefined ? {} : { name: option.name }),
  }));
}

function v2ModelsWithLightweightLevels(
  thinkingLevels: UtilityModelOptionV2["thinkingLevels"],
): UtilityModelOptionV2[] {
  return v2Models().map((option) => (
    option.model.provider === smallModel.provider && option.model.id === smallModel.id
      ? { ...option, thinkingLevels }
      : option
  ));
}

function responseV2(overrides: Partial<UtilityModelSettingsResponseV2> = {}): UtilityModelSettingsResponseV2 {
  return {
    contractVersion: 2,
    settings: {
      lightweight: { ...smallModel, thinkingLevel: "high" },
      context: { ...contextModel, thinkingLevel: "medium" },
    },
    models: v2Models(),
    slots: {
      lightweight: { valid: true },
      context: { valid: true },
    },
    valid: true,
    ...overrides,
  };
}

function responseV1(overrides: Partial<UtilityModelSettingsResponseV1> = {}): UtilityModelSettingsResponseV1 {
  return {
    contractVersion: 1,
    settings: {
      lightweight: { ...smallModel },
      context: { ...contextModel },
    },
    models: v1Models(),
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
  it("renders stable Model and Thinking controls for both utility rows", async () => {
    const panel = await mountPanel((element) => {
      element.response = responseV2();
    });
    const root = requireShadowRoot(panel);
    const header = root.querySelector(".field-header");
    if (header === null) throw new Error("Expected the utility model field header");

    expect(header.getAttribute("aria-hidden")).toBe("true");
    expect(header.textContent).toContain("Model");
    expect(header.textContent).toContain("Thinking");
    expect(root.querySelectorAll(".field-row")).toHaveLength(2);

    for (const slot of ["lightweight", "context"] as const) {
      const model = modelSelect(panel, slot);
      const thinking = thinkingSelect(panel, slot);
      expect(model.id).toBe(`select-utility-model-${slot}`);
      expect(thinking.id).toBe(`select-utility-thinking-${slot}`);
      expect(model.getAttribute("aria-label")).toBe(`${slot} utility model`);
      expect(thinking.getAttribute("aria-label")).toBe(`${slot} utility thinking`);
      expect(labelFor(panel, model.id).textContent.trim()).toBe("Model");
      expect(labelFor(panel, thinking.id).textContent.trim()).toBe("Thinking");
    }
  });

  it("renders selected-model thinking options in canonical order", async () => {
    const panel = await mountPanel((element) => {
      element.response = responseV2();
    });

    expect(optionValues(thinkingSelect(panel, "lightweight"))).toEqual([
      "auto",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(optionValues(thinkingSelect(panel, "context"))).toEqual(["auto", "off", "low", "medium"]);
  });

  it("disables the auto thinking control when no model is selected", async () => {
    const panel = await mountPanel((element) => {
      element.response = responseV2({ settings: {} });
    });

    const thinking = thinkingSelect(panel, "lightweight");
    expect(thinking.disabled).toBe(true);
    expect(thinking.value).toBe("auto");
    expect(optionValues(thinking)).toEqual(["auto"]);
  });

  it("clears explicit thinking when a model changes and omits it from the complete save", async () => {
    const onSave = vi.fn();
    const panel = await mountPanel((element) => {
      element.response = responseV2();
      element.onSave = onSave;
    });

    selectValue(modelSelect(panel, "lightweight"), modelKey(contextModel));
    await panel.updateComplete;

    expect(thinkingSelect(panel, "lightweight").value).toBe("auto");
    saveButton(panel).click();
    expect(onSave).toHaveBeenCalledWith({
      lightweight: { ...contextModel },
      context: { ...contextModel, thinkingLevel: "medium" },
    });
  });

  it("saves an explicit max level while preserving the other complete slot decision", async () => {
    const onSave = vi.fn();
    const panel = await mountPanel((element) => {
      element.response = responseV2();
      element.onSave = onSave;
    });

    selectValue(thinkingSelect(panel, "lightweight"), "max");
    await panel.updateComplete;
    saveButton(panel).click();

    expect(onSave).toHaveBeenCalledWith({
      lightweight: { ...smallModel, thinkingLevel: "max" },
      context: { ...contextModel, thinkingLevel: "medium" },
    });
  });

  it("keeps an unsupported saved level selected and enables auto repair", async () => {
    const models = v2ModelsWithLightweightLevels(["low", "off"]);
    const panel = await mountPanel((element) => {
      element.response = responseV2({
        settings: {
          lightweight: { ...smallModel, thinkingLevel: "max" },
          context: { ...contextModel, thinkingLevel: "medium" },
        },
        models,
      });
    });

    const thinking = thinkingSelect(panel, "lightweight");
    const unavailable = optionByValue(thinking, "max");
    const automatic = optionByValue(thinking, "auto");
    expect(thinking.value).toBe("max");
    expect(unavailable.textContent.trim()).toBe("max (unavailable)");
    expect(unavailable.disabled).toBe(true);
    expect(unavailable.selected).toBe(true);
    expect(automatic.disabled).toBe(false);
    expect(thinking.getAttribute("aria-invalid")).toBe("true");
    expect(saveButton(panel).disabled).toBe(true);

    selectValue(thinking, "auto");
    await panel.updateComplete;
    expect(thinkingSelect(panel, "lightweight").value).toBe("auto");
    expect(saveButton(panel).disabled).toBe(false);
  });

  it("disables only the controls that cannot repair loading, saving, stale, and unsupported states", async () => {
    const panel = await mountPanel((element) => {
      element.response = responseV2();
    });

    expectControlState(panel, { model: false, thinking: false, save: false });

    panel.loading = true;
    await panel.updateComplete;
    expectControlState(panel, { model: true, thinking: true, save: true });

    panel.loading = false;
    panel.saving = true;
    await panel.updateComplete;
    expectControlState(panel, { model: true, thinking: true, save: true });

    panel.saving = false;
    panel.response = responseV2({
      settings: { lightweight: { ...staleModel }, context: { ...contextModel, thinkingLevel: "medium" } },
    });
    await panel.updateComplete;
    expect(modelSelect(panel, "lightweight").disabled).toBe(false);
    expect(modelSelect(panel, "context").disabled).toBe(false);
    expect(thinkingSelect(panel, "lightweight").disabled).toBe(true);
    expect(thinkingSelect(panel, "context").disabled).toBe(false);
    expect(saveButton(panel).disabled).toBe(true);

    const models = v2ModelsWithLightweightLevels(["off"]);
    panel.response = responseV2({
      settings: {
        lightweight: { ...smallModel, thinkingLevel: "max" },
        context: { ...contextModel, thinkingLevel: "medium" },
      },
      models,
    });
    await panel.updateComplete;
    expectControlState(panel, { model: false, thinking: false, save: true });

    panel.support = { state: "unsupported", message: "Upgrade required" };
    await panel.updateComplete;
    expectControlState(panel, { model: true, thinking: true, save: true });
  });

  it("keeps version 1 model routing usable while displaying the required upgrade notice", async () => {
    const onSave = vi.fn();
    const panel = await mountPanel((element) => {
      element.response = responseV1();
      element.targetLabel = "Lab Mac (remote machine)";
      element.onSave = onSave;
    });

    const frame = settingsFrame(panel);
    await frame.updateComplete;
    expect(frame.notices).toContainEqual({
      type: "info",
      content: "Explicit thinking levels require a newer PI WEBUI runtime on Lab Mac (remote machine). Model routing remains available.",
    });
    expect(modelSelect(panel, "lightweight").disabled).toBe(false);
    expect(thinkingSelect(panel, "lightweight").disabled).toBe(true);
    expect(optionValues(thinkingSelect(panel, "lightweight"))).toEqual(["auto"]);

    selectValue(modelSelect(panel, "lightweight"), modelKey(contextModel));
    await panel.updateComplete;
    selectValue(modelSelect(panel, "context"), "");
    await panel.updateComplete;
    expect(saveButton(panel).disabled).toBe(false);
    saveButton(panel).click();
    expect(onSave).toHaveBeenCalledWith({ lightweight: { ...contextModel }, context: null });
  });

  it("passes network, configuration, availability, and success notices to the rendered frame", async () => {
    const panel = await mountPanel((element) => {
      element.response = responseV2({ configError: "Configured utility model is malformed" });
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
  });
});

async function mountPanel(configure: (panel: SettingsUtilityModelsPanel) => void): Promise<SettingsUtilityModelsPanel> {
  const panel = new SettingsUtilityModelsPanel();
  configure(panel);
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

function modelSelect(panel: SettingsUtilityModelsPanel, slot: "lightweight" | "context"): HTMLSelectElement {
  return selectById(panel, `select-utility-model-${slot}`);
}

function thinkingSelect(panel: SettingsUtilityModelsPanel, slot: "lightweight" | "context"): HTMLSelectElement {
  return selectById(panel, `select-utility-thinking-${slot}`);
}

function selectById(panel: SettingsUtilityModelsPanel, id: string): HTMLSelectElement {
  const select = requireShadowRoot(panel).querySelector<HTMLSelectElement>(`#${id}`);
  if (select === null) throw new Error(`Expected select #${id}`);
  return select;
}

function labelFor(panel: SettingsUtilityModelsPanel, id: string): HTMLLabelElement {
  const label = requireShadowRoot(panel).querySelector<HTMLLabelElement>(`label[for="${id}"]`);
  if (label === null) throw new Error(`Expected label for #${id}`);
  return label;
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

function selectValue(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

function modelKey(model: TierModelRef): string {
  return JSON.stringify([model.provider, model.id]);
}

function optionValues(select: HTMLSelectElement): string[] {
  return [...select.options].map((option) => option.value);
}

function optionByValue(select: HTMLSelectElement, value: string): HTMLOptionElement {
  const option = [...select.options].find((candidate) => candidate.value === value);
  if (option === undefined) throw new Error(`Expected option ${value}`);
  return option;
}

function expectControlState(
  panel: SettingsUtilityModelsPanel,
  expected: { model: boolean; thinking: boolean; save: boolean },
): void {
  for (const slot of ["lightweight", "context"] as const) {
    expect(modelSelect(panel, slot).disabled).toBe(expected.model);
    expect(thinkingSelect(panel, slot).disabled).toBe(expected.thinking);
  }
  expect(saveButton(panel).disabled).toBe(expected.save);
}
