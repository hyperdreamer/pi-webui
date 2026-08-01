import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import {
  MODEL_TIERS,
  type ClientSessionModelPolicyStatus,
  type ExactModelSelection,
  type ModelTier,
  type ModelTierModelOption,
  type ModelTierSettingsResponse,
  type SessionModelPolicyResponse,
  type SessionModelPolicyUpdate,
  type TierModelRef,
} from "../../../shared/apiTypes";
import {
  modelPolicyDraftFromPolicy,
  selectDraftExact,
  selectDraftTier,
  sessionModelPolicyUpdateFromDraft,
  updateDraftExactModel,
  updateDraftExactThinking,
  type SessionModelPolicyDraft,
} from "./sessionModelPolicyDraft";

const TIER_LABELS: Record<ModelTier, string> = {
  economy: "Economy",
  fast: "Fast",
  standard: "Standard",
  advanced: "Advanced",
  capable: "Capable",
  frontier: "Frontier",
};

const LADDER_INVALID_MESSAGE = "Model tier ladder is invalid. Tiered mode stays unavailable until the ladder is fixed in Settings → Model tiers.";

/**
 * Composer control for a session's model policy. This element is presentation,
 * event wiring, and accessibility only: every draft transition and every
 * save-eligibility decision comes from `sessionModelPolicyDraft`, and all
 * transport/session state stays with the parent.
 *
 * The closed trigger reads the live `status` projection so it keeps rendering
 * from websocket status before (or instead of) a policy GET. The opened form
 * needs a confirmed `response`; without one it offers a retry instead, because a
 * failed policy read is not retried automatically anywhere else.
 */
@customElement("session-model-policy-control")
export class SessionModelPolicyControl extends LitElement {
  /** Additive live-status projection; sufficient to render the closed trigger. */
  @property({ attribute: false }) status?: ClientSessionModelPolicyStatus;
  /** Fresh GET/PUT inspection result; required before the opened form can save. */
  @property({ attribute: false }) response?: SessionModelPolicyResponse;
  @property({ attribute: false }) catalog?: ModelTierSettingsResponse;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) saving = false;
  @property({ type: Boolean }) editable = false;
  @property() error = "";
  @property({ attribute: false }) onOpen?: () => void;
  @property({ attribute: false }) onSave?: (update: SessionModelPolicyUpdate) => void;

  @state() private open = false;
  @state() private draft: SessionModelPolicyDraft | undefined = undefined;

  @query(".policy-trigger") private triggerButton?: HTMLButtonElement;
  /** Whether focus was inside this element before the pending render replaced DOM. */
  private focusWasInside = false;

  protected override willUpdate(changed: PropertyValues<this>): void {
    this.focusWasInside = this.shadowRoot?.activeElement !== null;
    // Rebuild the editable draft only when a new confirmed response arrives, so
    // an in-progress edit survives unrelated re-renders (a save error, a status
    // tick, a loading flag) instead of being reset under the user.
    if (!changed.has("response")) return;
    this.draft = draftForResponse(this.response);
  }

  protected override updated(): void {
    // A render that replaces the focused control (a retry that resolves into the
    // form, a repair form replaced by a confirmed one) would otherwise drop focus
    // to the document. Re-anchor only when focus was ours and is now gone.
    if (!this.open || !this.focusWasInside) return;
    if (this.shadowRoot?.activeElement === null) this.focusPanel();
  }

  override disconnectedCallback(): void {
    this.open = false;
    super.disconnectedCallback();
  }

  override render(): TemplateResult | typeof nothing {
    const policyStatus = this.effectiveStatus();
    if (policyStatus === undefined) return nothing;
    const modeLabel = policyStatus.mode === "tiered" ? "Tiered" : "Exact";
    const tier = policyStatus.tier;
    const compactDiagnostic = this.compactDiagnostic(policyStatus);
    return html`
      <button
        type="button"
        class="policy-trigger"
        aria-label=${`Session model mode: ${modeLabel}`}
        aria-haspopup="dialog"
        aria-expanded=${this.open ? "true" : "false"}
        title=${triggerTitle(policyStatus, modeLabel)}
        @click=${() => { this.toggle(); }}
      >
        <span class="policy-mode">${modeLabel}</span>
        ${policyStatus.mode === "tiered" && tier !== undefined ? html`<span class="policy-tier">${TIER_LABELS[tier]}</span>` : null}
        ${policyStatus.mode === "tiered" ? html`<span class="policy-resolution">→ ${describeSelection(policyStatus.resolved)}</span>` : null}
      </button>
      ${compactDiagnostic === undefined ? null : html`<span class="policy-diagnostic" title=${compactDiagnostic}>${compactDiagnostic}</span>`}
      ${this.open ? this.renderPanel(policyStatus) : null}
    `;
  }

  private renderPanel(policyStatus: ClientSessionModelPolicyStatus): TemplateResult {
    const draft = this.draft;
    const catalog = this.catalog;
    return html`
      <section
        class="policy-panel"
        role="dialog"
        aria-label="Session model policy"
        @keydown=${(event: KeyboardEvent) => { this.handlePanelKeydown(event); }}
      >
        <header class="policy-panel-header">
          <h2 class="policy-panel-title">Session model policy</h2>
          <button type="button" class="policy-close" aria-label="Close session model policy" @click=${() => { this.close(); }}>×</button>
        </header>
        <p class="policy-current">Current: ${policyStatus.mode === "tiered" && policyStatus.tier !== undefined ? html`Tiered · ${TIER_LABELS[policyStatus.tier]} · ` : html`Exact · `}${describeSelection(policyStatus.resolved)}</p>
        ${this.renderDiagnostics(policyStatus, catalog)}
        ${draft === undefined || catalog === undefined ? this.renderUnavailable() : this.renderForm(draft, catalog)}
        ${this.error === "" ? null : html`<p class="policy-error" role="alert" aria-live="assertive">${this.error}</p>`}
      </section>
    `;
  }

  private renderUnavailable(): TemplateResult {
    return html`
      <div class="policy-unavailable">
        <p>${this.loading ? "Loading the current model policy…" : "The current model policy could not be loaded, so it cannot be changed yet."}</p>
        <button type="button" class="policy-retry" ?disabled=${this.loading} @click=${() => { this.onOpen?.(); }}>Retry</button>
      </div>
    `;
  }

  private renderForm(draft: SessionModelPolicyDraft, catalog: ModelTierSettingsResponse): TemplateResult {
    const mutable = this.canMutate();
    const update = sessionModelPolicyUpdateFromDraft(draft, catalog);
    return html`
      <div class="policy-field">
        <label for="policy-mode">Mode</label>
        <select id="policy-mode" ?disabled=${!mutable} .value=${draft.mode} @change=${(event: Event) => { this.changeMode(event); }}>
          <option value="exact" ?selected=${draft.mode === "exact"}>Exact model</option>
          <option value="tiered" ?selected=${draft.mode === "tiered"}>Tiered</option>
        </select>
      </div>
      ${this.renderTierField(draft, catalog, mutable)}
      ${draft.mode === "tiered" ? this.renderTierResolution(draft, catalog) : this.renderExactFields(draft, catalog, mutable)}
      <footer class="policy-actions">
        <button type="button" class="policy-cancel" @click=${() => { this.close(); }}>Cancel</button>
        <button type="button" class="policy-save" ?disabled=${!mutable || update === undefined} @click=${() => { this.save(); }}>${this.saving ? "Saving…" : "Save"}</button>
      </footer>
    `;
  }

  private renderTierField(draft: SessionModelPolicyDraft, catalog: ModelTierSettingsResponse, mutable: boolean): TemplateResult {
    // No tier is selectable while the configured ladder is unusable, so the
    // control is disabled rather than offering choices that cannot be saved.
    const ladderUsable = catalog.valid && catalog.ladder !== undefined;
    const selected = draft.tier;
    return html`
      <div class="policy-field">
        <label for="policy-tier">Tier</label>
        <select id="policy-tier" ?disabled=${!mutable || !ladderUsable} .value=${selected ?? ""} @change=${(event: Event) => { this.changeTier(event); }}>
          ${selected === undefined ? html`<option value="" disabled ?selected=${true}>Select a tier…</option>` : null}
          ${MODEL_TIERS.map((tier) => html`<option value=${tier} ?disabled=${!catalog.rows[tier].valid} ?selected=${selected === tier}>${TIER_LABELS[tier]}</option>`)}
        </select>
      </div>
    `;
  }

  private renderTierResolution(draft: SessionModelPolicyDraft, catalog: ModelTierSettingsResponse): TemplateResult {
    const tier = draft.tier;
    if (tier === undefined) return html`<p class="policy-hint">Select a tier to see the model it resolves to.</p>`;
    const entry = catalog.ladder?.[tier];
    const row = catalog.rows[tier];
    if (entry === undefined || !row.valid || !catalog.valid) {
      const reason = row.reason ?? catalog.configError ?? `The ${TIER_LABELS[tier]} tier is not configured with a usable model.`;
      return html`<p class="policy-row-error" role="alert">${reason}</p>`;
    }
    return html`
      <p class="policy-resolution-row">
        <span class="policy-resolution-label">Resolves to</span>
        <span class="policy-resolution">→ ${describeSelection(entry)}</span>
      </p>
    `;
  }

  private renderExactFields(draft: SessionModelPolicyDraft, catalog: ModelTierSettingsResponse, mutable: boolean): TemplateResult {
    const selectedModel = draft.exact.model;
    const option = catalog.models.find((candidate) => sameModel(candidate.model, selectedModel));
    const knownModel = option !== undefined;
    const thinkingLevel = draft.exact.thinkingLevel;
    const thinkingSupported = option?.thinkingLevels.includes(thinkingLevel) ?? false;
    return html`
      <div class="policy-field">
        <label for="policy-exact-model">Exact model</label>
        <select id="policy-exact-model" ?disabled=${!mutable} aria-invalid=${knownModel ? "false" : "true"} .value=${modelKey(selectedModel)} @change=${(event: Event) => { this.changeExactModel(event); }}>
          ${knownModel ? null : html`<option value=${modelKey(selectedModel)} disabled ?selected=${true}>${describeModel(selectedModel)} (unavailable)</option>`}
          ${catalog.models.map((candidate) => html`<option value=${modelKey(candidate.model)} ?selected=${sameModel(candidate.model, selectedModel)}>${modelOptionLabel(candidate)}</option>`)}
        </select>
      </div>
      <div class="policy-field">
        <label for="policy-exact-thinking">Thinking level</label>
        <select id="policy-exact-thinking" ?disabled=${!mutable} aria-invalid=${thinkingSupported ? "false" : "true"} .value=${thinkingLevel} @change=${(event: Event) => { this.changeExactThinking(event); }}>
          ${thinkingLevel === "" ? html`<option value="" disabled ?selected=${true}>Select a thinking level…</option>` : null}
          ${thinkingLevel !== "" && !thinkingSupported ? html`<option value=${thinkingLevel} disabled ?selected=${true}>${thinkingLevel} (unsupported)</option>` : null}
          ${(option?.thinkingLevels ?? []).map((level) => html`<option value=${level} ?selected=${thinkingLevel === level}>${level}</option>`)}
        </select>
      </div>
    `;
  }

  private renderDiagnostics(policyStatus: ClientSessionModelPolicyStatus, catalog: ModelTierSettingsResponse | undefined): TemplateResult | null {
    const messages: string[] = [];
    const blockedReason = this.blockedReason();
    if (blockedReason !== undefined) messages.push(blockedReason);
    if (!policyStatus.ladderValid) messages.push(LADDER_INVALID_MESSAGE);
    const configError = catalog?.configError;
    if (configError !== undefined && configError !== "") messages.push(configError);
    if (messages.length === 0) return null;
    return html`<div class="policy-blocked" role="alert">${messages.map((message) => html`<p>${message}</p>`)}</div>`;
  }

  /**
   * The compact row has little space, so it shows only the most urgent problem:
   * a live runtime/entry block, or (for a Tiered session, whose active policy it
   * breaks) an invalid ladder. Ladder validity comes from the live status, never
   * from a held response, which is allowed to go stale.
   */
  private compactDiagnostic(policyStatus: ClientSessionModelPolicyStatus): string | undefined {
    const blockedReason = this.blockedReason();
    if (blockedReason !== undefined) return blockedReason;
    if (policyStatus.mode === "tiered" && !policyStatus.ladderValid) return LADDER_INVALID_MESSAGE;
    return undefined;
  }

  private effectiveStatus(): ClientSessionModelPolicyStatus | undefined {
    return this.status ?? this.response?.session.modelPolicy;
  }

  private blockedReason(): string | undefined {
    const reason = this.effectiveStatus()?.blockedReason;
    return reason === undefined || reason.trim() === "" ? undefined : reason;
  }

  /**
   * A confirmed policy that the server reports as blocked is not editable from
   * here: the block describes the applied policy, not the draft, so the only
   * honest presentation is read-only with the reason visible. A response with no
   * `policy` is the repair case instead, where editing is the whole point.
   */
  private canMutate(): boolean {
    if (!this.editable || this.saving) return false;
    return !(this.blockedReason() !== undefined && this.response?.policy !== undefined);
  }

  private toggle(): void {
    if (this.open) {
      this.close();
      return;
    }
    this.open = true;
    this.onOpen?.();
    void this.updateComplete.then(() => {
      if (this.isConnected) this.focusPanel();
    });
  }

  private close(): void {
    if (!this.open) return;
    this.open = false;
    // Restore focus through the retained trigger reference so closing by Escape,
    // Cancel, or the close control never drops the user at the document root.
    void this.updateComplete.then(() => {
      if (this.isConnected) this.triggerButton?.focus();
    });
  }

  private handlePanelKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  }

  /**
   * Move focus into the opened surface so it is immediately keyboard operable and
   * a bubbling Escape reaches the panel handler. Preference order is the first
   * editable field, then the recovery action, then the header's close control.
   */
  private focusPanel(): void {
    const field = this.renderRoot.querySelector<HTMLElement>(".policy-panel select:not([disabled])");
    const retry = this.renderRoot.querySelector<HTMLElement>(".policy-retry:not([disabled])");
    const close = this.renderRoot.querySelector<HTMLElement>(".policy-close");
    (field ?? retry ?? close ?? this.triggerButton)?.focus();
  }

  private changeMode(event: Event): void {
    const draft = this.draft;
    if (draft === undefined || !(event.target instanceof HTMLSelectElement)) return;
    if (event.target.value === "exact") {
      this.draft = selectDraftExact(draft);
      return;
    }
    // A remembered tier is re-selected through the draft module; without one the
    // draft stays a tier-less Tiered draft, which the module treats as not yet
    // savable until a canonical tier is chosen.
    this.draft = draft.tier === undefined ? { ...draft, mode: "tiered" } : selectDraftTier(draft, draft.tier);
  }

  private changeTier(event: Event): void {
    const draft = this.draft;
    if (draft === undefined || !(event.target instanceof HTMLSelectElement)) return;
    const selected = event.target.value;
    const tier = MODEL_TIERS.find((candidate) => candidate === selected);
    if (tier === undefined) return;
    this.draft = selectDraftTier(draft, tier);
  }

  private changeExactModel(event: Event): void {
    const draft = this.draft;
    if (draft === undefined || !(event.target instanceof HTMLSelectElement)) return;
    const selectedKey = event.target.value;
    const option = this.catalog?.models.find((candidate) => modelKey(candidate.model) === selectedKey);
    if (option === undefined) return;
    this.draft = updateDraftExactModel(draft, option);
  }

  private changeExactThinking(event: Event): void {
    const draft = this.draft;
    if (draft === undefined || !(event.target instanceof HTMLSelectElement)) return;
    this.draft = updateDraftExactThinking(draft, event.target.value);
  }

  private save(): void {
    const draft = this.draft;
    const catalog = this.catalog;
    if (draft === undefined || catalog === undefined || !this.canMutate()) return;
    const update = sessionModelPolicyUpdateFromDraft(draft, catalog);
    if (update === undefined) return;
    this.onSave?.(update);
  }

  static override styles = css`
    :host { position: relative; min-width: 0; display: inline-flex; align-items: center; gap: 6px; font: inherit; }
    * { box-sizing: border-box; }
    .policy-trigger { flex: 0 0 auto; min-width: 0; display: inline-flex; align-items: baseline; gap: 6px; border: 1px solid var(--pi-border); border-radius: 999px; background: var(--pi-surface); color: var(--pi-text); padding: 4px 9px; font: inherit; font-size: 12px; line-height: 1.3; cursor: pointer; }
    .policy-trigger:hover, .policy-trigger:focus-visible { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    .policy-mode { font-weight: 600; }
    .policy-tier, .policy-resolution { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pi-muted); }
    .policy-diagnostic { min-width: 0; max-width: 22ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pi-danger); font-size: 11px; }

    .policy-panel { position: absolute; z-index: 30; bottom: calc(100% + 6px); left: 0; width: min(360px, calc(100vw - 24px)); max-height: min(420px, 60dvh); overflow: auto; overscroll-behavior: contain; display: grid; gap: 10px; border: 1px solid var(--pi-border); border-radius: 12px; background: var(--pi-bg); box-shadow: 0 12px 32px var(--pi-shadow); padding: 12px; text-align: left; }
    .policy-panel-header { display: flex; align-items: center; gap: 8px; }
    .policy-panel-title { flex: 1 1 auto; margin: 0; font-size: 13px; font-weight: 600; }
    .policy-close { flex: 0 0 auto; display: grid; place-items: center; width: 26px; height: 26px; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-muted); padding: 0; font: inherit; font-size: 15px; line-height: 1; cursor: pointer; }
    p { margin: 0; }
    .policy-current { color: var(--pi-muted); font-size: 12px; overflow-wrap: anywhere; }
    .policy-hint { color: var(--pi-muted); font-size: 12px; }
    .policy-field { display: grid; gap: 4px; }
    .policy-field label { font-size: 12px; font-weight: 600; }
    select { width: 100%; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 6px 8px; font: inherit; font-size: 13px; }
    select[aria-invalid="true"] { border-color: var(--pi-danger); }
    select:disabled { opacity: .55; cursor: not-allowed; }
    .policy-resolution-row { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; font-size: 12px; }
    .policy-resolution-label { color: var(--pi-muted); font-weight: 600; }
    .policy-resolution-row .policy-resolution { white-space: normal; overflow: visible; overflow-wrap: anywhere; }
    .policy-blocked, .policy-error, .policy-row-error { border: 1px solid var(--pi-danger); border-radius: 8px; background: var(--pi-surface); color: var(--pi-danger); padding: 8px 10px; font-size: 12px; overflow-wrap: anywhere; }
    .policy-blocked { display: grid; gap: 6px; }
    .policy-unavailable { display: grid; gap: 8px; justify-items: start; color: var(--pi-muted); font-size: 12px; }
    .policy-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .policy-actions button, .policy-retry { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 6px 12px; font: inherit; font-size: 12px; cursor: pointer; }
    .policy-save { border-color: var(--pi-accent); background: var(--pi-accent); color: #fff; }
    .policy-actions button:disabled, .policy-retry:disabled { opacity: .55; cursor: not-allowed; }
    .policy-panel :focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }

    /* Narrow layouts get a constrained bottom sheet instead of a popover that
       would overflow the composer. */
    @media (max-width: 760px) {
      .policy-panel { position: fixed; inset: auto 0 0 0; width: 100%; max-width: none; max-height: min(70dvh, 520px); border-width: 1px 0 0 0; border-radius: 14px 14px 0 0; padding: 14px max(12px, env(safe-area-inset-left)) max(14px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-right)); box-shadow: 0 -12px 32px var(--pi-shadow-strong); }
    }
  `;
}

function draftForResponse(response: SessionModelPolicyResponse | undefined): SessionModelPolicyDraft | undefined {
  if (response === undefined) return undefined;
  if (response.policy !== undefined) return modelPolicyDraftFromPolicy(response.policy);
  // The newest persisted entry is malformed, so there is no policy to copy. Seed
  // the repair form from the tuple the runtime actually resolved; the server's
  // blocked reason stays visible beside it.
  const resolved = response.session.modelPolicy?.resolved;
  return {
    mode: "exact",
    exact: {
      model: { provider: resolved?.model.provider ?? "", id: resolved?.model.id ?? "" },
      thinkingLevel: resolved?.thinkingLevel ?? "",
    },
  };
}

function triggerTitle(policyStatus: ClientSessionModelPolicyStatus, modeLabel: string): string {
  const tier = policyStatus.tier;
  const tierPart = policyStatus.mode === "tiered" && tier !== undefined ? ` · ${TIER_LABELS[tier]}` : "";
  return `Session model mode: ${modeLabel}${tierPart} · ${describeSelection(policyStatus.resolved)}`;
}

function describeSelection(selection: ExactModelSelection): string {
  // No substitution: a blank thinking level is reported as missing rather than
  // shown as "off", which would be a guess about what the runtime resolved.
  const thinking = selection.thinkingLevel.trim() === "" ? "no thinking level" : selection.thinkingLevel;
  return `${describeModel(selection.model)} · ${thinking}`;
}

function describeModel(model: TierModelRef): string {
  return `${model.provider}/${model.id}`;
}

function modelOptionLabel(option: ModelTierModelOption): string {
  const name = option.name;
  return name !== undefined && name !== "" ? `${name} (${describeModel(option.model)})` : describeModel(option.model);
}

function modelKey(model: TierModelRef): string {
  return `${model.provider}:${model.id}`;
}

function sameModel(left: TierModelRef, right: TierModelRef): boolean {
  return left.provider === right.provider && left.id === right.id;
}

declare global {
  interface HTMLElementTagNameMap {
    "session-model-policy-control": SessionModelPolicyControl;
  }
}
