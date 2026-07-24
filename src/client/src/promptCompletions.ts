export type PromptCompletionTrigger =
  | { kind: "command"; query: string; from: number; to: number }
  | { kind: "file"; query: string; from: number; to: number; fileScope?: "tracked" | "all" | undefined; allPrefix?: "@ " | "!@" | undefined; quoted?: boolean };

export function detectPromptCompletionTrigger(draft: string, cursor = draft.length): PromptCompletionTrigger | undefined {
  const beforeCursor = draft.slice(0, cursor);
  const quotedTrigger = currentQuotedTrigger(beforeCursor, cursor);
  if (quotedTrigger !== undefined) return quotedTrigger;

  const allFileTrigger = currentUnquotedAllFileTrigger(beforeCursor, cursor);
  if (allFileTrigger !== undefined) return allFileTrigger;

  const tokenStart = Math.max(beforeCursor.lastIndexOf(" "), beforeCursor.lastIndexOf("\n")) + 1;
  const token = beforeCursor.slice(tokenStart);
  const beforeToken = beforeCursor.slice(0, tokenStart);
  if (beforeToken.endsWith("@ ")) return { kind: "file", query: token, from: tokenStart - 2, to: cursor, fileScope: "all", allPrefix: "@ " };
  if (token.startsWith("/") && tokenStart === 0) return { kind: "command", query: token.slice(1), from: tokenStart, to: cursor };
  if (token.startsWith("!@")) return { kind: "file", query: token.slice(2), from: tokenStart, to: cursor, fileScope: "all", allPrefix: "!@" };
  if (token.startsWith("@")) return { kind: "file", query: token.slice(1), from: tokenStart, to: cursor, fileScope: "tracked" };
  return undefined;
}

export function fileCompletionInsertText(path: string, quoted: boolean, allPrefix?: "@ " | "!@"): string {
  const prefix = allPrefix ?? "@";
  if (!quoted && !path.includes(" ")) return `${prefix}${path}`;
  return `${prefix}"${path}"`;
}

function currentQuotedTrigger(beforeCursor: string, cursor: number): PromptCompletionTrigger | undefined {
  const quoteStart = beforeCursor.lastIndexOf("\"");
  if (quoteStart === -1) return undefined;
  const prefix = beforeCursor.slice(0, quoteStart);
  if (prefix.endsWith("!@")) return { kind: "file", query: beforeCursor.slice(quoteStart + 1), from: prefix.length - 2, to: cursor, fileScope: "all", allPrefix: "!@", quoted: true };
  if (prefix.endsWith("@")) return { kind: "file", query: beforeCursor.slice(quoteStart + 1), from: prefix.length - 1, to: cursor, fileScope: "tracked", quoted: true };
  if (prefix.endsWith("@ ")) return { kind: "file", query: beforeCursor.slice(quoteStart + 1), from: prefix.length - 2, to: cursor, fileScope: "all", allPrefix: "@ ", quoted: true };
  return undefined;
}

function currentUnquotedAllFileTrigger(beforeCursor: string, cursor: number): PromptCompletionTrigger | undefined {
  const lineStart = beforeCursor.lastIndexOf("\n") + 1;
  const line = beforeCursor.slice(lineStart);
  const atSpaceIndex = lastTokenBoundarySequence(line, "@ ");
  const bangAtIndex = lastTokenBoundarySequence(line, "!@");
  const prefixStartInLine = Math.max(atSpaceIndex, bangAtIndex);
  if (prefixStartInLine === -1) return undefined;

  const allPrefix: "@ " | "!@" = prefixStartInLine === bangAtIndex ? "!@" : "@ ";
  const from = lineStart + prefixStartInLine;
  const queryStart = from + allPrefix.length;
  return { kind: "file", query: beforeCursor.slice(queryStart), from, to: cursor, fileScope: "all", allPrefix };
}

function lastTokenBoundarySequence(text: string, sequence: string): number {
  for (let index = text.lastIndexOf(sequence); index >= 0; index = text.lastIndexOf(sequence, index - 1)) {
    if (index === 0 || isWhitespace(text[index - 1])) return index;
  }
  return -1;
}

function isWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\t";
}
