import { memoryApi } from "../api";
import type { MemorySnapshotResponse } from "../../../shared/apiTypes";
import type { MemoryWorkspaceState } from "../appState";
import { selectedMachineId, type GetState, type SetState } from "./types";

const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface MemoryTimer {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
}

export interface MemoryControllerDependencies {
  snapshot?: (projectPath: string, machineId: string) => Promise<MemorySnapshotResponse>;
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

  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    deps: MemoryControllerDependencies = {},
  ) {
    this.fetchSnapshot = deps.snapshot ?? memoryApi.snapshot;
    this.timer = deps.timer ?? defaultMemoryTimer;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  updatePolling(): void {
    const scope = this.currentScope();
    if (scope === undefined) {
      this.invalidateScope();
      return;
    }
    if (this.scope?.key !== scope.key) {
      this.startScope(scope);
      return;
    }
    if (this.inFlight?.generation === this.generation && this.inFlight.scopeKey === scope.key) return;
    if (this.pollTimer !== undefined) return;
    void this.startRequest(scope);
  }

  async refresh(): Promise<void> {
    const scope = this.currentScope();
    if (scope === undefined) {
      this.invalidateScope();
      return;
    }
    if (this.scope?.key !== scope.key) this.startScope(scope);
    else this.clearPollTimer();
    await this.startRequest(scope);
  }

  dispose(): void {
    this.invalidateScope();
  }

  private startScope(scope: MemoryScope): void {
    this.invalidateScope();
    this.scope = scope;
    this.setState({ memory: { kind: "loading" } });
    void this.startRequest(scope);
  }

  private startRequest(scope: MemoryScope): Promise<void> {
    const existing = this.inFlight;
    if (existing?.generation === this.generation && existing.scopeKey === scope.key) return existing.promise;

    const generation = this.generation;
    const requestId = ++this.nextRequestId;
    // `load()` can settle synchronously when a snapshot collaborator throws, so register it first.
    const request: InFlightMemoryRequest = { generation, requestId, scopeKey: scope.key, promise: Promise.resolve() };
    this.inFlight = request;
    const promise = this.load(scope, generation, requestId);
    request.promise = promise;
    return promise;
  }

  private async load(scope: MemoryScope, generation: number, requestId: number): Promise<void> {
    try {
      const snapshot = await this.fetchSnapshot(scope.workspacePath, scope.machineId);
      if (!this.isCurrent(scope, generation)) return;
      this.setState({ memory: stateForSnapshot(snapshot) });
    } catch (error) {
      if (!this.isCurrent(scope, generation)) return;
      this.applyFailure(String(error));
    } finally {
      const wasCurrentRequest = this.inFlight?.requestId === requestId;
      if (wasCurrentRequest) this.inFlight = undefined;
      if (wasCurrentRequest && this.isCurrent(scope, generation)) this.scheduleNext(scope, generation);
    }
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
      if (!this.isCurrent(scope, generation)) return;
      void this.startRequest(scope);
    }, this.pollIntervalMs);
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
    if (generation !== this.generation || this.scope?.key !== scope.key) return false;
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
