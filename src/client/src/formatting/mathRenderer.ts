export class MathJaxNotReadyError extends Error {
  constructor() {
    super("MathJax has not finished loading yet");
    this.name = "MathJaxNotReadyError";
  }
}

interface MathJaxEngine {
  convertLatex(texSource: string, display: boolean): string;
  /** The CHTML stylesheet as raw CSS text, without a `<style>` wrapper. */
  mathJaxStyles(): string;
}

let enginePromise: Promise<MathJaxEngine> | undefined;
let readyEngine: MathJaxEngine | undefined;
let readyCssText: string | undefined;
let sharedCssSheet: CSSStyleSheet | undefined;

/** Start loading the MathJax engine once. Resolves with the engine when ready. */
export function startMathJax(): Promise<MathJaxEngine> {
  enginePromise ??= import("./mathjaxEngine")
    .then((engine) => {
      readyCssText = engine.mathJaxStyles();
      sharedCssSheet = buildSharedCssSheet(readyCssText);
      // Document-head rules cannot reach shadow DOM content, but CHTML draws
      // every glyph through CSS, so keep a document-level copy as well: it
      // covers any light-DOM consumer and keeps @font-face registrations
      // global. Raw CSS text, not a `<style>` outerHTML — a wrapper string
      // would make the CSS parser drop the first stylesheet rule.
      const style = document.createElement("style");
      style.setAttribute("data-mathjax-chtml", "");
      style.textContent = readyCssText;
      document.head.append(style);
      readyEngine = engine;
      return engine;
    })
    .catch((error: unknown) => {
      console.error("MathJax failed to load; math will render as literal source.", error);
      throw error;
    });
  return enginePromise;
}

function buildSharedCssSheet(cssText: string): CSSStyleSheet | undefined {
  if (typeof CSSStyleSheet !== "function" || typeof CSSStyleSheet.prototype.replaceSync !== "function") {
    return undefined;
  }
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    return sheet;
  } catch {
    return undefined;
  }
}

/**
 * Deliver the CHTML stylesheet inside a shadow root that renders MathJax
 * output. When the browser supports constructable stylesheets, one shared
 * sheet is parsed once and adopted by reference; otherwise a `<style>`
 * element with the same CSS text is appended. Idempotent per root, and a
 * no-op until the engine is ready: the caller re-invokes on the re-render
 * that follows readiness.
 */
export function installMathJaxStyles(shadowRoot: ShadowRoot): void {
  if (readyCssText === undefined) return;
  if (sharedCssSheet !== undefined && "adoptedStyleSheets" in shadowRoot) {
    if (!shadowRoot.adoptedStyleSheets.includes(sharedCssSheet)) {
      shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, sharedCssSheet];
    }
    return;
  }
  if (shadowRoot.querySelector("style[data-mathjax-chtml]") !== null) return;
  const style = document.createElement("style");
  style.setAttribute("data-mathjax-chtml", "");
  style.textContent = readyCssText;
  shadowRoot.append(style);
}

export function isMathJaxReady(): boolean {
  return readyEngine !== undefined;
}

export function whenMathJaxReady(): Promise<void> {
  return startMathJax().then(() => undefined);
}

/** Synchronous renderer used as the pipeline default. Throws before readiness. */
export function renderLatexWithMathJax(tex: string, options: { displayMode: boolean }): string {
  if (readyEngine === undefined) {
    throw new MathJaxNotReadyError();
  }
  return readyEngine.convertLatex(tex, options.displayMode);
}
