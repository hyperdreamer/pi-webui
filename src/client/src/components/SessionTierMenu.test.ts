// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import "./SessionTierMenu";
import { MODEL_TIERS, type ModelTier, type ModelTierSettingsResponse } from "../../../shared/apiTypes";
import { SessionTierMenu } from "./SessionTierMenu";

function catalogFixture(): ModelTierSettingsResponse {
  const model = { provider: "openai", id: "gpt-default" };
  return {
    contractVersion: 1,
    ladder: {
      economy: { model, thinkingLevel: "medium" },
      fast: { model, thinkingLevel: "medium" },
      standard: { model, thinkingLevel: "medium" },
      advanced: { model, thinkingLevel: "medium" },
      capable: { model, thinkingLevel: "medium" },
      frontier: { model, thinkingLevel: "medium" },
    },
    models: [{ model, name: "Default", thinkingLevels: ["low", "medium", "high"] }],
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

async function mountMenu(configure: (element: SessionTierMenu) => void): Promise<SessionTierMenu> {
  const element = new SessionTierMenu();
  configure(element);
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function root(element: SessionTierMenu): ShadowRoot {
  const shadow = element.shadowRoot;
  if (shadow === null) throw new Error("no shadow root");
  return shadow;
}

async function open(element: SessionTierMenu): Promise<void> {
  root(element).querySelector<HTMLButtonElement>(".tier-trigger")?.click();
  await element.updateComplete;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("SessionTierMenu", () => {
  it("lists all six tiers in canonical order with their resolutions", async () => {
    const element = await mountMenu((el) => {
      el.catalog = catalogFixture();
      el.selectedTier = "standard";
      el.editable = true;
      el.label = "Standard";
    });
    await open(element);

    const items = [...root(element).querySelectorAll(".tier-item")];
    expect(items).toHaveLength(6);
    expect(items.map((item) => item.getAttribute("data-tier"))).toEqual([...MODEL_TIERS]);
    expect(items[2]?.getAttribute("aria-checked")).toBe("true");
    expect(items[0]?.textContent).toContain("openai/gpt-default · medium");
  });

  it("marks an unconfigured tier unselectable with its reason and refuses to pick it", async () => {
    const catalog = catalogFixture();
    catalog.rows.advanced = { valid: false, reason: "Advanced is not configured" };
    const picked: ModelTier[] = [];
    const element = await mountMenu((el) => {
      el.catalog = catalog;
      el.selectedTier = "standard";
      el.editable = true;
      el.label = "Standard";
      el.onSelectTier = (tier) => { picked.push(tier); };
    });
    await open(element);

    const advanced = root(element).querySelector<HTMLElement>('.tier-item[data-tier="advanced"]');
    expect(advanced?.getAttribute("aria-disabled")).toBe("true");
    expect(advanced?.classList.contains("tier-item-invalid")).toBe(true);
    expect(advanced?.textContent).toContain("Advanced is not configured");
    advanced?.click();
    await element.updateComplete;
    expect(picked).toEqual([]);
  });

  it("reports a valid tier and closes", async () => {
    const picked: ModelTier[] = [];
    const element = await mountMenu((el) => {
      el.catalog = catalogFixture();
      el.selectedTier = "standard";
      el.editable = true;
      el.label = "Standard";
      el.onSelectTier = (tier) => { picked.push(tier); };
    });
    await open(element);

    root(element).querySelector<HTMLElement>('.tier-item[data-tier="frontier"]')?.click();
    await element.updateComplete;

    expect(picked).toEqual(["frontier"]);
    expect(root(element).querySelector(".tier-menu")).toBeNull();
  });

  it("closes on Escape without selecting a tier", async () => {
    const picked: ModelTier[] = [];
    const element = await mountMenu((el) => {
      el.catalog = catalogFixture();
      el.selectedTier = "standard";
      el.editable = true;
      el.label = "Standard";
      el.onSelectTier = (tier) => { picked.push(tier); };
    });
    await open(element);

    root(element).querySelector(".tier-menu")?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      composed: true,
    }));
    await element.updateComplete;

    expect(picked).toEqual([]);
    expect(root(element).querySelector(".tier-menu")).toBeNull();
    expect(root(element).activeElement).toBe(root(element).querySelector(".tier-trigger"));
  });

  it("closes on an outside click", async () => {
    const element = await mountMenu((el) => {
      el.catalog = catalogFixture();
      el.selectedTier = "standard";
      el.editable = true;
      el.label = "Standard";
    });
    await open(element);

    document.body.click();
    await element.updateComplete;

    expect(root(element).querySelector(".tier-menu")).toBeNull();
  });

  it("does not open when it is not editable", async () => {
    const element = await mountMenu((el) => {
      el.catalog = catalogFixture();
      el.editable = false;
      el.label = "Standard";
    });
    await open(element);
    expect(root(element).querySelector(".tier-menu")).toBeNull();
  });

  it("removes its capture-phase document click listener when disconnected", async () => {
    const addEventListener = vi.spyOn(document, "addEventListener");
    const removeEventListener = vi.spyOn(document, "removeEventListener");
    const element = await mountMenu((el) => {
      el.catalog = catalogFixture();
      el.label = "Standard";
    });
    const clickRegistration = addEventListener.mock.calls.find(([type]) => type === "click");

    expect(clickRegistration).toBeDefined();
    element.remove();

    const matchingRemoval = removeEventListener.mock.calls.find(
      ([type, listener]) => type === "click" && listener === clickRegistration?.[1],
    );
    expect(matchingRemoval).toBeDefined();
    expect(clickRegistration?.[2]).toBe(true);
    expect(matchingRemoval?.[2]).toBe(clickRegistration?.[2]);
  });
});
