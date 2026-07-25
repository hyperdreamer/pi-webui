import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";

const DESKTOP_RAIL_MEDIA_QUERY = "(min-width: 1181px)";

@customElement("activity-rail")
export class ActivityRail extends LitElement {
  @property({ attribute: false }) onOpenTerminal?: () => void;
  @property({ attribute: false }) onOpenSystemPrompt?: () => void;
  @property({ attribute: false }) onOpenHistory?: () => void;
  @property({ type: Number }) terminalCount = 0;
  @property({ type: Boolean }) systemPromptEnabled = false;
  @property({ type: Boolean }) historyEnabled = false;
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

  private readonly openSystemPrompt = (): void => {
    this.onOpenSystemPrompt?.();
  };

  private readonly openHistory = (): void => {
    this.onOpenHistory?.();
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
          title="Terminal"
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
        <button
          type="button"
          class="icon-button system-prompt-button"
          title="System prompt"
          aria-label="Open system prompt"
          ?disabled=${!this.systemPromptEnabled}
          @click=${this.openSystemPrompt}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
               aria-hidden="true" focusable="false">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="8" y1="13" x2="16" y2="13"/>
            <line x1="8" y1="17" x2="13" y2="17"/>
          </svg>
        </button>
        <button
          type="button"
          class="icon-button history-button"
          title="Full history"
          aria-label="Open full history"
          ?disabled=${!this.historyEnabled}
          @click=${this.openHistory}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
               aria-hidden="true" focusable="false">
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8"/>
            <path d="M3 3v5h5"/>
            <path d="M12 7v5l3 2"/>
          </svg>
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
      gap: 8px;
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
    .icon-button:not(:disabled):hover {
      background: var(--pi-surface-hover);
      color: var(--pi-text);
    }
    .icon-button:disabled { color: var(--pi-dim); cursor: default; opacity: .6; }
    .icon-button:focus-visible {
      outline: 2px solid var(--pi-accent);
      outline-offset: 2px;
    }
  `;
}
