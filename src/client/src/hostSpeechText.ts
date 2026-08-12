import { marked, type MarkedToken, type Token } from "marked";
import { truncateHostSpeechText } from "../../shared/hostSpeech";
import type { ChatLine } from "./components/shared";

/**
 * True for every token marked's core lexer emits. Extension tokens
 * (`Tokens.Generic`) cannot be excluded from the union by their `type` member
 * (typed `string`), so the projection helpers narrow through this guard first;
 * its index signature would otherwise taint property narrowing everywhere.
 */
function isMarkedToken(token: Token): token is MarkedToken {
  return token.type !== "generic";
}

/**
 * True when a link's visible label is the raw destination URL itself (either
 * exactly, or any bare http(s) URL). Such links add nothing a listener does not
 * already have, so they are dropped; link destinations are never spoken.
 */
function isRawUrlLabel(label: string, href: string): boolean {
  const normalized = label.trim();
  return normalized === href || /^https?:\/\/\S+$/u.test(normalized);
}

/**
 * Projects inline tokens to spoken prose. Keeps text, escapes, emphasis,
 * strong, deletion, inline code, line breaks, and link labels; drops images,
 * HTML/tags, and links whose label is the raw URL itself. Link destinations are
 * never included.
 */
function inlineProse(tokens: Token[]): string {
  let prose = "";
  for (const token of tokens) {
    if (!isMarkedToken(token)) {
      const genericTokens = token.tokens;
      if (genericTokens) prose += inlineProse(genericTokens);
      continue;
    }
    switch (token.type) {
      case "text":
        // Text tokens can carry parsed inline children; projecting the raw
        // string then would leak markdown punctuation.
        prose += token.tokens ? inlineProse(token.tokens) : token.text;
        break;
      case "escape":
        prose += token.text;
        break;
      case "em":
      case "strong":
      case "del":
        prose += inlineProse(token.tokens);
        break;
      case "codespan":
        prose += token.text;
        break;
      case "br":
        prose += "\n";
        break;
      case "link":
        if (!isRawUrlLabel(token.text, token.href)) {
          prose += inlineProse(token.tokens);
        }
        break;
      case "image":
      case "html":
      case "space":
      case "checkbox":
      case "hr":
      case "code":
      case "def":
      case "table":
      case "heading":
      case "paragraph":
      case "blockquote":
      case "list":
      case "list_item":
        // Inline positions only ever see the kept kinds above; every other
        // block kind is unreachable here and silently dropped.
        break;
    }
  }
  return prose;
}

/**
 * Projects one block token to non-empty prose lines. Heading, paragraph,
 * blockquote, and list-item content is kept; code, tables, HTML blocks,
 * definitions, and horizontal rules are dropped.
 */
function blockProse(token: Token): string[] {
  if (!isMarkedToken(token)) {
    const genericTokens = token.tokens;
    return genericTokens ? genericTokens.flatMap(blockProse) : [];
  }
  switch (token.type) {
    case "heading":
    case "paragraph": {
      const prose = inlineProse(token.tokens);
      return prose === "" ? [] : [prose];
    }
    case "blockquote": {
      const lines: string[] = [];
      for (const child of token.tokens) {
        const childLines = blockProse(child);
        if (childLines.length > 0) {
          if (lines.length > 0) lines.push("");
          lines.push(...childLines);
        }
      }
      return lines;
    }
    case "list":
      return token.items.flatMap((item) => item.tokens.flatMap(blockProse));
    case "list_item":
      return token.tokens.flatMap(blockProse);
    case "text": {
      const prose = token.tokens ? inlineProse(token.tokens) : token.text;
      return prose === "" ? [] : [prose];
    }
    case "space":
    case "code":
    case "table":
    case "html":
    case "def":
    case "hr":
    case "br":
    case "checkbox":
    case "codespan":
    case "del":
    case "em":
    case "escape":
    case "image":
    case "link":
    case "strong":
      // Code, tables, HTML blocks, definitions, and rules carry no prose;
      // the remaining inline kinds never appear at block level.
      return [];
  }
}

/**
 * Lexes one markdown text part and returns its prose lines. Blank strings mark
 * paragraph breaks between blocks; list items stay on consecutive lines.
 */
function projectMarkdown(text: string): string[] {
  const tokens = marked.lexer(text, { gfm: true, breaks: true });
  const lines: string[] = [];
  for (const token of tokens) {
    const prose = blockProse(token);
    if (prose.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(...prose);
    }
  }
  return lines;
}

/**
 * Normalizes horizontal whitespace per line, removes empty leading/trailing
 * lines, and collapses consecutive blank lines to at most one.
 */
function normalizeProse(text: string): string {
  const lines = text.split("\n").map((line) => line.replace(/[ \t]+/gu, " ").trim());
  const kept: string[] = [];
  let previousBlank = true;
  for (const line of lines) {
    if (line === "") {
      if (previousBlank) continue;
      previousBlank = true;
      kept.push("");
    } else {
      previousBlank = false;
      kept.push(line);
    }
  }
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  return kept.join("\n");
}

/**
 * Projects an assistant message to spoken prose for host text-to-speech, or
 * `""` when the message cannot be spoken (wrong role, compaction or branch
 * summary source, or no text part with readable prose).
 */
export function assistantSpeechText(message: ChatLine): string {
  if (message.role !== "assistant") return "";
  if (message.source === "compaction" || message.source === "branch_summary") return "";
  const groups: string[][] = [];
  for (const part of message.parts) {
    if (part.type !== "text") continue;
    const lines = projectMarkdown(part.text);
    if (lines.length > 0) groups.push(lines);
  }
  if (groups.length === 0) return "";
  const joined = groups.map((lines) => lines.join("\n")).join("\n\n");
  const normalized = normalizeProse(joined);
  if (normalized === "") return "";
  return truncateHostSpeechText(normalized);
}

/**
 * Derives the speech cache key for an assistant line from its absolute index
 * in the transcript. Assistant lines never carry session-entry metadata, so
 * the index is the only stable identity ChatView has.
 */
export function assistantSpeechMessageKey(_message: ChatLine, absoluteIndex: number): string {
  return `assistant-index:${String(absoluteIndex)}`;
}
