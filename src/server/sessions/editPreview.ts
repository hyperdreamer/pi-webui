import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { diffLines } from "diff";

export interface EditReplacement {
  oldText: string;
  newText: string;
}

export type EditPreviewResult =
  | { diff: string; firstChangedLine?: number }
  | { error: string };

export async function computeEditPreview(path: string, edits: EditReplacement[], cwd: string): Promise<EditPreviewResult> {
  const absolutePath = isAbsolute(path) ? path : resolve(cwd, path);
  try {
    try {
      await access(absolutePath, constants.R_OK);
    } catch (error) {
      const message = error instanceof Error && "code" in error ? `Error code: ${String(error.code)}` : String(error);
      return { error: `Could not edit file: ${path}. ${message}.` };
    }

    const rawContent = await readFile(absolutePath, "utf8");
    const { text: content } = stripBom(rawContent);
    const normalizedContent = normalizeToLF(content);
    const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
    return generateDiffString(baseContent, newContent);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function fuzzyFindText(content: string, oldText: string): { found: boolean; index: number; matchLength: number; usedFuzzyMatch: boolean } {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false };

  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
  return { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true };
}

function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  if (fuzzyOldText === "") return 0;
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

function applyEditsToNormalizedContent(normalizedContent: string, edits: EditReplacement[], path: string): { baseContent: string; newContent: string } {
  const normalizedEdits = edits.map((edit) => ({ oldText: normalizeToLF(edit.oldText), newText: normalizeToLF(edit.newText) }));
  for (let index = 0; index < normalizedEdits.length; index++) {
    if ((normalizedEdits[index]?.oldText ?? "") === "") throw editError("empty", path, index, normalizedEdits.length);
  }

  const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
  const baseContent = initialMatches.some((match) => match.usedFuzzyMatch) ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

  const matchedEdits: { editIndex: number; matchIndex: number; matchLength: number; newText: string }[] = [];
  for (let index = 0; index < normalizedEdits.length; index++) {
    const edit = normalizedEdits[index];
    if (edit === undefined) continue;
    const match = fuzzyFindText(baseContent, edit.oldText);
    if (!match.found) throw editError("missing", path, index, normalizedEdits.length);
    const occurrences = countOccurrences(baseContent, edit.oldText);
    if (occurrences > 1) throw editError("duplicate", path, index, normalizedEdits.length, occurrences);
    matchedEdits.push({ editIndex: index, matchIndex: match.index, matchLength: match.matchLength, newText: edit.newText });
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let index = 1; index < matchedEdits.length; index++) {
    const previous = matchedEdits[index - 1];
    const current = matchedEdits[index];
    if (previous !== undefined && current !== undefined && previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(`edits[${String(previous.editIndex)}] and edits[${String(current.editIndex)}] overlap in ${path}. Merge them into one edit or target disjoint regions.`);
    }
  }

  let newContent = baseContent;
  for (let index = matchedEdits.length - 1; index >= 0; index--) {
    const edit = matchedEdits[index];
    if (edit === undefined) continue;
    newContent = `${newContent.slice(0, edit.matchIndex)}${edit.newText}${newContent.slice(edit.matchIndex + edit.matchLength)}`;
  }
  if (baseContent === newContent) throw editError("nochange", path, 0, normalizedEdits.length);
  return { baseContent, newContent };
}

function editError(kind: "missing" | "duplicate" | "empty" | "nochange", path: string, editIndex: number, totalEdits: number, occurrences?: number): Error {
  const prefix = totalEdits === 1 ? "" : `edits[${String(editIndex)}].`;
  if (kind === "empty") return new Error(totalEdits === 1 ? `oldText must not be empty in ${path}.` : `${prefix}oldText must not be empty in ${path}.`);
  if (kind === "missing") return new Error(totalEdits === 1 ? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.` : `Could not find edits[${String(editIndex)}] in ${path}. The oldText must match exactly including all whitespace and newlines.`);
  if (kind === "duplicate") return new Error(totalEdits === 1 ? `Found ${String(occurrences)} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.` : `Found ${String(occurrences)} occurrences of edits[${String(editIndex)}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`);
  return new Error(totalEdits === 1 ? `No changes made to ${path}. The replacement produced identical content.` : `No changes made to ${path}. The replacements produced identical content.`);
}

function generateDiffString(oldContent: string, newContent: string, contextLines = 4): { diff: string; firstChangedLine?: number } {
  const parts = diffLines(oldContent, newContent);
  const output: string[] = [];
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;
  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part === undefined) continue;
    const raw = part.value.split("\n");
    if (raw.at(-1) === "") raw.pop();

    if (part.added || part.removed) {
      firstChangedLine ??= newLineNum;
      for (const line of raw) {
        if (part.added) {
          output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
          newLineNum++;
        } else {
          output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
      continue;
    }

    const nextPart = parts[index + 1];
    const nextPartIsChange = (nextPart?.added ?? false) || (nextPart?.removed ?? false);
    const hasLeadingChange = lastWasChange;
    const hasTrailingChange = nextPartIsChange;

    if (hasLeadingChange && hasTrailingChange) {
      if (raw.length <= contextLines * 2) {
        appendContextLines(output, raw, lineNumWidth, () => oldLineNum++, () => newLineNum++);
      } else {
        const leadingLines = raw.slice(0, contextLines);
        const trailingLines = raw.slice(raw.length - contextLines);
        const skippedLines = raw.length - leadingLines.length - trailingLines.length;
        appendContextLines(output, leadingLines, lineNumWidth, () => oldLineNum++, () => newLineNum++);
        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skippedLines;
        newLineNum += skippedLines;
        appendContextLines(output, trailingLines, lineNumWidth, () => oldLineNum++, () => newLineNum++);
      }
    } else if (hasLeadingChange) {
      const shownLines = raw.slice(0, contextLines);
      const skippedLines = raw.length - shownLines.length;
      appendContextLines(output, shownLines, lineNumWidth, () => oldLineNum++, () => newLineNum++);
      if (skippedLines > 0) {
        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skippedLines;
        newLineNum += skippedLines;
      }
    } else if (hasTrailingChange) {
      const skippedLines = Math.max(0, raw.length - contextLines);
      if (skippedLines > 0) {
        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skippedLines;
        newLineNum += skippedLines;
      }
      appendContextLines(output, raw.slice(skippedLines), lineNumWidth, () => oldLineNum++, () => newLineNum++);
    } else {
      oldLineNum += raw.length;
      newLineNum += raw.length;
    }
    lastWasChange = false;
  }

  return { diff: output.join("\n"), ...(firstChangedLine === undefined ? {} : { firstChangedLine }) };
}

function appendContextLines(output: string[], lines: string[], lineNumWidth: number, nextOldLine: () => number, nextNewLine: () => number): void {
  for (const line of lines) {
    const oldLine = nextOldLine();
    nextNewLine();
    output.push(` ${String(oldLine).padStart(lineNumWidth, " ")} ${line}`);
  }
}
