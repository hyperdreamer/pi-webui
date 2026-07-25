import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseNetDevSnapshot, registerSystemInfoRoutes, type SystemInfoRouteDependencies } from "./systemInfoRoutes";

let app: FastifyInstance;

beforeEach(() => {
  app = Fastify({ logger: false });
});

afterEach(async () => {
  await app.close();
});

describe("system metrics route", () => {
  it("returns lightweight memory and network metrics without a full system snapshot", async () => {
    const metrics = {
      generatedAt: "2026-03-10T12:00:00.000Z",
      memory: { totalBytes: 1_000, usedBytes: 750, freeBytes: 250, usagePercent: 75 },
      network: { downloadSpeedBytesPerSecond: 1_500_000, uploadSpeedBytesPerSecond: 250_000 },
    };
    const collectDynamicSystemMetrics = vi.fn(() => Promise.resolve(metrics));
    const dependencies: SystemInfoRouteDependencies & { collectDynamicSystemMetrics: () => Promise<typeof metrics> } = { collectDynamicSystemMetrics };
    registerSystemInfoRoutes(app, "/api/pi-webui", dependencies);

    const response = await app.inject({ method: "GET", url: "/api/pi-webui/system-metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(metrics);
    expect(collectDynamicSystemMetrics).toHaveBeenCalledOnce();
  });
});

describe("parseNetDevSnapshot", () => {
  it("aggregates received and transmitted bytes across non-loopback interfaces", () => {
    const snapshot = parseNetDevSnapshot(`
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 100 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0
  eth0: 1000 1 0 0 0 0 0 0 2000 1 0 0 0 0 0 0
 wlan0: 3000 1 0 0 0 0 0 0 4000 1 0 0 0 0 0 0
`);

    expect(snapshot).toEqual({ rxBytes: 4000, txBytes: 6000 });
  });

  it("returns no snapshot when only the loopback interface is present", () => {
    expect(parseNetDevSnapshot(`
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 100 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0
`)).toBeUndefined();
  });
});
