import { describe, expect, it } from "vitest";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();

describe("buildApp Pi package routes", () => {
  it("serves Pi package management routes through the app wiring", async () => {
    const listResponse = await appTestContext.app.inject({ method: "GET", url: "/api/pi-packages" });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual({ packages: [{ source: "npm:@acme/tools", scope: "user", filtered: false, installedPath: "/tmp/pi-tools" }] });

    const installResponse = await appTestContext.app.inject({ method: "POST", url: "/api/pi-packages/install", payload: { source: "npm:@acme/new-tools" } });
    expect(installResponse.statusCode).toBe(200);
    expect(installResponse.json()).toMatchObject({ action: "install", source: "npm:@acme/new-tools" });

    const localAliasResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines/local/pi-packages/remove", payload: { source: "npm:@acme/tools", scope: "user" } });
    expect(localAliasResponse.statusCode).toBe(200);
    expect(localAliasResponse.json()).toMatchObject({ action: "remove", source: "npm:@acme/tools", scope: "user" });
    expect(appTestContext.piPackageRequests).toEqual([
      { action: "list" },
      { action: "install", source: "npm:@acme/new-tools" },
      { action: "remove", source: "npm:@acme/tools", scope: "user" },
    ]);
  });
});
