import { LitElement, css, html, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { customElement, property, query, state } from "lit/decorators.js";
import type { SessionActivity, SessionInfo, SessionStatus } from "../api";
import { sessionActivityIndicators } from "../sessionActivity";
import { sessionLabel } from "../sessionLabels";
import { sessionRowsForCurrentTree, type SessionRow } from "../sessionTreeRows";
import { renderActionActivityIndicators } from "./activityBadge";
import { activateSelectableRow, handleSelectableRowKeyboard } from "./selectableRow";
import { listStyles } from "./shared";

@customElement("session-browser-dialog")
export class SessionBrowserDialog extends LitElement {
  @property({ type: String }) projectName = "Project";
  @property({ attribute: false }) sessions: SessionInfo[] = [];
  @property({ attribute: false }) statuses: Record<string, SessionStatus> = {};
  @property({ attribute: false }) activities: Record<string, SessionActivity> = {};
  @property({ attribute: false }) sending: Record<string, true> = {};
  @property({ attribute: false }) unreadSessionIds: ReadonlySet<string> = new Set();
  @property({ attribute: false }) selected?: SessionInfo;
  @property({ attribute: false }) onSelect?: (session: SessionInfo) => void;
  @property({ attribute: false }) onClose?: () => void;

  @state() private searchQuery = "";
  @query(".session-browser-search") private searchInput?: HTMLInputElement;

  override firstUpdated(): void {
    this.searchInput?.focus();
  }

  override render(): TemplateResult {
    const projectName = this.projectName === "" ? "Project" : this.projectName;
    return html`
      <div class="backdrop" @mousedown=${(event: MouseEvent) => { this.handleBackdropMouseDown(event); }}>
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="session-browser-title"
          tabindex="-1"
          @mousedown=${(event: MouseEvent) => { event.stopPropagation(); }}
          @keydown=${(event: KeyboardEvent) => { this.handleDialogKeyDown(event); }}
        >
          <header>
            <h1 id="session-browser-title">Sessions · ${projectName}</h1>
            <button class="close-button" type="button" title="Close expanded session browser" aria-label="Close expanded session browser" @click=${() => { this.close(); }}>×</button>
          </header>
          <div class="dialog-body">
            <label class="search-label" for="session-browser-search">Search sessions</label>
            <input
              id="session-browser-search"
              class="session-browser-search"
              type="search"
              placeholder="Search sessions"
              .value=${this.searchQuery}
              @input=${(event: Event) => { this.handleSearchInput(event); }}
            >
            <div class="result-area">${this.renderResults()}</div>
          </div>
        </section>
      </div>
    `;
  }

  private renderResults(): TemplateResult {
    if (this.sessions.length === 0) return html`<p class="empty-state">No sessions in this project.</p>`;
    const rows = this.visibleRows;
    if (rows.length === 0) return html`<p class="empty-state">No matching sessions.</p>`;
    return html`
      <div class="session-list">
        ${repeat(rows, (row) => row.session.path, (row) => this.renderSession(row))}
      </div>
    `;
  }

  private get visibleRows(): SessionRow[] {
    const rows = sessionRowsForCurrentTree(this.sessions);
    return filterSessionRows(rows, this.searchQuery);
  }

  private renderSession(row: SessionRow): TemplateResult {
    const session = row.session;
    const indicators = sessionActivityIndicators(session, this.sessions, {
      statuses: this.statuses,
      activities: this.activities,
      sending: this.sending,
      unreadSessionIds: this.unreadSessionIds,
    });
    return html`
      <div
        class=${`action-row session-browser-row ${this.selected?.id === session.id ? "selected" : ""}`}
        style=${`--depth:${String(Math.min(row.depth, 4))}`}
        tabindex="0"
        title=${session.path}
        @click=${(event: MouseEvent) => { activateSelectableRow(event, () => { this.select(session); }); }}
        @keydown=${(event: KeyboardEvent) => { this.handleSessionKeydown(event, session); }}
      >
        <div class="action-main">
          <span class="action-name" dir="auto">${row.depth > 0 ? html`<span class="tree-marker">↳</span>` : null}${sessionLabel(session)}${row.hasMissingParent ? html` <span class="badge">parent unavailable</span>` : null}</span>
          <small>${session.cwd} · ${String(session.messageCount)} messages</small>
          ${renderActionActivityIndicators(indicators)}
        </div>
      </div>
    `;
  }

  private select(session: SessionInfo): void {
    if (!this.sessions.some((candidate) => candidate.id === session.id)) return;
    this.onSelect?.(session);
  }

  private handleSearchInput(event: Event): void {
    if (event.target instanceof HTMLInputElement) this.searchQuery = event.target.value;
  }

  private handleSessionKeydown(event: KeyboardEvent, session: SessionInfo): void {
    handleSelectableRowKeyboard(event, { activate: () => { this.select(session); } });
  }

  private close(): void {
    this.onClose?.();
  }

  private handleBackdropMouseDown(event: MouseEvent): void {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    this.close();
  }

  private handleDialogKeyDown(event: KeyboardEvent): void {
    if (event.key === "Tab") {
      this.trapTabFocus(event);
      return;
    }
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  }

  private trapTabFocus(event: KeyboardEvent): void {
    const focusable = [...this.renderRoot.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex='0']")];
    if (focusable.length === 0) {
      event.preventDefault();
      this.renderRoot.querySelector<HTMLElement>("section[role='dialog']")?.focus();
      return;
    }
    const active = this.shadowRoot?.activeElement;
    const activeIndex = focusable.findIndex((element) => element === active);
    const movingPastEnd = !event.shiftKey && activeIndex === focusable.length - 1;
    const movingBeforeStart = event.shiftKey && activeIndex <= 0;
    if (!movingPastEnd && !movingBeforeStart) return;
    event.preventDefault();
    (event.shiftKey ? focusable.at(-1) : focusable[0])?.focus();
  }

  static override styles = [listStyles, css`
    :host { position: fixed; inset: 0; z-index: 60; display: block; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    * { box-sizing: border-box; }
    .backdrop { width: 100%; height: 100dvh; display: grid; place-items: center; padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); background: var(--pi-overlay); }
    section[role="dialog"] { width: min(960px, 100%); height: min(760px, 100%); min-width: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; border: 1px solid var(--pi-border); border-radius: 12px; background: var(--pi-bg); padding: 0; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--pi-border); }
    h1, p { margin: 0; }
    h1 { font-size: 20px; line-height: 1.25; }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 8px 11px; font: inherit; cursor: pointer; }
    button:hover { background: var(--pi-surface-hover); }
    button:focus-visible, input:focus-visible, .session-browser-row:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .close-button { display: grid; place-items: center; width: 36px; height: 36px; padding: 0; color: var(--pi-muted); font-size: 20px; line-height: 1; }
    .close-button:hover { color: var(--pi-text); }
    .dialog-body { min-height: 0; display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: 7px; padding: 16px; }
    .search-label { font-weight: 700; }
    .session-browser-search { width: 100%; min-width: 0; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 8px 10px; font: inherit; }
    .result-area { min-height: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; }
    .session-list { display: grid; gap: 2px; }
    .session-browser-row { grid-template-columns: minmax(0, 1fr); }
    .session-browser-row .action-main { border-radius: 8px; padding-right: 56px; }
    .empty-state { margin: 0; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-muted); padding: 14px; }

    @media (max-width: 760px) {
      .backdrop { padding: 0; }
      section[role="dialog"] { width: 100%; height: 100%; border: 0; border-radius: 0; }
      header, .dialog-body { padding-inline: max(12px, env(safe-area-inset-left)) max(12px, env(safe-area-inset-right)); }
      header { padding-top: max(12px, env(safe-area-inset-top)); }
      .dialog-body { padding-bottom: max(12px, env(safe-area-inset-bottom)); }
    }
  `];
}

function filterSessionRows(rows: readonly SessionRow[], query: string): SessionRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery === "") return [...rows];
  const byPath = new Map(rows.map((row) => [row.session.path, row]));
  const visiblePaths = new Set<string>();
  for (const row of rows) {
    if (!sessionSearchText(row.session).includes(normalizedQuery)) continue;
    let path: string | undefined = row.session.path;
    const seenPaths = new Set<string>();
    while (path !== undefined && !seenPaths.has(path)) {
      seenPaths.add(path);
      const current = byPath.get(path);
      if (current === undefined) break;
      visiblePaths.add(path);
      path = current.session.parentSessionPath;
    }
  }
  return rows.filter((row) => visiblePaths.has(row.session.path));
}

function sessionSearchText(session: SessionInfo): string {
  return [sessionLabel(session), session.firstMessage, session.id, session.cwd].join("\n").toLocaleLowerCase();
}
