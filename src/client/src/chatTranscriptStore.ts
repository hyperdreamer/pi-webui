import { normalizeMessages } from "./chatMessages";
import { applyTranscriptEvent, seedStreamingPartial } from "./chatTranscript";
import { mergeChatHistory, readChatHistoryCache, removeChatHistoryCache, writeChatHistoryCache, type RawMessagePage } from "./chatHistoryCache";
import type { ChatLine } from "./components/shared";
import type { SessionUiEvent } from "./sessionSocket";

export interface ChatTranscriptView {
  messages: ChatLine[];
  messagePageStart: number;
  // End offset in the raw transcript. Normalization may coalesce multiple raw
  // entries into one displayed chat message, especially tool calls/results.
  messagePageEnd: number;
  messagePageTotal: number;
}

export interface ChatHistoryCacheAdapter {
  read(sessionId: string): RawMessagePage | undefined;
  write(sessionId: string, page: RawMessagePage): void;
  remove?(sessionId: string): void;
}

export type ChatHistoryWriteScheduler = (write: () => void) => void;

const browserChatHistoryWriteScheduler: ChatHistoryWriteScheduler = (write) => {
  // Serializing a large transcript blocks the main thread, so the write is
  // deferred to a macrotask and only the latest page is persisted. A burst of
  // merges during a live surge therefore costs one serialization, not one per
  // merge.
  setTimeout(write, 0);
};

const browserChatHistoryCache: ChatHistoryCacheAdapter = {
  read: readChatHistoryCache,
  write: writeChatHistoryCache,
  remove: removeChatHistoryCache,
};

export class ChatTranscriptStore {
  private readonly rawHistoryPages = new Map<string, RawMessagePage>();
  private readonly normalizedViews = new WeakMap<RawMessagePage, ChatTranscriptView>();
  private readonly pendingWrites = new Set<string>();

  constructor(
    private readonly cache: ChatHistoryCacheAdapter = browserChatHistoryCache,
    private readonly scheduleWrite: ChatHistoryWriteScheduler = browserChatHistoryWriteScheduler,
  ) {}

  cachedView(sessionId: string): ChatTranscriptView {
    return this.viewFromHistory(this.rawHistoryPage(sessionId));
  }

  mergeHistory(sessionId: string, page: RawMessagePage): ChatTranscriptView {
    const history = mergeChatHistory(this.rawHistoryPage(sessionId), page);
    this.rawHistoryPages.set(sessionId, history);
    this.queueCacheWrite(sessionId);
    return this.viewFromHistory(history);
  }

  applyLiveEvent(messages: ChatLine[], event: SessionUiEvent): ChatLine[] | undefined {
    return applyTranscriptEvent(messages, event);
  }

  /**
   * Seed the join-time in-flight partial assistant message on top of the
   * committed history view. Returns a new in-memory message list; the raw
   * history cache is deliberately untouched so the partial never persists.
   */
  seedStreamingPartial(messages: ChatLine[], partial: unknown): ChatLine[] {
    return seedStreamingPartial(messages, partial);
  }

  discard(sessionId: string): void {
    this.rawHistoryPages.delete(sessionId);
    this.pendingWrites.delete(sessionId);
    this.cache.remove?.(sessionId);
  }

  private queueCacheWrite(sessionId: string): void {
    if (this.pendingWrites.has(sessionId)) return;
    this.pendingWrites.add(sessionId);
    this.scheduleWrite(() => { this.flushCacheWrite(sessionId); });
  }

  private flushCacheWrite(sessionId: string): void {
    if (!this.pendingWrites.delete(sessionId)) return;
    const history = this.rawHistoryPages.get(sessionId);
    if (history === undefined) return;
    this.cache.write(sessionId, history);
  }

  rawHistoryPage(sessionId: string): RawMessagePage | undefined {
    const cached = this.rawHistoryPages.get(sessionId) ?? this.cache.read(sessionId);
    if (cached !== undefined) this.rawHistoryPages.set(sessionId, cached);
    return cached;
  }

  private viewFromHistory(history: RawMessagePage | undefined): ChatTranscriptView {
    if (history === undefined) return transcriptViewFromHistory(undefined);
    const cached = this.normalizedViews.get(history);
    if (cached !== undefined) return cached;
    const view = transcriptViewFromHistory(history);
    this.normalizedViews.set(history, view);
    return view;
  }
}

export function transcriptViewFromHistory(history: RawMessagePage | undefined): ChatTranscriptView {
  const start = history?.start ?? 0;
  return {
    messages: normalizeMessages(history?.messages ?? []),
    messagePageStart: start,
    messagePageEnd: start + (history?.messages.length ?? 0),
    messagePageTotal: history?.total ?? 0,
  };
}
