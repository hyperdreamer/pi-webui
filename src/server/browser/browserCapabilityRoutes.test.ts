import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerLocalBrowserCapabilityRoutes, type BrowserPrincipalProvider } from "./browserCapabilityRoutes.js";
import type { BrowserRuntimeClient, BrowserRuntimeReadiness } from "./browserRuntime.js";

const browserUser = { subject: "user-1", permissions: ["browser.use"] as const };
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function readyRuntime(): BrowserRuntimeReadiness {
  return {
    controlChannel: "authenticated-private",
    chromiumSandbox: "enforced",
    profileIsolation: "ephemeral-per-principal",
    hostIsolation: "enforced",
    debuggingTransport: "pipe-private",
    egress: { state: "enforced", mode: "domain-allowlist", privateNetworksBlocked: true },
    protocolVersions: [1],
    limits: { maxTabsPerSession: 10, maxSessionsPerPrincipal: 2 },
  };
}

function registerRoute(options: { runtime: BrowserRuntimeClient; principalProvider?: BrowserPrincipalProvider }): FastifyInstance {
  const app = Fastify();
  registerLocalBrowserCapabilityRoutes(app, options);
  apps.push(app);
  return app;
}

describe("local browser capability route", () => {
  it("fails closed without a trusted identity and does not probe the browser runtime", async () => {
    const readiness = vi.fn<BrowserRuntimeClient["readiness"]>();
    const app = registerRoute({ runtime: { readiness } });

    const response = await app.inject({ method: "GET", url: "/api/machines/local/browser/capabilities" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ available: false, code: "BROWSER_AUTH_REQUIRED", retryable: false });
    expect(readiness).not.toHaveBeenCalled();
  });

  it("returns a redacted capability only after a trusted principal and safe runtime readiness", async () => {
    const app = registerRoute({
      runtime: { readiness: () => Promise.resolve(readyRuntime()) },
      principalProvider: { principalFor: () => Promise.resolve(browserUser) },
    });

    const response = await app.inject({ method: "GET", url: "/api/machines/local/browser/capabilities" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      available: true,
      protocolVersions: [1],
      profileModes: ["ephemeral"],
      limits: { maxTabsPerSession: 10, maxSessionsPerPrincipal: 2 },
      egress: { mode: "domain-allowlist", privateNetworksBlocked: true },
    });
  });

  it("returns unavailable when the private runtime cannot establish readiness", async () => {
    const app = registerRoute({
      runtime: { readiness: () => Promise.reject(new Error("private socket unavailable")) },
      principalProvider: { principalFor: () => Promise.resolve(browserUser) },
    });

    const response = await app.inject({ method: "GET", url: "/api/machines/local/browser/capabilities" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ available: false, code: "BROWSER_UNAVAILABLE", retryable: true });
  });

  it("does not expose browser controls or remote-machine browsing before delegation exists", async () => {
    const app = registerRoute({ runtime: { readiness: () => Promise.resolve(readyRuntime()) } });

    const localControl = await app.inject({ method: "POST", url: "/api/machines/local/browser/sessions" });
    const remoteCapability = await app.inject({ method: "GET", url: "/api/machines/remote/browser/capabilities" });

    expect(localControl.statusCode).toBe(404);
    expect(remoteCapability.statusCode).toBe(404);
  });
});
