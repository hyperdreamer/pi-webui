import type { ReactiveControllerHost } from "lit";
import { describe, expect, it, vi } from "vitest";
import { ACTIVITY_RAIL_DESKTOP_MEDIA_QUERY, AppShellController } from "./appShellController";

class FakeMediaQueryListEvent extends Event {
  readonly media = ACTIVITY_RAIL_DESKTOP_MEDIA_QUERY;

  constructor(readonly matches: boolean) {
    super("change");
  }
}

class FakeMediaQueryList extends EventTarget implements MediaQueryList {
  readonly media = ACTIVITY_RAIL_DESKTOP_MEDIA_QUERY;
  onchange: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null = null;
  private readonly changeListeners = new Set<EventListenerOrEventListenerObject>();

  constructor(public matches: boolean) {
    super();
  }

  addListener(listener: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null): void {
    if (listener !== null) this.addEventListener("change", listener);
  }

  removeListener(listener: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null): void {
    if (listener !== null) this.removeEventListener("change", listener);
  }

  override addEventListener<K extends keyof MediaQueryListEventMap>(
    type: K,
    listener: (this: MediaQueryList, event: MediaQueryListEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void {
    super.addEventListener(type, listener, options);
    if (type === "change") this.changeListeners.add(listener);
  }

  override removeEventListener<K extends keyof MediaQueryListEventMap>(
    type: K,
    listener: (this: MediaQueryList, event: MediaQueryListEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void {
    super.removeEventListener(type, listener, options);
    if (type === "change") this.changeListeners.delete(listener);
  }

  dispatchChange(matches: boolean): void {
    this.matches = matches;
    const event = new FakeMediaQueryListEvent(matches);
    this.dispatchEvent(event);
    this.onchange?.call(this, event);
  }

  listenerCount(): number {
    return this.changeListeners.size;
  }
}

class FakeHost implements ReactiveControllerHost {
  readonly addController = vi.fn<ReactiveControllerHost["addController"]>();
  readonly removeController = vi.fn<ReactiveControllerHost["removeController"]>();
  readonly requestUpdate = vi.fn();
  readonly updateComplete = Promise.resolve(true);
}

describe("AppShellController", () => {
  it("updates the desktop-rail layout signal and removes its media listener when disconnected", () => {
    const activityRailDesktopMedia = new FakeMediaQueryList(false);
    const host = new FakeHost();
    const controller = new AppShellController(host, {
      activityRailDesktopMedia,
      pwaDisplayModeMedia: [],
    });

    controller.hostConnected();
    expect(controller.isDesktopActivityRailLayout).toBe(false);

    activityRailDesktopMedia.dispatchChange(true);

    expect(controller.isDesktopActivityRailLayout).toBe(true);
    expect(host.requestUpdate).toHaveBeenCalledOnce();

    controller.hostDisconnected();

    expect(activityRailDesktopMedia.listenerCount()).toBe(0);

    host.requestUpdate.mockClear();
    activityRailDesktopMedia.dispatchChange(false);

    expect(controller.isDesktopActivityRailLayout).toBe(true);
    expect(host.requestUpdate).not.toHaveBeenCalled();
  });
});
