import { Marked, Renderer, type MarkedToken, type Token, type Tokens, type TokensList, type TokenizerStartFunction, type TokenizerThis } from "marked";
import type { KatexOptions } from "katex";

export type LatexRenderToString = (tex: string, options: KatexOptions) => string;

const MAX_DISCOVERY_BODY_UNITS = 2_048;
const MAX_FORMULA_BODY_UNITS = 512;
const MAX_MESSAGE_SOURCE_UNITS = 4_096;
const MAX_FORMULA_COUNT = 8;
const MAX_BRACE_DEPTH = 32;
const MAX_CONTROL_SEQUENCE_STARTS = 64;
const MAX_ALIGNMENT_SEPARATORS = 64;
const MAX_RESERVED_OUTPUT_UNITS = 256_000;
const RESERVED_OUTPUT_PER_FORMULA = 32_000;

const MATH_OPTIONS = {
  output: "htmlAndMathml",
  throwOnError: false,
  trust: false,
  strict: "ignore",
  maxExpand: 1_000,
  maxSize: 100,
} as const satisfies Omit<KatexOptions, "displayMode">;

type MathTokenType = "latex-inline" | "latex-display";
type LiteralTokenType = "latex-inline-literal" | "latex-block-literal";

interface LatexMathToken {
  type: MathTokenType;
  raw: string;
  tex: string;
  displayMode: boolean;
}

interface MathRenderContext {
  mathSourceUnits: number;
  formulaCount: number;
  mathOutputUnits: number;
  outputAdmissionClosed: boolean;
}
interface Replacement {
  start: number;
  end: number;
  kind: "math" | "literal";
  tex?: string;
  displayMode?: boolean;
}

interface DelimiterEvent {
  index: number;
  kind: "open-paren" | "close-paren" | "open-bracket" | "close-bracket";
}

interface DollarPairing {
  replacements: Replacement[];
  discoveryStop?: number;
}

interface DisplayBlock {
  raw: string;
  tex: string;
}

/** Escape the same three characters escaped by the core Markdown formatter. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** A cheap pre-check used by callers to avoid loading the math path for plain text. */
export function hasPotentialLatexMath(source: string): boolean {
  return source.includes("$") || source.includes("\\(") || source.includes("\\[");
}

/**
 * Render one Markdown message with an isolated Marked extension set. The
 * injected renderer is deliberately kept at this boundary so tests can prove
 * admission and fallback behavior without invoking KaTeX.
 */
export function renderLatexMarkdown(source: string, renderMath: LatexRenderToString): string {
  const context: MathRenderContext = {
    mathSourceUnits: 0,
    formulaCount: 0,
    mathOutputUnits: 0,
    outputAdmissionClosed: false,
  };
  const renderer = new Renderer();
  renderer.html = ({ text }) => escapeHtml(text);

  const parser = new Marked({
    async: false,
    breaks: true,
    gfm: true,
    renderer,
    extensions: [
      createDisplayExtension(context, renderMath),
      createRendererExtension("latex-inline", context, renderMath),
      createRendererExtension("latex-inline-literal", context, renderMath),
      createRendererExtension("latex-block-literal", context, renderMath),
    ],
    hooks: {
      processAllTokens(tokens) {
        return processAllTokens(tokens);
      },
    },
  });

  return parser.parse(source, { async: false });
}

function createDisplayExtension(
  context: MathRenderContext,
  renderMath: LatexRenderToString,
): {
  name: "latex-display";
  level: "block";
  start: TokenizerStartFunction;
  tokenizer: (this: TokenizerThis, source: string, tokens: Token[] | TokensList) => Tokens.Generic | undefined;
  renderer: (token: Tokens.Generic) => string;
} {
  return {
    name: "latex-display",
    level: "block",
    start: displayStart,
    tokenizer: displayTokenizer,
    renderer: (token) => renderLatexToken(token, context, renderMath),
  };
}

function createRendererExtension(
  name: MathTokenType | LiteralTokenType,
  context: MathRenderContext,
  renderMath: LatexRenderToString,
): { name: MathTokenType | LiteralTokenType; renderer: (token: Tokens.Generic) => string } {
  return {
    name,
    renderer: (token) => renderLatexToken(token, context, renderMath),
  };
}

function displayStart(this: TokenizerThis, source: string): number | undefined {
  void this;
  let fence: { character: "`" | "~"; length: number } | undefined;
  // Marked calls block start hooks with src.slice(1), then adds one to the
  // returned offset. Suffix offset zero is therefore never known to be a line start.
  for (let offset = 1; offset < source.length; offset += 1) {
    if (source[offset - 1] !== "\n") continue;
    const lineEnd = source.indexOf("\n", offset);
    const line = source.slice(offset, lineEnd < 0 ? source.length : lineEnd);
    const fenceMarker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence !== undefined) {
      if (fenceMarker?.startsWith(fence.character) === true && fenceMarker.length >= fence.length) fence = undefined;
      continue;
    }
    const fenceCharacter = fenceMarker?.startsWith("`") === true ? "`" : fenceMarker?.startsWith("~") === true ? "~" : undefined;
    if (fenceCharacter !== undefined && fenceMarker !== undefined) {
      fence = { character: fenceCharacter, length: fenceMarker.length };
      continue;
    }
    if (parseDisplayBlock(source.slice(offset)) !== undefined) return offset;
  }
  return undefined;
}

function displayTokenizer(this: TokenizerThis, source: string, tokens: Token[] | TokensList): Tokens.Generic | undefined {
  void this;
  void tokens;
  const block = parseDisplayBlock(source);
  if (block === undefined) return undefined;
  return {
    type: "latex-display",
    raw: block.raw,
    tex: block.tex,
    displayMode: true,
  };
}

function parseDisplayBlock(source: string): DisplayBlock | undefined {
  const firstNewline = source.indexOf("\n");
  const firstLine = firstNewline < 0 ? source : source.slice(0, firstNewline);
  const opener = parseDisplayLine(firstLine);
  if (opener === undefined) return undefined;

  const afterOpener = firstLine.slice(opener.delimiterEnd);
  const remainder = afterOpener.replace(/^[ \t]+/u, "");
  if (remainder !== "") {
    const closeIndex = findDisplayCloser(remainder, opener.delimiter);
    if (closeIndex < 0) return undefined;
    const rawBody = remainder.slice(0, closeIndex);
    if (rawBody.length === 0 || rawBody.length > MAX_DISCOVERY_BODY_UNITS) return undefined;
    const body = rawBody.replace(/[ \t]+$/u, "");
    if (body.trim() === "") return undefined;
    if (/^[ \t]*$/u.exec(remainder.slice(closeIndex + opener.delimiter.length)) === null) return undefined;
    const rawEnd = firstNewline < 0 ? firstLine.length : firstNewline + 1;
    return {
      raw: source.slice(0, rawEnd),
      tex: body,
    };
  }

  if (firstNewline < 0) return undefined;
  const bodyLines: string[] = [];
  let cursor = firstNewline + 1;
  let bodyUnits = 0;
  while (cursor <= source.length) {
    const newline = source.indexOf("\n", cursor);
    const lineEnd = newline < 0 ? source.length : newline;
    const line = source.slice(cursor, lineEnd);
    const closing = parseClosingDisplayLine(line, opener.delimiter);
    if (closing) {
      if (bodyLines.length === 0 || bodyLines.every((bodyLine) => bodyLine.trim() === "")) return undefined;
      const rawEnd = newline < 0 ? lineEnd : newline + 1;
      return {
        raw: source.slice(0, rawEnd),
        tex: bodyLines.join("\n"),
      };
    }
    if (isFenceLine(line)) return undefined;
    bodyLines.push(line);
    bodyUnits += line.length + (bodyLines.length > 1 ? 1 : 0);
    if (bodyUnits > MAX_DISCOVERY_BODY_UNITS) return undefined;
    if (newline < 0) return undefined;
    cursor = newline + 1;
  }
  return undefined;
}

function parseDisplayLine(line: string): { delimiter: "$$" | "\\["; delimiterEnd: number } | undefined {
  const match = /^( {0,3})(\$\$|\\\[)([ \t]*)$/u.exec(line);
  if (match !== null) {
    const delimiter = match[2];
    if (delimiter !== "$$" && delimiter !== "\\[") return undefined;
    return {
      delimiter,
      delimiterEnd: match[0].length,
    };
  }

  const prefix = /^( {0,3})(\$\$|\\\[)/u.exec(line);
  if (prefix === null) return undefined;
  const delimiter = prefix[2];
  if (delimiter !== "$$" && delimiter !== "\\[") return undefined;
  return {
    delimiter,
    delimiterEnd: prefix[0].length,
  };
}

function parseClosingDisplayLine(line: string, delimiter: "$$" | "\\["): boolean {
  const closing = delimiter === "$$" ? "\\$\\$" : "\\\\\\]";
  return new RegExp(`^ {0,3}${closing}[ \\t]*$`, "u").test(line);
}

function findDisplayCloser(source: string, delimiter: "$$" | "\\["): number {
  const closer = delimiter === "$$" ? "$$" : "\\]";
  const searchWindow = source.slice(0, MAX_DISCOVERY_BODY_UNITS + closer.length);
  let searchStart = 0;
  while (searchStart < searchWindow.length) {
    const closeIndex = searchWindow.indexOf(closer, searchStart);
    if (closeIndex < 0 || closeIndex > MAX_DISCOVERY_BODY_UNITS) return -1;
    if (/^[ \t]*$/u.test(source.slice(closeIndex + closer.length))) return closeIndex;
    searchStart = closeIndex + closer.length;
  }
  return -1;
}

function isFenceLine(line: string): boolean {
  return /^ {0,3}(?:```|~~~)/u.test(line);
}

function processAllTokens(tokens: Token[] | TokensList): Token[] | TokensList {
  visitBlockTokens(tokens);
  return tokens;
}

function visitBlockTokens(tokens: Token[] | TokensList): void {
  for (const token of tokens) visitBlockToken(token);
}

function visitBlockToken(token: Token): void {
  if (isCoreToken(token, "paragraph") || isCoreToken(token, "heading")) {
    token.tokens = rewriteInlineScope(token.tokens);
    return;
  }
  if (isCoreToken(token, "blockquote")) {
    visitBlockTokens(token.tokens);
    return;
  }
  if (isCoreToken(token, "list")) {
    for (const item of token.items) visitBlockTokens(item.tokens);
    return;
  }
  if (isCoreToken(token, "list_item")) {
    visitListItemTokens(token.tokens);
    return;
  }
  if (isCoreToken(token, "text") && token.tokens !== undefined) {
    token.tokens = rewriteInlineScope(token.tokens);
    return;
  }
  if (isCoreToken(token, "table")) {
    for (const cell of token.header) cell.tokens = rewriteInlineScope(cell.tokens);
    for (const row of token.rows) {
      for (const cell of row) cell.tokens = rewriteInlineScope(cell.tokens);
    }
  }
}

function visitListItemTokens(tokens: Token[]): void {
  for (const token of tokens) {
    if (isCoreToken(token, "text") && token.tokens !== undefined) {
      token.tokens = rewriteInlineScope(token.tokens);
    } else {
      visitBlockToken(token);
    }
  }
}

function rewriteInlineScope(tokens: Token[]): Token[] {
  const rewritten: Token[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) break;
    if (isLeafInlineToken(token)) {
      const leafTokens: (Tokens.Text | Tokens.Escape)[] = [];
      while (index < tokens.length) {
        const next = tokens[index];
        if (next === undefined || !isLeafInlineToken(next)) break;
        leafTokens.push(next);
        index += 1;
      }
      rewritten.push(...rewriteLeafRun(leafTokens));
      continue;
    }

    if (isCoreToken(token, "em") || isCoreToken(token, "strong") || isCoreToken(token, "del")) {
      token.tokens = rewriteInlineScope(token.tokens);
    } else if (isCoreToken(token, "text") && token.tokens !== undefined) {
      token.tokens = rewriteInlineScope(token.tokens);
    }
    rewritten.push(token);
    index += 1;
  }
  return rewritten;
}

function isCoreToken<T extends MarkedToken["type"]>(token: Token, type: T): token is Extract<MarkedToken, { type: T }> {
  return token.type === type;
}

function isLeafInlineToken(token: Token): token is Tokens.Text | Tokens.Escape {
  return isCoreToken(token, "escape") || (isCoreToken(token, "text") && token.tokens === undefined);
}

interface LeafTokenRange {
  token: Tokens.Text | Tokens.Escape;
  start: number;
  end: number;
}

interface LeafRangeCursor {
  index: number;
}

function rewriteLeafRun(tokens: (Tokens.Text | Tokens.Escape)[]): Token[] {
  const raw = tokens.map((token) => token.raw).join("");
  if (!hasPotentialLatexMath(raw) && !raw.includes("\\)") && !raw.includes("\\]")) return tokens;
  const replacements = discoverReplacements(raw);
  if (replacements.length === 0) return tokens;

  const ranges = createLeafTokenRanges(tokens);
  const rangeCursor: LeafRangeCursor = { index: 0 };
  const result: Token[] = [];
  let cursor = 0;
  for (const replacement of replacements) {
    appendOriginalRange(result, ranges, rangeCursor, cursor, replacement.start);
    const replacementRaw = raw.slice(replacement.start, replacement.end);
    if (replacement.kind === "math") {
      result.push({
        type: replacement.displayMode === true ? "latex-display" : "latex-inline",
        raw: replacementRaw,
        tex: replacement.tex ?? "",
        displayMode: replacement.displayMode === true,
      } satisfies LatexMathToken);
    } else {
      result.push({
        type: "latex-inline-literal",
        raw: replacementRaw,
      });
    }
    cursor = replacement.end;
  }
  appendOriginalRange(result, ranges, rangeCursor, cursor, raw.length);
  return result;
}

function createLeafTokenRanges(tokens: (Tokens.Text | Tokens.Escape)[]): LeafTokenRange[] {
  const ranges: LeafTokenRange[] = [];
  let offset = 0;
  for (const token of tokens) {
    const end = offset + token.raw.length;
    ranges.push({ token, start: offset, end });
    offset = end;
  }
  return ranges;
}

function appendOriginalRange(
  output: Token[],
  ranges: LeafTokenRange[],
  cursor: LeafRangeCursor,
  start: number,
  end: number,
): void {
  if (start >= end) return;
  while (cursor.index < ranges.length) {
    const range = ranges[cursor.index];
    if (range === undefined || range.end > start) break;
    cursor.index += 1;
  }
  for (; cursor.index < ranges.length; cursor.index += 1) {
    const range = ranges[cursor.index];
    if (range === undefined || range.start >= end) break;
    const localStart = Math.max(start, range.start) - range.start;
    const localEnd = Math.min(end, range.end) - range.start;
    if (localStart === 0 && localEnd === range.token.raw.length) {
      output.push(range.token);
    } else {
      const raw = range.token.raw.slice(localStart, localEnd);
      const text = range.token.text.slice(localStart, localEnd);
      output.push({
        type: "text",
        raw,
        text: text.length === raw.length ? text : raw,
        escaped: range.token.type === "text" ? range.token.escaped : false,
      });
    }
    if (range.end > end) break;
  }
}

function discoverReplacements(raw: string): Replacement[] {
  const slashRuns = backslashRuns(raw);
  const markers: DelimiterEvent[] = [];
  const dollars: number[] = [];
  const displayDollarPairs: Replacement[] = [];

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === "\\" && (slashRuns[index] ?? 0) % 2 === 1) {
      const next = raw[index + 1];
      if (next === "(") markers.push({ index, kind: "open-paren" });
      else if (next === ")") markers.push({ index, kind: "close-paren" });
      else if (next === "[") markers.push({ index, kind: "open-bracket" });
      else if (next === "]") markers.push({ index, kind: "close-bracket" });
      continue;
    }
    if (character === "$" && (slashRuns[index - 1] ?? 0) % 2 === 0 && raw[index - 1] !== "$" && raw[index + 1] !== "$") {
      dollars.push(index);
    }
  }

  let pendingDisplay: number | undefined;
  for (let index = 0; index < raw.length - 1; index += 1) {
    if (raw[index] !== "$" || raw[index + 1] !== "$") continue;
    if ((slashRuns[index - 1] ?? 0) % 2 === 1) {
      index += 1;
      continue;
    }
    if (pendingDisplay === undefined) {
      pendingDisplay = index;
      index += 1;
      continue;
    }
    const body = raw.slice(pendingDisplay + 2, index);
    if (body.length > MAX_DISCOVERY_BODY_UNITS) break;
    if (body.trim() !== "") displayDollarPairs.push({ start: pendingDisplay, end: index + 2, kind: "literal" });
    pendingDisplay = undefined;
    index += 1;
  }

  const dollarPairing = pairDollars(raw, dollars);
  const candidates: Replacement[] = [
    ...displayDollarPairs,
    ...pairBackslashMarkers(raw, markers, "open-paren", "close-paren", false),
    ...pairBackslashMarkers(raw, markers, "open-bracket", "close-bracket", true),
    ...dollarPairing.replacements,
  ].filter((replacement) => dollarPairing.discoveryStop === undefined || replacement.end <= dollarPairing.discoveryStop);
  candidates.sort(compareReplacements);

  const acceptedCandidates: Replacement[] = [];
  let coveredEnd = 0;
  for (const candidate of candidates) {
    if (candidate.start < coveredEnd) continue;
    acceptedCandidates.push(candidate);
    coveredEnd = candidate.end;
  }

  const markerLiterals: Replacement[] = [];
  let candidateIndex = 0;
  for (const marker of markers) {
    const start = marker.index;
    const end = start + 2;
    while (candidateIndex < acceptedCandidates.length) {
      const candidate = acceptedCandidates[candidateIndex];
      if (candidate === undefined || candidate.end > start) break;
      candidateIndex += 1;
    }
    const containingCandidate = acceptedCandidates[candidateIndex];
    if (containingCandidate !== undefined && start >= containingCandidate.start && end <= containingCandidate.end) continue;
    markerLiterals.push({ start, end, kind: "literal" });
  }

  return mergeReplacementStreams(acceptedCandidates, markerLiterals);
}

function compareReplacements(left: Replacement, right: Replacement): number {
  return left.start - right.start || right.end - left.end;
}

function mergeReplacementStreams(candidates: Replacement[], markerLiterals: Replacement[]): Replacement[] {
  const merged: Replacement[] = [];
  let candidateIndex = 0;
  let markerIndex = 0;
  while (candidateIndex < candidates.length || markerIndex < markerLiterals.length) {
    const candidate = candidates[candidateIndex];
    const markerLiteral = markerLiterals[markerIndex];
    if (candidate === undefined) {
      if (markerLiteral === undefined) break;
      merged.push(markerLiteral);
      markerIndex += 1;
    } else if (markerLiteral === undefined || compareReplacements(candidate, markerLiteral) <= 0) {
      merged.push(candidate);
      candidateIndex += 1;
    } else {
      merged.push(markerLiteral);
      markerIndex += 1;
    }
  }
  return mergeAdjacentLiteralReplacements(merged);
}

function backslashRuns(raw: string): number[] {
  const runs = new Array<number>(raw.length).fill(0);
  let run = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === "\\") run += 1;
    else run = 0;
    runs[index] = run;
  }
  return runs;
}

function pairBackslashMarkers(
  raw: string,
  markers: DelimiterEvent[],
  opener: DelimiterEvent["kind"],
  closer: DelimiterEvent["kind"],
  literal: boolean,
): Replacement[] {
  const result: Replacement[] = [];
  let pending: DelimiterEvent | undefined;
  for (const marker of markers) {
    if (marker.kind === opener) {
      pending ??= marker;
      continue;
    }
    if (marker.kind !== closer || pending === undefined) continue;
    const bodyStart = pending.index + 2;
    const bodyLength = marker.index - bodyStart;
    if (bodyLength > MAX_DISCOVERY_BODY_UNITS) {
      pending = undefined;
      continue;
    }
    const body = raw.slice(bodyStart, marker.index);
    if (body.length > 0 && body.length <= MAX_DISCOVERY_BODY_UNITS && body.trim() !== ""
      && (literal || (
        !/\s/u.test(body[0] ?? "")
        && !/\s/u.test(body.at(-1) ?? "")
        && isInlineBoundary(raw[pending.index - 1])
        && isInlineBoundary(raw[marker.index + 2])
      ))) {
      const replacement: Replacement = { start: pending.index, end: marker.index + 2, kind: literal ? "literal" : "math", displayMode: false };
      if (!literal) replacement.tex = body;
      result.push(replacement);
      pending = undefined;
    } else if (body.length > MAX_DISCOVERY_BODY_UNITS) {
      pending = undefined;
    } else {
      pending = undefined;
    }
  }
  return result;
}

function pairDollars(raw: string, dollars: number[]): DollarPairing {
  const replacements: Replacement[] = [];
  let pending: number | undefined;
  for (const index of dollars) {
    if (pending === undefined) {
      if (isDollarOpener(raw, index)) pending = index;
      continue;
    }

    const body = raw.slice(pending + 1, index);
    if (body.length > MAX_DISCOVERY_BODY_UNITS) return { replacements, discoveryStop: index };
    if (isDollarCloser(raw, pending, index, body)) {
      replacements.push({ start: pending, end: index + 1, kind: "math", tex: body, displayMode: false });
      pending = undefined;
    } else {
      pending = isDollarOpener(raw, index) ? index : undefined;
    }
  }
  return { replacements };
}

function isDollarOpener(raw: string, index: number): boolean {
  const next = raw[index + 1];
  if (!isInlineBoundary(raw[index - 1]) || next === undefined || /\s/u.test(next)) return false;
  return true;
}

function isDollarCloser(raw: string, opener: number, index: number, body: string): boolean {
  if (body.length === 0 || /\s/u.test(body.at(-1) ?? "")) return false;
  if (!isInlineBoundary(raw[index + 1])) return false;
  return index > opener + 1;
}

function isInlineBoundary(character: string | undefined): boolean {
  return character === undefined || /[\s\p{P}\p{S}]/u.test(character);
}

function mergeAdjacentLiteralReplacements(replacements: Replacement[]): Replacement[] {
  const merged: Replacement[] = [];
  for (const replacement of replacements) {
    const previous = merged.at(-1);
    if (previous?.kind === "literal" && replacement.kind === "literal" && previous.end === replacement.start) {
      previous.end = replacement.end;
    } else {
      merged.push({ ...replacement });
    }
  }
  return merged;
}

function renderLatexToken(token: Tokens.Generic, context: MathRenderContext, renderMath: LatexRenderToString): string {
  if (token.type === "latex-inline-literal") return escapeHtml(token.raw);
  if (token.type === "latex-block-literal") return `<p>${escapeHtml(token.raw)}</p>`;

  const mathToken = readLatexMathToken(token);
  if (mathToken === undefined) return "";
  if (!admitFormula(mathToken.tex, context)) return literalForMathToken(mathToken);
  let rendered: string;
  try {
    rendered = renderMath(mathToken.tex, {
      ...MATH_OPTIONS,
      displayMode: mathToken.displayMode,
    });
  } catch {
    return literalForMathToken(mathToken);
  }
  if (rendered.length > RESERVED_OUTPUT_PER_FORMULA) {
    context.outputAdmissionClosed = true;
    return literalForMathToken(mathToken);
  }
  return mathToken.displayMode
    ? `<div class="math-display">${rendered}</div>`
    : `<span class="math-inline">${rendered}</span>`;
}

function readLatexMathToken(token: Tokens.Generic): LatexMathToken | undefined {
  if (token.type !== "latex-inline" && token.type !== "latex-display") return undefined;
  const candidate: Record<string, unknown> = token;
  const tex = candidate["tex"];
  const displayMode = candidate["displayMode"];
  if (typeof tex !== "string" || typeof displayMode !== "boolean") return undefined;
  return { type: token.type, raw: token.raw, tex, displayMode };
}

function admitFormula(tex: string, context: MathRenderContext): boolean {
  if (context.outputAdmissionClosed) return false;
  if (tex.length > MAX_FORMULA_BODY_UNITS) return false;
  if (context.mathSourceUnits + tex.length > MAX_MESSAGE_SOURCE_UNITS) return false;
  if (context.formulaCount >= MAX_FORMULA_COUNT) return false;
  if (context.mathOutputUnits + RESERVED_OUTPUT_PER_FORMULA > MAX_RESERVED_OUTPUT_UNITS) return false;
  if (!hasSafeMathStructure(tex)) return false;

  context.mathSourceUnits += tex.length;
  context.formulaCount += 1;
  context.mathOutputUnits += RESERVED_OUTPUT_PER_FORMULA;
  return true;
}

function hasSafeMathStructure(tex: string): boolean {
  let braceDepth = 0;
  let controlSequences = 0;
  let separators = 0;
  for (let index = 0; index < tex.length; index += 1) {
    const character = tex[index];
    if (character === "\\") {
      let runEnd = index;
      while (runEnd < tex.length && tex[runEnd] === "\\") runEnd += 1;
      const runLength = runEnd - index;
      if (runLength >= 2) separators += Math.floor(runLength / 2);
      if (separators > MAX_ALIGNMENT_SEPARATORS) return false;
      if (runLength % 2 === 1) {
        const next = tex[runEnd];
        if (/[A-Za-z@]/u.test(next ?? "")) {
          controlSequences += 1;
          const commandEnd = readControlSequenceEnd(tex, runEnd);
          const command = tex.slice(runEnd - 1, commandEnd);
          if (isForbiddenCommand(command)) return false;
          index = commandEnd - 1;
        } else {
          // The odd trailing backslash escapes the following punctuation or brace.
          index = runEnd;
        }
      } else {
        index = runEnd - 1;
      }
      continue;
    }
    if (character === "{") {
      braceDepth += 1;
      if (braceDepth > MAX_BRACE_DEPTH) return false;
    } else if (character === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    } else if (character === "&") {
      separators += 1;
      if (separators > MAX_ALIGNMENT_SEPARATORS) return false;
    }
  }
  return controlSequences <= MAX_CONTROL_SEQUENCE_STARTS;
}

function readControlSequenceEnd(tex: string, start: number): number {
  let end = start;
  while (end < tex.length && /[A-Za-z@]/u.test(tex[end] ?? "")) end += 1;
  return end;
}

function isForbiddenCommand(command: string): boolean {
  return ["\\def", "\\gdef", "\\edef", "\\xdef", "\\let", "\\newcommand", "\\renewcommand"].includes(command);
}

function literalForMathToken(token: LatexMathToken): string {
  return token.displayMode ? `<p>${escapeHtml(token.raw)}</p>` : escapeHtml(token.raw);
}
