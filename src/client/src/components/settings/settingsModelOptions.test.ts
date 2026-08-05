import { describe, expect, it } from "vitest";
import {
  INHERITED_SETTINGS_MODEL_VALUE,
  describeSettingsModel,
  settingsModelChoiceByKey,
  settingsModelKey,
  settingsModelPickerOptions,
} from "./settingsModelOptions";
import type { SettingsModelChoice } from "./settingsModelOptions";

describe("settingsModelPickerOptions", () => {
  it("sorts by provider then model id so each provider's entries are contiguous", () => {
    const choices: SettingsModelChoice[] = [
      { model: { provider: "openai", id: "gpt-5" }, name: "GPT-5" },
      { model: { provider: "anthropic", id: "claude-opus" } },
      { model: { provider: "google", id: "gemini-2.5-pro" }, name: "Gemini 2.5 Pro" },
      { model: { provider: "openai", id: "gpt-4o" }, name: "GPT-4o" },
    ];

    const options = settingsModelPickerOptions(choices);

    expect(options.map((option) => option.label)).toEqual([
      "claude-opus",
      "gemini-2.5-pro",
      "gpt-4o",
      "gpt-5",
    ]);
    expect(options.map((option) => option.group)).toEqual([
      "anthropic",
      "google",
      "openai",
      "openai",
    ]);
    expect(new Set(options.map((option) => option.group)).size).toBe(3);
  });

  it("labels options with the bare model id and groups them by provider", () => {
    const model = { provider: "anthropic", id: "claude-opus" };
    const choices: SettingsModelChoice[] = [{ model, name: "Claude Opus" }];

    const [option] = settingsModelPickerOptions(choices);

    expect(option).toMatchObject({ label: "claude-opus", group: "anthropic" });
    expect(option?.value).toBe(settingsModelKey(model));
  });

  it("carries the display name as the description only when it adds information", () => {
    const choices: SettingsModelChoice[] = [
      { model: { provider: "anthropic", id: "claude-opus" }, name: "Claude Opus" },
      { model: { provider: "openai", id: "gpt-4o" } },
      { model: { provider: "openai", id: "gpt-5" }, name: "" },
      { model: { provider: "google", id: "gemini" }, name: "gemini" },
    ];

    const options = settingsModelPickerOptions(choices);
    const [claudeOpus, gemini, gpt4o, gpt5] = options;

    expect(claudeOpus?.description).toBe("Claude Opus");
    expect(gemini?.description).toBeUndefined();
    expect(gpt4o?.description).toBeUndefined();
    expect(gpt5?.description).toBeUndefined();
  });

  it("omits the group when the provider is the empty string", () => {
    const choices: SettingsModelChoice[] = [
      { model: { provider: "", id: "bare-model" } },
    ];

    const [option] = settingsModelPickerOptions(choices);

    expect(option?.group).toBeUndefined();
    expect(option).toMatchObject({ label: "bare-model" });
  });

  it("prepends the inherited entry with the inherited value when supplied", () => {
    const choices: SettingsModelChoice[] = [
      { model: { provider: "anthropic", id: "claude-opus" } },
    ];

    const withInherited = settingsModelPickerOptions(choices, { label: "Inherited" });

    expect(withInherited[0]).toEqual({
      value: INHERITED_SETTINGS_MODEL_VALUE,
      label: "Inherited",
    });
    expect(withInherited[1]).toMatchObject({ group: "anthropic" });

    const withoutInherited = settingsModelPickerOptions(choices);
    expect(withoutInherited.some((option) => option.value === INHERITED_SETTINGS_MODEL_VALUE)).toBe(false);
  });
});

describe("settingsModelKey", () => {
  it("distinguishes models that collide under naive string concatenation", () => {
    const slashAmbiguity = settingsModelKey({ provider: "a", id: "b/c" });
    const slashProvider = settingsModelKey({ provider: "a/b", id: "c" });
    expect(slashAmbiguity).not.toBe(slashProvider);

    const colonAmbiguity = settingsModelKey({ provider: "a", id: "b:c" });
    const colonProvider = settingsModelKey({ provider: "a:b", id: "c" });
    expect(colonAmbiguity).not.toBe(colonProvider);

    const slashVsColon = settingsModelKey({ provider: "a", id: "b:c" });
    expect(slashVsColon).not.toBe(settingsModelKey({ provider: "a", id: "b/c" }));
  });
});

describe("settingsModelChoiceByKey", () => {
  it("round-trips a key produced by settingsModelKey", () => {
    const choices: SettingsModelChoice[] = [
      { model: { provider: "a", id: "b:c" }, name: "Colliding" },
      { model: { provider: "a:b", id: "c" } },
    ];

    expect(settingsModelChoiceByKey(choices, settingsModelKey({ provider: "a", id: "b:c" }))).toEqual(choices[0]);
    expect(settingsModelChoiceByKey(choices, settingsModelKey({ provider: "a:b", id: "c" }))).toEqual(choices[1]);
  });

  it("returns undefined for a key that is not present", () => {
    const choices: SettingsModelChoice[] = [
      { model: { provider: "anthropic", id: "claude-opus" } },
    ];

    expect(settingsModelChoiceByKey(choices, settingsModelKey({ provider: "openai", id: "gpt-5" }))).toBeUndefined();
  });
});

describe("describeSettingsModel", () => {
  it("renders provider/id", () => {
    expect(describeSettingsModel({ provider: "anthropic", id: "claude-opus" })).toBe("anthropic/claude-opus");
    expect(describeSettingsModel({ provider: "", id: "bare-model" })).toBe("/bare-model");
  });
});
