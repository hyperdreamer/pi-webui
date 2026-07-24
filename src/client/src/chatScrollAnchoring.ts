export interface PrependScrollAnchor {
  distanceFromBottom: number;
  markerId?: string;
  markerOffset?: number;
}

export interface MarkerMeasurement {
  id: string;
  offset: number;
}

export const PREPEND_RESTORE_SETTLE_FRAMES = 30;

export function capturePrependScrollAnchor(scroller: HTMLElement, markers: HTMLElement[]): PrependScrollAnchor {
  const marker = selectPrependMarker(measureMarkers(scroller, markers));
  const base = { distanceFromBottom: scroller.scrollHeight - scroller.scrollTop };
  return marker === undefined ? base : { ...base, markerId: marker.id, markerOffset: marker.offset };
}

export function restorePrependScrollAnchor(scroller: HTMLElement, anchor: PrependScrollAnchor, marker: HTMLElement | undefined): void {
  if (marker !== undefined && anchor.markerOffset !== undefined) {
    const markerOffset = marker.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += scrollDeltaForMarker(markerOffset, anchor.markerOffset);
    return;
  }
  scroller.scrollTop = scrollTopForBottomDistance(scroller.scrollHeight, anchor.distanceFromBottom);
}

export function selectPrependMarker(markers: MarkerMeasurement[]): MarkerMeasurement | undefined {
  let nearestAbove: MarkerMeasurement | undefined;
  let nearestAboveOffset = Number.NEGATIVE_INFINITY;
  let nearestBelow: MarkerMeasurement | undefined;
  let nearestBelowOffset = Number.POSITIVE_INFINITY;
  for (const marker of markers) {
    if (marker.offset <= 0 && marker.offset >= nearestAboveOffset) {
      nearestAbove = marker;
      nearestAboveOffset = marker.offset;
    } else if (marker.offset > 0 && marker.offset < nearestBelowOffset) {
      nearestBelow = marker;
      nearestBelowOffset = marker.offset;
    }
  }
  return nearestAbove ?? nearestBelow;
}

export function scrollDeltaForMarker(currentOffset: number, previousOffset: number): number {
  return currentOffset - previousOffset;
}

export function scrollTopForBottomDistance(scrollHeight: number, distanceFromBottom: number): number {
  return Math.max(0, scrollHeight - distanceFromBottom);
}

function measureMarkers(scroller: HTMLElement, markers: HTMLElement[]): MarkerMeasurement[] {
  const scrollerTop = scroller.getBoundingClientRect().top;
  return markers.flatMap((marker) => {
    const id = marker.dataset["markerId"];
    return id === undefined ? [] : [{ id, offset: marker.getBoundingClientRect().top - scrollerTop }];
  });
}
