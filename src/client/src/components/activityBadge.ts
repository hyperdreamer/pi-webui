import { html, type TemplateResult } from "lit";
import type { SessionActivityIndicator, SessionActivityIndicatorKind } from "../sessionActivity";

export type ActivityIndicatorKind = "terminal" | SessionActivityIndicatorKind;

export function renderActivityIndicator(kind: ActivityIndicatorKind | undefined, label = "Active", count?: number): TemplateResult | undefined {
  if (kind === undefined) return undefined;
  return html`<span class=${`activity-indicator ${kind}`} role="img" aria-label=${label} title=${label}>${count === undefined ? null : html`<span class="activity-indicator-count" aria-hidden="true">${String(count)}</span>`}</span>`;
}

export function renderActionActivityIndicator(kind: ActivityIndicatorKind | undefined, label = "Active"): TemplateResult | undefined {
  const indicator = renderActivityIndicator(kind, label);
  if (indicator === undefined) return undefined;
  return html`<span class="action-activity">${indicator}</span>`;
}

/** Renders a compact, accessible rack when a session has more than one state. */
export function renderActionActivityIndicators(indicators: readonly SessionActivityIndicator[]): TemplateResult | undefined {
  if (indicators.length === 0) return undefined;
  return html`<span class="action-activities">${indicators.map((indicator) => renderActivityIndicator(indicator.kind, indicator.label, indicator.count))}</span>`;
}
