import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { customElement, property, state } from "lit/decorators.js";
import {
  BLANK_BROWSER_URL,
  browserTabLabel,
  clampBrowserZoom,
  createBrowserTabsState,
  normalizeBrowserAddress,
  readBrowserZoom,
  updateBrowserTabs,
  writeBrowserZoom,
  type BrowserTab,
  type BrowserTabsState,
} from "../browserTabs";
import {
  fitTerminalModalBounds as fitBrowserPanelBounds,
  moveTerminalModal as moveBrowserPanel,
  resizeTerminalModal as resizeBrowserPanel,
  type TerminalModalBounds as BrowserPanelBounds,
  type TerminalModalViewport as BrowserPanelViewport,
} from "../terminalModalGeometry";

const BROWSER_ZOOM_STEP = 10;

interface BrowserPanelPointerInteraction {
  operation: "move" | "resize";
  pointerId: number;
  target: HTMLElement;
  startClientX: number;
  startClientY: number;
  bounds: BrowserPanelBounds;
}

interface BrowserPanelPointerEvent {
  button: number;
  pointerId: number;
  clientX: number;
  clientY: number;
  currentTarget: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}

@customElement("browser-panel")
export class BrowserPanel extends LitElement {
  @property({ attribute: false }) onClose?: () => void;

  @state() private browserTabs: BrowserTabsState = createBrowserTabsState("browser-tab-1");
  @state() private address = "";
  @state() private addressError = "";
  @state() private zoom = readBrowserZoom();
  @state() private bounds: BrowserPanelBounds | undefined;

  private nextTabNumber = 2;
  private pointerInteraction: BrowserPanelPointerInteraction | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("resize", this.onViewportResize);
  }

  override disconnectedCallback(): void {
    this.finishPointerInteraction();
    window.removeEventListener("resize", this.onViewportResize);
    super.disconnectedCallback();
  }

  override render(): TemplateResult {
    return html`
      <div
        class="browser-backdrop"
        role="dialog"
        aria-modal="true"
        aria-label="Browser"
        @click=${this.closeFromBackdrop}
        @keydown=${this.closeFromEscape}
      >
        <section class=${this.bounds === undefined ? "browser-frame" : "browser-frame browser-frame-positioned"} style=${this.frameStyle()}>
          <header class="browser-header">
            <span
              class="browser-drag-handle"
              @pointerdown=${this.handleMovePointerDown}
              @pointermove=${this.handlePointerMove}
              @pointerup=${this.handlePointerUp}
              @pointercancel=${this.handlePointerCancel}
            >Browser</span>
            <span class="browser-zoom-controls" aria-label="Page zoom controls">
              <button type="button" class="browser-zoom-button" @click=${() => { this.adjustZoom(-BROWSER_ZOOM_STEP); }} aria-label="Decrease page zoom">−</button>
              <span class="browser-zoom-value">${this.zoom}%</span>
              <button type="button" class="browser-zoom-button" @click=${() => { this.adjustZoom(BROWSER_ZOOM_STEP); }} aria-label="Increase page zoom">+</button>
            </span>
            <button type="button" class="browser-close-button" @click=${this.close} aria-label="Close browser">×</button>
          </header>
          <div class="browser-tabs" role="tablist" aria-label="Browser tabs">
            ${this.browserTabs.tabs.map((tab) => this.renderTab(tab))}
            <button type="button" class="add-tab" @click=${this.addTab} aria-label="New tab" title="New tab">+</button>
          </div>
          <div class="address-area">
            <form class="address-form" @submit=${this.submitAddress}>
              <input
                type="text"
                inputmode="url"
                autocomplete="url"
                spellcheck="false"
                aria-label="Address"
                placeholder="Enter a web address"
                .value=${this.address}
                @input=${this.updateAddress}
              />
              <button type="submit" class="navigate-button">Go</button>
              <button type="button" class="reload-button" @click=${this.reloadActiveTab} aria-label="Reload page" title="Reload page">↻</button>
            </form>
            ${this.addressError === "" ? null : html`<p class="address-error" role="alert">${this.addressError}</p>`}
          </div>
          <div class="browser-page-viewport" role="tabpanel" aria-label="Browser page">
            ${this.renderKeyedEmbeddedPage()}
          </div>
          <div
            class="browser-resize-handle"
            title="Drag to resize browser"
            aria-hidden="true"
            @pointerdown=${this.handleResizePointerDown}
            @pointermove=${this.handlePointerMove}
            @pointerup=${this.handlePointerUp}
            @pointercancel=${this.handlePointerCancel}
          ></div>
        </section>
      </div>
    `;
  }

  private renderTab(tab: BrowserTab): TemplateResult {
    const selected = tab.id === this.browserTabs.activeTabId;
    const label = browserTabLabel(tab.url);
    return html`
      <span class=${selected ? "browser-tab selected" : "browser-tab"}>
        <button
          type="button"
          class="browser-tab-select"
          role="tab"
          aria-selected=${String(selected)}
          title=${label}
          @click=${() => { this.selectTab(tab.id); }}
        >${label}</button>
        <button type="button" class="browser-tab-close" aria-label=${`Close ${label}`} @click=${() => { this.closeTab(tab.id); }}>×</button>
      </span>
    `;
  }

  private renderKeyedEmbeddedPage() {
    const tab = this.activeTab();
    if (tab === undefined) return nothing;
    return keyed(`${tab.id}:${String(tab.reloadRevision)}`, this.renderEmbeddedPage());
  }

  private renderEmbeddedPage(): TemplateResult {
    const tab = this.activeTab();
    if (tab === undefined) return html``;
    const label = browserTabLabel(tab.url);
    return html`
      <div class="browser-page-scale" style=${`--browser-page-zoom: ${String(this.zoom / 100)};`}>
        <iframe
          title=${`Browser: ${label}`}
          src=${tab.url}
          sandbox="allow-forms allow-scripts"
          referrerpolicy="no-referrer"
        ></iframe>
      </div>
    `;
  }

  private readonly addTab = (): void => {
    const tabId = `browser-tab-${String(this.nextTabNumber)}`;
    this.nextTabNumber += 1;
    this.browserTabs = updateBrowserTabs(this.browserTabs, { type: "add", tabId });
    this.address = "";
    this.addressError = "";
  };

  private selectTab(tabId: string): void {
    const tabs = updateBrowserTabs(this.browserTabs, { type: "select", tabId });
    if (tabs === this.browserTabs) return;
    this.browserTabs = tabs;
    this.address = addressForTab(this.activeTab());
    this.addressError = "";
  }

  private closeTab(tabId: string): void {
    const tabs = updateBrowserTabs(this.browserTabs, { type: "close", tabId });
    if (tabs === this.browserTabs) return;
    this.browserTabs = tabs;
    const activeTab = this.activeTab();
    this.address = addressForTab(activeTab);
    this.addressError = "";
    if (activeTab === undefined) this.close();
  }

  private readonly submitAddress = (event: SubmitEvent): void => {
    event.preventDefault();
    const url = normalizeBrowserAddress(this.address);
    if (url === undefined) {
      this.addressError = "Enter a valid http:// or https:// address.";
      return;
    }

    const activeTabId = this.browserTabs.activeTabId;
    if (activeTabId === undefined) return;
    this.browserTabs = updateBrowserTabs(this.browserTabs, { type: "navigate", tabId: activeTabId, url });
    this.address = url;
    this.addressError = "";
  };

  private readonly updateAddress = (event: Event): void => {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    this.address = input.value;
    this.addressError = "";
  };

  private readonly reloadActiveTab = (): void => {
    const activeTabId = this.browserTabs.activeTabId;
    if (activeTabId === undefined) return;
    this.browserTabs = updateBrowserTabs(this.browserTabs, { type: "reload", tabId: activeTabId });
  };

  private adjustZoom(delta: number): void {
    const zoom = clampBrowserZoom(this.zoom + delta);
    if (zoom === this.zoom) return;
    this.zoom = zoom;
    writeBrowserZoom(zoom);
  }

  private readonly closeFromBackdrop = (event: MouseEvent): void => {
    if (event.target === event.currentTarget) this.close();
  };

  private readonly closeFromEscape = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    this.close();
  };

  private readonly close = (): void => {
    this.finishPointerInteraction();
    this.onClose?.();
  };

  private readonly onViewportResize = (): void => {
    if (this.bounds === undefined) return;
    this.bounds = fitBrowserPanelBounds(this.bounds, this.viewport());
  };

  private readonly handleMovePointerDown = (event: BrowserPanelPointerEvent): void => {
    this.startPointerInteraction("move", event);
  };

  private readonly handleResizePointerDown = (event: BrowserPanelPointerEvent): void => {
    this.startPointerInteraction("resize", event);
  };

  private readonly handlePointerMove = (event: BrowserPanelPointerEvent): void => {
    const interaction = this.pointerInteraction;
    if (interaction?.pointerId !== event.pointerId) return;
    event.preventDefault();
    const delta = { x: event.clientX - interaction.startClientX, y: event.clientY - interaction.startClientY };
    this.bounds = interaction.operation === "move"
      ? moveBrowserPanel(interaction.bounds, delta, this.viewport())
      : resizeBrowserPanel(interaction.bounds, delta, this.viewport());
  };

  private readonly handlePointerUp = (event: BrowserPanelPointerEvent): void => {
    if (this.pointerInteraction?.pointerId !== event.pointerId) return;
    event.preventDefault();
    this.finishPointerInteraction();
  };

  private readonly handlePointerCancel = (event: BrowserPanelPointerEvent): void => {
    if (this.pointerInteraction?.pointerId !== event.pointerId) return;
    this.finishPointerInteraction();
  };

  private startPointerInteraction(operation: BrowserPanelPointerInteraction["operation"], event: BrowserPanelPointerEvent): void {
    if (event.button !== 0) return;
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const frame = target.closest(".browser-frame");
    if (!(frame instanceof HTMLElement)) return;

    event.preventDefault();
    event.stopPropagation();
    const bounds = fitBrowserPanelBounds(this.boundsFromFrame(frame), this.viewport());
    target.setPointerCapture(event.pointerId);
    this.bounds = bounds;
    this.pointerInteraction = {
      operation,
      pointerId: event.pointerId,
      target,
      startClientX: event.clientX,
      startClientY: event.clientY,
      bounds,
    };
  }

  private boundsFromFrame(frame: HTMLElement): BrowserPanelBounds {
    const { left, top, width, height } = frame.getBoundingClientRect();
    return { left, top, width, height };
  }

  private viewport(): BrowserPanelViewport {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  private frameStyle(): string {
    const bounds = this.bounds;
    return bounds === undefined
      ? ""
      : `left: ${String(bounds.left)}px; top: ${String(bounds.top)}px; width: ${String(bounds.width)}px; height: ${String(bounds.height)}px;`;
  }

  private finishPointerInteraction(): void {
    const interaction = this.pointerInteraction;
    if (interaction === undefined) return;
    try {
      interaction.target.releasePointerCapture(interaction.pointerId);
    } catch {
      // Pointer capture may already be gone after a browser cancellation.
    }
    this.pointerInteraction = undefined;
  }

  private activeTab(): BrowserTab | undefined {
    const activeTabId = this.browserTabs.activeTabId;
    return activeTabId === undefined ? undefined : this.browserTabs.tabs.find((tab) => tab.id === activeTabId);
  }

  static override styles = css`
    :host { position: fixed; inset: 0; z-index: 80; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    * { box-sizing: border-box; }
    .browser-backdrop { width: 100%; height: 100dvh; display: grid; place-items: center; padding: 16px; background: rgba(0, 0, 0, .48); }
    .browser-frame { position: relative; display: grid; grid-template-rows: auto auto auto minmax(0, 1fr); width: min(calc(100vw - 32px), 1280px); height: min(calc(100vh - 32px), 880px); overflow: hidden; border: 1px solid var(--pi-border); border-radius: 14px; background: var(--pi-bg); box-shadow: 0 20px 64px var(--pi-shadow-strong); }
    .browser-frame-positioned { position: fixed; }
    .browser-header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--pi-border); background: var(--pi-surface); color: var(--pi-text); font-size: 14px; font-weight: 600; }
    .browser-drag-handle { flex: 1 1 auto; align-self: stretch; min-width: 0; display: flex; align-items: center; cursor: move; touch-action: none; -webkit-user-select: none; user-select: none; }
    .browser-zoom-controls { display: inline-flex; align-items: center; gap: 4px; }
    .browser-zoom-button, .browser-close-button, .add-tab, .navigate-button, .reload-button, .browser-tab-select, .browser-tab-close { border: 1px solid var(--pi-border); background: var(--pi-surface); color: var(--pi-text); cursor: pointer; }
    .browser-zoom-button, .browser-close-button { display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0; border-radius: 6px; font-size: 16px; line-height: 1; }
    .browser-zoom-value { min-width: 38px; color: var(--pi-muted); font-size: 12px; font-weight: 400; text-align: center; }
    .browser-tabs { display: flex; align-items: center; gap: 5px; min-width: 0; padding: 7px 10px; overflow-x: auto; border-bottom: 1px solid var(--pi-border); background: var(--pi-bg); }
    .browser-tab { display: inline-flex; flex: 0 0 auto; min-width: 0; overflow: hidden; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); }
    .browser-tab.selected { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    .browser-tab-select { min-width: 0; max-width: 180px; overflow: hidden; border: 0; padding: 5px 8px; background: transparent; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
    .browser-tab-close { width: 26px; border: 0; border-left: 1px solid var(--pi-border); background: transparent; font-size: 16px; }
    .add-tab { flex: 0 0 auto; width: 28px; height: 28px; padding: 0; border-radius: 7px; font-size: 18px; line-height: 1; }
    .address-area { min-width: 0; border-bottom: 1px solid var(--pi-border); background: var(--pi-bg); }
    .address-form { display: flex; gap: 7px; min-width: 0; padding: 9px 10px; }
    .address-form input { flex: 1 1 auto; min-width: 0; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; font: inherit; }
    .navigate-button, .reload-button { flex: 0 0 auto; border-radius: 7px; padding: 7px 9px; font: inherit; }
    .reload-button { width: 34px; padding: 0; font-size: 17px; }
    .address-error { margin: 0; padding: 0 10px 8px; color: var(--pi-danger); font-size: 12px; }
    .browser-page-viewport { min-width: 0; min-height: 0; overflow: hidden; background: #fff; }
    .browser-page-scale { width: calc(100% / var(--browser-page-zoom)); height: calc(100% / var(--browser-page-zoom)); transform: scale(var(--browser-page-zoom)); transform-origin: top left; }
    iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
    .browser-resize-handle { position: absolute; right: 0; bottom: 0; z-index: 1; width: 20px; height: 20px; cursor: nwse-resize; touch-action: none; }
    .browser-resize-handle::after { content: ""; position: absolute; right: 5px; bottom: 5px; width: 7px; height: 7px; border-right: 2px solid var(--pi-muted); border-bottom: 2px solid var(--pi-muted); opacity: .7; }
    button:hover, button:focus-visible, input:focus-visible { border-color: var(--pi-accent); color: var(--pi-text); }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    .browser-resize-handle:hover::after { border-color: var(--pi-text); opacity: 1; }
    @media (max-width: 760px) {
      .browser-backdrop { padding: 0; }
      .browser-frame { width: 100%; height: 100%; border: 0; border-radius: 0; }
      .browser-frame-positioned { position: relative; }
      .browser-drag-handle { cursor: default; }
    }
  `;
}

function addressForTab(tab: BrowserTab | undefined): string {
  return tab === undefined || tab.url === BLANK_BROWSER_URL ? "" : tab.url;
}
