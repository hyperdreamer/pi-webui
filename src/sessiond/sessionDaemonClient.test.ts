import { rm } from "node:fs/promises";
import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { SessionDaemonClient } from "./sessionDaemonClient.js";

const activeAgentProfile = {
  schemaVersion: 1,
  revision: `sha256:${"a".repeat(64)}`,
  command: "acme-agent",
  dir: "/opt/acme-agent/state",
  sessionDirEnvKeys: ["PI_WEBUI_AGENT_SESSION_DIR"],
};

describe("SessionDaemonClient active agent profile protocol", () => {
  it("returns the validated immutable profile from the daemon runtime endpoint", async () => {
    const client = new SessionDaemonClient();
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
    const invalidClient = new SessionDaemonClient();
    vi.spyOn(invalidClient, "request").mockResolvedValue(runtimeResponse({
      ...activeAgentProfile,
      token: "must-not-cross-the-protocol",
    }));
    const unavailableClient = new SessionDaemonClient();
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
    const client = new SessionDaemonClient();
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
    const client = new SessionDaemonClient();
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
      const client = new SessionDaemonClient();
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
      const client = new SessionDaemonClient();
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
      const client = new SessionDaemonClient();
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
      const client = new SessionDaemonClient();
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
      const client = new SessionDaemonClient();
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
