import { LitElement, css, html, nothing, svg, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { SessionActivity, SessionInfo, SessionReorderRequest, SessionStatus, Workspace } from "../api";
import { sessionActivityIndicators, sessionRowActivityKind } from "../sessionActivity";
import { sessionLabel } from "../sessionLabels";
import { isArchivableSessionInfo, isTransientNewSessionInfo } from "../sessionPersistence";
import { eligibleSessionReorderGroup, moveSessionInGroup, sessionReorderEdgeScrollDelta, sessionReorderInsertionIndex, sessionReorderRequest, sessionReorderSubtreePaths, sessionReorderThresholdReached, type SessionReorderPeerRect } from "../sessionReorder";
import { filterSessionRows, hasSessionSearchQuery } from "../sessionSearch";
import { sessionRows, sessionRowsForCurrentTree, sessionRowsForSearch, type SessionRow, type SessionRowsOptions } from "../sessionTreeRows";
import { isSessionActive } from "../../../shared/activity";
import { SESSION_REORDER_LIMIT } from "../../../shared/apiTypes";
import { actionMenuPanelStyle, isClickWithinActionMenu } from "./actionMenu";
import { renderActionActivityIndicators } from "./activityBadge";
import type { KeyboardNavigableSection } from "./navigationFocus";
import { activateSelectableRow, focusSelectedOrFirstSelectableRow, handleSelectableRowKeyboard, isFromInteractiveElement } from "./selectableRow";
import { listStyles } from "./shared";

export { sessionRowActivityKind } from "../sessionActivity";
export { sessionRowsForCurrentTree } from "../sessionTreeRows";
export type { SessionRow, SessionRowsOptions } from "../sessionTreeRows";

export interface SessionListRowsOptions extends Omit<SessionRowsOptions, "foldedSessionPaths"> {
  expandedSessionPaths?: ReadonlySet<string>;
  selectedSessionPath?: string;
}

type SessionSelectionScope = "current" | "archived";

interface SessionPointerDrag {
  pointerId: number;
  pointerType: string;
  originX: number;
  originY: number;
  clientX: number;
  clientY: number;
  handle: HTMLElement;
  selected: SessionInfo;
  group: SessionInfo[];
  rows: readonly SessionRow[];
  active: boolean;
  insertionIndex?: number;
}

interface SessionReorderPeer {
  rect: SessionReorderPeerRect;
  beforeSessionPath: string;
  afterSessionPath: string;
}

@customElement("session-list")
export class SessionList extends LitElement implements KeyboardNavigableSection {
  @property({ attribute: false }) sessions: SessionInfo[] = [];
  @property({ attribute: false }) projectSessions: SessionInfo[] = [];
  @property({ type: String }) currentWorkspacePath: string | undefined;
  @property({ attribute: false }) workspaces: Workspace[] = [];
  @property({ attribute: false }) statuses: Record<string, SessionStatus> = {};
  @property({ attribute: false }) activities: Record<string, SessionActivity> = {};
  @property({ attribute: false }) sending: Record<string, true> = {};
  @property({ attribute: false }) unreadSessionIds: ReadonlySet<string> = new Set();
  @property({ attribute: false }) selected?: SessionInfo;
  @property({ type: Number }) startingCount = 0;
  @property({ type: Boolean }) canStart = false;
  @property({ type: Boolean }) canDeleteArchived = false;
  @property({ type: Boolean }) canReload = false;
  @property({ type: Boolean }) canCleanup = false;
  @property({ type: Boolean }) canReorder = false;
  @property({ type: Boolean }) authoritativeSessionPersistence = false;
  @property({ type: String }) archivedDeleteUnavailableMessage = "Update and restart Pi-Web on this machine to delete archived sessions.";
  @property({ type: String }) cleanupUnavailableMessage = "Update and restart Pi-Web on this machine to clean up sessions.";
  @property({ type: Boolean, reflect: true }) collapsible = false;
  @property({ type: Boolean, reflect: true }) collapsed = false;
  @property({ attribute: false }) onSelect?: (session: SessionInfo) => void;
  @property({ attribute: false }) onRenameStart?: (session: SessionInfo) => void;
  @property({ attribute: false }) onRename?: (session: SessionInfo, name: string) => void | Promise<void>;
  @property({ attribute: false }) onStart?: () => void;
  @property({ attribute: false }) onOpenExpanded?: (restoreFocus: () => void) => void;
  @property({ attribute: false }) onToggleCollapsed?: () => void;
  @property({ attribute: false }) onArchivedCollapsed?: () => void;
  @property({ attribute: false }) onFocusPreviousSection?: () => void | Promise<void>;
  @property({ attribute: false }) onFocusNextSection?: () => void | Promise<void>;
  @property({ attribute: false }) onCancelKeyboardNavigation?: () => void | Promise<void>;
  @property({ attribute: false }) onArchive?: (session: SessionInfo) => void;
  @property({ attribute: false }) onArchiveWithDescendants?: (session: SessionInfo) => void;
  @property({ attribute: false }) onArchiveMany?: (sessions: SessionInfo[]) => void | Promise<void>;
  @property({ attribute: false }) onRestore?: (session: SessionInfo) => void;
  @property({ attribute: false }) onDelete?: (session: SessionInfo) => void;
  @property({ attribute: false }) onDeleteArchived?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onDeleteArchivedMany?: (sessions: SessionInfo[]) => void | Promise<void>;
  @property({ attribute: false }) onDetachParent?: (session: SessionInfo) => void;
  @property({ attribute: false }) onReload?: (session: SessionInfo) => void;
  @property({ attribute: false }) onPin?: (session: SessionInfo) => void;
  @property({ attribute: false }) onUnpin?: (session: SessionInfo) => void;
  @property({ attribute: false }) onReorder?: (session: SessionInfo, input: SessionReorderRequest) => void | Promise<void>;
  @property({ attribute: false }) onCleanup?: () => void;

  @state() private openMenuSessionId: string | undefined;
  @state() private menuStyle = "";
  @state() private archivedExpanded = false;
  @state() private selectionScopes: ReadonlySet<SessionSelectionScope> = new Set();
  @state() private selectedSessionIds: ReadonlySet<string> = new Set();
  @state() private renamingSessionId: string | undefined;
  @state() private renameInputValue = "";
  @state() private expandedSessionPaths: ReadonlySet<string> = new Set();
  @query(".session-search-input") private searchInput?: HTMLInputElement;
  @state() private searchOpen = false;
  @state() private searchQuery = "";
  @state() private reorderPending = false;

  private sessionPointerDrag: SessionPointerDrag | undefined;
  private sessionReorderFrame: number | undefined;

  private readonly onDocumentClick = (event: Event) => {
    if (isClickWithinActionMenu(event, this.renderRoot)) return;
    this.openMenuSessionId = undefined;
  };

  private readonly onDocumentPointerMove = (event: PointerEvent) => { this.moveSessionReorder(event); };
  private readonly onDocumentPointerUp = (event: PointerEvent) => { this.finishSessionReorder(event); };
  private readonly onDocumentPointerCancel = (event: PointerEvent) => {
    if (this.sessionPointerDrag?.pointerId === event.pointerId) this.cancelSessionReorder();
  };
  private readonly onDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || this.sessionPointerDrag === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    this.cancelSessionReorder();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this.onDocumentClick, true);
    document.addEventListener("pointermove", this.onDocumentPointerMove);
    document.addEventListener("pointerup", this.onDocumentPointerUp);
    document.addEventListener("pointercancel", this.onDocumentPointerCancel);
    document.addEventListener("keydown", this.onDocumentKeydown);
  }

  override disconnectedCallback(): void {
    document.removeEventListener("click", this.onDocumentClick, true);
    document.removeEventListener("pointermove", this.onDocumentPointerMove);
    document.removeEventListener("pointerup", this.onDocumentPointerUp);
    document.removeEventListener("pointercancel", this.onDocumentPointerCancel);
    document.removeEventListener("keydown", this.onDocumentKeydown);
    this.cancelSessionReorder();
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>): void {
    const reorderInvalidated = changed.has("selected")
      || changed.has("sessions")
      || changed.has("projectSessions")
      || changed.has("currentWorkspacePath")
      || changed.has("workspaces")
      || changed.has("collapsed")
      || changed.has("canReorder")
      || hasChangedProperty(changed, "searchOpen")
      || hasChangedProperty(changed, "searchQuery")
      || hasChangedProperty(changed, "selectionScopes")
      || hasChangedProperty(changed, "renamingSessionId");
    if (this.sessionPointerDrag !== undefined && reorderInvalidated) this.cancelSessionReorder();
    if (changed.has("sessions")) {
      if (this.openMenuSessionId !== undefined && !this.sessions.some((session) => session.id === this.openMenuSessionId)) this.openMenuSessionId = undefined;
      if (this.renamingSessionId !== undefined && !this.sessions.some((session) => session.id === this.renamingSessionId)) this.cancelSessionRename();
      if (!this.sessions.some((session) => session.archived === true)) this.archivedExpanded = false;
      this.pruneSelectedSessionIds();
    }
    if (changed.has("currentWorkspacePath")) this.expandedSessionPaths = new Set();
    else if (changed.has("sessions") || changed.has("projectSessions")) this.pruneExpandedSessionPaths();
    if (changed.has("collapsed") && this.collapsed) {
      this.openMenuSessionId = undefined;
      this.cancelSessionRename();
    }
    const previousSelected = changed.get("selected");
    if (changed.has("selected") && this.selected?.archived === true && (previousSelected?.id !== this.selected.id || previousSelected.archived !== true) && !this.archivedExpanded) {
      this.archivedExpanded = true;
      void this.updateComplete.then(() => { this.scrollSelectedIntoView(); });
      return;
    }
    if ((changed.has("selected") || changed.has("sessions") || changed.has("collapsed")) && !this.collapsed) this.scrollSelectedIntoView();
  }

  async focusSelectedOrFirst(): Promise<boolean> {
    await this.updateComplete;
    return focusSelectedOrFirstSelectableRow(this.renderRoot, { fallbackSelector: ".section-toggle, h2 button:not([disabled])" });
  }

  override render() {
    const sessionTreeSessions = this.sessionTreeSessions();
    const treeOptions = this.currentSessionTreeOptions();
    const normalCurrentRows = sessionRowsForSessionList(sessionTreeSessions, {
      ...treeOptions,
      expandedSessionPaths: this.expandedSessionPaths,
      ...(this.selected === undefined ? {} : { selectedSessionPath: this.selected.path }),
    });
    const unfoldedCurrentRows = sessionRowsForCurrentTree(sessionTreeSessions, treeOptions);
    const currentRowPaths = new Set(unfoldedCurrentRows.map((row) => row.session.path));
    const allArchivedRows = sessionRows(this.sessions.filter((session) => session.archived === true && !currentRowPaths.has(session.path)));
    const searchActive = hasSessionSearchQuery(this.searchQuery);
    const searchRows = searchActive
      ? filterSessionRows(sessionRowsForSearch(sessionTreeSessions, treeOptions), this.searchQuery)
      : [];
    const { currentRows, archivedRows } = searchActive
      ? partitionSearchRows(searchRows)
      : { currentRows: normalCurrentRows, archivedRows: allArchivedRows };
    const reorderMarkers = !this.searchOpen && !searchActive;
    const reorderGroup = reorderMarkers && this.selected !== undefined
      ? eligibleSessionReorderGroup(unfoldedCurrentRows, this.selected, this.currentWorkspacePath)
      : [];
    const currentSelectableSessions = selectableCurrentSessions(currentRows);
    const unfilteredCurrentSelectableSessions = selectableCurrentSessions(normalCurrentRows);
    const archivedVisible = this.archivedExpanded || (searchActive && archivedRows.length > 0);
    const currentRowGroups = currentRows.reduce<SessionRow[][]>((groups, row) => {
      if (row.depth === 0) groups.push([row]);
      else groups.at(-1)?.push(row);
      return groups;
    }, []);
    const descendantCounts = unarchivedDescendantCounts(this.sessions);
    const unreadCount = unreadSessionCount(unfilteredCurrentSelectableSessions, this.unreadSessionIds, {
      statuses: this.statuses,
      activities: this.activities,
      sending: this.sending,
    });
    return html`
      <section>
        ${this.renderHeading(normalCurrentRows.length + allArchivedRows.length, currentSelectableSessions, unreadCount)}
        ${this.collapsed ? null : html`
          ${this.searchOpen ? this.renderSearchInput() : null}
          <div class="list-body">
            ${this.renderCurrentSelectionToolbar(currentSelectableSessions)}
            ${this.startingCount > 0 ? this.renderStartingSession() : null}
            ${currentRowGroups.map((rows) => {
              const root = rows[0];
              const rootPath = root?.session.path;
              const familySubject = reorderMarkers
                && rootPath !== undefined
                && root?.session.archived !== true
                && root?.hasChildren === true
                && rows.length > 1;
              const renderedRows = rows.map((row) => this.renderSession(
                row,
                descendantCounts.get(row.session.id) ?? 0,
                "current",
                sessionTreeSessions,
                reorderGroup,
                currentRows,
                reorderMarkers,
                familySubject && row.session.path === rootPath,
              ));
              return root?.hasChildren === true
                ? html`<div class="session-family-frame" data-session-reorder-path=${familySubject ? rootPath : nothing}>${renderedRows}</div>`
                : renderedRows;
            })}
            ${archivedRows.length > 0 ? html`
              ${this.renderArchivedHeading(archivedRows.map((row) => row.session), archivedVisible)}
              ${archivedVisible ? html`
                ${this.renderArchivedSelectionToolbar(archivedRows.map((row) => row.session))}
                ${archivedRows.map((row) => this.renderSession(
                  row,
                  descendantCounts.get(row.session.id) ?? 0,
                  "archived",
                  sessionTreeSessions,
                  [],
                  currentRows,
                  false,
                  false,
                ))}
              ` : null}
            ` : null}
            ${searchActive && currentRows.length === 0 && archivedRows.length === 0
              ? html`<p class="session-search-empty">No matching sessions.</p>`
              : null}
          </div>
        `}
      </section>
    `;
  }

  private renderHeading(sessionCount: number, currentSessions: SessionInfo[], unreadCount: number) {
    if (!this.collapsible) {
      return html`
        <h2>
          <span class="plain-heading">Sessions</span>
          ${this.renderExpandedBrowserButton()}
          ${this.renderSearchButton()}
          ${this.renderCurrentSelectionButton(currentSessions)}
          ${this.renderUnreadCount(unreadCount)}
          ${this.renderCleanupButton()}
          ${this.renderStartButton()}
        </h2>
      `;
    }
    const selectedSummary = this.selected === undefined ? "No session selected" : sessionLabel(this.selected);
    const selectedTitle = this.selected?.path ?? selectedSummary;
    return html`
      <h2>
        <button class="section-toggle" aria-expanded=${String(!this.collapsed)} @click=${() => { this.onToggleCollapsed?.(); }}><span class="section-title"><span class="section-name">${this.collapsed ? "▸" : "▾"} Sessions</span>${this.collapsed ? html`<small class="section-selected" dir="auto" title=${selectedTitle}>${selectedSummary}</small>` : null}</span></button>
        ${this.renderExpandedBrowserButton()}
        ${this.renderSearchButton()}
        ${this.renderCurrentSelectionButton(currentSessions)}
        ${this.renderUnreadCount(unreadCount)}
        <small class="section-count">${sessionCount}</small>
        ${this.renderCleanupButton()}
        ${this.renderStartButton()}
      </h2>
    `;
  }

  private renderUnreadCount(unreadCount: number) {
    if (unreadCount === 0) return null;
    const label = `${String(unreadCount)} unread`;
    return html`<small class="section-unread-count" title=${label}>${label}</small>`;
  }

  private renderExpandedBrowserButton() {
    if (this.onOpenExpanded === undefined) return null;
    return html`
      <button type="button" class="section-expand-button" title="Open expanded session browser" aria-label="Open expanded session browser" @click=${(event: MouseEvent) => { this.openExpandedBrowser(event); }}>
        ${svg`<svg class="section-expand-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 3H3v6M15 3h6v6M21 15v6h-6M9 21H3v-6"></path></svg>`}
      </button>
    `;
  }

  private openExpandedBrowser(event: MouseEvent): void {
    event.stopPropagation();
    const launcher = event.currentTarget;
    this.onOpenExpanded?.(() => {
      if (launcher instanceof HTMLButtonElement) launcher.focus();
    });
  }

  private renderSearchButton() {
    if (this.collapsed) return null;
    const label = this.searchOpen ? "Close session search" : "Search sessions";
    return html`
      <button type="button" class="section-search-button" title=${label} aria-label=${label} aria-expanded=${String(this.searchOpen)} aria-controls="session-search" @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleSessionSearch(); }}>
        ${svg`<svg class="section-search-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="6"></circle><path d="m16 16 4 4"></path></svg>`}
      </button>
    `;
  }

  private renderSearchInput() {
    return html`<div class="session-search"><input id="session-search" class="session-search-input" type="search" placeholder="Search sessions" aria-label="Search sessions" .value=${this.searchQuery} @input=${(event: Event) => { this.handleSearchInput(event); }}></div>`;
  }

  private toggleSessionSearch(): void {
    this.cancelSessionReorder();
    this.searchOpen = !this.searchOpen;
    if (!this.searchOpen) {
      this.searchQuery = "";
      return;
    }
    void this.updateComplete.then(() => {
      if (this.searchOpen) this.searchInput?.focus();
    });
  }

  private handleSearchInput(event: Event): void {
    if (!hasStringValue(event.target)) return;
    this.searchQuery = event.target.value;
    this.openMenuSessionId = undefined;
  }

  private renderCurrentSelectionButton(currentSessions: SessionInfo[]) {
    if (this.collapsed || currentSessions.length === 0) return null;
    const active = this.selectionScopes.has("current");
    return html`<button class="bulk-select-entry ${active ? "selected" : ""}" title=${active ? "Close current session selection" : "Select current sessions"} aria-label=${active ? "Close current session selection" : "Select current sessions"} aria-expanded=${String(active)} aria-pressed=${String(active)} @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleSelection("current", currentSessions); }}>☑</button>`;
  }

  private renderCleanupButton() {
    const label = this.canCleanup ? "Preview session cleanup" : this.cleanupUnavailableMessage;
    return html`<button type="button" class="cleanup-entry" title=${label} aria-label=${label} @click=${(event: MouseEvent) => { event.stopPropagation(); this.onCleanup?.(); }}>
      ${svg`<svg class="cleanup-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path class="cleanup-broom" d="M4 3 12.2 13.8"></path>
  <path class="cleanup-broom" d="m10.7 12.8 2.8 2.1"></path>
  <path class="cleanup-broom" d="M11 13.5c-1.4 1.1-1.5 2.9-.7 4.4.8 1.5 1.2 2.6.8 3.6 1.9.2 3.5-.1 4.6-1.1 1.2.2 2.4-.1 3.3-.8 1.4-.1 2.4-.9 2.9-1.9-3.7-.5-6.4-2.5-8.5-5.2Z"></path>
  <path class="cleanup-broom" d="M12 18.5v2.4"></path>
  <path class="cleanup-broom" d="M14.6 18.8v2"></path>
  <path class="cleanup-broom" d="M17.2 18.7v1.5"></path>
  <path class="cleanup-sparkle" d="m17.5 2 .55 1.45 1.45.55-1.45.55-.55 1.45-.55-1.45-1.45-.55 1.45-.55Z"></path>
  <path class="cleanup-sparkle" d="m20 7 .4 1.1 1.1.4-1.1.4-.4 1.1-.4-1.1-1.1-.4 1.1-.4Z"></path>
</svg>`}
    </button>`;
  }

  private renderStartButton() {
    const title = this.startingCount > 0 ? "Start another session" : "Start a new session";
    return html`<button class="section-add-button" title=${title} aria-label=${title} ?disabled=${!this.canStart} @click=${(event: MouseEvent) => { event.stopPropagation(); this.onStart?.(); }}>+</button>`;
  }

  private renderStartingSession() {
    const plural = this.startingCount !== 1;
    return html`
      <div class="pending-session-row starting-session" role="status" aria-live="polite">
        <div class="action-main">
          <span class="action-name"><span class="activity-indicator sending" aria-hidden="true"></span>${plural ? `Starting ${String(this.startingCount)} sessions…` : "Starting session…"}</span>
          <small>Waiting for ${plural ? "new sessions" : "the new session"} to be created</small>
        </div>
      </div>
    `;
  }

  private renderArchivedHeading(archivedSessions: SessionInfo[], expanded: boolean) {
    const active = this.selectionScopes.has("archived");
    return html`
      <h2 class="subheading">
        ${hasSessionSearchQuery(this.searchQuery)
          ? html`<span class="plain-heading">${expanded ? "▾" : "▸"} Archived</span>`
          : html`<button class="section-toggle" aria-expanded=${String(expanded)} @click=${() => { this.toggleArchived(); }}><span>${expanded ? "▾" : "▸"} Archived</span></button>`}
        ${expanded ? html`<button class="bulk-select-entry ${active ? "selected" : ""}" title=${active ? "Close archived session selection" : "Select archived sessions"} aria-label=${active ? "Close archived session selection" : "Select archived sessions"} aria-expanded=${String(active)} aria-pressed=${String(active)} @click=${() => { this.toggleSelection("archived", archivedSessions); }}>☑</button>` : null}
        <small class="section-count">${archivedSessions.length}</small>
      </h2>
    `;
  }

  private renderCurrentSelectionToolbar(visibleSessions: SessionInfo[]) {
    if (visibleSessions.length === 0 || !this.selectionScopes.has("current")) return null;

    const selectedSessions = this.selectedSessions("current");
    const selectedVisibleSessions = visibleSessions.filter((session) => this.selectedSessionIds.has(session.id));
    const archivableVisibleSessions = selectedVisibleSessions.filter((session) => isArchivableSessionInfo(session, this.statuses[session.id], this.sessionPersistenceOptions()));
    const allVisibleSelected = visibleSessions.length > 0 && visibleSessions.every((session) => this.selectedSessionIds.has(session.id));
    const visibleSelectedCount = selectedVisibleSessions.length;
    return html`
      <div class="bulk-row selecting">
        <button ?disabled=${visibleSessions.length === 0} @click=${() => { this.toggleVisibleSelection(visibleSessions, !allVisibleSelected); }}>${allVisibleSelected ? "Clear visible" : "Select visible"}</button>
        <small>${selectedSessions.length} selected${visibleSelectedCount !== selectedSessions.length ? html` · ${visibleSelectedCount} visible` : null}</small>
        <button ?disabled=${archivableVisibleSessions.length === 0} @click=${() => { this.archiveSelectedCurrent(archivableVisibleSessions); }}>Archive selected</button>
        <button @click=${() => { this.clearSelection("current"); }}>Clear</button>
        <button @click=${() => { this.closeSelection("current"); }}>Done</button>
      </div>
    `;
  }

  private renderArchivedSelectionToolbar(visibleSessions: SessionInfo[]) {
    if (visibleSessions.length === 0 || !this.selectionScopes.has("archived")) return null;

    const selectedSessions = this.selectedSessions("archived");
    const allVisibleSelected = visibleSessions.length > 0 && visibleSessions.every((session) => this.selectedSessionIds.has(session.id));
    const visibleSelectedCount = visibleSessions.filter((session) => this.selectedSessionIds.has(session.id)).length;
    return html`
      <div class="bulk-row selecting">
        <button ?disabled=${visibleSessions.length === 0} @click=${() => { this.toggleVisibleSelection(visibleSessions, !allVisibleSelected); }}>${allVisibleSelected ? "Clear visible" : "Select visible"}</button>
        <small>${selectedSessions.length} selected${visibleSelectedCount !== selectedSessions.length ? html` · ${visibleSelectedCount} visible` : null}</small>
        <button class="danger" title=${this.canDeleteArchived ? "Permanently delete selected archived sessions" : this.archivedDeleteUnavailableMessage} ?disabled=${selectedSessions.length === 0 || !this.canDeleteArchived} @click=${() => { this.confirmDeleteSelectedArchived(); }}>Delete selected</button>
        <button @click=${() => { this.clearSelection("archived"); }}>Clear</button>
        <button @click=${() => { this.closeSelection("archived"); }}>Done</button>
        ${this.canDeleteArchived ? null : html`<small class="capability-hint">${this.archivedDeleteUnavailableMessage}</small>`}
      </div>
    `;
  }

  private renderSession(
    row: SessionRow,
    descendantCount: number,
    scope: SessionSelectionScope,
    activitySessions: readonly SessionInfo[],
    reorderGroup: readonly SessionInfo[],
    reorderRows: readonly SessionRow[],
    reorderMarkers: boolean,
    usesFamilySubject: boolean,
  ) {
    const { session } = row;
    const cappedDepth = Math.min(row.depth, 2);
    const canBulkSelect = !row.external && sessionSelectionScope(session) === scope;
    const selectionActive = this.selectionScopes.has(scope) && !row.external;
    const showsCheckbox = selectionActive && canBulkSelect;
    const bulkSelected = showsCheckbox && this.selectedSessionIds.has(session.id);
    const status = this.statuses[session.id];
    const activity = this.activities[session.id];
    const indicatorKind = sessionRowActivityKind(session, status, activity, this.sending[session.id] === true, this.unreadSessionIds.has(session.id));
    const persistenceOptions = this.sessionPersistenceOptions();
    const canArchive = isArchivableSessionInfo(session, status, persistenceOptions);
    const canDeleteTransient = isTransientNewSessionInfo(session, status, persistenceOptions);
    const canRename = this.canRenameSession(session, scope, row.external);
    const canReloadSession = canArchive && this.canReload;
    const workspace = row.external ? this.workspaces.find((candidate) => candidate.path === session.cwd) : undefined;
    const externalWorkspaceLabel = workspace === undefined ? undefined : workspace.branch ?? workspace.label;
    const currentReorderRow = scope === "current" && reorderMarkers;
    const reorderSubject = currentReorderRow && session.archived !== true;
    const canDrag = this.canDragSessionReorder(row, scope, reorderGroup, reorderMarkers);
    return html`
      <div
        class="action-row ${this.selected?.id === session.id ? "selected" : ""} ${bulkSelected ? "bulk-selected" : ""} ${session.archived === true ? "archived" : ""} ${row.external ? "external-session" : ""} ${selectionActive ? "selecting" : ""} ${indicatorKind === "unread" ? "unread" : ""}"
        style=${`--depth:${String(cappedDepth)}`}
        tabindex="0"
        title=${session.path}
        data-session-row-path=${currentReorderRow ? session.path : nothing}
        data-session-reorder-path=${reorderSubject && !usesFamilySubject ? session.path : nothing}
        @dblclick=${(event: MouseEvent) => { this.startSessionRename(event, session, scope, row.external); }}
        @click=${(event: MouseEvent) => { activateSelectableRow(event, () => { this.activateSessionRow(session, scope, row.external); }); }}
        @keydown=${(event: KeyboardEvent) => { this.handleSessionKeydown(event, session, scope, row.external); }}
      >
        <div class="action-main ${selectionActive ? "selecting" : ""}">
          ${showsCheckbox ? html`<input class="session-checkbox" type="checkbox" aria-label=${`Select ${sessionLabel(session)}`} .checked=${bulkSelected} @click=${(event: MouseEvent) => { event.stopPropagation(); }} @change=${() => { this.toggleSelected(session.id); }}>` : null}
          <span class="action-name-line">
            ${this.renamingSessionId === session.id
              ? this.renderSessionRenameInput(session)
              : html`${this.renderSessionGroupToggle(row)}<span class="action-name" dir="auto">${row.depth > 0 ? html`<span class="tree-marker">↳</span>` : null}${!row.external && session.pinned === true ? html`<button class="pinned-star" type="button" title="Click to unpin session" aria-label="Unpin session" @click=${(event: MouseEvent) => { event.stopPropagation(); this.onUnpin?.(session); }}>★</button> ` : null}${sessionLabel(session)}${row.depth > 2 ? html` <span class="badge">depth ${row.depth}</span>` : null}${externalWorkspaceLabel === undefined ? null : html` <span class="badge external-workspace" title=${`Open ${externalWorkspaceLabel} workspace`}>${externalWorkspaceLabel} ↗</span>`}${row.hasMissingParent ? html` <span class="badge">parent unavailable</span>` : null}</span>`}
          </span><small>${this.renderSessionMetaPrefix(session, status, activity)}${String(session.messageCount)} messages</small>
          ${this.renderActivity(session, activitySessions)}
          ${canDrag ? html`
            <span
              class="session-reorder-grip"
              title="Drag to reorder selected session"
              data-session-reorder-handle=${session.path}
              @pointerdown=${(event: PointerEvent) => { this.beginSessionReorder(event, session, reorderGroup, reorderRows); }}
            >${svg`<svg class="session-reorder-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="9" cy="6" r="1"></circle><circle cx="15" cy="6" r="1"></circle><circle cx="9" cy="12" r="1"></circle><circle cx="15" cy="12" r="1"></circle><circle cx="9" cy="18" r="1"></circle><circle cx="15" cy="18" r="1"></circle></svg>`}</span>
          ` : null}
        </div>
        ${row.external ? null : html`
          <div class="session-row-controls">
            <div class="action-menu">
            <button class="action-menu-toggle" title="Session actions" @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(session.id, event.currentTarget); }}>⋯</button>
            ${this.openMenuSessionId === session.id ? html`
              <div class="action-menu-panel" style=${this.menuStyle}>
                ${canRename ? html`<button title="Rename session" @click=${(event: MouseEvent) => { this.startSessionRenameFromMenu(event, session, scope, row.external); }}>Rename</button>` : null}
                ${session.archived === true
                  ? html`
                    <button title="Restore session" @click=${() => { this.openMenuSessionId = undefined; this.onRestore?.(session); }}>Restore</button>
                    <button class="danger" title=${this.canDeleteArchived ? "Permanently delete archived session" : this.archivedDeleteUnavailableMessage} ?disabled=${!this.canDeleteArchived} @click=${() => { this.openMenuSessionId = undefined; this.confirmDeleteArchived(session); }}>Delete archived session</button>
                  `
                  : canDeleteTransient
                    ? html`<button title="Delete transient new session" @click=${() => { this.openMenuSessionId = undefined; this.onDelete?.(session); }}>Delete</button>`
                    : html`
                      ${canArchive ? html`
                        <button title="Archive session" @click=${() => { this.openMenuSessionId = undefined; this.onArchive?.(session); }}>Archive</button>
                        ${descendantCount > 0 ? html`<button title="Archive this session and its descendants" @click=${() => { this.openMenuSessionId = undefined; this.confirmArchiveWithDescendants(session, descendantCount); }}>Archive with descendants (${descendantCount})</button>` : null}
                      ` : null}
                      ${session.parentSessionPath !== undefined ? html`<button title="Detach from parent" @click=${() => { this.openMenuSessionId = undefined; this.onDetachParent?.(session); }}>Detach from parent</button>` : null}
                      ${canReloadSession ? html`<button title=${isSessionActive(this.statuses[session.id], this.activities[session.id]) ? "Stop current session activity before reloading from disk" : "Reload session from disk without refreshing Pi runtime resources"} ?disabled=${isSessionActive(this.statuses[session.id], this.activities[session.id])} @click=${() => { this.openMenuSessionId = undefined; this.onReload?.(session); }}>Reload from disk</button>` : null}
                      ${session.pinned === true
                        ? html`<button title="Unpin session" @click=${() => { this.openMenuSessionId = undefined; this.onUnpin?.(session); }}>Unpin</button>`
                        : html`<button title="Pin session to keep it at the top of the list" @click=${() => { this.openMenuSessionId = undefined; this.onPin?.(session); }}>Pin</button>`}
                    `}
              </div>
            ` : null}
            </div>
          </div>
        `}
      </div>
    `;
  }

  private canDragSessionReorder(
    row: SessionRow,
    scope: SessionSelectionScope,
    group: readonly SessionInfo[],
    reorderMarkers: boolean,
  ): boolean {
    const { session } = row;
    if (!reorderMarkers
      || !this.canReorder
      || this.reorderPending
      || scope !== "current"
      || row.external
      || row.hasMissingParent
      || session.persisted !== true
      || session.archived === true
      || this.searchOpen
      || hasSessionSearchQuery(this.searchQuery)
      || this.selectionScopes.size > 0
      || this.renamingSessionId !== undefined
      || this.selected === undefined
      || !sameSessionIdentity(this.selected, session)
      || group.length <= 1
      || group.length > SESSION_REORDER_LIMIT
      || !group.some((candidate) => sameSessionIdentity(candidate, session))) return false;
    return this.sessionReorderCatalogCwds(session, group).length <= SESSION_REORDER_LIMIT;
  }

  private beginSessionReorder(
    event: PointerEvent,
    selected: SessionInfo,
    group: readonly SessionInfo[],
    rows: readonly SessionRow[],
  ): void {
    const handle = event.currentTarget;
    if (!(handle instanceof HTMLElement)
      || this.sessionPointerDrag !== undefined
      || this.reorderPending
      || !this.canReorder
      || this.selected === undefined
      || !sameSessionIdentity(this.selected, selected)
      || selected.persisted !== true
      || selected.archived === true
      || this.searchOpen
      || hasSessionSearchQuery(this.searchQuery)
      || this.selectionScopes.size > 0
      || this.renamingSessionId !== undefined
      || group.length <= 1
      || group.length > SESSION_REORDER_LIMIT
      || !group.some((candidate) => sameSessionIdentity(candidate, selected))
      || this.sessionReorderCatalogCwds(selected, group).length > SESSION_REORDER_LIMIT
      || !event.isPrimary
      || (event.pointerType !== "mouse" && event.pointerType !== "touch")
      || (event.pointerType === "mouse" && event.button !== 0)) return;

    event.preventDefault();
    event.stopPropagation();
    this.openMenuSessionId = undefined;
    this.sessionPointerDrag = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      originX: event.clientX,
      originY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      handle,
      selected,
      group: [...group],
      rows: [...rows],
      active: false,
    };
  }

  private moveSessionReorder(event: PointerEvent): void {
    const drag = this.sessionPointerDrag;
    if (drag?.pointerId !== event.pointerId) return;
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    if (!drag.active) {
      if (!sessionReorderThresholdReached(
        { x: drag.originX, y: drag.originY },
        { x: drag.clientX, y: drag.clientY },
      )) return;
      drag.active = true;
      drag.handle.setPointerCapture(drag.pointerId);
      this.sessionReorderSubject(drag.selected.path)?.classList.add("session-reorder-dragging");
    }
    event.preventDefault();
    this.updateSessionReorderCandidate(drag);
    this.scheduleSessionReorderEdgeScroll(drag);
  }

  private finishSessionReorder(event: PointerEvent): void {
    const drag = this.sessionPointerDrag;
    if (drag?.pointerId !== event.pointerId) return;
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    if (!drag.active || !this.sessionReorderPointerWithinList(drag)) {
      this.cancelSessionReorder();
      return;
    }
    event.preventDefault();
    const insertionIndex = this.updateSessionReorderCandidate(drag);
    const callback = this.onReorder;
    if (insertionIndex === undefined || callback === undefined) {
      this.cancelSessionReorder();
      return;
    }
    const movedGroup = moveSessionInGroup(drag.group, drag.selected.id, insertionIndex);
    if (sameSessionOrder(movedGroup, drag.group)) {
      this.cancelSessionReorder();
      return;
    }
    const selected = drag.selected;
    const group = [...drag.group];
    const catalogCwds = this.sessionReorderCatalogCwds(selected, group);
    this.cancelSessionReorder();
    this.reorderPending = true;
    void this.submitSessionReorder(callback, selected, group, insertionIndex, catalogCwds);
  }

  private async submitSessionReorder(
    callback: (session: SessionInfo, input: SessionReorderRequest) => void | Promise<void>,
    selected: SessionInfo,
    group: readonly SessionInfo[],
    insertionIndex: number,
    catalogCwds: readonly string[],
  ): Promise<void> {
    try {
      const orderedGroup = moveSessionInGroup(group, selected.id, insertionIndex);
      await callback(selected, sessionReorderRequest(selected, orderedGroup, catalogCwds));
    } catch {
      // The controller owns application error reporting and recovery for reorder requests.
    } finally {
      this.reorderPending = false;
    }
  }

  private sessionReorderCatalogCwds(selected: SessionInfo, group: readonly SessionInfo[]): string[] {
    return [...new Set([
      ...this.workspaces.map((workspace) => workspace.path),
      ...group.map((session) => session.cwd),
      selected.cwd,
    ])];
  }

  private updateSessionReorderCandidate(drag: SessionPointerDrag): number | undefined {
    const peers = this.sessionReorderPeers(drag);
    if (peers.length !== drag.group.length - 1) {
      delete drag.insertionIndex;
      this.clearSessionReorderMarkers();
      return undefined;
    }
    const peerRects = peers.map((peer) => peer.rect);
    const insertionIndex = sessionReorderInsertionIndex(drag.clientY, peerRects);
    const boundary = insertionIndex === peers.length ? peers.at(-1) : peers[insertionIndex];
    const markerPath = boundary === undefined
      ? undefined
      : insertionIndex === peers.length ? boundary.afterSessionPath : boundary.beforeSessionPath;
    const element = markerPath === undefined ? undefined : this.sessionReorderSubject(markerPath);
    if (element === undefined) {
      delete drag.insertionIndex;
      this.clearSessionReorderMarkers();
      return undefined;
    }
    this.clearSessionReorderMarkers();
    element.classList.add(insertionIndex === peerRects.length ? "session-drop-after" : "session-drop-before");
    drag.insertionIndex = insertionIndex;
    return insertionIndex;
  }

  private sessionReorderPeers(drag: SessionPointerDrag): SessionReorderPeer[] {
    return drag.group.flatMap((session) => {
      if (sameSessionIdentity(session, drag.selected)) return [];
      const peer = this.sessionReorderPeer(session, drag.rows);
      return peer === undefined ? [] : [peer];
    });
  }

  private sessionReorderPeer(session: SessionInfo, rows: readonly SessionRow[]): SessionReorderPeer | undefined {
    if (session.parentSessionPath === undefined) {
      const subject = this.sessionReorderSubject(session.path);
      if (subject === undefined) return undefined;
      const rect = subject.getBoundingClientRect();
      return {
        rect: { sessionPath: session.path, top: rect.top, bottom: rect.bottom },
        beforeSessionPath: session.path,
        afterSessionPath: session.path,
      };
    }
    const subtreePaths = sessionReorderSubtreePaths(rows, session.path);
    const first = this.sessionReorderRow(session.path);
    const lastPath = subtreePaths.at(-1);
    const last = lastPath === undefined ? undefined : this.sessionReorderRow(lastPath);
    if (first === undefined || lastPath === undefined || last === undefined) return undefined;
    const firstRect = first.getBoundingClientRect();
    const lastRect = last.getBoundingClientRect();
    return {
      rect: { sessionPath: session.path, top: firstRect.top, bottom: lastRect.bottom },
      beforeSessionPath: session.path,
      afterSessionPath: lastPath,
    };
  }

  private sessionReorderRoot(): ParentNode | undefined {
    return this.renderRoot;
  }

  private sessionReorderSubject(sessionPath: string): HTMLElement | undefined {
    const root = this.sessionReorderRoot();
    if (root === undefined) return undefined;
    return [...root.querySelectorAll<HTMLElement>("[data-session-reorder-path]")]
      .find((element) => element.getAttribute("data-session-reorder-path") === sessionPath);
  }

  private sessionReorderRow(sessionPath: string): HTMLElement | undefined {
    const root = this.sessionReorderRoot();
    if (root === undefined) return undefined;
    return [...root.querySelectorAll<HTMLElement>("[data-session-row-path]")]
      .find((element) => element.getAttribute("data-session-row-path") === sessionPath);
  }

  private clearSessionReorderMarkers(): void {
    const root = this.sessionReorderRoot();
    if (root === undefined) return;
    for (const element of root.querySelectorAll<HTMLElement>("[data-session-reorder-path]")) {
      element.classList.remove("session-drop-before", "session-drop-after");
    }
  }

  private scheduleSessionReorderEdgeScroll(drag: SessionPointerDrag): void {
    if (!drag.active || this.sessionReorderFrame !== undefined || typeof requestAnimationFrame !== "function") return;
    const body = this.sessionReorderBody();
    if (body === undefined) return;
    const rect = body.getBoundingClientRect();
    if (sessionReorderEdgeScrollDelta(drag.clientY, rect.top, rect.bottom) === 0) return;
    this.sessionReorderFrame = requestAnimationFrame(() => {
      this.sessionReorderFrame = undefined;
      this.runSessionReorderEdgeScroll();
    });
  }

  private runSessionReorderEdgeScroll(): void {
    const drag = this.sessionPointerDrag;
    const body = this.sessionReorderBody();
    if (drag === undefined || !drag.active || body === undefined) return;
    const rect = body.getBoundingClientRect();
    const delta = sessionReorderEdgeScrollDelta(drag.clientY, rect.top, rect.bottom);
    if (delta === 0) return;
    const previousScrollTop = body.scrollTop;
    body.scrollTop += delta;
    this.updateSessionReorderCandidate(drag);
    if (body.scrollTop !== previousScrollTop) this.scheduleSessionReorderEdgeScroll(drag);
  }

  private sessionReorderBody(): HTMLElement | undefined {
    return this.sessionReorderRoot()?.querySelector<HTMLElement>(".list-body") ?? undefined;
  }

  private sessionReorderPointerWithinList(drag: SessionPointerDrag): boolean {
    const body = this.sessionReorderBody();
    if (body === undefined) return false;
    const rect = body.getBoundingClientRect();
    return drag.clientX >= rect.left
      && drag.clientX <= rect.right
      && drag.clientY >= rect.top
      && drag.clientY <= rect.bottom;
  }

  private cancelSessionReorder(): void {
    const drag = this.sessionPointerDrag;
    this.sessionPointerDrag = undefined;
    if (this.sessionReorderFrame !== undefined) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.sessionReorderFrame);
      this.sessionReorderFrame = undefined;
    }
    this.clearSessionReorderMarkers();
    if (drag === undefined) return;
    this.sessionReorderSubject(drag.selected.path)?.classList.remove("session-reorder-dragging");
    if (drag.active
      && typeof drag.handle.hasPointerCapture === "function"
      && drag.handle.hasPointerCapture(drag.pointerId)
      && typeof drag.handle.releasePointerCapture === "function") drag.handle.releasePointerCapture(drag.pointerId);
  }

  private startSessionRename(event: MouseEvent, session: SessionInfo, scope: SessionSelectionScope, external: boolean): void {
    if (isFromInteractiveElement(event) || !this.canRenameSession(session, scope, external)) return;
    this.beginSessionRename(event, session);
  }

  private startSessionRenameFromMenu(event: MouseEvent, session: SessionInfo, scope: SessionSelectionScope, external: boolean): void {
    if (!this.canRenameSession(session, scope, external)) return;
    this.openMenuSessionId = undefined;
    this.beginSessionRename(event, session);
  }

  private canRenameSession(session: SessionInfo, scope: SessionSelectionScope, external: boolean): boolean {
    return !external
      && session.archived !== true
      && !this.selectionScopes.has(scope)
      && !isTransientNewSessionInfo(session, this.statuses[session.id], this.sessionPersistenceOptions());
  }

  private beginSessionRename(event: MouseEvent, session: SessionInfo): void {
    this.cancelSessionReorder();
    this.onRenameStart?.(session);
    event.preventDefault();
    event.stopPropagation();
    this.renamingSessionId = session.id;
    this.renameInputValue = session.name ?? sessionLabel(session);
    void this.updateComplete.then(() => {
      if (this.renamingSessionId !== session.id) return;
      const input = this.renderRoot.querySelector<HTMLInputElement>(".session-name-input");
      input?.focus();
      input?.select();
    });
  }

  private renderSessionRenameInput(session: SessionInfo) {
    return html`
      <input
        class="session-name-input"
        aria-label="Rename session"
        .value=${this.renameInputValue}
        @keydown=${(event: KeyboardEvent) => { this.handleSessionRenameKeydown(event, session); }}
        @click=${(event: MouseEvent) => { event.stopPropagation(); }}
        @blur=${(event: FocusEvent) => { this.commitSessionRename(session, this.sessionRenameInputValue(event)); }}
      >
    `;
  }

  private handleSessionRenameKeydown(event: KeyboardEvent, session: SessionInfo): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.cancelSessionRename();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    this.commitSessionRename(session, this.sessionRenameInputValue(event));
  }

  private sessionRenameInputValue(event: Event): string {
    return hasStringValue(event.currentTarget) ? event.currentTarget.value : this.renameInputValue;
  }

  private commitSessionRename(session: SessionInfo, inputValue = this.renameInputValue): void {
    if (this.renamingSessionId !== session.id) return;
    const name = inputValue.trim();
    const currentName = session.name ?? sessionLabel(session);
    this.cancelSessionRename();
    if (name === "" || name === currentName) return;
    void this.onRename?.(session, name);
  }

  private cancelSessionRename(): void {
    this.renamingSessionId = undefined;
    this.renameInputValue = "";
  }

  private renderSessionGroupToggle(row: SessionRow) {
    if (!row.hasChildren || hasSessionSearchQuery(this.searchQuery)) return null;
    const { folded } = row;
    const action = folded ? "Expand" : "Collapse";
    return html`<button class="session-group-toggle" type="button" title=${`${action} ${sessionLabel(row.session)}`} aria-label=${`${action} ${sessionLabel(row.session)}`} aria-expanded=${String(!folded)} @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleSessionGroup(row.session.path, folded); }}>${folded ? "▸" : "▾"}</button>`;
  }

  private toggleSessionGroup(path: string, folded: boolean): void {
    const next = new Set(this.expandedSessionPaths);
    if (folded) {
      const rows = sessionRowsForCurrentTree(this.sessionTreeSessions(), this.currentSessionTreeOptions());
      for (const groupPath of sessionGroupPaths(path, rows)) next.add(groupPath);
    } else {
      next.delete(path);
    }
    this.expandedSessionPaths = next;
  }

  private handleSessionKeydown(event: KeyboardEvent, session: SessionInfo, scope: SessionSelectionScope, external: boolean): void {
    handleSelectableRowKeyboard(event, {
      activate: () => { this.activateSessionRow(session, scope, external); },
      previousSection: this.onFocusPreviousSection === undefined ? undefined : () => { void this.onFocusPreviousSection?.(); },
      nextSection: this.onFocusNextSection === undefined ? undefined : () => { void this.onFocusNextSection?.(); },
      cancel: this.onCancelKeyboardNavigation === undefined ? undefined : () => { void this.onCancelKeyboardNavigation?.(); },
    });
  }

  private activateSessionRow(session: SessionInfo, scope: SessionSelectionScope, external: boolean): void {
    if (!external && this.selectionScopes.has(scope) && sessionSelectionScope(session) === scope) {
      this.toggleSelected(session.id);
      return;
    }
    this.onSelect?.(session);
  }

  private confirmArchiveWithDescendants(session: SessionInfo, descendantCount: number): void {
    const noun = descendantCount === 1 ? "descendant session" : "descendant sessions";
    if (confirm(`Archive “${sessionLabel(session)}” and ${String(descendantCount)} ${noun}?`)) this.onArchiveWithDescendants?.(session);
  }

  private confirmDeleteArchived(session: SessionInfo): void {
    if (!this.canDeleteArchived) return;
    if (confirm(`Permanently delete archived session “${sessionLabel(session)}”? This cannot be undone.`)) void this.onDeleteArchived?.(session);
  }

  private confirmDeleteSelectedArchived(): void {
    if (!this.canDeleteArchived) return;
    const archived = this.selectedSessions("archived");
    if (archived.length === 0) return;
    const noun = archived.length === 1 ? "archived session" : "archived sessions";
    if (!confirm(`Permanently delete ${String(archived.length)} selected ${noun}? This cannot be undone.`)) return;
    this.selectedSessionIds = removeSessionIds(this.selectedSessionIds, archived.map((session) => session.id));
    void this.onDeleteArchivedMany?.(archived);
  }

  private archiveSelectedCurrent(sessions: SessionInfo[]): void {
    if (sessions.length === 0) return;
    this.selectedSessionIds = removeSessionIds(this.selectedSessionIds, sessions.map((session) => session.id));
    void this.onArchiveMany?.(sessions);
  }

  private toggleSelection(scope: SessionSelectionScope, visibleSessions: SessionInfo[]): void {
    if (this.selectionScopes.has(scope)) {
      this.closeSelection(scope);
      return;
    }
    this.startSelection(scope, visibleSessions);
  }

  private startSelection(scope: SessionSelectionScope, visibleSessions: SessionInfo[]): void {
    this.cancelSessionReorder();
    this.selectionScopes = new Set([...this.selectionScopes, scope]);
    const onlyVisibleSession = visibleSessions.length === 1 ? visibleSessions[0] : undefined;
    if (onlyVisibleSession !== undefined) this.selectedSessionIds = new Set([...this.selectedSessionIds, onlyVisibleSession.id]);
  }

  private closeSelection(scope: SessionSelectionScope): void {
    this.selectionScopes = new Set([...this.selectionScopes].filter((candidate) => candidate !== scope));
    this.clearSelection(scope);
  }

  private clearSelection(scope: SessionSelectionScope): void {
    const sessionIds = this.sessions.filter((session) => sessionSelectionScope(session) === scope).map((session) => session.id);
    this.selectedSessionIds = removeSessionIds(this.selectedSessionIds, sessionIds);
  }

  private toggleSelected(sessionId: string): void {
    const next = new Set(this.selectedSessionIds);
    if (next.has(sessionId)) next.delete(sessionId);
    else next.add(sessionId);
    this.selectedSessionIds = next;
  }

  private toggleVisibleSelection(sessions: SessionInfo[], selected: boolean): void {
    const next = new Set(this.selectedSessionIds);
    for (const session of sessions) {
      if (selected) next.add(session.id);
      else next.delete(session.id);
    }
    this.selectedSessionIds = next;
  }

  private selectedSessions(scope: SessionSelectionScope): SessionInfo[] {
    return this.sessions.filter((session) => this.selectedSessionIds.has(session.id) && sessionSelectionScope(session) === scope);
  }

  private sessionTreeSessions(): SessionInfo[] {
    return [
      ...this.sessions,
      ...this.projectSessions.filter((session) => session.cwd !== this.currentWorkspacePath),
    ];
  }

  private currentSessionTreeOptions(): SessionRowsOptions {
    if (this.currentWorkspacePath === undefined) return {};
    const knownWorkspacePaths = new Set(this.workspaces.map((workspace) => workspace.path));
    knownWorkspacePaths.add(this.currentWorkspacePath);
    return { currentWorkspacePath: this.currentWorkspacePath, knownWorkspacePaths };
  }

  private pruneExpandedSessionPaths(): void {
    const existingPaths = new Set([...this.sessions, ...this.projectSessions].map((session) => session.path));
    const next = new Set([...this.expandedSessionPaths].filter((path) => existingPaths.has(path)));
    if (next.size !== this.expandedSessionPaths.size) this.expandedSessionPaths = next;
  }

  private pruneSelectedSessionIds(): void {
    const existing = new Set(this.sessions.map((session) => session.id));
    const next = new Set([...this.selectedSessionIds].filter((sessionId) => existing.has(sessionId)));
    if (next.size !== this.selectedSessionIds.size) this.selectedSessionIds = next;
    if (this.selectionScopes.has("archived") && !this.sessions.some((session) => session.archived === true)) this.closeSelection("archived");
    if (this.selectionScopes.has("current") && !this.sessions.some((session) => session.archived !== true)) this.closeSelection("current");
  }

  private toggleMenu(sessionId: string, target: EventTarget | null) {
    if (this.openMenuSessionId === sessionId) {
      this.openMenuSessionId = undefined;
      return;
    }
    this.menuStyle = actionMenuPanelStyle(target, { constrainTo: "viewport" });
    this.openMenuSessionId = sessionId;
  }

  private toggleArchived() {
    this.archivedExpanded = !this.archivedExpanded;
    if (!this.archivedExpanded) {
      this.openMenuSessionId = undefined;
      if (this.selectionScopes.has("archived")) this.closeSelection("archived");
      this.onArchivedCollapsed?.();
    }
  }

  private scrollSelectedIntoView(): void {
    this.renderRoot.querySelector<HTMLElement>(".action-row.selected")?.scrollIntoView({ block: "nearest" });
  }

  private renderSessionMetaPrefix(session: SessionInfo, status: SessionStatus | undefined, activity: SessionActivity | undefined) {
    if (isTransientNewSessionInfo(session, status, this.sessionPersistenceOptions())) {
      if (activity?.phase === "active") return "creating · ";
      if (activity?.phase === "error") return "error · ";
      return "new · ";
    }
    if (session.archived === true) return "read-only · ";
    return "";
  }

  private sessionPersistenceOptions() {
    return { authoritative: this.authoritativeSessionPersistence };
  }

  private renderActivity(session: SessionInfo, sessions: readonly SessionInfo[]) {
    return renderActionActivityIndicators(sessionActivityIndicators(session, sessions, {
      statuses: this.statuses,
      activities: this.activities,
      sending: this.sending,
      unreadSessionIds: this.unreadSessionIds,
    }));
  }

  static override styles = [listStyles, css`
    h2 { min-height: 30px; }
    h2 > .section-count { flex: 0 0 auto; display: inline; color: var(--pi-muted); font-size: inherit; }
    h2 > .section-unread-count { flex: 0 0 auto; display: inline; color: var(--pi-accent); font-size: inherit; text-transform: none; }
    .bulk-select-entry, .section-expand-button, .section-search-button, .cleanup-entry { box-sizing: border-box; flex: 0 0 auto; display: inline-grid; place-items: center; width: 30px; height: 30px; padding: 0; font-size: 13px; line-height: 1; text-transform: none; }
    .section-expand-icon, .section-search-icon, .cleanup-icon { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .session-search { flex: 0 0 auto; margin: 0 0 6px; }
    .session-search-input { box-sizing: border-box; width: 100%; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-text); padding: 6px 8px; font: inherit; }
    .session-search-input:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    .session-search-empty { margin: 6px 0; color: var(--pi-muted); }
    .bulk-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0 0 6px; }
    .bulk-row button { padding: 5px 7px; font-size: 12px; }
    .bulk-row small { display: inline; min-width: 0; color: var(--pi-muted); }
    .action-name, .section-selected { text-align: start; unicode-bidi: plaintext; }
    .action-main { padding-right: 56px; }
    .session-row-controls { flex: 0 0 auto; display: flex; align-items: stretch; }
    .session-reorder-grip { position: absolute; right: 0; top: 50%; z-index: 2; box-sizing: border-box; display: grid; place-items: center; width: 24px; height: 24px; color: var(--pi-muted); cursor: grab; touch-action: none; transform: translateY(-50%); user-select: none; }
    .session-reorder-grip:active { cursor: grabbing; }
    .session-reorder-icon { width: 16px; height: 16px; fill: currentColor; }
    .session-family-frame, .action-row { position: relative; }
    .session-reorder-dragging { opacity: .45; }
    .session-drop-before::before, .session-drop-after::after { content: ""; position: absolute; right: 0; left: 0; z-index: 4; height: 2px; background: var(--pi-accent); pointer-events: none; }
    .session-drop-before::before { top: -4px; }
    .session-drop-after::after { bottom: -4px; }
    .action-row.unread .action-name { color: var(--pi-text-bright); font-weight: 650; }
    .plain-heading { min-width: 0; }
    .action-name-line { min-width: 0; display: flex; align-items: flex-start; gap: 6px; }
    .action-name-line .action-name { flex: 1 1 auto; min-width: 0; }
    .session-family-frame { box-sizing: border-box; margin: 6px 0; border: 1px solid var(--pi-danger); border-radius: 10px; background: color-mix(in srgb, var(--pi-surface) 52%, transparent); padding: 5px 6px; }
    .session-family-frame > .action-row { margin: 4px 0; }
    .session-family-frame > .action-row:first-child { margin-top: 0; }
    .session-family-frame > .action-row:last-child { margin-bottom: 0; }
    .session-group-toggle { flex: 0 0 auto; display: grid; place-items: center; width: 24px; min-width: 24px; height: 24px; margin: 0; border: 0; border-radius: 4px; background: transparent; color: var(--pi-muted); padding: 0; font: inherit; line-height: 1; }
    .session-group-toggle:hover { background: var(--pi-surface); box-shadow: 0 0 0 1px var(--pi-border); color: var(--pi-text); transform: scale(1.25); }
    .session-group-toggle:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    .external-session .action-main { border-radius: 8px; }
    .action-row.external-session .action-name { color: var(--pi-accent); }
    .external-workspace { color: var(--pi-accent); }
    .session-name-input { flex: 1 1 auto; min-width: 0; border: 1px solid var(--pi-accent); border-radius: 4px; background: var(--pi-bg); color: var(--pi-text); padding: 1px 4px; font: inherit; line-height: inherit; }
    .session-name-input:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    .bulk-row .capability-hint { flex: 1 0 100%; color: var(--pi-warning); }
    .bulk-row.selecting { padding: 6px; border: 1px solid var(--pi-border-muted); border-radius: 8px; background: color-mix(in srgb, var(--pi-surface) 65%, transparent); }
    button.danger, .action-menu-panel button.danger { color: var(--pi-danger); }
    button.danger:hover, .action-menu-panel button.danger:hover { background: color-mix(in srgb, var(--pi-danger) 14%, transparent); }
    .action-row.bulk-selected .action-main { border-color: var(--pi-accent); box-shadow: inset 3px 0 0 var(--pi-accent); }
    .pending-session-row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); margin: 6px 0; cursor: default; }
    .pending-session-row.starting-session .action-main { border-radius: 8px; border-style: dashed; color: var(--pi-muted); }
    .pending-session-row.starting-session .action-name { display: flex; align-items: center; gap: 6px; max-height: none; -webkit-line-clamp: 1; }
    .pending-session-row.starting-session .activity-indicator { flex: 0 0 auto; margin: 0; }
    .action-main.selecting { padding-left: calc(32px + var(--depth, 0) * 16px); }
    .session-checkbox { position: absolute; top: 9px; left: calc(8px + var(--depth, 0) * 16px); z-index: 2; margin: 0; }
    .pinned-star { flex: 0 0 auto; border: 0; background: transparent; color: #d4a017; padding: 0; font: inherit; font-size: 14px; line-height: 1; }
    .pinned-star:hover { border-radius: 4px; background: var(--pi-surface); box-shadow: 0 0 0 1px var(--pi-border); transform: scale(1.25); }
    .pinned-star:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; border-radius: 2px; }
  `];
}

export function unreadSessionCount(
  sessions: readonly SessionInfo[],
  unreadSessionIds: ReadonlySet<string>,
  runtime: {
    statuses?: Record<string, SessionStatus> | undefined;
    activities?: Record<string, SessionActivity> | undefined;
    sending?: Record<string, true> | undefined;
  } = {},
): number {
  return sessions.filter((session) => sessionRowActivityKind(
    session,
    runtime.statuses?.[session.id],
    runtime.activities?.[session.id],
    runtime.sending?.[session.id] === true,
    unreadSessionIds.has(session.id),
  ) === "unread").length;
}

function partitionSearchRows(rows: readonly SessionRow[]): { currentRows: SessionRow[]; archivedRows: SessionRow[] } {
  const rowsByPath = new Map(rows.map((row) => [row.session.path, row]));
  const currentFamilyPaths = new Set<string>();
  const pendingPaths = rows
    .filter((row) => row.session.archived !== true)
    .map((row) => row.session.path);

  while (pendingPaths.length > 0) {
    const path = pendingPaths.pop();
    if (path === undefined || currentFamilyPaths.has(path)) continue;
    currentFamilyPaths.add(path);
    const parentPath = rowsByPath.get(path)?.session.parentSessionPath;
    if (parentPath !== undefined && rowsByPath.has(parentPath)) pendingPaths.push(parentPath);
  }

  return {
    currentRows: rows.filter((row) => currentFamilyPaths.has(row.session.path)),
    archivedRows: rows.filter((row) => !currentFamilyPaths.has(row.session.path)),
  };
}

function hasStringValue(target: EventTarget | null): target is EventTarget & { value: string } {
  return target !== null && "value" in target && typeof target.value === "string";
}

function sameSessionIdentity(left: SessionInfo, right: SessionInfo): boolean {
  return left.id === right.id && left.cwd === right.cwd && left.path === right.path;
}

function sameSessionOrder(left: readonly SessionInfo[], right: readonly SessionInfo[]): boolean {
  return left.length === right.length && left.every((session, index) => {
    const other = right[index];
    return other !== undefined && sameSessionIdentity(session, other);
  });
}

function hasChangedProperty(changed: Iterable<readonly [PropertyKey, unknown]>, property: PropertyKey): boolean {
  for (const [changedProperty] of changed) {
    if (changedProperty === property) return true;
  }
  return false;
}

function selectableCurrentSessions(rows: readonly SessionRow[]): SessionInfo[] {
  return rows
    .filter((row) => !row.external)
    .map((row) => row.session)
    .filter((session) => sessionSelectionScope(session) === "current");
}

function sessionSelectionScope(session: SessionInfo): SessionSelectionScope {
  return session.archived === true ? "archived" : "current";
}

function removeSessionIds(sessionIds: ReadonlySet<string>, removedIds: readonly string[]): ReadonlySet<string> {
  const removed = new Set(removedIds);
  return new Set([...sessionIds].filter((sessionId) => !removed.has(sessionId)));
}

function unarchivedDescendantCounts(sessions: SessionInfo[]): Map<string, number> {
  const childrenByParentPath = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    if (session.parentSessionPath === undefined) continue;
    const children = childrenByParentPath.get(session.parentSessionPath) ?? [];
    children.push(session);
    childrenByParentPath.set(session.parentSessionPath, children);
  }

  const countFor = (session: SessionInfo, seenPaths: Set<string>): number => {
    if (seenPaths.has(session.path)) return 0;
    const nextSeenPaths = new Set(seenPaths);
    nextSeenPaths.add(session.path);
    let count = 0;
    for (const child of childrenByParentPath.get(session.path) ?? []) {
      if (nextSeenPaths.has(child.path)) continue;
      if (child.archived !== true) count += 1;
      count += countFor(child, nextSeenPaths);
    }
    return count;
  };

  return new Map(sessions.map((session) => [session.id, countFor(session, new Set())]));
}

export function sessionRowsForSessionList(sessions: SessionInfo[], options: SessionListRowsOptions = {}): SessionRow[] {
  const { expandedSessionPaths, selectedSessionPath, ...treeOptions } = options;
  const unfoldedRows = sessionRowsForCurrentTree(sessions, treeOptions);
  const foldedSessionPaths = new Set(unfoldedRows.filter((row) => row.hasChildren).map((row) => row.session.path));
  for (const path of expandedSessionPaths ?? []) foldedSessionPaths.delete(path);
  for (const path of selectedSessionAncestorPaths(selectedSessionPath, unfoldedRows)) foldedSessionPaths.delete(path);
  return sessionRowsForCurrentTree(sessions, { ...treeOptions, foldedSessionPaths });
}

function sessionGroupPaths(path: string, rows: readonly SessionRow[]): Set<string> {
  const childrenByParentPath = new Map<string, string[]>();
  for (const row of rows) {
    const parentPath = row.session.parentSessionPath;
    if (parentPath === undefined) continue;
    const childPaths = childrenByParentPath.get(parentPath) ?? [];
    childPaths.push(row.session.path);
    childrenByParentPath.set(parentPath, childPaths);
  }

  const paths = new Set<string>();
  const pendingPaths = [path];
  while (pendingPaths.length > 0) {
    const currentPath = pendingPaths.pop();
    if (currentPath === undefined || paths.has(currentPath)) continue;
    paths.add(currentPath);
    pendingPaths.push(...(childrenByParentPath.get(currentPath) ?? []));
  }
  return paths;
}

function selectedSessionAncestorPaths(selectedSessionPath: string | undefined, rows: readonly SessionRow[]): Set<string> {
  if (selectedSessionPath === undefined) return new Set();
  const sessionsByPath = new Map(rows.map((row) => [row.session.path, row]));
  const ancestorPaths = new Set<string>();
  const seenPaths = new Set<string>([selectedSessionPath]);
  let parentPath = sessionsByPath.get(selectedSessionPath)?.session.parentSessionPath;
  while (parentPath !== undefined && !seenPaths.has(parentPath)) {
    seenPaths.add(parentPath);
    const parent = sessionsByPath.get(parentPath);
    if (parent === undefined) break;
    ancestorPaths.add(parentPath);
    parentPath = parent.session.parentSessionPath;
  }
  return ancestorPaths;
}
