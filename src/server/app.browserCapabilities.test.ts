import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

let closeApp: (() => Promise<void>) | undefined;
let staticClientDist: string | undefined;

afterEach(async () => {
  await closeApp?.();
  closeApp = undefined;
  if (staticClientDist !== undefined) await rm(staticClientDist, { recursive: true, force: true });
  staticClientDist = undefined;
});

describe("buildApp browser capability foundation", () => {
  it("keeps remote browser discovery unavailable without an injected trusted identity", async () => {
    const app = await buildApp({ clientDist: false, logger: false });
    closeApp = () => app.close();

    const response = await app.inject({ method: "GET", url: "/api/machines/local/browser/capabilities" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ available: false, code: "BROWSER_AUTH_REQUIRED", retryable: false });
  });

  it("returns JSON API 404s for unavailable browser routes without replacing the client fallback", async () => {
    staticClientDist = await mkdtemp(join(tmpdir(), "pi-webui-browser-client-"));
    await writeFile(join(staticClientDist, "index.html"), "<html><body>PI WEBUI client</body></html>");
    const app = await buildApp({ clientDist: staticClientDist, logger: false });
    closeApp = () => app.close();

    const browserRouteProbes = await Promise.all([
      app.inject({ method: "GET", url: "/api/machines/remote/browser/capabilities" }),
      app.inject({ method: "POST", url: "/api/machines/local/browser/sessions" }),
      app.inject({ method: "GET", url: "/api/machines/local/browser/sessions" }),
    ]);

    for (const response of browserRouteProbes) {
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.json()).toEqual({ error: "API route not found" });
    }

    const registeredCapability = await app.inject({ method: "GET", url: "/api/machines/local/browser/capabilities" });
    expect(registeredCapability.statusCode).toBe(200);
    expect(registeredCapability.json()).toEqual({ available: false, code: "BROWSER_AUTH_REQUIRED", retryable: false });

    const clientRoute = await app.inject({ method: "GET", url: "/browser" });
    expect(clientRoute.statusCode).toBe(200);
    expect(clientRoute.headers["content-type"]).toContain("text/html");
    expect(clientRoute.body).toContain("PI WEBUI client");
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
