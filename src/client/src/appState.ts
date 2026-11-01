import type { AuthProviderOption, CommandOption, CommandResult, FileContentResponse, FileTreeEntry, GitDiffResponse, GitStatusResponse, Machine, MachineHealth, MachineRuntime, OAuthFlowState, PiWebUiStatusResponse, Project, QueuedSessionMessage, SessionActivity, SessionInfo, SessionStatus, SessionTreeSnapshot, TerminalCommandRun, Workspace, WorkspaceActivity } from "./api";
import type { LearnedSkill, MemoryEntry, SessionExtensionEntry, SessionModelPolicyResponse } from "../../shared/apiTypes";
import type { ChatLine } from "./components/shared";
import type { QualifiedContributionId } from "./plugins/ids";
import type { SelectedSessionNotificationInbox } from "./sessionNotifications";
import type { WorkspaceUploadBatchState } from "./workspaceUploadState";

/** The workspace whose session list a remote read is loading. */
export interface SessionListLoadScope {
  machineId: string;
  projectId: string;
  workspaceId: string;
  workspacePath: string;
}

/**
 * Provenance for one in-flight remote session-list read.
 *
 * `phase` distinguishes the budgeted wait for an upstream response from the
 * unbounded body transfer after it started, so the UI can explain what the
 * timeout actually covers.
 */
export interface SessionListLoad {
  owner: "selection" | "catalog-fallback" | "retry";
  scope: SessionListLoadScope;
  startedAt: number;
  budgetMs: number;
  phase: "waiting" | "receiving";
}

/** A selected remote session list that ended with a typed failure, not an error banner. */
export interface SessionListFailure {
  scope: { machineId: string; machineName: string; projectId: string; workspaceId: string };
  kind: "timeout" | "transfer";
  elapsedMs: number;
  budgetMs: number;
}

export interface AppState {
  machines: Machine[];
  selectedMachine: Machine | undefined;
  isLoadingMachines: boolean;
  machineStatuses: Record<string, MachineHealth>;
  machineRuntimes: Record<string, MachineRuntime>;
  projects: Project[];
  workspaces: Workspace[];
  sessions: SessionInfo[];
  /** Session records across the selected project's known workspaces, used only for cross-workspace hierarchy display. */
  projectSessions: SessionInfo[];
  messages: ChatLine[];
  /**
   * Extension-owned entries for the selected session, oldest first.
   *
   * Pi extensions persist their own state as `custom` session entries and Pi keeps those out of
   * the model context. PI WEBUI forwards them so a plugin can render state owned by an
   * extension; the entries are otherwise unused by the application.
   */
  sessionExtensionEntries: SessionExtensionEntry[];
  messagePageStart: number;
  messagePageEnd: number;
  messagePageTotal: number;
  isLoadingEarlierMessages: boolean;
  /** Sessions with a prompt upload in flight, keyed by sessionId (client-owned). */
  sendingPrompts: Record<string, true>;
  /** Client-side queued sends waiting for a just-created backend session, keyed by sessionId. */
  clientQueuedSessionMessages: Record<string, QueuedSessionMessage[]>;
  /** Client-initiated session creation requests waiting for the server. */
  startingSessionCount: number;
  isLoadingProjects: boolean;
  isLoadingWorkspaces: boolean;
  /** True while the currently selected workspace's session list is loading. */
  isLoadingSessions: boolean;
  /** Provenance for the remote selected session list currently being read. */
  sessionListLoad: SessionListLoad | undefined;
  /** Typed failure record for the selected session list, used by the retry notice. */
  sessionListFailure: SessionListFailure | undefined;
  selectedProject: Project | undefined;
  selectedWorkspace: Workspace | undefined;
  selectedSession: SessionInfo | undefined;
  status: SessionStatus | undefined;
  activity: SessionActivity | undefined;
  /** Thinking levels available for the selected session's current model. */
  availableThinkingLevels: readonly string[];
  /** Confirmed policy inspection result for the selected session, from its dedicated endpoint. */
  modelPolicy: SessionModelPolicyResponse | undefined;
  isLoadingModelPolicy: boolean;
  isSavingModelPolicy: boolean;
  modelPolicyError: string | undefined;
  sessionStatuses: Record<string, SessionStatus>;
  sessionActivities: Record<string, SessionActivity>;
  workspaceActivities: Record<string, WorkspaceActivity>;
  machineActivities: Record<string, Record<string, WorkspaceActivity>>;
  /** Authoritative projection plus browser-local optimistic overlays for the selected inbox. */
  selectedNotificationInbox: SelectedSessionNotificationInbox | undefined;
  workspacesByProjectId: Record<string, Workspace[]>;
  workspaceDeletionRuns: Record<string, TerminalCommandRun>;
  commandDialog: Extract<CommandResult, { type: "select" }> | undefined;
  treeDialog: SessionTreeSnapshot | undefined;
  modelDialog: { title: string; options: CommandOption[]; selectedValue?: string; source?: "starter" } | undefined;
  thinkingDialog: { title: string; options: CommandOption[]; selectedValue?: string; source?: "starter" } | undefined;
  themeDialog: { title: string; options: CommandOption[]; selectedValue?: string } | undefined;
  authDialog: AuthDialogState | undefined;
  actionPaletteOpen: boolean;
  projectDialogOpen: boolean;
  machineDialogOpen: boolean;
  workspaceTool: QualifiedContributionId;
  mainView: "navigation" | "chat" | QualifiedContributionId;
  fileTree: FileTreeEntry[];
  expandedDirs: Record<string, FileTreeEntry[]>;
  selectedFilePath: string | undefined;
  selectedFileContent: FileContentResponse | undefined;
  selectedFileTopLine?: number | undefined;
  fileTreeStale: boolean;
  /** Manual workspace file upload batches, keyed by client-owned batch id. */
  workspaceUploadBatches: Record<string, WorkspaceUploadBatchState>;
  gitStatus: GitStatusResponse | undefined;
  selectedDiffPath: string | undefined;
  selectedDiff: GitDiffResponse | undefined;
  selectedStagedDiff: GitDiffResponse | undefined;
  gitStale: boolean;
  memory: MemoryWorkspaceState;
  learnedSkills: LearnedSkillsWorkspaceState;
  activeTerminalCount: number;
  selectedTerminalId: string | undefined;
  piWebUiStatus: PiWebUiStatusResponse | undefined;
  error: string;
}

export type LearnedSkillsWorkspaceState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | {
      kind: "data";
      globalSkills: LearnedSkill[];
      projectSkills: LearnedSkill[];
      projectUnavailableMessage?: string;
      refreshError?: string;
    }
  | { kind: "error"; message: string };

export type MemoryWorkspaceState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | {
      kind: "data";
      globalEntries: MemoryEntry[];
      projectEntries: MemoryEntry[];
      projectUnavailableMessage?: string;
      refreshError?: string;
    }
  | { kind: "error"; message: string };

export type AuthDialogState =
  | { step: "method" }
  | { step: "providers"; mode: "login"; authType?: "oauth" | "api_key"; providers: AuthProviderOption[] }
  | { step: "apiKey"; provider: AuthProviderOption; value: string; saving?: boolean; error?: string }
  | { step: "oauth"; flow: OAuthFlowState; machineId: string; responding?: boolean; inputValue?: string; error?: string }
  | { step: "logout"; providers: AuthProviderOption[] };

export type WorkspaceScopedStateReset = Pick<AppState,
  | "sessions"
  | "projectSessions"
  | "clientQueuedSessionMessages"
  | "startingSessionCount"
  | "isLoadingSessions"
  | "sessionListLoad"
  | "sessionListFailure"
  | "selectedNotificationInbox"
  | "treeDialog"
  | "fileTree"
  | "expandedDirs"
  | "selectedFilePath"
  | "selectedFileContent"
  | "selectedFileTopLine"
  | "fileTreeStale"
  | "gitStatus"
  | "selectedDiffPath"
  | "selectedDiff"
  | "selectedStagedDiff"
  | "gitStale"
  | "memory"
  | "learnedSkills"
  | "selectedTerminalId"
  | "error"
>;

export function resetWorkspaceScopedState(): WorkspaceScopedStateReset {
  return {
    sessions: [],
    projectSessions: [],
    clientQueuedSessionMessages: {},
    startingSessionCount: 0,
    isLoadingSessions: false,
    sessionListLoad: undefined,
    sessionListFailure: undefined,
    selectedNotificationInbox: undefined,
    treeDialog: undefined,
    fileTree: [],
    expandedDirs: {},
    selectedFilePath: undefined,
    selectedFileContent: undefined,
    selectedFileTopLine: undefined,
    fileTreeStale: false,
    gitStatus: undefined,
    selectedDiffPath: undefined,
    selectedDiff: undefined,
    selectedStagedDiff: undefined,
    gitStale: false,
    memory: { kind: "loading" },
    learnedSkills: { kind: "loading" },
    selectedTerminalId: undefined,
    error: "",
  };
}

export function initialAppState(): AppState {
  return {
    machines: [],
    selectedMachine: undefined,
    isLoadingMachines: false,
    machineStatuses: {},
    machineRuntimes: {},
    projects: [],
    workspaces: [],
    sessions: [],
    projectSessions: [],
    messages: [],
    sessionExtensionEntries: [],
    messagePageStart: 0,
    messagePageEnd: 0,
    messagePageTotal: 0,
    isLoadingEarlierMessages: false,
    sendingPrompts: {},
    clientQueuedSessionMessages: {},
    startingSessionCount: 0,
    isLoadingProjects: false,
    isLoadingWorkspaces: false,
    isLoadingSessions: false,
    sessionListLoad: undefined,
    sessionListFailure: undefined,
    selectedProject: undefined,
    selectedWorkspace: undefined,
    selectedSession: undefined,
    status: undefined,
    activity: undefined,
    availableThinkingLevels: [],
    modelPolicy: undefined,
    isLoadingModelPolicy: false,
    isSavingModelPolicy: false,
    modelPolicyError: undefined,
    sessionStatuses: {},
    sessionActivities: {},
    workspaceActivities: {},
    machineActivities: {},
    selectedNotificationInbox: undefined,
    workspacesByProjectId: {},
    workspaceDeletionRuns: {},
    commandDialog: undefined,
    treeDialog: undefined,
    modelDialog: undefined,
    thinkingDialog: undefined,
    themeDialog: undefined,
    authDialog: undefined,
    actionPaletteOpen: false,
    projectDialogOpen: false,
    machineDialogOpen: false,
    workspaceTool: "core:workspace.files",
    mainView: "chat",
    fileTree: [],
    expandedDirs: {},
    selectedFilePath: undefined,
    selectedFileContent: undefined,
    fileTreeStale: false,
    workspaceUploadBatches: {},
    gitStatus: undefined,
    selectedDiffPath: undefined,
    selectedDiff: undefined,
    selectedStagedDiff: undefined,
    gitStale: false,
    memory: { kind: "loading" },
    learnedSkills: { kind: "loading" },
    activeTerminalCount: 0,
    selectedTerminalId: undefined,
    piWebUiStatus: undefined,
    error: "",
  };
}
