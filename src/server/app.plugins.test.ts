import { writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { machineScopedPluginId } from "../shared/machinePluginIds.js";
import { proxyMachinePluginManifest } from "./machines/machinePluginProxyRoutes.js";
import type { MachineClient, MachineRequestOptions } from "./machines/machineClient.js";
import { appTestContext, fakeRemoteClient, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();

const MOVE_TASK_REQUEST = {
  operationId: "00000000-0000-4000-8000-000000000001",
  intent: "start",
  source: {
    ref: { scope: "workspace", id: "build" },
    expectedCatalog: {
      kind: "loaded",
      revision: "workspace-revision",
      config: {
        version: 1,
        tasks: [{ id: "build", title: "Build", command: "npm run build", confirm: false }],
      },
    },
  },
  destination: {
    scope: "global",
    expectedCatalog: { kind: "loaded", revision: "global-revision", config: { version: 1, tasks: [] } },
    task: { id: "build", title: "Build", command: "npm run build", confirm: false },
  },
};

interface RawReply extends EventEmitter {
  writableFinished: boolean;
  destroyed: boolean;
}

interface ReplyWrite {
  readonly statusCode: number | undefined;
  readonly body: unknown;
}

interface ReplyObserver {
  readonly reply: FastifyReply;
  readonly raw: RawReply;
  readonly writes: ReplyWrite[];
}

interface DeferredManifestRequest {
  readonly client: MachineClient;
  readonly started: Promise<void>;
  options(): MachineRequestOptions | undefined;
}

/** The manifest route keeps its own 10-second budget and gains only the reply-owned signal. */
function expectManifestBudget(options: MachineRequestOptions | undefined): void {
  expect(Object.keys(options ?? {}).sort()).toEqual(["signal", "timeoutMs"]);
  expect(options?.timeoutMs).toBe(10_000);
  expect(options?.signal).toBeInstanceOf(AbortSignal);
}

interface FakeReply {
  readonly raw: RawReply;
  code(statusCode: number): FakeReply;
  send(body?: unknown): FakeReply;
}

/** Captures the reply the manifest route writes through, so a disconnect can be
 * emitted while the upstream read is still pending. */
function injectReplyObserver(): ReplyObserver {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the outgoing ServerResponse is an event emitter plus the two flags the scope reads.
  const raw = new EventEmitter() as RawReply;
  raw.writableFinished = false;
  raw.destroyed = false;
  const writes: ReplyWrite[] = [];
  let statusCode: number | undefined;
  const fake: FakeReply = {
    raw,
    code(status) {
      statusCode = status;
      return fake;
    },
    send(body) {
      writes.push({ statusCode, body });
      return fake;
    },
  };
  return { reply: asFastifyReply(fake), raw, writes };
}

function asFastifyReply(reply: FakeReply): FastifyReply {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub with the minimal reply surface the manifest route writes through.
  return reply as unknown as FastifyReply;
}

/** Remote client whose manifest read stays pending until the caller signal aborts,
 * mirroring RemoteMachineClient's caller-cancellation contract. */
function deferredManifestRequest(): DeferredManifestRequest {
  let markStarted = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let captured: MachineRequestOptions | undefined;
  const client = fakeRemoteClient({
    requestJson: (_method, _path, _body, options) => new Promise<never>((_resolve, reject) => {
      captured = options;
      markStarted();
      const signal = options?.signal;
      signal?.addEventListener("abort", () => {
        reject(signal.reason instanceof Error ? signal.reason : new DOMException("The response was disconnected", "AbortError"));
      }, { once: true });
    }),
  });
  return { client, started, options: () => captured };
}

describe("buildApp PI WEBUI plugin routes", () => {
  it("serves application-root plugin modules through the manifest and plugin-list APIs", async () => {
    const manifestResponse = await appTestContext.app.inject({ method: "GET", url: "/pi-webui-plugins/manifest.json" });
    expect(manifestResponse.statusCode).toBe(200);
    expect(manifestResponse.json()).toEqual({ plugins: [{ id: "fake", module: "/pi-webui-plugins/fake/plugin.js?v=1", source: "test", scope: "local", machineSpecific: false }] });

    const pluginsResponse = await appTestContext.app.inject({ method: "GET", url: "/api/plugins" });
    expect(pluginsResponse.statusCode).toBe(200);
    expect(pluginsResponse.json()).toEqual({ plugins: [{ id: "fake", module: "/pi-webui-plugins/fake/plugin.js?v=1", source: "test", scope: "local", machineSpecific: false, enabled: true }] });

    const localMachinePluginsResponse = await appTestContext.app.inject({ method: "GET", url: "/api/machines/local/plugins" });
    expect(localMachinePluginsResponse.statusCode).toBe(200);
    expect(localMachinePluginsResponse.json()).toEqual({ plugins: [{ id: "fake", module: "/pi-webui-plugins/fake/plugin.js?v=1", source: "test", scope: "local", machineSpecific: false, enabled: true }] });

    const assetResponse = await appTestContext.app.inject({ method: "GET", url: "/pi-webui-plugins/fake/plugin.js?v=1" });
    expect(assetResponse.statusCode).toBe(200);
    expect(assetResponse.headers["content-type"]).toContain("application/javascript");
    expect(assetResponse.body).toBe("export default {};");

    const svgResponse = await appTestContext.app.inject({ method: "GET", url: "/pi-webui-plugins/fake/assets/icon.svg" });
    expect(svgResponse.statusCode).toBe(200);
    expect(svgResponse.headers["content-type"]).toContain("image/svg+xml");
    expect(svgResponse.body).toContain("<svg");

    const missingResponse = await appTestContext.app.inject({ method: "GET", url: "/pi-webui-plugins/fake/missing.js" });
    expect(missingResponse.statusCode).toBe(404);
  });

  it("proxies remote machine plugin lists for settings", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json", "set-cookie": "secret=1" },
      body: Readable.from([JSON.stringify({ plugins: [{ id: "remote-tools", module: "/pi-webui-plugins/remote-tools/plugin.js", source: "local", scope: "local", machineSpecific: false, enabled: false }] })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/plugins` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.json()).toEqual({ plugins: [{ id: "remote-tools", module: "/pi-webui-plugins/remote-tools/plugin.js", source: "local", scope: "local", machineSpecific: false, enabled: false }] });
    expect(request).toHaveBeenCalledWith("GET", "/api/plugins", undefined);
  });

  it("rewrites existing root-style remote plugin manifests and proxies their assets", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const requestJson = vi.fn<MachineClient["requestJson"]>(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: { plugins: [{ id: "remote-tools", module: "/pi-webui-plugins/remote-tools/pi-webui-plugin.js?v=123", source: "local", scope: "local", machineSpecific: true }] },
    }));
    const request = vi.fn(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/javascript", "set-cookie": "secret=1" },
      body: Readable.from(["export default {};"]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ requestJson, request });

    const manifestResponse = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/pi-webui-plugins/manifest.json` });
    const scopedPluginId = machineScopedPluginId(remote.id, "remote-tools");
    const rewrittenModule = `../../../../pi-webui-plugins/${scopedPluginId}/pi-webui-plugin.js?v=123`;
    expect(manifestResponse.statusCode).toBe(200);
    expect(manifestResponse.json()).toEqual({
      plugins: [{ id: "remote-tools", module: rewrittenModule, source: "local", scope: "local", machineSpecific: true }],
    });
    expect(new URL(rewrittenModule, `https://gateway.example.test/api/machines/${remote.id}/pi-webui-plugins/manifest.json`).toString())
      .toBe(`https://gateway.example.test/pi-webui-plugins/${scopedPluginId}/pi-webui-plugin.js?v=123`);
    expect(new URL(rewrittenModule, `https://gateway.example.test/test/ai/api/machines/${remote.id}/pi-webui-plugins/manifest.json`).toString())
      .toBe(`https://gateway.example.test/test/ai/pi-webui-plugins/${scopedPluginId}/pi-webui-plugin.js?v=123`);
    const [, , , manifestOptions] = requestJson.mock.calls[0] ?? [];
    expectManifestBudget(manifestOptions);

    const assetResponse = await appTestContext.app.inject({ method: "GET", url: `/pi-webui-plugins/${scopedPluginId}/pi-webui-plugin.js?v=123` });
    expect(assetResponse.statusCode).toBe(200);
    expect(assetResponse.headers["content-type"]).toContain("application/javascript");
    expect(assetResponse.headers["set-cookie"]).toBeUndefined();
    expect(assetResponse.body).toBe("export default {};");
    expect(request).toHaveBeenCalledWith("GET", "/pi-webui-plugins/remote-tools/pi-webui-plugin.js?v=123");
  });

  it("cancels a disconnected manifest read while keeping its own budget", async () => {
    const manifest = deferredManifestRequest();
    const observer = injectReplyObserver();
    const pending = proxyMachinePluginManifest({ remoteClient: () => Promise.resolve(manifest.client) }, "remote-machine", observer.reply);

    await manifest.started;
    expectManifestBudget(manifest.options());

    observer.raw.emit("close");

    await expect(pending).resolves.toBe(observer.reply);
    expect(manifest.options()?.signal?.aborted).toBe(true);
    expect(observer.writes).toEqual([]);
    expect(observer.raw.listenerCount("finish")).toBe(0);
  });

  it("propagates invalid machine registry errors from manifest lookup", async () => {
    await writeFile(`${appTestContext.tempDir}/machines.json`, JSON.stringify({ machines: "invalid" }), "utf8");

    const response = await appTestContext.app.inject({ method: "GET", url: "/api/machines/remote-a/pi-webui-plugins/manifest.json" });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain("Invalid machine file");
  });

  it("accepts manifest-relative and legacy plugin-root-relative modules while dropping unsafe remote modules", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    appTestContext.remoteClient = fakeRemoteClient({
      requestJson: vi.fn(() => Promise.resolve({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: {
          plugins: [
            { id: "safe-tools", module: "./safe-tools/nested/pi-webui-plugin.js?v=1", source: "local", scope: "local" },
            { id: "legacy-tools", module: "nested/pi-webui-plugin.js?v=2", source: "local", scope: "local" },
            { id: "traversal-tools", module: "./traversal-tools/..%2F..%2Fapi%2Fconfig", source: "local", scope: "local" },
            { id: "wrong-root", module: "/pi-webui-plugins/other/pi-webui-plugin.js", source: "local", scope: "local" },
            { id: "cross-origin", module: "https://plugins.example.test/pi-webui-plugin.js", source: "local", scope: "local" },
            { id: "malformed", module: "nested/%E0%A4%A.js", source: "local", scope: "local" },
          ],
        },
      })),
    });

    const manifestResponse = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${remote.id}/pi-webui-plugins/manifest.json` });

    expect(manifestResponse.statusCode).toBe(200);
    expect(manifestResponse.json()).toEqual({
      plugins: [
        { id: "safe-tools", module: `../../../../pi-webui-plugins/${machineScopedPluginId(remote.id, "safe-tools")}/nested/pi-webui-plugin.js?v=1`, source: "local", scope: "local" },
        { id: "legacy-tools", module: `../../../../pi-webui-plugins/${machineScopedPluginId(remote.id, "legacy-tools")}/nested/pi-webui-plugin.js?v=2`, source: "local", scope: "local" },
      ],
    });
  });

  it("rejects remote machine plugin asset traversal before proxying", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn(() => Promise.resolve({ statusCode: 200, headers: {}, body: Readable.from([]) }));
    appTestContext.remoteClient = fakeRemoteClient({ request });
    const scopedPluginId = machineScopedPluginId(remote.id, "remote-tools");

    const response = await appTestContext.app.inject({ method: "GET", url: `/pi-webui-plugins/${scopedPluginId}/..%2F..%2Fapi%2Fconfig` });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid remote PI WEBUI plugin asset path" });
    expect(request).not.toHaveBeenCalled();
  });

  it("leaves a remote workspace-task move on the stored machine budget", async () => {
    const addResponse = await appTestContext.app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } });
    const remote = addResponse.json<{ id: string }>();
    const request = vi.fn<MachineClient["request"]>(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify({ moved: true })]),
    }));
    appTestContext.remoteClient = fakeRemoteClient({ request });
    const movePath = "/projects/project-1/workspaces/workspace-1/workspace-tasks/move";

    const response = await appTestContext.app.inject({
      method: "POST",
      url: `/api/machines/${remote.id}${movePath}`,
      payload: MOVE_TASK_REQUEST,
    });

    expect(response.statusCode).toBe(200);
    // The route carries no per-route override, so the stored machine/default budget resolves.
    expect(request.mock.calls[0]).toEqual(["POST", `/api${movePath}`, MOVE_TASK_REQUEST]);
  });
});
