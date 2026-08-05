import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import type { Project, ProjectUsageResponse, ProjectUsageTotals } from "../../../shared/apiTypes";
import { formatCompactNumber, formatFullNumber, formatPreciseCost } from "../utils/format";

const BUCKET_LABELS = [
  { key: "live", label: "Live workspaces" },
  { key: "retired", label: "Retired worktrees" },
  { key: "archived", label: "Archived" },
] as const;

/**
 * Exact below a million, compact at or above it. Exact digits everywhere would
 * widen the columns past the dialog; compact everywhere would erase meaningful
 * precision in low-usage buckets.
 */
export function formatUsageTokens(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value >= 1_000_000 ? formatCompactNumber(value) : formatFullNumber(value);
}

export function usageBucketRows(report: ProjectUsageResponse): { key: "live" | "retired" | "archived"; label: string; totals: ProjectUsageTotals }[] {
  return BUCKET_LABELS.map((bucket) => ({ key: bucket.key, label: bucket.label, totals: report.buckets[bucket.key] }));
}

@customElement("project-statistics-dialog")
export class ProjectStatisticsDialog extends LitElement {
  @property({ attribute: false }) project?: Project;
  @property({ attribute: false }) report?: ProjectUsageResponse;
  @property({ type: Boolean }) loading = false;
  @property({ attribute: false }) errorMessage?: string;
  @property({ attribute: false }) sessionCount?: number;
  @property({ attribute: false }) onClose?: () => void;
  @query(".close-button") private closeButton?: HTMLButtonElement;

  override firstUpdated(): void {
    this.closeButton?.focus();
  }

  override render() {
    return html`
      <div class="backdrop" @click=${(event: MouseEvent) => { if (event.target === event.currentTarget) this.close(); }}>
        <section
          role="dialog"
          aria-modal="true"
          aria-label=${`Statistics for ${this.project?.name ?? "project"}`}
          tabindex="-1"
          @keydown=${(event: KeyboardEvent) => { this.handleDialogKeyDown(event); }}
        >
          <header>
            <div>
              <strong>Project Statistics</strong>
              ${this.project === undefined ? null : html`<small>${this.project.name}</small>`}
            </div>
            <button class="close-button" type="button" title="Close statistics" aria-label="Close statistics" @click=${() => { this.close(); }}>×</button>
          </header>
          <div class="body">${this.renderBody()}</div>
        </section>
      </div>
    `;
  }

  private close(): void {
    this.onClose?.();
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

  private renderBody() {
    if (this.errorMessage !== undefined) return html`<p class="usage-error" role="alert">${this.errorMessage}</p>`;
    if (this.report !== undefined) return this.renderReport(this.report);
    if (this.loading) return this.renderScanning();
    return html`<p class="usage-empty">Usage data is not available.</p>`;
  }

  private renderScanning() {
    const count = this.sessionCount;
    return html`
      <div class="usage-scanning" role="status" aria-live="polite">
        <p class="usage-scanning-line">
          <span class="usage-spinner" role="progressbar" aria-label="Scanning project sessions"></span>
          <span>${count === undefined ? "Scanning sessions…" : `Scanning ${formatFullNumber(count)} sessions…`}</span>
        </p>
        <p class="usage-hint">First open only. Later opens are near-instant.</p>
      </div>
    `;
  }

  private renderReport(report: ProjectUsageResponse) {
    const rows = usageBucketRows(report);
    return html`
      <div class="usage-headline">
        <span class="usage-cost">${formatPreciseCost(report.total.cost)}</span>
        <span class="usage-summary">${formatFullNumber(report.total.sessionCount)} sessions · ${formatUsageTokens(report.total.cacheRead)} cache read</span>
      </div>
      <table class="usage-table">
        <thead>
          <tr>
            <th scope="col" class="usage-source">Source</th>
            <th scope="col">Input</th>
            <th scope="col">Output</th>
            <th scope="col">Cache read</th>
            <th scope="col">Cache write</th>
            <th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => html`
            <tr>
              <th scope="row" class="usage-source">${row.label} <span class="usage-count">· ${formatFullNumber(row.totals.sessionCount)}</span></th>
              <td class="usage-token-cell usage-input">
                <span class="usage-metric-label" aria-hidden="true">Input</span>
                <span class="usage-metric-value">${formatUsageTokens(row.totals.input)}</span>
              </td>
              <td class="usage-token-cell usage-output">
                <span class="usage-metric-label" aria-hidden="true">Output</span>
                <span class="usage-metric-value">${formatUsageTokens(row.totals.output)}</span>
              </td>
              <td class="usage-token-cell usage-cache-read">
                <span class="usage-metric-label" aria-hidden="true">Cache read</span>
                <span class="usage-metric-value">${formatUsageTokens(row.totals.cacheRead)}</span>
              </td>
              <td class="usage-token-cell usage-cache-write">
                <span class="usage-metric-label" aria-hidden="true">Cache write</span>
                <span class="usage-metric-value">${formatUsageTokens(row.totals.cacheWrite)}</span>
              </td>
              <td class="usage-cost-cell">${formatPreciseCost(row.totals.cost)}</td>
            </tr>
          `)}
          <tr class="usage-deleted">
            <th scope="row" class="usage-source">Deleted</th>
            <td colspan="5">not counted</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" class="usage-source">Total</th>
            <td class="usage-token-cell usage-input">
              <span class="usage-metric-label" aria-hidden="true">Input</span>
              <span class="usage-metric-value">${formatUsageTokens(report.total.input)}</span>
            </td>
            <td class="usage-token-cell usage-output">
              <span class="usage-metric-label" aria-hidden="true">Output</span>
              <span class="usage-metric-value">${formatUsageTokens(report.total.output)}</span>
            </td>
            <td class="usage-token-cell usage-cache-read">
              <span class="usage-metric-label" aria-hidden="true">Cache read</span>
              <span class="usage-metric-value">${formatUsageTokens(report.total.cacheRead)}</span>
            </td>
            <td class="usage-token-cell usage-cache-write">
              <span class="usage-metric-label" aria-hidden="true">Cache write</span>
              <span class="usage-metric-value">${formatUsageTokens(report.total.cacheWrite)}</span>
            </td>
            <td class="usage-cost-cell">${formatPreciseCost(report.total.cost)}</td>
          </tr>
        </tfoot>
      </table>
    `;
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 40; }
    * { box-sizing: border-box; }
    .backdrop { width: 100%; height: 100dvh; display: grid; place-items: center; padding: 16px; background: var(--pi-overlay); }
    section[role="dialog"] { width: min(960px, 100%); max-height: min(760px, 100%); min-width: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; border: 1px solid var(--pi-border); border-radius: 12px; background: var(--pi-bg); }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--pi-border); }
    header small { display: block; color: var(--pi-muted); }
    .close-button { display: grid; place-items: center; width: 36px; height: 36px; padding: 0; border: 0; background: transparent; color: var(--pi-muted); font-size: 20px; line-height: 1; cursor: pointer; }
    .body { overflow: auto; padding: 16px 20px 20px; }
    .usage-headline { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; padding-bottom: 12px; border-bottom: 1px solid var(--pi-border-muted); }
    .usage-cost { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .usage-summary, .usage-hint, .usage-count { color: var(--pi-muted); font-size: 12px; }
    .usage-table { width: 100%; border-collapse: collapse; margin-top: 12px; font-variant-numeric: tabular-nums; }
    .usage-table th, .usage-table td { text-align: right; padding: 9px 0 9px 30px; border-top: 1px solid var(--pi-border-muted); font-weight: inherit; }
    .usage-table thead th { border-top: 0; color: var(--pi-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0; font-weight: 600; }
    .usage-table .usage-source { text-align: left; padding-left: 0; }
    .usage-table tfoot th, .usage-table tfoot td { border-top: 2px solid var(--pi-border); font-weight: 700; }
    .usage-metric-label { display: none; }
    .usage-deleted td { color: var(--pi-muted); }
    .usage-scanning { display: grid; justify-items: center; gap: 6px; padding: 24px 0; text-align: center; }
    .usage-scanning p { margin: 0; }
    .usage-scanning-line { display: flex; align-items: center; gap: 8px; }
    .usage-spinner { width: 18px; height: 18px; flex: 0 0 18px; border: 2px solid var(--pi-border); border-top-color: var(--pi-accent); border-radius: 50%; animation: usage-spinner 800ms linear infinite; }
    .usage-empty { margin: 0; color: var(--pi-muted); }
    .usage-error { color: var(--pi-danger, #b3261e); }
    @keyframes usage-spinner { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .usage-spinner { animation: none; }
    }
    @media (max-width: 760px) {
      .backdrop { padding: 0; }
      section[role="dialog"] { width: 100%; height: 100%; border: 0; border-radius: 0; }
      .usage-table thead { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
      .usage-table tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; padding: 10px 0; border-top: 1px solid var(--pi-border-muted); }
      .usage-table th, .usage-table td { padding: 0; border-top: 0; }
      .usage-table .usage-source { grid-column: 1; grid-row: 1; min-width: 0; }
      .usage-table .usage-cost-cell { grid-column: 2; grid-row: 1; }
      .usage-table .usage-token-cell { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; }
      .usage-table .usage-input { grid-row: 2; }
      .usage-table .usage-output { grid-row: 3; }
      .usage-table .usage-cache-read { grid-row: 4; }
      .usage-table .usage-cache-write { grid-row: 5; }
      .usage-table .usage-metric-label { display: block; color: var(--pi-muted); text-align: left; }
      .usage-table .usage-deleted td { grid-column: 2; grid-row: 1; }
    }
  `;
}
