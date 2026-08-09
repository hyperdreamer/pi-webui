// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { markdownHtmlCacheSize } from "../formatting/markdown";
import { FormattedText, LIVE_PLAIN_TEXT_MIN_CHARS, shouldRenderLivePlainText } from "./FormattedText";

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

function markdownTailOfLength(chars: number): string {
  const block = "## Heading\n\nParagraph text for the streamed answer.\n\n- bullet item\n\n";
  return block.repeat(Math.ceil(chars / block.length)).slice(0, chars);
}

function formattedContainer(element: FormattedText): HTMLElement {
  const container = element.shadowRoot?.querySelector<HTMLElement>(".formatted");
  if (container === null || container === undefined) throw new Error("Expected a .formatted container");
  return container;
}

describe("shouldRenderLivePlainText", () => {
  it("keeps markdown for a live tail just below the threshold", () => {
    expect(shouldRenderLivePlainText({ text: "a".repeat(LIVE_PLAIN_TEXT_MIN_CHARS - 1), live: true })).toBe(false);
  });

  it("switches to plain text once a live tail reaches the threshold", () => {
    expect(shouldRenderLivePlainText({ text: "a".repeat(LIVE_PLAIN_TEXT_MIN_CHARS), live: true })).toBe(true);
  });

  it("never switches to plain text for settled text, however large", () => {
    expect(shouldRenderLivePlainText({ text: "a".repeat(LIVE_PLAIN_TEXT_MIN_CHARS * 4), live: false })).toBe(false);
  });
});

describe("FormattedText large live tail", () => {
  it("renders a large live tail as plain text instead of parsed markdown", async () => {
    const element = await mountFormattedText(markdownTailOfLength(LIVE_PLAIN_TEXT_MIN_CHARS), true);

    const container = formattedContainer(element);
    expect(container.querySelectorAll("*").length).toBe(0);
    expect(container.textContent).toContain("## Heading");
  });

  it("preserves line structure while rendering a large live tail as plain text", async () => {
    const element = await mountFormattedText(markdownTailOfLength(LIVE_PLAIN_TEXT_MIN_CHARS), true);

    expect(formattedContainer(element).classList.contains("plain")).toBe(true);
    expect(FormattedText.styles.toString()).toContain("pre-wrap");
  });

  it("still renders markdown for a live tail below the threshold", async () => {
    const element = await mountFormattedText(markdownTailOfLength(LIVE_PLAIN_TEXT_MIN_CHARS - 1), true);

    expect(formattedContainer(element).querySelectorAll("h2").length).toBeGreaterThan(0);
  });

  it("upgrades a large tail to parsed markdown once streaming ends", async () => {
    const element = await mountFormattedText(markdownTailOfLength(LIVE_PLAIN_TEXT_MIN_CHARS), true);
    expect(formattedContainer(element).querySelectorAll("*").length).toBe(0);

    element.live = false;
    await element.updateComplete;

    const container = formattedContainer(element);
    expect(container.classList.contains("plain")).toBe(false);
    expect(container.querySelectorAll("h2").length).toBeGreaterThan(0);
  });

  it("does not reparse markdown as a large live tail grows", async () => {
    const element = await mountFormattedText(markdownTailOfLength(LIVE_PLAIN_TEXT_MIN_CHARS), true);
    const before = markdownHtmlCacheSize();

    for (let append = 0; append < 5; append += 1) {
      element.text = `${element.text} token${String(append)}`;
      await element.updateComplete;
      expect(formattedContainer(element).querySelectorAll("*").length).toBe(0);
    }

    expect(markdownHtmlCacheSize()).toBe(before);
  });

  it("does not build code-block wrappers while a large live tail streams, then builds them on completion", async () => {
    const tail = `${markdownTailOfLength(LIVE_PLAIN_TEXT_MIN_CHARS)}\n\n\`\`\`ts\nconst pending = 1;\n\`\`\`\n`;
    const element = await mountFormattedText(tail, true);

    expect(formattedContainer(element).querySelector(".code-block-wrapper")).toBeNull();

    element.live = false;
    await element.updateComplete;

    expect(formattedContainer(element).querySelector(".code-block-wrapper .code-copy-button")).not.toBeNull();
  });
});
