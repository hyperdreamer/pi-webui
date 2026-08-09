import { LitElement, html, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { QualifiedContributionId } from "../plugins/types";
import { workspacePanelStyles } from "./shared";

export interface WorkspacePanelEmptyState {
  title: string;
  body?: string;
}

/**
 * A workspace-panel tab with its rendering already bound by the app shell. This
 * exists so a machine-level tab (Recent Projects) can appear with no selected
 * workspace, instead of the panel having to fabricate a WorkspacePanelContext.
 */
export interface ResolvedWorkspacePanelTab {
  id: QualifiedContributionId;
  title: string;
  icon?: TemplateResult;
  badge?: string | number | TemplateResult;
  render: () => TemplateResult;
}

type WorkspacePanelBadge = string | number | TemplateResult | undefined;

@customElement("workspace-panel")
export class WorkspacePanel extends LitElement {
  @property({ attribute: false }) tabs: ResolvedWorkspacePanelTab[] = [];
  @property({ attribute: false }) emptyState: WorkspacePanelEmptyState | undefined;
  @property() tool: QualifiedContributionId = "core:workspace.files";
  @property({ attribute: false }) hiddenTools: QualifiedContributionId[] = [];
  @property({ type: Boolean }) hideToolTabs = false;
  @property({ attribute: false }) onSelectTool: (tool: QualifiedContributionId) => void = () => undefined;
  @query(".workspace-header-strip") private workspaceHeaderStrip?: HTMLElement | null;
  @state() private workspaceHeaderCanScrollLeft = false;
  @state() private workspaceHeaderCanScrollRight = false;

  private observedWorkspaceHeaderStrip: HTMLElement | undefined;
  private workspaceHeaderResizeObserver: ResizeObserver | undefined;
  private readonly onWorkspaceHeaderScroll = () => {
    this.updateWorkspaceHeaderScrollState();
  };

  override firstUpdated(): void {
    this.observeWorkspaceHeaderStrip();
    this.updateWorkspaceHeaderScrollState();
  }

  override updated(): void {
    this.observeWorkspaceHeaderStrip();
    this.updateWorkspaceHeaderScrollState();
  }

  override disconnectedCallback(): void {
    this.workspaceHeaderResizeObserver?.disconnect();
    this.workspaceHeaderResizeObserver = undefined;
    this.observedWorkspaceHeaderStrip = undefined;
    super.disconnectedCallback();
  }

  override render() {
    const tabs = this.tabs;
    if (tabs.length === 0) {
      return this.renderEmptyState(this.emptyState ?? {
        title: "Select a workspace",
        body: "Choose a workspace to inspect files, Git, or terminals.",
      });
    }
    const visibleTabs = tabs.filter((tab) => !this.hiddenTools.includes(tab.id));
    const selectedTab = tabs.find((tab) => tab.id === this.tool) ?? visibleTabs[0] ?? tabs[0];
    return html`
      ${this.hideToolTabs ? null : html`
        <header>
          <div class=${this.workspaceHeaderFrameClass()}>
            <div class="workspace-header-strip" @scroll=${this.onWorkspaceHeaderScroll}>
              <div class="tabs">
                ${visibleTabs.map((tab) => {
                  const selected = selectedTab?.id === tab.id;
                  const ariaLabel = this.panelTabAriaLabel(tab, tab.badge);
                  return html`
                    <button class=${this.panelTabClass(tab, selected)} title=${ariaLabel} aria-label=${ariaLabel} aria-pressed=${String(selected)} @click=${() => { this.onSelectTool(tab.id); }}>
                      ${this.renderPanelTabContent(tab, tab.badge)}
                    </button>
                  `;
                })}
              </div>
            </div>
          </div>
        </header>
      `}
      ${selectedTab === undefined ? this.renderEmptyState({
        title: "No workspace tools available",
        body: "No tools are available for this workspace.",
      }) : html`
        <div class="panel-content">
          ${selectedTab.render()}
        </div>
      `}
    `;
  }

  private panelTabClass(tab: Pick<ResolvedWorkspacePanelTab, "icon">, selected: boolean): string {
    return [
      ...(tab.icon === undefined ? [] : ["icon-tab"]),
      ...(selected ? ["selected"] : []),
    ].join(" ");
  }

  private panelTabAriaLabel(tab: Pick<ResolvedWorkspacePanelTab, "title">, badge: WorkspacePanelBadge): string {
    if (typeof badge !== "string" && typeof badge !== "number") return tab.title;
    const trimmedBadge = String(badge).trim();
    return trimmedBadge === "" ? tab.title : `${tab.title}, ${trimmedBadge}`;
  }

  private renderPanelTabContent(tab: Pick<ResolvedWorkspacePanelTab, "icon" | "title">, badge: WorkspacePanelBadge): TemplateResult {
    return html`
      ${tab.icon === undefined ? null : html`<span class="tab-custom-icon" aria-hidden="true">${tab.icon}</span>`}
      <span class="tab-label">${tab.title}</span>
      ${this.isEmptyBadge(badge) ? null : html`<span class="tab-badge">${badge}</span>`}
    `;
  }

  private isEmptyBadge(badge: WorkspacePanelBadge): boolean {
    return badge === undefined || badge === "";
  }

  private renderEmptyState(state: WorkspacePanelEmptyState): TemplateResult {
    return html`
      <section class="empty-state" role="status">
        <h2>${state.title}</h2>
        ${state.body === undefined ? null : html`<p>${state.body}</p>`}
      </section>
    `;
  }

  private workspaceHeaderFrameClass(): string {
    return `workspace-header-scroll-frame${this.workspaceHeaderCanScrollLeft ? " can-scroll-left" : ""}${this.workspaceHeaderCanScrollRight ? " can-scroll-right" : ""}`;
  }

  private observeWorkspaceHeaderStrip(): void {
    const strip = this.workspaceHeaderStripElement();
    if (this.observedWorkspaceHeaderStrip === strip) return;
    this.workspaceHeaderResizeObserver?.disconnect();
    this.observedWorkspaceHeaderStrip = strip;
    this.workspaceHeaderResizeObserver = undefined;
    if (strip === undefined || typeof ResizeObserver === "undefined") return;
    this.workspaceHeaderResizeObserver = new ResizeObserver(() => {
      this.updateWorkspaceHeaderScrollState();
    });
    this.workspaceHeaderResizeObserver.observe(strip);
  }

  private updateWorkspaceHeaderScrollState(): void {
    const strip = this.workspaceHeaderStripElement();
    const maxScrollLeft = strip === undefined ? 0 : Math.max(0, strip.scrollWidth - strip.clientWidth);
    const canScrollLeft = strip !== undefined && strip.scrollLeft > 1;
    const canScrollRight = strip !== undefined && maxScrollLeft - strip.scrollLeft > 1;
    if (this.workspaceHeaderCanScrollLeft !== canScrollLeft) this.workspaceHeaderCanScrollLeft = canScrollLeft;
    if (this.workspaceHeaderCanScrollRight !== canScrollRight) this.workspaceHeaderCanScrollRight = canScrollRight;
  }

  private workspaceHeaderStripElement(): HTMLElement | undefined {
    const strip = this.workspaceHeaderStrip;
    return strip instanceof HTMLElement ? strip : undefined;
  }

  static override styles = workspacePanelStyles;
}
