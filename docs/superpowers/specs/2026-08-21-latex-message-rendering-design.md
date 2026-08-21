# LaTeX Message Rendering

## Problem

PI WEBUI's composer already accepts Markdown-like plain text, but the client Markdown renderer treats LaTeX delimiters as ordinary text. Mathematical content in user prompts and assistant replies therefore appears as source notation instead of rendered equations.

The feature should add ordinary LaTeX input without turning the composer into a rich-text editor. A user should be able to type notation such as `$x^2$`, `$$\frac{1}{2}$$`, or `\[\int_0^1 x^2\,dx\]` directly into the existing composer and see it rendered in the conversation.

## Goals

- Keep the composer a plain-text CodeMirror editor with no preview, toolbar, or new input mode.
- Render LaTeX in both user and assistant message content through the existing `FormattedText` path.
- Support inline delimiters `$...$` and `\(...\)`.
- Support display delimiters `$$...$$` and `\[...\]`, including multiline formulas.
- Cover the common commands and environments used in ordinary mathematical explanations:
  `\frac`, superscripts and subscripts, Greek symbols, `\sum`, `\int`, `\rightarrow`, `\text`, `aligned`, `matrix`, `cases`, and `array`.
- Preserve existing Markdown behavior, HTML sanitization, message caching, code-copy behavior, and large-live-tail responsiveness.
- Render accessible HTML plus MathML where KaTeX supports it.
- Keep the feature client-only. Prompt transport and session protocols remain unchanged.

## Non-Goals

- Live equation preview while composing.
- An equation toolbar, formatting controls, or LaTeX autocomplete.
- Server-side LaTeX conversion or a new prompt/message wire format.
- Full compatibility with every LaTeX package or document command.
- Optional KaTeX extensions such as `mhchem` unless a later feature specifically requires them.

## Approach

Use KaTeX as a synchronous `marked` extension at the existing Markdown rendering boundary. The extension will produce a dedicated math token only when a complete, valid delimiter pair begins at the current Marked tokenizer cursor. KaTeX will then render that token to HTML and MathML.

This preserves the current ownership model:

- `PromptEditor` stores and sends text as it is typed.
- `ChatView` continues to use `FormattedText` for message parts.
- `FormattedText` continues to call `toSafeMarkdownHtml()` for settled and short live content.
- `toSafeMarkdownHtml()` remains responsible for Markdown parsing, sanitization, and caching.

A post-render DOM scanner and a MathJax runtime were considered and rejected. A DOM scanner would need to reimplement code protection and nested Markdown handling after Marked has already parsed the message. MathJax would add asynchronous, heavier runtime behavior that complicates streaming updates, cache reuse, and layout stability.

## Delimiter Grammar

The local Marked extension will define deterministic precedence and fallback behavior:

1. Display `$$...$$` is considered before inline `$...$`.
2. Display `\[...\]` is considered before inline `\(...\)`.
3. Display formulas may contain newlines. A single-line display formula is also accepted, whether its delimiters occupy their own lines or appear within a paragraph; it always renders with `displayMode: true`.
4. Inline `$...$` and `\(...\)` do not cross an unescaped newline.
5. `$...$` requires a non-empty matching pair. An opening single dollar must be at the start of the source or be preceded by whitespace or punctuation. A closing single dollar must be at the end of the source or be followed by whitespace or punctuation, and it is not a closing delimiter when followed by an alphanumeric character. This keeps ordinary currency text such as `$5 and $10` readable.
6. Delimiters are recognized only when unescaped. The scanner uses the parity of consecutive preceding backslashes, so `\$` does not open math and escaped delimiter characters inside a formula remain source content.
7. `$$` is checked as a pair before `$`; `\[` and `\]` are checked as pairs before `\(` and `\)`.
8. An unmatched `$` remains ordinary text. An unmatched `\(`, `\)`, `\[`, or `\]` is emitted as a literal text token so Marked does not consume the backslash as a Markdown escape.
9. The extension does not preprocess the complete source into placeholders. Matching occurs at Marked's current cursor so inline code and fenced code remain protected by the normal tokenizer order. Both backtick and tilde fenced code are explicitly covered by tests.

The extension will use `displayMode: true` for display tokens and `displayMode: false` for inline tokens. It will not infer math from bare LaTeX commands without delimiters.

## Rendering and Safety

KaTeX will be added as a production client dependency in the 0.18.x line. Rendering options are explicit:

- `output: "htmlAndMathml"`
- `throwOnError: false`
- `trust: false`
- `strict: "ignore"`
- `maxExpand: 1000`
- `maxSize: 1000`

`throwOnError: false` ensures invalid or unsupported commands do not abort the entire Markdown render. KaTeX's `trust: false` remains the security control that rejects commands such as `\href`, `\includegraphics`, `\htmlClass`, `\htmlStyle`, and `\htmlData` that could introduce active or unsafe browser behavior. The existing `sanitizeHtml()` call remains after Marked and KaTeX output and continues to remove unsafe elements, event attributes, and URLs.

The supported command/environment list is an acceptance baseline, not a promise of complete LaTeX compatibility. Unsupported syntax remains readable through KaTeX's error rendering or ordinary source fallback.

## Shadow-DOM Styles and Assets

KaTeX's normal document-level stylesheet would not style the HTML inside `FormattedText`'s Lit shadow root. The component will import the Vite-processed stylesheet as a string using `katex/dist/katex.min.css?inline` and include it in `FormattedText.styles` through Lit's `unsafeCSS` boundary.

The CSS import must retain Vite's font URL processing. The production build therefore needs to emit the KaTeX `.woff2` assets and point the bundled stylesheet at those emitted assets. The component test will assert that the KaTeX stylesheet is present in the shadow-root styles, and a production Chromium check will verify that a rendered equation is nonblank and that the expected KaTeX font styling is available. Display equations will also receive responsive overflow handling so long formulas do not widen or overlap the message layout.

## Performance and Caching

The existing rendering performance policy remains authoritative:

- Settled messages render through Marked and KaTeX and are cached by their original message text.
- Short live content renders through the same path with `cache: false`.
- Live prefixes are never added to the Markdown HTML cache.
- A live message at or above `LIVE_PLAIN_TEXT_MIN_CHARS` remains line-preserving plain text, including any LaTeX, until streaming ends. When `live` becomes false, the full message is parsed and its equations render.

This deliberately trades immediate equation formatting for responsiveness on very large streaming answers. Tests will cover both the readable plain-text live state and the settled upgrade to rendered math.

## Testing

### Formatter tests

Extend `src/client/src/formatting/markdown.test.ts` to verify:

- Inline `$...$` and `\(...\)` render as inline KaTeX.
- Display `$$...$$` and `\[...\]` render as display KaTeX.
- Multiline display formulas and the supported command/environment baseline render.
- Multiple formulas and Markdown text around formulas render together.
- Inline code and fenced code, using both backticks and tildes, preserve every supported delimiter as code.
- Escaped delimiters, unmatched delimiters, and currency-like `$5 and $10` remain readable source text.
- Invalid or unsupported commands do not throw.
- KaTeX safety options and the existing sanitizer prevent active attributes and unsafe commands from becoming executable HTML. Assertions must allow the original TeX source in MathML annotations and should inspect active DOM attributes rather than reject every occurrence of a string such as `javascript:`.
- Existing cache behavior remains unchanged.

### Component tests

Extend `src/client/src/components/FormattedText.test.ts` to verify:

- Rendered math markup appears in the component's shadow-root message content.
- The KaTeX stylesheet is included in the shadow-root styles.
- Large live math remains plain text and readable, then renders after `live` becomes false.
- Existing code-block wrapper behavior continues to work around messages containing math.

### Build and browser verification

Run focused tests first, then typecheck and lint the changed files. The final verification will include the repository's fast verification command. A production client build and Chromium probe will verify that:

- KaTeX font assets are emitted.
- A representative inline formula and the multiline display formula from the feature example render with nonblank geometry.
- Long display equations stay within the message container through responsive overflow rules.
- User and assistant content use the same rendering path.

## Release

This is a backward-compatible user-facing feature and will receive a minor Changeset for `@hyperdreamer/pi-webui`. The Changeset will describe plain-text LaTeX input and rendered equations in conversation messages. `CHANGELOG.md` will not be edited during development; Changesets will generate release notes during release preparation.

No migration, configuration change, server restart requirement, session-daemon change, or persisted-data change is expected.

## Consequences

The client bundle gains KaTeX and its font assets. Message rendering becomes more capable while retaining the existing synchronous `marked`/cache boundary. A small local tokenizer extension and shadow-root stylesheet integration add maintenance surface, but they keep delimiter parsing, security options, and component styling under PI WEBUI's control instead of relying on a post-processing runtime.

Large live messages intentionally delay equation rendering until completion. KaTeX's supported subset, rather than all LaTeX packages, defines the feature's compatibility boundary.
