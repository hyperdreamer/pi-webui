import type {
  GlobalCatalogExpectation,
  GlobalWorkspaceTasksResponse,
  MoveWorkspaceTaskRequest,
  MoveWorkspaceTaskResult,
  WorkspaceCatalogExpectation,
  WorkspaceTasksCatalogResponse,
  WorkspaceTasksFailureResponse,
  WorkspaceTasksRequestResult,
} from "../../../shared/apiTypes";
import {
  appendWorkspaceTask,
  deriveWorkspaceTaskMove,
  removeWorkspaceTaskAt,
  replaceWorkspaceTaskAt,
  serializeWorkspaceTasksConfig,
  type WorkspaceTask,
  type WorkspaceTaskRef,
  type WorkspaceTaskScope,
  type WorkspaceTasksConfig,
} from "../../../shared/workspaceTasks";
import { workspaceTasksApi, type WorkspaceTasksClient } from "../api/workspaceTasksApi";
import { CancellableLoadScope, isLoadCancellation } from "./cancellableLoadScope";

const REFRESH_HINT = "Refresh and try again.";
const PARTIAL_MOVE_MESSAGE = "Move is partially complete. Refresh before retrying.";
const MANUAL_RESOLUTION_MESSAGE = "The move could not be verified. Refresh and resolve it manually.";
const DIRECT_RECONCILIATION_MESSAGE = "Task data changed while saving. Refresh before editing it.";

interface WorkspaceTasksSnapshotConfig {
  readonly version: WorkspaceTasksConfig["version"];
  readonly tasks: readonly Readonly<WorkspaceTask>[];
}

type WorkspaceTasksCatalogState =
  | { kind: "loading" }
  | { kind: "loaded"; config: WorkspaceTasksSnapshotConfig; refreshing: boolean; refreshError?: string }
  | { kind: "missing"; message: string; hint: string; refreshing: boolean; refreshError?: string }
  | { kind: "invalid"; message: string; hint: string; detail: string }
  | { kind: "unavailable"; message: string; hint: string; detail?: string }
  | { kind: "error"; message: string };

type GlobalTasksCatalogState =
  | { kind: "loading" }
  | { kind: "loaded"; config: WorkspaceTasksSnapshotConfig; refreshing: boolean; refreshError?: string }
  | { kind: "invalid"; message: string; hint: string; detail: string }
  | { kind: "unavailable"; message: string; hint: string; detail?: string }
  | { kind: "error"; message: string };

export interface WorkspaceTasksWorkspaceState {
  readonly workspace: WorkspaceTasksCatalogState;
  readonly global: GlobalTasksCatalogState;
  readonly move?: { kind: "partial" | "unknown-outcome" | "conflict"; message: string; retryAllowed: boolean };
  readonly mutationGate?: { scopes: readonly WorkspaceTaskScope[]; message: string };
}

export interface WorkspaceTasksActions {
  create(scope: WorkspaceTaskScope, task: WorkspaceTask): Promise<void>;
  update(ref: WorkspaceTaskRef, task: WorkspaceTask): Promise<void>;
  remove(ref: WorkspaceTaskRef): Promise<void>;
  move(ref: WorkspaceTaskRef, destinationTask: WorkspaceTask): Promise<void>;
  retryMove(): Promise<void>;
  refresh(): Promise<void>;
}

/** The selected identity needed to address and isolate one workspace catalog. */
export interface WorkspaceTasksSelection {
  machineId: string;
  projectId: string;
  workspaceId: string;
  workspacePath: string;
}

export interface WorkspaceTasksControllerDependencies {
  client?: WorkspaceTasksClient;
  selectedScope: () => WorkspaceTasksSelection | undefined;
  createUuid?: () => string;
  onChange?: (state: WorkspaceTasksWorkspaceState) => void;
}

type LoadOutcome = "success" | "failure" | "cancelled" | "skipped";
type RefreshMode = "ordinary" | "recovery";
type SourceLoadMode = "reuse" | "replace";

type CatalogFailure =
  | { kind: "unavailable"; message: string; detail?: string }
  | { kind: "error"; message: string };

interface InFlightCatalogRequest {
  id: number;
  promise: Promise<LoadOutcome>;
}

interface CatalogCache<TResponse> {
  readonly key: string;
  readonly loadScope: CancellableLoadScope;
  response: TResponse | undefined;
  failure: CatalogFailure | undefined;
  refreshError: string | undefined;
  attempted: boolean;
  recoveryAttempted: boolean;
  requestGeneration: number;
  readGeneration: number;
  dataGeneration: number;
  dirty: boolean;
  inFlight: InFlightCatalogRequest | undefined;
}

interface WorkspaceCatalogCache extends CatalogCache<WorkspaceTasksCatalogResponse> {
  readonly selection: Pick<WorkspaceTasksSelection, "machineId" | "projectId" | "workspaceId">;
}

interface GlobalCatalogCache extends CatalogCache<GlobalWorkspaceTasksResponse> {
  readonly machineId: string;
}

interface ActiveSelection {
  readonly machineId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly workspaceKey: string;
  readonly globalKey: string;
  readonly selectionKey: string;
}

interface RefreshOperation {
  readonly context: RefreshContext;
  readonly promise: Promise<void>;
}

interface RefreshContext {
  readonly selection: ActiveSelection;
  readonly selectionKey: string;
  readonly generation: number;
  readonly mode: RefreshMode;
}

type WorkspacePattern =
  | { kind: "loaded"; config: WorkspaceTasksConfig; revision?: string }
  | { kind: "missing"; revision: string };

interface GlobalPattern {
  config: WorkspaceTasksConfig;
  revision?: string;
}

interface MoveCatalogPair {
  workspace: WorkspacePattern;
  global: GlobalPattern;
}

interface MoveContext {
  readonly selection: ActiveSelection;
  readonly selectionKey: string;
  readonly generation: number;
  readonly workspaceKey: string;
  readonly globalKey: string;
  readonly request: MoveWorkspaceTaskRequest;
  readonly pristine: MoveCatalogPair;
  readonly destinationApplied: MoveCatalogPair;
  readonly complete: MoveCatalogPair;
  retryProhibited: boolean;
  manualMessage: string | undefined;
}

interface DirectMutationContext {
  readonly selection: ActiveSelection;
  readonly scope: WorkspaceTaskScope;
  readonly cacheKey: string;
  readonly dataGeneration: number;
}

interface SourceMutationGate {
  readonly message: string;
  readonly readGeneration: number;
  readonly requiresRecovery: boolean;
}

interface MoveMutationGate {
  readonly selectionKey: string;
  readonly workspaceKey: string;
  readonly globalKey: string;
  readonly scopes: readonly WorkspaceTaskScope[];
  readonly message: string;
}

/**
 * Owns selected Workspace Tasks catalog state. Source cache identities are kept
 * separate so switching workspaces does not invalidate a machine-global result.
 */
export class WorkspaceTasksController {
  private readonly client: WorkspaceTasksClient;
  private readonly createUuid: () => string;
  private readonly onChange: (state: WorkspaceTasksWorkspaceState) => void;
  private readonly workspaceCaches = new Map<string, WorkspaceCatalogCache>();
  private readonly globalCaches = new Map<string, GlobalCatalogCache>();
  private readonly activeMutationLocks = new Set<string>();
  private currentState = immutableState({ workspace: { kind: "loading" }, global: { kind: "loading" } });
  private activeSelection: ActiveSelection | undefined;
  private observing = false;
  private disposed = false;
  private selectionGeneration = 0;
  private refreshOperation: RefreshOperation | undefined;
  private moveContext: MoveContext | undefined;
  private moveState: WorkspaceTasksWorkspaceState["move"] | undefined;
  private moveStateSelectionKey: string | undefined;
  private readonly workspaceMutationGates = new Map<string, SourceMutationGate>();
  private readonly globalMutationGates = new Map<string, SourceMutationGate>();
  private moveMutationGate: MoveMutationGate | undefined;

  readonly actions: WorkspaceTasksActions;

  constructor(private readonly deps: WorkspaceTasksControllerDependencies) {
    this.client = deps.client ?? workspaceTasksApi;
    this.createUuid = deps.createUuid ?? (() => crypto.randomUUID());
    this.onChange = deps.onChange ?? (() => undefined);
    const actions: WorkspaceTasksActions = {
      create: (scope: WorkspaceTaskScope, task: WorkspaceTask) => this.create(scope, task),
      update: (ref: WorkspaceTaskRef, task: WorkspaceTask) => this.update(ref, task),
      remove: (ref: WorkspaceTaskRef) => this.remove(ref),
      move: (ref: WorkspaceTaskRef, destinationTask: WorkspaceTask) => this.move(ref, destinationTask),
      retryMove: () => this.retryMove(),
      refresh: () => this.refresh(),
    };
    this.actions = Object.freeze(actions);
  }

  get state(): WorkspaceTasksWorkspaceState {
    return this.currentState;
  }

  observe(enabled: boolean): void {
    if (this.disposed) return;
    if (!enabled) {
      if (!this.observing) return;
      this.observing = false;
      this.invalidateSelection();
      return;
    }

    this.observing = true;
    const selection = this.syncSelection();
    if (selection === undefined) return;
    this.ensureLoaded(selection);
  }

  refresh(): Promise<void> {
    if (this.disposed || !this.observing) return Promise.resolve();
    const selection = this.syncSelection();
    if (selection === undefined) return Promise.resolve();

    return this.startRefresh(selection, "ordinary");
  }

  private startRefresh(selection: ActiveSelection, mode: RefreshMode): Promise<void> {
    const current = this.refreshOperation;
    if (
      current?.context.selectionKey === selection.selectionKey
      && current.context.generation === this.selectionGeneration
      && mode === "ordinary"
    ) {
      return current.promise;
    }

    const context: RefreshContext = {
      selection,
      selectionKey: selection.selectionKey,
      generation: this.selectionGeneration,
      mode,
    };
    const promise = this.refreshSelection(context);
    const operation: RefreshOperation = {
      context,
      promise,
    };
    this.refreshOperation = operation;
    void promise.finally(() => {
      if (this.refreshOperation === operation) this.refreshOperation = undefined;
    });
    return promise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observing = false;
    this.invalidateSelection();
  }

  private ensureLoaded(selection: ActiveSelection): void {
    const workspace = this.workspaceCache(selection);
    const global = this.globalCache(selection);
    if (this.requiresRecoveryRefresh(workspace, global)) {
      void this.startRefresh(selection, "recovery");
      return;
    }
    void this.loadWorkspace(workspace, false).then((outcome) => {
      this.finalizeObservedSourceLoad("workspace", workspace, outcome);
    });
    void this.loadGlobal(global, false).then((outcome) => {
      this.finalizeObservedSourceLoad("global", global, outcome);
    });
  }

  private async refreshSelection(context: RefreshContext): Promise<void> {
    const selection = context.selection;
    const [workspace, global] = await Promise.all([
      this.loadWorkspace(this.workspaceCache(selection), true, context.mode === "recovery" ? "replace" : "reuse"),
      this.loadGlobal(this.globalCache(selection), true, context.mode === "recovery" ? "replace" : "reuse"),
    ]);
    if (!this.isRefreshContextCurrent(context)) return;

    this.clearDirectGatesAfterRefresh(selection, workspace, global);
    this.reconcileMoveAfterRefresh(selection, workspace, global);
    this.publishCurrent();
  }

  private async create(scope: WorkspaceTaskScope, task: WorkspaceTask): Promise<void> {
    const selection = this.actionSelection();
    if (selection === undefined || this.isMutationBlocked(selection, scope)) return;

    const catalog = this.catalogForCreate(selection, scope);
    if (catalog === undefined) return;
    const context = this.createDirectMutationContext(selection, scope);
    await this.runMutation([this.mutationLockKey(selection, scope)], async () => {
      if (!this.isSelectionCurrent(selection)) return;
      if (scope === "workspace") {
        const cache = this.workspaceCache(selection);
        const result = await this.client.replaceWorkspace({
          machineId: selection.machineId,
          projectId: selection.projectId,
          workspaceId: selection.workspaceId,
          expectedRevision: catalog.revision,
          config: appendWorkspaceTask(catalog.config, cloneTask(task)),
        });
        await this.handleDirectMutationResult(context, cache, result, (response) => {
          this.setWorkspaceResponse(cache, response);
        });
        return;
      }
      const cache = this.globalCache(selection);
      const result = await this.client.replaceGlobal({
          machineId: selection.machineId,
          expectedRevision: catalog.revision,
          config: appendWorkspaceTask(catalog.config, cloneTask(task)),
        });
      await this.handleDirectMutationResult(context, cache, result, (response) => {
        this.setGlobalResponse(cache, response);
      });
    });
  }

  private async update(ref: WorkspaceTaskRef, task: WorkspaceTask): Promise<void> {
    const selection = this.actionSelection();
    if (selection === undefined || this.isMutationBlocked(selection, ref.scope)) return;

    const catalog = this.loadedCatalogForMutation(selection, ref.scope);
    if (catalog === undefined) return;
    const context = this.createDirectMutationContext(selection, ref.scope);
    const index = catalog.config.tasks.findIndex((candidate) => candidate.id === ref.id);
    if (index === -1) {
      this.setDirectMutationGate(ref.scope, context.cacheKey, "The task changed. Refresh before editing it.");
      this.publishCurrent();
      return;
    }

    await this.runMutation([this.mutationLockKey(selection, ref.scope)], async () => {
      if (!this.isSelectionCurrent(selection)) return;
      const config = replaceWorkspaceTaskAt(catalog.config, index, cloneTask(task));
      if (ref.scope === "workspace") {
        const cache = this.workspaceCache(selection);
        const result = await this.client.replaceWorkspace({
          machineId: selection.machineId,
          projectId: selection.projectId,
          workspaceId: selection.workspaceId,
          expectedRevision: catalog.revision,
          config,
        });
        await this.handleDirectMutationResult(context, cache, result, (response) => {
          this.setWorkspaceResponse(cache, response);
        });
        return;
      }
      const cache = this.globalCache(selection);
      const result = await this.client.replaceGlobal({
          machineId: selection.machineId,
          expectedRevision: catalog.revision,
          config,
        });
      await this.handleDirectMutationResult(context, cache, result, (response) => {
        this.setGlobalResponse(cache, response);
      });
    });
  }

  private async remove(ref: WorkspaceTaskRef): Promise<void> {
    const selection = this.actionSelection();
    if (selection === undefined || this.isMutationBlocked(selection, ref.scope)) return;

    const catalog = this.loadedCatalogForMutation(selection, ref.scope);
    if (catalog === undefined) return;
    const context = this.createDirectMutationContext(selection, ref.scope);
    const index = catalog.config.tasks.findIndex((candidate) => candidate.id === ref.id);
    if (index === -1) {
      this.setDirectMutationGate(ref.scope, context.cacheKey, "The task changed. Refresh before removing it.");
      this.publishCurrent();
      return;
    }

    await this.runMutation([this.mutationLockKey(selection, ref.scope)], async () => {
      if (!this.isSelectionCurrent(selection)) return;
      const config = removeWorkspaceTaskAt(catalog.config, index);
      if (ref.scope === "workspace") {
        const cache = this.workspaceCache(selection);
        const result = await this.client.replaceWorkspace({
          machineId: selection.machineId,
          projectId: selection.projectId,
          workspaceId: selection.workspaceId,
          expectedRevision: catalog.revision,
          config,
        });
        await this.handleDirectMutationResult(context, cache, result, (response) => {
          this.setWorkspaceResponse(cache, response);
        });
        return;
      }
      const cache = this.globalCache(selection);
      const result = await this.client.replaceGlobal({
          machineId: selection.machineId,
          expectedRevision: catalog.revision,
          config,
        });
      await this.handleDirectMutationResult(context, cache, result, (response) => {
        this.setGlobalResponse(cache, response);
      });
    });
  }

  private async move(ref: WorkspaceTaskRef, destinationTask: WorkspaceTask): Promise<void> {
    const selection = this.actionSelection();
    if (selection === undefined || this.isMutationBlocked(selection, "workspace") || this.isMutationBlocked(selection, "global")) return;

    const context = this.createMoveContext(selection, ref, destinationTask);
    if (context === undefined) return;
    this.moveState = undefined;
    this.moveStateSelectionKey = undefined;

    await this.runMutation(this.mutationLockKeys(selection, ["workspace", "global"]), async () => {
      if (!this.isSelectionCurrent(selection)) return;
      this.moveContext = context;
      try {
        const result = await this.client.move(moveInput(selection, context.request));
        if (!this.isMoveContextCurrent(context)) return;
        await this.handleMoveResult(context, result);
      } catch (error) {
        if (!this.isMoveContextCurrent(context)) return;
        await this.handleUnknownMoveOutcome(context, errorMessage(error));
      }
    });
  }

  private async retryMove(): Promise<void> {
    const context = this.moveContext;
    if (context === undefined || this.moveState?.retryAllowed !== true || !this.isMoveContextCurrent(context)) return;
    if (!this.matchesMovePair(context.destinationApplied, context)) {
      this.markManualMoveResolution(context, MANUAL_RESOLUTION_MESSAGE);
      this.publishCurrent();
      return;
    }

    await this.runMutation(this.mutationLockKeys(contextSelection(context), ["workspace", "global"]), async () => {
      if (!this.isMoveContextCurrent(context) || this.moveState?.retryAllowed !== true) return;
      if (!this.matchesMovePair(context.destinationApplied, context)) {
        this.markManualMoveResolution(context, MANUAL_RESOLUTION_MESSAGE);
        this.publishCurrent();
        return;
      }
      try {
        const result = await this.client.move(moveInput(contextSelection(context), { ...context.request, intent: "retry" }));
        if (!this.isMoveContextCurrent(context)) return;
        await this.handleMoveResult(context, result);
      } catch (error) {
        if (!this.isMoveContextCurrent(context)) return;
        await this.handleUnknownMoveOutcome(context, errorMessage(error));
      }
    });
  }

  private async handleDirectMutationResult<TResponse extends WorkspaceTasksCatalogResponse | GlobalWorkspaceTasksResponse>(
    context: DirectMutationContext,
    cache: CatalogCache<TResponse>,
    result: WorkspaceTasksRequestResult<TResponse>,
    applyResponse: (response: TResponse) => void,
  ): Promise<void> {
    switch (result.kind) {
      case "success":
        if (cache.dataGeneration !== context.dataGeneration) {
          await this.reconcileStaleDirectMutation(context, cache);
          return;
        }
        applyResponse(result.value);
        this.clearDirectMutationGate(context.scope, context.cacheKey);
        this.publishForDirectMutation(context);
        return;
      case "conflict": {
        const requiresRecovery = result.reason === "invalid-catalog";
        if (requiresRecovery) {
          cache.dirty = true;
          cache.recoveryAttempted = false;
        }
        this.cancelLoad(cache);
        this.setDirectMutationGate(context.scope, context.cacheKey, result.message, requiresRecovery);
        this.publishForDirectMutation(context);
        if (result.reason === "invalid-catalog") {
          const selection = this.activeSelectionForDirectMutation(context);
          if (selection !== undefined) await this.startRefresh(selection, "recovery");
        }
        return;
      }
      case "unknown-outcome": {
        cache.dirty = true;
        cache.recoveryAttempted = false;
        this.setDirectMutationGate(context.scope, context.cacheKey, result.message, true);
        this.publishForDirectMutation(context);
        const selection = this.activeSelectionForDirectMutation(context);
        if (selection !== undefined) await this.startRefresh(selection, "recovery");
        return;
      }
      case "validation":
      case "unavailable":
        this.applyLoadFailure(cache, failureFromResult(result), false);
        this.publishForDirectMutation(context);
        return;
      default:
        return assertNever(result);
    }
  }

  private async handleMoveResult(context: MoveContext, result: MoveWorkspaceTaskResult | WorkspaceTasksFailureResponse): Promise<void> {
    if (!this.isMoveContextCurrent(context)) return;
    this.moveStateSelectionKey = context.selectionKey;
    switch (result.kind) {
      case "completed":
        if (result.operationId !== context.request.operationId) {
          this.markManualMoveResolution(context, MANUAL_RESOLUTION_MESSAGE);
          this.publishCurrent();
          return;
        }
        if (!matchesMoveObservations(context.complete, result.workspace, result.global)) {
          this.markManualMoveResolution(context, MANUAL_RESOLUTION_MESSAGE);
          this.publishCurrent();
          return;
        }
        this.applyMoveCatalogs(context, result.workspace, result.global);
        this.moveContext = undefined;
        this.moveState = undefined;
        this.moveStateSelectionKey = undefined;
        this.clearMoveMutationGate(context);
        this.publishCurrent();
        return;
      case "partial":
        if (result.operationId !== context.request.operationId) {
          this.markManualMoveResolution(context, MANUAL_RESOLUTION_MESSAGE);
          this.publishCurrent();
          return;
        }
        if (!matchesMoveObservations(context.destinationApplied, result.workspace, result.global)) {
          this.markManualMoveResolution(context, MANUAL_RESOLUTION_MESSAGE);
          this.publishCurrent();
          return;
        }
        this.applyMoveCatalogs(context, result.workspace, result.global);
        await this.beginMoveRecovery(context, { kind: "partial", message: PARTIAL_MOVE_MESSAGE, retryAllowed: false });
        return;
      case "unknown-outcome":
        await this.handleUnknownMoveOutcome(context, result.message);
        return;
      case "conflict":
        if (result.reason === "invalid-catalog") {
          await this.beginMoveRecovery(context, { kind: "unknown-outcome", message: result.message, retryAllowed: false });
          return;
        }
        this.markManualMoveResolution(context, result.message);
        this.publishCurrent();
        return;
      case "validation":
      case "unavailable":
        this.moveContext = undefined;
        this.moveStateSelectionKey = context.selectionKey;
        this.moveState = { kind: "conflict", message: result.message, retryAllowed: false };
        this.clearMoveMutationGate(context);
        this.publishCurrent();
        return;
    }
  }

  private async handleUnknownMoveOutcome(context: MoveContext, message: string): Promise<void> {
    await this.beginMoveRecovery(context, { kind: "unknown-outcome", message, retryAllowed: false });
  }

  private async beginMoveRecovery(
    context: MoveContext,
    state: NonNullable<WorkspaceTasksWorkspaceState["move"]>,
  ): Promise<void> {
    if (!this.isMoveContextCurrent(context)) return;
    this.moveStateSelectionKey = context.selectionKey;
    this.moveState = state;
    this.setMoveMutationGate(context, state.message);
    this.publishCurrent();
    await this.startRefresh(contextSelection(context), "recovery");
  }

  private reconcileMoveAfterRefresh(
    selection: ActiveSelection,
    workspaceOutcome: LoadOutcome,
    globalOutcome: LoadOutcome,
  ): void {
    const context = this.moveContext;
    if (context === undefined || !this.isMoveContextCurrent(context) || context.selectionKey !== selection.selectionKey) return;
    this.moveStateSelectionKey = context.selectionKey;

    if (workspaceOutcome !== "success" || globalOutcome !== "success") {
      this.moveState = {
        kind: "unknown-outcome",
        message: "Move recovery could not be verified. Refresh before retrying.",
        retryAllowed: false,
      };
      this.setMoveMutationGate(context, this.moveState.message);
      return;
    }

    if (this.matchesMovePair(context.complete, context)) {
      this.moveContext = undefined;
      this.moveState = undefined;
      this.moveStateSelectionKey = undefined;
      this.clearMoveMutationGate(context);
      return;
    }
    if (this.matchesMovePair(context.pristine, context)) {
      this.moveContext = undefined;
      this.moveState = undefined;
      this.moveStateSelectionKey = undefined;
      this.clearMoveMutationGate(context);
      return;
    }
    if (context.retryProhibited) {
      this.markManualMoveResolution(context, context.manualMessage ?? MANUAL_RESOLUTION_MESSAGE);
      return;
    }
    if (this.matchesMovePair(context.destinationApplied, context)) {
      this.moveState = { kind: "partial", message: PARTIAL_MOVE_MESSAGE, retryAllowed: true };
      this.setMoveMutationGate(context, this.moveState.message);
      return;
    }

    this.markManualMoveResolution(context, MANUAL_RESOLUTION_MESSAGE);
  }

  private markManualMoveResolution(context: MoveContext, message: string): void {
    if (!this.isMoveContextCurrent(context)) return;
    this.moveState = { kind: "conflict", message, retryAllowed: false };
    this.moveStateSelectionKey = context.selectionKey;
    context.retryProhibited = true;
    context.manualMessage = message;
    this.setMoveMutationGate(context, message);
  }

  private createMoveContext(
    selection: ActiveSelection,
    ref: WorkspaceTaskRef,
    destinationTask: WorkspaceTask,
  ): MoveContext | undefined {
    const workspaceResponse = this.workspaceCache(selection).response;
    const globalResponse = this.globalCache(selection).response;
    const workspaceExpectation = workspaceExpectationFor(workspaceResponse);
    const globalExpectation = globalExpectationFor(globalResponse);
    if (workspaceExpectation === undefined || globalExpectation === undefined) return undefined;

    try {
      const task = cloneTask(destinationTask);
      if (ref.scope === "workspace") {
        if (workspaceResponse?.kind !== "loaded") return undefined;
        const source: Extract<MoveWorkspaceTaskRequest["source"], { ref: { scope: "workspace" } }> = {
          ref: { scope: "workspace", id: ref.id },
          expectedCatalog: {
            kind: "loaded",
            revision: workspaceResponse.revision,
            config: cloneConfig(workspaceResponse.config),
          },
        };
        const destination: Extract<MoveWorkspaceTaskRequest["destination"], { scope: "global" }> = {
          scope: "global",
          expectedCatalog: globalExpectation,
          task,
        };
        const transformed = deriveWorkspaceTaskMove({
          source: { ref: source.ref, config: source.expectedCatalog.config },
          destination: { scope: destination.scope, config: destination.expectedCatalog.config, task },
        });
        const request: MoveWorkspaceTaskRequest = {
          operationId: this.createUuid(),
          intent: "start",
          source,
          destination,
        };
        const pristine: MoveCatalogPair = {
          workspace: workspacePattern(source.expectedCatalog),
          global: globalPattern(globalExpectation),
        };
        return this.buildMoveContext(selection, request, pristine, {
          workspace: pristine.workspace,
          global: { config: cloneConfig(transformed.destinationAfter) },
        }, {
          workspace: { kind: "loaded", config: cloneConfig(transformed.sourceAfter) },
          global: { config: cloneConfig(transformed.destinationAfter) },
        });
      }

      if (globalResponse?.kind !== "loaded") return undefined;
      const source: Extract<MoveWorkspaceTaskRequest["source"], { ref: { scope: "global" } }> = {
        ref: { scope: "global", id: ref.id },
        expectedCatalog: {
          kind: "loaded",
          revision: globalResponse.revision,
          config: cloneConfig(globalResponse.config),
        },
      };
      const destination: Extract<MoveWorkspaceTaskRequest["destination"], { scope: "workspace" }> = {
        scope: "workspace",
        expectedCatalog: workspaceExpectation,
        task,
      };
      const transformed = deriveWorkspaceTaskMove({
        source: { ref: source.ref, config: source.expectedCatalog.config },
        destination: {
          scope: destination.scope,
          config: destination.expectedCatalog.kind === "missing" ? emptyConfig() : destination.expectedCatalog.config,
          task,
        },
      });
      const request: MoveWorkspaceTaskRequest = {
        operationId: this.createUuid(),
        intent: "start",
        source,
        destination,
      };
      const pristine: MoveCatalogPair = {
        workspace: workspacePattern(workspaceExpectation),
        global: globalPattern(source.expectedCatalog),
      };
      return this.buildMoveContext(selection, request, pristine, {
        workspace: { kind: "loaded", config: cloneConfig(transformed.destinationAfter) },
        global: pristine.global,
      }, {
        workspace: { kind: "loaded", config: cloneConfig(transformed.destinationAfter) },
        global: { config: cloneConfig(transformed.sourceAfter) },
      });
    } catch (error) {
      this.moveStateSelectionKey = selection.selectionKey;
      this.moveState = { kind: "conflict", message: errorMessage(error), retryAllowed: false };
      this.publishCurrent();
      return undefined;
    }
  }

  private buildMoveContext(
    selection: ActiveSelection,
    request: MoveWorkspaceTaskRequest,
    pristine: MoveCatalogPair,
    destinationApplied: MoveCatalogPair,
    complete: MoveCatalogPair,
  ): MoveContext {
    return {
      selection,
      selectionKey: selection.selectionKey,
      generation: this.selectionGeneration,
      workspaceKey: selection.workspaceKey,
      globalKey: selection.globalKey,
      request: cloneMoveRequest(request),
      pristine,
      destinationApplied,
      complete,
      retryProhibited: false,
      manualMessage: undefined,
    };
  }

  private applyMoveCatalogs(
    context: MoveContext,
    workspace: WorkspaceTasksCatalogResponse,
    global: GlobalWorkspaceTasksResponse,
  ): void {
    const workspaceCache = this.workspaceCaches.get(context.workspaceKey);
    const globalCache = this.globalCaches.get(context.globalKey);
    if (workspaceCache === undefined || globalCache === undefined) return;
    this.setWorkspaceResponse(workspaceCache, workspace);
    this.setGlobalResponse(globalCache, global);
  }

  private matchesMovePair(pair: MoveCatalogPair, context: MoveContext): boolean {
    const workspace = this.workspaceCaches.get(context.workspaceKey)?.response;
    const global = this.globalCaches.get(context.globalKey)?.response;
    return workspace !== undefined
      && global !== undefined
      && matchesMoveObservations(pair, workspace, global);
  }

  private async runMutation(lockKeys: readonly string[], operation: () => Promise<void>): Promise<void> {
    const uniqueLockKeys = [...new Set(lockKeys)];
    if (uniqueLockKeys.some((key) => this.activeMutationLocks.has(key))) {
      throw new Error("A workspace task mutation is already in progress.");
    }
    for (const key of uniqueLockKeys) this.activeMutationLocks.add(key);
    try {
      await operation();
    } finally {
      for (const key of uniqueLockKeys) this.activeMutationLocks.delete(key);
    }
  }

  private mutationLockKey(selection: ActiveSelection, scope: WorkspaceTaskScope): string {
    const cacheKey = scope === "workspace" ? selection.workspaceKey : selection.globalKey;
    return `${scope}:${cacheKey}`;
  }

  private mutationLockKeys(selection: ActiveSelection, scopes: readonly WorkspaceTaskScope[]): string[] {
    return scopes.map((scope) => this.mutationLockKey(selection, scope));
  }

  private catalogForCreate(
    selection: ActiveSelection,
    scope: WorkspaceTaskScope,
  ): { revision: string; config: WorkspaceTasksConfig } | undefined {
    if (scope === "workspace") {
      const response = this.workspaceCache(selection).response;
      if (response?.kind === "loaded") return { revision: response.revision, config: cloneConfig(response.config) };
      if (response?.kind === "missing") return { revision: response.revision, config: emptyConfig() };
      return undefined;
    }
    return this.loadedCatalogForMutation(selection, scope);
  }

  private loadedCatalogForMutation(
    selection: ActiveSelection,
    scope: WorkspaceTaskScope,
  ): { revision: string; config: WorkspaceTasksConfig } | undefined {
    const response = scope === "workspace" ? this.workspaceCache(selection).response : this.globalCache(selection).response;
    if (response?.kind !== "loaded") return undefined;
    return { revision: response.revision, config: cloneConfig(response.config) };
  }

  private actionSelection(): ActiveSelection | undefined {
    if (this.disposed || !this.observing) return undefined;
    const selected = this.readSelection();
    const active = this.activeSelection;
    if (active?.selectionKey !== selected?.selectionKey) return undefined;
    return active;
  }

  private syncSelection(): ActiveSelection | undefined {
    const next = this.readSelection();
    if (next === undefined) {
      if (this.activeSelection !== undefined) this.invalidateSelection();
      return undefined;
    }
    if (this.activeSelection?.selectionKey === next.selectionKey) return this.activeSelection;

    const previous = this.activeSelection;
    this.activeSelection = next;
    this.selectionGeneration += 1;
    this.refreshOperation = undefined;
    this.moveContext = undefined;
    this.moveState = undefined;
    this.moveStateSelectionKey = undefined;
    this.moveMutationGate = undefined;
    if (previous !== undefined) {
      if (previous.workspaceKey !== next.workspaceKey) this.cancelWorkspaceLoad(previous.workspaceKey);
      if (previous.globalKey !== next.globalKey) this.cancelGlobalLoad(previous.globalKey);
      this.resetRetryStateForSelection(this.workspaceCache(next));
      this.resetRetryStateForSelection(this.globalCache(next));
    }
    this.publishCurrent();
    return next;
  }

  private invalidateSelection(): void {
    this.selectionGeneration += 1;
    this.refreshOperation = undefined;
    this.activeSelection = undefined;
    this.moveContext = undefined;
    this.moveState = undefined;
    this.moveStateSelectionKey = undefined;
    this.moveMutationGate = undefined;
    for (const cache of this.workspaceCaches.values()) {
      this.cancelLoad(cache);
      this.resetRetryStateForSelection(cache);
    }
    for (const cache of this.globalCaches.values()) {
      this.cancelLoad(cache);
      this.resetRetryStateForSelection(cache);
    }
  }

  private readSelection(): ActiveSelection | undefined {
    const selected = this.deps.selectedScope();
    if (selected === undefined) return undefined;
    const machineId = selected.machineId;
    const projectId = selected.projectId;
    const workspaceId = selected.workspaceId;
    const workspacePath = selected.workspacePath;
    if (![machineId, projectId, workspaceId, workspacePath].every((value) => typeof value === "string" && value !== "")) {
      return undefined;
    }
    const workspaceKey = JSON.stringify([machineId, projectId, workspaceId, workspacePath]);
    const globalKey = JSON.stringify([machineId]);
    return {
      machineId,
      projectId,
      workspaceId,
      workspacePath,
      workspaceKey,
      globalKey,
      selectionKey: JSON.stringify([workspaceKey, globalKey]),
    };
  }

  private workspaceCache(selection: ActiveSelection): WorkspaceCatalogCache {
    let cache = this.workspaceCaches.get(selection.workspaceKey);
    if (cache === undefined) {
      cache = {
        key: selection.workspaceKey,
        selection: {
          machineId: selection.machineId,
          projectId: selection.projectId,
          workspaceId: selection.workspaceId,
        },
        loadScope: new CancellableLoadScope(),
        response: undefined,
        failure: undefined,
        refreshError: undefined,
        attempted: false,
        recoveryAttempted: false,
        inFlight: undefined,
        requestGeneration: 0,
        readGeneration: 0,
        dataGeneration: 0,
        dirty: false,
      };
      this.workspaceCaches.set(cache.key, cache);
    }
    return cache;
  }

  private globalCache(selection: ActiveSelection): GlobalCatalogCache {
    let cache = this.globalCaches.get(selection.globalKey);
    if (cache === undefined) {
      cache = {
        key: selection.globalKey,
        machineId: selection.machineId,
        loadScope: new CancellableLoadScope(),
        response: undefined,
        failure: undefined,
        refreshError: undefined,
        attempted: false,
        recoveryAttempted: false,
        inFlight: undefined,
        requestGeneration: 0,
        readGeneration: 0,
        dataGeneration: 0,
        dirty: false,
      };
      this.globalCaches.set(cache.key, cache);
    }
    return cache;
  }

  private loadWorkspace(
    cache: WorkspaceCatalogCache,
    force: boolean,
    mode: SourceLoadMode = "reuse",
  ): Promise<LoadOutcome> {
    return this.loadSource(
      cache,
      force,
      (signal) => this.client.readWorkspace(cache.selection, signal),
      cloneWorkspaceResponse,
      mode,
    );
  }

  private loadGlobal(
    cache: GlobalCatalogCache,
    force: boolean,
    mode: SourceLoadMode = "reuse",
  ): Promise<LoadOutcome> {
    return this.loadSource(
      cache,
      force,
      (signal) => this.client.readGlobal(cache.machineId, signal),
      cloneGlobalResponse,
      mode,
    );
  }

  private loadSource<TResponse extends WorkspaceTasksCatalogResponse | GlobalWorkspaceTasksResponse>(
    cache: CatalogCache<TResponse>,
    force: boolean,
    request: (signal: AbortSignal) => Promise<WorkspaceTasksRequestResult<TResponse>>,
    cloneResponse: (response: TResponse) => TResponse,
    mode: SourceLoadMode,
  ): Promise<LoadOutcome> {
    if (mode === "replace") {
      cache.dirty = true;
      cache.recoveryAttempted = true;
      this.cancelLoad(cache);
    }
    if (cache.inFlight !== undefined) return cache.inFlight.promise;
    if (!force && cache.attempted) return Promise.resolve("skipped");

    const requestId = ++cache.requestGeneration;
    const dataGeneration = cache.dataGeneration;
    const signal = cache.loadScope.restart();
    cache.attempted = true;
    cache.refreshError = undefined;
    cache.failure = undefined;

    const promise = this.runSourceRequest(cache, requestId, dataGeneration, signal, request, cloneResponse);
    cache.inFlight = { id: requestId, promise };
    this.publishCurrent();
    return promise;
  }

  private async runSourceRequest<TResponse extends WorkspaceTasksCatalogResponse | GlobalWorkspaceTasksResponse>(
    cache: CatalogCache<TResponse>,
    requestId: number,
    dataGeneration: number,
    signal: AbortSignal,
    request: (signal: AbortSignal) => Promise<WorkspaceTasksRequestResult<TResponse>>,
    cloneResponse: (response: TResponse) => TResponse,
  ): Promise<LoadOutcome> {
    try {
      const result = await request(signal);
      if (!this.isCurrentSourceRequest(cache, requestId, dataGeneration)) return "cancelled";
      if (result.kind === "success") {
        cache.response = cloneResponse(result.value);
        cache.failure = undefined;
        cache.refreshError = undefined;
        cache.recoveryAttempted = false;
        cache.readGeneration += 1;
        cache.dataGeneration += 1;
        cache.dirty = false;
        this.finishSourceRequest(cache, requestId);
        this.publishCurrent();
        return "success";
      }
      this.finishSourceRequest(cache, requestId);
      this.applyLoadFailure(cache, failureFromResult(result));
      return "failure";
    } catch (error) {
      if (signal.aborted || isLoadCancellation(error) || !this.isCurrentSourceRequest(cache, requestId, dataGeneration)) {
        return "cancelled";
      }
      this.finishSourceRequest(cache, requestId);
      this.applyLoadFailure(cache, { kind: "error", message: errorMessage(error) });
      return "failure";
    } finally {
      this.finishSourceRequest(cache, requestId);
    }
  }

  private finishSourceRequest<TResponse>(cache: CatalogCache<TResponse>, requestId: number): void {
    if (cache.inFlight?.id === requestId) cache.inFlight = undefined;
  }

  private applyLoadFailure<TResponse>(cache: CatalogCache<TResponse>, failure: CatalogFailure, publish = true): void {
    if (cache.response !== undefined && retainsCatalogData(cache.response)) {
      cache.refreshError = failure.message;
    } else {
      cache.failure = failure;
      cache.refreshError = undefined;
    }
    if (publish) this.publishCurrent();
  }

  private isCurrentSourceRequest<TResponse>(cache: CatalogCache<TResponse>, requestId: number, dataGeneration: number): boolean {
    return !this.disposed && cache.requestGeneration === requestId && cache.dataGeneration === dataGeneration;
  }

  private cancelWorkspaceLoad(key: string): void {
    const cache = this.workspaceCaches.get(key);
    if (cache !== undefined) this.cancelLoad(cache);
  }

  private cancelGlobalLoad(key: string): void {
    const cache = this.globalCaches.get(key);
    if (cache !== undefined) this.cancelLoad(cache);
  }

  private cancelLoad<TResponse>(cache: CatalogCache<TResponse>): void {
    if (cache.inFlight === undefined) return;
    cache.requestGeneration += 1;
    cache.inFlight = undefined;
    cache.loadScope.abort();
  }

  private resetRetryStateForSelection<TResponse>(cache: CatalogCache<TResponse>): void {
    if (cache.dirty) {
      if (cache.inFlight === undefined) cache.recoveryAttempted = false;
      return;
    }
    if (cache.response === undefined && cache.inFlight === undefined) {
      cache.attempted = false;
      cache.recoveryAttempted = false;
    }
  }

  private setWorkspaceResponse(cache: WorkspaceCatalogCache, response: WorkspaceTasksCatalogResponse): void {
    this.cancelLoad(cache);
    cache.attempted = true;
    cache.recoveryAttempted = false;
    cache.response = cloneWorkspaceResponse(response);
    cache.failure = undefined;
    cache.refreshError = undefined;
    cache.dataGeneration += 1;
    cache.dirty = false;
  }

  private setGlobalResponse(cache: GlobalCatalogCache, response: GlobalWorkspaceTasksResponse): void {
    this.cancelLoad(cache);
    cache.attempted = true;
    cache.recoveryAttempted = false;
    cache.response = cloneGlobalResponse(response);
    cache.failure = undefined;
    cache.refreshError = undefined;
    cache.dataGeneration += 1;
    cache.dirty = false;
  }

  private isSelectionCurrent(selection: ActiveSelection): boolean {
    return !this.disposed
      && this.observing
      && this.activeSelection?.selectionKey === selection.selectionKey
      && this.readSelection()?.selectionKey === selection.selectionKey;
  }

  private isMoveContextCurrent(context: MoveContext): boolean {
    return this.isSelectionCurrent(contextSelection(context))
      && this.selectionGeneration === context.generation
      && this.moveContext === context;
  }

  private isRefreshContextCurrent(context: RefreshContext): boolean {
    return this.isSelectionCurrent(context.selection)
      && this.selectionGeneration === context.generation
      && this.refreshOperation?.context === context;
  }

  private createDirectMutationContext(selection: ActiveSelection, scope: WorkspaceTaskScope): DirectMutationContext {
    const cache = this.cacheForScope(selection, scope);
    return {
      selection,
      scope,
      cacheKey: cache.key,
      dataGeneration: cache.dataGeneration,
    };
  }

  private cacheForScope(
    selection: ActiveSelection,
    scope: WorkspaceTaskScope,
  ): WorkspaceCatalogCache | GlobalCatalogCache {
    return scope === "workspace" ? this.workspaceCache(selection) : this.globalCache(selection);
  }

  private gatesForScope(scope: WorkspaceTaskScope): Map<string, SourceMutationGate> {
    return scope === "workspace" ? this.workspaceMutationGates : this.globalMutationGates;
  }

  private setDirectMutationGate(
    scope: WorkspaceTaskScope,
    cacheKey: string,
    message: string,
    requiresRecovery = false,
  ): void {
    const cache = scope === "workspace"
      ? this.workspaceCaches.get(cacheKey)
      : this.globalCaches.get(cacheKey);
    if (cache === undefined) return;
    this.gatesForScope(scope).set(cacheKey, { message, readGeneration: cache.readGeneration, requiresRecovery });
  }

  private clearDirectMutationGate(scope: WorkspaceTaskScope, cacheKey: string): void {
    this.gatesForScope(scope).delete(cacheKey);
  }

  private clearDirectGatesAfterRefresh(
    selection: ActiveSelection,
    workspaceOutcome: LoadOutcome,
    globalOutcome: LoadOutcome,
  ): void {
    this.clearDirectGateAfterSourceRefresh("workspace", this.workspaceCache(selection), workspaceOutcome);
    this.clearDirectGateAfterSourceRefresh("global", this.globalCache(selection), globalOutcome);
  }

  private requiresRecoveryRefresh(
    workspace: WorkspaceCatalogCache,
    global: GlobalCatalogCache,
  ): boolean {
    return this.requiresSourceRecoveryRefresh("workspace", workspace)
      || this.requiresSourceRecoveryRefresh("global", global);
  }

  private requiresSourceRecoveryRefresh<TResponse>(
    scope: WorkspaceTaskScope,
    cache: CatalogCache<TResponse>,
  ): boolean {
    return cache.dirty
      && cache.inFlight === undefined
      && !cache.recoveryAttempted
      && this.gatesForScope(scope).get(cache.key)?.requiresRecovery === true;
  }

  private finalizeObservedSourceLoad<TResponse>(
    scope: WorkspaceTaskScope,
    cache: CatalogCache<TResponse>,
    outcome: LoadOutcome,
  ): void {
    if (!this.clearDirectGateAfterSourceRefresh(scope, cache, outcome)) return;
    const selection = this.activeSelection;
    if (selection === undefined || !this.isSelectionCurrent(selection)) return;
    const cacheKey = scope === "workspace" ? selection.workspaceKey : selection.globalKey;
    if (cacheKey === cache.key) this.publishCurrent();
  }

  private clearDirectGateAfterSourceRefresh<TResponse>(
    scope: WorkspaceTaskScope,
    cache: CatalogCache<TResponse>,
    outcome: LoadOutcome,
  ): boolean {
    const gate = this.gatesForScope(scope).get(cache.key);
    if (gate === undefined || outcome !== "success" || cache.readGeneration <= gate.readGeneration) return false;
    this.gatesForScope(scope).delete(cache.key);
    return true;
  }

  private activeSelectionForDirectMutation(context: DirectMutationContext): ActiveSelection | undefined {
    const selection = this.activeSelection;
    if (selection === undefined || !this.isSelectionCurrent(selection)) return undefined;
    const cacheKey = context.scope === "workspace" ? selection.workspaceKey : selection.globalKey;
    return cacheKey === context.cacheKey ? selection : undefined;
  }

  private publishForDirectMutation(context: DirectMutationContext): void {
    if (this.activeSelectionForDirectMutation(context) !== undefined) this.publishCurrent();
  }

  private async reconcileStaleDirectMutation<TResponse>(
    context: DirectMutationContext,
    cache: CatalogCache<TResponse>,
  ): Promise<void> {
    cache.dirty = true;
    cache.recoveryAttempted = false;
    this.setDirectMutationGate(context.scope, context.cacheKey, DIRECT_RECONCILIATION_MESSAGE, true);
    this.publishForDirectMutation(context);
    const selection = this.activeSelectionForDirectMutation(context);
    if (selection !== undefined) await this.startRefresh(selection, "recovery");
  }

  private isMutationBlocked(selection: ActiveSelection, scope: WorkspaceTaskScope): boolean {
    const cacheKey = scope === "workspace" ? selection.workspaceKey : selection.globalKey;
    if (this.gatesForScope(scope).has(cacheKey)) return true;
    const moveGate = this.moveMutationGate;
    return moveGate?.selectionKey === selection.selectionKey
      && moveGate.workspaceKey === selection.workspaceKey
      && moveGate.globalKey === selection.globalKey
      && moveGate.scopes.includes(scope);
  }

  private setMoveMutationGate(context: MoveContext, message: string): void {
    this.moveMutationGate = {
      selectionKey: context.selectionKey,
      workspaceKey: context.workspaceKey,
      globalKey: context.globalKey,
      scopes: ["workspace", "global"],
      message,
    };
  }

  private clearMoveMutationGate(context: MoveContext): void {
    const gate = this.moveMutationGate;
    if (gate?.selectionKey !== context.selectionKey) return;
    this.moveMutationGate = undefined;
  }

  private mutationGateForSelection(
    selection: ActiveSelection,
  ): { scopes: readonly WorkspaceTaskScope[]; message: string } | undefined {
    const moveGate = this.moveMutationGate;
    if (
      moveGate?.selectionKey === selection.selectionKey
      && moveGate.workspaceKey === selection.workspaceKey
      && moveGate.globalKey === selection.globalKey
    ) {
      return { scopes: moveGate.scopes, message: moveGate.message };
    }

    const workspaceGate = this.workspaceMutationGates.get(selection.workspaceKey);
    const globalGate = this.globalMutationGates.get(selection.globalKey);
    if (workspaceGate === undefined && globalGate === undefined) return undefined;
    const entries = [
      ...(workspaceGate === undefined ? [] : [{ scope: "workspace" as const, message: workspaceGate.message }]),
      ...(globalGate === undefined ? [] : [{ scope: "global" as const, message: globalGate.message }]),
    ];
    return {
      scopes: entries.map((entry) => entry.scope),
      message: entries.map((entry) => entry.message).join(" "),
    };
  }

  private publishCurrent(): void {
    if (this.disposed || !this.observing) return;
    const selection = this.activeSelection;
    if (selection === undefined || this.readSelection()?.selectionKey !== selection.selectionKey) return;
    const workspace = this.workspaceCache(selection);
    const global = this.globalCache(selection);
    const gate = this.mutationGateForSelection(selection);
    this.currentState = immutableState({
      workspace: workspaceState(workspace),
      global: globalState(global),
      ...(this.moveStateSelectionKey === selection.selectionKey && this.moveState !== undefined ? { move: this.moveState } : {}),
      ...(gate === undefined ? {} : { mutationGate: { scopes: [...gate.scopes], message: gate.message } }),
    });
    this.onChange(this.currentState);
  }
}

function moveInput(selection: ActiveSelection, request: MoveWorkspaceTaskRequest): MoveWorkspaceTaskRequest & {
  machineId: string;
  projectId: string;
  workspaceId: string;
} {
  return {
    machineId: selection.machineId,
    projectId: selection.projectId,
    workspaceId: selection.workspaceId,
    ...cloneMoveRequest(request),
  };
}

function contextSelection(context: MoveContext): ActiveSelection {
  return context.selection;
}

function workspaceState(cache: WorkspaceCatalogCache): WorkspaceTasksCatalogState {
  const response = cache.response;
  if (response === undefined) return stateFromFailure(cache.failure);
  switch (response.kind) {
    case "loaded":
      return {
        kind: "loaded",
        config: snapshotConfig(response.config),
        refreshing: cache.inFlight !== undefined,
        ...(cache.refreshError === undefined ? {} : { refreshError: cache.refreshError }),
      };
    case "missing":
      return {
        kind: "missing",
        message: response.message,
        hint: response.hint,
        refreshing: cache.inFlight !== undefined,
        ...(cache.refreshError === undefined ? {} : { refreshError: cache.refreshError }),
      };
    case "invalid":
      return { kind: "invalid", message: response.message, hint: response.hint, detail: response.detail };
    case "unavailable":
      return {
        kind: "unavailable",
        message: response.message,
        hint: response.hint,
        ...(response.detail === undefined ? {} : { detail: response.detail }),
      };
  }
}

function globalState(cache: GlobalCatalogCache): GlobalTasksCatalogState {
  const response = cache.response;
  if (response === undefined) return stateFromFailure(cache.failure);
  switch (response.kind) {
    case "loaded":
      return {
        kind: "loaded",
        config: snapshotConfig(response.config),
        refreshing: cache.inFlight !== undefined,
        ...(cache.refreshError === undefined ? {} : { refreshError: cache.refreshError }),
      };
    case "invalid":
      return { kind: "invalid", message: response.message, hint: response.hint, detail: response.detail };
  }
}

function stateFromFailure(failure: CatalogFailure | undefined): { kind: "loading" } | { kind: "unavailable"; message: string; hint: string; detail?: string } | { kind: "error"; message: string } {
  if (failure === undefined) return { kind: "loading" };
  if (failure.kind === "unavailable") {
    return {
      kind: "unavailable",
      message: failure.message,
      hint: REFRESH_HINT,
      ...(failure.detail === undefined ? {} : { detail: failure.detail }),
    };
  }
  return { kind: "error", message: failure.message };
}

function failureFromResult(result: WorkspaceTasksFailureResponse): CatalogFailure {
  if (result.kind === "unavailable") return { kind: "unavailable", message: result.message };
  return { kind: "error", message: result.message };
}

function retainsCatalogData(response: unknown): boolean {
  return isLoadedCatalog(response) || isMissingWorkspaceCatalog(response);
}

function isLoadedCatalog(response: unknown): response is { kind: "loaded"; config: WorkspaceTasksConfig; revision: string } {
  return typeof response === "object" && response !== null && "kind" in response && response.kind === "loaded";
}

function isMissingWorkspaceCatalog(response: unknown): response is Extract<WorkspaceTasksCatalogResponse, { kind: "missing" }> {
  return typeof response === "object" && response !== null && "kind" in response && response.kind === "missing";
}

function workspaceExpectationFor(response: WorkspaceTasksCatalogResponse | undefined): WorkspaceCatalogExpectation | undefined {
  if (response?.kind === "loaded") return { kind: "loaded", revision: response.revision, config: cloneConfig(response.config) };
  if (response?.kind === "missing") return { kind: "missing", revision: response.revision };
  return undefined;
}

function globalExpectationFor(response: GlobalWorkspaceTasksResponse | undefined): GlobalCatalogExpectation | undefined {
  if (response?.kind !== "loaded") return undefined;
  return { kind: "loaded", revision: response.revision, config: cloneConfig(response.config) };
}

function workspacePattern(expectation: WorkspaceCatalogExpectation): WorkspacePattern {
  return expectation.kind === "missing"
    ? { kind: "missing", revision: expectation.revision }
    : { kind: "loaded", revision: expectation.revision, config: cloneConfig(expectation.config) };
}

function globalPattern(expectation: GlobalCatalogExpectation): GlobalPattern {
  return { revision: expectation.revision, config: cloneConfig(expectation.config) };
}

function matchesWorkspacePattern(pattern: WorkspacePattern, response: WorkspaceTasksCatalogResponse): boolean {
  if (pattern.kind === "missing") return response.kind === "missing" && response.revision === pattern.revision;
  return response.kind === "loaded"
    && (pattern.revision === undefined || response.revision === pattern.revision)
    && configsEqual(pattern.config, response.config);
}

function matchesGlobalPattern(pattern: GlobalPattern, response: GlobalWorkspaceTasksResponse): boolean {
  return response.kind === "loaded"
    && (pattern.revision === undefined || response.revision === pattern.revision)
    && configsEqual(pattern.config, response.config);
}

function matchesMoveObservations(
  pair: MoveCatalogPair,
  workspace: WorkspaceTasksCatalogResponse,
  global: GlobalWorkspaceTasksResponse,
): boolean {
  return matchesWorkspacePattern(pair.workspace, workspace)
    && matchesGlobalPattern(pair.global, global);
}

function configsEqual(left: WorkspaceTasksConfig, right: WorkspaceTasksConfig): boolean {
  try {
    return serializeWorkspaceTasksConfig(left) === serializeWorkspaceTasksConfig(right);
  } catch {
    return false;
  }
}

function cloneWorkspaceResponse(response: WorkspaceTasksCatalogResponse): WorkspaceTasksCatalogResponse {
  if (response.kind === "loaded") return { ...response, config: cloneConfig(response.config) };
  return { ...response };
}

function cloneGlobalResponse(response: GlobalWorkspaceTasksResponse): GlobalWorkspaceTasksResponse {
  if (response.kind === "loaded") return { ...response, config: cloneConfig(response.config) };
  return { ...response };
}

function cloneMoveRequest(request: MoveWorkspaceTaskRequest): MoveWorkspaceTaskRequest {
  return {
    operationId: request.operationId,
    intent: request.intent,
    source: request.source.ref.scope === "workspace"
      ? {
        ref: { scope: "workspace", id: request.source.ref.id },
        expectedCatalog: {
          kind: "loaded",
          revision: request.source.expectedCatalog.revision,
          config: cloneConfig(request.source.expectedCatalog.config),
        },
      }
      : {
        ref: { scope: "global", id: request.source.ref.id },
        expectedCatalog: {
          kind: "loaded",
          revision: request.source.expectedCatalog.revision,
          config: cloneConfig(request.source.expectedCatalog.config),
        },
      },
    destination: request.destination.scope === "workspace"
      ? {
        scope: "workspace",
        expectedCatalog: request.destination.expectedCatalog.kind === "missing"
          ? { kind: "missing", revision: request.destination.expectedCatalog.revision }
          : {
            kind: "loaded",
            revision: request.destination.expectedCatalog.revision,
            config: cloneConfig(request.destination.expectedCatalog.config),
          },
        task: cloneTask(request.destination.task),
      }
      : {
        scope: "global",
        expectedCatalog: {
          kind: "loaded",
          revision: request.destination.expectedCatalog.revision,
          config: cloneConfig(request.destination.expectedCatalog.config),
        },
        task: cloneTask(request.destination.task),
      },
  };
}

function cloneConfig(config: WorkspaceTasksConfig): WorkspaceTasksConfig {
  return { version: config.version, tasks: config.tasks.map(cloneTask) };
}

function emptyConfig(): WorkspaceTasksConfig {
  return { version: 1, tasks: [] };
}

function cloneTask(task: WorkspaceTask): WorkspaceTask {
  return {
    id: task.id,
    title: task.title,
    command: task.command,
    ...(task.description === undefined ? {} : { description: task.description }),
    ...(task.group === undefined ? {} : { group: task.group }),
    confirm: task.confirm,
  };
}

function snapshotConfig(config: WorkspaceTasksConfig): WorkspaceTasksSnapshotConfig {
  const tasks = config.tasks.map((task) => Object.freeze(cloneTask(task)));
  return Object.freeze({ version: config.version, tasks: Object.freeze(tasks) });
}

function immutableState(state: WorkspaceTasksWorkspaceState): WorkspaceTasksWorkspaceState {
  const workspace = Object.freeze({ ...state.workspace });
  const global = Object.freeze({ ...state.global });
  const move = state.move === undefined ? undefined : Object.freeze({ ...state.move });
  const mutationGate = state.mutationGate === undefined
    ? undefined
    : Object.freeze({ scopes: Object.freeze([...state.mutationGate.scopes]), message: state.mutationGate.message });
  return Object.freeze({
    workspace,
    global,
    ...(move === undefined ? {} : { move }),
    ...(mutationGate === undefined ? {} : { mutationGate }),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Workspace Tasks result: ${JSON.stringify(value)}`);
}
