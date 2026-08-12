import { LitElement, css, html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { RecentProjectEntry } from "../api";

export type RecentProjectDialogView = "closed-actions" | "removal-confirmation";

/**
 * One modal for both Recent Projects entry states. A Closed-row activation opens
 * it in the Closed-actions view; a row-end remove control opens it directly in
 * the removal-confirmation view. Choosing Remove from history transitions in
 * place to the same confirmation, and every Cancel path dismisses the whole
 * modal. Removal affects only the history entry; the registered project
 * collection, sessions, terminals, workspaces, and files are outside its scope.
 */
@customElement("recent-project-dialog")
export class RecentProjectDialog extends LitElement {
  @property({ attribute: false }) entry!: RecentProjectEntry;
  @property({ attribute: false }) initialView: RecentProjectDialogView = "closed-actions";
  @property({ attribute: false }) onReopen!: (entry: RecentProjectEntry) => Promise<void>;
  @property({ attribute: false }) onRemove!: (entry: RecentProjectEntry) => Promise<void>;
  @property({ attribute: false }) onClose!: () => void;

  @query("dialog") private nativeDialog?: HTMLDialogElement;
  @query(".recent-project-reopen") private reopenButton?: HTMLButtonElement;
  @query(".recent-project-cancel") private cancelButton?: HTMLButtonElement;
  @state() private view: RecentProjectDialogView = "closed-actions";
  @state() private busy = false;
  @state() private failure: string | undefined;

  override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("entry") || changed.has("initialView")) {
      this.view = this.initialView;
      this.failure = undefined;
    }
  }

  override firstUpdated(): void {
    const dialog = this.nativeDialog;
    if (dialog?.isConnected !== true) return;
    dialog.showModal();
    if (this.view === "removal-confirmation") this.cancelButton?.focus();
    else this.reopenButton?.focus();
  }

  override disconnectedCallback(): void {
    this.close();
    super.disconnectedCallback();
  }

  close(): void {
    const dialog = this.nativeDialog;
    if (dialog?.open === true) dialog.close();
  }

  override render(): TemplateResult {
    return html`
      <dialog
        class="recent-project-backdrop"
        aria-modal="true"
        aria-labelledby="recent-project-heading"
        aria-busy=${this.busy ? "true" : "false"}
        @cancel=${this.handleCancel}
        @click=${this.handleBackdropClick}
      >
        <section class="recent-project-frame">
          ${this.view === "removal-confirmation" ? this.renderRemovalConfirmation() : this.renderClosedActions()}
        </section>
      </dialog>
    `;
  }

  private renderClosedActions(): TemplateResult {
    return html`
      <h2 id="recent-project-heading">${this.entry.name}</h2>
      <p class="recent-project-path">${this.entry.path}</p>
      <p class="muted">This project is no longer registered in PI WEBUI.</p>
      ${this.renderFailure()}
      <div class="recent-project-actions">
        <button class="recent-project-reopen" type="button" ?disabled=${this.busy} @click=${() => { void this.run(this.onReopen); }}>Reopen</button>
        <button class="recent-project-remove-request" type="button" ?disabled=${this.busy} @click=${this.requestRemoval}>Remove from history</button>
        <button class="recent-project-cancel" type="button" ?disabled=${this.busy} @click=${() => { this.onClose(); }}>Cancel</button>
      </div>
    `;
  }

  private renderRemovalConfirmation(): TemplateResult {
    return html`
      <h2 id="recent-project-heading">Remove from Recent Projects?</h2>
      <p class="recent-project-path">${this.entry.name} — ${this.entry.path}</p>
      <p class="recent-project-effect">Only the Recent Projects entry for this project will be removed. No project files will be deleted, and the project's registration is unaffected. Future meaningful work can add the project to Recent Projects again.</p>
      ${this.renderFailure()}
      <div class="recent-project-actions">
        <button class="recent-project-confirm-remove" type="button" ?disabled=${this.busy} @click=${() => { void this.run(this.onRemove); }}>Remove</button>
        <button class="recent-project-cancel" type="button" ?disabled=${this.busy} @click=${() => { this.onClose(); }}>Cancel</button>
      </div>
    `;
  }

  private renderFailure(): TemplateResult | null {
    if (this.failure === undefined) return null;
    return html`<p class="recent-project-error" role="status">${this.failure}</p>`;
  }

  /** Remove from history only changes the view; it must not mutate anything. */
  private readonly requestRemoval = (): void => {
    this.view = "removal-confirmation";
    this.failure = undefined;
    void this.updateComplete.then(() => { this.cancelButton?.focus(); });
  };

  private readonly handleCancel = (event: Event): void => {
    event.preventDefault();
    if (this.busy) return;
    this.onClose();
  };

  private readonly handleBackdropClick = (event: MouseEvent): void => {
    if (event.target !== event.currentTarget) return;
    if (this.busy) return;
    this.onClose();
  };

  /**
   * Both actions can fail for reasons the user must see: a missing directory, an
   * unavailable machine, or denied access. The dialog therefore stays open on
   * failure and only closes on success.
   */
  private async run(action: (entry: RecentProjectEntry) => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.failure = undefined;
    try {
      await action(this.entry);
      this.onClose();
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 70; display: block; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    dialog { max-width: calc(100vw - 24px); border: 0; padding: 0; background: transparent; }
    dialog::backdrop { background: var(--pi-overlay); }
    .recent-project-frame { box-sizing: border-box; width: min(480px, 92vw); max-width: calc(100vw - 24px); display: grid; gap: 12px; padding: 20px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); box-shadow: 0 20px 64px var(--pi-shadow-strong); }
    h2, p { margin: 0; }
    h2 { font-size: 16px; line-height: 1.3; }
    .recent-project-path { overflow-wrap: anywhere; color: var(--pi-muted); }
    .recent-project-effect { line-height: 1.45; }
    .recent-project-error { color: var(--pi-danger); }
    .recent-project-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    button { border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 12px; font: inherit; cursor: pointer; }
    button:hover:not(:disabled) { border-color: var(--pi-accent-border); background: var(--pi-selection-bg); }
    button:disabled { opacity: 0.55; cursor: wait; }
    button:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .recent-project-confirm-remove { border-color: color-mix(in srgb, var(--pi-danger) 45%, transparent); background: color-mix(in srgb, var(--pi-danger) 14%, transparent); color: var(--pi-danger); }
    .recent-project-confirm-remove:hover:not(:disabled) { border-color: var(--pi-danger); background: color-mix(in srgb, var(--pi-danger) 24%, transparent); }
  `;
}
