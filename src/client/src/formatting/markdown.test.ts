// @vitest-environment jsdom

import { marked } from "marked";
import { describe, expect, it, vi } from "vitest";
import { clearMarkdownHtmlCache, markdownHtmlCacheChars, markdownHtmlCacheSize, setDefaultRenderMathForTesting, toSafeMarkdownHtml } from "./markdown";

// The real MathJax engine never loads in jsdom. Model readiness explicitly so
// the cache contract can be pinned in both states: before readiness the default
// renderer falls back to literal TeX and must not cache it; once ready,
// production math renders cache like any other text.
const mathRendererState = vi.hoisted(() => ({ ready: false }));
vi.mock("./mathRenderer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mathRenderer")>();
  return {
    ...actual,
    isMathJaxReady: () => mathRendererState.ready,
    renderLatexWithMathJax: (tex: string, options: { displayMode: boolean }): string => {
      if (!mathRendererState.ready) throw new actual.MathJaxNotReadyError();
      return `<mjx-container data-tex="${tex}" data-display="${String(options.displayMode)}"></mjx-container>`;
    },
  };
});

describe("toSafeMarkdownHtml", () => {
  it("renders representative math with the injected renderer surface", () => {
    setDefaultRenderMathForTesting((tex, { displayMode }) =>
      `<span class="mjx-container" data-display="${displayMode ? "true" : "false"}" data-tex="${tex}"></span>`);
    try {
      const html = toSafeMarkdownHtml("Area: $x^2$", { cache: false });
      expect(html).toContain('class="math-inline"');
      expect(html).toContain('class="mjx-container"');
    } finally {
      setDefaultRenderMathForTesting(undefined);
    }
  });

  it("caches production math renders once ready, never caches pre-readiness literals, and bypasses injected adapters", () => {
    clearMarkdownHtmlCache();
    const source = `$x$ ${String(Date.now())} ${Math.random().toString(36)}`;
    const before = markdownHtmlCacheSize();

    // Pre-readiness the default renderer falls back to literal TeX; caching
    // that would serve stale literals forever even after the readiness retry
    // re-renders with cache bypass.
    mathRendererState.ready = false;
    const coldFirst = toSafeMarkdownHtml(source);
    const coldSecond = toSafeMarkdownHtml(source);

    expect(coldSecond).toBe(coldFirst);
    expect(markdownHtmlCacheSize()).toBe(before);

    mathRendererState.ready = true;
    const warmFirst = toSafeMarkdownHtml(source);
    const warmSecond = toSafeMarkdownHtml(source);

    expect(warmSecond).toBe(warmFirst);
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

  it("strips inline styles that reposition elements out of the document flow", () => {
    const adapter = vi.fn(() =>
      "<mjx-mi style=\"color: red;position:fixed;inset:0;z-index:99999;background:white\">EVIL</mjx-mi>");

    const html = toSafeMarkdownHtml("before $x$ after", { renderMath: adapter });

    expect(html).toContain("EVIL");
    expect(html).not.toMatch(/style\s*=/u);
  });

  it("keeps MathJax's own layout styles", () => {
    const adapter = vi.fn(() =>
      "<mjx-block style=\"width: 1.302em; margin: 0.276em 0 0.276em; position: relative; left: 0.276em; top: 0; max-width: 1.302em;\">x</mjx-block>");

    const html = toSafeMarkdownHtml("before $x$ after", { renderMath: adapter });

    expect(html).toContain("position: relative");
    expect(html).toContain("margin: 0.276em");
  });

  it("preserves unmatched closing markers through the Markdown facade", () => {
    const html = toSafeMarkdownHtml(String.raw`before \) and \] after`, { cache: false });

    expect(html).toContain(String.raw`\)`);
    expect(html).toContain(String.raw`\]`);
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
/** Render one Markdown link/image and return the actual sanitized element. */
function markdownAttribute(destination: string, image: boolean): Element {
  const template = document.createElement("template");
  template.innerHTML = toSafeMarkdownHtml(`${image ? "!" : ""}[local](<${destination}>)`);
  const element = template.content.querySelector(image ? "img" : "a");
  if (element === null) throw new Error("Missing Markdown element");
  return element;
}

const safeCandidates = [
  ["a.html", "a.html"],
  ["./a.html", "./a.html"],
  ["../a.html", "../a.html"],
  ["/ramdisk/a.html", "/ramdisk/a.html"],
  ["?view=a.html", "?view=a.html"],
  ["//cdn.example/a.png", "//cdn.example/a.png"],
  ["C:/Work/a.html", "C:/Work/a.html"],
  [String.raw`C:\Work\Repo\a.html`, "C:%5CWork%5CRepo%5Ca.html"],
  ["file:///ramdisk/a.html", "file:///ramdisk/a.html"],
  ["file://localhost/ramdisk/a.html", "file://localhost/ramdisk/a.html"],
  ["notes/a:b.txt", "notes/a:b.txt"],
] as const;

// Marked declines a literal newline inside an angle-bracket destination, so
// the newline-obfuscated active scheme is written as the equivalent entity and
// the assertion still checks the actual created DOM attribute.
const unsafeSchemes: readonly (readonly [label: string, destination: string])[] = [
  ["javascript:alert(1)", "javascript:alert(1)"],
  ["JaVaScRiPt:alert(1)", "JaVaScRiPt:alert(1)"],
  ["data:text/html,hello", "data:text/html,hello"],
  ["vbscript:msgbox(1)", "vbscript:msgbox(1)"],
  ["unknown:thing", "unknown:thing"],
  ["java%09script:alert(1)", "java%09script:alert(1)"],
  ["java%0Ascript:alert(1)", "java%0Ascript:alert(1)"],
  ["java\tscript:alert(1)", "java\tscript:alert(1)"],
  ["java\nscript:alert(1)", "java&#10;script:alert(1)"],
  ["%6Aavascript%3Aalert(1)", "%6Aavascript%3Aalert(1)"],
  ["unknown%3Athing", "unknown%3Athing"],
];

// Percent-encoded controls hide a relative filename or an allowed-scheme path
// from the scheme and relative-reference rules, so only the control-character
// rejection can remove these; Marked creates the element before sanitizing.
const controlBearingDestinations: readonly (readonly [label: string, destination: string])[] = [
  ["relative filename with encoded tab", "local%09.html"],
  ["relative filename with encoded newline", "local%0A.html"],
  ["allowed https path with encoded DEL", "https://outside.example/a%7F.html"],
];

describe("toSafeMarkdownHtml local file destinations", () => {
  for (const image of [false, true]) {
    for (const [source, expected] of safeCandidates) {
      it(`preserves ${source} on ${image ? "src" : "href"}`, () => {
        expect(markdownAttribute(source, image).getAttribute(image ? "src" : "href")).toBe(expected);
      });
    }
  }

  for (const image of [false, true]) {
    for (const [label, destination] of unsafeSchemes) {
      it(`removes ${JSON.stringify(label)} from ${image ? "src" : "href"}`, () => {
        expect(markdownAttribute(destination, image).hasAttribute(image ? "src" : "href")).toBe(false);
      });
    }
  }

  for (const image of [false, true]) {
    for (const [label, destination] of controlBearingDestinations) {
      it(`removes ${label} from ${image ? "src" : "href"}`, () => {
        expect(markdownAttribute(destination, image).hasAttribute(image ? "src" : "href")).toBe(false);
      });
    }
  }

  it("retains external anchor target and rel behavior", () => {
    for (const target of ["http://example.test/a", "https://example.test/a", "mailto:user@example.test", "#part"]) {
      const a = markdownAttribute(target, false);
      expect(a.getAttribute("href")).toBe(target);
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noreferrer noopener");
    }
  });

  it("caches only the written file targets", () => {
    const text = "[local](a.html) ![plot](plot.svg)";
    const first = toSafeMarkdownHtml(text);
    expect(toSafeMarkdownHtml(text)).toBe(first);
    expect(first).toContain('href="a.html"');
    expect(first).toContain('src="plot.svg"');
    expect(first).not.toContain("/file/view");
    expect(first).not.toContain("data-file-preview");
  });

  it("keeps encoded Windows drive destinations for links and images", () => {
    for (const image of [false, true]) {
      const attribute = image ? "src" : "href";
      expect(markdownAttribute(String.raw`C:\Work\Repo\a.html`, image).getAttribute(attribute)).toBe("C:%5CWork%5CRepo%5Ca.html");
      const template = document.createElement("template");
      template.innerHTML = toSafeMarkdownHtml(`${image ? "!" : ""}[local](${String.raw`C:\\Work\\Repo\\a.html`})`);
      expect(template.content.querySelector(image ? "img" : "a")?.getAttribute(attribute)).toBe("C:%5CWork%5CRepo%5Ca.html");
    }
  });
});
