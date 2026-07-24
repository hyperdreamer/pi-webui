import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { appTestContext, fakeRemoteClient, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();

describe("browser-facing HTTP compression", () => {
  it("negotiates compression for large local-machine API responses", async () => {
    const marker = "local transcript content ".repeat(256);
    appTestContext.piWebUiConfig = {
      plugins: { fake: { settings: { marker } } },
    };

    const compressed = await appTestContext.app.inject({
      method: "GET",
      url: "/api/machines/local/config",
      headers: { "accept-encoding": "gzip" },
    });
    const identity = await appTestContext.app.inject({
      method: "GET",
      url: "/api/machines/local/config",
      headers: { "accept-encoding": "identity" },
    });

    expect(compressed.statusCode).toBe(200);
    expect(compressed.headers["content-encoding"]).toBe("gzip");
    expect(compressed.headers["content-length"]).toBeUndefined();
    expect(compressed.headers.vary).toContain("accept-encoding");
    expect(gunzipJson(compressed)).toMatchObject({ effectiveConfig: { plugins: { fake: { settings: { marker } } } } });

    expect(identity.statusCode).toBe(200);
    expect(identity.headers["content-encoding"]).toBeUndefined();
    expect(identity.json()).toMatchObject({ effectiveConfig: { plugins: { fake: { settings: { marker } } } } });
  });

  it("negotiates compression after streaming a remote-machine API response", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/machines",
      payload: { name: "Remote", baseUrl: "https://remote.example.test/" },
    });
    const remote = addResponse.json<{ id: string }>();
    const projects = Array.from({ length: 64 }, (_, index) => ({
      id: `p-${String(index)}`,
      name: `Remote project ${String(index)}`,
      path: `/repos/project-${String(index)}`,
      createdAt: "2026-07-11T00:00:00.000Z",
    }));
    const body = JSON.stringify(projects);
    const request = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
      body: Readable.from([body]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });
    const url = `/api/machines/${remote.id}/projects`;

    const compressed = await appTestContext.app.inject({
      method: "GET",
      url,
      headers: { "accept-encoding": "gzip" },
    });
    const identity = await appTestContext.app.inject({
      method: "GET",
      url,
      headers: { "accept-encoding": "identity" },
    });

    expect(compressed.statusCode).toBe(200);
    expect(compressed.headers["content-encoding"]).toBe("gzip");
    expect(compressed.headers["content-length"]).toBeUndefined();
    expect(compressed.headers.vary).toContain("accept-encoding");
    expect(gunzipJson(compressed)).toEqual(projects);

    expect(identity.statusCode).toBe(200);
    expect(identity.headers["content-encoding"]).toBeUndefined();
    expect(identity.json()).toEqual(projects);
    expect(request).toHaveBeenNthCalledWith(1, "GET", "/api/projects", undefined);
    expect(request).toHaveBeenNthCalledWith(2, "GET", "/api/projects", undefined);
  });
});

function gunzipJson(response: { rawPayload: Buffer }): unknown {
  const value: unknown = JSON.parse(gunzipSync(response.rawPayload).toString("utf8"));
  return value;
}
