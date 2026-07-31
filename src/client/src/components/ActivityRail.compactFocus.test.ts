// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityRail } from "./ActivityRail";

function compactMediaQuery(): MediaQueryList {
  return {
    matches: false,
    media: "(min-width: 1181px)",
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
}

function compactCloseControl(rail: ActivityRail): HTMLButtonElement {
  const control = rail.shadowRoot?.querySelector<HTMLButtonElement>(".compact-rail-close");
  if (control === null || control === undefined) throw new Error("Expected the compact rail close control");
  return control;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("ActivityRail compact drawer focus", () => {
  it("focuses its close control so a bubbling Escape closes the drawer", async () => {
    vi.stubGlobal("matchMedia", () => compactMediaQuery());
    const onCloseCompact = vi.fn();
    const launcher = document.createElement("button");
    const rail = new ActivityRail();
    rail.onCloseCompact = onCloseCompact;
    document.body.append(launcher, rail);
    launcher.focus();
    await rail.updateComplete;

    expect(document.activeElement).toBe(launcher);

    rail.compactOpen = true;
    await rail.updateComplete;

    const closeControl = compactCloseControl(rail);
    expect(rail.shadowRoot?.activeElement).toBe(closeControl);

    const escape = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: "Escape",
    });
    closeControl.dispatchEvent(escape);

    expect(escape.defaultPrevented).toBe(true);
    expect(onCloseCompact).toHaveBeenCalledOnce();
  });
});
