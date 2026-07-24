import { LitElement, css, html, svg, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sessionsApi, type Machine, type SessionInfo } from "../api";

type SessionsApi = Pick<typeof sessionsApi, "systemPrompt">;

@customElement("system-prompt-dialog")
export class SystemPromptDialog extends LitElement {
  @property({ attribute: false }) machine: Machine | undefined;
  @property({ attribute: false }) session: SessionInfo | undefined;
  @property({ attribute: false }) sessionsApi: SessionsApi = sessionsApi;
  @property({ attribute: false }) onClose?: () => void;

  @state() private systemPrompt: string | undefined;
  @state() private loading = true;
  @state() private error = "";

  private loadRequestSequence = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.loadSystemPrompt();
  }

  protected override updated(changed: PropertyValues<this>): void {
    const sessionChanged = changed.has("session") && optionalSessionKey(changed.get("session")) !== optionalSessionKey(this.session);
    const machineChanged = changed.has("machine") && machineId(changed.get("machine")) !== machineId(this.machine);
    if ((sessionChanged || machineChanged) && this.isConnected) void this.loadSystemPrompt();
  }

  override render(): TemplateResult {
    return html`
      <div class="backdrop" @mousedown=${(event: MouseEvent) => { if (event.target === event.currentTarget) this.close(); }}>
        <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="system-prompt-dialog-title" @mousedown=${(event: MouseEvent) => { event.stopPropagation(); }} @keydown=${(event: KeyboardEvent) => { this.handleKeyDown(event); }}>
          <header>
            <div class="title-block">
              <span class="eyebrow">Session</span>
              <h1 id="system-prompt-dialog-title">System prompt</h1>
            </div>
            <button class="icon-button" type="button" title="Close system prompt" aria-label="Close system prompt" @click=${() => { this.close(); }}>
              ${closeIcon()}
            </button>
          </header>
          <div class="prompt-body" aria-live="polite">
            ${this.renderPrompt()}
          </div>
          <footer>
            <button type="button" class="secondary" @click=${() => { this.close(); }}>Close</button>
          </footer>
        </section>
      </div>
    `;
  }

  private renderPrompt(): TemplateResult {
    if (this.loading) return html`<p class="prompt-state">Loading system prompt…</p>`;
    if (this.error !== "") return html`<p class="prompt-state error">${this.error}</p>`;
    if (this.systemPrompt === undefined) return html`<p class="prompt-state">Send a message to load the system prompt</p>`;
    if (this.systemPrompt === "") return html`<p class="prompt-state">System prompt is empty (tools are disabled)</p>`;
    return html`<pre class="system-prompt">${this.systemPrompt}</pre>`;
  }

  private async loadSystemPrompt(): Promise<void> {
    const session = this.session;
    const target = session === undefined ? undefined : systemPromptTarget(machineId(this.machine), session);
    const request = ++this.loadRequestSequence;
    this.loading = true;
    this.error = "";
    this.systemPrompt = undefined;
    if (session === undefined || target === undefined) {
      this.loading = false;
      return;
    }

    try {
      const response = await this.sessionsApi.systemPrompt(session, machineId(this.machine));
      if (!this.isCurrentLoad(request, target)) return;
      this.systemPrompt = response.systemPrompt;
    } catch (error) {
      if (!this.isCurrentLoad(request, target)) return;
      this.error = `Failed to load system prompt: ${errorMessage(error)}`;
    } finally {
      if (this.isCurrentLoad(request, target)) this.loading = false;
    }
  }

  private isCurrentLoad(request: number, target: string): boolean {
    const session = this.session;
    return request === this.loadRequestSequence
      && session !== undefined
      && systemPromptTarget(machineId(this.machine), session) === target;
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
    :host { position: fixed; inset: 0; z-index: 30; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    * { box-sizing: border-box; }
    .backdrop { box-sizing: border-box; width: 100%; height: 100dvh; display: grid; place-items: center; padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left)); background: var(--pi-overlay); overflow: hidden; }
    .dialog { width: min(960px, 100%); max-height: min(760px, 100%); display: grid; grid-template-rows: auto minmax(0, 1fr) auto; border: 1px solid var(--pi-border); border-radius: 14px; background: var(--pi-bg); box-shadow: 0 20px 60px var(--pi-shadow-strong); overflow: hidden; }
    header, footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--pi-border); }
    footer { justify-content: flex-end; border-top: 1px solid var(--pi-border); border-bottom: 0; }
    .title-block { min-width: 0; display: grid; gap: 2px; }
    .eyebrow { color: var(--pi-muted); font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
    h1 { margin: 0; font-size: 17px; }
    .prompt-body { min-height: 0; overflow: auto; background: var(--pi-bg); }
    .system-prompt { min-height: 100%; margin: 0; padding: 12px 16px; color: var(--pi-muted); font: 12px/1.6 var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); white-space: pre-wrap; overflow-wrap: anywhere; }
    .prompt-state { margin: 0; padding: 12px 16px; color: var(--pi-muted); font-size: 12px; font-style: italic; }
    .prompt-state.error { color: var(--pi-danger); }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; font: inherit; cursor: pointer; }
    button:hover, button:focus-visible { border-color: var(--pi-accent); }
    button:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    .icon-button { display: inline-grid; place-items: center; width: 32px; height: 32px; padding: 0; color: var(--pi-muted); }
    .icon-button:hover, .icon-button:focus-visible { color: var(--pi-text); }
    .icon-button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
    @media (max-width: 620px) {
      .backdrop { padding: 12px; }
      .dialog { max-height: 100%; border-radius: 10px; }
      header, footer { padding: 12px; }
      .system-prompt, .prompt-state { padding: 12px; }
    }
  `;
}

function machineId(machine: Machine | undefined): string {
  return machine?.id ?? "local";
}

function optionalSessionKey(session: SessionInfo | undefined): string | undefined {
  return session === undefined ? undefined : sessionKey(session);
}

function sessionKey(session: SessionInfo): string {
  return JSON.stringify([session.id, session.cwd]);
}

function systemPromptTarget(targetMachineId: string, session: SessionInfo): string {
  return JSON.stringify([targetMachineId, session.id, session.cwd]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closeIcon() {
  return svg`
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12M18 6 6 18"></path>
    </svg>
  `;
}
