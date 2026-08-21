// @vitest-environment jsdom

import { marked } from "marked";
import { describe, expect, it, vi } from "vitest";
import { clearMarkdownHtmlCache, markdownHtmlCacheChars, markdownHtmlCacheSize, toSafeMarkdownHtml } from "./markdown";

describe("toSafeMarkdownHtml", () => {
  it("renders representative math with KaTeX HTML and MathML", () => {
    const html = toSafeMarkdownHtml("Area: $x^2$", { cache: false });

    expect(html).toContain('class="math-inline"');
    expect(html).toContain("katex");
    expect(html).toContain("MathML");
  });

  it("caches production math renders but bypasses the cache for an injected adapter", () => {
    clearMarkdownHtmlCache();
    const source = `$x$ ${String(Date.now())} ${Math.random().toString(36)}`;
    const before = markdownHtmlCacheSize();

    const first = toSafeMarkdownHtml(source);
    const second = toSafeMarkdownHtml(source);

    expect(second).toBe(first);
    expect(markdownHtmlCacheSize()).toBe(before + 1);

    const adapter = vi.fn(() => "<i>test-math</i>");
    const injectedFirst = toSafeMarkdownHtml("$y$", { renderMath: adapter });
    const injectedSecond = toSafeMarkdownHtml("$y$", { renderMath: adapter });

    expect(injectedSecond).toBe(injectedFirst);
    expect(adapter).toHaveBeenCalledTimes(2);
    expect(markdownHtmlCacheSize()).toBe(before + 1);
  });

  it("sanitizes unsafe output returned by an injected math adapter", () => {
    const adapter = vi.fn(() => "<img src=\"javascript:alert(1)\" onerror=\"alert(1)\">");

    const html = toSafeMarkdownHtml("before $x$ after", { renderMath: adapter });

    expect(html).toContain("before");
    expect(html).toContain("after");
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/onerror/i);
  });

  it("renders markdown to sanitized html", () => {
    const html = toSafeMarkdownHtml("**bold**", { cache: false });

    expect(html).toContain("<strong>bold</strong>");
  });

  it("removes javascript links during sanitization", () => {
    const html = toSafeMarkdownHtml("[unsafe](javascript:alert(1))", { cache: false });

    expect(html).not.toMatch(/href\s*=\s*["']javascript:/i);
  });

  it("does not grow the cache when rendering streaming prefixes", () => {
    const before = markdownHtmlCacheSize();

    for (let index = 1; index <= 200; index += 1) {
      toSafeMarkdownHtml(`streaming answer ${"x".repeat(index)}`, { cache: false });
    }

    expect(markdownHtmlCacheSize()).toBe(before);
  });

  it("still caches finalized text by default", () => {
    const unique = `finalized ${String(Date.now())} ${Math.random().toString(36).slice(2)}`;
    const before = markdownHtmlCacheSize();

    const first = toSafeMarkdownHtml(unique);
    const second = toSafeMarkdownHtml(unique);

    expect(second).toBe(first);
    expect(markdownHtmlCacheSize()).toBe(before + 1);
  });

  it("keeps a reused transcript cached while an unread one is evicted", () => {
    // The session-switch freeze: a plain FIFO cache evicted the transcript the
    // user keeps returning to, because insertion order ignored reuse, so every
    // switch back re-parsed it. Reading `reused` on every round must make the
    // never-reread filler the eviction victim instead.
    //
    // The measurement counts how often `reused` is re-parsed *across* the run.
    // Checking residency only at the end proves nothing, because the last touch
    // would have just re-stored it. String equality cannot prove a hit either:
    // two separately parsed identical strings compare equal by value.
    clearMarkdownHtmlCache();
    const reused = "# reused transcript message";
    const parse = vi.spyOn(marked, "parse");
    try {
      toSafeMarkdownHtml(reused);
      const parsesAfterFirst = parseCallsFor(parse, reused);

      // Push far more distinct filler through than the cache can hold, so
      // eviction definitely runs several times over.
      for (let index = 0; index < 4_000; index += 1) {
        toSafeMarkdownHtml(`# filler message ${String(index)}`);
        toSafeMarkdownHtml(reused);
      }

      // Under LRU the reused entry is refreshed by every read and is never
      // evicted, so it is parsed exactly once for the whole run.
      expect(parseCallsFor(parse, reused)).toBe(parsesAfterFirst);
      expect(markdownHtmlCacheSize()).toBeLessThanOrEqual(1_600);
    } finally {
      parse.mockRestore();
    }
  });

  it("bounds retained characters, not just entry count", () => {
    clearMarkdownHtmlCache();
    const body = "x".repeat(80_000);
    const parse = vi.spyOn(marked, "parse").mockReturnValue("<p>cached</p>");
    try {
      for (let index = 0; index < 100; index += 1) {
        toSafeMarkdownHtml(`${body} ${String(index)}`);
      }

      // 100 entries is far below the 1,600-entry cap, so only the character
      // budget can be holding this down.
      expect(parse).toHaveBeenCalledTimes(100);
      expect(markdownHtmlCacheSize()).toBeLessThan(100);
      expect(markdownHtmlCacheChars()).toBeLessThanOrEqual(6_000_000);
    } finally {
      parse.mockRestore();
    }
  });

  it("does not let one oversized message evict the working set", () => {
    clearMarkdownHtmlCache();
    const working = Array.from({ length: 20 }, (_, index) => `# working ${String(index)}`);
    for (const text of working) toSafeMarkdownHtml(text);
    const sizeBefore = markdownHtmlCacheSize();

    toSafeMarkdownHtml("y".repeat(2_000_000));

    // The outlier is skipped rather than stored, so the working set is intact.
    expect(markdownHtmlCacheSize()).toBe(sizeBefore);
  });
});
/** How many times the spied parser was invoked for exactly `text`. */
function parseCallsFor(parse: { mock: { calls: unknown[][] } }, text: string): number {
  return parse.mock.calls.filter((call) => call[0] === text).length;
}