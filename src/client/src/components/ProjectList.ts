import { LitElement, css, html, svg, type PropertyValues } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { customElement, property, query, state } from "lit/decorators.js";
import type { Project, Workspace, WorkspaceActivity } from "../api";
import { projectActivityIndicator } from "../workspaceActivity";
import { actionMenuPanelStyle, isClickWithinActionMenu } from "./actionMenu";
import { renderActionActivityIndicator } from "./activityBadge";
import type { KeyboardNavigableSection } from "./navigationFocus";
import { projectSubtreeIds, projectTreeRows, visibleProjectsFromRows, type ProjectTreeRow } from "./projectListProjection";
import { activateSelectableRow, focusSelectedOrFirstSelectableRow, handleSelectableRowKeyboard } from "./selectableRow";
import { listStyles } from "./shared";

@customElement("project-list")
export class ProjectList extends LitElement implements KeyboardNavigableSection {
  @property({ attribute: false }) projects: Project[] = [];
  @property({ attribute: false }) selected?: Project;
  @property({ attribute: false }) activities: Record<string, WorkspaceActivity> = {};
  @property({ attribute: false }) workspacesByProjectId: Record<string, Workspace[]> = {};
  @property({ type: Boolean, reflect: true }) collapsible = false;
  @property({ type: Boolean, reflect: true }) collapsed = false;
  @property({ attribute: false }) onSelect?: (project: Project) => void;
  @property({ attribute: false }) onClose?: (project: Project) => void;
  @property({ attribute: false }) onCloseTree?: (project: Project) => void;
  @property({ attribute: false }) onPin?: (project: Project) => void;
  @property({ attribute: false }) onUnpin?: (project: Project) => void;
  @property({ attribute: false }) onShowStatistics?: (project: Project) => void;
  @property({ type: Boolean }) statisticsAvailable = false;
  @property({ attribute: false }) onAdd?: () => void;
  @property({ attribute: false }) onOpenExpanded?: (restoreFocus: () => void) => void;
  @property({ attribute: false }) onToggleCollapsed?: () => void;
  @property({ attribute: false }) onFocusPreviousSection?: () => void | Promise<void>;
  @property({ attribute: false }) onFocusNextSection?: () => void | Promise<void>;
  @property({ attribute: false }) onCancelKeyboardNavigation?: () => void | Promise<void>;
  @query(".project-search-input") private searchInput?: HTMLInputElement;
  @state() private expandedProjectIds: ReadonlySet<string> = new Set();
  @state() private openMenuProjectId: string | undefined;
  @state() private menuStyle = "";
  @state() private searchOpen = false;
  @state() private searchQuery = "";
  private readonly onDocumentClick = (event: Event) => {
    if (isClickWithinActionMenu(event, this.renderRoot)) return;
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

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("projects")) {
      const existingIds = new Set(this.projects.map((project) => project.id));
      const prunedExpansion = new Set([...this.expandedProjectIds].filter((id) => existingIds.has(id)));
      if (prunedExpansion.size !== this.expandedProjectIds.size) this.expandedProjectIds = prunedExpansion;
      if (this.openMenuProjectId !== undefined && !existingIds.has(this.openMenuProjectId)) this.openMenuProjectId = undefined;
    }
    if (this.openMenuProjectId !== undefined && (changed.has("projects") || changed.has("activities") || changed.has("workspacesByProjectId"))) {
      const previousProjects = changed.get("projects") ?? this.projects;
      const previousWorkspacesByProjectId = changed.get("workspacesByProjectId") ?? this.workspacesByProjectId;
      const previousActivities = changed.get("activities") ?? this.activities;
      const previousRows = projectTreeRows(previousProjects, {
        queryText: this.searchQuery,
        ...(this.selected === undefined ? {} : { selectedProjectId: this.selected.id }),
        expandedProjectIds: this.expandedProjectIds,
        workspacesByProjectId: previousWorkspacesByProjectId,
        activities: previousActivities,
      });
      if (shouldCloseProjectMenuForOrderChange(
        this.openMenuProjectId,
        visibleProjectsFromRows(previousRows),
        visibleProjectsFromRows(this.visibleRows),
      )) this.openMenuProjectId = undefined;
    }
    if (changed.has("collapsed") && this.collapsed) this.openMenuProjectId = undefined;
  }

  async focusSelectedOrFirst(): Promise<boolean> {
    await this.updateComplete;
    return focusSelectedOrFirstSelectableRow(this.renderRoot, { fallbackSelector: ".section-toggle" });
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

  /** Group consecutive rows into depth-zero families so each root gets one frame. */
  private groupRows(rows: readonly ProjectTreeRow[]): ProjectTreeRow[][] {
    return rows.reduce<ProjectTreeRow[][]>((groups, row) => {
      if (row.depth === 0) groups.push([row]);
      else groups.at(-1)?.push(row);
      return groups;
    }, []);
  }

  override render() {
    const rows = this.visibleRows;
    return html`
      <section>
        <h2>
          ${this.renderHeading()}
          ${this.renderExpandedBrowserButton()}
          ${this.collapsed ? null : this.renderSearchButton()}
          ${this.renderAddButton()}
        </h2>
        ${this.collapsed ? null : html`
          ${this.searchOpen ? this.renderSearchInput() : null}
          <div class="list-body">
            ${repeat(
              this.groupRows(rows),
              (group) => group[0]?.project.id ?? "",
              (group) => group[0]?.hasChildren === true
                ? html`<div class="session-family-frame">${group.map((row) => this.renderProjectRow(row))}</div>`
                : html`${group.map((row) => this.renderProjectRow(row))}`,
            )}
            ${rows.length === 0 && this.searchQuery.trim() !== "" ? html`<p class="project-search-empty">No matching projects.</p>` : null}
          </div>
        `}
      </section>
    `;
  }

  /**
   * Renders one project row. Kept as a private method so the action-menu and
   * pinned-star wiring stays testable through the shared TemplateResult
   * inspection helpers, which cannot descend into the `repeat` directive's
   * results.
   */
  private renderProjectRow(row: ProjectTreeRow) {
    const project = row.project;
    const cappedDepth = Math.min(row.depth, 2);
    return html`
      <div
        class=${`action-row ${this.selected?.id === project.id ? "selected" : ""}`}
        style=${`--depth:${String(cappedDepth)}`}
        tabindex="0"
        title=${project.path}
        @click=${(event: MouseEvent) => { activateSelectableRow(event, () => this.onSelect?.(project)); }}
        @keydown=${(event: KeyboardEvent) => { this.handleProjectKeydown(event, project); }}
      >
        <div class="action-main">
          <span class="workspace-primary">${this.renderGroupToggle(row)}${row.depth > 0 ? html`<span class="tree-marker">↳</span>` : null}${project.pinned === true ? html`<button class="pinned-star" type="button" title="Click to unpin project" aria-label=${`Unpin ${project.name}`} aria-pressed="true" @click=${(event: MouseEvent) => { event.stopPropagation(); this.onUnpin?.(project); }}>★</button> ` : null}<span class="workspace-primary-label">${project.name}</span></span><small>${project.path}</small>
          ${this.renderActivity(project)}
        </div>
        <div class="action-menu">
          <button class="action-menu-toggle" title="Project actions" aria-label=${`Actions for ${project.name}`} @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(project.id, event.currentTarget); }}>⋯</button>
          ${this.openMenuProjectId === project.id ? html`
            <div class="action-menu-panel" style=${this.menuStyle}>
              ${this.statisticsAvailable ? html`<button title="Project statistics" @click=${() => { this.showStatistics(project); }}>Statistics</button>` : null}
              ${project.pinned === true
                ? html`<button title="Unpin project" @click=${() => { this.openMenuProjectId = undefined; this.onUnpin?.(project); }}>Unpin</button>`
                : html`<button title="Pin project to keep it at the top of the list" @click=${() => { this.openMenuProjectId = undefined; this.onPin?.(project); }}>Pin</button>`}
              <button title="Close project" @click=${() => { this.close(project); }}>Close</button>
              ${this.renderCloseTreeEntry(project)}
            </div>
          ` : null}
        </div>
      </div>
    `;
  }

  /** Hidden while searching, because search decides visibility rather than fold state. */
  private renderGroupToggle(row: ProjectTreeRow) {
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

  private handleProjectKeydown(event: KeyboardEvent, project: Project): void {
    handleSelectableRowKeyboard(event, {
      activate: () => this.onSelect?.(project),
      previousSection: this.onFocusPreviousSection === undefined ? undefined : () => { void this.onFocusPreviousSection?.(); },
      nextSection: this.onFocusNextSection === undefined ? undefined : () => { void this.onFocusNextSection?.(); },
      cancel: this.onCancelKeyboardNavigation === undefined ? undefined : () => { void this.onCancelKeyboardNavigation?.(); },
    });
  }

  private renderHeading() {
    if (!this.collapsible) return html`<span>Projects</span>`;
    const selectedSummary = this.selected?.name ?? "No project selected";
    const selectedTitle = this.selected?.path ?? selectedSummary;
    return html`<button class="section-toggle" aria-expanded=${String(!this.collapsed)} @click=${() => { this.onToggleCollapsed?.(); }}><span class="section-title"><span class="section-name">${this.collapsed ? "▸" : "▾"} Projects</span>${this.collapsed ? html`<small class="section-selected" title=${selectedTitle}>${selectedSummary}</small>` : null}</span><small class="section-count">${this.projects.length}</small></button>`;
  }

  private renderSearchButton() {
    const label = this.searchOpen ? "Close project search" : "Search projects";
    return html`
      <button type="button" class="section-search-button" title=${label} aria-label=${label} aria-expanded=${String(this.searchOpen)} aria-controls="project-search" @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleProjectSearch(); }}>
        ${svg`<svg class="section-search-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="6"></circle><path d="m16 16 4 4"></path></svg>`}
      </button>
    `;
  }

  private renderExpandedBrowserButton() {
    return html`
      <button type="button" class="section-expand-button" title="Open expanded project browser" aria-label="Open expanded project browser" @click=${(event: MouseEvent) => { this.openExpandedBrowser(event); }}>
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

  private renderSearchInput() {
    return html`
      <div class="project-search">
        <input id="project-search" class="project-search-input" type="search" placeholder="Search projects" aria-label="Search projects" .value=${this.searchQuery} @input=${(event: Event) => { this.handleSearchInput(event); }}>
      </div>
    `;
  }

  private renderAddButton() {
    return html`<button class="section-add-button" title="Add project" aria-label="Add project" @click=${(event: MouseEvent) => { event.stopPropagation(); this.onAdd?.(); }}>+</button>`;
  }

  private toggleProjectSearch(): void {
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
    if (!(event.target instanceof HTMLInputElement)) return;
    this.searchQuery = event.target.value;
    this.openMenuProjectId = undefined;
  }

  private renderActivity(project: Project) {
    const kind = projectActivityIndicator(project, this.workspacesByProjectId[project.id] ?? [], this.activities);
    return renderActionActivityIndicator(kind, kind === "terminal" ? "Project terminal active" : "Project active");
  }

  private toggleMenu(projectId: string, target: EventTarget | null) {
    if (this.openMenuProjectId === projectId) {
      this.openMenuProjectId = undefined;
      return;
    }
    this.menuStyle = actionMenuPanelStyle(target, { constrainTo: "viewport" });
    this.openMenuProjectId = projectId;
  }

  private close(project: Project) {
    this.openMenuProjectId = undefined;
    if (confirm(`Close ${project.name}?\n\nThis only removes it from PI WEBUI; it will not change the project folder.`)) this.onClose?.(project);
  }

  /** Descendant count comes from the whole catalog, so a folded family still reports honestly. */
  private renderCloseTreeEntry(project: Project) {
    const descendantCount = projectSubtreeIds(this.projects, project.id).length - 1;
    if (descendantCount < 1) return null;
    return html`<button title="Close this project and its subprojects" @click=${() => { this.closeTree(project, descendantCount); }}>Close with subprojects (${descendantCount})</button>`;
  }

  private closeTree(project: Project, descendantCount: number): void {
    this.openMenuProjectId = undefined;
    // A handler captured before the catalog changed must not act on a project
    // that is already gone, matching the expanded browser's guard.
    if (!this.projects.some((candidate) => candidate.id === project.id)) return;
    const noun = descendantCount === 1 ? "subproject" : "subprojects";
    if (confirm(`Close ${project.name} and ${String(descendantCount)} ${noun}?\n\nThis only removes them from PI WEBUI; it will not change the project folders.`)) {
      this.onCloseTree?.(project);
    }
  }

  private showStatistics(project: Project) {
    this.openMenuProjectId = undefined;
    this.onShowStatistics?.(project);
  }

  static override styles = [
    listStyles,
    css`
      .section-search-button, .section-expand-button { box-sizing: border-box; flex: 0 0 auto; display: inline-grid; place-items: center; width: 30px; height: 30px; padding: 0; }
      .section-search-icon, .section-expand-icon { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      .project-search { flex: 0 0 auto; margin: 0 0 6px; }
      .project-search-input { box-sizing: border-box; width: 100%; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-text); padding: 6px 8px; font: inherit; }
      .project-search-input:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
      .project-search-empty { margin: 6px 0; color: var(--pi-muted); }
      .pinned-star { flex: 0 0 auto; border: 0; background: transparent; color: #d4a017; padding: 0; font: inherit; font-size: 14px; line-height: 1; cursor: pointer; }
      .pinned-star:hover { border-radius: 4px; background: var(--pi-surface); box-shadow: 0 0 0 1px var(--pi-border); transform: scale(1.25); }
      .pinned-star:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; border-radius: 2px; }
      /* Family frames and disclosure toggles, mirroring SessionList's rules so both lists present identically; kept local because listStyles is shared more widely. */
      .session-family-frame { box-sizing: border-box; margin: 6px 0; border: 1px solid var(--pi-danger); border-radius: 10px; background: color-mix(in srgb, var(--pi-surface) 52%, transparent); padding: 5px 6px; }
      .session-family-frame > .action-row { margin: 4px 0; }
      .session-family-frame > .action-row:first-child { margin-top: 0; }
      .session-family-frame > .action-row:last-child { margin-bottom: 0; }
      .session-group-toggle { flex: 0 0 auto; display: grid; place-items: center; width: 24px; min-width: 24px; height: 24px; margin: 0; border: 0; border-radius: 4px; background: transparent; color: var(--pi-muted); padding: 0; font: inherit; line-height: 1; }
      .session-group-toggle:hover { background: var(--pi-surface); box-shadow: 0 0 0 1px var(--pi-border); color: var(--pi-text); transform: scale(1.25); }
      .session-group-toggle:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    `,
  ];
}

export function shouldCloseProjectMenuForOrderChange(projectId: string, previousProjects: readonly Project[], currentProjects: readonly Project[]): boolean {
  const previousIndex = previousProjects.findIndex((project) => project.id === projectId);
  const currentIndex = currentProjects.findIndex((project) => project.id === projectId);
  return previousIndex !== currentIndex;
}
