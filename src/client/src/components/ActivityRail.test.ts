import { describe, expect, it, vi } from "vitest";
import { ActivityRail } from "./ActivityRail";
import { templateEventHandlerAfterMarker, templateStrings, templateText, templateClickHandlerForText, templateValueAfterMarker } from "../templateInspection.testSupport";

describe("ActivityRail", () => {
  function createRail(terminalCount = 0, systemPromptEnabled = false) {
    const rail = new ActivityRail();
    const desktopStub = {
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    Object.defineProperty(rail, "desktopMedia", { get: () => desktopStub });
    rail.terminalCount = terminalCount;
    rail.systemPromptEnabled = systemPromptEnabled;
    return rail;
  }

  function railText(rail: ActivityRail): string {
    return templateText(rail.render());
  }

  describe("desktop rendering", () => {
    it("renders the rail with terminal, System prompt, and Full history icon buttons on desktop", () => {
      const rail = createRail();
      expect(railText(rail)).toContain("Open terminal");
      expect(railText(rail)).toContain("Open system prompt");
      expect(railText(rail)).toContain("Open full history");
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
  });

  describe("icon button", () => {
    it("uses a semantic button with accessible name", () => {
      const rail = createRail();
      expect(railText(rail)).toContain("Open terminal");
    });

    it("calls onOpenTerminal callback when clicked", () => {
      const rail = createRail();
      const onOpenTerminal = vi.fn();
      rail.onOpenTerminal = onOpenTerminal;

      const handler = templateClickHandlerForText(rail.render(), "Open terminal");
      expect(typeof handler).toBe("function");
      expect(onOpenTerminal).not.toHaveBeenCalled();
      handler(new Event("click"));
      expect(onOpenTerminal).toHaveBeenCalledOnce();
    });

    it("opens the System prompt when its left-rail icon is clicked", () => {
      const rail = createRail(0, true);
      const onOpenSystemPrompt = vi.fn();
      rail.onOpenSystemPrompt = onOpenSystemPrompt;

      // The rail has two icon buttons; anchor to the System button's stable
      // semantic class rather than relying on handler order.
      const handler = templateEventHandlerAfterMarker(rail.render(), "system-prompt-button");
      handler(new Event("click"));

      expect(onOpenSystemPrompt).toHaveBeenCalledOnce();
    });

    it("disables Full history until a persisted session is selected", () => {
      const rail = createRail();
      expect(templateValueAfterMarker(rail.render(), "history-button")).toBe(true);

      rail.historyEnabled = true;
      expect(templateValueAfterMarker(rail.render(), "history-button")).toBe(false);
    });

    it("opens Full history when its enabled left-rail icon is clicked", () => {
      const rail = createRail();
      const onOpenHistory = vi.fn();
      rail.historyEnabled = true;
      rail.onOpenHistory = onOpenHistory;

      expect(railText(rail)).toContain("Open full history");
      const handler = templateEventHandlerAfterMarker(rail.render(), "history-button");
      handler(new Event("click"));

      expect(onOpenHistory).toHaveBeenCalledOnce();
    });

    it("is safe to click when no callback is provided", () => {
      const rail = createRail();
      const handler = templateClickHandlerForText(rail.render(), "Open terminal");
      expect(() => { handler(new Event("click")); }).not.toThrow();
    });
  });

  describe("terminal count badge", () => {
    it("shows no badge when terminalCount is 0", () => {
      const rail = createRail(0);
      expect(railText(rail)).not.toContain("active terminal");
    });

    it("shows a badge with the count when terminalCount is positive", () => {
      const rail = createRail(3);
      expect(railText(rail)).toContain("3");
    });

    it("announces active terminal count in the accessible label", () => {
      const rail = createRail(4);
      expect(railText(rail)).toContain("4 active terminals");
    });

    it("announces singular active terminal count", () => {
      const rail = createRail(1);
      expect(railText(rail)).toContain("1 active terminal");
    });
  });

  describe("icon SVG", () => {
    it("marks the icon as hidden from assistive technology", () => {
      const rail = createRail();
      const svgString = templateStrings(rail.render()).join("");
      expect(svgString).toContain("aria-hidden");
    });

    it("preserves the original System prompt document icon geometry", () => {
      const svgString = templateStrings(createRail().render()).join("");
      expect(svgString).toContain("M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z");
    });
  });
});
