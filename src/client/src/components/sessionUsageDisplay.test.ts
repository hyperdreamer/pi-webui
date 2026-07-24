import { describe, expect, it } from "vitest";
import type { SessionInfo, SessionStatus } from "../api";
import type { ChatLine } from "./shared";
import {
  computeMessageCounts,
  sessionUsageDetail,
  sessionUsageTooltip,
} from "./sessionUsageDisplay";

function baseStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionId: "session-1",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// sessionUsageTooltip
// ---------------------------------------------------------------------------

describe("sessionUsageTooltip", () => {
  it("formats normal token, cost, and context values", () => {
    const status = baseStatus({
      tokens: { input: 95231, output: 7482, cacheRead: 0, cacheWrite: 0, total: 102713 },
      cost: 0.1874,
      contextUsage: { tokens: 94600, contextWindow: 1_100_000, percent: 8.6 },
    });

    const tooltip = sessionUsageTooltip(status);

    expect(tooltip).toContain("Input: 95,231");
    expect(tooltip).toContain("Output: 7,482");
    expect(tooltip).toContain("Cache read: 0");
    expect(tooltip).toContain("Cache write: 0");
    expect(tooltip).toContain("Total: 102,713");
    expect(tooltip).toContain("Cost: $0.1874");
    expect(tooltip).toContain("Context: 8.6% of 1,100,000 tokens");
  });

  it("handles zero cost gracefully", () => {
    const status = baseStatus({
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
      cost: 0,
      contextUsage: { tokens: 150, contextWindow: 200_000, percent: 0.075 },
    });

    const tooltip = sessionUsageTooltip(status);

    expect(tooltip).not.toContain("Cost:");
    expect(tooltip).toContain("Context: 0.1% of 200,000 tokens");
  });

  it("handles unknown context usage", () => {
    const status = baseStatus({
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
    });

    const tooltip = sessionUsageTooltip(status);

    expect(tooltip).not.toContain("Context:");
  });

  it("handles null context percent", () => {
    const status = baseStatus({
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
      contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
    });

    const tooltip = sessionUsageTooltip(status);

    expect(tooltip).toContain("Context: unknown of 200,000 tokens");
  });

  it("handles cache-read and cache-write values", () => {
    const status = baseStatus({
      tokens: { input: 10_000, output: 5_000, cacheRead: 3_000, cacheWrite: 1_500, total: 19_500 },
    });

    const tooltip = sessionUsageTooltip(status);

    expect(tooltip).toContain("Cache read: 3,000");
    expect(tooltip).toContain("Cache write: 1,500");
  });
});

// ---------------------------------------------------------------------------
// computeMessageCounts
// ---------------------------------------------------------------------------

describe("computeMessageCounts", () => {
  it("counts user, assistant, tool calls, and tool results", () => {
    const messages: ChatLine[] = [
      { role: "user", parts: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        parts: [
          { type: "toolCall", toolName: "read", summary: "read file" },
          { type: "text", text: "I will read the file" },
          { type: "toolCall", toolName: "bash", summary: "run command" },
        ],
      },
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "file contents", isError: false }] },
      { role: "user", parts: [{ type: "text", text: "thanks" }] },
      {
        role: "assistant",
        parts: [{ type: "text", text: "you're welcome" }],
      },
    ];

    const counts = computeMessageCounts(messages);

    expect(counts).toEqual({
      user: 2,
      assistant: 2,
      toolCalls: 2,
      toolResults: 1,
      total: 5,
    });
  });

  it("handles empty messages", () => {
    expect(computeMessageCounts([])).toEqual({
      user: 0,
      assistant: 0,
      toolCalls: 0,
      toolResults: 0,
      total: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// sessionUsageDetail
// ---------------------------------------------------------------------------

describe("sessionUsageDetail", () => {
  it("includes session identity rows when info is available", () => {
    const info: SessionInfo = {
      id: "abc-123",
      path: "/home/user/.pi/sessions/abc-123.json",
      cwd: "/project",
      name: "My session",
      created: "2025-01-01T00:00:00Z",
      modified: "2025-01-02T00:00:00Z",
      messageCount: 10,
      firstMessage: "hello",
    };

    const detail = sessionUsageDetail(baseStatus(), info, undefined);

    expect(detail.sessionRows).toEqual([
      { label: "Name", value: "My session" },
      { label: "ID", value: "abc-123", copyValue: "abc-123" },
      { label: "File", value: "/home/user/.pi/sessions/abc-123.json", copyValue: "/home/user/.pi/sessions/abc-123.json" },
    ]);
  });

  it("omits name row when name is empty", () => {
    const info: SessionInfo = {
      id: "abc-123",
      path: "/home/user/.pi/sessions/abc-123.json",
      cwd: "/project",
      name: "",
      created: "2025-01-01T00:00:00Z",
      modified: "2025-01-02T00:00:00Z",
      messageCount: 10,
      firstMessage: "hello",
    };

    const detail = sessionUsageDetail(baseStatus(), info, undefined);

    expect(detail.sessionRows.map((r) => r.label)).not.toContain("Name");
  });

  it("shows transient label when persisted is false", () => {
    const info: SessionInfo = {
      id: "transient-1",
      path: "",
      cwd: "/project",
      persisted: false,
      created: "2025-01-01T00:00:00Z",
      modified: "2025-01-02T00:00:00Z",
      messageCount: 0,
      firstMessage: "",
    };

    const detail = sessionUsageDetail(baseStatus(), info, undefined);

    expect(detail.sessionRows.find((r) => r.label === "File")?.value).toBe("In-memory (transient)");
  });

  it("includes message counts when available", () => {
    const detail = sessionUsageDetail(
      baseStatus({ messageCount: 42 }),
      undefined,
      { user: 15, assistant: 12, toolCalls: 8, toolResults: 7, total: 42 },
    );

    expect(detail.messageRows).toEqual([
      { label: "User", value: "15" },
      { label: "Assistant", value: "12" },
      { label: "Tool calls", value: "8" },
      { label: "Tool results", value: "7" },
      { label: "Total", value: "42" },
    ]);
  });

  it("falls back to messageCount when breakdown is unavailable", () => {
    const detail = sessionUsageDetail(baseStatus({ messageCount: 15 }), undefined, undefined);

    expect(detail.messageRows).toEqual([
      { label: "Total", value: "15" },
    ]);
  });

  it("handles zero-value status safely", () => {
    const detail = sessionUsageDetail(baseStatus(), undefined, undefined);

    // No costs when zero, no context when absent
    const labels = detail.tokenRows.map((r) => r.label);
    expect(labels).toContain("Input");
    expect(labels).toContain("Output");
    expect(labels).toContain("Total");
    expect(labels).not.toContain("Cost");
    expect(labels).not.toContain("Context");

    // Zero values render as "0" not NaN or undefined
    for (const row of detail.tokenRows) {
      expect(row.value).not.toBe("NaN");
      expect(row.value).not.toBe("undefined");
      expect(row.value).not.toBe("null");
    }
  });

  it("includes token breakdown with cache rows when non-zero", () => {
    const status = baseStatus({
      tokens: { input: 10_000, output: 5_000, cacheRead: 3_000, cacheWrite: 1_500, total: 19_500 },
      cost: 0.05,
      contextUsage: { tokens: 19_500, contextWindow: 200_000, percent: 9.75 },
    });

    const detail = sessionUsageDetail(status, undefined, undefined);

    const labels = detail.tokenRows.map((r) => r.label);
    expect(labels).toEqual(["Input", "Output", "Cache read", "Cache write", "Total", "Cost", "Context"]);
    expect(detail.tokenRows.find((r) => r.label === "Context")?.value).toBe("9.8% / 200k");
  });

  it("omits zero cache rows", () => {
    const status = baseStatus({
      tokens: { input: 500, output: 300, cacheRead: 0, cacheWrite: 0, total: 800 },
    });

    const detail = sessionUsageDetail(status, undefined, undefined);

    const labels = detail.tokenRows.map((r) => r.label);
    expect(labels).not.toContain("Cache read");
    expect(labels).not.toContain("Cache write");
  });

  it("handles unknown context percent gracefully", () => {
    const status = baseStatus({
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
      contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
    });

    const detail = sessionUsageDetail(status, undefined, undefined);

    expect(detail.tokenRows.find((r) => r.label === "Context")?.value).toBe("? / 200k");
  });
});
