import type { BrowserEgressMode, BrowserRuntimeReadiness } from "./browserRuntime.js";

const BROWSER_PROTOCOL_VERSION = 1;
const MAX_TABS_PER_SESSION = 10;
const MAX_SESSIONS_PER_PRINCIPAL = 2;

export type BrowserPermission = "browser.use" | "browser.admin" | "browser.persistent-profile";

/** A server-derived principal; routes must never construct this from client input. */
export interface BrowserPrincipal {
  subject: string;
  permissions: readonly BrowserPermission[];
}

export type BrowserAvailabilityCode = "BROWSER_AUTH_REQUIRED" | "BROWSER_FORBIDDEN" | "BROWSER_UNAVAILABLE";

export type BrowserRemoteCapability = BrowserRemoteCapabilityAvailable | BrowserRemoteCapabilityUnavailable;

export interface BrowserRemoteCapabilityAvailable {
  available: true;
  protocolVersions: number[];
  profileModes: ["ephemeral"];
  limits: {
    maxTabsPerSession: number;
    maxSessionsPerPrincipal: number;
  };
  egress: {
    mode: BrowserEgressMode;
    privateNetworksBlocked: true;
  };
}

export interface BrowserRemoteCapabilityUnavailable {
  available: false;
  code: BrowserAvailabilityCode;
  retryable: boolean;
}

/**
 * Pure feature gate for the browser capability. The runtime adapter must prove
 * every isolation property; partial readiness never becomes browser access.
 */
export function evaluateBrowserRemoteCapability(principal: BrowserPrincipal | undefined, readiness: BrowserRuntimeReadiness): BrowserRemoteCapability {
  if (!hasTrustedPrincipal(principal)) return unavailable("BROWSER_AUTH_REQUIRED", false);
  if (!principal.permissions.includes("browser.use")) return unavailable("BROWSER_FORBIDDEN", false);
  if (!hasSafeRuntime(readiness)) return unavailable("BROWSER_UNAVAILABLE", true);

  return {
    available: true,
    protocolVersions: [BROWSER_PROTOCOL_VERSION],
    profileModes: ["ephemeral"],
    limits: {
      maxTabsPerSession: readiness.limits.maxTabsPerSession,
      maxSessionsPerPrincipal: readiness.limits.maxSessionsPerPrincipal,
    },
    egress: {
      mode: readiness.egress.mode,
      privateNetworksBlocked: true,
    },
  };
}

function hasTrustedPrincipal(principal: unknown): principal is BrowserPrincipal {
  if (!isRecord(principal) || typeof principal["subject"] !== "string" || !Array.isArray(principal["permissions"])) return false;
  return principal["subject"].trim() !== "" && principal["permissions"].every(isBrowserPermission);
}

function isBrowserPermission(value: unknown): value is BrowserPermission {
  return value === "browser.use" || value === "browser.admin" || value === "browser.persistent-profile";
}

function hasSafeRuntime(readiness: unknown): boolean {
  if (!isRecord(readiness) || !isRecord(readiness["egress"]) || !Array.isArray(readiness["protocolVersions"])) return false;
  const egress = readiness["egress"];
  return readiness["controlChannel"] === "authenticated-private"
    && readiness["chromiumSandbox"] === "enforced"
    && readiness["profileIsolation"] === "ephemeral-per-principal"
    && readiness["hostIsolation"] === "enforced"
    && readiness["debuggingTransport"] === "pipe-private"
    && egress["state"] === "enforced"
    && (egress["mode"] === "public-web" || egress["mode"] === "domain-allowlist")
    && egress["privateNetworksBlocked"] === true
    && readiness["protocolVersions"].includes(BROWSER_PROTOCOL_VERSION)
    && hasBoundedLimits(readiness["limits"]);
}

function hasBoundedLimits(limits: unknown): boolean {
  if (!isRecord(limits)) return false;
  const maxTabsPerSession = limits["maxTabsPerSession"];
  const maxSessionsPerPrincipal = limits["maxSessionsPerPrincipal"];
  return typeof maxTabsPerSession === "number"
    && typeof maxSessionsPerPrincipal === "number"
    && isPositiveIntegerAtMost(maxTabsPerSession, MAX_TABS_PER_SESSION)
    && isPositiveIntegerAtMost(maxSessionsPerPrincipal, MAX_SESSIONS_PER_PRINCIPAL);
}

function isPositiveIntegerAtMost(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function unavailable(code: BrowserAvailabilityCode, retryable: boolean): BrowserRemoteCapabilityUnavailable {
  return { available: false, code, retryable };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
