// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientSessionModelPolicyStatus } from "../../../shared/apiTypes";
import { SessionModelPolicyControl } from "./SessionModelPolicyControl";
import { modelKey, THINKING_LEVEL_ORDER } from "./modelPolicyLabels";
import { KNOWN_THINKING_LEVELS } from "../../../shared/thinkingLevels";

const defaultModel = { provider: "openai", id: "gpt-default" };

function exactStatus(): ClientSessionModelPolicyStatus {
  return {
    mode: "exact",
    resolved: { model: { ...defaultModel }, thinkingLevel: "medium" },
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

function componentStyleRule(selector: string): CSSStyleDeclaration {
  const style = document.createElement("style");
  style.textContent = SessionModelPolicyControl.styles.cssText;
  document.head.append(style);
  const sheet = style.sheet;
  const rule = sheet === null
    ? undefined
    : Array.from(sheet.cssRules).find(
      (candidate): candidate is CSSStyleRule => candidate instanceof CSSStyleRule && candidate.selectorText === selector,
    );
  style.remove();
  if (rule === undefined) throw new Error(`Expected the ${selector} component style rule`);
  return rule.style;
}

function shadowText(control: SessionModelPolicyControl): string {
  return Array.from(shadowRoot(control).children)
    .filter((child) => child.tagName !== "STYLE")
    .map((child) => child.textContent)
    .join(" ");
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("SessionModelPolicyControl closed trigger", () => {
  it("renders an accessible Exact mode trigger as its first element", async () => {
    const control = await mountControl((element) => {
      element.status = exactStatus();
    });

    const controlTrigger = trigger(control);

    expect(shadowRoot(control).firstElementChild).toBe(controlTrigger);
    expect(controlTrigger.getAttribute("aria-label")).toBe("Session model mode: Exact");
    expect(controlTrigger.getAttribute("title")).toBe("Session model mode: Exact · openai/gpt-default · medium");
    expect(controlTrigger.textContent.trim()).toContain("Exact");
  });

  it("shows only the mode on a Tiered trigger, leaving tier and resolution to the tier menu", async () => {
    const control = await mountControl((element) => {
      element.status = tieredStatus();
    });

    const text = trigger(control).textContent.replace(/\s+/g, " ").trim();

    // The adjacent tier menu owns the tier name and its resolution; repeating
    // them here rendered the same tuple twice in the composer row. Pin the exact
    // content so any re-added span fails, not just the two known strings.
    expect(text).toBe("Tiered ▾");
    expect(shadowRoot(control).querySelectorAll("select")).toHaveLength(0);
    expect(shadowRoot(control).querySelectorAll("button")).toHaveLength(1);
  });

  it("keeps the full tiered tuple in the trigger tooltip", async () => {
    const control = await mountControl((element) => {
      element.status = tieredStatus();
    });

    const title = trigger(control).getAttribute("title") ?? "";

    expect(title).toContain("Tiered");
    expect(title).toContain("Advanced");
    expect(title).toContain("openai/gpt-advanced · high");
  });

  it("lets a Tiered trigger shrink and ellipsize inside its assigned narrow flex slot", async () => {
    const control = await mountControl((element) => {
      element.status = tieredStatus();
      element.style.width = "130px";
    });

    const triggerRule = componentStyleRule(".policy-trigger");
    const modeRule = componentStyleRule(".policy-mode");

    expect(control.style.width).toBe("130px");
    expect(triggerRule.flex).toBe("1 1 auto");
    expect(triggerRule.maxWidth).toBe("100%");
    expect(triggerRule.overflow).toBe("hidden");
    expect(modeRule.textOverflow).toBe("ellipsis");
  });

  it("stays visible from live status while policy data is loading", async () => {
    const control = await mountControl((element) => {
      element.status = tieredStatus();
      element.loading = true;
    });

    expect(trigger(control).isConnected).toBe(true);
  });

  it("surfaces a live block in the diagnostic chip", async () => {
    const control = await mountControl((element) => {
      element.status = { ...exactStatus(), blockedReason: "runtime rejected the persisted policy" };
    });

    const diagnostic = shadowRoot(control).querySelector<HTMLElement>(".policy-diagnostic");
    expect(diagnostic?.textContent).toContain("runtime rejected the persisted policy");
    expect(diagnostic?.getAttribute("title")).toContain("runtime rejected the persisted policy");
  });

  it("treats a blank blockedReason as no block rather than an empty chip", async () => {
    const control = await mountControl((element) => {
      element.status = { ...exactStatus(), blockedReason: "   " };
    });

    expect(shadowRoot(control).querySelector(".policy-diagnostic")).toBeNull();
  });

  it("renders nothing without any policy status", async () => {
    const control = await mountControl(() => undefined);

    expect(shadowRoot(control).querySelector(".policy-trigger")).toBeNull();
    expect(shadowRoot(control).querySelector(".policy-diagnostic")).toBeNull();
  });

  it("projects live Tiered ladder invalidity into the diagnostic chip", async () => {
    const control = await mountControl((element) => {
      element.status = { ...tieredStatus(), ladderValid: false };
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

    // The tooltip is where the resolved tuple now lives, so the no-substitution
    // guarantee is asserted there rather than in the mode-only pill text.
    const title = trigger(control).getAttribute("title") ?? "";

    expect(title).toContain("no thinking level");
    expect(title).not.toContain("· off");
  });
});

describe("mode menu", () => {
  it("opens a two-item menu from the trigger", async () => {
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.editable = true;
    });

    trigger(control).click();
    await control.updateComplete;

    const items = [...shadowRoot(control).querySelectorAll(".policy-mode-item")];
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.textContent.trim().split("\n")[0])).toEqual(["Exact model", "Tiered"]);
    expect(items.map((item) => item.querySelector(".policy-mode-hint")?.textContent.trim() ?? "").every((hint) => hint.length > 0)).toBe(true);
    expect(items.map((item) => item.querySelector(".policy-mode-check")?.textContent.trim())).toEqual(["✓", ""]);
    expect(items[0]?.getAttribute("aria-checked")).toBe("true");
    expect(items[1]?.getAttribute("aria-checked")).toBe("false");
  });

  it("reports the picked mode and closes", async () => {
    const picked: string[] = [];
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.editable = true;
      element.onSelectMode = (mode) => { picked.push(mode); };
    });
    trigger(control).click();
    await control.updateComplete;

    shadowRoot(control).querySelectorAll<HTMLElement>(".policy-mode-item")[1]?.click();
    await control.updateComplete;

    expect(picked).toEqual(["tiered"]);
    expect(shadowRoot(control).querySelector(".policy-mode-menu")).toBeNull();
  });

  it("closes on Escape without reporting a mode", async () => {
    const picked: string[] = [];
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.editable = true;
      element.onSelectMode = (mode) => { picked.push(mode); };
    });
    trigger(control).click();
    await control.updateComplete;

    shadowRoot(control).querySelector(".policy-mode-menu")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    await control.updateComplete;

    expect(picked).toEqual([]);
    expect(shadowRoot(control).querySelector(".policy-mode-menu")).toBeNull();
  });

  it("closes on an outside click", async () => {
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.editable = true;
    });
    trigger(control).click();
    await control.updateComplete;

    document.body.click();
    await control.updateComplete;

    expect(shadowRoot(control).querySelector(".policy-mode-menu")).toBeNull();
  });

  it("does not open while the control is not editable", async () => {
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.editable = false;
    });

    trigger(control).click();
    await control.updateComplete;

    expect(shadowRoot(control).querySelector(".policy-mode-menu")).toBeNull();
  });

  it("does not open while policy data is loading", async () => {
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.editable = true;
      element.loading = true;
    });

    trigger(control).click();
    await control.updateComplete;

    expect(shadowRoot(control).querySelector(".policy-mode-menu")).toBeNull();
  });

  it("does not open while a policy update is saving", async () => {
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.editable = true;
      element.saving = true;
    });

    trigger(control).click();
    await control.updateComplete;

    expect(shadowRoot(control).querySelector(".policy-mode-menu")).toBeNull();
  });

  it("allows a blocked policy to open and report a repair selection", async () => {
    const picked: string[] = [];
    const control = await mountControl((element) => {
      element.status = { ...exactStatus(), blockedReason: "MODEL_POLICY_BLOCKED: repair required" };
      element.editable = true;
      element.onSelectMode = (mode) => { picked.push(mode); };
    });

    trigger(control).click();
    await control.updateComplete;
    expect(shadowRoot(control).querySelector(".policy-mode-menu")).not.toBeNull();

    shadowRoot(control).querySelectorAll<HTMLElement>(".policy-mode-item")[1]?.click();
    await control.updateComplete;

    expect(picked).toEqual(["tiered"]);
  });

  it("removes its document click listener when disconnected", async () => {
    const addEventListener = vi.spyOn(document, "addEventListener");
    const removeEventListener = vi.spyOn(document, "removeEventListener");
    const control = await mountControl((element) => {
      element.status = exactStatus();
    });
    const clickRegistration = addEventListener.mock.calls.find(([type]) => type === "click");

    expect(clickRegistration).toBeDefined();
    control.remove();

    const matchingRemoval = removeEventListener.mock.calls.find(
      ([type, listener]) => type === "click" && listener === clickRegistration?.[1],
    );
    expect(matchingRemoval).toBeDefined();
    expect(matchingRemoval?.[2]).toBe(clickRegistration?.[2]);
  });
});

describe("SessionModelPolicyControl after panel retirement", () => {
  it("renders only the trigger and, when blocked, the diagnostic chip", async () => {
    const control = await mountControl((element) => {
      element.status = { ...exactStatus(), blockedReason: "MODEL_POLICY_BLOCKED: unverified tuple" };
    });

    expect(shadowRoot(control).querySelector(".policy-trigger")).not.toBeNull();
    expect(shadowRoot(control).querySelector(".policy-diagnostic")?.getAttribute("title")).toContain("MODEL_POLICY_BLOCKED");
    expect(shadowRoot(control).querySelector(".policy-panel")).toBeNull();
    expect(shadowRoot(control).querySelector("select")).toBeNull();
  });

  it("does not open a panel when the trigger is clicked", async () => {
    const control = await mountControl((element) => { element.status = exactStatus(); });

    trigger(control).click();
    await control.updateComplete;

    expect(shadowRoot(control).querySelector(".policy-panel")).toBeNull();
  });
});

describe("model policy labels", () => {
  it("keeps thinking levels in canonical ascending order", () => {
    expect(THINKING_LEVEL_ORDER).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("covers every level pi knows, so none sorts last as an unknown", () => {
    expect([...THINKING_LEVEL_ORDER]).toEqual([...KNOWN_THINKING_LEVELS]);
  });

  it("builds a stable provider-qualified model key", () => {
    expect(modelKey({ provider: "openai", id: "gpt-default" })).toBe("openai:gpt-default");
  });
});
