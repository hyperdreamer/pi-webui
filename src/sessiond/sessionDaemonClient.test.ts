import { rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionDaemonClient } from "./sessionDaemonClient.js";

const testConfigPath = join(tmpdir(), `pi-webui-sessiond-client-config-${String(process.pid)}-${String(Date.now())}.json`);

const activeAgentProfile = {
  schemaVersion: 1,
  revision: `sha256:${"a".repeat(64)}`,
  command: "acme-agent",
  dir: "/opt/acme-agent/state",
  sessionDirEnvKeys: ["PI_WEBUI_AGENT_SESSION_DIR"],
};

describe("SessionDaemonClient active agent profile protocol", () => {
  it("returns the validated immutable profile from the daemon runtime endpoint", async () => {
    const client = new SessionDaemonClient({ env: { PI_WEBUI_CONFIG: testConfigPath } });
    const request = vi.spyOn(client, "request").mockResolvedValue(runtimeResponse(activeAgentProfile));

    const result = await client.getActiveAgentProfile();

    expect(request).toHaveBeenCalledWith("GET", "/runtime");
    expect(result).toEqual({ status: "available", profile: activeAgentProfile });
    if (result.status === "available") {
      expect(Object.isFrozen(result.profile)).toBe(true);
      expect(Object.isFrozen(result.profile.sessionDirEnvKeys)).toBe(true);
    }
  });

  it("distinguishes invalid protocol responses from daemon unavailability", async () => {
    const invalidClient = new SessionDaemonClient({ env: { PI_WEBUI_CONFIG: testConfigPath } });
    vi.spyOn(invalidClient, "request").mockResolvedValue(runtimeResponse({
      ...activeAgentProfile,
      token: "must-not-cross-the-protocol",
    }));
    const unavailableClient = new SessionDaemonClient({ env: { PI_WEBUI_CONFIG: testConfigPath } });
    vi.spyOn(unavailableClient, "request").mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(invalidClient.getActiveAgentProfile()).resolves.toEqual({
      status: "invalid",
      error: "session daemon runtime response was invalid",
    });
    await expect(unavailableClient.getActiveAgentProfile()).resolves.toEqual({
      status: "unavailable",
      error: "connect ECONNREFUSED",
    });
  });

  it.skipIf(process.platform === "win32")("rejects foreign-platform active state paths before local consumers use them", async () => {
    const client = new SessionDaemonClient({ env: { PI_WEBUI_CONFIG: testConfigPath } });
    vi.spyOn(client, "request").mockResolvedValue(runtimeResponse({
      ...activeAgentProfile,
      dir: "C:\\agent-profiles\\acme",
    }));

    await expect(client.getActiveAgentProfile()).resolves.toEqual({
      status: "invalid",
      error: "session daemon active agent profile was not valid for this host",
    });
  });

  it("treats a legacy runtime response without a profile as invalid for profile-dependent work", async () => {
    const client = new SessionDaemonClient({ env: { PI_WEBUI_CONFIG: testConfigPath } });
    vi.spyOn(client, "request").mockResolvedValue(runtimeResponse(undefined));

    await expect(client.getActiveAgentProfile()).resolves.toEqual({
      status: "invalid",
      error: "session daemon runtime response did not include an active agent profile",
    });
  });

  it("passes an abort signal to TCP requests and rejects promptly when it is aborted", async () => {
    vi.stubEnv("PI_WEBUI_SESSIOND_URL", "http://127.0.0.1:43123");
    const fetchMock = vi.fn((_input: URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { reject(new DOMException("aborted", "AbortError")); }, { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new SessionDaemonClient({ env: { PI_WEBUI_CONFIG: testConfigPath, PI_WEBUI_SESSIOND_URL: "http://127.0.0.1:43123" } });
      const controller = new AbortController();

      const request = client.request("POST", "/speech-input/polish", { text: "pending" }, controller.signal);
      expect(fetchMock).toHaveBeenCalledWith(
        new URL("/speech-input/polish", "http://127.0.0.1:43123"),
        expect.objectContaining({ signal: controller.signal }),
      );
      controller.abort();

      await expect(request).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });


  it("rejects promptly when TCP response body reading is still pending at abort", async () => {
    vi.stubEnv("PI_WEBUI_SESSIOND_URL", "http://127.0.0.1:43123");
    const text = vi.fn(() => new Promise<string>(() => undefined));
    const response = new Response(null, { status: 200, headers: { "content-type": "application/json" } });
    vi.spyOn(response, "text").mockImplementation(text);
    const fetchMock = vi.fn(() => Promise.resolve(response));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new SessionDaemonClient({ env: { PI_WEBUI_CONFIG: testConfigPath, PI_WEBUI_SESSIOND_URL: "http://127.0.0.1:43123" } });
      const controller = new AbortController();
      const pending = client.request("POST", "/speech-input/polish", { text: "pending" }, controller.signal);
      await new Promise<void>((resolve) => setImmediate(() => { resolve(); }));
      controller.abort();
      await expect(Promise.race([
        pending.then(() => "resolved", () => "rejected"),
        new Promise<string>((resolve) => setTimeout(() => { resolve("pending"); }, 250)),
      ])).resolves.toBe("rejected");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it.skipIf(process.platform === "win32")("completes a Unix daemon request normally", async () => {
    const socketPath = `/tmp/pi-webui-sessiond-client-success-${String(process.pid)}-${String(Date.now())}.sock`;
    vi.stubEnv("PI_WEBUI_SESSIOND_URL", "");
    vi.stubEnv("PI_WEBUI_SESSIOND_SOCKET", socketPath);
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ text: "polished" }));
    });
    await listenUnix(server, socketPath);
    try {
      const client = new SessionDaemonClient({ env: { PI_WEBUI_CONFIG: testConfigPath } });
      await expect(client.request("POST", "/speech-input/polish", { text: "raw" })).resolves.toEqual(expect.objectContaining({
        statusCode: 200,
        body: JSON.stringify({ text: "polished" }),
      }));
    } finally {
      await closeUnix(server, socketPath);
      vi.unstubAllEnvs();
    }
  });

  it.skipIf(process.platform === "win32")("rejects promptly when a Unix daemon disconnects mid-response", async () => {
    const socketPath = `/tmp/pi-webui-sessiond-client-response-${String(process.pid)}-${String(Date.now())}.sock`;
    vi.stubEnv("PI_WEBUI_SESSIOND_URL", "");
    vi.stubEnv("PI_WEBUI_SESSIOND_SOCKET", socketPath);
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"text":"partial"');
      response.destroy();
    });
    await listenUnix(server, socketPath);
    try {
      const client = new SessionDaemonClient({ env: { PI_WEBUI_CONFIG: testConfigPath } });
      const request = client.request("POST", "/speech-input/polish", { text: "pending" });
      await expect(Promise.race([
        request.then(() => "resolved", () => "rejected"),
        new Promise<string>((resolve) => setTimeout(() => { resolve("pending"); }, 250)),
      ])).resolves.toBe("rejected");
    } finally {
      await closeUnix(server, socketPath);
      vi.unstubAllEnvs();
    }
  });


  it("aborts the HTTP and Unix daemon transports while leaving an unrelated daemon read independent", async () => {
    const controller = new AbortController();
    const httpSignals: (AbortSignal | undefined)[] = [];
    let resolveUnrelated: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn((_input: URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? undefined;
      httpSignals.push(signal);
      if (signal === undefined) {
        // An unsignalled read on the same client must not inherit another request's abort.
        resolveUnrelated = resolve;
        return;
      }
      if (signal.aborted) {
        reject(signalReason(signal));
        return;
      }
      signal.addEventListener("abort", () => { reject(signalReason(signal)); }, { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    // The Unix transport is stubbed, so this test never opens a socket.
    const unixRequest = fakeClientRequest();
    const requestSpy = vi.spyOn(http, "request").mockImplementation(() => unixRequest.request);
    try {
      vi.stubEnv("PI_WEBUI_SESSIOND_URL", "http://127.0.0.1:43123");
      const httpClient = new SessionDaemonClient({ env: { PI_WEBUI_CONFIG: testConfigPath, PI_WEBUI_SESSIOND_URL: "http://127.0.0.1:43123" } });
      const unrelated = httpClient.request("GET", "/sessions/unread");
      const httpPending = httpClient.request("GET", "/sessions?cwd=%2Frepo", undefined, controller.signal);

      vi.stubEnv("PI_WEBUI_SESSIOND_URL", "");
      const unixClient = new SessionDaemonClient({ env: { PI_WEBUI_CONFIG: testConfigPath, PI_WEBUI_SESSIOND_URL: "" } });
      const unixPending = unixClient.request("GET", "/sessions?cwd=%2Frepo", undefined, controller.signal);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(httpSignals[0]).toBeUndefined();
      expect(httpSignals[1]).toBe(controller.signal);

      controller.abort(new Error("browser disconnected"));

      await expect(httpPending).rejects.toThrow("browser disconnected");
      await expect(unixPending).rejects.toThrow("browser disconnected");
      expect(httpSignals[1]?.aborted).toBe(true);
      expect(unixRequest.request.destroyed).toBe(true);

      // The unrelated read settles on its own transport after the abort.
      expect(resolveUnrelated).toBeTypeOf("function");
      resolveUnrelated?.(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
      await expect(unrelated).resolves.toEqual(expect.objectContaining({ statusCode: 200, body: "[]" }));
    } finally {
      requestSpy.mockRestore();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it.skipIf(process.platform === "win32")("destroys a pending Unix request and rejects on explicit abort", async () => {
    const socketPath = `/tmp/pi-webui-sessiond-client-abort-${String(process.pid)}-${String(Date.now())}.sock`;
    vi.stubEnv("PI_WEBUI_SESSIOND_URL", "");
    vi.stubEnv("PI_WEBUI_SESSIOND_SOCKET", socketPath);
    let requestReceived = false;
    let requestClosed = false;
    const server = http.createServer((request) => {
      requestReceived = true;
      request.once("close", () => { requestClosed = true; });
    });
    await listenUnix(server, socketPath);
    try {
      const client = new SessionDaemonClient({ env: { PI_WEBUI_CONFIG: testConfigPath } });
      const controller = new AbortController();
      const pending = client.request("POST", "/speech-input/polish", { text: "pending" }, controller.signal);
      await waitFor(() => requestReceived);
      controller.abort();
      await expect(Promise.race([
        pending.then(() => "resolved", () => "rejected"),
        new Promise<string>((resolve) => setTimeout(() => { resolve("pending"); }, 250)),
      ])).resolves.toBe("rejected");
      await waitFor(() => requestClosed);
    } finally {
      await closeUnix(server, socketPath);
      vi.unstubAllEnvs();
    }
  });
});

async function listenUnix(server: http.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { resolve(); });
  });
}

async function closeUnix(server: http.Server, socketPath: string): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined && !(error instanceof Error && "code" in error && error.code === "ERR_SERVER_NOT_RUNNING")) reject(error);
      else resolve();
    });
  });
  await rm(socketPath, { force: true });
}

interface FakeClientRequest {
  readonly request: http.ClientRequest & { destroyed: boolean };
}

/** Stands in for `http.request` so an aborted Unix transport is observable without a socket. */
function fakeClientRequest(): FakeClientRequest {
  const emitter = new EventEmitter();
  const request = Object.assign(emitter, {
    destroyed: false,
    write: () => true,
    end: () => undefined,
    destroy: () => {
      request.destroyed = true;
      return request;
    },
  });
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the stub only needs the ClientRequest surface the transport touches.
  return { request: request as unknown as http.ClientRequest & { destroyed: boolean } };
}

function signalReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for Unix request close");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function runtimeResponse(profile: unknown) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      component: "sessiond",
      label: "Session daemon",
      available: true,
      capabilities: [],
      ...(profile === undefined ? {} : { activeAgentProfile: profile }),
    }),
  };
}
