// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { FormattedText } from "./FormattedText";

describe("FormattedText cold-start math retry", () => {
  it("re-renders literal math once the MathJax engine becomes ready", async () => {
    const element = new FormattedText();
    element.text = "Area: $x^2$";
    document.body.append(element);
    await element.updateComplete;

    // Not ready yet: the settled message renders the literal fallback.
    expect(element.shadowRoot?.querySelector(".math-inline")).toBeNull();
    expect(element.shadowRoot?.textContent).toContain("$x^2$");

    // The real engine loads in jsdom; the hook re-renders with MathJax output.
    await vi.waitFor(() => {
      expect(element.shadowRoot?.querySelector("mjx-container")).not.toBeNull();
    }, { timeout: 10_000 });

    expect(element.shadowRoot?.querySelector(".math-inline")).not.toBeNull();
  });
});
