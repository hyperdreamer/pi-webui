import { describe, expect, it } from "vitest";
import { ActivityRail } from "./ActivityRail";
import { templateText, templateClickHandlerForText } from "../templateInspection.testSupport";

function getPrivateEventHandler(rail: ActivityRail, name: string): (event: Event) => void {
  const method: unknown = Reflect.get(rail, name);
  if (typeof method !== "function") throw new Error(`Expected private method ${name}`);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Reflect.get returns unknown; runtime guard ensures safety
  return method as (event: Event) => void;
}

function getPrivateVoidMethod(rail: ActivityRail, name: string): () => void {
  const method: unknown = Reflect.get(rail, name);
  if (typeof method !== "function") throw new Error(`Expected private method ${name}`);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Reflect.get returns unknown; runtime guard ensures safety
  return method as () => void;
}

describe("ActivityRail", () => {
  function createRail() {
    const rail = new ActivityRail();
    // Stub the desktop media query to simulate >= 1181px viewport.
    const desktopStub = {
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    Object.defineProperty(rail, "desktopMedia", { get: () => desktopStub });
    return rail;
  }

  function railText(rail: ActivityRail): string {
    return templateText(rail.render());
  }

  describe("desktop rendering", () => {
    it("renders the rail with placeholder icon button on desktop", () => {
      const rail = createRail();
      expect(railText(rail)).toContain("Open mystery tool");
    });

    it("does not render rail content when viewport is below 1181px", () => {
      const rail = new ActivityRail();
      const mobileStub = {
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      };
      Object.defineProperty(rail, "desktopMedia", { get: () => mobileStub });
      expect(railText(rail)).toBe("");
    });

    it("does not show the popup by default", () => {
      const rail = createRail();
      expect(railText(rail)).not.toContain("Achievement unlocked");
    });
  });

  describe("icon button", () => {
    it("uses a semantic button with accessible name", () => {
      const rail = createRail();
      expect(railText(rail)).toContain("Open mystery tool");
    });

    it("opens the popup when clicked", () => {
      const rail = createRail();
      const handler = templateClickHandlerForText(rail.render(), "Open mystery tool");
      expect(typeof handler).toBe("function");
      expect(railText(rail)).not.toContain("Achievement unlocked");
      handler(new Event("click"));
      expect(railText(rail)).toContain("Achievement unlocked");
    });
  });

  describe("popup", () => {
    function openPopup(rail: ActivityRail): void {
      getPrivateVoidMethod(rail, "openPopup")();
    }

    it("displays the popup with title, message, and close button", () => {
      const rail = createRail();
      openPopup(rail);
      const text = railText(rail);
      expect(text).toContain("Achievement unlocked");
      expect(text).toContain("You clicked the placeholder. The placeholder is very proud of you.");
      expect(text).toContain("Return to productivity");
    });

    it("exposes the popup heading as accessible label", () => {
      const rail = createRail();
      openPopup(rail);
      expect(railText(rail)).toContain("Achievement unlocked");
    });

    it("closes when the close button is clicked", () => {
      const rail = createRail();
      openPopup(rail);
      const result = rail.render();
      const handler = templateClickHandlerForText(result, "Return to productivity");
      expect(railText(rail)).toContain("Achievement unlocked");
      handler(new Event("click"));
      expect(railText(rail)).not.toContain("Achievement unlocked");
    });

    it("closes when the backdrop is clicked", () => {
      const rail = createRail();
      openPopup(rail);
      expect(railText(rail)).toContain("Achievement unlocked");

      const backdropHandler = getPrivateEventHandler(rail, "onBackdropClick");
      const clickEvent = new Event("click");
      const target = {};
      Object.defineProperty(clickEvent, "target", { value: target });
      Object.defineProperty(clickEvent, "currentTarget", { value: target });
      backdropHandler(clickEvent);
      expect(railText(rail)).not.toContain("Achievement unlocked");
    });

    it("does not close when clicking inside the popup", () => {
      const rail = createRail();
      openPopup(rail);
      expect(railText(rail)).toContain("Achievement unlocked");

      const backdropHandler = getPrivateEventHandler(rail, "onBackdropClick");
      const clickEvent = new Event("click");
      Object.defineProperty(clickEvent, "target", { value: {} });
      Object.defineProperty(clickEvent, "currentTarget", { value: {} });
      backdropHandler(clickEvent);
      expect(railText(rail)).toContain("Achievement unlocked");
    });

    it("closes on Escape key", () => {
      const rail = createRail();
      openPopup(rail);
      expect(railText(rail)).toContain("Achievement unlocked");

      const keydownHandler = getPrivateEventHandler(rail, "onPopupKeyDown");
      const escEvent = Object.assign(new Event("keydown"), { key: "Escape" });
      keydownHandler(escEvent);
      expect(railText(rail)).not.toContain("Achievement unlocked");
    });
  });

  describe("viewport resize handling", () => {
    function assertClosesBelow(rail: ActivityRail, matches: boolean) {
      getPrivateVoidMethod(rail, "openPopup")();
      expect(railText(rail)).toContain("Achievement unlocked");

      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- partial stub of MediaQueryListEvent
      getPrivateEventHandler(rail, "onDesktopMediaChange")({ matches } as MediaQueryListEvent);
    }

    it("closes the popup when viewport goes below 1181px", () => {
      const rail = createRail();
      assertClosesBelow(rail, false);
      expect(railText(rail)).not.toContain("Achievement unlocked");
    });

    it("does not close the popup when viewport stays above 1181px", () => {
      const rail = createRail();
      assertClosesBelow(rail, true);
      expect(railText(rail)).toContain("Achievement unlocked");
    });
  });

  describe("icon SVG", () => {
    it("marks the icon as hidden from assistive technology", () => {
      const rail = createRail();
      const result = rail.render();
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- accessing Lit private template shape
      const strings = Reflect.get(result, "strings") as readonly string[];
      const svgString = strings.join("");
      expect(svgString).toContain("aria-hidden");
    });
  });
});
