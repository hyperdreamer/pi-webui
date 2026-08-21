# LaTeX Message Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users enter ordinary LaTeX delimiters in the existing plain-text composer and render bounded, accessible KaTeX equations across PI WEBUI's formatted chat content.

**Architecture:** Keep `markdown.ts` as the small cache and sanitization facade. Add a deep `latexMath.ts` module that creates a fresh `Marked` instance and renderer per uncached render, rewrites only core-token-safe raw runs to math/literal tokens, and owns delimiter parsing, resource admission, and injected KaTeX rendering. `FormattedText` supplies KaTeX's shadow-root CSS and defers all possible math while live; existing `ChatView` use of that component gives all formatted message surfaces the same policy.

**Tech Stack:** TypeScript 6, Marked 18.0.6, KaTeX 0.18.4, Lit 3, Vite 8, Vitest 4, npm 11, raw Chromium CDP, Changesets.

## Global Constraints

- Work from an isolated feature worktree created by the deterministic controller; do not edit the shared base checkout, existing `.sdd` artifacts, or user-owned changes.
- This is a client-only feature. Do not modify `src/server/sessiond.ts`, session-daemon code or protocol, server routes, prompt transport, session data, or persisted configuration.
- Keep `PromptEditor` as a plain-text CodeMirror editor. Do not add preview, toolbar, autocomplete, a new input mode, or composer-specific LaTeX syntax behavior.
- Use KaTeX as the direct production dependency `katex: ^0.18.4`; use its named `renderToString` export and `KatexOptions` type. Do not add `marked-katex-extension`, MathJax, or another math runtime.
- Use exactly these KaTeX options for every accepted formula: `output: "htmlAndMathml"`, `throwOnError: false`, `trust: false`, `strict: "ignore"`, `maxExpand: 1000`, and `maxSize: 100`.
- Never call `marked.use()` or mutate the shared `marked` singleton. Each uncached visual render must own a fresh `Marked` instance, a fresh Marked renderer, and a fresh math budget; `hostSpeechText.ts` remains on unextended core Marked behavior.
- Preserve the existing `toSafeMarkdownHtml()` cache key, LRU bounds, HTML sanitizer, code-copy behavior, and `LIVE_PLAIN_TEXT_MIN_CHARS = 24_000` behavior. A test-injected math adapter always bypasses the production HTML cache.
- Render only `$...$` and `\(...\)` inline. Render `$$...$$` and `\[...\]` only as the line-isolated display blocks defined in the approved spec. Never infer math from bare commands.
- Math recognition may operate only within one raw core-Markdown inline scope. It must not cross code spans, fenced/indented code, links, images, HTML, autolinks/URLs, line breaks, emphasis/strong/deletion boundaries, table-cell boundaries, or block boundaries. Link labels and image alt text remain ordinary Markdown.
- Preserve exact literal source for unescaped unmatched `\(`, `\)`, `\[`, and `\]`; for discovered non-block display pairs; and for any discovered complete pair rejected by budget, renderer failure, or output limits. Escaped delimiters retain ordinary Markdown escape behavior; unmatched dollars remain ordinary text.
- Use raw UTF-16 source before Markdown escape decoding. Delimiter discovery is capped at 2,048 body code units; render admission allows at most 512 body code units per formula, 4,096 body code units and 8 formulas per message, brace depth 32, 64 control-sequence starts per formula, and 64 combined unescaped alignment/row separators per formula. Reject `\def`, `\gdef`, `\edef`, `\xdef`, `\let`, `\newcommand`, and `\renewcommand`.
- Reserve 32,000 rendered HTML characters before each KaTeX call from a 256,000-character per-message math-output budget. An oversized rendered fragment falls back to exact source and closes later KaTeX admission for that message.
- A live tail with any potential `$`, `\(`, or `\[` opener must use line-preserving plain text regardless of length. It must not invoke the dedicated parser or KaTeX until `live` becomes false.
- Import `katex/dist/katex.min.css?inline` into `FormattedText.styles` through Lit `unsafeCSS`. Use `.math-inline` and `.math-display` wrappers with horizontal containment; `.math-display` must not set a fixed/max height or vertical clipping.
- Add root `THIRD_PARTY_NOTICES.md` with KaTeX 0.18.4 attribution and its full MIT text, add it to package `files`, and add one minor Changeset for `@hyperdreamer/pi-webui`. Never hand-edit `CHANGELOG.md`.
- Use TDD for every behavior change: write a focused test, observe its expected RED failure, write the minimum production code, and observe GREEN before moving on. Use `npm run test:serial -- --run <file>` for focused tests.
- Final validation must include `npm run verify`, `npm run changelog:status`, `npm run build`, `npm pack --dry-run --ignore-scripts --json`, `npm audit --omit=dev --json`, production asset inspection, and the disposable Chromium/CDP probe. A production/direct-dependency audit finding is not covered by `IGNORED.md` and must not be waived.
- Browser fixtures, temporary Vite configs, CDP drivers, profiles, screenshots, logs, and temporary servers are verification-only. Keep them under `src/client/` only while probing or under `/tmp`, remove them before staging, and prove cleanup with `git status --short` and closed temporary ports.

## Task 1: Package KaTeX, Attribution, And Release Metadata

**Implementer tier:** Standard

**Files:**

- Modify: `package.json:13-86`
- Modify: `package-lock.json:1-120` and npm-generated KaTeX package records
- Modify: `scripts/projectIdentity.test.mjs:1-72`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `.changeset/latex-message-rendering.md`

**Interfaces:**

- Consumes: package name `@hyperdreamer/pi-webui`, npm lockfile version 3, and KaTeX 0.18.4's packaged `LICENSE` file.
- Produces: a direct production dependency `katex: ^0.18.4`; a published root `THIRD_PARTY_NOTICES.md`; a package `files` entry for that notice; and a minor Changeset describing rendered LaTeX conversation math.
- Preserves: every existing package script, engine, peer dependency, package-file entry, and `CHANGELOG.md`.

- [ ] **Step 1: Add the RED package and notice contract test**

In `scripts/projectIdentity.test.mjs`, add a focused test that asserts all of the following:

```js
  it("ships KaTeX and its attribution notice", () => {
    expect(packageManifest.dependencies).toMatchObject({ katex: "^0.18.4" });
    expect(packageManifest.files).toContain("THIRD_PARTY_NOTICES.md");
    const notice = readFileSync(join(repositoryRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notice).toContain("KaTeX 0.18.4");
    expect(notice).toContain("The MIT License (MIT)");
    expect(notice).toContain("Copyright (c) 2013-2020 Khan Academy and other contributors");
  });
```

Run:

```bash
npm run test:serial -- --run scripts/projectIdentity.test.mjs
```

Expected RED result: the new test fails because `katex` is absent from `dependencies`, the notice is absent from `files`, and `THIRD_PARTY_NOTICES.md` does not exist. Do not edit package metadata before seeing that failure.

- [ ] **Step 2: Add the direct dependency and npm-generated lock entries**

Run exactly:

```bash
npm install katex@^0.18.4 --save
```

Keep the resulting `package.json` declaration as:

```json
"katex": "^0.18.4"
```

Inspect `package-lock.json` before proceeding. It must add the root dependency and `node_modules/katex` record for 0.18.4 without upgrading unrelated packages. Do not hand-edit lockfile integrity values.

- [ ] **Step 3: Add mandatory attribution and the minor Changeset**

Add `"THIRD_PARTY_NOTICES.md"` immediately after `"LICENSE"` in `package.json`'s `files` allowlist.

Create `THIRD_PARTY_NOTICES.md` with this heading and the KaTeX 0.18.4 MIT license text copied verbatim from `node_modules/katex/LICENSE` after installation:

```md
# Third-Party Notices

## KaTeX 0.18.4

The MIT License (MIT)

Copyright (c) 2013-2020 Khan Academy and other contributors
```

The remainder of the KaTeX MIT license must exactly retain its permission, condition, warranty, and liability paragraphs from `node_modules/katex/LICENSE`; do not paraphrase it.

Create `.changeset/latex-message-rendering.md` exactly as:

```md
---
"@hyperdreamer/pi-webui": minor
---

Render plain-text LaTeX equations in formatted conversation messages.
```

Do not edit `CHANGELOG.md`.

- [ ] **Step 4: Prove the package contract GREEN**

Run:

```bash
npm run test:serial -- --run scripts/projectIdentity.test.mjs
npm ls katex --depth=0
npm run changelog:status
git diff --check
```

Expected GREEN result: the project-identity file has no failures, npm reports `katex@0.18.4` at the project root, Changesets recognizes one minor release entry, and whitespace validation succeeds.

- [ ] **Step 5: Commit the package preparation**

Review `git diff --name-only` and confirm it contains only the five task paths. Commit:

```bash
git add package.json package-lock.json scripts/projectIdentity.test.mjs THIRD_PARTY_NOTICES.md .changeset/latex-message-rendering.md
git commit -m "chore: add KaTeX rendering dependency"
```

Write one task report with the RED failure reason, `npm ls` version, package-contract GREEN output, and commit SHA.

## Task 2: Implement Bounded Token-Tree LaTeX Rendering

**Implementer tier:** Capable

**Files:**

- Create: `src/client/src/formatting/latexMath.ts`
- Create: `src/client/src/formatting/latexMath.test.ts`
- Modify: `src/client/src/formatting/markdown.ts:1-138`
- Modify: `src/client/src/formatting/markdown.test.ts:1-115`
- Modify: `src/client/src/hostSpeechText.test.ts:1-102`

**Interfaces:**

- Consumes: KaTeX's `KatexOptions` type and `renderToString(tex: string, options?: KatexOptions): string`; Marked's `Marked`, `Renderer`, `Token`, `TokensList`, and generic extension-token APIs; the existing `escapeHtml`, `sanitizeHtml`, and LRU cache behavior in `markdown.ts`.
- Produces from `latexMath.ts`:
  - `export type LatexRenderToString = (tex: string, options: KatexOptions) => string`.
  - Private `MathRenderContext = { mathSourceUnits: number; formulaCount: number; mathOutputUnits: number; outputAdmissionClosed: boolean }`, created anew for each uncached render; per-formula brace/control-sequence/alignment counters are reset for each candidate.
  - `export function escapeHtml(text: string): string`, preserving the existing formatter's `&`, `<`, and `>` escaping.
  - `export function renderLatexMarkdown(source: string, renderMath: LatexRenderToString): string`, which creates one fresh Marked instance, renderer, and `MathRenderContext` per call and returns unsanitized HTML for `markdown.ts` to sanitize.
  - `export function hasPotentialLatexMath(source: string): boolean`, which conservatively returns true for source containing `$`, `\(`, or `\[`.
- Produces from `markdown.ts`: `MarkdownRenderOptions` gains optional `renderMath?: LatexRenderToString`; `toSafeMarkdownHtml()` uses the named KaTeX `renderToString` adapter only when the source contains a potential math opener or a test adapter is supplied, forces `cache: false` when `renderMath` is supplied, delegates those uncached math renders to `renderLatexMarkdown()`, keeps the existing singleton Marked path for cacheable/no-math and short-live/no-math text, and re-exports `hasPotentialLatexMath` for `FormattedText`.
- Preserves: global `marked` for `hostSpeechText.ts`, core Markdown options `{ async: false, breaks: true, gfm: true }`, current HTML sanitization, current LRU cache limits, and exact core token behavior outside math.

- [ ] **Step 1: Write the initial RED parser tests**

Create `latexMath.test.ts` with a recording adapter that returns a visible deterministic fragment and records `(tex, options)` calls. Add tests that import the not-yet-created `renderLatexMarkdown` and prove these first behaviors:

```ts
expect(renderLatexMarkdown("Before $x^2$ after.", record)).toContain('class="math-inline"');
expect(renderLatexMarkdown("\\(\\frac{1}{2}\\)", record)).toContain('class="math-inline"');
expect(renderLatexMarkdown("$$\\frac{1}{2}$$", record)).toContain('class="math-display"');
expect(renderLatexMarkdown("\\[\\n\\int_0^1 x^2\\,dx\\n\\]", record)).toContain('class="math-display"');
expect(record).toHaveBeenCalledWith("x^2", expect.objectContaining({
  output: "htmlAndMathml",
  displayMode: false,
  throwOnError: false,
  trust: false,
  strict: "ignore",
  maxExpand: 1000,
  maxSize: 100,
}));
```

Add a block test with a line-isolated `$$` formula inside a list item and a blockquote. Include one test proving `text $$x$$ text` and a table-cell `\[x\]` produce literal source rather than a math call.

Run:

```bash
npm run test:serial -- --run src/client/src/formatting/latexMath.test.ts
```

Expected RED result: the file cannot import `./latexMath` because the module does not exist.

- [ ] **Step 2: Implement the fresh Marked parser and display tokenizer**

Create `latexMath.ts` with these concrete ownership rules:

1. Define private generic token shapes for inline math, display math, inline literal source, and block literal source. Every token retains `raw`; math tokens also retain `tex` and `displayMode`.
2. Create `new Marked(...)` and a new `Renderer` inside `renderLatexMarkdown()` on every call. Configure the renderer's `html` method to escape raw HTML exactly as the existing formatter did. Do not import or mutate singleton `marked`.
3. Register a block extension named `latex-display` with a `start` hook and tokenizer. It accepts only the approved single-line and multiline grammar: zero through three ASCII-space indentation, `$$` paired only with `$$` or `\[` paired only with `\]`, delimiter-only multiline opening/closing lines, nonblank body, and optional horizontal whitespace. The tokenizer must stop at a fence line or 2,049 discovered body code units, return no token for incomplete input, and never interrupt a paragraph unless it found a complete valid block.
4. Register renderer extensions that call the injected `renderMath` with the exact KaTeX options. Successful inline output is wrapped in `<span class="math-inline">`; successful display output is wrapped in `<div class="math-display">`. Inline literal output is `escapeHtml(raw)`; block literal output is `<p>${escapeHtml(raw)}</p>`. Catch every thrown value from `renderMath`, including non-`ParseError` values, and convert that token to exact literal source without dropping surrounding Markdown.
5. Keep parsing synchronous with `async: false`, `gfm: true`, and `breaks: true`. Run the tests from Step 1 and confirm GREEN before adding inline rewriting.

Run:

```bash
npm run test:serial -- --run src/client/src/formatting/latexMath.test.ts
```

Expected GREEN result: the first parser tests pass, the adapter sees only complete formulas, and the exact KaTeX option object is supplied.

- [ ] **Step 3: Add RED tests for protected scopes, delimiter rules, and literal fallbacks**

Extend `latexMath.test.ts` with focused rows for all of these source contracts before changing production code again:

- `$x^2$`, `\(...\)`, multiple adjacent formulas, Unicode whitespace/punctuation, `\frac`, powers/subscripts, Greek, `\sum`, `\int`, `\rightarrow`, `\text{plain text}`, `aligned`, `matrix`, `cases`, and `array` all reach the adapter with expected display mode.
- Inline code, backtick fences, tilde fences, and cross-boundary opener/closer cases preserve core Markdown and make no math call: `$before \`code $inside$\` after$`, an opener before a Markdown link whose closer is in the label, and an opener before an HTML tag whose closer is inside the HTML token.
- Dollar restart cases: `$5 and $10`, `currency $5, and $x$`, `$x$foo`, `$a$+$b$`, and a long unmatched-currency run. Assert the recording adapter sees only `$x$` in the currency case and that the scanner does not call the adapter for unmatched source.
- Backslash parity with zero, one, two, and three preceding backslashes for `$`, `\(`, `\)`, `\[`, and `\]`.
- Exact visible literal source for unmatched backslash markers and complete non-block `$$...$$` or `\[...\]` pairs.
- A 513-code-unit discovered pair, a 2,049-code-unit delimiter discovery attempt, brace depth 33, 65 control sequences, 65 alignment/row separators, each forbidden macro primitive, ninth formula, and more than 4,096 aggregate body code units. Each must avoid the adapter and preserve source according to the spec.
- A recording adapter that returns 32,001 characters causes that formula and every later formula to be literal source. After eight accepted reservations, a ninth formula is rejected before the adapter call because both the eight-formula cap and the 256,000-character output-reservation cap are exhausted.
- A throwing adapter and an adapter returning active HTML such as `<img src="javascript:alert(1)" onerror="alert(1)">` preserve surrounding text after `toSafeMarkdownHtml()` sanitizes it. Also assert an ordinary no-math cached message still uses the existing singleton Marked path.

Run the file and confirm RED failures are behavior assertions, not test setup failures.

- [ ] **Step 4: Implement raw-token transformation and `MathRenderContext` admission**

Implement a `processAllTokens` hook that walks the core token tree before Marked renders HTML.

- Recurse into block containers, list items, table-cell token arrays, and child emphasis/strong/deletion token arrays. Do not recurse into links, images, HTML, code, or code spans.
- Within one eligible inline token array, operate only on contiguous leaf `text` and `escape` token runs. Preserve raw-to-token offsets so unchanged `escape` tokens retain normal Markdown behavior while a matched span can be replaced by one generic math or literal token.
- Scan each raw run once. Dollar matching keeps at most one pending opener and visits each singleton dollar once. A dollar is eligible after an even raw backslash run; a backslash marker is eligible when its leading backslash ends an odd raw backslash run. Never degrade `$$`, `\[`, or `\]` into inline syntax.
- Convert unescaped unmatched `\(`, `\)`, `\[`, and `\]` to literal tokens. Convert a complete embedded/non-block display pair and a discovered over-budget pair to a single literal token. If no closer occurs within the 2,048-code-unit discovery window, leave dollars as core text and literalize discovered unescaped backslash display markers without scanning farther.
- Implement a render-local `MathRenderContext` with the exact source/formula/structural counters from Global Constraints. Check admission before invoking KaTeX. Reserve 32,000 output characters before a call, fall back on oversized output, and close further admission after the first oversized output fragment.

Run:

```bash
npm run test:serial -- --run src/client/src/formatting/latexMath.test.ts
```

Expected GREEN result: every grammar, protected-scope, fallback, and budget test passes without global parser mutation.

- [ ] **Step 5: Wire the deep module through cache, sanitizer, and host-speech isolation**

Update `markdown.ts` as follows:

```ts
import { renderToString } from "katex";
import {
  escapeHtml,
  hasPotentialLatexMath,
  renderLatexMarkdown,
  type LatexRenderToString,
} from "./latexMath";

export interface MarkdownRenderOptions {
  cache?: boolean;
  renderMath?: LatexRenderToString;
}
```

On a cache miss, choose `options.renderMath ?? renderToString` only when `options.renderMath` exists or `hasPotentialLatexMath(text)` is true; otherwise keep the current singleton `marked.parse` path. Force cache bypass whenever `options.renderMath` exists, call `renderLatexMarkdown(text, renderMath)` for the math path, then pass its HTML through the existing `sanitizeHtml()`. Use the imported `escapeHtml` for the existing raw-HTML renderer. Re-export `hasPotentialLatexMath`. Keep the LRU key as the unmodified original message text.

Update `markdown.test.ts` to use actual KaTeX for representative HTML/MathML rendering and a supplied adapter for deterministic error and budget tests. Keep the existing singleton `marked.parse` LRU spy for a no-math cached message. For math caching, render the same `$x$` source twice with the production adapter, assert identical HTML and one cache-entry increase, and assert the supplied adapter path bypasses the cache. Add the sanitizer check for unsafe adapter output.

In `hostSpeechText.test.ts`, call `toSafeMarkdownHtml("before $x^2$ after", { cache: false })`, then assert `assistantSpeechText(assistant("before $x^2$ after"))` remains `"before $x^2$ after"`. This fails if visual math was registered on the shared singleton and speech drops the generic token.

Run:

```bash
npm run test:serial -- --run src/client/src/formatting/latexMath.test.ts src/client/src/formatting/markdown.test.ts src/client/src/hostSpeechText.test.ts
npm run typecheck
npx eslint src/client/src/formatting/latexMath.ts src/client/src/formatting/latexMath.test.ts src/client/src/formatting/markdown.ts src/client/src/formatting/markdown.test.ts src/client/src/hostSpeechText.test.ts
git diff --check
```

Expected GREEN result: all focused tests pass, typecheck and scoped lint pass, and only Task 2 source/test paths changed after Task 1's committed package files.

- [ ] **Step 6: Commit the bounded renderer**

```bash
git add src/client/src/formatting/latexMath.ts src/client/src/formatting/latexMath.test.ts src/client/src/formatting/markdown.ts src/client/src/formatting/markdown.test.ts src/client/src/hostSpeechText.test.ts
git commit -m "feat(formatting): render bounded LaTeX markdown"
```

Write one task report with each RED reason, all focused GREEN commands, parser-isolation evidence, and commit SHA.

## Task 3: Integrate Shadow Styles And Live Formatted Content

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/FormattedText.ts:1-104`
- Modify: `src/client/src/components/FormattedText.test.ts:1-125`
- Create: `src/client/src/components/ChatView.latex.test.ts`

**Interfaces:**

- Consumes: `hasPotentialLatexMath(source: string): boolean` re-exported by `../formatting/markdown`; `toSafeMarkdownHtml(text, { cache })`; KaTeX's Vite string import `katex/dist/katex.min.css?inline`; and existing `ChatView.renderPart()` behavior.
- Produces: `shouldRenderLivePlainText({ text, live })` returns true for any live large tail or any live text with a potential LaTeX opener; `FormattedText.styles` includes the KaTeX CSS and owned `.math-inline`/`.math-display` rules; `ChatView.latex.test.ts` exercises the existing unchanged `ChatView.renderPart()` routes.
- Preserves: the public `FormattedText` `text`/`live` properties, normal short live Markdown with no potential math, code-block copy enhancement, and `ChatView.ts` production rendering paths. No `PromptEditor` or `ChatView.ts` production source change is expected.

- [ ] **Step 1: Write RED component and live-tail tests**

In `FormattedText.test.ts`, add tests that first fail against the current component:

1. `shouldRenderLivePlainText({ live: true, text: "answer: $x^2$" })` is true below the 24,000-character threshold; the same settled text is false.
2. A live element with `"first $x"`, then `"first $x^2$"`, shows exact source text, has `.formatted.plain`, and contains no `.katex` or `math` element on every live update. Changing `live` to false produces `.katex`, a MathML `math` element, and the source no longer remains the plain rendered content.
3. A normal settled `\[ ... \]` display has `.math-display`; a long accepted display formula has `scrollWidth > clientWidth` on its owned math wrapper when jsdom properties are stubbed, while its parent style contract exposes `max-width: 100%` and horizontal overflow.
4. `FormattedText.styles.toString()` contains `KaTeX_Main`, `.math-inline`, `.math-display`, `overflow-x`, and does not contain a `.math-display` vertical-clipping declaration.
5. Existing large-tail plain rendering and code-copy wrapper tests remain present and pass.

Run:

```bash
npm run test:serial -- --run src/client/src/components/FormattedText.test.ts
```

Expected RED result: short live math still goes through Markdown, no KaTeX stylesheet or owned math-wrapper styles exist, and the new assertions fail for those specific missing behaviors.

- [ ] **Step 2: Add the smallest `FormattedText` integration**

Update imports and rendering logic exactly along these lines:

```ts
import { LitElement, css, html, unsafeCSS } from "lit";
import katexCss from "katex/dist/katex.min.css?inline";
import { hasPotentialLatexMath, toSafeMarkdownHtml } from "../formatting/markdown";

export function shouldRenderLivePlainText({ text, live }: { text: string; live: boolean }): boolean {
  return live && (text.length >= LIVE_PLAIN_TEXT_MIN_CHARS || hasPotentialLatexMath(text));
}
```

Place `unsafeCSS(katexCss)` in `FormattedText.styles` after `formattedTextStyles`. Add owned rules with these invariants:

```css
.math-inline { display: inline-block; max-width: 100%; overflow-x: auto; vertical-align: middle; }
.math-display { display: block; max-width: 100%; overflow-x: auto; margin: 10px 0; }
.math-display > .katex-display { margin: 0; }
```

Do not add `overflow-y: hidden`, `overflow-y: clip`, a fixed height, or a max height to `.math-display`. Run the component file and confirm GREEN before changing Chat tests.

- [ ] **Step 3: Write RED ChatView shared-surface tests**

Use the existing jsdom `ChatView` mounting patterns and define a small file-local `mountChatView()`/`formattedChildren()` helper in `ChatView.latex.test.ts`; do not import a helper from another test file and do not scrape bare `TemplateResult` text for general content assertions.

Add `src/client/src/components/ChatView.latex.test.ts` with a mounted ChatView case containing:

- ordinary user and assistant text parts with `$x^2$`;
- assistant `thinking` with `\(y_1\)`;
- `skillInvocation` content with `$$\\frac{1}{2}$$` on its own line;
- a `toolResult` with `\[\\sum_{i=1}^{n} i\\]` on its own lines;
- a queued server message with `$q$`; and
- a bash text part containing `$never$`.

Await each mounted `formatted-text` element's `updateComplete`. Assert the first five formatted surfaces contain KaTeX in their own shadow roots, while the bash article contains `.shell-output` source text and no `formatted-text` for that part. Add a streaming assistant version with `$x^2$` that asserts the trailing `FormattedText` is live and plain before settlement, then KaTeX-rendered after settlement.

Run:

```bash
npm run test:serial -- --run src/client/src/components/FormattedText.test.ts src/client/src/components/ChatView.latex.test.ts
```

Expected RED result before adding any necessary test harness updates: the math-specific shadow-root assertions and short-live plain assertions fail because Task 3 integration is not yet present.

- [ ] **Step 4: Commit After Integration Verification**

Do not modify `ChatView.ts` unless a test proves its existing `FormattedText` routing is insufficient. Run:

```bash
npm run test:serial -- --run src/client/src/components/FormattedText.test.ts src/client/src/components/ChatView.latex.test.ts
npm run typecheck
npx eslint src/client/src/components/FormattedText.ts src/client/src/components/FormattedText.test.ts src/client/src/components/ChatView.latex.test.ts
git diff --check
```

Expected GREEN result: the component and Chat tests pass, settled user/assistant/shared formatted content is rendered by the same boundary, short live math remains exact source, and no source change outside `FormattedText.ts` is required for Chat routing.

Commit only the listed task files:

```bash
git add src/client/src/components/FormattedText.ts src/client/src/components/FormattedText.test.ts src/client/src/components/ChatView.latex.test.ts
git commit -m "feat(chat): render LaTeX in formatted messages"
```

Write one task report with RED/green evidence, the all-surface assertion results, unchanged `ChatView.ts` confirmation, and commit SHA.

## Task 4: Verify Production Assets, Package Contents, And Browser Behavior

**Implementer tier:** Capable

**Files:**

- Verify: `package.json`, `package-lock.json`, `THIRD_PARTY_NOTICES.md`, `.changeset/latex-message-rendering.md`, `src/client/src/formatting/latexMath.ts`, `src/client/src/formatting/markdown.ts`, `src/client/src/components/FormattedText.ts`, and their focused tests.
- Create then remove: `src/client/latex-rendering-probe.html`
- Create then remove: `/tmp/pi-webui-latex-vite.config.mjs`, `/tmp/pi-webui-latex-cdp.mjs`, `/tmp/pi-webui-latex-dist/`, `/tmp/pi-webui-latex-profile/`, `/tmp/pi-webui-latex-results.json`, and temporary server logs.
- Modify only if a real browser defect is measured: the smallest relevant source file and its existing focused test file, using a new RED-to-GREEN cycle before repeating the identical probe.

**Interfaces:**

- Consumes: the production `katex` dependency, KaTeX inline CSS/font assets, `FormattedText`, the `base: "./"` Vite contract, package `files` allowlist, and the raw-CDP procedure in `probe-narrow-lit-layout-with-chromium-cdp`.
- Produces: recorded command output and raw-CDP measurements proving root and nested deployment font loading, MathML accessibility, nonblank geometry, horizontal containment, no vertical clipping, and bounded cache-miss rendering; no committed probe artifacts.
- Preserves: no temporary fixture/config/driver/profile/log/screenshot in the repository, no unapproved audit exception, and a clean worktree after verification.

- [ ] **Step 1: Run deterministic unit and production package verification**

Run the changed focused tests first, then the complete serial gate:

```bash
npm run test:serial -- --run scripts/projectIdentity.test.mjs src/client/src/formatting/latexMath.test.ts src/client/src/formatting/markdown.test.ts src/client/src/hostSpeechText.test.ts src/client/src/components/FormattedText.test.ts src/client/src/components/ChatView.latex.test.ts
npm run verify
npm run changelog:status
npm run build
npm pack --dry-run --ignore-scripts --json > /tmp/pi-webui-latex-pack.json
set +e
npm audit --omit=dev --json > /tmp/pi-webui-latex-audit.json
audit_status=$?
set -e
node -e 'const report = JSON.parse(require("node:fs").readFileSync("/tmp/pi-webui-latex-audit.json", "utf8")); if ((report.metadata?.vulnerabilities?.total ?? 0) !== 0) process.exit(1);'
test "$audit_status" -eq 0
```

Parse `/tmp/pi-webui-latex-pack.json` and assert the packed file list contains `package/THIRD_PARTY_NOTICES.md`, emitted KaTeX font assets, and the client bundle. The audit command intentionally records JSON before enforcing its exit status. Inspect `/tmp/pi-webui-latex-audit.json`; a nonzero `audit_status` or any production vulnerability blocks completion. A direct or production dependency finding, including a finding attributable to KaTeX, must not be classified under the upstream-only `IGNORED.md` exception or covered by a new exception.

- [ ] **Step 2: Build a disposable production fixture and CDP driver**

Create `src/client/latex-rendering-probe.html` temporarily. It imports the real `./src/components/FormattedText.ts`, defines the required PI color variables, waits for `customElements.whenDefined("formatted-text")`, and mounts four settled elements plus one live element:

```ts
const inline = "Inline $x^2 + y_1$";
const display = ["\\[", "\\int_0^1 x^2\\,dx", "\\]"].join("\n");
const long = `$$${Array.from({ length: 100 }, () => "x").join("+")}$$`;
const tallRows = Array.from({ length: 20 }, (_, i) => `a_${i + 1} &= b_${i + 1}\\\\`);
const tall = ["\\[", "\\begin{aligned}", tallRows.join("\n"), "\\end{aligned}", "\\]"].join("\n");
const live = "Streaming $x^2$";
```

The fixture must wait for all `updateComplete` promises and two animation frames, set the live element to settled once after recording its plain state, then expose JSON from `#result` with actual `window.innerWidth`, document/client scroll widths, each math wrapper's client/scroll dimensions and rectangle, MathML count, live-before/live-after class/markup state, `document.fonts.check("16px KaTeX_Main")`, and page errors captured by `window.onerror`/`unhandledrejection`.

Create `/tmp/pi-webui-latex-vite.config.mjs` using `defineConfig` with root set to the repository `src/client`, `base: "./"`, a temporary `/tmp/pi-webui-latex-dist` output directory, and `rollupOptions.input` set to the temporary fixture. Build it with the installed Vite binary so the probe uses a production bundle and Vite-processed font URLs.

Create `/tmp/pi-webui-latex-cdp.mjs` with Node's built-in `WebSocket`, a free HTTP port, a free DevTools port, and a fresh Chromium `--user-data-dir`. It must use a `type: "page"` target discovered from the new Chromium process, call `Page.enable`, `Runtime.enable`, `Network.enable`, and `Accessibility.enable`, and set `Emulation.setDeviceMetricsOverride` before navigation. Its static server must map both `/` and `/nested/` to the same temporary build directory so `./assets/...` URLs resolve at both prefixes.

- [ ] **Step 3: Execute root and nested Chromium acceptance**

Run the CDP driver against `latex-rendering-probe.html` at exactly `1280x800` and `390x844`, first at the root and then at `/nested/latex-rendering-probe.html`. At every one of the four cells, assert all of these conditions from actual CDP measurements:

- `window.innerWidth` equals the requested width.
- Inline and display formulas have nonzero width and height; settled live math contains `.katex` and MathML, while its initial live state is plain source with no `.katex`.
- `document.scrollWidth <= document.documentElement.clientWidth`; each `.formatted`, `.math-inline`, and `.math-display` remains horizontally contained; the deliberately long formula has internal horizontal overflow rather than widening its ancestor.
- The tall formula is not clipped: its display wrapper has no fixed/max height, its visible rectangle covers its `scrollHeight`, and the final row has a nonzero rectangle inside or below the wrapper rather than being hidden.
- Network response events contain successful 200 responses for required KaTeX font files, and `document.fonts.check("16px KaTeX_Main")` is true.
- `Accessibility.getFullAXTree` contains the generated mathematical content or a MathML-derived accessible node, and the DOM has a nonzero `.katex-mathml math` count.
- No page exception, rejected promise, failed fixture assertion, or unexpected 4xx/5xx font request occurs.

Record screenshots and JSON only under `/tmp`. If any assertion fails, first classify whether it is fixture/CDP setup or shipped behavior. For a shipped behavior defect, add the narrowest deterministic focused regression, observe RED, make the smallest source fix, observe GREEN, rebuild the same temporary production fixture, and repeat the identical failed cell. Do not claim browser acceptance from jsdom alone.

- [ ] **Step 4: Measure the adversarial settled-render budget**

Using the same fresh production bundle and CDP process, render cache-miss messages that stay within the 512-code-unit/8-formula/4,096-total admission limits and include nested fractions, 20 aligned rows, a matrix/cases expression, and repeated formulas. Add a unique ordinary text suffix to each trial so the production HTML cache cannot satisfy it. After one warm-up run, collect at least 20 `performance.now()` render durations for each representative source, calculate p95 and maximum, and save those measurements under `/tmp`.

The result is a release verification artifact, not a flaky unit-test time assertion. If an admitted case exceeds the team interaction budget, tighten the numeric admission limits in the source and add a deterministic budget regression before repeating the probe. Do not silently relax a limit or leave the measurement unreported.

- [ ] **Step 5: Commit Or Report The Measured Verification**

Stop Vite, the static server, and Chromium. Remove every temporary source fixture, Vite config, production output, profile, result, screenshot, and log. Confirm the temporary ports no longer listen and run:

```bash
rm -f src/client/latex-rendering-probe.html /tmp/pi-webui-latex-vite.config.mjs /tmp/pi-webui-latex-cdp.mjs /tmp/pi-webui-latex-results.json /tmp/pi-webui-latex-pack.json /tmp/pi-webui-latex-audit.json
rm -rf /tmp/pi-webui-latex-dist /tmp/pi-webui-latex-profile
git status --short
git diff --check
```

If no browser repair was needed, make no commit and report `STATUS: DONE` with every command and measurement. If a real repair was needed, stage only that repair and its RED/GREEN regression, commit with a Conventional Commit message describing the corrected math behavior, then rerun the relevant focused test, `npm run verify`, build/package/audit checks, and the identical CDP cell before reporting.

## Completion Boundary

After all four tasks receive independent task-review approval, run a fresh Frontier final review across the feature range. The final review must verify the plain-text composer remains unchanged, no server/session-daemon path changed, the shared `marked` singleton stays unmodified, all literal and protected-token fallback contracts hold, KaTeX options and resource limits match this plan exactly, the minor Changeset exists without a manual `CHANGELOG.md` edit, the production audit is acceptable, and the worktree has no temporary browser artifacts. Complete only with `SPEC: PASS`, `QUALITY: APPROVED`, no open load-bearing findings, serial verification evidence, and a clean feature worktree.
