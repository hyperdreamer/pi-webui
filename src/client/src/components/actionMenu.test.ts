import { afterEach, describe, expect, it, vi } from "vitest";
import { actionMenuPanelStyle } from "./actionMenu";

describe("actionMenuPanelStyle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("can constrain menus to the viewport for compact shadow-root controls", () => {
    vi.stubGlobal("window", { innerWidth: 400, innerHeight: 800 });
    vi.stubGlobal("HTMLElement", FakeHTMLElement);

    const target = new FakeHTMLElement({ top: 10, right: 390, bottom: 46, left: 354 });

    expect(actionMenuPanelStyle(target, { constrainTo: "viewport" })).toBe("top: 46px; max-height: 754px; right: 10px; max-width: 390px;");
  });
});

class FakeHTMLElement extends EventTarget {
  constructor(private readonly rect: { top: number; right: number; bottom: number; left: number }) {
    super();
  }

  getBoundingClientRect(): { top: number; right: number; bottom: number; left: number } {
    return this.rect;
  }
}
