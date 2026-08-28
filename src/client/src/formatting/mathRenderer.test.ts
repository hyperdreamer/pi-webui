// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { toSafeMarkdownHtml } from "./markdown";
import {
  MathJaxNotReadyError,
  isMathJaxReady,
  renderLatexWithMathJax,
  startMathJax,
  whenMathJaxReady,
} from "./mathRenderer";

describe("mathRenderer", () => {
  it("throws MathJaxNotReadyError before the engine has started", () => {
    expect(isMathJaxReady()).toBe(false);
    expect(() => renderLatexWithMathJax("\\notin", { displayMode: false })).toThrow(MathJaxNotReadyError);
  });

  it("starts once, injects the stylesheet, and renders real glyphs", async () => {
    const firstStart = startMathJax();
    expect(startMathJax()).toBe(firstStart);
    await firstStart;

    const mathStyle = [...document.head.querySelectorAll("style")]
      .find((style) => style.textContent.includes("MJX-CHTML-styles"));
    expect(mathStyle).toBeDefined();
    expect(mathStyle?.textContent).toContain("@font-face");
    expect(mathStyle?.textContent).toContain("mathjax/fonts");

    const html = renderLatexWithMathJax("\\notin", { displayMode: false });
    expect(html).toContain("mjx-c2209");
    expect(html).not.toContain("katex");
    expect(isMathJaxReady()).toBe(true);
    await whenMathJaxReady();
  });

  it("renders display mode and the production pipeline end to end", async () => {
    await startMathJax();
    const displayHtml = renderLatexWithMathJax("\\frac{1}{2}", { displayMode: true });
    expect(displayHtml).toContain('display="true"');

    const inline = toSafeMarkdownHtml("$\\notin$", {
      cache: false,
      renderMath: (tex, options) => renderLatexWithMathJax(tex, { displayMode: options.displayMode ?? false }),
    });
    expect(inline).toContain('class="math-inline"');
    expect(inline).toContain("mjx-c2209");

    const display = toSafeMarkdownHtml("$$\\frac{1}{2}$$", {
      cache: false,
      renderMath: (tex, options) => renderLatexWithMathJax(tex, { displayMode: options.displayMode ?? false }),
    });
    expect(display).toContain('class="math-display"');
  });
});
