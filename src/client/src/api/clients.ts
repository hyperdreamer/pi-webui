import type { DeleteWorkspaceFileResponse, FileSuggestion, ModelConnectionTestRequest, ModelDiscoveryRequest, ModelsConfigDocument, MoveWorkspaceFileOptions, PiPackageInstallRequest, PiPackageRemoveRequest, PiPackageScope, PiPackageUpdateRequest, PiWebUiConfigValues, PromptAttachment, RunTerminalCommandInput, SessionBulkMutationRef, SessionCleanupRequest, SessionNotificationDismissThrough, SessionRef, SessionTreeNavigateRequest, SessionUnreadAcknowledgeRequest, TerminalCommandRun, TerminalCommandRunFilter, WriteWorkspaceFileOptions } from "../../../shared/apiTypes";
import type { PiPackagePluginMutationRequest, PiPackagePluginsResponse } from "../../../shared/apiTypes";
import type { SessionDefaultsUpdate } from "../../../shared/apiTypes";
import type { SessionModelPolicyUpdate, StarterModelPolicyPreference } from "../../../shared/apiTypes";
import type { ModelTierLadder } from "../../../shared/apiTypes";
import type { MemorySnapshotResponse } from "../../../shared/apiTypes";
import type { SkillCheckRequest, SkillInstallRequest, SkillMutationResponse, SkillSearchRequest, SkillSearchResponse, SkillsCheckResponse, SkillsResponse, SkillToggleRequest, SkillUpdateRequest, SkillUpdateResponse } from "../../../shared/apiTypes";
import { resolveAppUrl } from "../appUrl";
import { request } from "./http";
import {
  arrayOf,
  parseAborted,
  parseAccepted,
  parseArchived,
  parseAuthProvidersResponse,
  parseClosed,
  parseCommandResult,
  parseConfirmedStarterModelPolicyPreference,
  parseDeleted,
  parseDeleteWorkspaceFileResponse,
  parseDetached,
  parseFileContentResponse,
  parseFileSuggestion,
  parseFileTreeResponse,
  parseGitDiffResponse,
  parseGitStatusResponse,
  parseMachine,
  parseMachineHealth,
  parseMachineRuntime,
  parseMemorySnapshotResponse,
  parseMachinesResponse,
  parseMessagePage,
  parseModelConnectionTestResponse,
  parseModelDiscoveryResponse,
  parseModelSelectionResponse,
  parseModelTierSettingsResponse,
  parseModelsConfigDocument,
  parseModelsConfigSaveResponse,
  parseSkillMutationResponse,
  parseSkillSearchResponse,
  parseSkillsCheckResponse,
  parseSkillsResponse,
  parseSkillUpdateResponse,
  parseMoveWorkspaceFileResponse,
  parseOAuthFlowState,
  parsePiPackageMutationResponse,
  parsePiPackagePluginsResponse,
  parsePiPackagesResponse,
  parsePiWebUiConfigResponse,
  parsePiWebUiPluginsResponse,
  parsePiWebUiRuntimeResponse,
  parsePiWebUiStatusResponse,
  parseProject,
  parseReloaded,
  parseRestored,
  parseSavedAttachments,
  parseSessionBulkArchiveResponse,
  parseSessionBulkDeleteArchivedResponse,
  parseSessionCleanupExecuteResponse,
  parseSessionCleanupPreviewResponse,
  parseSessionDefaultsResponse,
  parseSessionDefaultsV2Response,
  parseSessionInfo,
  parseSessionMessageForkResult,
  parseSessionModelPolicyResponse,
  parseSessionNotificationInboxSnapshot,
  parseSessionStatus,
  parseSessionSystemPrompt,
  parseSessionUnreadCatalogSnapshot,
  parseSessionStreamSnapshot,
  parseSessionTreeNavigateResult,
  parseSlashCommand,
  parseStopped,
  parseTerminalCommandRun,
  parseTerminalInfo,
  parseThinkingLevelsResponse,
  parseWriteWorkspaceFileResponse,
  parseWorkspace,
  parseWorkspaceActivityResponse,
  parseSystemInfoResponse,
  parseSystemMetricsResponse,
} from "./parsers";
import { machineGitDiffPath, messagePath } from "./urls";

const machinePrefix = (machineId = "local") => `api/machines/${encodeURIComponent(machineId)}`;

type SessionLookup = SessionRef | string;

function sessionId(session: SessionLookup): string {
  return typeof session === "string" ? session : session.id;
}

function sessionCwd(session: SessionLookup): string | undefined {
  return typeof session === "string" ? undefined : session.cwd;
}

function sessionBasePath(session: SessionLookup, machineId = "local"): string {
  return `${machinePrefix(machineId)}/sessions/${encodeURIComponent(sessionId(session))}`;
}

function sessionPath(session: SessionLookup, endpoint: string, machineId = "local"): string {
  return `${sessionBasePath(session, machineId)}/${endpoint}`;
}

function sessionQueryPath(session: SessionLookup, endpoint: string, machineId = "local"): string {
  return `${sessionPath(session, endpoint, machineId)}${sessionQuery(session)}`;
}

function sessionBaseQueryPath(session: SessionLookup, machineId = "local"): string {
  return `${sessionBasePath(session, machineId)}${sessionQuery(session)}`;
}

function sessionQuery(session: SessionLookup): string {
  const cwd = sessionCwd(session);
  return cwd === undefined || cwd === "" ? "" : `?${new URLSearchParams({ cwd }).toString()}`;
}

function sessionBody(session: SessionLookup, fields: Record<string, unknown> = {}): string {
  const cwd = sessionCwd(session);
  return JSON.stringify(cwd === undefined || cwd === "" ? fields : { cwd, ...fields });
}

function sessionBulkMutationBody(sessions: readonly SessionLookup[]): string {
  return JSON.stringify({ sessions: sessions.map(sessionBulkMutationRef) });
}

function sessionBulkMutationRef(session: SessionLookup): SessionBulkMutationRef {
  const id = sessionId(session);
  const cwd = sessionCwd(session);
  return cwd === undefined || cwd === "" ? { id } : { id, cwd };
}

function piWebUiStatusPath(machineId: string): string {
  return machineId === "local" ? "api/pi-webui/status" : `${machinePrefix(machineId)}/pi-webui/status`;
}

export const piWebUiApi = {
  piWebUiStatus: (machineId = "local") => request(piWebUiStatusPath(machineId), parsePiWebUiStatusResponse),
  checkForUpdates: (machineId = "local") => request(`${piWebUiStatusPath(machineId)}?refresh=1`, parsePiWebUiStatusResponse, { cache: "no-store" }),
  piWebUiRuntime: () => request("api/pi-webui/runtime", parsePiWebUiRuntimeResponse),
  systemInfo: (machineId = "local") => request(`${machinePrefix(machineId)}/pi-webui/system-info`, parseSystemInfoResponse),
  systemMetrics: (machineId = "local") => request(`${machinePrefix(machineId)}/pi-webui/system-metrics`, parseSystemMetricsResponse, { cache: "no-store" }),
};

export const machinesApi = {
  machines: () => request("api/machines", parseMachinesResponse),
  addMachine: (input: { name: string; baseUrl: string; token?: string }) => request("api/machines", parseMachine, { method: "POST", body: JSON.stringify(input) }),
  deleteMachine: (machineId: string) => request(`api/machines/${encodeURIComponent(machineId)}`, (value) => value, { method: "DELETE" }),
  health: (machineId: string) => request(`api/machines/${encodeURIComponent(machineId)}/health`, parseMachineHealth),
  runtime: (machineId: string, refresh = false) => request(`api/machines/${encodeURIComponent(machineId)}/runtime${refresh ? "?refresh=1" : ""}`, parseMachineRuntime, refresh ? { cache: "no-store" } : {}),
};

function memorySnapshotPath(projectPath: string, machineId = "local"): string {
  const params = new URLSearchParams({ projectPath });
  return `${machinePrefix(machineId)}/agent-memory/snapshot?${params.toString()}`;
}

export const memoryApi = {
  snapshot: (projectPath: string, machineId = "local"): Promise<MemorySnapshotResponse> => request(memorySnapshotPath(projectPath, machineId), parseMemorySnapshotResponse, { cache: "no-store" }),
};

function configPath(machineId?: string): string {
  return machineId === undefined ? "api/config" : `${machinePrefix(machineId)}/config`;
}

function pluginsPath(machineId?: string): string {
  return machineId === undefined ? "api/plugins" : `${machinePrefix(machineId)}/plugins`;
}

export const configApi = {
  config: (machineId?: string) => request(configPath(machineId), parsePiWebUiConfigResponse),
  saveConfig: (config: PiWebUiConfigValues, machineId?: string) => request(configPath(machineId), parsePiWebUiConfigResponse, { method: "PUT", body: JSON.stringify({ config }) }),
};

export const pluginsApi = {
  plugins: (machineId?: string) => request(pluginsPath(machineId), parsePiWebUiPluginsResponse),
};

function modelsConfigPath(machineId = "local"): string {
  return `${machinePrefix(machineId)}/models-config`;
}

export const modelsConfigApi = {
  config: (machineId = "local") => request(modelsConfigPath(machineId), parseModelsConfigDocument),
  save: (config: ModelsConfigDocument, machineId = "local") => request(modelsConfigPath(machineId), parseModelsConfigSaveResponse, { method: "PUT", body: JSON.stringify(config) }),
  test: (input: ModelConnectionTestRequest, machineId = "local") => request(`${modelsConfigPath(machineId)}/test`, parseModelConnectionTestResponse, { method: "POST", body: JSON.stringify(input) }),
  discover: (input: ModelDiscoveryRequest, machineId = "local") => request(`${modelsConfigPath(machineId)}/discover`, parseModelDiscoveryResponse, { method: "POST", body: JSON.stringify(input) }),
};

function modelTiersPath(machineId = "local"): string {
  return `${machinePrefix(machineId)}/model-tiers`;
}

export const modelTiersApi = {
  settings: (machineId = "local") => request(modelTiersPath(machineId), parseModelTierSettingsResponse),
  save: (ladder: ModelTierLadder, machineId = "local") => request(modelTiersPath(machineId), parseModelTierSettingsResponse, { method: "PUT", body: JSON.stringify({ ladder }) }),
};

function skillsConfigPath(machineId = "local"): string {
  return `${machinePrefix(machineId)}/skills`;
}

function skillsListPath(cwd: string, machineId = "local"): string {
  return `${skillsConfigPath(machineId)}?${new URLSearchParams({ cwd }).toString()}`;
}

export const skillsConfigApi = {
  list: (cwd: string, machineId = "local"): Promise<SkillsResponse> => request(skillsListPath(cwd, machineId), parseSkillsResponse),
  toggle: (input: SkillToggleRequest, machineId = "local"): Promise<SkillMutationResponse> => request(skillsConfigPath(machineId), parseSkillMutationResponse, { method: "PATCH", body: JSON.stringify(input) }),
  search: (input: SkillSearchRequest, machineId = "local"): Promise<SkillSearchResponse> => request(`${skillsConfigPath(machineId)}/search`, parseSkillSearchResponse, { method: "POST", body: JSON.stringify(input) }),
  install: (input: SkillInstallRequest, machineId = "local"): Promise<SkillMutationResponse> => request(`${skillsConfigPath(machineId)}/install`, parseSkillMutationResponse, { method: "POST", body: JSON.stringify(input) }),
  check: (input: SkillCheckRequest, machineId = "local"): Promise<SkillsCheckResponse> => request(`${skillsConfigPath(machineId)}/check`, parseSkillsCheckResponse, { method: "POST", body: JSON.stringify(input) }),
  update: (input: SkillUpdateRequest, machineId = "local"): Promise<SkillUpdateResponse> => request(`${skillsConfigPath(machineId)}/update`, parseSkillUpdateResponse, { method: "POST", body: JSON.stringify(input) }),
};

function piPackagePath(endpoint = "", machineId?: string): string {
  const basePath = machineId === undefined ? "api/pi-packages" : `${machinePrefix(machineId)}/pi-packages`;
  return endpoint === "" ? basePath : `${basePath}/${endpoint}`;
}

export const piPackagesApi = {
  packages: (machineId?: string) => request(piPackagePath("", machineId), parsePiPackagesResponse),
  install: (source: string, machineId?: string) => {
    const body: PiPackageInstallRequest = { source };
    return request(piPackagePath("install", machineId), parsePiPackageMutationResponse, { method: "POST", body: JSON.stringify(body) });
  },
  remove: (source: string, scope?: PiPackageScope, machineId?: string) => {
    const body: PiPackageRemoveRequest = scope === undefined ? { source } : { source, scope };
    return request(piPackagePath("remove", machineId), parsePiPackageMutationResponse, { method: "POST", body: JSON.stringify(body) });
  },
  update: (source?: string, machineId?: string) => {
    const body: PiPackageUpdateRequest | undefined = source === undefined ? undefined : { source };
    return request(piPackagePath("update", machineId), parsePiPackageMutationResponse, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  },
};

function piPackagePluginsPath(machineId = "local"): string {
  return `${machinePrefix(machineId)}/package-plugins`;
}

function piPackagePluginsListPath(cwd: string, machineId = "local"): string {
  return `${piPackagePluginsPath(machineId)}?${new URLSearchParams({ cwd }).toString()}`;
}

export const piPackagePluginsApi = {
  list: (cwd: string, machineId = "local"): Promise<PiPackagePluginsResponse> => request(piPackagePluginsListPath(cwd, machineId), parsePiPackagePluginsResponse),
  mutate: (input: PiPackagePluginMutationRequest, machineId = "local"): Promise<PiPackagePluginsResponse> => request(piPackagePluginsPath(machineId), parsePiPackagePluginsResponse, { method: "POST", body: JSON.stringify(input) }),
};

export const activityApi = {
  workspaceActivity: (machineId = "local") => request(`${machinePrefix(machineId)}/activity`, parseWorkspaceActivityResponse),
};

export const projectsApi = {
  projects: (machineId = "local") => request(`${machinePrefix(machineId)}/projects`, arrayOf(parseProject)),
  addProject: (path: string, name?: string, create?: boolean, machineId = "local") => request(`${machinePrefix(machineId)}/projects`, parseProject, { method: "POST", body: JSON.stringify({ path, name, create }) }),
  closeProject: (projectId: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}`, parseClosed, { method: "DELETE" }),
  projectDirectories: (query: string, machineId = "local") => request(`${machinePrefix(machineId)}/project-directories?q=${encodeURIComponent(query)}`, arrayOf(parseFileSuggestion)),
};

export const workspacesApi = {
  workspaces: (projectId: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces`, arrayOf(parseWorkspace)),
  deleteWorkspace: (projectId: string, workspaceId: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}`, parseTerminalCommandRun, { method: "DELETE" }),
  workspaceTree: (projectId: string, workspaceId: string, path = "", machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/tree?path=${encodeURIComponent(path)}`, parseFileTreeResponse),
  workspaceFile: (projectId: string, workspaceId: string, path: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/file?path=${encodeURIComponent(path)}`, parseFileContentResponse),
  writeWorkspaceFile: (projectId: string, workspaceId: string, path: string, content: string | Uint8Array, options?: WriteWorkspaceFileOptions, machineId = "local") => {
    const params = new URLSearchParams({ path });
    if (options?.createDirs === false) params.set("createDirs", "false");
    if (options?.overwrite === false) params.set("overwrite", "false");
    const isBinary = content instanceof Uint8Array;
    const body: BodyInit = isBinary ? new Uint8Array(content) : new TextEncoder().encode(content);
    return request(
      `${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/file?${params.toString()}`,
      parseWriteWorkspaceFileResponse,
      { method: "PUT", body, headers: { "Content-Type": isBinary ? "application/octet-stream" : "text/plain" } },
    );
  },
  deleteWorkspaceFile: (projectId: string, workspaceId: string, path: string, machineId = "local"): Promise<DeleteWorkspaceFileResponse> => {
    const params = new URLSearchParams({ path });
    return request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/file?${params.toString()}`, parseDeleteWorkspaceFileResponse, { method: "DELETE" });
  },
  moveWorkspaceFile: (projectId: string, workspaceId: string, fromPath: string, toPath: string, options?: MoveWorkspaceFileOptions, machineId = "local") => {
    const params = new URLSearchParams({ fromPath, toPath });
    if (options?.createDirs === false) params.set("createDirs", "false");
    if (options?.overwrite === true) params.set("overwrite", "true");
    return request(
      `${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/file/move?${params.toString()}`,
      parseMoveWorkspaceFileResponse,
      { method: "POST" },
    );
  },
};

export const sessionsApi = {
  sessions: (cwd: string, machineId = "local") => request(`${machinePrefix(machineId)}/sessions?cwd=${encodeURIComponent(cwd)}`, arrayOf(parseSessionInfo)),
  unreadCatalog: (machineId = "local") => request(`${machinePrefix(machineId)}/sessions/unread`, parseSessionUnreadCatalogSnapshot, { cache: "no-store" }),
  acknowledgeUnread: (session: SessionRef, catalogId: string, throughCompletionOrder: number, machineId = "local") => {
    const body: SessionUnreadAcknowledgeRequest = { cwd: session.cwd, catalogId, throughCompletionOrder };
    return request(sessionPath(session, "unread/acknowledge", machineId), parseSessionUnreadCatalogSnapshot, { method: "POST", body: JSON.stringify(body) });
  },
  notificationInbox: (session: SessionLookup, machineId = "local") => request(sessionQueryPath(session, "notifications", machineId), parseSessionNotificationInboxSnapshot),
  dismissNotification: (session: SessionLookup, daemonInstanceId: string, notificationId: string, machineId = "local") => request(sessionPath(session, "notifications/dismiss", machineId), parseSessionNotificationInboxSnapshot, { method: "POST", body: sessionBody(session, { daemonInstanceId, notificationId }) }),
  dismissAllNotifications: (session: SessionLookup, daemonInstanceId: string, through: SessionNotificationDismissThrough, machineId = "local") => request(sessionPath(session, "notifications/dismiss-all", machineId), parseSessionNotificationInboxSnapshot, { method: "POST", body: sessionBody(session, { daemonInstanceId, throughOrder: through.order, throughOverflowWatermark: through.overflowWatermark }) }),
  startSession: (cwd: string, machineId = "local", modelPolicy?: SessionModelPolicyUpdate) => request(`${machinePrefix(machineId)}/sessions`, parseSessionInfo, { method: "POST", body: JSON.stringify({ cwd, ...(modelPolicy === undefined ? {} : { modelPolicy }) }) }),
  startPlusSession: (cwd: string, initialModelPolicy: StarterModelPolicyPreference, machineId = "local") => request(`${machinePrefix(machineId)}/sessions`, parseSessionInfo, {
    method: "POST",
    body: JSON.stringify({ cwd, creationSource: "session-list-plus", initialModelPolicy }),
  }),
  sessionDefaults: (cwd: string, machineId = "local") => request(`${machinePrefix(machineId)}/session-defaults?cwd=${encodeURIComponent(cwd)}`, parseSessionDefaultsResponse),
  sessionDefaultsV2: (cwd: string, machineId = "local") => {
    const params = new URLSearchParams({
      cwd,
      starterModelPolicyContract: "2",
    });
    return request(
      `${machinePrefix(machineId)}/session-defaults?${params.toString()}`,
      parseSessionDefaultsV2Response,
    );
  },
  updateSessionDefaults: (cwd: string, update: SessionDefaultsUpdate, machineId = "local") => request(`${machinePrefix(machineId)}/session-defaults`, parseSessionDefaultsResponse, { method: "PUT", body: JSON.stringify({ cwd, ...update }) }),
  cleanupPreview: (input: SessionCleanupRequest, machineId = "local") => request(`${machinePrefix(machineId)}/sessions/cleanup/preview`, parseSessionCleanupPreviewResponse, { method: "POST", body: JSON.stringify(input) }),
  cleanup: (input: SessionCleanupRequest, machineId = "local") => request(`${machinePrefix(machineId)}/sessions/cleanup`, parseSessionCleanupExecuteResponse, { method: "POST", body: JSON.stringify(input) }),
  forceCleanup: (machineId = "local") => request(`${machinePrefix(machineId)}/sessions/cleanup/force`, parseSessionCleanupExecuteResponse, { method: "POST" }),
  archiveMany: (sessions: readonly SessionLookup[], machineId = "local") => request(`${machinePrefix(machineId)}/sessions/bulk/archive`, parseSessionBulkArchiveResponse, { method: "POST", body: sessionBulkMutationBody(sessions) }),
  deleteArchivedMany: (sessions: readonly SessionLookup[], machineId = "local") => request(`${machinePrefix(machineId)}/sessions/bulk/delete-archived`, parseSessionBulkDeleteArchivedResponse, { method: "POST", body: sessionBulkMutationBody(sessions) }),
  messages: (session: SessionLookup, options?: { limit?: number; before?: number }, machineId = "local") => request(messagePath(session, options, machineId), parseMessagePage),
  status: (session: SessionLookup, machineId = "local") => request(sessionQueryPath(session, "status", machineId), parseSessionStatus),
  systemPrompt: (session: SessionLookup, machineId = "local") => request(sessionQueryPath(session, "system-prompt", machineId), parseSessionSystemPrompt),
  streamSnapshot: (session: SessionLookup, machineId = "local") => request(sessionQueryPath(session, "stream-snapshot", machineId), parseSessionStreamSnapshot),
  clearQueue: (session: SessionLookup, machineId = "local") => request(sessionPath(session, "queue/clear", machineId), parseSessionStatus, { method: "POST", body: sessionBody(session) }),
  dismissWarning: (session: SessionLookup, dismissId: string, machineId = "local") => request(sessionPath(session, "warnings/dismiss", machineId), parseSessionStatus, { method: "POST", body: sessionBody(session, { dismissId }) }),
  modelPolicy: (session: SessionLookup, machineId = "local") => request(sessionQueryPath(session, "model-policy", machineId), parseSessionModelPolicyResponse),
  rememberCurrentModelPolicy: (session: SessionLookup, machineId = "local") => request(sessionQueryPath(session, "model-policy/remember", machineId), parseConfirmedStarterModelPolicyPreference, { method: "POST" }),
  setModelPolicy: (session: SessionLookup, policy: SessionModelPolicyUpdate, machineId = "local") => request(sessionPath(session, "model-policy", machineId), parseSessionModelPolicyResponse, { method: "PUT", body: sessionBody(session, { policy }) }),
  models: (session: SessionLookup, machineId = "local") => request(sessionQueryPath(session, "models", machineId), parseModelSelectionResponse),
  setModel: (session: SessionLookup, provider: string, modelId: string, machineId = "local") => request(sessionPath(session, "model", machineId), parseSessionStatus, { method: "POST", body: sessionBody(session, { provider, modelId }) }),
  cycleModel: (session: SessionLookup, direction: "forward" | "backward", machineId = "local") => request(sessionPath(session, "model/cycle", machineId), parseSessionStatus, { method: "POST", body: sessionBody(session, { direction }) }),
  thinkingLevels: (session: SessionLookup, machineId = "local") => request(sessionQueryPath(session, "thinking-levels", machineId), parseThinkingLevelsResponse),
  setThinkingLevel: (session: SessionLookup, level: string, machineId = "local") => request(sessionPath(session, "thinking-level", machineId), parseSessionStatus, { method: "POST", body: sessionBody(session, { level }) }),
  cycleThinkingLevel: (session: SessionLookup, machineId = "local") => request(sessionPath(session, "thinking-level/cycle", machineId), parseSessionStatus, { method: "POST", body: sessionBody(session) }),
  commands: (session: SessionLookup, machineId = "local") => request(sessionQueryPath(session, "commands", machineId), arrayOf(parseSlashCommand)),
  prompt: (session: SessionLookup, text: string, streamingBehavior?: "steer" | "followUp", machineId = "local", attachments?: PromptAttachment[]) => request(sessionPath(session, "prompt", machineId), parseAccepted, { method: "POST", body: sessionBody(session, { text, ...(streamingBehavior === undefined ? {} : { streamingBehavior }), ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}) }) }),
  saveAttachments: (session: SessionLookup, attachments: PromptAttachment[], machineId = "local", folder?: string) => request(sessionPath(session, "attachments", machineId), parseSavedAttachments, { method: "POST", body: sessionBody(session, { attachments, ...(folder === undefined ? {} : { folder }) }) }),
  shell: (session: SessionLookup, text: string, machineId = "local") => request(sessionPath(session, "shell", machineId), parseAccepted, { method: "POST", body: sessionBody(session, { text }) }),
  runCommand: (session: SessionLookup, text: string, machineId = "local") => request(sessionPath(session, "commands/run", machineId), parseCommandResult, { method: "POST", body: sessionBody(session, { text }) }),
  respondToCommand: (session: SessionLookup, requestId: string, value: string, machineId = "local") => request(sessionPath(session, "commands/respond", machineId), parseCommandResult, { method: "POST", body: sessionBody(session, { requestId, value }) }),
  navigateTree: (session: SessionLookup, navigation: SessionTreeNavigateRequest, machineId = "local") => request(sessionPath(session, "tree/navigate", machineId), parseSessionTreeNavigateResult, {
    method: "POST",
    body: sessionBody(session, { targetId: navigation.targetId, expectedLeafId: navigation.expectedLeafId, summary: navigation.summary }),
  }),
  editFromHere: (session: SessionLookup, entryId: string, machineId = "local") => request(sessionPath(session, "messages/edit-from-here", machineId), parseSessionTreeNavigateResult, {
    method: "POST",
    body: sessionBody(session, { entryId }),
  }),
  forkFromHere: (session: SessionLookup, entryId: string, machineId = "local") => request(sessionPath(session, "messages/fork", machineId), parseSessionMessageForkResult, {
    method: "POST",
    body: sessionBody(session, { entryId }),
  }),
  abort: (session: SessionLookup, machineId = "local") => request(sessionPath(session, "abort", machineId), parseAborted, { method: "POST", body: sessionBody(session) }),
  stop: (session: SessionLookup, machineId = "local") => request(sessionPath(session, "stop", machineId), parseStopped, { method: "POST", body: sessionBody(session) }),
  archive: (session: SessionLookup, machineId = "local") => request(sessionPath(session, "archive", machineId), parseArchived, { method: "POST", body: sessionBody(session) }),
  archiveWithDescendants: (session: SessionLookup, machineId = "local") => request(sessionPath(session, "archive-tree", machineId), parseArchived, { method: "POST", body: sessionBody(session) }),
  restore: (session: SessionLookup, machineId = "local") => request(sessionPath(session, "restore", machineId), parseRestored, { method: "POST", body: sessionBody(session) }),
  deleteArchived: (session: SessionLookup, machineId = "local") => request(sessionBaseQueryPath(session, machineId), parseDeleted, { method: "DELETE" }),
  detachParent: (session: SessionLookup, machineId = "local") => request(sessionPath(session, "detach-parent", machineId), parseDetached, { method: "POST", body: sessionBody(session) }),
  reloadSession: (session: SessionLookup, machineId = "local") => request(sessionPath(session, "reload", machineId), parseReloaded, { method: "POST", body: sessionBody(session) }),
  pin: (session: SessionLookup, machineId = "local") => request(sessionPath(session, "pin", machineId), parseSessionInfo, { method: "POST", body: sessionBody(session) }),
  unpin: (session: SessionLookup, machineId = "local") => request(sessionPath(session, "unpin", machineId), parseSessionInfo, { method: "POST", body: sessionBody(session) }),
  authProviders: (options?: { mode?: "login" | "logout"; authType?: "oauth" | "api_key"; machineId?: string }) => {
    const params = new URLSearchParams();
    if (options?.mode !== undefined) params.set("mode", options.mode);
    if (options?.authType !== undefined) params.set("authType", options.authType);
    const query = params.toString();
    return request(`${machinePrefix(options?.machineId)}/auth/providers${query === "" ? "" : `?${query}`}`, parseAuthProvidersResponse);
  },
  saveApiKey: (providerId: string, key: string, machineId = "local") => request(`${machinePrefix(machineId)}/auth/api-key`, parseAccepted, { method: "POST", body: JSON.stringify({ providerId, key }) }),
  startInteractiveApiKeyLogin: (providerId: string, machineId = "local") => request(`${machinePrefix(machineId)}/auth/api-key/interactive`, parseOAuthFlowState, { method: "POST", body: JSON.stringify({ providerId }) }),
  logoutProvider: (providerId: string, machineId = "local") => request(`${machinePrefix(machineId)}/auth/logout`, parseAccepted, { method: "POST", body: JSON.stringify({ providerId }) }),
  startOAuthLogin: (providerId: string, machineId = "local") => request(`${machinePrefix(machineId)}/auth/oauth`, parseOAuthFlowState, { method: "POST", body: JSON.stringify({ providerId }) }),
  oauthFlow: (flowId: string, machineId = "local") => request(`${machinePrefix(machineId)}/auth/oauth/${encodeURIComponent(flowId)}`, parseOAuthFlowState),
  respondOAuthFlow: (flowId: string, requestId: string, value: string, machineId = "local") => request(`${machinePrefix(machineId)}/auth/oauth/${encodeURIComponent(flowId)}/respond`, parseOAuthFlowState, { method: "POST", body: JSON.stringify({ requestId, value }) }),
  cancelOAuthFlow: (flowId: string, machineId = "local") => request(`${machinePrefix(machineId)}/auth/oauth/${encodeURIComponent(flowId)}/cancel`, parseOAuthFlowState, { method: "POST" }),
};

export const terminalsApi = {
  terminals: (projectId: string, workspaceId: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/terminals`, arrayOf(parseTerminalInfo)),
  startTerminal: (projectId: string, workspaceId: string, options?: { name?: string; cols?: number; rows?: number }, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/terminals`, parseTerminalInfo, { method: "POST", body: JSON.stringify(options ?? {}) }),
  closeWorkspaceTerminals: (projectId: string, workspaceId: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/terminals`, parseClosed, { method: "DELETE" }),
  closeTerminal: (projectId: string, workspaceId: string, terminalId: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/terminals/${encodeURIComponent(terminalId)}`, parseClosed, { method: "DELETE" }),
  continueTerminal: (projectId: string, workspaceId: string, terminalId: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/terminals/${encodeURIComponent(terminalId)}/continue`, parseTerminalInfo, { method: "POST" }),
  runTerminalCommand: (origin: string, input: RunTerminalCommandInput, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(input.workspace.projectId)}/workspaces/${encodeURIComponent(input.workspace.id)}/terminal-command-runs`, parseTerminalCommandRun, { method: "POST", body: JSON.stringify({ origin, title: input.title, command: input.command, metadata: input.metadata ?? {} }) }),
  listCommandRuns: (filter?: TerminalCommandRunFilter, machineId = "local") => request(`${machinePrefix(machineId)}/terminal-command-runs${terminalCommandRunFilterQuery(filter)}`, arrayOf(parseTerminalCommandRun)),
  getCommandRun: (runId: string, machineId = "local") => getOptionalTerminalCommandRun(runId, machineId),
  cancelCommandRun: (runId: string, machineId = "local") => request(`${machinePrefix(machineId)}/terminal-command-runs/${encodeURIComponent(runId)}/cancel`, parseTerminalCommandRun, { method: "POST" }),
};

async function getOptionalTerminalCommandRun(runId: string, machineId: string): Promise<TerminalCommandRun | undefined> {
  const response = await fetch(resolveAppUrl(`${machinePrefix(machineId)}/terminal-command-runs/${encodeURIComponent(runId)}`));
  if (response.status === 404) return undefined;
  if (!response.ok) {
    const body: unknown = await response.json().catch((): unknown => ({}));
    throw new Error(apiErrorMessage(body) ?? response.statusText);
  }
  return parseTerminalCommandRun(await response.json());
}

function terminalCommandRunFilterQuery(filter: TerminalCommandRunFilter | undefined): string {
  if (filter === undefined) return "";
  const params = new URLSearchParams();
  if (filter.projectId !== undefined) params.set("projectId", filter.projectId);
  if (filter.workspaceId !== undefined) params.set("workspaceId", filter.workspaceId);
  if (filter.terminalId !== undefined) params.set("terminalId", filter.terminalId);
  if (filter.statuses !== undefined && filter.statuses.length > 0) params.set("statuses", filter.statuses.join(","));
  if (filter.metadata !== undefined && Object.keys(filter.metadata).length > 0) params.set("metadata", JSON.stringify(filter.metadata));
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

function apiErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const error = value["error"];
  return typeof error === "string" ? error : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface FileSuggestionQueryOptions {
  kind?: FileSuggestion["kind"] | undefined;
  mode?: "file" | "path" | undefined;
  scope?: "tracked" | "all" | undefined;
  machineId?: string | undefined;
  projectId?: string | undefined;
  workspaceId?: string | undefined;
  workspaceScoped?: boolean | undefined;
}

export const filesApi = {
  files: (cwd: string, query: string, options: FileSuggestionQueryOptions = {}) => {
    const params = new URLSearchParams({ q: query });
    if (options.kind !== undefined) params.set("kind", options.kind);
    if (options.mode !== undefined) params.set("mode", options.mode);
    if (options.scope !== undefined) params.set("scope", options.scope);
    if (options.workspaceScoped === true && options.projectId !== undefined && options.workspaceId !== undefined) {
      return request(`${machinePrefix(options.machineId)}/projects/${encodeURIComponent(options.projectId)}/workspaces/${encodeURIComponent(options.workspaceId)}/files?${params.toString()}`, arrayOf(parseFileSuggestion));
    }
    params.set("cwd", cwd);
    return request(`${machinePrefix(options.machineId)}/files?${params.toString()}`, arrayOf(parseFileSuggestion));
  },
};

export const gitApi = {
  gitStatus: (projectId: string, workspaceId: string, machineId = "local") => request(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/git/status`, parseGitStatusResponse),
  gitDiff: (projectId: string, workspaceId: string, options?: { path?: string; staged?: boolean }, machineId = "local") => request(machineGitDiffPath(machineId, projectId, workspaceId, options), parseGitDiffResponse),
};

export const api = {
  ...piWebUiApi,
  ...machinesApi,
  ...memoryApi,
  ...modelTiersApi,
  ...configApi,
  ...pluginsApi,
  ...piPackagesApi,
  ...piPackagePluginsApi,
  ...activityApi,
  ...projectsApi,
  ...workspacesApi,
  ...sessionsApi,
  ...terminalsApi,
  ...filesApi,
  ...gitApi,
};
