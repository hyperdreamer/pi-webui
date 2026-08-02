import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  type ClientSessionModelPolicyStatus,
  type ModelTierSettingsResponse,
} from "../../../shared/apiTypes";
import { actionMenuPanelStyle, isClickWithinActionMenu } from "./actionMenu";
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
  @property({ attribute: false }) onSelectMode?: (mode: "exact" | "tiered") => void;
  @state() private menuOpen = false;
  @state() private menuStyle = "";

  private readonly onDocumentClick = (event: Event): void => {
    if (!this.menuOpen || isClickWithinActionMenu(event, this.renderRoot)) return;
    this.menuOpen = false;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this.onDocumentClick, true);
  }

  override disconnectedCallback(): void {
    document.removeEventListener("click", this.onDocumentClick, true);
    super.disconnectedCallback();
  }

  override render(): TemplateResult | typeof nothing {
    const policyStatus = this.effectiveStatus();
    if (policyStatus === undefined) return nothing;
    const modeLabel = policyStatus.mode === "tiered" ? "Tiered" : "Exact";
    const compactDiagnostic = this.compactDiagnostic(policyStatus);
    return html`
      <button
        type="button"
        class="policy-trigger action-menu"
        aria-label=${`Session model mode: ${modeLabel}`}
        aria-haspopup="menu"
        aria-expanded=${String(this.menuOpen)}
        title=${triggerTitle(policyStatus, modeLabel)}
        @click=${(event: MouseEvent) => { this.toggleModeMenu(event.currentTarget); }}
      >
        <span class="policy-mode">${modeLabel}</span>
        <span class="policy-chevron" aria-hidden="true">▾</span>
      </button>
      ${this.menuOpen ? this.renderModeMenu(policyStatus.mode) : null}
      ${compactDiagnostic === undefined ? null : html`<span class="policy-diagnostic" title=${compactDiagnostic}>${compactDiagnostic}</span>`}
    `;
  }

  private renderModeMenu(currentMode: "exact" | "tiered"): TemplateResult {
    return html`
      <div
        class="policy-mode-menu action-menu"
        role="menu"
        style=${this.menuStyle}
        @keydown=${(event: KeyboardEvent) => { this.handleMenuKeydown(event); }}
      >
        ${this.renderModeItem("exact", "Exact model", "Choose a model and thinking level", currentMode)}
        ${this.renderModeItem("tiered", "Tiered", "Use a configured model tier", currentMode)}
      </div>
    `;
  }

  private renderModeItem(
    mode: "exact" | "tiered",
    label: string,
    hint: string,
    currentMode: "exact" | "tiered",
  ): TemplateResult {
    const selected = mode === currentMode;
    return html`
      <button
        type="button"
        class="policy-mode-item"
        role="menuitemradio"
        aria-checked=${String(selected)}
        @click=${() => { this.selectMode(mode); }}
      >
        <span class="policy-mode-item-label">${label}</span>
        <span class="policy-mode-hint">${hint}</span>
        <span class="policy-mode-check" aria-hidden="true">${selected ? "✓" : nothing}</span>
      </button>
    `;
  }

  private toggleModeMenu(target: EventTarget | null): void {
    if (!this.canMutate()) {
      this.menuOpen = false;
      return;
    }
    if (this.menuOpen) {
      this.menuOpen = false;
      return;
    }
    this.menuStyle = actionMenuPanelStyle(target, { constrainTo: "viewport" });
    this.menuOpen = true;
  }

  private selectMode(mode: "exact" | "tiered"): void {
    if (!this.canMutate()) {
      this.menuOpen = false;
      return;
    }
    this.menuOpen = false;
    this.onSelectMode?.(mode);
  }

  private handleMenuKeydown(event: KeyboardEvent): void {
    if (!this.menuOpen || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.menuOpen = false;
    void this.updateComplete.then(() => {
      if (this.isConnected) this.renderRoot.querySelector<HTMLElement>(".policy-trigger")?.focus();
    });
  }

  /**
   * The compact row has little space, so it shows only the most urgent problem:
   * a live runtime/entry block, an invalid Tiered ladder, or a non-blocking
   * persistence warning, in that order.
   */
  private compactDiagnostic(policyStatus: ClientSessionModelPolicyStatus): string | undefined {
    const blockedReason = this.blockedReason();
    if (blockedReason !== undefined) return blockedReason;
    if (policyStatus.mode === "tiered" && !policyStatus.ladderValid) return LADDER_INVALID_MESSAGE;
    const error = this.error.trim();
    return error === "" ? undefined : error;
  }

  private effectiveStatus(): ClientSessionModelPolicyStatus | undefined {
    return this.status;
  }

  private blockedReason(): string | undefined {
    const reason = this.effectiveStatus()?.blockedReason;
    return reason === undefined || reason.trim() === "" ? undefined : reason;
  }

  private canMutate(): boolean {
    return this.editable && !this.loading && !this.saving;
  }

  static override styles = css`
    :host { position: relative; min-width: 0; display: inline-flex; align-items: center; gap: 6px; font: inherit; }
    * { box-sizing: border-box; }
    .policy-trigger { flex: 1 1 auto; min-width: 0; max-width: 100%; overflow: hidden; display: inline-flex; align-items: baseline; gap: 6px; border: 1px solid var(--pi-border); border-radius: 999px; background: var(--pi-surface); color: var(--pi-text); padding: 4px 9px; font: inherit; font-size: 12px; line-height: 1.3; cursor: pointer; }
    .policy-trigger:hover, .policy-trigger:focus-visible { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    .policy-mode { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .policy-chevron { flex: 0 0 auto; color: var(--pi-muted); }
    .policy-mode-menu { position: fixed; z-index: 10000; width: min(240px, calc(100vw - 16px)); overflow: auto; padding: 4px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); box-shadow: 0 8px 24px var(--pi-shadow); }
    .policy-mode-item { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) 18px; gap: 2px 8px; align-items: center; border: 0; border-radius: 7px; background: transparent; color: var(--pi-text); padding: 7px 8px; font: inherit; text-align: left; cursor: pointer; }
    .policy-mode-item:hover, .policy-mode-item:focus-visible { background: var(--pi-selection-bg); }
    .policy-mode-item-label { min-width: 0; font-size: 12px; font-weight: 600; line-height: 1.3; }
    .policy-mode-hint { min-width: 0; color: var(--pi-muted); font-size: 11px; line-height: 1.3; }
    .policy-mode-check { grid-column: 2; grid-row: 1 / span 2; width: 18px; color: var(--pi-accent); font-weight: 700; text-align: center; }
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
