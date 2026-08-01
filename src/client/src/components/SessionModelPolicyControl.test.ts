// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ClientSessionModelPolicyStatus,
  ExactModelSelection,
  ModelTierLadder,
  ModelTierModelOption,
  ModelTierSettingsResponse,
  SessionModelPolicy,
  SessionModelPolicyResponse,
  SessionStatus,
} from "../../../shared/apiTypes";
import { SessionModelPolicyControl } from "./SessionModelPolicyControl";

const defaultModelOption: ModelTierModelOption = {
  model: { provider: "openai", id: "gpt-default" },
  name: "Default",
  thinkingLevels: ["low", "medium", "high"],
};
const repairModelOption: ModelTierModelOption = {
  model: { provider: "openai", id: "gpt-repair" },
  name: "Repair",
  thinkingLevels: ["off", "low"],
};

function validLadder(): ModelTierLadder {
  return {
    economy: { model: { ...repairModelOption.model }, thinkingLevel: "off" },
    fast: { model: { ...repairModelOption.model }, thinkingLevel: "low" },
    standard: { model: { ...defaultModelOption.model }, thinkingLevel: "low" },
    advanced: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" },
    capable: { model: { ...defaultModelOption.model }, thinkingLevel: "high" },
    frontier: { model: { ...defaultModelOption.model }, thinkingLevel: "high" },
  };
}

function validCatalog(): ModelTierSettingsResponse {
  return {
    contractVersion: 1,
    ladder: validLadder(),
    models: [defaultModelOption, repairModelOption],
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

function unusableCatalog(): ModelTierSettingsResponse {
  return {
    contractVersion: 1,
    models: [],
    rows: {
      economy: { valid: false, reason: "tier economy has no model selected" },
      fast: { valid: false },
      standard: { valid: false },
      advanced: { valid: false },
      capable: { valid: false },
      frontier: { valid: false },
    },
    valid: false,
    configError: "missing model-tier ladder in settings.json",
  };
}

function sessionStatus(policyStatus?: ClientSessionModelPolicyStatus): SessionStatus {
  return {
    sessionId: "session-1",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    ...(policyStatus === undefined ? {} : { modelPolicy: policyStatus }),
  };
}

function exactStatus(): ClientSessionModelPolicyStatus {
  return {
    mode: "exact",
    resolved: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" },
    ladderValid: true,
  };
}

function tieredStatus(): ClientSessionModelPolicyStatus {
  return {
    mode: "tiered",
    tier: "advanced",
    resolved: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" },
    ladderValid: true,
  };
}

function policyResponse(policy: SessionModelPolicy, policyStatus: ClientSessionModelPolicyStatus): SessionModelPolicyResponse {
  return { contractVersion: 1, policy, session: sessionStatus(policyStatus) };
}

function exactResponse(exact: ExactModelSelection = { model: { ...defaultModelOption.model }, thinkingLevel: "medium" }): SessionModelPolicyResponse {
  return policyResponse({ mode: "exact", exact }, exactStatus());
}

/** Server shape for a malformed newest entry: no `policy`, blocked reason, live resolved tuple. */
function repairStatus(): ClientSessionModelPolicyStatus {
  return {
    mode: "exact",
    resolved: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" },
    ladderValid: true,
    blockedReason: "persisted session model policy entry is malformed",
  };
}

function repairResponse(): SessionModelPolicyResponse {
  return { contractVersion: 1, session: sessionStatus(repairStatus()) };
}

function modelKey(provider: string, id: string): string {
  return `${provider}:${id}`;
}

async function mountControl(configure: (control: SessionModelPolicyControl) => void): Promise<SessionModelPolicyControl> {
  const control = new SessionModelPolicyControl();
  configure(control);
  document.body.append(control);
  await control.updateComplete;
  return control;
}

function shadowRoot(control: SessionModelPolicyControl): ShadowRoot {
  const root = control.shadowRoot;
  if (root === null) throw new Error("Expected an open shadow root");
  return root;
}

function trigger(control: SessionModelPolicyControl): HTMLButtonElement {
  const element = shadowRoot(control).querySelector<HTMLButtonElement>(".policy-trigger");
  if (element === null) throw new Error("Expected the session model policy trigger");
  return element;
}

function panel(control: SessionModelPolicyControl): HTMLElement {
  const element = shadowRoot(control).querySelector<HTMLElement>(".policy-panel");
  if (element === null) throw new Error("Expected the opened session model policy panel");
  return element;
}

function optionalPanel(control: SessionModelPolicyControl): HTMLElement | null {
  return shadowRoot(control).querySelector<HTMLElement>(".policy-panel");
}

function field(control: SessionModelPolicyControl, id: string): HTMLSelectElement {
  const element = shadowRoot(control).querySelector<HTMLSelectElement>(`#${id}`);
  if (element === null) throw new Error(`Expected the ${id} control`);
  return element;
}

function optionalField(control: SessionModelPolicyControl, id: string): HTMLSelectElement | null {
  return shadowRoot(control).querySelector<HTMLSelectElement>(`#${id}`);
}

function saveButton(control: SessionModelPolicyControl): HTMLButtonElement {
  const element = shadowRoot(control).querySelector<HTMLButtonElement>(".policy-save");
  if (element === null) throw new Error("Expected the save action");
  return element;
}

function labelTextFor(control: SessionModelPolicyControl, id: string): string {
  const label = shadowRoot(control).querySelector<HTMLLabelElement>(`label[for="${id}"]`);
  if (label === null) throw new Error(`Expected a visible label for ${id}`);
  if (label.classList.contains("sr-only")) throw new Error(`Label for ${id} is visually hidden`);
  return label.textContent.trim();
}

/** Rendered text only; the adopted/injected <style> content is not user-facing. */
function shadowText(control: SessionModelPolicyControl): string {
  return Array.from(shadowRoot(control).children)
    .filter((child) => child.tagName !== "STYLE")
    .map((child) => child.textContent)
    .join(" ");
}

async function choose(control: SessionModelPolicyControl, id: string, value: string): Promise<void> {
  const select = field(control, id);
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  await control.updateComplete;
}

async function openPanel(control: SessionModelPolicyControl): Promise<void> {
  trigger(control).click();
  await control.updateComplete;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("SessionModelPolicyControl closed trigger", () => {
  it("renders an accessible Exact mode trigger as its first element", async () => {
    const control = await mountControl((element) => {
      element.status = exactStatus();
    });

    const control_trigger = trigger(control);

    expect(shadowRoot(control).firstElementChild).toBe(control_trigger);
    expect(control_trigger.getAttribute("aria-label")).toBe("Session model mode: Exact");
    expect(control_trigger.textContent.trim()).toContain("Exact");
    expect(control_trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders a Tiered trigger with a read-only resolution and no compact exact-model control", async () => {
    const control = await mountControl((element) => {
      element.status = tieredStatus();
    });

    const text = trigger(control).textContent.replace(/\s+/g, " ");

    expect(text).toContain("Tiered");
    expect(text).toContain("Advanced");
    expect(text).toContain("→ openai/gpt-advanced · high");
    expect(shadowRoot(control).querySelectorAll("select")).toHaveLength(0);
    expect(shadowRoot(control).querySelectorAll("button")).toHaveLength(1);
  });

  it("stays visible from live status before any policy response has loaded", async () => {
    const control = await mountControl((element) => {
      element.status = tieredStatus();
      element.loading = true;
    });

    expect(trigger(control).isConnected).toBe(true);
    expect(optionalPanel(control)).toBeNull();
  });

  it("surfaces a live block on the closed trigger row", async () => {
    const control = await mountControl((element) => {
      element.status = { ...exactStatus(), blockedReason: "runtime rejected the persisted policy" };
    });

    expect(shadowText(control)).toContain("runtime rejected the persisted policy");
  });

  it("renders and saves in the starter composer from a synthetic response alone", async () => {
    const onSave = vi.fn();
    const control = await mountControl((element) => {
      element.response = exactResponse();
      element.catalog = validCatalog();
      element.editable = true;
      element.onSave = onSave;
    });

    expect(trigger(control).getAttribute("aria-label")).toBe("Session model mode: Exact");

    await openPanel(control);
    await choose(control, "policy-mode", "tiered");
    await choose(control, "policy-tier", "capable");
    saveButton(control).click();

    expect(onSave).toHaveBeenCalledWith({ mode: "tiered", tier: "capable" });
  });

  it("renders nothing without any policy status or response", async () => {
    const control = await mountControl(() => undefined);

    expect(shadowRoot(control).querySelector(".policy-trigger")).toBeNull();
    expect(shadowRoot(control).querySelector(".policy-diagnostic")).toBeNull();
    expect(optionalPanel(control)).toBeNull();
  });

  it("renders the opened surface as a constrained popover on wide layouts and a bottom sheet on narrow ones", () => {
    const styles = SessionModelPolicyControl.styles.cssText;

    expect(styles).toMatch(/\.policy-panel \{[^}]*position: absolute;/);
    expect(styles).toMatch(/\.policy-panel \{[^}]*width: min\(360px, calc\(100vw - 24px\)\);/);
    expect(styles).toMatch(/\.policy-panel \{[^}]*max-height: min\(420px, 60dvh\);/);
    expect(styles).toMatch(/@media \(max-width: 760px\) \{\s*\.policy-panel \{[^}]*position: fixed;/);
    expect(styles).toMatch(/@media \(max-width: 760px\) \{\s*\.policy-panel \{[^}]*max-height: min\(70dvh, 520px\);/);
  });
});

describe("SessionModelPolicyControl opened surface", () => {
  it("opens once per opening and shows visible labels for every applicable field", async () => {
    const onOpen = vi.fn();
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.response = exactResponse();
      element.catalog = validCatalog();
      element.editable = true;
      element.onOpen = onOpen;
    });

    await openPanel(control);

    expect(onOpen).toHaveBeenCalledOnce();
    expect(panel(control).getAttribute("role")).toBe("dialog");
    expect(trigger(control).getAttribute("aria-expanded")).toBe("true");
    expect(labelTextFor(control, "policy-mode")).toBe("Mode");
    expect(labelTextFor(control, "policy-tier")).toBe("Tier");
    expect(labelTextFor(control, "policy-exact-model")).toBe("Exact model");
    expect(labelTextFor(control, "policy-exact-thinking")).toBe("Thinking level");

    await openPanel(control);

    expect(optionalPanel(control)).toBeNull();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("keeps Tiered resolution read-only inside the panel", async () => {
    const control = await mountControl((element) => {
      element.status = tieredStatus();
      element.response = policyResponse({ mode: "tiered", exact: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" }, tier: "advanced" }, tieredStatus());
      element.catalog = validCatalog();
      element.editable = true;
    });

    await openPanel(control);

    expect(shadowText(control).replace(/\s+/g, " ")).toContain("→ openai/gpt-advanced · high");
    expect(optionalField(control, "policy-exact-model")).toBeNull();
    expect(optionalField(control, "policy-exact-thinking")).toBeNull();
  });

  it("offers no Save action for a first Tiered selection until a canonical tier is chosen", async () => {
    const onSave = vi.fn();
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.response = exactResponse();
      element.catalog = validCatalog();
      element.editable = true;
      element.onSave = onSave;
    });

    await openPanel(control);
    await choose(control, "policy-mode", "tiered");

    expect(field(control, "policy-tier").value).toBe("");
    expect(saveButton(control).disabled).toBe(true);
    saveButton(control).click();
    expect(onSave).not.toHaveBeenCalled();

    await choose(control, "policy-tier", "advanced");

    expect(saveButton(control).disabled).toBe(false);
    saveButton(control).click();

    expect(onSave).toHaveBeenCalledWith({ mode: "tiered", tier: "advanced" });
  });

  it("clears an incompatible thinking level when the exact repair model changes and blocks Save until it is compatible", async () => {
    const onSave = vi.fn();
    const control = await mountControl((element) => {
      element.status = repairStatus();
      element.response = repairResponse();
      element.catalog = validCatalog();
      element.editable = true;
      element.onSave = onSave;
    });

    await openPanel(control);

    expect(shadowText(control)).toContain("persisted session model policy entry is malformed");
    expect(field(control, "policy-exact-thinking").value).toBe("medium");

    await choose(control, "policy-exact-model", modelKey("openai", "gpt-repair"));

    expect(field(control, "policy-exact-thinking").value).toBe("");
    expect(saveButton(control).disabled).toBe(true);
    saveButton(control).click();
    expect(onSave).not.toHaveBeenCalled();

    await choose(control, "policy-exact-thinking", "low");

    expect(saveButton(control).disabled).toBe(false);
    saveButton(control).click();

    expect(onSave).toHaveBeenCalledWith({
      mode: "exact",
      exact: { model: { provider: "openai", id: "gpt-repair" }, thinkingLevel: "low" },
    });
  });

  it("discards an abandoned draft when Cancel closes the panel", async () => {
    const onSave = vi.fn();
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.response = exactResponse();
      element.catalog = validCatalog();
      element.editable = true;
      element.onSave = onSave;
    });

    await openPanel(control);
    await choose(control, "policy-exact-thinking", "high");
    expect(field(control, "policy-exact-thinking").value).toBe("high");

    const cancel = shadowRoot(control).querySelector<HTMLButtonElement>(".policy-cancel");
    if (cancel === null) throw new Error("Expected the cancel action");
    cancel.click();
    await control.updateComplete;

    expect(optionalPanel(control)).toBeNull();

    await openPanel(control);

    expect(field(control, "policy-exact-thinking").value).toBe("medium");
    saveButton(control).click();
    expect(onSave).toHaveBeenCalledWith({
      mode: "exact",
      exact: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" },
    });
  });
});

describe("SessionModelPolicyControl keyboard and error surfaces", () => {
  it("closes on Escape and restores focus to the trigger", async () => {
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.response = exactResponse();
      element.catalog = validCatalog();
      element.editable = true;
    });

    await openPanel(control);

    expect(shadowRoot(control).activeElement).toBe(field(control, "policy-mode"));

    const escape = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Escape" });
    field(control, "policy-mode").dispatchEvent(escape);
    await control.updateComplete;

    expect(escape.defaultPrevented).toBe(true);
    expect(optionalPanel(control)).toBeNull();
    expect(shadowRoot(control).activeElement).toBe(trigger(control));
  });

  it("closes on Escape when focus has returned to the trigger", async () => {
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.response = exactResponse();
      element.catalog = validCatalog();
      element.editable = true;
    });

    await openPanel(control);
    const controlTrigger = trigger(control);
    controlTrigger.focus();
    expect(shadowRoot(control).activeElement).toBe(controlTrigger);

    const escape = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Escape" });
    controlTrigger.dispatchEvent(escape);
    await control.updateComplete;

    expect(escape.defaultPrevented).toBe(true);
    expect(optionalPanel(control)).toBeNull();
    expect(shadowRoot(control).activeElement).toBe(controlTrigger);
  });

  it("announces a save error in an assertive alert region without losing the draft", async () => {
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.response = exactResponse();
      element.catalog = validCatalog();
      element.editable = true;
    });

    await openPanel(control);
    await choose(control, "policy-exact-thinking", "high");

    control.error = "Error: policy write rejected";
    await control.updateComplete;

    const alert = shadowRoot(control).querySelector<HTMLElement>(".policy-error");
    expect(alert?.getAttribute("aria-live")).toBe("assertive");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toContain("Error: policy write rejected");
    expect(field(control, "policy-exact-thinking").value).toBe("high");
    expect(optionalPanel(control)).not.toBeNull();
  });

  it("keeps focus inside the panel when a retry resolves into the editable form", async () => {
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.error = "Error: policy read failed";
    });

    await openPanel(control);
    const retry = shadowRoot(control).querySelector<HTMLButtonElement>(".policy-retry");
    expect(shadowRoot(control).activeElement).toBe(retry);

    control.error = "";
    control.response = exactResponse();
    control.catalog = validCatalog();
    control.editable = true;
    await control.updateComplete;

    expect(shadowRoot(control).activeElement).toBe(field(control, "policy-mode"));
  });

  it("offers a retry path when the policy read failed and left no response", async () => {
    const onOpen = vi.fn();
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.error = "Error: policy read failed";
      element.onOpen = onOpen;
    });

    await openPanel(control);
    expect(onOpen).toHaveBeenCalledOnce();

    const retry = shadowRoot(control).querySelector<HTMLButtonElement>(".policy-retry");
    expect(retry).not.toBeNull();
    expect(shadowText(control)).toContain("The current model policy could not be loaded");
    expect(shadowText(control)).toContain("Error: policy read failed");
    retry?.click();

    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("identifies missing model tier settings while loading and after failure", async () => {
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.response = exactResponse();
      element.loading = true;
    });

    await openPanel(control);

    expect(shadowText(control)).toContain("Loading model tier settings");
    expect(shadowText(control)).not.toContain("Loading the current model policy");

    control.loading = false;
    await control.updateComplete;

    expect(shadowText(control)).toContain("Model tier settings could not be loaded");
    expect(shadowText(control)).not.toContain("The current model policy could not be loaded");
  });
});

describe("SessionModelPolicyControl mutation gates and diagnostics", () => {
  it("disables every mutation control when the parent marks the policy read-only", async () => {
    const onSave = vi.fn();
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.response = exactResponse();
      element.catalog = validCatalog();
      element.editable = false;
      element.onSave = onSave;
    });

    await openPanel(control);

    expect(field(control, "policy-mode").disabled).toBe(true);
    expect(field(control, "policy-tier").disabled).toBe(true);
    expect(field(control, "policy-exact-model").disabled).toBe(true);
    expect(field(control, "policy-exact-thinking").disabled).toBe(true);
    expect(saveButton(control).disabled).toBe(true);
    saveButton(control).click();

    expect(onSave).not.toHaveBeenCalled();
    expect(shadowText(control).replace(/\s+/g, " ")).toContain("openai/gpt-default · medium");
  });

  it("disables mutation while a write is in flight but keeps the current policy readable", async () => {
    const onSave = vi.fn();
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.response = exactResponse();
      element.catalog = validCatalog();
      element.editable = true;
      element.saving = true;
      element.onSave = onSave;
    });

    await openPanel(control);

    expect(field(control, "policy-mode").disabled).toBe(true);
    expect(field(control, "policy-exact-model").disabled).toBe(true);
    expect(field(control, "policy-exact-thinking").disabled).toBe(true);
    expect(saveButton(control).disabled).toBe(true);
    saveButton(control).click();

    expect(onSave).not.toHaveBeenCalled();
    expect(shadowText(control).replace(/\s+/g, " ")).toContain("openai/gpt-default · medium");
  });

  it("disables mutation while a refreshed policy read is in flight", async () => {
    const onSave = vi.fn();
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.response = exactResponse();
      element.catalog = validCatalog();
      element.editable = true;
      element.loading = true;
      element.onSave = onSave;
    });

    await openPanel(control);

    expect(field(control, "policy-mode").disabled).toBe(true);
    expect(field(control, "policy-exact-model").disabled).toBe(true);
    expect(field(control, "policy-exact-thinking").disabled).toBe(true);
    expect(saveButton(control).disabled).toBe(true);
    saveButton(control).click();

    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps an unusable catalog non-actionable while showing its configuration error", async () => {
    const onSave = vi.fn();
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.response = exactResponse();
      element.catalog = unusableCatalog();
      element.editable = true;
      element.onSave = onSave;
    });

    await openPanel(control);

    expect(shadowText(control)).toContain("missing model-tier ladder in settings.json");
    expect(saveButton(control).disabled).toBe(true);
    saveButton(control).click();
    expect(onSave).not.toHaveBeenCalled();

    await choose(control, "policy-mode", "tiered");
    expect(field(control, "policy-tier").disabled).toBe(true);
    expect(saveButton(control).disabled).toBe(true);
    saveButton(control).click();

    expect(onSave).not.toHaveBeenCalled();
  });

  it("marks an individually invalid tier unselectable and keeps Save blocked with its reason visible", async () => {
    const onSave = vi.fn();
    const catalog = validCatalog();
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.response = exactResponse();
      element.catalog = {
        ...catalog,
        rows: { ...catalog.rows, advanced: { valid: false, reason: "tier advanced names unavailable model openai/retired" } },
      };
      element.editable = true;
      element.onSave = onSave;
    });

    await openPanel(control);
    await choose(control, "policy-mode", "tiered");

    const advanced = shadowRoot(control).querySelector<HTMLOptionElement>('#policy-tier option[value="advanced"]');
    expect(advanced?.disabled).toBe(true);

    await choose(control, "policy-tier", "advanced");

    expect(shadowText(control)).toContain("tier advanced names unavailable model openai/retired");
    expect(saveButton(control).disabled).toBe(true);
    saveButton(control).click();

    expect(onSave).not.toHaveBeenCalled();

    await choose(control, "policy-tier", "capable");

    expect(saveButton(control).disabled).toBe(false);
  });

  it("keeps a remembered tier read-only until Mode explicitly changes to Tiered", async () => {
    const onSave = vi.fn();
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.response = policyResponse({ mode: "exact", exact: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" }, tier: "frontier" }, exactStatus());
      element.catalog = validCatalog();
      element.editable = true;
      element.onSave = onSave;
    });

    await openPanel(control);

    expect(field(control, "policy-mode").value).toBe("exact");
    expect(field(control, "policy-tier").value).toBe("frontier");
    expect(field(control, "policy-tier").disabled).toBe(true);

    await choose(control, "policy-mode", "tiered");

    expect(field(control, "policy-mode").value).toBe("tiered");
    expect(field(control, "policy-tier").disabled).toBe(false);
    saveButton(control).click();

    expect(onSave).toHaveBeenCalledWith({ mode: "tiered", tier: "frontier" });
  });

  it("keeps a runtime-blocked confirmed policy editable for an explicit repair update", async () => {
    const onSave = vi.fn();
    const blocked: ClientSessionModelPolicyStatus = {
      ...exactStatus(),
      blockedReason: "runtime could not prove the previous policy was restored",
    };
    const control = await mountControl((element) => {
      element.status = blocked;
      element.response = policyResponse(
        { mode: "exact", exact: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" } },
        blocked,
      );
      element.catalog = validCatalog();
      element.editable = true;
      element.onSave = onSave;
    });

    await openPanel(control);

    expect(shadowText(control)).toContain("runtime could not prove the previous policy was restored");
    expect(field(control, "policy-mode").disabled).toBe(false);
    expect(field(control, "policy-exact-model").disabled).toBe(false);
    expect(field(control, "policy-exact-thinking").disabled).toBe(false);
    expect(saveButton(control).disabled).toBe(false);

    await choose(control, "policy-exact-thinking", "high");

    expect(saveButton(control).disabled).toBe(false);
    saveButton(control).click();
    expect(onSave).toHaveBeenCalledWith({
      mode: "exact",
      exact: { model: { ...defaultModelOption.model }, thinkingLevel: "high" },
    });
  });

  it("lets a blocked Tiered starter choose a valid replacement tier", async () => {
    const onSave = vi.fn();
    const catalog = validCatalog();
    const blockedReason = "Choose a valid model tier before starting";
    const blocked: ClientSessionModelPolicyStatus = {
      ...tieredStatus(),
      ladderValid: false,
      blockedReason,
    };
    const control = await mountControl((element) => {
      element.status = blocked;
      element.response = policyResponse(
        { mode: "tiered", exact: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" }, tier: "advanced" },
        blocked,
      );
      element.catalog = {
        ...catalog,
        rows: {
          ...catalog.rows,
          advanced: { valid: false, reason: "tier advanced does not resolve to a valid model" },
        },
      };
      element.editable = true;
      element.onSave = onSave;
    });

    await openPanel(control);

    expect(shadowText(control)).toContain(blockedReason);
    expect(field(control, "policy-mode").disabled).toBe(false);
    expect(field(control, "policy-tier").disabled).toBe(false);
    expect(saveButton(control).disabled).toBe(true);

    await choose(control, "policy-tier", "capable");

    expect(saveButton(control).disabled).toBe(false);
    saveButton(control).click();
    expect(onSave).toHaveBeenCalledWith({ mode: "tiered", tier: "capable" });
  });

  it("reads ladder validity from live status rather than the held response session", async () => {
    const staleResponseStatus: ClientSessionModelPolicyStatus = { ...tieredStatus(), ladderValid: true };
    const control = await mountControl((element) => {
      element.status = { ...tieredStatus(), ladderValid: false };
      element.response = policyResponse({ mode: "tiered", exact: { model: { ...defaultModelOption.model }, thinkingLevel: "medium" }, tier: "advanced" }, staleResponseStatus);
      element.catalog = validCatalog();
      element.editable = true;
    });

    expect(shadowText(control)).toContain("Model tier ladder is invalid");
  });

  it("reports a missing thinking level instead of substituting a displayable one", async () => {
    const control = await mountControl((element) => {
      element.status = {
        mode: "tiered",
        tier: "advanced",
        resolved: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "" },
        ladderValid: true,
      };
    });

    const text = trigger(control).textContent.replace(/\s+/g, " ");

    expect(text).toContain("no thinking level");
    expect(text).not.toContain("· off");
  });
});
