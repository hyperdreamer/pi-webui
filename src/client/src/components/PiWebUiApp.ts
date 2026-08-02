import { LitElement, html } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { configApi, effectiveWorkspaceUploadFolder, modelTiersApi, sessionsApi, terminalsApi, workspacesApi, workspaceEffectiveUploadFolder, type GitStatusResponse, type Machine, type MachineHealth, type PiWebUiConfigValues, type PiWebUiShortcutConfig, type Project, type SessionCleanupExecuteResponse, type SessionCleanupPreviewResponse, type SessionCleanupRequest, type SessionInfo, type SessionTreeNavigateResult, type SessionTreeSummaryChoice, type TerminalCommandRun, type TerminalUiEvent, type Workspace } from "../api";
import type { AppAction } from "../actions";
import { closesActionPaletteAfterRun } from "../actions";
import type { SessionDefaultsResponse, SessionDefaultsUpdate } from "../api";
import type { ClientSessionModelPolicyStatus, ExactModelSelection, ModelTierSettingsResponse, SessionModelPolicy, SessionModelPolicyResponse, SessionModelPolicyUpdate, SessionStatus } from "../../../shared/apiTypes";
import { modelPolicyDraftFromPolicy, selectDraftTier, sessionModelPolicyUpdateFromDraft } from "./sessionModelPolicyDraft";
import { initialAppState, type AppState } from "../appState";
import { isSessionActive } from "../../../shared/activity";
import { PI_WEBUI_CAPABILITIES, supportsPiWebUiCapability } from "../../../shared/capabilities";
import { ActivityController } from "../controllers/activityController";
import { AuthController } from "../controllers/authController";
import { FileExplorerController } from "../controllers/fileExplorerController";
import { GitController } from "../controllers/gitController";
import { MemoryController } from "../controllers/memoryController";
import { gitUpdateManagerChangeCount } from "../gitUpdateManagerChanges";
import { MachineController } from "../controllers/machineController";
import { ProjectController } from "../controllers/projectController";
import { ProjectCatalogController } from "../controllers/projectCatalogController";
import { ProjectActivityOwnershipCoordinator } from "../controllers/projectActivityOwnershipCoordinator";
import { PiWebUiStatusController } from "../controllers/piWebUiStatusController";
import { SessionController } from "../controllers/sessionController";
import { SessionNotificationController } from "../controllers/sessionNotificationController";
import { WorkspaceController, canDeleteWorkspace } from "../controllers/workspaceController";
import { emptyMachineNavigationSnapshot, machineNavigationSnapshotFromState, routeFromMachineNavigationSnapshot, SessionStorageMachineNavigationMemory, type MachineNavigationSnapshot, type WorkspaceRouteSurface } from "../controllers/machineNavigationMemory";
import { SessionStorageSessionSelectionMemory } from "../controllers/sessionSelection";
import { SessionStorageTerminalSelectionMemory } from "../controllers/terminalSelection";
import { SessionStorageWorkspaceSelectionMemory } from "../controllers/workspaceSelection";
import { KeyboardShortcutDispatcher } from "../keyboardShortcuts";
import { selectedMachineId } from "../controllers/types";
import { machineSessionKey } from "../machineKeys";
import { sessionCleanupRequestKey, sessionCleanupUnavailableMessage } from "../sessionCleanupUi";
import { selectedNotificationView } from "../sessionNotifications";
import { hasAuthoritativeSessionPersistence as runtimeHasAuthoritativeSessionPersistence } from "../sessionPersistence";
import { SessionUnreadController } from "../sessionUnread";
import { initialSessionWarningVisibilityState, reconcileSessionWarningVisibility, toggleSessionWarnings } from "../sessionWarningVisibility";
import { RealtimeSocket, type BrowserRealtimeEvent } from "../sessionSocket";
import type { ActivityRailContext, LocalContributionId, PiWebUiPluginRegistration, PluginId, PluginMachine, PluginPromptEditor, QualifiedActivityRailContribution, QualifiedContributionId, QualifiedThemeContribution, QualifiedThemePairContribution, QualifiedWorkspacePanelContribution, PluginRuntimeContext, TerminalCommandRunsInternalRuntime, WorkspaceFiles, WorkspaceHost, WorkspaceLabelContext, WorkspaceLabelItem, WorkspacePanelContext, WorkspacePanelTerminal } from "../plugins/types";
import { isActivityRailItemVisible, visibleActivityRailItems, type ActivityRailDisplayItem, type ReportActivityRailError } from "../plugins/activityRail";
import { CLASSIC_THEME_ID, DEFAULT_THEME_PREFERENCE, applyPiWebUiTheme, findThemePairForTheme, readStoredThemePreference, resolveThemePreference, writeStoredThemePreference, type ThemePreference, type ThemePreferenceResolution } from "../theme";
import { corePlugin } from "../plugins/core";
import { themePackPlugin } from "../plugins/themes";
import { loadExternalPlugins } from "../plugins/external";
import { PluginRegistry, installActivityRailScope, installPluginRuntimeScope, installWorkspacePanelScope } from "../plugins/registry";
import { queryNamespace, readNamespacedString, setNamespacedQueryKey } from "../namespacedQueryArgs";
import { AppShellController } from "../appShell/appShellController";
import { BrowserResumeController } from "../appShell/browserResumeController";
import { NavigationSectionsController, type NavigationSection } from "../appShell/navigationState";
import { PanelCollapseController, mainViewClass } from "../appShell/panelCollapseController";
import { PanelResizeController, type PanelResizeConstraints, type ResizablePanelSide } from "../appShell/panelResizeController";
import { readRoute, writeRoute, type AppRoute } from "../route";
import { readSettingsSection, writeSettingsSection, type SettingsSection } from "../settingsRoute";
import { applyActiveShortcutPreferences } from "../shortcutPreferences";
import { createTerminalCommandRunsRuntime } from "../runtime/terminalRuntime";
import { fitTerminalModalBounds, moveTerminalModal, resizeTerminalModal, type TerminalModalBounds, type TerminalModalViewport } from "../terminalModalGeometry";
import { clampTerminalModalFontSize, clampTerminalModalOpacity, readTerminalModalPreferences, writeTerminalModalPreferences } from "../terminalModalPreferences";
import { readWorkspaceTabVisibility, writeWorkspaceTabVisibility } from "../workspaceTabVisibility";
import { isWorkspaceDeletionPending, isWorkspaceDeletionRunPending, latestWorkspaceDeletionRuns, pendingWorkspaceDeletionIds, targetWorkspaceIdForRun, workspaceDeletionRunFilter } from "../workspaceDeletion";
import { computeWindowTitle, createWindowTitleObserver } from "../windowTitle";
import "./MachineList";
import "./ProjectList";
import "./ProjectBrowserDialog";
import "./SessionBrowserDialog";
import "./WorkspaceList";
import { unreadSessionCount } from "./SessionList";
import "./SessionCleanupDialog";
import "./SessionHistoryWindow";
import "./SessionTreeNavigator";
import "./ChatView";
import type { ChatView } from "./ChatView";
import "./PromptEditor";
import type { PromptEditor } from "./PromptEditor";
import "./CommandPicker";
import "./ActionPalette";
import "./AuthDialog";
import "./ModelsConfigDialog";
import "./SkillsConfigDialog";
import "./PluginsConfigDialog";
import "./ProjectDialog";
import "./MachineDialog";
import type { MachineDialogSubmit } from "./MachineDialog";
import "./SettingsDialog";
import "./SystemPromptDialog";
import "./WorkspacePanel";
import type { WorkspacePanelEmptyState } from "./WorkspacePanel";
import "./TerminalPanel";
import "./appShell/AppContextBar";
import "./appShell/AppMobileMainTabs";
import type { AppMobileMainTab, AppMobileMainTabIcon } from "./appShell/AppMobileMainTabs";
import { shouldShowMachinesSection, type AppNavigationPanel, type NavigationFocusTarget } from "./appShell/AppNavigationPanel";
import "./appShell/AppPanelEdgeControl";
import "./appShell/AppRefreshControl";
import "./ActivityRail";
import "./PluginActivityDialog";
import "./GitUpdateManagerPanel";
import { DEFAULT_RAIL_ORDER, readRailOrder, writeRailOrder, type ReorderableRailItem } from "../activityRailOrder";
import { appStyles } from "./shared";


const PI_WEBUI_STATUS_REFRESH_MS = 15 * 60 * 1000;
const PI_WEBUI_STATUS_DEFER_MS = 750;
const REMOTE_ROUTE_RESTORE_RETRY_DELAYS_MS = [1_000, 3_000, 8_000, 15_000, 30_000] as const;
const GLOBAL_SHORTCUT_LISTENER_OPTIONS = { capture: true } as const;
const THEME_AUTO_ON_VALUE = "auto:on";
const THEME_AUTO_OFF_VALUE = "auto:off";
const THEME_OPTION_PREFIX = "theme:";
const FILES_ROUTE_NAMESPACE = queryNamespace("core:workspace.files");
const GIT_ROUTE_NAMESPACE = queryNamespace("core:workspace.git");
const TERMINAL_ROUTE_NAMESPACE = queryNamespace("core:workspace.terminal");
const MEMORY_ACTIVITY_RAIL_PLUGIN_ID: PluginId = "workspace-memory";
const MEMORY_ACTIVITY_RAIL_LOCAL_ID: LocalContributionId = "workspace.memory";
const MEMORY_ACTIVITY_RAIL_ID: QualifiedContributionId = "workspace-memory:workspace.memory";
const MIN_RESIZABLE_CHAT_WIDTH_PX = 320;
const PANEL_EDGE_COLUMNS_WIDTH_PX = 2;
const DESKTOP_SIDE_BY_SIDE_MEDIA_QUERY = "(min-width: 1181px)";

interface SessionCleanupDialogState {
  preview?: SessionCleanupPreviewResponse | undefined;
  previewRequest?: SessionCleanupRequest | undefined;
  result?: SessionCleanupExecuteResponse | undefined;
  loading?: boolean | undefined;
  running?: boolean | undefined;
  runningForce?: boolean | undefined;
  forceCleanupResult?: SessionCleanupExecuteResponse | undefined;
  error?: string | undefined;
}

interface SessionHistoryWindowState {
  machineId: string;
  session: SessionInfo;
}

interface TerminalModalPointerInteraction {
  operation: "move" | "resize";
  pointerId: number;
  target: HTMLElement;
  startClientX: number;
  startClientY: number;
  bounds: TerminalModalBounds;
}

interface TerminalModalPointerEvent {
  button: number;
  pointerId: number;
  clientX: number;
  clientY: number;
  currentTarget: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}

interface InternalActivityRailContext extends ActivityRailContext {
  onRefreshMemory: () => void;
}

interface ResolvedActivityRailItem {
  activity: QualifiedActivityRailContribution;
  context: ActivityRailContext;
}

interface ActiveActivityRailItem extends ResolvedActivityRailItem {
  generation: number;
}

@customElement("pi-webui-app")
export class PiWebUiApp extends LitElement {
  @state() private state: AppState = initialAppState();
  @query("chat-view") private chatView?: ChatView;
  @query("prompt-editor") private promptEditor?: PromptEditor;
  @query("app-navigation-panel") private navigationPanel?: AppNavigationPanel;
  @query("#navigation-panel") private navigationPanelFrame?: HTMLElement;
  @query("#workspace-panel") private workspacePanelFrame?: HTMLElement;

  private readonly sessionUnread = new SessionUnreadController({
    onChange: (machineId) => {
      if (selectedMachineId(this.state) !== machineId) return;
      this.syncUnreadSessionIds();
      this.syncSelectedSessionReadState();
    },
    onBackgroundError: (operation, machineId, error) => {
      console.warn(`Failed to ${operation} session unread state for ${machineId}`, error);
    },
  });
  @state() private unreadSessionIds: ReadonlySet<string> = this.sessionUnread.unreadSessionIds(selectedMachineId(this.state), this.state.sessions);
  private unreadConnected = false;
  private committedChatIdentity: string | undefined;
  private readyChatIdentity: string | undefined;

  private readonly notifications = new SessionNotificationController(
    () => this.state,
    (patch) => { this.setState(patch); },
    { onBackgroundError: (message, error) => { console.warn(message, error); } },
  );
  private readonly sessions = new SessionController(
    () => this.state,
    (patch) => { this.setState(patch); },
    () => { this.updateUrl(); },
    new SessionStorageSessionSelectionMemory(),
    {
      notifications: this.notifications,
      onSelectedSessionReady: ({ machineId, session }) => {
        void this.commitReadyChatAfterRender(machineId, session);
      },
      replacePromptEditorText: async ({ machineId, sessionId, text }) => {
        await this.updateComplete;
        if (selectedMachineId(this.state) !== machineId || this.state.selectedSession?.id !== sessionId) return;
        this.promptEditor?.replaceText(text);
      },
    },
  );
  private readonly workspaces = new WorkspaceController(
    () => this.state,
    (patch) => { this.setState(patch); },
    () => { this.updateUrl(); },
    this.sessions,
    new SessionStorageWorkspaceSelectionMemory(),
    {
      onBackgroundError: (operation, error) => {
        console.warn(`Failed to ${operation}`, error);
      },
    },
  );
  private readonly projectCatalog = new ProjectCatalogController(
    () => this.state,
    {
      workspaces: workspacesApi.workspaces,
      applySnapshot: async (snapshot) => {
        await this.workspaces.reconcileProjectCatalog(snapshot);
      },
      captureTopologyRequest: (scope) => this.workspaces.captureProjectCatalogTopologyRequest(scope),
      onBackgroundError: (operation, error) => {
        console.warn(`Failed to ${operation}`, error);
      },
    },
  );
  private readonly projectActivityOwnership = new ProjectActivityOwnershipCoordinator(
    () => this.state,
    (patch) => { this.setState(patch); },
    {
      api: workspacesApi,
      captureTopologyRequest: (scope) => this.workspaces.captureProjectCatalogTopologyRequest(scope),
      onProjectTopology: async (snapshot) => {
        const project = this.state.projects.find((candidate) => (
          candidate.id === snapshot.projectId && candidate.path === snapshot.projectPath
        ));
        if (project === undefined) return;
        await this.workspaces.reconcileProjectCatalog({
          machineId: snapshot.machineId,
          project,
          workspaces: snapshot.workspaces,
          ...(snapshot.topologyRequest === undefined ? {} : { topologyRequest: snapshot.topologyRequest }),
        });
      },
      onError: ({ machineId, projectId, error }) => {
        console.warn(`Failed to discover project activity ownership for ${projectId} on ${machineId}`, error);
      },
    },
  );
  private readonly activity = new ActivityController(
    () => this.state,
    (patch) => { this.setState(patch); },
    { onActivityApplied: (machineId) => { void this.projectActivityOwnership.handleActivityApplied(machineId); } },
  );
  private readonly auth = new AuthController(
    () => this.state,
    (patch) => { this.setState(patch); },
    (status) => { this.sessions.applySessionStatus(status); },
  );
  private readonly projects = new ProjectController(
    () => this.state,
    (patch) => { this.setState(patch); },
    this.workspaces,
    { onProjectsApplied: (machineId) => { void this.projectActivityOwnership.handleProjectsApplied(machineId); } },
  );
  private readonly machines = new MachineController(
    () => this.state,
    (patch) => { this.setState(patch); },
    () => { this.updateUrl(); },
    this.projects,
  );
  private readonly piWebUiStatusController = new PiWebUiStatusController(
    () => this.state,
    (patch) => { this.setState(patch); },
    { onRefreshError: (machineId, error) => { console.warn(`Failed to refresh PI WEBUI status for ${machineId}`, error); } },
  );
  private readonly files = new FileExplorerController(
    () => this.state,
    (patch) => { this.setState(patch); },
    () => { this.updateUrl(); },
  );
  private readonly git = new GitController(
    () => this.state,
    (patch) => { this.setState(patch); },
    () => { this.updateUrl(); },
  );
  private readonly memory = new MemoryController(
    () => this.state,
    (patch) => { this.setState(patch); },
  );
  private readonly keyboard = new KeyboardShortcutDispatcher();
  private readonly realtime = new RealtimeSocket();
  private readonly machineRealtimeSockets = new Map<string, RealtimeSocket>();
  private readonly unreadRuntimeRefreshes = new Map<string, Promise<void>>();
  private readonly activeTerminalIds = new Set<string>();
  private readonly machineNavigation = new SessionStorageMachineNavigationMemory();
  private readonly terminalSelection = new SessionStorageTerminalSelectionMemory();
  private readonly appShell = new AppShellController(this);
  private readonly browserResume = new BrowserResumeController({
    onResumeSignal: () => { this.handleBrowserResumeSignal(); },
    refreshAfterResume: () => this.refreshAfterBrowserResume(),
    onRefreshError: (error) => { console.warn("Failed to refresh after browser resume", error); },
  });
  private readonly panelCollapse = new PanelCollapseController(this);
  private readonly panelResize = new PanelResizeController(this);
  private readonly navigationSections = new NavigationSectionsController(
    this,
    () => this.state,
    () => this.appShell.isMobileNavigationLayout,
  );
  private readonly systemLightThemeMedia = typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia("(prefers-color-scheme: light)") : undefined;
  private terminalAutoStartWorkspaceId: string | undefined;
  private piWebUiStatusTimer: number | undefined;
  private piWebUiStatusDeferredTimer: number | undefined;
  private workspaceDeletionPollTimer: number | undefined;
  private refreshingWorkspaceDeletionRuns = false;
  private readonly handledWorkspaceDeletionRunIds = new Set<string>();
  private readonly terminalCommandRunRuntimes = new Map<string, TerminalCommandRunsInternalRuntime>();
  private machineNavigationRestoreSeq = 0;
  private navigationSelectionSeq = 0;
  private routeRestoreSeq = 0;
  private routeRestoreDepth = 0;
  private restoringRouteTerminalId: string | undefined;
  private pendingRemoteRouteRestore: AppRoute | undefined;
  private remoteRouteRestoreTimer: number | undefined;
  private remoteRouteRestoreAttempt = 0;
  private remoteRouteRestoreInProgress = false;
  private windowTitleCleanup: (() => void) | undefined;
  private readonly plugins = createPluginRegistry();
  private readonly reportActivityRailError: ReportActivityRailError = (phase, contributionId, error) => {
    console.warn("Plugin activity rail contribution failed", phase, contributionId, error);
  };
  private readonly loadedMachinePluginIds = new Set<string>();
  private readonly machinePluginLoadPromises = new Map<string, Promise<void>>();
  private gatewayPluginLoadPromise: Promise<void> | undefined;
  private themePreference: ThemePreference = readStoredThemePreference() ?? DEFAULT_THEME_PREFERENCE;
  @state() private activeThemeId: QualifiedContributionId = CLASSIC_THEME_ID;
  @state() private isRefreshingApp = false;
  @state() private sessionCleanupDialog: SessionCleanupDialogState | undefined;
  @state() private historyWindow: SessionHistoryWindowState | undefined;
  @state() private starterSessionDefaults: SessionDefaultsResponse | undefined;
  // Per-machine tier catalog owned by this component, shared by the starter and
  // active policy controls. Loaded on demand (never eagerly) because it is only
  // needed once a user opens a policy dialog, and re-fetched per machine.
  @state() private modelTierCatalog: ModelTierSettingsResponse | undefined;
  @state() private modelTierCatalogLoading = false;
  @state() private modelTierCatalogError = "";
  /**
   * The starter composer's local policy draft. There is no session yet, so no
   * server owns this: it is initialized from the confirmed Pi defaults, kept
   * independent of them once the user chooses Tiered, and carried into
   * `POST /sessions`. Cleared on every workspace/machine change.
   */
  @state() private starterModelPolicy: SessionModelPolicy | undefined;
  /** Machine the loaded catalog belongs to; guards cross-machine application. */
  private modelTierCatalogMachineId: string | undefined;
  /** Newest issued catalog request; a late response with a lower seq is dropped. */
  private modelTierCatalogSeq = 0;
  @state() private modelsConfigDialogOpen = false;
  @state() private projectBrowserOpen = false;
  private projectBrowserRestoreFocus: (() => void) | undefined;
  @state() private sessionBrowserOpen = false;
  private sessionBrowserRestoreFocus: (() => void) | undefined;
  @state() private skillsConfigDialogOpen = false;
  @state() private pluginsConfigDialogOpen = false;
  @state() private systemPromptDialogOpen = false;
  @state() private gitUpdateManagerPanelOpen = false;
  @state() private terminalModalOpen = false;
  @state() private terminalModalBounds: TerminalModalBounds | undefined;
  @state() private terminalModalMaximized = false;
  private terminalModalPointerInteraction: TerminalModalPointerInteraction | undefined;
  private readonly initialTerminalModalPreferences = readTerminalModalPreferences();
  @state() private terminalModalFontSize = this.initialTerminalModalPreferences.fontSize;
  @state() private terminalModalOpacity = this.initialTerminalModalPreferences.opacity;
  private readonly initialWorkspaceTabVisibility = readWorkspaceTabVisibility();
  @state() private terminalTabHidden = this.initialWorkspaceTabVisibility.terminalHidden;
  @state() private infoTabHidden = this.initialWorkspaceTabVisibility.infoHidden;
  @state() private railOrder: ReorderableRailItem[] = readRailOrder() ?? [...DEFAULT_RAIL_ORDER];
  @state() private compactRailOpen = false;
  private compactActivityRailLauncher: HTMLElement | undefined;
  @state() private activeActivityRailId: QualifiedContributionId | undefined;
  private activeActivityRailGeneration = 0;
  private activityRailRestoreFocus: (() => void) | undefined;
  @state() private settingsSection: SettingsSection | undefined = readSettingsSection();
  @state() private shortcutConfig: PiWebUiShortcutConfig = {};
  @state() private workspaceUploadDefaultFolder = effectiveWorkspaceUploadFolder(undefined);
  private sessionWarningVisibility = initialSessionWarningVisibilityState();
  private readonly onPopState = () => void this.withChatScrollTransition(async () => {
    this.restoreSettingsRoute();
    await this.restoreRoute(false);
  });
  private readonly onPageShow = () => {
    void this.renegotiateUnreadMachines();
    this.appShell.repairViewportPosition();
    this.retryPendingRemoteRouteRestoreSoon();
  };
  private readonly onSystemLightThemeChange = () => {
    if (this.themePreference.auto) this.applyPreferredTheme(false);
  };
  private readonly onTerminalModalViewportResize = () => {
    if (this.terminalModalBounds === undefined) return;
    this.terminalModalBounds = fitTerminalModalBounds(this.terminalModalBounds, this.terminalModalViewport());
  };
  private get routeRestoreInProgress(): boolean {
    return this.routeRestoreDepth > 0;
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (this.compactRailOpen || this.activeActivityRailId !== undefined || this.settingsSection !== undefined || this.state.treeDialog !== undefined) return;
    if (this.keyboard.handle(event, this.getDefaultActions(), { shortcuts: this.shortcutConfig })) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  protected override willUpdate(): void {
    this.toggleAttribute("pwa-display-mode", this.appShell.isPwaDisplayMode);
    this.syncSessionWarningVisibility();
  }

  protected override updated(): void {
    // Lit has now committed the selected chat and app-shell visibility state.
    // Recheck after every rendered transition; the unread controller
    // deduplicates acknowledgements for the observed completion order.
    this.committedChatIdentity = selectedChatIdentity(this.state);
    this.syncSelectedSessionReadState();
    if (this.compactRailOpen && this.appShell.isDesktopActivityRailLayout) this.closeCompactActivityRail();
    const activeActivityRailId = this.activeActivityRailId;
    if (activeActivityRailId !== undefined && this.activeActivityRailItem() === undefined) {
      this.closeActivityRailItem(activeActivityRailId, this.activeActivityRailGeneration);
    }
  }

  private syncSessionWarningVisibility(): void {
    const session = this.state.selectedSession;
    this.sessionWarningVisibility = reconcileSessionWarningVisibility(
      this.sessionWarningVisibility,
      session === undefined ? undefined : machineSessionKey(selectedMachineId(this.state), session.id),
      this.state.status === undefined ? undefined : this.state.status.warnings ?? [],
    );
  }

  private syncSelectedSessionReadState(): void {
    const session = this.state.selectedSession;
    if (session === undefined) return;
    const machineId = selectedMachineId(this.state);
    if (!this.isSessionSeen(machineId, session)) return;
    void this.sessionUnread.acknowledge(machineId, session);
  }

  private async commitReadyChatAfterRender(machineId: string, session: SessionInfo): Promise<void> {
    const identity = unreadChatIdentity(machineId, session);
    await this.updateComplete;
    if (!this.unreadConnected || selectedChatIdentity(this.state) !== identity) return;
    this.readyChatIdentity = identity;
    this.syncSelectedSessionReadState();
  }

  private syncUnreadSessionIds(): void {
    const next = this.sessionUnread.unreadSessionIds(selectedMachineId(this.state), this.state.sessions);
    if (!sameStringSet(next, this.unreadSessionIds)) this.unreadSessionIds = next;
  }

  private syncWindowTitle(): void {
    this.disconnectWindowTitle();
    const title = computeWindowTitle(this.state.selectedProject?.name);
    this.windowTitleCleanup = createWindowTitleObserver(title);
  }

  private disconnectWindowTitle(): void {
    this.windowTitleCleanup?.();
    this.windowTitleCleanup = undefined;
  }

  private isSessionSeen(machineId: string, session: SessionInfo): boolean {
    if (!this.unreadConnected) return false;
    const identity = unreadChatIdentity(machineId, session);
    if (selectedChatIdentity(this.state) !== identity
      || this.committedChatIdentity !== identity
      || this.readyChatIdentity !== identity) return false;
    if (typeof document !== "undefined") {
      if (document.visibilityState !== "visible") return false;
      if (typeof document.hasFocus === "function" && !document.hasFocus()) return false;
    }
    if (this.isChatObscured()) return false;
    if (this.state.mainView === "chat") return true;
    if (this.state.mainView === "navigation") return !this.appShell.isMobileNavigationLayout;
    return this.isDesktopSideBySideLayout();
  }

  private isChatObscured(): boolean {
    return this.compactRailOpen
      || this.activeActivityRailId !== undefined
      || this.settingsSection !== undefined
      || this.sessionCleanupDialog !== undefined
      || this.historyWindow !== undefined
      || this.modelsConfigDialogOpen
      || (this.skillsConfigDialogOpen && this.state.selectedWorkspace !== undefined)
      || (this.pluginsConfigDialogOpen && this.state.selectedWorkspace !== undefined)
      || (this.systemPromptDialogOpen && this.state.selectedSession !== undefined)
      || this.state.actionPaletteOpen
      || this.projectBrowserOpen
      || this.sessionBrowserOpen
      || this.state.projectDialogOpen
      || this.state.machineDialogOpen
      || this.state.commandDialog !== undefined
      || this.state.treeDialog !== undefined
      || this.state.modelDialog !== undefined
      || this.state.thinkingDialog !== undefined
      || this.state.themeDialog !== undefined
      || this.state.authDialog !== undefined
      || this.gitUpdateManagerPanelOpen
      || this.terminalModalOpen;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.synchronizeProjectCatalogPolling();
    this.unreadConnected = true;
    window.addEventListener("popstate", this.onPopState);
    window.addEventListener("pageshow", this.onPageShow);
    window.addEventListener("resize", this.onTerminalModalViewportResize);
    this.browserResume.connect();
    window.addEventListener("keydown", this.onKeyDown, GLOBAL_SHORTCUT_LISTENER_OPTIONS);
    this.systemLightThemeMedia?.addEventListener("change", this.onSystemLightThemeChange);
    this.applyPreferredTheme(false);
    this.connectRealtime();
    void this.renegotiateUnreadMachines();
    this.piWebUiStatusTimer = window.setInterval(() => { this.schedulePiWebUiStatusRefresh(); }, PI_WEBUI_STATUS_REFRESH_MS);
    void this.refreshWorkspaceActivity();
    void this.loadClientConfig();
    void this.ensureGatewayPluginsLoaded();
    void this.loadProjectsAndRestoreRoute().finally(() => { this.schedulePiWebUiStatusRefresh(); });
    this.syncWindowTitle();
  }

  override disconnectedCallback(): void {
    this.finishTerminalModalPointerInteraction();
    this.unreadConnected = false;
    this.committedChatIdentity = undefined;
    this.readyChatIdentity = undefined;
    this.unreadRuntimeRefreshes.clear();
    this.sessionUnread.retainMachines(new Set<string>());
    window.removeEventListener("popstate", this.onPopState);
    window.removeEventListener("pageshow", this.onPageShow);
    window.removeEventListener("resize", this.onTerminalModalViewportResize);
    this.browserResume.disconnect();
    window.removeEventListener("keydown", this.onKeyDown, GLOBAL_SHORTCUT_LISTENER_OPTIONS);
    this.systemLightThemeMedia?.removeEventListener("change", this.onSystemLightThemeChange);
    this.keyboard.reset();
    this.auth.dispose();
    this.sessions.dispose();
    this.projectCatalog.dispose();
    this.notifications.dispose();
    this.realtime.close();
    this.closeMachineActivitySockets();
    this.git.dispose();
    this.memory.dispose();
    if (this.piWebUiStatusTimer !== undefined) window.clearInterval(this.piWebUiStatusTimer);
    this.piWebUiStatusTimer = undefined;
    this.clearScheduledPiWebUiStatusRefresh();
    if (this.workspaceDeletionPollTimer !== undefined) window.clearInterval(this.workspaceDeletionPollTimer);
    this.workspaceDeletionPollTimer = undefined;
    this.clearPendingRemoteRouteRestore();
    this.disconnectWindowTitle();
    super.disconnectedCallback();
  }

  private setState(patch: Partial<AppState>) {
    if (!patchChangesState(this.state, patch)) return;
    const previous = this.state;
    this.state = { ...this.state, ...patch };
    if (selectedChatIdentity(previous) !== selectedChatIdentity(this.state)) {
      this.committedChatIdentity = undefined;
      this.readyChatIdentity = undefined;
    }
    if (machineUnreadInputsChanged(previous, this.state)) this.syncSessionUnreadMachines();
    this.syncUnreadSessionIds();
    this.handleActivityTransition(previous, this.state);
    this.handleWorkspaceChange(previous, this.state);
    if (!this.shouldShowSessionStartScreen(previous) && this.shouldShowSessionStartScreen(this.state) && this.state.selectedWorkspace !== undefined) {
      void this.loadStarterSessionDefaults(this.state.selectedWorkspace);
    }
    this.handleMachineChange(previous, this.state);
    if (machineActivitySubscriptionInputsChanged(previous, this.state)) this.syncMachineActivitySubscriptions();
    this.notifications.syncEnvironment(previous, this.state);
    if (previous.selectedProject?.name !== this.state.selectedProject?.name) this.syncWindowTitle();
    this.synchronizeProjectCatalogPolling();
  }

  private synchronizeProjectCatalogPolling(): void {
    // The node lifecycle shim may expose isConnected as undefined; do not let
    // ProjectCatalogController's default observation parameter treat that as true.
    this.projectCatalog.updatePolling(this.isConnected ? true : false);
  }

  private async loadProjectsAndRestoreRoute() {
    this.restoreSettingsRoute();
    const route = readRoute();
    await this.machines.loadMachines(route.machineId);
    const effectiveRoute = this.routeForSelectedMachine(route);
    const initialRouteMachineHealth = this.state.machineStatuses[effectiveRoute.machineId ?? "local"];
    if (effectiveRoute !== route) this.replaceRouteAndClearWorkspaceQuery(effectiveRoute);
    await this.projects.loadProjects();
    await this.withChatScrollTransition(() => this.restoreRouteFor(effectiveRoute, false));
    if (this.shouldDeferRemoteRouteRestore(effectiveRoute, initialRouteMachineHealth)) this.deferRemoteRouteRestore(effectiveRoute);
    else {
      this.clearPendingRemoteRouteRestore();
      this.rememberCurrentMachineNavigation();
    }
    await this.refreshWorkspaceDeletionRuns();
  }

  private handleBrowserResumeSignal(): void {
    this.appShell.repairViewportPosition();
    this.schedulePiWebUiStatusRefresh();
    this.retryPendingRemoteRouteRestoreSoon();
  }

  private async refreshAfterBrowserResume(): Promise<void> {
    void this.projectCatalog.refresh();
    await this.renegotiateUnreadMachines();
    await Promise.all([
      this.sessions.refreshSelectedSession(),
      this.refreshMachineActivities(),
      this.refreshWorkspaceDeletionRuns(),
    ]);
  }

  private schedulePiWebUiStatusRefresh(delayMs = PI_WEBUI_STATUS_DEFER_MS): void {
    this.clearScheduledPiWebUiStatusRefresh();
    this.piWebUiStatusDeferredTimer = window.setTimeout(() => {
      this.piWebUiStatusDeferredTimer = undefined;
      void this.piWebUiStatusController.refresh();
    }, delayMs);
  }

  private clearScheduledPiWebUiStatusRefresh(): void {
    if (this.piWebUiStatusDeferredTimer === undefined) return;
    window.clearTimeout(this.piWebUiStatusDeferredTimer);
    this.piWebUiStatusDeferredTimer = undefined;
  }

  private async refreshWorkspaceActivity(machineId = selectedMachineId(this.state)): Promise<void> {
    try {
      await this.activity.refresh(machineId);
    } catch (error) {
      console.warn(`Failed to refresh workspace activity for ${machineId}`, error);
    }
  }

  private async refreshMachineActivities(): Promise<void> {
    const machineIds = this.state.machines.length === 0
      ? [selectedMachineId(this.state)]
      : this.state.machines
        .filter((machine) => shouldRefreshMachineActivity(machine, this.state.machineStatuses[machine.id]))
        .map((machine) => machine.id);
    await Promise.all(machineIds.map((machineId) => this.refreshWorkspaceActivity(machineId)));
  }

  private async loadClientConfig(): Promise<void> {
    try {
      this.applyClientConfig((await configApi.config()).effectiveConfig);
    } catch (error) {
      console.warn("Failed to load PI WEBUI config", error);
    }
  }

  private applyClientConfig(config: PiWebUiConfigValues): void {
    this.shortcutConfig = config.shortcuts ?? {};
    this.workspaceUploadDefaultFolder = effectiveWorkspaceUploadFolder(config);
  }

  private async refreshAppData(): Promise<void> {
    if (this.isRefreshingApp) return;
    this.isRefreshingApp = true;
    try {
      await Promise.all([
        this.sessions.refreshSelectedSession(),
        this.refreshMachineActivities(),
        this.loadClientConfig(),
        this.refreshWorkspaceDeletionRuns(),
        this.refreshCurrentWorkspaceSurface(),
      ]);
      this.schedulePiWebUiStatusRefresh();
    } finally {
      this.isRefreshingApp = false;
    }
  }

  private async refreshCurrentWorkspaceSurface(): Promise<void> {
    const workspace = this.state.selectedWorkspace;
    const tool = this.state.mainView !== "chat" && this.state.mainView !== "navigation" ? this.state.mainView : this.state.workspaceTool;
    if (tool === "core:workspace.files") await this.files.refreshFiles();
    else if (tool === "core:workspace.git") await this.git.refreshGit();
    else if (tool === "core:workspace.terminal" && workspace !== undefined) await this.refreshActiveTerminals(workspace);
  }

  private hardReloadApp(): void {
    window.location.reload();
  }

  private async restoreRoute(updateUrl: boolean) {
    await this.restoreRouteFor(readRoute(), updateUrl);
    this.rememberCurrentMachineNavigation();
  }

  private async restoreRouteFor(route: AppRoute, updateUrl: boolean, surface = this.readWorkspaceRouteSurface(route), restoredMainView?: AppState["mainView"]) {
    const machineBeforeRestore = selectedMachineId(this.state);
    const routeSurface = route.projectId === undefined || route.projectId === "" ? emptyWorkspaceRouteSurface() : surface;
    const restoreSeq = ++this.routeRestoreSeq;
    this.routeRestoreDepth += 1;
    this.restoringRouteTerminalId = routeSurface.selectedTerminalId;
    try {
      await this.restoreRouteMachine(route, false);
      const selectedMachinePluginLoad = this.loadPluginsForSelectedMachine();
      if (route.tool?.startsWith("machine.") === true) await selectedMachinePluginLoad;
      if (!this.isCurrentRouteRestore(restoreSeq)) return;
      this.setState({
        workspaceTool: route.tool ?? this.state.workspaceTool,
        mainView: restoredMainView ?? route.view ?? this.defaultRouteView(),
        selectedFilePath: routeSurface.selectedFilePath,
        selectedDiffPath: routeSurface.selectedDiffPath,
        selectedTerminalId: routeSurface.selectedTerminalId,
      });
      if (route.projectId === undefined || route.projectId === "") {
        if (updateUrl) this.updateUrl();
        return;
      }
      if (this.routeMatchesCurrentSelection(route)) {
        if (routeSurface.selectedTerminalId !== undefined) this.rememberSelectedTerminal(routeSurface.selectedTerminalId);
        await this.refreshRestoredWorkspaceTool(route.tool, routeSurface.selectedFilePath);
        this.git.updatePolling();
        if (updateUrl) this.updateUrl();
        return;
      }
      const project = this.state.projects.find((p) => p.id === route.projectId);
      if (!project) {
        this.setState({ selectedFilePath: undefined, selectedDiffPath: undefined, selectedTerminalId: undefined });
        if (updateUrl) this.updateUrl();
        return;
      }
      await this.workspaces.selectProject(project, { workspaceId: route.workspaceId, sessionId: route.sessionId, updateUrl: false });
      if (!this.isCurrentRouteRestore(restoreSeq)) return;
      this.setState({ selectedFilePath: routeSurface.selectedFilePath, selectedDiffPath: routeSurface.selectedDiffPath, selectedTerminalId: routeSurface.selectedTerminalId });
      if (routeSurface.selectedTerminalId !== undefined) this.rememberSelectedTerminal(routeSurface.selectedTerminalId);
      await this.refreshRestoredWorkspaceTool(route.tool, routeSurface.selectedFilePath);
      this.git.updatePolling();
      if (updateUrl) this.updateUrl();
    } finally {
      this.routeRestoreDepth = Math.max(0, this.routeRestoreDepth - 1);
      if (this.routeRestoreDepth === 0) this.restoringRouteTerminalId = undefined;
      if (selectedMachineId(this.state) !== machineBeforeRestore) this.schedulePiWebUiStatusRefresh();
    }
  }

  private isCurrentRouteRestore(restoreSeq: number): boolean {
    return restoreSeq === this.routeRestoreSeq;
  }

  private readWorkspaceRouteSurface(route: AppRoute): WorkspaceRouteSurface {
    if (route.projectId === undefined || route.projectId === "") return emptyWorkspaceRouteSurface();
    return {
      selectedFilePath: readNamespacedString(FILES_ROUTE_NAMESPACE, "file"),
      selectedDiffPath: readNamespacedString(GIT_ROUTE_NAMESPACE, "diff"),
      selectedTerminalId: readNamespacedString(TERMINAL_ROUTE_NAMESPACE, "terminal"),
    };
  }

  private routeForSelectedMachine(route: AppRoute): AppRoute {
    const currentMachineId = this.state.selectedMachine?.id ?? "local";
    if ((route.machineId ?? "local") === currentMachineId) return route;
    return { machineId: currentMachineId, projectId: undefined, workspaceId: undefined, sessionId: undefined, tool: undefined, view: undefined };
  }

  private replaceRouteAndClearWorkspaceQuery(route: AppRoute): void {
    writeRoute(route, { replace: true });
    setNamespacedQueryKey(FILES_ROUTE_NAMESPACE, "file", undefined, { replace: true });
    setNamespacedQueryKey(GIT_ROUTE_NAMESPACE, "diff", undefined, { replace: true });
    setNamespacedQueryKey(TERMINAL_ROUTE_NAMESPACE, "terminal", undefined, { replace: true });
  }

  private shouldDeferRemoteRouteRestore(route: AppRoute, routeMachineHealth = this.state.machineStatuses[route.machineId ?? "local"]): boolean {
    const machineId = route.machineId ?? "local";
    const machine = this.state.selectedMachine;
    if (machineId === "local" || machine?.id !== machineId || machine.kind !== "remote") return false;
    if (routeMachineHealth?.ok !== false) return false;
    if (route.projectId === undefined || route.projectId === "") return this.state.projects.length === 0;
    return this.state.selectedProject?.id !== route.projectId;
  }

  private deferRemoteRouteRestore(route: AppRoute): void {
    this.pendingRemoteRouteRestore = route;
    this.remoteRouteRestoreAttempt = 0;
    this.setRemoteRouteRestoreMessage(route);
    this.schedulePendingRemoteRouteRestore();
  }

  private retryPendingRemoteRouteRestoreSoon(): void {
    if (this.pendingRemoteRouteRestore === undefined) return;
    this.schedulePendingRemoteRouteRestore(0);
  }

  private schedulePendingRemoteRouteRestore(delayMs = remoteRouteRestoreRetryDelay(this.remoteRouteRestoreAttempt)): void {
    if (this.pendingRemoteRouteRestore === undefined) return;
    this.clearPendingRemoteRouteRestoreTimer();
    this.remoteRouteRestoreTimer = window.setTimeout(() => {
      this.remoteRouteRestoreTimer = undefined;
      void this.retryPendingRemoteRouteRestore();
    }, delayMs);
  }

  private async retryPendingRemoteRouteRestore(): Promise<void> {
    if (this.remoteRouteRestoreInProgress) return;
    const route = this.pendingRemoteRouteRestore;
    if (route === undefined) return;
    if (!this.pendingRemoteRouteRestoreStillCurrent(route)) {
      this.clearPendingRemoteRouteRestore();
      return;
    }

    this.remoteRouteRestoreInProgress = true;
    try {
      const machineId = route.machineId ?? "local";
      const health = await this.machines.refreshMachineHealth(machineId);
      if (!this.pendingRemoteRouteRestoreStillCurrent(route)) return;
      if (health?.ok !== true) {
        this.scheduleNextRemoteRouteRestoreAttempt(route);
        return;
      }

      await this.machines.refreshMachineRuntime(machineId);
      if (!this.pendingRemoteRouteRestoreStillCurrent(route)) return;
      await this.projects.loadProjects();
      if (!this.pendingRemoteRouteRestoreStillCurrent(route)) return;
      if (this.state.error !== "") {
        this.scheduleNextRemoteRouteRestoreAttempt(route);
        return;
      }

      await this.withChatScrollTransition(() => this.restoreRouteFor(route, false));
      if (!this.pendingRemoteRouteRestoreStillCurrent(route)) return;
      this.clearPendingRemoteRouteRestore();
      this.rememberCurrentMachineNavigation();
      await this.refreshWorkspaceDeletionRuns();
    } finally {
      this.remoteRouteRestoreInProgress = false;
    }
  }

  private scheduleNextRemoteRouteRestoreAttempt(route: AppRoute): void {
    this.remoteRouteRestoreAttempt += 1;
    if (this.remoteRouteRestoreAttempt >= REMOTE_ROUTE_RESTORE_RETRY_DELAYS_MS.length) {
      this.setRemoteRouteRestoreMessage(route, { exhausted: true });
      this.clearPendingRemoteRouteRestore();
      return;
    }
    this.setRemoteRouteRestoreMessage(route);
    this.schedulePendingRemoteRouteRestore();
  }

  private setRemoteRouteRestoreMessage(route: AppRoute, options: { exhausted?: boolean } = {}): void {
    const machineId = route.machineId ?? "local";
    const machineName = this.state.machines.find((machine) => machine.id === machineId)?.name ?? this.state.selectedMachine?.name ?? "Remote machine";
    const health = this.state.machineStatuses[machineId];
    const detail = health?.error ?? (this.state.error === "" ? undefined : this.state.error);
    const prefix = options.exhausted === true
      ? `${machineName} is still unavailable.`
      : `${machineName} is unavailable; reconnecting…`;
    this.setState({ error: `${prefix}${detail === undefined ? "" : ` ${detail}`}` });
  }

  private pendingRemoteRouteRestoreStillCurrent(route: AppRoute): boolean {
    const machineId = route.machineId ?? "local";
    return machineId !== "local"
      && this.pendingRemoteRouteRestore === route
      && this.state.selectedMachine?.id === machineId
      && this.state.machines.some((machine) => machine.id === machineId);
  }

  private clearPendingRemoteRouteRestore(): void {
    this.clearPendingRemoteRouteRestoreTimer();
    this.pendingRemoteRouteRestore = undefined;
    this.remoteRouteRestoreAttempt = 0;
  }

  private clearPendingRemoteRouteRestoreTimer(): void {
    if (this.remoteRouteRestoreTimer === undefined) return;
    window.clearTimeout(this.remoteRouteRestoreTimer);
    this.remoteRouteRestoreTimer = undefined;
  }

  private async restoreRouteMachine(route: AppRoute, updateUrl: boolean): Promise<void> {
    const routeMachineId = route.machineId ?? "local";
    if (this.state.selectedMachine?.id === routeMachineId) return;
    const machine = this.state.machines.find((candidate) => candidate.id === routeMachineId);
    if (machine === undefined) return;
    await this.machines.selectMachine(machine, { updateUrl });
  }

  private routeMatchesCurrentSelection(route: AppRoute): boolean {
    return (route.machineId ?? "local") === (this.state.selectedMachine?.id ?? "local")
      && route.workspaceId !== undefined
      && route.workspaceId !== ""
      && this.state.selectedProject?.id === route.projectId
      && this.state.selectedWorkspace?.id === route.workspaceId
      && this.state.selectedSession?.id === route.sessionId;
  }

  private async refreshRestoredWorkspaceTool(tool: QualifiedContributionId | undefined, selectedFilePath: string | undefined): Promise<void> {
    if (tool === "core:workspace.files") await this.files.refreshFiles();
    if (tool === "core:workspace.files" && selectedFilePath !== undefined) await this.files.restoreFile(selectedFilePath);
    if (tool === "core:workspace.git") await this.git.refreshGit();
  }

  private async withChatScrollTransition(action: () => Promise<void>, shouldComplete: () => boolean = () => true) {
    this.chatView?.saveScrollPosition();
    await action();
    if (!shouldComplete()) return;
    await this.updateComplete;
    if (!shouldComplete()) return;
    await this.chatView?.updateComplete;
    if (!shouldComplete()) return;
    await nextFrame();
    if (!shouldComplete()) return;
    this.chatView?.restoreScrollPosition();
    if (this.shouldAutoFocusPrompt()) this.promptEditor?.focusInput();
  }

  private shouldAutoFocusPrompt(): boolean {
    return this.appShell.shouldAutoFocusPrompt();
  }

  private async withChatPrependTransition(action: () => Promise<void>) {
    await action();
    await this.updateComplete;
    await this.chatView?.updateComplete;
  }

  private defaultRouteView(): AppState["mainView"] {
    return this.appShell.defaultRouteView();
  }

  private updateUrl(options?: { replace?: boolean | undefined }) {
    this.rememberCurrentMachineNavigation();
    writeRoute({
      machineId: this.state.selectedMachine?.id,
      projectId: this.state.selectedProject?.id,
      workspaceId: this.state.selectedWorkspace?.id,
      sessionId: this.state.selectedSession?.id,
      tool: this.state.workspaceTool,
      view: this.state.mainView === "navigation" ? undefined : this.state.mainView,
    }, options);
    this.syncWorkspaceRouteSurfaceToUrl();
  }

  private rememberCurrentMachineNavigation(): void {
    this.machineNavigation.remember(machineNavigationSnapshotFromState(this.state));
  }

  private syncWorkspaceRouteSurfaceToUrl(): void {
    this.writeWorkspaceRouteSurfaceToUrl(machineNavigationSnapshotFromState(this.state).surface);
  }

  private writeMachineNavigationSnapshotToUrl(snapshot: MachineNavigationSnapshot, options?: { replace?: boolean | undefined }): void {
    writeRoute(routeFromMachineNavigationSnapshot(snapshot), options);
    this.writeWorkspaceRouteSurfaceToUrl(snapshot.surface);
  }

  private writeWorkspaceRouteSurfaceToUrl(surface: WorkspaceRouteSurface): void {
    setNamespacedQueryKey(FILES_ROUTE_NAMESPACE, "file", surface.selectedFilePath, { replace: true });
    setNamespacedQueryKey(GIT_ROUTE_NAMESPACE, "diff", surface.selectedDiffPath, { replace: true });
    setNamespacedQueryKey(TERMINAL_ROUTE_NAMESPACE, "terminal", surface.selectedTerminalId, { replace: true });
  }

  private async selectMachineWithMemory(machine: Machine, options: { rememberCurrent?: boolean } = {}): Promise<void> {
    if (this.state.selectedMachine?.id === machine.id) return;
    if (options.rememberCurrent !== false && !this.routeRestoreInProgress) this.rememberCurrentMachineNavigation();
    const seq = ++this.machineNavigationRestoreSeq;
    const snapshot = this.machineNavigation.latest(machine.id) ?? emptyMachineNavigationSnapshot(machine.id);
    await this.restoreRouteFor(routeFromMachineNavigationSnapshot(snapshot), false, snapshot.surface, snapshot.view);
    if (seq !== this.machineNavigationRestoreSeq || this.state.selectedMachine?.id !== machine.id) return;
    if (this.shouldPreserveUnrestoredMachineNavigation(snapshot)) {
      this.machineNavigation.remember(snapshot);
      this.writeMachineNavigationSnapshotToUrl(snapshot);
      return;
    }
    this.updateUrl();
  }

  private shouldPreserveUnrestoredMachineNavigation(snapshot: MachineNavigationSnapshot): boolean {
    return snapshot.projectId !== undefined && this.state.selectedProject?.id !== snapshot.projectId && this.state.error !== "";
  }

  private openWorkspaceTool(tool: QualifiedContributionId) {
    if (tool === "core:workspace.terminal") this.terminalAutoStartWorkspaceId = this.state.selectedWorkspace?.id;
    this.setState({ workspaceTool: tool, mainView: tool });
    this.updateUrl();
    this.refreshSelectedWorkspaceTool(tool);
    this.git.updatePolling();
  }

  private openTerminal(options?: { terminalId?: string | undefined }): void {
    if (options?.terminalId !== undefined) this.selectTerminal(options.terminalId, { replace: true });
    this.openWorkspaceTool("core:workspace.terminal");
  }

  private terminalCommandRunsForOrigin(origin: string, machineId = selectedMachineId(this.state)): TerminalCommandRunsInternalRuntime {
    const key = machineScopedKey(machineId, origin);
    const existing = this.terminalCommandRunRuntimes.get(key);
    if (existing !== undefined) return existing;
    const runtime = createTerminalCommandRunsRuntime(origin, {
      api: {
        runTerminalCommand: (runtimeOrigin, input) => terminalsApi.runTerminalCommand(runtimeOrigin, input, machineId),
        listCommandRuns: (filter) => terminalsApi.listCommandRuns(filter, machineId),
        getCommandRun: (runId) => terminalsApi.getCommandRun(runId, machineId),
      },
      openTerminal: (workspace, options) => { void this.openRuntimeTerminal(machineId, workspace, options); },
    });
    this.terminalCommandRunRuntimes.set(key, runtime);
    return runtime;
  }

  private async openRuntimeTerminal(machineId: string, workspace: Workspace | undefined, options?: { terminalId?: string | undefined }): Promise<void> {
    if (selectedMachineId(this.state) !== machineId || (workspace !== undefined && (this.state.selectedWorkspace?.id !== workspace.id || this.state.selectedProject?.id !== workspace.projectId))) {
      if (!this.routeRestoreInProgress) this.rememberCurrentMachineNavigation();
      await this.restoreRouteFor({
        machineId,
        projectId: workspace?.projectId,
        workspaceId: workspace?.id,
        sessionId: undefined,
        tool: "core:workspace.terminal",
        view: "core:workspace.terminal",
      }, false, { selectedTerminalId: options?.terminalId }, "core:workspace.terminal");
      if (selectedMachineId(this.state) !== machineId) {
        this.setState({ error: "Machine not found for terminal command run" });
        return;
      }
    }
    this.openTerminal(options);
  }

  private selectTerminal(terminalId: string | undefined, options?: { replace?: boolean | undefined }): void {
    this.rememberSelectedTerminal(terminalId);
    this.setState({ selectedTerminalId: terminalId });
    this.rememberCurrentMachineNavigation();
    this.writeSelectedTerminalToUrl(terminalId, options);
  }

  private rememberSelectedTerminal(terminalId: string | undefined): void {
    const workspace = this.state.selectedWorkspace;
    if (workspace === undefined) return;
    if (terminalId === undefined) this.terminalSelection.forgetWorkspace(this.terminalWorkspaceKey(workspace));
    else this.terminalSelection.rememberTerminal(this.terminalWorkspaceKey(workspace), terminalId);
  }

  private writeSelectedTerminalToUrl(terminalId: string | undefined, options?: { replace?: boolean | undefined }): void {
    setNamespacedQueryKey(TERMINAL_ROUTE_NAMESPACE, "terminal", terminalId, options);
  }

  private terminalWorkspaceKey(workspace: Workspace): string {
    return `${selectedMachineId(this.state)}:${workspace.path}`;
  }

  private selectMainView(view: AppState["mainView"]) {
    if (view !== "navigation" && view !== "chat") {
      this.openWorkspaceTool(view);
      return;
    }
    this.setState({ mainView: view });
    this.updateUrl();
    this.git.updatePolling();
  }

  private openSettings(section: SettingsSection = "general"): void {
    this.settingsSection = section;
    writeSettingsSection(section);
  }

  private closeSettings(): void {
    this.settingsSection = undefined;
    writeSettingsSection(undefined);
  }

  private navigateSettings(section: SettingsSection): void {
    this.settingsSection = section;
    writeSettingsSection(section);
  }

  private restoreSettingsRoute(): void {
    this.settingsSection = readSettingsSection();
  }

  private handleWorkspaceChange(previous: AppState, next: AppState) {
    const memoryScopeChanged = memoryPollingScopeChanged(previous, next);
    if (previous.selectedWorkspace?.id === next.selectedWorkspace?.id) {
      if (memoryScopeChanged) this.synchronizeMemoryPollingForSelectedWorkspace();
      return;
    }
    this.starterSessionDefaults = undefined;
    this.resetStarterModelPolicyForScopeChange();
    this.terminalAutoStartWorkspaceId = undefined;
    this.activeTerminalIds.clear();
    const selectedTerminalId = this.routeRestoreInProgress ? this.restoringRouteTerminalId : next.selectedWorkspace === undefined ? undefined : this.terminalSelection.latestTerminalId(this.terminalWorkspaceKey(next.selectedWorkspace));
    this.setState({ activeTerminalCount: 0, selectedTerminalId });
    if (!this.routeRestoreInProgress) {
      this.rememberCurrentMachineNavigation();
      this.writeSelectedTerminalToUrl(selectedTerminalId, { replace: true });
    }
    if (next.selectedWorkspace === undefined) {
      this.synchronizeMemoryPollingForSelectedWorkspace();
      return;
    }
    void this.refreshActiveTerminals(next.selectedWorkspace);
    void this.refreshWorkspaceDeletionRuns();
    this.refreshSelectedWorkspaceTool(next.workspaceTool);
    this.git.updatePolling();
    this.synchronizeMemoryPollingForSelectedWorkspace();
  }

  private async loadStarterSessionDefaults(workspace: Workspace): Promise<void> {
    const machineId = selectedMachineId(this.state);
    try {
      const defaults = await sessionsApi.sessionDefaults(workspace.path, machineId);
      if (selectedMachineId(this.state) !== machineId || this.state.selectedWorkspace?.id !== workspace.id) return;
      this.starterSessionDefaults = defaults;
      this.linkStarterExactBranch(defaults);
    } catch (error) {
      if (selectedMachineId(this.state) === machineId && this.state.selectedWorkspace?.id === workspace.id) {
        console.warn("Failed to load Pi session defaults", error);
      }
    }
  }

  /**
   * Keep the starter's remembered Exact branch pointed at whatever model/thinking
   * pair Pi actually resolved. While the user is Tiered the remembered Exact
   * tuple is theirs to keep, so a confirmed default must not overwrite it; the
   * two branches stay independent exactly as they do for a live session.
   */
  private linkStarterExactBranch(defaults: SessionDefaultsResponse): void {
    const exact = starterExactSelection(defaults);
    if (exact === undefined) return;
    const current = this.starterModelPolicy;
    if (current === undefined) {
      this.starterModelPolicy = { mode: "exact", exact };
      return;
    }
    if (current.mode === "tiered" || sameExactSelection(current.exact, exact)) return;
    this.starterModelPolicy = { ...current, exact };
  }

  private syncSessionUnreadMachines(): void {
    if (!this.unreadConnected) {
      this.sessionUnread.retainMachines(new Set<string>());
      return;
    }
    const machineIds = new Set(this.state.machines.map((machine) => machine.id));
    this.sessionUnread.retainMachines(machineIds);
    for (const machineId of machineIds) {
      const runtime = this.state.machineRuntimes[machineId];
      if (runtime === undefined) continue;
      const capability = this.unreadRuntimeRefreshes.has(machineId) || !runtime.ok
        ? "unknown"
        : supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.sessionsUnread)
          ? "supported"
          : "unsupported";
      if (this.sessionUnread.setCapability(machineId, capability)) void this.sessionUnread.refresh(machineId);
    }
  }

  private async renegotiateUnreadMachines(): Promise<void> {
    if (!this.unreadConnected) return;
    const machineIds = new Set(this.state.machines.map((machine) => machine.id));
    machineIds.add(selectedMachineId(this.state));
    await Promise.all([...machineIds].map(async (machineId) => { await this.renegotiateUnreadMachine(machineId); }));
  }

  private renegotiateUnreadMachine(machineId: string): Promise<void> {
    const existing = this.unreadRuntimeRefreshes.get(machineId);
    if (existing !== undefined) return existing;
    this.sessionUnread.setCapability(machineId, "unknown");
    let refreshed = false;
    const refresh = Promise.resolve().then(async () => {
      refreshed = await this.machines.refreshMachineRuntime(machineId) !== undefined;
    });
    this.unreadRuntimeRefreshes.set(machineId, refresh);
    const finishRefresh = () => {
      if (this.unreadRuntimeRefreshes.get(machineId) !== refresh) return;
      this.unreadRuntimeRefreshes.delete(machineId);
      if (!this.unreadConnected) return;
      if (refreshed) this.syncSessionUnreadMachines();
      else this.sessionUnread.setCapability(machineId, "unknown");
    };
    void refresh.then(finishRefresh, finishRefresh);
    return refresh;
  }

  private connectRealtime(): void {
    const machineId = selectedMachineId(this.state);
    this.realtime.connect(
      (event) => { this.handleRealtimeEvent(machineId, event); },
      () => {
        void this.renegotiateUnreadMachine(machineId);
        const workspace = this.state.selectedWorkspace;
        if (workspace !== undefined) void this.refreshActiveTerminals(workspace);
        void this.refreshWorkspaceActivity(machineId);
        void this.projectCatalog.refresh();
      },
      machineId,
    );
  }

  private syncMachineActivitySubscriptions(): void {
    const desiredMachineIds = this.machineActivitySubscriptionIds();
    for (const [machineId, socket] of this.machineRealtimeSockets.entries()) {
      if (desiredMachineIds.has(machineId)) continue;
      socket.close();
      this.machineRealtimeSockets.delete(machineId);
    }
    for (const machineId of desiredMachineIds) {
      if (this.machineRealtimeSockets.has(machineId)) continue;
      const socket = new RealtimeSocket();
      socket.connect(
        (event) => { this.handleMachineActivityEvent(machineId, event); },
        () => {
          void this.renegotiateUnreadMachine(machineId);
          void this.refreshWorkspaceActivity(machineId);
        },
        machineId,
      );
      this.machineRealtimeSockets.set(machineId, socket);
    }
  }

  private closeMachineActivitySockets(): void {
    for (const socket of this.machineRealtimeSockets.values()) socket.close();
    this.machineRealtimeSockets.clear();
  }

  private machineActivitySubscriptionIds(): Set<string> {
    const selected = selectedMachineId(this.state);
    return new Set(this.state.machines
      .filter((machine) => machine.id !== selected)
      .filter((machine) => shouldSubscribeToMachineActivity(machine, this.state.machineStatuses[machine.id]))
      .map((machine) => machine.id));
  }

  private handleMachineActivityEvent(machineId: string, event: BrowserRealtimeEvent): void {
    if (event.type === "sessions.unread") this.sessionUnread.applyEvent(machineId, event);
    else if (event.type === "workspace.activity") this.activity.applyWorkspaceActivity(event.activity, machineId);
  }

  private handleRealtimeEvent(machineId: string, event: BrowserRealtimeEvent): void {
    if (event.type === "sessions.unread") this.sessionUnread.applyEvent(machineId, event);
    else if (event.type === "workspace.activity") this.activity.applyWorkspaceActivity(event.activity);
    else if (isTerminalEvent(event)) {
      this.applyTerminalEvent(event);
      if (event.type === "terminal.exited") void this.refreshWorkspaceDeletionRuns();
    } else this.sessions.applyGlobalEvent(event);
  }

  private applyTerminalEvent(event: TerminalUiEvent): void {
    const workspace = this.state.selectedWorkspace;
    if (workspace === undefined) return;
    const cwd = event.type === "terminal.closed" ? event.cwd : event.terminal.cwd;
    if (cwd !== workspace.path) return;
    if (event.type === "terminal.created" && !event.terminal.exited) this.activeTerminalIds.add(event.terminal.id);
    else this.activeTerminalIds.delete(event.type === "terminal.closed" ? event.terminalId : event.terminal.id);
    if (event.type === "terminal.closed") {
      this.terminalSelection.forgetTerminal(event.terminalId);
      if (this.state.selectedTerminalId === event.terminalId) this.selectTerminal(undefined, { replace: true });
    }
    this.setState({ activeTerminalCount: this.activeTerminalIds.size });
  }

  private async refreshActiveTerminals(workspace: Workspace): Promise<void> {
    const machineId = selectedMachineId(this.state);
    try {
      const terminals = await terminalsApi.terminals(workspace.projectId, workspace.id, machineId);
      if (selectedMachineId(this.state) !== machineId || this.state.selectedWorkspace?.id !== workspace.id) return;
      this.activeTerminalIds.clear();
      for (const terminal of terminals) {
        if (!terminal.exited) this.activeTerminalIds.add(terminal.id);
      }
      this.setState({ activeTerminalCount: this.activeTerminalIds.size });
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  private handleActivityTransition(previous: AppState, next: AppState) {
    const wasActive = isActive(previous);
    const nowActive = isActive(next);
    if (wasActive && !nowActive) {
      this.setState({ fileTreeStale: true, gitStale: true });
      this.refreshSelectedWorkspaceTool(this.state.workspaceTool);
    }
  }

  private handleMachineChange(previous: AppState, next: AppState): void {
    if ((previous.selectedMachine?.id ?? "local") === (next.selectedMachine?.id ?? "local")) return;
    this.projectActivityOwnership.handleSelectedMachineChanged();
    const pendingMachineId = this.pendingRemoteRouteRestore?.machineId ?? "local";
    if (pendingMachineId !== (next.selectedMachine?.id ?? "local")) this.clearPendingRemoteRouteRestore();
    this.sessions.clearActiveSession();
    this.resetStarterModelPolicyForScopeChange();
    this.resetModelTierCatalogForMachineChange();
    this.realtime.close();
    this.connectRealtime();
    this.activeTerminalIds.clear();
    this.sessionCleanupDialog = undefined;
    this.setState({ piWebUiStatus: undefined });
    this.git.updatePolling();
    void this.loadPluginsForSelectedMachine();
  }

  private refreshSelectedWorkspaceTool(tool: QualifiedContributionId): void {
    if (tool === "core:workspace.files") void this.files.refreshFiles();
    if (tool === "core:workspace.git") void this.git.refreshGit();
  }

  private renderWorkspacePanel() {
    const workspace = this.state.selectedWorkspace;
    const panelContext = workspace === undefined ? undefined : this.createWorkspacePanelContext(workspace);
    const emptyState = workspace === undefined ? this.workspacePanelEmptyState() : undefined;
    return html`
      <workspace-panel
        id="workspace-panel"
        .workspace=${workspace}
        .panelContext=${panelContext}
        .emptyState=${emptyState}
        .tool=${this.state.workspaceTool}
        .panels=${this.workspacePanels()}
        .hiddenTools=${this.hiddenWorkspacePanelTools()}
        .onSelectTool=${(tool: QualifiedContributionId) => { this.openWorkspaceTool(tool); }}
      ></workspace-panel>
    `;
  }

  private renderNavigationPanelEdgeControl() {
    const constraints = this.resizablePanelConstraints("navigation");
    return html`
      <app-panel-edge-control
        side="navigation"
        controls="navigation-panel"
        resizeLabel="Resize navigation panel"
        expandLabel="Expand navigation panel"
        collapseLabel="Collapse navigation panel"
        .collapsed=${this.panelCollapse.navigationPanelCollapsed}
        .resizable=${!this.appShell.isMobileNavigationLayout}
        .panelWidth=${this.panelResize.panelWidth("navigation")}
        .minWidth=${constraints.minWidth}
        .maxWidth=${constraints.maxWidth}
        .onToggle=${() => { this.panelCollapse.toggleNavigationPanel(); }}
        .onResizeStart=${() => this.startPanelResize("navigation")}
        .onResize=${(width: number) => { this.panelResize.resizePanel("navigation", width, { persist: false }); }}
        .onResizeEnd=${() => { this.panelResize.persistPanelSizes(); }}
        .onReset=${() => { this.resetResizablePanel("navigation"); }}
      ></app-panel-edge-control>
    `;
  }

  private renderWorkspacePanelEdgeControl() {
    const constraints = this.resizablePanelConstraints("workspace");
    return html`
      <app-panel-edge-control
        side="workspace"
        controls="workspace-panel"
        resizeLabel="Resize workspace panel"
        expandLabel="Expand workspace panel"
        collapseLabel="Collapse workspace panel"
        .collapsed=${this.panelCollapse.workspacePanelCollapsed}
        .resizable=${!this.appShell.isMobileNavigationLayout}
        .panelWidth=${this.panelResize.panelWidth("workspace")}
        .minWidth=${constraints.minWidth}
        .maxWidth=${constraints.maxWidth}
        .onToggle=${() => { this.panelCollapse.toggleWorkspacePanel(); }}
        .onResizeStart=${() => this.startPanelResize("workspace")}
        .onResize=${(width: number) => { this.panelResize.resizePanel("workspace", width, { persist: false }); }}
        .onResizeEnd=${() => { this.panelResize.persistPanelSizes(); }}
        .onReset=${() => { this.resetResizablePanel("workspace"); }}
      ></app-panel-edge-control>
    `;
  }

  private startPanelResize(side: ResizablePanelSide): number {
    if (side === "navigation") this.panelCollapse.expandNavigationPanel();
    else this.panelCollapse.expandWorkspacePanel();
    return this.measuredPanelWidth(side) ?? this.panelResize.panelWidth(side);
  }

  private resizablePanelConstraints(side: ResizablePanelSide): PanelResizeConstraints {
    const constraints = this.panelResize.constraints(side);
    return {
      ...constraints,
      maxWidth: this.resizablePanelMaxWidth(side, constraints),
    };
  }

  private resizablePanelMaxWidth(side: ResizablePanelSide, constraints: PanelResizeConstraints): number {
    const shellWidth = this.getBoundingClientRect().width || (typeof window === "undefined" ? 0 : window.innerWidth);
    if (shellWidth <= 0) return constraints.maxWidth;

    const otherPanelWidth = this.oppositeResizablePanelWidth(side);
    const maxWidth = Math.floor(shellWidth - otherPanelWidth - PANEL_EDGE_COLUMNS_WIDTH_PX - MIN_RESIZABLE_CHAT_WIDTH_PX);
    return Math.max(constraints.minWidth, Math.min(constraints.maxWidth, maxWidth));
  }

  private oppositeResizablePanelWidth(side: ResizablePanelSide): number {
    const otherSide: ResizablePanelSide = side === "navigation" ? "workspace" : "navigation";
    if (this.isResizablePanelCollapsedOrStacked(otherSide)) return 0;
    return this.measuredPanelWidth(otherSide) ?? this.panelResize.panelWidth(otherSide);
  }

  private isResizablePanelCollapsedOrStacked(side: ResizablePanelSide): boolean {
    if (side === "navigation") return this.panelCollapse.navigationPanelCollapsed;
    return this.panelCollapse.workspacePanelCollapsed || !this.isDesktopSideBySideLayout();
  }

  private isDesktopSideBySideLayout(): boolean {
    if (typeof window === "undefined" || !("matchMedia" in window)) return true;
    return window.matchMedia(DESKTOP_SIDE_BY_SIDE_MEDIA_QUERY).matches;
  }

  private measuredPanelWidth(side: ResizablePanelSide): number | undefined {
    const element = side === "navigation" ? this.navigationPanelFrame : this.workspacePanelFrame;
    const width = element?.getBoundingClientRect().width;
    return width === undefined || width <= 0 ? undefined : width;
  }

  private resetResizablePanel(side: ResizablePanelSide): void {
    this.panelResize.resetPanel(side);
  }

  private resetResizablePanels(): void {
    this.panelResize.resetPanels();
  }

  private canDeleteArchivedSessions(): boolean {
    const runtime = this.selectedMachineRuntime();
    // COMPAT-CAP sessions.deleteArchived: older federated machines may support
    // the legacy DELETE route without advertising runtime capabilities. Only
    // block when capability discovery succeeds and reports no support.
    return runtime?.ok !== true || supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.sessionsDeleteArchived);
  }

  private canReloadSessions(): boolean {
    const runtime = this.selectedMachineRuntime();
    return runtime?.ok === true && supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.sessionsReload);
  }

  private canClearServerQueue(): boolean {
    const runtime = this.selectedMachineRuntime();
    return runtime?.ok === true && supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.sessionsClearQueue);
  }

  private canMessageActions(): boolean {
    const runtime = this.selectedMachineRuntime();
    return runtime?.ok === true && supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.sessionsMessageActions);
  }

  private canViewSystemPrompt(): boolean {
    const runtime = this.selectedMachineRuntime();
    return runtime?.ok === true && supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.sessionsSystemPrompt);
  }

  private canCleanupSessions(): boolean {
    const runtime = this.selectedMachineRuntime();
    return runtime?.ok === true && supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.sessionsCleanup);
  }

  private hasAuthoritativeSessionPersistence(): boolean {
    return runtimeHasAuthoritativeSessionPersistence(this.selectedMachineRuntime());
  }

  private supportsWorkspaceFileSuggestions(machineId = selectedMachineId(this.state)): boolean {
    if (machineId === "local") return true;
    // COMPAT-CAP workspace.fileSuggestions: remote machines without this
    // capability stay on the legacy cwd-based /files route.
    const runtime = this.state.machineRuntimes[machineId];
    return runtime?.ok === true && supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.workspaceFileSuggestions);
  }

  /**
   * COMPAT-CAP sessions.modelPolicy: the dedicated capability requires both web
   * and sessiond, and is never inferred from `settings.modelTiers` or
   * `settings.selectedMachine`. A remote peer whose runtime has not been
   * negotiated yet stays unsupported, so no unsupported request is issued and
   * the composer keeps its previous Exact-only model/thinking controls.
   */
  private sessionModelPolicySupported(machineId = selectedMachineId(this.state)): boolean {
    if (machineId === "local") return true;
    const runtime = this.state.machineRuntimes[machineId];
    return runtime?.ok === true && supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.sessionsModelPolicy);
  }

  /**
   * Fetch the selected machine's tier catalog for whichever policy control is
   * open. Two independent guards protect the single shared field: the response
   * must still belong to the machine and workspace it was issued for, and it
   * must be the newest issued request, so neither a machine/workspace switch nor
   * a slow earlier response can publish a catalog the user is no longer looking
   * at.
   */
  private async loadModelTierCatalog(machineId: string): Promise<void> {
    const workspaceId = this.state.selectedWorkspace?.id;
    const seq = ++this.modelTierCatalogSeq;
    const isCurrent = () => (
      seq === this.modelTierCatalogSeq
      && selectedMachineId(this.state) === machineId
      && this.state.selectedWorkspace?.id === workspaceId
    );
    this.modelTierCatalogLoading = true;
    this.modelTierCatalogError = "";
    try {
      const catalog = await modelTiersApi.settings(machineId);
      if (!isCurrent()) return;
      this.modelTierCatalogMachineId = machineId;
      this.modelTierCatalog = catalog;
    } catch (error) {
      if (!isCurrent()) return;
      this.modelTierCatalogError = errorMessage(error);
    } finally {
      if (seq === this.modelTierCatalogSeq) this.modelTierCatalogLoading = false;
    }
  }

  /**
   * Drop the starter draft when the selection it was derived from changes. The
   * draft is linked to one workspace's confirmed Pi defaults, so it must not
   * survive into another workspace and silently start a session with the previous
   * workspace's policy. `loadStarterSessionDefaults()` relinks a fresh Exact
   * branch only once the new defaults arrive.
   */
  private resetStarterModelPolicyForScopeChange(): void {
    this.starterModelPolicy = undefined;
    this.modelTierCatalogError = "";
  }

  /**
   * The catalog is a per-machine projection, so a machine change invalidates it
   * outright. In-flight loads are already dropped by their machine guard; the
   * sequence bump makes that explicit and keeps the loading flag honest.
   */
  private resetModelTierCatalogForMachineChange(): void {
    this.modelTierCatalogSeq += 1;
    this.modelTierCatalogMachineId = undefined;
    this.modelTierCatalog = undefined;
    this.modelTierCatalogLoading = false;
    this.modelTierCatalogError = "";
  }

  /** The loaded catalog, only when it belongs to the currently selected machine. */
  private selectedMachineModelTierCatalog(): ModelTierSettingsResponse | undefined {
    if (this.modelTierCatalogMachineId !== selectedMachineId(this.state)) return undefined;
    return this.modelTierCatalog;
  }

  private archivedDeleteUnavailableMessage(): string {
    const machineName = this.state.selectedMachine?.name ?? "this machine";
    return `Update and restart Pi-Web on ${machineName} to delete archived sessions.`;
  }

  private sessionCleanupUnavailableMessage(): string {
    return sessionCleanupUnavailableMessage(this.state.selectedMachine?.name);
  }

  private selectedMachineRuntime() {
    return this.state.machineRuntimes[selectedMachineId(this.state)];
  }

  private openSessionCleanupDialog(): void {
    this.sessionCleanupDialog = { error: "" };
  }

  private closeSessionCleanupDialog(): void {
    this.sessionCleanupDialog = undefined;
  }

  private async previewSessionCleanup(request: SessionCleanupRequest): Promise<void> {
    if (!this.canCleanupSessions()) {
      this.sessionCleanupDialog = { ...(this.sessionCleanupDialog ?? {}), error: this.sessionCleanupUnavailableMessage(), preview: undefined, previewRequest: undefined, result: undefined, loading: false };
      return;
    }
    const machineId = selectedMachineId(this.state);
    this.sessionCleanupDialog = { ...(this.sessionCleanupDialog ?? {}), loading: true, error: "", preview: undefined, previewRequest: undefined, result: undefined };
    try {
      const preview = await sessionsApi.cleanupPreview(request, machineId);
      if (selectedMachineId(this.state) !== machineId) return;
      this.sessionCleanupDialog = { ...this.sessionCleanupDialog, preview, previewRequest: request, result: undefined, loading: false, error: "" };
    } catch (error) {
      if (selectedMachineId(this.state) === machineId) this.sessionCleanupDialog = { ...this.sessionCleanupDialog, loading: false, error: `Failed to preview cleanup: ${errorMessage(error)}` };
    }
  }

  private async runSessionCleanup(request: SessionCleanupRequest): Promise<void> {
    const dialog = this.sessionCleanupDialog;
    if (dialog?.preview === undefined || sessionCleanupRequestKey(dialog.previewRequest) !== sessionCleanupRequestKey(request)) {
      this.sessionCleanupDialog = { ...(dialog ?? {}), error: "Preview cleanup before running it." };
      return;
    }
    if (!this.canCleanupSessions()) {
      this.sessionCleanupDialog = { ...dialog, error: this.sessionCleanupUnavailableMessage(), running: false };
      return;
    }
    const machineId = selectedMachineId(this.state);
    this.sessionCleanupDialog = { ...dialog, running: true, error: "" };
    try {
      const result = await sessionsApi.cleanup(request, machineId);
      if (selectedMachineId(this.state) !== machineId) return;
      this.sessionCleanupDialog = { ...this.sessionCleanupDialog, preview: result, previewRequest: request, result, running: false, error: "" };
      await this.sessions.applySessionCleanupResult(result, machineId);
    } catch (error) {
      if (selectedMachineId(this.state) === machineId) this.sessionCleanupDialog = { ...this.sessionCleanupDialog, running: false, error: `Failed to run cleanup: ${errorMessage(error)}` };
    }
  }

  private async runForceSessionCleanup(): Promise<void> {
    const dialog = this.sessionCleanupDialog;
    if (!this.canCleanupSessions()) {
      this.sessionCleanupDialog = { ...(dialog ?? {}), error: this.sessionCleanupUnavailableMessage(), runningForce: false };
      return;
    }
    const machineId = selectedMachineId(this.state);
    this.sessionCleanupDialog = { ...(dialog ?? {}), runningForce: true, error: "" };
    try {
      const result = await sessionsApi.forceCleanup(machineId);
      if (selectedMachineId(this.state) !== machineId) return;
      this.sessionCleanupDialog = { ...this.sessionCleanupDialog, forceCleanupResult: result, runningForce: false, error: "" };
      await this.sessions.applySessionCleanupResult(result, machineId);
    } catch (error) {
      if (selectedMachineId(this.state) === machineId) this.sessionCleanupDialog = { ...this.sessionCleanupDialog, runningForce: false, error: `Failed to force cleanup: ${errorMessage(error)}` };
    }
  }

  private renderNavigationPanel() {
    return html`
      <app-navigation-panel
        .machines=${this.state.machines}
        .selectedMachine=${this.state.selectedMachine}
        .version=${this.state.piWebUiStatus?.components.web.runtimeVersion}
        .machineStatuses=${this.state.machineStatuses}
        .machineActivities=${this.state.machineActivities}
        .machinesCollapsed=${this.navigationSections.isCollapsed("machines")}
        .onToggleMachines=${() => { this.navigationSections.toggle("machines"); }}
        .onSelectMachine=${(machine: Machine) => this.selectNavigationItem("machines", "projects", () => this.selectMachineWithMemory(machine))}
        .onRemoveMachine=${(machine: Machine) => { void this.removeMachine(machine); }}
        .projects=${this.state.projects}
        .selectedProject=${this.state.selectedProject}
        .workspaceActivities=${this.state.workspaceActivities}
        .workspacesByProjectId=${this.state.workspacesByProjectId}
        .workspaces=${this.state.workspaces}
        .selectedWorkspace=${this.state.selectedWorkspace}
        .deletingWorkspaceIds=${pendingWorkspaceDeletionIds(this.state.workspaceDeletionRuns)}
        .sessions=${this.state.sessions}
        .projectSessions=${this.state.projectSessions}
        .sessionStatuses=${this.state.sessionStatuses}
        .sessionActivities=${this.state.sessionActivities}
        .sendingPrompts=${this.state.sendingPrompts}
        .unreadSessionIds=${this.unreadSessionIds}
        .selectedSession=${this.state.selectedSession}
        .startingSessionCount=${this.state.startingSessionCount}
        .canStartSession=${!!this.state.selectedWorkspace}
        .canDeleteArchivedSessions=${this.canDeleteArchivedSessions()}
        .canReloadSessions=${this.canReloadSessions()}
        .canCleanupSessions=${this.canCleanupSessions()}
        .authoritativeSessionPersistence=${this.hasAuthoritativeSessionPersistence()}
        .archivedDeleteUnavailableMessage=${this.archivedDeleteUnavailableMessage()}
        .cleanupUnavailableMessage=${this.sessionCleanupUnavailableMessage()}
        .collapsible=${true}
        .compact=${this.appShell.isMobileNavigationLayout}
        .projectsCollapsed=${this.navigationSections.isCollapsed("projects")}
        .workspacesCollapsed=${this.navigationSections.isCollapsed("workspaces")}
        .sessionsCollapsed=${this.navigationSections.isCollapsed("sessions")}
        .workspaceLabelItems=${(workspace: Workspace) => this.workspaceLabelItems(workspace)}
        .refreshControl=${this.appShell.shouldShowAppRefreshInHeader() ? this.renderAppRefresh() : undefined}
        .onShowActions=${() => { this.setState({ actionPaletteOpen: true }); }}
        .skillsEnabled=${this.state.selectedWorkspace !== undefined}
        .pluginsEnabled=${this.state.selectedWorkspace !== undefined}
        .onOpenModels=${() => { this.modelsConfigDialogOpen = true; }}
        .onOpenSkills=${() => {
          if (this.state.selectedWorkspace !== undefined) this.skillsConfigDialogOpen = true;
        }}
        .onOpenPlugins=${() => {
          if (this.state.selectedWorkspace !== undefined) this.pluginsConfigDialogOpen = true;
        }}
        .onToggleProjects=${() => { this.navigationSections.toggle("projects"); }}
        .onAddProject=${() => { this.openProjectDialog(); }}
        .onOpenProjectBrowser=${(restoreFocus: () => void) => { this.openProjectBrowser(restoreFocus); }}
        .onOpenSessionBrowser=${this.state.selectedProject === undefined ? undefined : (restoreFocus: () => void) => { this.openSessionBrowser(restoreFocus); }}
        .onToggleWorkspaces=${() => { this.navigationSections.toggle("workspaces"); }}
        .onToggleSessions=${() => { this.navigationSections.toggle("sessions"); }}
        .onSelectProject=${(project: Project) => this.selectNavigationItem("projects", "workspaces", () => this.workspaces.selectProject(project))}
        .onCloseProject=${(project: Project) => this.projects.closeProject(project.id)}
        .onSelectWorkspace=${(workspace: Workspace) => this.selectNavigationItem("workspaces", "sessions", () => this.workspaces.selectWorkspace(workspace))}
        .onDeleteWorkspace=${(workspace: Workspace) => { void this.deleteWorkspace(workspace); }}
        .onArchivedCollapsed=${() => { this.sessions.clearSelectionAfterArchivedCollapse(); }}
        .onStartSession=${() => this.startSessionFromNavigation()}
        .onSelectSession=${(session: SessionInfo) => this.selectNavigationItem("sessions", "chat", () => this.selectSessionFromNavigation(session))}
        .onRenameSessionStart=${() => { this.cancelPendingNavigationSelection(); }}
        .onRenameSession=${(session: SessionInfo, name: string) => this.sessions.renameSession(session, name)}
        .onArchiveSession=${(session: SessionInfo) => this.sessions.archiveSession(session)}
        .onArchiveSessionWithDescendants=${(session: SessionInfo) => this.sessions.archiveSessionWithDescendants(session)}
        .onArchiveSessions=${(sessions: SessionInfo[]) => this.sessions.archiveSessions(sessions)}
        .onRestoreSession=${(session: SessionInfo) => this.selectNavigationItem("sessions", "chat", () => this.sessions.restoreSession(session))}
        .onDeleteCachedNewSession=${(session: SessionInfo) => this.sessions.deleteCachedNewSession(session)}
        .onDeleteArchivedSession=${(session: SessionInfo) => this.sessions.deleteArchivedSessions([session])}
        .onDeleteArchivedSessions=${(sessions: SessionInfo[]) => this.sessions.deleteArchivedSessions(sessions)}
        .onDetachParentSession=${(session: SessionInfo) => this.sessions.detachParent(session)}
        .onReloadSession=${(session: SessionInfo) => this.sessions.reloadSession(session)}
        .onPinSession=${(session: SessionInfo) => this.sessions.pinSession(session)}
        .onUnpinSession=${(session: SessionInfo) => this.sessions.unpinSession(session)}
        .onCleanupSessions=${() => { this.openSessionCleanupDialog(); }}
        .onFocusNavigationTarget=${(target: NavigationFocusTarget) => { void this.focusNavigationTarget(target); }}
        .onCancelKeyboardNavigation=${() => { void this.focusChatComposer(); }}
      ></app-navigation-panel>
    `;
  }

  private canOpenSessionHistory(): boolean {
    const session = this.state.selectedSession;
    return session !== undefined && session.persisted !== false && session.path !== "";
  }

  private openSessionHistory(): void {
    const session = this.state.selectedSession;
    if (session === undefined || !this.canOpenSessionHistory()) return;
    this.historyWindow = { machineId: selectedMachineId(this.state), session };
  }

  private openNavigationSection(section: NavigationSection): void {
    this.navigationSections.open(section, () => { this.selectMainView("navigation"); });
  }

  private cancelPendingNavigationSelection(): void {
    this.navigationSelectionSeq += 1;
  }

  private async selectNavigationItem(section: NavigationSection, nextTarget: NavigationFocusTarget, action: () => Promise<void>): Promise<void> {
    const seq = ++this.navigationSelectionSeq;
    const isCurrentSelection = () => seq === this.navigationSelectionSeq;

    await this.withChatScrollTransition(async () => {
      this.navigationSections.advanceAfterSelection(section);
      await action();
    }, isCurrentSelection);

    if (!isCurrentSelection()) return;
    await this.focusNavigationTarget(nextTarget);
  }

  private async selectSessionFromNavigation(session: SessionInfo): Promise<void> {
    if (this.state.selectedWorkspace?.path === session.cwd) {
      await this.sessions.selectSession(session);
      return;
    }
    const workspace = this.state.workspaces.find((candidate) => candidate.path === session.cwd);
    if (workspace === undefined) {
      this.setState({ error: "The session's workspace is no longer available." });
      return;
    }
    await this.workspaces.selectWorkspace(workspace, { sessionId: session.id });
  }

  private async startSessionFromNavigation(): Promise<void> {
    const seq = ++this.navigationSelectionSeq;
    const isCurrentSelection = () => seq === this.navigationSelectionSeq;

    this.navigationSections.advanceAfterSelection("sessions");
    await this.startSessionAndOpenChat(isCurrentSelection);
  }

  private async startSessionAndOpenChat(shouldComplete: () => boolean = () => true): Promise<void> {
    // Capture the starter state synchronously, before startSession() inserts and
    // selects its pending row. Draft identity acts as a generation guard because
    // every starter edit and value-changing relink replaces the policy object;
    // a value-equivalent relink intentionally preserves it.
    const workspaceId = this.state.selectedWorkspace?.id;
    const starterModelPolicy = this.starterModelPolicy;
    const modelPolicy = this.starterModelPolicyStartSnapshot();
    // `startSession()` remains in flight until the backend session resolves;
    // open the chat as soon as the controller has inserted the temporary row.
    const start = this.sessions.startSession(modelPolicy).then((started) => {
      this.clearStarterModelPolicyAfterSuccessfulStart(started, workspaceId, starterModelPolicy);
    }).catch((error: unknown) => {
      if (shouldComplete()) this.setState({ error: String(error) });
    });
    if (shouldComplete()) await this.focusChatComposer();
    void start;
  }

  private async focusNavigationTarget(target: NavigationFocusTarget): Promise<void> {
    if (target === "chat") {
      await this.focusChatComposer();
      return;
    }
    await this.focusNavigationSection(target);
  }

  private async focusNavigationSection(section: NavigationSection): Promise<void> {
    if (section === "machines" && !shouldShowMachinesSection(this.state.machines)) {
      await this.focusNavigationSection("projects");
      return;
    }
    this.panelCollapse.expandNavigationPanel();
    if (this.appShell.isMobileNavigationLayout) this.selectMainView("navigation");
    this.navigationSections.expand(section);
    await this.updateComplete;
    await nextFrame();
    await this.navigationPanel?.focusSection(section);
  }

  private async focusChatComposer(): Promise<void> {
    if (this.state.mainView !== "chat") this.selectMainView("chat");
    await this.updateComplete;
    await nextFrame();
    this.promptEditor?.focusInput();
  }

  private async navigateSessionTree(targetId: string, summaryChoice: SessionTreeSummaryChoice): Promise<SessionTreeNavigateResult> {
    const originMachineId = selectedMachineId(this.state);
    const originSessionId = this.state.selectedSession?.id;
    const result = await this.sessions.navigateTree(targetId, summaryChoice);
    if (!result.cancelled
      && originSessionId !== undefined
      && selectedMachineId(this.state) === originMachineId
      && this.state.selectedSession?.id === originSessionId) {
      await this.focusChatComposer();
    }
    return result;
  }

  private closeSessionTreeNavigator(): void {
    this.sessions.closeTreeDialog();
    void this.focusChatComposer();
  }

  private renderSessionTreeNavigator(state: AppState) {
    return state.treeDialog === undefined ? null : html`
      <session-tree-navigator
        .tree=${state.treeDialog}
        .onNavigate=${(targetId: string, summaryChoice: SessionTreeSummaryChoice) => this.navigateSessionTree(targetId, summaryChoice)}
        .onAbort=${() => this.sessions.abortTreeNavigation()}
        .onCancel=${() => { this.closeSessionTreeNavigator(); }}
      ></session-tree-navigator>
    `;
  }

  private workspacePanels(): QualifiedWorkspacePanelContribution[] {
    const workspace = this.state.selectedWorkspace;
    if (workspace === undefined) return [];
    const context = this.createWorkspacePanelContext(workspace);
    const panels = this.plugins.getWorkspacePanels();
    return panels.filter((panel) => panel.visible?.(context) ?? true);
  }

  private synchronizeMemoryPollingForSelectedWorkspace(
    activities: readonly QualifiedActivityRailContribution[] = this.plugins.getActivityRailItems(),
  ): void {
    if (this.state.selectedWorkspace === undefined) {
      this.memory.updatePolling(false);
      return;
    }
    this.synchronizeMemoryPolling(activities);
  }

  private synchronizeMemoryPolling(
    activities: readonly QualifiedActivityRailContribution[],
  ): void {
    const observed = activities.some((activity) => isMemoryActivityRailItem(activity)
      && isActivityRailItemVisible(
        activity,
        this.createActivityRailContext(activity.id),
        this.reportActivityRailError,
      ));
    this.memory.updatePolling(observed);
  }

  private visibleWorkspacePanels(): QualifiedWorkspacePanelContribution[] {
    const hiddenTools = this.hiddenWorkspacePanelTools();
    return this.workspacePanels().filter((panel) => !hiddenTools.includes(panel.id));
  }

  private hiddenWorkspacePanelTools(): QualifiedContributionId[] {
    const hiddenTools: QualifiedContributionId[] = [];
    if (this.terminalTabHidden) hiddenTools.push("core:workspace.terminal");
    if (this.infoTabHidden) hiddenTools.push("core:workspace.info");
    return hiddenTools;
  }

  private workspacePanelEmptyState(): WorkspacePanelEmptyState {
    const project = this.state.selectedProject;
    if (this.state.isLoadingProjects) {
      return {
        title: "Loading projects…",
        body: "Looking for projects you have added to PI WEBUI.",
      };
    }
    if (project === undefined) {
      return this.state.projects.length === 0
        ? {
            title: "No projects yet",
            body: "Use Actions → Add Project to add a folder. Workspace tools will appear here after you choose a workspace.",
          }
        : {
            title: "Select a project",
            body: "Choose a project from the sidebar, then select a workspace to inspect files, Git, or terminals.",
          };
    }
    if (this.state.isLoadingWorkspaces) {
      return {
        title: "Loading workspaces…",
        body: `Preparing workspace tools for ${project.name}.`,
      };
    }
    if (this.state.workspaces.length === 0) {
      return {
        title: "No workspaces found",
        body: `${project.name} does not have any available workspaces. Try selecting the project again or re-adding it.`,
      };
    }
    return {
      title: "Select a workspace",
      body: `Choose a workspace in ${project.name} to inspect files, Git, or terminals.`,
    };
  }

  private sessionEmptyMessage(): string {
    if (this.state.isLoadingProjects) return "Loading projects…";
    if (this.state.isLoadingSessions) return "Loading sessions…";
    if (this.state.selectedWorkspace !== undefined) return "Select or start a session.";
    if (this.state.selectedProject !== undefined) return "Select a workspace to start a session.";
    if (this.state.projects.length === 0) return "Add a project to start a session.";
    return "Select a project and workspace to start a session.";
  }

  private shouldShowSessionStartScreen(state: AppState): boolean {
    return state.selectedWorkspace !== undefined
      && state.selectedSession === undefined
      && !state.isLoadingSessions
      && state.sessions.every((session) => session.archived === true)
      && state.error === "";
  }

  private renderSessionStartScreen(state: AppState) {
    const workspace = state.selectedWorkspace;
    if (workspace === undefined) return html``;
    const defaults = this.starterSessionDefaults;
    const canSelectDefaultModel = defaults !== undefined && defaults.models.length > 0;
    const canSelectDefaultThinking = defaults !== undefined && defaults.thinkingLevels.length > 0;
    const policy = this.starterModelPolicyInputs();
    return html`
      <section class="session-start-screen" aria-labelledby="session-start-heading">
        <div class="session-start-content">
          <p class="session-start-eyebrow">PI WEBUI · ${workspace.label}</p>
          <h1 id="session-start-heading">What would you like to build?</h1>
          <p class="session-start-copy">Start a conversation in <strong>${workspace.label}</strong>. Ask Pi to explore the codebase, plan a change, or help you make it.</p>
          <div class="session-start-composer">
            <prompt-editor .cwd=${workspace.path} .machineId=${selectedMachineId(state)} .projectId=${workspace.projectId} .workspaceId=${workspace.id} .workspaceScopedFileSuggestions=${this.supportsWorkspaceFileSuggestions()} .showSessionConfiguration=${true} .sessionConfiguration=${defaults} .availableThinkingLevels=${defaults?.thinkingLevels ?? []} .modelPolicyStatus=${policy?.status} .modelPolicyResponse=${policy?.response} .modelTierCatalog=${policy === undefined ? undefined : this.selectedMachineModelTierCatalog()} .modelPolicyLoading=${policy !== undefined && this.modelTierCatalogLoading} .modelPolicySaving=${false} .modelPolicyError=${policy === undefined ? "" : this.modelTierCatalogError} .onOpenModelPolicy=${policy === undefined ? undefined : this.handleOpenStarterModelPolicy} .onSaveModelPolicy=${policy === undefined ? undefined : this.handleSaveStarterModelPolicy} .onSend=${this.handleStartSessionPrompt} .onSelectModel=${canSelectDefaultModel ? this.handleSelectStarterModel : undefined} .onSelectThinking=${canSelectDefaultThinking ? this.handleSelectStarterThinking : undefined}></prompt-editor>
          </div>
          <p class="session-start-hint">Describe a goal, paste a task, or attach a file to begin.</p>
        </div>
      </section>
    `;
  }

  /**
   * Project the local starter draft into the same inputs the active composer
   * receives. There is no session yet, so the "live status" and the "confirmed
   * response" are both derived locally from the draft and the catalog; the
   * synthetic response exists only so the control can open its editable form, and
   * its placeholder `sessionId` is never sent to an API.
   *
   * `blockedReason` is diagnostic here, exactly as it is for a live session: a
   * starter Tiered choice whose tier does not resolve still ships a `policy`, so
   * the control renders a repairable form rather than a dead end.
   *
   * Two things this must not misreport. The resolved tuple is only a tier entry
   * while the policy is actually Tiered — a persisted policy legitimately keeps a
   * remembered canonical tier in Exact mode, and there is no server confirmation
   * for a starter, so the local exact tuple is the only authoritative source of
   * what the session will start from. And an unknown (still loading, or failed)
   * catalog is not an invalid ladder: reporting `ladderValid: false` before the
   * catalog arrives would assert a configuration error that does not exist and
   * announce it to assistive tech beside the loading text.
   */
  private starterModelPolicyInputs(): { status: ClientSessionModelPolicyStatus; response: SessionModelPolicyResponse } | undefined {
    const defaults = this.starterSessionDefaults;
    const policy = this.starterModelPolicy;
    if (defaults === undefined || policy === undefined || !this.sessionModelPolicySupported()) return undefined;
    if (starterExactSelection(defaults) === undefined) return undefined;
    const catalog = this.selectedMachineModelTierCatalog();
    const selectedTier = policy.tier;
    const selectedTierRow = selectedTier === undefined ? undefined : catalog?.rows[selectedTier];
    const selectedTierEntry = policy.mode === "tiered" && selectedTier !== undefined && selectedTierRow?.valid === true
      ? catalog?.ladder?.[selectedTier]
      : undefined;
    const status: ClientSessionModelPolicyStatus = {
      mode: policy.mode,
      ...(selectedTier === undefined ? {} : { tier: selectedTier }),
      resolved: selectedTierEntry ?? policy.exact,
      ladderValid: catalog === undefined || catalog.valid,
      ...(policy.mode === "tiered" && selectedTierEntry === undefined
        ? { blockedReason: catalog?.configError ?? "Choose a valid model tier before starting" }
        : {}),
    };
    return {
      status,
      response: {
        contractVersion: 1,
        policy,
        session: {
          sessionId: "starter",
          isStreaming: false,
          isCompacting: false,
          isBashRunning: false,
          pendingMessageCount: 0,
          queuedMessages: [],
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
          ...(defaults.model === undefined ? {} : { model: defaults.model }),
          thinkingLevel: defaults.thinkingLevel,
          modelPolicy: status,
        },
      },
    };
  }

  /**
   * The typed policy snapshot to carry into `POST /sessions`, or undefined when
   * the starter never diverged from the defaults the daemon will apply anyway.
   * A Tiered choice always travels; an Exact choice travels only when the user
   * repaired it away from the confirmed defaults, so an untouched starter keeps
   * the existing request body byte-for-byte.
   */
  private starterModelPolicyStartSnapshot(): SessionModelPolicyUpdate | undefined {
    const policy = this.starterModelPolicy;
    const defaults = this.starterSessionDefaults;
    if (policy === undefined || defaults === undefined || !this.sessionModelPolicySupported()) return undefined;
    if (policy.mode === "tiered") {
      return policy.tier === undefined ? undefined : { mode: "tiered", tier: policy.tier };
    }
    const linked = starterExactSelection(defaults);
    if (linked !== undefined && sameExactSelection(linked, policy.exact)) return undefined;
    return { mode: "exact", exact: { model: { ...policy.exact.model }, thinkingLevel: policy.exact.thinkingLevel } };
  }

  private clearStarterModelPolicyAfterSuccessfulStart(
    started: boolean,
    workspaceId: string | undefined,
    starterModelPolicy: SessionModelPolicy | undefined,
  ): void {
    if (!started || this.state.selectedWorkspace?.id !== workspaceId || this.starterModelPolicy !== starterModelPolicy) return;
    this.starterModelPolicy = undefined;
  }

  private mobilePanelBadge(panel: QualifiedWorkspacePanelContribution): unknown {
    const workspace = this.state.selectedWorkspace;
    if (workspace === undefined) return undefined;
    return panel.badge?.(this.createWorkspacePanelContext(workspace));
  }

  private mobilePanelIcon(panel: QualifiedWorkspacePanelContribution): AppMobileMainTabIcon | undefined {
    switch (panel.id) {
      case "core:workspace.files": return "files";
      case "core:workspace.git": return "git";
      case "core:workspace.terminal": return "terminal";
      default: return undefined;
    }
  }

  private workspaceLabelItems(workspace: Workspace): WorkspaceLabelItem[] {
    return this.plugins.getWorkspaceLabelItems(this.createWorkspaceLabelContext(workspace));
  }

  private createWorkspaceLabelContext(workspace: Workspace): WorkspaceLabelContext {
    const machine = pluginMachineFromState(this.state);
    return {
      machine,
      workspace,
      state: this.state,
      files: this.createWorkspaceFiles(workspace, machine.id),
      host: this.createWorkspaceHost(),
    };
  }

  private createWorkspaceFiles(workspace: Workspace, machineId: string): WorkspaceFiles {
    return {
      readFile: (path: string) => workspacesApi.workspaceFile(workspace.projectId, workspace.id, path, machineId),
      writeFile: async (path, content, options) => {
        const result = await workspacesApi.writeWorkspaceFile(workspace.projectId, workspace.id, path, content, options, machineId);
        void this.files.refreshFiles();
        return result;
      },
      deleteFile: async (path) => {
        const result = await workspacesApi.deleteWorkspaceFile(workspace.projectId, workspace.id, path, machineId);
        void this.files.refreshFiles();
        return result;
      },
      moveFile: async (fromPath, toPath, options) => {
        const result = await workspacesApi.moveWorkspaceFile(workspace.projectId, workspace.id, fromPath, toPath, options, machineId);
        void this.files.refreshFiles();
        return result;
      },
    };
  }

  private createWorkspaceHost(): WorkspaceHost {
    return {
      requestRender: () => { this.requestUpdate(); },
    };
  }

  private createWorkspacePanelTerminal(workspace: Workspace, machineId: string, origin: string): WorkspacePanelTerminal {
    const terminalCommandRuns = this.terminalCommandRunsForOrigin(origin, machineId);
    return {
      open: (options) => { void this.openRuntimeTerminal(machineId, workspace, options); },
      runCommand: (input) => terminalCommandRuns.runCommand({ ...input, workspace }),
    };
  }

  private createWorkspacePanelContext(workspace: Workspace): WorkspacePanelContext {
    const machine = pluginMachineFromState(this.state);
    const machineId = machine.id;
    const createContext = (origin: string): WorkspacePanelContext => {
      const terminalCommandRuns = this.terminalCommandRunsForOrigin(origin, machineId);
      return installWorkspacePanelScope({
        machine,
        workspace,
        state: this.state,
        files: this.createWorkspaceFiles(workspace, machineId),
        prompt: this.createPromptEditor(),
        terminal: this.createWorkspacePanelTerminal(workspace, machineId, origin),
        openTerminal: (options) => { void this.openRuntimeTerminal(machineId, workspace, options); },
        host: this.createWorkspaceHost(),
        piWebUiUnstable: { terminalCommandRuns },
        fileTree: this.state.fileTree,
        expandedDirs: this.state.expandedDirs,
        selectedFilePath: this.state.selectedFilePath,
        selectedFileContent: this.state.selectedFileContent,
        fileTreeStale: this.state.fileTreeStale,
        gitStatus: this.state.gitStatus,
        selectedDiffPath: this.state.selectedDiffPath,
        selectedDiff: this.state.selectedDiff,
        selectedStagedDiff: this.state.selectedStagedDiff,
        gitStale: this.state.gitStale,
        activeTerminalCount: this.state.activeTerminalCount,
        selectedTerminalId: this.state.selectedTerminalId,
        terminalAutoStart: this.terminalAutoStartWorkspaceId === workspace.id,
        workspaceUploadDefaultFolder: workspaceEffectiveUploadFolder(workspace.effectiveConfig, this.workspaceUploadDefaultFolder),
        onRefreshFiles: () => { void this.files.refreshFiles(); },
        onExpandDir: (path: string) => { void this.files.expandDir(path); },
        onSelectFile: (path: string) => { void this.files.selectFile(path); },
        onStartWorkspaceUpload: (files, options) => this.files.startWorkspaceUpload(files, options),
        onCancelWorkspaceUpload: (batchId) => { this.files.cancelWorkspaceUpload(batchId); },
        onClearWorkspaceUpload: (batchId) => { this.files.clearWorkspaceUpload(batchId); },
        onRefreshGit: () => { void this.git.refreshGit(); },
        onRefreshMemory: () => { void this.memory.refresh(); },
        onSelectDiff: (path: string) => { void this.git.selectDiff(path); },
        onSelectTerminal: (terminalId: string | undefined, options?: { replace?: boolean | undefined }) => { this.selectTerminal(terminalId, options); },
      }, createContext);
    };
    return createContext("core");
  }

  private getActions(): AppAction[] {
    return applyActiveShortcutPreferences(this.getDefaultActions(), this.shortcutConfig);
  }

  private getDefaultActions(): AppAction[] {
    return [...this.plugins.getActions(this.createPluginRuntimeContext()), ...this.sessionActions(), ...this.navigationFocusActions(), ...this.panelLayoutActions()];
  }

  private sessionActions(): AppAction[] {
    const canCleanup = this.canCleanupSessions();
    return [
      {
        id: "app.sessions.cleanup",
        title: "Clean Up Sessions",
        description: "Preview and manually clean up idle or archived sessions on the selected machine",
        group: "Sessions",
        closesActionPalette: true,
        ...(canCleanup ? {} : { enabled: false, disabledReason: this.sessionCleanupUnavailableMessage() }),
        run: () => { this.openSessionCleanupDialog(); },
      },
    ];
  }

  private panelLayoutActions(): AppAction[] {
    return [
      {
        id: "app.layout.toggle-terminal-tab",
        title: this.terminalTabHidden ? "Show Terminal Tab" : "Hide Terminal Tab",
        description: this.terminalTabHidden
          ? "Show the terminal tab in the workspace panel"
          : "Hide the terminal tab from the workspace panel",
        group: "View",
        run: () => { this.toggleTerminalTab(); },
      },
      {
        id: "app.layout.toggle-info-tab",
        title: this.infoTabHidden ? "Show Info Tab" : "Hide Info Tab",
        description: this.infoTabHidden
          ? "Show the info tab in the workspace panel"
          : "Hide the info tab from the workspace panel",
        group: "View",
        run: () => { this.toggleInfoTab(); },
      },
      {
        id: "app.layout.reset-navigation-panel-size",
        title: "Reset Navigation Panel Size",
        description: "Restore the navigation panel to its default width",
        group: "View",
        run: () => { this.resetResizablePanel("navigation"); },
      },
      {
        id: "app.layout.reset-workspace-panel-size",
        title: "Reset Workspace Panel Size",
        description: "Restore the workspace panel to its default width",
        group: "View",
        run: () => { this.resetResizablePanel("workspace"); },
      },
      {
        id: "app.layout.reset-panel-sizes",
        title: "Reset Panel Sizes",
        description: "Restore all side panels to their default widths",
        group: "View",
        run: () => { this.resetResizablePanels(); },
      },
    ];
  }

  private navigationFocusActions(): AppAction[] {
    return [
      {
        id: "app.navigation.focus-machines",
        title: "Focus Machines",
        description: "Move keyboard focus to the machine selector",
        shortcut: "mod+g m",
        group: "Navigation",
        closesActionPalette: true,
        run: () => this.focusNavigationSection("machines"),
      },
      {
        id: "app.navigation.focus-projects",
        title: "Focus Projects",
        description: "Move keyboard focus to the projects list",
        shortcut: "mod+g p",
        group: "Navigation",
        closesActionPalette: true,
        run: () => this.focusNavigationSection("projects"),
      },
      {
        id: "app.navigation.focus-workspaces",
        title: "Focus Workspaces",
        description: "Move keyboard focus to the workspaces list",
        shortcut: "mod+g w",
        group: "Navigation",
        closesActionPalette: true,
        run: () => this.focusNavigationSection("workspaces"),
      },
      {
        id: "app.navigation.focus-sessions",
        title: "Focus Sessions",
        description: "Move keyboard focus to the sessions list",
        shortcut: "mod+g s",
        group: "Navigation",
        closesActionPalette: true,
        run: () => this.focusNavigationSection("sessions"),
      },
    ];
  }

  private ensureGatewayPluginsLoaded(): Promise<void> {
    this.gatewayPluginLoadPromise ??= this.loadExternalPlugins();
    return this.gatewayPluginLoadPromise;
  }

  private async loadExternalPlugins(): Promise<void> {
    await this.registerExternalPlugins("PI WEBUI plugins", () => loadExternalPlugins());
  }

  private async loadPluginsForSelectedMachine(): Promise<void> {
    const machine = this.state.selectedMachine;
    if (machine?.kind !== "remote") return;
    await this.loadPluginsForMachine(machine);
  }

  private async loadPluginsForMachine(machine: Machine): Promise<void> {
    await this.ensureGatewayPluginsLoaded();
    if (machine.kind !== "remote" || this.loadedMachinePluginIds.has(machine.id)) return;
    const existing = this.machinePluginLoadPromises.get(machine.id);
    if (existing !== undefined) return existing;

    const load = this.registerExternalPlugins(`PI WEBUI plugins from ${machine.name}`, () => loadExternalPlugins(`api/machines/${encodeURIComponent(machine.id)}/pi-webui-plugins/manifest.json`, {
      machineId: machine.id,
      shouldLoadPlugin: (entry) => this.plugins.shouldLoadRemotePlugin(entry.id, entry.machineSpecific),
    }))
      .then((loaded) => { if (loaded) this.loadedMachinePluginIds.add(machine.id); })
      .finally(() => { this.machinePluginLoadPromises.delete(machine.id); });
    this.machinePluginLoadPromises.set(machine.id, load);
    await load;
  }

  private async registerExternalPlugins(label: string, load: () => Promise<PiWebUiPluginRegistration[]>): Promise<boolean> {
    try {
      const registrations = await load();
      for (const registration of registrations) {
        try {
          this.plugins.register(registration);
        } catch (error) {
          console.warn(`Failed to register PI WEBUI plugin ${registration.id}`, error);
        }
      }
      this.synchronizeMemoryPollingForSelectedWorkspace();
      this.applyPreferredTheme(false);
      this.requestUpdate();
      return true;
    } catch (error) {
      console.warn(`Failed to load ${label}`, error);
      return false;
    }
  }

  private createPromptEditor(): PluginPromptEditor {
    return {
      insertText: (text: string) => {
        const editor = this.promptEditor?.view;
        if (!editor) return;
        if (!editor.hasFocus) editor.focus();
        const sel = editor.state.selection.main;
        editor.dispatch({
          changes: { from: sel.from, to: sel.to, insert: text },
          selection: { anchor: sel.from + text.length },
        });
      },
      getText: () => {
        return this.promptEditor?.view?.state.doc.toString() ?? "";
      },
      getSelection: () => {
        const editor = this.promptEditor?.view;
        if (!editor) return null;
        const sel = editor.state.selection.main;
        if (sel.empty) return null;
        return { start: sel.from, end: sel.to, text: editor.state.sliceDoc(sel.from, sel.to) };
      },
    };
  }

  private createPluginRuntimeContext(): PluginRuntimeContext {
    return this.createPluginRuntimeContextForOrigin("core", selectedMachineId(this.state));
  }

  private createPluginRuntimeContextForOrigin(origin: string, machineId: string): PluginRuntimeContext {
    const createContext = (scopedOrigin: string): PluginRuntimeContext => installPluginRuntimeScope({
      state: this.state,
      prompt: this.createPromptEditor(),
      piWebUiUnstable: {
        terminalCommandRuns: this.terminalCommandRunsForOrigin(scopedOrigin, machineId),
        openSettings: (section) => { this.openSettings(section); },
      },
      openActionPalette: () => { this.setState({ actionPaletteOpen: true }); },
      focusPrompt: () => { void this.focusChatComposer(); },
      addProject: () => { this.openProjectDialog(); },
      addMachine: () => { this.openMachineDialog(); },
      refreshSelectedMachine: async () => {
        await Promise.all([this.machines.refreshMachineHealth(), this.machines.refreshMachineRuntime()]);
      },
      removeSelectedMachine: () => this.removeMachine(),
      openSelectedMachine: () => { this.openSelectedMachine(); },
      configureAuth: () => this.auth.openLogin(),
      logoutAuth: () => this.auth.openLogout(),
      openThemePicker: () => { this.openThemeDialog(); },
      selectMainView: (view) => { this.selectMainView(view); },
      selectWorkspaceTool: (tool) => { this.openWorkspaceTool(tool); },
      openTerminal: (options) => { this.openTerminal(options); },
      refreshFiles: () => this.files.refreshFiles(),
      refreshGit: () => this.git.refreshGit(),
      refreshAppData: () => this.refreshAppData(),
      checkForPiWebUiUpdates: () => this.piWebUiStatusController.checkForUpdates(),
      reloadPage: () => { this.hardReloadApp(); },
      deleteWorkspace: (workspace) => this.deleteWorkspace(workspace),
      startSession: () => this.withChatScrollTransition(() => this.startSessionAndOpenChat()),
      archiveSession: () => this.sessions.archiveSession(),
      reloadSession: () => this.sessions.reloadSession(),
      deleteCachedNewSession: () => this.sessions.deleteCachedNewSession(),
      stopActiveWork: () => this.sessions.stopActiveWork(),
    }, createContext);
    return createContext(origin);
  }

  private createActivityRailContext(contributionId: QualifiedContributionId): ActivityRailContext {
    const machine = pluginMachineFromState(this.state);
    const workspace = this.state.selectedWorkspace;
    // Activity callbacks can outlive a render, so host.close is valid only for this active instance.
    const activityRailGeneration = this.activeActivityRailId === contributionId
      ? this.activeActivityRailGeneration
      : undefined;
    const createContext = (origin: string): InternalActivityRailContext => installActivityRailScope({
      ...this.createPluginRuntimeContextForOrigin(origin, machine.id),
      machine,
      ...(workspace === undefined ? {} : {
        workspaceScope: {
          workspace,
          files: this.createWorkspaceFiles(workspace, machine.id),
          terminal: this.createWorkspacePanelTerminal(workspace, machine.id, origin),
        },
      }),
      host: {
        requestRender: () => { this.requestUpdate(); },
        close: () => {
          if (activityRailGeneration !== undefined) {
            this.closeActivityRailItem(contributionId, activityRailGeneration);
          }
        },
      },
      onRefreshMemory: () => { void this.memory.refresh(); },
    }, createContext);
    return createContext("core");
  }

  private activityRailItems(): ActivityRailDisplayItem[] {
    const activities = this.plugins.getActivityRailItems();
    this.synchronizeMemoryPollingForSelectedWorkspace(activities);
    return activities.flatMap((activity) => this.projectActivityRailItems(
      [activity],
      this.createActivityRailContext(activity.id),
    ));
  }

  private projectActivityRailItems(
    items: readonly QualifiedActivityRailContribution[],
    context: ActivityRailContext,
  ): ActivityRailDisplayItem[] {
    return visibleActivityRailItems(items, context, this.reportActivityRailError);
  }

  private activeActivityRailItem(): ActiveActivityRailItem | undefined {
    const id = this.activeActivityRailId;
    if (id === undefined) return undefined;
    const resolved = this.resolveActivityRailItem(id);
    return resolved === undefined ? undefined : { ...resolved, generation: this.activeActivityRailGeneration };
  }

  private openActivityRailItem(id: QualifiedContributionId, restoreFocus: () => void): void {
    if (this.resolveActivityRailItem(id) === undefined) return;
    this.closeCompactActivityRail();
    this.activityRailRestoreFocus = restoreFocus;
    this.activeActivityRailGeneration += 1;
    this.activeActivityRailId = id;
  }

  private resolveActivityRailItem(id: QualifiedContributionId): ResolvedActivityRailItem | undefined {
    const activity = this.plugins.getActivityRailItems().find((item) => item.id === id);
    if (activity === undefined) return undefined;
    const context = this.createActivityRailContext(id);
    if (!this.projectActivityRailItems([activity], context).some((item) => item.id === id)) return undefined;
    return { activity, context };
  }

  private closeActivityRailItem(id: QualifiedContributionId, generation: number): void {
    if (this.activeActivityRailId !== id || this.activeActivityRailGeneration !== generation) return;
    const restoreFocus = this.activityRailRestoreFocus;
    this.activityRailRestoreFocus = undefined;
    this.activeActivityRailId = undefined;
    if (restoreFocus !== undefined) void this.updateComplete.then(() => {
      if (this.activeActivityRailId === undefined) restoreFocus();
    });
  }

  private readonly closeCompactActivityRail = (): void => {
    if (!this.compactRailOpen) return;
    this.compactRailOpen = false;
    const launcher = this.compactActivityRailLauncher;
    void this.updateComplete.then(() => {
      if (!this.compactRailOpen && this.activeActivityRailId === undefined) {
        if (launcher !== undefined) this.restoreActivityRailFocus(launcher);
        else this.currentCompactActivityRailLauncher()?.focus();
      }
    });
  };

  private readonly toggleCompactActivityRail = (source?: HTMLElement): void => {
    if (this.appShell.isDesktopActivityRailLayout) return;
    if (!this.compactRailOpen && source !== undefined) this.compactActivityRailLauncher = source;
    this.compactRailOpen = !this.compactRailOpen;
  };

  private restoreActivityRailFocus(source: HTMLElement): void {
    if (source.isConnected) {
      source.focus();
      return;
    }
    const compactLauncher = this.compactActivityRailLauncher;
    if (compactLauncher?.isConnected === true) {
      compactLauncher.focus();
      return;
    }
    this.currentCompactActivityRailLauncher()?.focus();
  }

  private currentCompactActivityRailLauncher(): HTMLElement | undefined {
    const contextBar = this.renderRoot.querySelector("app-context-bar");
    const launcher = contextBar?.shadowRoot?.querySelector<HTMLElement>(".activity-rail-action-button");
    return launcher?.isConnected === true ? launcher : undefined;
  }

  private async deleteWorkspace(workspace = this.state.selectedWorkspace): Promise<void> {
    if (workspace === undefined) return;
    if (!canDeleteWorkspace(workspace)) {
      this.setState({ error: "Only secondary Git worktrees can be deleted" });
      return;
    }
    if (isWorkspaceDeletionPending(this.state, workspace)) return;
    const label = workspace.branch ?? workspace.label;
    const confirmed = confirm(`Delete workspace ${label}?\n\nThis will run git worktree remove and delete:\n${workspace.path}\n\nThe Git branch will not be deleted.`);
    if (!confirmed) return;

    const machineId = selectedMachineId(this.state);
    try {
      const run = await workspacesApi.deleteWorkspace(workspace.projectId, workspace.id, machineId);
      if (selectedMachineId(this.state) !== machineId) return;
      this.recordWorkspaceDeletionRun(run, machineId);
      const commandWorkspace = await this.workspaceForCommandRun(run);
      if (selectedMachineId(this.state) !== machineId) return;
      if (commandWorkspace !== undefined) void this.openRuntimeTerminal(machineId, commandWorkspace, { terminalId: run.terminalId });
    } catch (error) {
      if (selectedMachineId(this.state) === machineId) this.setState({ error: `Failed to start workspace deletion: ${errorMessage(error)}` });
    }
  }

  private async workspaceForCommandRun(run: TerminalCommandRun): Promise<Workspace | undefined> {
    let workspaces = this.state.selectedProject?.id === run.projectId ? this.state.workspaces : this.state.workspacesByProjectId[run.projectId];
    if (workspaces === undefined || workspaces.length === 0) workspaces = await this.workspaces.refreshProjectWorkspaces(run.projectId);
    return workspaces.find((workspace) => workspace.id === run.workspaceId);
  }

  private recordWorkspaceDeletionRun(run: TerminalCommandRun, machineId: string): void {
    if (selectedMachineId(this.state) !== machineId) return;
    const workspaceId = targetWorkspaceIdForRun(run);
    if (workspaceId === undefined) return;
    this.setState({ workspaceDeletionRuns: { ...this.state.workspaceDeletionRuns, [workspaceId]: run } });
    this.updateWorkspaceDeletionPolling();
  }

  private async refreshWorkspaceDeletionRuns(): Promise<void> {
    if (this.refreshingWorkspaceDeletionRuns) return;
    const machineId = selectedMachineId(this.state);
    const project = this.state.selectedProject;
    if (project === undefined) {
      this.setState({ workspaceDeletionRuns: {} });
      this.updateWorkspaceDeletionPolling();
      return;
    }

    this.refreshingWorkspaceDeletionRuns = true;
    try {
      const runs = await this.terminalCommandRunsForOrigin("core", machineId).listCommandRuns(workspaceDeletionRunFilter(project.id));
      if (selectedMachineId(this.state) !== machineId) return;
      const latestRuns = latestWorkspaceDeletionRuns(runs);
      this.setState({ workspaceDeletionRuns: latestRuns });
      for (const run of Object.values(latestRuns)) {
        if (!isWorkspaceDeletionRunPending(run)) await this.handleCompletedWorkspaceDeletionRun(run, machineId);
      }
    } catch (error) {
      console.warn("Failed to refresh workspace deletion runs", error);
    } finally {
      this.refreshingWorkspaceDeletionRuns = false;
      this.updateWorkspaceDeletionPolling();
    }
  }

  private updateWorkspaceDeletionPolling(): void {
    const hasPendingDeletion = Object.values(this.state.workspaceDeletionRuns).some(isWorkspaceDeletionRunPending);
    if (hasPendingDeletion && this.workspaceDeletionPollTimer === undefined) {
      this.workspaceDeletionPollTimer = window.setInterval(() => { void this.refreshWorkspaceDeletionRuns(); }, 1000);
      return;
    }
    if (!hasPendingDeletion && this.workspaceDeletionPollTimer !== undefined) {
      window.clearInterval(this.workspaceDeletionPollTimer);
      this.workspaceDeletionPollTimer = undefined;
    }
  }

  private async handleCompletedWorkspaceDeletionRun(run: TerminalCommandRun, machineId = selectedMachineId(this.state)): Promise<void> {
    if (selectedMachineId(this.state) !== machineId) return;
    const runKey = machineScopedKey(machineId, run.id);
    if (this.handledWorkspaceDeletionRunIds.has(runKey)) return;
    const workspaceId = targetWorkspaceIdForRun(run);
    if (workspaceId === undefined) return;
    this.handledWorkspaceDeletionRunIds.add(runKey);

    if (run.status === "succeeded") {
      await this.workspaces.refreshAfterWorkspaceDeleted(run.projectId, workspaceId);
      if (selectedMachineId(this.state) !== machineId) return;
      this.setState({ workspaceDeletionRuns: omitWorkspaceDeletionRun(this.state.workspaceDeletionRuns, workspaceId) });
      this.updateWorkspaceDeletionPolling();
      return;
    }

    if (run.status === "failed") {
      this.setState({ error: "Workspace deletion failed. See terminal output." });
      this.updateWorkspaceDeletionPolling();
    }
  }

  private openProjectBrowser(restoreFocus: () => void): void {
    this.projectBrowserRestoreFocus = restoreFocus;
    this.projectBrowserOpen = true;
  }

  private closeProjectBrowser(options: { restoreFocus?: boolean } = {}): void {
    const restoreFocus = options.restoreFocus === true ? this.projectBrowserRestoreFocus : undefined;
    this.projectBrowserRestoreFocus = undefined;
    this.projectBrowserOpen = false;
    if (restoreFocus !== undefined) void this.updateComplete.then(() => { restoreFocus(); });
  }

  private selectProjectFromBrowser(project: Project): void {
    this.closeProjectBrowser();
    void this.selectNavigationItem("projects", "workspaces", () => this.workspaces.selectProject(project));
  }

  private addProjectFromBrowser(): void {
    this.closeProjectBrowser();
    this.openProjectDialog();
  }

  private openSessionBrowser(restoreFocus: () => void): void {
    if (this.state.selectedProject === undefined) return;
    this.sessionBrowserRestoreFocus = restoreFocus;
    this.sessionBrowserOpen = true;
  }

  private closeSessionBrowser(options: { restoreFocus?: boolean } = {}): void {
    const restoreFocus = options.restoreFocus === true ? this.sessionBrowserRestoreFocus : undefined;
    this.sessionBrowserRestoreFocus = undefined;
    this.sessionBrowserOpen = false;
    if (restoreFocus !== undefined) void this.updateComplete.then(() => { restoreFocus(); });
  }

  private selectSessionFromBrowser(session: SessionInfo): void {
    this.closeSessionBrowser();
    void this.selectNavigationItem("sessions", "chat", () => this.selectSessionFromNavigation(session));
  }

  private openProjectDialog(): void {
    this.setState({ projectDialogOpen: true });
  }

  private openMachineDialog(): void {
    this.setState({ machineDialogOpen: true, error: "" });
  }

  private async submitMachineDialog(input: MachineDialogSubmit): Promise<void> {
    const machine = await this.machines.addMachine(input);
    if (machine !== undefined) {
      this.setState({ machineDialogOpen: false });
      this.schedulePiWebUiStatusRefresh();
    }
  }

  private async removeMachine(machine: Machine | undefined = this.state.selectedMachine): Promise<void> {
    if (machine === undefined || machine.kind === "local") return;
    if (!window.confirm(`Remove ${machine.name}?\n\nThis only removes it from this PI WEBUI gateway.`)) return;
    const wasSelected = this.state.selectedMachine?.id === machine.id;
    if (wasSelected) this.rememberCurrentMachineNavigation();
    const fallback = await this.machines.deleteMachine(machine, { selectFallback: !wasSelected });
    if (!this.state.machines.some((candidate) => candidate.id === machine.id)) this.machineNavigation.forget(machine.id);
    if (wasSelected && fallback !== undefined) await this.selectMachineWithMemory(fallback, { rememberCurrent: false });
  }

  private openSelectedMachine(): void {
    const machine = this.state.selectedMachine;
    if (machine?.kind !== "remote" || machine.baseUrl === undefined) return;
    window.open(machine.baseUrl, "_blank", "noopener,noreferrer");
  }

  private runAction(action: AppAction): void {
    void Promise.resolve()
      .then(() => action.run())
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Action failed: ${action.id}`, error);
        this.setState({ error: `Action failed: ${message}` });
      });
  }

  private async openModelDialog() {
    const models = await this.sessions.listModels();
    const currentProvider = this.state.status?.model?.provider;
    const currentId = this.state.status?.model?.id;
    const sorted = [...models].sort((a, b) => {
      const providerA = a.provider ?? "";
      const providerB = b.provider ?? "";
      if (providerA !== providerB) return providerA.localeCompare(providerB);
      return (a.id ?? "").localeCompare(b.id ?? "");
    });
    this.setState({
      modelDialog: {
        title: "Select Model",
        ...(currentProvider !== undefined && currentId !== undefined ? { selectedValue: `${currentProvider}/${currentId}` } : {}),
        options: sorted.map((model) => {
          const provider = model.provider ?? "";
          const id = model.id ?? "";
          const isCurrent = provider === currentProvider && id === currentId;
          return {
            value: `${provider}/${id}`,
            label: id + (isCurrent ? " ✓ current" : ""),
            ...(provider === "" ? {} : { group: provider }),
          };
        }),
      },
    });
  }

  private async pickModel(value: string) {
    this.setState({ modelDialog: undefined });
    const slash = value.indexOf("/");
    if (slash <= 0) return;
    await this.sessions.setModel(value.slice(0, slash), value.slice(slash + 1));
  }

  private openStarterModelDialog(): void {
    const defaults = this.starterSessionDefaults;
    if (defaults === undefined) return;
    const currentProvider = defaults.model?.provider;
    const currentId = defaults.model?.id;
    const sorted = [...defaults.models].sort((a, b) => {
      const providerA = a.provider ?? "";
      const providerB = b.provider ?? "";
      if (providerA !== providerB) return providerA.localeCompare(providerB);
      return (a.id ?? "").localeCompare(b.id ?? "");
    });
    this.setState({
      modelDialog: {
        title: "Select Default Model",
        source: "starter",
        ...(currentProvider !== undefined && currentId !== undefined ? { selectedValue: `${currentProvider}/${currentId}` } : {}),
        options: sorted.map((model) => {
          const provider = model.provider ?? "";
          const id = model.id ?? "";
          const isCurrent = provider === currentProvider && id === currentId;
          return {
            value: `${provider}/${id}`,
            label: id + (isCurrent ? " ✓ current" : ""),
            ...(provider === "" ? {} : { group: provider }),
          };
        }),
      },
    });
  }

  private async pickStarterModel(value: string): Promise<void> {
    this.setState({ modelDialog: undefined });
    const slash = value.indexOf("/");
    if (slash <= 0) return;
    await this.updateStarterSessionDefaults({ model: { provider: value.slice(0, slash), modelId: value.slice(slash + 1) } });
  }

  private openThemeDialog() {
    const themes = this.plugins.getThemes();
    const resolution = this.resolveCurrentThemePreference(themes);
    const selectedThemeId = resolution.selectedTheme?.id;
    const autoValue = this.themePreference.auto ? THEME_AUTO_OFF_VALUE : THEME_AUTO_ON_VALUE;
    this.setState({
      themeDialog: {
        title: "Select Theme",
        selectedValue: selectedThemeId === undefined ? autoValue : `${THEME_OPTION_PREFIX}${selectedThemeId}`,
        options: [
          {
            value: autoValue,
            label: `Auto ${this.themePreference.auto ? "✓ on" : "off"}`,
            description: this.autoThemeDescription(resolution),
          },
          ...themes.map((theme) => ({
            value: `${THEME_OPTION_PREFIX}${theme.id}`,
            label: this.themeOptionLabel(theme, selectedThemeId),
            description: this.themeOptionDescription(theme),
          })),
        ],
      },
    });
  }

  private pickTheme(value: string) {
    this.setState({ themeDialog: undefined });
    if (value === THEME_AUTO_ON_VALUE || value === THEME_AUTO_OFF_VALUE) {
      const selectedThemeId = this.resolveCurrentThemePreference().selectedTheme?.id;
      if (selectedThemeId === undefined) return;
      this.themePreference = { themeId: selectedThemeId, auto: value === THEME_AUTO_ON_VALUE };
      this.applyPreferredTheme(true);
      return;
    }
    if (!value.startsWith(THEME_OPTION_PREFIX)) return;
    const themeId = value.slice(THEME_OPTION_PREFIX.length);
    const theme = this.plugins.getThemes().find((candidate) => candidate.id === themeId);
    if (theme === undefined) return;
    this.themePreference = { themeId: theme.id, auto: this.themePreference.auto };
    this.applyPreferredTheme(true);
  }

  private applyPreferredTheme(persist: boolean): void {
    const theme = this.resolveCurrentThemePreference().activeTheme;
    if (theme === undefined) return;
    this.activeThemeId = theme.id;
    applyPiWebUiTheme(theme);
    if (persist) writeStoredThemePreference(this.themePreference);
  }

  private resolveCurrentThemePreference(themes = this.plugins.getThemes()): ThemePreferenceResolution {
    return resolveThemePreference({
      themes,
      themePairs: this.plugins.getThemePairs(),
      preference: this.themePreference,
      prefersLight: this.systemPrefersLight(),
    });
  }

  private themePairForTheme(themeId: QualifiedContributionId): QualifiedThemePairContribution | undefined {
    return findThemePairForTheme(this.plugins.getThemePairs(), themeId);
  }

  private systemPrefersLight(): boolean {
    return this.systemLightThemeMedia?.matches ?? false;
  }

  private autoThemeDescription(resolution: ThemePreferenceResolution): string {
    if (!this.themePreference.auto) return "Follow the system light/dark preference when the selected theme has a pair.";
    if (resolution.selectedTheme === undefined) return "Follow the system light/dark preference when the selected theme has a pair.";
    if (resolution.selectedThemePair === undefined) return "On, but the selected theme has no light/dark pair, so it will stay selected.";
    return `On · ${resolution.selectedThemePair.name} follows the system ${this.systemPrefersLight() ? "light" : "dark"} preference.`;
  }

  private themeOptionLabel(theme: QualifiedThemeContribution, selectedThemeId: QualifiedContributionId | undefined): string {
    const markers = [
      ...(theme.id === selectedThemeId ? ["selected"] : []),
      ...(theme.id === this.activeThemeId && theme.id !== selectedThemeId ? ["active"] : []),
    ];
    return markers.length === 0 ? theme.name : `${theme.name} ✓ ${markers.join(" · ")}`;
  }

  private themeOptionDescription(theme: QualifiedThemeContribution): string {
    const parts: string[] = [theme.colorScheme];
    if (this.themePairForTheme(theme.id) !== undefined) parts.push("auto pair");
    if (theme.description !== undefined) parts.push(theme.description);
    return parts.join(" · ");
  }

  private async openThinkingDialog() {
    const levels = await this.sessions.listThinkingLevels();
    const current = this.state.status?.thinkingLevel ?? "off";
    this.setState({
      thinkingDialog: {
        title: "Select Thinking Level",
        selectedValue: current,
        options: levels.map((level) => { const description = thinkingDescription(level); return { value: level, label: `${level}${level === current ? " ✓ current" : ""}`, ...(description === undefined ? {} : { description }) }; }),
      },
    });
  }

  private async pickThinking(value: string) {
    this.setState({ thinkingDialog: undefined });
    if (value !== "") await this.sessions.setThinkingLevel(value);
  }

  private openStarterThinkingDialog(): void {
    const defaults = this.starterSessionDefaults;
    if (defaults === undefined) return;
    const current = defaults.thinkingLevel;
    this.setState({
      thinkingDialog: {
        title: "Select Default Thinking Level",
        source: "starter",
        selectedValue: current,
        options: defaults.thinkingLevels.map((level) => { const description = thinkingDescription(level); return { value: level, label: `${level}${level === current ? " ✓ current" : ""}`, ...(description === undefined ? {} : { description }) }; }),
      },
    });
  }

  private async pickStarterThinking(value: string): Promise<void> {
    this.setState({ thinkingDialog: undefined });
    if (value !== "") await this.updateStarterSessionDefaults({ thinkingLevel: value });
  }

  private async updateStarterSessionDefaults(update: SessionDefaultsUpdate): Promise<void> {
    const workspace = this.state.selectedWorkspace;
    if (workspace === undefined) return;
    const machineId = selectedMachineId(this.state);
    try {
      const defaults = await sessionsApi.updateSessionDefaults(workspace.path, update, machineId);
      if (selectedMachineId(this.state) !== machineId || this.state.selectedWorkspace?.id !== workspace.id) return;
      this.starterSessionDefaults = defaults;
      this.linkStarterExactBranch(defaults);
    } catch (error) {
      if (selectedMachineId(this.state) === machineId && this.state.selectedWorkspace?.id === workspace.id) this.setState({ error: String(error) });
    }
  }

  private sendPrompt(text: string, streamingBehavior?: "steer" | "followUp", attachments?: import("../api").PromptAttachment[], delivery?: import("../../../shared/apiTypes").PromptAttachmentDelivery): void {
    const hasAttachments = attachments !== undefined && attachments.length > 0;
    if (!hasAttachments && streamingBehavior === undefined && this.auth.handleSlashCommand(text)) return;
    void this.sessions.send(text, streamingBehavior, attachments, delivery);
  }

  // Stable handler identities for child components. Inlined arrow closures
  // would be a fresh reference on every render, forcing Lit to re-commit the
  // bindings each time the app re-renders; bound class fields keep them constant.
  private readonly handleSendPrompt = (text: string, streamingBehavior?: "steer" | "followUp", attachments?: import("../api").PromptAttachment[], delivery?: import("../../../shared/apiTypes").PromptAttachmentDelivery): void => {
    this.sendPrompt(text, streamingBehavior, attachments, delivery);
  };

  private readonly handleStartSessionPrompt = (text: string, streamingBehavior?: "steer" | "followUp", attachments?: import("../api").PromptAttachment[], delivery?: import("../../../shared/apiTypes").PromptAttachmentDelivery): void => {
    const hasAttachments = attachments !== undefined && attachments.length > 0;
    if (!hasAttachments && streamingBehavior === undefined && this.auth.handleSlashCommand(text)) return;
    // Capture the starter state before the controller inserts and selects its
    // pending row. A failed start retains this draft for a retry; a successful
    // stale completion cannot clear a newer draft or another workspace's draft.
    const workspaceId = this.state.selectedWorkspace?.id;
    const starterModelPolicy = this.starterModelPolicy;
    const modelPolicy = this.starterModelPolicyStartSnapshot();
    void this.sessions.startSessionWithPrompt(
      text,
      streamingBehavior,
      attachments,
      delivery,
      modelPolicy,
      (started) => {
        this.clearStarterModelPolicyAfterSuccessfulStart(started, workspaceId, starterModelPolicy);
      },
    ).catch((error: unknown) => {
      this.setState({ error: String(error) });
    });
    void this.focusChatComposer();
  };

  private readonly handleSelectStarterModel = (): void => {
    this.openStarterModelDialog();
  };

  private readonly handleSelectStarterThinking = (): void => {
    this.openStarterThinkingDialog();
  };

  /**
   * Opening either policy dialog is what triggers the catalog read: the control's
   * unavailable-state retry calls `onOpen` alone and distinguishes a missing
   * policy from a missing catalog, so catalog recovery depends on this.
   */
  private readonly handleOpenStarterModelPolicy = (): void => {
    void this.loadModelTierCatalog(selectedMachineId(this.state));
  };

  /**
   * Apply a starter choice to the local draft only. Choosing Tiered here must not
   * write a global Pi default; the transition and its validity check both come
   * from the pure draft module, so no policy decision is made in this component.
   */
  private readonly handleSaveStarterModelPolicy = (update: SessionModelPolicyUpdate): void => {
    const current = this.starterModelPolicy;
    const catalog = this.selectedMachineModelTierCatalog();
    if (current === undefined || catalog === undefined) return;
    const draft = modelPolicyDraftFromPolicy(current);
    const next = update.mode === "tiered"
      ? selectDraftTier(draft, update.tier)
      : { ...draft, mode: "exact" as const, exact: update.exact };
    if (sessionModelPolicyUpdateFromDraft(next, catalog) === undefined) return;
    this.starterModelPolicy = {
      mode: next.mode,
      exact: { model: { ...next.exact.model }, thinkingLevel: next.exact.thinkingLevel },
      ...(next.tier === undefined ? {} : { tier: next.tier }),
    };
  };

  private readonly handleOpenActiveModelPolicy = (): void => {
    void this.sessions.loadModelPolicy();
    void this.loadModelTierCatalog(selectedMachineId(this.state));
  };

  /**
   * Drop the held inspection response when the dialog closes. Every exact-route
   * model/thinking mutation supersedes it, and keeping it would either cost a
   * redundant policy GET with a transient `modelPolicy: undefined` or leave a
   * superseded remembered branch on screen.
   */
  private readonly handleCloseActiveModelPolicy = (): void => {
    this.setState({ modelPolicy: undefined, modelPolicyError: undefined });
  };

  private readonly handleSaveActiveModelPolicy = (update: SessionModelPolicyUpdate): void => {
    void this.sessions.saveModelPolicy(update);
  };

  private readonly handleOpenTerminalFromRail = (): void => {
    this.closeCompactActivityRail();
    if (this.state.selectedWorkspace === undefined) return;
    this.terminalModalOpen = true;
  };

  private readonly handleOpenGitUpdateManagerFromRail = (): void => {
    this.closeCompactActivityRail();
    if (this.state.selectedWorkspace === undefined) return;
    this.gitUpdateManagerPanelOpen = true;
  };

  private readonly handleCloseGitUpdateManagerPanel = (): void => {
    this.gitUpdateManagerPanelOpen = false;
  };

  private applyGitUpdateManagerStatus(workspace: Workspace, machineId: string, gitStatus: GitStatusResponse): void {
    const selectedWorkspace = this.state.selectedWorkspace;
    if (selectedMachineId(this.state) !== machineId || selectedWorkspace?.id !== workspace.id || selectedWorkspace.projectId !== workspace.projectId) return;
    this.setState({ gitStatus, gitStale: false });
  }

  private readonly handleOpenThemeFromRail = (): void => {
    this.closeCompactActivityRail();
    this.openThemeDialog();
  };

  private readonly handleRailOrderChange = (order: ReorderableRailItem[]): void => {
    this.railOrder = order;
    writeRailOrder(order);
  };

  private readonly handleCloseTerminalModal = (): void => {
    this.finishTerminalModalPointerInteraction();
    this.terminalModalOpen = false;
  };

  private readonly toggleTerminalModalMaximized = (): void => {
    this.finishTerminalModalPointerInteraction();
    this.terminalModalMaximized = !this.terminalModalMaximized;
  };

  private readonly handleTerminalModalMovePointerDown = (event: TerminalModalPointerEvent): void => {
    this.startTerminalModalPointerInteraction("move", event);
  };

  private readonly handleTerminalModalResizePointerDown = (event: TerminalModalPointerEvent): void => {
    this.startTerminalModalPointerInteraction("resize", event);
  };

  private readonly handleTerminalModalPointerMove = (event: TerminalModalPointerEvent): void => {
    const interaction = this.terminalModalPointerInteraction;
    if (interaction?.pointerId !== event.pointerId) return;
    event.preventDefault();
    const delta = { x: event.clientX - interaction.startClientX, y: event.clientY - interaction.startClientY };
    const viewport = this.terminalModalViewport();
    this.terminalModalBounds = interaction.operation === "move"
      ? moveTerminalModal(interaction.bounds, delta, viewport)
      : resizeTerminalModal(interaction.bounds, delta, viewport);
  };

  private readonly handleTerminalModalPointerUp = (event: TerminalModalPointerEvent): void => {
    if (this.terminalModalPointerInteraction?.pointerId !== event.pointerId) return;
    event.preventDefault();
    this.finishTerminalModalPointerInteraction();
  };

  private readonly handleTerminalModalPointerCancel = (event: TerminalModalPointerEvent): void => {
    if (this.terminalModalPointerInteraction?.pointerId !== event.pointerId) return;
    this.finishTerminalModalPointerInteraction();
  };

  private startTerminalModalPointerInteraction(operation: TerminalModalPointerInteraction["operation"], event: TerminalModalPointerEvent): void {
    if (this.terminalModalMaximized || event.button !== 0) return;
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const frame = target.closest(".terminal-modal-frame");
    if (!(frame instanceof HTMLElement)) return;

    event.preventDefault();
    event.stopPropagation();
    const bounds = fitTerminalModalBounds(this.terminalModalBoundsFromFrame(frame), this.terminalModalViewport());
    target.setPointerCapture(event.pointerId);
    this.terminalModalBounds = bounds;
    this.terminalModalPointerInteraction = {
      operation,
      pointerId: event.pointerId,
      target,
      startClientX: event.clientX,
      startClientY: event.clientY,
      bounds,
    };
  }

  private terminalModalBoundsFromFrame(frame: HTMLElement): TerminalModalBounds {
    const { left, top, width, height } = frame.getBoundingClientRect();
    return { left, top, width, height };
  }

  private terminalModalViewport(): TerminalModalViewport {
    if (typeof window === "undefined") return { width: 0, height: 0 };
    return { width: window.innerWidth, height: window.innerHeight };
  }

  private terminalModalFrameStyle(): string {
    const bounds = this.terminalModalMaximized ? undefined : this.terminalModalBounds;
    const geometry = bounds === undefined ? "" : `; left: ${String(bounds.left)}px; top: ${String(bounds.top)}px; width: ${String(bounds.width)}px; height: ${String(bounds.height)}px`;
    return `--terminal-modal-opacity: ${String(this.terminalModalOpacity)}%${geometry};`;
  }

  private finishTerminalModalPointerInteraction(): void {
    const interaction = this.terminalModalPointerInteraction;
    if (interaction === undefined) return;
    try {
      interaction.target.releasePointerCapture(interaction.pointerId);
    } catch {
      // Pointer capture may already be gone after a browser cancellation.
    }
    this.terminalModalPointerInteraction = undefined;
  }

  private readonly adjustTerminalFontSize = (delta: number): void => {
    const fontSize = clampTerminalModalFontSize(this.terminalModalFontSize + delta);
    if (fontSize === this.terminalModalFontSize) return;
    this.terminalModalFontSize = fontSize;
    this.persistTerminalModalPreferences();
  };

  private readonly adjustTerminalOpacity = (delta: number): void => {
    const opacity = clampTerminalModalOpacity(this.terminalModalOpacity + delta);
    if (opacity === this.terminalModalOpacity) return;
    this.terminalModalOpacity = opacity;
    this.persistTerminalModalPreferences();
  };

  private persistTerminalModalPreferences(): void {
    writeTerminalModalPreferences({
      fontSize: this.terminalModalFontSize,
      opacity: this.terminalModalOpacity,
    });
  }

  private toggleTerminalTab(): void {
    this.terminalTabHidden = !this.terminalTabHidden;
    this.persistWorkspaceTabVisibility();
  }

  private toggleInfoTab(): void {
    this.infoTabHidden = !this.infoTabHidden;
    this.persistWorkspaceTabVisibility();
  }

  private persistWorkspaceTabVisibility(): void {
    writeWorkspaceTabVisibility({ terminalHidden: this.terminalTabHidden, infoHidden: this.infoTabHidden });
  }

  private readonly handleStopActiveWork = (): void => {
    void this.sessions.stopActiveWork();
  };

  private readonly handleCompact = (): void => {
    void this.sessions.runCommand("/compact");
  };

  private readonly handleClearServerQueue = (): void => {
    void this.sessions.clearServerQueue();
  };

  private readonly handleEditFromHere = async (assistantEntryId: string, editorText: string): Promise<void> => {
    const originMachineId = selectedMachineId(this.state);
    const originSessionId = this.state.selectedSession?.id;
    try {
      const result = await this.sessions.editFromHere(assistantEntryId, editorText);
      if (!result.cancelled
        && originSessionId !== undefined
        && selectedMachineId(this.state) === originMachineId
        && this.state.selectedSession?.id === originSessionId) {
        await this.focusChatComposer();
      }
    } catch {
      // SessionController records the actionable error in app state; a message
      // action is fire-and-forget from Lit, so avoid an unhandled rejection.
    }
  };

  private readonly handleForkFromHere = async (userEntryId: string): Promise<void> => {
    await this.sessions.forkFromHere(userEntryId);
  };

  private readonly handleDismissWarning = (dismissId: string): void => {
    void this.sessions.dismissWarning(dismissId);
  };

  private readonly handleDismissNotification = (notificationId: string): void => {
    void this.notifications.dismissNotification(notificationId);
  };

  private readonly handleDismissAllNotifications = (): void => {
    void this.notifications.dismissAll();
  };

  private readonly handleToggleWarnings = (): void => {
    const next = toggleSessionWarnings(this.sessionWarningVisibility);
    if (next === this.sessionWarningVisibility) return;
    this.sessionWarningVisibility = next;
    this.requestUpdate();
  };

  private readonly handleSelectModel = (): void => {
    void this.openModelDialog();
  };

  private readonly handleSelectThinking = (): void => {
    void this.openThinkingDialog();
  };

  /**
   * Whether the active composer may show the policy control, plus the single
   * error string it should display. Requires both the negotiated capability and a
   * live status projection: a peer that supports the feature but has not published
   * a policy status yet has nothing to render a trigger from, and the control would
   * render nothing anyway.
   *
   * A policy transport error outranks a catalog error, because the control cannot
   * open its form at all without a policy response.
   */
  private activeModelPolicyInputs(state: AppState): { error: string } | undefined {
    if (state.status?.modelPolicy === undefined || !this.sessionModelPolicySupported()) return undefined;
    return { error: state.modelPolicyError ?? this.modelTierCatalogError };
  }

  private renderChatView(state: AppState, session: SessionInfo) {
    return html`
      <chat-view .sessionId=${session.id} .sessionInfo=${session} .messages=${state.messages} .messageStart=${state.messagePageStart} .messageEnd=${state.messagePageEnd} .messageTotal=${state.messagePageTotal} .hasMore=${state.messagePageStart > 0} .loadingMore=${state.isLoadingEarlierMessages} .isSendingPrompt=${state.sendingPrompts[session.id] === true} .isCompacting=${state.status?.isCompacting === true} .pendingMessageCount=${state.status?.pendingMessageCount ?? 0} .clientQueuedMessages=${state.clientQueuedSessionMessages[session.id] ?? []} .status=${state.status} .warningCount=${this.sessionWarningVisibility.warningCount} .warningsExpanded=${this.sessionWarningVisibility.warningCount > 0 && !this.sessionWarningVisibility.collapsed} .onToggleWarnings=${this.handleToggleWarnings} .activity=${state.activity} .notificationInbox=${selectedNotificationView(state.selectedNotificationInbox)} .canClearServerQueue=${this.canClearServerQueue()} .onClearServerQueue=${this.handleClearServerQueue} .canMessageActions=${this.canMessageActions() && session.archived !== true} .onEditFromHere=${this.handleEditFromHere} .onForkFromHere=${this.handleForkFromHere} .onDismissWarning=${this.handleDismissWarning} .onDismissNotification=${this.handleDismissNotification} .onDismissAllNotifications=${this.handleDismissAllNotifications} .warningsVisible=${!this.sessionWarningVisibility.collapsed} .onLoadMore=${() => this.withChatPrependTransition(() => this.sessions.loadEarlierMessages())}></chat-view>
    `;
  }

  private renderContextBar() {
    if (this.appShell.isDesktopActivityRailLayout) return null;
    return html`
      <app-context-bar
        .machines=${this.state.machines}
        .machine=${this.state.selectedMachine}
        .project=${this.state.selectedProject}
        .workspace=${this.state.selectedWorkspace}
        .session=${this.state.selectedSession}
        .refreshControl=${this.appShell.shouldShowAppRefreshInContextBar() ? this.renderAppRefresh() : undefined}
        .onOpenSection=${(section: NavigationSection) => { this.openNavigationSection(section); }}
        .onShowActions=${() => { this.setState({ actionPaletteOpen: true }); }}
        .activityRailOpen=${this.compactRailOpen}
        .onToggleActivityRail=${this.toggleCompactActivityRail}
      ></app-context-bar>
    `;
  }

  private renderMobileMainTabs() {
    return html`
      <app-mobile-main-tabs
        .tabs=${this.mobileMainTabs()}
        .selectedView=${this.state.mainView}
        .onSelect=${(view: AppState["mainView"]) => { this.selectMainView(view); }}
      ></app-mobile-main-tabs>
    `;
  }

  private mobileMainTabs(): AppMobileMainTab[] {
    const unreadCount = unreadSessionCount(this.state.sessions, this.unreadSessionIds, {
      statuses: this.state.sessionStatuses,
      activities: this.state.sessionActivities,
      sending: this.state.sendingPrompts,
    });
    return [
      {
        id: "navigation",
        label: "Sessions",
        icon: "navigation",
        className: "navigation-tab",
        ...(unreadCount === 0 ? {} : { badge: unreadCount, badgeLabel: `${String(unreadCount)} unread`, badgeTone: "unread" }),
      },
      { id: "chat", label: "Chat", icon: "chat" },
      ...this.visibleWorkspacePanels().map((panel): AppMobileMainTab => {
        const icon = panel.icon ?? this.mobilePanelIcon(panel);
        return {
          id: panel.id,
          label: panel.title,
          ...(icon === undefined ? {} : { icon }),
          badge: this.mobilePanelBadge(panel),
        };
      }),
    ];
  }

  private renderAppRefresh() {
    return html`<app-refresh-control .onReload=${() => { this.hardReloadApp(); }}></app-refresh-control>`;
  }

  private renderTerminalModal() {
    const state = this.state;
    const machineId = selectedMachineId(state);
    return html`
      <div
        class="terminal-modal-backdrop"
        role="dialog"
        aria-modal="true"
        aria-label="Terminal"
        @click=${(event: MouseEvent) => { if (event.target === event.currentTarget) this.handleCloseTerminalModal(); }}
        @keydown=${(event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); this.handleCloseTerminalModal(); } }}
      >
        <div
          class=${this.terminalModalMaximized
            ? "terminal-modal-frame terminal-modal-frame-maximized"
            : this.terminalModalBounds === undefined ? "terminal-modal-frame" : "terminal-modal-frame terminal-modal-frame-positioned"}
          style=${this.terminalModalFrameStyle()}
        >
          <header class="terminal-modal-header">
            <span
              class="terminal-modal-drag-handle"
              @pointerdown=${this.handleTerminalModalMovePointerDown}
              @pointermove=${this.handleTerminalModalPointerMove}
              @pointerup=${this.handleTerminalModalPointerUp}
              @pointercancel=${this.handleTerminalModalPointerCancel}
            >Terminal</span>
            <span class="terminal-modal-font-controls">
              <button type="button" class="terminal-modal-font-btn" @click=${() => { this.adjustTerminalFontSize(-1); }} aria-label="Decrease font size">−</button>
              <span class="terminal-modal-font-size">${this.terminalModalFontSize}px</span>
              <button type="button" class="terminal-modal-font-btn" @click=${() => { this.adjustTerminalFontSize(1); }} aria-label="Increase font size">+</button>
            </span>
            <span class="terminal-modal-font-controls">
              <button type="button" class="terminal-modal-font-btn" @click=${() => { this.adjustTerminalOpacity(-5); }} aria-label="Increase transparency">◐</button>
              <span class="terminal-modal-font-size">${this.terminalModalOpacity}%</span>
              <button type="button" class="terminal-modal-font-btn" @click=${() => { this.adjustTerminalOpacity(5); }} aria-label="Decrease transparency">●</button>
            </span>
            <span
              class="terminal-modal-drag-spacer"
              aria-hidden="true"
              @pointerdown=${this.handleTerminalModalMovePointerDown}
              @pointermove=${this.handleTerminalModalPointerMove}
              @pointerup=${this.handleTerminalModalPointerUp}
              @pointercancel=${this.handleTerminalModalPointerCancel}
            ></span>
            <button
              type="button"
              class="terminal-modal-maximize"
              @click=${this.toggleTerminalModalMaximized}
              aria-label=${this.terminalModalMaximized ? "Restore terminal window" : "Maximize terminal window"}
              title=${this.terminalModalMaximized ? "Restore terminal window" : "Maximize terminal window"}
            >
              <svg class="terminal-modal-maximize-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <rect class=${this.terminalModalMaximized ? "terminal-modal-maximize-icon-hidden" : ""} x="5" y="5" width="14" height="14" rx="1"></rect>
                <g class=${this.terminalModalMaximized ? "" : "terminal-modal-maximize-icon-hidden"}>
                  <rect x="8" y="4" width="12" height="12" rx="1"></rect>
                  <rect x="4" y="8" width="12" height="12" rx="1"></rect>
                </g>
              </svg>
            </button>
            <button type="button" class="terminal-modal-close" @click=${this.handleCloseTerminalModal} aria-label="Close terminal">×</button>
          </header>
          <div class="terminal-modal-body">
            <terminal-panel
              .workspace=${state.selectedWorkspace}
              .machineId=${machineId}
              .autoStart=${true}
              .fontSize=${this.terminalModalFontSize}
              .bgOpacity=${this.terminalModalOpacity}
            ></terminal-panel>
          </div>
          <div
            class="terminal-modal-resize-handle"
            title="Drag to resize terminal"
            aria-hidden="true"
            @pointerdown=${this.handleTerminalModalResizePointerDown}
            @pointermove=${this.handleTerminalModalPointerMove}
            @pointerup=${this.handleTerminalModalPointerUp}
            @pointercancel=${this.handleTerminalModalPointerCancel}
          ></div>
        </div>
      </div>
    `;
  }

  override render() {
    const state = this.state;
    const showCompact = state.selectedSession !== undefined
      && state.selectedSession.archived !== true;
    const gitUpdateManagerWorkspace = this.gitUpdateManagerPanelOpen ? state.selectedWorkspace : undefined;
    const activeActivity = this.activeActivityRailItem();
    const activePolicy = this.activeModelPolicyInputs(state);
    return html`
      <div class=${this.panelCollapse.shellClass(state.mainView)} style=${this.panelResize.shellStyle({ navigation: this.resizablePanelConstraints("navigation"), workspace: this.resizablePanelConstraints("workspace") })}>
        <activity-rail
          .onOpenTerminal=${this.handleOpenTerminalFromRail}
          .onOpenGitUpdateManager=${this.handleOpenGitUpdateManagerFromRail}
          .onOpenTheme=${this.handleOpenThemeFromRail}
          .terminalCount=${this.state.activeTerminalCount}
          .gitUpdateManagerCount=${gitUpdateManagerChangeCount(state.gitStatus?.files ?? [])}
          .systemPromptEnabled=${this.state.selectedSession !== undefined && this.canViewSystemPrompt()}
          .onOpenSystemPrompt=${() => {
            this.closeCompactActivityRail();
            if (this.state.selectedSession !== undefined && this.canViewSystemPrompt()) this.systemPromptDialogOpen = true;
          }}
          .historyEnabled=${this.canOpenSessionHistory()}
          .onOpenHistory=${() => { this.closeCompactActivityRail(); this.openSessionHistory(); }}
          .onOpenInfo=${() => { this.closeCompactActivityRail(); this.openWorkspaceTool("core:workspace.info"); }}
          .onOpenSettings=${() => { this.closeCompactActivityRail(); this.openSettings(); }}
          .railOrder=${this.railOrder}
          .onRailOrderChange=${this.handleRailOrderChange}
          .pluginItems=${this.activityRailItems()}
          .onOpenPluginActivity=${(id: QualifiedContributionId, source: HTMLElement) => {
            this.openActivityRailItem(id, () => { this.restoreActivityRailFocus(source); });
          }}
          .compactOpen=${this.compactRailOpen}
          .onCloseCompact=${this.closeCompactActivityRail}
        ></activity-rail>
        <aside id="navigation-panel">
          ${this.appShell.isMobileNavigationLayout ? null : this.renderNavigationPanel()}
        </aside>
        ${this.renderNavigationPanelEdgeControl()}
        <main class=${mainViewClass(state.mainView)}>
          ${this.renderContextBar()}
          ${this.renderMobileMainTabs()}
          ${state.error ? html`<div class="error">${state.error}</div>` : null}
          <div class="mobile-navigation-panel">${this.appShell.isMobileNavigationLayout ? this.renderNavigationPanel() : null}</div>
          ${state.selectedSession ? html`
            ${this.renderChatView(state, state.selectedSession)}
            <prompt-editor .sessionId=${state.selectedSession.id} .cwd=${state.selectedWorkspace?.path} .machineId=${selectedMachineId(state)} .projectId=${state.selectedWorkspace?.projectId} .workspaceId=${state.selectedWorkspace?.id} .workspaceScopedFileSuggestions=${this.supportsWorkspaceFileSuggestions()} .disabled=${state.selectedSession.archived === true} .canSteer=${state.status?.isStreaming === true} .isCompacting=${state.status?.isCompacting === true} .canStop=${state.status?.isStreaming === true || state.status?.isBashRunning === true || state.status?.isCompacting === true || (state.status?.pendingMessageCount ?? 0) > 0} .status=${activePolicy === undefined ? statusWithoutModelPolicy(state.status) : state.status} .availableThinkingLevels=${state.availableThinkingLevels} .modelPolicyStatus=${activePolicy === undefined ? undefined : state.status?.modelPolicy} .modelPolicyResponse=${activePolicy === undefined ? undefined : state.modelPolicy} .modelTierCatalog=${activePolicy === undefined ? undefined : this.selectedMachineModelTierCatalog()} .modelPolicyLoading=${activePolicy !== undefined && (state.isLoadingModelPolicy || this.modelTierCatalogLoading)} .modelPolicySaving=${activePolicy !== undefined && state.isSavingModelPolicy} .modelPolicyError=${activePolicy === undefined ? "" : activePolicy.error} .onOpenModelPolicy=${activePolicy === undefined ? undefined : this.handleOpenActiveModelPolicy} .onCloseModelPolicy=${activePolicy === undefined ? undefined : this.handleCloseActiveModelPolicy} .onSaveModelPolicy=${activePolicy === undefined ? undefined : this.handleSaveActiveModelPolicy} .sending=${state.sendingPrompts[state.selectedSession.id] === true} .onSend=${this.handleSendPrompt} .onStop=${this.handleStopActiveWork} .onSelectModel=${this.handleSelectModel} .onSelectThinking=${this.handleSelectThinking} .onCompact=${showCompact ? this.handleCompact : undefined}></prompt-editor>
            ${state.commandDialog !== undefined ? html`<command-picker .title=${state.commandDialog.title} .options=${state.commandDialog.options} .onPick=${(value: string) => this.sessions.respondToCommand(state.commandDialog?.requestId ?? "", value)} .onCancel=${() => { this.sessions.cancelCommand(); }}></command-picker>` : null}
          ` : this.shouldShowSessionStartScreen(state)
            ? this.renderSessionStartScreen(state)
            : html`<div class="empty">${this.sessionEmptyMessage()}</div>`}
          ${state.modelDialog !== undefined ? html`<command-picker title=${state.modelDialog.title} .searchable=${true} .options=${state.modelDialog.options} .selectedValue=${state.modelDialog.selectedValue} .onPick=${(value: string) => { void (state.modelDialog?.source === "starter" ? this.pickStarterModel(value) : this.pickModel(value)); }} .onCancel=${() => { this.setState({ modelDialog: undefined }); }}></command-picker>` : null}
          ${state.thinkingDialog !== undefined ? html`<command-picker title=${state.thinkingDialog.title} .options=${state.thinkingDialog.options} .selectedValue=${state.thinkingDialog.selectedValue} .onPick=${(value: string) => { void (state.thinkingDialog?.source === "starter" ? this.pickStarterThinking(value) : this.pickThinking(value)); }} .onCancel=${() => { this.setState({ thinkingDialog: undefined }); }}></command-picker>` : null}
        </main>
        ${this.renderWorkspacePanelEdgeControl()}
        ${this.renderWorkspacePanel()}
        ${state.actionPaletteOpen ? html`<action-palette .actions=${this.getActions()} .onRun=${(action: AppAction) => { if (closesActionPaletteAfterRun(action)) this.setState({ actionPaletteOpen: false }); this.runAction(action); }} .onCancel=${() => { this.setState({ actionPaletteOpen: false }); }}></action-palette>` : null}
        ${this.renderSessionTreeNavigator(state)}
        ${this.projectBrowserOpen ? html`<project-browser-dialog
          .projects=${state.projects}
          .selected=${state.selectedProject}
          .activities=${state.workspaceActivities}
          .workspacesByProjectId=${state.workspacesByProjectId}
          .onSelect=${(project: Project) => { this.selectProjectFromBrowser(project); }}
          .onClose=${() => { this.closeProjectBrowser({ restoreFocus: true }); }}
          .onAdd=${() => { this.addProjectFromBrowser(); }}
          .onCloseProject=${(project: Project) => this.projects.closeProject(project.id)}
        ></project-browser-dialog>` : null}
        ${this.sessionBrowserOpen && state.selectedProject !== undefined ? html`<session-browser-dialog
          .projectName=${state.selectedProject.name}
          .sessions=${state.projectSessions}
          .statuses=${state.sessionStatuses}
          .activities=${state.sessionActivities}
          .sending=${state.sendingPrompts}
          .unreadSessionIds=${this.unreadSessionIds}
          .selected=${state.selectedSession}
          .onSelect=${(session: SessionInfo) => { this.selectSessionFromBrowser(session); }}
          .onClose=${() => { this.closeSessionBrowser({ restoreFocus: true }); }}
        ></session-browser-dialog>` : null}
        ${this.historyWindow === undefined ? null : html`<session-history-window .machineId=${this.historyWindow.machineId} .session=${this.historyWindow.session} .onClose=${() => { this.historyWindow = undefined; }}></session-history-window>`}
        ${state.projectDialogOpen ? html`<project-dialog .machineId=${selectedMachineId(state)} .onSubmit=${(path: string, create: boolean) => this.projects.addProject(path, create)} .onCancel=${() => { this.setState({ projectDialogOpen: false }); }}></project-dialog>` : null}
        ${state.machineDialogOpen ? html`<machine-dialog .error=${state.error} .onSubmit=${(input: MachineDialogSubmit) => this.submitMachineDialog(input)} .onCancel=${() => { this.setState({ machineDialogOpen: false }); }}></machine-dialog>` : null}
        ${this.sessionCleanupDialog !== undefined ? html`<session-cleanup-dialog .canCleanup=${this.canCleanupSessions()} .unavailableMessage=${this.sessionCleanupUnavailableMessage()} .preview=${this.sessionCleanupDialog.preview} .previewRequest=${this.sessionCleanupDialog.previewRequest} .result=${this.sessionCleanupDialog.result} .loading=${this.sessionCleanupDialog.loading === true} .running=${this.sessionCleanupDialog.running === true} .error=${this.sessionCleanupDialog.error ?? ""} .onPreview=${(request: SessionCleanupRequest) => { void this.previewSessionCleanup(request); }} .onRun=${(request: SessionCleanupRequest) => { void this.runSessionCleanup(request); }} .onForceCleanup=${() => { void this.runForceSessionCleanup(); }} .forceCleanupResult=${this.sessionCleanupDialog.forceCleanupResult} .runningForce=${this.sessionCleanupDialog.runningForce === true} .onClose=${() => { this.closeSessionCleanupDialog(); }}></session-cleanup-dialog>` : null}
        ${this.modelsConfigDialogOpen ? html`<models-config-dialog .machine=${state.selectedMachine} .onClose=${() => { this.modelsConfigDialogOpen = false; }} .onConfigureAuth=${() => { void this.auth.openLogin(); }}></models-config-dialog>` : null}
        ${this.skillsConfigDialogOpen && state.selectedWorkspace !== undefined ? html`<skills-config-dialog .machine=${state.selectedMachine} .cwd=${state.selectedWorkspace.path} .onClose=${() => { this.skillsConfigDialogOpen = false; }}></skills-config-dialog>` : null}
        ${this.pluginsConfigDialogOpen && state.selectedWorkspace !== undefined ? html`<plugins-config-dialog .machine=${state.selectedMachine} .cwd=${state.selectedWorkspace.path} .session=${state.selectedSession} .onClose=${() => { this.pluginsConfigDialogOpen = false; }} .onReloaded=${() => this.sessions.refreshSelectedSession(state.selectedSession?.id)}></plugins-config-dialog>` : null}
        ${this.systemPromptDialogOpen && state.selectedSession !== undefined ? html`<system-prompt-dialog .machine=${state.selectedMachine} .session=${state.selectedSession} .onClose=${() => { this.systemPromptDialogOpen = false; }}></system-prompt-dialog>` : null}
        ${state.themeDialog !== undefined ? html`<command-picker title=${state.themeDialog.title} .options=${state.themeDialog.options} .selectedValue=${state.themeDialog.selectedValue} .onPick=${(value: string) => { this.pickTheme(value); }} .onCancel=${() => { this.setState({ themeDialog: undefined }); }}></command-picker>` : null}
        ${state.authDialog !== undefined ? html`<auth-dialog .state=${state.authDialog} .onChooseMethod=${(authType: "oauth" | "api_key") => { void this.auth.chooseLoginMethod(authType); }} .onSelectProvider=${(providerId: string, authType: "oauth" | "api_key") => { void this.auth.selectLoginProvider(providerId, authType); }} .onApiKeyInput=${(value: string) => { this.auth.updateApiKey(value); }} .onSaveApiKey=${() => { void this.auth.saveApiKey(); }} .onLogoutProvider=${(providerId: string) => { void this.auth.logoutProvider(providerId); }} .onOAuthInput=${(value: string) => { this.auth.updateOAuthInput(value); }} .onOAuthRespond=${(value?: string) => { void this.auth.respondOAuth(value); }} .onOAuthCancel=${() => { void this.auth.cancelOAuth(); }} .onCancel=${() => { this.auth.closeDialog(); }}></auth-dialog>` : null}
        ${activeActivity === undefined ? null : html`<plugin-activity-dialog .activity=${activeActivity.activity} .context=${activeActivity.context} .onClose=${() => { this.closeActivityRailItem(activeActivity.activity.id, activeActivity.generation); }} .onReportError=${this.reportActivityRailError}></plugin-activity-dialog>`}
        ${gitUpdateManagerWorkspace === undefined ? null : html`<git-update-manager-panel .workspace=${gitUpdateManagerWorkspace} .machineId=${selectedMachineId(state)} .onStatusChange=${(gitStatus: GitStatusResponse) => { this.applyGitUpdateManagerStatus(gitUpdateManagerWorkspace, selectedMachineId(state), gitStatus); }} .onClose=${this.handleCloseGitUpdateManagerPanel}></git-update-manager-panel>`}
        ${this.terminalModalOpen ? this.renderTerminalModal() : null}
        ${this.settingsSection !== undefined ? html`<settings-dialog .section=${this.settingsSection} .machine=${state.selectedMachine} .machineRuntime=${this.selectedMachineRuntime()} .actions=${this.getDefaultActions()} .onNavigate=${(section: SettingsSection) => { this.navigateSettings(section); }} .onClose=${() => { this.closeSettings(); }} .onConfigSaved=${(config: PiWebUiConfigValues) => { this.applyClientConfig(config); }} .onRefreshMachineRuntime=${async (machineId: string) => { await this.machines.refreshMachineRuntime(machineId); }}></settings-dialog>` : null}
      </div>
    `;
  }

  static override styles = appStyles;
}

function createPluginRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register({ id: "core", plugin: corePlugin });
  registry.register({ id: "themes", plugin: themePackPlugin });
  return registry;
}

function pluginMachineFromState(state: Pick<AppState, "selectedMachine">): PluginMachine {
  const machine = state.selectedMachine;
  if (machine !== undefined) return { id: machine.id, name: machine.name, kind: machine.kind };
  return { id: "local", name: "local", kind: "local" };
}

function unreadChatIdentity(machineId: string, session: Pick<SessionInfo, "id" | "cwd">): string {
  return JSON.stringify([machineId, session.id, session.cwd]);
}

function selectedChatIdentity(state: Pick<AppState, "selectedMachine" | "selectedSession">): string | undefined {
  const session = state.selectedSession;
  return session === undefined ? undefined : unreadChatIdentity(selectedMachineId(state), session);
}

function isMemoryActivityRailItem(activity: QualifiedActivityRailContribution): boolean {
  return activity.id === MEMORY_ACTIVITY_RAIL_ID
    || (activity.sourcePluginId === MEMORY_ACTIVITY_RAIL_PLUGIN_ID && activity.localId === MEMORY_ACTIVITY_RAIL_LOCAL_ID);
}

function memoryPollingScopeChanged(previous: AppState, next: AppState): boolean {
  return selectedMachineId(previous) !== selectedMachineId(next)
    || previous.selectedProject?.id !== next.selectedProject?.id
    || previous.selectedWorkspace?.id !== next.selectedWorkspace?.id
    || previous.selectedWorkspace?.path !== next.selectedWorkspace?.path;
}

function machineUnreadInputsChanged(previous: AppState, next: AppState): boolean {
  return previous.machines !== next.machines || previous.machineRuntimes !== next.machineRuntimes;
}

function machineActivitySubscriptionInputsChanged(previous: AppState, next: AppState): boolean {
  return previous.machines !== next.machines
    || previous.machineStatuses !== next.machineStatuses
    || (previous.selectedMachine?.id ?? "local") !== (next.selectedMachine?.id ?? "local");
}

function shouldSubscribeToMachineActivity(machine: Machine, health: MachineHealth | undefined): boolean {
  return shouldRefreshMachineActivity(machine, health);
}

function shouldRefreshMachineActivity(machine: Machine, health: MachineHealth | undefined): boolean {
  if (machine.kind === "local") return true;
  const status = health?.status ?? machine.status;
  return status === undefined || status === "unknown" || status === "online";
}

function patchChangesState(state: AppState, patch: Partial<AppState>): boolean {
  return Object.entries(patch).some(([key, value]) => Reflect.get(state, key) !== value);
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function isActive(state: Pick<AppState, "status" | "activity">): boolean {
  return isSessionActive(state.status, state.activity);
}

function isTerminalEvent(event: BrowserRealtimeEvent): event is TerminalUiEvent {
  return event.type === "terminal.created" || event.type === "terminal.exited" || event.type === "terminal.closed";
}

function emptyWorkspaceRouteSurface(): WorkspaceRouteSurface {
  return {};
}

function machineScopedKey(machineId: string, value: string): string {
  return JSON.stringify([machineId, value]);
}

function remoteRouteRestoreRetryDelay(attempt: number): number {
  const index = Math.min(attempt, REMOTE_ROUTE_RESTORE_RETRY_DELAYS_MS.length - 1);
  return REMOTE_ROUTE_RESTORE_RETRY_DELAYS_MS[index] ?? 30_000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The Exact selection a starter draft links to, or undefined when Pi has not
 * resolved a complete model/thinking pair yet. An incomplete pair must not be
 * padded with placeholders: the policy contract forbids substitution, and the
 * draft module would reject it as unsavable anyway.
 */
function starterExactSelection(defaults: SessionDefaultsResponse): ExactModelSelection | undefined {
  const provider = defaults.model?.provider;
  const id = defaults.model?.id;
  if (provider === undefined || provider === "" || id === undefined || id === "") return undefined;
  if (defaults.thinkingLevel === "") return undefined;
  return { model: { provider, id }, thinkingLevel: defaults.thinkingLevel };
}

function sameExactSelection(left: ExactModelSelection, right: ExactModelSelection): boolean {
  return left.model.provider === right.model.provider
    && left.model.id === right.model.id
    && left.thinkingLevel === right.thinkingLevel;
}

/**
 * The status to hand the active composer when policy support is withheld.
 *
 * PromptEditor falls back to `status.modelPolicy` when no separate policy status
 * prop is supplied, so leaving the projection on the status object would let the
 * control render with no callbacks — a panel whose Retry is wired to nothing.
 * That window is reachable between a session status arriving and the selected
 * machine's runtime health populating, so drop the projection at the boundary
 * that decided support is unavailable rather than relying on the component.
 */
function statusWithoutModelPolicy(status: SessionStatus | undefined): SessionStatus | undefined {
  if (status?.modelPolicy === undefined) return status;
  const rest: SessionStatus = { ...status };
  delete rest.modelPolicy;
  return rest;
}

function omitWorkspaceDeletionRun(runs: Record<string, TerminalCommandRun>, workspaceId: string): Record<string, TerminalCommandRun> {
  return Object.fromEntries(Object.entries(runs).filter(([candidate]) => candidate !== workspaceId));
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => { resolve(); }));
}

function thinkingDescription(level: string): string | undefined {
  switch (level) {
    case "off": return "No reasoning";
    case "minimal": return "Very brief reasoning (~1k tokens)";
    case "low": return "Light reasoning (~2k tokens)";
    case "medium": return "Moderate reasoning (~8k tokens)";
    case "high": return "Deep reasoning (~16k tokens)";
    case "xhigh": return "Maximum reasoning (~32k tokens)";
    default: return undefined; // unknown level from a newer pi: no description
  }
}
