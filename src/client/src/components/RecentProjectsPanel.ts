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
  @property({ attribute: false }) onRetry?: () => void;

  override render(): TemplateResult {
    if (this.state.kind === "loading") return html`<p class="muted" role="status">Loading recent projects…</p>`;
    if (this.state.kind === "failed") return this.renderFailure(this.state.message);
    if (this.state.entries.length === 0) return html`<p class="muted" role="status">No recent projects</p>`;
    return html`
      <div class="list-body recent-projects-list">
        ${this.state.entries.map((entry) => this.renderEntry(entry))}
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

  private renderEntry(entry: RecentProjectEntry): TemplateResult {
    const project = registeredProjectForEntry(entry, this.projects);
    const selected = project !== undefined && project.id === this.selectedProjectId;
    return html`
      <div
        class=${`action-row recent-project-row ${selected ? "selected" : ""}`}
        tabindex="0"
        role="button"
        data-recent-project-id=${entry.id}
        title=${entry.path}
        aria-label=${project === undefined ? `${entry.name}, closed, ${entry.path}` : `${entry.name}, ${entry.path}`}
        @click=${() => { this.open(entry, project); }}
        @keydown=${(event: KeyboardEvent) => { this.handleKeydown(event, entry, project); }}
      >
        <div class="action-main">
          <span class="recent-project-primary">
            <span class="recent-project-name">${entry.name}</span>
            ${project === undefined ? html`<span class="recent-project-status">Closed</span>` : null}
          </span>
          <small class="recent-project-path">${entry.path}</small>
          ${project === undefined ? null : this.renderActivity(project)}
        </div>
      </div>
    `;
  }

  private renderActivity(project: Project): TemplateResult | undefined {
    const kind = projectActivityIndicator(project, this.workspacesByProjectId[project.id] ?? [], this.activities);
    return renderActionActivityIndicator(kind, kind === "terminal" ? "Project terminal active" : "Project active");
  }

  private handleKeydown(event: KeyboardEvent, entry: RecentProjectEntry, project: Project | undefined): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    this.open(entry, project);
  }

  private open(entry: RecentProjectEntry, project: Project | undefined): void {
    if (project === undefined) this.onOpenClosed?.(entry, () => { this.focusEntry(entry.id); });
    else this.onOpenRegistered?.(project);
  }

  private focusEntry(entryId: string): void {
    if (!this.isConnected) return;
    const row = Array.from(this.renderRoot.querySelectorAll<HTMLElement>(".recent-project-row"))
      .find((candidate) => candidate.dataset["recentProjectId"] === entryId);
    row?.focus();
  }

  static override styles = [listStyles, css`
    /* The shared small rule truncates with ellipsis; history paths must wrap. */
    .recent-project-path { overflow: visible; text-overflow: clip; overflow-wrap: anywhere; white-space: normal; }
    .recent-project-status { flex: 0 0 auto; color: var(--pi-warning); font-size: 12px; }
  `];
}
