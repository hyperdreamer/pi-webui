import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface ScanResult {
  totals: UsageTotals;
  bytesScanned: number;
}

export interface SessionHeaderSummary {
  id: string;
  cwd?: string;
}

/** Entry types whose own `usage` counts, matching Pi's `getSessionStats`. */
const USAGE_ENTRY_TYPES = new Set(["branch_summary", "compaction"]);
/** Message roles whose `usage` counts. User messages carry none. */
const USAGE_MESSAGE_ROLES = new Set(["assistant", "toolResult"]);
const SESSION_HEADER_READ_BYTES = 4 * 1024;

export function emptyUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function addUsageTotals(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    cost: left.cost + right.cost,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberAt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function costOf(usage: Record<string, unknown>): number {
  const cost = usage["cost"];
  if (typeof cost === "number" && Number.isFinite(cost)) return cost;
  if (isRecord(cost)) return numberAt(cost, "total");
  return 0;
}

function totalsFromUsage(usage: Record<string, unknown>): UsageTotals {
  return {
    input: numberAt(usage, "input"),
    output: numberAt(usage, "output"),
    cacheRead: numberAt(usage, "cacheRead"),
    cacheWrite: numberAt(usage, "cacheWrite"),
    cost: costOf(usage),
  };
}

/**
 * Extract the usage contribution of one JSONL line, or undefined when the line
 * carries none. Callers prefilter on the `"usage"` substring; this function
 * still tolerates any line so it is safe to call directly in tests.
 */
export function usageTotalsFromLine(line: string): UsageTotals | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const type = parsed["type"];
  if (typeof type === "string" && USAGE_ENTRY_TYPES.has(type) && isRecord(parsed["usage"])) {
    return totalsFromUsage(parsed["usage"]);
  }

  if (type !== "message") return undefined;
  const message = parsed["message"];
  if (!isRecord(message)) return undefined;
  const role = message["role"];
  if (typeof role !== "string" || !USAGE_MESSAGE_ROLES.has(role)) return undefined;
  const usage = message["usage"];
  if (!isRecord(usage)) return undefined;
  return totalsFromUsage(usage);
}

/** Read a session file's header line without parsing the body. */
export async function readSessionHeader(path: string): Promise<SessionHeaderSummary | undefined> {
  try {
    const input = createReadStream(path, {
      encoding: "utf8",
      highWaterMark: SESSION_HEADER_READ_BYTES,
    });
    try {
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          const parsed: unknown = JSON.parse(line);
          if (!isRecord(parsed) || parsed["type"] !== "session") return undefined;
          const id = parsed["id"];
          if (typeof id !== "string") return undefined;
          const cwd = parsed["cwd"];
          return { id, ...(typeof cwd === "string" ? { cwd } : {}) };
        }
        return undefined;
      } finally {
        lines.close();
      }
    } finally {
      input.destroy();
    }
  } catch {
    return undefined;
  }
}

/** Read the `id` from a session file's header line without parsing the body. */
export async function readSessionHeaderId(path: string): Promise<string | undefined> {
  return (await readSessionHeader(path))?.id;
}

/**
 * Stream a session file from `startOffset` and sum its usage.
 *
 * Only complete newline-terminated lines are counted, and `bytesScanned`
 * advances only past those lines, so a session being appended to concurrently
 * resumes cleanly on the next pass instead of losing or double-counting a
 * partially written tail. Reading whole files is not an option: sessions here
 * exceed 30 MB.
 */
export async function scanSessionUsage(path: string, startOffset: number): Promise<ScanResult> {
  let totals = emptyUsageTotals();
  let bytesScanned = startOffset;

  try {
    const stream: AsyncIterable<string> = createReadStream(path, { encoding: "utf8", start: startOffset });
    let buffered = "";
    for await (const chunk of stream) {
      buffered += chunk;
      let newlineIndex = buffered.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffered.slice(0, newlineIndex);
        bytesScanned += Buffer.byteLength(line, "utf8") + 1;
        if (line.includes("\"usage\"")) {
          const lineTotals = usageTotalsFromLine(line);
          if (lineTotals !== undefined) totals = addUsageTotals(totals, lineTotals);
        }
        buffered = buffered.slice(newlineIndex + 1);
        newlineIndex = buffered.indexOf("\n");
      }
    }
  } catch {
    return { totals: emptyUsageTotals(), bytesScanned: startOffset === 0 ? 0 : startOffset };
  }

  return { totals, bytesScanned };
}
