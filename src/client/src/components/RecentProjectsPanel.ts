import { LitElement, css, html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { Project, RecentProjectEntry, Workspace, WorkspaceActivity } from "../api";
import type { RecentProjectsState } from "../controllers/recentProjectController";
import { projectActivityIndicator } from "../workspaceActivity";
import { renderActionActivityIndicator } from "./activityBadge";
import { listStyles } from "./shared";

/**
 * The registered project for a history entry, matched on the resolved path the
 * registry itself dedupes by. History deliberately stores no project id, because
 * closing and reopening a path can mint a new one.
 */
export function registeredProjectForEntry(entry: RecentProjectEntry, projects: readonly Project[]): Project | undefined {
  return projects.find((project) => project.path === entry.path);
}

@customElement("recent-projects-panel")
export class RecentProjectsPanel extends LitElement {
  @property({ attribute: false }) state: RecentProjectsState = { kind: "loading" };
  @property({ attribute: false }) projects: Project[] = [];
  @property({ attribute: false }) workspacesByProjectId: Record<string, Workspace[]> = {};
  @property({ attribute: false }) activities: Record<string, WorkspaceActivity> = {};
  @property({ attribute: false }) selectedProjectId: string | undefined;
  @property({ attribute: false }) onOpenRegistered?: (project: Project) => void;
  @property({ attribute: false }) onOpenClosed?: (entry: RecentProjectEntry, restoreFocus: () => void) => void;
  @property({ attribute: false }) onRemoveRequested?: (
    entry: RecentProjectEntry,
    cancelFocus: () => void,
    removalFocus: () => void,
  ) => void;
  @property({ attribute: false }) onRetry?: () => void;

  override render(): TemplateResult {
    if (this.state.kind === "loading") return html`<p class="muted" role="status">Loading recent projects…</p>`;
    if (this.state.kind === "failed") return this.renderFailure(this.state.message);
    if (this.state.entries.length === 0) return html`<p class="muted recent-projects-empty" role="status" tabindex="-1">No recent projects</p>`;
    return html`
      <div class="list-body recent-projects-list">
        ${this.state.entries.map((entry, index) => this.renderEntry(entry, index))}
      </div>
    `;
  }

  private renderFailure(message: string): TemplateResult {
    return html`
      <div class="recent-projects-failure" role="status">
        <p class="muted">Recent projects could not be loaded: ${message}</p>
        <button class="recent-projects-retry" type="button" @click=${() => { this.onRetry?.(); }}>Retry</button>
      </div>
    `;
  }

  private renderEntry(entry: RecentProjectEntry, index: number): TemplateResult {
    const project = registeredProjectForEntry(entry, this.projects);
    const selected = project !== undefined && project.id === this.selectedProjectId;
    const removeLabel = `Remove ${entry.name} from Recent Projects`;
    return html`
      <div class=${`action-row recent-project-row ${selected ? "selected" : ""}`} data-recent-project-id=${entry.id}>
        <button
          class="action-main recent-project-open"
          type="button"
          title=${entry.path}
          aria-label=${project === undefined ? `${entry.name}, closed, ${entry.path}` : `${entry.name}, ${entry.path}`}
          @click=${() => { this.open(entry, project, index); }}
        >
          <span class="recent-project-primary">
            <span class="recent-project-name">${entry.name}</span>
            ${project === undefined ? html`<span class="recent-project-status">Closed</span>` : null}
          </span>
          <small class="recent-project-path">${entry.path}</small>
          ${project === undefined ? null : this.renderActivity(project)}
        </button>
        <button
          class="recent-project-remove"
          type="button"
          title=${removeLabel}
          aria-label=${removeLabel}
          @click=${(event: MouseEvent) => { this.requestRemoval(event, entry, index); }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="m6 6 12 12M18 6 6 18"></path>
          </svg>
        </button>
      </div>
    `;
  }

  private renderActivity(project: Project): TemplateResult | undefined {
    const kind = projectActivityIndicator(project, this.workspacesByProjectId[project.id] ?? [], this.activities);
    return renderActionActivityIndicator(kind, kind === "terminal" ? "Project terminal active" : "Project active");
  }

  private open(entry: RecentProjectEntry, project: Project | undefined, index: number): void {
    if (project === undefined) {
      this.onOpenClosed?.(entry, () => { void this.restoreClosedFocus(entry.id, index); });
    } else {
      this.onOpenRegistered?.(project);
    }
  }

  private requestRemoval(event: MouseEvent, entry: RecentProjectEntry, index: number): void {
    event.stopPropagation();
    this.onRemoveRequested?.(
      entry,
      () => { void this.focusAfterSettle(() => { this.focusRemoveForEntry(entry.id); }); },
      () => { void this.focusAfterSettle(() => { this.focusPrimaryNear(index); }); },
    );
  }

  /** Focus the original primary action; once it disappears, fall back by original index. */
  private async restoreClosedFocus(entryId: string, originalIndex: number): Promise<void> {
    if (!this.isConnected) return;
    await this.updateComplete;
    if (this.focusPrimaryForEntry(entryId)) return;
    this.focusPrimaryNear(originalIndex);
  }

  /** Re-query the rendered rows after the current update settles instead of retaining stale elements. */
  private async focusAfterSettle(focus: () => void): Promise<void> {
    if (!this.isConnected) return;
    await this.updateComplete;
    focus();
  }

  private rowForEntry(entryId: string): HTMLElement | undefined {
    return Array.from(this.renderRoot.querySelectorAll<HTMLElement>(".recent-project-row"))
      .find((row) => row.dataset["recentProjectId"] === entryId);
  }

  private focusPrimaryForEntry(entryId: string): boolean {
    const primary = this.rowForEntry(entryId)?.querySelector<HTMLElement>(".recent-project-open");
    if (primary == null) return false;
    primary.focus();
    return true;
  }

  private focusRemoveForEntry(entryId: string): boolean {
    const remove = this.rowForEntry(entryId)?.querySelector<HTMLElement>(".recent-project-remove");
    if (remove == null) return false;
    remove.focus();
    return true;
  }

  /** Focus the primary action at the original index, otherwise the one before it, otherwise the empty state. */
  private focusPrimaryNear(originalIndex: number): void {
    const primaries = Array.from(this.renderRoot.querySelectorAll<HTMLElement>(".recent-project-row .recent-project-open"));
    const target = primaries[originalIndex] ?? primaries[originalIndex - 1];
    if (target !== undefined) {
      target.focus();
      return;
    }
    this.renderRoot.querySelector<HTMLElement>(".recent-projects-empty")?.focus();
  }

  static override styles = [listStyles, css`
    /* The shared small rule truncates with ellipsis; history paths must wrap. */
    .recent-project-path { overflow: visible; text-overflow: clip; overflow-wrap: anywhere; white-space: normal; }
    .recent-project-status { flex: 0 0 auto; color: var(--pi-warning); font-size: 12px; }
    /* The sibling remove action overlays the card so the row remains one visual surface. */
    .recent-projects-list { box-sizing: border-box; padding-inline: 8px; }
    .recent-project-row { display: block; }
    .recent-project-open { width: 100%; border-radius: 8px; padding-right: 54px; font: inherit; }
    .recent-project-remove {
      position: absolute;
      top: 0;
      right: 0;
      z-index: 2;
      width: 32px;
      min-width: 32px;
      height: 100%;
      padding: 0;
      border: 0;
      border-radius: 0 8px 8px 0;
      background: transparent;
      display: grid;
      place-items: center;
      color: var(--pi-muted);
      opacity: 0;
      pointer-events: none;
    }
    .action-activity { right: 38px; }
    .recent-project-remove svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .recent-project-row:hover .recent-project-remove,
    .recent-project-row:focus-within .recent-project-remove { opacity: 1; pointer-events: auto; }
    .recent-project-remove:hover { color: var(--pi-text); background: transparent; }
    .recent-project-open:focus-visible, .recent-project-remove:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    @media (hover: none) {
      .recent-project-remove { opacity: 1; pointer-events: auto; }
    }
  `];
}
