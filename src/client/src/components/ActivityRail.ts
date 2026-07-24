import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";

const DESKTOP_RAIL_MEDIA_QUERY = "(min-width: 1181px)";

@customElement("activity-rail")
export class ActivityRail extends LitElement {
  @property({ attribute: false }) onOpenTerminal?: () => void;
  @property({ type: Number }) terminalCount = 0;
  private desktopMedia: MediaQueryList | undefined;

  constructor() {
    super();
    if (typeof window !== "undefined" && "matchMedia" in window) {
      this.desktopMedia = window.matchMedia(DESKTOP_RAIL_MEDIA_QUERY);
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.desktopMedia?.addEventListener("change", this.onDesktopMediaChange);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.desktopMedia?.removeEventListener("change", this.onDesktopMediaChange);
  }

  private onDesktopMediaChange = () => {
    // Media change triggers a re-render; no popup state to clean up.
  };

  private readonly openTerminal = (): void => {
    this.onOpenTerminal?.();
  };

  override render() {
    const isDesktop = this.desktopMedia?.matches ?? true;
    if (!isDesktop) return html``;

    const badge = this.terminalCount > 0 ? this.terminalCount : undefined;
    const badgeLabel = badge === undefined ? "" : `${String(badge)} active terminal${badge === 1 ? "" : "s"}`;
    return html`
      <nav class="rail" aria-label="Activity rail">
        <button
          type="button"
          class="icon-button"
          aria-label=${`Open terminal${badgeLabel === "" ? "" : `, ${badgeLabel}`}` }
          @click=${this.openTerminal}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
               aria-hidden="true" focusable="false">
            <rect x="3" y="5" width="18" height="14" rx="2"/>
            <path d="m7 10 3 3-3 3"/>
            <path d="M12 16h5"/>
          </svg>
          ${badge === undefined ? null : html`<span class="rail-badge" aria-hidden="true">${badge}</span>`}
        </button>
      </nav>
    `;
  }

  static override styles = css`
    :host {
      display: block;
      flex: 0 0 auto;
      min-height: 0;
    }
    .rail {
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 44px;
      height: 100%;
      border-right: 1px solid var(--pi-border);
      background: var(--pi-bg);
      padding-top: 12px;
      box-sizing: border-box;
    }
    .icon-button {
      position: relative;
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      padding: 0;
      border: 1px solid var(--pi-border);
      border-radius: 8px;
      background: var(--pi-surface);
      color: var(--pi-muted);
      cursor: pointer;
    }
    .rail-badge {
      position: absolute;
      top: -3px;
      right: -3px;
      display: inline-block;
      min-width: 14px;
      border: 1px solid var(--pi-success-border);
      border-radius: 999px;
      background: var(--pi-success-surface);
      color: var(--pi-success);
      padding: 0 5px;
      font-size: 11px;
      line-height: 16px;
      text-align: center;
      pointer-events: none;
    }
    .icon-button:hover {
      background: var(--pi-surface-hover);
      color: var(--pi-text);
    }
    .icon-button:focus-visible {
      outline: 2px solid var(--pi-accent);
      outline-offset: 2px;
    }
  `;
}
