// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { markdownHtmlCacheSize } from "../formatting/markdown";
import { FormattedText, LIVE_PLAIN_TEXT_MIN_CHARS, shouldRenderLivePlainText } from "./FormattedText";

vi.mock("katex/dist/katex.min.css?inline", () => ({ default: "@font-face { font-family: KaTeX_Main; }" }));

afterEach(() => {
  document.body.replaceChildren();
});

async function mountFormattedText(text: string, live: boolean): Promise<FormattedText> {
  const element = new FormattedText();
  element.text = text;
  element.live = live;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

describe("FormattedText live rendering", () => {
  it("does not grow the markdown cache while live is true, then caches once live is false", async () => {
    const before = markdownHtmlCacheSize();

    const liveText = `live-tail-${String(Date.now())}-${String(Math.random())}`;
    await mountFormattedText(liveText, true);

    expect(markdownHtmlCacheSize()).toBe(before);

    const idleText = `idle-message-${String(Date.now())}-${String(Math.random())}`;
    await mountFormattedText(idleText, false);

    expect(markdownHtmlCacheSize()).toBe(before + 1);
  });
});

function markdownTailOfLength(chars: number): string {
  const block = "## Heading\n\nParagraph text for the streamed answer.\n\n- bullet item\n\n";
  return block.repeat(Math.ceil(chars / block.length)).slice(0, chars);
}

function formattedContainer(element: FormattedText): HTMLElement {
  const container = element.shadowRoot?.querySelector<HTMLElement>(".formatted");
  if (container === null || container === undefined) throw new Error("Expected a .formatted container");
  return container;
}

function cssDeclarationBlock(cssText: string, selector: string): string | undefined {
  for (const match of cssText.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selectors = match[1]?.split(",").map((part) => part.trim()) ?? [];
    if (selectors.includes(selector)) return match[2];
  }
  return undefined;
}

describe("shouldRenderLivePlainText", () => {
  it("detects potential math only while a live tail is streaming", () => {
    expect(shouldRenderLivePlainText({ text: "answer: $x^2$", live: true })).toBe(true);
    expect(shouldRenderLivePlainText({ text: "answer: $x^2$", live: false })).toBe(false);
  });

  it("keeps markdown for a live tail just below the threshold", () => {
    expect(shouldRenderLivePlainText({ text: "a".repeat(LIVE_PLAIN_TEXT_MIN_CHARS - 1), live: true })).toBe(false);
  });

  it("switches to plain text once a live tail reaches the threshold", () => {
    expect(shouldRenderLivePlainText({ text: "a".repeat(LIVE_PLAIN_TEXT_MIN_CHARS), live: true })).toBe(true);
  });

  it("never switches to plain text for settled text, however large", () => {
    expect(shouldRenderLivePlainText({ text: "a".repeat(LIVE_PLAIN_TEXT_MIN_CHARS * 4), live: false })).toBe(false);
  });
});

describe("FormattedText live LaTeX rendering", () => {
  it("keeps a potential math opener as exact plain source until the tail settles", async () => {
    const element = await mountFormattedText("first $x", true);
    const assertLivePlain = (source: string) => {
      const container = formattedContainer(element);
      expect(container.classList.contains("plain")).toBe(true);
      expect(container.textContent).toBe(source);
      expect(container.querySelector(".katex")).toBeNull();
      expect(container.querySelector("math")).toBeNull();
    };

    assertLivePlain("first $x");

    element.text = "first $x^2$";
    await element.updateComplete;
    assertLivePlain("first $x^2$");

    element.live = false;
    await element.updateComplete;

    const settled = formattedContainer(element);
    expect(settled.classList.contains("plain")).toBe(false);
    expect(settled.querySelector(".katex")).not.toBeNull();
    expect(settled.querySelector("math")).not.toBeNull();
    expect(settled.textContent).not.toBe("first $x^2$");
  });

  it("contains settled display math horizontally without vertical clipping", async () => {
    const element = await mountFormattedText("\\[\\n\\int_0^1 x^2\\,dx\\n\\]", false);
    const firstDisplay = formattedContainer(element).querySelector<HTMLElement>(".math-display");
    expect(firstDisplay).not.toBeNull();

    element.text = `$$${"x".repeat(500)}$$`;
    await element.updateComplete;

    const display = formattedContainer(element).querySelector<HTMLElement>(".math-display");
    if (display === null) throw new Error("Expected a display-math wrapper");
    Object.defineProperties(display, {
      clientWidth: { configurable: true, value: 240 },
      scrollWidth: { configurable: true, value: 1_200 },
    });
    expect(display.scrollWidth).toBeGreaterThan(display.clientWidth);

    const styles = FormattedText.styles.toString();
    const displayRule = cssDeclarationBlock(styles, ".math-display");
    expect(displayRule).toBeDefined();
    if (displayRule === undefined) return;
    expect(displayRule).toMatch(/max-width:\s*100%/u);
    expect(displayRule).toMatch(/overflow-x:\s*auto/u);
    expect(displayRule).not.toMatch(/(?:overflow-y|height|max-height)\s*:/u);
  });

  it("composes KaTeX CSS with the owned math wrapper rules", () => {
    const styles = FormattedText.styles.toString();

    expect(styles).toContain("KaTeX_Main");
    expect(styles).toContain(".math-inline");
    expect(styles).toContain(".math-display");
    expect(styles).toContain("overflow-x");

    const displayRule = cssDeclarationBlock(styles, ".math-display");
    if (displayRule === undefined) throw new Error("Expected a .math-display stylesheet rule");
    expect(displayRule).not.toMatch(/(?:overflow-y|height|max-height)\s*:/u);
  });
});

describe("FormattedText large live tail", () => {
  it("renders a large live tail as plain text instead of parsed markdown", async () => {
    const element = await mountFormattedText(markdownTailOfLength(LIVE_PLAIN_TEXT_MIN_CHARS), true);

    const container = formattedContainer(element);
    expect(container.querySelectorAll("*").length).toBe(0);
    expect(container.textContent).toContain("## Heading");
  });

  it("preserves line structure while rendering a large live tail as plain text", async () => {
    const element = await mountFormattedText(markdownTailOfLength(LIVE_PLAIN_TEXT_MIN_CHARS), true);

    expect(formattedContainer(element).classList.contains("plain")).toBe(true);
    expect(FormattedText.styles.toString()).toContain("pre-wrap");
  });

  it("still renders markdown for a live tail below the threshold", async () => {
    const element = await mountFormattedText(markdownTailOfLength(LIVE_PLAIN_TEXT_MIN_CHARS - 1), true);

    expect(formattedContainer(element).querySelectorAll("h2").length).toBeGreaterThan(0);
  });

  it("upgrades a large tail to parsed markdown once streaming ends", async () => {
    const element = await mountFormattedText(markdownTailOfLength(LIVE_PLAIN_TEXT_MIN_CHARS), true);
    expect(formattedContainer(element).querySelectorAll("*").length).toBe(0);

    element.live = false;
    await element.updateComplete;

    const container = formattedContainer(element);
    expect(container.classList.contains("plain")).toBe(false);
    expect(container.querySelectorAll("h2").length).toBeGreaterThan(0);
  });

  it("does not reparse markdown as a large live tail grows", async () => {
    const element = await mountFormattedText(markdownTailOfLength(LIVE_PLAIN_TEXT_MIN_CHARS), true);
    const before = markdownHtmlCacheSize();

    for (let append = 0; append < 5; append += 1) {
      element.text = `${element.text} token${String(append)}`;
      await element.updateComplete;
      expect(formattedContainer(element).querySelectorAll("*").length).toBe(0);
    }

    expect(markdownHtmlCacheSize()).toBe(before);
  });

  it("does not build code-block wrappers while a large live tail streams, then builds them on completion", async () => {
    const tail = `${markdownTailOfLength(LIVE_PLAIN_TEXT_MIN_CHARS)}\n\n\`\`\`ts\nconst pending = 1;\n\`\`\`\n`;
    const element = await mountFormattedText(tail, true);

    expect(formattedContainer(element).querySelector(".code-block-wrapper")).toBeNull();

    element.live = false;
    await element.updateComplete;

    expect(formattedContainer(element).querySelector(".code-block-wrapper .code-copy-button")).not.toBeNull();
  });
});
