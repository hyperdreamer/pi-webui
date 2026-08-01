import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  MODEL_TIERS,
  type ModelTier,
  type ModelTierLadder,
  type ModelTierModelOption,
  type ModelTierSettingsResponse,
  type TierModelRef,
} from "../../../../shared/apiTypes";
import "./SettingsPanelFrame";
import type { SettingsNotice } from "./SettingsPanelFrame";
import {
  emptyModelTierLadderDraft,
  modelTierLadderDraftFromResponse,
  modelTierLadderFromDraft,
  updateTierModel,
  updateTierThinkingLevel,
  validateModelTierDraft,
  type ModelTierLadderDraft,
} from "./modelTierLadderDraft";
import type { SelectedMachineSettingsSupport } from "./settingsMachineTarget";

const TIER_META: Record<ModelTier, { label: string; step: string }> = {
  economy: { label: "Economy", step: "1" },
  fast: { label: "Fast", step: "↓" },
  standard: { label: "Standard", step: "↓" },
  advanced: { label: "Advanced", step: "↓" },
  capable: { label: "Capable", step: "↓" },
  frontier: { label: "Frontier", step: "6" },
};

@customElement("settings-model-tiers-panel")
export class SettingsModelTiersPanel extends LitElement {
  @property({ attribute: false }) response: ModelTierSettingsResponse | undefined;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) saving = false;
  @property() error = "";
  @property() savedMessage = "";
  @property() targetLabel = "selected machine";
  @property({ attribute: false }) support: SelectedMachineSettingsSupport = { state: "supported" };
  @property({ attribute: false }) onReload?: () => void | Promise<void>;
  @property({ attribute: false }) onSave?: (ladder: ModelTierLadder) => void | Promise<void>;

  @state() draft: ModelTierLadderDraft = emptyModelTierLadderDraft();

  get canSave(): boolean {
    const models = this.response?.models ?? [];
    const validation = validateModelTierDraft(this.draft, models);
    return validation.valid && !this.saving && !this.loading && this.support.state === "supported";
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("response")) {
      if (this.response !== undefined) {
        this.draft = modelTierLadderDraftFromResponse(this.response);
      } else {
        this.draft = emptyModelTierLadderDraft();
      }
    }
  }

  handleReload(): void {
    void this.onReload?.();
  }

  handleSave(): void {
    if (!this.canSave) return;
    const models = this.response?.models ?? [];
    const ladder = modelTierLadderFromDraft(this.draft, models);
    if (ladder && this.onSave) {
      void this.onSave(ladder);
    }
  }

  handleModelChange(tier: ModelTier, selectedOption: ModelTierModelOption): void {
    this.draft = updateTierModel(this.draft, tier, selectedOption);
  }

  handleThinkingChange(tier: ModelTier, thinkingLevel: string): void {
    this.draft = updateTierThinkingLevel(this.draft, tier, thinkingLevel);
  }

  private onModelSelectChange(tier: ModelTier, event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const selectedKey = event.target.value;
    const models = this.response?.models ?? [];
    const option = models.find((m) => modelKey(m.model) === selectedKey);
    if (option !== undefined) {
      this.handleModelChange(tier, option);
    }
  }

  private onThinkingSelectChange(tier: ModelTier, event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    this.handleThinkingChange(tier, event.target.value);
  }

  panelNotices(): readonly SettingsNotice[] {
    const notices: SettingsNotice[] = [];
    if (this.support.state === "unsupported") {
      notices.push({
        type: "availability",
        tone: "error",
        content:
          this.support.message ??
          `Model tier configuration is not available on ${this.targetLabel}. Update and restart Pi-Web on that machine, then try again.`,
      });
    } else if (this.support.state === "unknown") {
      notices.push({
        type: "availability",
        tone: "warning",
        content: this.support.message ?? `Model tier configuration support is unknown for ${this.targetLabel}.`,
      });
    }

    if (this.error !== "") {
      notices.push({
        type: "error",
        content: this.error,
      });
    }

    if (this.response?.configError !== undefined && this.response.configError !== "") {
      notices.push({
        type: "error",
        title: "Configuration error",
        content: this.response.configError,
      });
    }

    if (this.savedMessage !== "") {
      notices.push({
        type: "success",
        content: this.savedMessage,
      });
    }

    return notices;
  }

  override render(): TemplateResult {
    const models = this.response?.models ?? [];
    const validation = validateModelTierDraft(this.draft, models);
    const validCount = MODEL_TIERS.filter((t) => validation.rows[t].valid).length;
    const isEditingDisabled = this.loading || this.saving || this.support.state !== "supported";

    return html`
      <settings-panel-frame
        heading="Model tiers"
        description="Configure the six exact model/thinking bindings used by tiered sessions."
        actionLabel="Refresh models"
        actionTitle="Refresh available models and current settings"
        .actionDisabled=${this.loading || this.saving}
        .notices=${this.panelNotices()}
        .onAction=${() => {
          this.handleReload();
        }}
      >
        ${this.response === undefined && this.loading
          ? html`<div class="loading-card">Loading model tier settings…</div>`
          : this.response === undefined
            ? html`<div class="loading-card">Model tier settings are unavailable. Click Refresh models to try again.</div>`
            : html`
                <div class="tiers-table">
                  <div class="table-header" aria-hidden="true">
                    <div class="step-col"></div>
                    <div class="tier-col">Tier</div>
                    <div class="model-col">Available model</div>
                    <div class="thinking-col">Thinking</div>
                  </div>

                  ${MODEL_TIERS.map((tier) => this.renderTierRow(tier, models, validation, isEditingDisabled))}
                </div>

                <footer class="panel-footer">
                  <div class="footer-status" aria-live="polite">${validCount} of 6 tiers valid</div>
                  <button
                    class="primary"
                    ?disabled=${!this.canSave}
                    @click=${() => {
                      this.handleSave();
                    }}
                  >
                    ${this.saving ? "Saving…" : "Save complete ladder"}
                  </button>
                </footer>
              `}
      </settings-panel-frame>
    `;
  }

  private renderTierRow(
    tier: ModelTier,
    models: readonly ModelTierModelOption[],
    validation: ReturnType<typeof validateModelTierDraft>,
    disabled: boolean,
  ): TemplateResult {
    const meta = TIER_META[tier];
    const row = this.draft[tier];
    const rowValidation = validation.rows[tier];
    const selectedRef = row.model;

    const isKnown = selectedRef !== undefined && models.some((m) => sameModel(m.model, selectedRef));
    const selectedOption = selectedRef ? models.find((m) => sameModel(m.model, selectedRef)) : undefined;

    return html`
      <div class="tier-row ${rowValidation.valid ? "" : "invalid"}" data-tier=${tier}>
        <div class="step-col" aria-hidden="true">${meta.step}</div>
        <div class="tier-col">
          <span class="tier-label">${meta.label}</span>
        </div>

        <div class="model-col">
          <label class="sr-only" for=${`select-model-${tier}`}>${meta.label} tier model</label>
          <select
            id=${`select-model-${tier}`}
            aria-invalid=${String(!rowValidation.valid)}
            ?disabled=${disabled}
            .value=${selectedRef ? modelKey(selectedRef) : ""}
            @change=${(e: Event) => {
              this.onModelSelectChange(tier, e);
            }}
            title=${selectedRef ? describeModel(selectedRef) : "Select model"}
          >
            ${selectedRef === undefined
              ? html`<option value="" disabled ?selected=${true}>Select a model…</option>`
              : null}
            ${selectedRef !== undefined && !isKnown
              ? html`<option value=${modelKey(selectedRef)} disabled selected>
                  ${describeModel(selectedRef)} (unavailable)
                </option>`
              : null}
            ${models.map((opt) => {
              const isSelected = selectedRef !== undefined && sameModel(opt.model, selectedRef);
              const label =
                opt.name !== undefined && opt.name !== ""
                  ? `${opt.name} (${describeModel(opt.model)})`
                  : describeModel(opt.model);
              return html`<option value=${modelKey(opt.model)} ?selected=${isSelected}>${label}</option>`;
            })}
          </select>
        </div>

        <div class="thinking-col">
          <label class="sr-only" for=${`select-thinking-${tier}`}>${meta.label} tier thinking level</label>
          <select
            id=${`select-thinking-${tier}`}
            aria-invalid=${String(!rowValidation.valid)}
            ?disabled=${disabled || selectedRef === undefined}
            .value=${row.thinkingLevel}
            @change=${(e: Event) => {
              this.onThinkingSelectChange(tier, e);
            }}
          >
            ${row.thinkingLevel === ""
              ? html`<option value="" disabled selected>Select level…</option>`
              : null}
            ${selectedOption !== undefined
              ? html`
                  ${row.thinkingLevel !== "" && !selectedOption.thinkingLevels.includes(row.thinkingLevel)
                    ? html`<option value=${row.thinkingLevel} disabled selected>${row.thinkingLevel} (unsupported)</option>`
                    : null}
                  ${selectedOption.thinkingLevels.map(
                    (lvl) => html`<option value=${lvl} ?selected=${row.thinkingLevel === lvl}>${lvl}</option>`,
                  )}
                `
              : html`
                  ${row.thinkingLevel !== ""
                    ? html`<option value=${row.thinkingLevel} disabled selected>${row.thinkingLevel} (unavailable)</option>`
                    : null}
                `}
          </select>
        </div>

        ${!rowValidation.valid && rowValidation.reason !== undefined && rowValidation.reason !== ""
          ? html`<div class="row-error" role="alert">${rowValidation.reason}</div>`
          : null}
      </div>
    `;
  }

  static override styles = css`
    :host {
      display: block;
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .loading-card {
      border: 1px solid var(--pi-border);
      border-radius: 10px;
      background: var(--pi-surface);
      padding: 16px;
      color: var(--pi-muted);
    }

    .tiers-table {
      display: grid;
      gap: 8px;
    }

    .table-header {
      display: grid;
      grid-template-columns: 24px 100px 1fr 140px;
      gap: 12px;
      align-items: center;
      padding: 0 12px 4px 12px;
      font-size: 12px;
      font-weight: 600;
      color: var(--pi-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .tier-row {
      display: grid;
      grid-template-columns: 24px 100px 1fr 140px;
      grid-template-areas: "step tier model thinking";
      gap: 12px;
      align-items: center;
      border: 1px solid var(--pi-border);
      border-radius: 10px;
      background: var(--pi-surface);
      padding: 10px 12px;
    }

    .tier-row.invalid {
      border-color: color-mix(in srgb, var(--pi-danger) 50%, var(--pi-border));
    }

    .step-col {
      grid-area: step;
      text-align: center;
      font-weight: 600;
      color: var(--pi-muted);
    }

    .tier-col {
      grid-area: tier;
      font-weight: 600;
    }

    .model-col {
      grid-area: model;
      min-width: 0;
    }

    .thinking-col {
      grid-area: thinking;
      min-width: 0;
    }

    select {
      width: 100%;
      border: 1px solid var(--pi-border);
      border-radius: 8px;
      background: var(--pi-bg);
      color: var(--pi-text);
      padding: 7px 10px;
      font: inherit;
      font-size: 13px;
      box-sizing: border-box;
    }

    select[aria-invalid="true"] {
      border-color: var(--pi-danger);
    }

    select:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .row-error {
      grid-column: 1 / -1;
      font-size: 12px;
      color: var(--pi-danger);
      padding-top: 2px;
    }

    .panel-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-top: 8px;
      padding-top: 12px;
      border-top: 1px solid var(--pi-border-muted);
    }

    .footer-status {
      font-size: 13px;
      color: var(--pi-muted);
      font-weight: 500;
    }

    button.primary {
      border: 1px solid var(--pi-accent, #0066cc);
      border-radius: 8px;
      background: var(--pi-accent, #0066cc);
      color: #ffffff;
      padding: 8px 16px;
      font: inherit;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }

    button.primary:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    @media (max-width: 760px) {
      .table-header {
        display: none;
      }

      .tier-row {
        grid-template-columns: 1fr;
        grid-template-areas:
          "tier"
          "model"
          "thinking";
        gap: 10px;
        padding: 12px;
      }

      .step-col {
        display: none;
      }

      .panel-footer {
        flex-direction: column;
        align-items: stretch;
      }

      button.primary {
        width: 100%;
      }
    }
  `;
}

function sameModel(left: TierModelRef, right: TierModelRef): boolean {
  return left.provider === right.provider && left.id === right.id;
}

function modelKey(model: TierModelRef): string {
  return `${model.provider}:${model.id}`;
}

function describeModel(model: TierModelRef): string {
  return `${model.provider}/${model.id}`;
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-model-tiers-panel": SettingsModelTiersPanel;
  }
}
