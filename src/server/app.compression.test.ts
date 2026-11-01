import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { appTestContext, fakeRemoteClient, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();

// `expect.any` is typed `any` by vitest; the matcher is asserted at the assertion site.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const REPLY_OWNED_SIGNAL = expect.objectContaining({ signal: expect.any(AbortSignal) });

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
    expect(request).toHaveBeenNthCalledWith(1, "GET", "/api/projects", undefined, REPLY_OWNED_SIGNAL);
    expect(request).toHaveBeenNthCalledWith(2, "GET", "/api/projects", undefined, REPLY_OWNED_SIGNAL);
  });

  it("flushes delayed remote headers after compression negotiation", async () => {
    const projects = Array.from({ length: 64 }, (_, index) => ({
      id: `p-${String(index)}`,
      name: `Remote project ${String(index)}`,
    }));
    const body = JSON.stringify(projects);
    const source = deferredStreamBody();
    const flush = observeFlushFor("/projects", () => source.emitted());
    const url = await remoteProjectsUrl(source.stream, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    });

    const pending = appTestContext.app.inject({ method: "GET", url, headers: { "accept-encoding": "gzip" } });
    const observed = await flush.flushed;

    expect(observed.emitted).toBe(0);
    expect(observed.statusCode).toBe(200);
    expect(observed.headers["content-encoding"]).toBe("gzip");
    expect(String(observed.headers["vary"]).toLowerCase()).toContain("accept-encoding");
    expect(observed.headers["content-length"]).toBeUndefined();

    source.release(body);
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(gunzipJson(response)).toEqual(projects);
  });

  it("preserves identity negotiation with an eagerly flushed stream", async () => {
    const source = deferredStreamBody();
    const flush = observeFlushFor("/projects", () => source.emitted());
    const url = await remoteProjectsUrl(source.stream, {
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
    });

    const pending = appTestContext.app.inject({ method: "GET", url, headers: { "accept-encoding": "identity" } });
    const observed = await flush.flushed;

    expect(observed.emitted).toBe(0);
    expect(observed.headers["content-encoding"]).toBeUndefined();
    expect(observed.headers["x-content-type-options"]).toBe("nosniff");

    source.release(JSON.stringify([{ id: "p-0" }]));
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.json()).toEqual([{ id: "p-0" }]);
  });
});

interface FlushObservation {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | number | undefined>;
  /** Source chunks emitted when the raw response flushed its headers. */
  readonly emitted: number;
}

/**
 * Records the first `flushHeaders()` on the raw response of the streamed remote
 * route, so header timing is observed before the deferred body releases a byte.
 */
function observeFlushFor(urlSuffix: string, emitted: () => number): { flushed: Promise<FlushObservation> } {
  let resolveFlush: (value: FlushObservation) => void = () => undefined;
  const flushed = new Promise<FlushObservation>((resolve) => { resolveFlush = resolve; });
  appTestContext.app.addHook("onSend", async (request, reply, payload) => {
    if (!request.url.endsWith(urlSuffix)) return payload;
    const raw = reply.raw;
    const writeHeaders = raw.flushHeaders.bind(raw);
    raw.flushHeaders = () => {
      resolveFlush({ statusCode: raw.statusCode, headers: { ...raw.getHeaders() }, emitted: emitted() });
      writeHeaders();
    };
    return payload;
  });
  return { flushed };
}

async function remoteProjectsUrl(body: NodeJS.ReadableStream, headers: Record<string, string>): Promise<string> {
  const addResponse = await appTestContext.app.inject({
    method: "POST",
    url: "/api/machines",
    payload: { name: "Remote", baseUrl: "https://remote.example.test/" },
  });
  const remote = addResponse.json<{ id: string }>();
  appTestContext.remoteClient = fakeRemoteClient({
    request: () => Promise.resolve({ statusCode: 200, headers, body }),
  });
  return `/api/machines/${remote.id}/projects`;
}

function deferredStreamBody(): { stream: Readable; emitted(): number; release(chunk: string): void } {
  let emitted = 0;
  const stream = new Readable({
    read() {
      // Chunks are pushed explicitly by the test.
    },
  });
  return {
    stream,
    emitted: () => emitted,
    release: (chunk) => {
      emitted += 1;
      stream.push(chunk);
      stream.push(null);
    },
  };
}

function gunzipJson(response: { rawPayload: Buffer }): unknown {
  const value: unknown = JSON.parse(gunzipSync(response.rawPayload).toString("utf8"));
  return value;
}
