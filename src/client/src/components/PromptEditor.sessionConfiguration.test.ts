import type { TemplateResult } from "lit";
import { describe, expect, it, vi } from "vitest";
import { findOptionalTemplateEventHandlerNearMarker, isTemplateResult, templateEventHandlerAfterValue, templateEventHandlerNearMarker, templateValueAfterMarker } from "../templateInspection.testSupport";
import { PromptEditor } from "./PromptEditor";

describe("PromptEditor session controls", () => {
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

  it("runs manual compaction from session controls", () => {
    const editor = new PromptEditor();
    const onCompact = vi.fn();
    editor.status = {
      sessionId: "session-1",
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    };
    editor.onCompact = onCompact;

    const statusControls = renderCompactStatus(editor);

    expect(findOptionalTemplateEventHandlerNearMarker(statusControls, 'title="Compact context"')).toBeUndefined();

    const controls = renderPromptEditor(editor);

    // The stable control title keeps this node-only wiring check narrowly scoped.
    templateEventHandlerNearMarker(controls, 'title="Compact context"')(new Event("click"));

    expect(onCompact).toHaveBeenCalledOnce();
  });

  it("keeps Compact beside Queue without allowing active work to be interrupted", () => {
    const editor = new PromptEditor();
    editor.status = {
      sessionId: "session-1",
      isStreaming: true,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 1,
      queuedMessages: [{ kind: "followUp", text: "queued" }],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    };
    editor.canSteer = true;
    editor.canStop = true;
    editor.onCompact = vi.fn();

    expect(templateValueAfterMarker(renderPromptEditor(editor), 'class="compact-button" ?disabled=')).toBe(true);
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

function renderPromptEditor(editor: PromptEditor): TemplateResult {
  const rendered = editor.render();
  if (!isTemplateResult(rendered)) throw new Error("PromptEditor did not render a template");
  return rendered;
}
