// @vitest-environment jsdom

import { render, type PropertyValues, type TemplateResult } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientSessionModelPolicyStatus, ModelTierSettingsResponse } from "../../../shared/apiTypes";
import type { SessionStatus } from "../api";
import { isTemplateResult } from "../templateInspection.testSupport";
import { PromptEditor } from "./PromptEditor";

const tieredPolicyStatus: ClientSessionModelPolicyStatus = {
  mode: "tiered",
  tier: "advanced",
  resolved: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" },
  ladderValid: true,
};

type PolicyStatusMutation = (policy: ClientSessionModelPolicyStatus) => ClientSessionModelPolicyStatus;

const policyStatusMutations: readonly (readonly [string, PolicyStatusMutation])[] = [
  ["mode", (policy) => ({ ...policy, mode: "exact" })],
  ["tier", (policy) => ({ ...policy, tier: "frontier" })],
  ["resolved provider", (policy) => ({
    ...policy,
    resolved: { ...policy.resolved, model: { ...policy.resolved.model, provider: "anthropic" } },
  })],
  ["resolved model", (policy) => ({
    ...policy,
    resolved: { ...policy.resolved, model: { ...policy.resolved.model, id: "claude-advanced" } },
  })],
  ["resolved thinking", (policy) => ({
    ...policy,
    resolved: { ...policy.resolved, thinkingLevel: "medium" },
  })],
  ["ladder validity", (policy) => ({ ...policy, ladderValid: false })],
  ["blocked reason", (policy) => ({ ...policy, blockedReason: "Policy transition failed" })],
];

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => mediaQuery(query));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PromptEditor session controls", () => {
  it("renders model and thinking controls before a session when enabled", () => {
    const editor = new PromptEditor();
    const onSelectModel = vi.fn();
    const onSelectThinking = vi.fn();
    editor.showSessionConfiguration = true;
    editor.sessionConfiguration = { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "high" };
    editor.onSelectModel = onSelectModel;
    editor.onSelectThinking = onSelectThinking;

    const controls = renderCompactStatusElement(editor);
    requiredButton(controls, '[title="Select model"]').click();
    requiredButton(controls, ".select-thinking").click();

    expect(onSelectModel).toHaveBeenCalledOnce();
    expect(onSelectThinking).toHaveBeenCalledOnce();
  });

  it("renders Tiered policy controls first without duplicate model and thinking controls", () => {
    const editor = new PromptEditor();
    editor.status = sessionStatus(tieredPolicyStatus);

    const controls = renderCompactStatusElement(editor);

    expect(Array.from(controls.children, (child) => child.localName)).toEqual(["session-model-policy-control"]);
    expect(controls.querySelector('[title="Select model"]')).toBeNull();
    expect(controls.querySelector(".select-thinking")).toBeNull();
  });

  it("renders Exact policy controls before the existing model and thinking controls", () => {
    const editor = new PromptEditor();
    const exactPolicyStatus: ClientSessionModelPolicyStatus = { ...tieredPolicyStatus, mode: "exact" };
    const catalog = emptyModelTierCatalog();
    editor.status = sessionStatus(exactPolicyStatus);
    editor.modelTierCatalog = catalog;
    editor.modelPolicyLoading = true;
    editor.modelPolicyError = "Policy read failed";

    const controls = renderCompactStatusElement(editor);
    const policyControl = renderedPolicyControl(controls);

    expect(Array.from(controls.children, (child) => child.localName)).toEqual([
      "session-model-policy-control",
      "button",
      "button",
    ]);
    expect(controls.querySelector('[title="Select model"]')).not.toBeNull();
    expect(controls.querySelector(".select-thinking")).not.toBeNull();
    expect(policyControl.status).toBe(exactPolicyStatus);
    expect(policyControl.catalog).toBe(catalog);
    expect(policyControl.loading).toBe(true);
    expect(policyControl.saving).toBe(false);
    expect(policyControl.error).toBe("Policy read failed");
  });

  it("forwards live invalid blocked status without disabling repair", () => {
    const livePolicyStatus: ClientSessionModelPolicyStatus = {
      ...tieredPolicyStatus,
      ladderValid: false,
      blockedReason: "runtime could not prove the previous policy was restored",
    };
    const editor = new PromptEditor();
    editor.status = sessionStatus(livePolicyStatus);

    const policyControl = renderedPolicyControl(renderCompactStatusElement(editor));

    expect(policyControl.status).toBe(livePolicyStatus);
    expect(policyControl.status?.ladderValid).toBe(false);
    expect(policyControl.status?.blockedReason).toBe("runtime could not prove the previous policy was restored");
    expect(policyControl.editable).toBe(true);
  });

  it("keeps policy mutation disabled while the composer or active session is busy", () => {
    const scenarios: {
      name: string;
      disabled?: boolean;
      saving?: boolean;
      status?: Partial<SessionStatus>;
    }[] = [
      { name: "disabled composer", disabled: true },
      { name: "streaming", status: { isStreaming: true } },
      { name: "bash", status: { isBashRunning: true } },
      { name: "compaction", status: { isCompacting: true } },
      { name: "queued work", status: { pendingMessageCount: 1 } },
      { name: "policy save", saving: true },
    ];

    const idleEditor = new PromptEditor();
    idleEditor.status = sessionStatus(tieredPolicyStatus);
    expect(renderedPolicyControl(renderCompactStatusElement(idleEditor)).editable).toBe(true);

    for (const scenario of scenarios) {
      const editor = new PromptEditor();
      editor.status = sessionStatus(tieredPolicyStatus, scenario.status);
      editor.disabled = scenario.disabled ?? false;
      editor.modelPolicySaving = scenario.saving ?? false;

      const control = renderedPolicyControl(renderCompactStatusElement(editor));
      expect(control.editable, scenario.name).toBe(false);
      if (scenario.saving === true) expect(control.saving).toBe(true);
    }
  });

  it.each(policyStatusMutations)("re-renders when the displayed policy %s changes", (_field, mutatePolicy) => {
    const previous = sessionStatus(tieredPolicyStatus);
    const editor = new PromptEditor();
    editor.status = sessionStatus(mutatePolicy(tieredPolicyStatus));

    expect(statusChangeRequiresRender(editor, previous)).toBe(true);
  });

  it("retains render gating for an unrelated per-token status republish", () => {
    const previous = sessionStatus(tieredPolicyStatus);
    const editor = new PromptEditor();
    editor.modelPolicyStatus = clonePolicyStatus(tieredPolicyStatus);
    editor.status = {
      ...previous,
      ...(previous.model === undefined ? {} : { model: { ...previous.model } }),
      modelPolicy: clonePolicyStatus(tieredPolicyStatus),
      messageCount: 17,
      tokens: { input: 31, output: 19, cacheRead: 7, cacheWrite: 5, total: 62 },
      cost: 0.25,
    };

    expect(statusChangeRequiresRender(editor, previous, tieredPolicyStatus)).toBe(false);
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

    expect(renderCompactStatusElement(editor).querySelector(".compact-button")).toBeNull();

    const compact = requiredButton(renderPromptEditorActions(editor), ".compact-button");
    expect(compact.disabled).toBe(false);
    compact.click();

    expect(onCompact).toHaveBeenCalledOnce();
  });

  it("keeps Compact beside Queue without allowing active work to be interrupted", () => {
    const editor = new PromptEditor();
    const onCompact = vi.fn();
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
    editor.onCompact = onCompact;

    const actions = renderPromptEditorActions(editor);
    const compact = requiredButton(actions, ".compact-button");
    const queue = requiredButton(actions, '[aria-label="Queue message"]');

    expect(compact.nextElementSibling).toBe(queue);
    expect(compact.disabled).toBe(true);
    compact.click();
    expect(onCompact).not.toHaveBeenCalled();
  });
});

type RenderCompactStatus = (this: PromptEditor) => TemplateResult | null;
type ShouldUpdate = (this: PromptEditor, changed: PropertyValues<PromptEditor>) => boolean;
type RenderedPolicyControl = HTMLElement & {
  status?: ClientSessionModelPolicyStatus;
  catalog?: ModelTierSettingsResponse;
  loading: boolean;
  saving: boolean;
  editable: boolean;
  error: string;
};

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

function renderCompactStatusElement(editor: PromptEditor): HTMLElement {
  const host = document.createElement("div");
  render(renderCompactStatus(editor), host);
  const controls = host.querySelector<HTMLElement>(".compact-status");
  if (controls === null) throw new Error("PromptEditor compact status did not render");
  return controls;
}

function renderedPolicyControl(controls: HTMLElement): RenderedPolicyControl {
  const control = controls.querySelector<RenderedPolicyControl>("session-model-policy-control");
  if (control === null) throw new Error("PromptEditor policy control did not render");
  return control;
}

function statusChangeRequiresRender(
  editor: PromptEditor,
  previous: SessionStatus,
  previousPolicyStatus?: ClientSessionModelPolicyStatus,
): boolean {
  const method: unknown = Reflect.get(editor, "shouldUpdate");
  if (!isShouldUpdate(method)) throw new Error("PromptEditor.shouldUpdate is not callable");
  const changed: PropertyValues<PromptEditor> = new Map();
  changed.set("status", previous);
  if (previousPolicyStatus !== undefined) changed.set("modelPolicyStatus", previousPolicyStatus);
  return method.call(editor, changed);
}

function isShouldUpdate(value: unknown): value is ShouldUpdate {
  return typeof value === "function";
}

function renderPromptEditorActions(editor: PromptEditor): HTMLElement {
  const host = document.createElement("div");
  render(editor.render(), host);
  const actions = host.querySelector<HTMLElement>(".actions");
  if (actions === null) throw new Error("PromptEditor actions did not render");
  return actions;
}

function requiredButton(root: ParentNode, selector: string): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>(selector);
  if (button === null) throw new Error(`Expected the ${selector} button`);
  return button;
}

function sessionStatus(
  modelPolicy: ClientSessionModelPolicyStatus,
  patch: Partial<SessionStatus> = {},
): SessionStatus {
  return {
    sessionId: "session-1",
    persisted: true,
    model: { provider: "openai", id: "gpt-advanced" },
    thinkingLevel: "high",
    modelPolicy,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    messageCount: 12,
    tokens: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, total: 6 },
    cost: 0.01,
    ...patch,
  };
}

function clonePolicyStatus(policy: ClientSessionModelPolicyStatus): ClientSessionModelPolicyStatus {
  return {
    ...policy,
    resolved: {
      model: { ...policy.resolved.model },
      thinkingLevel: policy.resolved.thinkingLevel,
    },
  };
}

function emptyModelTierCatalog(): ModelTierSettingsResponse {
  const unavailable = { valid: false, reason: "Not configured" };
  return {
    contractVersion: 1,
    models: [],
    rows: {
      economy: unavailable,
      fast: unavailable,
      standard: unavailable,
      advanced: unavailable,
      capable: unavailable,
      frontier: unavailable,
    },
    valid: false,
  };
}

function mediaQuery(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
}
