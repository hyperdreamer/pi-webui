import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach } from "vitest";
import { buildApp } from "./app.js";
import type { PiWebUiConfigMutationCoordinator, PiWebUiConfigMutationSnapshot } from "../configMutationCoordinator.js";
import { createWorkspaceTasksComposition } from "./workspaceTasks/workspaceTasksComposition.js";
import { ProjectService } from "./projects/projectService.js";
import { ProjectStore } from "./storage/projectStore.js";
import type { MachineClient } from "./machines/machineClient.js";
import { MachineService } from "./machines/machineService.js";
import { MachineStore } from "./machines/machineStore.js";
import { WorkspaceService } from "./workspaces/workspaceService.js";
import type { PiPackageService } from "./piPackageService.js";
import type { PiPackagePluginsConfigService } from "./piPackagePluginsConfigService.js";
import type { SessionProxyDaemon } from "./sessiond/sessionProxyRoutes.js";
import { PI_WEBUI_CAPABILITIES } from "../shared/capabilities.js";
import { createPiWebUiStatusCache, type PiWebUiStatusCache } from "./piWebUiStatusCache.js";
import { getPiWebUiStatus } from "./piWebUiStatus.js";
import { createSpeechInputSettingsService, type SpeechInputSettingsService } from "./speechInput/speechInputSettingsService.js";
import type { SpeechInputTranscriptionService } from "./speechInput/speechTranscriptionService.js";
import { createInMemorySpeechInputConfigCoordinator, type InMemorySpeechInputConfigCoordinator } from "./speechInput/speechInputSettingsService.testSupport.js";
import type { ActiveAgentProfileDescriptor, HostSpeechSpeakRequest, HostSpeechStatus, PiPackageInfo, PiPackagePluginMutationRequest, PiWebUiConfigResponse, PiWebUiConfigValues } from "../shared/apiTypes.js";
import type { SessionDaemonAgentProfileResult } from "../sessiond/sessionDaemonClient.js";
import type { HostSpeech } from "./tts/hostSpeech.js";

/** App-test fake HostSpeech: captured calls, mutable status, idempotent close spy. */
export interface FakeHostSpeech extends HostSpeech {
  statusValue: HostSpeechStatus;
  speakCalls: HostSpeechSpeakRequest[];
  stopCalls: string[];
  closeCalls: number;
}

interface AppTestContext {
  readonly app: FastifyInstance;
  readonly tempDir: string;
  readonly projectDir: string;
  remoteClient: MachineClient | undefined;
  readonly sessionDaemonRequests: CapturedSessionDaemonRequest[];
  readonly piPackageRequests: CapturedPiPackageRequest[];
  readonly piPackagePluginRequests: CapturedPiPackagePluginRequest[];
  piWebUiConfig: PiWebUiConfigValues;
  agentProfileResult: SessionDaemonAgentProfileResult;
  readonly hostSpeech: FakeHostSpeech;
  readonly piWebUiStatusCache: PiWebUiStatusCache;
  readonly speechInputCoordinator: InMemorySpeechInputConfigCoordinator;
}

let app: FastifyInstance | undefined;
let tempDir: string | undefined;
let projectDir: string | undefined;
let remoteClient: MachineClient | undefined;
let hostSpeech: FakeHostSpeech | undefined;
let piWebUiStatusCache: PiWebUiStatusCache | undefined;
let speechInputCoordinator: InMemorySpeechInputConfigCoordinator | undefined;
let sessionDaemonRequests: CapturedSessionDaemonRequest[] = [];
let piPackageRequests: CapturedPiPackageRequest[] = [];
let piPackagePluginRequests: CapturedPiPackagePluginRequest[] = [];
let piWebUiConfig: PiWebUiConfigValues = {};
let agentProfileResult: SessionDaemonAgentProfileResult = { status: "invalid", error: "App test harness was not initialized" };

export const appTestContext: AppTestContext = {
  get app() {
    if (app === undefined) throw new Error("App test harness was not initialized");
    return app;
  },
  get tempDir() {
    if (tempDir === undefined) throw new Error("App test tempDir was not initialized");
    return tempDir;
  },
  get projectDir() {
    if (projectDir === undefined) throw new Error("App test projectDir was not initialized");
    return projectDir;
  },
  get remoteClient() {
    return remoteClient;
  },
  set remoteClient(client) {
    remoteClient = client;
  },
  get sessionDaemonRequests() {
    return sessionDaemonRequests;
  },
  get piPackageRequests() {
    return piPackageRequests;
  },
  get piPackagePluginRequests() {
    return piPackagePluginRequests;
  },
  get piWebUiConfig() {
    return piWebUiConfig;
  },
  set piWebUiConfig(config) {
    piWebUiConfig = config;
  },
  get agentProfileResult() {
    return agentProfileResult;
  },
  set agentProfileResult(result) {
    agentProfileResult = result;
  },
  get hostSpeech() {
    if (hostSpeech === undefined) throw new Error("App test harness was not initialized");
    return hostSpeech;
  },
  get piWebUiStatusCache() {
    if (piWebUiStatusCache === undefined) throw new Error("App test harness was not initialized");
    return piWebUiStatusCache;
  },
  get speechInputCoordinator() {
    if (speechInputCoordinator === undefined) throw new Error("App test harness was not initialized");
    return speechInputCoordinator;
  },
};

export function registerAppTestHooks(): void {
  beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), "pi-webui-app-test-")));
    projectDir = join(tempDir, "project");
    remoteClient = undefined;
    sessionDaemonRequests = [];
    piPackageRequests = [];
    piPackagePluginRequests = [];
    piWebUiConfig = {};
    agentProfileResult = { status: "available", profile: appTestAgentProfile(join(tempDir, "agent")) };
    hostSpeech = createFakeHostSpeech();
    const agentProfileProvider = { getActiveAgentProfile: () => Promise.resolve(agentProfileResult) };
    const sessionDaemon = fakeSessionDaemon();
    piWebUiStatusCache = createPiWebUiStatusCache(
      async ({ force }) => {
        const activeAgentProfile = await agentProfileProvider.getActiveAgentProfile();
        return getPiWebUiStatus(sessionDaemon, {
          forceReleaseCheck: force,
          ...(activeAgentProfile.status === "available" ? { activeAgentProfile: activeAgentProfile.profile } : {}),
        });
      },
      { onError: () => undefined },
    );
    speechInputCoordinator = createInMemorySpeechInputConfigCoordinator({});
    const projects = new ProjectService(new ProjectStore(join(tempDir, "projects.json")));
    const workspaces = new WorkspaceService();
    const configMutationCoordinator = createAppTestConfigMutationCoordinator();
    const workspaceTasks = createWorkspaceTasksComposition({ configMutationCoordinator, projects, workspaces });
    app = await buildApp({
      projects,
      workspaces,
      machines: new MachineService(new MachineStore(join(tempDir, "machines.json")), {
        remoteClientFactory: () => {
          if (remoteClient === undefined) throw new Error("No remote machine client configured");
          return remoteClient;
        },
        now: () => new Date("2026-05-25T00:00:00.000Z"),
        localRuntime: () => Promise.resolve({
          packageName: "@hyperdreamer/pi-webui",
          generatedAt: "2026-05-25T00:00:00.000Z",
          components: {
            web: { component: "web", label: "PI WEBUI", available: true, capabilities: [PI_WEBUI_CAPABILITIES.sessionsDeleteArchived] },
            sessiond: { component: "sessiond", label: "PI WEBUI Session Daemon", available: true, capabilities: [PI_WEBUI_CAPABILITIES.sessionsDeleteArchived] },
          },
          capabilities: [PI_WEBUI_CAPABILITIES.sessionsDeleteArchived],
        }),
      }),
      sessionDaemon,
      agentProfileProvider,
      config: fakeConfigService(),
      configMutationCoordinator,
      workspaceTasks,
      speechInputSettings: createSpeechInputSettingsService({
        coordinator: speechInputCoordinator,
        onCommitted: () => piWebUiStatusCache?.invalidate(),
      }),
      speechInputTranscription: createFakeSpeechInputTranscriptionService(),
      piWebUiStatusCache,
      piPackages: fakePiPackageService(),
      piPackagePlugins: fakePiPackagePluginsConfigService(),
      piWebUiPlugins: {
        manifest: () => Promise.resolve({ plugins: [{ id: "fake", module: "/pi-webui-plugins/fake/plugin.js?v=1", source: "test", scope: "local", machineSpecific: false }] }),
        plugins: () => Promise.resolve({ plugins: [{ id: "fake", module: "/pi-webui-plugins/fake/plugin.js?v=1", source: "test", scope: "local", machineSpecific: false, enabled: true }] }),
        readAsset: fakePiWebUiPluginAsset,
      },
      clientDist: false,
      logger: false,
      hostSpeech,
    });
  });

  afterEach(async () => {
    const appToClose = app;
    const tempDirToRemove = tempDir;
    app = undefined;
    tempDir = undefined;
    projectDir = undefined;
    remoteClient = undefined;
    sessionDaemonRequests = [];
    piPackageRequests = [];
    piPackagePluginRequests = [];
    piWebUiConfig = {};
    agentProfileResult = { status: "invalid", error: "App test harness was not initialized" };
    hostSpeech = undefined;
    piWebUiStatusCache = undefined;
    speechInputCoordinator = undefined;

    if (appToClose !== undefined) await appToClose.close();
    if (tempDirToRemove !== undefined) await rm(tempDirToRemove, { recursive: true, force: true });
  });
}

function fakePiWebUiPluginAsset(pluginId: string, assetPath: string): Promise<{ content: Buffer; contentType: string } | undefined> {
  if (pluginId !== "fake") return Promise.resolve(undefined);
  if (assetPath === "plugin.js") return Promise.resolve({ content: Buffer.from("export default {};"), contentType: "application/javascript; charset=utf-8" });
  if (assetPath === "assets/icon.svg") return Promise.resolve({ content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), contentType: "image/svg+xml" });
  return Promise.resolve(undefined);
}

function createFakeHostSpeech(): FakeHostSpeech {
  const fake: FakeHostSpeech = {
    statusValue: { available: true, voices: [{ name: "default", language: "en" }] },
    speakCalls: [],
    stopCalls: [],
    closeCalls: 0,
    status: () => Promise.resolve(fake.statusValue),
    speak: (input) => {
      fake.speakCalls.push(input);
      return Promise.resolve({ runId: input.runId, outcome: "ended" });
    },
    stop: (runId) => {
      fake.stopCalls.push(runId);
      return Promise.resolve(fake.speakCalls.some((call) => call.runId === runId)
        ? { runId, outcome: "canceled" }
        : undefined);
    },
    close: () => {
      fake.closeCalls += 1;
      return Promise.resolve();
    },
  };
  return fake;
}

export interface CapturedSessionDaemonRequest {
  method: string;
  path: string;
  body?: unknown;
}

interface CapturedPiPackageRequest {
  action: "list" | "install" | "remove" | "update";
  source?: string;
  scope?: "user" | "project";
}

interface CapturedPiPackagePluginRequest {
  action: "list" | PiPackagePluginMutationRequest["action"];
  cwd: string;
  source?: string;
  scope?: PiPackagePluginMutationRequest["scope"];
}

function createAppTestConfigMutationCoordinator(): PiWebUiConfigMutationCoordinator {
  const snapshot = (): PiWebUiConfigMutationSnapshot => ({
    loaded: {
      path: join(tempDir ?? "/tmp", "config.json"),
      exists: false,
      config: piWebUiConfig,
    },
    speechInputRevision: "test-speech-revision",
  });
  return {
    read: () => Promise.resolve(snapshot()),
    mutate: (mutate, options = {}) => Promise.resolve().then(() => {
      const before = snapshot();
      const next = mutate(before);
      if (options.shouldSave?.(before, next) === false) return before;
      options.onPublicationAttempt?.();
      piWebUiConfig = next;
      options.onSaved?.();
      return snapshot();
    }),
  };
}

export function fakeConfigService() {
  return {
    read: () => piWebUiConfigResponse(piWebUiConfig),
    write: (config: PiWebUiConfigValues) => {
      piWebUiConfig = config;
      return piWebUiConfigResponse(config);
    },
    update: (mutate: (current: PiWebUiConfigValues) => PiWebUiConfigValues) => {
      piWebUiConfig = mutate(piWebUiConfig);
      return piWebUiConfigResponse(piWebUiConfig);
    },
  };
}

/**
 * Fake speech settings service backed by an in-memory full-fidelity
 * coordinator. Tests that inject a custom `config` service pair it with this
 * fake so production never silently creates a second config authority.
 */
export function createFakeSpeechInputSettingsService(): SpeechInputSettingsService {
  return createSpeechInputSettingsService({
    coordinator: createInMemorySpeechInputConfigCoordinator({}),
  });
}

function createFakeSpeechInputTranscriptionService(): SpeechInputTranscriptionService {
  return { transcribe: () => Promise.resolve("test transcript") };
}

function appTestAgentProfile(dir: string): ActiveAgentProfileDescriptor {
  return {
    schemaVersion: 1,
    revision: `sha256:${"a".repeat(64)}`,
    command: "pi",
    dir,
    sessionDirEnvKeys: ["PI_WEBUI_AGENT_SESSION_DIR", "PI_CODING_AGENT_SESSION_DIR"],
  };
}

export function fullPiWebUiConfig(): PiWebUiConfigValues {
  return {
    host: "127.0.0.1",
    port: 8808,
    allowedHosts: ["gateway.example.test"],
    shortcuts: { "core:view.chat": "mod+1" },
    plugins: { info: { enabled: true, settings: { note: "remote" } } },
    pathAccess: { allowedPaths: ["/srv/repos"] },
    uploads: { defaultFolder: "uploads" },
    maxUploadBytes: 1024,
    spawnSessions: false,
    subsessions: false,
    agent: { command: "agent-lab", dir: "/srv/agent-lab" },
  };
}

export function selectedMachinePiWebUiConfig(): PiWebUiConfigValues {
  return {
    plugins: { info: { enabled: true, settings: { note: "remote" } } },
    pathAccess: { allowedPaths: ["/srv/repos"] },
    uploads: { defaultFolder: "uploads" },
    maxUploadBytes: 1024,
    spawnSessions: false,
    subsessions: false,
    agent: { command: "agent-lab", dir: "/srv/agent-lab" },
  };
}

export function piWebUiConfigResponse(config: PiWebUiConfigValues): PiWebUiConfigResponse {
  return {
    path: join(appTestContext.tempDir, "config.json"),
    exists: false,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false },
  };
}

interface MachineConfigWriteBody {
  config: PiWebUiConfigValues;
}

export function configFromMachineConfigWriteBody(body: unknown): PiWebUiConfigValues {
  if (!isMachineConfigWriteBody(body)) throw new Error("Expected machine config write body");
  return body.config;
}

function isMachineConfigWriteBody(value: unknown): value is MachineConfigWriteBody {
  if (!isRecord(value)) return false;
  return isRecord(value["config"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function fakePiPackageService(): PiPackageService {
  const packages: PiPackageInfo[] = [{ source: "npm:@acme/tools", scope: "user", filtered: false, installedPath: "/tmp/pi-tools" }];
  return {
    list: () => {
      piPackageRequests.push({ action: "list" });
      return Promise.resolve({ packages });
    },
    install: (source) => {
      piPackageRequests.push({ action: "install", source });
      return Promise.resolve({ action: "install", source, packages });
    },
    remove: (source, scope = "user") => {
      piPackageRequests.push({ action: "remove", source, scope });
      return Promise.resolve({ action: "remove", source, scope, removed: true, packages });
    },
    update: (source) => {
      piPackageRequests.push({ action: "update", ...(source === undefined ? {} : { source }) });
      return Promise.resolve({ action: "update", ...(source === undefined ? {} : { source }), packages });
    },
  };
}

function fakePiPackagePluginsConfigService(): PiPackagePluginsConfigService {
  const response = {
    packages: [{
      source: "npm:@acme/tools",
      scope: "global" as const,
      filtered: false,
      disabled: false,
      counts: { extensions: 1, skills: 0, prompts: 0, themes: 0 },
      resources: [{ kind: "extension" as const, name: "tools", path: "/tmp/pi-tools/extensions/index.ts", relativePath: "extensions/index.ts" }],
      status: "loaded" as const,
    }],
    totals: { extensions: 1, skills: 0, prompts: 0, themes: 0 },
    diagnostics: [],
  };
  return {
    list: (cwd) => {
      piPackagePluginRequests.push({ action: "list", cwd });
      return Promise.resolve(response);
    },
    mutate: (request) => {
      piPackagePluginRequests.push(request);
      return Promise.resolve(response);
    },
  };
}

function fakeSessionDaemon(): SessionProxyDaemon {
  return {
    request: (method, path, body) => {
      const captured = { method, path, ...(body === undefined ? {} : { body }) } satisfies CapturedSessionDaemonRequest;
      sessionDaemonRequests.push(captured);
      return Promise.resolve({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(captured),
      });
    },
    connectWebSocket: () => { throw new Error("WebSocket not configured for test"); },
  };
}

export function fakeRemoteClient(overrides: Partial<MachineClient>): MachineClient {
  return {
    request: () => Promise.resolve({ statusCode: 200, headers: {}, body: Readable.from([]) }),
    requestJson: () => Promise.resolve({ statusCode: 200, headers: {}, body: undefined }),
    connectWebSocket: () => { throw new Error("WebSocket not configured for test"); },
    ...overrides,
  };
}
