import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
  TierModelRef,
  UtilityModelOption,
  UtilityModelSettings,
  UtilityModelSettingsResponse,
  UtilityModelSettingsUpdate,
  UtilityModelSlot,
} from "../../../../shared/apiTypes";
import "./SettingsPanelFrame";
import type { SettingsNotice } from "./SettingsPanelFrame";
import type { UtilityModelSettingsSupport } from "./settingsMachineTarget";

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

  @state() draft: UtilityModelSettings = {};

  get editingDisabled(): boolean {
    return this.loading || this.saving || this.support.state !== "supported";
  }

  get canSave(): boolean {
    return this.isDraftValid() && !this.editingDisabled;
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (!changed.has("response")) return;
    this.draft = this.response === undefined ? {} : { ...this.response.settings };
  }

  handleReload(): void {
    void this.onReload?.();
  }

  handleSave(): void {
    if (!this.canSave) return;
    void this.onSave?.({
      lightweight: this.draft.lightweight ?? null,
      context: this.draft.context ?? null,
    });
  }

  handleModelChange(slot: UtilityModelSlot, option: UtilityModelOption | undefined): void {
    this.draft = option === undefined
      ? withoutUtilityModel(this.draft, slot)
      : { ...this.draft, [slot]: option.model };
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
    const detail = SLOT_DETAILS[slot];
    const selectedRef = this.draft[slot];
    const models = this.response?.models ?? [];
    const selectedOption = selectedRef === undefined ? undefined : models.find((option) => sameModel(option.model, selectedRef));
    const valid = selectedRef === undefined || selectedOption !== undefined;
    const selectId = `select-utility-model-${slot}`;

    return html`
      <div class="field-row">
        <div class="field-copy">
          <label for=${selectId}>${detail.label}</label>
          <p>${detail.description}</p>
        </div>
        <select
          id=${selectId}
          aria-label=${`${detail.label} utility model`}
          aria-invalid=${String(!valid)}
          ?disabled=${this.editingDisabled}
          .value=${selectedRef === undefined ? "" : modelKey(selectedRef)}
          @change=${(event: Event) => {
            this.onModelSelectChange(slot, event);
          }}
          title=${selectedRef === undefined ? detail.emptyLabel : describeModel(selectedRef)}
        >
          <option value="" ?selected=${selectedRef === undefined}>${detail.emptyLabel}</option>
          ${selectedRef !== undefined && selectedOption === undefined
            ? html`<option value=${modelKey(selectedRef)} disabled selected>${describeModel(selectedRef)} (unavailable)</option>`
            : null}
          ${models.map((option) => html`
            <option value=${modelKey(option.model)} ?selected=${selectedRef !== undefined && sameModel(option.model, selectedRef)}>
              ${describeOption(option)}
            </option>
          `)}
        </select>
      </div>
    `;
  }

  private onModelSelectChange(slot: UtilityModelSlot, event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const selectedKey = event.target.value;
    const option = (this.response?.models ?? []).find((candidate) => modelKey(candidate.model) === selectedKey);
    this.handleModelChange(slot, option);
  }

  private isDraftValid(): boolean {
    const models = this.response?.models ?? [];
    return this.isAvailable(this.draft.lightweight, models) && this.isAvailable(this.draft.context, models);
  }

  private isAvailable(model: TierModelRef | undefined, models: readonly UtilityModelOption[]): boolean {
    return model === undefined || models.some((option) => sameModel(option.model, model));
  }

  static override styles = css`
    :host { display: block; }
    .loading-message { color: var(--pi-muted); }
    .field-list { display: grid; gap: 14px; }
    .field-row { display: grid; grid-template-columns: minmax(160px, 0.6fr) minmax(0, 1fr); gap: 16px; align-items: center; padding: 0 0 14px; border-bottom: 1px solid var(--pi-border-muted); }
    .field-copy { min-width: 0; }
    label { display: block; font-weight: 600; }
    p { margin: 4px 0 0; color: var(--pi-muted); font-size: 13px; line-height: 1.4; }
    select { width: 100%; min-width: 0; box-sizing: border-box; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); padding: 7px 10px; font: inherit; font-size: 13px; }
    select[aria-invalid="true"] { border-color: var(--pi-danger); }
    select:disabled, button:disabled { opacity: 0.55; cursor: not-allowed; }
    .panel-footer { display: flex; justify-content: flex-end; margin-top: 2px; }
    button.primary { border: 1px solid var(--pi-accent, #0066cc); border-radius: 8px; background: var(--pi-accent, #0066cc); color: #ffffff; padding: 8px 16px; font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; }

    @media (max-width: 760px) {
      .field-row { grid-template-columns: minmax(0, 1fr); gap: 8px; }
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

function withoutUtilityModel(settings: UtilityModelSettings, slot: UtilityModelSlot): UtilityModelSettings {
  if (slot === "lightweight") {
    return settings.context === undefined ? {} : { context: settings.context };
  }
  return settings.lightweight === undefined ? {} : { lightweight: settings.lightweight };
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-utility-models-panel": SettingsUtilityModelsPanel;
  }
}
