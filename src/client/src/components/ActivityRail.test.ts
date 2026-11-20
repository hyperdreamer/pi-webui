// @vitest-environment jsdom

import { LitElement, html } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityRail } from "./ActivityRail";
import { templateEventHandlerAfterMarker, templateText, templateClickHandlerForText, templateValueAfterMarker, templateEventHandlerNearMarker } from "../templateInspection.testSupport";
import { type ReorderableRailItem } from "../activityRailOrder";
import type { NotificationPresentation } from "../notificationPresentation";
import type { SelectedSessionNotificationView, SessionNotificationTarget } from "../sessionNotifications";
import type { ActivityRailDisplayItem } from "../plugins/activityRail";

const notificationTarget: SessionNotificationTarget = { machineId: "local", sessionId: "session-1", cwd: "/repo" };

function notificationPresentation(total: number): NotificationPresentation {
  const retainedCount = Math.min(total, 100);
  const discardedCount = Math.max(total - 100, 0);
  const view: SelectedSessionNotificationView = {
    ...notificationTarget,
    daemonInstanceId: "daemon-a",
    notifications: [],
    retainedCount,
    discardedCount,
    dismissThrough: { order: 0, overflowWatermark: discardedCount },
    pendingDismissedIds: new Set(),
    dismissAllPending: false,
    announcements: [],
  };
  return { kind: "fresh", target: notificationTarget, view, operation: "idle" };
}

async function mountRail(configure: (rail: ActivityRail) => void = () => undefined): Promise<ActivityRail> {
  const rail = new ActivityRail();
  configure(rail);
  document.body.append(rail);
  await rail.updateComplete;
  return rail;
}

function railRoot(rail: ActivityRail): ShadowRoot {
  const shadowRoot = rail.shadowRoot;
  if (shadowRoot === null) throw new Error("Expected an open rail shadow root");
  return shadowRoot;
}

function reloadButton(rail: ActivityRail): HTMLButtonElement {
  const button = railRoot(rail).querySelector<HTMLButtonElement>(".rail-reload-button");
  if (button === null) throw new Error("Expected the rail reload button");
  return button;
}

function notificationButton(rail: ActivityRail): HTMLButtonElement {
  const button = railRoot(rail).querySelector<HTMLButtonElement>("button.icon-button.notifications-button");
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (button === null) throw new Error("Expected the fixed notification bell");
  return button;
}

function expectReloadBellSettingsOrder(rail: ActivityRail): void {
  const bell = notificationButton(rail);
  expect(reloadButton(rail).nextElementSibling).toBe(bell);
  expect(bell.nextElementSibling).toBe(railRoot(rail).querySelector("button.settings-button"));
}

type DesktopMediaListener = (event: MediaQueryListEvent) => void;

/**
 * jsdom exposes `window.matchMedia` as an undefined accessor, so every real
 * `ActivityRail` construction needs an explicit media fake instead of trusting
 * the environment. The stub is a full `MediaQueryList` because the component
 * subscribes in `connectedCallback` and unsubscribes when disconnected.
 */
function mediaQueryList(matches: boolean): MediaQueryList {
  return {
    matches,
    media: "(min-width: 1181px)",
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => mediaQueryList(true));
});

class FakeDesktopMediaQueryEvent extends Event {
  readonly media = "";

  constructor(readonly matches: boolean) {
    super("change");
  }
}

class FakeRailButton extends EventTarget {}

interface DesktopMediaStub {
  matches: boolean;
  addEventListener(type: string, listener: DesktopMediaListener): void;
  removeEventListener(type: string, listener: DesktopMediaListener): void;
  dispatchChange(matches: boolean): void;
}

function createDesktopMediaStub(initialMatches: boolean): DesktopMediaStub {
  const listeners = new Set<DesktopMediaListener>();
  return {
    matches: initialMatches,
    addEventListener: (_type, listener) => { listeners.add(listener); },
    removeEventListener: (_type, listener) => { listeners.delete(listener); },
    dispatchChange(matches) {
      this.matches = matches;
      for (const listener of listeners) listener(new FakeDesktopMediaQueryEvent(matches));
    },
  };
}

function eventWithTargets(type: string, target: EventTarget, currentTarget: EventTarget): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    currentTarget: { value: currentTarget },
    target: { value: target },
  });
  return event;
}

function eventWithCurrentTarget(type: string, currentTarget: EventTarget): Event {
  const event = new Event(type);
  Object.defineProperty(event, "currentTarget", { value: currentTarget });
  return event;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ActivityRail", () => {
  function pluginItems(): ActivityRailDisplayItem[] {
    return [
      { id: "tasks:open", title: "Tasks", icon: html`<svg data-icon="tasks"></svg>` },
      { id: "memory:open", title: "Memory", icon: html`<svg data-icon="brain"></svg>`, badge: 2 },
    ];
  }

  function createRail(terminalCount = 0, systemPromptEnabled = false, desktopMedia: DesktopMediaStub = createDesktopMediaStub(true)) {
    const rail = new ActivityRail();
    Object.defineProperty(rail, "desktopMedia", { get: () => desktopMedia });
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

    it("renders nothing below the desktop breakpoint while the compact drawer is closed", () => {
      const rail = createRail(0, false, createDesktopMediaStub(false));
      rail.compactOpen = false;

      expect(railText(rail)).toBe("");
    });
  });

  describe("plugin controls", () => {
    it("renders supplied plugin controls in a circular, non-draggable section after core controls", () => {
      const rail = createRail();
      rail.pluginItems = pluginItems();
      const text = railText(rail);
      const infoPos = text.indexOf("Open system info");
      const separatorPos = text.indexOf("rail-plugin-separator");
      const tasksPos = text.indexOf("Tasks");
      const memoryPos = text.indexOf("Memory");
      const spacerPos = text.indexOf("rail-spacer");
      const settingsPos = text.indexOf("Open settings");
      const pluginSection = text.slice(separatorPos, spacerPos);

      expect(infoPos).toBeLessThan(separatorPos);
      expect(separatorPos).toBeLessThan(tasksPos);
      expect(tasksPos).toBeLessThan(memoryPos);
      expect(memoryPos).toBeLessThan(spacerPos);
      expect(spacerPos).toBeLessThan(settingsPos);
      expect(pluginSection).toContain('class="icon-button plugin-rail-button"');
      expect(pluginSection).not.toContain("draggable");
      expect(pluginSection).not.toContain("data-rail-item");
      expect(text).toContain("Memory, 2");
      expect(ActivityRail.styles.cssText).toMatch(/\.plugin-rail-button\s*\{[^}]*border-radius:\s*50%/);
    });

    it("does not render a plugin separator when no plugin controls are supplied", () => {
      expect(railText(createRail())).not.toContain("rail-plugin-separator");
    });
  });

  describe("compact drawer", () => {
    function createCompactRail() {
      const rail = createRail(0, false, createDesktopMediaStub(false));
      rail.pluginItems = pluginItems();
      rail.compactOpen = true;
      return rail;
    }

    it("renders the activity rail in a labelled overlay with close, backdrop, and Escape controls", () => {
      const rail = createCompactRail();
      const text = railText(rail);

      expect(text).toContain('role="dialog"');
      expect(text).toContain('aria-label="Activity rail"');
      expect(text).toContain("Tasks");
      expect(text).toContain("Memory");
      expect(text).toContain("Close activity rail");
      expect(text).toContain("compact-rail-backdrop");
      expect(text).toContain("@mousedown=");
      expect(text).toContain("@keydown=");
    });

    // TemplateResult handler extraction is proportionate here: this pins only the
    // backdrop's target check, and a DOM mousedown would not distinguish the
    // backdrop itself from a descendant any more directly.
    it("closes only when the compact drawer backdrop itself is pressed", () => {
      const rail = createCompactRail();
      const onCloseCompact = vi.fn();
      rail.onCloseCompact = onCloseCompact;
      const backdrop = new EventTarget();
      const handler = templateEventHandlerNearMarker(rail.render(), "compact-rail-backdrop");

      handler(eventWithTargets("mousedown", new EventTarget(), backdrop));
      expect(onCloseCompact).not.toHaveBeenCalled();

      handler(eventWithTargets("mousedown", backdrop, backdrop));
      expect(onCloseCompact).toHaveBeenCalledOnce();
    });

    it("closes the compact drawer with Escape and its close control", () => {
      const rail = createCompactRail();
      const onCloseCompact = vi.fn();
      rail.onCloseCompact = onCloseCompact;
      const escapeHandler = templateEventHandlerNearMarker(rail.render(), "@keydown=");
      const closeHandler = templateClickHandlerForText(rail.render(), "Close activity rail");

      escapeHandler(Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" }));
      closeHandler(new Event("click"));

      expect(onCloseCompact).toHaveBeenCalledTimes(2);
    });

    it("closes the compact drawer before invoking a core action", () => {
      const rail = createCompactRail();
      const calls: string[] = [];
      rail.onCloseCompact = () => { calls.push("close"); };
      rail.onOpenTerminal = () => { calls.push("terminal"); };

      templateClickHandlerForText(rail.render(), "Open terminal")(new Event("click"));

      expect(calls).toEqual(["close", "terminal"]);
    });

    it("closes the compact drawer before invoking a plugin action with its source", () => {
      const rail = createCompactRail();
      const calls: string[] = [];
      const source = new FakeRailButton();
      vi.stubGlobal("HTMLElement", FakeRailButton);
      rail.onCloseCompact = () => { calls.push("close"); };
      rail.onOpenPluginActivity = (id, receivedSource) => {
        expect(receivedSource).toBe(source);
        calls.push(`plugin:${id}`);
      };

      templateClickHandlerForText(rail.render(), "Memory, 2")(eventWithCurrentTarget("click", source));

      expect(calls).toEqual(["close", "plugin:memory:open"]);
    });

    it("clears compact-open state and requests an update after a desktop resize", () => {
      const desktopMedia = createDesktopMediaStub(false);
      const rail = createRail(0, false, desktopMedia);
      const requestUpdate = vi.spyOn(rail, "requestUpdate");
      const baseConnectedCallback = vi.spyOn(LitElement.prototype, "connectedCallback").mockImplementation(() => undefined);
      const baseDisconnectedCallback = vi.spyOn(LitElement.prototype, "disconnectedCallback").mockImplementation(() => undefined);
      rail.compactOpen = true;
      rail.onCloseCompact = () => { rail.compactOpen = false; };

      try {
        rail.connectedCallback();
        requestUpdate.mockClear();
        desktopMedia.dispatchChange(true);

        expect(rail.compactOpen).toBe(false);
        expect(requestUpdate).toHaveBeenCalled();
      } finally {
        rail.disconnectedCallback();
        baseConnectedCallback.mockRestore();
        baseDisconnectedCallback.mockRestore();
      }
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

  describe("fixed reload control", () => {
    it("renders no reload control while showReload is false", async () => {
      const rail = await mountRail((instance) => { instance.showReload = false; });

      expect(rail.shadowRoot?.querySelectorAll(".rail-reload-button")).toHaveLength(0);
      expect(rail.shadowRoot?.querySelector("button[aria-label='Full page reload']")).toBeNull();
    });

    it("renders one fixed reload control while showReload is true", async () => {
      const rail = await mountRail((instance) => { instance.showReload = true; });

      const reload = reloadButton(rail);
      expect(rail.shadowRoot?.querySelectorAll(".rail-reload-button")).toHaveLength(1);
      expect(reload.classList).toContain("icon-button");
      expect(reload.type).toBe("button");
      expect(reload.getAttribute("title")).toBe("Full page reload");
      expect(reload.getAttribute("aria-label")).toBe("Full page reload");
      const icon = reload.querySelector("svg");
      if (icon === null) throw new Error("Expected the reload icon");
      expect(icon.getAttribute("aria-hidden")).toBe("true");
      expect(icon.getAttribute("focusable")).toBe("false");
    });

    it("keeps reload in one fixed slot between the spacer and Notifications", async () => {
      const rail = await mountRail((instance) => { instance.showReload = true; });

      expect(railRoot(rail).querySelector(".rail-spacer")?.nextElementSibling).toBe(reloadButton(rail));
      expectReloadBellSettingsOrder(rail);

      rail.railOrder = ["info", "history", "git-update-manager", "terminal", "theme", "system-prompt"];
      await rail.updateComplete;

      expect(railRoot(rail).querySelector(".rail-spacer")?.nextElementSibling).toBe(reloadButton(rail));
      expectReloadBellSettingsOrder(rail);
    });

    it("keeps reload in the fixed slot with and without plugin controls", async () => {
      const rail = await mountRail((instance) => {
        instance.showReload = true;
        instance.pluginItems = pluginItems();
      });

      expect(reloadButton(rail).previousElementSibling?.className).toBe("rail-spacer");
      expectReloadBellSettingsOrder(rail);
      expect(rail.shadowRoot?.querySelectorAll(".rail-plugin-separator")).toHaveLength(1);

      rail.pluginItems = [];
      await rail.updateComplete;

      expect(railRoot(rail).querySelector(".rail-spacer")?.nextElementSibling).toBe(reloadButton(rail));
      expectReloadBellSettingsOrder(rail);
    });

    it("renders reload in the compact drawer using the same fixed slot", async () => {
      vi.stubGlobal("matchMedia", () => mediaQueryList(false));
      const rail = await mountRail((instance) => {
        instance.showReload = true;
        instance.compactOpen = true;
      });

      expect(rail.shadowRoot?.querySelectorAll(".rail-reload-button")).toHaveLength(1);
      expect(railRoot(rail).querySelector(".rail-spacer")?.nextElementSibling).toBe(reloadButton(rail));
      expectReloadBellSettingsOrder(rail);
    });

    it("renders effective notification count badges at the required boundaries", async () => {
      for (const total of [0, 1, 99, 100, 103]) {
        const rail = await mountRail((instance) => {
          instance.notificationPresentation = notificationPresentation(total);
          instance.notificationSessionTitle = "Build session";
        });
        const bell = notificationButton(rail);
        expect(bell.getAttribute("aria-label")).toContain(`${String(total)} notifications`);
        const badge = railRoot(rail).querySelector(".rail-badge");
        if (total === 0) expect(badge).toBeNull();
        else expect(badge?.textContent).toBe(total > 99 ? "99+" : String(total));
        document.body.replaceChildren();
      }
    });

    it("keeps the disabled bell between the spacer and Settings and out of drag ordering", async () => {
      const onRailOrderChange = vi.fn();
      const rail = await mountRail((instance) => { instance.onRailOrderChange = onRailOrderChange; });
      const bell = notificationButton(rail);
      expect(railRoot(rail).querySelector(".rail-spacer")?.nextElementSibling).toBe(bell);
      expect(bell.nextElementSibling).toBe(railRoot(rail).querySelector("button.settings-button"));
      expect(bell.disabled).toBe(true);
      expect(bell.getAttribute("aria-expanded")).toBe("false");
      expect(bell.hasAttribute("data-rail-item")).toBe(false);
      expect(bell.hasAttribute("draggable")).toBe(false);
      bell.dispatchEvent(new Event("dragstart", { bubbles: true }));
      railRoot(rail).querySelector(".info-button")?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
      expect(onRailOrderChange).not.toHaveBeenCalled();
    });

    it("excludes reload from ordering attributes, drag metadata, and railOrder", async () => {
      const rail = await mountRail((instance) => { instance.showReload = true; });
      const reload = reloadButton(rail);

      expect(reload.hasAttribute("data-rail-item")).toBe(false);
      expect(reload.hasAttribute("draggable")).toBe(false);
      expect(reload.draggable).toBe(false);
      expect(rail.railOrder).not.toContain("reload");
      expect(rail.railOrder).toHaveLength(6);
    });

    it("invokes onReload once when the reload control is clicked", async () => {
      const onReload = vi.fn();
      const rail = await mountRail((instance) => {
        instance.showReload = true;
        instance.onReload = onReload;
      });

      reloadButton(rail).click();

      expect(onReload).toHaveBeenCalledOnce();
    });

    it("closes the compact drawer before reloading", async () => {
      vi.stubGlobal("matchMedia", () => mediaQueryList(false));
      const calls: string[] = [];
      const rail = await mountRail((instance) => {
        instance.showReload = true;
        instance.compactOpen = true;
        instance.onCloseCompact = () => { calls.push("close"); };
        instance.onReload = () => { calls.push("reload"); };
      });

      reloadButton(rail).click();

      expect(calls).toEqual(["close", "reload"]);
    });

    it("is safe to click when no onReload callback is provided", async () => {
      const rail = await mountRail((instance) => { instance.showReload = true; });

      expect(() => { reloadButton(rail).click(); }).not.toThrow();
    });

    it("cannot be dragged or dropped into rail order", async () => {
      const onRailOrderChange = vi.fn();
      const rail = await mountRail((instance) => {
        instance.showReload = true;
        instance.onRailOrderChange = onRailOrderChange;
      });
      const reload = reloadButton(rail);

      reload.dispatchEvent(new Event("dragstart", { bubbles: true }));
      const infoButton = railRoot(rail).querySelector(".info-button");
      if (infoButton === null) throw new Error("Expected the info rail button");
      infoButton.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));

      expect(onRailOrderChange).not.toHaveBeenCalled();
      expect(rail.railOrder).toEqual(["terminal", "git-update-manager", "theme", "system-prompt", "history", "info"]);
    });
  });
});
