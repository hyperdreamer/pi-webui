import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiWebUiRuntimeResponse } from "../../shared/apiTypes.js";
import { PI_WEBUI_CAPABILITIES } from "../../shared/capabilities.js";
import type { MachineClient } from "./machineClient.js";
import { MachineService, type UpdateMachineInput } from "./machineService.js";
import { MachineStore, machineStorePath } from "./machineStore.js";

const INVALID_REQUEST_TIMEOUT_MESSAGE = "requestTimeoutMs must be an integer between 5000 and 180000 milliseconds";

let tempDir: string;
let storePath: string;
let service: MachineService;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-webui-machines-test-"));
  storePath = join(tempDir, "machines.json");
  service = new MachineService(new MachineStore(storePath));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("MachineService", () => {
  it("synthesizes local machine without persisting it", async () => {
    expect(await service.list()).toEqual([
      { id: "local", name: "Local", kind: "local", createdAt: "1970-01-01T00:00:00.000Z", updatedAt: "1970-01-01T00:00:00.000Z" },
    ]);
    await expect(stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("adds remote machines and omits secrets from public responses", async () => {
    const machine = await service.add({ name: " Dev Box ", baseUrl: "https://devbox.example.test/", token: "secret" });

    expect(machine).toMatchObject({ name: "Dev Box", kind: "remote", baseUrl: "https://devbox.example.test" });
    expect(machine).not.toHaveProperty("token");
    expect(await service.list()).toEqual([expect.objectContaining({ id: "local", kind: "local" }), machine]);

    const raw: unknown = JSON.parse(await readFile(storePath, "utf8"));
    expect(raw).toMatchObject({ machines: [expect.objectContaining({ kind: "remote", token: "secret" })] });
    await expectOwnerOnlyMachineStore(storePath);
  });

  it("gets, updates, and removes remote machines without exposing stored secrets", async () => {
    const machine = await service.add({
      name: "Remote",
      baseUrl: "https://remote.example.test",
      token: "initial-secret",
      headers: { "X-Pi-Web-Test": "initial" },
    });

    expect(await service.get(machine.id)).toEqual(machine);

    const updated = await service.update(machine.id, {
      name: " Updated Remote ",
      baseUrl: "https://updated.example.test/",
      token: "updated-secret",
      headers: { "X-Pi-Web-Test": "updated" },
    });
    if (updated === undefined) throw new Error("Expected remote machine update to succeed");

    expect(updated).toMatchObject({
      id: machine.id,
      name: "Updated Remote",
      kind: "remote",
      baseUrl: "https://updated.example.test",
      createdAt: machine.createdAt,
    });
    expect(updated).not.toHaveProperty("token");
    expect(updated).not.toHaveProperty("headers");
    expect(await service.get(machine.id)).toEqual(updated);
    expect(await service.list()).toEqual([expect.objectContaining({ id: "local", kind: "local" }), updated]);

    const persistedAfterUpdate: unknown = JSON.parse(await readFile(storePath, "utf8"));
    expect(persistedAfterUpdate).toMatchObject({
      machines: [expect.objectContaining({
        id: machine.id,
        name: "Updated Remote",
        baseUrl: "https://updated.example.test",
        token: "updated-secret",
        headers: { "X-Pi-Web-Test": "updated" },
      })],
    });

    await expect(service.remove(machine.id)).resolves.toBe(true);
    await expect(service.get(machine.id)).resolves.toBeUndefined();
    await expect(service.remove(machine.id)).resolves.toBe(false);
    expect(await service.list()).toEqual([expect.objectContaining({ id: "local", kind: "local" })]);

    const persistedAfterRemove: unknown = JSON.parse(await readFile(storePath, "utf8"));
    expect(persistedAfterRemove).toEqual({ machines: [] });
  });

  it("round trips a supplied requestTimeoutMs through the store", async () => {
    const machine = await service.add({ name: "Remote Lab", baseUrl: "https://remote.example.test", requestTimeoutMs: 5_000 });

    expect(machine).toMatchObject({ name: "Remote Lab", kind: "remote", requestTimeoutMs: 5_000 });
    expect(machine).not.toHaveProperty("token");

    const updated = await service.update(machine.id, { requestTimeoutMs: 180_000 });
    expect(updated).toMatchObject({ id: machine.id, requestTimeoutMs: 180_000 });
    expect(await service.get(machine.id)).toMatchObject({ id: machine.id, requestTimeoutMs: 180_000 });
    expect(await service.list()).toEqual([
      expect.objectContaining({ id: "local", kind: "local" }),
      expect.objectContaining({ id: machine.id, requestTimeoutMs: 180_000 }),
    ]);

    const persisted: unknown = JSON.parse(await readFile(storePath, "utf8"));
    expect(persisted).toMatchObject({ machines: [expect.objectContaining({ id: machine.id, requestTimeoutMs: 180_000 })] });
    await expectOwnerOnlyMachineStore(storePath);
  });

  it("projects requestTimeoutMs publicly without exposing secrets", async () => {
    const machine = await service.add({
      name: "Remote Lab",
      baseUrl: "https://remote.example.test",
      token: "secret",
      headers: { "X-Pi-Web-Test": "yes" },
      requestTimeoutMs: 90_000,
    });

    const fetched = await service.get(machine.id);
    expect(fetched).toMatchObject({ id: machine.id, requestTimeoutMs: 90_000 });
    expect(fetched).not.toHaveProperty("token");
    expect(fetched).not.toHaveProperty("headers");
    expect(await service.get("local")).not.toHaveProperty("requestTimeoutMs");
  });

  it("omits requestTimeoutMs for a record written before the setting existed", async () => {
    await writeFile(storePath, `${JSON.stringify({
      machines: [{
        id: "remote-1",
        name: "Remote",
        kind: "remote",
        baseUrl: "https://remote.example.test",
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z",
      }],
    }, null, 2)}\n`, "utf8");

    expect(await service.get("remote-1")).toMatchObject({ id: "remote-1", kind: "remote" });
    expect(await service.get("remote-1")).not.toHaveProperty("requestTimeoutMs");
    expect(await service.get("local")).not.toHaveProperty("requestTimeoutMs");
  });

  it("validates requestTimeoutMs before writing or invalidating caches", async () => {
    const requestJson = vi.fn<MachineClient["requestJson"]>(() => Promise.resolve({ statusCode: 200, headers: {}, body: remoteStatusBody() }));
    const remoteService = new MachineService(new MachineStore(storePath), {
      remoteClientFactory: () => fakeRemoteClient({ requestJson }),
      now: () => new Date("2026-05-25T00:00:00.000Z"),
      healthCacheTtlMs: 60_000,
    });
    const machine = await remoteService.add({ name: "Remote Lab", baseUrl: "https://remote.example.test", requestTimeoutMs: 5_000 });
    await remoteService.health(machine.id);
    const before = await remoteService.list();
    const fileBefore = await readFile(storePath, "utf8");
    const explicitUndefined = withOwnUndefinedRequestTimeout<UpdateMachineInput>({});

    await expect(remoteService.add({ name: "Bad", baseUrl: "https://bad.example.test", requestTimeoutMs: 120_000.5 })).rejects.toThrow(INVALID_REQUEST_TIMEOUT_MESSAGE);
    await expect(remoteService.add({ name: "Bad", baseUrl: "https://bad.example.test", requestTimeoutMs: 4_999 })).rejects.toThrow(INVALID_REQUEST_TIMEOUT_MESSAGE);
    await expect(remoteService.update(machine.id, { requestTimeoutMs: 180_001 })).rejects.toThrow(INVALID_REQUEST_TIMEOUT_MESSAGE);
    await expect(remoteService.update(machine.id, explicitUndefined)).rejects.toThrow(INVALID_REQUEST_TIMEOUT_MESSAGE);

    await expect(remoteService.list()).resolves.toEqual(before);
    await expect(readFile(storePath, "utf8")).resolves.toBe(fileBefore);
    await remoteService.health(machine.id);
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it("hands the stored requestTimeoutMs to the remote client while probes stay at three seconds", async () => {
    const timeouts: (number | undefined)[] = [];
    const factoryMachines: unknown[] = [];
    const requestJson = vi.fn<MachineClient["requestJson"]>((_method, path, _body, options) => {
      timeouts.push(options?.timeoutMs);
      return Promise.resolve({
        statusCode: 200,
        headers: {},
        body: path === "/api/pi-webui/runtime" ? remoteRuntimeBody() : remoteStatusBody(),
      });
    });
    const remoteService = new MachineService(new MachineStore(storePath), {
      remoteClientFactory: (remote) => {
        factoryMachines.push(remote);
        return fakeRemoteClient({ requestJson });
      },
      now: () => new Date("2026-05-25T00:00:00.000Z"),
    });
    const machine = await remoteService.add({ name: "Remote Lab", baseUrl: "https://remote.example.test", requestTimeoutMs: 180_000 });

    await remoteService.health(machine.id);
    await remoteService.runtime(machine.id);

    expect(timeouts).toEqual([3_000, 3_000]);
    expect(factoryMachines).toHaveLength(2);
    for (const remote of factoryMachines) expect(remote).toMatchObject({ id: machine.id, requestTimeoutMs: 180_000 });
  });

  it.skipIf(process.platform === "win32")("tightens permissions after reading an existing machine store", async () => {
    await writeFile(storePath, `${JSON.stringify({
      machines: [{
        id: "remote-1",
        name: "Remote",
        kind: "remote",
        baseUrl: "https://remote.example.test",
        token: "secret",
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z",
      }],
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
    await chmod(storePath, 0o644);

    await expect(service.list()).resolves.toEqual([expect.objectContaining({ id: "local" }), expect.objectContaining({ id: "remote-1" })]);

    await expectOwnerOnlyMachineStore(storePath);
  });

  it("rejects invalid remote base URLs", async () => {
    await expect(service.add({ name: "Bad", baseUrl: "ftp://example.test" })).rejects.toThrow("http or https");
    await expect(service.add({ name: "Bad", baseUrl: "https://user@example.test" })).rejects.toThrow("credentials");
    await expect(service.add({ name: "Bad", baseUrl: "https://example.test/path?q=1" })).rejects.toThrow("query or hash");
  });

  it("rejects configured machine headers that would override proxy transport semantics", async () => {
    await expect(service.add({ name: "Bad", baseUrl: "https://example.test", headers: { Authorization: "Bearer secret" } })).rejects.toThrow("not allowed");
    await expect(service.add({ name: "Bad", baseUrl: "https://example.test", headers: { Connection: "close" } })).rejects.toThrow("not allowed");
  });

  it("uses the lightweight runtime check for local machine health", async () => {
    const localRuntime = vi.fn(() => Promise.resolve({
      packageName: "@hyperdreamer/pi-webui",
      generatedAt: "2026-05-25T00:00:00.000Z",
      components: {
        web: { component: "web" as const, label: "Web/UI", runtimeVersion: "1.0.0", available: true, capabilities: [] },
        sessiond: { component: "sessiond" as const, label: "Session daemon", runtimeVersion: "1.0.0", available: true, capabilities: [] },
      },
      capabilities: [],
    }));
    const healthService = new MachineService(new MachineStore(storePath), {
      localRuntime,
      now: () => new Date("2026-05-25T00:00:00.000Z"),
    });

    const health = await healthService.health("local");

    expect(localRuntime).toHaveBeenCalledTimes(1);
    expect(health).toEqual({
      machineId: "local",
      ok: true,
      checkedAt: "2026-05-25T00:00:00.000Z",
      status: "online",
      web: { component: "web", label: "Web/UI", runtimeVersion: "1.0.0", stale: false, available: true },
      sessiond: { component: "sessiond", label: "Session daemon", runtimeVersion: "1.0.0", stale: false, available: true },
    });
  });

  it("fetches and caches remote runtime through the configured client", async () => {
    const body = remoteRuntimeBody();
    const requestJson = vi.fn<MachineClient["requestJson"]>(() => Promise.resolve({ statusCode: 200, headers: {}, body }));
    const factoryMachines: unknown[] = [];
    const remoteService = new MachineService(new MachineStore(storePath), {
      remoteClientFactory: (machine) => {
        factoryMachines.push(machine);
        return fakeRemoteClient({ requestJson });
      },
      now: () => new Date("2026-05-25T00:00:00.000Z"),
      runtimeCacheTtlMs: 10_000,
    });
    const machine = await remoteService.add({
      name: " Remote ",
      baseUrl: "https://remote.example.test/",
      token: "secret",
      headers: { "X-Pi-Web-Test": "yes" },
    });

    const first = await remoteService.runtime(machine.id);
    const second = await remoteService.runtime(machine.id);
    const forced = await remoteService.runtime(machine.id, true);

    expect(first).toEqual({
      machineId: machine.id,
      ok: true,
      checkedAt: "2026-05-25T00:00:00.000Z",
      packageName: body.packageName,
      generatedAt: body.generatedAt,
      components: body.components,
      capabilities: body.capabilities,
    });
    expect(second).toEqual(first);
    expect(forced).toEqual(first);
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(requestJson).toHaveBeenCalledWith("GET", "/api/pi-webui/runtime", undefined, { timeoutMs: 3000 });
    expect(factoryMachines).toEqual([
      expect.objectContaining({
        id: machine.id,
        name: "Remote",
        baseUrl: "https://remote.example.test",
        token: "secret",
        headers: { "X-Pi-Web-Test": "yes" },
      }),
      expect.objectContaining({ id: machine.id }),
    ]);
  });

  it("retains the daemon listener descriptor for remote runtime snapshots", async () => {
    const body = remoteRuntimeBody();
    const requestJson = vi.fn<MachineClient["requestJson"]>(() => Promise.resolve({ statusCode: 200, headers: {}, body }));
    const remoteService = new MachineService(new MachineStore(storePath), {
      remoteClientFactory: () => fakeRemoteClient({ requestJson }),
      now: () => new Date("2026-05-25T00:00:00.000Z"),
    });
    const machine = await remoteService.add({ name: "Remote", baseUrl: "https://remote.example.test" });

    const runtime = await remoteService.runtime(machine.id);

    expect(runtime?.components?.sessiond.sessiondListener).toEqual({ kind: "tcp", host: "127.0.0.1", port: 8810, hostSource: "config", portSource: "config" });
  });

  it("caches remote runtime errors and clears them after remote updates", async () => {
    let now = new Date("2026-05-25T00:00:00.000Z");
    const body = remoteRuntimeBody();
    const requestJson = vi.fn<MachineClient["requestJson"]>()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ statusCode: 200, headers: {}, body });
    const remoteService = new MachineService(new MachineStore(storePath), {
      remoteClientFactory: () => fakeRemoteClient({ requestJson }),
      now: () => now,
      runtimeCacheTtlMs: 10_000,
    });
    const machine = await remoteService.add({ name: "Remote", baseUrl: "https://remote.example.test" });

    const errorRuntime = await remoteService.runtime(machine.id);
    now = new Date("2026-05-25T00:00:01.000Z");
    const cachedErrorRuntime = await remoteService.runtime(machine.id);
    await remoteService.update(machine.id, { name: "Remote Updated" });
    now = new Date("2026-05-25T00:00:02.000Z");
    const refreshedRuntime = await remoteService.runtime(machine.id);

    expect(errorRuntime).toEqual({
      machineId: machine.id,
      ok: false,
      checkedAt: "2026-05-25T00:00:00.000Z",
      error: "network down",
    });
    expect(cachedErrorRuntime).toEqual(errorRuntime);
    expect(refreshedRuntime).toEqual({
      machineId: machine.id,
      ok: true,
      checkedAt: "2026-05-25T00:00:02.000Z",
      packageName: body.packageName,
      generatedAt: body.generatedAt,
      components: body.components,
      capabilities: body.capabilities,
    });
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it("does not allow local machine mutation", async () => {
    await expect(service.update("local", { name: "Other" })).rejects.toThrow("Local machine cannot be changed");
    await expect(service.remove("local")).rejects.toThrow("Local machine cannot be deleted");
  });

  it("supports PI_WEBUI_MACHINES_FILE path overrides", () => {
    const env: NodeJS.ProcessEnv = { PI_WEBUI_MACHINES_FILE: "data/machines.json" };
    expect(machineStorePath(env, "/tmp/pi-webui")).toBe(resolve("/tmp/pi-webui", "data/machines.json"));
  });
});

async function expectOwnerOnlyMachineStore(path: string): Promise<void> {
  if (process.platform === "win32") return;
  expect((await stat(path)).mode & 0o777).toBe(0o600);
}

function remoteRuntimeBody(): PiWebUiRuntimeResponse {
  return {
    packageName: "@hyperdreamer/pi-webui",
    generatedAt: "2026-05-25T00:00:00.000Z",
    components: {
      web: {
        component: "web",
        label: "Remote Web",
        runtimeVersion: "1.0.0",
        available: true,
        capabilities: [PI_WEBUI_CAPABILITIES.sessionsDeleteArchived, PI_WEBUI_CAPABILITIES.piPackagesManage],
      },
      sessiond: {
        component: "sessiond",
        label: "Remote Session daemon",
        runtimeVersion: "1.0.0",
        available: true,
        capabilities: [PI_WEBUI_CAPABILITIES.sessionsDeleteArchived],
        sessiondListener: { kind: "tcp", host: "127.0.0.1", port: 8810, hostSource: "config", portSource: "config" },
      },
    },
    capabilities: [PI_WEBUI_CAPABILITIES.sessionsDeleteArchived, PI_WEBUI_CAPABILITIES.piPackagesManage],
  };
}

function remoteStatusBody(): Record<string, unknown> {
  return {
    packageName: "@hyperdreamer/pi-webui",
    generatedAt: "2026-05-25T00:00:00.000Z",
    components: {
      web: { component: "web", label: "Remote Web", stale: false, available: true },
      sessiond: { component: "sessiond", label: "Remote Sessiond", stale: false, available: true },
    },
  };
}

function withOwnUndefinedRequestTimeout<T extends object>(value: T): T {
  Object.defineProperty(value, "requestTimeoutMs", { value: undefined, enumerable: true });
  return value;
}

function fakeRemoteClient(overrides: Partial<MachineClient>): MachineClient {
  return {
    request: () => { throw new Error("HTTP request not configured for test"); },
    requestJson: () => { throw new Error("JSON request not configured for test"); },
    connectWebSocket: () => { throw new Error("WebSocket not configured for test"); },
    ...overrides,
  };
}
