import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  notificationDismissLabel,
  notificationInboxOverflowLabel,
  notificationInboxTotalCount,
  notificationMessageTruncationLabel,
  notificationSeverityLabel,
  notificationTargetsEqual,
  notificationTrayHeading,
  type SelectedSessionNotificationView,
  type SessionNotificationTarget,
} from "../sessionNotifications";
import type { NotificationPresentation } from "../notificationPresentation";

const notificationTimestampFormatter = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

export type NotificationSurfaceFocusDestination = "heading" | "equivalent-control" | "trigger";
export interface NotificationSurfaceControl {
  role: "dismiss" | "clear-all" | "retry" | "close";
  notificationId?: string;
}

export interface NotificationSurfaceFocusIntent {
  token: number;
  surfaceGeneration: number;
  selectionGeneration: number;
  target: SessionNotificationTarget;
  destination: NotificationSurfaceFocusDestination;
  control?: NotificationSurfaceControl;
}

@customElement("session-notification-tray")
export class SessionNotificationTray extends LitElement {
  @property({ attribute: false }) presentation: NotificationPresentation = { kind: "ineligible" };
  @property() sessionTitle = "Selected session";
  @property() errorMessage: string | undefined;
  @property({ type: String }) mode: "flyout" | "sheet" = "flyout";
  @property({ type: Boolean }) open = false;
  @property({ attribute: false }) focusIntent: NotificationSurfaceFocusIntent | undefined;
  @property({ attribute: false }) onValidateFocusIntent?: (intent: NotificationSurfaceFocusIntent) => boolean;
  @property({ attribute: false }) onDismiss?: (notificationId: string) => void;
  @property({ attribute: false }) onDismissAll?: () => void;
  @property({ attribute: false }) onRetry?: () => void;
  @property({ attribute: false }) onClose?: () => void;

  private focusedBeforePresentationUpdate: NotificationSurfaceControl | undefined;
  private focusedTargetBeforePresentationUpdate: SessionNotificationTarget | undefined;

  protected override willUpdate(changed: PropertyValues<this>): void {
    this.focusedBeforePresentationUpdate = changed.has("presentation") && this.open ? this.focusedControl() : undefined;
    const previousPresentation = changed.get("presentation");
    this.focusedTargetBeforePresentationUpdate = previousPresentation !== undefined && previousPresentation.kind !== "ineligible"
      ? previousPresentation.target
      : undefined;
  }

  protected override updated(changed: PropertyValues<this>): void {
    this.id = "session-notification-surface";
    this.setAttribute("role", this.mode === "sheet" ? "dialog" : "region");
    if (this.mode === "sheet" && this.open) this.setAttribute("aria-modal", "true");
    else this.removeAttribute("aria-modal");
    const heading = this.renderRoot.querySelector<HTMLElement>("[data-notification-focus='heading']");
    const headingText = heading === null ? "" : heading.textContent.trim();
    this.setAttribute("aria-label", headingText === "" ? `Notifications for ${this.sessionTitle}` : headingText);
    Reflect.set(this, "ariaLabelledByElements", heading === null ? null : [heading]);
    const priorControl = this.focusedBeforePresentationUpdate;
    const priorTarget = this.focusedTargetBeforePresentationUpdate;
    this.focusedBeforePresentationUpdate = undefined;
    this.focusedTargetBeforePresentationUpdate = undefined;
    const targetChanged = priorTarget === undefined || this.presentation.kind === "ineligible"
      || !notificationTargetsEqual(priorTarget, this.presentation.target);
    const intent = changed.has("focusIntent") ? this.focusIntent : undefined;
    const intentIsCurrent = this.open && intent !== undefined && this.onValidateFocusIntent?.(intent) !== false;
    if (priorControl !== undefined && this.open && (targetChanged || this.controlElement(priorControl) === undefined)) {
      const destination = intentIsCurrent ? this.focusIntentTarget() : undefined;
      (destination ?? heading)?.focus();
      return;
    }
    if (!intentIsCurrent) return;
    (this.focusIntentTarget() ?? heading)?.focus();
  }

  override render() {
    const view = this.presentation.kind === "fresh" ? this.presentation.view : undefined;
    const total = view === undefined ? undefined : notificationInboxTotalCount(view);
    return html`
      <div class="notification-tray" data-mode=${this.mode} @keydown=${this.handleKeyDown}>
        <header class="notification-header">
          <h2 class="notification-heading" id="session-notifications-heading" data-notification-focus="heading" tabindex="-1">${this.heading(view, total)}</h2>
          <div class="notification-header-actions">
            ${view === undefined ? nothing : html`
              <button
                type="button"
                class="notification-control notification-clear"
                data-notification-control="clear-all"
                aria-label="Clear all notifications"
                title="Clear all notifications"
                ?disabled=${view.dismissAllPending || total === 0 || this.onDismissAll === undefined}
                @click=${() => { this.onDismissAll?.(); }}
              >Clear all</button>
            `}
            <button type="button" class="notification-control notification-close" data-notification-control="close" aria-label="Close notifications" title="Close notifications" @click=${() => { this.onClose?.(); }}>×</button>
          </div>
        </header>
        ${this.errorMessage === undefined || this.errorMessage === "" ? nothing : html`<p class="notification-error" role="alert">${this.errorMessage}</p>`}
        ${this.renderPresentation(view)}
      </div>
    `;
  }

  private heading(view: SelectedSessionNotificationView | undefined, total: number | undefined): string {
    if (view === undefined || total === undefined) return `Notifications for ${this.sessionTitle}`;
    return `${notificationTrayHeading(view)} for ${this.sessionTitle}`;
  }

  private renderPresentation(view: SelectedSessionNotificationView | undefined) {
    switch (this.presentation.kind) {
      case "ineligible":
        return html`<p class="notification-state">Select an active session to view notifications.</p>`;
      case "offline":
        return this.renderState("Notifications are unavailable while this machine is offline.", true);
      case "capability-unavailable":
        return this.renderState(this.presentation.operation === "checking-capability" ? "Checking notification support…" : "Notification support is unavailable.", this.presentation.operation !== "checking-capability");
      case "unsupported":
        return html`<p class="notification-state">This runtime does not support session notifications.</p>`;
      case "loading":
        return html`<p class="notification-state" role="status">Loading notifications…</p>`;
      case "unavailable":
        return this.renderState("Notifications are currently unavailable.", true);
      case "fresh":
        return this.renderFresh(view ?? this.presentation.view);
    }
  }

  private renderState(message: string, retry: boolean) {
    return html`
      <div class="notification-state-block">
        <p class="notification-state">${message}</p>
        ${retry ? html`<button type="button" class="notification-control notification-retry" data-notification-control="retry" @click=${() => { this.onRetry?.(); }}>Retry</button>` : nothing}
      </div>
    `;
  }

  private renderFresh(view: SelectedSessionNotificationView) {
    return html`
      <div class="notification-list" role="list">
        ${view.discardedCount === 0 ? nothing : html`<p class="notification-overflow">${notificationInboxOverflowLabel(view.discardedCount)}</p>`}
        ${view.notifications.length === 0 ? html`<p class="notification-empty">No notifications.</p>` : view.notifications.map((notification) => {
          const truncationLabel = notificationMessageTruncationLabel(notification);
          const disabled = view.pendingDismissedIds.has(notification.id) || view.dismissAllPending || this.onDismiss === undefined;
          return html`
            <article class=${`notification-row ${notification.severity}`} data-notification-id=${notification.id} role="listitem">
              <div class="notification-metadata">
                <strong class="notification-severity">${notificationSeverityLabel(notification.severity)}</strong>
                <span aria-hidden="true">·</span>
                <time datetime=${notification.receivedAt}>${notificationTimestampFormatter.format(new Date(notification.receivedAt))}</time>
              </div>
              <p class="notification-message" dir="auto">${notification.message}</p>
              ${truncationLabel === undefined ? nothing : html`<p class="notification-truncated">${truncationLabel}</p>`}
              <button
                type="button"
                class="notification-row-dismiss"
                data-notification-control="dismiss"
                data-notification-id=${notification.id}
                aria-label=${notificationDismissLabel(notification)}
                title="Dismiss notification"
                ?disabled=${disabled}
                @click=${() => { this.onDismiss?.(notification.id); }}
              >×</button>
            </article>
          `;
        })}
      </div>
    `;
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (this.mode !== "sheet" || event.key !== "Tab") return;
    const controls = Array.from(this.renderRoot.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"))
      .filter((control) => control.isConnected && control.getAttribute("aria-hidden") !== "true");
    const heading = this.renderRoot.querySelector<HTMLElement>("[data-notification-focus='heading']");
    if (controls.length === 0) {
      event.preventDefault();
      heading?.focus();
      return;
    }
    const active = this.shadowRoot?.activeElement;
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && (active === first || active === heading)) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first?.focus();
    } else if (active === heading && !event.shiftKey) {
      event.preventDefault();
      first?.focus();
    }
  };

  focusedControl(): NotificationSurfaceControl | undefined {
    const active = this.shadowRoot?.activeElement;
    if (!(active instanceof HTMLElement)) return undefined;
    const role = active.dataset["notificationControl"];
    if (role === "dismiss") {
      const notificationId = active.dataset["notificationId"];
      return notificationId === undefined ? undefined : { role, notificationId };
    }
    if (role === "clear-all" || role === "retry" || role === "close") return { role };
    return undefined;
  }

  private controlElement(control: NotificationSurfaceControl): HTMLButtonElement | undefined {
    if (control.role === "dismiss" && control.notificationId !== undefined) {
      const target = this.renderRoot.querySelector<HTMLButtonElement>(`button[data-notification-control='dismiss'][data-notification-id="${cssEscape(control.notificationId)}"]`);
      return target?.isConnected === true && !target.disabled ? target : undefined;
    }
    if (control.role === "clear-all") {
      const target = this.renderRoot.querySelector<HTMLButtonElement>("button.notification-clear");
      return target?.isConnected === true && !target.disabled ? target : undefined;
    }
    if (control.role === "retry") {
      const target = this.renderRoot.querySelector<HTMLButtonElement>("button.notification-retry");
      return target?.isConnected === true && !target.disabled ? target : undefined;
    }
    const target = this.renderRoot.querySelector<HTMLButtonElement>("button.notification-close");
    return target?.isConnected === true && !target.disabled ? target : undefined;
  }

  private focusIntentTarget(): HTMLElement | undefined {
    const intent = this.focusIntent;
    if (intent === undefined || intent.destination === "trigger") return undefined;
    if (intent.destination === "heading") return this.renderRoot.querySelector<HTMLElement>("[data-notification-focus='heading']") ?? undefined;
    return intent.control === undefined ? undefined : this.controlElement(intent.control);
  }

  static override styles = css`
    :host { display: block; min-width: 0; min-height: 0; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    .notification-tray { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; background: var(--pi-bg-overlay); }
    .notification-header { position: sticky; top: 0; z-index: 2; flex: 0 0 auto; min-width: 0; display: flex; flex-wrap: nowrap; align-items: center; justify-content: space-between; gap: 8px; box-sizing: border-box; min-height: 40px; padding: 4px 10px; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg-overlay); }
    .notification-heading { min-width: 0; flex: 1 1 auto; margin: 0; overflow: hidden; color: var(--pi-text-bright); font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
    .notification-heading:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .notification-header-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 4px; }
    .notification-control, .notification-row-dismiss { box-sizing: border-box; min-height: 34px; border: 0; border-radius: 6px; background: transparent; color: var(--pi-muted); cursor: pointer; }
    .notification-control { padding: 0 8px; font: 12px system-ui, sans-serif; white-space: nowrap; }
    .notification-control:hover, .notification-control:focus-visible, .notification-row-dismiss:hover, .notification-row-dismiss:focus-visible { background: var(--pi-selection-bg); color: var(--pi-text-bright); }
    .notification-control:focus-visible, .notification-row-dismiss:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    .notification-control:disabled, .notification-row-dismiss:disabled { opacity: .5; background: transparent; cursor: default; }
    .notification-close { width: 34px; padding: 0; font-size: 20px; line-height: 1; }
    .notification-error { flex: 0 0 auto; margin: 0; padding: 8px 12px; color: var(--pi-danger); overflow-wrap: anywhere; }
    .notification-state-block { flex: 1 1 auto; min-height: 0; display: grid; place-items: center; align-content: center; gap: 12px; padding: 24px; text-align: center; }
    .notification-state, .notification-empty { margin: 0; color: var(--pi-muted); overflow-wrap: anywhere; }
    .notification-empty { padding: 28px 12px; text-align: center; }
    .notification-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior-y: contain; box-sizing: border-box; padding: 0 12px 8px; }
    .notification-overflow { margin: 0; padding: 8px 2px; border-bottom: 1px solid var(--pi-border-muted); color: var(--pi-muted); font-size: 11px; overflow-wrap: anywhere; }
    .notification-row { position: relative; min-width: 0; display: grid; gap: 4px; box-sizing: border-box; padding: 10px 42px 10px 2px; border-bottom: 1px solid var(--pi-border-muted); color: var(--pi-text); }
    .notification-metadata { min-width: 0; display: flex; align-items: baseline; gap: 5px; color: var(--pi-muted); font-size: 11px; }
    .notification-severity { color: var(--pi-muted); font-size: inherit; font-weight: 600; }
    .notification-row.warning .notification-severity { color: var(--pi-warning); }
    .notification-row.error .notification-severity { color: var(--pi-danger); }
    .notification-message { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; text-align: start; unicode-bidi: plaintext; }
    .notification-truncated { margin: 0; color: var(--pi-muted); font-size: 11px; overflow-wrap: anywhere; }
    .notification-row-dismiss { position: absolute; top: 6px; right: 0; display: inline-grid; place-items: center; width: 34px; height: 34px; padding: 0; font-size: 18px; }
    @media (pointer: coarse) {
      .notification-control, .notification-row-dismiss { min-height: 40px; }
      .notification-row-dismiss { width: 40px; height: 40px; }
    }
    @media (max-width: 520px) {
      .notification-header { gap: 4px; padding-inline: 10px; }
      .notification-list { padding-inline: 10px; }
    }
  `;
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/gu, "\\$&");
}
