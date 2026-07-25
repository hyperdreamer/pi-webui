import type { FastifyInstance, FastifyRequest } from "fastify";
import { evaluateBrowserRemoteCapability, unavailableBrowserRemoteCapability, type BrowserPrincipal } from "./browserCapabilities.js";
import { unavailableBrowserRuntimeReadiness, type BrowserRuntimeClient } from "./browserRuntime.js";

/**
 * Adapts an already-authenticated server request to a browser principal.
 * It is intentionally absent by default: host allowlists and client headers
 * are not a trustworthy identity source for remote browser sessions.
 */
export interface BrowserPrincipalProvider {
  principalFor(request: FastifyRequest): BrowserPrincipal | undefined | Promise<BrowserPrincipal | undefined>;
}

export interface BrowserCapabilityRouteDependencies {
  runtime: BrowserRuntimeClient;
  principalProvider?: BrowserPrincipalProvider;
}

/**
 * This foundation intentionally registers capability discovery only. Browser
 * controls and remote federation wait for the required runtime/delegation work.
 */
export function registerLocalBrowserCapabilityRoutes(app: FastifyInstance, deps: BrowserCapabilityRouteDependencies): void {
  app.get("/api/machines/local/browser/capabilities", async (request) => {
    const principal = await resolveBrowserPrincipal(request, deps.principalProvider);
    if (principal.status === "unavailable") return unavailableBrowserRemoteCapability();
    if (principal.status === "absent") return evaluateBrowserRemoteCapability(undefined, unavailableBrowserRuntimeReadiness());

    try {
      return evaluateBrowserRemoteCapability(principal.value, await deps.runtime.readiness());
    } catch {
      return evaluateBrowserRemoteCapability(principal.value, unavailableBrowserRuntimeReadiness());
    }
  });
}

type BrowserPrincipalResolution =
  | { status: "available"; value: BrowserPrincipal }
  | { status: "absent" }
  | { status: "unavailable" };

async function resolveBrowserPrincipal(request: FastifyRequest, provider: BrowserPrincipalProvider | undefined): Promise<BrowserPrincipalResolution> {
  if (provider === undefined) return { status: "absent" };
  try {
    const principal = await provider.principalFor(request);
    return principal === undefined ? { status: "absent" } : { status: "available", value: principal };
  } catch {
    request.log.warn({ dependency: "browser-principal-provider" }, "browser principal provider unavailable");
    return { status: "unavailable" };
  }
}
