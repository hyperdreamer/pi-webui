/**
 * Pure helpers for the `read_subsession` tool: turn a subsession's normalized
 * history (as produced by `historyMessages`) into a filtered, projected,
 * paginated view the parent agent can explore.
 *
 * The agent drives the read: it picks which roles and content kinds it cares
 * about, how much detail it wants, and how far back to look. If a narrow read
 * does not answer its question it can widen the filters or page further back,
 * the same grep-then-read loop it already uses on files. Everything here is a
 * pure transform over an array so it can be unit-tested without a live session.
 */

/** Message roles the parent can ask for, mapped from raw history roles. */
export type TranscriptRole = "assistant" | "user" | "tool" | "system" | "custom";

/** Content kinds the parent can keep within retained messages. */
export type TranscriptContentKind = "text" | "thinking" | "tool_call" | "tool_result" | "image";

/**
 * Marks a text value that the caller's `maxChars` clipped. Carries the full
 * length so the consumer knows *how much* was dropped and can re-read with a
 * larger `maxChars` (or none). Truncation only ever happens when the caller
 * passes `maxChars`, so a `truncated` marker is always something they asked
 * for and should expect, never a silent surprise. Its presence (not a `…`
 * glyph, which is indistinguishable from real content) is the reliable signal.
 */
export interface TranscriptTruncation {
  /** Characters retained in `text`. */
  shown: number;
  /** Length of the original, untruncated text. */
  full: number;
}

export type TranscriptPart =
  | { kind: "text"; text: string; truncated?: TranscriptTruncation }
  | { kind: "thinking"; text: string; truncated?: TranscriptTruncation }
  | { kind: "tool_call"; toolName: string; summary: string; args?: unknown }
  | { kind: "tool_result"; toolName?: string; text: string; isError: boolean; truncated?: TranscriptTruncation }
  | { kind: "image" };

export interface TranscriptEntry {
  /** Position of this message in the full transcript (stable across reads). */
  index: number;
  role: TranscriptRole;
  parts: TranscriptPart[];
}

export interface TranscriptQuery {
  /** Message roles to include. Omit for all roles. */
  roles?: TranscriptRole[];
  /** Content kinds to keep within retained messages. Omit for all kinds. */
  include?: TranscriptContentKind[];
  /** Case-insensitive substring; keep only entries whose text matches. */
  search?: string;
  /**
   * Truncate each text/thinking/tool_result value to this many characters,
   * flagging clipped parts with `truncated`. Omit for full, untruncated text:
   * there is deliberately no default, so truncation only happens when asked for
   * and a `truncated` marker is always expected. `search` always runs against
   * the full content regardless, so clipping never hides a match.
   */
  maxChars?: number;
  /** Include raw tool-call arguments (can be large). The compact `summary` is always present. */
  includeToolArgs?: boolean;
  /** Upper bound (exclusive) on original index; page backward by passing the previous `start`. */
  before?: number;
  /** Keep at most this many of the most-recent matches in the window; entries are returned in chronological order. */
  limit?: number;
}

export interface TranscriptView {
  entries: TranscriptEntry[];
  /** Total messages in the full transcript, before any filtering. */
  total: number;
  /** Entries matching the role/content/search filters across the whole transcript. */
  matched: number;
  /** Original index of the first returned entry, or `before` when nothing matched in-window. */
  start: number;
  /** True when matching entries exist before `start` (page back with `before: start`). */
  hasMore: boolean;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Build a filtered, projected, paginated view of a normalized transcript.
 *
 * Filtering happens before paging for *semantics*, not speed: `search`, the
 * `matched` count, and "page backward through matches" all require scanning the
 * whole transcript, so a window-first approach could not answer them. The
 * tradeoff is an O(total) scan per call (paging a raw window first would be
 * cheaper), but `total` is a single session's history and this runs once per
 * tool call, so the scan is negligible. The cost that matters for an LLM tool,
 * the tokens returned, is bounded by `limit` regardless of ordering; `matched`
 * is only a count, so the agent learns whether widening or paging is worthwhile
 * without paying to receive every match.
 */
export function buildTranscriptView(messages: readonly unknown[], query: TranscriptQuery = {}): TranscriptView {
  const total = messages.length;
  // Explicit, caller-owned truncation: only when provided, and a malformed
  // value (negative/fractional) is coerced to a safe non-negative integer
  // rather than silently meaning "no cap".
  const maxChars = query.maxChars === undefined ? undefined : Math.max(0, Math.floor(query.maxChars));
  const includeToolArgs = query.includeToolArgs === true;
  const roleFilter = query.roles === undefined ? undefined : new Set(query.roles);
  const includeFilter = query.include === undefined ? undefined : new Set(query.include);
  const search = query.search !== undefined && query.search !== "" ? query.search.toLowerCase() : undefined;

  // Extract *full* (untruncated) parts and run all filtering/search on them, so
  // matching never depends on `maxChars`. Projection (clipping, arg dropping)
  // happens later and only on the entries we actually return.
  const matchedEntries: FullEntry[] = [];
  for (let index = 0; index < total; index++) {
    const role = roleOf(messages[index]);
    if (role === undefined) continue;
    if (roleFilter !== undefined && !roleFilter.has(role)) continue;

    let parts = fullPartsOf(messages[index], role);
    if (includeFilter !== undefined) parts = parts.filter((part) => includeFilter.has(part.kind));
    if (parts.length === 0) continue;
    if (search !== undefined && !partsMatchSearch(parts, search)) continue;

    matchedEntries.push({ index, role, parts });
  }

  const matched = matchedEntries.length;
  const before = clampInteger(query.before ?? total, 0, total);
  const limit = clampInteger(query.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);

  const inWindow = matchedEntries.filter((entry) => entry.index < before);
  const windowed = inWindow.slice(Math.max(0, inWindow.length - limit));
  const entries = windowed.map((entry) => projectEntry(entry, maxChars, includeToolArgs));
  const first = windowed[0];
  const start = first === undefined ? before : first.index;
  const hasMore = inWindow.length > windowed.length;

  return { entries, total, matched, start, hasMore };
}

/**
 * A part before projection: tool calls keep their raw `args`, text-bearing
 * parts keep their full untruncated `text`. Search and filtering run on these
 * so a match is never hidden by `summary` truncation.
 */
type FullPart =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; toolName: string; args?: unknown }
  | { kind: "tool_result"; toolName?: string; text: string; isError: boolean }
  | { kind: "image" };

interface FullEntry {
  index: number;
  role: TranscriptRole;
  parts: FullPart[];
}

function partsMatchSearch(parts: readonly FullPart[], needle: string): boolean {
  return parts.some((part) => {
    if (part.kind === "text" || part.kind === "thinking") return part.text.toLowerCase().includes(needle);
    if (part.kind === "tool_result") return part.text.toLowerCase().includes(needle) || (part.toolName?.toLowerCase().includes(needle) ?? false);
    // Search the *full* serialized args, not the lossy one-line summary, so a
    // term inside edit/write content, nested objects, or long values is found.
    if (part.kind === "tool_call") return part.toolName.toLowerCase().includes(needle) || stringifyArgs(part.args).toLowerCase().includes(needle);
    return false;
  });
}

/** Full, search-friendly serialization of tool-call args (distinct from the lossy display summary). */
function stringifyArgs(args: unknown): string {
  if (args === undefined) return "";
  if (typeof args === "string") return args;
  try {
    // JSON.stringify can return undefined at runtime (e.g. a function/symbol),
    // despite its string-typed signature; normalize that to "".
    const json: unknown = JSON.stringify(args);
    return typeof json === "string" ? json : "";
  } catch {
    return "";
  }
}

/** Project a fully-extracted entry into the returned shape, clipping only when `maxChars` is set. */
function projectEntry(entry: FullEntry, maxChars: number | undefined, includeToolArgs: boolean): TranscriptEntry {
  return { index: entry.index, role: entry.role, parts: entry.parts.map((part) => projectPart(part, maxChars, includeToolArgs)) };
}

function projectPart(part: FullPart, maxChars: number | undefined, includeToolArgs: boolean): TranscriptPart {
  if (part.kind === "text") return { kind: "text", ...clip(part.text, maxChars) };
  if (part.kind === "thinking") return { kind: "thinking", ...clip(part.text, maxChars) };
  if (part.kind === "tool_result") {
    return {
      kind: "tool_result",
      ...(part.toolName === undefined ? {} : { toolName: part.toolName }),
      isError: part.isError,
      ...clip(part.text, maxChars),
    };
  }
  if (part.kind === "tool_call") {
    return {
      kind: "tool_call",
      toolName: part.toolName,
      summary: summarizeToolArgs(part.args),
      ...(includeToolArgs && part.args !== undefined ? { args: part.args } : {}),
    };
  }
  return { kind: "image" };
}

/** Clip text to `maxChars`, attaching a `truncated` marker when it actually shortens. */
function clip(text: string, maxChars: number | undefined): { text: string; truncated?: TranscriptTruncation } {
  if (maxChars === undefined || text.length <= maxChars) return { text };
  return { text: text.slice(0, maxChars), truncated: { shown: maxChars, full: text.length } };
}

/** Map a raw history message to one of the agent-facing roles, or undefined to drop it. */
function roleOf(message: unknown): TranscriptRole | undefined {
  const role = getString(message, "role");
  if (role === "assistant") return "assistant";
  if (role === "user") return "user";
  if (role === "toolResult") return "tool";
  if (role === "custom") return "custom";
  if (role === "system") return "system";
  return undefined;
}

/** Extract a message's *full* (untruncated) parts; projection happens later. */
function fullPartsOf(message: unknown, role: TranscriptRole): FullPart[] {
  if (role === "tool") return toolResultParts(message);
  const content = getProperty(message, "content");
  if (typeof content === "string") return content === "" ? [] : [{ kind: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap(contentPart);
}

function toolResultParts(message: unknown): FullPart[] {
  const text = stringifyContent(getProperty(message, "content")) || (getString(message, "text") ?? "");
  const toolName = getString(message, "toolName");
  const isError = getProperty(message, "isError") === true;
  return [{ kind: "tool_result", ...(toolName === undefined ? {} : { toolName }), text, isError }];
}

function contentPart(part: unknown): FullPart[] {
  const type = getString(part, "type");
  if (type === "text") {
    const text = getString(part, "text") ?? "";
    return text === "" ? [] : [{ kind: "text", text }];
  }
  if (type === "thinking") {
    const text = getString(part, "thinking") ?? getString(part, "text") ?? "";
    return text === "" ? [] : [{ kind: "thinking", text }];
  }
  if (type === "toolCall") {
    const toolName = getString(part, "name") ?? "tool";
    const args = getProperty(part, "arguments");
    return [{ kind: "tool_call", toolName, ...(args === undefined ? {} : { args }) }];
  }
  if (type === "image") return [{ kind: "image" }];
  return [];
}

/** Compact one-line description of tool arguments (mirrors the UI's summary). */
function summarizeToolArgs(args: unknown): string {
  if (!isRecord(args)) return typeof args === "string" ? args : "";
  const command = getString(args, "command");
  if (command !== undefined) return command;
  const path = getString(args, "path");
  if (path !== undefined) return path;
  if (typeof args["oldText"] === "string" && typeof args["newText"] === "string") return "edit text replacement";
  const edits = args["edits"];
  if (Array.isArray(edits)) return `${String(edits.length)} edit${edits.length === 1 ? "" : "s"}`;
  const entries = Object.entries(args).filter(([, value]) => value != null).slice(0, 3);
  return entries.map(([key, value]) => `${key}: ${shortValue(value)}`).join(" · ");
}

function shortValue(value: unknown): string {
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 77)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${String(value.length)} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object" && value !== null) return "object";
  return "";
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (getString(part, "type") === "image" ? "[image]" : getString(part, "text") ?? ""))
      .filter((text) => text !== "")
      .join("\n");
  }
  return "";
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function getString(value: unknown, key: string): string | undefined {
  const property = getProperty(value, key);
  return typeof property === "string" ? property : undefined;
}
