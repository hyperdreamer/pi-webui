import type { SessionInfo, SessionStatus } from "../api";
import type { ChatLine } from "./shared";
import { formatCompactNumber, formatFullNumber, formatPreciseCost } from "../utils/format";

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

/** Build the `title` / accessible-label text for the usage badge. */
export function sessionUsageTooltip(status: SessionStatus): string {
  const parts: string[] = [];
  const t = status.tokens;

  parts.push(`Input: ${formatFullNumber(t.input)}`);
  parts.push(`Output: ${formatFullNumber(t.output)}`);
  parts.push(`Cache read: ${formatFullNumber(t.cacheRead)}`);
  parts.push(`Cache write: ${formatFullNumber(t.cacheWrite)}`);
  parts.push(`Total: ${formatFullNumber(t.total)}`);

  if (status.cost > 0) parts.push(`Cost: ${formatPreciseCost(status.cost)}`);

  const ctx = status.contextUsage;
  if (ctx !== undefined) {
    const pct = ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "unknown";
    parts.push(`Context: ${pct} of ${formatFullNumber(ctx.contextWindow)} tokens`);
  }

  return parts.join(" | ");
}

// ---------------------------------------------------------------------------
// Message counts (computed from loaded messages)
// ---------------------------------------------------------------------------

export interface SessionMessageCounts {
  user: number;
  assistant: number;
  toolCalls: number;
  toolResults: number;
  total: number;
}

/** Scan loaded `ChatLine` messages for role/tool breakdown. */
export function computeMessageCounts(messages: readonly ChatLine[]): SessionMessageCounts {
  let user = 0;
  let assistant = 0;
  let toolCalls = 0;
  let toolResults = 0;

  for (const message of messages) {
    if (message.role === "user") user += 1;
    if (message.role === "assistant") {
      assistant += 1;
      toolCalls += message.parts.filter((part) => part.type === "toolCall").length;
    }
    if (message.role === "tool") {
      toolResults += message.parts.filter((part) => part.type === "toolResult").length;
    }
  }

  return { user, assistant, toolCalls, toolResults, total: messages.length };
}

// ---------------------------------------------------------------------------
// Popover detail rows
// ---------------------------------------------------------------------------

export interface DetailRow {
  label: string;
  value: string;
  copyValue?: string;
}

export interface SessionUsageDetail {
  sessionRows: DetailRow[];
  messageRows: DetailRow[];
  tokenRows: DetailRow[];
}

export function sessionUsageDetail(
  status: SessionStatus,
  info: SessionInfo | undefined,
  messageCounts: SessionMessageCounts | undefined,
): SessionUsageDetail {
  const sessionRows: DetailRow[] = [];
  if (info?.name !== undefined && info.name !== "") {
    sessionRows.push({ label: "Name", value: info.name });
  }
  sessionRows.push({
    label: "ID",
    value: info?.id ?? status.sessionId,
    copyValue: info?.id ?? status.sessionId,
  });
  if (info?.path !== undefined && info.path !== "") {
    sessionRows.push({ label: "File", value: info.path, copyValue: info.path });
  } else if (info?.persisted === false) {
    sessionRows.push({ label: "File", value: "In-memory (transient)" });
  } else {
    sessionRows.push({ label: "File", value: status.persisted === false ? "In-memory (transient)" : "Unknown" });
  }

  // Messages
  const messageRows: DetailRow[] = [];
  if (messageCounts !== undefined) {
    messageRows.push({ label: "User", value: formatFullNumber(messageCounts.user) });
    messageRows.push({ label: "Assistant", value: formatFullNumber(messageCounts.assistant) });
    messageRows.push({ label: "Tool calls", value: formatFullNumber(messageCounts.toolCalls) });
    messageRows.push({ label: "Tool results", value: formatFullNumber(messageCounts.toolResults) });
    messageRows.push({ label: "Total", value: formatFullNumber(messageCounts.total) });
  } else if (status.messageCount !== undefined) {
    messageRows.push({ label: "Total", value: formatFullNumber(status.messageCount) });
  }

  // Tokens
  const t = status.tokens;
  const tokenRows: DetailRow[] = [
    { label: "Input", value: formatFullNumber(t.input) },
    { label: "Output", value: formatFullNumber(t.output) },
  ];
  if (t.cacheRead > 0) tokenRows.push({ label: "Cache read", value: formatFullNumber(t.cacheRead) });
  if (t.cacheWrite > 0) tokenRows.push({ label: "Cache write", value: formatFullNumber(t.cacheWrite) });
  tokenRows.push({ label: "Total", value: formatFullNumber(t.total) });

  if (status.cost > 0) tokenRows.push({ label: "Cost", value: formatPreciseCost(status.cost) });

  const ctx = status.contextUsage;
  if (ctx !== undefined) {
    const pct = ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?";
    tokenRows.push({ label: "Context", value: `${pct} / ${formatCompactNumber(ctx.contextWindow)}` });
  }

  return { sessionRows, messageRows, tokenRows };
}
