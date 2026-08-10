import { describe, expect, it } from "vitest";
import type { ChatGroup } from "./chatGroups";
import {
  boundedLiveEventMessages,
  chatEventAnchorIndex,
  clampRenderedGroupStart,
  earlierRenderedGroupStart,
  hasEarlierRenderedGroups,
  initialRenderedGroupStart,
  renderedChatGroups,
} from "./chatRenderWindow";

function messageGroups(count: number, offset = 0): ChatGroup[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "message",
    index: offset + index,
    message: { role: "assistant", parts: [{ type: "text", text: String(index) }] },
  }));
}

describe("chat render window", () => {
  it("starts at the latest ten groups and expands ten groups at a time", () => {
    const groups = messageGroups(24, 100);
    const initial = initialRenderedGroupStart(groups);

    expect(initial).toBe(114);
    expect(renderedChatGroups(groups, initial)).toHaveLength(10);
    expect(hasEarlierRenderedGroups(groups, initial)).toBe(true);
    expect(earlierRenderedGroupStart(groups, initial)).toBe(104);
    expect(earlierRenderedGroupStart(groups, 104)).toBe(100);
    expect(hasEarlierRenderedGroups(groups, 100)).toBe(false);
  });

  it("includes a whole event group when the window starts inside it", () => {
    const groups: ChatGroup[] = [
      { kind: "message", index: 10, message: { role: "user", parts: [{ type: "text", text: "start" }] } },
      { kind: "group", startIndex: 11, endIndex: 20, messages: [] },
      { kind: "message", index: 21, message: { role: "assistant", parts: [{ type: "text", text: "end" }] } },
    ];

    expect(renderedChatGroups(groups, 18)).toEqual(groups.slice(1));
  });

  it("keeps a valid absolute start across prepends and clamps after replacement", () => {
    expect(clampRenderedGroupStart(messageGroups(20, 80), 95)).toBe(95);
    expect(clampRenderedGroupStart(messageGroups(10, 100), 95)).toBe(100);
    expect(clampRenderedGroupStart(messageGroups(10, 100), 200)).toBe(100);
  });

  it("handles empty windows and starts that are past the loaded range", () => {
    expect(initialRenderedGroupStart([])).toBeUndefined();
    expect(renderedChatGroups([], 10)).toEqual([]);
    expect(renderedChatGroups(messageGroups(3, 10), 99)).toEqual([]);
    expect(earlierRenderedGroupStart([], 10)).toBeUndefined();
  });

  it("parses only canonical event scroll anchors", () => {
    expect(chatEventAnchorIndex("e:0")).toBe(0);
    expect(chatEventAnchorIndex("e:42")).toBe(42);
    expect(chatEventAnchorIndex("e:04")).toBeUndefined();
    expect(chatEventAnchorIndex("g:4")).toBeUndefined();
  });

  it("bounds a live event body to its latest eight messages", () => {
    const messages = Array.from({ length: 20 }, (_, index) => index);

    expect(boundedLiveEventMessages(messages, false)).toEqual({
      messages: [12, 13, 14, 15, 16, 17, 18, 19],
      startOffset: 12,
      hiddenCount: 12,
    });
    expect(boundedLiveEventMessages(messages, true)).toEqual({ messages, startOffset: 0, hiddenCount: 0 });
  });
});
