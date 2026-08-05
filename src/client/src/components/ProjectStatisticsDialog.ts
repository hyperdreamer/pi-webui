import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
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

  override render() {
    return html`
      <div class="backdrop" @click=${(event: MouseEvent) => { if (event.target === event.currentTarget) this.onClose?.(); }}>
        <section role="dialog" aria-label=${`Statistics for ${this.project?.name ?? "project"}`}>
          <header>
            <div>
              <strong>Project Statistics</strong>
              ${this.project === undefined ? null : html`<small>${this.project.name}</small>`}
            </div>
            <button class="close-button" type="button" title="Close statistics" aria-label="Close statistics" @click=${() => { this.onClose?.(); }}>×</button>
          </header>
          <div class="body">${this.renderBody()}</div>
        </section>
      </div>
    `;
  }

  private renderBody() {
    if (this.errorMessage !== undefined) return html`<p class="usage-error" role="alert">${this.errorMessage}</p>`;
    if (this.report === undefined) return this.renderScanning();
    return this.renderReport(this.report);
  }

  private renderScanning() {
    const count = this.sessionCount;
    return html`
      <div class="usage-scanning">
        <p>${count === undefined ? "Scanning sessions…" : `Scanning ${formatFullNumber(count)} sessions…`}</p>
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
              <td>${formatUsageTokens(row.totals.input)}</td>
              <td>${formatUsageTokens(row.totals.output)}</td>
              <td>${formatUsageTokens(row.totals.cacheRead)}</td>
              <td>${formatUsageTokens(row.totals.cacheWrite)}</td>
              <td>${formatPreciseCost(row.totals.cost)}</td>
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
            <td>${formatUsageTokens(report.total.input)}</td>
            <td>${formatUsageTokens(report.total.output)}</td>
            <td>${formatUsageTokens(report.total.cacheRead)}</td>
            <td>${formatUsageTokens(report.total.cacheWrite)}</td>
            <td>${formatPreciseCost(report.total.cost)}</td>
          </tr>
        </tfoot>
      </table>
    `;
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 40; }
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
    .usage-deleted td { color: var(--pi-muted); }
    .usage-scanning { padding: 24px 0; text-align: center; }
    .usage-error { color: var(--pi-danger, #b3261e); }
    @media (max-width: 760px) {
      .usage-table thead { display: none; }
      .usage-table tr { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; padding: 10px 0; border-top: 1px solid var(--pi-border-muted); }
      .usage-table th, .usage-table td { padding: 0; border-top: 0; }
      .usage-table .usage-source { grid-column: 1 / 2; }
    }
  `;
}
