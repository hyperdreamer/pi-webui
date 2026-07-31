import { LitElement, html } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { ChatDisclosureController } from "../chatDisclosure";
import { groupChatMessages, summarizeChatGroup, type ChatGroup } from "../chatGroups";
import { writeClipboardText } from "../clipboard";
import { capturePrependScrollAnchor, PREPEND_RESTORE_SETTLE_FRAMES, restorePrependScrollAnchor, type PrependScrollAnchor } from "../chatScrollAnchoring";
import { shouldRequestEarlierMessages } from "../chatHistoryLoading";
import { ChatScrollController, distanceFromScrollBottom, findFirstVisibleArticle, isNearScrollBottom, type ChatAnchorScrollPosition, type ChatScrollRestoreResult } from "../chatScrollPosition";
import { clampRatio, computeMinimapViewport, extractMinimapScrollRatio, messageTopRatio, type MinimapMarker } from "../chatMinimapGeometry";
import type { QueuedSessionMessage, SessionActivity, SessionInfo, SessionStatus, SessionWarningSeverity } from "../api";
import { formatCost, formatTokenCount } from "../utils/format";
import { computeMessageCounts, sessionUsageDetail, sessionUsageTooltip, type DetailRow, type SessionUsageDetail } from "./sessionUsageDisplay";
import {
  notificationAnnouncementLabel,
  notificationDismissLabel,
  notificationFocusTargetAfterDismiss,
  notificationInboxOverflowLabel,
  notificationInboxTotalCount,
  notificationMessageTruncationLabel,
  notificationSeverityLabel,
  notificationTargetKey,
  notificationTrayHeading,
  notificationTrayIsCollapsed,
  setNotificationTrayCollapsed,
  type NotificationFocusTarget,
  type SelectedSessionNotificationView,
  type SessionNotificationTarget,
} from "../sessionNotifications";
import type { ChatLine, ChatPart } from "./shared";
import { chatStyles, renderSessionWarningIcon } from "./shared";
import "./ChatMinimap";
import "./FormattedText";
import "./ToolExecutionView";

const messageTimestampFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const notificationTimestampFormatter = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

function renderNotificationDisclosureIcon(collapsed: boolean) {
  return html`
    <svg class=${`notification-icon notification-disclosure-icon${collapsed ? "" : " expanded"}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m9 18 6-6-6-6"></path>
    </svg>
  `;
}

function renderNotificationCloseIcon() {
  return html`
    <svg class="notification-icon notification-close-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12"></path>
      <path d="M18 6 6 18"></path>
    </svg>
  `;
}

function isSessionNotificationTarget(value: unknown): value is SessionNotificationTarget {
  return typeof value === "object"
    && value !== null
    && typeof Reflect.get(value, "machineId") === "string"
    && typeof Reflect.get(value, "cwd") === "string"
    && typeof Reflect.get(value, "sessionId") === "string";
}

function clampPercent(value: number): number {
  return clampNumber(value, 0, 100);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

interface PendingNotificationFocus {
  chatKey: string;
  focusTarget: NotificationFocusTarget;
}

export interface QueuedMessageSection {
  source: "client" | "server";
  kind?: "steer" | "followUp";
  heading: string;
  detail: string;
  messages: QueuedSessionMessage[];
}

export function chatQueuedMessageSections(clientQueued: QueuedSessionMessage[], serverQueued: QueuedSessionMessage[]): QueuedMessageSection[] {
  const serverSections = (["steer", "followUp"] as const).flatMap((kind): QueuedMessageSection[] => {
    const messages = serverQueued.filter((message) => message.kind === kind);
    if (messages.length === 0) return [];
    return [{
      source: "server",
      kind,
      heading: kind === "steer" ? "Steered" : "Follow-up",
      detail: kind === "steer" ? "Sent together at the next turn" : "Sent together after the agent finishes",
      messages,
    }];
  });

  const sections: (QueuedMessageSection | undefined)[] = [
    clientQueued.length === 0 ? undefined : { source: "client", heading: "Queued until session starts", detail: "Will send once the backend session is ready", messages: clientQueued },
    ...serverSections,
  ];
  return sections.filter((section): section is QueuedMessageSection => section !== undefined);
}

export type ChatImagePart = Extract<ChatPart, { type: "image" }>;

/** Derive the `<img>` source URL and alt text for a rendered image part. */
export function chatImagePartSource(part: ChatImagePart): { src: string; alt: string } {
  return { src: `data:${part.mimeType};base64,${part.data}`, alt: "attached image" };
}

/** The message-header label used when a tool message renders as an image output. */
export function chatToolOutputLabel(toolName?: string): string {
  return toolName === undefined || toolName === "" ? "tool output" : `${toolName} output`;
}

/** The stable scroll-anchor/render key for a top-level message at `index`. */
export function chatMessageAnchorKey(index: number): string {
  return `m:${String(index)}`;
}

/** The stable scroll-anchor/render key for a collapsed event group starting at `startIndex`. */
export function chatGroupAnchorKey(startIndex: number): string {
  return `g:${String(startIndex)}`;
}

/** The stable scroll-anchor key for an event inside a group at `index`. */
export function chatEventAnchorKey(index: number): string {
  return `e:${String(index)}`;
}

/** The stable scroll-marker id emitted before an event group ending at `endIndex`. */
export function chatGroupScrollMarkerId(endIndex: number): string {
  return `g:${String(endIndex)}`;
}

/** The CSS class list for an event-group `<details>`, distinguishing the live tail. */
export function chatMessageGroupClassName(defaultOpen: boolean): string {
  return defaultOpen ? "msg event-group live" : "msg event-group";
}

/** The disclosure summary label for an event group, distinguishing the live tail. */
export function chatMessageGroupLabel(defaultOpen: boolean): string {
  return defaultOpen ? "live events" : "events";
}

/** Whether the complete queue presentation contains both live Pi queue kinds. */
export function chatQueuedSectionsHaveBothServerKinds(sections: QueuedMessageSection[]): boolean {
  return sections.some((section) => section.source === "server" && section.kind === "steer" && section.messages.length > 0)
    && sections.some((section) => section.source === "server" && section.kind === "followUp" && section.messages.length > 0);
}

/** Whether the shared live-queue clear action is available. */
export function chatQueuedSectionsShowClearAction(sections: QueuedMessageSection[], canClearServerQueue: boolean, hasClearHandler: boolean): boolean {
  return chatQueuedSectionsHaveBothServerKinds(sections) && canClearServerQueue && hasClearHandler;
}

/** Aggregate-copy text for the non-empty live Pi queue sections. */
export function chatQueuedMessagesCopyText(sections: QueuedMessageSection[]): string {
  return sections
    .filter((section) => section.source === "server" && section.messages.length > 0)
    .map((section) => `${section.heading}\n${section.messages.map((message) => message.text).join("\n\n")}`)
    .join("\n\n");
}

/** A rendered session-warning row derived from live status warnings. */
export interface ChatSessionWarningRow {
  severity: SessionWarningSeverity;
  severityClass: string;
  message: string;
  source?: string;
  path?: string;
  dismissId?: string;
}

/** Derive one severity-tagged warning row per live status warning, in order. */
export function chatSessionWarningRows(status: SessionStatus | undefined): ChatSessionWarningRow[] {
  return (status?.warnings ?? []).map((warning) => ({
    severity: warning.severity,
    severityClass: `session-warning ${warning.severity}`,
    message: warning.message,
    ...(warning.source === undefined ? {} : { source: warning.source }),
    ...(warning.path === undefined ? {} : { path: warning.path }),
    ...(warning.dismiss === undefined ? {} : { dismissId: warning.dismiss.id }),
  }));
}

export interface ActivityDockMetric {
  label: string;
  text: string;
  className?: string;
}

/** Metrics beside the live activity label versus cumulative session totals. */
export interface ActivityDockMetricGroups {
  afterStatus: readonly ActivityDockMetric[];
  trailing: readonly ActivityDockMetric[];
}

function generationRateClass(tokensPerSecond: number): string {
  if (tokensPerSecond >= 50) return "generation-rate very-fast";
  if (tokensPerSecond >= 30) return "generation-rate fast";
  if (tokensPerSecond >= 15) return "generation-rate moderate";
  return "generation-rate slow";
}

export function activityDockMetricGroups(status: SessionStatus | undefined): ActivityDockMetricGroups {
  if (status === undefined) return { afterStatus: [], trailing: [] };
  const context = status.contextUsage;
  const contextText = context
    ? context.percent == null
      ? `context ${formatTokenCount(context.contextWindow)}`
      : `${context.percent.toFixed(1)}%/${formatTokenCount(context.contextWindow)}`
    : "context unknown";
  const generation = status.generation;
  const afterStatus = !status.isStreaming || generation === undefined || !Number.isFinite(generation.outputTokens) || generation.outputTokens <= 0
    ? []
    : [
        { label: generation.estimated === true ? "Estimated received tokens" : "Received tokens", text: `↓ ${formatTokenCount(generation.outputTokens)}` },
        ...(generation.tokensPerSecond === undefined || !Number.isFinite(generation.tokensPerSecond) || generation.tokensPerSecond <= 0
          ? []
          : [{ label: generation.estimated === true ? "Estimated generation speed" : "Generation speed", text: `${generation.tokensPerSecond.toFixed(1)} t/s`, className: generationRateClass(generation.tokensPerSecond) }]),
      ];
  const trailing = [
    { label: "Input tokens", text: `↑${formatTokenCount(status.tokens.input)}` },
    { label: "Output tokens", text: `↓${formatTokenCount(status.tokens.output)}` },
    { label: "Context usage", text: contextText },
    { label: "Session cost", text: formatCost(status.cost) },
    ...(status.pendingMessageCount > 0 ? [{ label: "Queued messages", text: `${String(status.pendingMessageCount)} queued` }] : []),
  ];
  return { afterStatus, trailing };
}

export function activityDockMetrics(status: SessionStatus | undefined): readonly ActivityDockMetric[] {
  const groups = activityDockMetricGroups(status);
  return [...groups.afterStatus, ...groups.trailing];
}

export interface ActivityDockWarningControlContent {
  countText: string;
  accessibleLabel: string;
}

export function activityDockWarningControlContent(count: number, expanded: boolean): ActivityDockWarningControlContent | undefined {
  if (!Number.isInteger(count) || count <= 0) return undefined;
  const warningText = `${String(count)} ${count === 1 ? "warning" : "warnings"}`;
  return {
    countText: String(count),
    accessibleLabel: expanded ? `Minimise ${warningText}` : `Show ${warningText} in the warning area`,
  };
}

export function chatMessageMetadataLabel(message: ChatLine): string {
  const timestamp = message.meta?.timestamp;
  const time = timestamp === undefined ? undefined : formatMessageTimestamp(timestamp);
  const model = chatMessageModelLabel(message);
  const parts = [time, model].filter((part): part is string => part !== undefined && part !== "");
  return parts.length === 0 ? "No Pi message metadata available" : parts.join(" · ");
}

export interface ChatUserMessageActionAvailability {
  editFromHereEntryId?: string;
  forkEntryId?: string;
}

/** The server annotates history messages so the UI never infers session-tree IDs from display order. */
export function chatUserMessageActionAvailability(
  message: ChatLine,
  options: { enabled: boolean; busy: boolean },
): ChatUserMessageActionAvailability {
  if (!options.enabled || options.busy || message.role !== "user") return {};
  return {
    ...(message.previousAssistantEntryId === undefined ? {} : { editFromHereEntryId: message.previousAssistantEntryId }),
    ...(message.canFork === true && message.entryId !== undefined ? { forkEntryId: message.entryId } : {}),
  };
}

/** Text restored to the composer by "Edit from here"; image parts intentionally remain attachments only. */
export function chatMessageEditText(message: ChatLine): string {
  return message.parts
    .filter((part): part is Extract<ChatPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function formatMessageTimestamp(timestamp: string): string | undefined {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return undefined;
  return messageTimestampFormatter.format(date);
}

function chatMessageModelLabel(message: ChatLine): string | undefined {
  const model = message.meta?.model;
  if (model === undefined) return undefined;
  const id = model.responseId ?? model.id;
  if (id === undefined || id === "") return model.provider;
  return model.provider !== undefined && model.provider !== "" ? `${model.provider}/${id}` : id;
}

@customElement("chat-view")
export class ChatView extends LitElement {
  @property({ attribute: false }) messages: ChatLine[] = [];
  @property() sessionId = "";
  @property({ type: Number }) messageStart = 0;
  @property({ type: Number }) messageEnd = 0;
  @property({ type: Number }) messageTotal = 0;
  @property({ type: Boolean }) hasMore = false;
  @property({ type: Boolean }) loadingMore = false;
  @property({ type: Boolean }) isSendingPrompt = false;
  @property({ type: Boolean }) isCompacting = false;
  @property({ type: Number }) pendingMessageCount = 0;
  @property({ attribute: false }) clientQueuedMessages: QueuedSessionMessage[] = [];
  @property({ attribute: false }) status?: SessionStatus;
  @property({ type: Number }) warningCount = 0;
  @property({ type: Boolean }) warningsExpanded = false;
  @property({ attribute: false }) onToggleWarnings?: () => void;
  @property({ attribute: false }) activity?: SessionActivity;
  @property({ attribute: false }) sessionInfo?: SessionInfo;
  @property({ attribute: false }) notificationInbox?: SelectedSessionNotificationView;
  @property({ type: Boolean }) canClearServerQueue = false;
  @property({ type: Boolean }) canMessageActions = false;
  @property({ attribute: false }) onEditFromHere?: (assistantEntryId: string, editorText: string) => void | Promise<void>;
  @property({ attribute: false }) onForkFromHere?: (userEntryId: string) => void | Promise<void>;
  @property({ attribute: false }) onClearServerQueue?: () => void;
  @property({ attribute: false }) onDismissWarning?: (dismissId: string) => void;
  @property({ attribute: false }) onDismissNotification?: (notificationId: string) => void;
  @property({ attribute: false }) onDismissAllNotifications?: () => void;
  @property({ type: Boolean }) warningsVisible = true;
  @property({ attribute: false }) onLoadMore?: () => void;
  @query(".chat") private chat?: HTMLDivElement;
  @query("dialog.image-zoom") private imageZoomDialog?: HTMLDialogElement;
  @state() private pinnedToBottom = true;
  @state() private zoomedImage: { src: string; alt: string } | undefined = undefined;
  @state() private expandedMetaKey: string | undefined;
  @state() private copiedMessageKey: string | undefined;
  @state() private forkingEntryId: string | undefined;
  @state() private currentConversationIndex: number | undefined;
  @state() private collapsedNotificationTargetKeys: ReadonlySet<string> = new Set();
  @state() private retainedEmptyNotificationTrayTargetKey: string | undefined;
  private pendingNotificationFocus: PendingNotificationFocus | undefined;
  private readonly disclosures = new ChatDisclosureController();
  private readonly scrollController = new ChatScrollController();
  private suppressScrollSave = false;
  private suppressLoadMoreRequests = false;
  private loadMoreCheckFrame: number | undefined;
  private scrollToBottomFrame: number | undefined;
  private conversationRailFrame: number | undefined;
  private groupedMessagesInput?: ChatLine[];
  private groupedMessagesStart = 0;
  private groupedMessagesCache: ChatGroup[] = [];
  private readonly messageMetaCache = new WeakMap<ChatLine, string>();
  private readonly messageCopyTextCache = new WeakMap<ChatLine, string>();
  private lastScrollTop = 0;
  private lastClientHeight = 0;
  private touchStartY: number | undefined;
  private pendingScrollRestoreSessionId: string | undefined;
  private pendingScrollRestorePosition: ChatAnchorScrollPosition | undefined;
  private restoreScrollFrame: number | undefined;
  private prependRestoreToken = 0;
  @state() private loadMoreRequested = false;
  @state() private sessionInfoOpen = false;
  @state() private _minimapMarkers: MinimapMarker[] = [];
  @state() private _minimapViewport = { scrollRatio: 0, viewportRatio: 1, visible: false };
  private _minimapLoadedPercent = 100;
  private _minimapMeasureTimer: ReturnType<typeof setTimeout> | undefined;
  private _resizeObserver: ResizeObserver | undefined;
  private readonly onViewportResize = () => {
    if (this.pinnedToBottom) this.scrollToBottom();
    else this.lastClientHeight = this.chat?.clientHeight ?? 0;
  };
  private readonly onImageLoad = (): void => {
    if (this.pinnedToBottom) this.scrollToBottom();
  };
  private readonly openImageZoom = (src: string, alt: string): void => {
    this.zoomedImage = { src, alt };
  };
  private readonly closeImageZoom = (): void => {
    if (this.zoomedImage !== undefined) this.zoomedImage = undefined;
  };
  private readonly onImageZoomDialogClick = (event: MouseEvent): void => {
    if (event.target === this.imageZoomDialog) this.closeImageZoom();
  };
  private readonly onPageHide = () => {
    this.saveScrollPosition();
  };
  private readonly handleClearServerQueue = (): void => {
    this.onClearServerQueue?.();
  };
  private readonly handleToggleWarnings = (): void => {
    this.onToggleWarnings?.();
  };

  private readonly handleUsageToggle = (): void => {
    this.sessionInfoOpen = !this.sessionInfoOpen;
  };

  private readonly handleUsageKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.sessionInfoOpen = !this.sessionInfoOpen;
    }
  };

  private readonly closeSessionInfoPopover = (): void => {
    if (!this.sessionInfoOpen) return;
    this.sessionInfoOpen = false;
    this.removePopoverOutsideListener();
    this.requestUpdate();
  };

  private readonly handlePopoverKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeSessionInfoPopover();
      this.focusUsageToggle();
    }
  };

  private focusUsageToggle(): void {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- renderRoot may be unavailable in test environments without DOM
    if (this.renderRoot === undefined) return;
    const toggle = this.renderRoot.querySelector<HTMLElement>(".usage-toggle");
    toggle?.focus();
  }

  private handlePopoverClickOutside(event: MouseEvent): void {
    const popover = this.renderRoot.querySelector<HTMLElement>(".session-info-popover");
    const toggle = this.renderRoot.querySelector<HTMLElement>(".usage-toggle");
    if (popover === null || toggle === null) return;
    const target = event.target;
    if (target instanceof Node && !popover.contains(target) && !toggle.contains(target)) {
      this.closeSessionInfoPopover();
    }
  }

  private onPopoverGlobalClick = (event: MouseEvent): void => {
    this.handlePopoverClickOutside(event);
  };

  private popoverGlobalListenerAttached = false;

  private ensurePopoverOutsideListener(): void {
    if (this.popoverGlobalListenerAttached) return;
    if (typeof window === "undefined") return;
    this.popoverGlobalListenerAttached = true;
    window.addEventListener("click", this.onPopoverGlobalClick, true);
  }

  private removePopoverOutsideListener(): void {
    if (!this.popoverGlobalListenerAttached) return;
    this.popoverGlobalListenerAttached = false;
    if (typeof window === "undefined") return;
    window.removeEventListener("click", this.onPopoverGlobalClick, true);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("resize", this.onViewportResize);
    window.addEventListener("pagehide", this.onPageHide);
    window.visualViewport?.addEventListener("resize", this.onViewportResize);
    this._setupResizeObserver();
  }

  protected override firstUpdated(): void {
    this.lastClientHeight = this.chat?.clientHeight ?? 0;
  }

  private _setupResizeObserver(): void {
    if (this._resizeObserver !== undefined) return;
    const chat = this.chat;
    if (!chat) return;
    this._resizeObserver = new ResizeObserver(() => {
      this._requestMinimapMeasure();
    });
    this._resizeObserver.observe(chat);
  }

  override disconnectedCallback(): void {
    this.removePopoverOutsideListener();
    this.saveScrollPosition();
    this.scrollController.dispose();
    this.prependRestoreToken += 1;
    if (this.restoreScrollFrame !== undefined) cancelAnimationFrame(this.restoreScrollFrame);
    if (this.loadMoreCheckFrame !== undefined) cancelAnimationFrame(this.loadMoreCheckFrame);
    if (this.scrollToBottomFrame !== undefined) cancelAnimationFrame(this.scrollToBottomFrame);
    if (this.conversationRailFrame !== undefined) cancelAnimationFrame(this.conversationRailFrame);
    if (this._minimapMeasureTimer !== undefined) {
      clearTimeout(this._minimapMeasureTimer);
      this._minimapMeasureTimer = undefined;
    }
    if (this._resizeObserver !== undefined) {
      this._resizeObserver.disconnect();
      this._resizeObserver = undefined;
    }
    window.removeEventListener("resize", this.onViewportResize);
    window.removeEventListener("pagehide", this.onPageHide);
    window.visualViewport?.removeEventListener("resize", this.onViewportResize);
    super.disconnectedCallback();
  }

  private savePreviousSessionScrollPosition(previousSessionId: unknown): void {
    if (typeof previousSessionId !== "string" || previousSessionId === "" || previousSessionId === this.sessionId) return;
    this.saveScrollPosition(previousSessionId);
  }

  private prepareSessionUiState(): void {
    this.disclosures.syncSession(this.sessionId);
    this.pendingNotificationFocus = undefined;
    this.retainedEmptyNotificationTrayTargetKey = undefined;
    this.sessionInfoOpen = false;
    this.scrollController.clearScheduledSave();
    this.suppressScrollSave = false;
    this.suppressLoadMoreRequests = false;
    this.pendingScrollRestoreSessionId = undefined;
    this.pendingScrollRestorePosition = undefined;
    this._minimapMarkers = [];
    this._minimapViewport = { scrollRatio: 0, viewportRatio: 1, visible: false };
    this._minimapLoadedPercent = 100;
    this.prependRestoreToken += 1;
    if (this.restoreScrollFrame !== undefined) {
      cancelAnimationFrame(this.restoreScrollFrame);
      this.restoreScrollFrame = undefined;
    }
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("sessionId")) {
      this.savePreviousSessionScrollPosition(changed.get("sessionId"));
      this.prepareSessionUiState();
    } else if (changed.has("notificationInbox") && this.notificationTargetChanged(changed.get("notificationInbox"))) {
      this.pendingNotificationFocus = undefined;
      this.retainedEmptyNotificationTrayTargetKey = undefined;
    }
    if (changed.has("messages")) this.pinnedToBottom = this.pinnedToBottom && (this.didChatHeightChange() || this.isNearBottom());
  }

  protected override update(changed: Map<string, unknown>): void {
    const prependAnchor = this.isPrependingMessages(changed) ? this.capturePrependScrollAnchor() : undefined;
    super.update(changed);
    if (prependAnchor !== undefined) this.restorePrependScrollAnchor(prependAnchor);
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has("loadingMore") && !this.loadingMore) this.loadMoreRequested = false;
    if (changed.has("hasMore") && !this.hasMore) this.loadMoreRequested = false;
    if (changed.has("sessionId")) this.restoreScrollPosition();
    if (!changed.has("sessionId") && changed.has("messages") && this.pinnedToBottom) this.scrollToBottom();
    if (changed.has("messages") || changed.has("messageStart") || changed.has("messageTotal") || changed.has("hasMore") || changed.has("loadingMore")) { this.scheduleConversationRailUpdate(); this._requestMinimapMeasure(); }
    if (changed.has("messages") && !changed.has("sessionId")) this._updateMinimapViewport();
    if (changed.has("messages") || changed.has("messageStart") || changed.has("hasMore") || changed.has("loadingMore")) this.continuePendingScrollRestore();
    if (changed.has("messages") || changed.has("hasMore") || changed.has("loadingMore")) this.requestLoadMoreIfNeeded();
    if (changed.has("notificationInbox") && this.pendingNotificationFocus !== undefined) this.focusPendingNotificationTarget();
    if (changed.has("zoomedImage")) this.syncImageZoomDialog();
    this.syncPopoverOutsideListener();
  }

  private syncPopoverOutsideListener(): void {
    if (this.sessionInfoOpen) this.ensurePopoverOutsideListener();
    else this.removePopoverOutsideListener();
  }

  private syncImageZoomDialog(): void {
    const dialog = this.imageZoomDialog;
    if (dialog === undefined) return;
    if (this.zoomedImage !== undefined && !dialog.open) dialog.showModal();
    else if (this.zoomedImage === undefined && dialog.open) dialog.close();
  }

  private notificationTargetChanged(previous: unknown): boolean {
    const currentInbox = this.notificationInbox;
    if (!isSessionNotificationTarget(previous) || currentInbox === undefined) return previous !== currentInbox;
    return notificationTargetKey(previous) !== notificationTargetKey(currentInbox);
  }

  override render() {
    const groups = this.groupedMessages();
    return html`
      ${this.renderTopNotices()}
      ${this.renderNotificationLiveRegions()}
      <div class="chat-wrap" style=${(this._minimapViewport.visible && this.messages.length > 0 && this.messageTotal > 0) ? "--pi-minimap-right:36px" : ""}>
        ${this.renderConversationRail()}
        <div class="chat" @scroll=${() => { this.onScroll(); }} @wheel=${(event: WheelEvent) => { this.onWheel(event); }} @touchstart=${(event: TouchEvent) => { this.onTouchStart(event); }} @touchmove=${(event: TouchEvent) => { this.onTouchMove(event); }}>
          ${this.renderHistoryBoundary()}
          ${repeat(
            groups,
            (group) => group.kind === "group" ? this.groupRenderKey(group.startIndex) : this.messageAnchorKey(group.index),
            (group, index) => {
              if (group.kind === "group") return this.renderMessageGroup(group.messages, group.startIndex, group.endIndex, this.isLiveTailGroup(groups, index));
              if (group.kind === "tool-image") return this.renderToolImageOutput(group.message, group.index, group.toolName);
              return this.renderMessage(group.message, group.index);
            },
          )}
          ${this.renderQueuedMessages()}
          ${this.renderSessionActivity()}
        </div>
        ${this.renderActivityDock()}
      </div>
      ${this.renderImageZoom()}
    `;
  }

  private renderTopNotices() {
    const warnings = this.renderWarnings();
    const notifications = this.renderNotificationTray();
    if (warnings === null && notifications === null) return null;
    return html`<div class="top-notices">${warnings}${notifications}</div>`;
  }

  private renderNotificationTray() {
    const inbox = this.notificationInbox;
    if (inbox?.sessionId !== this.sessionId) return null;
    const chatKey = notificationTargetKey(inbox);
    const hasPendingOverlay = inbox.pendingDismissedIds.size > 0 || inbox.dismissAllPending;
    const retainsFocusTarget = this.retainedEmptyNotificationTrayTargetKey === chatKey;
    const totalCount = notificationInboxTotalCount(inbox);
    if (totalCount === 0 && !hasPendingOverlay && !retainsFocusTarget) return null;
    const collapsed = notificationTrayIsCollapsed(this.collapsedNotificationTargetKeys, inbox);
    const toggleLabel = collapsed ? "Expand notifications" : "Collapse notifications";
    return html`
      <section class=${`notification-tray${collapsed ? " collapsed" : ""}`} role="region" aria-labelledby="session-notifications-heading" @focusout=${(event: FocusEvent) => { this.releaseEmptyNotificationTray(event); }}>
        <header class="notification-header" data-notification-focus="header" tabindex="-1">
          <strong class="notification-heading" id="session-notifications-heading">${notificationTrayHeading(inbox)}</strong>
          <div class="notification-header-actions">
            <button
              type="button"
              class="notification-control notification-clear"
              aria-label="Clear all notifications"
              title="Clear all notifications"
              ?disabled=${inbox.dismissAllPending || totalCount === 0 || this.onDismissAllNotifications === undefined}
              @click=${() => { this.dismissAllNotifications(); }}
            >Clear</button>
            <button
              type="button"
              class="notification-control notification-toggle"
              aria-label=${toggleLabel}
              title=${toggleLabel}
              aria-expanded=${String(!collapsed)}
              aria-controls="session-notification-list"
              @click=${() => { this.toggleNotificationTray(inbox, collapsed); }}
            >${renderNotificationDisclosureIcon(collapsed)}</button>
          </div>
        </header>
        <div class="notification-list" id="session-notification-list" ?hidden=${collapsed}>
          ${inbox.discardedCount === 0 ? null : html`
            <p class="notification-overflow">${notificationInboxOverflowLabel(inbox.discardedCount)}</p>
          `}
          ${inbox.notifications.map((notification) => {
            const label = notificationSeverityLabel(notification.severity);
            const truncationLabel = notificationMessageTruncationLabel(notification);
            return html`
              <article class=${`notification-row ${notification.severity}`} data-notification-id=${notification.id} tabindex="-1">
                <div class="notification-metadata">
                  <strong class="notification-severity">${label}</strong>
                  <span aria-hidden="true">·</span>
                  <time datetime=${notification.receivedAt}>${notificationTimestampFormatter.format(new Date(notification.receivedAt))}</time>
                </div>
                <p class="notification-message" dir="auto">${notification.message}</p>
                ${truncationLabel === undefined ? null : html`<p class="notification-truncated">${truncationLabel}</p>`}
                <button
                  type="button"
                  class="notification-row-dismiss"
                  aria-label=${notificationDismissLabel(notification)}
                  title="Dismiss notification"
                  ?disabled=${inbox.pendingDismissedIds.has(notification.id) || inbox.dismissAllPending || this.onDismissNotification === undefined}
                  @click=${() => { this.dismissNotification(notification.id); }}
                >${renderNotificationCloseIcon()}</button>
              </article>
            `;
          })}
        </div>
      </section>
    `;
  }

  private renderNotificationLiveRegions() {
    const announcements = this.notificationInbox?.sessionId === this.sessionId ? this.notificationInbox.announcements : [];
    const polite = announcements.filter((announcement) => announcement.severity !== "error");
    const assertive = announcements.filter((announcement) => announcement.severity === "error");
    return html`
      <div class="visually-hidden notification-live" aria-live="polite" aria-atomic="false">${repeat(polite, (announcement) => announcement.id, (announcement) => html`<span data-announcement-id=${announcement.id}>${notificationAnnouncementLabel(announcement)}</span>`)}</div>
      <div class="visually-hidden notification-live" aria-live="assertive" aria-atomic="false">${repeat(assertive, (announcement) => announcement.id, (announcement) => html`<span data-announcement-id=${announcement.id}>${notificationAnnouncementLabel(announcement)}</span>`)}</div>
    `;
  }

  private toggleNotificationTray(inbox: SelectedSessionNotificationView, collapsed: boolean): void {
    this.collapsedNotificationTargetKeys = setNotificationTrayCollapsed(this.collapsedNotificationTargetKeys, inbox, !collapsed);
  }

  private dismissNotification(notificationId: string): void {
    const inbox = this.notificationInbox;
    if (inbox === undefined || this.onDismissNotification === undefined) return;
    const focusTarget = notificationFocusTargetAfterDismiss(inbox.notifications, notificationId);
    const chatKey = notificationTargetKey(inbox);
    this.pendingNotificationFocus = { chatKey, focusTarget };
    if (focusTarget.kind === "header") this.retainedEmptyNotificationTrayTargetKey = chatKey;
    this.onDismissNotification(notificationId);
  }

  private dismissAllNotifications(): void {
    const inbox = this.notificationInbox;
    if (inbox === undefined || this.onDismissAllNotifications === undefined) return;
    const chatKey = notificationTargetKey(inbox);
    this.pendingNotificationFocus = { chatKey, focusTarget: { kind: "header" } };
    this.retainedEmptyNotificationTrayTargetKey = chatKey;
    this.onDismissAllNotifications();
  }

  private releaseEmptyNotificationTray(event: FocusEvent): void {
    const tray = event.currentTarget;
    const next = event.relatedTarget;
    if (tray instanceof HTMLElement && next instanceof Node && tray.contains(next)) return;
    // Removing the activated row can emit focusout before updated() moves focus.
    if (this.pendingNotificationFocus !== undefined) return;
    const inbox = this.notificationInbox;
    if (inbox !== undefined
      && this.retainedEmptyNotificationTrayTargetKey === notificationTargetKey(inbox)
      && notificationInboxTotalCount(inbox) === 0) this.retainedEmptyNotificationTrayTargetKey = undefined;
  }

  private focusPendingNotificationTarget(): void {
    const pending = this.pendingNotificationFocus;
    this.pendingNotificationFocus = undefined;
    const inbox = this.notificationInbox;
    if (pending === undefined || inbox === undefined || notificationTargetKey(inbox) !== pending.chatKey) return;
    const target = pending.focusTarget;
    if (target.kind === "header") {
      this.renderRoot.querySelector<HTMLElement>("[data-notification-focus='header']")?.focus();
      return;
    }
    const row = Array.from(this.renderRoot.querySelectorAll<HTMLElement>("[data-notification-id]"))
      .find((candidate) => candidate.dataset["notificationId"] === target.notificationId);
    if (row !== undefined) {
      row.focus();
      return;
    }
    if (notificationInboxTotalCount(inbox) === 0) this.retainedEmptyNotificationTrayTargetKey = pending.chatKey;
    this.renderRoot.querySelector<HTMLElement>("[data-notification-focus='header']")?.focus();
  }

  private renderWarnings() {
    const rows = chatSessionWarningRows(this.status);
    if (!this.warningsVisible || rows.length === 0) return null;
    return html`
      <aside class="session-warnings" role="alert" aria-live="polite">
        ${rows.map((row) => {
          const dismissId = row.dismissId;
          return html`
          <div class=${row.severityClass}>
            <div class="session-warning-head">
              ${renderSessionWarningIcon(row.severity, "session-warning-icon")}
              ${row.source === undefined ? null : html`<span class="session-warning-source">${row.source}</span>`}
            </div>
            <div class="session-warning-body">
              <p class="session-warning-message">${row.message}</p>
              ${row.path === undefined ? null : html`<p class="session-warning-path">${row.path}</p>`}
            </div>
            ${dismissId === undefined ? null : html`
              <button
                type="button"
                class="session-warning-dismiss"
                title="Don't show this warning again"
                aria-label="Dismiss warning"
                @click=${() => { this.onDismissWarning?.(dismissId); }}
              >×</button>
            `}
          </div>
        `;
        })}
      </aside>
    `;
  }

  private renderSessionInfoPopover() {
    if (!this.sessionInfoOpen) return null;
    const status = this.status;
    if (status === undefined) return null;
    const messageCounts = this.messages.length > 0 ? computeMessageCounts(this.messages) : undefined;
    const detail: SessionUsageDetail = sessionUsageDetail(status, this.sessionInfo, messageCounts);
    const popoverId = `session-info-popover-${this.sessionId}`;
    return html`
      <section
        class="session-info-popover"
        id=${popoverId}
        role="dialog"
        aria-label="Session Info"
        aria-modal="false"
        @keydown=${this.handlePopoverKeydown}
      >
        <header class="session-info-popover-header">
          <h2 class="session-info-popover-heading">Session Info</h2>
          <button
            type="button"
            class="session-info-popover-close"
            aria-label="Close session info"
            title="Close"
            @click=${this.closeSessionInfoPopover}
          >×</button>
        </header>
        <div class="session-info-popover-body">
          ${this.renderDetailSection("Session", detail.sessionRows)}
          ${detail.messageRows.length > 0 ? this.renderDetailSection("Messages", detail.messageRows) : null}
          ${this.renderDetailSection("Tokens", detail.tokenRows)}
        </div>
      </section>
    `;
  }

  private renderDetailSection(title: string, rows: DetailRow[]) {
    return html`
      <div class="session-info-section">
        <h3 class="session-info-section-title">${title}</h3>
        <dl class="session-info-detail-list">
          ${rows.map((row) => html`
            <div class="session-info-detail-row">
              <dt>${row.label}</dt>
              <dd>${row.value}${row.copyValue !== undefined ? this.renderCopyButton(row.copyValue) : null}</dd>
            </div>
          `)}
        </dl>
      </div>
    `;
  }

  private renderCopyButton(value: string) {
    return html`
      <button
        type="button"
        class="session-info-copy"
        title="Copy"
        aria-label="Copy ${value}"
        @click=${(event: MouseEvent) => { event.stopPropagation(); void this.copySessionValue(value); }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>
    `;
  }

  private async copySessionValue(value: string): Promise<void> {
    await writeClipboardText(value);
  }

  private renderImageZoom() {
    return html`
      <dialog class="image-zoom" @click=${this.onImageZoomDialogClick} @close=${this.closeImageZoom} @cancel=${this.closeImageZoom}>
        ${this.zoomedImage === undefined ? null : html`
          <button type="button" class="image-zoom-close" aria-label="Close image" @click=${this.closeImageZoom}>×</button>
          <img class="image-zoom-full" src=${this.zoomedImage.src} alt=${this.zoomedImage.alt} />
        `}
      </dialog>
    `;
  }

  private groupedMessages(): ChatGroup[] {
    if (this.groupedMessagesInput === this.messages && this.groupedMessagesStart === this.messageStart) return this.groupedMessagesCache;
    this.groupedMessagesInput = this.messages;
    this.groupedMessagesStart = this.messageStart;
    this.groupedMessagesCache = groupChatMessages(this.messages, this.messageStart);
    return this.groupedMessagesCache;
  }

  private isLiveTailGroup(groups: ChatGroup[], index: number): boolean {
    return index === groups.length - 1 && this.isSessionLive();
  }

  private isSessionLive(): boolean {
    return this.isSendingPrompt
      || this.status?.isStreaming === true
      || this.status?.isCompacting === true
      || this.status?.isBashRunning === true
      || this.activity?.phase === "active";
  }

  private renderActivityDock() {
    if (this.isSendingPrompt) return this.renderActivityDockContent("Sending your message…", true);
    const state = this.activityState();
    if (state === undefined) return null;
    return this.renderActivityDockContent(this.activityText(state), state !== "idle" || this.activity?.phase === "active");
  }

  private renderActivityDockContent(activityText: string, active: boolean) {
    const metrics = activityDockMetricGroups(this.status);
    const warningControl = activityDockWarningControlContent(this.warningCount, this.warningsExpanded);
    const hasUsage = metrics.trailing.length > 0;
    const tooltip = this.status ? sessionUsageTooltip(this.status) : "";
    const popoverId = hasUsage ? `session-info-popover-${this.sessionId}` : undefined;
    return html`
      <div class=${active ? "activity-dock active" : "activity-dock"}>
        ${warningControl === undefined || this.onToggleWarnings === undefined ? null : html`
          <button
            type="button"
            class="warning-toggle"
            title=${warningControl.accessibleLabel}
            aria-label=${warningControl.accessibleLabel}
            aria-expanded=${String(this.warningsExpanded)}
            @click=${this.handleToggleWarnings}
          >
            ${renderSessionWarningIcon("warning", "warning-toggle-icon")}
            <span>${warningControl.countText}</span>
          </button>
        `}
        <span class="dot"></span>
        <span class="activity-leading">
          <span class="activity-text" aria-live="polite">${activityText}</span>
          ${metrics.afterStatus.length === 0 ? null : html`
            <span class="activity-generation-metrics" role="group" aria-label="Live generation usage" aria-live="off">
              ${this.renderActivityMetrics(metrics.afterStatus)}
            </span>
          `}
        </span>
        ${!hasUsage ? null : html`
          <button
            type="button"
            class="usage-toggle"
            title=${tooltip}
            aria-label=${`Session usage: ${tooltip}`}
            aria-haspopup="dialog"
            aria-expanded=${String(this.sessionInfoOpen)}
            aria-controls=${popoverId}
            @click=${this.handleUsageToggle}
            @keydown=${this.handleUsageKeydown}
          >
            <span class="activity-metrics" role="group" aria-label="Session usage" aria-live="off">
              ${this.renderActivityMetrics(metrics.trailing)}
            </span>
          </button>
        `}
        ${this.renderSessionInfoPopover()}
      </div>
    `;
  }

  private renderActivityMetrics(metrics: readonly ActivityDockMetric[]) {
    return metrics.map((metric) => html`<span class=${metric.className === undefined ? "activity-metric" : `activity-metric ${metric.className}`} title=${metric.label}>${metric.text}</span>`);
  }

  private renderQueuedMessages() {
    const serverQueued = this.status?.queuedMessages ?? [];
    const sections = chatQueuedMessageSections(this.clientQueuedMessages, serverQueued);
    return html`${sections.map((section) => this.renderQueuedMessageList(section, sections))}`;
  }

  private renderQueuedMessageList(section: QueuedMessageSection, sections: QueuedMessageSection[]) {
    const canClear = chatQueuedSectionsShowClearAction(sections, this.canClearServerQueue, this.onClearServerQueue !== undefined);
    return html`
      <aside class="queued-messages" aria-live="polite">
        <div class="queued-header">
          <div class="queued-heading">
            <strong>${section.heading}</strong>
            <small>${section.detail}</small>
          </div>
          ${canClear ? html`
            <button type="button" class="queued-clear-button" title="Clear queued messages without stopping active work" @click=${this.handleClearServerQueue}>Clear queue</button>
          ` : null}
        </div>
        ${section.messages.map((message, index) => html`
          <div class="queued-message">
            <span class="queued-kind">${message.kind === "steer" ? "Steer" : "Follow-up"} ${String(index + 1)}</span>
            <formatted-text .text=${message.text}></formatted-text>
          </div>
        `)}
      </aside>
    `;
  }

  private renderSessionActivity() {
    if (!this.isCompacting) return null;
    return html`
      <aside class="session-activity compacting" aria-live="polite">
        <strong>Compacting history…</strong>
        <span>The agent is summarizing earlier context. New prompts will be queued until compaction finishes.</span>
        ${this.pendingMessageCount > 0 ? html`<small>${this.pendingMessageCount} queued ${this.pendingMessageCount === 1 ? "message" : "messages"}</small>` : null}
      </aside>
    `;
  }

  private activityState(): string | undefined {
    const status = this.status;
    if (status === undefined) return this.activity?.label;
    if (status.isCompacting) return "compacting";
    if (status.isBashRunning) return "bash";
    if (status.isStreaming) return "running";
    if (status.pendingMessageCount > 0) return "queued";
    return "idle";
  }

  private activityText(state: string): string {
    const activity = this.activity;
    if (activity === undefined) return state;
    if (state !== "idle" && activity.phase === "idle") return state;
    return activity.detail !== undefined && activity.detail !== "" ? `${activity.label}: ${activity.detail}` : activity.label;
  }

  private renderConversationRail() {
    if (!this.messages.length || this.messageTotal <= 0) return null;
    this._minimapLoadedPercent = this.hasMore
      ? clampPercent((this.messages.length / this.conversationDisplayTotal()) * 100)
      : 100;
    return html`
      <chat-minimap
        .scrollRatio=${this._minimapViewport.scrollRatio}
        .viewportRatio=${this._minimapViewport.viewportRatio}
        .visible=${this._minimapViewport.visible}
        .loadedPercent=${this._minimapLoadedPercent}
        .markers=${this._minimapMarkers}
        @minimap-scroll-to=${(e: CustomEvent) => { this._onMinimapScrollTo(e); }}
      ></chat-minimap>
    `;
  }

  private conversationDisplayTotal(): number {
    if (!this.hasMore && this.messageStart === 0) return Math.max(1, this.messages.length);
    return Math.max(1, this.messageTotal, this.messageStart + this.messages.length);
  }

  private conversationPositionPercent(total = this.conversationDisplayTotal()): number {
    if (total <= 1) return 100;
    const fallbackIndex = this.pinnedToBottom ? this.messageStart + this.messages.length - 1 : this.messageStart;
    const index = clampNumber(this.currentConversationIndex ?? fallbackIndex, 0, total - 1);
    return clampPercent((index / (total - 1)) * 100);
  }

  private renderHistoryBoundary() {
    const range = this.historyRangeLabel();
    if (this.loadingMore) return html`<div class="history-boundary"><span>Loading earlier messages…</span>${range}</div>`;
    if (this.hasMore) return html`
      <div class="history-boundary">
        <button type="button" class="history-load-button" ?disabled=${this.loadMoreRequested} @click=${() => { this.requestLoadMore(); }}>Load earlier messages</button>
        <span>Scroll up to load earlier messages</span>
        ${range}
      </div>
    `;
    if (this.messages.length) return html`<div class="history-boundary"><span>Beginning of session</span>${range}</div>`;
    return null;
  }

  private historyRangeLabel() {
    if (!this.messages.length || this.messageTotal <= 0) return null;
    const from = this.messageStart + 1;
    const to = this.loadedRawMessageEnd();
    const total = Math.max(this.messageTotal, to);
    return html`<small>Showing messages ${from}–${to} of ${total}</small>`;
  }

  private loadedRawMessageEnd(): number {
    return Math.max(this.messageEnd, this.messageStart + this.messages.length);
  }

  private renderMessage(message: ChatLine, index: number) {
    const toolOnly = this.isToolExecutionOnlyMessage(message);
    return html`
      ${this.renderScrollMarker(this.messageScrollMarkerId(index))}
      <article class=${toolOnly ? "msg tool-execution-shell" : `msg ${message.role}`} data-index=${index} data-scroll-anchor-id=${this.messageAnchorKey(index)}>
        ${toolOnly ? null : this.renderMessageHeader(message, String(index))}
        ${message.parts.map((part) => this.renderPart(part, message))}
      </article>
    `;
  }

  private renderToolImageOutput(message: ChatLine, index: number, toolName?: string) {
    const label = chatToolOutputLabel(toolName);
    return html`
      ${this.renderScrollMarker(this.messageScrollMarkerId(index))}
      <article class="msg tool-image-output" data-index=${index} data-scroll-anchor-id=${this.messageAnchorKey(index)}>
        ${this.renderMessageHeader(message, String(index), label)}
        ${message.parts.map((part) => this.renderPart(part, message))}
      </article>
    `;
  }

  private isToolExecutionOnlyMessage(message: ChatLine): boolean {
    return message.role === "tool" && message.parts.length > 0 && message.parts.every((part) => part.type === "toolExecution");
  }

  private renderMessageGroup(messages: ChatLine[], startIndex: number, endIndex: number, defaultOpen: boolean) {
    const disclosureKey = this.groupDisclosureKey(startIndex, endIndex, defaultOpen);
    const open = this.disclosures.isOpen(disclosureKey, defaultOpen);
    return html`
      ${this.renderScrollMarker(this.groupScrollMarkerId(endIndex))}
      <details class=${chatMessageGroupClassName(defaultOpen)} data-index=${startIndex} data-scroll-anchor-id=${this.groupAnchorKey(startIndex)} ?open=${open} @toggle=${(event: Event) => { this.onGroupToggle(disclosureKey, event, defaultOpen); }}>
        <summary>
          <b class="label">${chatMessageGroupLabel(defaultOpen)}</b>
          <span>${summarizeChatGroup(messages)}</span>
        </summary>
        ${open ? this.renderMessageGroupBody(messages, startIndex) : null}
      </details>
    `;
  }

  private renderMessageGroupBody(messages: ChatLine[], startIndex: number) {
    return html`
      <div class="group-body">
        ${messages.map((message, offset) => {
          const toolOnly = this.isToolExecutionOnlyMessage(message);
          return html`
            <section class=${toolOnly ? "group-msg tool-execution-shell" : `group-msg ${message.role}`} data-index=${startIndex + offset} data-scroll-anchor-id=${this.eventAnchorKey(startIndex + offset)}>
              ${toolOnly ? null : this.renderMessageHeader(message, `${String(startIndex)}:${String(offset)}`)}
              ${message.parts.map((part) => this.renderPart(part, message))}
            </section>
          `;
        })}
      </div>
    `;
  }

  private renderScrollMarker(markerId: string) {
    return html`<span class="scroll-marker" data-marker-id=${markerId} aria-hidden="true"></span>`;
  }

  private renderMessageHeader(message: ChatLine, key: string, label: string = message.role) {
    const meta = this.messageMetaLabel(message);
    const expanded = this.expandedMetaKey === key;
    return html`
      <div class="msg-header">
        <b class="label">${label}</b>
        <div class="msg-header-trailing">
          ${this.renderMessageActions(message, key)}
          <span class=${expanded ? "msg-meta expanded" : "msg-meta"} role="button" tabindex="0" title=${meta} aria-label=${meta} aria-expanded=${String(expanded)} @click=${() => { this.expandedMetaKey = expanded ? undefined : key; }} @keydown=${(event: KeyboardEvent) => { this.onMetaKeydown(event, key, expanded); }}>${meta}</span>
        </div>
      </div>
    `;
  }

  private renderMessageActions(message: ChatLine, key: string) {
    const copyable = this.isCopyableMessage(message);
    const available = chatUserMessageActionAvailability(message, {
      enabled: this.canMessageActions,
      busy: this.messageActionsBusy(),
    });
    const editEntryId = this.onEditFromHere === undefined ? undefined : available.editFromHereEntryId;
    const forkEntryId = this.onForkFromHere === undefined ? undefined : available.forkEntryId;
    if (!copyable && editEntryId === undefined && forkEntryId === undefined) return null;

    const copied = this.copiedMessageKey === key;
    const forking = forkEntryId !== undefined && this.forkingEntryId === forkEntryId;
    return html`
      <div class=${`msg-actions${forking ? " forking" : ""}`} aria-label="Message actions">
        ${copyable ? html`
          <button type="button" class="msg-action" title=${copied ? "Copied" : "Copy message"} aria-label=${`${copied ? "Copied" : "Copy"} ${message.role} message`} @click=${(event: MouseEvent) => { void this.copyMessage(message, key, event); }}>
            <span aria-hidden="true">${copied ? "✓" : "⧉"}</span>
          </button>
        ` : null}
        ${editEntryId === undefined ? null : html`
          <button type="button" class="msg-action msg-history-action" data-message-action="edit-from-here" title="Edit from here — branches within this session" @click=${() => { void this.editFromHere(editEntryId, chatMessageEditText(message)); }}>
            <svg class="msg-history-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="15 10 20 15 15 20"></polyline>
              <path d="M4 4v7a4 4 0 0 0 4 4h12"></path>
            </svg>
            Edit from here
          </button>
        `}
        ${forkEntryId === undefined ? null : html`
          <button type="button" class="msg-action msg-history-action" title=${forking ? "Creating new session…" : "New session — creates an independent copy from here"} ?disabled=${forking} data-message-action="new-session" @click=${() => { void this.forkFromHere(forkEntryId); }}>
            <svg class="msg-history-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="6" y1="3" x2="6" y2="15"></line>
              <circle cx="18" cy="6" r="3"></circle>
              <circle cx="6" cy="18" r="3"></circle>
              <path d="M18 9a9 9 0 0 1-9 9"></path>
            </svg>
            ${forking ? "Creating…" : "New session"}
          </button>
        `}
      </div>
    `;
  }

  private messageActionsBusy(): boolean {
    return this.isSendingPrompt
      || this.isCompacting
      || this.status?.isStreaming === true
      || this.status?.isBashRunning === true
      || this.status?.isCompacting === true
      || (this.status?.pendingMessageCount ?? this.pendingMessageCount) > 0;
  }

  private async editFromHere(assistantEntryId: string, editorText: string): Promise<void> {
    await this.onEditFromHere?.(assistantEntryId, editorText);
  }

  private async forkFromHere(userEntryId: string): Promise<void> {
    if (this.forkingEntryId !== undefined) return;
    this.forkingEntryId = userEntryId;
    try {
      await this.onForkFromHere?.(userEntryId);
    } finally {
      if (this.forkingEntryId === userEntryId) this.forkingEntryId = undefined;
    }
  }

  private onMetaKeydown(event: KeyboardEvent, key: string, expanded: boolean) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    this.expandedMetaKey = expanded ? undefined : key;
  }

  private isCopyableMessage(message: ChatLine): boolean {
    return (message.role === "user" || message.role === "assistant") && this.messageCopyText(message) !== "";
  }

  private messageCopyText(message: ChatLine): string {
    const cached = this.messageCopyTextCache.get(message);
    if (cached !== undefined) return cached;
    const text = message.parts
      .filter((part): part is Extract<ChatPart, { type: "text" }> => part.type === "text")
      .map((part) => part.text.trim())
      .filter((partText) => partText !== "")
      .join("\n\n");
    this.messageCopyTextCache.set(message, text);
    return text;
  }

  private async copyMessage(message: ChatLine, key: string, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    const copied = await writeClipboardText(this.messageCopyText(message));
    if (!copied) return;
    this.copiedMessageKey = key;
    window.setTimeout(() => {
      if (this.copiedMessageKey === key) this.copiedMessageKey = undefined;
    }, 1200);
  }


  private messageMetaLabel(message: ChatLine): string {
    const cached = this.messageMetaCache.get(message);
    if (cached !== undefined) return cached;
    const label = chatMessageMetadataLabel(message);
    this.messageMetaCache.set(message, label);
    return label;
  }

  private renderPart(part: ChatPart, message?: ChatLine) {
    if (part.type === "text" && message?.role === "bash") return html`<pre class="part shell-output">${part.text}</pre>`;
    if (part.type === "text") return html`<formatted-text class="part" .text=${part.text}></formatted-text>`;
    if (part.type === "thinking") return html`<details class="part"><summary>thinking</summary><formatted-text .text=${part.text}></formatted-text></details>`;
    if (part.type === "skillInvocation") return html`
      <details class="part skill-invocation">
        <summary><b>[skill]</b> ${part.name}</summary>
        <small>${part.location}</small>
        <formatted-text .text=${part.content}></formatted-text>
      </details>
    `;
    if (part.type === "skillRead") return html`
      <div class="part skill-read">
        <strong>Loaded ${part.name}</strong>
        <small>read ${part.path}</small>
      </div>
    `;
    if (part.type === "image") {
      const { src, alt } = chatImagePartSource(part);
      return html`<img class="part chat-image" src=${src} alt=${alt} loading="lazy" role="button" tabindex="0" title="Click to enlarge" @load=${this.onImageLoad} @click=${() => { this.openImageZoom(src, alt); }} @keydown=${(event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.openImageZoom(src, alt); } }} />`;
    }
    if (part.type === "toolCall") return html`<div class="part tool-line">▶ ${part.toolName}<span class="summary">${part.summary}</span></div>`;
    if (part.type === "toolExecution") return html`<tool-execution-view class="part" .execution=${part}></tool-execution-view>`;
    if (part.type === "toolResult") return html`
      <details class="part" ?open=${part.isError}>
        <summary>${part.isError ? "✖" : "✓"} ${part.toolName} result</summary>
        <formatted-text .text=${part.text}></formatted-text>
      </details>
    `;
    return null;
  }

  private onGroupToggle(key: string, event: Event, defaultOpen: boolean) {
    const details = event.currentTarget;
    if (!(details instanceof HTMLDetailsElement)) return;
    if (this.disclosures.applyToggle(key, details.open, defaultOpen)) this.requestUpdate();
  }

  private onScroll() {
    this.requestLoadMoreIfNeeded();
    this.updatePinnedToBottomFromScroll();
    this.scheduleConversationRailUpdate();
    this._updateMinimapViewport();
    if (!this.suppressScrollSave) this.scheduleScrollPositionSave();
  }

  private onWheel(event: WheelEvent) {
    if (event.deltaY < 0 && this.canScrollUp()) this.pinnedToBottom = false;
  }

  private onTouchStart(event: TouchEvent) {
    this.touchStartY = event.touches[0]?.clientY;
  }

  private onTouchMove(event: TouchEvent) {
    const y = event.touches[0]?.clientY;
    if (this.touchStartY !== undefined && y !== undefined && y > this.touchStartY && this.canScrollUp()) this.pinnedToBottom = false;
  }

  private updatePinnedToBottomFromScroll() {
    const chat = this.chat;
    if (!chat) return;
    const heightChanged = this.didChatHeightChange();
    const wasPinnedToBottom = this.pinnedToBottom;
    const scrollingUp = chat.scrollTop < this.lastScrollTop;
    if (heightChanged && wasPinnedToBottom) {
      this.lastClientHeight = chat.clientHeight;
      this.scrollToBottom();
      return;
    }
    if (this.isAtBottom()) this.pinnedToBottom = true;
    else if (scrollingUp) this.pinnedToBottom = false;
    else this.pinnedToBottom = this.isNearBottom();
    this.lastScrollTop = chat.scrollTop;
    this.lastClientHeight = chat.clientHeight;
  }

  private didChatHeightChange(): boolean {
    const chat = this.chat;
    return chat !== undefined && this.lastClientHeight !== 0 && chat.clientHeight !== this.lastClientHeight;
  }

  private isPrependingMessages(changed: Map<string, unknown>): boolean {
    const oldMessageStart = changed.get("messageStart");
    return typeof oldMessageStart === "number" && this.messageStart < oldMessageStart;
  }

  private requestLoadMoreIfNeeded(): void {
    if (this.loadMoreCheckFrame !== undefined) return;
    this.loadMoreCheckFrame = requestAnimationFrame(() => {
      this.loadMoreCheckFrame = undefined;
      if (this.suppressLoadMoreRequests) return;
      const chat = this.chat;
      if (!chat) return;
      if (shouldRequestEarlierMessages({
        hasMore: this.hasMore,
        loadingMore: this.loadingMore || this.loadMoreRequested,
        canRequest: this.onLoadMore !== undefined,
        scrollTop: chat.scrollTop,
        scrollHeight: chat.scrollHeight,
        clientHeight: chat.clientHeight,
      })) this.requestLoadMore();
    });
  }

  private requestLoadMore(): void {
    if (this.loadMoreRequested) return;
    if (!this.hasMore || this.loadingMore || this.onLoadMore === undefined) return;
    this.loadMoreRequested = true;
    this.onLoadMore();
  }

  private isNearBottom(): boolean {
    const chat = this.chat;
    if (!chat) return true;
    return isNearScrollBottom(chat);
  }

  private isAtBottom(): boolean {
    const chat = this.chat;
    if (!chat) return true;
    return distanceFromScrollBottom(chat) < 2;
  }

  private canScrollUp(): boolean {
    const chat = this.chat;
    return chat !== undefined && chat.scrollTop > 0;
  }

  private scrollToBottom() {
    if (this.scrollToBottomFrame !== undefined) return;
    this.scrollToBottomFrame = requestAnimationFrame(() => {
      this.scrollToBottomFrame = undefined;
      const chat = this.chat;
      if (!chat) return;
      this.withSuppressedScrollSave(() => {
        chat.scrollTop = chat.scrollHeight;
        this.lastScrollTop = chat.scrollTop;
        this.lastClientHeight = chat.clientHeight;
      });
    });
  }

  restoreScrollPosition() {
    const sessionId = this.sessionId;
    if (this.restoreScrollFrame !== undefined) cancelAnimationFrame(this.restoreScrollFrame);
    this.restoreScrollFrame = requestAnimationFrame(() => {
      this.restoreScrollFrame = undefined;
      if (this.sessionId !== sessionId) return;
      this.withSuppressedScrollSave(() => {
        const result = this.scrollController.restorePosition(sessionId, this.chat, this.scrollAnchorElements(), { fallbackToBottom: this.shouldFallbackToBottomForMissingAnchor() });
        this.handleScrollRestoreResult(sessionId, result);
      });
    });
  }

  private continuePendingScrollRestore(): void {
    const sessionId = this.pendingScrollRestoreSessionId;
    const position = this.pendingScrollRestorePosition;
    if (sessionId === undefined || position === undefined || sessionId !== this.sessionId || this.restoreScrollFrame !== undefined) return;
    this.restoreScrollFrame = requestAnimationFrame(() => {
      this.restoreScrollFrame = undefined;
      if (this.sessionId !== sessionId) return;
      this.withSuppressedScrollSave(() => {
        const result = this.scrollController.restoreExplicitPosition(position, this.chat, this.scrollAnchorElements(), { fallbackToBottom: this.shouldFallbackToBottomForMissingAnchor() });
        this.handleScrollRestoreResult(sessionId, result);
      });
    });
  }

  private handleScrollRestoreResult(sessionId: string, result: ChatScrollRestoreResult): void {
    this.syncScrollMetrics();
    if (result.status !== "missing") {
      this.updatePinnedToBottomAfterRestore(result.status);
      if (result.status === "restored" || result.status === "bottom") this.cancelPrependRestore();
      this.pendingScrollRestoreSessionId = undefined;
      this.pendingScrollRestorePosition = undefined;
      return;
    }

    this.pinnedToBottom = false;
    this.pendingScrollRestoreSessionId = sessionId;
    this.pendingScrollRestorePosition = result.position;
    const chat = this.chat;
    if (chat === undefined || !this.hasMore || this.loadingMore) return;
    chat.scrollTop = 0;
    this.syncScrollMetrics();
    this.requestLoadMore();
  }

  private shouldFallbackToBottomForMissingAnchor(): boolean {
    // Only fall back to the bottom once the full history is loaded; while earlier
    // pages can still load, a missing scroll anchor should keep retrying rather
    // than jump the user to the bottom.
    return !this.hasMore;
  }

  private updatePinnedToBottomAfterRestore(status: Exclude<ChatScrollRestoreResult["status"], "missing">): void {
    if (status === "bottom") this.pinnedToBottom = true;
    else if (status === "restored") this.pinnedToBottom = this.isNearBottom();
  }

  private syncScrollMetrics(): void {
    const chat = this.chat;
    if (chat === undefined) return;
    this.lastScrollTop = chat.scrollTop;
    this.lastClientHeight = chat.clientHeight;
  }

  private cancelPrependRestore(): void {
    this.prependRestoreToken += 1;
    this.suppressLoadMoreRequests = false;
  }

  capturePrependScrollAnchor(): PrependScrollAnchor | undefined {
    const chat = this.chat;
    if (!chat) return undefined;
    return capturePrependScrollAnchor(chat, this.scrollMarkers());
  }

  restorePrependScrollAnchor(anchor: PrependScrollAnchor | undefined): void {
    if (!this.chat || !anchor) return;
    this.suppressLoadMoreRequests = true;
    this.suppressScrollSave = true;
    const token = this.prependRestoreToken + 1;
    this.prependRestoreToken = token;
    let frames = 0;
    const settle = () => {
      const chat = this.chat;
      if (!chat || token !== this.prependRestoreToken) return;
      restorePrependScrollAnchor(chat, anchor, anchor.markerId === undefined ? undefined : this.scrollMarkerAt(anchor.markerId));
      this.lastScrollTop = chat.scrollTop;
      frames += 1;
      // Formatted markdown/code layout can settle after Lit's first render. Re-apply
      // the marker anchor briefly so late height changes above the viewport do not
      // move the user's reading position.
      if (frames < PREPEND_RESTORE_SETTLE_FRAMES) {
        requestAnimationFrame(settle);
        return;
      }
      requestAnimationFrame(() => {
        if (token !== this.prependRestoreToken) return;
        this.suppressScrollSave = false;
        this.suppressLoadMoreRequests = false;
      });
    };
    settle();
  }

  saveScrollPosition(sessionId = this.sessionId) {
    if (!sessionId) return;
    this.scrollController.savePosition(sessionId, this.chat, this.scrollAnchorElements());
  }

  private scheduleScrollPositionSave() {
    const sessionId = this.sessionId;
    this.scrollController.scheduleSave(sessionId, (scheduledSessionId) => {
      if (this.sessionId === scheduledSessionId) this.saveScrollPosition(scheduledSessionId);
    });
  }

  private scheduleConversationRailUpdate(): void {
    if (this.conversationRailFrame !== undefined) return;
    this.conversationRailFrame = requestAnimationFrame(() => {
      this.conversationRailFrame = undefined;
      this.updateConversationRailPosition();
    });
  }

  private updateConversationRailPosition(): void {
    if (!this.messages.length || this.messageTotal <= 0) {
      this.currentConversationIndex = undefined;
      return;
    }
    const total = this.conversationDisplayTotal();
    const article = this.firstVisibleArticle();
    const index = Number(article?.dataset["index"]);
    if (Number.isFinite(index)) {
      this.currentConversationIndex = clampNumber(index, 0, Math.max(0, total - 1));
      return;
    }
    this.currentConversationIndex = clampNumber(this.pinnedToBottom ? this.messageStart + this.messages.length - 1 : this.messageStart, 0, Math.max(0, total - 1));
  }

  private scrollMarkers(): HTMLElement[] {
    return Array.from(this.renderRoot.querySelectorAll<HTMLElement>(".scroll-marker"));
  }

  private scrollMarkerAt(markerId: string): HTMLElement | undefined {
    return this.scrollMarkers().find((marker) => marker.dataset["markerId"] === markerId);
  }

  private firstVisibleArticle(): HTMLElement | undefined {
    const chat = this.chat;
    if (chat === undefined) return undefined;
    const primaryArticles = Array.from(this.renderRoot.querySelectorAll<HTMLElement>("article.msg"));
    return findFirstVisibleArticle(chat, primaryArticles) ?? findFirstVisibleArticle(chat, this.articles());
  }

  private articles(): HTMLElement[] {
    return Array.from(this.renderRoot.querySelectorAll<HTMLElement>("article.msg, details.msg"));
  }

  private scrollAnchorElements(): HTMLElement[] {
    return Array.from(this.renderRoot.querySelectorAll<HTMLElement>("[data-scroll-anchor-id]"));
  }

  private withSuppressedScrollSave(callback: () => void) {
    this.suppressScrollSave = true;
    callback();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.suppressScrollSave = false;
      });
    });
  }

  private groupDisclosureKey(startIndex: number, endIndex: number, defaultOpen: boolean): string {
    return defaultOpen ? `${this.sessionId}:live:${String(startIndex)}` : `${this.sessionId}:${String(endIndex)}`;
  }

  private messageAnchorKey(index: number): string {
    return chatMessageAnchorKey(index);
  }

  private groupRenderKey(startIndex: number): string {
    return chatGroupAnchorKey(startIndex);
  }

  private groupAnchorKey(startIndex: number): string {
    return chatGroupAnchorKey(startIndex);
  }

  private eventAnchorKey(index: number): string {
    return chatEventAnchorKey(index);
  }

  private messageScrollMarkerId(index: number): string {
    return chatMessageAnchorKey(index);
  }

  private groupScrollMarkerId(endIndex: number): string {
    return chatGroupScrollMarkerId(endIndex);
  }

  // --- Conversation minimap ---------------------------------------------------

  private _updateMinimapViewport(): void {
    const chat = this.chat;
    if (!chat) return;
    this._minimapViewport = computeMinimapViewport({
      scrollHeight: chat.scrollHeight,
      clientHeight: chat.clientHeight,
      scrollTop: chat.scrollTop,
    });
    this._minimapLoadedPercent = this.hasMore
      ? clampPercent((this.messages.length / this.conversationDisplayTotal()) * 100)
      : 100;
  }

  private _requestMinimapMeasure(): void {
    if (this._minimapMeasureTimer !== undefined) return;
    this._minimapMeasureTimer = setTimeout(() => {
      this._minimapMeasureTimer = undefined;
      this._measureMinimapMarkers();
      this._updateMinimapViewport();
    }, 150);
  }

  private _measureMinimapMarkers(): void {
    const chat = this.chat;
    if (!chat || !this.messages.length) {
      this._minimapMarkers = [];
      return;
    }
    const containerRect = chat.getBoundingClientRect();
    const scrollHeight = chat.scrollHeight;
    if (scrollHeight <= 0) {
      this._minimapMarkers = [];
      return;
    }
    const articles = this.renderRoot.querySelectorAll<HTMLElement>(
      "article.msg.user, article.msg.assistant",
    );
    const markers: MinimapMarker[] = [];
    for (const article of articles) {
      const indexStr = article.dataset["index"];
      if (indexStr === undefined) continue;
      const absoluteIndex = Number(indexStr);
      if (!Number.isFinite(absoluteIndex)) continue;
      const localIndex = absoluteIndex - this.messageStart;
      if (localIndex < 0 || localIndex >= this.messages.length) continue;
      const message = this.messages[localIndex];
      if (message === undefined) continue;
      const preview = this._minimapMessagePreview(message);
      if (!preview) continue;
      const articleRect = article.getBoundingClientRect();
      const topRatio = messageTopRatio(
        articleRect.top,
        containerRect.top,
        chat.scrollTop,
        scrollHeight,
      );
      if (message.role !== "user" && message.role !== "assistant") continue;
      const role: "user" | "assistant" = message.role;
      markers.push({ topRatio, role, preview });
    }
    this._minimapMarkers = markers;
  }

  private _minimapMessagePreview(message: ChatLine): string {
    return message.parts
      .filter(
        (part): part is Extract<ChatPart, { type: "text" }> => part.type === "text",
      )
      .map((part) => part.text.trim())
      .filter((text) => text !== "")
      .join(" ")
      .slice(0, 200);
  }

  private _onMinimapScrollTo(e: CustomEvent): void {
    const ratio = extractMinimapScrollRatio(e.detail);
    if (ratio === undefined) return;
    const chat = this.chat;
    if (!chat) return;
    const scrollable = chat.scrollHeight - chat.clientHeight;
    if (scrollable <= 0) return;
    const adjustedRatio = clampRatio(
      ratio / (1 - this._minimapViewport.viewportRatio),
    );
    chat.scrollTop = adjustedRatio * scrollable;
    this.pinnedToBottom = isNearScrollBottom(chat);
  }

  static override styles = chatStyles;
}
