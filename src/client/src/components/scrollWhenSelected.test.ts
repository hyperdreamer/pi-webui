// @vitest-environment jsdom

import { LitElement, html } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrollWhenSelected } from "./scrollWhenSelected";

class ScrollFixture extends LitElement {
  override render() {
    return html`<button ${scrollWhenSelected(true, "item")}>Item</button>`;
  }
}

customElements.define("scroll-fixture", ScrollFixture);

describe("scrollWhenSelected", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("does not throw when scrollIntoView is unavailable", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      callback();
      return 0;
    });

    const fixture = new ScrollFixture();
    document.body.append(fixture);

    await expect(fixture.updateComplete).resolves.toBe(true);
  });
});
