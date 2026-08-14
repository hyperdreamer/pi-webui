import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyServerOptions } from "fastify";
import fastifyCompress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { ProjectStore } from "./storage/projectStore.js";
import { ProjectNotFoundError, ProjectService } from "./projects/projectService.js";
import { WorkspaceService } from "./workspaces/workspaceService.js";
import { isAbsoluteishFileSuggestionQuery, listFileSuggestions, listPathSuggestions } from "./workspaces/fileSuggestions.js";
import { pathAccessForCwd } from "./workspaces/effectivePathAccess.js";
import { loadEffectiveProjectUploadsConfig } from "./workspaces/projectPiWebUiConfig.js";
import { normalizeRequestCwd } from "./workingDirectory.js";
import { listDirectorySuggestions } from "./projects/directorySuggestions.js";
import { SessionDaemonClient } from "../sessiond/sessionDaemonClient.js";
import { registerSessionProxyRoutes, type SessionProxyDaemon } from "./sessiond/sessionProxyRoutes.js";
import { sessionRouteFastifyOptions } from "./sessions/sessionRouteFastifyOptions.js";
import { registerWorkspaceExplorerRoutes } from "./workspaceExplorerRoutes.js";
import { registerGitRoutes } from "./gitRoutes.js";
import { registerTerminalProxyRoutes } from "./terminalProxyRoutes.js";
import { registerWorkspaceDeletionRoutes } from "./workspaces/workspaceDeletionRoutes.js";
import { registerSystemInfoRoutes } from "./systemInfoRoutes.js";
import { createFilePiWebUiConfigService, registerConfigRoutes, registerLocalMachineConfigRoutes, type PiWebUiConfigService } from "./configRoutes.js";
import { createPiWebUiConfigMutationCoordinator, type PiWebUiConfigMutationCoordinator } from "../configMutationCoordinator.js";
import { createSpeechInputSettingsService, type SpeechInputSettingsService } from "./speechInput/speechInputSettingsService.js";
import { registerSpeechInputSettingsRoutes } from "./speechInput/speechInputSettingsRoutes.js";
import { PiWebUiPluginService } from "./piWebUiPluginService.js";
import { createActiveProfilePiPackageService, type PiPackageService } from "./piPackageService.js";
import { createActiveProfilePiPackagePluginsConfigService, type PiPackagePluginsConfigService } from "./piPackagePluginsConfigService.js";
import { registerPiPackagePluginsConfigRoutes } from "./piPackagePluginsConfigRoutes.js";
import { registerPiPackageRoutes } from "./piPackageRoutes.js";
import { createPiWebUiStatusCache, type PiWebUiStatusCache } from "./piWebUiStatusCache.js";
import { getPiWebUiRuntime, getPiWebUiStatus, getPiWebUiVersionStatus } from "./piWebUiStatus.js";
import {
  ActiveAgentProfileAccessError,
  requireActiveAgentProfile,
  SessionDaemonActiveAgentProfileProvider,
  type ActiveAgentProfileProvider,
} from "./activeAgentProfileProvider.js";
import { MachineService } from "./machines/machineService.js";
import { registerMemoryRoutes } from "./memory/memoryRoutes.js";
import { registerLearnedSkillsRoutes } from "./learnedSkills/learnedSkillsRoutes.js";
import { registerMachineRoutes } from "./machines/machineRoutes.js";
import { registerMachineProxyRoutes } from "./machines/machineProxyRoutes.js";
import { proxyMachinePluginAsset, registerMachinePluginProxyRoutes } from "./machines/machinePluginProxyRoutes.js";
import { registerTtsRoutes } from "./tts/ttsRoutes.js";
import { HostSpeechService } from "./tts/hostSpeechService.js";
import { SpeechDispatcherAdapter } from "./tts/speechDispatcherAdapter.js";
import type { HostSpeech } from "./tts/hostSpeech.js";
import type { Project, Workspace } from "./types.js";

export interface AppDependencies {
  projects?: ProjectService;
  workspaces?: WorkspaceService;
  machines?: MachineService;
  sessionDaemon?: SessionProxyDaemon;
  agentProfileProvider?: ActiveAgentProfileProvider;
  piWebUiPlugins?: Pick<PiWebUiPluginService, "manifest" | "plugins" | "readAsset">;
  piPackages?: PiPackageService;
  piPackagePlugins?: PiPackagePluginsConfigService;
  piWebUiStatusCache?: PiWebUiStatusCache;
  config?: PiWebUiConfigService;
  /** Shared cross-process config mutation authority; defaults to one shared lazy instance. */
  configMutationCoordinator?: PiWebUiConfigMutationCoordinator;
  /** Gateway speech input settings authority; production pairs it with the shared coordinator. */
  speechInputSettings?: SpeechInputSettingsService;
  clientDist?: string | false;
  logger?: FastifyServerOptions["logger"];
  /** Maximum accepted HTTP request body size in bytes. */
  bodyLimit?: number;
  /** Gateway host speech service for manual text-to-speech playback. */
  hostSpeech?: HostSpeech;
}

interface LocalProjectRouteOptions {
  config?: Pick<PiWebUiConfigService, "read">;
}

function registerLocalProjectRoutes(app: FastifyInstance, projects: ProjectService, workspaces: WorkspaceService, prefix: string, options: LocalProjectRouteOptions = {}): void {
  app.get(`${prefix}/projects`, async () => projects.list());

  app.post<{ Body: { name?: string; path: string; create?: boolean } }>(`${prefix}/projects`, async (request, reply) => {
    try {
      return await projects.add(request.body);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete<{ Params: { projectId: string } }>(`${prefix}/projects/:projectId`, async (request, reply) => {
    try {
      await projects.close(request.params.projectId);
      return { closed: true };
    } catch (error) {
      return sendProjectRouteError(reply, error);
    }
  });

  app.post<{ Params: { projectId: string } }>(`${prefix}/projects/:projectId/pin`, async (request, reply) => {
    try {
      return await projects.pin(request.params.projectId);
    } catch (error) {
      return sendProjectRouteError(reply, error);
    }
  });

  app.post<{ Params: { projectId: string } }>(`${prefix}/projects/:projectId/unpin`, async (request, reply) => {
    try {
      return await projects.unpin(request.params.projectId);
    } catch (error) {
      return sendProjectRouteError(reply, error);
    }
  });

  app.post<{ Params: { projectId: string } }>(`${prefix}/projects/:projectId/close-tree`, async (request, reply) => {
    try {
      return await projects.closeTree(request.params.projectId);
    } catch (error) {
      return sendProjectRouteError(reply, error);
    }
  });

  app.get(`${prefix}/recent-projects`, async (_request, reply) => {
    try {
      return await projects.listRecent();
    } catch (error) {
      return sendProjectRouteError(reply, error);
    }
  });

  app.post<{ Params: { projectId: string } }>(`${prefix}/projects/:projectId/recent`, async (request, reply) => {
    try {
      return await projects.recordRecent(request.params.projectId);
    } catch (error) {
      return sendProjectRouteError(reply, error);
    }
  });

  app.delete<{ Params: { entryId: string } }>(`${prefix}/recent-projects/:entryId`, async (request, reply) => {
    try {
      return await projects.removeRecent(request.params.entryId);
    } catch (error) {
      return sendProjectRouteError(reply, error);
    }
  });

  app.get<{ Querystring: { q?: string } }>(`${prefix}/project-directories`, async (request, reply) => {
    try {
      return await listDirectorySuggestions(request.query.q ?? "");
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { projectId: string } }>(`${prefix}/projects/:projectId/workspaces`, async (request, reply) => {
    try {
      const project = await projects.requireProject(request.params.projectId);
      return await listWorkspacesWithEffectiveConfig(project, workspaces, options.config);
    } catch (error) {
      return sendProjectRouteError(reply, error);
    }
  });
}

function sendProjectRouteError(reply: FastifyReply, error: unknown): FastifyReply {
  // Only unknown project ids answer 404. Genuine store or workspace failures
  // (git, filesystem) answer 500 so clients can distinguish them. The wider
  // resolveWorkspaceContext consumers (git, workspace explorer, terminal, and
  // workspace deletion routes) deliberately keep their own catch-all mapping
  // instead of this instanceof split, so the asymmetry is not an oversight.
  const status = error instanceof ProjectNotFoundError ? 404 : 500;
  return reply.code(status).send({ error: error instanceof Error ? error.message : String(error) });
}

async function listWorkspacesWithEffectiveConfig(project: Project, workspaces: WorkspaceService, config?: Pick<PiWebUiConfigService, "read">): Promise<Workspace[]> {
  const [workspaceList, effectiveConfig] = await Promise.all([
    workspaces.list(project),
    workspaceEffectiveConfig(project.path, config),
  ]);
  return workspaceList.map((workspace) => ({ ...workspace, effectiveConfig }));
}

async function workspaceEffectiveConfig(projectPath: string, config?: Pick<PiWebUiConfigService, "read">): Promise<NonNullable<Workspace["effectiveConfig"]>> {
  const globalConfig = config === undefined ? {} : (await config.read()).effectiveConfig;
  return { uploads: await loadEffectiveProjectUploadsConfig(projectPath, globalConfig) };
}

interface LocalFileSuggestionRouteOptions {
  config?: Pick<PiWebUiConfigService, "read">;
}

function registerLocalFileSuggestionRoutes(app: FastifyInstance, projects: ProjectService, workspaces: WorkspaceService, prefix: string, options: LocalFileSuggestionRouteOptions = {}): void {
  app.get<{ Querystring: { cwd?: string; q?: string; kind?: "tracked" | "untracked" | "other"; mode?: "file" | "path"; scope?: "tracked" | "all" } }>(`${prefix}/files`, async (request, reply) => {
    if (request.query.cwd === undefined || request.query.cwd === "") return reply.code(400).send({ error: "cwd query parameter is required" });
    try {
      const cwd = normalizeRequestCwd(request.query.cwd);
      const query = request.query.q ?? "";
      const pathAccess = isAbsoluteishFileSuggestionQuery(query) ? await pathAccessForCwd(cwd, projects, workspaces, options.config) : undefined;
      if (request.query.mode === "path") return await listPathSuggestions(cwd, query, pathAccess);
      return await listFileSuggestions(cwd, query, { kind: request.query.kind, scope: request.query.scope, pathAccess });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function readEffectiveConfig(config: Pick<PiWebUiConfigService, "read">) {
  return (await config.read()).effectiveConfig;
}

function invalidatePiWebUiStatusOnWrite(config: PiWebUiConfigService, statusCache: Pick<PiWebUiStatusCache, "invalidate">): PiWebUiConfigService {
  return {
    read: () => config.read(),
    write: async (nextConfig) => {
      const response = await config.write(nextConfig);
      statusCache.invalidate();
      return response;
    },
    update: async (mutate) => {
      const response = await config.update(mutate);
      statusCache.invalidate();
      return response;
    },
  };
}

async function withProfileDependency<T>(reply: FastifyReply, operation: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof ActiveAgentProfileAccessError)) throw error;
    return reply.code(503).send({ error: error.message });
  }
}

function isApiPath(requestUrl: string): boolean {
  return requestUrl === "/api" || requestUrl.startsWith("/api/") || requestUrl.startsWith("/api?");
}

/**
 * One lazy shared config mutation authority per app. When `injected` is
 * supplied, the returned coordinator delegates to exactly that instance, so
 * every consumer handed this proxy shares one authority. Otherwise the real
 * coordinator is created on first use against `pinnedEnv` (frozen from
 * `process.env` when omitted, the same startup moment `src/server/index.ts`
 * freezes its snapshot), so a live process.env change cannot move the
 * coordinated paths away from the frozen startup snapshot and apps that
 * never touch coordinated paths create no filesystem state.
 */
export function sharedConfigMutationCoordinator(
  injected: PiWebUiConfigMutationCoordinator | undefined,
  pinnedEnv: NodeJS.ProcessEnv = Object.freeze({ ...process.env }),
): PiWebUiConfigMutationCoordinator {
  let created: PiWebUiConfigMutationCoordinator | undefined;
  const resolve = (): PiWebUiConfigMutationCoordinator => {
    created ??= injected ?? createPiWebUiConfigMutationCoordinator({ config: { env: pinnedEnv } });
    return created;
  };
  return {
    read: () => resolve().read(),
    mutate: (mutate, mutationOptions) => resolve().mutate(mutate, mutationOptions),
  };
}

/**
 * The production gateway composition: exactly one shared lazy coordinator,
 * pinned to the frozen startup environment, handed to both the file-backed
 * generic config service and (through `AppDependencies.configMutationCoordinator`)
 * the speech settings service, so the normal startup path can never silently
 * own a second mutation authority.
 */
export function createGatewayConfigComposition(
  env: NodeJS.ProcessEnv,
  injectedCoordinator?: PiWebUiConfigMutationCoordinator,
): { coordinator: PiWebUiConfigMutationCoordinator; config: PiWebUiConfigService } {
  const coordinator = injectedCoordinator ?? sharedConfigMutationCoordinator(undefined, env);
  return { coordinator, config: createFilePiWebUiConfigService({ env }, coordinator) };
}

export async function buildApp(deps: AppDependencies = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? true,
    ...sessionRouteFastifyOptions,
    ...(deps.bodyLimit === undefined ? {} : { bodyLimit: deps.bodyLimit }),
  });
  // Vite proxies development API requests here, while production and machine-scoped
  // API requests already terminate here, so this is the shared HTTP edge.
  await app.register(fastifyCompress, {
    globalCompression: true,
    globalDecompression: false,
    threshold: 1024,
  });
  await app.register(fastifyWebsocket);

  const projects = deps.projects ?? new ProjectService(new ProjectStore());
  const workspaces = deps.workspaces ?? new WorkspaceService();
  // One shared config mutation authority for the app: the generic config
  // service and the speech settings service must never coordinate against
  // different coordinators. Construction stays lazy behind the shared
  // instance so apps that never touch coordinated paths (including injected
  // test apps) create no filesystem state in the real data directory.
  const configMutationCoordinator = sharedConfigMutationCoordinator(deps.configMutationCoordinator);
  const configService = deps.config ?? createFilePiWebUiConfigService(undefined, configMutationCoordinator);
  const readConfig = () => readEffectiveConfig(configService);
  const sessionDaemon = deps.sessionDaemon ?? new SessionDaemonClient();
  const agentProfileProvider = deps.agentProfileProvider ?? new SessionDaemonActiveAgentProfileProvider(sessionDaemon);
  const piWebUiPlugins = deps.piWebUiPlugins ?? new PiWebUiPluginService({
    configProvider: readConfig,
    agentDirProvider: async () => (await requireActiveAgentProfile(agentProfileProvider)).dir,
  });
  const piPackages = deps.piPackages ?? createActiveProfilePiPackageService(agentProfileProvider);
  const piPackagePlugins = deps.piPackagePlugins ?? createActiveProfilePiPackagePluginsConfigService(agentProfileProvider);
  const piWebUiStatusCache = deps.piWebUiStatusCache ?? createPiWebUiStatusCache(
    async ({ force }) => {
      const activeAgentProfile = await agentProfileProvider.getActiveAgentProfile();
      return getPiWebUiStatus(sessionDaemon, {
        forceReleaseCheck: force,
        ...(activeAgentProfile.status === "available" ? { activeAgentProfile: activeAgentProfile.profile } : {}),
      });
    },
    { onError: (error) => { app.log.warn({ err: error }, "failed to refresh PI WEBUI status cache"); } },
  );
  const machines = deps.machines ?? new MachineService(undefined, {
    localRuntime: () => getPiWebUiRuntime(sessionDaemon),
  });
  const hostSpeech = deps.hostSpeech ?? new HostSpeechService(new SpeechDispatcherAdapter());

  app.get("/pi-webui-plugins/manifest.json", async (_request, reply) => withProfileDependency(reply, () => piWebUiPlugins.manifest()));

  app.get<{ Params: { pluginId: string; "*": string } }>("/pi-webui-plugins/:pluginId/*", async (request, reply) => {
    if (await proxyMachinePluginAsset(machines, request.params.pluginId, request.params["*"], request.url, reply)) return;

    return withProfileDependency(reply, async () => {
      const asset = await piWebUiPlugins.readAsset(request.params.pluginId, request.params["*"]);
      if (asset === undefined) return reply.code(404).send({ error: "Plugin asset not found" });
      return reply.type(asset.contentType).send(asset.content);
    });
  });

  app.get<{ Querystring: { refresh?: string } }>("/api/pi-webui/status", async (request) => request.query.refresh === "1"
    ? piWebUiStatusCache.refresh({ force: true })
    : piWebUiStatusCache.get());
  app.get("/api/pi-webui/version", async () => {
    const activeAgentProfile = await agentProfileProvider.getActiveAgentProfile();
    return getPiWebUiVersionStatus(sessionDaemon, activeAgentProfile.status === "available" ? { activeAgentProfile: activeAgentProfile.profile } : {});
  });
  app.get("/api/pi-webui/runtime", async () => getPiWebUiRuntime(sessionDaemon));
  app.get("/api/plugins", async (_request, reply) => withProfileDependency(reply, () => piWebUiPlugins.plugins()));
  app.get("/api/machines/local/plugins", async (_request, reply) => withProfileDependency(reply, () => piWebUiPlugins.plugins()));
  registerPiPackageRoutes(app, piPackages);
  registerPiPackageRoutes(app, piPackages, "/api/machines/local");
  registerPiPackagePluginsConfigRoutes(app, piPackagePlugins);
  registerPiPackagePluginsConfigRoutes(app, piPackagePlugins, "/api/machines/local");
  const invalidatingConfigService = invalidatePiWebUiStatusOnWrite(configService, piWebUiStatusCache);
  registerConfigRoutes(app, invalidatingConfigService);
  registerLocalMachineConfigRoutes(app, invalidatingConfigService);

  const speechInputSettingsService = deps.speechInputSettings ?? createSpeechInputSettingsService({
    coordinator: configMutationCoordinator,
    onCommitted: () => {
      piWebUiStatusCache.invalidate();
    },
  });
  registerSpeechInputSettingsRoutes(app, speechInputSettingsService);

  registerMemoryRoutes(app, agentProfileProvider, "/api");
  registerMemoryRoutes(app, agentProfileProvider, "/api/machines/local");

  registerLearnedSkillsRoutes(app, agentProfileProvider, "/api");
  registerLearnedSkillsRoutes(app, agentProfileProvider, "/api/machines/local");

  registerMachineRoutes(app, machines);
  registerMachinePluginProxyRoutes(app, machines);

  registerLocalProjectRoutes(app, projects, workspaces, "/api", { config: configService });
  registerLocalProjectRoutes(app, projects, workspaces, "/api/machines/local", { config: configService });

  registerSessionProxyRoutes(app, sessionDaemon);
  registerSessionProxyRoutes(app, sessionDaemon, "/api/machines/local");
  registerWorkspaceExplorerRoutes(app, projects, workspaces, "/api", { config: configService });
  registerWorkspaceExplorerRoutes(app, projects, workspaces, "/api/machines/local", { config: configService });
  registerGitRoutes(app, projects, workspaces);
  registerGitRoutes(app, projects, workspaces, "/api/machines/local");
  registerTerminalProxyRoutes(app, projects, workspaces, sessionDaemon);
  registerTerminalProxyRoutes(app, projects, workspaces, sessionDaemon, "/api/machines/local");
  registerWorkspaceDeletionRoutes(app, projects, workspaces, sessionDaemon);
  registerWorkspaceDeletionRoutes(app, projects, workspaces, sessionDaemon, "/api/machines/local");

  registerSystemInfoRoutes(app, "/api/pi-webui", { piWebUiRuntime: () => getPiWebUiRuntime(sessionDaemon) });
  registerSystemInfoRoutes(app, "/api/machines/local/pi-webui", { piWebUiRuntime: () => getPiWebUiRuntime(sessionDaemon) });

  registerLocalFileSuggestionRoutes(app, projects, workspaces, "/api", { config: configService });
  registerLocalFileSuggestionRoutes(app, projects, workspaces, "/api/machines/local", { config: configService });

  registerTtsRoutes(app, hostSpeech);
  app.addHook("onClose", () => hostSpeech.close());

  registerMachineProxyRoutes(app, machines);

  const packagedClientDist = join(dirname(fileURLToPath(import.meta.url)), "..", "client");
  const clientDist = deps.clientDist ?? (existsSync(packagedClientDist) ? packagedClientDist : join(process.cwd(), "dist", "client"));
  if (clientDist !== false && existsSync(clientDist)) {
    await app.register(fastifyStatic, { root: clientDist });
    app.setNotFoundHandler((request, reply) => {
      if (isApiPath(request.url)) return reply.code(404).send({ error: "API route not found" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}
