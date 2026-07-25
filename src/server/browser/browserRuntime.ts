export type BrowserControlChannelStatus = "authenticated-private" | "unavailable";
export type BrowserSandboxStatus = "enforced" | "unavailable";
export type BrowserProfileIsolationStatus = "ephemeral-per-principal" | "unavailable";
export type BrowserHostIsolationStatus = "enforced" | "unavailable";
/** Chromium must use a private debugging pipe, never a TCP debugging listener. */
export type BrowserDebuggingTransport = "pipe-private" | "unavailable";
export type BrowserEgressMode = "public-web" | "domain-allowlist";
export type BrowserEgressStatus = "enforced" | "unavailable";

export interface BrowserRuntimeLimits {
  maxTabsPerSession: number;
  maxSessionsPerPrincipal: number;
}

/**
 * Safe readiness evidence supplied by the private browser-runtime adapter.
 * Chromium/CDP details deliberately stay behind this interface.
 */
export interface BrowserRuntimeReadiness {
  controlChannel: BrowserControlChannelStatus;
  chromiumSandbox: BrowserSandboxStatus;
  profileIsolation: BrowserProfileIsolationStatus;
  hostIsolation: BrowserHostIsolationStatus;
  debuggingTransport: BrowserDebuggingTransport;
  egress: {
    /** Connection-time network-boundary enforcement, not URL validation alone. */
    state: BrowserEgressStatus;
    mode: BrowserEgressMode;
    privateNetworksBlocked: boolean;
  };
  protocolVersions: readonly number[];
  limits: BrowserRuntimeLimits;
}

/**
 * The web/API edge only learns whether an independently owned browser runtime
 * is safe to expose. It cannot send Chromium commands through this seam.
 */
export interface BrowserRuntimeClient {
  readiness(): Promise<BrowserRuntimeReadiness>;
}

export function unavailableBrowserRuntimeReadiness(): BrowserRuntimeReadiness {
  return {
    controlChannel: "unavailable",
    chromiumSandbox: "unavailable",
    profileIsolation: "unavailable",
    hostIsolation: "unavailable",
    debuggingTransport: "unavailable",
    egress: { state: "unavailable", mode: "domain-allowlist", privateNetworksBlocked: false },
    protocolVersions: [],
    limits: { maxTabsPerSession: 0, maxSessionsPerPrincipal: 0 },
  };
}

export function unavailableBrowserRuntime(): BrowserRuntimeClient {
  return { readiness: () => Promise.resolve(unavailableBrowserRuntimeReadiness()) };
}
