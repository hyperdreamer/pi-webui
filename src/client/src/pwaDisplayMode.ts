export const PWA_DISPLAY_MODE_QUERIES = [
  "(display-mode: standalone)",
  "(display-mode: fullscreen)",
  "(display-mode: minimal-ui)",
] as const;

export interface DisplayModeMediaState {
  readonly matches: boolean;
}

export function createPwaDisplayModeMedia(): MediaQueryList[] {
  if (typeof window === "undefined" || !("matchMedia" in window)) return [];
  return PWA_DISPLAY_MODE_QUERIES.map((query) => window.matchMedia(query));
}

export function detectPwaDisplayMode(media: readonly DisplayModeMediaState[], navigatorObject = currentNavigator()): boolean {
  return media.some((query) => query.matches) || isIosStandalonePwa(navigatorObject);
}

function currentNavigator(): object | undefined {
  return typeof navigator === "undefined" ? undefined : navigator;
}

function isIosStandalonePwa(navigatorObject: object | undefined): boolean {
  return navigatorObject !== undefined && "standalone" in navigatorObject && navigatorObject.standalone === true;
}
