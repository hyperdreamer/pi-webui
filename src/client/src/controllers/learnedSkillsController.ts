import { learnedSkillsApi } from "../api";
import type { LearnedSkillsSnapshotResponse } from "../../../shared/apiTypes";
import type { LearnedSkillsWorkspaceState } from "../appState";
import { selectedMachineId, type GetState, type SetState } from "./types";

const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface LearnedSkillsTimer {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
}

export interface LearnedSkillsControllerDependencies {
  snapshot?: (projectPath: string, machineId: string) => Promise<LearnedSkillsSnapshotResponse>;
  timer?: LearnedSkillsTimer;
  pollIntervalMs?: number;
}

interface LearnedSkillsScope {
  key: string;
  machineId: string;
  projectId: string;
  workspaceId: string;
  workspacePath: string;
}

interface InFlightLearnedSkillsRequest {
  generation: number;
  requestId: number;
  scopeKey: string;
  promise: Promise<void>;
}

const defaultLearnedSkillsTimer: LearnedSkillsTimer = {
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (id) => { window.clearTimeout(id); },
};

/** Owns selected-workspace learned-skill loading, serialized polling, and stale-result suppression. */
export class LearnedSkillsController {
  private readonly fetchSnapshot: NonNullable<LearnedSkillsControllerDependencies["snapshot"]>;
  private readonly timer: LearnedSkillsTimer;
  private readonly pollIntervalMs: number;
  private pollTimer: number | undefined;
  private scope: LearnedSkillsScope | undefined;
  private generation = 0;
  private nextRequestId = 0;
  private inFlight: InFlightLearnedSkillsRequest | undefined;
  private observing = false;

  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    deps: LearnedSkillsControllerDependencies = {},
  ) {
    this.fetchSnapshot = deps.snapshot ?? learnedSkillsApi.snapshot;
    this.timer = deps.timer ?? defaultLearnedSkillsTimer;
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
    void this.startRequest(scope);
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
    await this.startRequest(scope);
  }

  dispose(): void {
    this.observing = false;
    this.invalidateScope();
  }

  private startScope(scope: LearnedSkillsScope): Promise<void> {
    this.invalidateScope();
    this.scope = scope;
    this.setState({ learnedSkills: { kind: "loading" } });
    return this.startRequest(scope);
  }

  private startRequest(scope: LearnedSkillsScope): Promise<void> {
    const existing = this.inFlight;
    if (existing?.generation === this.generation && existing.scopeKey === scope.key) return existing.promise;

    const generation = this.generation;
    const requestId = ++this.nextRequestId;
    // `load()` can settle synchronously when a snapshot collaborator throws, so register it first.
    const request: InFlightLearnedSkillsRequest = { generation, requestId, scopeKey: scope.key, promise: Promise.resolve() };
    this.inFlight = request;
    const promise = this.load(scope, generation, requestId);
    request.promise = promise;
    return promise;
  }

  private async load(scope: LearnedSkillsScope, generation: number, requestId: number): Promise<void> {
    try {
      const snapshot = await this.fetchSnapshot(scope.workspacePath, scope.machineId);
      if (!this.isCurrent(scope, generation)) return;
      const learnedSkills = stateForSnapshot(snapshot);
      this.setState({ learnedSkills });
      if (learnedSkills.kind === "unavailable") this.stopObserving();
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
    const learnedSkills = this.getState().learnedSkills;
    if (learnedSkills.kind === "data") {
      this.setState({ learnedSkills: { ...learnedSkills, refreshError: message } });
      return;
    }
    this.setState({ learnedSkills: { kind: "error", message } });
  }

  private scheduleNext(scope: LearnedSkillsScope, generation: number): void {
    this.clearPollTimer();
    this.pollTimer = this.timer.setTimeout(() => {
      this.pollTimer = undefined;
      if (!this.observing || !this.isCurrent(scope, generation)) return;
      void this.startRequest(scope);
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

  private currentScope(): LearnedSkillsScope | undefined {
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

  private isCurrent(scope: LearnedSkillsScope, generation: number): boolean {
    if (!this.observing || generation !== this.generation || this.scope?.key !== scope.key) return false;
    const current = this.currentScope();
    if (current?.machineId !== scope.machineId) return false;
    return current.projectId === scope.projectId
      && current.workspaceId === scope.workspaceId
      && current.workspacePath === scope.workspacePath;
  }
}

function stateForSnapshot(snapshot: LearnedSkillsSnapshotResponse): LearnedSkillsWorkspaceState {
  if (snapshot.kind === "unavailable") return { kind: "unavailable" };
  return {
    kind: "data",
    globalSkills: snapshot.globalSkills,
    projectSkills: snapshot.projectSkills,
    ...(snapshot.projectUnavailableMessage === undefined ? {} : { projectUnavailableMessage: snapshot.projectUnavailableMessage }),
  };
}
