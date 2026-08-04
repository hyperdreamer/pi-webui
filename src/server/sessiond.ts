#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { WorkspaceActivityService } from "./activity/workspaceActivityService.js";
import { registerWorkspaceActivityRoutes } from "./activity/workspaceActivityRoutes.js";
import { SessionEventHub } from "./realtime/sessionEventHub.js";
import { AuthService } from "./sessions/authService.js";
import { registerAuthRoutes } from "./sessions/authRoutes.js";
import { ModelsConfigService } from "./models/modelsConfigService.js";
import { registerModelsConfigRoutes } from "./models/modelsConfigRoutes.js";
import { SkillsConfigService } from "./skills/skillsConfigService.js";
import { registerSkillsConfigRoutes } from "./skills/skillsConfigRoutes.js";
import { PiSessionService } from "./sessions/piSessionService.js";
import { createPiSessionManagerGateway } from "./sessions/piSessionManagerGateway.js";
import { registerSessionRoutes } from "./sessions/sessionRoutes.js";
import { SessionDefaultsService } from "./sessions/sessionDefaultsService.js";
import { registerSessionDefaultsRoutes } from "./sessions/sessionDefaultsRoutes.js";
import { StarterModelPolicyPreferenceStore } from "./sessions/starterModelPolicyPreferenceStore.js";
import { createModelTierSettingsService } from "./sessions/modelTierSettingsService.js";
import { registerModelTierSettingsRoutes } from "./sessions/modelTierSettingsRoutes.js";
import { SessionNotificationStore } from "./sessions/sessionNotificationStore.js";
import { FileSessionUnreadPersistence, SessionUnreadStore } from "./sessions/sessionUnreadStore.js";
import { ProjectScopedSpawnTargetResolver } from "./sessions/spawnTargetResolver.js";
import { ProjectService } from "./projects/projectService.js";
import { ProjectStore } from "./storage/projectStore.js";
import { WorkspaceService } from "./workspaces/workspaceService.js";
import { sessiondSocketPath } from "../sessiond/config.js";
import { TerminalService } from "./terminals/terminalService.js";
import { registerTerminalRoutes } from "./terminals/terminalRoutes.js";
import { getPiWebUiRuntimeComponent } from "./piWebUiStatus.js";
import { SESSIOND_RUNTIME_CAPABILITIES } from "../shared/capabilities.js";
import { agentSessionDirEnvKeys, effectivePiWebUiConfig, loadPiWebUiConfig, maxUploadBytes, replacePiWebUiModelTiers } from "../config.js";
import { createActiveAgentProfileDescriptor } from "../sessiond/activeAgentProfile.js";
import { runSessionDaemonStartup } from "./sessiond/sessionDaemonStartup.js";
import { resolveSkillsGitHubToken } from "./sessiond/skillsGithubToken.js";
import { runtimeThinkingLevels } from "./sessions/modelTierRegistry.js";

const daemonEnvironment: NodeJS.ProcessEnv = Object.freeze({ ...process.env });
const { config } = effectivePiWebUiConfig({ env: daemonEnvironment });
const activeAgentProfile = createActiveAgentProfileDescriptor({
  command: config.agent.command,
  dir: config.agent.dir,
  sessionDirEnvKeys: agentSessionDirEnvKeys(config.agent.command),
});
const app = Fastify({ logger: true, bodyLimit: maxUploadBytes(daemonEnvironment, config) });
await app.register(fastifyWebsocket);

await runSessionDaemonStartup({
  logger: app.log,
  async createRuntime() {
    const eventHub = new SessionEventHub();
    const notificationStore = new SessionNotificationStore();
    const unreadStore = new SessionUnreadStore({
      persistence: new FileSessionUnreadPersistence(),
      onPersistenceError(operation, error) {
        app.log.error({ err: error, operation }, "session unread persistence failed");
      },
    });
    await unreadStore.load();
    const workspaceActivity = new WorkspaceActivityService(eventHub);
    const auth = await AuthService.create({ agentDir: activeAgentProfile.dir, logger: app.log });
    const models = new ModelsConfigService({ agentDir: activeAgentProfile.dir, modelRuntime: auth.runtime });
    const githubToken = resolveSkillsGitHubToken(daemonEnvironment);
    const skills = new SkillsConfigService({
      agentDir: activeAgentProfile.dir,
      ...(githubToken === undefined ? {} : { githubToken }),
    });
    const spawnTargets = config.spawnSessions
      ? new ProjectScopedSpawnTargetResolver({ projects: new ProjectService(new ProjectStore()), workspaces: new WorkspaceService() })
      : undefined;
    const starterModelPolicyPreferenceStore = new StarterModelPolicyPreferenceStore();
    const sessions = new PiSessionService(eventHub, {
      modelRuntime: auth.runtime,
      agentDir: activeAgentProfile.dir,
      workspaceActivity,
      logger: app.log,
      ...(spawnTargets === undefined ? {} : { spawnTargets }),
      subsessionsEnabled: spawnTargets !== undefined && config.subsessions,
      notificationStore,
      unreadStore,
      starterModelPolicyPreferenceStore,
      sessionManager: createPiSessionManagerGateway({
        agentDir: activeAgentProfile.dir,
        env: daemonEnvironment,
        sessionDirEnvKeys: activeAgentProfile.sessionDirEnvKeys,
      }),
    });
    auth.subscribe((change) => { sessions.applyAuthChange(change); });
    const defaults = new SessionDefaultsService({
      agentDir: activeAgentProfile.dir,
      modelRuntime: auth.runtime,
      starterModelPolicyPreferenceStore,
    });
    const modelTiers = createModelTierSettingsService({
      loadConfig: () => {
        const loaded = loadPiWebUiConfig({ env: daemonEnvironment });
        return {
          ...(loaded.config.modelTiers === undefined ? {} : { modelTiers: loaded.config.modelTiers }),
          ...(loaded.modelTiersError === undefined ? {} : { modelTiersError: loaded.modelTiersError }),
        };
      },
      saveConfig: ({ modelTiers: ladder }) => {
        replacePiWebUiModelTiers(ladder, { env: daemonEnvironment });
      },
      modelRuntime: auth.runtime,
      thinkingLevelsForModel: runtimeThinkingLevels,
    });
    const terminals = new TerminalService(eventHub, workspaceActivity);
    const runtimeComponent = Object.freeze({
      ...getPiWebUiRuntimeComponent("sessiond", SESSIOND_RUNTIME_CAPABILITIES),
      activeAgentProfile,
    });
    return { eventHub, workspaceActivity, auth, models, skills, sessions, defaults, modelTiers, terminals, unreadStore, activeAgentProfile, runtimeComponent };
  },
  registerRoutes({ eventHub, workspaceActivity, auth, models, skills, sessions, defaults, modelTiers, terminals, runtimeComponent }) {
    registerWorkspaceActivityRoutes(app, workspaceActivity);
    registerAuthRoutes(app, auth);
    registerModelsConfigRoutes(app, models);
    registerSkillsConfigRoutes(app, skills);
    registerSessionDefaultsRoutes(app, defaults);
    registerModelTierSettingsRoutes(app, modelTiers);
    registerSessionRoutes(app, sessions, eventHub);
    registerTerminalRoutes(app, terminals);

    app.get("/health", () => ({
      ok: true,
      activeSessions: sessions.activeCount(),
      checkedAt: new Date().toISOString(),
      version: {
        component: runtimeComponent.component,
        label: runtimeComponent.label,
        ...(runtimeComponent.runtimeVersion === undefined ? {} : { runtimeVersion: runtimeComponent.runtimeVersion }),
        stale: false,
        available: runtimeComponent.available,
      },
    }));

    app.get("/runtime", () => runtimeComponent);
  },
  async listen({ auth, sessions, terminals, unreadStore }) {
    let shuttingDown = false;
    async function shutdown(signal: NodeJS.Signals): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      app.log.info({ signal }, "shutting down session daemon");
      const attempt = async (operation: string, run: () => void | Promise<void>): Promise<void> => {
        try {
          await run();
        } catch (error: unknown) {
          process.exitCode = 1;
          app.log.error({ err: error, operation }, "session daemon shutdown operation failed");
        }
      };
      await attempt("dispose terminals", () => { terminals.dispose(); });
      await attempt("dispose auth", () => { auth.dispose(); });
      await attempt("dispose sessions", () => sessions.dispose());
      await attempt("flush session unread state", () => unreadStore.flush());
      await attempt("close server", () => app.close());
    }

    process.once("SIGINT", (signal) => { void shutdown(signal); });
    process.once("SIGTERM", (signal) => { void shutdown(signal); });

    const portValue = daemonEnvironment["PI_WEBUI_SESSIOND_PORT"];
    const port = portValue !== undefined && portValue !== "" ? Number(portValue) : undefined;
    const host = daemonEnvironment["PI_WEBUI_SESSIOND_HOST"] ?? "127.0.0.1";

    if (port !== undefined) {
      await app.listen({ port, host });
    } else {
      const path = sessiondSocketPath();
      await mkdir(dirname(path), { recursive: true });
      await rm(path, { force: true });
      await app.listen({ path });
      process.on("exit", () => void rm(path, { force: true }));
    }
  },
});
