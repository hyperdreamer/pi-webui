import { SESSION_NOTIFICATION_LIMIT, SESSION_NOTIFICATION_MESSAGE_BYTES, SESSION_UNREAD_CATALOG_ID_MAX_LENGTH, SESSION_UNREAD_COMPLETED_AT_MAX_LENGTH, SESSION_UNREAD_CWD_MAX_LENGTH, SESSION_UNREAD_LIMIT, SESSION_UNREAD_SESSION_ID_MAX_LENGTH, type ArchiveSessionsResponse, type AuthProviderOption, type AuthProviderStatus, type AuthProvidersResponse, type AuthStatusSource, type AuthType, type CommandOption, type CommandResult, type DeleteWorkspaceFileResponse, type FileContentResponse, type FileSuggestion, type FileTreeEntry, type FileTreeResponse, type GitDiffResponse, type GitFileState, type GitStatusFile, type GitStatusResponse, type Machine, type MachineHealth, type MachineKind, type MachineRuntime, type MachineStatus, type MessagePage, type ModelConnectionTestResponse, type ModelDiscoveryModel, type ModelDiscoveryResponse, type ModelSelectionResponse, type ModelsConfigDocument, type ModelsConfigModel, type ModelsConfigProvider, type ModelsConfigSaveResponse, type MoveWorkspaceFileResponse, type OAuthFlowState, type PiWebUiAgentDirEnvSource, type PiWebUiCapability, type PiWebUiComponentStatus, type PiWebUiConfigEnvOverrides, type PiWebUiConfigResponse, type PiWebUiConfigValues, type PiWebUiInstallationInfo, type PiWebUiPluginConfigMap, type PiWebUiPluginInfo, type PiWebUiPluginsResponse, type PiWebUiPluginScope, type PiWebUiReleaseStatus, type PiWebUiRuntimeComponent, type PiWebUiRuntimeResponse, type PiWebUiServiceComponent, type PiWebUiShortcutConfig, type PiWebUiStatusMessage, type PiWebUiStatusResponse, type PiWebUiStatusSeverity, type Project, type ProjectUsageResponse, type ProjectUsageTotals, type QueuedSessionMessage, type SavedPromptAttachment, type SessionBulkArchiveResponse, type SessionBulkDeleteArchivedResponse, type SessionBulkFailure, type SessionCleanupExecuteResponse, type SessionCleanupPreviewResponse, type SessionCleanupProjectSummary, type SessionCleanupThresholds, type SessionCleanupTotals, type SessionInfo, type SessionModel, type SessionNotification, type SessionNotificationClearReason, type SessionNotificationDismissThrough, type SessionNotificationInboxDelta, type SessionNotificationInboxEvent, type SessionNotificationInboxSnapshot, type SessionNotificationSeverity, type SessionNotificationSummary, type SessionStatus, type SessionStreamSnapshot, type SessionSystemPrompt, type SessionUnreadCatalogSnapshot, type SessionUnreadEvent, type SessionUnreadSummary, type SessionWarning, type SessionWarningSeverity, type SlashCommand, type TerminalCommandRun, type TerminalCommandRunStatus, type TerminalInfo, type ThinkingLevelsResponse, type WriteWorkspaceFileResponse, type Workspace, type WorkspaceActivity, type WorkspaceActivityResponse } from "../../../shared/apiTypes";
import type { PiPackageInfo, PiPackageMutationAction, PiPackageMutationResponse, PiPackagePluginDiagnostic, PiPackagePluginInfo, PiPackagePluginResourceCounts, PiPackagePluginResourceInfo, PiPackagePluginResourceKind, PiPackagePluginScope, PiPackagePluginStatus, PiPackageScope, PiPackagePluginsResponse, PiPackagesResponse, SessionMessageForkResult, SessionTreeNavigateResult, SessionTreeNode, SessionTreeNodeKind, SessionTreeSnapshot, SystemInfoResponse, SystemMetricsResponse, SystemNetworkMetrics } from "../../../shared/apiTypes";
import type { LegacyStarterModelPolicyPreference, SessionDefaultsResponse, SessionDefaultsV2Response, StarterModelPolicyPreference, StarterModelPolicyPreferenceResponse } from "../../../shared/apiTypes";
import type { SessionOrderEntry, SessionReorderResponse } from "../../../shared/apiTypes";
import type { ClientSessionModelPolicyStatus, ExactModelSelection, SessionModelPolicy, SessionModelPolicyResponse } from "../../../shared/apiTypes";
import type { MemoryEntry, MemorySnapshotResponse } from "../../../shared/apiTypes";
import type { SkillInfo, SkillInstallInfo, SkillInstallScope, SkillMutationResponse, SkillSearchResponse, SkillsCheckResponse, SkillsResponse, SkillUpdateResponse, SkillUpdateResult, SkillUpdateState } from "../../../shared/apiTypes";
import { MODEL_TIERS, UTILITY_MODEL_SLOTS } from "../../../shared/apiTypes";
import type { ModelTier, ModelTierEntry, ModelTierLadder, ModelTierModelOption, ModelTierRowValidation, ModelTierSettingsResponse, TierModelRef, UtilityModelBinding, UtilityModelOptionV1, UtilityModelOptionV2, UtilityModelSettings, UtilityModelSettingsResponse, UtilityModelSettingsResponseV1, UtilityModelSettingsResponseV2, UtilityModelSlot, UtilityModelSlotValidation } from "../../../shared/apiTypes";
import { parseActiveAgentProfileDescriptor } from "../../../shared/activeAgentProfile";
import { parseKnownPiWebUiCapabilities } from "../../../shared/capabilities";
import { isKnownThinkingLevel } from "../../../shared/thinkingLevels";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected object response");
  return value;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`Expected string field: ${key}`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Expected optional string field: ${key}`);
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") throw new Error(`Expected number field: ${key}`);
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`Expected boolean field: ${key}`);
  return value;
}

export function arrayOf<T>(parse: (value: unknown) => T): (value: unknown) => T[] {
  return (value) => {
    if (!Array.isArray(value)) throw new Error("Expected array response");
    return value.map(parse);
  };
}

function parseUnknownArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected array response");
  return value;
}

function arrayOfString(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`Expected string array field: ${key}`);
  return value;
}

export function parseMemorySnapshotResponse(value: unknown): MemorySnapshotResponse {
  if (!isRecord(value) || typeof value["kind"] !== "string") throw new Error("Invalid memory snapshot response");
  if (value["kind"] === "unavailable") return { kind: "unavailable" };
  if (value["kind"] !== "data") throw new Error("Invalid memory snapshot response");
  return {
    kind: "data",
    globalEntries: parseMemoryEntries(value["globalEntries"]),
    projectEntries: parseMemoryEntries(value["projectEntries"]),
    ...(typeof value["projectUnavailableMessage"] === "string" ? { projectUnavailableMessage: value["projectUnavailableMessage"] } : {}),
  };
}

function parseMemoryEntries(value: unknown): MemoryEntry[] {
  if (!Array.isArray(value)) throw new Error("Invalid memory snapshot response");
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry["id"] !== "string" || typeof entry["content"] !== "string") {
      throw new Error("Invalid memory snapshot response");
    }
    return {
      id: entry["id"],
      content: entry["content"],
      ...(typeof entry["category"] === "string" ? { category: entry["category"] } : {}),
      ...(typeof entry["created"] === "string" ? { created: entry["created"] } : {}),
      ...(typeof entry["last"] === "string" ? { last: entry["last"] } : {}),
      ...(typeof entry["failureReason"] === "string" ? { failureReason: entry["failureReason"] } : {}),
    };
  });
}

export function parseMessagePage(value: unknown): MessagePage {
  if (Array.isArray(value)) return { messages: value, start: 0, total: value.length };
  const record = requireRecord(value);
  return { messages: parseUnknownArray(record["messages"]), start: requireNumber(record, "start"), total: requireNumber(record, "total") };
}

export function parseMachinesResponse(value: unknown): Machine[] {
  const record = requireRecord(value);
  return arrayOf(parseMachine)(record["machines"]);
}

export function parseMachine(value: unknown): Machine {
  const record = requireRecord(value);
  const kind = requireMachineKind(record, "kind");
  const baseUrl = optionalString(record, "baseUrl");
  const status = optionalMachineStatus(record, "status");
  const statusMessage = optionalString(record, "statusMessage");
  return {
    id: requireString(record, "id"),
    name: requireString(record, "name"),
    kind,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    createdAt: requireString(record, "createdAt"),
    updatedAt: requireString(record, "updatedAt"),
    ...(status === undefined ? {} : { status }),
    ...(statusMessage === undefined ? {} : { statusMessage }),
  };
}

export function parseMachineHealth(value: unknown): MachineHealth {
  const record = requireRecord(value);
  const status = optionalMachineStatus(record, "status");
  const error = optionalString(record, "error");
  return {
    machineId: requireString(record, "machineId"),
    ok: requireBoolean(record, "ok"),
    checkedAt: requireString(record, "checkedAt"),
    ...(status === undefined ? {} : { status }),
    ...(record["web"] === undefined ? {} : { web: parsePiWebUiComponentStatus(record["web"]) }),
    ...(record["sessiond"] === undefined ? {} : { sessiond: parsePiWebUiComponentStatus(record["sessiond"]) }),
    ...(error === undefined ? {} : { error }),
  };
}

export function parseMachineRuntime(value: unknown): MachineRuntime {
  const record = requireRecord(value);
  const error = optionalString(record, "error");
  return {
    machineId: requireString(record, "machineId"),
    ok: requireBoolean(record, "ok"),
    checkedAt: requireString(record, "checkedAt"),
    ...optionalField("packageName", optionalString(record, "packageName")),
    ...optionalField("generatedAt", optionalString(record, "generatedAt")),
    ...(record["components"] === undefined ? {} : { components: parsePiWebUiRuntimeComponents(record["components"]) }),
    ...(record["capabilities"] === undefined ? {} : { capabilities: parsePiWebUiCapabilities(record["capabilities"]) }),
    ...(error === undefined ? {} : { error }),
  };
}

function requireMachineKind(record: Record<string, unknown>, key: string): MachineKind {
  const value = requireString(record, key);
  if (value !== "local" && value !== "remote") throw new Error(`Expected machine kind field: ${key}`);
  return value;
}

function optionalMachineStatus(record: Record<string, unknown>, key: string): MachineStatus | undefined {
  const value = optionalString(record, key);
  if (value === undefined) return undefined;
  if (value !== "unknown" && value !== "online" && value !== "offline" && value !== "error") throw new Error(`Expected machine status field: ${key}`);
  return value;
}

export function parseProject(value: unknown): Project {
  const record = requireRecord(value);
  return { id: requireString(record, "id"), name: requireString(record, "name"), path: requireString(record, "path"), createdAt: requireString(record, "createdAt") };
}

export function parseWorkspace(value: unknown): Workspace {
  const record = requireRecord(value);
  const branch = optionalString(record, "branch");
  return {
    id: requireString(record, "id"),
    projectId: requireString(record, "projectId"),
    path: requireString(record, "path"),
    label: requireString(record, "label"),
    ...(branch === undefined ? {} : { branch }),
    isMain: requireBoolean(record, "isMain"),
    isGitRepo: requireBoolean(record, "isGitRepo"),
    isGitWorktree: requireBoolean(record, "isGitWorktree"),
    ...optionalField("effectiveConfig", optionalWorkspaceEffectiveConfig(record["effectiveConfig"])),
  };
}

function optionalWorkspaceEffectiveConfig(value: unknown): Workspace["effectiveConfig"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Array.isArray(value)) throw new Error("Invalid workspace effectiveConfig field");
  return {
    ...optionalField("uploads", optionalUploads(value["uploads"])),
  };
}

export function parseSessionInfo(value: unknown): SessionInfo {
  const record = requireRecord(value);
  const name = optionalString(record, "name");
  const persisted = parseOptionalBoolean(record["persisted"], "persisted");
  const parentSessionPath = optionalString(record, "parentSessionPath");
  const archivedAt = optionalString(record, "archivedAt");
  const pinned = parseOptionalBoolean(record["pinned"], "pinned");
  const creationSource =
    record["creationSource"] === "session-list-plus"
      ? record["creationSource"]
      : undefined;
  const manualOrder = record["manualOrder"] === undefined
    ? undefined
    : requireNonNegativeSafeInteger(record, "manualOrder");
  return {
    id: requireString(record, "id"),
    path: requireString(record, "path"),
    cwd: requireString(record, "cwd"),
    ...(persisted === undefined ? {} : { persisted }),
    ...(name === undefined ? {} : { name }),
    created: requireString(record, "created"),
    modified: requireString(record, "modified"),
    messageCount: requireNumber(record, "messageCount"),
    firstMessage: requireString(record, "firstMessage"),
    ...(parentSessionPath === undefined ? {} : { parentSessionPath }),
    ...(record["archived"] === true ? { archived: true } : {}),
    ...(archivedAt === undefined ? {} : { archivedAt }),
    ...(pinned === undefined ? {} : { pinned }),
    ...(creationSource === undefined ? {} : { creationSource }),
    ...(manualOrder === undefined ? {} : { manualOrder }),
  };
}

function parseSessionOrderEntry(value: unknown): SessionOrderEntry {
  const record = requireRecord(value);
  return {
    id: requireString(record, "id"),
    cwd: requireString(record, "cwd"),
    manualOrder: requireNonNegativeSafeInteger(record, "manualOrder"),
  };
}

export function parseSessionReorderResponse(value: unknown): SessionReorderResponse {
  const record = requireRecord(value);
  return { orderedSessions: arrayOf(parseSessionOrderEntry)(record["orderedSessions"]) };
}

function parseSessionWarningSeverity(value: unknown): SessionWarningSeverity {
  if (value !== "info" && value !== "warning" && value !== "error") throw new Error("Invalid session warning severity");
  return value;
}

function parseSessionWarningDismiss(value: unknown): { id: string } | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value);
  return { id: requireString(record, "id") };
}

function parseSessionWarning(value: unknown): SessionWarning {
  const record = requireRecord(value);
  const dismiss = parseSessionWarningDismiss(record["dismiss"]);
  return {
    severity: parseSessionWarningSeverity(record["severity"]),
    message: requireString(record, "message"),
    ...optionalField("source", optionalString(record, "source")),
    ...optionalField("path", optionalString(record, "path")),
    ...(dismiss === undefined ? {} : { dismiss }),
  };
}

function optionalWarnings(value: unknown): Pick<SessionStatus, "warnings"> | object {
  if (value === undefined) return {};
  return { warnings: arrayOf(parseSessionWarning)(value) };
}

export function parseSessionStatus(value: unknown): SessionStatus {
  const record = requireRecord(value);
  return {
    sessionId: requireString(record, "sessionId"),
    ...optionalField("persisted", parseOptionalBoolean(record["persisted"], "persisted")),
    isStreaming: requireBoolean(record, "isStreaming"),
    isCompacting: requireBoolean(record, "isCompacting"),
    isBashRunning: requireBoolean(record, "isBashRunning"),
    pendingMessageCount: requireNumber(record, "pendingMessageCount"),
    queuedMessages: record["queuedMessages"] === undefined ? [] : arrayOf(parseQueuedSessionMessage)(record["queuedMessages"]),
    ...optionalField("messageCount", optionalNumber(record, "messageCount")),
    tokens: parseTokens(record["tokens"]),
    cost: requireNumber(record, "cost"),
    ...optionalGeneration(record["generation"]),
    ...optionalModel(record["model"]),
    ...optionalField("modelPolicy", record["modelPolicy"] === undefined ? undefined : parseClientSessionModelPolicyStatus(record["modelPolicy"])),
    ...optionalContextUsage(record["contextUsage"]),
    ...optionalField("thinkingLevel", optionalString(record, "thinkingLevel")),
    ...optionalWarnings(record["warnings"]),
  };
}

export function parseSessionModelPolicyResponse(value: unknown): SessionModelPolicyResponse {
  const record = requirePlainRecord(value, "session model policy response");
  assertOnlyFields(record, ["contractVersion", "policy", "session"], "session model policy response");
  if (record["contractVersion"] !== 1) throw new Error("Invalid session model policy contract version");

  const session = parseSessionStatus(record["session"]);
  if (!Object.hasOwn(record, "policy")) {
    const blockedReason = session.modelPolicy?.blockedReason;
    if (blockedReason === undefined || blockedReason.trim() === "") {
      throw new Error("Expected non-blank string field: blockedReason");
    }
    return { contractVersion: 1, session };
  }
  return { contractVersion: 1, policy: parseSessionModelPolicy(record["policy"]), session };
}

function parseSessionModelPolicy(value: unknown): SessionModelPolicy {
  const record = requirePlainRecord(value, "session model policy");
  assertOnlyFields(record, ["mode", "exact", "tier"], "session model policy");
  const mode = parseSessionModelPolicyMode(record["mode"]);
  const tier = parseOptionalSessionModelPolicyTier(record, "session model policy");
  if (mode === "tiered" && tier === undefined) throw new Error("Tiered session model policy requires a tier");
  return {
    mode,
    exact: parseExactModelSelection(record["exact"]),
    ...optionalField("tier", tier),
  };
}

function parseStarterModelPolicyPreference(value: unknown): LegacyStarterModelPolicyPreference {
  const record = requirePlainRecord(value, "starter model policy preference");
  assertOnlyFields(record, ["mode", "tier"], "starter model policy preference");
  const mode = parseSessionModelPolicyMode(record["mode"]);
  const tier = parseOptionalSessionModelPolicyTier(record, "starter model policy preference");
  if (mode === "tiered" && tier === undefined) {
    throw new Error("Tiered starter model policy preference requires a tier");
  }
  return { mode, ...optionalField("tier", tier) };
}

function parseStarterModelPolicyPreferenceResponse(value: unknown): StarterModelPolicyPreferenceResponse {
  const record = requirePlainRecord(value, "starter model policy preference");
  if (!Object.hasOwn(record, "exact")) return parseStarterModelPolicyPreference(record);
  return parseConfirmedStarterModelPolicyPreference(record);
}

export function parseConfirmedStarterModelPolicyPreference(
  value: unknown,
): StarterModelPolicyPreference {
  const record = requirePlainRecord(value, "confirmed starter model policy preference");
  assertOnlyFields(record, ["mode", "exact", "tier"], "confirmed starter model policy preference");
  const mode = parseSessionModelPolicyMode(record["mode"]);
  const tier = parseOptionalSessionModelPolicyTier(record, "confirmed starter model policy preference");
  if (mode === "tiered" && tier === undefined) {
    throw new Error("Tiered confirmed starter model policy preference requires a tier");
  }
  return {
    mode,
    exact: parseExactModelSelection(record["exact"]),
    ...optionalField("tier", tier),
  };
}

function parseClientSessionModelPolicyStatus(value: unknown): ClientSessionModelPolicyStatus {
  const record = requirePlainRecord(value, "session model policy status");
  assertOnlyFields(record, ["mode", "tier", "resolved", "ladderValid", "blockedReason"], "session model policy status");
  const mode = parseSessionModelPolicyMode(record["mode"]);
  const tier = parseOptionalSessionModelPolicyTier(record, "session model policy status");
  if (mode === "tiered" && tier === undefined) throw new Error("Tiered session model policy status requires a tier");
  return {
    mode,
    ...optionalField("tier", tier),
    resolved: parseExactModelSelection(record["resolved"]),
    ladderValid: requireBoolean(record, "ladderValid"),
    ...optionalField("blockedReason", optionalString(record, "blockedReason")),
  };
}

function parseExactModelSelection(value: unknown): ExactModelSelection {
  const record = requirePlainRecord(value, "exact selection");
  assertOnlyFields(record, ["model", "thinkingLevel"], "exact selection");
  return {
    model: parseExactModelReference(record["model"]),
    thinkingLevel: requireNonBlankString(record, "thinkingLevel"),
  };
}

function parseExactModelReference(value: unknown): ExactModelSelection["model"] {
  const record = requirePlainRecord(value, "model reference");
  assertOnlyFields(record, ["provider", "id"], "model reference");
  return {
    provider: requireNonBlankString(record, "provider"),
    id: requireNonBlankString(record, "id"),
  };
}

function parseSessionModelPolicyMode(value: unknown): SessionModelPolicy["mode"] {
  if (value !== "exact" && value !== "tiered") throw new Error("Invalid session model policy mode");
  return value;
}

function parseOptionalSessionModelPolicyTier(record: Record<string, unknown>, label: string): ModelTier | undefined {
  if (!Object.hasOwn(record, "tier")) return undefined;
  const value = record["tier"];
  if (typeof value !== "string" || !isModelTier(value)) throw new Error(`Invalid ${label} tier`);
  return value;
}

function requirePlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`Expected ${label} object`);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyFields(record: Record<string, unknown>, allowedFields: readonly string[], label: string): void {
  const unexpected = Object.keys(record).find((field) => !allowedFields.includes(field));
  if (unexpected !== undefined) throw new Error(`Invalid ${label} field: ${unexpected}`);
}

export function parseSessionStreamSnapshot(value: unknown): SessionStreamSnapshot {
  const record = requireRecord(value);
  return {
    seq: requireNumber(record, "seq"),
    partial: record["partial"] ?? null,
  };
}

export function parseSessionSystemPrompt(value: unknown): SessionSystemPrompt {
  const systemPrompt = optionalString(requireRecord(value), "systemPrompt");
  return systemPrompt === undefined ? {} : { systemPrompt };
}

export function parseSessionUnreadCatalogSnapshot(value: unknown): SessionUnreadCatalogSnapshot {
  const record = requireRecord(value);
  const catalogRevision = requireNonNegativeSafeInteger(record, "catalogRevision");
  const sessions = boundedArrayOf(record["sessions"], parseSessionUnreadSummary, SESSION_UNREAD_LIMIT, "sessions");
  assertUniqueUnreadSummaries(sessions);
  assertUnreadNewestFirst(sessions);
  if (sessions.some((summary) => summary.completionOrder > catalogRevision)) {
    throw new Error("Session unread completion order exceeds catalog revision");
  }
  return {
    catalogId: requireBoundedNonEmptyString(record, "catalogId", SESSION_UNREAD_CATALOG_ID_MAX_LENGTH),
    catalogRevision,
    sessions,
  };
}

export function parseSessionUnreadEvent(value: unknown): SessionUnreadEvent {
  const record = requireRecord(value);
  if (record["type"] !== "sessions.unread") throw new Error("Invalid session unread event type");
  const sessionId = requireBoundedNonEmptyString(record, "sessionId", SESSION_UNREAD_SESSION_ID_MAX_LENGTH);
  const cwd = requireBoundedNonEmptyString(record, "cwd", SESSION_UNREAD_CWD_MAX_LENGTH);
  const catalogRevision = requirePositiveSafeInteger(record, "catalogRevision");
  const unread = record["unread"] === null ? null : parseSessionUnreadSummary(record["unread"]);
  if (unread !== null && (unread.sessionId !== sessionId || unread.cwd !== cwd)) {
    throw new Error("Session unread event identity mismatch");
  }
  if (unread !== null && unread.completionOrder > catalogRevision) {
    throw new Error("Session unread completion order exceeds catalog revision");
  }
  return {
    type: "sessions.unread",
    catalogId: requireBoundedNonEmptyString(record, "catalogId", SESSION_UNREAD_CATALOG_ID_MAX_LENGTH),
    catalogRevision,
    sessionId,
    cwd,
    unread,
  };
}

function parseSessionUnreadSummary(value: unknown): SessionUnreadSummary {
  const record = requireRecord(value);
  const completedAt = requireBoundedNonEmptyString(
    record,
    "completedAt",
    SESSION_UNREAD_COMPLETED_AT_MAX_LENGTH,
  );
  const completedDate = new Date(completedAt);
  if (!Number.isFinite(completedDate.getTime()) || completedDate.toISOString() !== completedAt) {
    throw new Error("Invalid canonical session unread completion time");
  }
  return {
    sessionId: requireBoundedNonEmptyString(record, "sessionId", SESSION_UNREAD_SESSION_ID_MAX_LENGTH),
    cwd: requireBoundedNonEmptyString(record, "cwd", SESSION_UNREAD_CWD_MAX_LENGTH),
    completionOrder: requirePositiveSafeInteger(record, "completionOrder"),
    completedAt,
  };
}

function assertUniqueUnreadSummaries(summaries: readonly SessionUnreadSummary[]): void {
  const identities = summaries.map((summary) => JSON.stringify([summary.sessionId, summary.cwd]));
  if (new Set(identities).size !== identities.length) throw new Error("Duplicate session unread identity");
  const completionOrders = summaries.map((summary) => summary.completionOrder);
  if (new Set(completionOrders).size !== completionOrders.length) throw new Error("Duplicate session unread completion order");
}

function assertUnreadNewestFirst(summaries: readonly SessionUnreadSummary[]): void {
  for (let index = 1; index < summaries.length; index += 1) {
    const previous = summaries[index - 1];
    const current = summaries[index];
    if (previous === undefined || current === undefined || previous.completionOrder <= current.completionOrder) {
      throw new Error("Session unread summaries are not newest-first");
    }
  }
}

function requireBoundedNonEmptyString(record: Record<string, unknown>, key: string, maxLength: number): string {
  const value = requireNonEmptyString(record, key);
  if (value.length > maxLength) throw new Error(`String field exceeds limit: ${key}`);
  return value;
}

function requirePositiveSafeInteger(record: Record<string, unknown>, key: string): number {
  const value = requireNonNegativeSafeInteger(record, key);
  if (value === 0) throw new Error(`Expected positive safe integer field: ${key}`);
  return value;
}

export function parseSessionNotificationInboxSnapshot(value: unknown): SessionNotificationInboxSnapshot {
  const record = requireRecord(value);
  const summary = parseSessionNotificationSummary(record["summary"]);
  const notifications = boundedArrayOf(record["notifications"], parseSessionNotification, SESSION_NOTIFICATION_LIMIT, "notifications");
  assertUniqueNotifications(notifications);
  assertNewestFirst(notifications);
  if (summary.retainedCount !== notifications.length) throw new Error("Notification snapshot retained count mismatch");
  if (summary.highestSeverity !== highestNotificationSeverity(notifications)) throw new Error("Notification snapshot severity mismatch");
  const dismissThrough = parseSessionNotificationDismissThrough(record["dismissThrough"]);
  const newestOrder = notifications[0]?.order ?? 0;
  if (dismissThrough.order !== newestOrder) throw new Error("Notification snapshot dismiss cutoff mismatch");
  if (dismissThrough.overflowWatermark < summary.discardedCount) throw new Error("Notification snapshot overflow cutoff mismatch");
  return {
    daemonInstanceId: requireNonEmptyString(record, "daemonInstanceId"),
    catalogRevision: requireNonNegativeSafeInteger(record, "catalogRevision"),
    summary,
    notifications,
    dismissThrough,
  };
}

export function parseSessionNotificationInboxEvent(value: unknown): SessionNotificationInboxEvent {
  const record = requireRecord(value);
  if (record["type"] !== "notifications.inbox") throw new Error("Invalid notification inbox event type");
  const summary = parseSessionNotificationSummary(record["summary"]);
  const dismissThrough = parseSessionNotificationDismissThrough(record["dismissThrough"]);
  if (dismissThrough.overflowWatermark < summary.discardedCount) throw new Error("Notification event overflow cutoff mismatch");
  const delta = parseSessionNotificationInboxDelta(record["delta"]);
  if (delta.kind === "cleared" && !notificationSummaryIsEmpty(summary)) throw new Error("Notification clear event summary mismatch");
  if (delta.kind === "added" && summary.retainedCount === 0) throw new Error("Notification add event summary mismatch");
  return {
    type: "notifications.inbox",
    daemonInstanceId: requireNonEmptyString(record, "daemonInstanceId"),
    catalogRevision: requireNonNegativeSafeInteger(record, "catalogRevision"),
    summary,
    dismissThrough,
    delta,
  };
}

function parseSessionNotificationSummary(value: unknown): SessionNotificationSummary {
  const record = requireRecord(value);
  const retainedCount = requireNonNegativeSafeInteger(record, "retainedCount");
  if (retainedCount > SESSION_NOTIFICATION_LIMIT) throw new Error("Notification retained count exceeds limit");
  const discardedCount = requireNonNegativeSafeInteger(record, "discardedCount");
  const highestSeverity = optionalSessionNotificationSeverity(record["highestSeverity"]);
  if ((retainedCount === 0) !== (highestSeverity === undefined)) throw new Error("Notification summary severity mismatch");
  return {
    sessionId: requireNonEmptyString(record, "sessionId"),
    cwd: requireNonEmptyString(record, "cwd"),
    inboxRevision: requireNonNegativeSafeInteger(record, "inboxRevision"),
    retainedCount,
    discardedCount,
    ...(highestSeverity === undefined ? {} : { highestSeverity }),
  };
}

function parseSessionNotification(value: unknown): SessionNotification {
  const record = requireRecord(value);
  const message = requireString(record, "message");
  if (new TextEncoder().encode(message).byteLength > SESSION_NOTIFICATION_MESSAGE_BYTES) throw new Error("Notification message exceeds byte limit");
  const receivedAt = requireString(record, "receivedAt");
  if (!Number.isFinite(Date.parse(receivedAt))) throw new Error("Invalid notification receive time");
  const order = requireNonNegativeSafeInteger(record, "order");
  if (order === 0) throw new Error("Invalid notification order");
  return {
    id: requireNonEmptyString(record, "id"),
    message,
    truncated: requireBoolean(record, "truncated"),
    severity: parseSessionNotificationSeverity(record["severity"]),
    receivedAt,
    order,
  };
}

function parseSessionNotificationDismissThrough(value: unknown): SessionNotificationDismissThrough {
  const record = requireRecord(value);
  return {
    order: requireNonNegativeSafeInteger(record, "order"),
    overflowWatermark: requireNonNegativeSafeInteger(record, "overflowWatermark"),
  };
}

function parseSessionNotificationInboxDelta(value: unknown): SessionNotificationInboxDelta {
  const record = requireRecord(value);
  switch (record["kind"]) {
    case "added": {
      const evictedNotificationId = optionalString(record, "evictedNotificationId");
      return {
        kind: "added",
        notification: parseSessionNotification(record["notification"]),
        ...(evictedNotificationId === undefined ? {} : { evictedNotificationId }),
      };
    }
    case "dismissed": {
      const notificationIds = boundedArrayOf(record["notificationIds"], parseNonEmptyString, SESSION_NOTIFICATION_LIMIT, "notificationIds");
      if (new Set(notificationIds).size !== notificationIds.length) throw new Error("Duplicate dismissed notification id");
      return { kind: "dismissed", notificationIds };
    }
    case "cleared":
      return { kind: "cleared", reason: parseSessionNotificationClearReason(record["reason"]) };
    case "resync":
      return { kind: "resync" };
    default:
      throw new Error("Invalid notification inbox delta");
  }
}

function parseSessionNotificationSeverity(value: unknown): SessionNotificationSeverity {
  if (value !== "info" && value !== "warning" && value !== "error") throw new Error("Invalid notification severity");
  return value;
}

function optionalSessionNotificationSeverity(value: unknown): SessionNotificationSeverity | undefined {
  return value === undefined ? undefined : parseSessionNotificationSeverity(value);
}

function parseSessionNotificationClearReason(value: unknown): SessionNotificationClearReason {
  switch (value) {
    case "runtime-close":
    case "archive":
    case "delete":
    case "restore":
    case "archive-reconcile":
    case "replacement":
    case "initialization-failed":
    case "service-dispose":
      return value;
    default:
      throw new Error("Invalid notification clear reason");
  }
}

function boundedArrayOf<T>(value: unknown, parse: (item: unknown) => T, limit: number, field: string): T[] {
  if (!Array.isArray(value)) throw new Error(`Expected array field: ${field}`);
  if (value.length > limit) throw new Error(`Array field exceeds limit: ${field}`);
  return value.map(parse);
}

function parseNonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new Error("Expected non-empty string");
  return value;
}

function requireNonEmptyString(record: Record<string, unknown>, key: string): string {
  const value = requireString(record, key);
  if (value === "") throw new Error(`Expected non-empty string field: ${key}`);
  return value;
}

function requireNonNegativeSafeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Expected non-negative safe integer field: ${key}`);
  return value;
}

function assertUniqueNotifications(notifications: readonly SessionNotification[]): void {
  if (new Set(notifications.map((notification) => notification.id)).size !== notifications.length) throw new Error("Duplicate notification id");
  if (new Set(notifications.map((notification) => notification.order)).size !== notifications.length) throw new Error("Duplicate notification order");
}

function assertNewestFirst(notifications: readonly SessionNotification[]): void {
  for (let index = 1; index < notifications.length; index += 1) {
    const previous = notifications[index - 1];
    const current = notifications[index];
    if (previous === undefined || current === undefined || previous.order <= current.order) throw new Error("Notifications are not newest-first");
  }
}

function notificationSummaryIsEmpty(summary: SessionNotificationSummary): boolean {
  return summary.retainedCount === 0 && summary.discardedCount === 0;
}

function highestNotificationSeverity(notifications: readonly SessionNotification[]): SessionNotificationSeverity | undefined {
  let highest: SessionNotificationSeverity | undefined;
  for (const notification of notifications) {
    if (notification.severity === "error") return "error";
    if (notification.severity === "warning") highest = "warning";
    else highest ??= "info";
  }
  return highest;
}

export function parseSessionCleanupPreviewResponse(value: unknown): SessionCleanupPreviewResponse {
  const record = requireRecord(value);
  const skippedBusySessionIds = record["skippedBusySessionIds"] === undefined ? undefined : arrayOfString(record["skippedBusySessionIds"], "skippedBusySessionIds");
  return {
    generatedAt: requireString(record, "generatedAt"),
    thresholds: parseSessionCleanupThresholds(record["thresholds"]),
    projects: arrayOf(parseSessionCleanupProjectSummary)(record["projects"]),
    totals: parseSessionCleanupTotals(record["totals"]),
    ...(skippedBusySessionIds === undefined ? {} : { skippedBusySessionIds }),
  };
}

export function parseSessionCleanupExecuteResponse(value: unknown): SessionCleanupExecuteResponse {
  const record = requireRecord(value);
  return {
    ...parseSessionCleanupPreviewResponse(record),
    archivedSessionIds: arrayOfString(record["archivedSessionIds"], "archivedSessionIds"),
    deletedSessionIds: arrayOfString(record["deletedSessionIds"], "deletedSessionIds"),
  };
}

export function parseSessionBulkArchiveResponse(value: unknown): SessionBulkArchiveResponse {
  const record = requireRecord(value);
  if (record["archived"] !== true) throw new Error("Expected bulk archived response");
  return {
    archived: true,
    archivedSessionIds: arrayOfString(record["archivedSessionIds"], "archivedSessionIds"),
    failures: arrayOf(parseSessionBulkFailure)(record["failures"]),
    generatedAt: requireString(record, "generatedAt"),
  };
}

export function parseSessionBulkDeleteArchivedResponse(value: unknown): SessionBulkDeleteArchivedResponse {
  const record = requireRecord(value);
  if (record["deleted"] !== true) throw new Error("Expected bulk deleted response");
  return {
    deleted: true,
    deletedSessionIds: arrayOfString(record["deletedSessionIds"], "deletedSessionIds"),
    failures: arrayOf(parseSessionBulkFailure)(record["failures"]),
    generatedAt: requireString(record, "generatedAt"),
  };
}

function parseSessionBulkFailure(value: unknown): SessionBulkFailure {
  const record = requireRecord(value);
  return { sessionId: requireString(record, "sessionId"), error: requireString(record, "error") };
}

function parseSessionCleanupThresholds(value: unknown): SessionCleanupThresholds {
  const record = requireRecord(value);
  return {
    ...optionalField("archiveIdleDays", optionalNumber(record, "archiveIdleDays")),
    ...optionalField("deleteArchivedDays", optionalNumber(record, "deleteArchivedDays")),
  };
}

function parseSessionCleanupProjectSummary(value: unknown): SessionCleanupProjectSummary {
  const record = requireRecord(value);
  return {
    cwd: requireString(record, "cwd"),
    archiveCount: requireNumber(record, "archiveCount"),
    deleteCount: requireNumber(record, "deleteCount"),
  };
}

function parseSessionCleanupTotals(value: unknown): SessionCleanupTotals {
  const record = requireRecord(value);
  return {
    archiveCount: requireNumber(record, "archiveCount"),
    deleteCount: requireNumber(record, "deleteCount"),
  };
}

function parseQueuedSessionMessage(value: unknown): QueuedSessionMessage {
  const record = requireRecord(value);
  const kind = requireString(record, "kind");
  if (kind !== "steer" && kind !== "followUp") throw new Error("Invalid queued message kind");
  return { kind, text: requireString(record, "text") };
}

function parseTokens(value: unknown): SessionStatus["tokens"] {
  const record = requireRecord(value);
  return {
    input: requireNumber(record, "input"),
    output: requireNumber(record, "output"),
    cacheRead: requireNumber(record, "cacheRead"),
    cacheWrite: requireNumber(record, "cacheWrite"),
    total: requireNumber(record, "total"),
  };
}

function parseSessionModel(value: unknown): SessionModel {
  const record = requireRecord(value);
  return { ...optionalField("provider", optionalString(record, "provider")), ...optionalField("id", optionalString(record, "id")), ...optionalField("name", optionalString(record, "name")), ...optionalField("contextWindow", optionalNumber(record, "contextWindow")), ...optionalField("reasoning", record["reasoning"]) };
}

function optionalModel(value: unknown): Pick<SessionStatus, "model"> | object {
  if (value === undefined) return {};
  return { model: parseSessionModel(value) };
}

export function parseModelSelectionResponse(value: unknown): ModelSelectionResponse {
  const record = requireRecord(value);
  return { models: arrayOf(parseSessionModel)(record["models"]) };
}

export function parseSessionDefaultsResponse(value: unknown): SessionDefaultsResponse {
  const record = requireRecord(value);
  const preference = record["starterModelPolicyPreference"] === undefined
    ? undefined
    : parseStarterModelPolicyPreference(record["starterModelPolicyPreference"]);
  const preferenceError = optionalString(record, "starterModelPolicyPreferenceError");
  if (preference !== undefined && preferenceError !== undefined) {
    throw new Error("Session defaults cannot contain both a starter preference and preference error");
  }
  return {
    ...(record["model"] === undefined ? {} : { model: parseSessionModel(record["model"]) }),
    thinkingLevel: requireString(record, "thinkingLevel"),
    models: arrayOf(parseSessionModel)(record["models"]),
    thinkingLevels: arrayOfString(record["thinkingLevels"], "thinkingLevels"),
    ...optionalField("starterModelPolicyPreference", preference),
    ...optionalField("starterModelPolicyPreferenceError", preferenceError),
  };
}

export function parseSessionDefaultsV2Response(value: unknown): SessionDefaultsV2Response {
  const record = requirePlainRecord(value, "version-two session defaults response");
  assertOnlyFields(record, [
    "starterModelPolicyContractVersion",
    "model",
    "thinkingLevel",
    "models",
    "thinkingLevels",
    "starterModelPolicyPreference",
    "starterModelPolicyPreferenceError",
  ], "version-two session defaults response");
  if (record["starterModelPolicyContractVersion"] !== 2) {
    throw new Error("Invalid starter model policy contract version");
  }
  const preference = record["starterModelPolicyPreference"] === undefined
    ? undefined
    : parseStarterModelPolicyPreferenceResponse(record["starterModelPolicyPreference"]);
  const preferenceError = optionalString(record, "starterModelPolicyPreferenceError");
  if (preference !== undefined && preferenceError !== undefined) {
    throw new Error("Session defaults cannot contain both a starter preference and preference error");
  }
  return {
    starterModelPolicyContractVersion: 2,
    ...(record["model"] === undefined ? {} : { model: parseSessionModel(record["model"]) }),
    thinkingLevel: requireString(record, "thinkingLevel"),
    models: arrayOf(parseSessionModel)(record["models"]),
    thinkingLevels: arrayOfString(record["thinkingLevels"], "thinkingLevels"),
    ...optionalField("starterModelPolicyPreference", preference),
    ...optionalField("starterModelPolicyPreferenceError", preferenceError),
  };
}

export function parseModelsConfigDocument(value: unknown): ModelsConfigDocument {
  const record = requireModelsConfigObject(value, "models configuration");
  const rawProviders = record["providers"];
  if (rawProviders === undefined) return { ...record, providers: {} };
  const providerRecords = requireModelsConfigObject(rawProviders, "models configuration providers");
  const providers: Record<string, ModelsConfigProvider> = {};
  for (const [providerName, rawProvider] of Object.entries(providerRecords)) {
    providers[providerName] = parseModelsConfigProvider(rawProvider);
  }
  return { ...record, providers };
}

function parseModelsConfigProvider(value: unknown): ModelsConfigProvider {
  const record = requireModelsConfigObject(value, "models configuration provider");
  const provider: ModelsConfigProvider = {};
  for (const [key, entry] of Object.entries(record)) provider[key] = entry;

  const baseUrl = optionalString(record, "baseUrl");
  if (baseUrl !== undefined) provider.baseUrl = baseUrl;
  const api = optionalString(record, "api");
  if (api !== undefined) provider.api = api;
  const apiKey = optionalString(record, "apiKey");
  if (apiKey !== undefined) provider.apiKey = apiKey;

  const headers = optionalModelsConfigObject(record["headers"], "models configuration provider headers");
  if (headers !== undefined) provider.headers = parseModelsConfigStringRecord(headers, "models configuration provider headers");
  const compat = optionalModelsConfigObject(record["compat"], "models configuration provider compatibility");
  if (compat !== undefined) provider.compat = { ...compat };
  const modelOverrides = optionalModelsConfigObject(record["modelOverrides"], "models configuration provider model overrides");
  if (modelOverrides !== undefined) provider.modelOverrides = { ...modelOverrides };

  const models = record["models"];
  if (models !== undefined) {
    if (!Array.isArray(models)) throw new Error("Expected models configuration models array");
    provider.models = models.map(parseModelsConfigModel);
  }
  return provider;
}

function parseModelsConfigModel(value: unknown): ModelsConfigModel {
  const record = requireModelsConfigObject(value, "models configuration model");
  const model: ModelsConfigModel = { id: requireString(record, "id") };
  for (const [key, entry] of Object.entries(record)) model[key] = entry;
  model.id = requireString(record, "id");

  const name = optionalString(record, "name");
  if (name !== undefined) model.name = name;
  const api = optionalString(record, "api");
  if (api !== undefined) model.api = api;
  const reasoning = optionalBoolean(record, "reasoning");
  if (reasoning !== undefined) model.reasoning = reasoning;
  const thinkingLevelMap = optionalModelsConfigObject(record["thinkingLevelMap"], "models configuration thinking level map");
  if (thinkingLevelMap !== undefined) model.thinkingLevelMap = parseThinkingLevelMap(thinkingLevelMap);

  const input = record["input"];
  if (input !== undefined) {
    if (!Array.isArray(input) || !input.every((entry) => typeof entry === "string")) throw new Error("Expected models configuration model input array of strings");
    model.input = [...input];
  }
  const contextWindow = optionalNumber(record, "contextWindow");
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  const maxTokens = optionalNumber(record, "maxTokens");
  if (maxTokens !== undefined) model.maxTokens = maxTokens;
  const cost = optionalModelsConfigObject(record["cost"], "models configuration model cost");
  if (cost !== undefined) model.cost = parseModelCost(cost);
  const compat = optionalModelsConfigObject(record["compat"], "models configuration model compatibility");
  if (compat !== undefined) model.compat = { ...compat };
  return model;
}

function requireModelsConfigObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) throw new Error(`Expected ${label} object`);
  return value;
}

function optionalModelsConfigObject(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return requireModelsConfigObject(value, label);
}

function parseModelsConfigStringRecord(record: Record<string, unknown>, label: string): Record<string, string> {
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string") throw new Error(`Expected ${label} values to be strings`);
    strings[key] = value;
  }
  return strings;
}

function parseThinkingLevelMap(record: Record<string, unknown>): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  for (const [level, value] of Object.entries(record)) {
    if (value !== null && typeof value !== "string") throw new Error("Expected models configuration thinking level map values to be strings or null");
    map[level] = value;
  }
  return map;
}

function parseModelCost(record: Record<string, unknown>): NonNullable<ModelsConfigModel["cost"]> {
  const cost: NonNullable<ModelsConfigModel["cost"]> = {};
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const value = record[field];
    if (value === undefined) continue;
    if (typeof value !== "number") throw new Error(`Expected models configuration model cost ${field} to be a number`);
    cost[field] = value;
  }
  return cost;
}

export function parseModelsConfigSaveResponse(value: unknown): ModelsConfigSaveResponse {
  const record = requireRecord(value);
  if (record["success"] !== true) throw new Error("Expected successful models configuration save");
  return { success: true };
}

export function parseModelDiscoveryResponse(value: unknown): ModelDiscoveryResponse {
  const record = requireRecord(value);
  return { models: arrayOf(parseModelDiscoveryModel)(record["models"]) };
}

function parseModelDiscoveryModel(value: unknown): ModelDiscoveryModel {
  const record = requireRecord(value);
  const id = requireString(record, "id");
  const name = optionalString(record, "name");
  return name === undefined ? { id } : { id, name };
}

export function parseModelConnectionTestResponse(value: unknown): ModelConnectionTestResponse {
  const record = requireRecord(value);
  const ok = requireBoolean(record, "ok");
  const error = optionalString(record, "error");
  const latencyMs = record["latencyMs"] === undefined ? undefined : requireNumber(record, "latencyMs");
  const status = record["status"] === undefined ? undefined : requireNumber(record, "status");
  const responseText = optionalString(record, "responseText");
  return {
    ok,
    ...(error === undefined ? {} : { error }),
    ...(latencyMs === undefined ? {} : { latencyMs }),
    ...(status === undefined ? {} : { status }),
    ...(responseText === undefined ? {} : { responseText }),
  };
}

export function parseSkillsResponse(value: unknown): SkillsResponse {
  const record = requireRecord(value);
  return { skills: arrayOf(parseSkillInfo)(record["skills"]) };
}

function parseSkillInfo(value: unknown): SkillInfo {
  const record = requireRecord(value);
  const sourceInfo = requireRecord(record["sourceInfo"]);
  const source = optionalString(sourceInfo, "source");
  const scope = optionalString(sourceInfo, "scope");
  return {
    name: requireString(record, "name"),
    description: requireString(record, "description"),
    filePath: requireString(record, "filePath"),
    baseDir: requireString(record, "baseDir"),
    disableModelInvocation: requireBoolean(record, "disableModelInvocation"),
    sourceInfo: {
      ...(source === undefined ? {} : { source }),
      ...(scope === undefined ? {} : { scope }),
    },
    ...(record["install"] === undefined ? {} : { install: parseSkillInstallInfo(record["install"]) }),
  };
}

function parseSkillInstallInfo(value: unknown): SkillInstallInfo {
  const record = requireRecord(value);
  const sourceType = optionalString(record, "sourceType");
  const skillsShUrl = optionalString(record, "skillsShUrl");
  const skillPath = optionalString(record, "skillPath");
  const ref = optionalString(record, "ref");
  const versionHash = optionalString(record, "versionHash");
  return {
    package: requireString(record, "package"),
    scope: parseSkillInstallScope(record["scope"]),
    source: requireString(record, "source"),
    ...(sourceType === undefined ? {} : { sourceType }),
    ...(skillsShUrl === undefined ? {} : { skillsShUrl }),
    ...(skillPath === undefined ? {} : { skillPath }),
    ...(ref === undefined ? {} : { ref }),
    ...(versionHash === undefined ? {} : { versionHash }),
    canCheckForUpdates: requireBoolean(record, "canCheckForUpdates"),
  };
}

function parseSkillInstallScope(value: unknown): SkillInstallScope {
  if (value !== "global" && value !== "project") throw new Error("Expected skill install scope");
  return value;
}

export function parseSkillMutationResponse(value: unknown): SkillMutationResponse {
  const record = requireRecord(value);
  if (record["success"] !== true) throw new Error("Expected successful Skills mutation");
  return { success: true };
}

export function parseSkillSearchResponse(value: unknown): SkillSearchResponse {
  const record = requireRecord(value);
  return { results: arrayOf(parseSkillSearchResult)(record["results"]) };
}

function parseSkillSearchResult(value: unknown): SkillSearchResponse["results"][number] {
  const record = requireRecord(value);
  return {
    package: requireString(record, "package"),
    installs: requireString(record, "installs"),
    url: requireString(record, "url"),
  };
}

export function parseSkillsCheckResponse(value: unknown): SkillsCheckResponse {
  const record = requireRecord(value);
  return { updates: arrayOf(parseSkillUpdateResult)(record["updates"]) };
}

function parseSkillUpdateResult(value: unknown): SkillUpdateResult {
  const record = requireRecord(value);
  const currentVersion = optionalString(record, "currentVersion");
  const latestVersion = optionalString(record, "latestVersion");
  const message = optionalString(record, "message");
  return {
    package: requireString(record, "package"),
    scope: parseSkillInstallScope(record["scope"]),
    state: parseSkillUpdateState(record["state"]),
    ...(currentVersion === undefined ? {} : { currentVersion }),
    ...(latestVersion === undefined ? {} : { latestVersion }),
    ...(message === undefined ? {} : { message }),
  };
}

function parseSkillUpdateState(value: unknown): SkillUpdateState {
  if (value !== "up-to-date" && value !== "update-available" && value !== "unsupported" && value !== "error") {
    throw new Error("Expected skill update state");
  }
  return value;
}

export function parseSkillUpdateResponse(value: unknown): SkillUpdateResponse {
  const record = requireRecord(value);
  if (record["success"] !== true) throw new Error("Expected successful Skills update");
  const output = optionalString(record, "output");
  return {
    success: true,
    ...(record["skill"] === undefined ? {} : { skill: parseSkillInfo(record["skill"]) }),
    ...(output === undefined ? {} : { output }),
  };
}

function parseThinkingLevel(value: unknown): string {
  // pi owns the level set; accept any string so a newer pi runtime reporting an
  // unknown level degrades gracefully instead of failing the whole response.
  if (typeof value !== "string") throw new Error("Invalid thinking level");
  return value;
}

export function parseThinkingLevelsResponse(value: unknown): ThinkingLevelsResponse {
  const record = requireRecord(value);
  return { levels: arrayOf(parseThinkingLevel)(record["levels"]) };
}

function parseAuthType(value: unknown): AuthType {
  if (value !== "oauth" && value !== "api_key") throw new Error("Invalid auth type");
  return value;
}

function parseAuthStatusSource(value: unknown): AuthStatusSource {
  if (value !== "stored" && value !== "runtime" && value !== "environment" && value !== "fallback" && value !== "models_json_key" && value !== "models_json_command") throw new Error("Invalid auth status source");
  return value;
}

function parseAuthProviderStatus(value: unknown): AuthProviderStatus {
  const record = requireRecord(value);
  const source = record["source"] === undefined ? undefined : parseAuthStatusSource(record["source"]);
  return { configured: requireBoolean(record, "configured"), ...optionalField("source", source), ...optionalField("label", optionalString(record, "label")) };
}

function parseAuthProviderOption(value: unknown): AuthProviderOption {
  const record = requireRecord(value);
  const loginFlow = record["loginFlow"];
  if (loginFlow !== undefined && loginFlow !== "interactive") throw new Error("Invalid auth provider login flow");
  return {
    id: requireString(record, "id"),
    name: requireString(record, "name"),
    authType: parseAuthType(record["authType"]),
    status: parseAuthProviderStatus(record["status"]),
    ...(loginFlow === undefined ? {} : { loginFlow }),
  };
}

export function parseAuthProvidersResponse(value: unknown): AuthProvidersResponse {
  const record = requireRecord(value);
  return { providers: arrayOf(parseAuthProviderOption)(record["providers"]) };
}

export function parseOAuthFlowState(value: unknown): OAuthFlowState {
  const record = requireRecord(value);
  const flow = {
    flowId: requireString(record, "flowId"),
    providerId: requireString(record, "providerId"),
    providerName: requireString(record, "providerName"),
    status: parseOAuthFlowStatus(record["status"]),
    progress: arrayOf((item) => {
      if (typeof item !== "string") throw new Error("Expected progress item string");
      return item;
    })(record["progress"]),
    ...optionalField("error", optionalString(record, "error")),
    ...optionalField("auth", optionalOAuthAuth(record["auth"])),
    ...optionalField("prompt", optionalOAuthPrompt(record["prompt"])),
    ...optionalField("select", optionalOAuthSelect(record["select"])),
    ...optionalField("info", optionalOAuthInfo(record["info"])),
  };
  return flow;
}

function parseOAuthFlowStatus(value: unknown): OAuthFlowState["status"] {
  if (value !== "running" && value !== "complete" && value !== "error" && value !== "cancelled") throw new Error("Invalid OAuth flow status");
  return value;
}

function optionalOAuthAuth(value: unknown): OAuthFlowState["auth"] | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value);
  return {
    url: requireString(record, "url"),
    ...optionalField("instructions", optionalString(record, "instructions")),
    ...optionalField("deviceCode", optionalOAuthDeviceCode(record["deviceCode"])),
  };
}

function optionalOAuthDeviceCode(value: unknown): NonNullable<OAuthFlowState["auth"]>["deviceCode"] | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value);
  return {
    userCode: requireString(record, "userCode"),
    ...optionalField("intervalSeconds", optionalNumber(record, "intervalSeconds")),
    ...optionalField("expiresInSeconds", optionalNumber(record, "expiresInSeconds")),
  };
}

function optionalOAuthPrompt(value: unknown): OAuthFlowState["prompt"] | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value);
  const kind = requireString(record, "kind");
  if (kind !== "prompt" && kind !== "manual") throw new Error("Invalid OAuth prompt kind");
  const promptType = record["promptType"] === undefined ? (kind === "manual" ? "manual_code" : "text") : parseOAuthPromptType(record["promptType"]);
  return {
    requestId: requireString(record, "requestId"),
    message: requireString(record, "message"),
    kind,
    promptType,
    ...optionalField("placeholder", optionalString(record, "placeholder")),
    ...optionalField("allowEmpty", optionalBoolean(record, "allowEmpty")),
  };
}

function parseOAuthPromptType(value: unknown): "text" | "secret" | "manual_code" {
  if (value !== "text" && value !== "secret" && value !== "manual_code") throw new Error("Invalid OAuth prompt type");
  return value;
}

function optionalOAuthSelect(value: unknown): OAuthFlowState["select"] | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value);
  return { requestId: requireString(record, "requestId"), message: requireString(record, "message"), options: arrayOf(parseCommandOption)(record["options"]) };
}

function optionalOAuthInfo(value: unknown): OAuthFlowState["info"] | undefined {
  if (value === undefined) return undefined;
  return arrayOf((item) => {
    const record = requireRecord(item);
    return {
      message: requireString(record, "message"),
      ...optionalField("links", record["links"] === undefined ? undefined : arrayOf(parseOAuthInfoLink)(record["links"])),
    };
  })(value);
}

function parseOAuthInfoLink(value: unknown): NonNullable<NonNullable<OAuthFlowState["info"]>[number]["links"]>[number] {
  const record = requireRecord(value);
  return { url: requireString(record, "url"), ...optionalField("label", optionalString(record, "label")) };
}

function optionalGeneration(value: unknown): Pick<SessionStatus, "generation"> | object {
  if (value === undefined) return {};
  const record = requireRecord(value);
  return {
    generation: {
      outputTokens: requireNumber(record, "outputTokens"),
      ...optionalField("tokensPerSecond", optionalNumber(record, "tokensPerSecond")),
      ...optionalField("estimated", optionalBoolean(record, "estimated")),
    },
  };
}

function optionalContextUsage(value: unknown): Pick<SessionStatus, "contextUsage"> | object {
  if (value === undefined) return {};
  const record = requireRecord(value);
  return { contextUsage: { tokens: numberOrNull(record, "tokens"), contextWindow: requireNumber(record, "contextWindow"), percent: numberOrNull(record, "percent") } };
}

export function parseSlashCommand(value: unknown): SlashCommand {
  const record = requireRecord(value);
  const source = requireString(record, "source");
  if (source !== "extension" && source !== "prompt" && source !== "skill" && source !== "builtin") throw new Error("Invalid command source");
  return { name: requireString(record, "name"), source, ...optionalField("description", optionalString(record, "description")) };
}

export function parseFileSuggestion(value: unknown): FileSuggestion {
  const record = requireRecord(value);
  const kind = requireString(record, "kind");
  if (kind !== "tracked" && kind !== "untracked" && kind !== "other") throw new Error("Invalid file kind");
  return { path: requireString(record, "path"), kind };
}

export function parseFileTreeResponse(value: unknown): FileTreeResponse {
  const record = requireRecord(value);
  return { path: requireString(record, "path"), entries: arrayOf(parseFileTreeEntry)(record["entries"]), scannedAt: requireString(record, "scannedAt"), truncated: requireBoolean(record, "truncated") };
}

function parseFileTreeEntry(value: unknown): FileTreeEntry {
  const record = requireRecord(value);
  const type = requireString(record, "type");
  if (type !== "file" && type !== "directory" && type !== "symlink") throw new Error("Invalid file tree entry type");
  return { name: requireString(record, "name"), path: requireString(record, "path"), type, ...optionalField("size", optionalNumber(record, "size")), ...optionalField("modifiedAt", optionalString(record, "modifiedAt")) };
}

export function parseFileContentResponse(value: unknown): FileContentResponse {
  const record = requireRecord(value);
  const encoding = requireString(record, "encoding");
  if (encoding !== "utf8") throw new Error("Invalid file encoding");
  return { path: requireString(record, "path"), ...optionalField("language", optionalString(record, "language")), ...optionalField("mediaType", optionalFileMediaType(record["mediaType"])), ...optionalField("mimeType", optionalString(record, "mimeType")), encoding, size: requireNumber(record, "size"), modifiedAt: requireString(record, "modifiedAt"), content: requireString(record, "content"), truncated: requireBoolean(record, "truncated"), binary: requireBoolean(record, "binary") };
}

export function parseWriteWorkspaceFileResponse(value: unknown): WriteWorkspaceFileResponse {
  const record = requireRecord(value);
  return {
    path: requireString(record, "path"),
    size: requireNumber(record, "size"),
    modifiedAt: requireString(record, "modifiedAt"),
    created: requireBoolean(record, "created"),
  };
}

export function parseDeleteWorkspaceFileResponse(value: unknown): DeleteWorkspaceFileResponse {
  const record = requireRecord(value);
  return {
    path: requireString(record, "path"),
    existed: requireBoolean(record, "existed"),
  };
}

export function parseMoveWorkspaceFileResponse(value: unknown): MoveWorkspaceFileResponse {
  const record = requireRecord(value);
  return {
    fromPath: requireString(record, "fromPath"),
    toPath: requireString(record, "toPath"),
    size: requireNumber(record, "size"),
    modifiedAt: requireString(record, "modifiedAt"),
  };
}

function optionalFileMediaType(value: unknown): FileContentResponse["mediaType"] | undefined {
  if (value === undefined) return undefined;
  if (value !== "image") throw new Error("Invalid file media type");
  return value;
}

export function parseGitStatusResponse(value: unknown): GitStatusResponse {
  const record = requireRecord(value);
  return { isGitRepo: requireBoolean(record, "isGitRepo"), hash: requireString(record, "hash"), ...optionalField("branch", optionalString(record, "branch")), ...optionalField("latestTag", optionalString(record, "latestTag")), ...optionalField("upstream", optionalString(record, "upstream")), ...optionalField("ahead", optionalNumber(record, "ahead")), ...optionalField("behind", optionalNumber(record, "behind")), files: arrayOf(parseGitStatusFile)(record["files"]) };
}

function parseGitStatusFile(value: unknown): GitStatusFile {
  const record = requireRecord(value);
  return { path: requireString(record, "path"), ...optionalField("oldPath", optionalString(record, "oldPath")), index: parseGitFileState(record["index"]), workingTree: parseGitFileState(record["workingTree"]) };
}

function parseGitFileState(value: unknown): GitFileState {
  switch (value) {
    case "unmodified":
    case "modified":
    case "added":
    case "deleted":
    case "renamed":
    case "copied":
    case "untracked":
    case "ignored":
    case "conflicted":
      return value;
    default:
      throw new Error("Invalid git file state");
  }
}

export function parseGitDiffResponse(value: unknown): GitDiffResponse {
  const record = requireRecord(value);
  return { ...optionalField("path", optionalString(record, "path")), staged: requireBoolean(record, "staged"), hash: requireString(record, "hash"), diff: requireString(record, "diff"), truncated: requireBoolean(record, "truncated") };
}

export function parseTerminalInfo(value: unknown): TerminalInfo {
  const record = requireRecord(value);
  return { id: requireString(record, "id"), cwd: requireString(record, "cwd"), name: requireString(record, "name"), createdAt: requireString(record, "createdAt"), exited: requireBoolean(record, "exited"), ...optionalField("exitCode", optionalNumber(record, "exitCode")), ...optionalField("commandRunId", optionalString(record, "commandRunId")) };
}

export function parseTerminalCommandRun(value: unknown): TerminalCommandRun {
  const record = requireRecord(value);
  return {
    id: requireString(record, "id"),
    origin: requireString(record, "origin"),
    projectId: requireString(record, "projectId"),
    workspaceId: requireString(record, "workspaceId"),
    terminalId: requireString(record, "terminalId"),
    title: requireString(record, "title"),
    command: requireString(record, "command"),
    status: parseTerminalCommandRunStatus(record["status"]),
    ...optionalField("exitCode", optionalNumber(record, "exitCode")),
    createdAt: requireString(record, "createdAt"),
    ...optionalField("startedAt", optionalString(record, "startedAt")),
    ...optionalField("completedAt", optionalString(record, "completedAt")),
    metadata: parseStringRecord(record["metadata"], "metadata"),
  };
}

function parseTerminalCommandRunStatus(value: unknown): TerminalCommandRunStatus {
  if (value !== "queued" && value !== "running" && value !== "succeeded" && value !== "failed") throw new Error("Invalid terminal command run status");
  return value;
}

function parseStringRecord(value: unknown, key: string): Record<string, string> {
  const record = requireRecord(value);
  return Object.fromEntries(Object.entries(record).map(([field, fieldValue]) => {
    if (typeof fieldValue !== "string") throw new Error(`Expected string record field: ${key}.${field}`);
    return [field, fieldValue];
  }));
}

export function parseWorkspaceActivity(value: unknown): WorkspaceActivity {
  const record = requireRecord(value);
  return {
    cwd: requireString(record, "cwd"),
    hasSessionActivity: requireBoolean(record, "hasSessionActivity"),
    hasTerminalActivity: requireBoolean(record, "hasTerminalActivity"),
    updatedAt: requireString(record, "updatedAt"),
  };
}

export function parseWorkspaceActivityResponse(value: unknown): WorkspaceActivityResponse {
  const record = requireRecord(value);
  return { workspaces: arrayOf(parseWorkspaceActivity)(record["workspaces"]), generatedAt: requireString(record, "generatedAt") };
}

export function parseUtilityModelSettingsResponse(value: unknown): UtilityModelSettingsResponse {
  const record = requireObjectRecord(value, "utility model settings response");
  const unknownKey = Object.keys(record).find((key) => !isUtilityModelSettingsResponseKey(key));
  if (unknownKey !== undefined) throw new Error(`Invalid utility model settings response field: ${unknownKey}`);
  if (record["contractVersion"] === 1) return parseUtilityModelSettingsResponseV1(record);
  if (record["contractVersion"] === 2) return parseUtilityModelSettingsResponseV2(record);
  throw new Error("Invalid utility model settings contract version");
}

function parseUtilityModelSettingsResponseV1(record: Record<string, unknown>): UtilityModelSettingsResponseV1 {
  const configError = optionalString(record, "configError");
  return {
    contractVersion: 1,
    settings: parseUtilityModelSettingsV1(record["settings"]),
    models: arrayOf(parseUtilityModelOptionV1)(record["models"]),
    slots: parseUtilityModelSlots(record["slots"]),
    valid: requireBoolean(record, "valid"),
    ...optionalField("configError", configError),
  };
}

function parseUtilityModelSettingsResponseV2(record: Record<string, unknown>): UtilityModelSettingsResponseV2 {
  const configError = optionalString(record, "configError");
  return {
    contractVersion: 2,
    settings: parseUtilityModelSettingsV2(record["settings"]),
    models: arrayOf(parseUtilityModelOptionV2)(record["models"]),
    slots: parseUtilityModelSlots(record["slots"]),
    valid: requireBoolean(record, "valid"),
    ...optionalField("configError", configError),
  };
}

function isUtilityModelSettingsResponseKey(key: string): boolean {
  return key === "contractVersion" || key === "settings" || key === "models" || key === "slots" || key === "valid" || key === "configError";
}

function parseUtilityModelSettingsV1(value: unknown): UtilityModelSettings {
  const record = requireObjectRecord(value, "settings");
  const unknownSlot = Object.keys(record).find((key) => !isUtilityModelSlot(key));
  if (unknownSlot !== undefined) throw new Error(`Invalid utility model settings field: settings.${unknownSlot}`);
  return {
    ...optionalField("lightweight", record["lightweight"] === undefined ? undefined : parseTierModelRef(record["lightweight"], "settings.lightweight")),
    ...optionalField("context", record["context"] === undefined ? undefined : parseTierModelRef(record["context"], "settings.context")),
  };
}

function parseUtilityModelSettingsV2(value: unknown): UtilityModelSettings {
  const record = requireObjectRecord(value, "settings");
  const unknownSlot = Object.keys(record).find((key) => !isUtilityModelSlot(key));
  if (unknownSlot !== undefined) throw new Error(`Invalid utility model settings field: settings.${unknownSlot}`);
  return {
    ...optionalField("lightweight", record["lightweight"] === undefined ? undefined : parseUtilityModelBinding(record["lightweight"], "settings.lightweight")),
    ...optionalField("context", record["context"] === undefined ? undefined : parseUtilityModelBinding(record["context"], "settings.context")),
  };
}

function parseUtilityModelBinding(value: unknown, field: string): UtilityModelBinding {
  const record = requireObjectRecord(value, field);
  const unknownKey = Object.keys(record).find((key) => key !== "provider" && key !== "id" && key !== "thinkingLevel");
  if (unknownKey !== undefined) throw new Error(`Invalid utility model binding field: ${field}.${unknownKey}`);
  const provider = requireNonEmptyString(record, "provider");
  const id = requireNonEmptyString(record, "id");
  const thinkingLevel = optionalString(record, "thinkingLevel");
  if (thinkingLevel === undefined) return { provider, id };
  if (!isKnownThinkingLevel(thinkingLevel)) throw new Error(`Invalid utility model thinking level: ${field}.thinkingLevel`);
  return { provider, id, thinkingLevel };
}

function parseUtilityModelOptionV1(value: unknown): UtilityModelOptionV1 {
  const record = requireObjectRecord(value, "models");
  const unknownKey = Object.keys(record).find((key) => key !== "model" && key !== "name");
  if (unknownKey !== undefined) throw new Error(`Invalid utility model option field: models.${unknownKey}`);
  return {
    model: parseTierModelRef(record["model"], "models.model"),
    ...optionalField("name", optionalString(record, "name")),
  };
}

function parseUtilityModelOptionV2(value: unknown): UtilityModelOptionV2 {
  const record = requireObjectRecord(value, "models");
  const unknownKey = Object.keys(record).find((key) => key !== "model" && key !== "name" && key !== "thinkingLevels");
  if (unknownKey !== undefined) throw new Error(`Invalid utility model option field: models.${unknownKey}`);
  const thinkingLevels = arrayOfString(record["thinkingLevels"], "models.thinkingLevels").map((thinkingLevel) => {
    if (!isKnownThinkingLevel(thinkingLevel)) throw new Error("Invalid utility model thinking levels: models.thinkingLevels");
    return thinkingLevel;
  });
  return {
    model: parseTierModelRef(record["model"], "models.model"),
    ...optionalField("name", optionalString(record, "name")),
    thinkingLevels,
  };
}

function parseUtilityModelSlots(value: unknown): Record<UtilityModelSlot, UtilityModelSlotValidation> {
  const record = requireCanonicalUtilityModelSlotRecord(value, "slots");
  return {
    lightweight: parseUtilityModelSlotValidation(record["lightweight"], "slots.lightweight"),
    context: parseUtilityModelSlotValidation(record["context"], "slots.context"),
  };
}

function parseUtilityModelSlotValidation(value: unknown, field: string): UtilityModelSlotValidation {
  const record = requireObjectRecord(value, field);
  const unknownKey = Object.keys(record).find((key) => key !== "valid" && key !== "reason");
  if (unknownKey !== undefined) throw new Error(`Invalid utility model validation field: ${field}.${unknownKey}`);
  return {
    valid: requireBoolean(record, "valid"),
    ...optionalField("reason", optionalString(record, "reason")),
  };
}

function isUtilityModelSlot(value: string): value is UtilityModelSlot {
  return UTILITY_MODEL_SLOTS.some((slot) => slot === value);
}

function requireCanonicalUtilityModelSlotRecord(value: unknown, field: string): Record<string, unknown> {
  const record = requireObjectRecord(value, field);
  const unknownSlot = Object.keys(record).find((key) => !isUtilityModelSlot(key));
  if (unknownSlot !== undefined) throw new Error(`Invalid utility model ${field} field: unknown slot ${unknownSlot}`);
  const missingSlot = UTILITY_MODEL_SLOTS.find((slot) => record[slot] === undefined);
  if (missingSlot !== undefined) throw new Error(`Invalid utility model ${field} field: missing slot ${missingSlot}`);
  return record;
}

export function parseModelTierSettingsResponse(value: unknown): ModelTierSettingsResponse {
  const record = requireRecord(value);
  if (record["contractVersion"] !== 1) throw new Error("Invalid model-tier settings contract version");
  const ladder = record["ladder"] === undefined ? undefined : parseModelTierLadder(record["ladder"]);
  const configError = optionalString(record, "configError");
  return {
    contractVersion: 1,
    ...optionalField("ladder", ladder),
    models: arrayOf(parseModelTierModelOption)(record["models"]),
    rows: parseModelTierRows(record["rows"]),
    valid: requireBoolean(record, "valid"),
    ...optionalField("configError", configError),
  };
}

function parseModelTierLadder(value: unknown): ModelTierLadder {
  const record = requireCanonicalModelTierRecord(value, "ladder");
  return {
    economy: parseModelTierEntry(record["economy"], "ladder.economy"),
    fast: parseModelTierEntry(record["fast"], "ladder.fast"),
    standard: parseModelTierEntry(record["standard"], "ladder.standard"),
    advanced: parseModelTierEntry(record["advanced"], "ladder.advanced"),
    capable: parseModelTierEntry(record["capable"], "ladder.capable"),
    frontier: parseModelTierEntry(record["frontier"], "ladder.frontier"),
  };
}

function parseModelTierEntry(value: unknown, field: string): ModelTierEntry {
  const record = requireObjectRecord(value, field);
  const unknownKey = Object.keys(record).find((key) => key !== "model" && key !== "thinkingLevel");
  if (unknownKey !== undefined) throw new Error(`Invalid model-tier entry field: ${field}.${unknownKey}`);
  return {
    model: parseTierModelRef(record["model"], `${field}.model`),
    thinkingLevel: requireNonEmptyString(record, "thinkingLevel"),
  };
}

function parseTierModelRef(value: unknown, field: string): TierModelRef {
  const record = requireObjectRecord(value, field);
  const unknownKey = Object.keys(record).find((key) => key !== "provider" && key !== "id");
  if (unknownKey !== undefined) throw new Error(`Invalid model reference field: ${field}.${unknownKey}`);
  return {
    provider: requireNonEmptyString(record, "provider"),
    id: requireNonEmptyString(record, "id"),
  };
}

function parseModelTierModelOption(value: unknown): ModelTierModelOption {
  const record = requireObjectRecord(value, "models");
  return {
    model: parseTierModelRef(record["model"], "models.model"),
    ...optionalField("name", optionalString(record, "name")),
    thinkingLevels: arrayOfString(record["thinkingLevels"], "models.thinkingLevels"),
  };
}

function parseModelTierRows(value: unknown): Record<ModelTier, ModelTierRowValidation> {
  const record = requireCanonicalModelTierRecord(value, "rows");
  return {
    economy: parseModelTierRowValidation(record["economy"], "rows.economy"),
    fast: parseModelTierRowValidation(record["fast"], "rows.fast"),
    standard: parseModelTierRowValidation(record["standard"], "rows.standard"),
    advanced: parseModelTierRowValidation(record["advanced"], "rows.advanced"),
    capable: parseModelTierRowValidation(record["capable"], "rows.capable"),
    frontier: parseModelTierRowValidation(record["frontier"], "rows.frontier"),
  };
}

function parseModelTierRowValidation(value: unknown, field: string): ModelTierRowValidation {
  const record = requireObjectRecord(value, field);
  const unknownKey = Object.keys(record).find((key) => key !== "valid" && key !== "reason");
  if (unknownKey !== undefined) throw new Error(`Invalid model-tier row field: ${field}.${unknownKey}`);
  return {
    valid: requireBoolean(record, "valid"),
    ...optionalField("reason", optionalString(record, "reason")),
  };
}

function isModelTier(value: string): value is ModelTier {
  return MODEL_TIERS.some((tier) => tier === value);
}

function requireCanonicalModelTierRecord(value: unknown, field: string): Record<string, unknown> {
  const record = requireObjectRecord(value, field);
  const unknownTier = Object.keys(record).find((key) => !isModelTier(key));
  if (unknownTier !== undefined) throw new Error(`Invalid model-tier ${field} field: unknown tier ${unknownTier}`);
  const missingTier = MODEL_TIERS.find((tier) => record[tier] === undefined);
  if (missingTier !== undefined) throw new Error(`Invalid model-tier ${field} field: missing tier ${missingTier}`);
  return record;
}

function requireObjectRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) throw new Error(`Expected object field: ${field}`);
  return value;
}

export function parsePiWebUiConfigResponse(value: unknown): PiWebUiConfigResponse {
  const record = requireRecord(value);
  return {
    path: requireString(record, "path"),
    exists: requireBoolean(record, "exists"),
    config: parsePiWebUiConfigValues(record["config"]),
    effectiveConfig: parsePiWebUiConfigValues(record["effectiveConfig"]),
    envOverrides: parsePiWebUiConfigEnvOverrides(record["envOverrides"]),
  };
}

function parsePiWebUiConfigValues(value: unknown): PiWebUiConfigValues {
  const record = requireRecord(value);
  return {
    ...optionalField("host", optionalString(record, "host")),
    ...optionalField("port", optionalNumber(record, "port")),
    ...optionalField("allowedHosts", optionalAllowedHosts(record["allowedHosts"])),
    ...optionalField("shortcuts", optionalShortcuts(record["shortcuts"])),
    ...optionalField("plugins", optionalPlugins(record["plugins"])),
    ...optionalField("pathAccess", optionalPathAccess(record["pathAccess"])),
    ...optionalField("uploads", optionalUploads(record["uploads"])),
    ...optionalField("maxUploadBytes", optionalNumber(record, "maxUploadBytes")),
    ...optionalField("agent", optionalAgent(record["agent"])),
    ...optionalField("spawnSessions", optionalBoolean(record, "spawnSessions")),
    ...optionalField("subsessions", optionalBoolean(record, "subsessions")),
  };
}

function optionalAgent(value: unknown): PiWebUiConfigValues["agent"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Array.isArray(value)) throw new Error("Invalid PI WEBUI agent field");
  return {
    ...optionalField("command", optionalString(value, "command")),
    ...optionalField("dir", optionalString(value, "dir")),
  };
}

function optionalAllowedHosts(value: unknown): PiWebUiConfigValues["allowedHosts"] | undefined {
  if (value === undefined) return undefined;
  if (value === true) return true;
  if (isStringArray(value)) return value;
  throw new Error("Invalid PI WEBUI allowedHosts field");
}

function optionalPathAccess(value: unknown): PiWebUiConfigValues["pathAccess"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Invalid PI WEBUI pathAccess field");
  const allowedPaths = value["allowedPaths"];
  return {
    ...optionalField("allowedPaths", optionalStringArray(allowedPaths, "pathAccess.allowedPaths")),
  };
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (isNonEmptyStringArray(value)) return value;
  throw new Error(`Invalid PI WEBUI ${field} field`);
}

function optionalUploads(value: unknown): PiWebUiConfigValues["uploads"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Array.isArray(value)) throw new Error("Invalid PI WEBUI uploads field");
  return {
    ...optionalField("defaultFolder", optionalString(value, "defaultFolder")),
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "");
}

function optionalShortcuts(value: unknown): PiWebUiShortcutConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Array.isArray(value)) throw new Error("Invalid PI WEBUI shortcuts field");
  return Object.fromEntries(Object.entries(value).map(([actionId, shortcut]) => {
    if (shortcut !== null && (typeof shortcut !== "string" || shortcut === "")) throw new Error("Invalid PI WEBUI shortcut field");
    return [actionId, shortcut];
  }));
}

function optionalPlugins(value: unknown): PiWebUiPluginConfigMap | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Array.isArray(value)) throw new Error("Invalid PI WEBUI plugins field");
  return Object.fromEntries(Object.entries(value).map(([pluginId, config]) => {
    if (!isRecord(config) || Array.isArray(config)) throw new Error("Invalid PI WEBUI plugin config field");
    const enabled = config["enabled"];
    if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("Invalid PI WEBUI plugin enabled field");
    const settings = config["settings"];
    if (settings !== undefined && (!isRecord(settings) || Array.isArray(settings))) throw new Error("Invalid PI WEBUI plugin settings field");
    return [pluginId, config];
  }));
}

function parsePiWebUiConfigEnvOverrides(value: unknown): PiWebUiConfigEnvOverrides {
  const record = requireRecord(value);
  return {
    host: requireBoolean(record, "host"),
    port: requireBoolean(record, "port"),
    allowedHosts: requireBoolean(record, "allowedHosts"),
    spawnSessions: requireBoolean(record, "spawnSessions"),
    subsessions: requireBoolean(record, "subsessions"),
    agentCommand: optionalBoolean(record, "agentCommand") ?? false,
    agentDir: optionalBoolean(record, "agentDir") ?? false,
    ...optionalAgentDirSource(record),
    agentSessionDir: optionalBoolean(record, "agentSessionDir") ?? false,
  };
}

function optionalAgentDirSource(record: Record<string, unknown>): { agentDirSource?: PiWebUiAgentDirEnvSource } {
  const value = record["agentDirSource"];
  if (value === undefined) return {};
  if (value !== "pi-webui" && value !== "pi-compatibility") throw new Error("Invalid PI WEBUI agentDirSource field");
  return { agentDirSource: value };
}

export function parsePiPackagesResponse(value: unknown): PiPackagesResponse {
  const record = requireRecord(value);
  return { packages: arrayOf(parsePiPackageInfo)(record["packages"]) };
}

export function parsePiPackageMutationResponse(value: unknown): PiPackageMutationResponse {
  const record = requireRecord(value);
  const source = optionalString(record, "source");
  const scope = record["scope"] === undefined ? undefined : parsePiPackageScope(record["scope"]);
  const removed = parseOptionalBoolean(record["removed"], "removed");
  return {
    action: parsePiPackageMutationAction(record["action"]),
    ...optionalField("source", source),
    ...optionalField("scope", scope),
    ...optionalField("removed", removed),
    packages: arrayOf(parsePiPackageInfo)(record["packages"]),
  };
}

function parsePiPackageInfo(value: unknown): PiPackageInfo {
  const record = requireRecord(value);
  return {
    source: requireString(record, "source"),
    scope: parsePiPackageScope(record["scope"]),
    filtered: requireBoolean(record, "filtered"),
    ...optionalField("installedPath", optionalString(record, "installedPath")),
  };
}

function parsePiPackageScope(value: unknown): PiPackageScope {
  if (value !== "user" && value !== "project") throw new Error("Invalid Pi package scope");
  return value;
}

function parsePiPackageMutationAction(value: unknown): PiPackageMutationAction {
  if (value !== "install" && value !== "remove" && value !== "update") throw new Error("Invalid Pi package mutation action");
  return value;
}

export function parsePiPackagePluginsResponse(value: unknown): PiPackagePluginsResponse {
  const record = requireRecord(value);
  return {
    packages: arrayOf(parsePiPackagePluginInfo)(record["packages"]),
    totals: parsePiPackagePluginResourceCounts(record["totals"]),
    diagnostics: arrayOf(parsePiPackagePluginDiagnostic)(record["diagnostics"]),
  };
}

function parsePiPackagePluginInfo(value: unknown): PiPackagePluginInfo {
  const record = requireRecord(value);
  return {
    source: requireString(record, "source"),
    scope: parsePiPackagePluginScope(record["scope"]),
    filtered: requireBoolean(record, "filtered"),
    disabled: requireBoolean(record, "disabled"),
    ...optionalField("installedPath", optionalString(record, "installedPath")),
    ...optionalField("packageName", optionalString(record, "packageName")),
    ...optionalField("version", optionalString(record, "version")),
    ...optionalField("configuredVersion", optionalString(record, "configuredVersion")),
    counts: parsePiPackagePluginResourceCounts(record["counts"]),
    resources: arrayOf(parsePiPackagePluginResourceInfo)(record["resources"]),
    status: parsePiPackagePluginStatus(record["status"]),
  };
}

function parsePiPackagePluginScope(value: unknown): PiPackagePluginScope {
  if (value !== "global" && value !== "project") throw new Error("Invalid Pi package plugin scope");
  return value;
}

function parsePiPackagePluginStatus(value: unknown): PiPackagePluginStatus {
  if (value !== "loaded" && value !== "installed" && value !== "missing" && value !== "disabled") {
    throw new Error("Invalid Pi package plugin status");
  }
  return value;
}

function parsePiPackagePluginResourceCounts(value: unknown): PiPackagePluginResourceCounts {
  const record = requireRecord(value);
  return {
    extensions: requireNumber(record, "extensions"),
    skills: requireNumber(record, "skills"),
    prompts: requireNumber(record, "prompts"),
    themes: requireNumber(record, "themes"),
  };
}

function parsePiPackagePluginResourceInfo(value: unknown): PiPackagePluginResourceInfo {
  const record = requireRecord(value);
  return {
    kind: parsePiPackagePluginResourceKind(record["kind"]),
    name: requireString(record, "name"),
    path: requireString(record, "path"),
    relativePath: requireString(record, "relativePath"),
  };
}

function parsePiPackagePluginResourceKind(value: unknown): PiPackagePluginResourceKind {
  if (value !== "extension" && value !== "skill" && value !== "prompt" && value !== "theme") {
    throw new Error("Invalid Pi package plugin resource kind");
  }
  return value;
}

function parsePiPackagePluginDiagnostic(value: unknown): PiPackagePluginDiagnostic {
  const record = requireRecord(value);
  const type = record["type"];
  if (type !== "warning" && type !== "error") throw new Error("Invalid Pi package plugin diagnostic type");
  return {
    type,
    message: requireString(record, "message"),
    ...optionalField("source", optionalString(record, "source")),
    ...optionalField("path", optionalString(record, "path")),
  };
}

export function parsePiWebUiPluginsResponse(value: unknown): PiWebUiPluginsResponse {
  const record = requireRecord(value);
  return { plugins: arrayOf(parsePiWebUiPluginInfo)(record["plugins"]) };
}

function parsePiWebUiPluginInfo(value: unknown): PiWebUiPluginInfo {
  const record = requireRecord(value);
  return {
    id: requireString(record, "id"),
    module: requireString(record, "module"),
    source: requireString(record, "source"),
    scope: parsePiWebUiPluginScope(record["scope"]),
    machineSpecific: parseOptionalBoolean(record["machineSpecific"], "machineSpecific") ?? false,
    enabled: requireBoolean(record, "enabled"),
  };
}

function parsePiWebUiPluginScope(value: unknown): PiWebUiPluginScope {
  if (value !== "bundled" && value !== "local" && value !== "user" && value !== "project") throw new Error("Invalid PI WEBUI plugin scope");
  return value;
}

function parseOptionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Expected optional boolean field: ${key}`);
  return value;
}

export function parsePiWebUiStatusResponse(value: unknown): PiWebUiStatusResponse {
  const record = requireRecord(value);
  return {
    packageName: requireString(record, "packageName"),
    generatedAt: requireString(record, "generatedAt"),
    components: parsePiWebUiComponents(record["components"]),
    release: parsePiWebUiReleaseStatus(record["release"]),
    commands: parsePiWebUiCommands(record["commands"]),
    messages: arrayOf(parsePiWebUiStatusMessage)(record["messages"]),
  };
}

export function parsePiWebUiRuntimeResponse(value: unknown): PiWebUiRuntimeResponse {
  const record = requireRecord(value);
  return {
    packageName: requireString(record, "packageName"),
    generatedAt: requireString(record, "generatedAt"),
    components: parsePiWebUiRuntimeComponents(record["components"]),
    capabilities: parsePiWebUiCapabilities(record["capabilities"]),
  };
}

function parsePiWebUiComponents(value: unknown): PiWebUiStatusResponse["components"] {
  const record = requireRecord(value);
  return { web: parsePiWebUiComponentStatus(record["web"]), sessiond: parsePiWebUiComponentStatus(record["sessiond"]) };
}

function parsePiWebUiRuntimeComponents(value: unknown): PiWebUiRuntimeResponse["components"] {
  const record = requireRecord(value);
  return { web: parsePiWebUiRuntimeComponent(record["web"]), sessiond: parsePiWebUiRuntimeComponent(record["sessiond"]) };
}

function parsePiWebUiRuntimeComponent(value: unknown): PiWebUiRuntimeComponent {
  const record = requireRecord(value);
  const component = parsePiWebUiServiceComponent(record["component"]);
  const activeAgentProfileValue = record["activeAgentProfile"];
  const activeAgentProfile = activeAgentProfileValue === undefined ? undefined : parseActiveAgentProfileDescriptor(activeAgentProfileValue);
  if (activeAgentProfileValue !== undefined && (component !== "sessiond" || activeAgentProfile === undefined)) throw new Error("Invalid active agent profile descriptor");
  return {
    component,
    label: requireString(record, "label"),
    ...optionalField("runtimeVersion", optionalString(record, "runtimeVersion")),
    available: requireBoolean(record, "available"),
    capabilities: parsePiWebUiCapabilities(record["capabilities"]),
    ...optionalField("activeAgentProfile", activeAgentProfile),
    ...optionalField("error", optionalString(record, "error")),
  };
}

function parsePiWebUiComponentStatus(value: unknown): PiWebUiComponentStatus {
  const record = requireRecord(value);
  return {
    component: parsePiWebUiServiceComponent(record["component"]),
    label: requireString(record, "label"),
    ...optionalField("runtimeVersion", optionalString(record, "runtimeVersion")),
    ...optionalField("installedVersion", optionalString(record, "installedVersion")),
    stale: requireBoolean(record, "stale"),
    available: requireBoolean(record, "available"),
    ...optionalField("installation", optionalPiWebUiInstallationInfo(record["installation"])),
    ...optionalField("error", optionalString(record, "error")),
  };
}

function optionalPiWebUiInstallationInfo(value: unknown): PiWebUiInstallationInfo | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value);
  const kind = requireString(record, "kind");
  if (kind !== "pi-package" && kind !== "npm-global" && kind !== "local" && kind !== "docker" && kind !== "unknown") throw new Error("Invalid PI WEBUI installation kind");
  const scope = record["scope"];
  if (scope !== undefined && scope !== "user" && scope !== "project") throw new Error("Invalid PI WEBUI installation scope");
  const dockerMode = record["dockerMode"];
  if (dockerMode !== undefined && dockerMode !== "runtime" && dockerMode !== "dev") throw new Error("Invalid PI WEBUI Docker mode");
  return {
    kind,
    ...optionalField("path", optionalString(record, "path")),
    ...optionalField("source", optionalString(record, "source")),
    ...(scope === undefined ? {} : { scope }),
    ...optionalField("npmRoot", optionalString(record, "npmRoot")),
    ...(dockerMode === undefined ? {} : { dockerMode }),
  };
}

function parsePiWebUiReleaseStatus(value: unknown): PiWebUiReleaseStatus {
  const record = requireRecord(value);
  return {
    packageName: requireString(record, "packageName"),
    ...optionalField("latestVersion", optionalString(record, "latestVersion")),
    updateAvailable: requireBoolean(record, "updateAvailable"),
    ...optionalField("checkedAt", optionalString(record, "checkedAt")),
    ...(record["skipped"] === true ? { skipped: true } : {}),
    ...optionalField("error", optionalString(record, "error")),
  };
}

function parsePiWebUiCommands(value: unknown): PiWebUiStatusResponse["commands"] {
  const record = requireRecord(value);
  return {
    ...optionalField("update", optionalString(record, "update")),
    ...optionalField("restart", optionalString(record, "restart")),
    ...optionalField("restartWeb", optionalString(record, "restartWeb")),
    ...optionalField("restartSessiond", optionalString(record, "restartSessiond")),
    ...optionalField("status", optionalString(record, "status")),
  };
}

function parsePiWebUiStatusMessage(value: unknown): PiWebUiStatusMessage {
  const record = requireRecord(value);
  return {
    id: requireString(record, "id"),
    severity: parsePiWebUiStatusSeverity(record["severity"]),
    title: requireString(record, "title"),
    body: requireString(record, "body"),
    ...optionalField("command", optionalString(record, "command")),
  };
}

function parsePiWebUiServiceComponent(value: unknown): PiWebUiServiceComponent {
  if (value !== "web" && value !== "sessiond") throw new Error("Invalid PI WEBUI service component");
  return value;
}

function parsePiWebUiCapabilities(value: unknown): PiWebUiCapability[] {
  const capabilities = parseKnownPiWebUiCapabilities(value);
  if (capabilities === undefined) throw new Error("Invalid PI WEBUI capabilities");
  return capabilities;
}

function parsePiWebUiStatusSeverity(value: unknown): PiWebUiStatusSeverity {
  if (value !== "info" && value !== "warning" && value !== "error") throw new Error("Invalid PI WEBUI status severity");
  return value;
}

export function parseCommandResult(value: unknown): CommandResult {
  const record = requireRecord(value);
  const type = requireString(record, "type");
  if (type === "unsupported") return { type, message: requireString(record, "message") };
  if (type === "select") return { type, requestId: requireString(record, "requestId"), title: requireString(record, "title"), options: arrayOf(parseCommandOption)(record["options"]) };
  if (type === "tree") return { type, tree: parseSessionTreeSnapshot(record["tree"]) };
  if (type === "done") return { type, ...optionalField("message", optionalString(record, "message")), ...optionalSession(record["session"]), ...optionalField("promptDraft", optionalString(record, "promptDraft")) };
  throw new Error("Invalid command result type");
}

export function parseSessionTreeSnapshot(value: unknown): SessionTreeSnapshot {
  const record = requireRecord(value);
  const nodes = arrayOf(parseSessionTreeNode)(record["nodes"]);
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (nodeIds.size !== nodes.length) throw new Error("Duplicate session tree node id");
  const activeLeafId = requireNullableString(record, "activeLeafId");
  if (activeLeafId !== null && !nodeIds.has(activeLeafId)) throw new Error("Invalid session tree activeLeafId");
  return {
    nodes,
    activeLeafId,
    activePathIds: arrayOfNonBlankString(record["activePathIds"], "activePathIds"),
  };
}

function parseSessionTreeNode(value: unknown): SessionTreeNode {
  const record = requireRecord(value);
  return {
    id: requireNonBlankString(record, "id"),
    parentId: requireNullableString(record, "parentId"),
    kind: parseSessionTreeNodeKind(record["kind"]),
    summary: requireString(record, "summary"),
    ...optionalField("timestamp", optionalString(record, "timestamp")),
    ...optionalField("label", optionalString(record, "label")),
  };
}

function parseSessionTreeNodeKind(value: unknown): SessionTreeNodeKind {
  switch (value) {
    case "user":
    case "assistant":
    case "tool-result":
    case "bash":
    case "custom-message":
    case "compaction":
    case "branch-summary":
    case "model-change":
    case "thinking-level-change":
    case "session-info":
    case "label":
    case "custom":
    case "other":
      return value;
    default:
      throw new Error("Invalid session tree node kind");
  }
}

export function parseSessionTreeNavigateResult(value: unknown): SessionTreeNavigateResult {
  const record = requireRecord(value);
  const cancelled = requireBoolean(record, "cancelled");
  if (Object.hasOwn(record, "summaryEntry")) throw new Error("Invalid session tree navigation result field: summaryEntry");
  if (cancelled) {
    rejectResponseField(record, "editorText", "session tree cancellation result");
    const aborted = record["aborted"];
    if (aborted !== undefined && typeof aborted !== "boolean") throw new Error("Expected optional boolean field: aborted");
    return { cancelled, ...(aborted === undefined ? {} : { aborted }) };
  }
  rejectResponseField(record, "aborted", "session tree navigation result");
  return { cancelled, ...optionalField("editorText", optionalString(record, "editorText")) };
}

export function parseSessionMessageForkResult(value: unknown): SessionMessageForkResult {
  const record = requireRecord(value);
  const cancelled = requireBoolean(record, "cancelled");
  if (cancelled) {
    rejectResponseField(record, "session", "session fork cancellation result");
    return { cancelled: true };
  }
  return { cancelled: false, session: parseSessionInfo(record["session"]) };
}

function rejectResponseField(record: Record<string, unknown>, field: string, label: string): void {
  if (Object.hasOwn(record, field)) throw new Error(`Invalid ${label} field: ${field}`);
}

function requireNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value !== null && typeof value !== "string") throw new Error(`Expected string or null field: ${key}`);
  if (typeof value === "string" && value.trim() === "") throw new Error(`Expected non-blank string or null field: ${key}`);
  return value;
}

function requireNonBlankString(record: Record<string, unknown>, key: string): string {
  const value = requireString(record, key);
  if (value.trim() === "") throw new Error(`Expected non-blank string field: ${key}`);
  return value;
}

function arrayOfNonBlankString(value: unknown, key: string): string[] {
  const strings = arrayOfString(value, key);
  if (strings.some((item) => item.trim() === "")) throw new Error(`Expected non-blank string array field: ${key}`);
  return strings;
}

function parseCommandOption(value: unknown): CommandOption {
  const record = requireRecord(value);
  return { value: requireString(record, "value"), label: requireString(record, "label"), ...optionalField("description", optionalString(record, "description")) };
}

function optionalSession(value: unknown): Pick<Extract<CommandResult, { type: "done" }>, "session"> | object {
  return value === undefined ? {} : { session: parseSessionInfo(value) };
}

export function parseAccepted(value: unknown): { accepted: true } {
  const record = requireRecord(value);
  if (record["accepted"] !== true) throw new Error("Expected accepted response");
  return { accepted: true };
}

export function parseSavedAttachments(value: unknown): SavedPromptAttachment[] {
  const record = requireRecord(value);
  return arrayOf(parseSavedAttachment)(record["attachments"]);
}

function parseSavedAttachment(value: unknown): SavedPromptAttachment {
  const record = requireRecord(value);
  return { path: requireString(record, "path"), mimeType: requireString(record, "mimeType"), size: requireNumber(record, "size") };
}

export function parseClosed(value: unknown): { closed: true } {
  const record = requireRecord(value);
  if (record["closed"] !== true) throw new Error("Expected closed response");
  return { closed: true };
}

export function parseAborted(value: unknown): { aborted: true } {
  const record = requireRecord(value);
  if (record["aborted"] !== true) throw new Error("Expected aborted response");
  return { aborted: true };
}

export function parseStopped(value: unknown): { stopped: true } {
  const record = requireRecord(value);
  if (record["stopped"] !== true) throw new Error("Expected stopped response");
  return { stopped: true };
}

export function parseArchived(value: unknown): ArchiveSessionsResponse {
  const record = requireRecord(value);
  if (record["archived"] !== true) throw new Error("Expected archived response");
  const sessionIds = record["sessionIds"] === undefined ? undefined : arrayOfString(record["sessionIds"], "sessionIds");
  const archivedCount = optionalNumber(record, "archivedCount");
  const skippedAlreadyArchivedCount = optionalNumber(record, "skippedAlreadyArchivedCount");
  return {
    archived: true,
    ...(sessionIds === undefined ? {} : { sessionIds }),
    ...(archivedCount === undefined ? {} : { archivedCount }),
    ...(skippedAlreadyArchivedCount === undefined ? {} : { skippedAlreadyArchivedCount }),
  };
}

export function parseRestored(value: unknown): { restored: true } {
  const record = requireRecord(value);
  if (record["restored"] !== true) throw new Error("Expected restored response");
  return { restored: true };
}

export function parseDeleted(value: unknown): { deleted: true } {
  const record = requireRecord(value);
  if (record["deleted"] !== true) throw new Error("Expected deleted response");
  return { deleted: true };
}

export function parseDetached(value: unknown): { detached: true } {
  const record = requireRecord(value);
  if (record["detached"] !== true) throw new Error("Expected detached response");
  return { detached: true };
}

export function parseReloaded(value: unknown): { reloaded: true } {
  const record = requireRecord(value);
  if (record["reloaded"] !== true) throw new Error("Expected reloaded response");
  return { reloaded: true };
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Invalid PI WEBUI ${key} field`);
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error(`Expected optional number field: ${key}`);
  return value;
}

function numberOrNull(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "number") throw new Error(`Expected number|null field: ${key}`);
  return value;
}

function optionalField(key: string, value: unknown): object {
  return value === undefined ? {} : { [key]: value };
}

export function parseSystemMetricsResponse(value: unknown): SystemMetricsResponse {
  const record = requireRecord(value);
  const memory = requireRecord(record["memory"]);
  const network = requireRecord(record["network"]);
  return {
    generatedAt: requireString(record, "generatedAt"),
    memory: {
      totalBytes: requireNumber(memory, "totalBytes"),
      usedBytes: requireNumber(memory, "usedBytes"),
      freeBytes: requireNumber(memory, "freeBytes"),
      usagePercent: requireNumber(memory, "usagePercent"),
    },
    network: buildSystemNetworkMetrics(network),
  };
}

export function parseSystemInfoResponse(value: unknown): SystemInfoResponse {
  const record = requireRecord(value);
  const os = requireRecord(record["os"]);
  const cpu = requireRecord(record["cpu"]);
  const memory = requireRecord(record["memory"]);
  const network = requireRecord(record["network"]);

  const gpuRaw = record["gpu"];
  let gpu: SystemInfoResponse["gpu"] | undefined;
  if (gpuRaw !== undefined && gpuRaw !== null) {
    const gpuRecord = requireRecord(gpuRaw);
    const gpuInfo: SystemInfoResponse["gpu"] = { name: requireString(gpuRecord, "name") };
    const driverVer = optionalString(gpuRecord, "driverVersion");
    if (driverVer !== undefined) gpuInfo.driverVersion = driverVer;
    const memTotal = optionalNumber(gpuRecord, "memoryTotalBytes");
    if (memTotal !== undefined) gpuInfo.memoryTotalBytes = memTotal;
    const memUsed = optionalNumber(gpuRecord, "memoryUsedBytes");
    if (memUsed !== undefined) gpuInfo.memoryUsedBytes = memUsed;
    const utilPct = optionalNumber(gpuRecord, "utilizationPercent");
    if (utilPct !== undefined) gpuInfo.utilizationPercent = utilPct;
    const tempC = optionalNumber(gpuRecord, "temperatureCelsius");
    if (tempC !== undefined) gpuInfo.temperatureCelsius = tempC;
    gpu = gpuInfo;
  }

  const result: SystemInfoResponse = {
    generatedAt: requireString(record, "generatedAt"),
    os: {
      platform: requireString(os, "platform"),
      release: requireString(os, "release"),
      arch: requireString(os, "arch"),
      uptimeSeconds: requireNumber(os, "uptimeSeconds"),
    },
    cpu: {
      model: requireString(cpu, "model"),
      cores: requireNumber(cpu, "cores"),
      usagePercent: requireNumber(cpu, "usagePercent"),
    },
    memory: {
      totalBytes: requireNumber(memory, "totalBytes"),
      usedBytes: requireNumber(memory, "usedBytes"),
      freeBytes: requireNumber(memory, "freeBytes"),
      usagePercent: requireNumber(memory, "usagePercent"),
    },
    network: buildSystemNetworkInfo(network),
  };
  if (gpu !== undefined) result.gpu = gpu;
  const piVer = optionalString(record, "piVersion");
  if (piVer !== undefined) result.piVersion = piVer;
  const webUiVer = optionalString(record, "piWebUiVersion");
  if (webUiVer !== undefined) result.piWebUiVersion = webUiVer;
  return result;
}

function buildSystemNetworkInfo(network: Record<string, unknown>): SystemInfoResponse["network"] {
  const result: SystemInfoResponse["network"] = {
    hostname: requireString(network, "hostname"),
    localIpv4Addresses: arrayOfString(network["localIpv4Addresses"], "localIpv4Addresses"),
    ...buildSystemNetworkMetrics(network),
  };
  const ipv4 = optionalString(network, "publicIpv4");
  if (ipv4 !== undefined) result.publicIpv4 = ipv4;
  const ipv6 = optionalString(network, "publicIpv6");
  if (ipv6 !== undefined) result.publicIpv6 = ipv6;
  return result;
}

function buildSystemNetworkMetrics(network: Record<string, unknown>): SystemNetworkMetrics {
  const result: SystemNetworkMetrics = {};
  const downloadSpeed = optionalNumber(network, "downloadSpeedBytesPerSecond");
  if (downloadSpeed !== undefined) result.downloadSpeedBytesPerSecond = downloadSpeed;
  const uploadSpeed = optionalNumber(network, "uploadSpeedBytesPerSecond");
  if (uploadSpeed !== undefined) result.uploadSpeedBytesPerSecond = uploadSpeed;
  return result;
}

function parseProjectUsageTotals(value: unknown): ProjectUsageTotals {
  const record = requireRecord(value);
  return {
    input: requireNumber(record, "input"),
    output: requireNumber(record, "output"),
    cacheRead: requireNumber(record, "cacheRead"),
    cacheWrite: requireNumber(record, "cacheWrite"),
    cost: requireNumber(record, "cost"),
    sessionCount: requireNumber(record, "sessionCount"),
  };
}

export function parseProjectUsageResponse(value: unknown): ProjectUsageResponse {
  const record = requireRecord(value);
  const buckets = requireRecord(record["buckets"]);
  return {
    projectPath: requireString(record, "projectPath"),
    buckets: {
      live: parseProjectUsageTotals(buckets["live"]),
      retired: parseProjectUsageTotals(buckets["retired"]),
      archived: parseProjectUsageTotals(buckets["archived"]),
    },
    total: parseProjectUsageTotals(record["total"]),
    generatedAt: requireString(record, "generatedAt"),
  };
}
