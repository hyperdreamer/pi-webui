export interface TerminalModalBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TerminalModalDragDelta {
  x: number;
  y: number;
}

export interface TerminalModalViewport {
  width: number;
  height: number;
}

interface TerminalModalAxisLimits {
  viewportSize: number;
  margin: number;
  minSize: number;
  maxSize: number;
}

const TERMINAL_MODAL_VIEWPORT_MARGIN_PX = 16;
const MIN_TERMINAL_MODAL_WIDTH_PX = 320;
const MIN_TERMINAL_MODAL_HEIGHT_PX = 240;

export function moveTerminalModal(
  bounds: TerminalModalBounds,
  delta: TerminalModalDragDelta,
  viewport: TerminalModalViewport,
): TerminalModalBounds {
  const fittedBounds = fitTerminalModalBounds(bounds, viewport);
  const horizontal = terminalModalAxisLimits(viewport.width, MIN_TERMINAL_MODAL_WIDTH_PX);
  const vertical = terminalModalAxisLimits(viewport.height, MIN_TERMINAL_MODAL_HEIGHT_PX);
  return {
    ...fittedBounds,
    left: clamp(fittedBounds.left + delta.x, horizontal.margin, horizontal.viewportSize - horizontal.margin - fittedBounds.width),
    top: clamp(fittedBounds.top + delta.y, vertical.margin, vertical.viewportSize - vertical.margin - fittedBounds.height),
  };
}

export function resizeTerminalModal(
  bounds: TerminalModalBounds,
  delta: TerminalModalDragDelta,
  viewport: TerminalModalViewport,
): TerminalModalBounds {
  const fittedBounds = fitTerminalModalBounds(bounds, viewport);
  const horizontal = terminalModalAxisLimits(viewport.width, MIN_TERMINAL_MODAL_WIDTH_PX);
  const vertical = terminalModalAxisLimits(viewport.height, MIN_TERMINAL_MODAL_HEIGHT_PX);
  return {
    ...fittedBounds,
    width: clamp(fittedBounds.width + delta.x, horizontal.minSize, horizontal.viewportSize - horizontal.margin - fittedBounds.left),
    height: clamp(fittedBounds.height + delta.y, vertical.minSize, vertical.viewportSize - vertical.margin - fittedBounds.top),
  };
}

export function fitTerminalModalBounds(bounds: TerminalModalBounds, viewport: TerminalModalViewport): TerminalModalBounds {
  const horizontal = terminalModalAxisLimits(viewport.width, MIN_TERMINAL_MODAL_WIDTH_PX);
  const vertical = terminalModalAxisLimits(viewport.height, MIN_TERMINAL_MODAL_HEIGHT_PX);
  const width = clamp(bounds.width, horizontal.minSize, horizontal.maxSize);
  const height = clamp(bounds.height, vertical.minSize, vertical.maxSize);
  return {
    left: clamp(bounds.left, horizontal.margin, horizontal.viewportSize - horizontal.margin - width),
    top: clamp(bounds.top, vertical.margin, vertical.viewportSize - vertical.margin - height),
    width,
    height,
  };
}

function terminalModalAxisLimits(viewportSize: number, preferredMinSize: number): TerminalModalAxisLimits {
  const normalizedViewportSize = Math.max(0, viewportSize);
  const margin = Math.min(TERMINAL_MODAL_VIEWPORT_MARGIN_PX, normalizedViewportSize / 2);
  const maxSize = normalizedViewportSize - margin * 2;
  return {
    viewportSize: normalizedViewportSize,
    margin,
    minSize: Math.min(preferredMinSize, maxSize),
    maxSize,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
