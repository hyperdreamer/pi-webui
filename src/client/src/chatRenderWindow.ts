import type { ChatGroup } from "./chatGroups";

export const INITIAL_RENDERED_CHAT_GROUPS = 10;
export const CHAT_GROUP_EXPANSION_SIZE = 10;
export const LIVE_EVENT_GROUP_MESSAGE_LIMIT = 8;

export interface BoundedMessageWindow<T> {
  messages: T[];
  startOffset: number;
  hiddenCount: number;
}

export function chatEventAnchorIndex(anchorId: string): number | undefined {
  const match = /^e:(0|[1-9]\d*)$/.exec(anchorId);
  if (match === null) return undefined;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) ? index : undefined;
}

export function initialRenderedGroupStart(
  groups: ChatGroup[],
  limit = INITIAL_RENDERED_CHAT_GROUPS,
): number | undefined {
  const first = groups[0];
  if (first === undefined) return undefined;
  return chatGroupStart(groups[Math.max(0, groups.length - limit)] ?? first);
}

export function clampRenderedGroupStart(
  groups: ChatGroup[],
  currentStart: number | undefined,
): number | undefined {
  if (groups.length === 0) return undefined;
  if (currentStart === undefined) return initialRenderedGroupStart(groups);
  const first = groups[0];
  const last = groups.at(-1);
  if (first === undefined || last === undefined) return undefined;
  if (currentStart <= chatGroupStart(first)) return chatGroupStart(first);
  if (currentStart > chatGroupEnd(last)) return initialRenderedGroupStart(groups);
  return currentStart;
}

export function renderedGroupIndex(groups: ChatGroup[], renderedStart: number | undefined): number {
  if (groups.length === 0 || renderedStart === undefined) return 0;
  const index = groups.findIndex((group) => chatGroupEnd(group) >= renderedStart);
  return index === -1 ? groups.length : index;
}

export function renderedChatGroups(groups: ChatGroup[], renderedStart: number | undefined): ChatGroup[] {
  return groups.slice(renderedGroupIndex(groups, renderedStart));
}

export function hasEarlierRenderedGroups(groups: ChatGroup[], renderedStart: number | undefined): boolean {
  return renderedGroupIndex(groups, renderedStart) > 0;
}

export function earlierRenderedGroupStart(
  groups: ChatGroup[],
  renderedStart: number | undefined,
  count = CHAT_GROUP_EXPANSION_SIZE,
): number | undefined {
  const first = groups[0];
  if (first === undefined) return undefined;
  const currentIndex = renderedGroupIndex(groups, renderedStart);
  const next = groups[Math.max(0, currentIndex - count)] ?? first;
  return chatGroupStart(next);
}

export function boundedLiveEventMessages<T>(
  messages: T[],
  expanded: boolean,
  limit = LIVE_EVENT_GROUP_MESSAGE_LIMIT,
): BoundedMessageWindow<T> {
  if (expanded || messages.length <= limit) return { messages, startOffset: 0, hiddenCount: 0 };
  const startOffset = messages.length - limit;
  return {
    messages: messages.slice(startOffset),
    startOffset,
    hiddenCount: startOffset,
  };
}

function chatGroupStart(group: ChatGroup): number {
  return group.kind === "group" ? group.startIndex : group.index;
}

function chatGroupEnd(group: ChatGroup): number {
  return group.kind === "group" ? group.endIndex : group.index;
}
