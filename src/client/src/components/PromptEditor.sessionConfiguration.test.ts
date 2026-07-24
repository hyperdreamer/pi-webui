import type { TemplateResult } from "lit";
import { describe, expect, it, vi } from "vitest";
import { isTemplateResult, templateEventHandlerAfterValue, templateEventHandlerNearMarker } from "../templateInspection.testSupport";
import { PromptEditor } from "./PromptEditor";

describe("PromptEditor starter session configuration", () => {
  it("renders model and thinking controls before a session when enabled", () => {
    const editor = new PromptEditor();
    const onSelectModel = vi.fn();
    const onSelectThinking = vi.fn();
    editor.showSessionConfiguration = true;
    editor.sessionConfiguration = { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "high" };
    editor.onSelectModel = onSelectModel;
    editor.onSelectThinking = onSelectThinking;

    const controls = renderCompactStatus(editor);

    // This node-only suite checks the component's two stable control bindings
    // directly rather than installing a disproportionate DOM harness.
    templateEventHandlerNearMarker(controls, 'title="Select model"')(new Event("click"));
    templateEventHandlerAfterValue(controls, "Default thinking level: high", "@click")(new Event("click"));

    expect(onSelectModel).toHaveBeenCalledOnce();
    expect(onSelectThinking).toHaveBeenCalledOnce();
  });
});

type RenderCompactStatus = (this: PromptEditor) => TemplateResult | null;

function renderCompactStatus(editor: PromptEditor): TemplateResult {
  const method: unknown = Reflect.get(editor, "renderCompactStatus");
  if (!isRenderCompactStatus(method)) throw new Error("PromptEditor.renderCompactStatus is not callable");
  const controls = method.call(editor);
  if (!isTemplateResult(controls)) throw new Error("PromptEditor starter configuration controls were unavailable");
  return controls;
}

function isRenderCompactStatus(value: unknown): value is RenderCompactStatus {
  return typeof value === "function";
}
