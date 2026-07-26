import { afterEach, describe, expect, it, vi } from "vitest";
import { actionMenuPanelStyle, isClickWithinActionMenu } from "./actionMenu";

describe("action menu utilities", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("can constrain menus to the viewport for compact shadow-root controls", () => {
    vi.stubGlobal("window", { innerWidth: 400, innerHeight: 800 });
    vi.stubGlobal("HTMLElement", FakeHTMLElement);

    const target = new FakeHTMLElement({ top: 10, right: 390, bottom: 46, left: 354 });

    expect(actionMenuPanelStyle(target, { constrainTo: "viewport" })).toBe("top: 46px; max-height: 754px; right: 10px; max-width: 390px;");
  });

  it("recognizes clicks inside an action menu in its render root", () => {
    vi.stubGlobal("HTMLElement", FakeHTMLElement);
    const renderRoot = new EventTarget();
    const menuTarget = new FakeHTMLElement({ top: 0, right: 0, bottom: 0, left: 0 }, renderRoot, true);

    expect(isClickWithinActionMenu(clickEvent([menuTarget]), renderRoot)).toBe(true);
  });
});

class FakeHTMLElement extends EventTarget {
  constructor(
    private readonly rect: { top: number; right: number; bottom: number; left: number },
    private readonly root = new EventTarget(),
    private readonly isInsideActionMenu = false,
  ) {
    super();
  }

  getBoundingClientRect(): { top: number; right: number; bottom: number; left: number } {
    return this.rect;
  }

  getRootNode(): EventTarget {
    return this.root;
  }

  closest(selector: string): FakeHTMLElement | null {
    return selector === ".action-menu" && this.isInsideActionMenu ? this : null;
  }
}

function clickEvent(path: EventTarget[]): Event {
  const event = new Event("click");
  Object.defineProperty(event, "composedPath", { value: () => path });
  return event;
}
