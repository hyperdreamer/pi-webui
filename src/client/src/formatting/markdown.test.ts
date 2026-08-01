// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { markdownHtmlCacheSize, toSafeMarkdownHtml } from "./markdown";

describe("toSafeMarkdownHtml", () => {
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
});
