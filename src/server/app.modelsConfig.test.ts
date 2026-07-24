import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { appTestContext, fakeRemoteClient, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();

describe("buildApp models configuration routes", () => {
  it("forwards local models configuration reads, saves, and connection tests to the session daemon", async () => {
    const config = {
      providers: {
        "example-provider": {
          api: "openai-completions",
          models: [{ id: "example-model" }],
        },
      },
    };
    const connectionTest = {
      providerName: "example-provider",
      provider: config.providers["example-provider"],
      model: { id: "example-model" },
    };
    const discovery = {
      providerName: "example-provider",
      provider: config.providers["example-provider"],
    };

    const read = await appTestContext.app.inject({ method: "GET", url: "/api/machines/local/models-config" });
    const save = await appTestContext.app.inject({ method: "PUT", url: "/api/machines/local/models-config", payload: config });
    const test = await appTestContext.app.inject({ method: "POST", url: "/api/machines/local/models-config/test", payload: connectionTest });
    const discover = await appTestContext.app.inject({ method: "POST", url: "/api/machines/local/models-config/discover", payload: discovery });

    expect([read.statusCode, save.statusCode, test.statusCode, discover.statusCode]).toEqual([200, 200, 200, 200]);
    expect(appTestContext.sessionDaemonRequests).toEqual([
      { method: "GET", path: "/models-config" },
      { method: "PUT", path: "/models-config", body: config },
      { method: "POST", path: "/models-config/test", body: connectionTest },
      { method: "POST", path: "/models-config/discover", body: discovery },
    ]);
  });

  it("proxies the allowlisted models configuration routes to a remote machine", async () => {
    const added = await appTestContext.app.inject({
      method: "POST",
      url: "/api/machines",
      payload: { name: "Remote", baseUrl: "https://remote.example.test/" },
    });
    const remote = added.json<{ id: string }>();
    const request = vi.fn((method: string, path: string, body: unknown) => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ method, path, body })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const config = { providers: { custom: { api: "anthropic-messages", baseUrl: "https://models.example.test" } } };
    const testInput = { providerName: "custom", provider: config.providers.custom, model: { id: "claude-test" } };
    const discoveryInput = { providerName: "custom", provider: config.providers.custom };
    const read = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/models-config` });
    const save = await appTestContext.app.inject({ method: "PUT", url: `/api/machines/${remote.id}/models-config`, payload: config });
    const test = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/models-config/test`, payload: testInput });
    const discover = await appTestContext.app.inject({ method: "POST", url: `/api/machines/${remote.id}/models-config/discover`, payload: discoveryInput });

    expect(read.json()).toEqual({ method: "GET", path: "/api/models-config" });
    expect(save.json()).toEqual({ method: "PUT", path: "/api/models-config", body: config });
    expect(test.json()).toEqual({ method: "POST", path: "/api/models-config/test", body: testInput });
    expect(discover.json()).toEqual({ method: "POST", path: "/api/models-config/discover", body: discoveryInput });
    expect(request).toHaveBeenNthCalledWith(1, "GET", "/api/models-config", undefined);
    expect(request).toHaveBeenNthCalledWith(2, "PUT", "/api/models-config", config);
    expect(request).toHaveBeenNthCalledWith(3, "POST", "/api/models-config/test", testInput);
    expect(request).toHaveBeenNthCalledWith(4, "POST", "/api/models-config/discover", discoveryInput);
  });
});
