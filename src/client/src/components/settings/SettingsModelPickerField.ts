import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { TierModelRef } from "../../../../shared/apiTypes";
import "../CommandPicker";
import {
  describeSettingsModel,
  INHERITED_SETTINGS_MODEL_VALUE,
  settingsModelChoiceByKey,
  settingsModelKey,
  settingsModelPickerOptions,
  type SettingsModelChoice,
} from "./settingsModelOptions";

/**
 * Settings trigger that selects a model through the searchable, provider-grouped
 * `command-picker` dialog instead of a native `<select>`.
 *
 * Long model catalogs are impractical to scan in a dropdown, so this mirrors the
 * composer's Exact-mode selection: a compact trigger showing `provider/id` that
 * opens a searchable dialog. The component owns only the open/closed state of
 * that dialog; the selected value stays owned by the panel's draft and is
 * reported back through `onSelect`.
 */
@customElement("settings-model-picker-field")
export class SettingsModelPickerField extends LitElement {
  /** Id for the trigger so panels can keep their existing `<label for>` wiring. */
  @property() triggerId = "";
  @property() accessibleLabel = "";
  @property() dialogTitle = "Select Model";
  @property({ attribute: false }) choices: readonly SettingsModelChoice[] = [];
  @property({ attribute: false }) selected: TierModelRef | undefined;
  /** Label of the "no explicit model" entry. Omitted when a model is required. */
  @property() inheritedLabel = "";
  @property() placeholder = "Select a model…";
  @property({ type: Boolean }) disabled = false;
  @property({ type: Boolean }) invalid = false;
  @property({ attribute: false }) onSelect?: (model: TierModelRef | undefined) => void;

  @state() private pickerOpen = false;

  get isPickerOpen(): boolean {
    return this.pickerOpen;
  }

  override render(): TemplateResult {
    const selected = this.selected;
    const known = selected !== undefined && this.choices.some((choice) => sameModel(choice.model, selected));
    const summary = selected === undefined
      ? this.emptyLabel()
      : `${describeSettingsModel(selected)}${known ? "" : " (unavailable)"}`;

    return html`
      <button
        type="button"
        id=${this.triggerId}
        class="model-trigger ${selected === undefined ? "empty" : ""}"
        aria-label=${this.accessibleLabel === "" ? nothing : this.accessibleLabel}
        aria-haspopup="dialog"
        aria-expanded=${String(this.pickerOpen)}
        aria-invalid=${String(this.invalid)}
        ?disabled=${this.disabled}
        title=${this.triggerTitle(summary, known)}
        @click=${() => {
          this.showPicker();
        }}
      >
        <span class="model-summary">${summary}</span>
        <span class="model-chevron" aria-hidden="true">▾</span>
      </button>
      ${this.pickerOpen ? this.renderPicker() : null}
    `;
  }

  private renderPicker(): TemplateResult {
    const selected = this.selected;
    const options = settingsModelPickerOptions(
      this.choices,
      this.inheritedLabel === "" ? undefined : { label: this.inheritedLabel },
    );
    const selectedValue = selected === undefined
      ? (this.inheritedLabel === "" ? undefined : INHERITED_SETTINGS_MODEL_VALUE)
      : settingsModelKey(selected);

    /*
     * The settings dialog closes itself on Escape and on backdrop mousedown.
     * `command-picker` cancels and contains Escape at its dialog boundary; this
     * host remains the outer containment boundary for settings-specific events.
     */
    return html`
      <div
        class="picker-host"
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Escape") event.stopPropagation();
        }}
        @mousedown=${(event: MouseEvent) => {
          event.stopPropagation();
        }}
      >
        <command-picker
          title=${this.dialogTitle}
          .searchable=${true}
          .options=${options}
          .selectedValue=${selectedValue}
          .onPick=${(value: string) => {
            this.pickModel(value);
          }}
          .onCancel=${() => {
            this.closePicker();
          }}
        ></command-picker>
      </div>
    `;
  }

  showPicker(): void {
    if (this.disabled) return;
    this.pickerOpen = true;
  }

  private closePicker(): void {
    if (!this.pickerOpen) return;
    this.pickerOpen = false;
    void this.updateComplete.then(() => {
      if (this.isConnected) this.renderRoot.querySelector<HTMLElement>(".model-trigger")?.focus();
    });
  }

  private pickModel(value: string): void {
    if (value === INHERITED_SETTINGS_MODEL_VALUE) {
      if (this.inheritedLabel === "") return;
      this.closePicker();
      this.onSelect?.(undefined);
      return;
    }
    const choice = settingsModelChoiceByKey(this.choices, value);
    if (choice === undefined) return;
    this.closePicker();
    this.onSelect?.({ ...choice.model });
  }

  private emptyLabel(): string {
    return this.inheritedLabel === "" ? this.placeholder : this.inheritedLabel;
  }

  private triggerTitle(summary: string, known: boolean): string {
    const selected = this.selected;
    if (selected === undefined || !known) return summary;
    const name = this.choices.find((choice) => sameModel(choice.model, selected))?.name;
    return name === undefined || name === "" || name === selected.id ? summary : `${name} (${summary})`;
  }

  static override styles = css`
    :host { display: block; min-width: 0; }
    .model-trigger { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; min-width: 0; box-sizing: border-box; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); padding: 7px 10px; font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
    .model-trigger:hover:not(:disabled), .model-trigger:focus-visible { border-color: var(--pi-accent); }
    .model-trigger[aria-invalid="true"] { border-color: var(--pi-danger); }
    .model-trigger:disabled { opacity: 0.55; cursor: not-allowed; }
    .model-trigger.empty .model-summary { color: var(--pi-muted); }
    .model-summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .model-chevron { flex: 0 0 auto; color: var(--pi-muted); }
  `;
}

function sameModel(left: TierModelRef, right: TierModelRef): boolean {
  return left.provider === right.provider && left.id === right.id;
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-model-picker-field": SettingsModelPickerField;
  }
}
