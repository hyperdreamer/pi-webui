# LaTeX Message Rendering

## Problem

PI WEBUI's composer already accepts Markdown-like plain text, but the client Markdown renderer treats LaTeX delimiters as ordinary text. Mathematical content in user prompts and assistant replies therefore appears as source notation instead of rendered equations.

The feature should add ordinary LaTeX input without turning the composer into a rich-text editor. A user should be able to type notation such as `$x^2$`, `$$\frac{1}{2}$$`, or `\[\int_0^1 x^2\,dx\]` directly into the existing composer and see it rendered in the conversation.

## Goals

- Keep the composer a plain-text CodeMirror editor with no preview, toolbar, or new input mode.
- Render LaTeX in both user and assistant message content through the existing `FormattedText` path.
- Support inline delimiters `$...$` and `\(...\)`.
- Support display delimiters `$$...$$` and `\[...\]` when they occupy a display-math block, including multiline formulas.
- Cover the common commands and environments used in ordinary mathematical explanations:
  `\frac`, superscripts and subscripts, Greek symbols, `\sum`, `\int`, `\rightarrow`, `\text`, `aligned`, `matrix`, `cases`, and `array`.
- Preserve existing Markdown behavior, HTML sanitization, message caching, code-copy behavior, and non-math large-live-tail responsiveness.
- Defer rendering of potential LaTeX while a response is streaming; render the complete formula when the response settles.
- Render accessible HTML plus MathML where KaTeX supports it.
- Keep the feature client-only. Prompt transport and session protocols remain unchanged.

## Non-Goals

- Live equation preview while composing.
- An equation toolbar, formatting controls, or LaTeX autocomplete.
- Server-side LaTeX conversion or a new prompt/message wire format.
- Full compatibility with every LaTeX package or document command.
- Optional KaTeX extensions such as `mhchem` unless a later feature specifically requires them.

## Approach

Use KaTeX as a synchronous `marked` extension at the existing Markdown rendering boundary. The extension will produce dedicated math tokens only when a complete delimiter pair begins at the current Marked tokenizer cursor. KaTeX will then render that token to HTML and MathML.

This preserves the current ownership model:

- `PromptEditor` stores and sends text as it is typed.
- `ChatView` continues to use `FormattedText` for message parts.
- `FormattedText` continues to call `toSafeMarkdownHtml()` for settled content and for live content that has no potential math.
- `toSafeMarkdownHtml()` remains responsible for Markdown parsing, sanitization, and caching.
- A live message containing a potential math opener uses the existing line-preserving plain-text path until it settles, so KaTeX is never invoked for a growing formula.

A post-render DOM scanner and a MathJax runtime were considered and rejected. A DOM scanner would need to reimplement code protection and nested Markdown handling after Marked has already parsed the message. MathJax would add asynchronous, heavier runtime behavior that complicates streaming updates, cache reuse, and layout stability.

The math renderer will be isolated behind a small adapter that accepts the KaTeX `renderToString` function. Production uses KaTeX; formatter tests can inject a throwing function to prove token-level fallback without replacing the whole Markdown parser.

## Delimiter Grammar

The local Marked extension will define deterministic precedence and fallback behavior.

### Block display tokens

A block tokenizer handles line-isolated display formulas before Marked's paragraph tokenizer:

- A multiline form has an opening line containing only optional indentation of up to three spaces, then `$$` or `\[`, followed by optional horizontal whitespace. Its closing line contains the matching delimiter (`$$` or `\]`) with the same indentation allowance and optional horizontal whitespace.
- A single-line form contains optional indentation of up to three spaces, an opening delimiter, a non-whitespace formula body, the matching closing delimiter, and optional horizontal whitespace. It is still a display block because the entire content line is the formula.
- A multiline body between the delimiter-only lines must contain at least one non-whitespace character and may contain newlines and blank lines.
- The opening and closing delimiter must match; `$$` cannot close `\[` and vice versa.
- The block token uses `displayMode: true` and renders through the block wrapper described below.

Because the block extension only runs when the current block begins with a delimiter line, a Markdown fenced code token beginning with backticks or tildes is consumed by Marked before its contents can be considered as math.

Display delimiters embedded in prose or table cells remain ordinary source text. Use `$...$` or `\(...\)` for inline formulas in those contexts. A line-isolated formula nested by normal Markdown inside a list item or blockquote is still a display block after Marked has stripped the list or quote prefix.

### Inline tokens

- `$...$` and `\(...\)` are inline-only and never cross an unescaped newline.
- A formula body must contain at least one non-whitespace character.
- An opening delimiter must be at the start of the current source or be preceded by Unicode whitespace, punctuation, or symbol. It must be followed by a non-whitespace body character.
- A closing delimiter must be at the end of the current source or be followed by Unicode whitespace, punctuation, or symbol. It must be preceded by a non-whitespace body character.
- A valid display block is claimed before inline tokenization begins. At inline cursor positions, `$$` never degrades into a single-dollar token, and `\[`/`\]` never degrade into `\(`/`\)` tokens.

For a single-dollar candidate, matching is deliberately restartable. The scanner examines each unescaped singleton `$` between an opener and the end of the line:

1. If the candidate satisfies the closing-boundary rule, it closes the formula.
2. If it does not satisfy that rule, the earlier opener is invalidated and scanning resumes at that candidate as a possible new opener.
3. If no later valid pair exists, no math token is emitted for the region and normal Markdown text handling applies.

This makes `currency $5, and $x$` leave `currency $5, and ` as ordinary text and render only `$x$`, while `$5 and $10` remains ordinary text. Adjacent formulas such as `$a$+$b$` remain valid because `+` is a punctuation boundary. An unescaped singleton dollar inside an inline formula is therefore not supported as literal TeX content; authors write `\$` inside `\text{...}` when they need a literal dollar. The same boundary rules apply to `\(...\)`, without the currency-specific ambiguity.

A delimiter is unescaped when the consecutive backslash run immediately before its delimiter marker has even length. Odd-length runs escape the marker; even-length runs leave it eligible. This parity rule is tested with zero, one, two, and three preceding backslashes. A backslash that is part of the `\(`, `\)`, `\[`, or `\]` marker is subject to the same rule. The extension uses parser-local source context, never module-global mutable state, to derive the preceding raw code point and immediate backslash run as Marked advances through ordinary and nested inline token streams.

No renderable math token is emitted for an unmatched delimiter. Normal Marked parsing then applies, including its existing backslash-escape behavior. Consequently unmatched `\(`, `\)`, `\[`, and `\]` markers follow the current Markdown result rather than introducing a new literal-backslash rendering exception. A complete pair rejected only by the resource budget instead emits a literal-source token whose renderer escapes the exact original delimiter and body. Escaped delimiters such as `\$` are never rendered as math.

The extension never preprocesses the complete source into placeholders. Matching occurs at Marked's current cursor, so inline code and fenced code remain protected by the normal tokenizer order. Both backtick and tilde fences are covered by tests.

The extension will not infer math from bare LaTeX commands without delimiters.

## Rendering and Safety

KaTeX will be added as a production client dependency in the 0.18.x line. Rendering options are explicit:

- `output: "htmlAndMathml"`
- `throwOnError: false`
- `trust: false`
- `strict: "ignore"`
- `maxExpand: 1000`
- `maxSize: 100`

`throwOnError: false` converts ordinary KaTeX parse errors into readable error markup. The math renderer also catches every thrown value from the injected `renderToString` function, including non-`ParseError` failures. On such a failure, it returns the original token source through the existing HTML escaping helper, so one formula cannot discard the surrounding message.

The per-render math budget is checked before invoking KaTeX:

- Maximum formula body: 2,048 source code units.
- Maximum math source across one message: 16,384 source code units.
- Maximum formulas across one message: 32.
- Maximum rendered HTML for one formula: 256,000 characters; a fragment exceeding this limit falls back to escaped source after rendering.

A formula that exceeds a pre-render budget remains ordinary source text. The budget is local to one `toSafeMarkdownHtml()` call and is not shared across messages or cache entries. The source, expansion, and size limits bound the work admitted to synchronous KaTeX; the post-render limit prevents an admitted formula from inflating the cached HTML. These limits do not change the existing general Markdown message limits.

KaTeX's `trust: false` is the security control that rejects commands such as `\href`, `\includegraphics`, `\htmlClass`, `\htmlStyle`, and `\htmlData` that could introduce active or unsafe browser behavior. The existing `sanitizeHtml()` call remains after Marked and KaTeX output as defense in depth. It continues to remove the known unsafe elements and event/URL attributes defined by the current renderer; it is not treated as a general HTML/MathML allowlist.

The supported command/environment list is an acceptance baseline, not a promise of complete LaTeX compatibility. Unsupported syntax remains readable through KaTeX's error rendering or ordinary source fallback.

## Shadow-DOM Styles and Assets

KaTeX's normal document-level stylesheet would not style the HTML inside `FormattedText`'s Lit shadow root. The component will import the Vite-processed stylesheet as a string using `katex/dist/katex.min.css?inline` and include it in `FormattedText.styles` through Lit's `unsafeCSS` boundary.

The CSS import must retain Vite's font URL processing. The production build therefore needs to emit the KaTeX font assets referenced by the inlined stylesheet and point those URLs at emitted files under the configured relative base. The build/package check must confirm that the CSS references resolve in development, production, and a nested deployment path. It must also verify that the KaTeX MIT notice is preserved in the distributed assets; if Vite's generated output does not retain it, the implementation adds a published third-party notice file and includes it in the npm package `files` allowlist.

Math output is wrapped in owned classes so layout behavior is independent of KaTeX's document-level defaults:

- `.math-inline` is an inline-block with `max-width: 100%`, vertical alignment, and horizontal overflow for unusually long inline formulas.
- `.math-display` is a block-level container with `max-width: 100%`, horizontal overflow, and hidden vertical overflow. It owns the display formula's spacing and does not allow the formula to widen the message or document.

The component test will assert that the KaTeX stylesheet is present in the shadow-root styles. A production Chromium probe will verify actual font loading, nonblank rendering, MathML exposure, and document/message scroll widths at wide and narrow viewports.

## Performance and Caching

The existing rendering performance policy remains authoritative, with one math-specific deferral:

- Settled messages render through Marked and KaTeX. Eligible settled messages are cached by their original message text; the existing cache may skip oversized entries.
- Short live content with no potential math renders through the existing Markdown path with `cache: false`.
- Live content containing a potential `$`, `\(`, or `\[` math opener uses the line-preserving plain-text path, regardless of length. KaTeX is not invoked while that content grows, and the complete source remains readable.
- A live message at or above `LIVE_PLAIN_TEXT_MIN_CHARS` remains line-preserving plain text as it does today, including non-math content.
- When `live` becomes false, the complete message is parsed and its equations render. A delimiter split across live updates is therefore handled from the complete settled source rather than from partial prefixes.
- Live prefixes are never added to the Markdown HTML cache.

The potential-math check is intentionally conservative: a delimiter-looking sequence in a code-like live response may defer Markdown formatting until settlement. This favors responsiveness and source fidelity during streaming; settled rendering still lets Marked protect code spans and fences normally.

## Testing

### Formatter tests

Extend `src/client/src/formatting/markdown.test.ts` to verify:

- Inline `$...$` and `\(...\)` render as inline KaTeX.
- Line-isolated block `$$` and `\[...\]` render as display KaTeX, including blank lines in the body.
- Single-line display `$$...$$` and `\[...\]` render when the full content line is the formula, including within normal list-item and blockquote nesting.
- Display delimiters embedded in prose or table cells remain source text, while `$...$` and `\(...\)` render inline in those contexts.
- Multiline formulas and the supported command/environment baseline render: `\frac`, powers, subscripts, Greek symbols, `\sum`, `\int`, `\rightarrow`, `\text`, `aligned`, `matrix`, `cases`, and `array`.
- Multiple formulas and Markdown text around formulas render together.
- Inline code and fenced code, using both backticks and tildes, preserve every supported delimiter as code.
- The single-dollar restart rule handles `$5 and $10`, `currency $5, and $x$`, `$x$foo`, adjacent formulas, Unicode punctuation/whitespace, and nested/unescaped dollar candidates.
- Delimiter parity cases with zero, one, two, and three preceding backslashes behave as specified.
- Unmatched backslash delimiters follow the current Marked escape result; unmatched dollar delimiters remain ordinary text.
- Over-budget formulas and messages remain readable source and do not call KaTeX.
- Invalid or unsupported commands do not throw, and an injected non-`ParseError` from the math adapter falls back to escaped original source without losing surrounding Markdown.
- KaTeX safety options and the existing sanitizer prevent active attributes and unsafe commands from becoming executable HTML. Assertions inspect active DOM attributes rather than rejecting every occurrence of a string such as `javascript:` because MathML annotations may retain original TeX source.
- A representative repeated-math message stays within the rendered-fragment and cache budgets; existing cache behavior remains unchanged.

### Component tests

Extend `src/client/src/components/FormattedText.test.ts` to verify:

- Rendered math markup and MathML appear in the component's shadow-root message content.
- The KaTeX stylesheet is included in the shadow-root styles.
- Live math, including a delimiter pair split across updates, remains readable plain text with no KaTeX markup or math-renderer calls and renders after `live` becomes false.
- A math-heavy live tail updated through multiple prefixes never calls the math renderer before settlement; its settled render honors the formula and source-size budgets.
- Existing large-live-tail behavior and code-block wrapper behavior continue to work around messages containing math.

### Build, package, and browser verification

Run focused tests first, then typecheck and lint the changed files. The final verification will include the repository's fast verification command, followed separately by the production/browser checks that `verify:fast` does not cover:

1. Run `npm run build` and inspect the generated client bundle for KaTeX font assets and resolved stylesheet URLs.
2. Run `npm pack --dry-run --ignore-scripts --json` and confirm the production package contains the required client assets and any required KaTeX attribution notice. Run `npm audit --omit=dev --json`; the upstream-only exception in `IGNORED.md` does not cover a new direct production dependency or any production finding.
3. Following the project procedure in `probe-narrow-lit-layout-with-chromium-cdp`, create a disposable fixture under `src/client` and a raw-CDP driver under `/tmp`. Start the client on a free strict port, launch a fresh headless Chromium profile, and set exact CDP viewports of `1280x800` and `390x844` before navigation. Remove every fixture, driver, profile, screenshot, log, and server after the probe.
4. In each viewport, assert the actual `window.innerWidth`, nonblank inline and display formula geometry, `document.scrollWidth <= document.clientWidth`, message scroll width containment, and `.math-inline`/`.math-display` overflow behavior for a deliberately long formula. Assert that KaTeX font faces are loaded, the generated MathML is exposed through the accessibility tree, and no page exception occurs.
5. Repeat the asset URL check with the client served below a nested path so the configured `base: "./"` behavior is covered.

## Release

This is a backward-compatible user-facing feature and will receive a minor Changeset for `@hyperdreamer/pi-webui`. The Changeset will describe plain-text LaTeX input and rendered equations in conversation messages. `CHANGELOG.md` will not be edited during development; Changesets will generate release notes during release preparation.

The implementation must update the production dependency declaration and `package-lock.json`. Release verification includes `npm pack --dry-run --ignore-scripts --json`, `npm audit --omit=dev --json`, and preservation of KaTeX's required MIT notice.

No migration, configuration change, server restart requirement, session-daemon change, or persisted-data change is expected.

## Consequences

The client bundle gains KaTeX and its font assets. Message rendering becomes more capable while retaining the existing synchronous `marked`/cache boundary. A small local tokenizer extension, per-render budget, adapter seam, and shadow-root stylesheet integration add maintenance surface, but they keep delimiter parsing, security options, resource limits, and component styling under PI WEBUI's control instead of relying on a post-processing runtime.

Live messages containing potential math intentionally show source text until completion. KaTeX's supported subset, rather than all LaTeX packages, defines the feature's compatibility boundary. Long formulas may scroll within their own math container, while the surrounding message and document remain horizontally contained.
