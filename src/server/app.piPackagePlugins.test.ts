import { describe, expect, it } from "vitest";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();

describe("buildApp Pi package Plugins routes", () => {
  it("serves workspace-aware package plugin reads and mutations through both local browser paths", async () => {
    const cwd = "/workspace/plugins-project";
    const listed = await appTestContext.app.inject({ method: "GET", url: `/api/package-plugins?cwd=${encodeURIComponent(cwd)}` });
    const changed = await appTestContext.app.inject({
      method: "POST",
      url: "/api/machines/local/package-plugins",
      payload: { action: "disable", source: "npm:@acme/tools", scope: "global", cwd },
    });

    expect([listed.statusCode, changed.statusCode]).toEqual([200, 200]);
    expect(listed.json()).toMatchObject({
      packages: [{ source: "npm:@acme/tools", scope: "global", status: "loaded" }],
    });
    expect(appTestContext.piPackagePluginRequests).toEqual([
      { action: "list", cwd },
      { action: "disable", source: "npm:@acme/tools", scope: "global", cwd },
    ]);
  });
});
