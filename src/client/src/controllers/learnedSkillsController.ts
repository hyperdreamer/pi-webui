import { learnedSkillsApi } from "../api";
import type { LearnedSkillsSnapshotResponse } from "../../../shared/apiTypes";
import type { LearnedSkillsWorkspaceState } from "../appState";
import { LOCAL_MACHINE_ID } from "../machineKeys";
import { runBackgroundRead, type ReadIntent } from "./backgroundRead";
import { isLoadCancellation, LoadCancelledError } from "./cancellableLoadScope";
import { selectedMachineId, type GetState, type SetState } from "./types";

const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface LearnedSkillsTimer {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
}

export interface LearnedSkillsControllerDependencies {
  snapshot?: (projectPath: string, machineId: string, signal?: AbortSignal) => Promise<LearnedSkillsSnapshotResponse>;
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
  intent: ReadIntent;
  /** Background purpose signal, so a foreground read can supersede this read. */
  cancellation: AbortController | undefined;
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

  private startScope(scope: LearnedSkillsScope): Promise<void> {
    this.invalidateScope();
    this.scope = scope;
    this.setState({ learnedSkills: { kind: "loading" } });
    return this.startRequest(scope, "foreground");
  }

  private startRequest(scope: LearnedSkillsScope, intent: ReadIntent): Promise<void> {
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
    const request: InFlightLearnedSkillsRequest = {
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

  private supersedeBackgroundRequest(request: InFlightLearnedSkillsRequest): void {
    if (this.inFlight === request) this.inFlight = undefined;
    request.cancellation?.abort(new LoadCancelledError());
  }

  private async load(
    scope: LearnedSkillsScope,
    generation: number,
    requestId: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    try {
      const snapshot = await this.readSnapshot(scope, signal);
      if (!this.isCurrent(scope, generation)) return;
      const learnedSkills = stateForSnapshot(snapshot);
      this.setState({ learnedSkills });
      if (learnedSkills.kind === "unavailable") this.stopObserving();
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
  private readSnapshot(scope: LearnedSkillsScope, signal: AbortSignal | undefined): Promise<LearnedSkillsSnapshotResponse> {
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
