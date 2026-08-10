// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../api";
import { chatScrollStorageKey } from "../chatScrollPosition";
import type { ChatLine } from "./shared";
import { ChatView } from "./ChatView";
import type { FormattedText } from "./FormattedText";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

function baseStatus(isStreaming: boolean): SessionStatus {
  return {
    sessionId: "session-1",
    isStreaming,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}

const messages: ChatLine[] = [
  { role: "user", parts: [{ type: "text", text: "Question" }] },
  { role: "assistant", parts: [{ type: "text", text: "Partial answer" }] },
];

function liveEventMessages(count: number): ChatLine[] {
  return Array.from({ length: count }, (_, index) => ({
    role: "tool",
    parts: [{ type: "toolResult", toolName: "read", text: `Result ${String(index)}`, isError: false }],
  } satisfies ChatLine));
}

async function mountChatView(isStreaming: boolean): Promise<ChatView> {
  const view = new ChatView();
  view.messages = messages;
  view.status = baseStatus(isStreaming);
  document.body.append(view);
  await view.updateComplete;
  return view;
}

async function mountLiveEventView(count: number, hasMore = false): Promise<{ view: ChatView; loadMore: ReturnType<typeof vi.fn> }> {
  const view = new ChatView();
  const loadMore = vi.fn();
  view.sessionId = "session-1";
  view.messages = liveEventMessages(count);
  view.messageEnd = count;
  view.messageTotal = hasMore ? count + 100 : count;
  view.hasMore = hasMore;
  view.onLoadMore = loadMore;
  view.status = baseStatus(true);
  document.body.append(view);
  await view.updateComplete;
  return { view, loadMore };
}

function trailingFormattedText(view: ChatView): FormattedText {
  const nodes = view.shadowRoot?.querySelectorAll<FormattedText>("formatted-text") ?? [];
  const last = nodes[nodes.length - 1];
  if (last === undefined) throw new Error("Expected a trailing formatted-text element");
  return last;
}

describe("ChatView live streaming tail", () => {
  it("marks the trailing assistant formatted-text live while the session is streaming", async () => {
    const view = await mountChatView(true);

    expect(trailingFormattedText(view).live).toBe(true);
  });

  it("does not mark the trailing assistant formatted-text live when the session is idle", async () => {
    const view = await mountChatView(false);

    expect(trailingFormattedText(view).live).toBe(false);
  });

  it("bounds an automatically opened live event group until the user expands it", async () => {
    const { view } = await mountLiveEventView(20);

    const sections = () => Array.from(view.shadowRoot?.querySelectorAll<HTMLElement>(".group-body > section") ?? []);
    expect(sections().map((section) => Number(section.dataset["index"]))).toEqual(Array.from({ length: 8 }, (_, index) => 12 + index));

    const showAll = Array.from(view.shadowRoot?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => button.textContent.trim() === "Show all 20 events");
    if (showAll === undefined) throw new Error("Expected a live-event expansion button");
    showAll.focus();
    showAll.click();
    await view.updateComplete;

    expect(sections()).toHaveLength(20);
    const showLatest = Array.from(view.shadowRoot?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => button.textContent.trim() === "Show latest 8 events");
    expect(showLatest).toBeDefined();
    expect(view.shadowRoot?.activeElement).toBe(showLatest);

    showLatest?.click();
    await view.updateComplete;
    expect(sections()).toHaveLength(8);
    const showAllAgain = Array.from(view.shadowRoot?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => button.textContent.trim() === "Show all 20 events");
    expect(showAllAgain).toBeDefined();
    expect(view.shadowRoot?.activeElement).toBe(showAllAgain);

    showAllAgain?.click();
    await view.updateComplete;
    expect(sections()).toHaveLength(20);

    view.messages = liveEventMessages(22);
    view.messageEnd = 22;
    view.messageTotal = 22;
    await view.updateComplete;
    expect(sections()).toHaveLength(22);

    view.sessionId = "session-2";
    await view.updateComplete;
    expect(sections()).toHaveLength(8);
    expect(Array.from(view.shadowRoot?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .some((button) => button.textContent.trim() === "Show all 22 events")).toBe(true);
  });

  it("keeps a growing live event group bounded and omits the toggle at the limit", async () => {
    const { view } = await mountLiveEventView(8);
    const sections = () => Array.from(view.shadowRoot?.querySelectorAll<HTMLElement>(".group-body > section") ?? []);
    expect(sections()).toHaveLength(8);
    expect(view.shadowRoot?.querySelector(".event-group-expand")).toBeNull();

    view.messages = liveEventMessages(20);
    view.messageEnd = 20;
    view.messageTotal = 20;
    await view.updateComplete;

    expect(sections().map((section) => Number(section.dataset["index"]))).toEqual(Array.from({ length: 8 }, (_, index) => 12 + index));
    expect(view.shadowRoot?.querySelector(".event-group-expand")).not.toBeNull();
  });

  it("reveals a bounded live event needed by scroll restoration before falling back", async () => {
    const { view, loadMore } = await mountLiveEventView(20);
    const chat = view.shadowRoot?.querySelector<HTMLElement>(".chat");
    if (chat === null || chat === undefined) throw new Error("Expected the chat scroller");
    let scrollTop = 0;
    Object.defineProperties(chat, {
      scrollHeight: { configurable: true, get: () => 2000 },
      clientHeight: { configurable: true, get: () => 800 },
      scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } },
    });
    localStorage.setItem(chatScrollStorageKey(view.sessionId), JSON.stringify({ mode: "anchor", anchorId: "e:5", offset: 0 }));

    view.restoreScrollPosition();
    await flushFrames();
    await view.updateComplete;
    await flushFrames();

    expect(view.shadowRoot?.querySelectorAll(".group-body > section")).toHaveLength(20);
    expect(loadMore).not.toHaveBeenCalled();
  });
});

async function flushFrames(): Promise<void> {
  await new Promise((resolve) => { requestAnimationFrame(() => { resolve(undefined); }); });
  await new Promise((resolve) => { requestAnimationFrame(() => { resolve(undefined); }); });
}
