import { renderToString } from "katex";
import { marked } from "marked";
import {
  escapeHtml,
  hasLatexDelimiterMarker,
  hasPotentialLatexMath,
  renderLatexMarkdown,
  type LatexRenderToString,
} from "./latexMath";

const renderer = new marked.Renderer();
renderer.html = ({ text }) => escapeHtml(text);

const MAX_MARKDOWN_CACHE_ENTRIES = 1_600;
/**
 * Character budget across retained keys and rendered HTML. Entry count alone is
 * a poor bound because message sizes vary by orders of magnitude, so the budget
 * is what actually caps retained memory; the entry cap only stops unbounded
 * `Map` growth from many tiny messages.
 */
const MAX_MARKDOWN_CACHE_CHARS = 6_000_000;
/**
 * Largest single entry worth retaining, as a fraction of the whole budget. One
 * enormous message must not evict an otherwise healthy working set to store
 * only itself.
 */
const MAX_SINGLE_ENTRY_SHARE = 8;

interface CacheEntry {
  html: string;
  chars: number;
}

// Insertion-ordered `Map` used as an LRU: a hit re-inserts the key so it moves
// to the newest position, and eviction always takes the oldest key. Plain FIFO
// (no re-insert) made switching between sessions evict transcripts that were
// still actively in use, so every switch re-parsed the whole transcript
// synchronously and blocked the main thread.
const markdownHtmlCache = new Map<string, CacheEntry>();
let retainedChars = 0;

export interface MarkdownRenderOptions {
  /**
   * Whether the rendered HTML may be cached. Streaming text must pass `false`:
   * every partial answer is a distinct cache key, so caching prefixes retains
   * hundreds of progressively larger copies of the same response and can freeze
   * the tab under fast provider output.
   */
  cache?: boolean;
  renderMath?: LatexRenderToString;
}

export function toSafeMarkdownHtml(text: string, options: MarkdownRenderOptions = {}): string {
  const useCache = options.cache !== false && options.renderMath === undefined;

  if (useCache) {
    const cached = markdownHtmlCache.get(text);
    if (cached !== undefined) {
      // Re-insert to mark this entry newest, so an actively viewed transcript is
      // never the eviction victim while a transcript nobody is reading survives.
      markdownHtmlCache.delete(text);
      markdownHtmlCache.set(text, cached);
      return cached.html;
    }
  }
  const html = options.renderMath !== undefined || hasLatexDelimiterMarker(text)
    ? renderLatexMarkdown(text, options.renderMath ?? renderToString)
    : marked.parse(text, { async: false, breaks: true, gfm: true, renderer });

  const safeHtml = sanitizeHtml(html);
  if (!useCache) return safeHtml;
  storeMarkdownHtml(text, safeHtml);
  return safeHtml;
}

function storeMarkdownHtml(text: string, html: string): void {
  const chars = text.length + html.length;
  // Skip outliers rather than letting one message clear most of the budget.
  if (chars > MAX_MARKDOWN_CACHE_CHARS / MAX_SINGLE_ENTRY_SHARE) return;
  const existing = markdownHtmlCache.get(text);
  if (existing !== undefined) {
    markdownHtmlCache.delete(text);
    retainedChars -= existing.chars;
  }
  markdownHtmlCache.set(text, { html, chars });
  retainedChars += chars;
  evictUntilWithinBudget();
}

function evictUntilWithinBudget(): void {
  // Stop at one entry: the newest store must survive even if it alone exceeds
  // the budget, otherwise this loop could evict everything and still not fit.
  while (markdownHtmlCache.size > 1
    && (markdownHtmlCache.size > MAX_MARKDOWN_CACHE_ENTRIES || retainedChars > MAX_MARKDOWN_CACHE_CHARS)) {
    const oldest = markdownHtmlCache.entries().next();
    if (oldest.done === true) break;
    const [key, entry] = oldest.value;
    markdownHtmlCache.delete(key);
    retainedChars -= entry.chars;
  }
}

export { hasPotentialLatexMath };

/** Current cached-entry count. Exposed so tests can assert cache growth. */
export function markdownHtmlCacheSize(): number {
  return markdownHtmlCache.size;
}

/** Retained characters across cached keys and rendered HTML. Exposed for tests. */
export function markdownHtmlCacheChars(): number {
  return retainedChars;
}

/** Drop all cached HTML. Exposed so tests can start from a known state. */
export function clearMarkdownHtmlCache(): void {
  markdownHtmlCache.clear();
  retainedChars = 0;
}

function sanitizeHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("script, style, iframe, object, embed").forEach((node) => { node.remove(); });
  template.content.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) element.removeAttribute(attribute.name);
      if ((name === "href" || name === "src") && !isSafeUrl(attribute.value)) element.removeAttribute(attribute.name);
    }
    if (element.tagName === "A") {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noreferrer noopener");
    }
  });
  return template.innerHTML;
}

function isSafeUrl(url: string): boolean {
  if (url.startsWith("#") || url.startsWith("/")) return true;
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
