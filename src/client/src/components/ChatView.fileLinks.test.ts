// @vitest-environment jsdom

import { afterEach, expect, it } from "vitest";
import type { SessionStatus } from "../api";
import type { ChatLine } from "./shared";
import { ChatView } from "./ChatView";
import type { FormattedText } from "./FormattedText";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

const baseStatus: SessionStatus = {
  sessionId: "s1",
  isStreaming: false,
  isCompacting: false,
  isBashRunning: false,
  pendingMessageCount: 0,
  queuedMessages: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
};

const messages: ChatLine[] = [
  { role: "user", parts: [{ type: "text", text: "[user](user.html)" }] },
  { role: "assistant", parts: [{ type: "text", text: "[assistant](assistant.html)" }] },
  { role: "assistant", parts: [{ type: "thinking", text: "[thinking](thinking.html)" }] },
  { role: "assistant", parts: [{ type: "skillInvocation", name: "skill", location: "/skill/SKILL.md", content: "[skill](skill.html)" }] },
  { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "[tool](tool.html)", isError: false }] },
  { role: "bash", parts: [{ type: "text", text: "[bash](bash.html)" }] },
];

function children(view: ChatView): FormattedText[] {
  return Array.from(view.shadowRoot?.querySelectorAll<FormattedText>("formatted-text") ?? []);
}

async function settled(view: ChatView): Promise<void> {
  await view.updateComplete;
  await Promise.all(children(view).map((child) => child.updateComplete));
}

async function mounted(): Promise<ChatView> {
  const view = new ChatView();
  view.sessionId = "s1";
  view.messages = messages;
  view.messageEnd = messages.length;
  view.messageTotal = messages.length;
  view.status = { ...baseStatus, queuedMessages: [{ kind: "followUp", text: "[queued](queued.html)" }] };
  document.body.append(view);
  await settled(view);
  for (const details of view.shadowRoot?.querySelectorAll<HTMLDetailsElement>("details.event-group") ?? []) {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  }
  await settled(view);
  return view;
}

for (const [site, targets] of [
  ["queued text", ["queued.html"]],
  ["message text", ["user.html", "assistant.html"]],
  ["thinking", ["thinking.html"]],
  ["skill invocation", ["skill.html"]],
  ["tool result", ["tool.html"]],
] as const) {
  it(`forwards the resolver at ${site}`, async () => {
    const view = await mounted();
    if (site === "queued text") {
      view.clientQueuedMessages = [{ kind: "steer", text: "[client queued](client-queued.html)" }];
      await settled(view);
    }
    const resolver = (raw: string) => `https://gateway.example/view?path=${encodeURIComponent(raw)}`;
    view.resolveFileLink = resolver;
    await settled(view);

    const expectedTargets: readonly string[] = site === "queued text" ? [...targets, "client-queued.html"] : targets;
    for (const target of expectedTargets) {
      const child = children(view).find((candidate) => candidate.text.includes(`](${target})`));
      expect(child, target).toBeDefined();
      expect(child?.resolveFileLink).toBe(resolver);
      expect(child?.shadowRoot?.querySelector("a")?.getAttribute("href")).toBe(`https://gateway.example/view?path=${encodeURIComponent(target)}`);
    }
  });
}

it("updates existing formatted children when the resolver is replaced or removed", async () => {
  const view = await mounted();
  const original = children(view);

  view.resolveFileLink = (raw) => `https://gateway.example/A/${raw}`;
  await settled(view);
  view.resolveFileLink = (raw) => `https://gateway.example/B/${raw}`;
  await settled(view);

  expect(children(view)).toEqual(original);
  for (const child of original) {
    expect(child.shadowRoot?.querySelector("a")?.getAttribute("href")).toContain("https://gateway.example/B/");
  }

  Reflect.set(view, "resolveFileLink", undefined);
  await settled(view);

  for (const child of original) {
    expect(child.resolveFileLink).toBeUndefined();
    expect(child.shadowRoot?.querySelector("a")?.getAttribute("href")).toMatch(/^[a-z]+\.html$/u);
  }
});

it("keeps bash output on its existing plain-text surface", async () => {
  const view = await mounted();
  const article = view.shadowRoot?.querySelector("article.msg.bash");

  expect(article?.querySelector(".shell-output")?.textContent).toBe("[bash](bash.html)");
  expect(article?.querySelector("formatted-text")).toBeNull();
});
