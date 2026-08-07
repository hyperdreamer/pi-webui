import { LitElement, css, html, type PropertyValues, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { customElement, property, query, state } from "lit/decorators.js";
import type { Project, Workspace, WorkspaceActivity } from "../api";
import { projectActivityIndicator } from "../workspaceActivity";
import { actionMenuPanelStyle, isClickWithinActionMenu } from "./actionMenu";
import { renderActionActivityIndicator } from "./activityBadge";
import { projectSubtreeIds, projectTreeRows, visibleProjectsFromRows, type ProjectTreeRow } from "./projectListProjection";
import { activateSelectableRow, handleSelectableRowKeyboard } from "./selectableRow";

@customElement("project-browser-dialog")
export class ProjectBrowserDialog extends LitElement {
  @property({ attribute: false }) projects: Project[] = [];
  @property({ attribute: false }) selected?: Project;
  @property({ attribute: false }) activities: Record<string, WorkspaceActivity> = {};
  @property({ attribute: false }) workspacesByProjectId: Record<string, Workspace[]> = {};
  @property({ attribute: false }) onSelect?: (project: Project) => void;
  @property({ attribute: false }) onCloseProject?: (project: Project) => void | Promise<void>;
  @property({ attribute: false }) onCloseProjectTree?: (project: Project) => void | Promise<void>;
  @property({ attribute: false }) onPinProject?: (project: Project) => void | Promise<void>;
  @property({ attribute: false }) onUnpinProject?: (project: Project) => void | Promise<void>;
  @property({ attribute: false }) onShowProjectStatistics?: (project: Project) => void | Promise<void>;
  @property({ type: Boolean }) statisticsAvailable = false;
  @property({ attribute: false }) onAdd?: () => void;
  @property({ attribute: false }) onClose?: () => void;

  @state() private searchQuery = "";
  @state() private openMenuProjectId: string | undefined;
  @state() private menuStyle = "";
  @state() private expandedProjectIds: ReadonlySet<string> = new Set();
  @query(".project-browser-search") private searchInput?: HTMLInputElement;

  private readonly onDocumentClick = (event: Event): void => {
    if (this.openMenuProjectId === undefined || isClickWithinActionMenu(event, this.renderRoot)) return;
    this.openMenuProjectId = undefined;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this.onDocumentClick, true);
  }

  override disconnectedCallback(): void {
    document.removeEventListener("click", this.onDocumentClick, true);
    super.disconnectedCallback();
  }

  override firstUpdated(): void {
    this.searchInput?.focus();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("projects")) {
      const existingIds = new Set(this.projects.map((project) => project.id));
      const prunedExpansion = new Set([...this.expandedProjectIds].filter((id) => existingIds.has(id)));
      if (prunedExpansion.size !== this.expandedProjectIds.size) this.expandedProjectIds = prunedExpansion;
      if (this.openMenuProjectId !== undefined && !existingIds.has(this.openMenuProjectId)) {
        this.openMenuProjectId = undefined;
        return;
      }
    }
    if (this.openMenuProjectId === undefined || (!changed.has("projects") && !changed.has("activities") && !changed.has("workspacesByProjectId"))) return;

    const previousProjects = changed.get("projects") ?? this.projects;
    const previousActivities = changed.get("activities") ?? this.activities;
    const previousWorkspacesByProjectId = changed.get("workspacesByProjectId") ?? this.workspacesByProjectId;
    const previousRows = projectTreeRows(previousProjects, {
      queryText: this.searchQuery,
      ...(this.selected === undefined ? {} : { selectedProjectId: this.selected.id }),
      expandedProjectIds: this.expandedProjectIds,
      workspacesByProjectId: previousWorkspacesByProjectId,
      activities: previousActivities,
    });
    if (visibleProjectOrderChanged(visibleProjectsFromRows(previousRows), this.visibleProjects)) this.openMenuProjectId = undefined;
  }

  private get visibleRows(): ProjectTreeRow[] {
    return projectTreeRows(this.projects, {
      queryText: this.searchQuery,
      ...(this.selected === undefined ? {} : { selectedProjectId: this.selected.id }),
      expandedProjectIds: this.expandedProjectIds,
      workspacesByProjectId: this.workspacesByProjectId,
      activities: this.activities,
    });
  }

  private get visibleProjects(): Project[] {
    return visibleProjectsFromRows(this.visibleRows);
  }

  private close(): void {
    this.openMenuProjectId = undefined;
    this.onClose?.();
  }

  private select(project: Project): void {
    this.openMenuProjectId = undefined;
    if (!this.hasProject(project.id)) return;
    this.onSelect?.(project);
  }

  override render(): TemplateResult {
    return html`
      <div class="backdrop" @mousedown=${(event: MouseEvent) => { this.handleBackdropMouseDown(event); }}>
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="project-browser-title"
          tabindex="-1"
          @mousedown=${(event: MouseEvent) => { event.stopPropagation(); }}
          @keydown=${(event: KeyboardEvent) => { this.handleDialogKeyDown(event); }}
        >
          <header>
            <h1 id="project-browser-title">Projects</h1>
            <div class="header-actions">
              <button class="add-button" type="button" @click=${() => { this.onAdd?.(); }}>Add project</button>
              <button class="close-button" type="button" title="Close expanded project browser" aria-label="Close expanded project browser" @click=${() => { this.close(); }}>
                <svg class="close-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18"></path></svg>
              </button>
            </div>
          </header>
          <div class="dialog-body">
            <label class="search-label" for="project-browser-search">Search projects</label>
            <input
              id="project-browser-search"
              class="project-browser-search"
              type="search"
              placeholder="Search projects"
              .value=${this.searchQuery}
              @input=${(event: Event) => { this.handleSearchInput(event); }}
            >
            <div class="result-area" @scroll=${() => { this.openMenuProjectId = undefined; }}>
              ${this.renderResults()}
            </div>
          </div>
        </section>
      </div>
    `;
  }

  private renderResults(): TemplateResult {
    if (this.projects.length === 0) {
      return html`
        <div class="empty-state">
          <p>No projects are open.</p>
          <button class="add-empty-button" type="button" @click=${() => { this.onAdd?.(); }}>Add project</button>
        </div>
      `;
    }

    const rows = this.visibleRows;
    if (rows.length === 0) return html`<p class="empty-state">No matching projects.</p>`;

    return html`
      <div class="project-list">
        ${repeat(
          this.groupRows(rows),
          (group) => group[0]?.project.id ?? "",
          (group) => group[0]?.hasChildren === true
            ? html`<div class="session-family-frame">${group.map((row) => this.renderProjectRow(row))}</div>`
            : html`${group.map((row) => this.renderProjectRow(row))}`,
        )}
      </div>
    `;
  }

  /** Group consecutive rows into depth-zero families so each root gets one frame. */
  private groupRows(rows: readonly ProjectTreeRow[]): ProjectTreeRow[][] {
    return rows.reduce<ProjectTreeRow[][]>((groups, row) => {
      if (row.depth === 0) groups.push([row]);
      else groups.at(-1)?.push(row);
      return groups;
    }, []);
  }

  private renderProjectRow(row: ProjectTreeRow): TemplateResult {
    const project = row.project;
    const cappedDepth = Math.min(row.depth, 2);
    return html`
      <div
        class=${`project-row action-row ${this.selected?.id === project.id ? "selected" : ""}`}
        style=${`--depth:${String(cappedDepth)}`}
        tabindex="0"
        title=${project.path}
        @click=${(event: MouseEvent) => { activateSelectableRow(event, () => { this.select(project); }); }}
        @keydown=${(event: KeyboardEvent) => { this.handleProjectKeydown(event, project); }}
      >
        <div class="project-main">
          <span class="project-name">${this.renderGroupToggle(row)}${row.depth > 0 ? html`<span class="tree-marker">↳</span>` : null}${this.renderPinToggle(project)}${project.name}</span>
          <span class="project-path">${project.path}</span>
          ${this.renderActivity(project)}
        </div>
        <div class="action-menu">
          <button class="action-menu-toggle" type="button" title="Project actions" aria-label=${`Actions for ${project.name}`} @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(project.id, event.currentTarget); }}>
            <svg class="action-menu-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor"><circle cx="5" cy="12" r="1.5"></circle><circle cx="12" cy="12" r="1.5"></circle><circle cx="19" cy="12" r="1.5"></circle></svg>
          </button>
          ${this.openMenuProjectId === project.id ? html`
            <div class="action-menu-panel" style=${this.menuStyle}>
              ${this.statisticsAvailable ? html`<button type="button" title="Project statistics" @click=${() => { this.showStatistics(project); }}>Statistics</button>` : null}
              ${project.pinned === true
                ? html`<button type="button" title="Unpin project" @click=${() => { this.openMenuProjectId = undefined; void this.onUnpinProject?.(project); }}>Unpin</button>`
                : html`<button type="button" title="Pin project to keep it at the top of the list" @click=${() => { this.openMenuProjectId = undefined; void this.onPinProject?.(project); }}>Pin</button>`}
              <button type="button" title="Close project" @click=${() => { this.closeProject(project); }}>Close</button>
              ${this.renderCloseTreeEntry(project)}
            </div>
          ` : null}
        </div>
      </div>
    `;
  }

  /** Hidden while searching, because search decides visibility rather than fold state. */
  private renderGroupToggle(row: ProjectTreeRow): TemplateResult | null {
    if (!row.hasChildren || this.searchQuery.trim() !== "") return null;
    const action = row.folded ? "Expand" : "Collapse";
    return html`<button class="session-group-toggle" type="button" title=${`${action} ${row.project.name}`} aria-label=${`${action} ${row.project.name}`} aria-expanded=${String(!row.folded)} @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleProjectGroup(row.project.id, row.folded); }}>${row.folded ? "▸" : "▾"}</button>`;
  }

  private toggleProjectGroup(projectId: string, folded: boolean): void {
    const next = new Set(this.expandedProjectIds);
    if (folded) next.add(projectId);
    else next.delete(projectId);
    this.expandedProjectIds = next;
  }

  private handleSearchInput(event: Event): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.searchQuery = event.target.value;
    this.openMenuProjectId = undefined;
  }

  private handleProjectKeydown(event: KeyboardEvent, project: Project): void {
    handleSelectableRowKeyboard(event, { activate: () => { this.select(project); } });
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
    const focusable = [...this.renderRoot.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex='0']")];
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

  private toggleMenu(projectId: string, target: EventTarget | null): void {
    if (!this.hasProject(projectId)) {
      this.openMenuProjectId = undefined;
      return;
    }
    if (this.openMenuProjectId === projectId) {
      this.openMenuProjectId = undefined;
      return;
    }
    this.menuStyle = actionMenuPanelStyle(target, { constrainTo: "viewport" });
    this.openMenuProjectId = projectId;
  }

  private closeProject(project: Project): void {
    this.openMenuProjectId = undefined;
    if (!this.hasProject(project.id)) return;
    if (confirm(`Close ${project.name}?\n\nThis only removes it from PI WEBUI; it will not change the project folder.`)) {
      void this.onCloseProject?.(project);
    }
  }

  private renderCloseTreeEntry(project: Project): TemplateResult | null {
    const descendantCount = projectSubtreeIds(this.projects, project.id).length - 1;
    if (descendantCount < 1) return null;
    return html`<button type="button" title="Close this project and its subprojects" @click=${() => { this.closeProjectTree(project, descendantCount); }}>Close with subprojects (${descendantCount})</button>`;
  }

  private closeProjectTree(project: Project, descendantCount: number): void {
    this.openMenuProjectId = undefined;
    if (!this.hasProject(project.id)) return;
    const noun = descendantCount === 1 ? "subproject" : "subprojects";
    if (confirm(`Close ${project.name} and ${String(descendantCount)} ${noun}?\n\nThis only removes them from PI WEBUI; it will not change the project folders.`)) {
      void this.onCloseProjectTree?.(project);
    }
  }

  private showStatistics(project: Project) {
    this.openMenuProjectId = undefined;
    void this.onShowProjectStatistics?.(project);
  }

  private renderPinToggle(project: Project): TemplateResult {
    const isPinned = project.pinned === true;
    const label = `${isPinned ? "Unpin" : "Pin"} ${project.name}`;
    return html`<button
      class=${`pin-toggle ${isPinned ? "pinned" : ""}`}
      type="button"
      title=${isPinned ? "Click to unpin project" : "Click to pin project"}
      aria-label=${label}
      aria-pressed=${String(isPinned)}
      @click=${(event: MouseEvent) => {
        event.stopPropagation();
        void (isPinned ? this.onUnpinProject?.(project) : this.onPinProject?.(project));
      }}
    >${isPinned ? "★" : "☆"}</button> `;
  }

  private renderActivity(project: Project): TemplateResult | undefined {
    const kind = projectActivityIndicator(project, this.workspacesByProjectId[project.id] ?? [], this.activities);
    return renderActionActivityIndicator(kind, kind === "terminal" ? "Project terminal active" : "Project active");
  }

  private hasProject(projectId: string): boolean {
    return this.projects.some((project) => project.id === projectId);
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 60; display: block; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    * { box-sizing: border-box; }
    .backdrop { width: 100%; height: 100dvh; display: grid; place-items: center; padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); background: var(--pi-overlay); }
    section[role="dialog"] { width: min(960px, 100%); height: min(760px, 100%); min-width: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; border: 1px solid var(--pi-border); border-radius: 12px; background: var(--pi-bg); box-shadow: 0 20px 64px var(--pi-shadow-strong); }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--pi-border); }
    h1, p { margin: 0; }
    h1 { font-size: 20px; line-height: 1.25; }
    .header-actions { display: flex; align-items: center; gap: 8px; }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 8px 11px; font: inherit; cursor: pointer; }
    button:hover { background: var(--pi-surface-hover); }
    button:focus-visible, input:focus-visible, .project-row:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .add-button { border-color: var(--pi-accent); background: var(--pi-accent); color: var(--pi-bg); font-weight: 700; }
    .add-button:hover { background: var(--pi-accent); filter: brightness(1.08); }
    .close-button { display: grid; place-items: center; width: 36px; height: 36px; padding: 0; color: var(--pi-muted); }
    .close-icon { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
    .close-button:hover { color: var(--pi-text); }
    .dialog-body { min-height: 0; display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: 7px; padding: 16px; }
    .search-label { font-weight: 700; }
    .project-browser-search { width: 100%; min-width: 0; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 8px 10px; font: inherit; }
    .result-area { min-height: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; }
    .project-list { display: grid; gap: 8px; }
    .project-row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; cursor: pointer; }
    .project-main { position: relative; min-width: 0; display: grid; gap: 3px; border: 1px solid var(--pi-border); border-radius: 8px 0 0 8px; background: var(--pi-surface); padding: 9px 28px 9px calc(11px + var(--depth, 0) * 16px); }
    .project-row:hover .project-main { background: var(--pi-surface-hover); }
    .project-row.selected .project-main, .project-row.selected .action-menu-toggle { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    .project-name { min-width: 0; font-weight: 700; overflow-wrap: anywhere; }
    .pin-toggle { flex: 0 0 auto; border: 0; background: transparent; color: var(--pi-muted); padding: 0; font: inherit; font-size: 14px; line-height: 1; cursor: pointer; }
    .pin-toggle.pinned { color: #d4a017; }
    .pin-toggle:hover { border-radius: 4px; background: var(--pi-surface); box-shadow: 0 0 0 1px var(--pi-border); transform: scale(1.25); }
    .pin-toggle:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; border-radius: 2px; }
    .project-path { min-width: 0; white-space: normal; overflow-wrap: anywhere; color: var(--pi-muted); font-size: 12px; line-height: 1.35; }
    .action-activity { position: absolute; top: 6px; right: 7px; display: grid; place-items: center; width: 10px; height: 10px; }
    .action-activity .activity-indicator { margin: 0; }
    .activity-indicator { display: inline-block; width: 7px; height: 7px; background: var(--pi-success); animation: pulse 1s ease-in-out infinite; }
    .activity-indicator.session { border-radius: 50%; background: var(--pi-success); }
    .activity-indicator.terminal { border-radius: 2px; background: var(--pi-accent); }
    .action-menu { position: relative; }
    .action-menu-toggle { display: grid; place-items: center; width: 36px; height: 100%; min-height: 100%; border-left: 0; border-radius: 0 8px 8px 0; padding: 0; color: var(--pi-muted); }
    .action-menu-icon { width: 18px; height: 18px; }
    .action-menu-toggle:hover { color: var(--pi-text); }
    .action-menu-panel { position: fixed; z-index: 70; min-width: min(120px, calc(100vw - 16px)); max-width: calc(100vw - 16px); overflow: auto; padding: 4px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); box-shadow: 0 8px 24px var(--pi-shadow); overflow-wrap: anywhere; }
    .action-menu-panel button { display: block; width: 100%; border: 0; background: transparent; text-align: left; white-space: normal; overflow-wrap: anywhere; }
    .action-menu-panel button:hover { background: var(--pi-selection-bg); }
    .empty-state { display: grid; gap: 10px; justify-items: start; margin: 0; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-muted); padding: 14px; }
    .add-empty-button { color: var(--pi-text); }
    /* Family frames and disclosure toggles mirror SessionList's rules so both surfaces present identically. */
    .session-family-frame { box-sizing: border-box; margin: 6px 0; border: 1px solid var(--pi-danger); border-radius: 10px; background: color-mix(in srgb, var(--pi-surface) 52%, transparent); padding: 5px 6px; }
    .session-family-frame > .action-row { margin: 4px 0; }
    .session-family-frame > .action-row:first-child { margin-top: 0; }
    .session-family-frame > .action-row:last-child { margin-bottom: 0; }
    .session-group-toggle { flex: 0 0 auto; display: inline-grid; place-items: center; width: 24px; min-width: 24px; height: 24px; margin: 0; border: 0; border-radius: 4px; background: transparent; color: var(--pi-muted); padding: 0; font: inherit; line-height: 1; cursor: pointer; }
    .session-group-toggle:hover { background: var(--pi-surface); box-shadow: 0 0 0 1px var(--pi-border); color: var(--pi-text); }
    .session-group-toggle:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    .tree-marker { color: var(--pi-dim); margin-right: 5px; }
    @keyframes pulse { 0%, 100% { transform: scale(.75); opacity: .55; } 50% { transform: scale(1.2); opacity: 1; } }

    @media (max-width: 760px) {
      .backdrop { padding: 0; }
      section[role="dialog"] { width: 100%; height: 100%; border: 0; border-radius: 0; }
      header, .dialog-body { padding-inline: max(12px, env(safe-area-inset-left)) max(12px, env(safe-area-inset-right)); }
      header { padding-top: max(12px, env(safe-area-inset-top)); }
      .dialog-body { padding-bottom: max(12px, env(safe-area-inset-bottom)); }
    }
  `;
}

function visibleProjectOrderChanged(previousProjects: readonly Project[], currentProjects: readonly Project[]): boolean {
  return previousProjects.length !== currentProjects.length
    || previousProjects.some((project, index) => project.id !== currentProjects[index]?.id);
}
