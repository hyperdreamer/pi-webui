import type { FastifyInstance, FastifyRequest } from "fastify";
import { evaluateBrowserRemoteCapability, type BrowserPrincipal } from "./browserCapabilities.js";
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
    const principal = await principalFor(request, deps.principalProvider);
    if (principal === undefined) return evaluateBrowserRemoteCapability(undefined, unavailableBrowserRuntimeReadiness());

    try {
      return evaluateBrowserRemoteCapability(principal, await deps.runtime.readiness());
    } catch {
      return evaluateBrowserRemoteCapability(principal, unavailableBrowserRuntimeReadiness());
    }
  });
}

async function principalFor(request: FastifyRequest, provider: BrowserPrincipalProvider | undefined): Promise<BrowserPrincipal | undefined> {
  if (provider === undefined) return undefined;
  try {
    return await provider.principalFor(request);
  } catch {
    return undefined;
  }
}
