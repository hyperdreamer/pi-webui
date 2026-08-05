import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { CommandOption } from "../api";
import { scrollWhenSelected } from "./scrollWhenSelected";
import { commandPickerStyles } from "./shared";

@customElement("command-picker")
export class CommandPicker extends LitElement {
  @property() override title = "Select";
  @property({ type: Boolean }) searchable = false;
  @property({ attribute: false }) options: CommandOption[] = [];
  @property({ attribute: false }) selectedValue?: string;
  @property({ attribute: false }) onPick?: (value: string) => void;
  @property({ attribute: false }) onCancel?: () => void;
  @state() private selectedIndex = 0;
  @state() private query = "";

  override render() {
    const options = this.filteredOptions();
    return html`
      <div class="backdrop" @mousedown=${() => this.onCancel?.()}>
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="command-picker-title"
          tabindex="-1"
          @mousedown=${(event: MouseEvent) => { event.stopPropagation(); }}
          @keydown=${(event: KeyboardEvent) => { this.handleDialogKeyDown(event); }}
        >
          <header>
            <strong id="command-picker-title">${this.title}</strong>
            <button type="button" aria-label=${`Close ${this.title}`} @click=${() => this.onCancel?.()}>×</button>
          </header>
          ${this.searchable ? html`<input aria-label="Search options" placeholder="Search" .value=${this.query} @input=${(event: Event) => { this.handleSearchInput(event); }}>` : null}
          <div class="options" tabindex="0">
            ${options.length === 0 ? html`<div class="empty">No matching options</div>` : this.renderGroupedOptions(options)}
          </div>
        </section>
      </div>
    `;
  }

  override firstUpdated() {
    this.selectInitialValue();
    this.renderRoot.querySelector<HTMLElement>(this.searchable ? "input" : ".options")?.focus();
  }

  private selectInitialValue(): void {
    if (this.selectedValue === undefined) return;
    const index = this.filteredOptions().findIndex((option) => option.value === this.selectedValue);
    if (index >= 0) this.selectedIndex = index;
  }

  private handleSearchInput(event: Event): void {
    if (event.target instanceof HTMLInputElement) {
      this.query = event.target.value;
      this.selectedIndex = 0;
    }
  }

  private filteredOptions(): CommandOption[] {
    const query = this.query.trim().toLowerCase();
    if (query === "") return this.options;
    return this.options.filter((option) => `${option.label} ${option.description ?? ""} ${option.value}`.toLowerCase().includes(query));
  }

  private renderGroupedOptions(options: CommandOption[]) {
    const groups: { group: string | undefined; items: { option: CommandOption; index: number }[] }[] = [];
    for (const [i, option] of options.entries()) {
      const last = groups[groups.length - 1];
      if (last !== undefined && last.group === option.group) {
        last.items.push({ option, index: i });
      } else {
        groups.push({ group: option.group, items: [{ option, index: i }] });
      }
    }
    return groups.map((group) => {
      const labelled = group.group !== undefined && group.group !== "";
      const header = labelled
        ? html`<div class="group-header">${group.group}</div>`
        : null;
      return html`
        ${header}
        ${group.items.map(({ option, index }) => html`
          <button class="${index === this.selectedIndex ? "selected" : ""}${labelled ? " grouped" : ""}" ${scrollWhenSelected(index === this.selectedIndex, option.value)} @click=${() => this.onPick?.(option.value)}>
            <span>${option.label}</span>
            ${option.description !== undefined && option.description !== "" ? html`<small>${option.description}</small>` : null}
          </button>
        `)}
      `;
    });
  }

  private handleDialogKeyDown(event: KeyboardEvent): void {
    if (event.key === "Tab") {
      event.stopPropagation();
      this.trapTabFocus(event);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.onCancel?.();
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLInputElement) && !(target instanceof Element && target.closest(".options") !== null)) {
      return;
    }
    this.handleOptionKeyDown(event);
  }

  private trapTabFocus(event: KeyboardEvent): void {
    const focusable = [...this.renderRoot.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), [tabindex='0']",
    )];
    if (focusable.length === 0) {
      event.preventDefault();
      this.renderRoot.querySelector<HTMLElement>("section[role='dialog']")?.focus();
      return;
    }
    const activeIndex = focusable.findIndex((element) => element === this.shadowRoot?.activeElement);
    const movingPastEnd = !event.shiftKey && activeIndex === focusable.length - 1;
    const movingBeforeStart = event.shiftKey && activeIndex <= 0;
    const focusIsOutside = activeIndex < 0;
    if (!movingPastEnd && !movingBeforeStart && !focusIsOutside) return;
    event.preventDefault();
    (event.shiftKey ? focusable.at(-1) : focusable[0])?.focus();
  }

  private handleOptionKeyDown(event: KeyboardEvent): void {
    const options = this.filteredOptions();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (options.length > 0) this.selectedIndex = (this.selectedIndex + 1) % options.length;
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length > 0) this.selectedIndex = (this.selectedIndex - 1 + options.length) % options.length;
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = options[this.selectedIndex];
      if (option) this.onPick?.(option.value);
    }
  }

  static override styles = commandPickerStyles;
}
