import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
  TierModelRef,
  UtilityModelOption,
  UtilityModelSettingsResponse,
  UtilityModelSettingsUpdate,
  UtilityModelSlot,
} from "../../../../shared/apiTypes";
import { isKnownThinkingLevel } from "../../../../shared/thinkingLevels";
import "./SettingsPanelFrame";
import type { SettingsNotice } from "./SettingsPanelFrame";
import type { UtilityModelSettingsSupport } from "./settingsMachineTarget";
import {
  AUTO_UTILITY_MODEL_THINKING,
  updateUtilityModelDraftModel,
  updateUtilityModelDraftThinkingLevel,
  utilityModelSettingsDraftFromResponse,
  utilityModelSettingsUpdateFromDraft,
  utilityModelThinkingOptions,
  validateUtilityModelSettingsDraft,
  type UtilityModelDraftThinkingLevel,
  type UtilityModelSettingsDraft,
} from "./utilityModelSettingsDraft";

const SLOT_DETAILS: Record<UtilityModelSlot, { label: string; description: string; emptyLabel: string }> = {
  lightweight: {
    label: "Lightweight",
    description: "Titles and branch summaries",
    emptyLabel: "Use active session model",
  },
  context: {
    label: "Context",
    description: "Compaction and context summaries",
    emptyLabel: "Use lightweight, then active session model",
  },
};

@customElement("settings-utility-models-panel")
export class SettingsUtilityModelsPanel extends LitElement {
  @property({ attribute: false }) response: UtilityModelSettingsResponse | undefined;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) saving = false;
  @property() error = "";
  @property() savedMessage = "";
  @property() targetLabel = "selected machine";
  @property({ attribute: false }) support: UtilityModelSettingsSupport = { state: "supported" };
  @property({ attribute: false }) onReload?: () => void | Promise<void>;
  @property({ attribute: false }) onSave?: (update: UtilityModelSettingsUpdate) => void | Promise<void>;

  @state() draft: UtilityModelSettingsDraft = {};

  get editingDisabled(): boolean {
    return this.loading || this.saving || this.support.state !== "supported";
  }

  get canSave(): boolean {
    return this.response !== undefined &&
      validateUtilityModelSettingsDraft(this.draft, this.response).valid &&
      !this.editingDisabled;
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (!changed.has("response")) return;
    this.draft = this.response === undefined ? {} : utilityModelSettingsDraftFromResponse(this.response);
  }

  handleReload(): void {
    void this.onReload?.();
  }

  handleSave(): void {
    const response = this.response;
    if (!this.canSave || response === undefined) return;
    const update = utilityModelSettingsUpdateFromDraft(this.draft, response);
    if (update !== undefined && this.onSave !== undefined) void this.onSave(update);
  }

  handleModelChange(slot: UtilityModelSlot, option: UtilityModelOption | undefined): void {
    this.draft = updateUtilityModelDraftModel(this.draft, slot, option);
  }

  handleThinkingChange(slot: UtilityModelSlot, level: UtilityModelDraftThinkingLevel): void {
    this.draft = updateUtilityModelDraftThinkingLevel(this.draft, slot, level);
  }

  panelNotices(): readonly SettingsNotice[] {
    const notices: SettingsNotice[] = [];
    if (this.support.state === "unsupported") {
      notices.push({
        type: "availability",
        tone: "error",
        content: this.support.message ?? `Utility model settings are not available on ${this.targetLabel}. Update and restart PI WEBUI on that machine, then try again.`,
      });
    } else if (this.support.state === "unknown") {
      notices.push({
        type: "availability",
        tone: "warning",
        content: this.support.message ?? `Utility model settings support is unknown for ${this.targetLabel}.`,
      });
    }
    if (this.response?.contractVersion === 1) {
      notices.push({
        type: "info",
        content: `Explicit thinking levels require a newer PI WEBUI runtime on ${this.targetLabel}. Model routing remains available.`,
      });
    }
    if (this.error !== "") notices.push({ type: "error", content: this.error });
    if (this.response?.configError !== undefined && this.response.configError !== "") {
      notices.push({ type: "error", title: "Configuration error", content: this.response.configError });
    }
    if (this.savedMessage !== "") notices.push({ type: "success", content: this.savedMessage });
    return notices;
  }

  override render(): TemplateResult {
    return html`
      <settings-panel-frame
        heading="Utility models"
        description="Choose machine-global models for utility operations outside active sessions."
        actionLabel="Refresh models"
        actionTitle="Refresh available models and current utility model settings"
        .actionDisabled=${this.loading || this.saving}
        .notices=${this.panelNotices()}
        .onAction=${() => {
          this.handleReload();
        }}
      >
        ${this.response === undefined && this.loading
          ? html`<div class="loading-message">Loading utility model settings...</div>`
          : this.response === undefined
            ? html`<div class="loading-message">Utility model settings are unavailable. Click Refresh models to try again.</div>`
            : html`
                <div class="field-list">
                  <div class="field-header" aria-hidden="true">
                    <div></div>
                    <div>Model</div>
                    <div>Thinking</div>
                  </div>
                  ${this.renderFieldRow("lightweight")}
                  ${this.renderFieldRow("context")}
                </div>
                <footer class="panel-footer">
                  <button
                    class="primary"
                    ?disabled=${!this.canSave}
                    @click=${() => {
                      this.handleSave();
                    }}
                  >
                    ${this.saving ? "Saving..." : "Save utility models"}
                  </button>
                </footer>
              `}
      </settings-panel-frame>
    `;
  }

  private renderFieldRow(slot: UtilityModelSlot): TemplateResult {
    const response = this.response;
    if (response === undefined) return html``;

    const detail = SLOT_DETAILS[slot];
    const binding = this.draft[slot];
    const selectedOption = binding === undefined
      ? undefined
      : response.models.find((option) => sameModel(option.model, binding));
    const validation = validateUtilityModelSettingsDraft(this.draft, response).slots[slot];
    const modelId = `select-utility-model-${slot}`;
    const thinkingId = `select-utility-thinking-${slot}`;
    const thinkingOptions = utilityModelThinkingOptions(response, binding);
    const thinkingValue = response.contractVersion === 2 && selectedOption !== undefined
      ? binding?.thinkingLevel ?? AUTO_UTILITY_MODEL_THINKING
      : AUTO_UTILITY_MODEL_THINKING;
    const thinkingDisabled = this.editingDisabled ||
      response.contractVersion === 1 ||
      binding === undefined ||
      selectedOption === undefined;

    return html`
      <div class="field-row ${validation.valid ? "" : "invalid"}" data-slot=${slot}>
        <div class="field-copy">
          <span class="slot-label">${detail.label}</span>
          <p>${detail.description}</p>
        </div>
        <div class="field-control">
          <label class="field-label" for=${modelId}>Model</label>
          <select
            id=${modelId}
            aria-label=${`${slot} utility model`}
            aria-invalid=${String(!validation.valid)}
            ?disabled=${this.editingDisabled}
            .value=${binding === undefined ? "" : modelKey(binding)}
            @change=${(event: Event) => {
              this.onModelSelectChange(slot, event);
            }}
            title=${binding === undefined ? detail.emptyLabel : describeModel(binding)}
          >
            <option value="" ?selected=${binding === undefined}>${detail.emptyLabel}</option>
            ${binding !== undefined && selectedOption === undefined
              ? html`<option value=${modelKey(binding)} disabled selected>${describeModel(binding)} (unavailable)</option>`
              : null}
            ${response.models.map((option) => html`
              <option value=${modelKey(option.model)} ?selected=${binding !== undefined && sameModel(option.model, binding)}>
                ${describeOption(option)}
              </option>
            `)}
          </select>
        </div>
        <div class="field-control">
          <label class="field-label" for=${thinkingId}>Thinking</label>
          <select
            id=${thinkingId}
            aria-label=${`${slot} utility thinking`}
            aria-invalid=${String(!validation.valid)}
            ?disabled=${thinkingDisabled}
            .value=${thinkingValue}
            @change=${(event: Event) => {
              this.onThinkingSelectChange(slot, event);
            }}
          >
            ${thinkingOptions.map((option) => html`
              <option value=${option.value} ?disabled=${option.disabled} ?selected=${thinkingValue === option.value}>
                ${option.label}
              </option>
            `)}
          </select>
        </div>
        ${!validation.valid && validation.reason !== undefined && validation.reason !== ""
          ? html`<div class="row-error" role="alert">${validation.reason}</div>`
          : null}
      </div>
    `;
  }

  private onModelSelectChange(slot: UtilityModelSlot, event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const selectedKey = event.target.value;
    const option = this.response?.models.find((candidate) => modelKey(candidate.model) === selectedKey);
    this.handleModelChange(slot, option);
  }

  private onThinkingSelectChange(slot: UtilityModelSlot, event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const level = event.target.value;
    if (level !== AUTO_UTILITY_MODEL_THINKING && !isKnownThinkingLevel(level)) return;
    this.handleThinkingChange(slot, level);
  }

  static override styles = css`
    :host { display: block; }
    .loading-message { color: var(--pi-muted); }
    .field-list { display: grid; gap: 14px; }
    .field-header, .field-row { display: grid; grid-template-columns: minmax(140px, 0.6fr) minmax(220px, 1fr) minmax(120px, 140px); gap: 16px; }
    .field-header { align-items: end; padding: 0 0 4px; color: var(--pi-muted); font-size: 12px; font-weight: 600; }
    .field-row { align-items: center; padding: 0 0 14px; border-bottom: 1px solid var(--pi-border-muted); }
    .field-copy, .field-control { min-width: 0; }
    .field-control { display: grid; gap: 6px; }
    .slot-label { display: block; font-weight: 600; }
    p { margin: 4px 0 0; color: var(--pi-muted); font-size: 13px; line-height: 1.4; }
    .field-label { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    select { width: 100%; min-width: 0; box-sizing: border-box; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); padding: 7px 10px; font: inherit; font-size: 13px; }
    select[aria-invalid="true"] { border-color: var(--pi-danger); }
    select:disabled, button:disabled { opacity: 0.55; cursor: not-allowed; }
    .row-error { grid-column: 1 / -1; color: var(--pi-danger); font-size: 12px; }
    .panel-footer { display: flex; justify-content: flex-end; margin-top: 2px; }
    button.primary { border: 1px solid var(--pi-accent, #0066cc); border-radius: 8px; background: var(--pi-accent, #0066cc); color: #ffffff; padding: 8px 16px; font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; }

    @media (max-width: 760px) {
      .field-header { display: none; }
      .field-row { grid-template-columns: minmax(0, 1fr); gap: 8px; align-items: stretch; }
      .field-label { position: static; width: auto; height: auto; padding: 0; margin: 0; overflow: visible; clip: auto; white-space: normal; border: 0; font-weight: 600; }
      .panel-footer { display: block; }
      button.primary { width: 100%; }
    }
  `;
}

function sameModel(left: TierModelRef, right: TierModelRef): boolean {
  return left.provider === right.provider && left.id === right.id;
}

function modelKey(model: TierModelRef): string {
  return JSON.stringify([model.provider, model.id]);
}

function describeModel(model: TierModelRef): string {
  return `${model.provider}/${model.id}`;
}

function describeOption(option: UtilityModelOption): string {
  const model = describeModel(option.model);
  return option.name === undefined || option.name === "" ? model : `${option.name} (${model})`;
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-utility-models-panel": SettingsUtilityModelsPanel;
  }
}
