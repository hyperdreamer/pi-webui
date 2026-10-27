import { LitElement, html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Workspace, WorkspaceActivity } from "../api";
import type { WorkspaceLabelItem } from "../plugins/types";
import { workspaceActivityFor, workspaceActivityIndicator } from "../workspaceActivity";
import { actionMenuPanelStyle, isClickWithinActionMenu } from "./actionMenu";
import { renderActionActivityIndicator } from "./activityBadge";
import type { KeyboardNavigableSection } from "./navigationFocus";
import { activateSelectableRow, focusSelectedOrFirstSelectableRow, handleSelectableRowKeyboard } from "./selectableRow";
import { listStyles } from "./shared";
import { renderWorkspaceLabelInlineItems } from "./workspaceLabel";

@customElement("workspace-list")
export class WorkspaceList extends LitElement implements KeyboardNavigableSection {
  @property({ attribute: false }) workspaces: Workspace[] = [];
  @property({ attribute: false }) selected?: Workspace;
  @property({ type: Boolean, reflect: true }) collapsible = false;
  @property({ type: Boolean, reflect: true }) collapsed = false;
  @property({ attribute: false }) workspaceLabelItems: (workspace: Workspace) => WorkspaceLabelItem[] = () => [];
  @property({ attribute: false }) activities: Record<string, WorkspaceActivity> = {};
  @property({ attribute: false }) deletingWorkspaceIds: string[] = [];
  @property({ attribute: false }) onSelect?: (workspace: Workspace) => void;
  @property({ attribute: false }) onDelete?: (workspace: Workspace) => void;
  @property({ attribute: false }) onToggleCollapsed?: () => void;
  @property({ attribute: false }) onFocusPreviousSection?: () => void | Promise<void>;
  @property({ attribute: false }) onFocusNextSection?: () => void | Promise<void>;
  @property({ attribute: false }) onCancelKeyboardNavigation?: () => void | Promise<void>;
  @state() private openMenuWorkspaceId: string | undefined;
  @state() private menuStyle = "";

  private visibleSelectedWorkspaceId: string | undefined;
  private pendingRevealWorkspaceId: string | undefined;
  // An enclosing collapsed or compact navigation panel hides this list with CSS, which
  // leaves the rows without layout. Scrolling then is a silent no-op, so the reveal is
  // retried once the list has a size again instead of being consumed while hidden.
  private readonly revealOnResize = typeof ResizeObserver === "undefined"
    ? undefined
    : new ResizeObserver(() => { this.revealPendingSelection(); });

  private readonly onDocumentClick = (event: Event) => {
    if (isClickWithinActionMenu(event, this.renderRoot)) return;
    this.openMenuWorkspaceId = undefined;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this.onDocumentClick, true);
    this.revealOnResize?.observe(this);
  }

  override disconnectedCallback(): void {
    document.removeEventListener("click", this.onDocumentClick, true);
    this.revealOnResize?.disconnect();
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("workspaces") && this.openMenuWorkspaceId !== undefined && !this.workspaces.some((workspace) => workspace.id === this.openMenuWorkspaceId)) this.openMenuWorkspaceId = undefined;
    if (changed.has("collapsed") && this.collapsed) this.openMenuWorkspaceId = undefined;
    // Refreshes replace workspace objects without changing the user's selection.
    // Only reveal a newly selected or newly visible row, not every refreshed list.
    if (!changed.has("selected") && !changed.has("workspaces") && !changed.has("collapsed")) return;
    const visibleSelectedId = !this.collapsed && this.workspaces.some((workspace) => workspace.id === this.selected?.id)
      ? this.selected?.id
      : undefined;
    if (visibleSelectedId === undefined) {
      this.visibleSelectedWorkspaceId = undefined;
      this.pendingRevealWorkspaceId = undefined;
      return;
    }
    if (visibleSelectedId === this.visibleSelectedWorkspaceId) return;
    this.pendingRevealWorkspaceId = this.revealSelectedWorkspace(visibleSelectedId) ? undefined : visibleSelectedId;
  }

  async focusSelectedOrFirst(): Promise<boolean> {
    await this.updateComplete;
    return focusSelectedOrFirstSelectableRow(this.renderRoot, { fallbackSelector: ".section-toggle" });
  }

  override render() {
    return html`
      <section>
        <h2>${this.renderHeading()}</h2>
        ${this.collapsed ? null : html`
          <div class="list-body">
            ${this.workspaces.map((workspace) => {
              const label = workspacePrimaryLabel(workspace);
              const items = this.workspaceLabelItems(workspace);
              return html`
                <div
                  class=${`action-row workspace-row ${this.selected?.id === workspace.id ? "selected" : ""}`}
                  tabindex="0"
                  title=${label}
                  @click=${(event: MouseEvent) => { activateSelectableRow(event, () => this.onSelect?.(workspace)); }}
                  @keydown=${(event: KeyboardEvent) => { this.handleWorkspaceKeydown(event, workspace); }}
                >
                  <div class="action-main">
                    ${this.renderWorkspaceMain(label, items, workspace)}
                  </div>
                  ${this.renderWorkspaceMenu(label, items, workspace)}
                </div>
              `;
            })}
          </div>
        `}
      </section>
    `;
  }

  private renderHeading() {
    if (!this.collapsible) return html`<span>Workspaces</span>`;
    const selectedSummary = this.selected === undefined ? "No workspace selected" : `${this.selected.label}${this.selected.isMain ? " · main" : ""} · ${this.selected.path}`;
    const selectedTitle = this.selected?.path ?? selectedSummary;
    return html`<button class="section-toggle" aria-expanded=${String(!this.collapsed)} @click=${() => { this.onToggleCollapsed?.(); }}><span class="section-title"><span class="section-name">${this.collapsed ? "▸" : "▾"} Workspaces</span>${this.collapsed ? html`<small class="section-selected" title=${selectedTitle}>${selectedSummary}</small>` : null}</span><small class="section-count">${this.workspaces.length}</small></button>`;
  }

  private renderActivity(workspace: Workspace): TemplateResult | undefined {
    const kind = workspaceActivityIndicator(workspaceActivityFor(workspace, this.activities));
    return renderActionActivityIndicator(kind, kind === "terminal" ? "Workspace terminal active" : "Workspace active");
  }

  private renderWorkspaceMain(label: string, items: WorkspaceLabelItem[], workspace: Workspace): TemplateResult {
    return html`
      <span class="workspace-primary">
        <span class="workspace-primary-label">${label}</span>
        ${this.isDeleting(workspace) ? html`<span class="workspace-status">Deleting…</span>` : null}
      </span>
      ${items.length === 0 ? null : html`
        <small class="workspace-secondary">
          <span class="workspace-label">${renderWorkspaceLabelInlineItems(items)}</span>
        </small>
      `}
      ${this.renderActivity(workspace)}
    `;
  }

  private renderWorkspaceMenu(label: string, items: WorkspaceLabelItem[], workspace: Workspace): TemplateResult {
    const open = this.openMenuWorkspaceId === workspace.id;
    const menuId = workspaceMenuId(workspace.id);
    return html`
      <div class="action-menu">
        <button
          class="action-menu-toggle"
          title="Workspace actions and details"
          aria-label=${`Actions and details for ${label}`}
          aria-expanded=${String(open)}
          aria-controls=${menuId}
          @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleMenu(workspace.id, event.currentTarget); }}
        >⋯</button>
        ${open ? html`
          <div class="action-menu-panel workspace-menu-panel" id=${menuId} style=${this.menuStyle} @click=${(event: MouseEvent) => { event.stopPropagation(); }}>
            ${this.renderWorkspaceActions(workspace)}
            ${this.renderWorkspaceDetails(label, items, workspace)}
          </div>
        ` : null}
      </div>
    `;
  }

  private renderWorkspaceActions(workspace: Workspace): TemplateResult | undefined {
    if (!canDeleteWorkspace(workspace)) return undefined;
    const deleting = this.isDeleting(workspace);
    return html`
      <div class="workspace-menu-actions">
        <button class="danger" title=${deleting ? "Workspace deletion in progress" : "Delete workspace"} ?disabled=${deleting} @click=${() => { this.delete(workspace); }}>${deleting ? "Deleting…" : "Delete workspace"}</button>
      </div>
    `;
  }

  private renderWorkspaceDetails(label: string, items: WorkspaceLabelItem[], workspace: Workspace): TemplateResult {
    return html`
      <dl class="workspace-menu-details">
        <div class="workspace-detail-row">
          <dt>${workspace.branch === undefined ? "Workspace" : "Branch"}</dt>
          <dd>${label}</dd>
        </div>
        <div class="workspace-detail-row">
          <dt>Path</dt>
          <dd title=${workspace.path}>${workspace.path}</dd>
        </div>
        ${items.length === 0 ? null : html`
          <div class="workspace-detail-row">
            <dt>Details</dt>
            <dd><span class="workspace-label">${renderWorkspaceLabelInlineItems(items)}</span></dd>
          </div>
        `}
      </dl>
    `;
  }

  private delete(workspace: Workspace): void {
    if (this.isDeleting(workspace)) return;
    this.openMenuWorkspaceId = undefined;
    this.onDelete?.(workspace);
  }

  private isDeleting(workspace: Workspace): boolean {
    return this.deletingWorkspaceIds.includes(workspace.id);
  }

  private toggleMenu(workspaceId: string, target: EventTarget | null): void {
    if (this.openMenuWorkspaceId === workspaceId) {
      this.openMenuWorkspaceId = undefined;
      return;
    }
    this.menuStyle = actionMenuPanelStyle(target, { constrainTo: "viewport" });
    this.openMenuWorkspaceId = workspaceId;
  }

  private handleWorkspaceKeydown(event: KeyboardEvent, workspace: Workspace): void {
    if (event.key === "Escape" && this.openMenuWorkspaceId === workspace.id) {
      event.preventDefault();
      event.stopPropagation();
      this.openMenuWorkspaceId = undefined;
      return;
    }
    handleSelectableRowKeyboard(event, {
      activate: () => this.onSelect?.(workspace),
      previousSection: this.onFocusPreviousSection === undefined ? undefined : () => { void this.onFocusPreviousSection?.(); },
      nextSection: this.onFocusNextSection === undefined ? undefined : () => { void this.onFocusNextSection?.(); },
      cancel: this.onCancelKeyboardNavigation === undefined ? undefined : () => { void this.onCancelKeyboardNavigation?.(); },
    });
  }

  private revealSelectedWorkspace(workspaceId: string): boolean {
    const row = this.renderRoot.querySelector<HTMLElement>(".action-row.selected");
    // A row inside a hidden navigation panel has no layout; scrolling it now would do
    // nothing and the reveal would be lost for good, because a parent CSS change does
    // not re-run this component's update cycle.
    if (row === null || row.getClientRects().length === 0) return false;
    row.scrollIntoView({ block: "nearest" });
    this.visibleSelectedWorkspaceId = workspaceId;
    return true;
  }

  private revealPendingSelection(): void {
    const pendingId = this.pendingRevealWorkspaceId;
    if (pendingId === undefined || this.collapsed || pendingId !== this.selected?.id) return;
    if (!this.workspaces.some((workspace) => workspace.id === pendingId)) return;
    if (this.revealSelectedWorkspace(pendingId)) this.pendingRevealWorkspaceId = undefined;
  }

  static override styles = listStyles;
}

function workspacePrimaryLabel(workspace: Workspace): string {
  return `${workspace.branch ?? workspace.label}${workspace.isMain ? " · main" : ""}`;
}

function canDeleteWorkspace(workspace: Workspace): boolean {
  return workspace.isGitWorktree && !workspace.isMain;
}

function workspaceMenuId(workspaceId: string): string {
  return `workspace-menu-${workspaceId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}
