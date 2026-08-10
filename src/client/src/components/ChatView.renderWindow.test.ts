// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatLine } from "./shared";
import { ChatView } from "./ChatView";

afterEach(() => {
  document.body.replaceChildren();
});

function transcript(count: number): ChatLine[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text: `Message ${String(index)}` }],
  } satisfies ChatLine));
}

async function mountTranscript(count = 24): Promise<{ view: ChatView; loadMore: ReturnType<typeof vi.fn> }> {
  const view = new ChatView();
  const loadMore = vi.fn();
  view.sessionId = "session-1";
  view.messages = transcript(count);
  view.messageStart = 100;
  view.messageEnd = 100 + count;
  view.messageTotal = 200;
  view.hasMore = true;
  view.onLoadMore = loadMore;
  document.body.append(view);
  await view.updateComplete;
  return { view, loadMore };
}

function renderedMessageIndexes(view: ChatView): number[] {
  return Array.from(view.shadowRoot?.querySelectorAll<HTMLElement>("article.msg") ?? [])
    .map((article) => Number(article.dataset["index"]));
}

function historyButton(view: ChatView): HTMLButtonElement {
  const button = view.shadowRoot?.querySelector<HTMLButtonElement>(".history-load-button");
  if (button === null || button === undefined) throw new Error("Expected an earlier-history button");
  return button;
}

describe("ChatView bounded transcript rendering", () => {
  it("renders only the latest ten loaded groups initially", async () => {
    const { view } = await mountTranscript();

    expect(view.messages).toHaveLength(24);
    expect(renderedMessageIndexes(view)).toEqual(Array.from({ length: 10 }, (_, index) => 114 + index));
    expect(historyButton(view).textContent.trim()).toBe("Show earlier messages");
  });

  it("reveals loaded groups before requesting an earlier server page", async () => {
    const { view, loadMore } = await mountTranscript();

    historyButton(view).click();
    await view.updateComplete;
    expect(renderedMessageIndexes(view)).toEqual(Array.from({ length: 20 }, (_, index) => 104 + index));
    expect(loadMore).not.toHaveBeenCalled();

    historyButton(view).click();
    await view.updateComplete;
    expect(renderedMessageIndexes(view)).toEqual(Array.from({ length: 24 }, (_, index) => 100 + index));
    expect(loadMore).not.toHaveBeenCalled();

    historyButton(view).click();
    expect(loadMore).toHaveBeenCalledOnce();
  });

  it("reveals another loaded chunk when the user scrolls near the top", async () => {
    const { view, loadMore } = await mountTranscript();
    await flushFrames();
    const chat = view.shadowRoot?.querySelector<HTMLElement>(".chat");
    if (chat === null || chat === undefined) throw new Error("Expected the chat scroller");
    let scrollTop = 100;
    Object.defineProperties(chat, {
      scrollHeight: { configurable: true, get: () => 5000 },
      clientHeight: { configurable: true, get: () => 800 },
      scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } },
    });

    chat.dispatchEvent(new Event("scroll"));
    await flushFrame();
    await view.updateComplete;

    expect(renderedMessageIndexes(view)).toEqual(Array.from({ length: 20 }, (_, index) => 104 + index));
    expect(loadMore).not.toHaveBeenCalled();
  });

  it("keeps a pinned viewport at the bottom while revealing a loaded chunk", async () => {
    const { view } = await mountTranscript();
    const chat = view.shadowRoot?.querySelector<HTMLElement>(".chat");
    if (chat === null || chat === undefined) throw new Error("Expected the chat scroller");
    let scrollTop = 1000;
    Object.defineProperties(chat, {
      scrollHeight: { configurable: true, get: () => renderedMessageIndexes(view).length * 100 },
      clientHeight: { configurable: true, get: () => 500 },
      scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } },
    });

    historyButton(view).click();
    await view.updateComplete;
    await flushFrame();

    expect(renderedMessageIndexes(view)).toHaveLength(20);
    expect(scrollTop).toBe(chat.scrollHeight);
  });

  it("does not move a pending restore while an earlier page is loading", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messages = transcript(4);
    view.messageEnd = 4;
    view.messageTotal = 8;
    view.hasMore = true;
    view.loadingMore = true;
    document.body.append(view);
    await view.updateComplete;
    const chat = view.shadowRoot?.querySelector<HTMLElement>(".chat");
    if (chat === null || chat === undefined) throw new Error("Expected the chat scroller");
    let scrollTop = 500;
    Object.defineProperties(chat, {
      scrollHeight: { configurable: true, get: () => 2000 },
      clientHeight: { configurable: true, get: () => 800 },
      scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } },
    });
    const handleScrollRestoreResult: unknown = Reflect.get(view, "handleScrollRestoreResult");
    if (typeof handleScrollRestoreResult !== "function") throw new Error("ChatView.handleScrollRestoreResult is not callable");

    handleScrollRestoreResult.call(view, "session-1", {
      status: "missing",
      position: { mode: "anchor", anchorId: "m:0", offset: 0 },
    });

    expect(scrollTop).toBe(500);
  });

  it("restores the initial tail bound for a different session", async () => {
    const { view } = await mountTranscript();
    historyButton(view).click();
    await view.updateComplete;
    expect(renderedMessageIndexes(view)).toHaveLength(20);

    view.sessionId = "session-2";
    await view.updateComplete;

    expect(renderedMessageIndexes(view)).toEqual(Array.from({ length: 10 }, (_, index) => 114 + index));
  });

  it("does not treat a session switch as a local prepend", () => {
    const view = new ChatView();
    if (!Reflect.set(view, "renderedGroupStart", 100)) throw new Error("Could not set the rendered group start");
    const isPrependingMessages: unknown = Reflect.get(view, "isPrependingMessages");
    if (typeof isPrependingMessages !== "function") throw new Error("ChatView.isPrependingMessages is not callable");

    expect(isPrependingMessages.call(view, new Map<string, unknown>([
      ["sessionId", "session-1"],
      ["renderedGroupStart", 114],
    ]))).toBe(false);
  });

  it("re-enables scroll saving when a prepend restore is cancelled", () => {
    const view = new ChatView();
    if (!Reflect.set(view, "suppressScrollSave", true)) throw new Error("Could not suppress scroll saving");
    const cancelPrependRestore: unknown = Reflect.get(view, "cancelPrependRestore");
    if (typeof cancelPrependRestore !== "function") throw new Error("ChatView.cancelPrependRestore is not callable");

    cancelPrependRestore.call(view);

    expect(Reflect.get(view, "suppressScrollSave")).toBe(false);
  });
});

async function flushFrames(): Promise<void> {
  await flushFrame();
  await flushFrame();
}

async function flushFrame(): Promise<void> {
  await new Promise((resolve) => { requestAnimationFrame(() => { resolve(undefined); }); });
}
