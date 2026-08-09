import { LitElement, css, html, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { RecentProjectEntry } from "../api";

@customElement("closed-recent-project-dialog")
export class ClosedRecentProjectDialog extends LitElement {
  @property({ attribute: false }) entry!: RecentProjectEntry;
  @property({ attribute: false }) onReopen!: (entry: RecentProjectEntry) => Promise<void>;
  @property({ attribute: false }) onRemove!: (entry: RecentProjectEntry) => Promise<void>;
  @property({ attribute: false }) onClose!: () => void;

  @query("dialog") private nativeDialog?: HTMLDialogElement;
  @query(".closed-recent-reopen") private reopenButton?: HTMLButtonElement;
  @state() private busy = false;
  @state() private failure: string | undefined;

  override firstUpdated(): void {
    const dialog = this.nativeDialog;
    if (dialog?.isConnected !== true) return;
    dialog.showModal();
    this.reopenButton?.focus();
  }

  override disconnectedCallback(): void {
    const dialog = this.nativeDialog;
    if (dialog?.open === true) dialog.close();
    super.disconnectedCallback();
  }

  override render(): TemplateResult {
    return html`
      <dialog
        class="closed-recent-backdrop"
        aria-modal="true"
        aria-label=${`Recent project ${this.entry.name}`}
        @cancel=${this.handleCancel}
        @click=${this.handleBackdropClick}
      >
        <section class="closed-recent-frame">
          <h2>${this.entry.name}</h2>
          <p class="closed-recent-path">${this.entry.path}</p>
          <p class="muted">This project is no longer registered in PI WEBUI.</p>
          ${this.failure === undefined ? null : html`<p class="closed-recent-error" role="status">${this.failure}</p>`}
          <div class="closed-recent-actions">
            <button class="closed-recent-reopen" type="button" ?disabled=${this.busy} @click=${() => { void this.run(this.onReopen); }}>Reopen</button>
            <button class="closed-recent-remove" type="button" ?disabled=${this.busy} @click=${() => { void this.run(this.onRemove); }}>Remove from history</button>
            <button class="closed-recent-cancel" type="button" @click=${() => { this.onClose(); }}>Cancel</button>
          </div>
        </section>
      </dialog>
    `;
  }

  private readonly handleCancel = (event: Event): void => {
    event.preventDefault();
    this.onClose();
  };

  private readonly handleBackdropClick = (event: MouseEvent): void => {
    if (event.target === event.currentTarget) this.onClose();
  };

  /**
   * Both actions can fail for reasons the user must see: a missing directory, an
   * unavailable machine, denied access, or a path that was registered again. The
   * dialog therefore stays open on failure and only closes on success.
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
    dialog { border: 0; padding: 0; background: transparent; }
    dialog::backdrop { background: var(--pi-overlay); }
    .closed-recent-frame { width: min(480px, 92vw); display: grid; gap: 12px; padding: 20px; border: 1px solid var(--pi-border); border-radius: 12px; background: var(--pi-bg); box-shadow: 0 20px 64px var(--pi-shadow-strong); }
    h2, p { margin: 0; }
    .closed-recent-path { overflow-wrap: anywhere; color: var(--pi-muted); }
    .closed-recent-error { color: var(--pi-danger); }
    .closed-recent-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    button:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
  `;
}
