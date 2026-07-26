import { describe, expect, it, vi } from "vitest";
import { ActivityRail } from "./ActivityRail";
import { templateEventHandlerAfterMarker, templateText, templateClickHandlerForText, templateValueAfterMarker, templateEventHandlerNearMarker } from "../templateInspection.testSupport";
import { type ReorderableRailItem } from "../activityRailOrder";

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
    it("renders the rail without a Browser control", () => {
      const rail = createRail();
      expect(railText(rail)).toContain("Open terminal");
      expect(railText(rail)).toContain("Open Git Update Manager");
      expect(railText(rail)).not.toContain("Open browser");
      expect(railText(rail)).toContain("Open theme picker");
      expect(railText(rail)).toContain("Open system prompt");
      expect(railText(rail)).toContain("Open full history");
      expect(railText(rail)).toContain("Open system info");
      expect(railText(rail)).toContain("Open settings");
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

    it("does not expose a Browser callback or activity-rail icon", () => {
      const rail = createRail();

      expect("onOpenBrowser" in rail).toBe(false);
      expect(railText(rail)).not.toContain("Open browser");
    });

    it("opens Git Update Manager from its activity-rail icon", () => {
      const rail = createRail();
      const onOpenGitUpdateManager = vi.fn();
      rail.onOpenGitUpdateManager = onOpenGitUpdateManager;

      const handler = templateEventHandlerAfterMarker(rail.render(), "git-update-manager-button");
      handler(new Event("click"));

      expect(onOpenGitUpdateManager).toHaveBeenCalledOnce();
    });

    it("shows the Git Update Manager changed-file badge", () => {
      const rail = createRail();
      rail.gitUpdateManagerCount = 3;

      expect(railText(rail)).toContain("3 changed files");
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

    it("opens the theme picker when its icon is clicked", () => {
      const rail = createRail();
      const onOpenTheme = vi.fn();
      rail.onOpenTheme = onOpenTheme;

      const handler = templateEventHandlerAfterMarker(rail.render(), "theme-button");
      handler(new Event("click"));

      expect(onOpenTheme).toHaveBeenCalledOnce();
    });

    it("opens the System prompt when its left-rail icon is clicked", () => {
      const rail = createRail(0, true);
      const onOpenSystemPrompt = vi.fn();
      rail.onOpenSystemPrompt = onOpenSystemPrompt;

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

    it("opens system info from its rail icon", () => {
      const rail = createRail();
      const onOpenInfo = vi.fn();
      rail.onOpenInfo = onOpenInfo;

      const handler = templateEventHandlerAfterMarker(rail.render(), "info-button");
      handler(new Event("click"));

      expect(onOpenInfo).toHaveBeenCalledOnce();
    });

    it("opens settings from the bottom rail icon", () => {
      const rail = createRail();
      const onOpenSettings = vi.fn();
      rail.onOpenSettings = onOpenSettings;

      const handler = templateEventHandlerAfterMarker(rail.render(), "settings-button");
      handler(new Event("click"));

      expect(onOpenSettings).toHaveBeenCalledOnce();
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
      // templateText recurses into nested TemplateResults (each icon button
      // is now a separate template); templateStrings would only see the
      // top-level nav wrapper.
      expect(templateText(rail.render())).toContain("aria-hidden");
    });

    it("preserves the original System prompt document icon geometry", () => {
      expect(templateText(createRail().render())).toContain("M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z");
    });
  });

  describe("rail order", () => {
    it("renders non-browser reorderable buttons in the default order", () => {
      const rail = createRail();
      const text = railText(rail);
      const terminalPos = text.indexOf("Open terminal");
      const gitUpdateManagerPos = text.indexOf("Open Git Update Manager");
      const themePos = text.indexOf("Open theme picker");
      const spPos = text.indexOf("Open system prompt");
      const historyPos = text.indexOf("Open full history");
      const infoPos = text.indexOf("Open system info");
      expect(text).not.toContain("Open browser");
      expect(terminalPos).toBeLessThan(gitUpdateManagerPos);
      expect(gitUpdateManagerPos).toBeLessThan(themePos);
      expect(themePos).toBeLessThan(spPos);
      expect(spPos).toBeLessThan(historyPos);
      expect(historyPos).toBeLessThan(infoPos);
    });

    it("renders non-browser reorderable buttons in a custom railOrder", () => {
      const rail = createRail();
      const customOrder: ReorderableRailItem[] = ["info", "history", "git-update-manager", "terminal", "theme", "system-prompt"];
      rail.railOrder = customOrder;
      const text = railText(rail);
      const infoPos = text.indexOf("Open system info");
      const historyPos = text.indexOf("Open full history");
      const gitUpdateManagerPos = text.indexOf("Open Git Update Manager");
      const terminalPos = text.indexOf("Open terminal");
      const themePos = text.indexOf("Open theme picker");
      const spPos = text.indexOf("Open system prompt");
      expect(text).not.toContain("Open browser");
      expect(infoPos).toBeLessThan(historyPos);
      expect(historyPos).toBeLessThan(gitUpdateManagerPos);
      expect(gitUpdateManagerPos).toBeLessThan(terminalPos);
      expect(terminalPos).toBeLessThan(themePos);
      expect(themePos).toBeLessThan(spPos);
    });

    it("falls back to default order when railOrder is empty", () => {
      const rail = createRail();
      rail.railOrder = [];
      expect(railText(rail)).toContain("Open terminal");
      expect(railText(rail)).toContain("Open system info");
    });

    it("always renders the settings button last, after a spacer", () => {
      const rail = createRail();
      rail.railOrder = ["terminal", "git-update-manager", "theme", "system-prompt", "history", "info"];
      const text = railText(rail);
      const lastReorderablePos = text.indexOf("Open system info");
      const settingsPos = text.indexOf("Open settings");
      // Settings always appears after all reorderable items.
      expect(lastReorderablePos).toBeLessThan(settingsPos);

      // Swap order: settings should still be last.
      rail.railOrder = ["info", "history", "system-prompt", "theme", "git-update-manager", "terminal"];
      const text2 = railText(rail);
      const terminalPos2 = text2.indexOf("Open terminal");
      const settingsPos2 = text2.indexOf("Open settings");
      expect(terminalPos2).toBeLessThan(settingsPos2);
    });
  });

  describe("drag-and-drop", () => {
    it("nav has dragover and drop handlers", () => {
      const rail = createRail();
      const dragoverHandler = templateEventHandlerNearMarker(rail.render(), "@dragover=");
      expect(typeof dragoverHandler).toBe("function");
      const dropHandler = templateEventHandlerNearMarker(rail.render(), "@drop=");
      expect(typeof dropHandler).toBe("function");
    });

    it("reorderable buttons have dragstart and dragend handlers", () => {
      const rail = createRail();
      const markers = ["terminal-button", "git-update-manager-button", "theme-button", "system-prompt-button", "history-button", "info-button"];
      for (const marker of markers) {
        const dragStart = templateEventHandlerAfterMarker(rail.render(), marker);
        expect(typeof dragStart).toBe("function");
      }
    });

    it("settings button does not have drag handlers (it is fixed)", () => {
      const rail = createRail();
      // The settings button has no drag attributes because it is pinned.
      const text = railText(rail);
      expect(text).toContain("Open settings");
      // Settings button has no data-rail-item or draggable in its template.
      const afterSettingsMarker = text.indexOf("Open settings");
      const restAfterSettings = text.slice(afterSettingsMarker);
      expect(restAfterSettings).not.toContain("data-rail-item");
    });

    it("exposes railOrder and onRailOrderChange for parent wiring", () => {
      const rail = createRail();
      expect(rail.railOrder).toHaveLength(6);
      expect(rail.railOrder).toContain("terminal");
      expect(rail.railOrder).not.toContain("browser");
      expect(rail.railOrder).toContain("git-update-manager");
      // info IS now in railOrder (it is reorderable).
      expect(rail.railOrder).toContain("info");
      // settings is NOT in railOrder (it's always fixed).
      expect(rail.railOrder).not.toContain("settings");

      const onRailOrderChange = vi.fn();
      rail.onRailOrderChange = onRailOrderChange;
      expect(rail.onRailOrderChange).toBe(onRailOrderChange);
    });
  });
});
