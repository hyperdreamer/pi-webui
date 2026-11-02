import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { Machine } from "../api";
import type { SessionListFailure, SessionListLoad, SessionListScope } from "../appState";

/**
 * How long a foreground remote list read stays silent before it explains the
 * wait. A remote that answers quickly never flashes progress chrome in the
 * session section.
 */
export const SESSION_LIST_NOTICE_DELAY_MS = 5_000;
/** How often the displayed elapsed wait is recomputed. */
export const SESSION_LIST_NOTICE_TICK_MS = 1_000;

/**
 * The wait and failure feedback for one remote session-list read.
 *
 * It renders only for a remote machine whose scope still matches the record:
 * a local read has no budget to explain, a catalog fallback owns its own
 * recovery channel, and a record captured for another machine or a superseded
 * scope must not be shown as if it belonged to the current one.
 *
 * The elapsed wait needs a clock of its own. The tick only recomputes elapsed
 * time; it is retired as soon as the read reaches a terminal phase, a failure
 * replaces it, its scope no longer matches, or the notice disconnects. Only a
 * connected notice may own the interval, so a pending update that flushes after
 * `disconnectedCallback` cannot resurrect it.
 */
@customElement("session-list-load-notice")
export class SessionListLoadNotice extends LitElement {
  @property({ attribute: false }) machine: Machine | undefined;
  @property({ attribute: false }) currentScope: SessionListScope | undefined;
  @property({ attribute: false }) load: SessionListLoad | undefined;
  @property({ attribute: false }) failure: SessionListFailure | undefined;
  @property({ attribute: false }) onRetry: ((failure: SessionListFailure) => void | Promise<void>) | undefined;
  @property({ attribute: false }) onRaiseLimit: ((failure: SessionListFailure) => void) | undefined;
  @property({ attribute: false }) now: () => number = Date.now;

  private interval: number | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this.syncClock();
  }

  override disconnectedCallback(): void {
    this.stopClock();
    super.disconnectedCallback();
  }

  protected override updated(): void {
    this.syncClock();
  }

  private syncClock(): void {
    // A pending Lit update can still flush after `disconnectedCallback`, so the
    // connected state is the authority, not just the disconnect hook.
    if (this.isConnected && this.shouldTick()) {
      this.interval ??= window.setInterval(() => { this.requestUpdate(); }, SESSION_LIST_NOTICE_TICK_MS);
      return;
    }
    this.stopClock();
  }

  private stopClock(): void {
    if (this.interval !== undefined) window.clearInterval(this.interval);
    this.interval = undefined;
  }

  /** A waiting read is the only phase with a changing elapsed value to show. */
  private shouldTick(): boolean {
    const machine = this.machine;
    const load = this.load;
    if (machine?.kind !== "remote" || load === undefined) return false;
    return this.matchesCurrentScope(load.scope)
      && load.owner !== "catalog-fallback"
      && load.phase === "waiting"
      && this.failure === undefined;
  }

  protected override render(): TemplateResult | typeof nothing {
    const machine = this.machine;
    if (machine?.kind !== "remote") return nothing;
    const failure = this.failure;
    if (failure !== undefined) return this.renderFailure(failure);
    const load = this.load;
    if (load === undefined || !this.matchesCurrentScope(load.scope) || load.owner === "catalog-fallback") return nothing;
    if (load.phase === "receiving") {
      return html`<div class="session-list-load-notice receiving" role="status">Receiving sessions from ${machine.name}…</div>`;
    }
    const elapsedMs = Math.max(0, this.now() - load.startedAt);
    if (elapsedMs < SESSION_LIST_NOTICE_DELAY_MS) return nothing;
    return html`<div class="session-list-load-notice waiting" role="status">Loading sessions from ${machine.name}… ${formatElapsed(elapsedMs)} of ${formatElapsed(load.budgetMs)}</div>`;
  }

  private renderFailure(failure: SessionListFailure): TemplateResult | typeof nothing {
    if (!this.matchesCurrentScope(failure.scope)) return nothing;
    const machineName = failure.scope.machineName;
    const waited = `Waited ${formatElapsed(failure.elapsedMs)}.`;
    const message = failure.kind === "timeout"
      ? `${machineName} didn't answer within ${formatElapsed(failure.budgetMs)}. ${waited}`
      : `${machineName} stopped responding while sending sessions. ${waited}`;
    return html`
      <div class="session-list-load-notice failure" role="alert">
        <span>${message}</span>
        <div class="session-list-load-actions">
          <button type="button" @click=${() => { void this.onRetry?.(failure); }}>Try again</button>
          <button type="button" @click=${() => { this.onRaiseLimit?.(failure); }}>Raise limit</button>
        </div>
      </div>
    `;
  }

  private matchesCurrentScope(scope: SessionListScope): boolean {
    const machine = this.machine;
    const currentScope = this.currentScope;
    if (machine?.kind !== "remote" || currentScope?.machineId !== machine.id) return false;
    return scope.machineId === machine.id
      && scope.projectId === currentScope.projectId
      && scope.projectPath === currentScope.projectPath
      && scope.workspaceId === currentScope.workspaceId
      && scope.workspacePath === currentScope.workspacePath;
  }

  static override styles = css`
    :host { display: block; }
    .session-list-load-notice { box-sizing: border-box; margin: 0 0 6px; border: 1px solid var(--pi-border-muted); border-radius: 8px; background: color-mix(in srgb, var(--pi-surface) 70%, transparent); padding: 6px 8px; color: var(--pi-muted); font-size: 12px; }
    .session-list-load-notice.waiting { border-style: dashed; }
    .session-list-load-notice.failure { border-color: color-mix(in srgb, var(--pi-danger) 55%, var(--pi-border)); color: var(--pi-danger); }
    .session-list-load-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
    .session-list-load-actions button { padding: 4px 8px; font-size: 12px; }
  `;
}

/** Whole seconds as unpadded minutes and two-digit seconds: `0:05`, `2:00`. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  return `${String(Math.floor(totalSeconds / 60))}:${String(totalSeconds % 60).padStart(2, "0")}`;
}
