import { LitElement, css, html } from "lit";
import { customElement, query, state } from "lit/decorators.js";

const DESKTOP_RAIL_MEDIA_QUERY = "(min-width: 1181px)";

@customElement("activity-rail")
export class ActivityRail extends LitElement {
  @state() private popupOpen = false;
  @query("#placeholder-icon") private iconButton?: HTMLButtonElement;
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

  private onDesktopMediaChange = (event: MediaQueryListEvent) => {
    if (!event.matches && this.popupOpen) {
      this.closePopup();
    }
  };

  private readonly openPopup = (): void => {
    this.popupOpen = true;
    // Focus the close button after render
    void this.updateComplete.then(() => {
      const closeButton = this.shadowRoot?.querySelector<HTMLButtonElement>(".popup-close-button");
      closeButton?.focus();
    });
  };

  private readonly closePopup = (): void => {
    this.popupOpen = false;
    // Return focus to the icon button after render
    void this.updateComplete.then(() => {
      this.iconButton?.focus();
    });
  };

  private readonly onBackdropClick = (event: MouseEvent): void => {
    // Only close when clicking the backdrop, not the popup content
    if (event.target === event.currentTarget) {
      this.closePopup();
    }
  };

  private readonly onPopupKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      this.closePopup();
    }
  };

  override render() {
    const isDesktop = this.desktopMedia?.matches ?? true;
    if (!isDesktop) return html``;

    return html`
      <nav class="rail" aria-label="Activity rail">
        <button
          id="placeholder-icon"
          type="button"
          class="icon-button"
          aria-label="Open mystery tool"
          @click=${this.openPopup}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
               aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="10"/>
            <path d="M8 12h8"/>
            <path d="M12 8v8"/>
          </svg>
        </button>
      </nav>
      ${this.popupOpen ? html`
        <div
          class="backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="popup-title"
          @click=${this.onBackdropClick}
          @keydown=${this.onPopupKeyDown}
        >
          <div class="popup">
            <h2 id="popup-title">Achievement unlocked</h2>
            <p>You clicked the placeholder. The placeholder is very proud of you.</p>
            <button
              type="button"
              class="popup-close-button"
              @click=${this.closePopup}
            >Return to productivity</button>
          </div>
        </div>
      ` : null}
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
    .icon-button:hover {
      background: var(--pi-surface-hover);
      color: var(--pi-text);
    }
    .icon-button:focus-visible {
      outline: 2px solid var(--pi-accent);
      outline-offset: 2px;
    }
    /* Popup overlay */
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 100;
      display: grid;
      place-items: center;
      background: rgba(0, 0, 0, 0.45);
      padding: 20px;
      box-sizing: border-box;
    }
    .popup {
      box-sizing: border-box;
      width: min(calc(100vw - 32px), 360px);
      padding: 24px;
      border: 1px solid var(--pi-border);
      border-radius: 12px;
      background: var(--pi-bg);
      box-shadow: 0 12px 40px var(--pi-shadow-strong);
      color: var(--pi-text);
      font: 14px system-ui, sans-serif;
      text-align: center;
    }
    .popup h2 {
      margin: 0 0 12px;
      color: var(--pi-text-bright);
      font-size: 18px;
      line-height: 1.3;
    }
    .popup p {
      margin: 0 0 20px;
      color: var(--pi-muted);
      line-height: 1.45;
    }
    .popup-close-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--pi-border);
      border-radius: 8px;
      background: var(--pi-surface);
      color: var(--pi-text);
      padding: 8px 18px;
      font: inherit;
      cursor: pointer;
    }
    .popup-close-button:hover {
      background: var(--pi-surface-hover);
    }
    .popup-close-button:focus-visible {
      outline: 2px solid var(--pi-accent);
      outline-offset: 2px;
    }
  `;
}
