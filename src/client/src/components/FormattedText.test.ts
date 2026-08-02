// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { markdownHtmlCacheSize } from "../formatting/markdown";
import { FormattedText } from "./FormattedText";

afterEach(() => {
  document.body.replaceChildren();
});

async function mountFormattedText(text: string, live: boolean): Promise<FormattedText> {
  const element = new FormattedText();
  element.text = text;
  element.live = live;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

describe("FormattedText live rendering", () => {
  it("does not grow the markdown cache while live is true, then caches once live is false", async () => {
    const before = markdownHtmlCacheSize();

    const liveText = `live-tail-${String(Date.now())}-${String(Math.random())}`;
    await mountFormattedText(liveText, true);

    expect(markdownHtmlCacheSize()).toBe(before);

    const idleText = `idle-message-${String(Date.now())}-${String(Math.random())}`;
    await mountFormattedText(idleText, false);

    expect(markdownHtmlCacheSize()).toBe(before + 1);
  });
});
