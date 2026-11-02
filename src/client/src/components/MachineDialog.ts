import { LitElement, css, html, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { Machine } from "../api";
import {
  DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
  effectiveMachineRequestTimeoutMs,
  validateMachineRequestTimeoutMs,
} from "../../../shared/machineRequestTimeout";

/** The identity of the dialog's editing scope: one machine, or a new one. */
const CREATE_IDENTITY = "create";

/**
 * Decimal seconds with at most millisecond precision. An exponent, a sign, or a
 * fourth fractional digit is not a timeout this field accepts, so it is handed
 * to the shared validator unchanged and reports that one range message.
 */
const TIMEOUT_SECONDS_PATTERN = /^\d+(?:\.\d{1,3})?$/u;

export interface MachineDialogSubmit {
  name: string;
  baseUrl: string;
  /** Patience in milliseconds, already validated against the shared bounds. */
  requestTimeoutMs: number;
  token?: string;
}

@customElement("machine-dialog")
export class MachineDialog extends LitElement {
  @property({ attribute: false }) onSubmit?: (input: MachineDialogSubmit) => void | Promise<void>;
  @property({ attribute: false }) onCancel?: () => void;
  @property({ attribute: false }) error = "";
  /** The machine being edited; absent while adding a new machine. */
  @property({ attribute: false }) machine?: Machine;
  /** Focus the patience field once, for a dialog opened to raise a limit. */
  @property({ type: Boolean }) focusRequestTimeout = false;

  @state() private url = "";
  @state() private name = "";
  @state() private token = "";
  @state() private requestTimeoutSeconds = "";
  @state() private requestTimeoutError: string | undefined;
  @state() private submitting = false;
  @query("input[name='baseUrl']") private urlInput?: HTMLInputElement;
  @query("input[name='name']") private nameInput?: HTMLInputElement;
  @query("input[name='requestTimeoutMs']") private requestTimeoutInput?: HTMLInputElement;

  private nameEdited = false;
  private previousSuggestedName = "";
  /** The editing scope the fields currently hold. */
  private seededIdentity: string | undefined;

  override firstUpdated(): void {
    if (this.focusRequestTimeout) {
      this.focusRequestTimeoutInput();
      return;
    }
    this.urlInput?.focus();
  }

  protected override willUpdate(): void {
    const identity = this.dialogIdentity();
    if (this.seededIdentity === identity) return;
    this.seededIdentity = identity;
    this.seedFields();
  }

  protected override updated(changed: PropertyValues<this>): void {
    // Opening a dialog for another machine while it is already mounted keeps
    // the same element, so the identity change owns the focus move.
    if (changed.has("focusRequestTimeout") && this.focusRequestTimeout) this.focusRequestTimeoutInput();
  }

  private dialogIdentity(): string {
    return this.machine?.id ?? CREATE_IDENTITY;
  }

  private seedFields(): void {
    const machine = this.machine;
    this.url = machine?.baseUrl ?? "";
    this.name = machine?.name ?? "";
    this.token = "";
    this.requestTimeoutError = undefined;
    this.requestTimeoutSeconds = formatTimeoutSeconds(
      machine === undefined ? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS : effectiveMachineRequestTimeoutMs(machine),
    );
    // An edited machine already has a name the user chose; URL typing must not
    // replace it with a host suggestion.
    this.nameEdited = machine !== undefined;
    this.previousSuggestedName = suggestedMachineNameFromUrl(this.url);
  }

  private focusRequestTimeoutInput(): void {
    this.requestTimeoutInput?.focus();
    this.requestTimeoutInput?.select();
  }

  private handleUrlInput(event: InputEvent): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    const url = event.target.value;
    const suggestedName = suggestedMachineNameFromUrl(url);
    if (!this.nameEdited || this.name.trim() === "" || this.name === this.previousSuggestedName) this.name = suggestedName;
    this.previousSuggestedName = suggestedName;
    this.url = url;
  }

  private handleNameInput(event: InputEvent): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.nameEdited = true;
    this.name = event.target.value;
  }

  private handleTokenInput(event: InputEvent): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.token = event.target.value;
  }

  private handleRequestTimeoutInput(event: InputEvent): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.requestTimeoutSeconds = event.target.value;
    this.requestTimeoutError = undefined;
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.onCancel?.();
      return;
    }
    if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.name === "baseUrl" && machineBaseUrlValidationMessage(this.url) === undefined) {
      event.preventDefault();
      void this.updateComplete.then(() => {
        this.nameInput?.focus();
        this.nameInput?.select();
      });
    }
  }

  private handleSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void this.submit();
  }

  private async submit(): Promise<void> {
    if (this.submitting) return;
    const timeout = this.requestTimeoutMilliseconds();
    if ("error" in timeout) {
      this.requestTimeoutError = timeout.error;
      await this.updateComplete;
      this.focusRequestTimeoutInput();
      return;
    }
    const input = this.validInput(timeout.value);
    if (input === undefined) return;
    this.submitting = true;
    try {
      await this.onSubmit?.(input);
    } finally {
      if (this.isConnected) this.submitting = false;
    }
  }

  private requestTimeoutMilliseconds(): { value: number } | { error: string } {
    try {
      return { value: parseTimeoutSeconds(this.requestTimeoutSeconds) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private validInput(requestTimeoutMs: number): MachineDialogSubmit | undefined {
    const baseUrl = this.url.trim();
    const name = this.name.trim();
    if (baseUrl === "" || name === "" || machineBaseUrlValidationMessage(baseUrl) !== undefined) return undefined;
    const token = this.token.trim();
    return { name, baseUrl, requestTimeoutMs, ...(token === "" ? {} : { token }) };
  }

  /** Whether the URL and name alone allow a submit; patience has its own message. */
  private formReady(): boolean {
    const baseUrl = this.url.trim();
    return baseUrl !== "" && this.name.trim() !== "" && machineBaseUrlValidationMessage(baseUrl) === undefined;
  }

  override render() {
    const hasUrl = this.url.trim() !== "";
    const urlError = hasUrl ? machineBaseUrlValidationMessage(this.url) : undefined;
    const editing = this.machine !== undefined;
    const canSubmit = this.formReady() && !this.submitting;
    return html`
      <div class="backdrop" @click=${() => this.onCancel?.()}>
        <section @click=${(event: Event) => { event.stopPropagation(); }}>
          <form @submit=${(event: SubmitEvent) => { this.handleSubmit(event); }} @keydown=${(event: KeyboardEvent) => { this.handleKeyDown(event); }}>
            <header>
              <strong>${editing ? "Edit machine" : "Add machine"}</strong>
              <button type="button" @click=${() => { this.onCancel?.(); }} aria-label="Close">×</button>
            </header>
            <div class="body">
              ${this.error === "" ? null : html`<div class="dialog-error" role="alert">${this.error}</div>`}
              <label>
                Remote PI WEBUI URL
                <input name="baseUrl" type="url" .value=${this.url} @input=${(event: InputEvent) => { this.handleUrlInput(event); }} placeholder="http://dev-box.local:8808" autocomplete="url" inputmode="url" autofocus />
              </label>
              <small class=${urlError === undefined ? "hint" : "field-error"}>${urlError ?? "Enter the reachable base URL first, including http:// or https://."}</small>
              <label>
                Request timeout <span class="optional">seconds</span>
                <input name="requestTimeoutMs" type="text" .value=${this.requestTimeoutSeconds} @input=${(event: InputEvent) => { this.handleRequestTimeoutInput(event); }} placeholder="120" autocomplete="off" inputmode="decimal" />
              </label>
              <small class=${this.requestTimeoutError === undefined ? "hint" : "field-error"}>${this.requestTimeoutError ?? "How long a remote request may take. Fractions allow millisecond precision."}</small>
              ${hasUrl ? html`
                <label>
                  Machine name
                  <input name="name" type="text" .value=${this.name} @input=${(event: InputEvent) => { this.handleNameInput(event); }} placeholder=${this.previousSuggestedName || "Dev Box"} autocomplete="off" />
                </label>
                <small class="hint">Suggested from the URL. Edit it to use a friendlier sidebar label.</small>
                <label>
                  Bearer token <span class="optional">optional</span>
                  <input name="token" type="password" .value=${this.token} @input=${(event: InputEvent) => { this.handleTokenInput(event); }} placeholder="Leave blank if the remote machine does not require one" autocomplete="off" />
                </label>
                <small class="hint">Paste only the token value; PI WEBUI sends it as an Authorization: Bearer header.</small>
              ` : html`<p class="hint intro">After you enter a URL, PI WEBUI will suggest a machine name and let you add an optional bearer token.</p>`}
            </div>
            <footer>
              <button type="button" @click=${() => { this.onCancel?.(); }}>Cancel</button>
              <button class="primary" type="submit" ?disabled=${!canSubmit}>${this.submitting ? "Saving…" : editing ? "Save changes" : "Add machine"}</button>
            </footer>
          </form>
        </section>
      </div>
    `;
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 30; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    .backdrop { display: grid; place-items: start center; width: 100%; height: 100%; padding-top: min(12vh, 90px); box-sizing: border-box; background: var(--pi-overlay); }
    section { width: min(560px, calc(100vw - 40px)); max-height: min(640px, calc(100vh - 40px)); border: 1px solid var(--pi-border); border-radius: 12px; background: var(--pi-bg); box-shadow: 0 20px 60px var(--pi-shadow-strong); overflow: hidden; }
    form { display: flex; flex-direction: column; max-height: inherit; min-height: 0; }
    header, footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px; border-bottom: 1px solid var(--pi-border); }
    footer { border-top: 1px solid var(--pi-border); border-bottom: 0; justify-content: end; }
    .body { display: grid; gap: 8px; padding: 12px; min-height: 0; overflow: auto; }
    label { display: grid; gap: 6px; color: var(--pi-muted); }
    input { box-sizing: border-box; width: 100%; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); padding: 9px; font: var(--pi-control-font-size, 16px) var(--pi-control-monospace-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
    input:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    .hint { color: var(--pi-muted); }
    .intro { margin: 4px 0 0; line-height: 1.4; }
    .optional { color: var(--pi-muted); font-weight: 400; }
    .field-error { color: var(--pi-danger); }
    .dialog-error { border: 1px solid var(--pi-danger); border-radius: 8px; background: color-mix(in srgb, var(--pi-danger) 10%, transparent); color: var(--pi-danger); padding: 9px; line-height: 1.35; }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; cursor: pointer; }
    header button { border: 0; background: transparent; color: var(--pi-muted); font-size: 22px; padding: 0 8px; }
    .primary { border-color: var(--pi-success-border); background: var(--pi-success-border); }
    button:disabled { opacity: .5; cursor: not-allowed; }
  `;
}

/**
 * Decimal seconds as milliseconds, validated against the shared bounds.
 *
 * A token that is not decimal seconds at all (an exponent, a sign, a fourth
 * fractional digit) goes to the validator unchanged, so the user reads the one
 * accepted-range message instead of a second, invented parse error.
 */
function parseTimeoutSeconds(raw: string): number {
  const value = raw.trim();
  if (!TIMEOUT_SECONDS_PATTERN.test(value)) return validateMachineRequestTimeoutMs(Number(value));
  const [whole = "", fraction = ""] = value.split(".");
  return validateMachineRequestTimeoutMs(Number(whole) * 1_000 + Number(fraction.padEnd(3, "0")));
}

/** Milliseconds as decimal seconds, omitting a zero fraction: `120`, `5.001`. */
function formatTimeoutSeconds(ms: number): string {
  const whole = Math.floor(ms / 1_000);
  const fraction = ms % 1_000;
  if (fraction === 0) return String(whole);
  return `${String(whole)}.${String(fraction).padStart(3, "0").replace(/0+$/u, "")}`;
}

export function suggestedMachineNameFromUrl(value: string): string {
  const raw = value.trim();
  if (raw === "") return "";
  const parsed = parseUrlForSuggestion(raw) ?? parseUrlForSuggestion(`http://${raw.replace(/^\/+/u, "")}`);
  if (parsed !== undefined && parsed.hostname !== "") return parsed.hostname.replace(/^\[(.*)\]$/u, "$1");
  return fallbackSuggestedName(raw);
}

export function machineBaseUrlValidationMessage(value: string): string | undefined {
  const raw = value.trim();
  if (raw === "") return "Remote PI WEBUI URL is required.";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Enter a valid URL including http:// or https://.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Use an http:// or https:// URL.";
  if (url.username !== "" || url.password !== "") return "Do not include credentials in the machine URL.";
  if (url.search !== "" || url.hash !== "") return "Do not include a query string or fragment.";
  return undefined;
}

function parseUrlForSuggestion(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function fallbackSuggestedName(value: string): string {
  const withoutProtocol = value.replace(/^[a-z][a-z\d+.-]*:\/\//iu, "");
  const withoutCredentials = withoutProtocol.slice(withoutProtocol.lastIndexOf("@") + 1);
  const host = withoutCredentials.split(/[/?#]/u)[0] ?? "";
  if (host.startsWith("[") && host.includes("]")) return host.slice(1, host.indexOf("]"));
  return host.replace(/:\d+$/u, "");
}
