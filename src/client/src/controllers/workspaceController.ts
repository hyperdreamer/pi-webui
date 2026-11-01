import { api as defaultApi, type Project, type SessionInfo, type Workspace } from "../api";
import { HttpResponseBodyError, HttpRequestError } from "../api/http";
import {
  resetWorkspaceScopedState,
  type AppState,
  type SessionListFailure,
  type SessionListLoad,
  type SessionListLoadScope,
} from "../appState";
import { mergeCachedNewSessions } from "../cachedNewSessions";
import { LOCAL_MACHINE_ID, machineProjectKey } from "../machineKeys";
import {
  DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
  effectiveMachineRequestTimeoutMs,
} from "../../../shared/machineRequestTimeout";
import { runBackgroundRead, type ReadIntent } from "./backgroundRead";
import { CancellableLoadScope, LoadCancelledError, isLoadCancellation } from "./cancellableLoadScope";
import { selectedMachineId, type GetState, type RouteTarget, type SetState, type UpdateUrl } from "./types";
import type {
  ProjectCatalogSnapshot,
  ProjectCatalogTopologyRequest,
  ProjectCatalogTopologyScope,
} from "./projectCatalogController";
import type { SessionController } from "./sessionController";
import { InMemoryWorkspaceSelectionMemory, selectPreferredWorkspace, type WorkspaceSelectionMemory } from "./workspaceSelection";

interface CatalogWorkspaceSelectionScope {
  machineId: string;
  project: Project;
  topologyRequest: ProjectCatalogTopologyRequest;
}

interface PendingProjectSelection {
  request: number;
  machineId: string;
  project: Project;
  target: RouteTarget | undefined;
}

interface CatalogFallbackSelection {
  foregroundError: string;
  eligibleProjectSessions: SessionInfo[];
}

interface CatalogFallbackFailure {
  error: unknown;
}

interface SessionListRefreshScope {
  key: string;
  request: number;
  machineId: string;
  project: Project;
  workspace: Workspace;
  /**
   * Invalidations waiting for a read, with the strongest requested intent per
   * cwd. A foreground arrival upgrades a pending background read of that cwd so
   * the full machine budget applies instead of the background bow-out window.
   */
  dirty: Map<string, ReadIntent>;
  calls: SessionListRefreshCall[];
  scheduled: boolean;
  running: boolean;
}

interface SessionListRefreshCall {
  cwds: ReadonlySet<string>;
  intent: ReadIntent;
  resolve: () => void;
}

/** One remote selected-list read, with everything its guards and records need. */
interface SessionListReadOperation {
  readonly token: number;
  readonly owner: SessionListLoad["owner"];
  readonly scope: SessionListLoadScope;
  readonly machineId: string;
  readonly machineName: string;
  readonly budgetMs: number;
  readonly startedAt: number;
  readonly supersession: AbortSignal | undefined;
  readonly isTargetCurrent: () => boolean;
  phase: SessionListLoad["phase"];
}

/** The debounce that merges a burst of invalidations into one read pass. */
const SESSION_LIST_REFRESH_DELAY_MS = 50;
/** Gateway-timeout status marking a bounded wait that expired without headers. */
const SESSION_LIST_TIMEOUT_STATUS = 504;

interface WorkspaceSelectionTarget {
  sessionId?: string | undefined;
  updateUrl?: boolean | undefined;
  preserveError?: boolean | undefined;
  catalogScope?: CatalogWorkspaceSelectionScope | undefined;
  catalogFallback?: CatalogFallbackSelection | undefined;
  /**
   * Internal: this selection continues the foreground load that is already
   * open (a project selection choosing its workspace) rather than starting a
   * new one. It must inherit that load's cancellation instead of restarting it,
   * or completing a project selection would abort the project read it belongs
   * to when background catalog topology arrives first.
   */
  continuesSelectionLoad?: boolean | undefined;
}

interface ReconcileProjectCatalogOptions {
  fallbackSelection?: "background" | "foreground" | undefined;
}

export interface WorkspaceControllerDependencies {
  api?: Pick<typeof defaultApi, "sessions" | "workspaces">;
  onBackgroundError?: (operation: string, error: unknown) => void;
  onForgetProject?: (machineId: string, projectId: string) => void;
  /** Injectable clock for provenance timestamps; defaults to `Date.now`. */
  now?: () => number;
}

export class WorkspaceController {
  private readonly api: Pick<typeof defaultApi, "sessions" | "workspaces">;
  private readonly onBackgroundError: WorkspaceControllerDependencies["onBackgroundError"];
  private readonly onForgetProject: WorkspaceControllerDependencies["onForgetProject"];
  private readonly now: () => number;
  private readonly unhydratedWorkspaceKeys = new Set<string>();
  private readonly latestTopologyRequestOrderByScope = new Map<string, number>();
  /**
   * Cancellation for the foreground selection's reads. Switching projects or
   * workspaces abandons the previous selection, and identity guards alone cannot
   * stop its response from arriving and being parsed first. Background catalog
   * reconciliation deliberately does not use this scope: it must not cancel the
   * foreground selection the user is waiting on.
   */
  private readonly selectionLoad = new CancellableLoadScope();
  private nextTopologyRequestOrder = 0;
  private projectSessionsRequest = 0;
  private projectSelectionRequest = 0;
  private pendingProjectSelection: PendingProjectSelection | undefined;
  private readonly sessionListRevisions = new Map<string, number>();
  private pendingSessionListRefresh: SessionListRefreshScope | undefined;
  private nextSessionListOperationToken = 0;
  /** The only operation allowed to publish provenance or failures right now. */
  private activeSessionListOperation = 0;
  private activeSessionListRetry: { key: string; promise: Promise<void> } | undefined;
  private disposed = false;

  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    private readonly updateUrl: UpdateUrl,
    private readonly sessions: Pick<SessionController, "clearActiveSession" | "preferredSession" | "selectSession" | "applyRefreshedSessionLists">,
    private readonly workspaceSelection: WorkspaceSelectionMemory = new InMemoryWorkspaceSelectionMemory(),
    deps: WorkspaceControllerDependencies = {},
  ) {
    this.api = deps.api ?? defaultApi;
    this.onBackgroundError = deps.onBackgroundError;
    this.onForgetProject = deps.onForgetProject;
    this.now = deps.now ?? (() => Date.now());
  }

  dispose(): void {
    this.disposed = true;
    this.projectSessionsRequest += 1;
    this.selectionLoad.abort();
    this.settlePendingSessionListRefresh();
    this.activeSessionListOperation = 0;
    this.activeSessionListRetry = undefined;
  }

  /**
   * Invalidation is scoped to the visible catalog, never a periodic project-wide scan.
   *
   * `intent` decides how each affected cwd is read: background invalidations bow
   * out at the background window, while a foreground (mutation-commit) refresh
   * keeps the machine budget and settles only after its queued replay applied its
   * rows. A foreground call always settles later than any background read of the
   * same cwd, so it cannot be satisfied by the short-window path.
   */
  refreshSessionLists(
    cwds?: readonly string[],
    machineId = selectedMachineId(this.getState()),
    intent: ReadIntent = "foreground",
  ): Promise<void> {
    const state = this.getState();
    const project = state.selectedProject;
    const workspace = state.selectedWorkspace;
    if (this.disposed || selectedMachineId(state) !== machineId || project === undefined || workspace === undefined) return Promise.resolve();
    const relevant = this.relevantSessionCwds();
    const affected = (cwds ?? [...relevant]).filter((cwd) => relevant.has(cwd));
    if (affected.length === 0) return Promise.resolve();
    const request = this.projectSessionsRequest;
    const key = JSON.stringify([machineId, project.id, project.path, workspace.id, workspace.path, request]);
    let scope = this.pendingSessionListRefresh;
    if (scope?.key !== key) {
      if (scope !== undefined) this.settleSessionListRefreshCalls(scope);
      scope = {
        key,
        request,
        machineId,
        project,
        workspace,
        dirty: new Map(),
        calls: [],
        scheduled: false,
        running: false,
      };
      this.pendingSessionListRefresh = scope;
    }
    const promise = new Promise<void>((resolve) => {
      scope.calls.push({ cwds: new Set(affected), intent, resolve });
    });
    for (const cwd of affected) mergeSessionListIntent(scope.dirty, cwd, intent);
    this.scheduleSessionListRefreshPass(scope);
    return promise;
  }

  /**
   * Retry the selected workspace's session list without any selection or stream
   * side effects. A retry aimed at a workspace the catalog no longer has, or one
   * that is no longer selected, is a no-op instead of a read.
   */
  async retrySessionList(): Promise<void> {
    const state = this.getState();
    const project = state.selectedProject;
    const workspace = state.selectedWorkspace;
    if (this.disposed || project === undefined || workspace === undefined) return;
    const machineId = selectedMachineId(state);
    const request = this.projectSessionsRequest;
    if (!this.isSessionListRetryTargetCurrent(workspace, machineId, request)) return;
    const retryKey = JSON.stringify([machineId, project.id, project.path, workspace.id, workspace.path]);
    const active = this.activeSessionListRetry;
    if (active?.key === retryKey) return active.promise;
    const promise = this.runSessionListRetry(workspace, machineId, request, retryKey);
    this.activeSessionListRetry = { key: retryKey, promise };
    return promise;
  }

  private async runSessionListRetry(
    workspace: Workspace,
    machineId: string,
    request: number,
    retryKey: string,
  ): Promise<void> {
    const isTargetCurrent = (): boolean => this.isSessionListRetryTargetCurrent(workspace, machineId, request);
    const operation = this.beginSessionListRead({
      owner: "retry",
      workspace,
      machineId,
      supersession: this.selectionLoad.signal,
      isTargetCurrent,
    });
    let applied = false;
    try {
      // The catalog may have dropped the workspace between admission and the read.
      if (!isTargetCurrent()) throw new LoadCancelledError("Session list retry target changed");
      const rows = await this.readSessionList(operation, workspace);
      if (!isTargetCurrent()) return;
      await this.sessions.applyRefreshedSessionLists(
        [{ cwd: workspace.path, sessions: rows }],
        machineId,
        { preserveSelection: true },
      );
      applied = true;
    } catch (error) {
      if (isLoadCancellation(error)) return;
      if (!isTargetCurrent()) return;
      this.publishSessionListFailure(operation, error);
    } finally {
      this.finishSessionListOperation(operation, { clearFailure: applied });
      if (this.activeSessionListRetry?.key === retryKey) this.activeSessionListRetry = undefined;
    }
  }

  private scheduleSessionListRefreshPass(scope: SessionListRefreshScope): void {
    if (this.disposed || scope.scheduled) return;
    scope.scheduled = true;
    // WebSocket messages arrive in separate tasks; a short window also merges
    // those bursts rather than only callers within a single microtask turn.
    setTimeout(() => {
      scope.scheduled = false;
      void this.runSessionListRefreshPass(scope);
    }, SESSION_LIST_REFRESH_DELAY_MS);
  }

  private async runSessionListRefreshPass(scope: SessionListRefreshScope): Promise<void> {
    if (this.disposed || this.pendingSessionListRefresh !== scope) {
      this.settleSessionListRefreshCalls(scope);
      return;
    }
    if (scope.running) return;
    if (!this.isSessionListRefreshCurrent(scope)) {
      this.settleSessionListRefreshCalls(scope);
      return;
    }
    if (this.getState().isLoadingSessions) {
      // A foreground selection owns its initial read. Keep the invalidation dirty
      // for the selection's completion flush; a background caller's own pass has
      // returned without a read, so it settles now and promises nothing further.
      this.settleSessionListRefreshCalls(scope, (call) => call.intent === "background");
      return;
    }

    scope.running = true;
    const claimed = new Map<string, ReadIntent>();
    const relevant = this.relevantSessionCwds();
    for (const [cwd, intent] of scope.dirty) {
      if (relevant.has(cwd)) claimed.set(cwd, intent);
    }
    for (const cwd of claimed.keys()) scope.dirty.delete(cwd);
    try {
      if (claimed.size > 0) {
        const revisions = new Map<string, number>();
        for (const cwd of claimed.keys()) {
          const revision = (this.sessionListRevisions.get(cwd) ?? 0) + 1;
          this.sessionListRevisions.set(cwd, revision);
          revisions.set(cwd, revision);
        }
        const results = await Promise.allSettled([...claimed.entries()].map(async ([cwd, intent]) => ({
          cwd,
          sessions: await this.readQueuedSessionList(cwd, scope.machineId, intent),
        })));
        if (!this.isSessionListRefreshCurrent(scope)) {
          this.settleSessionListRefreshCalls(scope);
          return;
        }
        const currentRelevant = this.relevantSessionCwds();
        const lists: { cwd: string; sessions: SessionInfo[] }[] = [];
        for (const result of results) {
          if (result.status === "rejected") {
            if (!isLoadCancellation(result.reason)) this.reportBackgroundError("refresh invalidated session list", result.reason);
          } else if (currentRelevant.has(result.value.cwd) && revisions.get(result.value.cwd) === this.sessionListRevisions.get(result.value.cwd)) {
            lists.push({ cwd: result.value.cwd, sessions: result.value.sessions });
          }
        }
        if (lists.length > 0) await this.sessions.applyRefreshedSessionLists(lists, scope.machineId);
      }
    } catch (error) {
      if (!isLoadCancellation(error) && this.isSessionListRefreshCurrent(scope)) this.reportBackgroundError("refresh invalidated session lists", error);
    } finally {
      scope.running = false;
      this.settleSessionListRefreshCallsAfterPass(scope);
      if (!this.isSessionListRefreshCurrent(scope)) this.settleSessionListRefreshCalls(scope);
      else if (scope.dirty.size > 0) this.scheduleSessionListRefreshPass(scope);
      else if (this.pendingSessionListRefresh === scope && scope.calls.length === 0) this.pendingSessionListRefresh = undefined;
    }
  }

  /**
   * Settle the callers a completed pass can honestly satisfy. Background callers
   * settle with their pass; foreground callers stay pending until a pass claims
   * and applies (or definitively drops) every cwd they asked about.
   */
  private settleSessionListRefreshCallsAfterPass(scope: SessionListRefreshScope): void {
    if (!this.isSessionListRefreshCurrent(scope)) {
      this.settleSessionListRefreshCalls(scope);
      return;
    }
    this.settleSessionListRefreshCalls(scope, (call) => (
      call.intent === "background" || ![...call.cwds].some((cwd) => scope.dirty.has(cwd))
    ));
  }

  private settleSessionListRefreshCalls(
    scope: SessionListRefreshScope,
    shouldSettle: (call: SessionListRefreshCall) => boolean = () => true,
  ): void {
    const retained: SessionListRefreshCall[] = [];
    for (const call of scope.calls) {
      if (shouldSettle(call)) call.resolve();
      else retained.push(call);
    }
    scope.calls = retained;
  }

  private settlePendingSessionListRefresh(): void {
    const pending = this.pendingSessionListRefresh;
    this.pendingSessionListRefresh = undefined;
    if (pending !== undefined) this.settleSessionListRefreshCalls(pending);
  }

  private relevantSessionCwds(): Set<string> {
    const state = this.getState();
    return new Set([
      ...state.workspaces.filter((workspace) => workspace.projectId === state.selectedProject?.id).map((workspace) => workspace.path),
      ...(state.selectedWorkspace === undefined ? [] : [state.selectedWorkspace.path]),
    ]);
  }

  private isSessionListRefreshCurrent(scope: SessionListRefreshScope): boolean {
    const state = this.getState();
    return !this.disposed && scope.request === this.projectSessionsRequest
      && selectedMachineId(state) === scope.machineId
      && state.selectedProject?.id === scope.project.id && state.selectedProject.path === scope.project.path
      && state.selectedWorkspace?.id === scope.workspace.id && state.selectedWorkspace.path === scope.workspace.path;
  }

  private async readQueuedSessionList(cwd: string, machineId: string, intent: ReadIntent): Promise<SessionInfo[]> {
    if (machineId === LOCAL_MACHINE_ID) return this.api.sessions(cwd, machineId);
    if (intent === "background") {
      return runBackgroundRead(machineId, (signal) => this.api.sessions(cwd, machineId, signal));
    }
    // Foreground invalidation reads keep the machine budget. Once the upstream
    // response starts, body transfer is unbounded, so the deadline is disarmed.
    const budgetMs = this.machineBudgetMs(machineId);
    const deadline = new AbortController();
    const timer = setTimeout(() => { deadline.abort(sessionListTimeoutError(budgetMs)); }, budgetMs);
    try {
      return await this.api.sessions(cwd, machineId, deadline.signal, (response) => {
        if (response.ok) clearTimeout(timer);
      });
    } finally {
      clearTimeout(timer);
    }
  }

  clearSelection(options?: { updateUrl?: boolean | undefined; preserveError?: boolean | undefined }) {
    this.invalidatePendingProjectSelection();
    this.selectionLoad.abort();
    this.settlePendingSessionListRefresh();
    const error = this.getState().error;
    this.projectSessionsRequest += 1;
    this.sessions.clearActiveSession();
    this.setState({
      selectedProject: undefined,
      selectedWorkspace: undefined,
      workspaces: [],
      isLoadingWorkspaces: false,
      ...resetWorkspaceScopedState(),
      ...(options?.preserveError === true ? { error } : {}),
    });
    if (options?.updateUrl !== false) this.updateUrl();
  }

  forgetProject(projectId: string): void {
    this.onForgetProject?.(selectedMachineId(this.getState()), projectId);
    this.workspaceSelection.forgetProject(machineProjectKey(selectedMachineId(this.getState()), projectId));
    const workspacesByProjectId = Object.fromEntries(Object.entries(this.getState().workspacesByProjectId).filter(([candidate]) => candidate !== projectId));
    this.setState({ workspacesByProjectId });
  }

  /** Owns request ordering for all background topology sources in a project scope. */
  captureProjectCatalogTopologyRequest(scope: ProjectCatalogTopologyScope): ProjectCatalogTopologyRequest {
    const order = ++this.nextTopologyRequestOrder;
    this.latestTopologyRequestOrderByScope.set(projectCatalogTopologyScopeKey(scope), order);
    return { ...scope, order };
  }

  async selectProject(project: Project, target?: RouteTarget) {
    this.settlePendingSessionListRefresh();
    this.projectSessionsRequest += 1;
    const pending = this.beginProjectSelection(project, target);
    const signal = this.selectionLoad.restart();
    this.sessions.clearActiveSession();
    this.setState({ selectedProject: project, selectedWorkspace: undefined, workspaces: [], isLoadingWorkspaces: true, ...resetWorkspaceScopedState() });
    try {
      const workspaces = await this.api.workspaces(project.id, pending.machineId, signal);
      if (!this.isPendingProjectSelectionCurrent(pending)) return;
      this.applyProjectWorkspaceProjection(project, workspaces, pending.machineId);
      await this.completePendingProjectSelection(pending, workspaces);
    } catch (error) {
      // A read abandoned by a newer selection is supersession, not failure.
      if (isLoadCancellation(error)) return;
      if (!this.isPendingProjectSelectionCurrent(pending)) return;
      this.pendingProjectSelection = undefined;
      this.setState({ error: String(error), isLoadingWorkspaces: false });
    }
  }

  async selectWorkspace(workspace: Workspace, target?: WorkspaceSelectionTarget) {
    if (!this.isCatalogSelectionScopeCurrent(target?.catalogScope)) return;
    // Refresh work queued for the previous selection can no longer be flushed by
    // it; settle those callers instead of leaving them waiting for rows that the
    // new selection supersedes.
    this.settlePendingSessionListRefresh();

    const state = this.getState();
    const preserveMemory = isSameWorkspaceScope(state, workspace);
    const projectSessionsRequest = ++this.projectSessionsRequest;
    // A catalog-driven fallback runs while the user's own selection may still be
    // loading, so it neither restarts nor borrows the foreground scope; its own
    // topology-token guards decide whether its result may be applied. A
    // continuation inherits the open load. Any other selection is a new
    // foreground action and supersedes whatever was loading before it.
    const signal = target?.catalogScope !== undefined
      ? undefined
      : target?.continuesSelectionLoad === true
        ? this.selectionLoad.signal
        : this.selectionLoad.restart();
    const machineId = selectedMachineId(state);
    const error = state.error;
    this.workspaceSelection.rememberWorkspace({ ...workspace, projectId: machineProjectKey(machineId, workspace.projectId) });
    this.sessions.clearActiveSession();
    const reset = resetWorkspaceScopedState();
    this.setState({
      selectedWorkspace: workspace,
      isLoadingWorkspaces: false,
      ...reset,
      ...(preserveMemory ? { memory: state.memory } : {}),
      ...(target?.preserveError === true ? { error } : {}),
      isLoadingSessions: true,
    });
    const catalogFallback = target?.catalogFallback;
    const isTargetCurrent = (): boolean => this.isWorkspaceSelectionTargetCurrent(
      workspace,
      machineId,
      projectSessionsRequest,
      target,
    );
    const operation = this.beginSessionListRead({
      // A catalog fallback is background recovery, not the user's own selection.
      owner: catalogFallback === undefined ? "selection" : "catalog-fallback",
      workspace,
      machineId,
      supersession: signal,
      isTargetCurrent,
    });
    let listed = false;
    try {
      const listedSessions = await this.readSessionList(operation, workspace);
      listed = true;
      if (!isTargetCurrent()) {
        if (catalogFallback !== undefined && this.isCatalogFallbackRecoveryCurrent(
          workspace,
          machineId,
          projectSessionsRequest,
          target?.catalogScope,
        )) {
          this.restoreCatalogFallbackSessionState(workspace, machineId, catalogFallback);
          return;
        }
        this.clearStaleCatalogSelectionLoadingIfOwned(
          workspace,
          machineId,
          projectSessionsRequest,
          target?.catalogScope,
        );
        return;
      }
      const sessions = mergeCachedNewSessions(workspace.path, listedSessions, machineId);
      this.setState({ sessions, projectSessions: sessions, isLoadingSessions: false });
      void this.refreshProjectSessions(projectSessionsRequest, workspace, sessions, machineId, target?.catalogScope, signal);
      const session = this.sessions.preferredSession(workspace.path, sessions, target?.sessionId);
      if (session) await this.sessions.selectSession(session, { updateUrl: target?.updateUrl });
      else if (target?.updateUrl !== false) this.updateUrl();
    } catch (error) {
      if (isLoadCancellation(error)) {
        // Supersession by a newer selection: the newer selection owns the state,
        // including its own loading indicator, so nothing is published here. A
        // cancelled background fallback owns the loading state it opened, so it
        // releases it and restores the rows the catalog already had.
        if (catalogFallback !== undefined && this.isCatalogFallbackRecoveryCurrent(
          workspace,
          machineId,
          projectSessionsRequest,
          target?.catalogScope,
        )) {
          this.restoreCatalogFallbackSessionState(workspace, machineId, catalogFallback);
        }
        return;
      }
      if (!isTargetCurrent()) {
        if (catalogFallback !== undefined && this.isCatalogFallbackRecoveryCurrent(
          workspace,
          machineId,
          projectSessionsRequest,
          target?.catalogScope,
        )) {
          this.applyCatalogFallbackSessionFailure(workspace, machineId, catalogFallback, error);
          return;
        }
        this.clearStaleCatalogSelectionLoadingIfOwned(
          workspace,
          machineId,
          projectSessionsRequest,
          target?.catalogScope,
        );
        return;
      }
      // A bounded remote wait that expired, or a body that stopped mid-transfer,
      // is a typed list failure with its own notice — never a generic state error.
      if (this.publishSessionListFailure(operation, error)) {
        this.setState({ isLoadingSessions: false });
        return;
      }
      if (catalogFallback === undefined) {
        this.setState({ error: String(error), isLoadingSessions: false });
        return;
      }
      this.applyCatalogFallbackSessionFailure(workspace, machineId, catalogFallback, error);
    } finally {
      this.finishSessionListOperation(operation, { clearFailure: listed });
      const pending = this.pendingSessionListRefresh;
      if (pending !== undefined && pending.dirty.size > 0 && this.isSessionListRefreshCurrent(pending)) this.scheduleSessionListRefreshPass(pending);
    }
  }

  private beginSessionListRead(input: {
    owner: SessionListLoad["owner"];
    workspace: Workspace;
    machineId: string;
    supersession: AbortSignal | undefined;
    isTargetCurrent: () => boolean;
  }): SessionListReadOperation {
    const operation: SessionListReadOperation = {
      token: ++this.nextSessionListOperationToken,
      owner: input.owner,
      scope: {
        machineId: input.machineId,
        projectId: input.workspace.projectId,
        workspaceId: input.workspace.id,
        workspacePath: input.workspace.path,
      },
      machineId: input.machineId,
      machineName: this.machineName(input.machineId),
      budgetMs: this.machineBudgetMs(input.machineId),
      startedAt: this.now(),
      supersession: input.supersession,
      isTargetCurrent: input.isTargetCurrent,
      phase: "waiting",
    };
    this.activeSessionListOperation = operation.token;
    if (this.publishesSessionListProvenance(operation)) {
      this.setState({
        sessionListLoad: {
          owner: operation.owner,
          scope: operation.scope,
          startedAt: operation.startedAt,
          budgetMs: operation.budgetMs,
          phase: "waiting",
        },
      });
    }
    return operation;
  }

  /** The local machine keeps the plain read path: no budget, records, or notice. */
  private publishesSessionListProvenance(operation: SessionListReadOperation): boolean {
    return operation.machineId !== LOCAL_MACHINE_ID && operation.owner !== "catalog-fallback";
  }

  private async readSessionList(operation: SessionListReadOperation, workspace: Workspace): Promise<SessionInfo[]> {
    if (operation.machineId === LOCAL_MACHINE_ID) {
      return this.api.sessions(workspace.path, operation.machineId, operation.supersession);
    }
    if (operation.owner === "catalog-fallback") {
      return runBackgroundRead(
        operation.machineId,
        (signal) => this.api.sessions(workspace.path, operation.machineId, signal),
        operation.supersession,
      );
    }
    // Foreground selection and retry keep the machine budget, and only the wait
    // for upstream headers is budgeted: the deadline is disarmed when a successful
    // response starts so body transfer stays unbounded.
    const deadline = new AbortController();
    const timer = setTimeout(() => { deadline.abort(sessionListTimeoutError(operation.budgetMs)); }, operation.budgetMs);
    const stopForwarding = forwardSupersession(operation.supersession, deadline);
    try {
      return await this.api.sessions(workspace.path, operation.machineId, deadline.signal, (response) => {
        if (!response.ok) return;
        clearTimeout(timer);
        this.publishSessionListPhase(operation, deadline.signal);
      });
    } finally {
      clearTimeout(timer);
      stopForwarding();
    }
  }

  private publishSessionListPhase(operation: SessionListReadOperation, signal: AbortSignal): void {
    if (operation.phase === "waiting") operation.phase = "receiving";
    if (!this.publishesSessionListProvenance(operation)) return;
    if (!this.isSessionListOperationCurrent(operation, signal)) return;
    this.setState({
      sessionListLoad: {
        owner: operation.owner,
        scope: operation.scope,
        startedAt: operation.startedAt,
        budgetMs: operation.budgetMs,
        phase: "receiving",
      },
    });
  }

  private isSessionListOperationCurrent(operation: SessionListReadOperation, signal?: AbortSignal): boolean {
    return !this.disposed
      && operation.token === this.activeSessionListOperation
      && operation.supersession?.aborted !== true
      && signal?.aborted !== true
      && operation.isTargetCurrent();
  }

  private finishSessionListOperation(operation: SessionListReadOperation, options: { clearFailure?: boolean } = {}): void {
    if (operation.token !== this.activeSessionListOperation) return;
    if (!this.publishesSessionListProvenance(operation)) return;
    this.setState({
      sessionListLoad: undefined,
      ...(options.clearFailure === true ? { sessionListFailure: undefined } : {}),
    });
  }

  /** Publish a typed list failure instead of a generic error, when it is one. */
  private publishSessionListFailure(operation: SessionListReadOperation, error: unknown): boolean {
    const kind = classifySessionListFailure(error);
    if (kind === undefined || !this.publishesSessionListProvenance(operation)) return false;
    if (!this.isSessionListOperationCurrent(operation)) return false;
    this.setState({
      sessionListLoad: undefined,
      sessionListFailure: {
        scope: {
          machineId: operation.machineId,
          machineName: operation.machineName,
          projectId: operation.scope.projectId,
          workspaceId: operation.scope.workspaceId,
        },
        kind,
        elapsedMs: Math.max(0, this.now() - operation.startedAt),
        budgetMs: operation.budgetMs,
      },
    });
    return true;
  }

  private isSessionListRetryTargetCurrent(workspace: Workspace, machineId: string, request: number): boolean {
    if (this.disposed || !this.isCurrentWorkspaceSessionRequest(request, workspace, machineId)) return false;
    const state = this.getState();
    const workspaces = state.workspacesByProjectId[workspace.projectId] ?? state.workspaces;
    return workspaceStillExists(workspace, workspaces);
  }

  private readProjectSiblingSessions(path: string, machineId: string, signal: AbortSignal | undefined): Promise<SessionInfo[]> {
    // Cross-workspace grouping is background work: a remote reader bows out at
    // the background window, while the local machine keeps its plain read.
    if (machineId === LOCAL_MACHINE_ID) return this.api.sessions(path, machineId, signal);
    return runBackgroundRead(machineId, (backgroundSignal) => this.api.sessions(path, machineId, backgroundSignal), signal);
  }

  private readDiscoveredWorkspaceSessions(path: string, machineId: string): Promise<SessionInfo[]> {
    // Discovery hydration is background work too, and must be able to bail out.
    if (machineId === LOCAL_MACHINE_ID) return this.api.sessions(path, machineId);
    return runBackgroundRead(machineId, (signal) => this.api.sessions(path, machineId, signal));
  }

  private machineBudgetMs(machineId: string): number {
    const state = this.getState();
    const machine = state.machines.find((candidate) => candidate.id === machineId)
      ?? (state.selectedMachine?.id === machineId ? state.selectedMachine : undefined);
    return machine === undefined ? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS : effectiveMachineRequestTimeoutMs(machine);
  }

  private machineName(machineId: string): string {
    const state = this.getState();
    return state.machines.find((candidate) => candidate.id === machineId)?.name
      ?? (state.selectedMachine?.id === machineId ? state.selectedMachine.name : machineId);
  }

  private async refreshProjectSessions(
    request: number,
    workspace: Workspace,
    currentSessions: SessionInfo[],
    machineId: string,
    catalogScope?: CatalogWorkspaceSelectionScope,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = this.getState();
    const projectWorkspaces = state.workspaces.filter((candidate) => candidate.projectId === workspace.projectId);
    if (!projectWorkspaces.some((candidate) => candidate.id === workspace.id)) projectWorkspaces.unshift(workspace);

    const revisions = new Map(this.sessionListRevisions);
    try {
      const sessionLists = await Promise.all(projectWorkspaces.map(async (candidate) => {
        if (candidate.id === workspace.id) return currentSessions;
        return mergeCachedNewSessions(
          candidate.path,
          await this.readProjectSiblingSessions(candidate.path, machineId, signal),
          machineId,
        );
      }));
      if (!this.isCurrentWorkspaceSessionRequest(request, workspace, machineId)
        || !this.isCatalogSelectionScopeCurrent(catalogScope)) return;
      // A later invalidation read outranks this initial catalog read per CWD.
      const currentCwds = this.relevantSessionCwds();
      const applicable = projectWorkspaces.filter((candidate) => currentCwds.has(candidate.path)
        && revisions.get(candidate.path) === this.sessionListRevisions.get(candidate.path));
      const replaced = new Set(applicable.map((candidate) => candidate.path));
      this.setState({ projectSessions: uniqueSessionsByPath([
        ...sessionLists.flat().filter((session) => replaced.has(session.cwd)),
        ...this.getState().projectSessions.filter((session) => !replaced.has(session.cwd)),
      ]) });
    } catch {
      // Cross-workspace grouping is an enhancement; preserve the current
      // workspace's already-loaded sessions if a sibling cannot be listed. A
      // cancelled sibling read lands here too and is equally harmless.
    }
  }

  async reconcileProjectCatalog(
    snapshot: ProjectCatalogSnapshot,
    options: ReconcileProjectCatalogOptions = {},
  ): Promise<void> {
    const topologyRequest = snapshot.topologyRequest ?? this.captureProjectCatalogTopologyRequest({
      machineId: snapshot.machineId,
      projectId: snapshot.project.id,
      projectPath: snapshot.project.path,
    });
    const orderedSnapshot: ProjectCatalogSnapshot = { ...snapshot, topologyRequest };
    if (!this.isProjectCatalogSnapshotCurrent(orderedSnapshot)) return;

    const { added, selectedWorkspaceRemoved } = this.applyProjectWorkspaceProjection(
      orderedSnapshot.project,
      orderedSnapshot.workspaces,
      orderedSnapshot.machineId,
    );
    if (!this.isProjectCatalogSnapshotCurrent(orderedSnapshot)
      || !this.isSelectedProject(orderedSnapshot.project)) return;

    const pending = this.pendingProjectSelection;
    if (this.isPendingProjectSelectionCurrent(pending)
      && pending.machineId === orderedSnapshot.machineId
      && pending.project.id === orderedSnapshot.project.id
      && pending.project.path === orderedSnapshot.project.path) {
      await this.completePendingProjectSelection(pending, orderedSnapshot.workspaces, {
        machineId: orderedSnapshot.machineId,
        project: orderedSnapshot.project,
        topologyRequest,
      });
      return;
    }

    for (const workspace of added) {
      this.unhydratedWorkspaceKeys.add(workspaceHydrationKey(
        orderedSnapshot.machineId,
        orderedSnapshot.project.id,
        workspace,
      ));
    }
    const workspacesToHydrate = uniqueWorkspacesByKey(orderedSnapshot.workspaces.filter((workspace) => (
      this.unhydratedWorkspaceKeys.has(workspaceHydrationKey(
        orderedSnapshot.machineId,
        orderedSnapshot.project.id,
        workspace,
      ))
    )));
    await this.hydrateDiscoveredWorkspaceSessions(orderedSnapshot, workspacesToHydrate);
    if (!this.isProjectCatalogSnapshotCurrent(orderedSnapshot)) return;

    const selectedWorkspace = this.getState().selectedWorkspace;
    if (!selectedWorkspaceRemoved
      || !this.isSelectedProject(orderedSnapshot.project)
      || selectedWorkspace === undefined
      || workspaceStillExists(selectedWorkspace, orderedSnapshot.workspaces)) return;

    const fallback = selectFallbackWorkspace(orderedSnapshot.workspaces);
    if (fallback === undefined) {
      if (options.fallbackSelection === "foreground") this.clearSelection();
      else this.clearSelection({ preserveError: true });
      return;
    }

    if (options.fallbackSelection === "foreground") {
      await this.selectWorkspace(fallback);
      return;
    }

    const fallbackState = this.getState();
    await this.selectWorkspace(fallback, {
      preserveError: true,
      catalogScope: {
        machineId: orderedSnapshot.machineId,
        project: orderedSnapshot.project,
        topologyRequest,
      },
      catalogFallback: {
        foregroundError: fallbackState.error,
        eligibleProjectSessions: fallbackState.projectSessions,
      },
    });
    if (!this.isProjectCatalogSnapshotCurrent(orderedSnapshot)) return;
  }

  async refreshProjectWorkspaces(
    projectId: string,
    options: ReconcileProjectCatalogOptions = {},
  ): Promise<Workspace[]> {
    const state = this.getState();
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new Error("Project not found");
    const machineId = selectedMachineId(state);
    const topologyRequest = this.captureProjectCatalogTopologyRequest({
      machineId,
      projectId: project.id,
      projectPath: project.path,
    });
    const workspaces = await this.api.workspaces(project.id, machineId);
    await this.reconcileProjectCatalog({ machineId, project, workspaces, topologyRequest }, options);
    return workspaces;
  }

  async refreshAfterWorkspaceDeleted(projectId: string, workspaceId: string): Promise<void> {
    const workspaces = await this.refreshProjectWorkspaces(projectId, { fallbackSelection: "foreground" });
    const state = this.getState();
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (project === undefined
      || !this.isSelectedProject(project)
      || state.selectedWorkspace?.id !== workspaceId) return;

    const fallback = selectFallbackWorkspace(workspaces);
    if (fallback !== undefined) await this.selectWorkspace(fallback);
    else this.clearSelection();
  }

  private beginProjectSelection(project: Project, target: RouteTarget | undefined): PendingProjectSelection {
    const pending: PendingProjectSelection = {
      request: ++this.projectSelectionRequest,
      machineId: selectedMachineId(this.getState()),
      project,
      target,
    };
    this.pendingProjectSelection = pending;
    return pending;
  }

  private invalidatePendingProjectSelection(): void {
    this.projectSelectionRequest += 1;
    this.pendingProjectSelection = undefined;
  }

  private isSelectedProject(project: Project): boolean {
    const selectedProject = this.getState().selectedProject;
    return selectedProject?.id === project.id && selectedProject.path === project.path;
  }

  private isPendingProjectSelectionCurrent(
    pending: PendingProjectSelection | undefined,
  ): pending is PendingProjectSelection {
    if (pending === undefined
      || this.pendingProjectSelection !== pending
      || pending.request !== this.projectSelectionRequest) return false;
    const state = this.getState();
    const currentProject = state.projects.find((candidate) => candidate.id === pending.project.id);
    return selectedMachineId(state) === pending.machineId
      && this.isSelectedProject(pending.project)
      && currentProject?.path === pending.project.path;
  }

  private async completePendingProjectSelection(
    pending: PendingProjectSelection,
    workspaces: Workspace[],
    catalogScope?: CatalogWorkspaceSelectionScope,
  ): Promise<void> {
    if (!this.isPendingProjectSelectionCurrent(pending)
      || (catalogScope !== undefined && !this.isCatalogSelectionScopeCurrent(catalogScope))) return;

    this.pendingProjectSelection = undefined;
    const workspace = selectPreferredWorkspace(workspaces, {
      targetWorkspaceId: pending.target?.workspaceId,
      latestWorkspaceId: this.workspaceSelection.latestWorkspaceId(
        machineProjectKey(pending.machineId, pending.project.id),
      ),
    });
    if (workspace !== undefined) {
      await this.selectWorkspace(workspace, {
        sessionId: pending.target?.sessionId,
        updateUrl: pending.target?.updateUrl,
        continuesSelectionLoad: true,
      });
      return;
    }

    this.setState({ isLoadingWorkspaces: false });
    if (pending.target?.updateUrl !== false) this.updateUrl();
  }

  private isCurrentWorkspaceSessionRequest(request: number, workspace: Workspace, machineId: string): boolean {
    const state = this.getState();
    return request === this.projectSessionsRequest
      && selectedMachineId(state) === machineId
      && state.selectedProject?.id === workspace.projectId
      && state.selectedWorkspace?.id === workspace.id
      && state.selectedWorkspace.path === workspace.path;
  }

  private applyProjectWorkspaceProjection(
    project: Project,
    workspaces: Workspace[],
    machineId: string,
  ): { added: Workspace[]; selectedWorkspaceRemoved: boolean } {
    const state = this.getState();
    const selectedProject = this.isSelectedProject(project);
    const oldWorkspaces = state.workspacesByProjectId[project.id]
      ?? (selectedProject ? state.workspaces : []);
    const oldWorkspaceIdentities = new Set(oldWorkspaces.map(workspaceIdentity));
    const added = workspaces.filter((workspace) => !oldWorkspaceIdentities.has(workspaceIdentity(workspace)));
    const workspacePaths = new Set(workspaces.map((workspace) => workspace.path));
    const workspaceKeys = new Set(workspaces.map((workspace) => workspaceHydrationKey(machineId, project.id, workspace)));
    for (const key of this.unhydratedWorkspaceKeys) {
      if (isWorkspaceKeyForProject(key, machineId, project.id) && !workspaceKeys.has(key)) this.unhydratedWorkspaceKeys.delete(key);
    }

    const selectedWorkspace = selectedProject ? state.selectedWorkspace : undefined;
    const refreshedSelectedWorkspace = selectedWorkspace === undefined
      ? undefined
      : workspaces.find((workspace) => workspaceIdentity(workspace) === workspaceIdentity(selectedWorkspace));
    const selectedWorkspaceRemoved = selectedWorkspace !== undefined && refreshedSelectedWorkspace === undefined;
    const workspacesByProjectId = { ...state.workspacesByProjectId, [project.id]: workspaces };
    this.setState({
      workspacesByProjectId,
      ...(selectedProject ? { workspaces } : {}),
      ...(refreshedSelectedWorkspace === undefined ? {} : { selectedWorkspace: refreshedSelectedWorkspace }),
      ...(selectedProject ? { projectSessions: state.projectSessions.filter((session) => workspacePaths.has(session.cwd)) } : {}),
    });
    return { added, selectedWorkspaceRemoved };
  }

  private async hydrateDiscoveredWorkspaceSessions(
    snapshot: ProjectCatalogSnapshot,
    workspacesToHydrate: Workspace[],
  ): Promise<void> {
    const { machineId, project } = snapshot;
    if (workspacesToHydrate.length === 0 || !this.isProjectCatalogSnapshotCurrent(snapshot)) return;

    const revisions = new Map(this.sessionListRevisions);
    const results = await Promise.allSettled(workspacesToHydrate.map(async (workspace) => {
      const sessions = await this.readDiscoveredWorkspaceSessions(workspace.path, machineId);
      if (!this.isWorkspaceCurrentForProject(snapshot, workspace)) return undefined;
      return { workspace, sessions: mergeCachedNewSessions(workspace.path, sessions, machineId) };
    }));
    if (!this.isProjectCatalogSnapshotCurrent(snapshot)) return;

    const hydratedSessions: SessionInfo[] = [];
    const hydratedSessionsByWorkspace = new Map<string, SessionInfo[]>();
    for (const [index, result] of results.entries()) {
      const workspace = workspacesToHydrate[index];
      if (workspace === undefined) continue;
      if (result.status === "rejected") {
        // A cancelled hydration keeps its workspace eligible for a later snapshot.
        if (!isLoadCancellation(result.reason)) this.reportBackgroundError("reconcile discovered workspace sessions", result.reason);
        continue;
      }
      if (result.value === undefined || revisions.get(workspace.path) !== this.sessionListRevisions.get(workspace.path)) continue;
      this.unhydratedWorkspaceKeys.delete(workspaceHydrationKey(machineId, project.id, workspace));
      hydratedSessions.push(...result.value.sessions);
      hydratedSessionsByWorkspace.set(workspaceIdentity(workspace), result.value.sessions);
    }
    if (hydratedSessions.length === 0) return;

    const state = this.getState();
    if (!this.isProjectCatalogSnapshotCurrent(snapshot) || !this.isSelectedProject(project)) return;
    const workspaces = state.workspacesByProjectId[project.id] ?? state.workspaces;
    const workspacePaths = new Set(workspaces.map((workspace) => workspace.path));
    const currentProjectSessions = state.projectSessions.filter((session) => workspacePaths.has(session.cwd));
    const selectedWorkspace = state.selectedWorkspace;
    const selectedWorkspaceSessions = selectedWorkspace === undefined
      ? undefined
      : hydratedSessionsByWorkspace.get(workspaceIdentity(selectedWorkspace));
    this.setState({
      projectSessions: uniqueSessionsByPath([
        ...hydratedSessions.filter((session) => workspacePaths.has(session.cwd)),
        ...currentProjectSessions,
      ]),
      ...(selectedWorkspace === undefined || selectedWorkspaceSessions === undefined ? {} : {
        sessions: uniqueSessionsByPath([
          ...selectedWorkspaceSessions,
          ...state.sessions.filter((session) => session.cwd === selectedWorkspace.path),
        ]),
      }),
    });
  }

  private applyCatalogFallbackSessionFailure(
    workspace: Workspace,
    machineId: string,
    fallback: CatalogFallbackSelection,
    error: unknown,
  ): void {
    this.restoreCatalogFallbackSessionState(workspace, machineId, fallback, { error });
  }

  private restoreCatalogFallbackSessionState(
    workspace: Workspace,
    machineId: string,
    fallback: CatalogFallbackSelection,
    failure?: CatalogFallbackFailure,
  ): void {
    const state = this.getState();
    const workspaces = state.workspacesByProjectId[workspace.projectId] ?? state.workspaces;
    const workspacePaths = new Set(workspaces.map((candidate) => candidate.path));
    const eligibleProjectSessions = uniqueSessionsByPath([
      ...fallback.eligibleProjectSessions.filter((session) => workspacePaths.has(session.cwd)),
      ...state.projectSessions.filter((session) => workspacePaths.has(session.cwd)),
    ]);
    this.unhydratedWorkspaceKeys.add(workspaceHydrationKey(machineId, workspace.projectId, workspace));
    if (failure !== undefined) this.reportBackgroundError("reconcile selected workspace fallback sessions", failure.error);
    this.setState({
      sessions: eligibleProjectSessions.filter((session) => session.cwd === workspace.path),
      projectSessions: eligibleProjectSessions,
      error: fallback.foregroundError,
      isLoadingSessions: false,
    });
  }

  private isCatalogFallbackRecoveryCurrent(
    workspace: Workspace,
    machineId: string,
    request: number,
    catalogScope: CatalogWorkspaceSelectionScope | undefined,
  ): boolean {
    if (catalogScope === undefined) return false;
    if (machineId !== catalogScope.machineId
      || workspace.projectId !== catalogScope.project.id
      || request !== this.projectSessionsRequest
      || !this.isProjectCatalogScopeCurrent(catalogScope.machineId, catalogScope.project)) return false;

    const state = this.getState();
    const isSelectedProject = this.isSelectedProject(catalogScope.project);
    const selectedWorkspace = state.selectedWorkspace;
    if (selectedWorkspace === undefined
      || selectedMachineId(state) !== machineId
      || !isSelectedProject
      || workspaceIdentity(selectedWorkspace) !== workspaceIdentity(workspace)) return false;

    const workspaces = state.workspacesByProjectId[workspace.projectId] ?? state.workspaces;
    return workspaceStillExists(workspace, workspaces);
  }

  private clearStaleCatalogSelectionLoadingIfOwned(
    workspace: Workspace,
    machineId: string,
    request: number,
    catalogScope: CatalogWorkspaceSelectionScope | undefined,
  ): void {
    if (catalogScope !== undefined && this.isCurrentWorkspaceSessionRequest(request, workspace, machineId)) {
      this.setState({ isLoadingSessions: false });
    }
  }

  private isWorkspaceSelectionTargetCurrent(
    workspace: Workspace,
    machineId: string,
    request: number,
    target: WorkspaceSelectionTarget | undefined,
  ): boolean {
    return this.isCurrentWorkspaceSessionRequest(request, workspace, machineId)
      && this.isCatalogSelectionScopeCurrent(target?.catalogScope);
  }

  private isCatalogSelectionScopeCurrent(catalogScope: CatalogWorkspaceSelectionScope | undefined): boolean {
    return catalogScope === undefined || (
      this.isProjectCatalogScopeCurrent(catalogScope.machineId, catalogScope.project)
      && this.isProjectCatalogTopologyRequestCurrent(catalogScope.topologyRequest)
    );
  }

  private isProjectCatalogSnapshotCurrent(snapshot: ProjectCatalogSnapshot): boolean {
    return snapshot.topologyRequest !== undefined
      && this.isProjectCatalogScopeCurrent(snapshot.machineId, snapshot.project)
      && this.isProjectCatalogTopologyRequestCurrent(snapshot.topologyRequest);
  }

  private isProjectCatalogScopeCurrent(machineId: string, project: Project): boolean {
    const state = this.getState();
    const currentProject = state.projects.find((candidate) => candidate.id === project.id);
    return selectedMachineId(state) === machineId && currentProject?.path === project.path;
  }

  private isProjectCatalogTopologyRequestCurrent(request: ProjectCatalogTopologyRequest): boolean {
    return this.latestTopologyRequestOrderByScope.get(projectCatalogTopologyScopeKey(request)) === request.order;
  }

  private isWorkspaceCurrentForProject(snapshot: ProjectCatalogSnapshot, workspace: Workspace): boolean {
    if (!this.isProjectCatalogSnapshotCurrent(snapshot)) return false;
    const state = this.getState();
    const workspaces = state.workspacesByProjectId[snapshot.project.id]
      ?? (this.isSelectedProject(snapshot.project) ? state.workspaces : []);
    return workspaceStillExists(workspace, workspaces);
  }

  private reportBackgroundError(operation: string, error: unknown): void {
    if (this.onBackgroundError === undefined) return;
    try {
      this.onBackgroundError(operation, error);
    } catch {
      // Reporting must not disrupt background reconciliation or its retry state.
    }
  }
}

export function canDeleteWorkspace(workspace: Workspace | undefined): boolean {
  return workspace !== undefined && workspace.isGitWorktree && !workspace.isMain;
}

/** Foreground is the stronger intent: it upgrades a pending background read. */
function mergeSessionListIntent(dirty: Map<string, ReadIntent>, cwd: string, intent: ReadIntent): void {
  if (dirty.get(cwd) === "foreground") return;
  dirty.set(cwd, intent);
}

function sessionListTimeoutError(budgetMs: number): HttpRequestError {
  return new HttpRequestError(
    `Session list request timed out after ${String(budgetMs)} milliseconds`,
    SESSION_LIST_TIMEOUT_STATUS,
  );
}

/**
 * Only a gateway timeout and a stopped body are typed list failures. Any other
 * rejection keeps the existing generic error reporting.
 */
function classifySessionListFailure(error: unknown): SessionListFailure["kind"] | undefined {
  if (error instanceof HttpResponseBodyError) return "transfer";
  if (error instanceof HttpRequestError && error.status === SESSION_LIST_TIMEOUT_STATUS) return "timeout";
  return undefined;
}

function forwardSupersession(source: AbortSignal | undefined, target: AbortController): () => void {
  if (source === undefined) return () => undefined;
  const forward = (): void => { target.abort(source.reason); };
  // Read through a closure so a source that aborted between the admission check
  // and the listener attach still forwards its first reason.
  const isAborted = (): boolean => source.aborted;
  if (isAborted()) {
    forward();
    return () => undefined;
  }
  source.addEventListener("abort", forward, { once: true });
  if (isAborted()) forward();
  return () => { source.removeEventListener("abort", forward); };
}

function selectFallbackWorkspace(workspaces: Workspace[]): Workspace | undefined {
  return workspaces.find((workspace) => workspace.isMain) ?? workspaces[0];
}

function isSameWorkspaceScope(state: AppState, workspace: Workspace): boolean {
  return state.selectedProject?.id === workspace.projectId
    && state.selectedWorkspace?.id === workspace.id
    && state.selectedWorkspace.path === workspace.path;
}

function workspaceIdentity(workspace: Workspace): string {
  return JSON.stringify([workspace.id, workspace.path]);
}

function projectCatalogTopologyScopeKey(scope: ProjectCatalogTopologyScope): string {
  return JSON.stringify([scope.machineId, scope.projectId, scope.projectPath]);
}

function workspaceHydrationKey(machineId: string, projectId: string, workspace: Workspace): string {
  return JSON.stringify([machineId, projectId, workspace.id, workspace.path]);
}

function isWorkspaceKeyForProject(key: string, machineId: string, projectId: string): boolean {
  return key.startsWith(`${JSON.stringify([machineId, projectId]).slice(0, -1)},`);
}

function uniqueWorkspacesByKey(workspaces: readonly Workspace[]): Workspace[] {
  const workspacesByKey = new Map<string, Workspace>();
  for (const workspace of workspaces) workspacesByKey.set(workspaceIdentity(workspace), workspace);
  return [...workspacesByKey.values()];
}

function workspaceStillExists(workspace: Workspace, workspaces: readonly Workspace[]): boolean {
  const identity = workspaceIdentity(workspace);
  return workspaces.some((candidate) => workspaceIdentity(candidate) === identity);
}

function uniqueSessionsByPath(sessions: readonly SessionInfo[]): SessionInfo[] {
  const byPath = new Map<string, SessionInfo>();
  for (const session of sessions) byPath.set(session.path, session);
  return [...byPath.values()];
}
