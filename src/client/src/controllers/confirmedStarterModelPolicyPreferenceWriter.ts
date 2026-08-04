import type { SessionInfo } from "../api";
import type {
  StarterModelPolicyPreferenceWriteScope,
  StarterModelPolicyPreferenceWriteSnapshot,
} from "./starterModelPolicyPreferenceWriter";

export type {
  StarterModelPolicyPreferenceWriteScope,
  StarterModelPolicyPreferenceWriteSnapshot,
} from "./starterModelPolicyPreferenceWriter";

export interface ConfirmedStarterModelPolicyPreferenceWriterDependencies {
  remember(
    scope: StarterModelPolicyPreferenceWriteScope,
    session: SessionInfo,
  ): Promise<unknown>;
  onStateChange?: (
    scope: StarterModelPolicyPreferenceWriteScope,
    snapshot: StarterModelPolicyPreferenceWriteSnapshot,
  ) => void;
}

interface PendingConfirmedPreferenceWrite {
  session: SessionInfo;
  completions: (() => void)[];
}

interface ConfirmedPreferenceWriteState {
  scope: StarterModelPolicyPreferenceWriteScope;
  worker: Promise<void> | undefined;
  pending: PendingConfirmedPreferenceWrite | undefined;
  error: string | undefined;
}

export class ConfirmedStarterModelPolicyPreferenceWriter {
  private readonly states = new Map<string, ConfirmedPreferenceWriteState>();

  constructor(private readonly deps: ConfirmedStarterModelPolicyPreferenceWriterDependencies) {}

  write(scope: StarterModelPolicyPreferenceWriteScope, session: SessionInfo): Promise<void> {
    const state = this.stateFor(scope);
    let resolveCompletion: (() => void) | undefined;
    const completion = new Promise<void>((resolvePromise) => { resolveCompletion = resolvePromise; });
    if (resolveCompletion === undefined) {
      throw new Error("Confirmed preference write completion was not initialized");
    }

    if (state.pending === undefined) {
      state.pending = { session: cloneSession(session), completions: [resolveCompletion] };
    } else {
      state.pending.session = cloneSession(session);
      state.pending.completions.push(resolveCompletion);
    }
    if (state.worker === undefined) this.startWorker(state);
    this.publish(state);
    return completion;
  }

  snapshot(scope: StarterModelPolicyPreferenceWriteScope): StarterModelPolicyPreferenceWriteSnapshot {
    const state = this.states.get(scopeKey(scope));
    return state === undefined ? { saving: false } : snapshotFor(state);
  }

  private stateFor(scope: StarterModelPolicyPreferenceWriteScope): ConfirmedPreferenceWriteState {
    const key = scopeKey(scope);
    const existing = this.states.get(key);
    if (existing !== undefined) return existing;
    const state: ConfirmedPreferenceWriteState = {
      scope: cloneScope(scope),
      worker: undefined,
      pending: undefined,
      error: undefined,
    };
    this.states.set(key, state);
    return state;
  }

  private startWorker(state: ConfirmedPreferenceWriteState): void {
    let resolveWorker: (() => void) | undefined;
    const worker = new Promise<void>((resolvePromise) => { resolveWorker = resolvePromise; });
    if (resolveWorker === undefined) {
      throw new Error("Confirmed preference write worker was not initialized");
    }
    const completeWorker = resolveWorker;

    state.worker = worker;
    void this.runWorker(state).then(() => { this.finishWorker(state, worker, completeWorker); });
  }

  private async runWorker(state: ConfirmedPreferenceWriteState): Promise<void> {
    while (state.pending !== undefined) {
      const pending = state.pending;
      state.pending = undefined;
      try {
        await this.deps.remember(cloneScope(state.scope), pending.session);
        state.error = undefined;
      } catch (error) {
        state.error = String(error);
      }
      for (const resolveCompletion of pending.completions) resolveCompletion();
      this.publish(state);
    }
  }

  private finishWorker(
    state: ConfirmedPreferenceWriteState,
    worker: Promise<void>,
    resolveWorker: () => void,
  ): void {
    if (state.worker === worker) {
      state.worker = undefined;
      if (state.pending !== undefined) this.startWorker(state);
      this.publish(state);
      this.pruneIdleState(state);
    }
    resolveWorker();
  }

  private pruneIdleState(state: ConfirmedPreferenceWriteState): void {
    if (state.worker !== undefined || state.pending !== undefined || state.error !== undefined) return;
    const key = scopeKey(state.scope);
    if (this.states.get(key) === state) this.states.delete(key);
  }

  private publish(state: ConfirmedPreferenceWriteState): void {
    try {
      this.deps.onStateChange?.(cloneScope(state.scope), snapshotFor(state));
    } catch {
      // State reporting must not interrupt confirmed preference persistence.
    }
  }
}

function scopeKey(scope: StarterModelPolicyPreferenceWriteScope): string {
  return JSON.stringify([scope.machineId, scope.cwd]);
}

function cloneScope(
  scope: StarterModelPolicyPreferenceWriteScope,
): StarterModelPolicyPreferenceWriteScope {
  return { machineId: scope.machineId, cwd: scope.cwd };
}

function cloneSession(session: SessionInfo): SessionInfo {
  return { ...session };
}

function snapshotFor(
  state: ConfirmedPreferenceWriteState,
): StarterModelPolicyPreferenceWriteSnapshot {
  return {
    saving: state.worker !== undefined,
    ...(state.error === undefined ? {} : { error: state.error }),
  };
}
