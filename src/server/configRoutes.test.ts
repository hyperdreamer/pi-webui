import Fastify, { type FastifyInstance } from "fastify";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPiWebUiConfig } from "../config.js";
import { PiWebUiConfigMutationBusyError } from "../configMutationCoordinator.js";
import { createFilePiWebUiConfigService, parsePiWebUiConfigResponseBody, parseSelectedMachineConfigRequest, redactSpeechInputConfigResponse, registerConfigRoutes, registerLocalMachineConfigRoutes, type PiWebUiConfigService } from "./configRoutes.js";
import type { PiWebUiConfigResponse, PiWebUiSpeechInputConfig, PiWebUiConfigValues } from "../shared/apiTypes.js";
import type { WorkspaceTasksMutationAuthorizer } from "./workspaceTasks/workspaceTasksErrors.js";
import { WorkspaceTasksMoveRecoveryPendingError } from "./workspaceTasks/workspaceTasksMoveRegistry.js";
import { WorkspaceTasksGlobalMutationGate } from "./workspaceTasks/workspaceTasksGlobalMutationGate.js";

let app: FastifyInstance;
let savedConfig: PiWebUiConfigValues;
let service: PiWebUiConfigService;

beforeEach(async () => {
  savedConfig = { host: "127.0.0.1", port: 8808, allowedHosts: [] };
  service = {
    read: vi.fn(() => responseFor(savedConfig, true)),
    write: vi.fn((config: PiWebUiConfigValues) => {
      savedConfig = config;
      return responseFor(savedConfig, true);
    }),
    update: vi.fn((mutate: (current: PiWebUiConfigValues) => PiWebUiConfigValues) => {
      savedConfig = mutate(savedConfig);
      return responseFor(savedConfig, true);
    }),
  };
  app = Fastify({ logger: false });
  registerConfigRoutes(app, service);
  registerLocalMachineConfigRoutes(app, service);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("config routes", () => {
  it("returns the PI WEBUI config contract", async () => {
    const response = await app.inject({ method: "GET", url: "/api/config" });

    expect(response.statusCode).toBe(200);
    expect(response.json<PiWebUiConfigResponse>()).toEqual(responseFor(savedConfig, true));
  });

  it("updates config through the service", async () => {
    const requestedConfig: PiWebUiConfigValues = {
      host: "0.0.0.0",
      port: 9000,
      allowedHosts: true,
      spawnSessions: true,
      subsessions: true,
      shortcuts: { "core:view.chat": "mod+1", "core:session.stop": null },
      plugins: { info: { enabled: false, settings: { note: "hidden" } } },
      pathAccess: { allowedPaths: ["/tmp"] },
      uploads: { defaultFolder: "uploads\\manual" },
      maxUploadBytes: 1234,
      agent: { command: "agent-lab", dir: "~/agent-profiles/lab" },
    };
    const expectedConfig: PiWebUiConfigValues = {
      ...requestedConfig,
      uploads: { defaultFolder: "uploads/manual" },
    };

    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { config: requestedConfig },
    });

    expect(response.statusCode).toBe(200);
    expect(service.update).toHaveBeenCalledWith(expect.any(Function));
    expect(savedConfig).toEqual(expectedConfig);
    expect(response.json<PiWebUiConfigResponse>().config).toEqual(expectedConfig);
  });

  it("rejects invalid config payloads before writing", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { config: { host: 42 } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty("error");
    expect(service.update).not.toHaveBeenCalled();
    expect(service.write).not.toHaveBeenCalled();
  });

  it("rejects invalid path access payloads before writing", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { config: { pathAccess: { allowedPaths: [""] } } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty("error");
    expect(service.update).not.toHaveBeenCalled();
  });

  it("rejects invalid max upload bytes before writing", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { config: { maxUploadBytes: 0 } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty("error");
    expect(service.update).not.toHaveBeenCalled();
  });

  it("rejects invalid upload defaults before writing", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { config: { uploads: { defaultFolder: "/tmp" } } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty("error");
    expect(service.update).not.toHaveBeenCalled();
  });

  it("accepts and retains valid tts, rejecting invalid tts payloads", async () => {
    const validResponse = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { config: { tts: { voice: "en-US-Test", rate: 20 } } },
    });
    expect(validResponse.statusCode).toBe(200);
    expect(savedConfig.tts).toEqual({ voice: "en-US-Test", rate: 20 });

    const invalidResponse = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { config: { tts: { rate: 200 } } },
    });
    expect(invalidResponse.statusCode).toBe(400);
  });

  it.each([
    { agent: { command: "./agent", dir: "/srv/agent" }, error: "safe bare executable name or host-absolute executable path" },
    { agent: { command: "agent", dir: "/srv/agent", futureSetting: true }, error: 'agent contains unknown key "futureSetting"' },
  ])("rejects unsafe agent profile payloads before writing", async ({ agent, error }) => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { config: { agent } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain(error);
    expect(service.update).not.toHaveBeenCalled();
  });

  it("rejects tts in selected-machine config updates", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/machines/local/config",
      payload: { config: { tts: {} } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("selected-machine config key is not allowed: tts");
    expect(service.update).not.toHaveBeenCalled();
  });

  it("filters local machine config reads to selected-machine-safe keys", async () => {
    savedConfig = fullConfig();

    const response = await app.inject({ method: "GET", url: "/api/machines/local/config" });

    expect(response.statusCode).toBe(200);
    expect(response.json<PiWebUiConfigResponse>()).toEqual({
      ...responseFor(savedConfig, true),
      config: selectedMachineConfig(),
      effectiveConfig: selectedMachineConfig(),
    });
  });

  it("merges local selected-machine config updates without dropping gateway-only keys", async () => {
    savedConfig = fullConfig();
    const selectedMachinePatch: PiWebUiConfigValues = {
      plugins: { info: { enabled: false } },
      uploads: { defaultFolder: "uploads\\manual" },
      spawnSessions: true,
      agent: { command: "alternate-agent", dir: "/srv/alternate-agent" },
    };

    const response = await app.inject({
      method: "PUT",
      url: "/api/machines/local/config",
      payload: { config: selectedMachinePatch },
    });

    const expectedConfig: PiWebUiConfigValues = {
      ...fullConfig(),
      plugins: { info: { enabled: false } },
      uploads: { defaultFolder: "uploads/manual" },
      spawnSessions: true,
      agent: { command: "alternate-agent", dir: "/srv/alternate-agent" },
    };
    expect(response.statusCode).toBe(200);
    expect(savedConfig).toEqual(expectedConfig);
    expect(service.update).toHaveBeenCalledWith(expect.any(Function));
    expect(response.json<PiWebUiConfigResponse>().config).toEqual({
      plugins: { info: { enabled: false } },
      pathAccess: { allowedPaths: ["/srv/repos"] },
      uploads: { defaultFolder: "uploads/manual" },
      maxUploadBytes: 1024,
      spawnSessions: true,
      subsessions: false,
      agent: { command: "alternate-agent", dir: "/srv/alternate-agent" },
    });
  });

  it("keeps foreign-platform agent paths portable at federation transport boundaries", () => {
    const agent = { command: "C:\\tools\\pi.exe", dir: "C:\\agent-profiles\\pi" };
    const response = {
      ...responseFor({ agent }, true),
      effectiveConfig: { agent },
    };

    expect(parsePiWebUiConfigResponseBody(response).config.agent).toEqual(agent);
    expect(parseSelectedMachineConfigRequest({ agent }, "portable").agent).toEqual(agent);
    if (process.platform !== "win32") {
      expect(() => parseSelectedMachineConfigRequest({ agent })).toThrow("host-absolute executable path");
    }
  });

  it("defaults missing agent override fields from older config responses", () => {
    const parsed = parsePiWebUiConfigResponseBody({
      path: "/tmp/pi-webui/config.json",
      exists: true,
      config: {},
      effectiveConfig: {},
      envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false },
    });

    expect(parsed.envOverrides).toMatchObject({ agentCommand: false, agentDir: false, agentSessionDir: false });
  });

  it("retains the agent directory environment source across federation responses", () => {
    const parsed = parsePiWebUiConfigResponseBody({
      ...responseFor({}, false),
      envOverrides: {
        ...responseFor({}, false).envOverrides,
        agentDir: true,
        agentDirSource: "pi-compatibility",
      },
    });

    expect(parsed.envOverrides).toMatchObject({ agentDir: true, agentDirSource: "pi-compatibility" });
    expect(() => parsePiWebUiConfigResponseBody({
      ...responseFor({}, false),
      envOverrides: { ...responseFor({}, false).envOverrides, agentDirSource: "future-source" },
    })).toThrow("valid agent directory source");
  });

  it("rejects unsafe local selected-machine config keys before writing", async () => {
    savedConfig = fullConfig();

    const response = await app.inject({
      method: "PUT",
      url: "/api/machines/local/config",
      payload: { config: { host: "0.0.0.0", spawnSessions: true } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("PI WEBUI selected-machine config key is not allowed: host");
    expect(savedConfig).toEqual(fullConfig());
    expect(service.update).not.toHaveBeenCalled();
  });

  it("rejects invalid local selected-machine config values before writing", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/machines/local/config",
      payload: { config: { spawnSessions: "yes" } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("PI WEBUI selected-machine config spawnSessions must be a boolean");
    expect(service.update).not.toHaveBeenCalled();
  });
});

describe("config route speech redaction", () => {
  it("redacts the persisted speech subtree from generic GET responses", async () => {
    const speechInput: PiWebUiSpeechInputConfig = {
      provider: "cloud",
      language: "en-US",
      cloud: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe", apiKey: "$OPENAI_API_KEY" },
    };
    savedConfig = { port: 9000, speechInput };

    const response = await app.inject({ method: "GET", url: "/api/config" });

    expect(response.statusCode).toBe(200);
    const body = response.json<PiWebUiConfigResponse>();
    expect(body.config).not.toHaveProperty("speechInput");
    expect(body.effectiveConfig).not.toHaveProperty("speechInput");
    expect(body.config.port).toBe(9000);
    expect(service.read).toHaveBeenCalledOnce();
  });

  it("redacts the persisted speech subtree from generic PUT responses", async () => {
    savedConfig = {
      port: 8808,
      speechInput: { provider: "cloud", cloud: { apiKey: "$OPENAI_API_KEY" } },
    };

    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { config: { port: 9001 } },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<PiWebUiConfigResponse>();
    expect(body.config).not.toHaveProperty("speechInput");
    expect(body.effectiveConfig).not.toHaveProperty("speechInput");
    expect(savedConfig.port).toBe(9001);
    expect(savedConfig.speechInput).toEqual({ provider: "cloud", cloud: { apiKey: "$OPENAI_API_KEY" } });
  });

  it("rejects any speechInput key in generic browser updates before parsing other fields", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { config: { port: 9001, speechInput: { provider: "cloud" } } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("dedicated speech input settings API");
    expect(savedConfig).toEqual({ host: "127.0.0.1", port: 8808, allowedHosts: [] });
    expect(service.update).not.toHaveBeenCalled();
  });

  it("rejects an empty speechInput object in generic browser updates", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { config: { speechInput: {} } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("dedicated speech input settings API");
  });

  it("preserves the raw speech subtree across unrelated generic and selected-machine updates", async () => {
    const speechInput: PiWebUiSpeechInputConfig = {
      provider: "cloud",
      language: "en-US",
      cloud: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe", apiKey: "$OPENAI_API_KEY" },
    };
    savedConfig = { ...fullConfig(), speechInput };

    const generic = await app.inject({ method: "PUT", url: "/api/config", payload: { config: { port: 9001 } } });
    expect(generic.statusCode).toBe(200);
    expect(savedConfig.speechInput).toEqual(speechInput);

    const selectedMachine = await app.inject({
      method: "PUT",
      url: "/api/machines/local/config",
      payload: { config: { spawnSessions: true } },
    });
    expect(selectedMachine.statusCode).toBe(200);
    expect(savedConfig.speechInput).toEqual(speechInput);
  });

  it("maps typed coordinator contention from generic and selected-machine mutations to 503", async () => {
    service.update = vi.fn(() => { throw new PiWebUiConfigMutationBusyError(); });

    const generic = await app.inject({ method: "PUT", url: "/api/config", payload: { config: { port: 9001 } } });
    expect(generic.statusCode).toBe(503);
    expect(generic.json()).toEqual({ error: "PI WEBUI config is busy. Try again." });

    const selectedMachine = await app.inject({
      method: "PUT",
      url: "/api/machines/local/config",
      payload: { config: { spawnSessions: true } },
    });
    expect(selectedMachine.statusCode).toBe(503);
    expect(selectedMachine.json()).toEqual({ error: "PI WEBUI config is busy. Try again." });
  });

  it("keeps ordinary unlocked read failures and unexpected mutation failures at 500", async () => {
    service.read = vi.fn(() => { throw new Error("disk read failure"); });
    const read = await app.inject({ method: "GET", url: "/api/config" });
    expect(read.statusCode).toBe(500);
    expect(read.json()).toEqual({ error: "disk read failure" });

    service.read = vi.fn(() => responseFor(savedConfig, true));
    service.update = vi.fn(() => { throw new Error("unexpected mutation failure"); });
    const write = await app.inject({ method: "PUT", url: "/api/config", payload: { config: { port: 9001 } } });
    expect(write.statusCode).toBe(500);
    expect(write.json()).toEqual({ error: "unexpected mutation failure" });
  });

  it("maps a guarded global-task mutation to a safe 409 in both config route families", async () => {
    const gatedApp = Fastify({ logger: false });
    const authorizer: WorkspaceTasksMutationAuthorizer = {
      reconcileGlobalMoveClaim: vi.fn(() => Promise.resolve()),
      assertGlobalMutationAllowed: vi.fn(() => { throw new WorkspaceTasksMoveRecoveryPendingError(); }),
      assertWorkspaceMutationAllowed: vi.fn(),
    };
    const gatedService = new WorkspaceTasksGlobalMutationGate(authorizer).decorate(service);
    registerConfigRoutes(gatedApp, gatedService);
    registerLocalMachineConfigRoutes(gatedApp, gatedService);
    await gatedApp.ready();

    const guardedGlobalTasks = { version: 1, tasks: [{ id: "build", title: "Build", command: "npm run build", confirm: false }] };
    const global = await gatedApp.inject({ method: "PUT", url: "/api/config", payload: { config: { plugins: { "workspace-tasks": { settings: { globalTasks: guardedGlobalTasks } } } } } });
    const selected = await gatedApp.inject({ method: "PUT", url: "/api/machines/local/config", payload: { config: { plugins: { "workspace-tasks": { settings: { globalTasks: guardedGlobalTasks } } } } } });

    expect(global.statusCode).toBe(409);
    expect(global.json()).toEqual({ error: "Workspace task move recovery is pending. Refresh before changing the affected catalog." });
    expect(selected.statusCode).toBe(409);
    expect(selected.json()).toEqual({ error: "Workspace task move recovery is pending. Refresh before changing the affected catalog." });
    await gatedApp.close();
  });
  it("returns each mutation's own committed response even when a later mutation commits first", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstCommitted: PiWebUiConfigValues = { ...savedConfig, port: 9001 };
    const deferredService: PiWebUiConfigService = {
      read: () => responseFor(savedConfig, true),
      write: (config) => { savedConfig = config; return responseFor(savedConfig, true); },
      update: (mutate) => {
        const next = mutate(savedConfig);
        const response = responseFor(next, true);
        // The first mutation commits immediately but its route response stays
        // pending; a later writer commits before it is serialized.
        if (next.port === firstCommitted.port) return firstGate.then(() => response);
        savedConfig = next;
        return Promise.resolve(response);
      },
    };
    const deferredApp = Fastify({ logger: false });
    registerConfigRoutes(deferredApp, deferredService);
    await deferredApp.ready();
    try {
      const first = deferredApp.inject({ method: "PUT", url: "/api/config", payload: { config: { port: 9001 } } });

      // B commits through the same service while A's response is pending.
      const second = await deferredService.update((current) => ({ ...current, port: 9002 }));
      expect(second.config.port).toBe(9002);
      expect(savedConfig.port).toBe(9002);

      releaseFirst();
      const firstResponse = await first;
      expect(firstResponse.statusCode).toBe(200);
      // A returns A's own committed config, not B's later disk state.
      expect(firstResponse.json<PiWebUiConfigResponse>().config.port).toBe(9001);
    } finally {
      await deferredApp.close();
    }
  });

  it("redacts only the response projection and leaves the service full-fidelity", () => {
    const response = responseFor({ port: 9000, speechInput: { provider: "cloud", cloud: { apiKey: "$KEY" } } }, true);

    const redacted = redactSpeechInputConfigResponse(response);

    expect(redacted.config).not.toHaveProperty("speechInput");
    expect(redacted.effectiveConfig).not.toHaveProperty("speechInput");
    expect(response.config.speechInput).toEqual({ provider: "cloud", cloud: { apiKey: "$KEY" } });
  });
});

describe("config file service environment pinning", () => {
  let tempDir: string;
  let pinnedConfigPath: string;
  let pinnedDataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-webui-config-service-test-"));
    pinnedConfigPath = join(tempDir, "config.json");
    pinnedDataDir = join(tempDir, "data");
    mkdirSync(pinnedDataDir, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("pins the default file service to the environment frozen at construction", async () => {
    const originalConfig = process.env["PI_WEBUI_CONFIG"];
    const originalData = process.env["PI_WEBUI_DATA_DIR"];
    process.env["PI_WEBUI_CONFIG"] = pinnedConfigPath;
    process.env["PI_WEBUI_DATA_DIR"] = pinnedDataDir;
    try {
      const service = createFilePiWebUiConfigService();
      // A post-start environment change must not move the config and lock
      // database paths away from the construction-time snapshot.
      process.env["PI_WEBUI_CONFIG"] = join(tempDir, "mutated.json");
      await service.update((current) => ({ ...current, port: 9001 }));
    } finally {
      restoreProcessEnv("PI_WEBUI_CONFIG", originalConfig);
      restoreProcessEnv("PI_WEBUI_DATA_DIR", originalData);
    }

    expect(existsSync(pinnedConfigPath)).toBe(true);
    expect(existsSync(join(tempDir, "mutated.json"))).toBe(false);
    expect(loadPiWebUiConfig({ env: { PI_WEBUI_CONFIG: pinnedConfigPath } }).config.port).toBe(9001);
  });

  it("keeps an injected frozen startup snapshot authoritative after process.env changes", async () => {
    const env: NodeJS.ProcessEnv = Object.freeze({ PI_WEBUI_CONFIG: pinnedConfigPath, PI_WEBUI_DATA_DIR: pinnedDataDir });
    const service = createFilePiWebUiConfigService({ env });
    const original = process.env["PI_WEBUI_CONFIG"];
    process.env["PI_WEBUI_CONFIG"] = join(tempDir, "mutated.json");
    try {
      await service.update((current) => ({ ...current, port: 9002 }));
    } finally {
      restoreProcessEnv("PI_WEBUI_CONFIG", original);
    }

    expect(existsSync(pinnedConfigPath)).toBe(true);
    expect(existsSync(join(tempDir, "mutated.json"))).toBe(false);
  });
});

function restoreProcessEnv(key: string, original: string | undefined): void {
  if (original === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = original;
}

function fullConfig(): PiWebUiConfigValues {
  return {
    host: "127.0.0.1",
    port: 8808,
    allowedHosts: ["gateway.example.test"],
    shortcuts: { "core:view.chat": "mod+1" },
    plugins: { info: { enabled: true, settings: { note: "visible" } } },
    pathAccess: { allowedPaths: ["/srv/repos"] },
    uploads: { defaultFolder: "uploads" },
    maxUploadBytes: 1024,
    spawnSessions: false,
    subsessions: false,
    agent: { command: "agent-lab", dir: "/srv/agent-lab" },
    tts: { voice: "en-US-Test", rate: 20 },
  };
}

function selectedMachineConfig(): PiWebUiConfigValues {
  return {
    plugins: { info: { enabled: true, settings: { note: "visible" } } },
    pathAccess: { allowedPaths: ["/srv/repos"] },
    uploads: { defaultFolder: "uploads" },
    maxUploadBytes: 1024,
    spawnSessions: false,
    subsessions: false,
    agent: { command: "agent-lab", dir: "/srv/agent-lab" },
  };
}

function responseFor(config: PiWebUiConfigValues, exists: boolean): PiWebUiConfigResponse {
  return {
    path: "/tmp/pi-webui/config.json",
    exists,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false },
  };
}
