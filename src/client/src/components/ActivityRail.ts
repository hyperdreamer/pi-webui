import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { DEFAULT_RAIL_ORDER, type ReorderableRailItem } from "../activityRailOrder";

const DESKTOP_RAIL_MEDIA_QUERY = "(min-width: 1181px)";
const REORDERABLE_IDS: readonly string[] = ["terminal", "browser", "git-update-manager", "theme", "system-prompt", "history", "info"];

function isReorderableItem(value: string): value is ReorderableRailItem {
  return REORDERABLE_IDS.includes(value);
}

@customElement("activity-rail")
export class ActivityRail extends LitElement {
  @property({ attribute: false }) onOpenTerminal?: () => void;
  @property({ attribute: false }) onOpenBrowser?: () => void;
  @property({ attribute: false }) onOpenGitUpdateManager?: () => void;
  @property({ attribute: false }) onOpenTheme?: () => void;
  @property({ attribute: false }) onOpenSystemPrompt?: () => void;
  @property({ attribute: false }) onOpenHistory?: () => void;
  @property({ attribute: false }) onOpenInfo?: () => void;
  @property({ attribute: false }) onOpenSettings?: () => void;
  @property({ type: Number }) terminalCount = 0;
  @property({ type: Number }) gitUpdateManagerCount = 0;
  @property({ type: Boolean }) systemPromptEnabled = false;
  @property({ type: Boolean }) historyEnabled = false;
  @property({ attribute: false }) railOrder: ReorderableRailItem[] = [...DEFAULT_RAIL_ORDER];
  @property({ attribute: false }) onRailOrderChange?: (order: ReorderableRailItem[]) => void;

  private desktopMedia: MediaQueryList | undefined;
  private dragItem: ReorderableRailItem | undefined;

  constructor() {
    super();
    if (typeof window !== "undefined" && "matchMedia" in window) {
      this.desktopMedia = window.matchMedia(DESKTOP_RAIL_MEDIA_QUERY);
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.desktopMedia?.addEventListener("change", this.onDesktopMediaChange);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.desktopMedia?.removeEventListener("change", this.onDesktopMediaChange);
  }

  private onDesktopMediaChange = () => {
    // Media change triggers a re-render; no popup state to clean up.
  };

  // -- Click handlers --

  private readonly openTerminal = (): void => { this.onOpenTerminal?.(); };
  private readonly openBrowser = (): void => { this.onOpenBrowser?.(); };
  private readonly openGitUpdateManager = (): void => { this.onOpenGitUpdateManager?.(); };
  private readonly openTheme = (): void => { this.onOpenTheme?.(); };
  private readonly openSystemPrompt = (): void => { this.onOpenSystemPrompt?.(); };
  private readonly openHistory = (): void => { this.onOpenHistory?.(); };
  private readonly openInfo = (): void => { this.onOpenInfo?.(); };
  private readonly openSettings = (): void => { this.onOpenSettings?.(); };

  // -- Drag-and-drop (reorderable items only) --

  private readonly onDragStart = (item: ReorderableRailItem, event: DragEvent): void => {
    this.dragItem = item;
    if (event.dataTransfer !== null) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", item);
    }
    requestAnimationFrame(() => {
      const el = this.renderRoot.querySelector(`[data-rail-item="${item}"]`);
      el?.classList.add("dragging");
    });
  };

  private readonly onDragEnd = (item: ReorderableRailItem): void => {
    this.dragItem = undefined;
    const el = this.renderRoot.querySelector(`[data-rail-item="${item}"]`);
    el?.classList.remove("dragging");
    this.renderRoot.querySelectorAll(".drag-over").forEach((el) => { el.classList.remove("drag-over"); });
  };

  private readonly onRailDragOver = (event: DragEvent): void => {
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move";
    if (this.dragItem === undefined) return;

    const target = this.resolveDragTarget(event.target);
    this.renderRoot.querySelectorAll(".drag-over").forEach((el) => { el.classList.remove("drag-over"); });
    if (target !== null && target.dataset["railItem"] !== this.dragItem) {
      target.classList.add("drag-over");
    }
  };

  private readonly onRailDrop = (event: DragEvent): void => {
    event.preventDefault();
    this.renderRoot.querySelectorAll(".drag-over").forEach((el) => { el.classList.remove("drag-over"); });

    if (this.dragItem === undefined) return;
    const target = this.resolveDragTarget(event.target);
    if (target === null || target.dataset["railItem"] === this.dragItem) {
      this.dragItem = undefined;
      return;
    }

    const targetId = target.dataset["railItem"];
    if (targetId === undefined || !isReorderableItem(targetId)) {
      this.dragItem = undefined;
      return;
    }

    const current = [...this.railOrder];
    const fromIndex = current.indexOf(this.dragItem);
    const toIndex = current.indexOf(targetId);
    if (fromIndex === -1 || toIndex === -1) {
      this.dragItem = undefined;
      return;
    }

    current.splice(fromIndex, 1);
    current.splice(toIndex, 0, this.dragItem);
    this.railOrder = current;
    this.onRailOrderChange?.(current);
    this.dragItem = undefined;
  };

  private resolveDragTarget(target: EventTarget | null): HTMLElement | null {
    if (target === null || !(target instanceof HTMLElement)) return null;
    const el = target.closest("[data-rail-item]");
    return el instanceof HTMLElement ? el : null;
  }

  // -- Button rendering --

  /** Returns drag attributes for reorderable items only (settings is fixed). */
  private dndProps(item: ReorderableRailItem) {
    return {
      draggable: "true",
      "data-rail-item": item,
    };
  }

  private renderReorderableButton(item: ReorderableRailItem): TemplateResult {
    switch (item) {
      case "terminal": return this.renderTerminalButton();
      case "browser": return this.renderBrowserButton();
      case "git-update-manager": return this.renderGitUpdateManagerButton();
      case "theme": return this.renderThemeButton();
      case "system-prompt": return this.renderSystemPromptButton();
      case "history": return this.renderHistoryButton();
      case "info": return this.renderInfoButton();
    }
  }

  private renderTerminalButton(): TemplateResult {
    const p = this.dndProps("terminal");
    const badge = this.terminalCount > 0 ? this.terminalCount : undefined;
    const badgeLabel = badge === undefined ? "" : `${String(badge)} active terminal${badge === 1 ? "" : "s"}`;
    return html`
      <button
        type="button"
        class="icon-button terminal-button"
        title="Terminal"
        aria-label=${`Open terminal${badgeLabel === "" ? "" : `, ${badgeLabel}`}`}
        @click=${this.openTerminal}
        draggable=${p.draggable}
        data-rail-item=${p["data-rail-item"]}
        @dragstart=${(event: DragEvent) => { this.onDragStart("terminal", event); }}
        @dragend=${() => { this.onDragEnd("terminal"); }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
          <rect x="3" y="5" width="18" height="14" rx="2"/>
          <path d="m7 10 3 3-3 3"/>
          <path d="M12 16h5"/>
        </svg>
        ${badge === undefined ? nothing : html`<span class="rail-badge" aria-hidden="true">${badge}</span>`}
      </button>
    `;
  }

  private renderBrowserButton(): TemplateResult {
    const p = this.dndProps("browser");
    return html`
      <button
        type="button"
        class="icon-button browser-button"
        title="Browser"
        aria-label="Open browser"
        @click=${this.openBrowser}
        draggable=${p.draggable}
        data-rail-item=${p["data-rail-item"]}
        @dragstart=${(event: DragEvent) => { this.onDragStart("browser", event); }}
        @dragend=${() => { this.onDragEnd("browser"); }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="9"/>
          <path d="M3 12h18"/>
          <path d="M12 3a14 14 0 0 1 0 18"/>
          <path d="M12 3a14 14 0 0 0 0 18"/>
        </svg>
      </button>
    `;
  }

  private renderGitUpdateManagerButton(): TemplateResult {
    const p = this.dndProps("git-update-manager");
    const badge = this.gitUpdateManagerCount > 0 ? this.gitUpdateManagerCount : undefined;
    const badgeLabel = badge === undefined ? "" : `${String(badge)} changed file${badge === 1 ? "" : "s"}`;
    return html`
      <button
        type="button"
        class="icon-button git-update-manager-button"
        title="Git Update Manager"
        aria-label=${`Open Git Update Manager${badgeLabel === "" ? "" : `, ${badgeLabel}`}`}
        @click=${this.openGitUpdateManager}
        draggable=${p.draggable}
        data-rail-item=${p["data-rail-item"]}
        @dragstart=${(event: DragEvent) => { this.onDragStart("git-update-manager", event); }}
        @dragend=${() => { this.onDragEnd("git-update-manager"); }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
          <circle cx="6" cy="5" r="2"/>
          <circle cx="18" cy="7" r="2"/>
          <circle cx="18" cy="19" r="2"/>
          <path d="M6 7v8a4 4 0 0 0 4 4h6"/>
          <path d="M10 5h6"/>
        </svg>
        ${badge === undefined ? nothing : html`<span class="rail-badge" aria-hidden="true">${badge}</span>`}
      </button>
    `;
  }

  private renderThemeButton(): TemplateResult {
    const p = this.dndProps("theme");
    return html`
      <button
        type="button"
        class="icon-button theme-button"
        title="Theme"
        aria-label="Open theme picker"
        @click=${this.openTheme}
        draggable=${p.draggable}
        data-rail-item=${p["data-rail-item"]}
        @dragstart=${(event: DragEvent) => { this.onDragStart("theme", event); }}
        @dragend=${() => { this.onDragEnd("theme"); }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
          <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5Z"/>
        </svg>
      </button>
    `;
  }

  private renderSystemPromptButton(): TemplateResult {
    const p = this.dndProps("system-prompt");
    return html`
      <button
        type="button"
        class="icon-button system-prompt-button"
        title="System prompt"
        aria-label="Open system prompt"
        ?disabled=${!this.systemPromptEnabled}
        @click=${this.openSystemPrompt}
        draggable=${p.draggable}
        data-rail-item=${p["data-rail-item"]}
        @dragstart=${(event: DragEvent) => { this.onDragStart("system-prompt", event); }}
        @dragend=${() => { this.onDragEnd("system-prompt"); }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="8" y1="13" x2="16" y2="13"/>
          <line x1="8" y1="17" x2="13" y2="17"/>
        </svg>
      </button>
    `;
  }

  private renderHistoryButton(): TemplateResult {
    const p = this.dndProps("history");
    return html`
      <button
        type="button"
        class="icon-button history-button"
        title="Full history"
        aria-label="Open full history"
        ?disabled=${!this.historyEnabled}
        @click=${this.openHistory}
        draggable=${p.draggable}
        data-rail-item=${p["data-rail-item"]}
        @dragstart=${(event: DragEvent) => { this.onDragStart("history", event); }}
        @dragend=${() => { this.onDragEnd("history"); }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8"/>
          <path d="M3 3v5h5"/>
          <path d="M12 7v5l3 2"/>
        </svg>
      </button>
    `;
  }

  private renderInfoButton(): TemplateResult {
    const p = this.dndProps("info");
    return html`
      <button
        type="button"
        class="icon-button info-button"
        title="System Info"
        aria-label="Open system info"
        @click=${this.openInfo}
        draggable=${p.draggable}
        data-rail-item=${p["data-rail-item"]}
        @dragstart=${(event: DragEvent) => { this.onDragStart("info", event); }}
        @dragend=${() => { this.onDragEnd("info"); }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
          <rect x="2" y="3" width="20" height="14" rx="2"/>
          <path d="M8 21h8"/>
          <path d="M12 17v4"/>
        </svg>
      </button>
    `;
  }

  private renderSettingsButton(): TemplateResult {
    return html`
      <button
        type="button"
        class="icon-button settings-button"
        title="Settings"
        aria-label="Open settings"
        @click=${this.openSettings}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
    `;
  }

  override render() {
    const isDesktop = this.desktopMedia?.matches ?? true;
    if (!isDesktop) return html``;

    const order = this.railOrder.length === 0 ? [...DEFAULT_RAIL_ORDER] : this.railOrder;
    return html`
      <nav
        class="rail"
        aria-label="Activity rail"
        @dragover=${this.onRailDragOver}
        @drop=${this.onRailDrop}
      >
        ${order.map((item) => this.renderReorderableButton(item))}
        <div class="rail-spacer"></div>
        ${this.renderSettingsButton()}
      </nav>
    `;
  }

  static override styles = css`
    :host {
      display: block;
      flex: 0 0 auto;
      min-height: 0;
    }
    .rail {
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 44px;
      height: 100%;
      border-right: 1px solid var(--pi-border);
      background: var(--pi-bg);
      gap: 8px;
      padding-top: 12px;
      box-sizing: border-box;
    }
    .icon-button {
      position: relative;
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      padding: 0;
      border: 1px solid var(--pi-border);
      border-radius: 8px;
      background: var(--pi-surface);
      color: var(--pi-muted);
      cursor: pointer;
      transition: opacity 0.15s ease, box-shadow 0.15s ease;
    }
    .rail-badge {
      position: absolute;
      top: -3px;
      right: -3px;
      display: inline-block;
      min-width: 14px;
      border: 1px solid var(--pi-success-border);
      border-radius: 999px;
      background: var(--pi-success-surface);
      color: var(--pi-success);
      padding: 0 5px;
      font-size: 11px;
      line-height: 16px;
      text-align: center;
      pointer-events: none;
    }
    .icon-button:not(:disabled):hover {
      background: var(--pi-surface-hover);
      color: var(--pi-text);
    }
    .icon-button:disabled { color: var(--pi-dim); cursor: default; opacity: .6; }
    .icon-button:focus-visible {
      outline: 2px solid var(--pi-accent);
      outline-offset: 2px;
    }
    .icon-button.dragging { opacity: 0.4; }
    .icon-button.drag-over {
      box-shadow: 0 -2px 0 0 var(--pi-accent);
    }
    .rail-spacer { flex: 1 1 auto; min-height: 0; }
    .settings-button { margin-bottom: 12px; }
  `;
}
