# MathJax Rendering Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace KaTeX with a self-hosted MathJax v3 (CHTML) engine behind the existing Markdown math pipeline so negated relation symbols (`\notin`, `\nsubseteq`, `\nexists`, `\not\le`) and overall math typography render properly.

**Architecture:** A new bridge module (`mathRenderer.ts`) lazily dynamic-imports a small engine module (`mathjaxEngine.ts`) that wraps `mathjax-full`'s lite-adaptor `doc.convert()` (synchronous, returns an HTML string) with `TeX({ packages: AllPackages, maxMacros: 1000 })` and `CHTML({ fontURL, adaptiveCSS: false })`. The existing discovery/admission pipeline in `latexMath.ts` and `markdown.ts` is largely untouched; the admission layer extends its forbidden-command list to MathJax's raw-splice command family (`\href`/`\url`/`\style`/`\class`/`\cssId`, `\bbox`, `\unicode`, `\definecolor`) and validates color-command arguments, because `AllPackages` enables commands that KaTeX's `trust: false` posture rejected, and the sanitizer rejects inline styles that pull elements out of the document flow (`position: fixed/absolute/sticky`; MathJax only emits `relative`). Fonts (23 `.woff` files from the `mathjax` es5 package) are copied into the build via `vite-plugin-static-copy` and resolved with `resolveAppUrl` for nested deployments.

**Tech Stack:** `mathjax-full@^3.2.2` (engine, dynamic chunk), `mathjax@^3.2.2` (devDependency, font assets only), `vite-plugin-static-copy@^4.1.1` (devDependency), Vite 8, Vitest 4 (jsdom), Lit.

## Global Constraints

- `mathjax-full@^3.2.2` is the engine dependency; do not install or upgrade to the 4.x line.
- `mathjax@^3.2.2` and `vite-plugin-static-copy@^4.1.1` are devDependencies used only for the font assets; no other new dependencies.
- No CDN: every MathJax asset is served from the app itself; `fontURL` is resolved via `resolveAppUrl("mathjax/fonts")`.
- Keep every admission budget in `latexMath.ts` unchanged: `MAX_DISCOVERY_BODY_UNITS = 2048`, `MAX_FORMULA_BODY_UNITS = 512`, `MAX_MESSAGE_SOURCE_UNITS = 4096`, `MAX_BRACE_DEPTH = 32`, `MAX_CONTROL_SEQUENCE_STARTS = 64`, `MAX_ALIGNMENT_SEPARATORS = 64`, `MAX_MATH_OUTPUT_UNITS = 256000`, `MAX_FORMULA_OUTPUT_UNITS = 32000`.
- MathJax expansion bound: `maxMacros: 1000`; CHTML option `adaptiveCSS: false`.
- Keep the `.math-inline` and `.math-display` wrapper classes produced by `renderLatexToken`.
- The renderer stays synchronous: `(tex: string, options: { displayMode: boolean }) => string`.
- jsdom tests must not load the MathJax es5 component script; all component-level tests use `setDefaultRenderMathForTesting` with a fake renderer, except the dedicated engine tests in `mathRenderer.test.ts` which load the real `mathjax-full` module.
- Every new export must be imported by at least one test in the task that introduces it (Knip runs in pre-commit).
- Pre-commit automatically runs `npm run verify:staged`; every commit must pass typecheck, Knip, and the related Vitest files.
- Test files use the `// @vitest-environment jsdom` pragma; run a single file with `npm test -- <path>`.

## Task 1: Add MathJax dependencies and serve font assets

**Implementer tier:** Standard

**Files:**

- Modify: `vite.config.ts:1-10` (imports) and `vite.config.ts:105-135` (plugins array)
- Modify: `THIRD_PARTY_NOTICES.md:1-35`
- Modify: `scripts/projectIdentity.test.mjs:52-60`
- Verify: `package.json`, `package-lock.json` (changed by npm, not hand-edited)

**Interfaces:**

- Consumes: nothing; this task only adds dependencies and build assets.
- Produces: font files served at `{app-base}/mathjax/fonts/*.woff` in dev and at `dist/client/mathjax/fonts/*.woff` in the production build (23 files), and npm packages `mathjax-full@^3.2.2`, `mathjax@^3.2.2`, `vite-plugin-static-copy@^4.1.1` present in `package.json`.

- [ ] **Step 1: Install the new dependencies**

```bash
npm install mathjax-full@^3.2.2
npm install --save-dev mathjax@^3.2.2 vite-plugin-static-copy@^4.1.1
```

Confirm with `node -e 'const p = require("./package.json"); console.log(p.dependencies["mathjax-full"], p.devDependencies["mathjax"], p.devDependencies["vite-plugin-static-copy"])'` that the three entries exist. Do NOT remove `katex` in this task; it is still imported until Task 3.

- [ ] **Step 2: Copy the font assets in the Vite config**

Add the import to the top of `vite.config.ts` (after the existing `import { defineConfig } from "vite";` line):

```ts
import { viteStaticCopy } from "vite-plugin-static-copy";
```

Change the `plugins` array in `vite.config.ts` (currently `plugins: [devDocsPlugin()],`) to:

```ts
export default defineConfig({
  plugins: [
    devDocsPlugin(),
    viteStaticCopy({
      targets: [
        {
          src: "../../node_modules/mathjax/es5/output/chtml/fonts/woff-v2/*",
          dest: "mathjax/fonts",
          rename: { stripBase: true },
        },
      ],
    }),
  ],
```

The `src` glob is relative to the Vite `root` (`src/client`); the `stripBase: true` rename flattens the copied tree so the 23 `.woff` files land directly in `dist/client/mathjax/fonts/`. Leave the rest of the config untouched.

- [ ] **Step 3: Add the MathJax entry to THIRD_PARTY_NOTICES.md**

Insert this section after the KaTeX section (which stays until Task 3 removes it):

```md
## MathJax 3.2.2

The Apache License, Version 2.0

MathJax is made available under the Apache License, Version 2.0 (the
"License"); you may not use this file except in compliance with the
License. You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

- [ ] **Step 4: Extend the project identity test**

In `scripts/projectIdentity.test.mjs`, extend the existing test named `"ships KaTeX and its attribution notice"` (do not rename it yet; Task 3 renames it) so it reads:

```js
  it("ships KaTeX and its attribution notice", () => {
    expect(packageManifest.dependencies).toMatchObject({ katex: "^0.18.4", "mathjax-full": "^3.2.2" });
    expect(packageManifest.devDependencies).toMatchObject({ mathjax: "^3.2.2" });
    expect(packageManifest.files).toContain("THIRD_PARTY_NOTICES.md");
    const notice = readFileSync(join(repositoryRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notice).toContain("KaTeX 0.18.4");
    expect(notice).toContain("MathJax 3.2.2");
    expect(notice).toContain("Apache License");
  });
```

- [ ] **Step 5: Verify the build emits the fonts and the tests pass**

```bash
npm run typecheck
npm test -- scripts/projectIdentity.test.mjs
npx vite build
ls dist/client/mathjax/fonts | wc -l
```

Expected: typecheck passes; the projectIdentity test passes; the build succeeds; the font count is exactly `23`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vite.config.ts THIRD_PARTY_NOTICES.md scripts/projectIdentity.test.mjs
git commit -m "chore(deps): add MathJax engine and font assets"
```

## Task 2: MathJax engine and bridge modules

**Implementer tier:** Standard

**Files:**

- Create: `src/client/src/formatting/mathjaxEngine.ts`
- Create: `src/client/src/formatting/mathRenderer.ts`
- Test: `src/client/src/formatting/mathRenderer.test.ts`

**Interfaces:**

- Consumes: `resolveAppUrl(path: string): string` from `src/client/src/appUrl.ts`; `toSafeMarkdownHtml` from `src/client/src/formatting/markdown.ts` (existing); the npm packages from Task 1.
- Produces:
  - `startMathJax(): Promise<MathJaxEngine>` (idempotent; injects the CHTML stylesheet into `document.head` on first start), where `MathJaxEngine = { convertLatex(texSource: string, display: boolean): string; mathJaxStyles(): string }`.
  - `isMathJaxReady(): boolean`.
  - `whenMathJaxReady(): Promise<void>`.
  - `renderLatexWithMathJax(tex: string, options: { displayMode: boolean }): string` (throws `MathJaxNotReadyError` before readiness).
  - `class MathJaxNotReadyError extends Error` (exported; tests assert `instanceof`).

- [ ] **Step 1: Write the failing tests**

Create `src/client/src/formatting/mathRenderer.test.ts`:

```ts
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
      .find((style) => style.textContent?.includes("MJX-CHTML-styles"));
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

    const inline = toSafeMarkdownHtml("$\\notin$", { cache: false, renderMath: renderLatexWithMathJax });
    expect(inline).toContain('class="math-inline"');
    expect(inline).toContain("mjx-c2209");

    const display = toSafeMarkdownHtml("$$\\frac{1}{2}$$", { cache: false, renderMath: renderLatexWithMathJax });
    expect(display).toContain('class="math-display"');
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- src/client/src/formatting/mathRenderer.test.ts`
Expected: FAIL, `Cannot find module './mathRenderer'`.

- [ ] **Step 3: Write the engine module**

Create `src/client/src/formatting/mathjaxEngine.ts`:

```ts
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
 * Convert TeX to a CHTML HTML string synchronously. This module is the lazy
 * boundary: it is only ever loaded through the dynamic import in mathRenderer.
 */
export function convertLatex(texSource: string, display: boolean): string {
  const node = doc.convert(texSource, { display }) as Parameters<typeof adaptor.outerHTML>[0];
  const output = adaptor.outerHTML(node);
  adaptor.remove(node);
  return output;
}

/** The complete CHTML stylesheet (all wrapper rules, `adaptiveCSS: false`), as a `<style>` element string. */
export function mathJaxStyles(): string {
  return adaptor.outerHTML(
    doc.outputJax.styleSheet(doc) as unknown as Parameters<typeof adaptor.outerHTML>[0],
  );
}
```

- [ ] **Step 4: Write the bridge module**

Create `src/client/src/formatting/mathRenderer.ts`:

```ts
export class MathJaxNotReadyError extends Error {
  constructor() {
    super("MathJax has not finished loading yet");
    this.name = "MathJaxNotReadyError";
  }
}

interface MathJaxEngine {
  convertLatex(texSource: string, display: boolean): string;
  mathJaxStyles(): string;
}

let enginePromise: Promise<MathJaxEngine> | undefined;
let readyEngine: MathJaxEngine | undefined;

/** Start loading the MathJax engine once. Resolves with the engine when ready. */
export function startMathJax(): Promise<MathJaxEngine> {
  if (enginePromise === undefined) {
    enginePromise = import("./mathjaxEngine")
      .then((engine) => {
        const style = document.createElement("style");
        style.textContent = engine.mathJaxStyles();
        document.head.append(style);
        readyEngine = engine;
        return engine;
      })
      .catch((error: unknown) => {
        console.error("MathJax failed to load; math will render as literal source.", error);
        return Promise.reject(error);
      });
  }
  return enginePromise;
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
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm test -- src/client/src/formatting/mathRenderer.test.ts`
Expected: PASS, 3 tests. The first test proves the not-ready throw; the other two load the real `mathjax-full` module through the dynamic import (jsdom-safe: the lite adaptor needs no DOM), verify the injected stylesheet contains `@font-face` and the resolved `mathjax/fonts` URL, and verify the production pipeline (`toSafeMarkdownHtml`) emits `mjx-c2209` (the real U+2209 glyph) inside `class="math-inline"` and `class="math-display"` wrappers.

- [ ] **Step 6: Commit**

```bash
git add src/client/src/formatting/mathjaxEngine.ts src/client/src/formatting/mathRenderer.ts src/client/src/formatting/mathRenderer.test.ts
git commit -m "feat(formatting): add MathJax engine bridge"
```

## Task 3: Swap the pipeline to MathJax and remove KaTeX

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/formatting/latexMath.ts:1-23` and `src/client/src/formatting/latexMath.ts:693-711`
- Modify: `src/client/src/formatting/markdown.ts:1-8` and `src/client/src/formatting/markdown.ts:40-68`
- Test: `src/client/src/formatting/markdown.test.ts:1-16`
- Test: `src/client/src/components/ChatView.latex.test.ts:1-130`
- Test: `src/client/src/components/FormattedText.test.ts:1-135`
- Modify: `src/client/src/components/FormattedText.ts:1-7` and `src/client/src/components/FormattedText.ts:99-108`
- Modify: `scripts/projectIdentity.test.mjs:52-60`
- Modify: `THIRD_PARTY_NOTICES.md:1-35`
- Modify: `package.json` and `package-lock.json` (via `npm uninstall katex`)

**Interfaces:**

- Consumes: `renderLatexWithMathJax(tex: string, options: { displayMode: boolean }): string` from Task 2.
- Produces:
  - `LatexRenderToString = (tex: string, options: { displayMode: boolean }) => string` (narrowed; no longer `KatexOptions`).
  - `escapeHtmlAttribute(text: string): string` (exported from `latexMath.ts`).
  - `setDefaultRenderMathForTesting(renderMath: LatexRenderToString | undefined): void` (exported from `markdown.ts`; `undefined` restores the MathJax default; a custom renderer forces the cache bypass that already exists for injected adapters).

- [ ] **Step 1: Narrow the renderer type and add wrapper labels in latexMath.ts**

In `src/client/src/formatting/latexMath.ts`:

1. Delete line 2 (`import type { KatexOptions } from "katex";`).
2. Change line 4 to:

```ts
export type LatexRenderToString = (tex: string, options: { displayMode: boolean }) => string;
```

3. Delete the whole `MATH_OPTIONS` constant (lines 15-23, from `const MATH_OPTIONS = {` through the `} as const satisfies Omit<KatexOptions, "displayMode">;` line).
4. Add this helper directly after the existing `escapeHtml` function:

```ts
/** Escape text for an HTML attribute value: the core escapes plus double quotes. */
export function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replaceAll('"', "&quot;");
}
```

5. In `renderLatexToken` (line 693), replace the render call and the wrapper return with:

```ts
  let rendered: string;
  try {
    rendered = renderMath(mathToken.tex, { displayMode: mathToken.displayMode });
  } catch {
    return literalForMathToken(mathToken);
  }
  if (!admitRenderedOutput(rendered, context)) return literalForMathToken(mathToken);
  const label = `aria-label="${escapeHtmlAttribute(mathToken.tex)}"`;
  return mathToken.displayMode
    ? `<div class="math-display" role="img" ${label}>${rendered}</div>`
    : `<span class="math-inline" role="img" ${label}>${rendered}</span>`;
```

The `aria-label`/`role="img"` pair preserves screen-reader access to the TeX source, which the KaTeX MathML annotation used to provide. The `escapeHtmlAttribute` escape of `"` matters because the sanitizer does not strip `style` attributes, so an unescaped quote in `tex` could break out of the attribute.

- [ ] **Step 2: Swap the default renderer and add the test seam in markdown.ts**

In `src/client/src/formatting/markdown.ts`:

1. Delete line 1 (`import { renderToString } from "katex";`).
2. Add after the existing `import { ... } from "./latexMath";` block:

```ts
import { renderLatexWithMathJax } from "./mathRenderer";
```

3. After the `let retainedChars = 0;` line, add:

```ts
let defaultRenderMath: LatexRenderToString = renderLatexWithMathJax;

/**
 * Test seam: swap the production MathJax renderer. Component tests pass a fake
 * so jsdom never needs the real engine; pass `undefined` to restore MathJax.
 * A custom renderer also forces the cache bypass that injected adapters use.
 */
export function setDefaultRenderMathForTesting(renderMath: LatexRenderToString | undefined): void {
  defaultRenderMath = renderMath ?? renderLatexWithMathJax;
}
```

4. In `toSafeMarkdownHtml`, change the fallback on line 67 from `options.renderMath ?? renderToString` to `options.renderMath ?? defaultRenderMath`.

- [ ] **Step 3: Update markdown.test.ts**

Replace the first test (`"renders representative math with KaTeX HTML and MathML"`) with:

```ts
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
```

Add `setDefaultRenderMathForTesting` to the existing import from `"./markdown"`. The cache-bypass and sanitizer tests below it already inject adapters and stay unchanged.

- [ ] **Step 4: Update ChatView.latex.test.ts to the MathJax surface**

In `src/client/src/components/ChatView.latex.test.ts`:

1. Add `import { setDefaultRenderMathForTesting } from "../formatting/markdown";` and a file-level fake:

```ts
const fakeMathRenderer = (tex: string, options: { displayMode: boolean }): string =>
  `<span class="mjx-container" data-display="${options.displayMode ? "true" : "false"}" data-tex="${tex}"></span>`;
```

2. In `afterEach`, add `setDefaultRenderMathForTesting(undefined);` and add a `beforeEach` that runs `setDefaultRenderMathForTesting(fakeMathRenderer);`.
3. Rename `assertKaTeXSurface` to `assertMathJaxSurface` and replace its body with:

```ts
function assertMathJaxSurface(element: FormattedText): void {
  expect(element.shadowRoot?.querySelector(".mjx-container")).not.toBeNull();
  expect(element.shadowRoot?.querySelector(".katex")).toBeNull();
}
```

4. Replace both `assertKaTeXSurface(` call sites with `assertMathJaxSurface(`.
5. In the streaming test, replace the two assertions

```ts
    expect(liveContainer?.querySelector(".katex")).toBeNull();
    expect(liveContainer?.querySelector("math")).toBeNull();
```

with

```ts
    expect(liveContainer?.querySelector(".mjx-container")).toBeNull();
```

6. Rename the first test title from `"renders every formatted ChatView route through the shared KaTeX boundary"` to `"renders every formatted ChatView route through the shared MathJax boundary"`.

- [ ] **Step 5: Update FormattedText.test.ts to the MathJax surface and drop the KaTeX CSS mock**

In `src/client/src/components/FormattedText.test.ts`:

1. Add `import { setDefaultRenderMathForTesting } from "../formatting/markdown";` and the same `fakeMathRenderer` definition as Step 4.
2. Add a `beforeEach` installing `setDefaultRenderMathForTesting(fakeMathRenderer);` and restore with `setDefaultRenderMathForTesting(undefined);` in `afterEach` (create the `beforeEach` if the file only has `afterEach`).
3. Where the file asserts `expect(settled.querySelector(".katex")).not.toBeNull();`, change it to `expect(settled.querySelector(".mjx-container")).not.toBeNull();`.
4. Where the file asserts the live plain container has no KaTeX output (a `.katex` null assertion), change it to assert `.mjx-container` is null. Leave the `styles` assertion on `".math-inline"` unchanged.
5. Delete the `vi.mock("katex/dist/katex.min.css?inline", () => ({ default: "@font-face { font-family: KaTeX_Main; }" }));` line; the import it mocked is removed in Step 8. If `vi` is then unused in the file, remove it from the `import { ... } from "vitest";` line.

- [ ] **Step 6: Remove the KaTeX stylesheet from FormattedText and swap the wrapper CSS**

In `src/client/src/components/FormattedText.ts`:

1. Change the import block (lines 1-7) to:

```ts
import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { writeClipboardText } from "../clipboard";
import { hasPotentialLatexMath, toSafeMarkdownHtml } from "../formatting/markdown";
import { formattedTextStyles } from "./shared";
```

This drops the `katex/dist/katex.min.css?inline` import and the now-unused `unsafeCSS` import; it must land in this task because the katex package is uninstalled here and both the Vite build and `ChatView.latex.test.ts` would otherwise fail to resolve it.

2. Replace the styles array (lines 99-108) with:

```ts
  static override styles = [
    formattedTextStyles,
    css`
      .formatted.plain { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
      .math-inline { display: inline-block; max-width: 100%; overflow-x: auto; vertical-align: -0.25em; }
      .math-display { display: block; max-width: 100%; overflow-x: auto; margin: 10px 0; }
      .math-display > mjx-container { margin: 0; }
    `,
  ];
```

The `-0.25em` inline vertical-align and the `mjx-container` margin neutralization are the MathJax-specific visual tuning; Task 5's browser probe confirms them visually.

- [ ] **Step 7: Update the project identity test and notices, then uninstall katex**

In `scripts/projectIdentity.test.mjs`, replace the test body written in Task 1 with:

```js
  it("ships MathJax and its attribution notice", () => {
    expect(packageManifest.dependencies).toMatchObject({ "mathjax-full": "^3.2.2" });
    expect(packageManifest.devDependencies).toMatchObject({ mathjax: "^3.2.2" });
    expect(packageManifest.files).toContain("THIRD_PARTY_NOTICES.md");
    const notice = readFileSync(join(repositoryRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notice).toContain("MathJax 3.2.2");
    expect(notice).toContain("Apache License");
    expect(notice).not.toContain("KaTeX");
  });
```

In `THIRD_PARTY_NOTICES.md`, delete the entire KaTeX section (from `## KaTeX 0.18.4` through the end of its MIT license text, immediately before the `## MathJax 3.2.2` heading).

Then remove the package:

```bash
npm uninstall katex
```

- [ ] **Step 8: Run the full affected test set, typecheck, and client build**

```bash
npm run typecheck
npx vite build
npm test -- src/client/src/formatting/latexMath.test.ts src/client/src/formatting/markdown.test.ts src/client/src/formatting/mathRenderer.test.ts src/client/src/components/ChatView.latex.test.ts src/client/src/components/FormattedText.test.ts scripts/projectIdentity.test.mjs
```

Expected: all pass. `latexMath.test.ts` needs no edits (its assertions are substring `toContain` checks that survive the aria-label addition). The client build proves the removed katex CSS import is fully gone.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json THIRD_PARTY_NOTICES.md scripts/projectIdentity.test.mjs src/client/src/formatting/latexMath.ts src/client/src/formatting/markdown.ts src/client/src/formatting/markdown.test.ts src/client/src/components/ChatView.latex.test.ts src/client/src/components/FormattedText.test.ts src/client/src/components/FormattedText.ts
git commit -m "feat(formatting): render math with MathJax and remove KaTeX"
```

## Task 4: Cold-start retry hook and app bootstrap

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/FormattedText.ts:1-7`, `src/client/src/components/FormattedText.ts:38-50`, and `src/client/src/components/FormattedText.ts:99-109`
- Modify: `src/client/src/main.ts:1-2`
- Test: `src/client/src/components/FormattedText.mathRetry.test.ts` (new)

**Interfaces:**

- Consumes: `isMathJaxReady(): boolean`, `whenMathJaxReady(): Promise<void>`, `renderLatexWithMathJax(tex: string, options: { displayMode: boolean }): string` from Task 2; `hasPotentialLatexMath(source: string): boolean` and `toSafeMarkdownHtml(text: string, options: MarkdownRenderOptions): string` from `markdown.ts`.
- Produces: the cold-start re-render behavior — a settled message that rendered literal source before MathJax readiness re-renders through `toSafeMarkdownHtml(text, { cache: false, renderMath: renderLatexWithMathJax })` once `whenMathJaxReady()` resolves.

- [ ] **Step 1: Write the failing retry test**

Create `src/client/src/components/FormattedText.mathRetry.test.ts`:

```ts
// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { FormattedText } from "./FormattedText";

describe("FormattedText cold-start math retry", () => {
  it("re-renders literal math once the MathJax engine becomes ready", async () => {
    const element = new FormattedText();
    element.text = "Area: $x^2$";
    document.body.append(element);
    await element.updateComplete;

    // Not ready yet: the settled message renders the literal fallback.
    expect(element.shadowRoot?.querySelector(".math-inline")).toBeNull();
    expect(element.shadowRoot?.textContent).toContain("$x^2$");

    // The real engine loads in jsdom; the hook re-renders with MathJax output.
    await vi.waitFor(() => {
      expect(element.shadowRoot?.querySelector("mjx-container")).not.toBeNull();
    }, { timeout: 10_000 });

    expect(element.shadowRoot?.querySelector(".math-inline")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- src/client/src/components/FormattedText.mathRetry.test.ts`
Expected: FAIL on the first `vi.waitFor` (the `.math-inline` query is null and stays null; the second assertion `$x^2$` text passes).

- [ ] **Step 3: Add the retry hook and renderer plumbing to FormattedText**

In `src/client/src/components/FormattedText.ts`:

1. Add the MathJax imports to the import block (Task 3 removed the katex CSS import; do not reintroduce it):

```ts
import { isMathJaxReady, renderLatexWithMathJax, whenMathJaxReady } from "../formatting/mathRenderer";
```

2. Add two private fields before `override render()`:

```ts
  /** Set when a cold-start retry re-render must bypass the literal-fallback cache entry. */
  private retryMathRender = false;
  /** One subscription per element; the retry promise never resolves if the engine fails to load. */
  private mathRetryScheduled = false;
```

3. Replace `override render()` (lines 40-45) and add the two helpers after it:

```ts
  override render() {
    // A large live tail renders as plain text: Lit updates the single text node
    // in place instead of reparsing and rebuilding the whole subtree per delta.
    if (shouldRenderLivePlainText(this)) return html`<div class="formatted plain" dir="auto">${this.text}</div>`;
    return html`<div class="formatted" dir="auto" @click=${this.onFormattedClick}>${unsafeHTML(this.renderMarkdown())}</div>`;
  }

  private renderMarkdown(): string {
    if (this.retryMathRender) {
      this.retryMathRender = false;
      // Cache bypass: the first attempt may have cached a literal-fallback render.
      return toSafeMarkdownHtml(this.text, { cache: false, renderMath: renderLatexWithMathJax });
    }
    return toSafeMarkdownHtml(this.text, { cache: !this.live });
  }

  /**
   * Cold-start insurance: a settled message rendered before MathJax finished
   * loading shows literal source; re-render it once the engine is ready.
   */
  private scheduleMathRetry(): void {
    if (this.mathRetryScheduled || isMathJaxReady() || this.live || !hasPotentialLatexMath(this.text)) return;
    this.mathRetryScheduled = true;
    void whenMathJaxReady()
      .then(() => {
        this.retryMathRender = true;
        this.requestUpdate();
      })
      .catch(() => {
        // The engine failed to load; the message stays literal source.
      });
  }
```

4. Extend `override updated()` to call the hook:

```ts
  override updated(): void {
    this.enhanceCodeBlocks();
    this.scheduleMathRetry();
  }
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- src/client/src/components/FormattedText.test.ts src/client/src/components/FormattedText.mathRetry.test.ts`
Expected: PASS. The retry test proves the full cold-start story with the real engine in jsdom: literal `$x^2$` first, then `mjx-container` output after the dynamic import resolves and the hook re-renders.

- [ ] **Step 5: Wire the app bootstrap in main.ts**

Replace the whole content of `src/client/src/main.ts` with:

```ts
import "./components/PiWebUiApp";
import { startMathJax } from "./formatting/mathRenderer";

// Math loads after the app shell starts; settled math messages render once ready.
void startMathJax();
```

- [ ] **Step 6: Commit**

```bash
git add src/client/src/components/FormattedText.ts src/client/src/components/FormattedText.mathRetry.test.ts src/client/src/main.ts
git commit -m "feat(formatting): retry cold-start math once MathJax is ready"
```

## Task 5: Changeset and full verification

**Implementer tier:** Standard

**Files:**

- Create: `.changeset/mathjax-rendering-engine.md`

**Interfaces:**

- Consumes: everything from Tasks 1-4.
- Produces: a release fragment and a verified production build.

- [ ] **Step 1: Write the changeset**

Create `.changeset/mathjax-rendering-engine.md`:

```md
---
"@hyperdreamer/pi-webui": patch
---

Upgrade LaTeX math rendering to MathJax for cleaner typography, including proper glyphs for negated relation symbols such as `\notin`.
```

- [ ] **Step 2: Run the full verification suite**

```bash
npm run verify
npm run build
```

Expected: typecheck, lint, Knip, and the full serial test suite pass; the full build succeeds. Knip must report no unused exports (every new export from Tasks 2-4 is imported by its tests or by production consumers).

- [ ] **Step 3: Verify the production assets**

```bash
ls dist/client/mathjax/fonts | wc -l
```

Expected: `23`. Confirm `grep -r "mjx-c2209" dist/client/assets/*.js` matches nothing (the glyph is produced at runtime, not baked into the bundle).

- [ ] **Step 4: Real-browser probe against the production build**

```bash
npx vite preview --port 8940 &
PREVIEW_PID=$!
sleep 2
CHUNK=$(ls dist/client/assets | grep -E '^mathjaxEngine-.*\.js$' | head -1)
echo "$CHUNK"
```

If the chunk name does not match `mathjaxEngine-*.js`, list `dist/client/assets` and use the dynamic-import chunk that contains the MathJax engine code. Then create `/tmp/math-browser-probe.html` with `CHUNK` substituted literally:

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>math probe</title>
<style>body{font:15px/1.5 system-ui,sans-serif}#out .math-inline{display:inline-block;vertical-align:-0.25em}</style>
</head>
<body>
<div id="out"></div>
<script type="module">
const engine = await import("./assets/CHUNK");
const style = document.createElement("style");
style.innerHTML = engine.mathJaxStyles();
document.head.append(style);
const out = document.getElementById("out");
for (const tex of ["\\notin", "\\nsubseteq", "\\nexists", "\\not\\le"]) {
  const span = document.createElement("span");
  span.className = "math-inline";
  span.innerHTML = engine.convertLatex(tex, false);
  out.append(span, document.createTextNode("  "));
}
document.body.dataset.done = "1";
</script>
</body>
</html>
```

Copy it into the preview root and screenshot it:

```bash
cp /tmp/math-browser-probe.html dist/client/mathprobe.html
chromium --headless=new --disable-gpu --no-sandbox --hide-scrollbars --window-size=1000,400 --virtual-time-budget=30000 --screenshot=/tmp/math-browser-probe.png "http://localhost:8940/mathprobe.html"
```

Use `vision_analyze` on `/tmp/math-browser-probe.png` and confirm the negation strokes are proper diagonal slashes (∉, ⊄, ∄, ≰). Then confirm the self-hosted fonts are reachable through the preview server:

```bash
curl -sI http://localhost:8940/mathjax/fonts/MathJax_Main-Regular.woff | head -1
```

Expected: `HTTP/1.1 200`. Then stop the preview server and remove the probe file:

```bash
kill $PREVIEW_PID
rm dist/client/mathprobe.html
```

- [ ] **Step 5: Commit**

```bash
git add .changeset/mathjax-rendering-engine.md
git commit -m "chore: changeset for MathJax rendering upgrade"
```
