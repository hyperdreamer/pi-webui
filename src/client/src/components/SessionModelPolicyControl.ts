import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  type ClientSessionModelPolicyStatus,
  type ModelTierSettingsResponse,
} from "../../../shared/apiTypes";
import { describeSelection, TIER_LABELS } from "./modelPolicyLabels";

const LADDER_INVALID_MESSAGE = "Model tier ladder is invalid. Tiered mode stays unavailable until the ladder is fixed in Settings → Model tiers.";

/** Composer trigger and diagnostic projection for a session's model policy. */
@customElement("session-model-policy-control")
export class SessionModelPolicyControl extends LitElement {
  @property({ attribute: false }) status?: ClientSessionModelPolicyStatus;
  @property({ attribute: false }) catalog?: ModelTierSettingsResponse;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) saving = false;
  @property({ type: Boolean }) editable = false;
  @property() error = "";

  override render(): TemplateResult | typeof nothing {
    const policyStatus = this.effectiveStatus();
    if (policyStatus === undefined) return nothing;
    const modeLabel = policyStatus.mode === "tiered" ? "Tiered" : "Exact";
    const tier = policyStatus.tier;
    const compactDiagnostic = this.compactDiagnostic(policyStatus);
    return html`
      <button
        type="button"
        class="policy-trigger"
        aria-label=${`Session model mode: ${modeLabel}`}
        title=${triggerTitle(policyStatus, modeLabel)}
      >
        <span class="policy-mode">${modeLabel}</span>
        ${policyStatus.mode === "tiered" && tier !== undefined ? html`<span class="policy-tier">${TIER_LABELS[tier]}</span>` : null}
        ${policyStatus.mode === "tiered" ? html`<span class="policy-resolution">→ ${describeSelection(policyStatus.resolved)}</span>` : null}
      </button>
      ${compactDiagnostic === undefined ? null : html`<span class="policy-diagnostic" title=${compactDiagnostic}>${compactDiagnostic}</span>`}
    `;
  }

  /**
   * The compact row has little space, so it shows only the most urgent problem:
   * a live runtime/entry block, or (for a Tiered session, whose active policy it
   * breaks) an invalid ladder.
   */
  private compactDiagnostic(policyStatus: ClientSessionModelPolicyStatus): string | undefined {
    const blockedReason = this.blockedReason();
    if (blockedReason !== undefined) return blockedReason;
    if (policyStatus.mode === "tiered" && !policyStatus.ladderValid) return LADDER_INVALID_MESSAGE;
    return undefined;
  }

  private effectiveStatus(): ClientSessionModelPolicyStatus | undefined {
    return this.status;
  }

  private blockedReason(): string | undefined {
    const reason = this.effectiveStatus()?.blockedReason;
    return reason === undefined || reason.trim() === "" ? undefined : reason;
  }

  static override styles = css`
    :host { position: relative; min-width: 0; display: inline-flex; align-items: center; gap: 6px; font: inherit; }
    * { box-sizing: border-box; }
    .policy-trigger { flex: 1 1 auto; min-width: 0; max-width: 100%; overflow: hidden; display: inline-flex; align-items: baseline; gap: 6px; border: 1px solid var(--pi-border); border-radius: 999px; background: var(--pi-surface); color: var(--pi-text); padding: 4px 9px; font: inherit; font-size: 12px; line-height: 1.3; cursor: pointer; }
    .policy-trigger:hover, .policy-trigger:focus-visible { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    .policy-mode { font-weight: 600; }
    .policy-tier, .policy-resolution { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pi-muted); }
    .policy-diagnostic { min-width: 0; max-width: 22ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pi-danger); font-size: 11px; }
  `;
}

function triggerTitle(policyStatus: ClientSessionModelPolicyStatus, modeLabel: string): string {
  const tier = policyStatus.tier;
  const tierPart = policyStatus.mode === "tiered" && tier !== undefined ? ` · ${TIER_LABELS[tier]}` : "";
  return `Session model mode: ${modeLabel}${tierPart} · ${describeSelection(policyStatus.resolved)}`;
}

declare global {
  interface HTMLElementTagNameMap {
    "session-model-policy-control": SessionModelPolicyControl;
  }
}
