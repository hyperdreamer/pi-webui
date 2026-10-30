import { normalizeContext, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

const SESSION_NAME_TIMEOUT_MS = 10_000;
const SESSION_NAME_MAX_INPUT_CHARS = 4_000;
const SESSION_NAME_MAX_LENGTH = 60;
const FALLBACK_SESSION_NAME_MAX_WORDS = 6;
const RELAY_HANDOFF_FIRST_LINE = /^Relay\s+"([^"\n]+)"\s+leg\s+(\d+)\s+begins now\.?\s*(?:\n|$)/;

export function deterministicSessionName(firstMessage: unknown): string | undefined {
  if (typeof firstMessage !== "string") return undefined;

  return relayHandoffSessionName(firstMessage.trimStart());
}

export type SessionNameGeneration =
  | { ok: true; title: string }
  | {
      ok: false;
      reason:
        | "stream-error"
        | "no-completion"
        | "incomplete-stop"
        | "non-text-content"
        | "empty"
        | "unusable";
    };

export async function generateShortSessionName<TApi extends Api>(
  streamFn: StreamFn,
  model: Model<TApi>,
  firstMessage: string,
): Promise<SessionNameGeneration> {
  const context = {
    systemPrompt: "Generate a concise title for a coding-agent chat session. Return only the title, with no quotes or punctuation wrapper.",
    messages: [{
      role: "user" as const,
      content: `Create a 2-6 word title for this request:\n\n${truncateInput(firstMessage)}`,
      timestamp: Date.now(),
    }],
  };
  const stream = await streamFn(model, normalizeContext(context), {
    maxTokens: 256,
    signal: AbortSignal.timeout(SESSION_NAME_TIMEOUT_MS),
  });

  let finalMessage: AssistantMessage | undefined;
  for await (const event of stream) {
    if (event.type === "error") return { ok: false, reason: "stream-error" };
    if (event.type === "done") finalMessage = event.message;
  }
  if (finalMessage === undefined) return { ok: false, reason: "no-completion" };
  if (finalMessage.stopReason !== "stop") return { ok: false, reason: "incomplete-stop" };
  if (finalMessage.content.some((block) => block.type !== "text" && block.type !== "thinking")) {
    return { ok: false, reason: "non-text-content" };
  }
  const normalized = normalizeSessionName(textFromAssistant(finalMessage));
  if (normalized === undefined) return { ok: false, reason: "empty" };
  if (!isUsableSessionTitle(normalized)) return { ok: false, reason: "unusable" };
  return { ok: true, title: shortenSessionName(normalized) };
}

export function fallbackSessionName(firstMessage: unknown): string | undefined {
  if (typeof firstMessage !== "string") return undefined;

  return cleanSessionName(firstMessage
    .replace(/<skill name="[^"]+" location="[^"]+">[\s\S]*?<\/skill>/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#[\](){}<>]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, FALLBACK_SESSION_NAME_MAX_WORDS)
    .join(" "));
}

export function normalizeSessionName(value: string): string | undefined {
  const title = (value.split("\n", 1)[0] ?? "")
    .replace(/^\s*(title|session title)\s*:\s*/i, "")
    .replace(/^\s*["'`]+|["'`.]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return title === "" ? undefined : title;
}

export function isUsableSessionTitle(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;
  const words = trimmed.split(/\s+/);
  if (words.length > 8) return false;
  if (/\b(?:no quotes|punctuation wrapper|2-6 words?|the user wants|we need|need to (?:produce|infer|craft))\b/i.test(value)) {
    return false;
  }
  const lastWord = (words.at(-1) ?? "").replace(/[.,!?;:]+$/g, "");
  return !/^(?:and|or|for|the|a|an|to|with|of|in|on|by)$/i.test(lastWord);
}

export function shortenSessionName(value: string): string {
  const points = Array.from(value);
  if (points.length <= SESSION_NAME_MAX_LENGTH) return value;
  let cut = SESSION_NAME_MAX_LENGTH;
  for (let index = SESSION_NAME_MAX_LENGTH; index > 0; index -= 1) {
    if (/\s/u.test(points[index] ?? "")) {
      cut = index;
      break;
    }
  }
  return points.slice(0, cut).join("").trimEnd();
}

export function cleanSessionName(value: string): string | undefined {
  const normalized = normalizeSessionName(value);
  return normalized === undefined ? undefined : shortenSessionName(normalized);
}

function relayHandoffSessionName(firstMessage: string): string | undefined {
  const match = RELAY_HANDOFF_FIRST_LINE.exec(firstMessage);
  if (match === null) return undefined;

  const relayName = match[1]?.replace(/\s+/g, " ").trim();
  const legNumber = match[2];
  if (relayName === undefined || relayName === "" || legNumber === undefined) return undefined;

  return cleanSessionName(formatRelaySessionName(relayName, legNumber));
}

function formatRelaySessionName(relayName: string, legNumber: string): string {
  const prefix = "Relay ";
  const suffix = ` leg ${legNumber}`;
  const maxRelayNameLength = Math.max(1, SESSION_NAME_MAX_LENGTH - prefix.length - suffix.length);
  const displayedRelayName = truncateRelayName(relayName, maxRelayNameLength);
  return `${prefix}${displayedRelayName}${suffix}`;
}

function truncateRelayName(relayName: string, maxLength: number): string {
  if (relayName.length <= maxLength) return relayName;
  const truncated = relayName.slice(0, maxLength).replace(/[\s._-]+$/g, "").trim();
  return truncated === "" ? relayName.slice(0, maxLength).trim() : truncated;
}

function textFromAssistant(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function truncateInput(value: string): string {
  return value.length <= SESSION_NAME_MAX_INPUT_CHARS ? value : `${value.slice(0, SESSION_NAME_MAX_INPUT_CHARS)}…`;
}
