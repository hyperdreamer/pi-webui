export interface ChatHistoryLoadState {
  hasMore: boolean;
  loadingMore: boolean;
  canRequest: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  topThreshold?: number;
}

const DEFAULT_TOP_THRESHOLD = 600;
const VIEWPORT_FILL_TOLERANCE = 1;

export function shouldRequestEarlierMessages(state: ChatHistoryLoadState): boolean {
  if (!state.hasMore || state.loadingMore || !state.canRequest || state.clientHeight <= 0) return false;
  return isNearTop(state) || doesNotFillViewport(state);
}

export function isNearTop(state: Pick<ChatHistoryLoadState, "scrollTop" | "clientHeight" | "topThreshold">): boolean {
  return state.scrollTop < (state.topThreshold ?? Math.max(DEFAULT_TOP_THRESHOLD, state.clientHeight));
}

export function doesNotFillViewport(state: Pick<ChatHistoryLoadState, "scrollHeight" | "clientHeight">): boolean {
  return state.scrollHeight <= state.clientHeight + VIEWPORT_FILL_TOLERANCE;
}
