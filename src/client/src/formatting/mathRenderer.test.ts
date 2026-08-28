// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { toSafeMarkdownHtml } from "./markdown";
import {
  MathJaxNotReadyError,
  installMathJaxStyles,
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

  it("starts once, exposes wrapper-free stylesheet text, and renders real glyphs", async () => {
    const firstStart = startMathJax();
    expect(startMathJax()).toBe(firstStart);
    const engine = await firstStart;

    // The engine exposes raw CSS text, not the `<style id=...>` outerHTML:
    // a wrapper string makes the CSS parser drop the first stylesheet rule.
    const cssText = engine.mathJaxStyles();
    expect(cssText).not.toContain("<style");
    expect(cssText.trimStart().startsWith('mjx-container[jax="CHTML"]')).toBe(true);
    expect(cssText).toContain("@font-face");
    expect(cssText).toContain("mathjax/fonts");

    const mathStyle = document.head.querySelector("style[data-mathjax-chtml]");
    expect(mathStyle).toBeDefined();
    expect(mathStyle?.textContent).toBe(cssText);

    const html = renderLatexWithMathJax("\\notin", { displayMode: false });
    expect(html).toContain("mjx-c2209");
    expect(html).not.toContain("katex");
    expect(isMathJaxReady()).toBe(true);
    await whenMathJaxReady();
  });

  it("delivers the CHTML stylesheet into shadow roots that render math", async () => {
    await startMathJax();
    const host = document.createElement("div");
    const renderRoot = host.attachShadow({ mode: "open" });
    document.body.append(host);

    installMathJaxStyles(renderRoot);

    const styles = renderRoot.querySelectorAll("style[data-mathjax-chtml]");
    expect(styles).toHaveLength(1);
    const style = styles.item(0);
    const cssText = style.textContent;
    expect(cssText.trimStart().startsWith('mjx-container[jax="CHTML"]')).toBe(true);
    expect(cssText).toContain("@font-face");
    expect(cssText).toContain("mathjax/fonts");

    // Root-level idempotence: repeated installation must not duplicate the style.
    installMathJaxStyles(renderRoot);
    expect(renderRoot.querySelectorAll("style[data-mathjax-chtml]")).toHaveLength(1);
    host.remove();
  });

  it("renders display mode and the production pipeline end to end", async () => {
    await startMathJax();
    const displayHtml = renderLatexWithMathJax("\\frac{1}{2}", { displayMode: true });
    expect(displayHtml).toContain('display="true"');

    const inline = toSafeMarkdownHtml("$\\notin$", {
      cache: false,
      renderMath: (tex, options) => renderLatexWithMathJax(tex, { displayMode: options.displayMode }),
    });
    expect(inline).toContain('class="math-inline"');
    expect(inline).toContain("mjx-c2209");

    const display = toSafeMarkdownHtml("$$\\frac{1}{2}$$", {
      cache: false,
      renderMath: (tex, options) => renderLatexWithMathJax(tex, { displayMode: options.displayMode }),
    });
    expect(display).toContain('class="math-display"');
  });
});
