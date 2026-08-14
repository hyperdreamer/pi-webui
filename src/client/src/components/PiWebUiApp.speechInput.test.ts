// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiWebUiApp } from "./PiWebUiApp";

interface KeyEventDouble {
  key: string;
  preventDefault: () => void;
  stopPropagation: () => void;
  calls: { preventDefault: number; stopPropagation: number };
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", mediaQuery);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PiWebUiApp speech input Escape delegation", () => {
  it("cancels active dictation before modal and shortcut guards consume Escape", () => {
    const app = new PiWebUiApp();
    const cancelSpeechInput = vi.fn(() => true);
    const keyboard = replaceKeyboardHandler(app);
    setPromptEditor(app, { cancelSpeechInput });
    Reflect.set(app, "settingsSection", "general");
    const event = keyEvent("Escape");

    invokeGlobalKeyDown(app, event);

    expect(cancelSpeechInput).toHaveBeenCalledOnce();
    expect(event.calls.preventDefault).toBe(1);
    expect(event.calls.stopPropagation).toBe(1);
    expect(keyboard).not.toHaveBeenCalled();
  });

  it("preserves idle Escape modal and shortcut behavior when dictation declines it", () => {
    const app = new PiWebUiApp();
    const cancelSpeechInput = vi.fn(() => false);
    const keyboard = replaceKeyboardHandler(app);
    setPromptEditor(app, { cancelSpeechInput });
    Reflect.set(app, "settingsSection", "general");
    const modalEvent = keyEvent("Escape");

    invokeGlobalKeyDown(app, modalEvent);

    expect(cancelSpeechInput).toHaveBeenCalledOnce();
    expect(modalEvent.calls.preventDefault).toBe(0);
    expect(modalEvent.calls.stopPropagation).toBe(0);
    expect(keyboard).not.toHaveBeenCalled();

    Reflect.set(app, "settingsSection", undefined);
    keyboard.mockReturnValue(true);
    const shortcutEvent = keyEvent("Escape");
    invokeGlobalKeyDown(app, shortcutEvent);

    expect(cancelSpeechInput).toHaveBeenCalledTimes(2);
    expect(keyboard).toHaveBeenCalledOnce();
    expect(shortcutEvent.calls.preventDefault).toBe(1);
    expect(shortcutEvent.calls.stopPropagation).toBe(1);
  });

  it("does not delegate non-Escape keys to the prompt editor", () => {
    const app = new PiWebUiApp();
    const cancelSpeechInput = vi.fn(() => true);
    const keyboard = replaceKeyboardHandler(app);
    setPromptEditor(app, { cancelSpeechInput });
    const event = keyEvent("Enter");

    invokeGlobalKeyDown(app, event);

    expect(cancelSpeechInput).not.toHaveBeenCalled();
    expect(keyboard).toHaveBeenCalledOnce();
  });
});

function setPromptEditor(app: PiWebUiApp, promptEditor: { cancelSpeechInput: () => boolean }): void {
  Object.defineProperty(app, "promptEditor", { configurable: true, value: promptEditor });
}

function mediaQuery(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
}

function replaceKeyboardHandler(app: PiWebUiApp) {
  const keyboard: unknown = Reflect.get(app, "keyboard");
  if (typeof keyboard !== "object" || keyboard === null || typeof Reflect.get(keyboard, "handle") !== "function") {
    throw new Error("PiWebUiApp keyboard dispatcher was unavailable");
  }
  const handle = vi.fn(() => false);
  if (!Reflect.set(keyboard, "handle", handle)) throw new Error("Could not replace PiWebUiApp keyboard dispatcher");
  return handle;
}

function invokeGlobalKeyDown(app: PiWebUiApp, event: KeyEventDouble): void {
  const handler: unknown = Reflect.get(app, "onKeyDown");
  if (typeof handler !== "function") throw new Error("PiWebUiApp global keydown handler was unavailable");
  Reflect.apply(handler, app, [event]);
}

function keyEvent(key: string): KeyEventDouble {
  const calls = { preventDefault: 0, stopPropagation: 0 };
  return {
    key,
    calls,
    preventDefault: () => { calls.preventDefault += 1; },
    stopPropagation: () => { calls.stopPropagation += 1; },
  };
}
