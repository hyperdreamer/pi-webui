// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import type { ChatLine } from "./shared";
import { ChatView } from "./ChatView";
import type { ChatMinimap } from "./ChatMinimap";

/**
 * Counts Lit render passes.
 *
 * A pass rebuilds every message template, so this is the cost that made fast
 * scrolling on a long transcript saturate the main thread. Keyed `repeat()`
 * reuses DOM elements across passes, so element identity cannot detect one;
 * overriding `render` is the reliable observation point.
 */
class CountingChatView extends ChatView {
  renderCount = 0;

  override render() {
    this.renderCount += 1;
    return super.render();
  }
}

customElements.define("chat-view-scroll-probe", CountingChatView);

afterEach(() => {
  document.body.replaceChildren();
});

function transcript(messageCount: number): ChatLine[] {
  return Array.from({ length: messageCount }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text: `Message ${String(index)}` }],
  } satisfies ChatLine));
}

/**
 * jsdom reports zero-sized layout, so the scroll metrics the component reads are
 * stubbed to model a transcript taller than its viewport.
 *
 * The view mounts pinned to the bottom, schedules a scroll-to-bottom, and debounces
 * a minimap marker measurement. The helper settles all of that and scrolls up once
 * to release the pin, so the assertions below observe steady-state scrolling rather
 * than one-time mount transitions.
 */
async function mountScrollableChatView(messageCount = 40): Promise<{ view: CountingChatView; setScrollTop: (value: number) => void }> {
  const view = new CountingChatView();
  view.messages = transcript(messageCount);
  view.messageTotal = messageCount;
  document.body.append(view);
  await view.updateComplete;

  let scrollTop = 0;
  const chat = view.shadowRoot?.querySelector<HTMLElement>(".chat");
  if (chat === null || chat === undefined) throw new Error("Expected a .chat scroller");
  Object.defineProperties(chat, {
    scrollHeight: { configurable: true, get: () => 20_000 },
    clientHeight: { configurable: true, get: () => 800 },
    scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } },
  });

  const setScrollTop = (value: number) => {
    scrollTop = value;
    chat.dispatchEvent(new Event("scroll"));
  };

  await flushFrames();
  setScrollTop(12_000);
  await flushFrames();
  // Let the debounced marker measurement land before the caller takes a baseline.
  await new Promise((resolve) => { setTimeout(resolve, 250); });
  await view.updateComplete;

  return { view, setScrollTop };
}

function minimapOf(view: ChatView): ChatMinimap {
  const minimap = view.shadowRoot?.querySelector<ChatMinimap>("chat-minimap");
  if (minimap === null || minimap === undefined) throw new Error("Expected a chat-minimap element");
  return minimap;
}

/** Run the callbacks queued via requestAnimationFrame, as one browser frame would. */
async function flushFrames(): Promise<void> {
  await new Promise((resolve) => { requestAnimationFrame(() => { resolve(undefined); }); });
  await new Promise((resolve) => { requestAnimationFrame(() => { resolve(undefined); }); });
}

describe("ChatView scroll cost", () => {
  it("does not re-render the transcript while the user scrolls", async () => {
    const { view, setScrollTop } = await mountScrollableChatView();
    const before = view.renderCount;

    for (let offset = 8000; offset >= 1000; offset -= 500) setScrollTop(offset);
    await flushFrames();
    await view.updateComplete;

    expect(view.renderCount).toBe(before);
  });

  it("still updates the minimap rail geometry as the user scrolls", async () => {
    const { view, setScrollTop } = await mountScrollableChatView();

    setScrollTop(9600);
    await flushFrames();

    // scrollTop 9600 over a scrollable range of 20000 - 800.
    expect(minimapOf(view).scrollRatio).toBeCloseTo(0.5, 2);
  });

  it("coalesces a burst of scroll events into a single frame of rail work", async () => {
    const { view, setScrollTop } = await mountScrollableChatView();
    const before = view.renderCount;

    for (let offset = 5000; offset >= 1000; offset -= 250) setScrollTop(offset);
    await flushFrames();
    await view.updateComplete;

    // 17 scroll events, no render passes, and the rail still lands on the last
    // position: the per-event work is bounded by frames rather than by events.
    expect(view.renderCount).toBe(before);
    expect(minimapOf(view).scrollRatio).toBeCloseTo(1000 / 19_200, 4);
  });

  it("keeps the rail in sync after a transcript re-render replaces the minimap bindings", async () => {
    const { view, setScrollTop } = await mountScrollableChatView();
    setScrollTop(9600);
    await flushFrames();

    view.messages = transcript(41);
    view.messageTotal = 41;
    await view.updateComplete;

    expect(minimapOf(view).scrollRatio).toBeCloseTo(0.5, 2);
  });
});
