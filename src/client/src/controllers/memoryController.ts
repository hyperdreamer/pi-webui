import { memoryApi } from "../api";
import type { MemorySnapshotResponse } from "../../../shared/apiTypes";
import type { MemoryWorkspaceState } from "../appState";
import { LOCAL_MACHINE_ID } from "../machineKeys";
import { runBackgroundRead, type ReadIntent } from "./backgroundRead";
import { isLoadCancellation, LoadCancelledError } from "./cancellableLoadScope";
import { selectedMachineId, type GetState, type SetState } from "./types";

const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface MemoryTimer {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
}

export interface MemoryControllerDependencies {
  snapshot?: (projectPath: string, machineId: string, signal?: AbortSignal) => Promise<MemorySnapshotResponse>;
  timer?: MemoryTimer;
  pollIntervalMs?: number;
}

interface MemoryScope {
  key: string;
  machineId: string;
  projectId: string;
  workspaceId: string;
  workspacePath: string;
}

interface InFlightMemoryRequest {
  generation: number;
  requestId: number;
  scopeKey: string;
  intent: ReadIntent;
  /** Background purpose signal, so a foreground read can supersede this read. */
  cancellation: AbortController | undefined;
  promise: Promise<void>;
}

const defaultMemoryTimer: MemoryTimer = {
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (id) => { window.clearTimeout(id); },
};

/** Owns selected-workspace memory loading, serialized polling, and stale-result suppression. */
export class MemoryController {
  private readonly fetchSnapshot: NonNullable<MemoryControllerDependencies["snapshot"]>;
  private readonly timer: MemoryTimer;
  private readonly pollIntervalMs: number;
  private pollTimer: number | undefined;
  private scope: MemoryScope | undefined;
  private generation = 0;
  private nextRequestId = 0;
  private inFlight: InFlightMemoryRequest | undefined;
  private observing = false;

  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    deps: MemoryControllerDependencies = {},
  ) {
    this.fetchSnapshot = deps.snapshot ?? memoryApi.snapshot;
    this.timer = deps.timer ?? defaultMemoryTimer;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
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
    if (this.scope?.key !== scope.key) {
      void this.startScope(scope);
      return;
    }
    if (this.inFlight?.generation === this.generation && this.inFlight.scopeKey === scope.key) return;
    if (this.pollTimer !== undefined) return;
    void this.startRequest(scope, "foreground");
  }

  async refresh(): Promise<void> {
    if (!this.observing) return;
    const scope = this.currentScope();
    if (scope === undefined) {
      this.invalidateScope();
      return;
    }
    if (this.scope?.key !== scope.key) {
      await this.startScope(scope);
      return;
    }
    this.clearPollTimer();
    await this.startRequest(scope, "foreground");
  }

  dispose(): void {
    this.observing = false;
    this.invalidateScope();
  }

  private startScope(scope: MemoryScope): Promise<void> {
    this.invalidateScope();
    this.scope = scope;
    this.setState({ memory: { kind: "loading" } });
    return this.startRequest(scope, "foreground");
  }

  private startRequest(scope: MemoryScope, intent: ReadIntent): Promise<void> {
    const existing = this.inFlight;
    if (existing?.generation === this.generation && existing.scopeKey === scope.key) {
      if (intent !== "foreground" || existing.intent !== "background") return existing.promise;
      // Foreground work wins over a running poll: cancel the bounded read and
      // start a full-budget read instead of joining the background one.
      this.supersedeBackgroundRequest(existing);
    }

    const generation = this.generation;
    const requestId = ++this.nextRequestId;
    const cancellation = intent === "background" ? new AbortController() : undefined;
    // `load()` can settle synchronously when a snapshot collaborator throws, so register it first.
    const request: InFlightMemoryRequest = {
      generation,
      requestId,
      scopeKey: scope.key,
      intent,
      cancellation,
      promise: Promise.resolve(),
    };
    this.inFlight = request;
    const promise = this.load(scope, generation, requestId, cancellation?.signal);
    request.promise = promise;
    return promise;
  }

  private supersedeBackgroundRequest(request: InFlightMemoryRequest): void {
    if (this.inFlight === request) this.inFlight = undefined;
    request.cancellation?.abort(new LoadCancelledError());
  }

  private async load(
    scope: MemoryScope,
    generation: number,
    requestId: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    try {
      const snapshot = await this.readSnapshot(scope, signal);
      if (!this.isCurrent(scope, generation)) return;
      const memory = stateForSnapshot(snapshot);
      this.setState({ memory });
      if (memory.kind === "unavailable") this.stopObserving();
    } catch (error) {
      if (isLoadCancellation(error)) return;
      if (!this.isCurrent(scope, generation)) return;
      this.applyFailure(String(error));
    } finally {
      const wasCurrentRequest = this.inFlight?.requestId === requestId;
      if (wasCurrentRequest) this.inFlight = undefined;
      if (wasCurrentRequest && this.isCurrent(scope, generation)) this.scheduleNext(scope, generation);
    }
  }

  /**
   * Only scheduled polls are background work. Initial and manual loads keep the
   * machine budget, and the local machine never takes the background helper.
   */
  private readSnapshot(scope: MemoryScope, signal: AbortSignal | undefined): Promise<MemorySnapshotResponse> {
    if (signal === undefined || scope.machineId === LOCAL_MACHINE_ID) {
      return this.fetchSnapshot(scope.workspacePath, scope.machineId);
    }
    return runBackgroundRead(
      scope.machineId,
      (backgroundSignal) => this.fetchSnapshot(scope.workspacePath, scope.machineId, backgroundSignal),
      signal,
    );
  }

  private applyFailure(message: string): void {
    const memory = this.getState().memory;
    if (memory.kind === "data") {
      this.setState({ memory: { ...memory, refreshError: message } });
      return;
    }
    this.setState({ memory: { kind: "error", message } });
  }

  private scheduleNext(scope: MemoryScope, generation: number): void {
    this.clearPollTimer();
    this.pollTimer = this.timer.setTimeout(() => {
      this.pollTimer = undefined;
      if (!this.observing || !this.isCurrent(scope, generation)) return;
      void this.startRequest(scope, "background");
    }, this.pollIntervalMs);
  }

  private stopObserving(): void {
    if (!this.observing) return;
    this.observing = false;
    this.invalidateScope();
  }

  private invalidateScope(): void {
    this.clearPollTimer();
    this.scope = undefined;
    this.inFlight = undefined;
    this.generation += 1;
  }

  private clearPollTimer(): void {
    if (this.pollTimer === undefined) return;
    this.timer.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private currentScope(): MemoryScope | undefined {
    const state = this.getState();
    const project = state.selectedProject;
    const workspace = state.selectedWorkspace;
    if (project === undefined || workspace === undefined) return undefined;
    const machineId = selectedMachineId(state);
    return {
      key: JSON.stringify([machineId, project.id, workspace.id, workspace.path]),
      machineId,
      projectId: project.id,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
    };
  }

  private isCurrent(scope: MemoryScope, generation: number): boolean {
    if (!this.observing || generation !== this.generation || this.scope?.key !== scope.key) return false;
    const current = this.currentScope();
    if (current?.machineId !== scope.machineId) return false;
    return current.projectId === scope.projectId
      && current.workspaceId === scope.workspaceId
      && current.workspacePath === scope.workspacePath;
  }
}

function stateForSnapshot(snapshot: MemorySnapshotResponse): MemoryWorkspaceState {
  if (snapshot.kind === "unavailable") return { kind: "unavailable" };
  return {
    kind: "data",
    globalEntries: snapshot.globalEntries,
    projectEntries: snapshot.projectEntries,
    ...(snapshot.projectUnavailableMessage === undefined ? {} : { projectUnavailableMessage: snapshot.projectUnavailableMessage }),
  };
}
