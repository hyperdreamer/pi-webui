import type { ThinkingLevel } from "./thinkingLevels.js";

export type MachineKind = "local" | "remote";
export type MachineStatus = "unknown" | "online" | "offline" | "error";

export const PI_WEBUI_CAPABILITIES = {
  sessionsDeleteArchived: "sessions.deleteArchived",
  sessionsBulkMutations: "sessions.bulkMutations",
  sessionsCleanup: "sessions.cleanup",
  sessionsReload: "sessions.reload",
  sessionsClearQueue: "sessions.clearQueue",
  sessionsMessageActions: "sessions.messageActions",
  sessionsSystemPrompt: "sessions.systemPrompt",
  sessionsPersistedState: "sessions.persistedState",
  sessionsNotifications: "sessions.notifications",
  sessionsUnread: "sessions.unread",
  promptAttachments: "prompt.attachments",
  workspaceFileSuggestions: "workspace.fileSuggestions",
  piPackagesManage: "piPackages.manage",
  selectedMachineSettings: "settings.selectedMachine",
  agentProfileConfig: "settings.agentProfile",
  modelTierSettings: "settings.modelTiers",
  utilityModelSettings: "settings.utilityModels",
  sessionsModelPolicy: "sessions.modelPolicy",
  sessionsModelPolicyDefaults: "sessions.modelPolicyDefaults",
  sessionsModelPolicyStarterSelection: "sessions.modelPolicyStarterSelection",
  sessionsReorder: "sessions.reorder",
  projectUsageStatistics: "project.usageStatistics",
} as const;

export type PiWebUiCapability = typeof PI_WEBUI_CAPABILITIES[keyof typeof PI_WEBUI_CAPABILITIES];

export interface Machine {
  id: string;
  name: string;
  kind: MachineKind;
  baseUrl?: string;
  createdAt: string;
  updatedAt: string;
  status?: MachineStatus;
  statusMessage?: string;
}

export interface MachineHealth {
  machineId: string;
  ok: boolean;
  checkedAt: string;
  status?: MachineStatus;
  web?: PiWebUiComponentStatus;
  sessiond?: PiWebUiComponentStatus;
  error?: string;
}

export interface MachineRuntime {
  machineId: string;
  ok: boolean;
  checkedAt: string;
  packageName?: string;
  generatedAt?: string;
  components?: PiWebUiRuntimeResponse["components"];
  capabilities?: PiWebUiCapability[];
  error?: string;
}

export type PiWebUiShortcutConfig = Record<string, string | null>;
export type PiWebUiPluginSettings = Record<string, unknown>;
export type PiWebUiPluginConfigMap = Record<string, PiWebUiPluginConfig>;

export interface PiWebUiPluginConfig {
  enabled?: boolean;
  settings?: PiWebUiPluginSettings;
  [key: string]: unknown;
}

export interface PiWebUiPathAccessConfig {
  allowedPaths?: string[];
}

export interface PiWebUiUploadsConfig {
  defaultFolder?: string;
}

export const MODEL_TIERS = ["economy", "fast", "standard", "advanced", "capable", "frontier"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export interface TierModelRef {
  provider: string;
  id: string;
}

export const UTILITY_MODEL_SLOTS = ["lightweight", "context"] as const;
export type UtilityModelSlot = (typeof UTILITY_MODEL_SLOTS)[number];

export interface UtilityModelBinding extends TierModelRef {
  thinkingLevel?: ThinkingLevel;
}

export interface UtilityModelSettings {
  lightweight?: UtilityModelBinding;
  context?: UtilityModelBinding;
}

export type UtilityModelSettingsUpdate = Partial<
  Record<UtilityModelSlot, UtilityModelBinding | null>
>;

export interface UtilityModelOptionV1 {
  model: TierModelRef;
  name?: string;
}

export interface UtilityModelOptionV2 extends UtilityModelOptionV1 {
  thinkingLevels: ThinkingLevel[];
}

export type UtilityModelOption = UtilityModelOptionV1 | UtilityModelOptionV2;

export interface UtilityModelSlotValidation {
  valid: boolean;
  reason?: string;
}

interface UtilityModelSettingsResponseFields {
  settings: UtilityModelSettings;
  slots: Record<UtilityModelSlot, UtilityModelSlotValidation>;
  valid: boolean;
  configError?: string;
}

export interface UtilityModelSettingsResponseV1
  extends UtilityModelSettingsResponseFields {
  contractVersion: 1;
  models: UtilityModelOptionV1[];
}

export interface UtilityModelSettingsResponseV2
  extends UtilityModelSettingsResponseFields {
  contractVersion: 2;
  models: UtilityModelOptionV2[];
}

export type UtilityModelSettingsResponse =
  | UtilityModelSettingsResponseV1
  | UtilityModelSettingsResponseV2;

export interface ModelTierEntry {
  model: TierModelRef;
  thinkingLevel: string;
}

export type ModelTierLadder = Record<ModelTier, ModelTierEntry>;

export interface ModelTierModelOption {
  model: TierModelRef;
  name?: string;
  thinkingLevels: string[];
}

export interface ExactModelSelection {
  model: TierModelRef;
  thinkingLevel: string;
}

export type SessionModelPolicyMode = "exact" | "tiered";

/** Version-one shape: no `exact` branch, Pi settings own the starter Exact model and thinking defaults. */
export interface LegacyStarterModelPolicyPreference {
  mode: SessionModelPolicyMode;
  /** Remembered while Exact is active; required while Tiered is active. */
  tier?: ModelTier;
}

/** Complete remembered starter policy: active mode, remembered Exact tuple, and remembered tier. */
export interface StarterModelPolicyPreference {
  mode: SessionModelPolicyMode;
  /** Remembered while Tiered is active; required while Exact is active. */
  exact: ExactModelSelection;
  /** Remembered while Exact is active; required while Tiered is active. */
  tier?: ModelTier;
}

export type StarterModelPolicyPreferenceResponse =
  | StarterModelPolicyPreference
  | LegacyStarterModelPolicyPreference;

/** SessionCreationSource identifies a top-level root explicitly created by SESSIONS `+`. */
export type SessionCreationSource = "session-list-plus";

export type SessionStartOptions =
  | {
      modelPolicy?: SessionModelPolicyUpdate;
      creationSource?: never;
      initialModelPolicy?: never;
    }
  | {
      creationSource: SessionCreationSource;
      initialModelPolicy: StarterModelPolicyPreference;
      modelPolicy?: never;
    };

export interface SessionModelPolicy {
  mode: SessionModelPolicyMode;
  exact: ExactModelSelection;
  /** Remembered after the first Tiered choice, including while Exact is active. */
  tier?: ModelTier;
}

export type SessionModelPolicyUpdate =
  | { mode: "exact"; exact: ExactModelSelection }
  | { mode: "tiered"; tier: ModelTier };

export interface ClientSessionModelPolicyStatus {
  mode: SessionModelPolicyMode;
  tier?: ModelTier;
  /** The tuple last confirmed by the policy runtime adapter in this staged slice. */
  resolved: ExactModelSelection;
  ladderValid: boolean;
  blockedReason?: string;
}

export interface SessionModelPolicyResponse {
  contractVersion: 1;
  /** Omitted only when the newest persisted entry is malformed and requires repair. */
  policy?: SessionModelPolicy;
  session: SessionStatus;
}

export interface ModelTierRowValidation {
  valid: boolean;
  reason?: string;
}

export interface ModelTierSettingsResponse {
  contractVersion: 1;
  ladder?: ModelTierLadder;
  models: ModelTierModelOption[];
  rows: Record<ModelTier, ModelTierRowValidation>;
  valid: boolean;
  configError?: string;
}

export interface PiWebUiAgentConfig {
  /** Pi-compatible companion CLI used for diagnostics and safe package-managed updates. */
  command?: string;
  /** Pi-compatible profile directory containing auth.json, models.json, settings.json, and sessions/. */
  dir?: string;
}

export interface PiWebUiConfigValues {
  host?: string;
  port?: number;
  allowedHosts?: string[] | true;
  shortcuts?: PiWebUiShortcutConfig;
  plugins?: PiWebUiPluginConfigMap;
  /** External filesystem roots PI WEBUI may expose outside a workspace. */
  pathAccess?: PiWebUiPathAccessConfig;
  /** Workspace-relative defaults for manual file uploads. */
  uploads?: PiWebUiUploadsConfig;
  /** Maximum accepted HTTP request body size in bytes (uploads/attachments). */
  maxUploadBytes?: number;
  /** Machine-global exact model and thinking bindings for the six canonical tiers. */
  modelTiers?: ModelTierLadder;
  /** Machine-global model bindings for utility operations outside active sessions. */
  utilityModels?: UtilityModelSettings;
  /** When true, LLMs can start new sessions via the spawn_session tool. */
  spawnSessions?: boolean;
  /**
   * Beta: when true, LLMs can start tracked child sessions via the
   * spawn_subsession / list_subsessions / check_subsession / read_subsession
   * tools. Off by default
   * while the capability stabilizes. Requires spawnSessions to be enabled.
   */
  subsessions?: boolean;
  /** Desired Pi-compatible agent profile and companion CLI (Pi by default). */
  agent?: PiWebUiAgentConfig;
}

export type PiWebUiPluginScope = "bundled" | "local" | "user" | "project";

export interface PiWebUiPluginInfo {
  id: string;
  module: string;
  source: string;
  scope: PiWebUiPluginScope;
  machineSpecific: boolean;
  enabled: boolean;
}

export interface PiWebUiPluginsResponse {
  plugins: PiWebUiPluginInfo[];
}

export type PiPackageScope = "user" | "project";

export interface PiPackageInfo {
  source: string;
  scope: PiPackageScope;
  filtered: boolean;
  installedPath?: string;
}

export interface PiPackagesResponse {
  packages: PiPackageInfo[];
}

export interface PiPackageInstallRequest {
  source: string;
}

export interface PiPackageRemoveRequest {
  source: string;
  /** Optional known scope from a listed package; not an install-location picker. */
  scope?: PiPackageScope;
}

export interface PiPackageUpdateRequest {
  /** Omit to update all configured Pi packages. */
  source?: string;
}

export type PiPackageMutationAction = "install" | "remove" | "update";

export interface PiPackageMutationResponse extends PiPackagesResponse {
  action: PiPackageMutationAction;
  source?: string;
  scope?: PiPackageScope;
  removed?: boolean;
}

/** UI-facing scope labels for Pi packages resolved in a selected workspace. */
export type PiPackagePluginScope = "global" | "project";
export type PiPackagePluginResourceKind = "extension" | "skill" | "prompt" | "theme";
export type PiPackagePluginStatus = "loaded" | "installed" | "missing" | "disabled";
export type PiPackagePluginAction = "install" | "remove" | "update" | "disable" | "enable";

export interface PiPackagePluginResourceCounts {
  extensions: number;
  skills: number;
  prompts: number;
  themes: number;
}

export interface PiPackagePluginDiagnostic {
  type: "warning" | "error";
  message: string;
  source?: string;
  path?: string;
}

export interface PiPackagePluginResourceInfo {
  kind: PiPackagePluginResourceKind;
  name: string;
  path: string;
  relativePath: string;
}

/** A configured Pi package together with the resources it resolves for a workspace. */
export interface PiPackagePluginInfo {
  source: string;
  scope: PiPackagePluginScope;
  filtered: boolean;
  disabled: boolean;
  installedPath?: string;
  packageName?: string;
  version?: string;
  configuredVersion?: string;
  counts: PiPackagePluginResourceCounts;
  resources: PiPackagePluginResourceInfo[];
  status: PiPackagePluginStatus;
}

export interface PiPackagePluginsResponse {
  packages: PiPackagePluginInfo[];
  totals: PiPackagePluginResourceCounts;
  diagnostics: PiPackagePluginDiagnostic[];
}

export interface PiPackagePluginMutationRequest {
  action: PiPackagePluginAction;
  cwd: string;
  source?: string;
  scope?: PiPackagePluginScope;
}

/** A resource-loader skill visible to a project-scoped Pi runtime. */
export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: {
    source?: string;
    scope?: string;
  };
  install?: SkillInstallInfo;
}

export type SkillInstallScope = "global" | "project";

export interface SkillInstallInfo {
  package: string;
  scope: SkillInstallScope;
  source: string;
  sourceType?: string;
  skillsShUrl?: string;
  skillPath?: string;
  ref?: string;
  versionHash?: string;
  canCheckForUpdates: boolean;
}

export interface SkillSearchResult {
  package: string;
  installs: string;
  url: string;
}

export type SkillUpdateState = "up-to-date" | "update-available" | "unsupported" | "error";

export interface SkillUpdateResult {
  package: string;
  scope: SkillInstallScope;
  state: SkillUpdateState;
  currentVersion?: string;
  latestVersion?: string;
  message?: string;
}

export interface SkillsResponse {
  skills: SkillInfo[];
}

export interface SkillMutationResponse {
  success: true;
}

export interface SkillToggleRequest {
  cwd: string;
  filePath: string;
  disableModelInvocation: boolean;
}

export interface SkillInstallRequest {
  cwd: string;
  package: string;
  scope: SkillInstallScope;
}

export interface SkillCheckRequest {
  cwd: string;
  package?: string;
  scope?: SkillInstallScope;
}

export interface SkillUpdateRequest {
  cwd: string;
  package: string;
  scope: SkillInstallScope;
}

export interface SkillSearchRequest {
  query: string;
  limit?: number;
}

export interface SkillSearchResponse {
  results: SkillSearchResult[];
}

export interface SkillsCheckResponse {
  updates: SkillUpdateResult[];
}

export interface SkillUpdateResponse {
  success: true;
  skill?: SkillInfo;
  output?: string;
}

export type PiWebUiAgentDirEnvSource = "pi-webui" | "pi-compatibility";

export interface PiWebUiConfigEnvOverrides {
  host: boolean;
  port: boolean;
  allowedHosts: boolean;
  spawnSessions: boolean;
  subsessions: boolean;
  agentCommand: boolean;
  agentDir: boolean;
  /** The configured directory environment source, even when Pi compatibility is inactive for the desired command. */
  agentDirSource?: PiWebUiAgentDirEnvSource;
  agentSessionDir: boolean;
}

export interface PiWebUiConfigResponse {
  path: string;
  exists: boolean;
  config: PiWebUiConfigValues;
  effectiveConfig: PiWebUiConfigValues;
  /** Structural model-tier config errors are reportable without blocking Exact sessions. */
  modelTiersError?: string;
  envOverrides: PiWebUiConfigEnvOverrides;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  /** True when the user has pinned this project so it sorts above unpinned projects. */
  pinned?: boolean;
}

export interface ProjectUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  sessionCount: number;
}

export interface ProjectUsageResponse {
  projectPath: string;
  buckets: {
    live: ProjectUsageTotals;
    retired: ProjectUsageTotals;
    archived: ProjectUsageTotals;
  };
  total: ProjectUsageTotals;
  generatedAt: string;
}

export interface ProjectUsageRequest {
  projectPath: string;
  liveCwds: string[];
}

export type ProjectUsageCountRequest = ProjectUsageRequest;

export interface ProjectUsageCountResponse {
  sessionCount: number;
}

export interface WorkspaceEffectiveConfig {
  uploads?: PiWebUiUploadsConfig;
}

export interface Workspace {
  id: string;
  projectId: string;
  path: string;
  label: string;
  branch?: string;
  isMain: boolean;
  isGitRepo: boolean;
  isGitWorktree: boolean;
  /** Workspace-effective project/global settings needed by workspace UI features. */
  effectiveConfig?: WorkspaceEffectiveConfig;
}

export interface SessionRef {
  id: string;
  cwd: string;
}

/** Identifies the sibling group a persisted manual order position belongs to. */
export type SessionReorderScope =
  | { kind: "root"; cwd: string }
  | { kind: "children"; parentSessionPath: string };

export const SESSION_REORDER_LIMIT = 1_000;
export const SESSION_REORDER_SESSION_ID_MAX_LENGTH = 512;
export const SESSION_REORDER_CWD_MAX_LENGTH = 32 * 1024;
export const SESSION_REORDER_PARENT_PATH_MAX_LENGTH = 32 * 1024;

export interface SessionReorderRequest {
  cwd: string;
  scope: SessionReorderScope;
  pinned: boolean;
  catalogCwds: string[];
  orderedSessions: SessionRef[];
}

export interface SessionOrderEntry extends SessionRef {
  manualOrder: number;
}

export interface SessionReorderResponse {
  orderedSessions: SessionOrderEntry[];
}

export const SESSION_UNREAD_LIMIT = 1_000;
export const SESSION_UNREAD_SESSION_ID_MAX_LENGTH = 512;
export const SESSION_UNREAD_CWD_MAX_LENGTH = 32 * 1024;
export const SESSION_UNREAD_CATALOG_ID_MAX_LENGTH = 512;
export const SESSION_UNREAD_COMPLETED_AT_MAX_LENGTH = 64;

export interface SessionUnreadSummary {
  sessionId: string;
  cwd: string;
  /** Monotonic within a catalog and never greater than its containing revision. */
  completionOrder: number;
  completedAt: string;
}

export interface SessionUnreadCatalogSnapshot {
  /** Stable for one persisted catalog epoch; changes when unread state is reset. */
  catalogId: string;
  /** Monotonic catalog mutation revision; at least every contained completion order. */
  catalogRevision: number;
  /** Bounded by `SESSION_UNREAD_LIMIT` and ordered newest completion first. */
  sessions: SessionUnreadSummary[];
}

export interface SessionUnreadAcknowledgeRequest {
  cwd: string;
  /** The catalog epoch in which `throughCompletionOrder` was observed. */
  catalogId: string;
  throughCompletionOrder: number;
}

/** Authoritative delta for one session in the daemon-owned unread catalog. */
export interface SessionUnreadEvent {
  type: "sessions.unread";
  catalogId: string;
  /** At least `unread.completionOrder` when carrying an unread summary. */
  catalogRevision: number;
  sessionId: string;
  cwd: string;
  unread: SessionUnreadSummary | null;
}

export const SESSION_NOTIFICATION_LIMIT = 100;
export const SESSION_NOTIFICATION_MESSAGE_BYTES = 8 * 1024;

export type SessionNotificationSeverity = "info" | "warning" | "error";

export interface SessionNotification {
  id: string;
  message: string;
  truncated: boolean;
  severity: SessionNotificationSeverity;
  receivedAt: string;
  order: number;
}

export interface SessionNotificationSummary {
  sessionId: string;
  cwd: string;
  inboxRevision: number;
  retainedCount: number;
  discardedCount: number;
  highestSeverity?: SessionNotificationSeverity;
}

export interface SessionNotificationDismissThrough {
  order: number;
  overflowWatermark: number;
}

export interface SessionNotificationInboxSnapshot {
  daemonInstanceId: string;
  catalogRevision: number;
  summary: SessionNotificationSummary;
  notifications: SessionNotification[];
  dismissThrough: SessionNotificationDismissThrough;
}

export interface SessionNotificationCatalogSnapshot {
  daemonInstanceId: string;
  catalogRevision: number;
  sessions: SessionNotificationSummary[];
}

export interface SessionNotificationDismissRequest {
  cwd: string;
  daemonInstanceId: string;
  notificationId: string;
}

export interface SessionNotificationDismissAllRequest {
  cwd: string;
  daemonInstanceId: string;
  throughOrder: number;
  throughOverflowWatermark: number;
}

export type SessionNotificationClearReason =
  | "runtime-close"
  | "archive"
  | "delete"
  | "restore"
  | "archive-reconcile"
  | "replacement"
  | "initialization-failed"
  | "service-dispose";

export type SessionNotificationInboxDelta =
  | { kind: "added"; notification: SessionNotification; evictedNotificationId?: string }
  | { kind: "dismissed"; notificationIds: string[] }
  | { kind: "cleared"; reason: SessionNotificationClearReason }
  | { kind: "resync" };

export interface SessionNotificationInboxEvent {
  type: "notifications.inbox";
  daemonInstanceId: string;
  catalogRevision: number;
  summary: SessionNotificationSummary;
  dismissThrough: SessionNotificationDismissThrough;
  delta: SessionNotificationInboxDelta;
}

export interface SessionNotificationSummaryEvent {
  type: "notifications.summary";
  daemonInstanceId: string;
  catalogRevision: number;
  summary: SessionNotificationSummary;
}

export interface SessionInfo extends SessionRef {
  path: string;
  /** True when the server has verified a backing session file exists; false when known transient. */
  persisted?: boolean;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  parentSessionPath?: string;
  archived?: boolean;
  archivedAt?: string;
  /** True when the user has pinned this session so it sorts first in lists. */
  pinned?: boolean;
  /** Present only for a top-level root explicitly created by SESSIONS `+`. */
  creationSource?: SessionCreationSource;
  /** Normalized durable position inside this session's sibling and pin group. */
  manualOrder?: number;
}

export interface ArchiveSessionsResponse {
  archived: true;
  sessionIds?: string[];
  archivedCount?: number;
  skippedAlreadyArchivedCount?: number;
}

export interface SessionBulkMutationRef {
  id: string;
  cwd?: string;
}

export interface SessionBulkMutationRequest {
  sessions: SessionBulkMutationRef[];
}

export interface SessionBulkFailure {
  sessionId: string;
  error: string;
}

export interface SessionBulkArchiveResponse {
  archived: true;
  archivedSessionIds: string[];
  failures: SessionBulkFailure[];
  generatedAt: string;
}

export interface SessionBulkDeleteArchivedResponse {
  deleted: true;
  deletedSessionIds: string[];
  failures: SessionBulkFailure[];
  generatedAt: string;
}

export interface SessionCleanupRequest {
  /** Archive non-archived sessions whose modified time is older than this many days. Omit/null to disable. */
  archiveIdleDays?: number | null;
  /** Permanently delete archived sessions whose archivedAt time is older than this many days. Omit/null to disable. */
  deleteArchivedDays?: number | null;
  /** Stored cwd paths selected from a preview. Omit/null to include all discovered project/workspace paths. */
  projectCwds?: string[] | null;
}

export interface SessionCleanupThresholds {
  archiveIdleDays?: number;
  deleteArchivedDays?: number;
}

export interface SessionCleanupProjectSummary {
  cwd: string;
  archiveCount: number;
  deleteCount: number;
}

export interface SessionCleanupTotals {
  archiveCount: number;
  deleteCount: number;
}

export interface SessionCleanupPreviewResponse {
  generatedAt: string;
  thresholds: SessionCleanupThresholds;
  projects: SessionCleanupProjectSummary[];
  totals: SessionCleanupTotals;
  skippedBusySessionIds?: string[];
}

export interface SessionCleanupExecuteResponse extends SessionCleanupPreviewResponse {
  archivedSessionIds: string[];
  deletedSessionIds: string[];
}

export interface SessionActivity {
  sessionId: string;
  phase: "active" | "idle" | "error";
  label: string;
  detail?: string;
  at: string;
}

export interface QueuedSessionMessage {
  kind: "steer" | "followUp";
  text: string;
}

/**
 * A pi-native image attachment carried with a prompt. The wire format mirrors
 * pi's own `ImageContent` shape (`{ type: "image", data, mimeType }`) so these
 * attachments are compatible with native multimodal delivery after validation.
 */
export interface PromptImageAttachment {
  kind: "image";
  /** Supported image MIME type (image/png, image/jpeg, image/gif, or image/webp). */
  mimeType: string;
  /** Base64-encoded binary payload (no data: URL prefix). */
  data: string;
  /** Optional original filename, used for previews and folder-mode filenames. */
  name?: string;
}

/** A general file attachment that must be saved into the workspace before use. */
export interface PromptFileAttachment {
  kind: "file";
  /** Non-empty IANA MIME type (for example "application/pdf"). */
  mimeType: string;
  /** Base64-encoded binary payload (no data: URL prefix). Empty for zero-byte files. */
  data: string;
  /** Optional original filename, used for previews and folder-mode filenames. */
  name?: string;
}

export type PromptAttachment = PromptImageAttachment | PromptFileAttachment;

/**
 * How prompt attachments should be delivered to the session.
 * - "inline": send the binary to pi as native image content (multimodal input).
 * - "folder": save the file into the workspace and reference it from the prompt
 *   text so the agent reads it with its own tools.
 */
export type PromptAttachmentDelivery = "inline" | "folder";

export interface SavedPromptAttachment {
  /** Workspace-relative path the attachment was written to. */
  path: string;
  mimeType: string;
  size: number;
}

export interface SessionModel {
  provider?: string;
  id?: string;
  name?: string;
  contextWindow?: number;
  reasoning?: unknown;
}

// Domain type is owned by pi and re-exported from the shared thinking-levels
// module. Wire/data fields below intentionally use `string` so an unknown level
// from a newer pi runtime parses and renders gracefully instead of failing.
export type { ThinkingLevel } from "./thinkingLevels.js";

export type AuthType = "oauth" | "api_key";
export type AuthStatusSource = "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";

export interface AuthProviderStatus {
  configured: boolean;
  source?: AuthStatusSource;
  label?: string;
}

export interface AuthProviderOption {
  id: string;
  name: string;
  authType: AuthType;
  status: AuthProviderStatus;
  /** Additive hint: use the generic AuthInteraction transport instead of the legacy one-secret form. */
  loginFlow?: "interactive";
}

export interface AuthProvidersResponse {
  providers: AuthProviderOption[];
}

export interface OAuthFlowState {
  flowId: string;
  providerId: string;
  providerName: string;
  status: "running" | "complete" | "error" | "cancelled";
  auth?: {
    url: string;
    instructions?: string;
    deviceCode?: { userCode: string; intervalSeconds?: number; expiresInSeconds?: number };
  };
  prompt?: {
    requestId: string;
    message: string;
    placeholder?: string;
    allowEmpty?: boolean;
    /** Additive semantic detail; legacy peers continue to use `kind`. */
    promptType?: "text" | "secret" | "manual_code";
    kind: "prompt" | "manual";
  };
  select?: { requestId: string; message: string; options: CommandOption[] };
  progress: string[];
  info?: { message: string; links?: { url: string; label?: string }[] }[];
  error?: string;
}

export interface ModelSelectionResponse {
  models: SessionModel[];
}

/** Pi's persisted defaults used when a new session is created. */
export interface SessionDefaultsResponse {
  model?: SessionModel;
  thinkingLevel: string;
  models: SessionModel[];
  thinkingLevels: string[];
  starterModelPolicyPreference?: LegacyStarterModelPolicyPreference;
  starterModelPolicyPreferenceError?: string;
}

/** Negotiated through `starterModelPolicyContract=2` once `sessions.modelPolicyStarterSelection` is effective. */
export interface SessionDefaultsV2Response {
  starterModelPolicyContractVersion: 2;
  model?: SessionModel;
  thinkingLevel: string;
  models: SessionModel[];
  thinkingLevels: string[];
  starterModelPolicyPreference?: StarterModelPolicyPreferenceResponse;
  starterModelPolicyPreferenceError?: string;
}

export type SessionDefaultsUpdate =
  | {
      model: { provider: string; modelId: string };
      thinkingLevel?: string;
      starterModelPolicyPreference?: never;
    }
  | {
      model?: { provider: string; modelId: string };
      thinkingLevel: string;
      starterModelPolicyPreference?: never;
    }
  | {
      model?: never;
      thinkingLevel?: never;
      starterModelPolicyPreference: LegacyStarterModelPolicyPreference;
    };

/** Editable `models.json` document for the active Pi-compatible profile. */
export interface ModelsConfigDocument {
  providers?: Record<string, ModelsConfigProvider> | undefined;
  [key: string]: unknown;
}

/**
 * Editable provider configuration. `undefined` means remove the field when
 * serializing the user's models.json draft.
 */
export interface ModelsConfigProvider {
  /** Preserve provider-specific Pi fields that PI WEBUI does not edit directly. */
  [key: string]: unknown;
  baseUrl?: string | undefined;
  api?: string | undefined;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  compat?: Record<string, unknown> | undefined;
  models?: ModelsConfigModel[] | undefined;
  modelOverrides?: Record<string, unknown> | undefined;
}

export interface ModelsConfigModel {
  /** Preserve model-specific Pi fields that PI WEBUI does not edit directly. */
  [key: string]: unknown;
  id: string;
  name?: string | undefined;
  api?: string | undefined;
  reasoning?: boolean | undefined;
  thinkingLevelMap?: Record<string, string | null> | undefined;
  input?: string[] | undefined;
  contextWindow?: number | undefined;
  maxTokens?: number | undefined;
  cost?: { input?: number | undefined; output?: number | undefined; cacheRead?: number | undefined; cacheWrite?: number | undefined } | undefined;
  compat?: Record<string, unknown> | undefined;
}

export interface ModelsConfigSaveResponse {
  success: true;
}

export interface ModelConnectionTestRequest {
  providerName: string;
  provider: ModelsConfigProvider;
  model: ModelsConfigModel;
}

/** A provider model returned by its model-list endpoint. */
export interface ModelDiscoveryModel {
  id: string;
  name?: string | undefined;
}

/** Uses the provider draft so discovery can run before the configuration is saved. */
export interface ModelDiscoveryRequest {
  providerName: string;
  provider: ModelsConfigProvider;
}

export interface ModelDiscoveryResponse {
  models: ModelDiscoveryModel[];
}

export interface ModelConnectionTestResponse {
  ok: boolean;
  error?: string;
  latencyMs?: number;
  status?: number;
  responseText?: string;
}

export interface ThinkingLevelsResponse {
  levels: string[];
}

export type SessionWarningSeverity = "info" | "warning" | "error";

/**
 * A live, runtime-scoped warning surfaced to the browser (skill/resource
 * diagnostics, extension load errors, subscription-auth billing notice, etc.).
 *
 * Warnings are recomputed whenever the runtime is (re)built inside sessiond and
 * are not persisted chat messages. `source` is an optional short origin label
 * (e.g. `"skill"`, `"extension"`, `"anthropic"`); `path` carries a related file
 * path when the warning came from a resource diagnostic.
 *
 * `dismiss` is present only when the warning has a durable, first-class
 * off-switch in the underlying `pi` agent (not a UI-only hide). Its `id` is the
 * opaque token the server maps back to that suppression; the client renders a
 * dismiss control for any warning carrying it, without knowing what it means.
 */
export interface SessionWarning {
  severity: SessionWarningSeverity;
  message: string;
  source?: string;
  path?: string;
  dismiss?: { id: string };
}

export interface SessionStatus {
  sessionId: string;
  /** True when the server has verified a backing session file exists; false when known transient. */
  persisted?: boolean;
  model?: SessionModel;
  thinkingLevel?: string;
  modelPolicy?: ClientSessionModelPolicyStatus;
  isStreaming: boolean;
  isCompacting: boolean;
  isBashRunning: boolean;
  pendingMessageCount: number;
  queuedMessages: QueuedSessionMessage[];
  messageCount?: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  /**
   * Current assistant-response output usage. Provider-reported values take
   * precedence; `estimated` marks Pi Web-style streamed-content approximations.
   * Omitted once the response ends.
   */
  generation?: { outputTokens: number; tokensPerSecond?: number; estimated?: boolean };
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  /**
   * Live, runtime-scoped warnings for this session (skill/resource diagnostics,
   * extension load errors, Anthropic subscription-auth billing notice, etc.).
   * Recomputed on each status read from the current runtime; absent/empty when
   * there are none. See {@link SessionWarning}.
   */
  warnings?: SessionWarning[];
}

export interface WorkspaceActivity {
  cwd: string;
  hasSessionActivity: boolean;
  hasTerminalActivity: boolean;
  updatedAt: string;
}

export interface WorkspaceActivityResponse {
  workspaces: WorkspaceActivity[];
  generatedAt: string;
}

export interface SlashCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill" | "builtin";
}

export interface FileSuggestion {
  path: string;
  kind: "tracked" | "untracked" | "other";
}

export interface FileTreeEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size?: number;
  modifiedAt?: string;
}

export interface FileTreeResponse {
  path: string;
  entries: FileTreeEntry[];
  scannedAt: string;
  truncated: boolean;
}

export type FileContentMediaType = "image";

export interface FileContentResponse {
  path: string;
  language?: string;
  mediaType?: FileContentMediaType;
  mimeType?: string;
  encoding: "utf8";
  size: number;
  modifiedAt: string;
  content: string;
  truncated: boolean;
  binary: boolean;
}

export interface WriteWorkspaceFileOptions {
  createDirs?: boolean;     // default: true — mkdir -p equivalent
  overwrite?: boolean;      // default: true — throw if false and file exists
}

export interface WriteWorkspaceFileResponse {
  path: string;
  size: number;
  modifiedAt: string;
  created: boolean;  // true if file was created, false if overwritten
}

export interface DeleteWorkspaceFileResponse {
  path: string;
  existed: boolean;  // true if file existed and was deleted, false if file did not exist
}

export interface MoveWorkspaceFileOptions {
  createDirs?: boolean;   // default: true — mkdir -p equivalent for target parent directory
  overwrite?: boolean;    // default: false — throw if target exists (safer default than writeFile)
}

export interface MoveWorkspaceFileResponse {
  fromPath: string;
  toPath: string;
  size: number;
  modifiedAt: string;
}

export type GitFileState = "unmodified" | "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "ignored" | "conflicted";

export interface GitStatusFile {
  path: string;
  oldPath?: string;
  index: GitFileState;
  workingTree: GitFileState;
}

export interface GitStatusResponse {
  isGitRepo: boolean;
  hash: string;
  branch?: string;
  latestTag?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  files: GitStatusFile[];
}

export interface GitDiffResponse {
  path?: string;
  staged: boolean;
  hash: string;
  diff: string;
  truncated: boolean;
}

export interface TerminalInfo {
  id: string;
  cwd: string;
  name: string;
  createdAt: string;
  exited: boolean;
  exitCode?: number;
  commandRunId?: string;
}

export type TerminalCommandRunStatus = "queued" | "running" | "succeeded" | "failed";

export interface TerminalCommandRun {
  id: string;
  origin: string;
  projectId: string;
  workspaceId: string;
  terminalId: string;
  title: string;
  command: string;
  status: TerminalCommandRunStatus;
  exitCode?: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  metadata: Record<string, string>;
}

export interface RunTerminalCommandInput {
  workspace: Workspace;
  title: string;
  command: string;
  metadata?: Record<string, string>;
  open?: boolean;
}

export interface TerminalCommandRunHandle {
  run: TerminalCommandRun;
  completed: Promise<TerminalCommandRun>;
}

export interface TerminalCommandRunFilter {
  projectId?: string;
  workspaceId?: string;
  terminalId?: string;
  statuses?: TerminalCommandRunStatus[];
  metadata?: Record<string, string>;
}

export type PiWebUiServiceComponent = "web" | "sessiond";
export type PiWebUiStatusSeverity = "info" | "warning" | "error";
export type PiWebUiInstallationKind = "pi-package" | "npm-global" | "local" | "docker" | "unknown";
export type PiWebUiDockerMode = "runtime" | "dev";

export interface PiWebUiInstallationInfo {
  kind: PiWebUiInstallationKind;
  path?: string;
  source?: string;
  scope?: "user" | "project";
  npmRoot?: string;
  dockerMode?: PiWebUiDockerMode;
}

export interface PiWebUiComponentStatus {
  component: PiWebUiServiceComponent;
  label: string;
  runtimeVersion?: string;
  installedVersion?: string;
  stale: boolean;
  available: boolean;
  installation?: PiWebUiInstallationInfo;
  error?: string;
}

/** Secret-free identity of the Pi-compatible CLI/state profile fixed for one sessiond lifetime. */
export interface ActiveAgentProfileDescriptor {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly command: string;
  readonly dir: string;
  readonly sessionDirEnvKeys: readonly string[];
}

export interface PiWebUiRuntimeComponent {
  component: PiWebUiServiceComponent;
  label: string;
  runtimeVersion?: string;
  available: boolean;
  capabilities: PiWebUiCapability[];
  /** Present only for a session daemon that supports active-profile reporting. */
  activeAgentProfile?: ActiveAgentProfileDescriptor;
  error?: string;
}

export interface PiWebUiReleaseStatus {
  packageName: string;
  latestVersion?: string;
  updateAvailable: boolean;
  checkedAt?: string;
  skipped?: boolean;
  error?: string;
}

export interface PiWebUiStatusMessage {
  id: string;
  severity: PiWebUiStatusSeverity;
  title: string;
  body: string;
  command?: string;
}

export interface PiWebUiVersionResponse {
  packageName: string;
  generatedAt: string;
  components: {
    web: PiWebUiComponentStatus;
    sessiond: PiWebUiComponentStatus;
  };
}

export interface PiWebUiRuntimeResponse {
  packageName: string;
  generatedAt: string;
  components: {
    web: PiWebUiRuntimeComponent;
    sessiond: PiWebUiRuntimeComponent;
  };
  capabilities: PiWebUiCapability[];
}

export interface PiWebUiStatusResponse extends PiWebUiVersionResponse {
  release: PiWebUiReleaseStatus;
  commands: {
    update?: string;
    restart?: string;
    restartWeb?: string;
    restartSessiond?: string;
    status?: string;
  };
  messages: PiWebUiStatusMessage[];
}

export type TerminalUiEvent =
  | { type: "terminal.created"; terminal: TerminalInfo }
  | { type: "terminal.exited"; terminal: TerminalInfo }
  | { type: "terminal.closed"; terminalId: string; cwd: string };

export interface WorkspaceActivityUiEvent {
  type: "workspace.activity";
  activity: WorkspaceActivity;
}

export interface CommandOption {
  value: string;
  label: string;
  description?: string;
  /** When set, options with the same group are rendered together under a group header. */
  group?: string;
}

export type SessionTreeNodeKind =
  | "user"
  | "assistant"
  | "tool-result"
  | "bash"
  | "custom-message"
  | "compaction"
  | "branch-summary"
  | "model-change"
  | "thinking-level-change"
  | "session-info"
  | "label"
  | "custom"
  | "other";

export interface SessionTreeNode {
  id: string;
  parentId: string | null;
  kind: SessionTreeNodeKind;
  summary: string;
  timestamp?: string;
  label?: string;
}

export interface SessionTreeSnapshot {
  /** Pre-order, parent-linked projection of all retained roots and descendants. */
  nodes: SessionTreeNode[];
  activeLeafId: string | null;
  /** Root-to-leaf IDs for explicit, non-color-only active-path rendering. */
  activePathIds: string[];
}

export const SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH = 10_000;

export type SessionTreeSummaryChoice =
  | { mode: "none" }
  | { mode: "default" }
  | { mode: "custom"; instructions: string };

export interface SessionTreeNavigateRequest {
  targetId: string;
  /** Leaf shown when the navigator opened; null is valid for an empty/root position. */
  expectedLeafId: string | null;
  summary: SessionTreeSummaryChoice;
}

export type SessionTreeNavigateResult =
  | { cancelled: false; editorText?: string }
  | { cancelled: true; aborted?: boolean };

/** Result of creating an independent session from a user-message history entry. */
export type SessionMessageForkResult =
  | { cancelled: false; session: SessionInfo }
  | { cancelled: true };

export interface MessagePage {
  messages: unknown[];
  start: number;
  total: number;
}

/**
 * Join-time snapshot of a session's in-flight assistant stream. `seq` is the
 * `SessionEventHub` watermark captured together with `partial` in a single tick,
 * so a joining client can seed `partial` and then apply only buffered live events
 * with `seq > snapshot.seq` (exactly-once). `partial` is a browser-projected
 * in-flight `AssistantMessage` (thinking signatures stripped), or `null` when the
 * session is not mid assistant-message stream.
 */
export interface SessionStreamSnapshot {
  seq: number;
  /** Browser-projected in-flight `AssistantMessage`, or `null` when idle. */
  partial: unknown;
}

/**
 * Current resolved system prompt for one session. It is omitted when the
 * runtime has not loaded a prompt yet, preserving the distinction between an
 * unavailable prompt and an intentionally empty one.
 */
export interface SessionSystemPrompt {
  systemPrompt?: string;
}

export type CommandResult =
  | { type: "done"; message?: string; session?: SessionInfo; promptDraft?: string }
  | { type: "select"; requestId: string; title: string; options: CommandOption[] }
  | { type: "tree"; tree: SessionTreeSnapshot }
  | { type: "unsupported"; message: string };

/**
 * Transport-level per-session sequence stamp. `SessionEventHub.publish` assigns a
 * monotonic `seq` to every per-session event as it is serialized to the socket.
 * Clients use it as a watermark against the join-time stream snapshot so buffered
 * live events are applied exactly once. Existing consumers may ignore it.
 */
export type SessionUiEvent = SessionUiEventBody & { seq?: number };

type SessionUiEventBody =
  | { type: "message.append"; message: unknown }
  | { type: "assistant.delta"; text: string }
  | { type: "assistant.thinking.delta"; text: string }
  | { type: "tool.start"; toolName: string; toolCallId: string; summary: string; args?: unknown }
  | { type: "tool.update"; toolName: string; toolCallId: string; text: string; content?: unknown; details?: unknown }
  | { type: "tool.end"; toolName: string; toolCallId: string; text: string; isError: boolean; content?: unknown; details?: unknown }
  | { type: "shell.start"; command: string; excludeFromContext?: boolean }
  | { type: "shell.chunk"; chunk: string }
  | { type: "shell.end"; output?: string; exitCode?: number | null; cancelled?: boolean; truncated?: boolean; fullOutputPath?: string; isError?: boolean }
  | { type: "agent.start" }
  | { type: "agent.end" }
  | { type: "message.end"; message?: unknown }
  | { type: "status.update"; status: SessionStatus }
  | { type: "activity.update"; activity: SessionActivity }
  | { type: "command.output"; level: "info" | "success" | "error"; message: string; notificationId?: string }
  | SessionNotificationInboxEvent
  | { type: "session.error"; message: string }
  | { type: "session.name"; sessionId: string; name?: string }
  | { type: "session.created"; session: SessionInfo }
  | { type: "pi.event"; eventType: string };

export type GlobalSessionEvent =
  | Extract<SessionUiEventBody, { type: "status.update" | "activity.update" | "session.name" | "session.created" }>
  | SessionNotificationSummaryEvent
  | SessionUnreadEvent;
export type RealtimeEvent = GlobalSessionEvent | TerminalUiEvent | WorkspaceActivityUiEvent;

export interface SystemCpuInfo {
  model: string;
  cores: number;
  usagePercent: number;
}

export interface SystemGpuInfo {
  name: string;
  driverVersion?: string;
  memoryTotalBytes?: number;
  memoryUsedBytes?: number;
  utilizationPercent?: number;
  temperatureCelsius?: number;
}

export interface SystemMemoryInfo {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usagePercent: number;
}

export interface SystemNetworkMetrics {
  downloadSpeedBytesPerSecond?: number;
  uploadSpeedBytesPerSecond?: number;
}

export interface SystemNetworkInfo extends SystemNetworkMetrics {
  hostname: string;
  publicIpv4?: string;
  publicIpv6?: string;
  localIpv4Addresses: string[];
}

export interface SystemOsInfo {
  platform: string;
  release: string;
  arch: string;
  uptimeSeconds: number;
}

export interface SystemMetricsResponse {
  generatedAt: string;
  memory: SystemMemoryInfo;
  network: SystemNetworkMetrics;
}

export interface MemoryEntry {
  id: string;
  content: string;
  category?: string;
  created?: string;
  last?: string;
  failureReason?: string;
}

export type MemorySnapshotResponse =
  | { kind: "unavailable" }
  | {
      kind: "data";
      globalEntries: MemoryEntry[];
      projectEntries: MemoryEntry[];
      projectUnavailableMessage?: string;
    };

export interface MemoryEntriesResponse {
  entries: MemoryEntry[];
}

export interface SystemInfoResponse {
  generatedAt: string;
  os: SystemOsInfo;
  cpu: SystemCpuInfo;
  gpu?: SystemGpuInfo;
  memory: SystemMemoryInfo;
  network: SystemNetworkInfo;
  piVersion?: string;
  piWebUiVersion?: string;
}
