import { LitElement, css, html, type TemplateResult } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { renderActivityRailBody, type ReportActivityRailError } from "../plugins/activityRail";
import type { ActivityRailContext, QualifiedActivityRailContribution } from "../plugins/types";

const defaultReportActivityRailError: ReportActivityRailError = (phase, contributionId, error) => {
  console.warn("Plugin activity rail contribution failed", phase, contributionId, error);
};

const sequentialTabStopSelector = [
  "a[href]",
  "area[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "summary",
  "iframe",
  "object",
  "embed",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]",
  "[tabindex]",
].join(", ");

@customElement("plugin-activity-dialog")
export class PluginActivityDialog extends LitElement {
  @property({ attribute: false }) activity!: QualifiedActivityRailContribution;
  @property({ attribute: false }) context!: ActivityRailContext;
  @property({ attribute: false }) onClose?: () => void;
  @property({ attribute: false }) onReportError?: ReportActivityRailError;

  @query(".plugin-activity-close") private closeButton?: HTMLButtonElement;

  override firstUpdated(): void {
    this.closeButton?.focus();
  }

  override render(): TemplateResult {
    const body = renderActivityRailBody(this.activity, this.context, this.onReportError ?? defaultReportActivityRailError);
    return html`
      <div
        class="plugin-activity-backdrop"
        role="dialog"
        aria-modal="true"
        aria-label="${this.activity.title}"
        @click=${this.handleBackdropClick}
        @keydown=${this.handleKeyDown}
      >
        <section class="plugin-activity-frame">
          <header>
            <span class="plugin-activity-icon" aria-hidden="true">${this.activity.icon}</span>
            <h2>${this.activity.title}</h2>
            <button
              class="plugin-activity-close"
              type="button"
              aria-label="${`Close ${this.activity.title}`}"
              @click=${this.close}
            >×</button>
          </header>
          <div class="plugin-activity-body">${body ?? this.renderFailure()}</div>
        </section>
      </div>
    `;
  }

  private readonly close = (): void => {
    this.onClose?.();
  };

  private readonly handleBackdropClick = (event: MouseEvent): void => {
    if (event.target === event.currentTarget) this.close();
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Tab") {
      this.trapTabFocus(event);
      return;
    }
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };

  private trapTabFocus(event: KeyboardEvent): void {
    const frame = this.renderRoot.querySelector<HTMLElement>(".plugin-activity-frame");
    if (frame === null) return;
    const tabStops = this.sequentialTabStops(frame);
    if (tabStops.length === 0) return;

    const activeIndex = tabStops.findIndex((element) => element === this.deeplyFocusedElement());
    const movingPastEnd = !event.shiftKey && activeIndex === tabStops.length - 1;
    const movingBeforeStart = event.shiftKey && activeIndex === 0;
    if (!movingPastEnd && !movingBeforeStart) return;

    event.preventDefault();
    (event.shiftKey ? tabStops.at(-1) : tabStops[0])?.focus();
  }

  private deeplyFocusedElement(): Element | null {
    let activeElement = this.shadowRoot?.activeElement ?? null;
    while (activeElement !== null) {
      const nestedActiveElement = activeElement.shadowRoot?.activeElement;
      if (nestedActiveElement === null || nestedActiveElement === undefined) return activeElement;
      activeElement = nestedActiveElement;
    }
    return null;
  }

  private sequentialTabStops(frame: HTMLElement): HTMLElement[] {
    const candidates: { element: HTMLElement; composedIndex: number }[] = [];
    this.collectComposedTabStopCandidates(frame, false, candidates);

    // Positive tabIndex values precede zero/default controls. Within either
    // group, the composed tree order is the browser-visible tie breaker.
    return candidates
      .sort((left, right) => {
        const leftTabIndex = left.element.tabIndex;
        const rightTabIndex = right.element.tabIndex;
        const leftIsPositive = leftTabIndex > 0;
        const rightIsPositive = rightTabIndex > 0;
        if (leftIsPositive && rightIsPositive) return leftTabIndex - rightTabIndex || left.composedIndex - right.composedIndex;
        if (leftIsPositive !== rightIsPositive) return leftIsPositive ? -1 : 1;
        return left.composedIndex - right.composedIndex;
      })
      .map(({ element }) => element);
  }

  private collectComposedTabStopCandidates(
    root: ParentNode,
    excludedByAncestor: boolean,
    candidates: { element: HTMLElement; composedIndex: number }[],
  ): void {
    this.collectComposedTabStopElements(root.children, excludedByAncestor, candidates);
  }

  private collectComposedTabStopElements(
    elements: Iterable<Element>,
    excludedByAncestor: boolean,
    candidates: { element: HTMLElement; composedIndex: number }[],
  ): void {
    for (const element of elements) {
      const excluded = excludedByAncestor || element.matches("[hidden], [inert]");
      if (
        element instanceof HTMLElement
        && !excluded
        && element.matches(sequentialTabStopSelector)
        && element.tabIndex >= 0
        && !element.matches(":disabled")
      ) {
        candidates.push({ element, composedIndex: candidates.length });
      }

      if (element instanceof HTMLSlotElement) {
        const assigned = element.assignedElements({ flatten: true });
        this.collectComposedTabStopElements(assigned.length === 0 ? [...element.children] : assigned, excluded, candidates);
        continue;
      }

      // An open root is the browser-visible boundary for plugin controls.
      // A closed root is intentionally opaque: its active descendant cannot
      // be observed or included in a dialog-owned focus loop.
      this.collectComposedTabStopCandidates(element.shadowRoot ?? element, excluded, candidates);
    }
  }

  private renderFailure(): TemplateResult {
    return html`<p class="plugin-activity-render-failure">This plugin activity could not be rendered.</p>`;
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 60; display: block; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    * { box-sizing: border-box; }
    .plugin-activity-backdrop { width: 100%; height: 100dvh; display: grid; place-items: center; padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); background: var(--pi-overlay); overflow: hidden; }
    .plugin-activity-frame { width: min(1040px, 100%); height: min(780px, 100%); min-width: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; border: 1px solid var(--pi-border); border-radius: 12px; background: var(--pi-bg); box-shadow: 0 20px 64px var(--pi-shadow-strong); }
    header { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--pi-border); }
    .plugin-activity-icon { flex: 0 0 auto; display: grid; place-items: center; color: var(--pi-muted); }
    .plugin-activity-icon > svg { width: 24px; height: 24px; }
    h2, p { margin: 0; }
    h2 { min-width: 0; flex: 1 1 auto; font-size: 20px; line-height: 1.25; overflow-wrap: anywhere; }
    .plugin-activity-close { flex: 0 0 auto; display: grid; place-items: center; width: 36px; height: 36px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-muted); padding: 0; font: inherit; font-size: 20px; line-height: 1; cursor: pointer; }
    .plugin-activity-close:hover { background: var(--pi-surface-hover); color: var(--pi-text); }
    .plugin-activity-close:focus-visible, .plugin-activity-body :focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .plugin-activity-body { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 16px; }
    .plugin-activity-render-failure { border: 1px solid var(--pi-danger); border-radius: 8px; background: var(--pi-surface); color: var(--pi-muted); padding: 14px; }

    @media (max-width: 760px) {
      .plugin-activity-backdrop { padding: 0; }
      .plugin-activity-frame { width: 100%; height: 100%; border: 0; border-radius: 0; }
      header, .plugin-activity-body { padding-inline: max(12px, env(safe-area-inset-left)) max(12px, env(safe-area-inset-right)); }
      header { padding-top: max(12px, env(safe-area-inset-top)); }
      .plugin-activity-body { padding-bottom: max(12px, env(safe-area-inset-bottom)); }
    }
  `;
}
