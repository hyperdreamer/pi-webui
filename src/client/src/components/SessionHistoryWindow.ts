import { LitElement, css, html, svg, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SessionInfo } from "../api";
import { resolveAppUrl } from "../appUrl";
import { sessionHistoryPath } from "../api/urls";

@customElement("session-history-window")
export class SessionHistoryWindow extends LitElement {
  @property({ attribute: false }) session: SessionInfo | undefined;
  @property({ type: String }) machineId = "local";
  @property({ attribute: false }) onClose?: () => void;

  override render(): TemplateResult {
    const session = this.session;
    const historyUrl = session === undefined ? undefined : resolveAppUrl(sessionHistoryPath(session, this.machineId));
    const label = session === undefined ? "" : sessionLabel(session);
    return html`
      <div class="backdrop" @mousedown=${(event: MouseEvent) => { if (event.target === event.currentTarget) this.close(); }}>
        <section class="history-window" role="dialog" aria-modal="true" aria-labelledby="session-history-window-title" @mousedown=${(event: MouseEvent) => { event.stopPropagation(); }} @keydown=${(event: KeyboardEvent) => { this.handleKeyDown(event); }}>
          <header>
            <div class="title-block">
              <span class="eyebrow">Session</span>
              <h1 id="session-history-window-title">Full history</h1>
              ${session === undefined ? null : html`<span class="session-label" title=${label}>${label}</span>`}
            </div>
            <button class="icon-button" type="button" title="Close full history" aria-label="Close full history" @click=${() => { this.close(); }}>
              ${closeIcon()}
            </button>
          </header>
          <div class="history-body">
            ${historyUrl === undefined
              ? html`<p class="history-state">Select a persisted session to view its full history.</p>`
              : html`<iframe title=${`Full history for ${label}`} src=${historyUrl} sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>`}
          </div>
          <footer>
            <button type="button" @click=${() => { this.close(); }}>Close</button>
          </footer>
        </section>
      </div>
    `;
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    this.close();
  }

  private close(): void {
    this.onClose?.();
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 60; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    * { box-sizing: border-box; }
    .backdrop { box-sizing: border-box; width: 100%; height: 100dvh; display: grid; place-items: center; padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); background: var(--pi-overlay); overflow: hidden; }
    .history-window { width: min(1440px, 100%); height: min(920px, 100%); display: grid; grid-template-rows: auto minmax(0, 1fr) auto; overflow: hidden; border: 1px solid var(--pi-border); border-radius: 14px; background: var(--pi-bg); box-shadow: 0 20px 60px var(--pi-shadow-strong); }
    header, footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--pi-border); }
    footer { justify-content: flex-end; border-top: 1px solid var(--pi-border); border-bottom: 0; }
    .title-block { min-width: 0; display: grid; gap: 2px; }
    .eyebrow { color: var(--pi-muted); font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
    h1 { margin: 0; font-size: 17px; }
    .session-label { max-width: min(78vw, 780px); overflow: hidden; color: var(--pi-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .history-body { min-height: 0; overflow: hidden; background: var(--pi-bg); }
    iframe { display: block; width: 100%; height: 100%; border: 0; background: var(--pi-bg); }
    .history-state { margin: 0; padding: 16px; color: var(--pi-muted); }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; font: inherit; cursor: pointer; }
    button:hover, button:focus-visible { border-color: var(--pi-accent); }
    button:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    .icon-button { display: inline-grid; place-items: center; width: 32px; height: 32px; padding: 0; color: var(--pi-muted); }
    .icon-button:hover, .icon-button:focus-visible { color: var(--pi-text); }
    .icon-button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
    @media (max-width: 760px) {
      .backdrop { padding: 0; }
      .history-window { width: 100%; height: 100%; border: 0; border-radius: 0; }
      header, footer { padding: 12px; }
      .session-label { max-width: 68vw; }
    }
  `;
}

function sessionLabel(session: SessionInfo): string {
  const name = session.name?.trim();
  if (name !== undefined && name !== "") return name;
  const firstMessage = session.firstMessage.trim();
  return firstMessage === "" ? session.id : firstMessage;
}

function closeIcon() {
  return svg`
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12M18 6 6 18"></path>
    </svg>
  `;
}
