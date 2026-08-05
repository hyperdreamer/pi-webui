// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TierModelRef } from "../../../../shared/apiTypes";
import { CommandPicker } from "../CommandPicker";
import { SettingsModelPickerField } from "./SettingsModelPickerField";
import type { SettingsModelChoice } from "./settingsModelOptions";

const smallModel: TierModelRef = { provider: "openai", id: "gpt-small" };
const contextModel: TierModelRef = { provider: "anthropic", id: "claude-context" };
const staleModel: TierModelRef = { provider: "retired", id: "model" };

const catalog: SettingsModelChoice[] = [
  { model: smallModel, name: "Small" },
  { model: contextModel, name: "Context" },
];

const INHERIT_LABEL = "Use active session model";

afterEach(() => {
  document.body.replaceChildren();
});

describe("SettingsModelPickerField trigger", () => {
  it("summarizes the selection as provider/id and shows the placeholder when nothing is selected", async () => {
    const field = await mountField((f) => {
      f.choices = catalog;
      f.selected = smallModel;
    });

    expect(triggerText(field)).toBe("openai/gpt-small");

    field.selected = undefined;
    await field.updateComplete;

    expect(triggerText(field)).toBe("Select a model…");
  });

  it("shows the inherited label instead of the placeholder when nothing is selected", async () => {
    const field = await mountField((f) => {
      f.choices = catalog;
      f.inheritedLabel = INHERIT_LABEL;
    });

    expect(triggerText(field)).toBe(INHERIT_LABEL);
  });

  it("keeps a stale configured model visible with an (unavailable) suffix", async () => {
    const field = await mountField((f) => {
      f.choices = catalog;
      f.selected = staleModel;
    });

    expect(triggerText(field)).toBe("retired/model (unavailable)");
  });

  it("reflects invalid and dialog state on the trigger attributes", async () => {
    const field = await mountField((f) => {
      f.choices = catalog;
      f.invalid = true;
    });

    const trigger = triggerButton(field);
    expect(trigger.getAttribute("aria-invalid")).toBe("true");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await openPicker(field);
    expect(triggerButton(field).getAttribute("aria-expanded")).toBe("true");

    closePickerDialog(field);
    await field.updateComplete;
    expect(triggerButton(field).getAttribute("aria-expanded")).toBe("false");
  });

  it("does not open the dialog when disabled", async () => {
    const field = await mountField((f) => {
      f.choices = catalog;
      f.disabled = true;
    });

    triggerButton(field).dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await field.updateComplete;

    expect(field.isPickerOpen).toBe(false);
    expect(pickerRoot(field).querySelector("command-picker")).toBeNull();
  });
});

describe("SettingsModelPickerField dialog", () => {
  it("opens on click with a search input and filters options by typing", async () => {
    const field = await mountField((f) => {
      f.choices = catalog;
    });

    await openPicker(field);

    expect(field.isPickerOpen).toBe(true);
    expect(pickerOptionLabels(field)).toEqual(["claude-context", "gpt-small"]);

    await searchPicker(field, "context");

    expect(pickerOptionLabels(field)).toEqual(["claude-context"]);
  });

  it("reports the picked model through onSelect as a copy and closes the dialog", async () => {
    const onSelect = vi.fn<(model: TierModelRef | undefined) => void>();
    const field = await mountField((f) => {
      f.choices = catalog;
      f.selected = smallModel;
      f.onSelect = onSelect;
    });

    await openPicker(field);
    await clickPickerOption(field, "claude-context");

    const picked = onSelect.mock.calls[0]?.[0];
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(picked).toEqual(contextModel);
    // The caller receives a copy so it cannot mutate the catalog entry.
    expect(picked).not.toBe(contextModel);
    expect(field.isPickerOpen).toBe(false);
  });

  it("reports undefined through onSelect when the inherit entry is picked", async () => {
    const onSelect = vi.fn<(model: TierModelRef | undefined) => void>();
    const field = await mountField((f) => {
      f.choices = catalog;
      f.inheritedLabel = INHERIT_LABEL;
      f.selected = smallModel;
      f.onSelect = onSelect;
    });

    await openPicker(field);
    expect(pickerOptionLabels(field)[0]).toBe(INHERIT_LABEL);

    await clickPickerOption(field, INHERIT_LABEL);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(undefined);
    expect(field.isPickerOpen).toBe(false);
  });

  it("leaves the selection unchanged and returns focus to the trigger when cancelled", async () => {
    const onSelect = vi.fn<(model: TierModelRef | undefined) => void>();
    const field = await mountField((f) => {
      f.choices = catalog;
      f.selected = smallModel;
      f.onSelect = onSelect;
    });

    await openPicker(field);
    closePickerDialog(field);
    await field.updateComplete;

    expect(field.isPickerOpen).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
    expect(field.selected).toEqual(smallModel);
    // document.activeElement retargets to the shadow host, so read the focus
    // from the field's shadow root like the component itself set it.
    expect(pickerRoot(field).activeElement).toBe(triggerButton(field));
  });

  it("exposes a named modal dialog with labelled search and close controls", async () => {
    const field = await mountField((f) => {
      f.choices = catalog;
      f.dialogTitle = "Choose a model";
    });

    await openPicker(field);

    const root = pickerShadow(commandPicker(field));
    const dialog = root.querySelector<HTMLElement>("section[role='dialog']");
    if (dialog === null) throw new Error("Expected the picker dialog");
    const titleId = dialog.getAttribute("aria-labelledby");
    if (titleId === null) throw new Error("Expected the picker dialog to reference its title");

    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(root.getElementById(titleId)?.textContent.trim()).toBe("Choose a model");
    expect(searchInput(field).getAttribute("aria-label")).toBe("Search options");
    expect(pickerCloseButton(field).getAttribute("aria-label")).toBe("Close Choose a model");
  });

  it("contains focus by wrapping Tab at both ends of the dialog", async () => {
    const field = await mountField((f) => {
      f.choices = catalog;
    });
    await openPicker(field);

    const root = pickerShadow(commandPicker(field));
    const close = pickerCloseButton(field);
    const options = [...root.querySelectorAll<HTMLButtonElement>(".options button")];
    const lastOption = options.at(-1);
    if (lastOption === undefined) throw new Error("Expected a final picker option");

    lastOption.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, composed: true });
    lastOption.dispatchEvent(tab);

    expect(tab.defaultPrevented).toBe(true);
    expect(root.activeElement).toBe(close);

    close.focus();
    const shiftTab = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    close.dispatchEvent(shiftTab);

    expect(shiftTab.defaultPrevented).toBe(true);
    expect(root.activeElement).toBe(lastOption);
  });
});

describe("SettingsModelPickerField event containment", () => {
  it("stops the picker's Escape keydown at the component boundary", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const keydownSpy = vi.fn();
    host.addEventListener("keydown", keydownSpy);

    const field = await mountField((f) => {
      f.choices = catalog;
    }, host);
    await openPicker(field);

    // Control: an unrelated keydown does propagate to the ancestor listener.
    searchInput(field).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, composed: true }));
    expect(keydownSpy).toHaveBeenCalledTimes(1);

    searchInput(field).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    await field.updateComplete;

    expect(keydownSpy).toHaveBeenCalledTimes(1);
    // The Escape still did its job inside the component: the dialog closed.
    expect(field.isPickerOpen).toBe(false);
  });

  it("closes on Escape from the focused close button without escaping the component", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const keydownSpy = vi.fn();
    host.addEventListener("keydown", keydownSpy);

    const field = await mountField((f) => {
      f.choices = catalog;
    }, host);
    await openPicker(field);

    const close = pickerCloseButton(field);
    close.focus();
    close.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, composed: true }));
    expect(keydownSpy).toHaveBeenCalledTimes(1);
    keydownSpy.mockClear();

    close.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
      composed: true,
    }));
    await field.updateComplete;

    expect(field.isPickerOpen).toBe(false);
    expect(pickerRoot(field).activeElement).toBe(triggerButton(field));
    expect(keydownSpy).not.toHaveBeenCalled();
  });

  it("stops the picker's backdrop mousedown at the component boundary", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const mousedownSpy = vi.fn();
    host.addEventListener("mousedown", mousedownSpy);

    const field = await mountField((f) => {
      f.choices = catalog;
    }, host);
    await openPicker(field);

    // Control: the ancestor listener observes mousedowns that reach it.
    host.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
    expect(mousedownSpy).toHaveBeenCalledTimes(1);
    mousedownSpy.mockClear();

    const backdrop = pickerShadow(commandPicker(field)).querySelector<HTMLElement>(".backdrop");
    if (backdrop === null) throw new Error("Expected the picker backdrop");
    backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
    await field.updateComplete;

    expect(mousedownSpy).not.toHaveBeenCalled();
    // The backdrop mousedown still did its job inside the component: the dialog closed.
    expect(field.isPickerOpen).toBe(false);
  });
});

async function mountField(
  configure: (field: SettingsModelPickerField) => void,
  host: HTMLElement = document.body,
): Promise<SettingsModelPickerField> {
  const field = new SettingsModelPickerField();
  configure(field);
  host.append(field);
  await field.updateComplete;
  return field;
}

function pickerRoot(field: SettingsModelPickerField): ShadowRoot {
  const root = field.shadowRoot;
  if (root === null) throw new Error("Expected an open shadow root");
  return root;
}

function triggerButton(field: SettingsModelPickerField): HTMLButtonElement {
  const trigger = pickerRoot(field).querySelector<HTMLButtonElement>(".model-trigger");
  if (trigger === null) throw new Error("Expected the model picker trigger");
  return trigger;
}

function triggerText(field: SettingsModelPickerField): string {
  const summary = pickerRoot(field).querySelector(".model-trigger .model-summary");
  if (summary === null) throw new Error("Expected the model picker trigger summary");
  return summary.textContent.trim();
}

function commandPicker(field: SettingsModelPickerField): CommandPicker {
  const picker = pickerRoot(field).querySelector<CommandPicker>("command-picker");
  if (picker === null) throw new Error("Expected the searchable model dialog");
  return picker;
}

function pickerShadow(picker: CommandPicker): ShadowRoot {
  const root = picker.shadowRoot;
  if (root === null) throw new Error("Expected an open picker shadow root");
  return root;
}

async function openPicker(field: SettingsModelPickerField): Promise<void> {
  triggerButton(field).click();
  await field.updateComplete;
  await commandPicker(field).updateComplete;
}

function closePickerDialog(field: SettingsModelPickerField): void {
  pickerCloseButton(field).click();
}

function pickerCloseButton(field: SettingsModelPickerField): HTMLButtonElement {
  const close = pickerShadow(commandPicker(field)).querySelector<HTMLButtonElement>("header button");
  if (close === null) throw new Error("Expected the picker close button");
  return close;
}

function searchInput(field: SettingsModelPickerField): HTMLInputElement {
  const input = pickerShadow(commandPicker(field)).querySelector<HTMLInputElement>("input");
  if (input === null) throw new Error("Expected the model dialog search input");
  return input;
}

async function searchPicker(field: SettingsModelPickerField, query: string): Promise<void> {
  const input = searchInput(field);
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  await commandPicker(field).updateComplete;
}

function pickerOptionLabels(field: SettingsModelPickerField): string[] {
  return [...pickerShadow(commandPicker(field)).querySelectorAll(".options button span")]
    .map((option) => option.textContent.trim());
}

async function clickPickerOption(field: SettingsModelPickerField, label: string): Promise<void> {
  const picker = commandPicker(field);
  const option = [...pickerShadow(picker).querySelectorAll<HTMLButtonElement>(".options button")]
    .find((button) => button.querySelector("span")?.textContent.trim() === label);
  if (option === undefined) throw new Error(`Expected model dialog option ${label}`);
  option.click();
  await picker.updateComplete;
  await field.updateComplete;
}
