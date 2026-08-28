# MathJax Rendering Engine

## Problem

PI WEBUI renders LaTeX with KaTeX 0.18.4. KaTeX has no real glyph for several negated-relation symbols: `\notin` is defined in KaTeX's own source as `\mathllap{/}` — a plain slash character dragged left over `∈` — and the Unicode codepoint `∉` (U+2209) is remapped to that same composite. The result looks visibly broken: thin, vertical-looking, misaligned negation strokes. The same slash-overlay technique covers other negations (`\nsubseteq`, `\nexists`, `\not\le`, `\not\ni`).

A Chromium screenshot comparison (KaTeX current, KaTeX `\not\...` composition, native browser MathML, MathJax v3) confirmed:

- KaTeX current: worst — thin, off-center, nearly vertical overlays.
- KaTeX `\not\...`: modest improvement, still visibly assembled.
- Native MathML: cleanest single glyphs, but rendering quality moves to each browser.
- MathJax v3: proper diagonal negation strokes, consistent across all sampled symbols, blends well with the surrounding sans-serif UI text.

The chosen direction is a full typography upgrade: replace the KaTeX render engine with MathJax v3 (CHTML output, self-hosted, loaded at app start), behind the existing discovery/admission pipeline.

The original LaTeX rendering design (2026-08-21) rejected MathJax because it "would add asynchronous, heavier runtime behavior that complicates streaming updates, cache reuse, and layout stability." That rejection is revisited here with evidence:

- **Streaming**: live message tails containing a potential math delimiter already render as line-preserving plain text until settlement (`shouldRenderLivePlainText` in `FormattedText.ts`). MathJax is therefore never invoked on a growing formula; it renders each settled message once.
- **Sync API**: `MathJax.tex2chtml(tex, { display })` is synchronous after `MathJax.startup.promise` resolves. The existing `LatexRenderToString` sync interface is preserved.
- **Cache reuse**: the LRU markdown HTML cache stores strings; CHTML output is an HTML string like KaTeX's, so the cache shape is unchanged.
- **Layout stability**: the existing `.math-inline` / `.math-display` wrappers are retained; MathJax display-math margins are neutralized with one CSS rule, mirroring the current `.katex-display` rule.

## Goals

- Fix the broken negation composites (`\notin` and friends) with proper TeX-quality typography.
- Upgrade overall math typography: spacing, alignment with surrounding text, consistency across constructs.
- Keep the existing pipeline untouched where possible: delimiter discovery, admission guards, literal fallback, LRU cache, streaming plain-text behavior, `.math-inline` / `.math-display` wrappers.
- Self-host MathJax (local-first app; no CDN dependency) and keep nested-deployment URL rules (`resolveAppUrl`).
- Preserve dark-mode theming (MathJax CHTML inherits `currentColor`).
- Keep the math renderer injectable for tests (jsdom cannot load the es5 component script).

## Non-Goals

- Native MathML rendering (browser-owned layout, browser floor Chrome 109+/Safari 16.4+, per-OS font variance) — documented as the rejected alternative.
- KaTeX retention with a curated glyph patch (whack-a-mole; does not fix overall typography).
- Server-side math rendering in the session daemon or web API.
- The MathJax `[safe]` extension: the existing source-level admission guards (forbidden `\def`/`\gdef`/`\let`/`\newcommand`/…, brace-depth, control-sequence and alignment-separator caps) remain the security boundary; MathJax v3 does not enable `\href`/`\url` by default.
- MathJax optional-extensions tuning (e.g. `mhchem`/`physics`): the full es5 tree is served so extensions load on demand; failures fall back to literal source, same as KaTeX errors today.
- SVG output: CHTML is chosen for lean DOM and string-cache compatibility; SVG with `fontCache: "none"` would inflate per-message HTML against the output budgets.
- A pruned/slimmed MathJax asset copy: full es5 tree first, pruning is a possible follow-up.

## Approach

### Engine bridge (`src/client/src/formatting/mathRenderer.ts`, new)

A small bridge module owns MathJax lifecycle and the renderer function:

- `startMathJax(): void` — idempotent. Injects a `<script>` tag for the self-hosted es5 component (`resolveAppUrl("mathjax/tex-chtml.js")`, resolved exactly once at the browser boundary per the app-URL convention) with pre-set config: `tex: { maxMacros: 1000 }` (mirrors today's `maxExpand: 1000`), no inline delimiters configured (the pipeline drives display mode), CHTML defaults. The component injects its own stylesheet and derives its font URL from its script location, so no `fontURL` override is needed.
- `isMathJaxReady(): boolean` and `whenMathJaxReady(): Promise<void>`.
- `renderLatexWithMathJax(tex, { displayMode }): string` — synchronous; throws `MathJaxNotReadyError` before readiness; otherwise returns `MathJax.tex2chtml(tex, { display: displayMode }).outerHTML`.

### Pipeline integration (`latexMath.ts`, `markdown.ts`)

- `LatexRenderToString` options narrow from `KatexOptions` to `{ displayMode: boolean }`; the `katex` type import and the `MATH_OPTIONS` constant are removed.
- `markdown.ts` default `renderMath` becomes `renderLatexWithMathJax` via the bridge.
- All admission guards, budgets (`MAX_FORMULA_BODY_UNITS`, `MAX_MESSAGE_SOURCE_UNITS`, `MAX_FORMULA_OUTPUT_UNITS`, `MAX_MATH_OUTPUT_UNITS`), forbidden commands, and the literal-fallback path are unchanged. CHTML output length is comparable to KaTeX's HTML output, so the budgets need no tuning.
- Error handling is unchanged: `renderLatexToken` already catches renderer throws and emits escaped source (`literalForMathToken`).

### Loading and cold start

- `main.ts` calls `void startMathJax()` after app bootstrap (fire-and-forget; local assets, non-blocking).
- If a render lands before readiness — only possible for a user's own message in the first moments after load — the pipeline's literal fallback shows the escaped source and `FormattedText` re-renders the message once `whenMathJaxReady()` resolves. The retry passes the renderer explicitly (`toSafeMarkdownHtml(text, { cache: false, renderMath: renderLatexWithMathJax })`), because the first attempt may have cached the literal-fallback HTML under the same key and that stale entry must neither be read nor left behind. `FormattedText` subscribes to the readiness promise when it rendered a math-marker message while not ready.

### Styling (`FormattedText.ts`)

- Remove `katex/dist/katex.min.css?inline` (and later the `katex` dependency).
- Keep `.math-inline` / `.math-display` wrappers.
- Expected tuning, each verified by Chromium screenshot comparison against the current build before finalizing:
  1. `.math-display > .mjx-container { margin: 0 }` — neutralize MathJax's display margins inside our wrapper (mirrors `.katex-display`).
  2. Inline size/baseline: MathJax renders at 1em with its own baseline handling; likely a small `font-size` and `vertical-align` tune on `.math-inline` for optical parity with 14px text (the current `vertical-align: middle` may become a fixed-em offset).
  3. Wide-formula overflow behavior stays (`max-width: 100%; overflow-x: auto`).

### Assets

- `vite-plugin-static-copy` (new devDependency) copies `node_modules/mathjax/es5/` (component script, on-demand extension files, `output/chtml/fonts/woff-v2/`) into the build output and serves it in dev. Nothing is committed to git; versions track `package.json`.
- The whole es5 tree is copied (≈4-5MB static) because MathJax dynamically fetches optional extensions from its own directory; only what is used is fetched at runtime (typically script + used font subsets, ≈1.5-2MB).
- Script URL resolved once via `resolveAppUrl("mathjax/tex-chtml.js")` for nested-deployment safety.

### Test seam

- `markdown.ts` gains a test seam so jsdom tests install a fake renderer producing MathJax-shaped markup (`.mjx-container`); jsdom never loads the real es5 script.
- `latexMath.test.ts` is unchanged (already injects fakes).
- `ChatView.latex.test.ts`: `assertKaTeXSurface` becomes the new surface — `.mjx-container` present, `.katex`/`math` absent.
- `markdown.test.ts`: the KaTeX-specific HTML assertion becomes a MathJax-output assertion with the fake.
- New `mathRenderer.test.ts`: config shape, idempotent `startMathJax()`, readiness promise, sync render call, `MathJaxNotReadyError` before readiness, script-injection URL resolution (nested base), script element mocked.
- `FormattedText`: unit coverage for the re-render-on-ready hook.

### Release surface

- `package.json`: `katex` → `mathjax`.
- `THIRD_PARTY_NOTICES.md`: replace the KaTeX (MIT) entry with MathJax (Apache-2.0).
- Changeset: user-visible rendering change (math engine upgrade), classification per the release workflow.
- `scripts/projectIdentity.test.mjs` references katex; update the dependency inventory.
- No user-facing docs changes: KaTeX is only referenced in superpowers specs/plans, not in README or docs landing pages.

## Verification

- Full client test suite, lint, typecheck, Knip (new exports consumed; no planned-but-unconsumed exports).
- Production build: confirm `mathjax/` assets emitted and referenced through the base-aware URL helper; nested-base dev run renders math.
- Real-browser check of a math-heavy message: `\notin` and friends render with proper diagonal strokes; dark mode; wide-formula overflow; streaming shows plain text until settlement then math; cold-start message re-renders after readiness.
- Chromium screenshot comparison of inline alignment/size vs. the current build; CSS tuned to optical parity before finalizing.
