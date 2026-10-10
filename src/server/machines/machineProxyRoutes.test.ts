import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiWebUiConfigResponse } from "../../shared/apiTypes.js";
import type { MachineClient } from "./machineClient.js";
import { registerMachineProxyRoutes } from "./machineProxyRoutes.js";
import { MachineService } from "./machineService.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("machine proxy selected-machine config route", () => {
  it("preserves sessiond and sessiondUrl across a remote config round-trip", async () => {
    const sessiond = { host: "0.0.0.0", port: 8810, url: "http://127.0.0.1:8810" };
    const upstream: PiWebUiConfigResponse = {
      path: "/home/remote/.config/pi-webui/config.json",
      exists: true,
      config: { host: "127.0.0.1", port: 8808, shortcuts: { "core:view.chat": "mod+1" }, sessiond, agent: { command: "agent-lab", dir: "/srv/agent-lab" } },
      effectiveConfig: { host: "127.0.0.1", port: 8808, shortcuts: { "core:view.chat": "mod+1" }, sessiond, agent: { command: "agent-lab", dir: "/srv/agent-lab" } },
      envOverrides: {
        host: false,
        port: false,
        allowedHosts: false,
        spawnSessions: false,
        subsessions: false,
        agentCommand: false,
        agentDir: false,
        agentSessionDir: false,
        sessiondUrl: true,
      },
    };
    const machines = new MachineService();
    vi.spyOn(machines, "remoteClient").mockResolvedValue(fakeClient(upstream));
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    registerMachineProxyRoutes(app, machines);

    const response = await app.inject({ method: "GET", url: "/api/machines/remote-a/config" });

    expect(response.statusCode).toBe(200);
    const body = response.json<PiWebUiConfigResponse>();
    expect(body.config.sessiond).toEqual(sessiond);
    expect(body.effectiveConfig.sessiond).toEqual(sessiond);
    expect(body.envOverrides.sessiondUrl).toBe(true);
    expect(body.config).not.toHaveProperty("host");
    expect(body.config).not.toHaveProperty("port");
    expect(body.config).not.toHaveProperty("shortcuts");
  });
});

function fakeClient(body: PiWebUiConfigResponse): MachineClient {
  return {
    request: () => Promise.reject(new Error("raw request not configured for this test")),
    requestJson: () => Promise.resolve({ statusCode: 200, headers: {}, body }),
    connectWebSocket: () => { throw new Error("WebSocket not configured for this test"); },
  };
}
