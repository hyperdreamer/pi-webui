import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  MODEL_TIERS,
  type ModelTier,
  type ModelTierSettingsResponse,
} from "../../../shared/apiTypes";
import { actionMenuPanelStyle, isClickWithinActionMenu } from "./actionMenu";
import { describeSelection, TIER_LABELS } from "./modelPolicyLabels";

/** Anchored composer menu for selecting one of the six model tiers. */
@customElement("session-tier-menu")
export class SessionTierMenu extends LitElement {
  @property({ attribute: false }) catalog?: ModelTierSettingsResponse;
  @property() selectedTier?: ModelTier;
  @property() label = "";
  @property({ type: Boolean }) editable = false;
  @property({ attribute: false }) onSelectTier?: (tier: ModelTier) => void;
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

  override render(): TemplateResult {
    const selectedResolution = this.selectedTier === undefined
      ? undefined
      : this.catalog?.ladder?.[this.selectedTier];
    return html`
      <button
        type="button"
        class="tier-trigger action-menu"
        aria-label=${`Session model tier: ${this.label}`}
        aria-haspopup="menu"
        aria-expanded=${String(this.menuOpen)}
        title=${selectedResolution === undefined
          ? this.label
          : `${this.label} · ${describeSelection(selectedResolution)}`}
        @click=${(event: MouseEvent) => { this.toggleMenu(event.currentTarget); }}
      >
        <span class="tier-trigger-label">${this.label}</span>
        ${selectedResolution === undefined
          ? null
          : html`<span class="tier-trigger-resolution">→ ${describeSelection(selectedResolution)}</span>`}
        <span class="tier-chevron" aria-hidden="true">▾</span>
      </button>
      ${this.menuOpen ? this.renderMenu() : null}
    `;
  }

  private renderMenu(): TemplateResult {
    return html`
      <div
        class="tier-menu action-menu"
        role="menu"
        style=${this.menuStyle}
        @keydown=${(event: KeyboardEvent) => { this.handleMenuKeydown(event); }}
      >
        ${MODEL_TIERS.map((tier) => this.renderTierItem(tier))}
      </div>
    `;
  }

  private renderTierItem(tier: ModelTier): TemplateResult {
    const row = this.catalog?.rows[tier];
    const valid = row?.valid === true;
    const selected = tier === this.selectedTier;
    const resolution = this.catalog?.ladder?.[tier];
    const detail = valid && resolution !== undefined
      ? describeSelection(resolution)
      : row?.reason ?? "Tier options are unavailable";
    return html`
      <button
        type="button"
        class=${`tier-item${valid ? "" : " tier-item-invalid"}`}
        role="menuitemradio"
        data-tier=${tier}
        aria-checked=${String(selected)}
        aria-disabled=${valid ? nothing : "true"}
        @click=${() => { this.selectTier(tier); }}
      >
        <span class="tier-item-label">${TIER_LABELS[tier]}</span>
        <span class=${valid ? "tier-item-resolution" : "tier-item-reason"}>${detail}</span>
        <span class="tier-item-check" aria-hidden="true">${selected ? "✓" : nothing}</span>
      </button>
    `;
  }

  private toggleMenu(target: EventTarget | null): void {
    if (!this.editable) {
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

  private selectTier(tier: ModelTier): void {
    if (!this.editable || this.catalog?.rows[tier].valid !== true) return;
    this.menuOpen = false;
    this.onSelectTier?.(tier);
  }

  private handleMenuKeydown(event: KeyboardEvent): void {
    if (!this.menuOpen || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.menuOpen = false;
    void this.updateComplete.then(() => {
      if (this.isConnected) this.renderRoot.querySelector<HTMLElement>(".tier-trigger")?.focus();
    });
  }

  static override styles = css`
    :host { position: relative; min-width: 0; display: inline-flex; align-items: center; font: inherit; }
    * { box-sizing: border-box; }
    .tier-trigger { min-width: 0; max-width: 100%; overflow: hidden; display: inline-flex; align-items: baseline; gap: 6px; border: 1px solid var(--pi-border); border-radius: 999px; background: var(--pi-surface); color: var(--pi-text); padding: 4px 9px; font: inherit; font-size: 12px; line-height: 1.3; cursor: pointer; }
    .tier-trigger:hover, .tier-trigger:focus-visible { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    .tier-trigger-label { flex: 0 0 auto; font-weight: 600; }
    .tier-trigger-resolution { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pi-muted); }
    .tier-chevron { flex: 0 0 auto; color: var(--pi-muted); }
    .tier-menu { position: fixed; z-index: 10000; width: min(320px, calc(100vw - 16px)); overflow: auto; padding: 4px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); box-shadow: 0 8px 24px var(--pi-shadow); }
    .tier-item { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) 18px; gap: 2px 8px; align-items: center; border: 0; border-radius: 7px; background: transparent; color: var(--pi-text); padding: 7px 8px; font: inherit; text-align: left; cursor: pointer; }
    .tier-item:hover, .tier-item:focus-visible, .tier-item[aria-checked="true"] { background: var(--pi-selection-bg); }
    .tier-item-label { min-width: 0; font-size: 12px; font-weight: 600; line-height: 1.3; }
    .tier-item-resolution, .tier-item-reason { min-width: 0; overflow-wrap: anywhere; font-size: 11px; line-height: 1.3; }
    .tier-item-resolution { color: var(--pi-muted); }
    .tier-item-invalid { cursor: not-allowed; }
    .tier-item-invalid .tier-item-label { color: var(--pi-muted); }
    .tier-item-invalid:hover, .tier-item-invalid:focus-visible { background: transparent; }
    .tier-item-reason { color: var(--pi-danger); }
    .tier-item-check { grid-column: 2; grid-row: 1 / span 2; width: 18px; color: var(--pi-accent); font-weight: 700; text-align: center; }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "session-tier-menu": SessionTierMenu;
  }
}
