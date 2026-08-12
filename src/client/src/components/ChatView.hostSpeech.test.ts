// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSpeechStatus, SessionStatus } from "../api";
import type { ChatLine } from "./shared";
import { ChatView } from "./ChatView";

afterEach(() => {
  document.body.replaceChildren();
});

function baseStatus(isStreaming = false): SessionStatus {
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

const availableStatus: HostSpeechStatus = { available: true, voices: [] };
const unavailableStatus: HostSpeechStatus = { available: false, reason: "No speech service on this host.", voices: [] };

const transcript: ChatLine[] = [
  { role: "user", parts: [{ type: "text", text: "Question" }] },
  { role: "assistant", parts: [{ type: "text", text: "Hello **world**" }] },
];

interface MountOptions {
  messages?: ChatLine[];
  status?: SessionStatus;
  hostSpeechStatus?: HostSpeechStatus;
  activeHostSpeechMessageKey?: string;
  hostSpeechError?: string;
  onToggleHostSpeech?: (target: { message: ChatLine; messageKey: string; text: string }) => void;
}

async function mountChatView(options: MountOptions = {}): Promise<ChatView> {
  const view = new ChatView();
  view.messages = options.messages ?? transcript;
  view.status = options.status ?? baseStatus(false);
  if (options.hostSpeechStatus !== undefined) view.hostSpeechStatus = options.hostSpeechStatus;
  if (options.activeHostSpeechMessageKey !== undefined) view.activeHostSpeechMessageKey = options.activeHostSpeechMessageKey;
  if (options.hostSpeechError !== undefined) view.hostSpeechError = options.hostSpeechError;
  if (options.onToggleHostSpeech !== undefined) view.onToggleHostSpeech = options.onToggleHostSpeech;
  document.body.append(view);
  await view.updateComplete;
  return view;
}

function hostSpeechButtons(view: ChatView): HTMLButtonElement[] {
  return Array.from(view.shadowRoot?.querySelectorAll<HTMLButtonElement>("[data-message-action='host-speech']") ?? []);
}

function hostSpeechButton(view: ChatView): HTMLButtonElement {
  const button = hostSpeechButtons(view)[0];
  if (button === undefined) throw new Error("Expected a host-speech action button");
  return button;
}

describe("ChatView host speech controls", () => {
  it("renders an enabled icon-only Listen action for the finalized assistant reply", async () => {
    const onToggleHostSpeech = vi.fn();
    const view = await mountChatView({ hostSpeechStatus: availableStatus, onToggleHostSpeech });

    const buttons = hostSpeechButtons(view);
    expect(buttons).toHaveLength(1);
    const button = hostSpeechButton(view);
    expect(button.title).toBe("Listen to assistant reply");
    expect(button.getAttribute("aria-label")).toBe("Listen to assistant reply");
    expect(button.disabled).toBe(false);
    expect(button.classList.contains("msg-action")).toBe(true);
    expect(button.classList.contains("host-speech-action")).toBe(true);
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(button.querySelector("svg")?.getAttribute("focusable")).toBe("false");
    expect(button.querySelector("svg path")).not.toBeNull();
  });

  it("calls the toggle callback with the message, absolute-index key, and projected prose on click", async () => {
    const onToggleHostSpeech = vi.fn();
    const view = await mountChatView({ hostSpeechStatus: availableStatus, onToggleHostSpeech });
    const stopPropagation = vi.spyOn(Event.prototype, "stopPropagation");
    try {
      hostSpeechButton(view).click();
    } finally {
      stopPropagation.mockRestore();
    }

    expect(onToggleHostSpeech).toHaveBeenCalledExactlyOnceWith({
      message: transcript[1],
      messageKey: "assistant-index:1",
      text: "Hello world",
    });
  });

  it("keeps focus on the control and swaps it to Stop in place for the exact active message key", async () => {
    const view = await mountChatView({ hostSpeechStatus: availableStatus, onToggleHostSpeech: vi.fn() });
    const listenButton = hostSpeechButton(view);
    listenButton.focus();
    expect(view.shadowRoot?.activeElement).toBe(listenButton);

    view.activeHostSpeechMessageKey = "assistant-index:1";
    await view.updateComplete;

    const stopButton = hostSpeechButton(view);
    expect(stopButton).toBe(listenButton);
    expect(stopButton.title).toBe("Stop reading assistant reply");
    expect(stopButton.getAttribute("aria-label")).toBe("Stop reading assistant reply");
    expect(stopButton.disabled).toBe(false);
    expect(stopButton.querySelector("rect")).not.toBeNull();
    expect(view.shadowRoot?.activeElement).toBe(stopButton);
  });

  it("disables Listen with the availability reason when host speech is unavailable", async () => {
    const onToggleHostSpeech = vi.fn();
    const view = await mountChatView({ hostSpeechStatus: unavailableStatus, onToggleHostSpeech });

    const button = hostSpeechButton(view);
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Listen to assistant reply — No speech service on this host.");
    expect(button.getAttribute("aria-label")).toBe("Listen to assistant reply");

    button.click();
    expect(onToggleHostSpeech).not.toHaveBeenCalled();
  });

  it("keeps Listen absent while the trailing reply is streaming and present for finalized replies", async () => {
    const messages: ChatLine[] = [
      { role: "user", parts: [{ type: "text", text: "Question" }] },
      { role: "assistant", parts: [{ type: "text", text: "Earlier answer" }] },
      { role: "assistant", parts: [{ type: "text", text: "Partial answer" }] },
    ];
    const view = await mountChatView({
      messages,
      status: baseStatus(true),
      hostSpeechStatus: availableStatus,
      onToggleHostSpeech: vi.fn(),
    });

    const buttons = hostSpeechButtons(view);
    expect(buttons).toHaveLength(1);
    const button = buttons[0];
    expect(button?.getAttribute("aria-label")).toBe("Listen to assistant reply");
    const article = button?.closest("article, section");
    expect(article?.getAttribute("data-index")).toBe("1");

    // The exact active key still renders an enabled Stop on the streaming tail.
    view.activeHostSpeechMessageKey = "assistant-index:2";
    await view.updateComplete;
    expect(hostSpeechButtons(view)).toHaveLength(2);
    const tailButton = hostSpeechButtons(view).find((button) => button.title === "Stop reading assistant reply");
    expect(tailButton).toBeDefined();
    expect(tailButton?.disabled).toBe(false);
  });

  it("keeps existing message actions unchanged beside the host-speech control", async () => {
    const view = await mountChatView({ hostSpeechStatus: availableStatus, onToggleHostSpeech: vi.fn() });

    const copyButton = Array.from(view.shadowRoot?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => button.getAttribute("aria-label") === "Copy assistant message");
    if (copyButton === undefined) throw new Error("Expected a copy button");
    const speechButton = hostSpeechButton(view);
    expect(speechButton.compareDocumentPosition(copyButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("shows the unframed transient error notice near the chat top only while nonempty", async () => {
    const view = await mountChatView({ hostSpeechError: "Could not start speech." });

    const notice = view.shadowRoot?.querySelector<HTMLElement>(".host-speech-error");
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.textContent).toBe("Could not start speech.");
    expect(notice?.closest(".top-notices")).not.toBeNull();

    view.hostSpeechError = "";
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector(".host-speech-error")).toBeNull();
  });
});
