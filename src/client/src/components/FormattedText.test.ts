// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markdownHtmlCacheSize, setDefaultRenderMathForTesting, toSafeMarkdownHtml } from "../formatting/markdown";
import { FormattedText, LIVE_PLAIN_TEXT_MIN_CHARS, shouldRenderLivePlainText } from "./FormattedText";

const fakeMathRenderer = (tex: string, options: { displayMode: boolean }): string =>
  `<span class="mjx-container" data-display="${options.displayMode ? "true" : "false"}" data-tex="${tex}"></span>`;

beforeEach(() => {
  setDefaultRenderMathForTesting(fakeMathRenderer);
});

afterEach(() => {
  setDefaultRenderMathForTesting(undefined);
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
      expect(container.querySelector(".mjx-container")).toBeNull();
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
    expect(settled.querySelector(".mjx-container")).not.toBeNull();
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

  it("composes MathJax output with the owned math wrapper rules", () => {
    const styles = FormattedText.styles.toString();

    expect(styles).toContain("mjx-container");
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

const fileMarkdown = "[local](a.html) ![local](plot.svg) [external](https://outside.example/a.html)";

function fileNodes(element: FormattedText): { a: HTMLAnchorElement; img: HTMLImageElement } {
  const root = formattedContainer(element);
  const a = root.querySelector<HTMLAnchorElement>('a[href]:not([href^="https://outside.example"])');
  const img = root.querySelector<HTMLImageElement>("img");
  if (a === null || img === null) throw new Error("Missing file nodes");
  return { a, img };
}

function resolver(prefix: string) {
  return vi.fn((raw: string) => (["a.html", "plot.svg", "other.html"].includes(raw) ? `${prefix}${raw}` : undefined));
}

describe("FormattedText file link enhancement", () => {
  it("rewrites file anchor and image attributes and marks only matches", async () => {
    const element = await mountFormattedText(fileMarkdown, false);
    element.resolveFileLink = resolver("https://gateway.example/A/");
    await element.updateComplete;

    const { a, img } = fileNodes(element);
    expect(a.getAttribute("href")).toBe("https://gateway.example/A/a.html");
    expect(img.getAttribute("src")).toBe("https://gateway.example/A/plot.svg");
    expect(a.dataset["filePreview"]).toBe("true");
    expect(img.dataset["filePreview"]).toBe("true");
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noreferrer noopener");
    const external = formattedContainer(element).querySelector('a[href="https://outside.example/a.html"]');
    expect(external?.hasAttribute("data-file-preview")).toBe(false);
  });

  it("keeps the same elements while resolving A then B from the original targets", async () => {
    const element = await mountFormattedText(fileMarkdown, false);
    const nodes = fileNodes(element);
    const first = resolver("https://gateway.example/A/");
    const second = resolver("https://gateway.example/B/");

    element.resolveFileLink = first;
    await element.updateComplete;
    element.resolveFileLink = second;
    await element.updateComplete;

    expect(fileNodes(element)).toEqual(nodes);
    expect(fileNodes(element).a).toBe(nodes.a);
    expect(fileNodes(element).img).toBe(nodes.img);
    expect(first).toHaveBeenCalledWith("a.html");
    expect(second).toHaveBeenCalledWith("a.html");
    expect(second).toHaveBeenCalledWith("plot.svg");
    expect(second.mock.calls.flat()).not.toContain("https://gateway.example/A/a.html");
    expect(nodes.a.getAttribute("href")).toBe("https://gateway.example/B/a.html");
  });

  it("restores original attributes when a replacement resolver declines", async () => {
    const element = await mountFormattedText(fileMarkdown, false);
    const nodes = fileNodes(element);

    for (const next of [resolver("https://gateway.example/A/"), resolver("https://gateway.example/B/"), () => undefined]) {
      element.resolveFileLink = next;
      await element.updateComplete;
    }

    expect(fileNodes(element).a).toBe(nodes.a);
    expect(nodes.a.getAttribute("href")).toBe("a.html");
    expect(nodes.img.getAttribute("src")).toBe("plot.svg");
    expect(nodes.a.hasAttribute("data-file-preview")).toBe(false);
    expect(nodes.img.hasAttribute("data-file-preview")).toBe(false);
  });

  it("restores original attributes when the resolver disappears", async () => {
    const element = await mountFormattedText(fileMarkdown, false);
    const nodes = fileNodes(element);
    element.resolveFileLink = resolver("https://gateway.example/B/");
    await element.updateComplete;

    Reflect.set(element, "resolveFileLink", undefined);
    await element.updateComplete;

    expect(nodes.a.getAttribute("href")).toBe("a.html");
    expect(nodes.img.getAttribute("src")).toBe("plot.svg");
    expect(nodes.a.hasAttribute("data-file-preview")).toBe(false);

    element.resolveFileLink = resolver("https://gateway.example/A/");
    await element.updateComplete;
    expect(nodes.a.getAttribute("href")).toBe("https://gateway.example/A/a.html");
  });

  it("restores a throwing element and continues enhancing its siblings", async () => {
    const element = await mountFormattedText(fileMarkdown, false);
    element.resolveFileLink = resolver("https://gateway.example/A/");
    await element.updateComplete;
    element.resolveFileLink = (raw) => {
      if (raw === "a.html") throw new Error("resolver failure");
      return raw === "plot.svg" ? "https://gateway.example/B/plot.svg" : undefined;
    };
    await element.updateComplete;

    const { a, img } = fileNodes(element);
    expect(a.getAttribute("href")).toBe("a.html");
    expect(a.hasAttribute("data-file-preview")).toBe(false);
    expect(img.getAttribute("src")).toBe("https://gateway.example/B/plot.svg");
  });

  it("isolates two workspace resolvers sharing cached Markdown", async () => {
    const a = await mountFormattedText(fileMarkdown, false);
    const b = await mountFormattedText(fileMarkdown, false);

    a.resolveFileLink = resolver("https://gateway.example/A/");
    b.resolveFileLink = resolver("https://gateway.example/B/");
    await Promise.all([a.updateComplete, b.updateComplete]);

    expect(fileNodes(a).a.getAttribute("href")).toBe("https://gateway.example/A/a.html");
    expect(fileNodes(b).a.getAttribute("href")).toBe("https://gateway.example/B/a.html");
    const cached = toSafeMarkdownHtml(fileMarkdown);
    expect(cached).toContain('href="a.html"');
    expect(cached).toContain('src="plot.svg"');
    expect(cached).not.toContain("/file/view");
    expect(cached).not.toContain("gateway.example");
  });

  it("records new originals after Markdown replaces nodes", async () => {
    const element = await mountFormattedText(fileMarkdown, false);
    element.resolveFileLink = resolver("https://gateway.example/A/");
    await element.updateComplete;
    const old = fileNodes(element).a;

    element.text = "[other](other.html) ![local](plot.svg)";
    await element.updateComplete;

    const current = fileNodes(element).a;
    expect(current).not.toBe(old);
    Reflect.set(element, "resolveFileLink", undefined);
    await element.updateComplete;
    expect(current.getAttribute("href")).toBe("other.html");
  });

  it("enhances links when a live plain-text tail settles without changing plain-text rendering", async () => {
    const text = "[local](a.html) $x";
    const element = await mountFormattedText(text, true);
    element.resolveFileLink = resolver("https://gateway.example/A/");
    await element.updateComplete;

    expect(formattedContainer(element).textContent).toBe(text);
    expect(formattedContainer(element).querySelector("a")).toBeNull();

    element.live = false;
    await element.updateComplete;

    expect(formattedContainer(element).querySelector("a")?.getAttribute("href")).toBe("https://gateway.example/A/a.html");
  });
});
