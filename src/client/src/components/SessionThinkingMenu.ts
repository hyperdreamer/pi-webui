import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { actionMenuPanelStyle, isClickWithinActionMenu } from "./actionMenu";
import type { ThinkingLevelOption } from "./thinkingLevelOptions";

/** Anchored composer menu for selecting a model-supported thinking level. */
@customElement("session-thinking-menu")
export class SessionThinkingMenu extends LitElement {
  @property({ attribute: false }) options: ThinkingLevelOption[] = [];
  @property() label = "";
  @property({ type: Boolean }) editable = false;
  @property({ attribute: false }) onSelectLevel?: (level: string) => void;
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
    return html`
      <button
        type="button"
        class="thinking-trigger action-menu"
        aria-label=${`Session thinking level: ${this.label}`}
        aria-haspopup="menu"
        aria-expanded=${String(this.menuOpen)}
        title=${this.label}
        @click=${(event: MouseEvent) => { this.toggleMenu(event.currentTarget); }}
      >
        <span class="thinking-trigger-label">${this.label}</span>
        <span class="thinking-chevron" aria-hidden="true">▾</span>
      </button>
      ${this.menuOpen ? this.renderMenu() : null}
    `;
  }

  private renderMenu(): TemplateResult {
    return html`
      <div
        class="thinking-menu action-menu"
        role="menu"
        style=${this.menuStyle}
        @keydown=${(event: KeyboardEvent) => { this.handleMenuKeydown(event); }}
      >
        ${this.options.map((option) => this.renderThinkingItem(option))}
      </div>
    `;
  }

  private renderThinkingItem(option: ThinkingLevelOption): TemplateResult {
    return html`
      <button
        type="button"
        class=${`thinking-item${option.supported ? "" : " thinking-item-unsupported"}`}
        role="menuitemradio"
        data-level=${option.level}
        aria-checked=${String(option.selected)}
        aria-disabled=${option.supported ? nothing : "true"}
        @click=${() => { this.selectLevel(option); }}
      >
        <span class="thinking-item-label">${option.level}</span>
        ${option.description === undefined
          ? null
          : html`<span class="thinking-item-description">${option.description}</span>`}
        ${option.supported
          ? null
          : html`<span class="thinking-item-support">unsupported by this model</span>`}
        <span class="thinking-item-check" aria-hidden="true">${option.selected ? "✓" : nothing}</span>
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

  private selectLevel(option: ThinkingLevelOption): void {
    if (!this.editable || !option.supported) return;
    this.menuOpen = false;
    this.onSelectLevel?.(option.level);
  }

  private handleMenuKeydown(event: KeyboardEvent): void {
    if (!this.menuOpen || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.menuOpen = false;
    void this.updateComplete.then(() => {
      if (this.isConnected) this.renderRoot.querySelector<HTMLElement>(".thinking-trigger")?.focus();
    });
  }

  static override styles = css`
    :host { position: relative; min-width: 0; display: inline-flex; align-items: center; font: inherit; }
    * { box-sizing: border-box; }
    .thinking-trigger { min-width: 0; max-width: 100%; overflow: hidden; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--pi-border); border-radius: 999px; background: var(--pi-surface); color: var(--pi-text); padding: 4px 9px; font: inherit; font-size: 12px; line-height: 1.3; cursor: pointer; }
    .thinking-trigger:hover, .thinking-trigger:focus-visible { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    .thinking-trigger-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .thinking-chevron { flex: 0 0 auto; color: var(--pi-muted); }
    .thinking-menu { position: fixed; z-index: 10000; width: min(280px, calc(100vw - 16px)); overflow: auto; padding: 4px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); box-shadow: 0 8px 24px var(--pi-shadow); }
    .thinking-item { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) 18px; gap: 2px 8px; align-items: center; border: 0; border-radius: 7px; background: transparent; color: var(--pi-text); padding: 7px 8px; font: inherit; text-align: left; cursor: pointer; }
    .thinking-item:hover, .thinking-item:focus-visible, .thinking-item[aria-checked="true"] { background: var(--pi-selection-bg); }
    .thinking-item-label { min-width: 0; overflow-wrap: anywhere; font-size: 12px; font-weight: 600; line-height: 1.3; }
    .thinking-item-description, .thinking-item-support { min-width: 0; overflow-wrap: anywhere; font-size: 11px; line-height: 1.3; color: var(--pi-muted); }
    .thinking-item-unsupported { cursor: not-allowed; opacity: 0.72; }
    .thinking-item-unsupported:hover, .thinking-item-unsupported:focus-visible { background: transparent; }
    .thinking-item-check { grid-column: 2; grid-row: 1 / span 3; width: 18px; color: var(--pi-accent); font-weight: 700; text-align: center; }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "session-thinking-menu": SessionThinkingMenu;
  }
}
