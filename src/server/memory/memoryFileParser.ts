import { createHash } from "node:crypto";

export interface ParsedMemoryEntry {
  id: string;
  content: string;
  category?: string;
  created?: string;
  last?: string;
  failureReason?: string;
}

/**
 * Parse a pi-hermes-memory file into structured entries.
 * Entries are delimited by § on its own line.
 * Empty entries are skipped.
 */
export function parseMemoryFile(content: string): ParsedMemoryEntry[] {
  // Split on § as a line delimiter — handle both \n§\n and leading/trailing §
  const rawEntries = content.split(/\n?^\u00A7\n?/gm);
  return rawEntries
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map(parseEntry);
}

function parseEntry(raw: string): ParsedMemoryEntry {
  const id = createHash("sha256").update(raw).digest("hex").slice(0, 8);

  // Extract category prefix: [category]
  const categoryExec = /^\[([^\]]+)\]\s*/.exec(raw);
  const category: string | undefined = categoryExec?.[1];

  // Extract metadata comment: <!-- created=YYYY-MM-DD, last=YYYY-MM-DD -->
  const metadataExec = /<!--\s*created=(\S+),\s*last=(\S+)\s*-->/.exec(raw);
  const created: string | undefined = metadataExec?.[1];
  const last: string | undefined = metadataExec?.[2];

  // Extract failure reason suffix: — Failed: <reason>
  // Stop before an optional trailing metadata comment.
  const failureExec = /\u2014\s*Failed:\s*(.+?)\s*(?:<!--.*)?$/m.exec(raw);
  const failureRaw = failureExec?.[1]?.trim();
  const failureReason: string | undefined = failureRaw !== undefined && failureRaw !== "" ? failureRaw : undefined;

  return {
    id,
    content: raw,
    ...(category !== undefined ? { category } : {}),
    ...(created !== undefined ? { created } : {}),
    ...(last !== undefined ? { last } : {}),
    ...(failureReason !== undefined ? { failureReason } : {}),
  };
}
