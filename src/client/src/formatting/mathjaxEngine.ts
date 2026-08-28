import { LiteElement } from "mathjax-full/js/adaptors/lite/Element.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { CHTML } from "mathjax-full/js/output/chtml.js";
import { resolveAppUrl } from "../appUrl";

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

const tex = new TeX({ packages: AllPackages, maxMacros: 1000 });
const chtml = new CHTML({
  fontURL: resolveAppUrl("mathjax/fonts"),
  adaptiveCSS: false,
});
const doc = mathjax.document("", { InputJax: tex, OutputJax: chtml });

/**
 * The public `mathjax.document` API is `any`-typed, but with CHTML output the
 * conversion and stylesheet results are always lite-adaptor elements. Narrow
 * them through `instanceof` at this boundary so the typed engine API below
 * never leaks `any`.
 */
function toLiteElement(node: unknown, what: string): LiteElement {
  if (!(node instanceof LiteElement)) {
    throw new TypeError(`MathJax ${what} did not produce an element`);
  }
  return node;
}

/**
 * Convert TeX to a CHTML HTML string synchronously. This module is the lazy
 * boundary: it is only ever loaded through the dynamic import in mathRenderer.
 */
export function convertLatex(texSource: string, display: boolean): string {
  const converted: unknown = doc.convert(texSource, { display });
  const node = toLiteElement(converted, "conversion");
  const output = adaptor.outerHTML(node);
  adaptor.remove(node);
  return output;
}

/** The complete CHTML stylesheet (all wrapper rules, `adaptiveCSS: false`), as a `<style>` element string. */
export function mathJaxStyles(): string {
  const stylesheet: unknown = doc.outputJax.styleSheet(doc);
  return adaptor.outerHTML(toLiteElement(stylesheet, "stylesheet"));
}
