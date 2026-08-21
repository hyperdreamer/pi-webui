# LaTeX Message Rendering

## Problem

PI WEBUI's composer already accepts Markdown-like plain text, but the client Markdown renderer treats LaTeX delimiters as ordinary text. Mathematical content in user prompts and assistant replies therefore appears as source notation instead of rendered equations.

The feature should add ordinary LaTeX input without turning the composer into a rich-text editor. A user should be able to type notation such as `$x^2$`, `$$\frac{1}{2}$$`, or `\[\int_0^1 x^2\,dx\]` directly into the existing composer and see it rendered in the conversation.

## Goals

- Keep the composer a plain-text CodeMirror editor with no preview, toolbar, or new input mode.
- Render LaTeX in user and assistant conversation content through the existing `FormattedText` path.
- Support inline delimiters `$...$` and `\(...\)`.
- Support display delimiters `$$...$$` and `\[...\]` when they occupy a display-math block, including multiline formulas.
- Cover the common commands and environments used in ordinary mathematical explanations: `\frac`, superscripts and subscripts, Greek symbols, `\sum`, `\int`, `\rightarrow`, `\text`, `aligned`, `matrix`, `cases`, and `array`.
- Preserve Markdown code, links, HTML escaping, message caching, code-copy behavior, and non-math large-live-tail responsiveness.
- Defer rendering of potential LaTeX while a response is streaming; render the complete formula when the response settles.
- Render accessible HTML plus MathML where KaTeX supports it.
- Keep the feature client-only. Prompt transport and session protocols remain unchanged.

## Non-Goals

- Live equation preview while composing.
- An equation toolbar, formatting controls, or LaTeX autocomplete.
- Server-side LaTeX conversion or a new prompt/message wire format.
- Full compatibility with every LaTeX package or document command.
- User-defined TeX macros or optional KaTeX extensions such as `mhchem`.
- A target-independent wall-clock guarantee for synchronous browser-side KaTeX rendering.

## Approach

Use KaTeX as a synchronous `marked` token-tree extension at the existing Markdown rendering boundary. A fresh, dedicated `Marked` instance first produces the normal core Markdown token tree. Before Marked renders HTML, its `processAllTokens` hook rewrites eligible raw token runs into generic math or literal-source tokens. KaTeX renders math tokens to HTML and MathML; Marked then renders the remaining core tokens normally.

This is deliberately not an early custom inline tokenizer, a complete-source placeholder pass, or a post-render DOM scanner. An early inline tokenizer runs before Marked's built-in code-span and link tokenizers, so it could consume a delimiter that lies across a protected Markdown construct. A token-tree transform receives the established core boundaries and retains each token's raw source without parsing generated HTML.

The rendering flow is:

1. `toSafeMarkdownHtml()` checks the existing HTML cache.
2. On a cache miss, it creates a render-local math context and a fresh dedicated `Marked` instance plus renderer configured with the display-block extension, token-tree transform, literal-source renderer, and injected math renderer.
3. The dedicated instance lexes ordinary Markdown. Its display extension claims only a complete, line-isolated display block. When a core construct begins at the current source position, such as a fenced-code marker, the display extension returns no token and the core lexer consumes that construct normally.
4. The token-tree transform creates inline math only inside an eligible raw inline scope. It never crosses a protected core token boundary.
5. The dedicated instance renders Marked, math, and literal-source tokens synchronously; `sanitizeHtml()` remains the final HTML defense-in-depth step.
6. The production call may cache the sanitized result under the original message text. A live prefix and a test-injected adapter never populate or read that cache.

This preserves the current ownership model:

- `PromptEditor` stores and sends text as it is typed.
- `ChatView` continues to send displayable text through `FormattedText`.
- `FormattedText` calls `toSafeMarkdownHtml()` only for settled content and for live content that has no potential math.
- A live message containing a potential `$`, `\(`, or `\[` opener uses the existing line-preserving plain-text path until it settles, so KaTeX is never invoked for a growing formula.
- `toSafeMarkdownHtml()` remains responsible for Markdown parsing, sanitization, and production-result caching.

`FormattedText` is a shared presentation boundary, so all of its current consumers intentionally inherit math rendering: ordinary user and assistant text, visible assistant thinking, skill-invocation content, tool-result text, and queued-message previews. Shell-output parts remain preformatted because they do not use `FormattedText`. This is one shared rendering policy, not a role-specific opt-in. Existing host speech is intentionally outside this boundary: visual math rendering does not change `hostSpeechText.ts`, which continues to project the original Markdown source with unextended core Marked behavior. Its existing speech result, including any raw math source that current projection preserves, must retain surrounding assistant prose and must neither receive generic math tokens nor drop the message because visual math rendering was enabled.

The math renderer is isolated behind a small adapter that accepts KaTeX's `renderToString` function. A render-local factory receives that adapter and owns the Marked instance, renderer, and math budget for one uncached call. Production supplies KaTeX. Formatter tests may supply a throwing or recording adapter through the factory; supplying that adapter forces cache bypass, so tests can prove token-level fallback and admission behavior without reading or writing production HTML cache entries. Neither the production factory nor tests call `marked.use()` or mutate the shared `marked` singleton.

A post-render DOM scanner and a MathJax runtime remain rejected. A DOM scanner would need to reimplement code protection and nested Markdown behavior after Marked has already parsed the message. MathJax would add asynchronous, heavier runtime behavior that complicates streaming updates, cache reuse, and layout stability.

## Delimiter Grammar

The dedicated Marked instance has one block display extension and one token-tree transform. Their precedence and fallback behavior are deterministic.

### Token Scope and Protection

The inline transform operates within one already-lexed inline token array at a time. It scans only contiguous runs of leaf `text` and `escape` tokens. It may recurse into a child token array so a formula wholly inside an existing emphasis, strong, deletion, or table-cell scope can render, but it never consumes, merges, or crosses those container tokens. Markdown emphasis syntax inside a formula is therefore a protected boundary; ordinary TeX source such as aligned row separators and `\text{plain text}` remains available through the raw `text`/`escape` run.

It never crosses a `codespan`, fenced or indented `code` block, `link`, `image`, `html`, autolink/URL, line-break, emphasis, strong, deletion, table-cell boundary, block boundary, or other core token boundary. A formula may be recognized wholly inside its own nested emphasis, strong, deletion, table-cell, list, or blockquote scope, but it never starts in one Markdown scope and closes in another. Link labels and image alt text are left to normal Marked behavior rather than receiving math rendering.

For example, ``$before `code $inside$` after$`` leaves the outside dollars as ordinary source and the code span untouched. The same rule applies when an opener is outside a link or HTML token and a closer appears inside it. A formula whose delimiters both occur inside inline code or either kind of fenced code remains code.

The transform uses raw Marked token fields, not rendered text or global source state. Matching and length limits use raw UTF-16 source before Markdown escape decoding; opening and closing delimiters count toward discovery ranges, while formula-body and aggregate math-source budgets count body source only. Marked's standard line-ending normalization is the source representation for these ranges. The transform does not preprocess the complete source into placeholders, and it never scans HTML after rendering.

### Block Display Tokens

The display-block extension is evaluated before Marked's paragraph tokenizer, but its `startBlock` hook advertises only a complete valid display block. It must not interrupt a paragraph for an incomplete or invalid delimiter-looking line. A valid block is emitted as a `math-display` token with `displayMode: true`.

For this grammar, `HWS` is zero or more spaces or tabs, `INDENT` is zero through three ASCII spaces, and a body is nonblank when it contains at least one non-whitespace code point:

| Form | Accepted source |
| --- | --- |
| Single line | `INDENT OPEN BODY CLOSE HWS (newline or EOF)`, where `BODY` contains no newline and at least one non-whitespace code point. Leading and trailing horizontal whitespace within `BODY` is permitted. |
| Multiline | `INDENT OPEN HWS newline BODY newline INDENT CLOSE HWS (newline or EOF)`, where the opening and closing delimiter lines contain no other source and `BODY` is nonblank. Blank body lines are permitted. |

`OPEN` is `$$` with matching `CLOSE` `$$`, or `\[` with matching `CLOSE` `\]`. The close marker is the first matching marker that satisfies the applicable complete-line rule; a marker followed by non-horizontal text is formula body, not a close. Opening and closing indentation are independently limited to `INDENT`; they need not contain the same number of spaces. Tabs are not indentation for this feature.

The block scanner is single-pass and stops at the first line that starts a backtick or tilde fenced-code block before a valid closing delimiter. It also stops when delimiter discovery reaches 2,049 UTF-16 code units without a close; it does not scan an unbounded malformed candidate merely to discover a fallback. In either case it emits no display token and leaves the original source to normal Markdown/literal-marker fallback. A display opener inside a fenced code block is never reached because Marked consumes the fence before its contents. A line-isolated formula nested by normal Markdown inside a list item or blockquote remains a display block after Marked has stripped that container's prefix.

Display delimiters embedded in prose or table cells are not display math. A complete embedded `$$...$$`, `\[...\]`, or non-block-isolated display pair found within bounded discovery is emitted as exact literal source. Use `$...$` or `\(...\)` for inline formulas in those contexts.

### Inline Tokens

- `$...$` and `\(...\)` are inline-only and never cross an unescaped newline or a protected Markdown token boundary.
- A formula body must contain at least one non-whitespace code point.
- Delimiter discovery scans at most 2,048 body code units before it stops looking for a matching closer; a completed pair whose body is over the 512-code-unit render-admission cap falls back to exact source.
- An opening delimiter must be at the start of its inline scope or be preceded by Unicode whitespace, punctuation, or symbol. It must be followed by a non-whitespace body character.
- A closing delimiter must be at the end of its inline scope or be followed by Unicode whitespace, punctuation, or symbol. It must be preceded by a non-whitespace body character.
- Display syntax is claimed before inline transformation. `$$` never degrades into a single-dollar token, and `\[` or `\]` never degrades into `\(` or `\)` tokens.

Single-dollar matching is restartable but linear. The scanner visits each singleton dollar at most once, maintains at most one pending opener, and stops discovery at the 2,048-code-unit limit or a protected Markdown boundary. At a candidate dollar:

1. A valid closing boundary closes the pending opener.
2. An invalid closing boundary invalidates the earlier opener. That same dollar becomes the next pending opener only when it also satisfies the opening-boundary rule.
3. If no later valid pair appears in the same eligible inline scope, no math token is emitted for that region.

This makes `currency $5, and $x$` leave `currency $5, and ` as ordinary text and render only `$x$`, while `$5 and $10` remains ordinary text. Adjacent formulas such as `$a$+$b$` remain valid because `+` is a punctuation boundary. An unescaped singleton dollar inside an inline formula is not supported as literal TeX content; authors write `\$` inside `\text{...}` when they need a literal dollar. The same boundary rules apply to `\(...\)`, without the currency-specific restart case.

### Escapes, Literal Source, and Fallback

For `$`, the delimiter is eligible when the consecutive raw backslash run immediately before the dollar has even length. For a backslash delimiter marker such as `\(`, the marker's leading backslash is eligible only when the raw run ending at that backslash has odd length. Equivalently, zero, two, or four preceding backslashes leave a `\(` marker eligible, while one or three preceding backslashes escape it. The same rule applies to `\)`, `\[`, and `\]`. Tests cover zero through three preceding backslashes for each delimiter family.

Unescaped unmatched `\(`, `\)`, `\[`, and `\]` markers are converted to literal-source tokens so their backslashes remain visible. A complete display pair that is not block-isolated and is found within bounded discovery is likewise one literal-source token. A complete delimiter pair discovered within the bounded search and then rejected by the 512-code-unit render-admission cap, another resource rule, an exhausted message budget, a renderer exception, or a post-render output limit is one literal-source token containing its exact original delimiter and body. When delimiter discovery reaches its 2,048-code-unit limit before a matching close, the scanner does not keep searching: dollar source remains ordinary text and every encountered unescaped backslash display marker is literalized independently. The literal-source renderer HTML-escapes its exact source and does not feed it back through Markdown.

Escaped delimiters such as `\$` remain ordinary Markdown escape behavior and are never math. Unmatched dollar delimiters remain ordinary Markdown text. When an otherwise possible pair would cross a protected core token boundary, the transform leaves the existing core tokens untouched; it does not consume or merge the boundary. These fallback rules ensure malformed, unsupported, or intentionally code-like input stays readable without losing surrounding content.

The extension does not infer math from bare LaTeX commands without delimiters.

## Rendering and Safety

KaTeX will be added as a production client dependency in the 0.18.x line. Rendering options are explicit:

- `output: "htmlAndMathml"`
- `throwOnError: false`
- `trust: false`
- `strict: "ignore"`
- `maxExpand: 1000`
- `maxSize: 100`

`throwOnError: false` converts ordinary KaTeX parse errors into readable error markup. The math renderer also catches every thrown value from the injected `renderToString` function, including non-`ParseError` failures. On such a failure, it returns the original token source through the literal-source renderer, so one formula cannot discard the surrounding message.

Each uncached render owns a `MathRenderContext`; no math budget or adapter state is module-global or shared with another message. Before KaTeX is invoked, a single forward source scan applies all of these admission limits:

- Maximum delimiter-discovery body: 2,048 UTF-16 code units; a complete pair found within this bound can receive exact literal fallback even when its render body exceeds the admission limit.
- Maximum renderable formula body: 512 UTF-16 code units.
- Maximum math source across one message: 4,096 UTF-16 code units.
- Maximum renderable formulas across one message: 8.
- Maximum brace nesting: 32.
- Maximum TeX control-sequence starts: 64 per formula.
- Maximum unescaped alignment separators and TeX row separators combined: 64 per formula.
- Macro-definition primitives such as `\def`, `\gdef`, `\edef`, `\xdef`, `\let`, `\newcommand`, and `\renewcommand` are not admitted.

The source scanner performs one bounded forward pass per eligible raw run and no delimiter matcher restarts from an earlier source position or rebuilds a scanned prefix. A structural or render-admission breach marks the pending candidate inadmissible without calling KaTeX, but the scanner may continue only to its matching closer or the 2,048-code-unit discovery bound so a discovered complete pair can become one exact literal-source token. Its aggregate counters are checked before each render, so the first candidate that would exceed a message-level source or formula limit and every later candidate that depends on that exhausted limit remain source. The implementation must use source ranges or equivalent linear accumulation while applying the restart rule.

Rendered output has a separate, deterministic containment policy. Before invoking KaTeX, each admitted formula reserves 32,000 HTML characters from a 256,000-character per-message math-output budget; a formula is rejected without a call when no reservation remains. After a call, if the fragment exceeds its 32,000-character reservation, that formula falls back to literal source and closes further KaTeX admission for the message. If the accumulated accepted fragments would exceed 256,000 characters, the first overflowing formula and every later formula fall back to literal source. This output rule bounds rendered and cached math HTML; it does not pretend to cancel work that KaTeX already performed for the first oversized fragment.

The input, structural, formula-count, and expansion limits bound what reaches synchronous KaTeX. JavaScript cannot impose a reliable per-formula wall-clock deadline on this main-thread call, so the feature does not claim one. An adversarial browser benchmark is a required release verification step for the largest admitted formulas; measured results must be recorded and the numeric limits tightened if the declared interaction budget is not met.

KaTeX's `trust: false` rejects commands such as `\href`, `\includegraphics`, `\htmlClass`, `\htmlStyle`, and `\htmlData` that could introduce active or unsafe browser behavior. The existing `sanitizeHtml()` call remains after Marked and KaTeX output as defense in depth. It continues to remove the known unsafe elements and event/URL attributes defined by the current renderer; it is not treated as a general HTML/MathML allowlist.

The supported command/environment list is an acceptance baseline, not a promise of complete LaTeX compatibility. Unsupported syntax remains readable through KaTeX's error rendering or exact source fallback.

## Shadow-DOM Styles, Assets, and Attribution

KaTeX's normal document-level stylesheet would not style the HTML inside `FormattedText`'s Lit shadow root. The component will import the Vite-processed stylesheet as a string using `katex/dist/katex.min.css?inline` and include it in `FormattedText.styles` through Lit's `unsafeCSS` boundary.

The CSS import must retain Vite's font URL processing. The production build must emit the KaTeX font assets referenced by the inlined stylesheet and resolve them under the configured relative base in development, production, and a nested deployment path. The implementation adds a root `THIRD_PARTY_NOTICES.md` containing the KaTeX version, attribution, and full MIT license text, then includes that file in the npm package `files` allowlist. This is mandatory even if a generated bundle happens to retain a license comment.

Math output is wrapped in owned classes so layout behavior is independent of KaTeX's document-level defaults:

- `.math-inline` is an inline-block with `max-width: 100%`, vertical alignment, and horizontal overflow for unusually long inline formulas.
- `.math-display` is a block-level container with `max-width: 100%` and horizontal overflow. It owns display spacing, cannot widen the message or document, has no fixed or maximum height, and must not use vertical clipping. Tall `aligned`, `matrix`, `cases`, and `array` output remains fully visible.

The component test asserts that the KaTeX stylesheet is present in the shadow-root styles. Production browser probes assert actual font loading, nonblank rendering, MathML exposure, horizontal containment, and absence of vertical clipping.

## Performance and Caching

The existing rendering performance policy remains authoritative, with one math-specific deferral:

- Settled messages render through the dedicated Marked/KaTeX path. Eligible production results are cached by original message text; the existing cache may skip oversized entries.
- Short live content with no potential math renders through the existing Markdown path with `cache: false`.
- Live content containing a potential `$`, `\(`, or `\[` opener uses the line-preserving plain-text path, regardless of length. KaTeX and the dedicated math parser are not invoked while that content grows, and the complete source remains readable.
- A live message at or above `LIVE_PLAIN_TEXT_MIN_CHARS` remains line-preserving plain text as it does today, including non-math content.
- When `live` becomes false, the complete message is parsed and eligible equations render. A delimiter split across live updates is therefore handled from the complete settled source rather than partial prefixes.
- Live prefixes, test-injected renderer calls, literal fallbacks, and oversized cached results do not create cross-message mutable math state. Live prefixes are never added to the Markdown HTML cache.

The potential-math check is intentionally conservative: a delimiter-looking sequence in a code-like live response may defer Markdown formatting until settlement. This favors responsiveness and source fidelity during streaming; settled rendering still lets the core Marked lexer establish protected boundaries normally.

## Testing

### Formatter and Parser-Isolation Tests

Extend `src/client/src/formatting/markdown.test.ts` and add focused parser-factory coverage to verify:

- Inline `$...$` and `\(...\)` render as inline KaTeX.
- Line-isolated block `$$` and `\[...\]` render as display KaTeX, including blank body lines.
- Single-line display `$$...$$` and `\[...\]` render only when the full content line is the formula, including normal list-item and blockquote nesting.
- Display delimiters embedded in prose or table cells render as exact literal source, while `$...$` and `\(...\)` render inline in those contexts.
- Multiline formulas and the supported command/environment baseline render: `\frac`, powers, subscripts, Greek symbols, `\sum`, `\int`, `\rightarrow`, `\text`, `aligned`, `matrix`, `cases`, and `array`.
- Multiple formulas and Markdown text around formulas render together.
- Inline code and fenced code, using both backticks and tildes, preserve every delimiter. Cross-boundary cases where an opener is outside and a closer is inside a code span, link, image, HTML token, or fence leave core Markdown semantics intact.
- The single-dollar restart rule handles `$5 and $10`, `currency $5, and $x$`, `$x$foo`, adjacent formulas, Unicode punctuation/whitespace, and long unmatched-currency input without repeated rescans.
- The exact escape table covers zero through three preceding backslashes for dollars and backslash delimiters.
- Unmatched `\(`, `\)`, `\[`, and `\]`, plus complete non-block display pairs, preserve exact literal source. Unmatched dollars remain ordinary text.
- Exact boundaries for delimiter discovery, renderable source size, formula count, brace depth, control sequences, alignment separators, macro definitions, and message-level source budget reject before the injected renderer is called.
- The first post-render output-budget overflow and every later candidate fall back to exact source; an injected renderer verifies the deterministic call count.
- Invalid or unsupported commands do not throw. An injected non-`ParseError` falls back to escaped original source without losing surrounding Markdown.
- KaTeX safety options and the existing sanitizer prevent active attributes and unsafe commands from becoming executable HTML. Assertions inspect active DOM attributes rather than rejecting every occurrence of a string such as `javascript:` because MathML annotations may retain original TeX source.
- Production cache behavior remains unchanged, while sequential injected adapters do not share a parser, budget, or cached HTML result.

Extend `src/client/src/hostSpeechText.test.ts` to prove a visual math render does not register generic tokens on the shared `marked` singleton and that host speech retains surrounding assistant prose for an equation-containing response.

### Component and Chat Tests

Extend `src/client/src/components/FormattedText.test.ts` to verify:

- Rendered math markup and MathML appear in the component's shadow-root message content.
- The KaTeX stylesheet is included in the shadow-root styles.
- Live math, including a delimiter pair split across updates, remains readable plain text with no KaTeX markup or math-renderer calls and renders after `live` becomes false.
- A math-heavy live tail updated through multiple prefixes never calls the math renderer before settlement; its settled render honors all source and formula budgets.
- Existing large-live-tail behavior and code-block wrapper behavior continue to work around messages containing math.

Add focused `ChatView` coverage showing that ordinary text, visible thinking, skill-invocation content, tool-result text, and queued-message previews consistently inherit the shared `FormattedText` policy, while shell output remains literal preformatted text.

### Build, Package, Browser, and Benchmark Verification

Run focused tests first, then typecheck and lint changed files. Final verification includes the repository's serial `npm run verify`, which is the CI-equivalent test profile, plus the following checks that it does not cover:

1. Run `npm run changelog:status`, `npm run build`, and inspect the generated client bundle for KaTeX font assets and resolved stylesheet URLs.
2. Run `npm pack --dry-run --ignore-scripts --json` and confirm the production package contains the required client assets and `THIRD_PARTY_NOTICES.md`. Run `npm audit --omit=dev --json`; the upstream-only exception in `IGNORED.md` does not cover a new direct production dependency or any production finding.
3. Following the project procedure in `probe-narrow-lit-layout-with-chromium-cdp`, create a disposable fixture under `src/client` and a raw-CDP driver under `/tmp`. Start the client on a free strict port, launch a fresh headless Chromium profile, and set exact CDP viewports of `1280x800` and `390x844` before navigation. Remove every fixture, driver, profile, screenshot, log, and server after the probe.
4. At each viewport, assert the actual `window.innerWidth`, nonblank inline and display formula geometry, `document.scrollWidth <= document.clientWidth`, message scroll-width containment, and `.math-inline`/`.math-display` horizontal overflow behavior for deliberately long formulas. Use `Accessibility.getFullAXTree` or an equivalent explicit CDP accessibility assertion to confirm MathML exposure. Record page exceptions and fail on any exception. Use a tall `aligned`, `matrix`, `cases`, or `array` fixture to prove display content is not vertically clipped.
5. Use CDP network events and `document.fonts` to assert every selected KaTeX font request resolves successfully and the expected face is loaded. Repeat all font, geometry, overflow, accessibility, and exception assertions with `dist/client` mounted below a nested trailing-slash path such as `/nested/`, not merely an asset URL string check.
6. In the same fresh browser profile, run an adversarial settled-render benchmark on cache misses using the largest admitted source, nested fractions, aligned rows, matrix cells, and repeated formulas. Record warm-up, p95, and maximum render durations. The measurement is a release artifact rather than a flaky unit-test timing threshold; tighten the stated admission limits before merge if it violates the declared interaction budget.

## Release

This is a backward-compatible user-facing feature and receives a minor Changeset for `@hyperdreamer/pi-webui`. The Changeset describes plain-text LaTeX input and rendered equations in conversation messages. `CHANGELOG.md` is not edited during development; Changesets generate release notes during release preparation.

The implementation updates the production dependency declaration, `package-lock.json`, package `files` allowlist, and `THIRD_PARTY_NOTICES.md`. Release verification includes `npm run changelog:status`, `npm pack --dry-run --ignore-scripts --json`, `npm audit --omit=dev --json`, and preservation of the KaTeX MIT notice.

No migration, configuration change, server restart requirement, session-daemon change, or persisted-data change is expected.

## Consequences

The client bundle gains KaTeX and its font assets. Message rendering becomes more capable while retaining the existing synchronous Markdown/cache boundary. A render-local parser factory, raw token-tree transform, resource context, adapter seam, literal-source fallback, and shadow-root stylesheet integration add maintenance surface, but they contain parser state, preserve protected Markdown constructs, and keep delimiter parsing and resource controls testable.

Live messages containing potential math intentionally show source text until completion. KaTeX's supported subset, rather than all LaTeX packages, defines the feature compatibility boundary. Long formulas may scroll within their own math container, while the surrounding message and document remain horizontally contained. Inputs over the declared render budget remain readable source rather than consuming unbounded synchronous work.
