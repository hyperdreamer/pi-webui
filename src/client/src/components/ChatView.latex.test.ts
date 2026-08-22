// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import type { SessionStatus } from "../api";
import { ChatView } from "./ChatView";
import type { FormattedText } from "./FormattedText";
import type { ChatLine } from "./shared";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

function baseStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionId: "latex-session",
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

async function mountChatView(messages: ChatLine[], status: SessionStatus = baseStatus()): Promise<ChatView> {
  const view = new ChatView();
  view.sessionId = status.sessionId;
  view.messages = messages;
  view.messageEnd = messages.length;
  view.messageTotal = messages.length;
  view.status = status;
  document.body.append(view);
  await view.updateComplete;
  await settleFormattedChildren(view);
  return view;
}

function formattedChildren(view: ChatView): FormattedText[] {
  return Array.from(view.shadowRoot?.querySelectorAll<FormattedText>("formatted-text") ?? []);
}

async function settleFormattedChildren(view: ChatView): Promise<void> {
  await Promise.all(formattedChildren(view).map(async (child) => {
    await child.updateComplete;
  }));
}

async function openEventGroup(view: ChatView): Promise<void> {
  const details = view.shadowRoot?.querySelector<HTMLDetailsElement>("details.event-group");
  if (details === null || details === undefined) throw new Error("Expected the technical event group");
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
  await view.updateComplete;
  await settleFormattedChildren(view);
}

function assertKaTeXSurface(element: FormattedText): void {
  expect(element.shadowRoot?.querySelector(".katex")).not.toBeNull();
  expect(element.shadowRoot?.querySelector("math")).not.toBeNull();
}

describe("ChatView formatted LaTeX surfaces", () => {
  it("renders every formatted ChatView route through the shared KaTeX boundary", async () => {
    const messages: ChatLine[] = [
      { role: "user", parts: [{ type: "text", text: "$x^2$" }] },
      { role: "assistant", parts: [{ type: "text", text: "$x^2$" }] },
      { role: "bash", parts: [{ type: "text", text: "$never$" }] },
      {
        role: "assistant",
        parts: [{
          type: "skillInvocation",
          name: "math-skill",
          location: "/skills/math.md",
          content: ["skill output", "$$", "\\frac{1}{2}", "$$"].join("\n"),
        }],
      },
      { role: "assistant", parts: [{ type: "thinking", text: "\\(y_1\\)" }] },
      {
        role: "tool",
        parts: [{
          type: "toolResult",
          toolName: "calculate",
          text: ["result", "\\[", "\\sum_{i=1}^{n} i", "\\]"].join("\n"),
          isError: false,
        }],
      },
    ];
    const view = await mountChatView(messages, baseStatus({ queuedMessages: [{ kind: "followUp", text: "$q$" }] }));

    await openEventGroup(view);
    const children = formattedChildren(view);
    expect(children.map((child) => child.text)).toEqual([
      "$x^2$",
      "$x^2$",
      ["skill output", "$$", "\\frac{1}{2}", "$$"].join("\n"),
      "\\(y_1\\)",
      ["result", "\\[", "\\sum_{i=1}^{n} i", "\\]"].join("\n"),
      "$q$",
    ]);
    expect(children).toHaveLength(6);
    for (const child of children) assertKaTeXSurface(child);

    const bashArticle = view.shadowRoot?.querySelector<HTMLElement>("article.msg.bash");
    if (bashArticle === null || bashArticle === undefined) throw new Error("Expected the bash article");
    expect(bashArticle.querySelector<HTMLElement>(".shell-output")?.textContent).toBe("$never$");
    expect(bashArticle.querySelector("formatted-text")).toBeNull();
  });

  it("keeps a streaming assistant math tail exact and plain until settlement", async () => {
    const messages: ChatLine[] = [
      { role: "user", parts: [{ type: "text", text: "Question" }] },
      { role: "assistant", parts: [{ type: "text", text: "$x^2$" }] },
    ];
    const view = await mountChatView(messages, baseStatus({ isStreaming: true }));
    const live = formattedChildren(view).at(-1);
    if (live === undefined) throw new Error("Expected the trailing formatted-text element");
    await live.updateComplete;

    expect(live.live).toBe(true);
    const liveContainer = live.shadowRoot?.querySelector<HTMLElement>(".formatted");
    expect(liveContainer?.classList.contains("plain")).toBe(true);
    expect(liveContainer?.textContent).toBe("$x^2$");
    expect(liveContainer?.querySelector(".katex")).toBeNull();
    expect(liveContainer?.querySelector("math")).toBeNull();

    view.status = baseStatus();
    await view.updateComplete;
    await settleFormattedChildren(view);

    const settled = formattedChildren(view).at(-1);
    if (settled === undefined) throw new Error("Expected the settled formatted-text element");
    expect(settled.live).toBe(false);
    assertKaTeXSurface(settled);
    expect(settled.shadowRoot?.querySelector(".formatted.plain")).toBeNull();
  });
});
