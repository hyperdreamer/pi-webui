export interface TerminalSize {
  cols: number;
  rows: number;
}

export function parseTerminalSize(cols: string | number | undefined, rows: string | number | undefined): TerminalSize | undefined {
  const parsedCols = Number(cols);
  const parsedRows = Number(rows);
  if (!isValidTerminalSize(parsedCols, parsedRows)) return undefined;
  return { cols: Math.floor(parsedCols), rows: Math.floor(parsedRows) };
}

export function terminalSizeQuery(cols: string | number | undefined, rows: string | number | undefined): string {
  const size = parseTerminalSize(cols, rows);
  if (size === undefined) return "";
  return `?cols=${encodeURIComponent(String(size.cols))}&rows=${encodeURIComponent(String(size.rows))}`;
}

export function isValidTerminalSize(cols: number, rows: number): boolean {
  return Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0;
}
