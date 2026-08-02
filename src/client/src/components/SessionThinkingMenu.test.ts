// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import "./SessionThinkingMenu";
import { SessionThinkingMenu } from "./SessionThinkingMenu";
import { thinkingLevelOptions } from "./thinkingLevelOptions";

async function mountMenu(configure: (element: SessionThinkingMenu) => void): Promise<SessionThinkingMenu> {
  const element = new SessionThinkingMenu();
  configure(element);
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function root(element: SessionThinkingMenu): ShadowRoot {
  const shadow = element.shadowRoot;
  if (shadow === null) throw new Error("no shadow root");
  return shadow;
}

async function open(element: SessionThinkingMenu): Promise<void> {
  root(element).querySelector<HTMLButtonElement>(".thinking-trigger")?.click();
  await element.updateComplete;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("SessionThinkingMenu", () => {
  it("renders supported levels as selectable and unsupported ones as disabled", async () => {
    const element = await mountMenu((el) => {
      el.options = thinkingLevelOptions({
        supported: ["off", "low"],
        all: ["off", "low", "medium"],
        selected: "low",
      });
      el.label = "low";
      el.editable = true;
    });
    await open(element);

    const items = [...root(element).querySelectorAll(".thinking-item")];
    expect(items.map((item) => item.getAttribute("data-level"))).toEqual(["off", "low", "medium"]);
    expect(items[2]?.getAttribute("aria-disabled")).toBe("true");
    expect(items[2]?.classList.contains("thinking-item-unsupported")).toBe(true);
    expect(items[1]?.getAttribute("aria-checked")).toBe("true");
    expect(items[1]?.textContent).toContain("Light reasoning (~2k tokens)");
    expect(items[2]?.textContent).toContain("unsupported by this model");
  });

  it("reports a supported level and refuses an unsupported one", async () => {
    const picked: string[] = [];
    const element = await mountMenu((el) => {
      el.options = thinkingLevelOptions({
        supported: ["off", "low"],
        all: ["off", "low", "medium"],
        selected: "low",
      });
      el.label = "low";
      el.editable = true;
      el.onSelectLevel = (level) => { picked.push(level); };
    });
    await open(element);

    root(element).querySelector<HTMLElement>('.thinking-item[data-level="medium"]')?.click();
    await element.updateComplete;
    expect(picked).toEqual([]);

    root(element).querySelector<HTMLElement>('.thinking-item[data-level="off"]')?.click();
    await element.updateComplete;
    expect(picked).toEqual(["off"]);
    expect(root(element).querySelector(".thinking-menu")).toBeNull();
  });

  it("closes on Escape without selecting a level", async () => {
    const picked: string[] = [];
    const element = await mountMenu((el) => {
      el.options = thinkingLevelOptions({ supported: ["off", "low"], all: [], selected: "low" });
      el.label = "low";
      el.editable = true;
      el.onSelectLevel = (level) => { picked.push(level); };
    });
    await open(element);

    root(element).querySelector(".thinking-menu")?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      composed: true,
    }));
    await element.updateComplete;

    expect(picked).toEqual([]);
    expect(root(element).querySelector(".thinking-menu")).toBeNull();
    expect(root(element).activeElement).toBe(root(element).querySelector(".thinking-trigger"));
  });

  it("closes on an outside click", async () => {
    const element = await mountMenu((el) => {
      el.options = thinkingLevelOptions({ supported: ["off", "low"], all: [], selected: "low" });
      el.label = "low";
      el.editable = true;
    });
    await open(element);

    document.body.click();
    await element.updateComplete;

    expect(root(element).querySelector(".thinking-menu")).toBeNull();
  });

  it("does not open when it is not editable", async () => {
    const element = await mountMenu((el) => {
      el.options = thinkingLevelOptions({ supported: ["off", "low"], all: [], selected: "low" });
      el.label = "low";
      el.editable = false;
    });
    await open(element);

    expect(root(element).querySelector(".thinking-menu")).toBeNull();
  });

  it("removes its capture-phase document click listener when disconnected", async () => {
    const addEventListener = vi.spyOn(document, "addEventListener");
    const removeEventListener = vi.spyOn(document, "removeEventListener");
    const element = await mountMenu((el) => {
      el.options = thinkingLevelOptions({ supported: ["off", "low"], all: [], selected: "low" });
      el.label = "low";
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
