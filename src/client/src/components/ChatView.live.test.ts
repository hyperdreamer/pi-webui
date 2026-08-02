// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import type { SessionStatus } from "../api";
import type { ChatLine } from "./shared";
import { ChatView } from "./ChatView";
import type { FormattedText } from "./FormattedText";

afterEach(() => {
  document.body.replaceChildren();
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

async function mountChatView(isStreaming: boolean): Promise<ChatView> {
  const view = new ChatView();
  view.messages = messages;
  view.status = baseStatus(isStreaming);
  document.body.append(view);
  await view.updateComplete;
  return view;
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
});
