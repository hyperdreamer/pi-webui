import { workspacesApi, type Project, type Workspace } from "../api";
import type { AppState } from "../appState";
import { selectedMachineId, type GetState } from "./types";

const DEFAULT_PROJECT_CATALOG_POLL_INTERVAL_MS = 5_000;
const BACKGROUND_RECONCILIATION_OPERATION = "reconcile selected project catalog";

export interface ProjectCatalogSnapshot {
  machineId: string;
  project: Project;
  workspaces: Workspace[];
}

export interface ProjectCatalogTimer {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
}

export interface ProjectCatalogControllerDependencies {
  workspaces?: (projectId: string, machineId: string) => Promise<Workspace[]>;
  applySnapshot: (snapshot: ProjectCatalogSnapshot) => Promise<void> | void;
  timer?: ProjectCatalogTimer;
  pollIntervalMs?: number;
  onBackgroundError?: (operation: string, error: unknown) => void;
}

interface ProjectCatalogScope {
  key: string;
  machineId: string;
  project: Project;
}

interface InFlightProjectCatalogRequest {
  generation: number;
  requestId: number;
  scopeKey: string;
  promise: Promise<void>;
}

interface QueuedImmediateRefresh {
  generation: number;
  scope: ProjectCatalogScope;
  promise: Promise<void>;
  resolve(): void;
}

const defaultProjectCatalogTimer: ProjectCatalogTimer = {
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (id) => { window.clearTimeout(id); },
};

/** Owns selected-project catalog polling, refresh serialization, and stale-result suppression. */
export class ProjectCatalogController {
  private readonly listWorkspaces: NonNullable<ProjectCatalogControllerDependencies["workspaces"]>;
  private readonly applySnapshot: ProjectCatalogControllerDependencies["applySnapshot"];
  private readonly timer: ProjectCatalogTimer;
  private readonly pollIntervalMs: number;
  private readonly onBackgroundError: ProjectCatalogControllerDependencies["onBackgroundError"];
  private pollTimer: number | undefined;
  private scope: ProjectCatalogScope | undefined;
  private generation = 0;
  private nextRequestId = 0;
  private inFlight: InFlightProjectCatalogRequest | undefined;
  private queuedImmediateRefresh: QueuedImmediateRefresh | undefined;
  private observing = false;

  constructor(
    private readonly getState: GetState,
    deps: ProjectCatalogControllerDependencies,
  ) {
    this.listWorkspaces = deps.workspaces ?? workspacesApi.workspaces;
    this.applySnapshot = deps.applySnapshot;
    this.timer = deps.timer ?? defaultProjectCatalogTimer;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_PROJECT_CATALOG_POLL_INTERVAL_MS;
    this.onBackgroundError = deps.onBackgroundError;
  }

  updatePolling(observed = true): void {
    if (!observed) {
      this.stopObserving();
      return;
    }

    this.observing = true;
    const scope = this.currentScope();
    if (scope === undefined) {
      this.invalidateScope();
      return;
    }

    const scopeChanged = this.retargetScope(scope);
    if (this.inFlight !== undefined) return;
    if (!scopeChanged && this.pollTimer !== undefined) return;

    // The foreground selection already supplied this topology, so its first reconciliation is delayed.
    this.scheduleNext(scope, this.generation);
  }

  refresh(): Promise<void> {
    if (!this.observing) return Promise.resolve();

    const scope = this.currentScope();
    if (scope === undefined) {
      this.invalidateScope();
      return Promise.resolve();
    }

    this.retargetScope(scope);
    this.clearPollTimer();

    const generation = this.generation;
    const inFlight = this.inFlight;
    if (inFlight !== undefined) {
      if (inFlight.generation === generation && inFlight.scopeKey === scope.key) return inFlight.promise;
      return this.queueImmediateRefresh(scope, generation);
    }

    return this.startRequest(scope, generation);
  }

  dispose(): void {
    this.observing = false;
    this.invalidateScope();
  }

  private retargetScope(scope: ProjectCatalogScope): boolean {
    if (this.scope?.key === scope.key) {
      this.scope = scope;
      return false;
    }

    this.clearPollTimer();
    this.clearQueuedImmediateRefresh();
    this.scope = scope;
    this.generation += 1;
    return true;
  }

  private startRequest(scope: ProjectCatalogScope, generation: number): Promise<void> {
    const existing = this.inFlight;
    if (existing !== undefined) {
      if (existing.generation === generation && existing.scopeKey === scope.key) return existing.promise;
      return this.queueImmediateRefresh(scope, generation);
    }

    const requestId = ++this.nextRequestId;
    let resolveRequest: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => { resolveRequest = resolve; });
    if (resolveRequest === undefined) throw new Error("Project catalog request promise was not initialized");

    // Register before invoking collaborators so synchronous throws stay tracked and serialized.
    this.inFlight = { generation, requestId, scopeKey: scope.key, promise };
    void this.load(scope, generation, requestId).then(resolveRequest, resolveRequest);
    return promise;
  }

  private async load(scope: ProjectCatalogScope, generation: number, requestId: number): Promise<void> {
    try {
      const workspaces = await this.listWorkspaces(scope.project.id, scope.machineId);
      if (!this.isCurrent(scope, generation)) return;
      await this.applySnapshot({ machineId: scope.machineId, project: scope.project, workspaces });
    } catch (error) {
      if (this.isCurrent(scope, generation)) this.reportBackgroundError(error);
    } finally {
      this.finishRequest(requestId);
    }
  }

  private finishRequest(requestId: number): void {
    if (this.inFlight?.requestId !== requestId) return;
    this.inFlight = undefined;

    const queued = this.queuedImmediateRefresh;
    if (queued !== undefined) {
      this.queuedImmediateRefresh = undefined;
      if (this.isCurrent(queued.scope, queued.generation)) {
        void this.startRequest(queued.scope, queued.generation).then(
          () => { queued.resolve(); },
          () => { queued.resolve(); },
        );
        return;
      }
      queued.resolve();
    }

    const scope = this.scope;
    if (scope !== undefined && this.isCurrent(scope, this.generation)) this.scheduleNext(scope, this.generation);
  }

  private queueImmediateRefresh(scope: ProjectCatalogScope, generation: number): Promise<void> {
    const queued = this.queuedImmediateRefresh;
    if (queued?.generation === generation && queued.scope.key === scope.key) return queued.promise;

    this.clearQueuedImmediateRefresh();
    let resolve: (() => void) | undefined;
    const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
    if (resolve === undefined) throw new Error("Queued project catalog refresh promise was not initialized");

    this.queuedImmediateRefresh = { generation, scope, promise, resolve };
    return promise;
  }

  private scheduleNext(scope: ProjectCatalogScope, generation: number): void {
    if (!this.isCurrent(scope, generation)) return;

    this.clearPollTimer();
    this.pollTimer = this.timer.setTimeout(() => {
      this.pollTimer = undefined;
      if (!this.isCurrent(scope, generation) || this.inFlight !== undefined) return;
      void this.startRequest(scope, generation);
    }, this.pollIntervalMs);
  }

  private stopObserving(): void {
    this.observing = false;
    this.invalidateScope();
  }

  private invalidateScope(): void {
    this.clearPollTimer();
    this.clearQueuedImmediateRefresh();
    this.scope = undefined;
    this.generation += 1;
  }

  private clearPollTimer(): void {
    if (this.pollTimer === undefined) return;
    this.timer.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private clearQueuedImmediateRefresh(): void {
    const queued = this.queuedImmediateRefresh;
    this.queuedImmediateRefresh = undefined;
    queued?.resolve();
  }

  private currentScope(): ProjectCatalogScope | undefined {
    const state: AppState = this.getState();
    const project = state.selectedProject;
    if (project === undefined || state.isLoadingWorkspaces) return undefined;
    const machineId = selectedMachineId(state);
    return {
      key: JSON.stringify([machineId, project.id, project.path]),
      machineId,
      project,
    };
  }

  private isCurrent(scope: ProjectCatalogScope, generation: number): boolean {
    if (!this.observing || generation !== this.generation || this.scope?.key !== scope.key) return false;
    return this.currentScope()?.key === scope.key;
  }

  private reportBackgroundError(error: unknown): void {
    if (this.onBackgroundError === undefined) return;
    try {
      this.onBackgroundError(BACKGROUND_RECONCILIATION_OPERATION, error);
    } catch {
      // Reporting must not block the next background reconciliation.
    }
  }
}
