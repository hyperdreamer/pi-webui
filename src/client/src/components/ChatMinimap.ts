import { LitElement, css, html } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { clampRatio, minimapTooltipTopPositions, scrollToMinimapTopRatio, type MinimapMarker } from "../chatMinimapGeometry";

/**
 * Right-side conversation minimap rail.
 *
 * Displays a narrow vertical rail with a viewport indicator that shows the
 * user's position within a long conversation.  Message markers distinguish
 * user turns (accent-coloured rounded-square dots) from assistant turns
 * (muted circular dots).  Hovering over the rail highlights the nearest
 * marker and shows a short preview tooltip for every message marker.
 *
 * Clicking or dragging on the rail dispatches `minimap-scroll-to` with a
 * target 0–1 ratio.  The parent (`ChatView`) is responsible for translating
 * that ratio into a `scrollTop` value, respecting its own pinned-to-bottom,
 * lazy-history, and scroll-restoration state.
 */
@customElement("chat-minimap")
export class ChatMinimap extends LitElement {
  /** Current scroll position as a ratio (0–1) of the scrollable range. */
  @property({ type: Number }) scrollRatio = 0;

  /** Ratio of visible viewport height to total scroll height. */
  @property({ type: Number }) viewportRatio = 1;

  /** Whether the minimap should be displayed (false when content doesn't overflow). */
  @property({ type: Boolean }) visible = false;

  /** Percentage (0–100) of total conversation messages that are currently loaded. */
  @property({ type: Number }) loadedPercent = 100;

  /** Markers representing primary user/assistant messages with visible text content. */
  @property({ attribute: false }) markers: readonly MinimapMarker[] = [];

  @state() private _hovered = false;
  @state() private _nearestIndex: number | null = null;

  @query(".rail") private _rail?: HTMLDivElement;

  private _dragging = false;
  private _grabOffset = 0;

  private _handlePointerDown(e: PointerEvent): void {
    if (!this.visible) return;
    const rail = this._rail;
    if (!rail) return;
    this._dragging = true;
    rail.setPointerCapture(e.pointerId);
    const rect = rail.getBoundingClientRect();
    const clickRatio = clampRatio((e.clientY - rect.top) / rect.height);
    const viewportTop = this._viewportTopRatio();
    const insideBox =
      clickRatio >= viewportTop &&
      clickRatio <= viewportTop + this.viewportRatio;
    this._grabOffset = insideBox
      ? clickRatio - viewportTop
      : this.viewportRatio / 2;
    this._dispatchScroll(clickRatio - this._grabOffset);
  }

  private _handlePointerMove(e: PointerEvent): void {
    if (!this._rail) return;
    const rect = this._rail.getBoundingClientRect();
    const ratio = clampRatio((e.clientY - rect.top) / rect.height);
    if (this._dragging) {
      this._dispatchScroll(ratio - this._grabOffset);
      return;
    }
    this._nearestIndex = this._findNearestMarker(ratio);
  }

  private _handlePointerUp(): void {
    this._dragging = false;
  }

  private _handleKeyDown(e: KeyboardEvent): void {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const step = this.viewportRatio / 2;
      const delta = e.key === "ArrowUp" ? -step : step;
      const newTop = clampRatio(
        this._viewportTopRatio() + delta,
      );
      this._dispatchScroll(newTop);
    }
  }

  private _viewportTopRatio(): number {
    return scrollToMinimapTopRatio(this.scrollRatio, this.viewportRatio);
  }

  private _dispatchScroll(viewportTopRatio: number): void {
    const clamped = clampRatio(viewportTopRatio);
    this.dispatchEvent(
      new CustomEvent("minimap-scroll-to", {
        detail: { ratio: clamped },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _findNearestMarker(
    mouseYRatio: number,
  ): number | null {
    const list = this.markers;
    if (list.length === 0) return null;
    const first = list[0];
    if (first === undefined) return null;
    let bestIdx = 0;
    let bestDist = Math.abs(first.topRatio - mouseYRatio);
    for (let i = 1; i < list.length; i++) {
      const item = list[i];
      if (item === undefined) continue;
      const dist = Math.abs(item.topRatio - mouseYRatio);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  override render() {
    if (!this.visible) return html``;

    const rail = this._renderRail();
    const tooltips = this._renderTooltips();
    return html`${rail}${tooltips}`;
  }

  private _renderRail() {
    const viewportTopPct = this._viewportTopRatio() * 100;
    const viewportHeightPct = this.viewportRatio * 100;
    const loadedLabel =
      this.loadedPercent >= 100
        ? "all messages loaded"
        : `${String(Math.round(this.loadedPercent))}% of messages loaded`;
    const label = `Conversation navigator: about ${String(Math.round(this.scrollRatio * 100))}% through loaded messages; ${loadedLabel}.`;

    return html`
      <div
        class="rail"
        role="scrollbar"
        aria-label=${label}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow=${String(Math.round(this.scrollRatio * 100))}
        tabindex="0"
        @pointerdown=${(e: PointerEvent) => { this._handlePointerDown(e); }}
        @pointermove=${(e: PointerEvent) => { this._handlePointerMove(e); }}
        @pointerup=${() => { this._handlePointerUp(); }}
        @pointerleave=${() => {
          this._hovered = false;
          this._nearestIndex = null;
        }}
        @pointerenter=${(e: PointerEvent) => {
          this._hovered = true;
          this._handlePointerMove(e);
        }}
        @keydown=${(e: KeyboardEvent) => { this._handleKeyDown(e); }}
      >
        <div class="center-line"></div>
        <div
          class="viewport-indicator"
          style=${`top:${viewportTopPct.toFixed(2)}%;height:${viewportHeightPct.toFixed(2)}%`}
        ></div>
        ${this.markers.map(
          (marker, index) => this._renderMarker(marker, index),
        )}
      </div>
    `;
  }

  private _renderMarker(marker: MinimapMarker, index: number) {
    const isNearest = this._hovered && this._nearestIndex === index;
    const isUser = marker.role === "user";
    const dotTop = marker.topRatio * 100;

    return html`
      <div
        class="marker-container"
        style=${`top:${dotTop.toFixed(2)}%`}
        data-marker-index=${index}
        data-marker-role=${marker.role}
      >
        <div
          class=${`marker-dot${isUser ? " user" : " assistant"}${isNearest ? " nearest" : ""}`}
        ></div>
      </div>
    `;
  }

  private _renderTooltips() {
    if (!this._hovered) return null;

    const positions = minimapTooltipTopPositions(
      this.markers,
      this._rail?.clientHeight ?? 600,
    );
    return this.markers.map((marker, index) => {
      const top = positions[index];
      if (marker.preview === "" || top === undefined) return null;
      const isNearest = this._nearestIndex === index;
      return html`
        <div
          class=${`tooltip ${marker.role}${isNearest ? " nearest" : ""}`}
          style=${`top:${String(top)}px`}
        >
          <div class="tooltip-text">${marker.preview}</div>
        </div>
      `;
    });
  }

  static override styles = css`
    :host {
      display: none;
      position: absolute;
      right: 0;
      top: 0;
      bottom: 0;
      width: 36px;
      z-index: 30;
      overflow: visible;
    }

    @media (min-width: 761px) {
      :host {
        display: block;
      }
    }

    .rail {
      position: relative;
      width: 100%;
      height: 100%;
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
      border-left: 1px solid var(--pi-border-muted);
      background: var(--pi-surface);
      overflow: visible;
    }
    .rail:focus-visible {
      outline: 2px solid var(--pi-accent);
      outline-offset: -2px;
    }

    .center-line {
      position: absolute;
      left: 50%;
      top: 0;
      bottom: 0;
      width: 1px;
      background: var(--pi-border-muted);
      transform: translateX(-50%);
      z-index: 0;
    }

    .viewport-indicator {
      position: absolute;
      left: 0;
      right: 0;
      background: color-mix(in srgb, var(--pi-text) 8%, transparent);
      border-top: 1px solid
        color-mix(in srgb, var(--pi-text) 14%, transparent);
      border-bottom: 1px solid
        color-mix(in srgb, var(--pi-text) 14%, transparent);
      pointer-events: none;
      z-index: 1;
    }

    .marker-container {
      position: absolute;
      left: 0;
      right: 0;
      transform: translateY(-50%);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2;
      pointer-events: none;
    }

    .marker-dot {
      flex-shrink: 0;
      transition: transform 0.1s;
    }
    .marker-dot.user {
      width: 8px;
      height: 8px;
      border-radius: 2px;
      background: color-mix(in srgb, var(--pi-accent) 18%, transparent);
      border: 1.5px solid
        color-mix(in srgb, var(--pi-accent) 70%, transparent);
    }
    .marker-dot.assistant {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--pi-text) 12%, transparent);
      border: 1.5px solid
        color-mix(in srgb, var(--pi-text) 30%, transparent);
    }
    .marker-dot.nearest {
      transform: scale(1.6);
    }

    .tooltip {
      position: absolute;
      right: calc(100% + 6px);
      background: var(--pi-surface);
      border: 1px solid var(--pi-border);
      border-left-width: 2px;
      border-radius: 4px;
      padding: 2px 7px;
      width: 200px;
      max-height: 22px;
      z-index: 100;
      pointer-events: none;
      opacity: .45;
      transition: top .1s, opacity .1s;
    }
    .tooltip.user { border-left-color: color-mix(in srgb, var(--pi-accent) 70%, transparent); }
    .tooltip.assistant { border-left-color: color-mix(in srgb, var(--pi-text) 30%, transparent); }
    .tooltip.nearest { z-index: 101; opacity: 1; }
    .tooltip.nearest.user { border-color: color-mix(in srgb, var(--pi-accent) 70%, transparent); }
    .tooltip.nearest.assistant { border-color: color-mix(in srgb, var(--pi-text) 30%, transparent); }

    .tooltip-text {
      font-size: 11px;
      color: var(--pi-muted);
      line-height: 1.4;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tooltip.nearest .tooltip-text { color: var(--pi-text); }

    @media (prefers-reduced-motion: reduce) {
      .marker-dot, .tooltip {
        transition: none;
      }
    }
  `;
}
