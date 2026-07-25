import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
// Template inspection is proportionate here because these tests cover the
// Browser panel's Lit event bindings in the node test environment.
import { isTemplateEventHandler, templateEventHandlerAfterMarker, templateEventHandlerNearMarker, templateText, templateValueAfterMarker } from "../templateInspection.testSupport";
import { BrowserPanel } from "./BrowserPanel";

interface BrowserTabsState {
  tabs: { id: string; url: string; reloadRevision: number }[];
  activeTabId: string | undefined;
}

type RenderEmbeddedPage = (this: BrowserPanel) => TemplateResult;

interface PointerEventInput {
  pointerId: number;
  clientX: number;
  clientY: number;
}

class FakeBrowserPanelElement extends EventTarget {
  readonly setPointerCapture = vi.fn();
  readonly releasePointerCapture = vi.fn();

  constructor(private readonly frame: FakeBrowserPanelElement | null = null) {
    super();
  }

  closest(): FakeBrowserPanelElement | null {
    return this.frame;
  }

  getBoundingClientRect() {
    return { left: 100, top: 120, width: 400, height: 300 };
  }
}

class FakeBrowserPanelPointerEvent extends Event {
  readonly button = 0;

  constructor(input: PointerEventInput) {
    super("pointer-event", { cancelable: true });
    this.pointerId = input.pointerId;
    this.clientX = input.clientX;
    this.clientY = input.clientY;
  }

  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BrowserPanel", () => {
  it("renders tabs, an address bar, reload, zoom, and a sandboxed embedded page", () => {
    const panel = createPanel();
    const rendered = templateText(panel.render());

    expect(rendered).toContain("New tab");
    expect(rendered).toContain("Address");
    expect(rendered).toContain("Reload page");
    expect(rendered).toContain("Increase page zoom");
    expect(templateText(renderEmbeddedPage(panel))).toContain('sandbox="allow-forms allow-scripts"');
    expect(templateText(renderEmbeddedPage(panel))).toContain('referrerpolicy="no-referrer"');
  });

  it("navigates the active tab when the address form is submitted", () => {
    const panel = createPanel();
    Reflect.set(panel, "address", "example.com/docs");

    const submit = eventHandler(templateValueAfterMarker(panel.render(), "@submit="));
    submit(new Event("submit", { cancelable: true }));

    expect(browserTabs(panel)).toMatchObject({
      activeTabId: "browser-tab-1",
      tabs: [{ id: "browser-tab-1", url: "https://example.com/docs", reloadRevision: 0 }],
    });
  });

  it("opens a blank tab, reloads the active page, and adjusts zoom", () => {
    const panel = createPanel();
    const addTab = templateEventHandlerAfterMarker(panel.render(), "add-tab");
    addTab(new Event("click"));

    expect(browserTabs(panel)).toMatchObject({
      activeTabId: "browser-tab-2",
      tabs: [
        { id: "browser-tab-1", url: "about:blank", reloadRevision: 0 },
        { id: "browser-tab-2", url: "about:blank", reloadRevision: 0 },
      ],
    });

    const reload = eventHandler(templateValueAfterMarker(panel.render(), 'class="reload-button"'));
    reload(new Event("click"));
    const increaseZoom = templateEventHandlerNearMarker(panel.render(), 'aria-label="Increase page zoom"');
    increaseZoom(new Event("click"));

    expect(browserTabs(panel).tabs[1]).toMatchObject({ reloadRevision: 1 });
    expect(Reflect.get(panel, "zoom")).toBe(110);
  });

  it("moves and resizes the panel through the terminal-style drag controls", () => {
    vi.stubGlobal("HTMLElement", FakeBrowserPanelElement);
    const panel = createPanel();
    const frame = new FakeBrowserPanelElement();
    const dragHandle = new FakeBrowserPanelElement(frame);
    const resizeHandle = new FakeBrowserPanelElement(frame);
    const modal = panel.render();

    const pointerMove = eventHandler(templateValueAfterMarker(modal, "@pointermove="));
    const pointerUp = eventHandler(templateValueAfterMarker(modal, "@pointerup="));
    const dragPointerDown = templateEventHandlerNearMarker(modal, 'class="browser-drag-handle"');
    const resizePointerDown = templateEventHandlerNearMarker(modal, 'class="browser-resize-handle"');

    dispatchPointerEvent(dragHandle, dragPointerDown, { pointerId: 1, clientX: 150, clientY: 130 });
    dispatchPointerEvent(dragHandle, pointerMove, { pointerId: 1, clientX: 1_000, clientY: -100 });
    expect(Reflect.get(panel, "bounds")).toEqual({ left: 584, top: 16, width: 400, height: 300 });

    dispatchPointerEvent(dragHandle, pointerUp, { pointerId: 1, clientX: 1_000, clientY: -100 });
    dispatchPointerEvent(resizeHandle, resizePointerDown, { pointerId: 2, clientX: 100, clientY: 120 });
    dispatchPointerEvent(resizeHandle, pointerMove, { pointerId: 2, clientX: 1_100, clientY: -880 });
    expect(Reflect.get(panel, "bounds")).toEqual({ left: 100, top: 120, width: 884, height: 240 });
  });
});

function renderEmbeddedPage(panel: BrowserPanel): TemplateResult {
  const renderPage: unknown = Reflect.get(panel, "renderEmbeddedPage");
  if (!isRenderEmbeddedPage(renderPage)) throw new Error("BrowserPanel embedded page renderer was unavailable");
  return renderPage.call(panel);
}

function createPanel(): BrowserPanel {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
  };
  vi.stubGlobal("window", {
    innerWidth: 1_000,
    innerHeight: 800,
    localStorage: storage,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  return new BrowserPanel();
}

function browserTabs(panel: BrowserPanel): BrowserTabsState {
  const tabs: unknown = Reflect.get(panel, "browserTabs");
  if (!isBrowserTabsState(tabs)) throw new Error("BrowserPanel browser tabs were unavailable");
  return tabs;
}

function isRenderEmbeddedPage(value: unknown): value is RenderEmbeddedPage {
  return typeof value === "function";
}

function isBrowserTabsState(value: unknown): value is BrowserTabsState {
  return typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "tabs"));
}

function eventHandler(value: unknown): (event: Event) => void {
  if (!isTemplateEventHandler(value)) throw new Error("Expected a template event handler");
  return value;
}

function dispatchPointerEvent(target: EventTarget, handler: (event: Event) => void, input: PointerEventInput): void {
  target.addEventListener("pointer-event", handler);
  target.dispatchEvent(new FakeBrowserPanelPointerEvent(input));
  target.removeEventListener("pointer-event", handler);
}
