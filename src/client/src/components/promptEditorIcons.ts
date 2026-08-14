import { svg, type TemplateResult } from "lit";
import type { ThinkingGauge } from "../../../shared/thinkingLevels";

// Hand-rolled inline icons matching the project's stroke style
// (viewBox 0 0 24 24, fill none, stroke currentColor, round caps/joins).
// See tabIcons.ts for the established convention.

export function renderMicrophoneIcon(): TemplateResult {
  return svg`
    <svg class="prompt-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="9" y="3" width="6" height="11" rx="3"></rect>
      <path d="M6 11a6 6 0 0 0 12 0"></path>
      <path d="M12 17v4"></path>
      <path d="M8.5 21h7"></path>
    </svg>
  `;
}

export function renderWaveformIcon(): TemplateResult {
  return svg`
    <svg class="prompt-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 12h2"></path>
      <path d="M8 8v8"></path>
      <path d="M12 5v14"></path>
      <path d="M16 8v8"></path>
      <path d="M18 12h2"></path>
    </svg>
  `;
}

export function renderAttachIcon(): TemplateResult {
  return svg`
    <svg class="prompt-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M20 11.5 12.5 19a4 4 0 0 1-5.66-5.66l7.07-7.07a2.5 2.5 0 0 1 3.54 3.54l-7.07 7.07a1 1 0 0 1-1.42-1.42l6.37-6.36"></path>
    </svg>
  `;
}

export function renderCompactIcon(): TemplateResult {
  return svg`
    <svg class="prompt-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <polyline points="4 14 10 14 10 20"></polyline>
      <polyline points="20 10 14 10 14 4"></polyline>
      <line x1="10" y1="14" x2="3" y2="21"></line>
      <line x1="21" y1="3" x2="14" y2="10"></line>
    </svg>
  `;
}

export function renderSendIcon(): TemplateResult {
  return svg`
    <svg class="prompt-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M21 3 13.5 21l-2-8.5L3 10.5Z"></path>
      <path d="M21 3 11.5 12.5"></path>
    </svg>
  `;
}

export function renderQueueIcon(): TemplateResult {
  return svg`
    <svg class="prompt-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 7h11"></path>
      <path d="M4 12h7"></path>
      <path d="M4 17h7"></path>
      <path d="m15 14 5 3-5 3z"></path>
    </svg>
  `;
}

export function renderSteerIcon(): TemplateResult {
  // Steer and send are both "do this now"; the queue icon carries the "later" distinction.
  return renderSendIcon();
}

export function renderStopIcon(): TemplateResult {
  return svg`
    <svg class="prompt-action-icon prompt-action-icon-filled" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="6.5" y="6.5" width="11" height="11" rx="2"></rect>
    </svg>
  `;
}

/**
 * A gauge whose bar count comes from the available thinking levels (the non-"off"
 * levels) and whose fill reflects the current level's rank. Bars are laid out to
 * fill the 24x24 box regardless of count, so it adapts if pi changes the set.
 *
 * Bars share a baseline and climb from a visible floor to near the top of the
 * box, so rank reads as magnitude at a glance. Corner rounding is a fraction of
 * bar width rather than a fixed radius, so narrow bars stay rectangular instead
 * of collapsing into lozenges when the level set is dense.
 */
export function renderThinkingGauge(gauge: ThinkingGauge): TemplateResult {
  const total = Math.max(gauge.total, 1);
  const gap = total > 1 ? 1.4 : 0;
  const left = 3;
  const right = 21;
  const baseline = 21;
  const minHeight = 5;
  const maxHeight = 18;
  const span = right - left;
  // Cap bar width so a level set with one non-off level renders a bar rather than
  // a box-filling square, and centre the track whatever the count.
  const rawWidth = (span - gap * (total - 1)) / total;
  const barWidth = Math.min(rawWidth, 5);
  const usedWidth = barWidth * total + gap * (total - 1);
  const originX = left + (span - usedWidth) / 2;
  const radius = Math.min(0.75, barWidth * 0.3);
  const bars = Array.from({ length: total }, (_unused, i) => {
    const x = originX + i * (barWidth + gap);
    const step = total === 1 ? 1 : i / (total - 1);
    const height = minHeight + step * (maxHeight - minHeight);
    const y = baseline - height;
    const active = i < gauge.filled;
    return svg`<rect class=${active ? "gauge-bar gauge-bar-active" : "gauge-bar"} x=${x} y=${y} width=${barWidth} height=${height} rx=${radius}></rect>`;
  });
  return svg`
    <svg class="prompt-thinking-gauge" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      ${bars}
    </svg>
  `;
}
