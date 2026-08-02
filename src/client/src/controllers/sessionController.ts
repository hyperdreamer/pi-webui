import { api as defaultApi, type CommandResult, type PromptAttachment, type QueuedSessionMessage, type SessionActivity, type SessionBulkFailure, type SessionCleanupExecuteResponse, type SessionInfo, type SessionRef, type SessionStatus, type SessionStreamSnapshot, type SessionTreeNavigateResult, type SessionTreeSummaryChoice, type Workspace } from "../api";
import type { AppState } from "../appState";
import { forgetCachedNewSession, isCachedNewSessionInfo, markCachedNewSessionInfo, mergeCachedNewSessions, rememberCachedNewSession, stripCachedNewSessionMarker } from "../cachedNewSessions";
import { textMessage } from "../chatMessages";
import { machineSessionKey } from "../machineKeys";
import { clearDraft, moveDraft, saveDraft } from "../promptDraftStorage";
import { ChatTranscriptStore } from "../chatTranscriptStore";
import { isShellInput } from "../inputModes";
import { fileCompletionInsertText } from "../promptCompletions";
import { SessionSocket, type GlobalSessionEvent, type SessionUiEvent } from "../sessionSocket";
import { StreamEventBuffer, isBufferedStreamEvent } from "../streamEventBuffer";
import { isArchivableSessionInfo, isTransientNewSessionInfo, sessionPersistenceOptionsForRuntime } from "../sessionPersistence";
import { isSessionActive } from "../../../shared/activity";
import { PI_WEBUI_CAPABILITIES, supportsPiWebUiCapability } from "../../../shared/capabilities";
import type { ClientSessionModelPolicyStatus, PromptAttachmentDelivery, SessionModelPolicyResponse, SessionModelPolicyUpdate, SessionNotificationInboxEvent } from "../../../shared/apiTypes";
import { InMemorySessionSelectionMemory, markSessionArchived, markSessionsArchived, selectPreferredSession, selectionAfterArchivingSession, selectionAfterArchivingSessions, shouldDeselectAfterArchivedCollapse, type SessionSelectionMemory } from "./sessionSelection";
import { selectedMachineId, type GetState, type SetState, type UpdateUrl } from "./types";
import { TrailingRefreshCoordinator } from "./trailingRefreshCoordinator";

const MESSAGE_PAGE_SIZE = 100;
const OVERLOAD_RESYNC_MIN_INTERVAL_MS = 1_000;
const BULK_FALLBACK_CONCURRENCY = 4;

type OverloadResyncScheduler = (run: () => void, delayMs: number) => () => void;

const defaultOverloadResyncScheduler: OverloadResyncScheduler = (run, delayMs) => {
  const timer = globalThis.setTimeout(run, delayMs);
  return () => { globalThis.clearTimeout(timer); };
};

export interface SessionEventSocket {
  connect(
    session: SessionRef,
    onEvent: (event: SessionUiEvent) => void,
    onReconnect?: () => void,
    machineId?: string,
    onInitialOpen?: () => void,
  ): void;
  setHandler(onEvent: (event: SessionUiEvent) => void): void;
  close(): void;
}

export interface SessionNotificationSessionBridge {
  prepareSelectedSession(session: SessionInfo, machineId: string): void;
  clearSelectedSession(): void;
  refreshSelectedSession(session: SessionRef, machineId: string): Promise<void>;
  applyInboxEvent(machineId: string, event: SessionNotificationInboxEvent): void;
  shouldFilterLegacyNotification(machineId: string, notificationId: string | undefined): boolean;
}

export interface PromptEditorTextReplacement {
  machineId: string;
  sessionId: string;
  text: string;
}

export interface SelectedSessionReady {
  machineId: string;
  session: SessionInfo;
}

export interface SessionControllerDependencies {
  api?: typeof defaultApi;
  socket?: SessionEventSocket;
  transcripts?: ChatTranscriptStore;
  streamEventBuffer?: StreamEventBuffer;
  now?: () => number;
  scheduleOverloadResync?: OverloadResyncScheduler;
  notifications?: SessionNotificationSessionBridge;
  replacePromptEditorText?: (replacement: PromptEditorTextReplacement) => void | Promise<void>;
  onSelectedSessionReady?: (selection: SelectedSessionReady) => void;
}

interface BulkSessionMutationResult {
  succeededIds: string[];
  failures: string[];
  generatedAt?: string;
}

type ClientPendingStartSessionInfo = SessionInfo & { clientPendingStart: true; machineId: string };

type QueuedPendingSessionSendInput =
  | { type: "prompt"; text: string; streamingBehavior?: "steer" | "followUp" | undefined; attachments?: PromptAttachment[] | undefined; delivery: PromptAttachmentDelivery }
  | { type: "shell"; text: string }
  | { type: "command"; text: string };

type QueuedPendingSessionSend = QueuedPendingSessionSendInput & { id: string };

interface PendingSessionStart {
  tempId: string;
  workspaceId: string;
  cwd: string;
  machineId: string;
  session: ClientPendingStartSessionInfo;
  queuedSends: QueuedPendingSessionSend[];
  discarded: boolean;
  /** Starter policy snapshot captured before `POST /sessions`, handed to the request unchanged. */
  modelPolicy: SessionModelPolicyUpdate | undefined;
}

interface SuppressedCreatedSession {
  session: SessionInfo;
  machineId: string;
}

interface SelectedSessionRefreshTarget {
  session: SessionInfo;
  machineId: string;
  selectionSeq: number;
}

interface PendingOverloadResync {
  cancel: () => void;
}

type SelectedModelPolicyStateReset = Pick<AppState, "modelPolicy" | "isLoadingModelPolicy" | "isSavingModelPolicy" | "modelPolicyError">;

export class SessionController {
  private readonly socket: SessionEventSocket;
  private readonly api: typeof defaultApi;
  private readonly transcripts: ChatTranscriptStore;
  private readonly notifications: SessionNotificationSessionBridge | undefined;
  private readonly replacePromptEditorText: SessionControllerDependencies["replacePromptEditorText"];
  private readonly onSelectedSessionReady: SessionControllerDependencies["onSelectedSessionReady"];
  private selectionSeq = 0;
  private disposed = false;
  // Join-time stream watermark for the selected session. `seq` is the
  // `SessionEventHub` sequence captured together with the seeded partial by the
  // stream snapshot: buffered/live events with `seq <= seq` are already reflected
  // in the committed history + seeded partial and must be dropped, so every event
  // applies exactly once. Reset whenever the selection changes.
  private streamWatermark: { sessionId: string; seq: number } | undefined;
  private readonly streamEventBuffer: StreamEventBuffer;
  private readonly now: () => number;
  private readonly scheduleOverloadResync: OverloadResyncScheduler;
  private lastOverloadResyncAt: number | undefined;
  private pendingOverloadResync: PendingOverloadResync | undefined;
  private pendingStatusBySession = new Map<string, SessionStatus>();
  private pendingActivityBySession = new Map<string, SessionActivity>();
  private pendingFrame: number | undefined;
  private pendingSessionStartSeq = 0;
  private pendingQueuedSendSeq = 0;
  // Model policy request ordering. `modelPolicyIssueSeq` stamps every issued
  // policy request; `modelPolicyLoadSeq`/`modelPolicySaveSeq` hold the newest
  // issued read/write of each kind, so only the newest of a kind may write its
  // data or clear its own progress flag. A confirmed write outranks a read: a
  // read may write only while no save of this selection is in flight and none
  // has settled since the read was issued, so a GET served before a PUT commits
  // can never replace the confirmed policy (or drop the PUT's error) with
  // pre-write state. `modelPolicySavesInFlight` holds only current-selection
  // saves, so a save abandoned by a selection change cannot suppress the new
  // selection's reads.
  private modelPolicyIssueSeq = 0;
  private modelPolicyLoadSeq = 0;
  private modelPolicySaveSeq = 0;
  private modelPolicySettledSaveSeq = 0;
  private readonly modelPolicySavesInFlight = new Set<number>();
  // Policy status that arrived with the currently held response. A later status
  // for the selected session that disagrees with it means the daemon changed the
  // authoritative policy underneath the held response (every exact-route
  // mutation appends a fresh Exact branch), so the held remembered branch is
  // stale and must be re-read.
  private modelPolicyConfirmedStatus: ClientSessionModelPolicyStatus | undefined;
  private readonly pendingSessionStarts = new Map<string, PendingSessionStart>();
  private readonly suppressedCreatedSessions = new Map<string, SuppressedCreatedSession>();
  private readonly selectedSessionRefreshes = new TrailingRefreshCoordinator<string>();

  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    private readonly updateUrl: UpdateUrl,
    private readonly sessionSelection: SessionSelectionMemory = new InMemorySessionSelectionMemory(),
    deps: SessionControllerDependencies = {},
  ) {
    this.socket = deps.socket ?? new SessionSocket();
    this.api = deps.api ?? defaultApi;
    this.transcripts = deps.transcripts ?? new ChatTranscriptStore();
    this.streamEventBuffer = deps.streamEventBuffer ?? new StreamEventBuffer();
    this.now = deps.now ?? (() => Date.now());
    this.scheduleOverloadResync = deps.scheduleOverloadResync ?? defaultOverloadResyncScheduler;
    this.notifications = deps.notifications;
    this.replacePromptEditorText = deps.replacePromptEditorText;
    this.onSelectedSessionReady = deps.onSelectedSessionReady;
  }

  applyGlobalEvent(event: GlobalSessionEvent): void {
    if (event.type === "status.update") this.queueStatusUpdate(event.status);
    else if (event.type === "activity.update") this.queueActivityUpdate(event.activity);
    else if (event.type === "session.created") this.applyCreatedSession(event.session);
    else if (event.type === "session.name") this.applySessionName(event.sessionId, event.name);
  }

  dispose() {
    this.disposed = true;
    this.selectionSeq += 1;
    this.socket.close();
    this.clearPendingUpdates();
  }

  clearActiveSession() {
    this.selectionSeq += 1;
    this.socket.close();
    this.notifications?.clearSelectedSession();
    this.streamWatermark = undefined;
    this.clearPendingUpdates();
    // Note: sendingPrompts is intentionally NOT cleared here. Deselecting a
    // session must not cancel the in-flight upload indicator of the session
    // that is still sending; the per-session entry is cleared by send()'s
    // finally block when the request settles.
    this.setState({ selectedSession: undefined, messages: [], messagePageStart: 0, messagePageEnd: 0, messagePageTotal: 0, isLoadingEarlierMessages: false, status: undefined, activity: undefined, availableThinkingLevels: [], ...this.clearSelectedModelPolicyState(), treeDialog: undefined });
  }

  deselectSession(options?: { forgetRememberedSelection?: boolean | undefined; updateUrl?: boolean | undefined }) {
    const state = this.getState();
    const cwd = state.selectedSession?.cwd ?? state.selectedWorkspace?.path;
    if (options?.forgetRememberedSelection === true && cwd !== undefined) this.sessionSelection.forgetWorkspace(this.workspaceSelectionKey(cwd));
    this.clearActiveSession();
    if (options?.updateUrl !== false) this.updateUrl();
  }

  clearSelectionAfterArchivedCollapse(): void {
    const state = this.getState();
    if (!shouldDeselectAfterArchivedCollapse(state.sessions, state.selectedSession)) return;
    this.deselectSession({ forgetRememberedSelection: true });
  }

  async startSession(modelPolicy?: SessionModelPolicyUpdate): Promise<boolean> {
    const workspace = this.getState().selectedWorkspace;
    if (!workspace) return false;
    const machineId = selectedMachineId(this.getState());
    const pending = this.createPendingSessionStart(workspace, machineId, modelPolicy);
    this.pendingSessionStarts.set(pending.tempId, pending);
    this.insertAndSelectPendingSession(pending.session);
    try {
      const session = await this.api.startSession(workspace.path, machineId, pending.modelPolicy);
      await this.resolvePendingSessionStart(pending.tempId, session);
      return true;
    } catch (error) {
      this.failPendingSessionStart(pending.tempId, error);
      return false;
    }
  }

  async startSessionWithPrompt(
    text: string,
    streamingBehavior?: "steer" | "followUp",
    attachments?: PromptAttachment[],
    delivery: PromptAttachmentDelivery = "inline",
    modelPolicy?: SessionModelPolicyUpdate,
    onStarted?: (started: boolean) => void,
  ): Promise<void> {
    const startingSession = this.startSession(modelPolicy).then(
      (started) => ({ rejected: false as const, started }),
      (error: unknown) => ({ rejected: true as const, started: false, error }),
    );
    try {
      await this.send(text, streamingBehavior, attachments, delivery);
    } finally {
      onStarted?.((await startingSession).started);
    }
    const startOutcome = await startingSession;
    if (startOutcome.rejected) throw startOutcome.error;
  }

  preferredSession(cwd: string, sessions: SessionInfo[], targetSessionId: string | undefined): SessionInfo | undefined {
    return selectPreferredSession(sessions, { targetSessionId, latestSessionId: this.sessionSelection.latestSessionId(this.workspaceSelectionKey(cwd)) });
  }

  async selectSession(session: SessionInfo, options?: { updateUrl?: boolean | undefined; preserveTreeDialog?: boolean | undefined; propagateRefreshError?: boolean | undefined }) {
    if (this.disposed) return;
    if (isClientPendingStartSessionInfo(session)) {
      this.selectClientPendingStartSession(session, options);
      return;
    }
    this.sessionSelection.rememberSession({ ...session, cwd: this.workspaceSelectionKey(session.cwd) });
    const seq = ++this.selectionSeq;
    this.socket.close();
    this.streamWatermark = undefined;
    this.clearPendingUpdates();
    const machineId = selectedMachineId(this.getState());
    this.notifications?.prepareSelectedSession(session, machineId);
    const transcriptKey = this.sessionCacheKey(session.id);
    const cached = this.transcripts.cachedView(transcriptKey);
    this.setState({
      selectedSession: session,
      ...cached,
      isLoadingEarlierMessages: false,
      ...(options?.preserveTreeDialog === true ? {} : { treeDialog: undefined }),
      status: session.archived === true ? undefined : this.getState().sessionStatuses[session.id],
      activity: session.archived === true ? undefined : this.getState().sessionActivities[session.id],
      availableThinkingLevels: [],
      ...this.clearSelectedModelPolicyState(),
    });
    let buffered: SessionUiEvent[] | undefined;
    try {
      if (session.archived === true) {
        const page = await this.api.messages(session, { limit: MESSAGE_PAGE_SIZE }, selectedMachineId(this.getState()));
        if (seq !== this.selectionSeq || this.getState().selectedSession?.id !== session.id) return;
        const history = this.transcripts.mergeHistory(transcriptKey, page);
        this.setState({ ...history, isLoadingEarlierMessages: false, status: undefined, activity: undefined });
        this.onSelectedSessionReady?.({ machineId, session });
        if (options?.updateUrl !== false) this.updateUrl();
        return;
      }
      const socketBuffer: SessionUiEvent[] = [];
      buffered = socketBuffer;
      this.socket.connect(
        session,
        (event) => socketBuffer.push(event),
        () => { void this.refreshSelectedSession(session.id); },
        machineId,
        () => { void this.notifications?.refreshSelectedSession(session, machineId); },
      );
      await this.requestSelectedSessionRefresh({ session, machineId, selectionSeq: seq });
      if (!this.isCurrentRefreshTarget({ session, machineId, selectionSeq: seq })) return;
      void this.refreshAvailableThinkingLevels();
      for (const event of socketBuffer) this.applyEvent(event);
      this.socket.setHandler((event) => { this.applyEvent(event); });
      this.onSelectedSessionReady?.({ machineId, session });
      if (options?.updateUrl !== false) this.updateUrl();
    } catch (error) {
      if (seq !== this.selectionSeq || this.getState().selectedSession?.id !== session.id) {
        // Tree navigation still needs to know when a same-session reselection's
        // shared trailing refresh failed, even though this selection is stale.
        if (options?.propagateRefreshError === true && this.isSelectedSessionIdentity(session.id, machineId)) throw error;
        return;
      }
      if (isCachedNewSessionInfo(session) && isSessionNotFoundError(error)) {
        await this.recreateCachedNewSession(session, options);
        return;
      }
      // A failed join refresh must not strand the socket on its temporary
      // buffering callback. Apply what arrived and keep live events flowing so
      // reconnect/trailing refresh can recover authoritatively.
      if (buffered !== undefined) {
        for (const event of buffered) this.applyEvent(event);
        this.socket.setHandler((event) => { this.applyEvent(event); });
      }
      this.setState({ error: String(error) });
      if (options?.propagateRefreshError === true) throw error;
    }
  }

  async loadEarlierMessages() {
    const state = this.getState();
    const session = state.selectedSession;
    if (!session || state.isLoadingEarlierMessages || state.messagePageStart <= 0) return;
    this.setState({ isLoadingEarlierMessages: true });
    try {
      const page = await this.api.messages(session, { before: state.messagePageStart, limit: MESSAGE_PAGE_SIZE }, selectedMachineId(this.getState()));
      if (this.getState().selectedSession?.id !== session.id) return;
      const history = this.transcripts.mergeHistory(this.sessionCacheKey(session.id), page);
      this.setState(history);
    } catch (error) {
      this.setState({ error: String(error) });
    } finally {
      if (this.getState().selectedSession?.id === session.id) this.setState({ isLoadingEarlierMessages: false });
    }
  }

  async send(text: string, streamingBehavior?: "steer" | "followUp", attachments?: PromptAttachment[], delivery: PromptAttachmentDelivery = "inline") {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;

    const trimmed = text.trim();
    const hasAttachments = attachments !== undefined && attachments.length > 0;
    if (isClientPendingStartSessionInfo(session)) {
      if (!hasAttachments && trimmed.startsWith("/")) this.enqueuePendingSessionSend(session, { type: "command", text });
      else if (!hasAttachments && isShellInput(text)) this.enqueuePendingSessionSend(session, { type: "shell", text });
      else this.enqueuePendingSessionSend(session, { type: "prompt", text, streamingBehavior, attachments, delivery });
      return;
    }
    if (!hasAttachments && trimmed.startsWith("/")) return this.runCommand(text);
    if (!hasAttachments && isShellInput(text)) return this.runShell(text);

    // Capture the originating session/machine before any await so the request
    // and its sending indicator stay bound to the right session even if the
    // user navigates elsewhere mid-upload.
    await this.deliverPromptToSession(session, text, streamingBehavior, attachments, delivery, selectedMachineId(this.getState()), { markSending: hasAttachments });
  }

  private markSendingPrompt(sessionId: string, sending: boolean): void {
    const current = this.getState().sendingPrompts;
    if (sending) {
      if (current[sessionId] !== true) this.setState({ sendingPrompts: { ...current, [sessionId]: true } });
    } else if (sessionId in current) {
      this.setState({ sendingPrompts: omitKey(current, sessionId) });
    }
  }

  async runShell(text: string) {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    if (isClientPendingStartSessionInfo(session)) {
      this.enqueuePendingSessionSend(session, { type: "shell", text });
      return;
    }
    await this.deliverShellToSession(session, text, selectedMachineId(this.getState()), { optimisticLine: true });
  }

  async runCommand(text: string) {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    if (isClientPendingStartSessionInfo(session)) {
      this.enqueuePendingSessionSend(session, { type: "command", text });
      return;
    }
    await this.deliverCommandToSession(session, text, selectedMachineId(this.getState()), { applyResult: true });
  }

  async renameSession(session: SessionInfo, name: string): Promise<void> {
    if (session.archived === true || isClientPendingStartSessionInfo(session)) return;
    const trimmedName = name.trim();
    if (trimmedName === "") return;
    const machineId = selectedMachineId(this.getState());
    try {
      const result = await this.api.runCommand(session, `/name ${trimmedName}`, machineId);
      if (selectedMachineId(this.getState()) !== machineId) return;
      if (result.type === "done" && result.session !== undefined) {
        this.applySessionName(result.session.id, result.session.name);
        return;
      }
      this.setState({ error: result.type === "unsupported" ? result.message : "Could not rename session." });
    } catch (error) {
      if (selectedMachineId(this.getState()) === machineId) this.setState({ error: String(error) });
    }
  }

  private enqueuePendingSessionSend(session: ClientPendingStartSessionInfo, input: QueuedPendingSessionSendInput): void {
    const pending = this.pendingSessionStarts.get(session.id);
    if (pending === undefined || pending.discarded) {
      this.setState({ error: "The backend session is not ready for queued sends. Copy your message before discarding this failed start." });
      return;
    }
    const queued: QueuedPendingSessionSend = { ...input, id: `pending-send-${String(++this.pendingQueuedSendSeq)}` };
    pending.queuedSends.push(queued);
    const state = this.getState();
    const current = state.clientQueuedSessionMessages[session.id] ?? [];
    const activity = creatingPendingSessionActivity(session.id, pending.queuedSends.length);
    this.setState({
      clientQueuedSessionMessages: { ...state.clientQueuedSessionMessages, [session.id]: [...current, queuedSessionMessagePreview(queued)] },
      sessionActivities: { ...state.sessionActivities, [session.id]: activity },
      activity: state.selectedSession?.id === session.id ? activity : state.activity,
      error: "",
    });
  }

  private async flushQueuedPendingSends(session: SessionInfo, machineId: string, queuedSends: readonly QueuedPendingSessionSend[]): Promise<void> {
    for (const queued of queuedSends) {
      const delivered = await this.deliverQueuedPendingSend(session, machineId, queued);
      if (!delivered) return;
      this.dropNextQueuedSessionMessage(session.id);
    }
  }

  private async deliverQueuedPendingSend(session: SessionInfo, machineId: string, queued: QueuedPendingSessionSend): Promise<boolean> {
    if (queued.type === "prompt") return this.deliverPromptToSession(session, queued.text, queued.streamingBehavior, queued.attachments, queued.delivery, machineId, { markSending: true });
    if (queued.type === "shell") return this.deliverShellToSession(session, queued.text, machineId, { optimisticLine: true });
    return this.deliverCommandToSession(session, queued.text, machineId, { applyResult: true });
  }

  private async deliverPromptToSession(session: SessionInfo, text: string, streamingBehavior: "steer" | "followUp" | undefined, attachments: PromptAttachment[] | undefined, delivery: PromptAttachmentDelivery, machineId: string, options: { markSending: boolean }): Promise<boolean> {
    const hasAttachments = attachments !== undefined && attachments.length > 0;
    if (options.markSending) this.markSendingPrompt(session.id, true);
    try {
      if (hasAttachments && delivery === "folder") {
        const saved = await this.api.saveAttachments(session, attachments, machineId);
        const references = saved.map((file) => fileCompletionInsertText(file.path, false)).join(" ");
        const body = text === "" ? references : `${text}\n\n${references}`;
        await this.api.prompt(session, body, streamingBehavior, machineId);
      } else {
        await this.api.prompt(session, text, streamingBehavior, machineId, attachments);
      }
      this.markCachedNewSessionPersisted(session);
      return true;
    } catch (error) {
      this.setState({ error: String(error) });
      return false;
    } finally {
      if (options.markSending) this.markSendingPrompt(session.id, false);
    }
  }

  private async deliverShellToSession(session: SessionInfo, text: string, machineId: string, options: { optimisticLine: boolean }): Promise<boolean> {
    if (options.optimisticLine && this.getState().selectedSession?.id === session.id) {
      this.setState({ messages: [...this.getState().messages, textMessage("user", text)] });
    }
    try {
      await this.api.shell(session, text, machineId);
      this.markCachedNewSessionPersisted(session);
      return true;
    } catch (error) {
      if (this.getState().selectedSession?.id === session.id) this.setState({ messages: [...this.getState().messages, textMessage("system", String(error))] });
      this.setState({ error: String(error) });
      return false;
    }
  }

  private async deliverCommandToSession(session: SessionInfo, text: string, machineId: string, options: { applyResult: boolean }): Promise<boolean> {
    // Commands are not inserted into the transcript optimistically: a builtin
    // command produces its own result line, and a runtime/skill command is
    // forwarded to the agent, which streams back the canonical (expanded)
    // message. Inserting the raw text here would leave a line that doesn't
    // converge with server history and disappears on reload. Surface the same
    // per-session sending indicator that send() uses for the pre-receipt window.
    this.markSendingPrompt(session.id, true);
    try {
      const result = await this.api.runCommand(session, text, machineId);
      if (options.applyResult && this.isSelectedSessionIdentity(session.id, machineId)) this.applyCommandResult(result);
      else if (result.type === "select" || result.type === "tree") this.setState({ error: `Queued command “${text}” needs input; open the session and run it again.` });
      this.markCachedNewSessionPersisted(session);
      return true;
    } catch (error) {
      if (this.getState().selectedSession?.id === session.id) this.setState({ messages: [...this.getState().messages, textMessage("system", String(error))] });
      this.setState({ error: String(error) });
      return false;
    } finally {
      this.markSendingPrompt(session.id, false);
    }
  }

  private dropNextQueuedSessionMessage(sessionId: string): void {
    const state = this.getState();
    const current = state.clientQueuedSessionMessages[sessionId] ?? [];
    if (current.length === 0) return;
    const remaining = current.slice(1);
    this.setState({ clientQueuedSessionMessages: remaining.length === 0 ? omitKey(state.clientQueuedSessionMessages, sessionId) : { ...state.clientQueuedSessionMessages, [sessionId]: remaining } });
  }

  async respondToCommand(requestId: string, value: string) {
    const session = this.getState().selectedSession;
    if (!session) return;
    this.setState({ commandDialog: undefined });
    try {
      this.applyCommandResult(await this.api.respondToCommand(session, requestId, value, selectedMachineId(this.getState())));
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  cancelCommand() {
    this.setState({ commandDialog: undefined });
  }

  async navigateTree(targetId: string, summary: SessionTreeSummaryChoice): Promise<SessionTreeNavigateResult> {
    const state = this.getState();
    const session = state.selectedSession;
    const tree = state.treeDialog;
    if (session === undefined || tree === undefined || session.archived === true || isClientPendingStartSessionInfo(session)) {
      throw new Error("The session tree navigator is no longer available");
    }

    const machineId = selectedMachineId(state);
    const selectionSeq = this.selectionSeq;
    let result: SessionTreeNavigateResult;
    try {
      result = await this.api.navigateTree(session, { targetId, expectedLeafId: tree.activeLeafId, summary }, machineId);
    } catch (error) {
      if (this.isCurrentSessionSelection(session.id, machineId, selectionSeq)) this.setState({ error: String(error) });
      throw error;
    }

    if (!result.cancelled) await this.refreshAfterTreeNavigation(session, machineId, result.editorText ?? "", tree);
    return result;
  }

  async editFromHere(targetId: string, editorText: string): Promise<SessionTreeNavigateResult> {
    const state = this.getState();
    const session = state.selectedSession;
    if (session === undefined || session.archived === true || isClientPendingStartSessionInfo(session)) {
      throw new Error("The message action is no longer available");
    }

    const machineId = selectedMachineId(state);
    const selectionSeq = this.selectionSeq;
    let result: SessionTreeNavigateResult;
    try {
      result = await this.api.editFromHere(session, targetId, machineId);
    } catch (error) {
      if (this.isCurrentSessionSelection(session.id, machineId, selectionSeq)) this.setState({ error: String(error) });
      throw error;
    }

    if (!result.cancelled) await this.refreshAfterTreeNavigation(session, machineId, editorText);
    return result;
  }

  async forkFromHere(entryId: string): Promise<void> {
    const state = this.getState();
    const session = state.selectedSession;
    if (session === undefined || session.archived === true || isClientPendingStartSessionInfo(session)) return;

    const machineId = selectedMachineId(state);
    const selectionSeq = this.selectionSeq;
    let result;
    try {
      result = await this.api.forkFromHere(session, entryId, machineId);
    } catch (error) {
      if (this.isCurrentSessionSelection(session.id, machineId, selectionSeq)) this.setState({ error: String(error) });
      return;
    }
    if (result.cancelled) return;

    const current = this.getState();
    if (selectedMachineId(current) !== machineId) return;
    const sessions = [result.session, ...current.sessions.filter((candidate) => candidate.id !== result.session.id)];
    this.setState({ sessions });
    if (!this.isCurrentSessionSelection(session.id, machineId, selectionSeq)) return;
    await this.selectSession(result.session);
  }

  private async refreshAfterTreeNavigation(
    session: SessionInfo,
    machineId: string,
    editorText: string,
    tree?: AppState["treeDialog"],
  ): Promise<void> {
    const cacheKey = machineSessionKey(machineId, session.id);
    saveDraft(cacheKey, editorText);
    this.transcripts.discard(cacheKey);

    // A user can reselect the same session while the request is in flight. Its
    // sequence changes, but the server mutation still belongs to the selected
    // identity and requires a fresh authoritative branch read.
    if (!this.isSelectedSessionIdentity(session.id, machineId)) return;
    this.clearPendingUpdates();
    let authoritativeRefreshFailure: { error: unknown } | undefined;
    try {
      await this.selectSession(session, {
        updateUrl: false,
        ...(tree === undefined ? {} : { preserveTreeDialog: true }),
        propagateRefreshError: true,
      });
    } catch (error) {
      authoritativeRefreshFailure = { error };
    }
    if (!this.isSelectedSessionIdentity(session.id, machineId)) return;

    try {
      await this.replacePromptEditorText?.({ machineId, sessionId: session.id, text: editorText });
    } catch (error) {
      if (this.isSelectedSessionIdentity(session.id, machineId)) this.setState({ error: String(error) });
      throw error;
    }
    if (authoritativeRefreshFailure !== undefined) {
      if (this.isSelectedSessionIdentity(session.id, machineId)) this.setState({ error: String(authoritativeRefreshFailure.error) });
      throw authoritativeRefreshFailure.error;
    }
    if (tree !== undefined && this.isSelectedSessionIdentity(session.id, machineId) && this.getState().treeDialog === tree) {
      this.setState({ treeDialog: undefined });
    }
  }

  async abortTreeNavigation(): Promise<void> {
    const state = this.getState();
    const session = state.selectedSession;
    if (session === undefined || state.treeDialog === undefined || isClientPendingStartSessionInfo(session)) return;
    const machineId = selectedMachineId(state);
    const selectionSeq = this.selectionSeq;
    try {
      await this.api.abort(session, machineId);
    } catch (error) {
      if (this.isCurrentSessionSelection(session.id, machineId, selectionSeq)) this.setState({ error: String(error) });
      throw error;
    }
  }

  closeTreeDialog(): void {
    this.setState({ treeDialog: undefined });
  }

  applySessionStatus(status: SessionStatus): void {
    this.applyStatus(status);
  }

  async archiveSession(session = this.getState().selectedSession) {
    if (!session) return;
    const status = this.statusForSession(session);
    const persistenceOptions = this.sessionPersistenceOptions();
    if (isTransientNewSessionInfo(session, status, persistenceOptions)) {
      await this.deleteCachedNewSession(session);
      return;
    }
    if (!isArchivableSessionInfo(session, status, persistenceOptions)) return;
    try {
      await this.api.archive(session, selectedMachineId(this.getState()));
      const state = this.getState();
      const sessions = markSessionArchived(state.sessions, session.id, new Date().toISOString());
      const selectionChange = selectionAfterArchivingSession(sessions, state.selectedSession?.id, session.id);
      this.setState({ sessions });

      if (selectionChange.type === "select") await this.selectSession(selectionChange.session);
      else if (selectionChange.type === "clear") this.deselectSession({ forgetRememberedSelection: true });
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async archiveSessionWithDescendants(session = this.getState().selectedSession) {
    if (session === undefined || !isArchivableSessionInfo(session, this.statusForSession(session), this.sessionPersistenceOptions())) return;
    try {
      const response = await this.api.archiveWithDescendants(session, selectedMachineId(this.getState()));
      const archivedIds = response.sessionIds !== undefined && response.sessionIds.length > 0 ? response.sessionIds : [session.id];
      const state = this.getState();
      const sessions = markSessionsArchived(state.sessions, archivedIds, new Date().toISOString());
      const selectionChange = selectionAfterArchivingSessions(sessions, state.selectedSession?.id, archivedIds);
      this.setState({ sessions });

      if (selectionChange.type === "select") await this.selectSession(selectionChange.session);
      else if (selectionChange.type === "clear") this.deselectSession({ forgetRememberedSelection: true });
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async archiveSessions(sessions: readonly SessionInfo[]): Promise<void> {
    const persistenceOptions = this.sessionPersistenceOptions();
    const candidates = uniqueSessionsById(sessions).filter((session) => isArchivableSessionInfo(session, this.statusForSession(session), persistenceOptions));
    if (candidates.length === 0) return;

    try {
      const machineId = selectedMachineId(this.getState());
      const { succeededIds: archivedIds, failures, generatedAt } = await this.archiveSessionBatch(candidates, machineId);
      if (archivedIds.length > 0) {
        const state = this.getState();
        const nextSessions = markSessionsArchived(state.sessions, archivedIds, generatedAt ?? new Date().toISOString());
        const selectionChange = selectionAfterArchivingSessions(nextSessions, state.selectedSession?.id, archivedIds);
        this.setState({ sessions: nextSessions });

        if (selectionChange.type === "select") await this.selectSession(selectionChange.session);
        else if (selectionChange.type === "clear") this.deselectSession({ forgetRememberedSelection: true });
      }
      this.applyBulkSessionFailures("Archive", failures);
    } catch (error) {
      this.setState({ error: `Archive failed: ${errorMessage(error)}` });
    }
  }

  async deleteArchivedSessions(sessions: readonly SessionInfo[]): Promise<void> {
    const candidates = uniqueSessionsById(sessions).filter((session) => session.archived === true);
    if (candidates.length === 0) return;

    const machineId = selectedMachineId(this.getState());
    const runtime = this.getState().machineRuntimes[machineId];
    // Preserve legacy federated deletes when capability discovery is unavailable;
    // only a positive runtime response without support should block the action.
    if (runtime?.ok === true && !supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.sessionsDeleteArchived)) {
      this.setState({ error: "Deleting archived sessions requires an updated Pi-Web runtime on this machine." });
      return;
    }
    try {
      const { succeededIds: deletedIds, failures } = await this.deleteArchivedSessionBatch(candidates, machineId);
      if (deletedIds.length > 0) {
        const deletedIdSet = new Set(deletedIds);
        const state = this.getState();
        const nextSessions = state.sessions.filter((session) => !deletedIdSet.has(session.id));
        this.setState({ sessions: nextSessions });
        if (state.selectedSession !== undefined && deletedIdSet.has(state.selectedSession.id)) {
          const next = nextSessions.find((session) => session.archived !== true) ?? nextSessions[0];
          if (next !== undefined) await this.selectSession(next);
          else this.deselectSession({ forgetRememberedSelection: true });
        }
      }
      this.applyBulkSessionFailures("Delete", failures);
    } catch (error) {
      this.setState({ error: `Delete failed: ${errorMessage(error)}` });
    }
  }

  private async archiveSessionBatch(sessions: readonly SessionInfo[], machineId: string): Promise<BulkSessionMutationResult> {
    const runtime = this.getState().machineRuntimes[machineId];
    if (runtime?.ok === true && supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.sessionsBulkMutations)) {
      const response = await this.api.archiveMany(sessions, machineId);
      return { succeededIds: response.archivedSessionIds, failures: bulkFailureMessages(response.failures), generatedAt: response.generatedAt };
    }

    const results = await allSettledWithConcurrency(sessions, BULK_FALLBACK_CONCURRENCY, async (session) => {
      await this.api.archive(session, machineId);
      return session.id;
    });
    return { succeededIds: fulfilledValues(results), failures: settledSessionFailureMessages(sessions, results) };
  }

  private async deleteArchivedSessionBatch(sessions: readonly SessionInfo[], machineId: string): Promise<BulkSessionMutationResult> {
    const runtime = this.getState().machineRuntimes[machineId];
    if (runtime?.ok === true && supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.sessionsBulkMutations)) {
      const response = await this.api.deleteArchivedMany(sessions, machineId);
      return { succeededIds: response.deletedSessionIds, failures: bulkFailureMessages(response.failures) };
    }

    const results = await allSettledWithConcurrency(sessions, BULK_FALLBACK_CONCURRENCY, async (session) => {
      await this.api.deleteArchived(session, machineId);
      return session.id;
    });
    return { succeededIds: fulfilledValues(results), failures: settledSessionFailureMessages(sessions, results) };
  }

  async applySessionCleanupResult(result: SessionCleanupExecuteResponse, machineId = selectedMachineId(this.getState())): Promise<void> {
    if (selectedMachineId(this.getState()) !== machineId) return;
    const archivedIds = result.archivedSessionIds;
    const deletedIds = result.deletedSessionIds;
    if (archivedIds.length > 0 || deletedIds.length > 0) {
      const state = this.getState();
      const deletedIdSet = new Set(deletedIds);
      const affectedIds = [...archivedIds, ...deletedIds];
      const nextSessions = markSessionsArchived(state.sessions, archivedIds, result.generatedAt).filter((session) => !deletedIdSet.has(session.id));
      const selectedAffected = state.selectedSession !== undefined && affectedIds.includes(state.selectedSession.id);
      this.setState({
        sessions: nextSessions,
        sessionStatuses: omitKeys(state.sessionStatuses, affectedIds),
        sessionActivities: omitKeys(state.sessionActivities, affectedIds),
        ...(selectedAffected ? { status: undefined, activity: undefined } : {}),
      });

      if (state.selectedSession !== undefined && deletedIdSet.has(state.selectedSession.id)) {
        const next = nextSessions.find((session) => session.archived !== true) ?? nextSessions[0];
        if (next !== undefined) await this.selectSession(next);
        else this.deselectSession({ forgetRememberedSelection: true });
      } else {
        const selectionChange = selectionAfterArchivingSessions(nextSessions, state.selectedSession?.id, archivedIds);
        if (selectionChange.type === "select") await this.selectSession(selectionChange.session);
        else if (selectionChange.type === "clear") this.deselectSession({ forgetRememberedSelection: true });
      }
    }
    await this.refreshCurrentWorkspaceSessions(machineId);
  }

  async refreshCurrentWorkspaceSessions(machineId = selectedMachineId(this.getState())): Promise<void> {
    const workspace = this.getState().selectedWorkspace;
    if (workspace === undefined) return;
    try {
      const listedSessions = mergeCachedNewSessions(workspace.path, await this.api.sessions(workspace.path, machineId), machineId)
        .filter((session) => !this.isSuppressedCreatedSession(session, machineId));
      if (selectedMachineId(this.getState()) !== machineId || this.getState().selectedWorkspace?.id !== workspace.id) return;
      const sessions = this.mergePendingStartSessions(workspace.path, listedSessions, machineId);
      const selectedSession = this.getState().selectedSession;
      this.setState({ sessions });
      if (selectedSession === undefined) return;
      const refreshedSelected = sessions.find((session) => session.id === selectedSession.id);
      if (refreshedSelected !== undefined) {
        if (refreshedSelected !== selectedSession) this.setState({ selectedSession: refreshedSelected });
        return;
      }
      const next = sessions.find((session) => session.archived !== true) ?? sessions[0];
      if (next !== undefined) await this.selectSession(next);
      else this.deselectSession({ forgetRememberedSelection: true });
    } catch (error) {
      if (selectedMachineId(this.getState()) === machineId && this.getState().selectedWorkspace?.id === workspace.id) this.setState({ error: String(error) });
    }
  }

  async deleteCachedNewSession(session = this.getState().selectedSession) {
    if (session === undefined || !isTransientNewSessionInfo(session, this.statusForSession(session), this.sessionPersistenceOptions())) return;
    const pendingStart = isClientPendingStartSessionInfo(session) ? this.pendingSessionStarts.get(session.id) : undefined;
    if (pendingStart !== undefined) {
      pendingStart.discarded = true;
      pendingStart.queuedSends = [];
    }
    else {
      void this.api.stop(session, selectedMachineId(this.getState())).catch(() => {
        // Best-effort cleanup for transient sessions that may not exist server-side anymore.
      });
    }
    forgetCachedNewSession(session.id, selectedMachineId(this.getState()));
    clearDraft(this.sessionCacheKey(session.id));
    const state = this.getState();
    const sessions = state.sessions.filter((candidate) => candidate.id !== session.id);
    this.setState({
      sessions,
      sessionStatuses: omitKey(state.sessionStatuses, session.id),
      sessionActivities: omitSessionActivity(state.sessionActivities, session.id),
      sendingPrompts: omitKey(state.sendingPrompts, session.id),
      clientQueuedSessionMessages: omitKey(state.clientQueuedSessionMessages, session.id),
    });
    if (this.getState().selectedSession?.id !== session.id) return;
    const next = sessions.find((candidate) => candidate.archived !== true) ?? sessions[0];
    if (next !== undefined) await this.selectSession(next);
    else {
      this.clearActiveSession();
      this.updateUrl();
    }
  }

  async restoreSession(session = this.getState().selectedSession) {
    if (!session) return;
    try {
      await this.api.restore(session, selectedMachineId(this.getState()));
      const restored = { ...session };
      delete restored.archived;
      delete restored.archivedAt;
      this.replaceSession(restored);
      if (this.getState().selectedSession?.id === restored.id) await this.selectSession(restored);
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async reloadSession(session = this.getState().selectedSession) {
    if (session === undefined || !isArchivableSessionInfo(session, this.statusForSession(session), this.sessionPersistenceOptions())) return;
    const machineId = selectedMachineId(this.getState());
    const runtime = this.getState().machineRuntimes[machineId];
    if (runtime?.ok !== true || !supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.sessionsReload)) {
      this.setState({ error: "Reloading sessions from disk requires an updated Pi-Web runtime on this machine." });
      return;
    }
    try {
      await this.api.reloadSession(session.id, machineId);
      this.transcripts.discard(this.sessionCacheKey(session.id));
      if (this.getState().selectedSession?.id === session.id) {
        await this.selectSession(session, { updateUrl: false });
      }
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async detachParent(session = this.getState().selectedSession) {
    if (session?.parentSessionPath === undefined) return;
    try {
      await this.api.detachParent(session, selectedMachineId(this.getState()));
      const detached = { ...session };
      delete detached.parentSessionPath;
      this.replaceSession(detached);
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async pinSession(session = this.getState().selectedSession) {
    if (!session || session.archived === true) return;
    try {
      const updated = await this.api.pin(session, selectedMachineId(this.getState()));
      this.replaceSession(updated);
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async unpinSession(session = this.getState().selectedSession) {
    if (!session || session.archived === true) return;
    try {
      const updated = await this.api.unpin(session, selectedMachineId(this.getState()));
      this.replaceSession(updated);
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  /**
   * Read the selected session's persisted policy from its dedicated endpoint.
   * A response whose `policy` is omitted is the daemon's corrupt-entry repair
   * signal and is stored as-is: nothing here substitutes, clamps, or repairs a
   * blocked or invalid policy client-side.
   */
  async loadModelPolicy(): Promise<void> {
    const target = this.selectedModelPolicyTarget();
    if (target === undefined) return;
    const { session, machineId, selectionSeq } = target;
    const loadSeq = ++this.modelPolicyIssueSeq;
    this.modelPolicyLoadSeq = loadSeq;
    const settledSaveSeq = this.modelPolicySettledSaveSeq;
    // A previous session's confirmed response must not stay visible while the
    // new read is in flight, and a stale failure must not outlive the retry.
    // While a save is in flight this read can publish nothing anyway (a
    // confirmed write outranks it), so the response being saved is left visible
    // rather than cleared out from under the save.
    if (this.modelPolicySavesInFlight.size > 0) this.setState({ isLoadingModelPolicy: true });
    else this.setState({ modelPolicy: undefined, modelPolicyError: undefined, isLoadingModelPolicy: true });
    try {
      const response = await this.api.modelPolicy(session, machineId);
      if (this.canWriteModelPolicyReadResult(session.id, machineId, selectionSeq, loadSeq, settledSaveSeq)) {
        this.applyConfirmedModelPolicyResponse(response);
      }
    } catch (error) {
      if (this.canWriteModelPolicyReadResult(session.id, machineId, selectionSeq, loadSeq, settledSaveSeq)) this.setState({ modelPolicyError: String(error) });
    } finally {
      if (!this.disposed && this.modelPolicyLoadSeq === loadSeq) this.setState({ isLoadingModelPolicy: false });
    }
  }

  /** Persist a policy choice for the selected session and adopt the confirmed response. */
  async saveModelPolicy(update: SessionModelPolicyUpdate): Promise<void> {
    const target = this.selectedModelPolicyTarget();
    if (target === undefined) return;
    const { session, machineId, selectionSeq } = target;
    const saveSeq = ++this.modelPolicyIssueSeq;
    this.modelPolicySaveSeq = saveSeq;
    this.modelPolicySavesInFlight.add(saveSeq);
    // The currently displayed response stays visible while saving so the user
    // keeps seeing the policy they are editing; only the stale error is dropped.
    this.setState({ modelPolicyError: undefined, isSavingModelPolicy: true });
    try {
      const response = await this.api.setModelPolicy(session, update, machineId);
      if (this.canWriteModelPolicyWriteResult(session.id, machineId, selectionSeq, saveSeq)) {
        this.applyConfirmedModelPolicyResponse(response);
      }
    } catch (error) {
      if (this.canWriteModelPolicyWriteResult(session.id, machineId, selectionSeq, saveSeq)) this.setState({ modelPolicyError: String(error) });
    } finally {
      // Recorded even when this result was discarded, so a read issued while the
      // write was in flight still loses to the write instead of resurrecting
      // pre-write state once the write settles.
      this.modelPolicySavesInFlight.delete(saveSeq);
      // Only a save that still owns the current selection may outrank reads; a
      // save abandoned by a selection change must not suppress the new
      // selection's reads.
      const isCurrentSelection = this.isCurrentSessionSelection(session.id, machineId, selectionSeq);
      if (isCurrentSelection && saveSeq > this.modelPolicySettledSaveSeq) this.modelPolicySettledSaveSeq = saveSeq;
      if (!this.disposed && this.modelPolicySaveSeq === saveSeq) this.setState({ isSavingModelPolicy: false });
      // A status received while the save was pending may have been deliberately
      // held back. Once this save leaves the in-flight set, compare that current
      // status with the last confirmed response before the stale branch can be
      // used for another update.
      const currentStatus = isCurrentSelection ? this.getState().status : undefined;
      if (currentStatus !== undefined) this.invalidateSupersededModelPolicy(currentStatus);
    }
  }

  /**
   * Capture the selected session identity a policy request belongs to. Returns
   * undefined when there is nothing policy-addressable selected (no session, an
   * archived session, or a client-pending start that has no backend session yet).
   */
  private selectedModelPolicyTarget(): { session: SessionRef; machineId: string; selectionSeq: number } | undefined {
    const state = this.getState();
    const selected = state.selectedSession;
    if (selected === undefined || selected.archived === true || isClientPendingStartSessionInfo(selected)) return undefined;
    return { session: { id: selected.id, cwd: selected.cwd }, machineId: selectedMachineId(state), selectionSeq: this.selectionSeq };
  }

  /**
   * A settled policy *read* may write confirmed state only while it still belongs
   * to the current selection, is the newest issued read, and no write of this
   * selection has settled or is still in flight since it was issued. A GET
   * served before a concurrent PUT commits therefore cannot republish pre-write
   * policy as confirmed, nor drop the write's own error.
   */
  private canWriteModelPolicyReadResult(sessionId: string, machineId: string, selectionSeq: number, loadSeq: number, settledSaveSeq: number): boolean {
    if (loadSeq !== this.modelPolicyLoadSeq) return false;
    if (this.modelPolicySavesInFlight.size > 0 || this.modelPolicySettledSaveSeq !== settledSaveSeq) return false;
    return this.isCurrentSessionSelection(sessionId, machineId, selectionSeq);
  }

  /**
   * A settled policy *write* may write confirmed state while it still belongs to
   * the current selection and is the newest issued write, so an older write
   * resolving late cannot overwrite a newer confirmed one.
   */
  private canWriteModelPolicyWriteResult(sessionId: string, machineId: string, selectionSeq: number, saveSeq: number): boolean {
    return saveSeq === this.modelPolicySaveSeq && this.isCurrentSessionSelection(sessionId, machineId, selectionSeq);
  }

  /**
   * Adopt a confirmed policy response. Buffered updates are flushed first (as
   * `requestSelectedSessionRefresh()` does) so a status published before the
   * confirmation but still frame-buffered cannot flush afterwards and revert
   * `status.modelPolicy` to its pre-confirmation value.
   */
  private applyConfirmedModelPolicyResponse(response: SessionModelPolicyResponse): void {
    this.flushPendingUpdates();
    this.modelPolicyConfirmedStatus = response.session.modelPolicy;
    this.setState({ modelPolicy: response, modelPolicyError: undefined });
    this.applyStatus(response.session);
  }

  /**
   * Drop a held policy response the daemon has since superseded. Every exact
   * route mutation (`setModel`, `cycleModel`, `setThinkingLevel`,
   * `cycleThinkingLevel`) appends a fresh Exact policy branch server-side and
   * reports the result only through `SessionStatus.modelPolicy`, never through
   * this feature's response. A status that disagrees with the one the held
   * response arrived with therefore means `state.modelPolicy` holds a superseded
   * remembered branch; keeping it would let a later "switch back to Exact" update
   * persist a tuple the user has already replaced. The remembered branch exists
   * only in the dedicated endpoint's response, so the held value is dropped and
   * re-read rather than patched from the status.
   */
  private invalidateSupersededModelPolicy(status: SessionStatus): void {
    const state = this.getState();
    if (state.selectedSession?.id !== status.sessionId) return;
    if (state.modelPolicy === undefined || status.modelPolicy === undefined) return;
    // Nothing to compare against when the confirmed response carried no policy
    // status (an older daemon), so no status can be read as superseding it.
    if (this.modelPolicyConfirmedStatus === undefined) return;
    // A save in flight owns the displayed response until it settles and then
    // rechecks the latest status. An ordinary read clears the held response when
    // it starts; if one is still held here, a concurrent read began during the
    // save and cannot publish after that save settled, so a replacement is needed.
    if (this.modelPolicySavesInFlight.size > 0) return;
    if (modelPolicyStatusesAgree(status.modelPolicy, this.modelPolicyConfirmedStatus)) return;
    this.setState({ modelPolicy: undefined });
    void this.loadModelPolicy();
  }

  /**
   * Selected-session policy reset, spread into the selection-lifecycle state
   * writes that already bump `selectionSeq`. In-flight requests are abandoned by
   * the sequence guards, so a prior session's remembered exact branch, error, or
   * progress flag never survives a selection or machine change.
   */
  private clearSelectedModelPolicyState(): SelectedModelPolicyStateReset {
    this.modelPolicyLoadSeq = 0;
    this.modelPolicySaveSeq = 0;
    this.modelPolicySettledSaveSeq = 0;
    this.modelPolicySavesInFlight.clear();
    this.modelPolicyConfirmedStatus = undefined;
    return { modelPolicy: undefined, isLoadingModelPolicy: false, isSavingModelPolicy: false, modelPolicyError: undefined };
  }

  async listModels() {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return [];
    try {
      return (await this.api.models(session, selectedMachineId(this.getState()))).models;
    } catch (error) {
      this.setState({ error: String(error) });
      return [];
    }
  }

  async setModel(provider: string, modelId: string) {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    try {
      this.applyStatus(await this.api.setModel(session, provider, modelId, selectedMachineId(this.getState())));
      await this.refreshAvailableThinkingLevels();
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async cycleModel(direction: "forward" | "backward") {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    try {
      this.applyStatus(await this.api.cycleModel(session, direction, selectedMachineId(this.getState())));
      await this.refreshAvailableThinkingLevels();
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async listThinkingLevels() {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return [];
    try {
      return (await this.api.thinkingLevels(session, selectedMachineId(this.getState()))).levels;
    } catch (error) {
      this.setState({ error: String(error) });
      return [];
    }
  }

  /** Refresh the available thinking levels for the selected session's model. */
  async refreshAvailableThinkingLevels() {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) {
      if (this.getState().availableThinkingLevels.length > 0) this.setState({ availableThinkingLevels: [] });
      return;
    }
    const levels = await this.listThinkingLevels();
    if (this.getState().selectedSession?.id !== session.id) return;
    this.setState({ availableThinkingLevels: levels });
  }

  async setThinkingLevel(level: string) {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    try {
      this.applyStatus(await this.api.setThinkingLevel(session, level, selectedMachineId(this.getState())));
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async cycleThinkingLevel() {
    const session = this.getState().selectedSession;
    if (!session || session.archived === true) return;
    try {
      this.applyStatus(await this.api.cycleThinkingLevel(session, selectedMachineId(this.getState())));
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async clearServerQueue() {
    const state = this.getState();
    const session = state.selectedSession;
    if (session === undefined || session.archived === true || isClientPendingStartSessionInfo(session)) return;
    const machineId = selectedMachineId(state);
    const selectionSeq = this.selectionSeq;
    try {
      const status = await this.api.clearQueue(session, machineId);
      if (this.isCurrentSessionSelection(session.id, machineId, selectionSeq)) this.applyStatus(status);
    } catch (error) {
      if (this.isCurrentSessionSelection(session.id, machineId, selectionSeq)) this.setState({ error: String(error) });
    }
  }

  async dismissWarning(dismissId: string) {
    const state = this.getState();
    const session = state.selectedSession;
    if (session === undefined || isClientPendingStartSessionInfo(session)) return;
    const machineId = selectedMachineId(state);
    const selectionSeq = this.selectionSeq;
    try {
      const status = await this.api.dismissWarning(session, dismissId, machineId);
      if (this.isCurrentSessionSelection(session.id, machineId, selectionSeq)) this.applyStatus(status);
    } catch (error) {
      if (this.isCurrentSessionSelection(session.id, machineId, selectionSeq)) this.setState({ error: String(error) });
    }
  }

  async stopActiveWork() {
    const session = this.getState().selectedSession;
    if (!session) return;
    try {
      await this.api.abort(session, selectedMachineId(this.getState()));
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  refreshSelectedSession(sessionId = this.getState().selectedSession?.id): Promise<void> {
    const target = this.selectedSessionRefreshTarget(sessionId);
    if (target === undefined) return Promise.resolve();
    return this.refreshSelectedSessionTarget(target);
  }

  private selectedSessionRefreshTarget(sessionId: string | undefined): SelectedSessionRefreshTarget | undefined {
    const session = this.getState().selectedSession;
    if (sessionId === undefined || session?.id !== sessionId || session.archived === true || isClientPendingStartSessionInfo(session)) return undefined;
    return {
      session,
      machineId: selectedMachineId(this.getState()),
      selectionSeq: this.selectionSeq,
    };
  }

  private refreshSelectedSessionTarget(target: SelectedSessionRefreshTarget): Promise<void> {
    return this.requestSelectedSessionRefresh(target).catch((error: unknown) => {
      if (this.isCurrentRefreshTarget(target)) this.setState({ error: String(error) });
    });
  }

  private requestSelectedSessionRefresh(target: SelectedSessionRefreshTarget): Promise<void> {
    const key = machineSessionKey(target.machineId, target.session.id);
    return this.selectedSessionRefreshes.request(key, async () => {
      if (!this.isCurrentRefreshTarget(target)) return;
      this.flushPendingUpdates();
      const [page, status, streamSnapshot] = await Promise.all([
        this.api.messages(target.session, { limit: MESSAGE_PAGE_SIZE }, target.machineId),
        this.api.status(target.session, target.machineId),
        // The stream snapshot is a progressive enhancement. An older/not-yet-
        // restarted session daemon or a remote machine on an older pi-webui has no
        // `stream-snapshot` route and returns 404; treat any failure as "no
        // partial to seed". A `seq: 0` watermark drops nothing (live events start
        // at seq 1, and un-stamped events fail open), so the core transcript
        // still loads and streams normally.
        this.api.streamSnapshot(target.session, target.machineId).catch((): SessionStreamSnapshot => ({ seq: 0, partial: null })),
        this.notifications?.refreshSelectedSession(target.session, target.machineId) ?? Promise.resolve(),
      ]);
      if (!this.isCurrentRefreshTarget(target)) return;
      // Seed the in-flight partial assistant message on top of committed history
      // and record the snapshot's sequence as the watermark. Buffered/live events
      // with `seq <= watermark` are already reflected here and are dropped by
      // `applyEvent`; later events (`seq > watermark`) stream in on top. The
      // partial is seeded into the in-memory transcript only, never the raw
      // history cache, so it never persists.
      const history = this.transcripts.mergeHistory(key, page);
      const messages = this.transcripts.seedStreamingPartial(history.messages, streamSnapshot.partial);
      this.streamWatermark = { sessionId: target.session.id, seq: streamSnapshot.seq };
      this.setState({
        ...history,
        messages,
        status,
        activity: this.getState().sessionActivities[target.session.id],
      });
      this.applyStatus(status);
    });
  }

  private isCurrentRefreshTarget(target: SelectedSessionRefreshTarget): boolean {
    return this.isCurrentSessionSelection(target.session.id, target.machineId, target.selectionSeq);
  }

  private isCurrentSessionSelection(sessionId: string, machineId: string, selectionSeq: number): boolean {
    return selectionSeq === this.selectionSeq && this.isSelectedSessionIdentity(sessionId, machineId);
  }

  private isSelectedSessionIdentity(sessionId: string, machineId: string): boolean {
    if (this.disposed) return false;
    const state = this.getState();
    const selected = state.selectedSession;
    return selectedMachineId(state) === machineId
      && selected?.id === sessionId
      && selected.archived !== true
      && !isClientPendingStartSessionInfo(selected);
  }

  private applyBulkSessionFailures(action: string, failures: readonly string[]): void {
    if (failures.length === 0) return;
    this.setState({ error: `${action} failed for ${String(failures.length)} session${failures.length === 1 ? "" : "s"}: ${failures.join("; ")}` });
  }

  private sessionCacheKey(sessionId: string): string {
    return machineSessionKey(selectedMachineId(this.getState()), sessionId);
  }

  private statusForSession(session: SessionInfo | undefined): SessionStatus | undefined {
    if (session === undefined) return undefined;
    const state = this.getState();
    if (state.status?.sessionId === session.id && state.selectedSession?.id === session.id) return state.status;
    return state.sessionStatuses[session.id];
  }

  private sessionPersistenceOptions() {
    const state = this.getState();
    return sessionPersistenceOptionsForRuntime(state.machineRuntimes[selectedMachineId(state)]);
  }

  private workspaceSelectionKey(cwd: string): string {
    return `${selectedMachineId(this.getState())}:${cwd}`;
  }

  private replaceSession(session: SessionInfo) {
    const state = this.getState();
    const current = state.selectedSession;
    this.setState({
      sessions: state.sessions.map((candidate) => candidate.id === session.id ? session : candidate),
      projectSessions: state.projectSessions.map((candidate) => candidate.id === session.id ? session : candidate),
      selectedSession: current?.id === session.id ? session : current,
    });
  }

  private createPendingSessionStart(workspace: Workspace, machineId: string, modelPolicy: SessionModelPolicyUpdate | undefined): PendingSessionStart {
    const tempId = `pending-session-${String(++this.pendingSessionStartSeq)}-${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    const session: ClientPendingStartSessionInfo = {
      id: tempId,
      path: `pi-webui://pending-session/${tempId}`,
      cwd: workspace.path,
      persisted: false,
      name: "New session",
      created: now,
      modified: now,
      messageCount: 0,
      firstMessage: "",
      clientPendingStart: true,
      machineId,
    };
    return { tempId, workspaceId: workspace.id, cwd: workspace.path, machineId, session, queuedSends: [], discarded: false, modelPolicy };
  }

  private insertAndSelectPendingSession(session: ClientPendingStartSessionInfo): void {
    const state = this.getState();
    this.selectClientPendingStartSession(session, {
      activity: creatingPendingSessionActivity(session.id),
      sessions: [session, ...state.sessions.filter((candidate) => candidate.id !== session.id)],
    });
  }

  private selectClientPendingStartSession(session: ClientPendingStartSessionInfo, options?: { updateUrl?: boolean | undefined; activity?: SessionActivity | undefined; sessions?: SessionInfo[] | undefined }): void {
    this.sessionSelection.rememberSession({ ...session, cwd: this.workspaceSelectionKey(session.cwd) });
    this.selectionSeq += 1;
    this.socket.close();
    this.notifications?.clearSelectedSession();
    this.streamWatermark = undefined;
    this.clearPendingUpdates();
    const state = this.getState();
    const pendingStart = this.pendingSessionStarts.get(session.id);
    const activity = options?.activity ?? state.sessionActivities[session.id] ?? (pendingStart !== undefined ? creatingPendingSessionActivity(session.id, pendingStart.queuedSends.length) : undefined);
    this.setState({
      ...(options?.sessions === undefined ? {} : { sessions: options.sessions }),
      selectedSession: session,
      messages: [],
      messagePageStart: 0,
      messagePageEnd: 0,
      messagePageTotal: 0,
      isLoadingEarlierMessages: false,
      status: undefined,
      activity,
      availableThinkingLevels: [],
      ...this.clearSelectedModelPolicyState(),
      treeDialog: undefined,
      ...(activity === undefined ? {} : { sessionActivities: { ...state.sessionActivities, [session.id]: activity } }),
      error: "",
    });
    if (options?.updateUrl !== false) this.updateUrl();
  }

  private async resolvePendingSessionStart(tempId: string, session: SessionInfo): Promise<void> {
    const pending = this.pendingSessionStarts.get(tempId);
    if (pending === undefined) return;
    this.pendingSessionStarts.delete(tempId);
    const queuedSends = pending.queuedSends.splice(0);
    const releasedCreatedSessions = this.takeSuppressedCreatedSessionsFor(pending.cwd, pending.machineId, session.id);
    if (pending.discarded) {
      clearDraft(machineSessionKey(pending.machineId, tempId));
      this.setState({ clientQueuedSessionMessages: omitKey(this.getState().clientQueuedSessionMessages, tempId) });
      this.applyReleasedCreatedSessions(releasedCreatedSessions, pending.machineId);
      void this.api.stop(session, pending.machineId).catch(() => {
        // Best-effort cleanup for a backend session whose temporary UI row was discarded before creation finished.
      });
      return;
    }

    rememberCachedNewSession(session, pending.machineId);
    moveDraft(machineSessionKey(pending.machineId, tempId), machineSessionKey(pending.machineId, session.id));
    const cachedSession = markCachedNewSessionInfo(session, pending.machineId);
    if (!this.isCurrentPendingStart(pending)) {
      this.setState({ clientQueuedSessionMessages: omitKey(this.getState().clientQueuedSessionMessages, tempId) });
      await this.flushQueuedPendingSends(cachedSession, pending.machineId, queuedSends);
      return;
    }

    const state = this.getState();
    const wasSelected = state.selectedSession?.id === tempId;
    this.setState({
      sessions: replacePendingSessionInList(state.sessions, tempId, cachedSession),
      sessionActivities: omitSessionActivity(state.sessionActivities, tempId),
      sendingPrompts: moveRecordKey(state.sendingPrompts, tempId, cachedSession.id),
      clientQueuedSessionMessages: moveRecordKey(state.clientQueuedSessionMessages, tempId, cachedSession.id),
      ...(wasSelected ? { selectedSession: cachedSession, status: state.sessionStatuses[cachedSession.id], activity: state.sessionActivities[cachedSession.id] } : {}),
      error: "",
    });
    this.applyReleasedCreatedSessions(releasedCreatedSessions, pending.machineId);
    if (wasSelected) {
      this.updateUrl({ replace: true });
      await this.selectSession(cachedSession, { updateUrl: false });
    }
    await this.flushQueuedPendingSends(cachedSession, pending.machineId, queuedSends);
  }

  private failPendingSessionStart(tempId: string, error: unknown): void {
    const pending = this.pendingSessionStarts.get(tempId);
    if (pending === undefined) return;
    this.pendingSessionStarts.delete(tempId);
    const releasedCreatedSessions = this.takeSuppressedCreatedSessionsFor(pending.cwd, pending.machineId);
    const isCurrentPendingStart = this.isCurrentPendingStart(pending);
    if (pending.discarded || !isCurrentPendingStart) {
      if (isCurrentPendingStart) this.applyReleasedCreatedSessions(releasedCreatedSessions, pending.machineId);
      return;
    }
    const state = this.getState();
    const message = errorMessage(error);
    const activity = failedPendingSessionActivity(tempId, message, pending.queuedSends.length);
    const hasPendingRow = state.sessions.some((session) => session.id === tempId);
    this.setState({
      sessions: hasPendingRow ? state.sessions : [pending.session, ...state.sessions],
      sessionActivities: { ...state.sessionActivities, [tempId]: activity },
      activity: state.selectedSession?.id === tempId ? activity : state.activity,
      error: `Failed to start session: ${message}`,
    });
    this.applyReleasedCreatedSessions(releasedCreatedSessions, pending.machineId);
  }

  private isCurrentPendingStart(pending: PendingSessionStart): boolean {
    const state = this.getState();
    return selectedMachineId(state) === pending.machineId && state.selectedWorkspace?.id === pending.workspaceId;
  }

  private hasPendingStartFor(cwd: string, machineId: string): boolean {
    return Array.from(this.pendingSessionStarts.values()).some((pending) => pending.cwd === cwd && pending.machineId === machineId);
  }

  private isSuppressedCreatedSession(session: SessionInfo, machineId: string): boolean {
    const suppressed = this.suppressedCreatedSessions.get(session.id);
    return suppressed?.session.cwd === session.cwd && suppressed.machineId === machineId;
  }

  private takeSuppressedCreatedSessionsFor(cwd: string, machineId: string, resolvedSessionId?: string): SessionInfo[] {
    if (resolvedSessionId !== undefined) this.suppressedCreatedSessions.delete(resolvedSessionId);
    if (this.hasPendingStartFor(cwd, machineId)) return [];
    const released: SessionInfo[] = [];
    for (const [sessionId, suppressed] of this.suppressedCreatedSessions) {
      if (suppressed.session.cwd !== cwd || suppressed.machineId !== machineId) continue;
      this.suppressedCreatedSessions.delete(sessionId);
      released.push(suppressed.session);
    }
    return released;
  }

  private applyReleasedCreatedSessions(sessions: readonly SessionInfo[], machineId: string): void {
    if (sessions.length === 0 || selectedMachineId(this.getState()) !== machineId) return;
    const state = this.getState();
    if (state.selectedWorkspace === undefined) return;
    const existingIds = new Set(state.sessions.map((session) => session.id));
    const released = sessions.filter((session) => session.cwd === state.selectedWorkspace?.path && !existingIds.has(session.id));
    if (released.length === 0) return;
    this.setState({ sessions: [...released.reverse(), ...state.sessions] });
  }

  private mergePendingStartSessions(cwd: string, sessions: SessionInfo[], machineId: string): SessionInfo[] {
    const pending = this.getState().sessions.filter((session): session is ClientPendingStartSessionInfo => isClientPendingStartSessionInfo(session) && session.cwd === cwd && session.machineId === machineId);
    if (pending.length === 0) return sessions;
    const pendingIds = new Set(pending.map((session) => session.id));
    return [...pending, ...sessions.filter((session) => !pendingIds.has(session.id))];
  }

  private async recreateCachedNewSession(session: SessionInfo, options?: { updateUrl?: boolean | undefined }): Promise<void> {
    try {
      const machineId = selectedMachineId(this.getState());
      const replacement = await this.api.startSession(session.cwd, machineId);
      rememberCachedNewSession(replacement, machineId);
      moveDraft(this.sessionCacheKey(session.id), this.sessionCacheKey(replacement.id));
      forgetCachedNewSession(session.id, machineId);
      const cachedReplacement = markCachedNewSessionInfo(replacement, machineId);
      this.setState({ sessions: [cachedReplacement, ...this.getState().sessions.filter((candidate) => candidate.id !== session.id)], error: "" });
      await this.selectSession(cachedReplacement, { updateUrl: false });
      this.updateUrl(options?.updateUrl === false ? { replace: true } : undefined);
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  private markCachedNewSessionPersisted(session: SessionInfo): void {
    if (!isCachedNewSessionInfo(session)) return;
    const latest = this.getState().sessions.find((candidate) => candidate.id === session.id) ?? session;
    this.replaceSession(stripCachedNewSessionMarker(latest));
  }

  private applyCommandResult(result: CommandResult) {
    if (result.type === "select") {
      this.setState({ commandDialog: result });
      return;
    }
    if (result.type === "tree") {
      this.setState({ treeDialog: result.tree });
      return;
    }
    const message = result.type === "unsupported" ? result.message : result.message;
    if (message !== undefined && message !== "") this.setState({ messages: [...this.getState().messages, textMessage(result.type === "unsupported" ? "system" : "tool", message)] });
    if (result.type === "done" && result.session) {
      if (result.promptDraft !== undefined) saveDraft(this.sessionCacheKey(result.session.id), result.promptDraft);
      const current = this.getState().selectedSession;
      const sessions = [result.session, ...this.getState().sessions.filter((session) => session.id !== result.session?.id)];
      this.setState({ sessions, selectedSession: current?.id === result.session.id ? result.session : current });
      if (current?.id !== result.session.id) void this.selectSession(result.session);
    }
  }

  private applyCreatedSession(session: SessionInfo) {
    const state = this.getState();
    const belongsToSelectedProject = state.selectedWorkspace?.path === session.cwd || state.workspaces.some((workspace) => workspace.path === session.cwd);
    const projectSessions = belongsToSelectedProject ? prependOrReplaceSession(state.projectSessions, session) : state.projectSessions;
    // Only surface sessions for the workspace currently in view; cross-workspace
    // records still join the project catalog so they can appear beneath a local
    // parent without replacing the workspace's actionable session list.
    if (state.selectedWorkspace?.path !== session.cwd) {
      if (projectSessions !== state.projectSessions) this.setState({ projectSessions });
      return;
    }
    if (state.sessions.some((candidate) => candidate.id === session.id)) {
      if (projectSessions !== state.projectSessions) this.setState({ projectSessions });
      return;
    }
    const machineId = selectedMachineId(state);
    if (this.hasPendingStartFor(session.cwd, machineId)) {
      this.suppressedCreatedSessions.set(session.id, { session, machineId });
      if (projectSessions !== state.projectSessions) this.setState({ projectSessions });
      return;
    }
    this.setState({ sessions: [session, ...state.sessions], projectSessions });
  }

  private applyActivity(activity: SessionActivity) {
    this.setState({
      sessionActivities: { ...this.getState().sessionActivities, [activity.sessionId]: activity },
      activity: this.getState().selectedSession?.id === activity.sessionId ? activity : this.getState().activity,
    });
  }

  private applyStatus(status: SessionStatus) {
    const state = this.getState();
    const clearsStaleActivity = state.sessionActivities[status.sessionId]?.phase === "active" && !isSessionActive(status);
    this.setState({
      sessionStatuses: { ...state.sessionStatuses, [status.sessionId]: status },
      ...sessionMessageCountPatch(state, status.sessionId, status.messageCount),
      ...(clearsStaleActivity ? { sessionActivities: omitSessionActivity(state.sessionActivities, status.sessionId) } : {}),
      status: state.selectedSession?.id === status.sessionId ? status : state.status,
      activity: state.selectedSession?.id === status.sessionId && clearsStaleActivity ? undefined : state.activity,
    });
    this.invalidateSupersededModelPolicy(status);
  }

  private applySessionName(sessionId: string, name: string | undefined) {
    const rename = (session: SessionInfo) => {
      if (session.id !== sessionId) return session;
      const next = { ...session };
      if (name === undefined || name === "") delete next.name;
      else next.name = name;
      return next;
    };
    const selectedSession = this.getState().selectedSession;
    const state = this.getState();
    this.setState({
      sessions: state.sessions.map(rename),
      projectSessions: state.projectSessions.map(rename),
      selectedSession: selectedSession === undefined ? undefined : rename(selectedSession),
    });
  }

  private applyEvent(event: SessionUiEvent) {
    // Notification revisions use their own join snapshot. Handle them before the
    // transcript watermark so a notification event sharing an already-seeded
    // transcript sequence cannot be lost.
    if (event.type === "notifications.inbox") {
      this.notifications?.applyInboxEvent(selectedMachineId(this.getState()), event);
      return;
    }
    if (event.type === "command.output" && this.notifications?.shouldFilterLegacyNotification(selectedMachineId(this.getState()), event.notificationId) === true) return;

    // Drop events already reflected in the seeded join snapshot (committed
    // history + partial). Everything past the watermark applies exactly once,
    // so live content streams directly on top of the seeded partial.
    if (this.isStreamEventBelowWatermark(event)) return;

    // Status and activity arrive once per token (the server republishes them on
    // every transcript event). Buffer them alongside high-frequency transcript
    // deltas so the host component renders at most once per animation frame
    // instead of once per token. Coalescing these here is what keeps the prompt
    // editor's DOM stable during streaming, so in-progress touch gestures (e.g.
    // the iOS long-press edit/paste callout) are not interrupted by a re-render.
    if (event.type === "status.update") {
      this.queueStatusUpdate(event.status);
      return;
    }
    if (event.type === "activity.update") {
      this.queueActivityUpdate(event.activity);
      return;
    }
    if (isBufferedStreamEvent(event)) {
      this.queueTranscriptEvent(event);
      return;
    }

    this.flushPendingUpdates();
    const transcript = this.transcripts.applyLiveEvent(this.getState().messages, event);
    if (transcript) {
      this.setState({ messages: transcript });
    } else if (event.type === "session.name") {
      this.applySessionName(event.sessionId, event.name);
    }
    if (event.type === "agent.end") {
      // Live prompt events contain message content but not session-entry IDs.
      // Reconcile once the turn is durable so history actions become available
      // without requiring the user to reload the browser.
      void this.refreshSelectedSession();
    }
  }

  private queueTranscriptEvent(event: Parameters<StreamEventBuffer["enqueue"]>[0]): void {
    this.streamEventBuffer.enqueue(event);
    this.schedulePendingFlush();
  }

  /** Buffered transcript-event count after materializing coalesced runs. Exposed for tests. */
  pendingTranscriptEventCount(): number {
    return this.streamEventBuffer.eventCount;
  }

  private queueStatusUpdate(status: SessionStatus): void {
    this.pendingStatusBySession.set(status.sessionId, status);
    this.schedulePendingFlush();
  }

  private queueActivityUpdate(activity: SessionActivity): void {
    this.pendingActivityBySession.set(activity.sessionId, activity);
    this.schedulePendingFlush();
  }

  private schedulePendingFlush(): void {
    if (this.pendingFrame !== undefined) return;
    this.pendingFrame = requestAnimationFrame(() => {
      this.pendingFrame = undefined;
      this.flushPendingUpdates();
    });
  }

  // Apply buffered transcript deltas, activity, and status in one task. Activity
  // is applied before status to mirror the server's publish order, so an idle
  // status can clear the now-stale active activity it supersedes. Status and
  // activity are last-write-wins per session, so iterating the maps applies only
  // the latest buffered value per session. These writes run in a single task, so
  // Lit batches them into one render.
  flushPendingUpdates(): void {
    const { events, resyncRequired } = this.streamEventBuffer.drain();
    if (events.length > 0) {
      let messages = this.getState().messages;
      for (const event of events) messages = this.transcripts.applyLiveEvent(messages, event) ?? messages;
      if (messages !== this.getState().messages) this.setState({ messages });
    }
    if (resyncRequired) this.requestOverloadResync();
    if (this.pendingActivityBySession.size > 0) {
      const activities = Array.from(this.pendingActivityBySession.values());
      this.pendingActivityBySession.clear();
      for (const activity of activities) this.applyActivity(activity);
    }
    if (this.pendingStatusBySession.size > 0) {
      const statuses = Array.from(this.pendingStatusBySession.values());
      this.pendingStatusBySession.clear();
      for (const status of statuses) this.applyStatus(status);
    }
  }

  /**
   * Buffer overflow means the client is behind, and the recovery refetch is the
   * most expensive operation available. Without a floor between attempts, a
   * sustained surge trips the cap again within a few hundred milliseconds and
   * the refetch becomes a self-sustaining loop that freezes the tab.
   */
  private requestOverloadResync(target = this.selectedSessionRefreshTarget(this.getState().selectedSession?.id)): void {
    if (target === undefined || !this.isCurrentRefreshTarget(target)) return;
    const now = this.now();
    const last = this.lastOverloadResyncAt;
    if (last !== undefined) {
      const elapsed = now - last;
      if (elapsed < OVERLOAD_RESYNC_MIN_INTERVAL_MS) {
        this.scheduleDeferredOverloadResync(target, OVERLOAD_RESYNC_MIN_INTERVAL_MS - elapsed);
        return;
      }
    }
    this.cancelPendingOverloadResync();
    this.lastOverloadResyncAt = now;
    void this.refreshSelectedSessionTarget(target);
  }

  private scheduleDeferredOverloadResync(target: SelectedSessionRefreshTarget, delayMs: number): void {
    if (this.pendingOverloadResync !== undefined) return;
    const pending: PendingOverloadResync = { cancel: () => undefined };
    this.pendingOverloadResync = pending;
    pending.cancel = this.scheduleOverloadResync(() => {
      if (this.pendingOverloadResync !== pending) return;
      this.pendingOverloadResync = undefined;
      this.requestOverloadResync(target);
    }, delayMs);
  }

  private cancelPendingOverloadResync(): void {
    const pending = this.pendingOverloadResync;
    if (pending === undefined) return;
    this.pendingOverloadResync = undefined;
    pending.cancel();
  }

  private clearPendingUpdates(): void {
    this.lastOverloadResyncAt = undefined;
    this.cancelPendingOverloadResync();
    this.streamEventBuffer.clear();
    this.pendingStatusBySession.clear();
    this.pendingActivityBySession.clear();
    if (this.pendingFrame === undefined) return;
    cancelAnimationFrame(this.pendingFrame);
    this.pendingFrame = undefined;
  }

  // Watermark filter for join-time exactly-once application. An event is below
  // the watermark when it belongs to the selected session's seeded snapshot
  // (`seq <= watermark.seq`); such events are already reflected in the committed
  // history + seeded partial and must be dropped. Events with no `seq` (which
  // should not occur on the per-session socket) are never dropped.
  private isStreamEventBelowWatermark(event: SessionUiEvent): boolean {
    const watermark = this.streamWatermark;
    if (watermark === undefined || watermark.sessionId !== this.getState().selectedSession?.id) return false;
    return event.seq !== undefined && event.seq <= watermark.seq;
  }
}

function omitSessionActivity(activities: Record<string, SessionActivity>, sessionId: string): Record<string, SessionActivity> {
  return omitKey(activities, sessionId);
}

/**
 * Whether two policy statuses describe the same authoritative policy. Compares
 * exactly what the daemon changes when the policy moves (mode, remembered tier,
 * resolved tuple, and blocked state), so an unrelated status republish during
 * streaming is not mistaken for a policy change.
 */
function modelPolicyStatusesAgree(a: ClientSessionModelPolicyStatus, b: ClientSessionModelPolicyStatus): boolean {
  return a.mode === b.mode
    && a.tier === b.tier
    && a.blockedReason === b.blockedReason
    && a.resolved.thinkingLevel === b.resolved.thinkingLevel
    && a.resolved.model.provider === b.resolved.model.provider
    && a.resolved.model.id === b.resolved.model.id;
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => id !== key));
}

function omitKeys<T>(record: Record<string, T>, keys: readonly string[]): Record<string, T> {
  if (keys.length === 0) return record;
  const removed = new Set(keys);
  return Object.fromEntries(Object.entries(record).filter(([id]) => !removed.has(id)));
}

function moveRecordKey<T>(record: Record<string, T>, fromKey: string, toKey: string): Record<string, T> {
  if (fromKey === toKey || !(fromKey in record)) return record;
  const value = record[fromKey];
  if (value === undefined) return record;
  return { ...omitKey(record, fromKey), [toKey]: value };
}

function prependOrReplaceSession(sessions: SessionInfo[], session: SessionInfo): SessionInfo[] {
  const existing = sessions.find((candidate) => candidate.id === session.id || candidate.path === session.path);
  if (existing === session) return sessions;
  return [session, ...sessions.filter((candidate) => candidate.id !== session.id && candidate.path !== session.path)];
}

function replacePendingSessionInList(sessions: readonly SessionInfo[], pendingSessionId: string, resolvedSession: SessionInfo): SessionInfo[] {
  const next: SessionInfo[] = [];
  let inserted = false;
  for (const session of sessions) {
    if (session.id === pendingSessionId) {
      if (!inserted) {
        next.push(resolvedSession);
        inserted = true;
      }
      continue;
    }
    if (session.id === resolvedSession.id) continue;
    next.push(session);
  }
  if (!inserted) return [resolvedSession, ...next];
  return next;
}

function isClientPendingStartSessionInfo(session: SessionInfo | undefined): session is ClientPendingStartSessionInfo {
  return session !== undefined && "clientPendingStart" in session && session.clientPendingStart === true;
}

function creatingPendingSessionActivity(sessionId: string, queuedCount = 0): SessionActivity {
  return {
    sessionId,
    phase: "active",
    label: "Creating session",
    detail: queuedCount > 0 ? `${String(queuedCount)} queued ${queuedCount === 1 ? "message" : "messages"} will send when the backend session is ready` : "Waiting for the backend session to be ready",
    at: new Date().toISOString(),
  };
}

function failedPendingSessionActivity(sessionId: string, message: string, queuedCount = 0): SessionActivity {
  const queuedDetail = queuedCount > 0 ? ` · ${String(queuedCount)} queued ${queuedCount === 1 ? "message" : "messages"} kept below` : "";
  return {
    sessionId,
    phase: "error",
    label: "Session creation failed",
    detail: `${message}${queuedDetail}`,
    at: new Date().toISOString(),
  };
}

function queuedSessionMessagePreview(queued: QueuedPendingSessionSend): QueuedSessionMessage {
  if (queued.type === "prompt") {
    return { kind: queued.streamingBehavior === "steer" ? "steer" : "followUp", text: queuedPromptPreviewText(queued.text, queued.attachments) };
  }
  return { kind: "followUp", text: queued.text };
}

function queuedPromptPreviewText(text: string, attachments: PromptAttachment[] | undefined): string {
  const attachmentText = queuedAttachmentSummary(attachments);
  if (attachmentText === undefined) return text;
  const trimmed = text.trim();
  return trimmed === "" ? attachmentText : `${text}\n\n${attachmentText}`;
}

function queuedAttachmentSummary(attachments: PromptAttachment[] | undefined): string | undefined {
  if (attachments === undefined || attachments.length === 0) return undefined;
  const names = attachments.map((attachment) => attachment.name?.trim()).filter((name): name is string => name !== undefined && name !== "");
  const count = attachments.length;
  const label = `${String(count)} ${count === 1 ? "attachment" : "attachments"}`;
  if (names.length === 0) return `[${label} queued]`;
  const shownNames = names.slice(0, 3).join(", ");
  const suffix = names.length > 3 ? `, +${String(names.length - 3)} more` : "";
  return `[${label} queued: ${shownNames}${suffix}]`;
}

function uniqueSessionsById(sessions: readonly SessionInfo[]): SessionInfo[] {
  const seen = new Set<string>();
  const unique: SessionInfo[] = [];
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    unique.push(session);
  }
  return unique;
}

function fulfilledValues<T>(results: readonly PromiseSettledResult<T>[]): T[] {
  return results.filter(isFulfilled).map((result) => result.value);
}

function bulkFailureMessages(failures: readonly SessionBulkFailure[]): string[] {
  return failures.map((failure) => `${failure.sessionId}: ${failure.error}`);
}

function settledSessionFailureMessages(sessions: readonly SessionInfo[], results: readonly PromiseSettledResult<unknown>[]): string[] {
  return results.flatMap((result, index) => {
    if (!isRejected(result)) return [];
    const sessionId = sessions[index]?.id ?? "unknown";
    return [`${sessionId}: ${errorMessage(result.reason)}`];
  });
}

async function allSettledWithConcurrency<T, R>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const indexedItems = items.map((item, index) => ({ item, index }));
  const results: PromiseSettledResult<R>[] = [];
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < indexedItems.length) {
      const entry = indexedItems[nextIndex];
      if (entry === undefined) return;
      nextIndex += 1;
      try {
        results[entry.index] = { status: "fulfilled", value: await worker(entry.item) };
      } catch (reason) {
        results[entry.index] = { status: "rejected", reason };
      }
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), indexedItems.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function isFulfilled<T>(result: PromiseSettledResult<T>): result is PromiseFulfilledResult<T> {
  return result.status === "fulfilled";
}

function isRejected<T>(result: PromiseSettledResult<T>): result is PromiseRejectedResult {
  return result.status === "rejected";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionMessageCountPatch(state: AppState, sessionId: string, messageCount: number | undefined): Pick<Partial<AppState>, "sessions" | "projectSessions" | "selectedSession"> {
  if (messageCount === undefined) return {};

  const sessionsChanged = state.sessions.some((session) => session.id === sessionId && session.messageCount !== messageCount);
  const sessions = sessionsChanged
    ? state.sessions.map((session) => session.id === sessionId ? { ...session, messageCount } : session)
    : undefined;
  const projectSessionsChanged = state.projectSessions.some((session) => session.id === sessionId && session.messageCount !== messageCount);
  const projectSessions = projectSessionsChanged
    ? state.projectSessions.map((session) => session.id === sessionId ? { ...session, messageCount } : session)
    : undefined;
  const selectedSession = state.selectedSession?.id === sessionId && state.selectedSession.messageCount !== messageCount
    ? { ...state.selectedSession, messageCount }
    : state.selectedSession;

  return {
    ...(sessions === undefined ? {} : { sessions }),
    ...(projectSessions === undefined ? {} : { projectSessions }),
    ...(selectedSession !== state.selectedSession ? { selectedSession } : {}),
  };
}

function isSessionNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("session not found");
}
