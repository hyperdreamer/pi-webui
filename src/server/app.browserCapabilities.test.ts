import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

let closeApp: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeApp?.();
  closeApp = undefined;
});

describe("buildApp browser capability foundation", () => {
  it("keeps remote browser discovery unavailable without an injected trusted identity", async () => {
    const app = await buildApp({ clientDist: false, logger: false });
    closeApp = () => app.close();

    const response = await app.inject({ method: "GET", url: "/api/machines/local/browser/capabilities" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ available: false, code: "BROWSER_AUTH_REQUIRED", retryable: false });
  });

  it("uses only injected browser dependencies to advertise an isolated runtime", async () => {
    const app = await buildApp({
      browserRuntime: {
        readiness: () => Promise.resolve({
          controlChannel: "authenticated-private",
          chromiumSandbox: "enforced",
          profileIsolation: "ephemeral-per-principal",
          hostIsolation: "enforced",
          debuggingTransport: "pipe-private",
          egress: { state: "enforced", mode: "domain-allowlist", privateNetworksBlocked: true },
          protocolVersions: [1],
          limits: { maxTabsPerSession: 10, maxSessionsPerPrincipal: 2 },
        }),
      },
      browserPrincipalProvider: { principalFor: () => ({ subject: "user-1", permissions: ["browser.use"] }) },
      clientDist: false,
      logger: false,
    });
    closeApp = () => app.close();

    const response = await app.inject({ method: "GET", url: "/api/machines/local/browser/capabilities" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ available: true, profileModes: ["ephemeral"], egress: { privateNetworksBlocked: true } });
  });
});
