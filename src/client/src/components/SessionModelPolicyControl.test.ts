// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import type { ClientSessionModelPolicyStatus } from "../../../shared/apiTypes";
import { SessionModelPolicyControl } from "./SessionModelPolicyControl";
import { modelKey, THINKING_LEVEL_ORDER } from "./modelPolicyLabels";

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

  it("lets a Tiered trigger shrink and ellipsize inside its assigned narrow flex slot", async () => {
    const control = await mountControl((element) => {
      element.status = tieredStatus();
      element.style.width = "130px";
    });

    const triggerRule = componentStyleRule(".policy-trigger");
    const resolutionRule = componentStyleRule(".policy-tier, .policy-resolution");

    expect(control.style.width).toBe("130px");
    expect(triggerRule.flex).toBe("1 1 auto");
    expect(triggerRule.maxWidth).toBe("100%");
    expect(triggerRule.overflow).toBe("hidden");
    expect(resolutionRule.textOverflow).toBe("ellipsis");
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

    const text = trigger(control).textContent.replace(/\s+/g, " ");

    expect(text).toContain("no thinking level");
    expect(text).not.toContain("· off");
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
    expect(THINKING_LEVEL_ORDER).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
  });

  it("builds a stable provider-qualified model key", () => {
    expect(modelKey({ provider: "openai", id: "gpt-default" })).toBe("openai:gpt-default");
  });
});
