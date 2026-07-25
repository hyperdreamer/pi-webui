import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
// Template inspection is proportionate here because this narrowly covers the
// panel's Lit pointer-event bindings in the node test environment.
import { isTemplateEventHandler, templateEventHandlerNearMarker, templateValueAfterMarker } from "../templateInspection.testSupport";

interface GitUpdateManagerPanelModule {
  GitUpdateManagerPanel: new () => { render: () => TemplateResult };
}

async function loadGitUpdateManagerPanel(): Promise<GitUpdateManagerPanelModule | undefined> {
  try {
    return await import("./GitUpdateManagerPanel.js");
  } catch {
    return undefined;
  }
}

interface PointerEventInput {
  pointerId: number;
  clientX: number;
  clientY: number;
}

class FakeGitUpdateManagerElement extends EventTarget {
  readonly setPointerCapture = vi.fn();
  readonly releasePointerCapture = vi.fn();

  constructor(private readonly frame: FakeGitUpdateManagerElement | null = null) {
    super();
  }

  closest(): FakeGitUpdateManagerElement | null {
    return this.frame;
  }

  getBoundingClientRect() {
    return { left: 100, top: 120, width: 400, height: 300 };
  }
}

class FakeGitUpdateManagerPointerEvent extends Event {
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

describe("GitUpdateManagerPanel resizing", () => {
  it("moves and resizes through the review-panel drag controls", async () => {
    const module = await loadGitUpdateManagerPanel();
    expect(module).toBeDefined();
    if (module === undefined) return;

    vi.stubGlobal("window", { innerWidth: 1_000, innerHeight: 800 });
    vi.stubGlobal("HTMLElement", FakeGitUpdateManagerElement);
    const panel = new module.GitUpdateManagerPanel();
    const frame = new FakeGitUpdateManagerElement();
    const dragHandle = new FakeGitUpdateManagerElement(frame);
    const resizeHandle = new FakeGitUpdateManagerElement(frame);
    const modal = panel.render();

    const pointerMove = eventHandler(templateValueAfterMarker(modal, "@pointermove="));
    const pointerUp = eventHandler(templateValueAfterMarker(modal, "@pointerup="));
    const dragPointerDown = templateEventHandlerNearMarker(modal, 'class="git-update-manager-drag-handle"');
    const resizePointerDown = templateEventHandlerNearMarker(modal, 'class="git-update-manager-resize-handle"');

    dispatchPointerEvent(dragHandle, dragPointerDown, { pointerId: 1, clientX: 150, clientY: 130 });
    dispatchPointerEvent(dragHandle, pointerMove, { pointerId: 1, clientX: 1_000, clientY: -100 });
    expect(Reflect.get(panel, "bounds")).toEqual({ left: 584, top: 16, width: 400, height: 300 });

    dispatchPointerEvent(dragHandle, pointerUp, { pointerId: 1, clientX: 1_000, clientY: -100 });
    dispatchPointerEvent(resizeHandle, resizePointerDown, { pointerId: 2, clientX: 100, clientY: 120 });
    dispatchPointerEvent(resizeHandle, pointerMove, { pointerId: 2, clientX: 1_100, clientY: -880 });
    expect(Reflect.get(panel, "bounds")).toEqual({ left: 100, top: 120, width: 884, height: 240 });
  });
});

function eventHandler(value: unknown): (event: Event) => void {
  if (!isTemplateEventHandler(value)) throw new Error("Expected a template event handler");
  return value;
}

function dispatchPointerEvent(target: EventTarget, handler: (event: Event) => void, input: PointerEventInput): void {
  target.addEventListener("pointer-event", handler);
  target.dispatchEvent(new FakeGitUpdateManagerPointerEvent(input));
  target.removeEventListener("pointer-event", handler);
}
