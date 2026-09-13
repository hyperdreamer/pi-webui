/**
 * Pi 0.85.1 compatibility: optional leading BOM, `//` line comments, and
 * trailing commas are accepted; block comments and hash comments are not.
 * Mirrors `dist/utils/text.js` and `dist/utils/json.js` in the installed Pi.
 */
export class ModelsJsonParseError extends SyntaxError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ModelsJsonParseError";
  }
}

export function stripModelsJsonBom(content: string): string {
  return content.startsWith("\uFEFF") ? content.slice(1) : content;
}

export function stripModelsJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) =>
      match.startsWith('"') ? match : "")
    .replace(
      /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
      (match, tail: string | undefined) =>
        tail ?? (match.startsWith('"') ? match : ""),
    );
}

export function parseModelsJsonText(content: string): unknown {
  const text = stripModelsJsonComments(stripModelsJsonBom(content));
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ModelsJsonParseError(error instanceof Error ? error.message : String(error), { cause: error });
  }
}
