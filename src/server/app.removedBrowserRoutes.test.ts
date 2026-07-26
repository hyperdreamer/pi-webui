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

describe("buildApp", () => {
  it("returns normal API 404s for removed browser routes without replacing the client fallback", async () => {
    staticClientDist = await mkdtemp(join(tmpdir(), "pi-webui-client-"));
    await writeFile(join(staticClientDist, "index.html"), "<html><body>PI WEBUI client</body></html>");
    const app = await buildApp({ clientDist: staticClientDist, logger: false });
    closeApp = () => app.close();

    const apiResponses = await Promise.all([
      app.inject({ method: "GET", url: "/api/machines/local/browser/capabilities" }),
      app.inject({ method: "POST", url: "/api/machines/local/browser/sessions" }),
      app.inject({ method: "GET", url: "/api/machines/remote/browser/capabilities" }),
    ]);

    for (const response of apiResponses) {
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.json()).toEqual({ error: "API route not found" });
    }

    const clientRoute = await app.inject({ method: "GET", url: "/removed-browser-route" });
    expect(clientRoute.statusCode).toBe(200);
    expect(clientRoute.headers["content-type"]).toContain("text/html");
    expect(clientRoute.body).toContain("PI WEBUI client");
  });
});
