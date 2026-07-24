import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
// Template inspection is proportionate here because this test covers only the
// terminal modal's Lit pointer-event wiring in the node test environment.
import { isTemplateEventHandler, templateEventHandlerNearMarker, templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebUiApp } from "./PiWebUiApp";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PiWebUiApp terminal modal", () => {
  it("moves the sidebar terminal window through its title-bar drag control", () => {
    const harness = createTerminalModalHarness();

    dispatchPointerEvent(harness.dragHandle, harness.movePointerDown, { pointerId: 1, clientX: 150, clientY: 130 });
    dispatchPointerEvent(harness.dragHandle, harness.pointerMove, { pointerId: 1, clientX: 1_000, clientY: -100 });

    expect(terminalModalBounds(harness.app)).toEqual({ left: 584, top: 16, width: 400, height: 300 });
    expect(harness.dragHandle.setPointerCapture).toHaveBeenCalledWith(1);

    dispatchPointerEvent(harness.dragHandle, harness.pointerUp, { pointerId: 1, clientX: 1_000, clientY: -100 });
    expect(harness.dragHandle.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it("resizes the sidebar terminal window through its lower-right drag control", () => {
    const harness = createTerminalModalHarness();

    dispatchPointerEvent(harness.resizeHandle, harness.resizePointerDown, { pointerId: 2, clientX: 100, clientY: 120 });
    dispatchPointerEvent(harness.resizeHandle, harness.pointerMove, { pointerId: 2, clientX: 1_100, clientY: -880 });

    expect(terminalModalBounds(harness.app)).toEqual({ left: 100, top: 120, width: 884, height: 240 });
  });
});

type PointerEventHandler = (event: Event) => void;
type RenderTerminalModal = (this: PiWebUiApp) => TemplateResult;

interface PointerEventInput {
  pointerId: number;
  clientX: number;
  clientY: number;
}

interface TerminalModalHarness {
  app: PiWebUiApp;
  dragHandle: FakeTerminalModalElement;
  resizeHandle: FakeTerminalModalElement;
  movePointerDown: PointerEventHandler;
  resizePointerDown: PointerEventHandler;
  pointerMove: PointerEventHandler;
  pointerUp: PointerEventHandler;
}

class FakeTerminalModalElement extends EventTarget {
  readonly setPointerCapture = vi.fn();
  readonly releasePointerCapture = vi.fn();

  constructor(private readonly frame: FakeTerminalModalElement | null = null) {
    super();
  }

  closest(): FakeTerminalModalElement | null {
    return this.frame;
  }

  getBoundingClientRect() {
    return { left: 100, top: 120, width: 400, height: 300 };
  }
}

class FakeTerminalModalPointerEvent extends Event {
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

function createTerminalModalHarness(): TerminalModalHarness {
  const app = createApp();
  const frame = new FakeTerminalModalElement();
  const dragHandle = new FakeTerminalModalElement(frame);
  const resizeHandle = new FakeTerminalModalElement(frame);
  vi.stubGlobal("HTMLElement", FakeTerminalModalElement);
  const modal = renderTerminalModal(app);
  return {
    app,
    dragHandle,
    resizeHandle,
    movePointerDown: templateEventHandlerNearMarker(modal, 'class="terminal-modal-drag-handle"'),
    resizePointerDown: templateEventHandlerNearMarker(modal, 'class="terminal-modal-resize-handle"'),
    pointerMove: templatePointerHandlerAfterMarker(modal, "@pointermove="),
    pointerUp: templatePointerHandlerAfterMarker(modal, "@pointerup="),
  };
}

function createApp(): PiWebUiApp {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage, innerWidth: 1_000, innerHeight: 800 });
  return new PiWebUiApp();
}

function renderTerminalModal(app: PiWebUiApp): TemplateResult {
  const method: unknown = Reflect.get(app, "renderTerminalModal");
  if (!isRenderTerminalModal(method)) throw new Error("PiWebUiApp.renderTerminalModal is not callable");
  return method.call(app);
}

function terminalModalBounds(app: PiWebUiApp): unknown {
  return Reflect.get(app, "terminalModalBounds");
}

function templatePointerHandlerAfterMarker(template: TemplateResult, marker: string): PointerEventHandler {
  const value = templateValueAfterMarker(template, marker);
  if (!isTemplateEventHandler(value)) throw new Error(`Expected pointer handler after ${marker}`);
  return value;
}

function dispatchPointerEvent(target: EventTarget, handler: PointerEventHandler, input: PointerEventInput): void {
  target.addEventListener("pointer-event", handler);
  target.dispatchEvent(new FakeTerminalModalPointerEvent(input));
  target.removeEventListener("pointer-event", handler);
}

function isRenderTerminalModal(value: unknown): value is RenderTerminalModal {
  return typeof value === "function";
}
