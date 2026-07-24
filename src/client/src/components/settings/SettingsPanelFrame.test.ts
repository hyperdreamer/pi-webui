import { html, type TemplateResult } from "lit";
import { describe, expect, it } from "vitest";
import { SettingsPanelFrame, settingsNoticeTone, type SettingsNotice } from "./SettingsPanelFrame";

describe("settings-panel-frame", () => {
  it("renders header, ordered notices, and settings content in the shared order", () => {
    const frame = new SettingsPanelFrame();
    frame.heading = "Pi packages";
    frame.description = "Manage packages on Lab Mac.";
    frame.actionLabel = "Reload";
    frame.notices = [
      { type: "availability", title: "Unavailable", content: "Package management is unavailable." },
      { type: "success", content: "Saved package settings." },
      { type: "security", content: html`<strong>Trusted code warning:</strong> Install packages only from sources you trust.` },
    ];

    const rendered = flattenTemplateContent(frame.render());

    expectTextOrder(rendered, [
      "Pi packages",
      "Manage packages on Lab Mac.",
      "Reload",
      "Unavailable",
      "Package management is unavailable.",
      "Saved package settings.",
      "Trusted code warning:",
    ]);
    expect(rendered.indexOf('class="notice-stack"')).toBeLessThan(rendered.indexOf('class="content"'));
  });

  it("maps representative notice types to consistent default tones and roles", () => {
    const notices: readonly SettingsNotice[] = [
      { type: "availability", content: "Configuration unavailable." },
      { type: "success", content: "Saved." },
      { type: "security", content: "Trusted code warning." },
      { type: "info", content: "Loading…" },
    ];
    const frame = new SettingsPanelFrame();
    frame.notices = notices;

    const values = collectTemplateValues(frame.render());

    expect(notices.map(settingsNoticeTone)).toEqual(["error", "success", "warning", "info"]);
    expect(values.filter(isNoticeClassOrRole)).toEqual([
      "notice error", "alert",
      "notice success", "status",
      "notice warning", "note",
      "notice info", "note",
    ]);
  });

  it("wires the default header action through the frame", () => {
    const frame = new SettingsPanelFrame();
    let reloads = 0;
    frame.actionLabel = "Reload";
    frame.actionTitle = "Reload settings";
    frame.actionDisabled = true;
    frame.onAction = () => { reloads += 1; };

    const values = collectTemplateValues(frame.render());
    const action = values.find(isActionHandler);

    expect(values).toEqual(expect.arrayContaining(["Reload settings", true, "Reload"]));
    if (action === undefined) throw new Error("Action handler was not rendered");
    action();
    expect(reloads).toBe(1);
  });
});

function flattenTemplateContent(template: TemplateResult): string {
  const chunks: string[] = [];
  visitTemplate(template);
  return chunks.join("");

  function visitTemplate(current: TemplateResult): void {
    const strings = templateStrings(current);
    const values = templateValues(current);
    for (let index = 0; index < values.length; index += 1) {
      const staticChunk = strings[index];
      if (staticChunk !== undefined) chunks.push(staticChunk);
      visitValue(values[index]);
    }
    const finalChunk = strings[values.length];
    if (finalChunk !== undefined) chunks.push(finalChunk);
  }

  function visitValue(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) visitValue(item);
      return;
    }
    if (isTemplateResult(value)) {
      visitTemplate(value);
      return;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      chunks.push(String(value));
    }
  }
}

function collectTemplateValues(template: TemplateResult): unknown[] {
  const values: unknown[] = [];
  visit(template);
  return values;

  function visit(current: unknown): void {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (!isTemplateResult(current)) return;
    for (const value of templateValues(current)) {
      values.push(value);
      visit(value);
    }
  }
}

function expectTextOrder(content: string, labels: readonly string[]): void {
  let previousIndex = -1;
  for (const label of labels) {
    const currentIndex = content.indexOf(label, previousIndex + 1);
    if (currentIndex === -1) throw new Error(`Expected rendered content to include ${label}`);
    expect(currentIndex).toBeGreaterThan(previousIndex);
    previousIndex = currentIndex;
  }
}

function templateStrings(template: TemplateResult): readonly string[] {
  const strings = Reflect.get(template, "strings");
  if (!isStringArray(strings)) throw new Error("TemplateResult strings were unavailable");
  return strings;
}

function templateValues(template: TemplateResult): readonly unknown[] {
  const values = Reflect.get(template, "values");
  if (!Array.isArray(values)) throw new Error("TemplateResult values were unavailable");
  return values.map((value: unknown) => value);
}

function isTemplateResult(value: unknown): value is TemplateResult {
  return typeof value === "object" && value !== null && isStringArray(Reflect.get(value, "strings")) && Array.isArray(Reflect.get(value, "values"));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function isActionHandler(value: unknown): value is () => void {
  return typeof value === "function";
}

function isNoticeClassOrRole(value: unknown): value is string {
  return typeof value === "string"
    && (value.startsWith("notice ") || value === "alert" || value === "status" || value === "note");
}
