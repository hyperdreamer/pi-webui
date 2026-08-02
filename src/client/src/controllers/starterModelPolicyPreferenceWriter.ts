import type { StarterModelPolicyPreference } from "../../../shared/apiTypes";

export interface StarterModelPolicyPreferenceWriteScope {
  machineId: string;
  cwd: string;
}

export interface StarterModelPolicyPreferenceWriteSnapshot {
  saving: boolean;
  error?: string;
}

export interface StarterModelPolicyPreferenceWriterDependencies {
  save(
    scope: StarterModelPolicyPreferenceWriteScope,
    preference: StarterModelPolicyPreference,
  ): Promise<unknown>;
  onStateChange?: (
    scope: StarterModelPolicyPreferenceWriteScope,
    snapshot: StarterModelPolicyPreferenceWriteSnapshot,
  ) => void;
}

interface PendingPreferenceWrite {
  preference: StarterModelPolicyPreference;
  completions: (() => void)[];
}

interface PreferenceWriteState {
  scope: StarterModelPolicyPreferenceWriteScope;
  worker: Promise<void> | undefined;
  pending: PendingPreferenceWrite | undefined;
  error: string | undefined;
}

export class StarterModelPolicyPreferenceWriter {
  private readonly states = new Map<string, PreferenceWriteState>();

  constructor(private readonly deps: StarterModelPolicyPreferenceWriterDependencies) {}

  write(
    scope: StarterModelPolicyPreferenceWriteScope,
    preference: StarterModelPolicyPreference,
  ): Promise<void> {
    const state = this.stateFor(scope);
    let resolveCompletion: (() => void) | undefined;
    const completion = new Promise<void>((resolvePromise) => { resolveCompletion = resolvePromise; });
    if (resolveCompletion === undefined) {
      throw new Error("Preference write completion was not initialized");
    }

    if (state.pending === undefined) {
      state.pending = { preference: clonePreference(preference), completions: [resolveCompletion] };
    } else {
      state.pending.preference = clonePreference(preference);
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

  private stateFor(scope: StarterModelPolicyPreferenceWriteScope): PreferenceWriteState {
    const key = scopeKey(scope);
    const existing = this.states.get(key);
    if (existing !== undefined) return existing;
    const state: PreferenceWriteState = {
      scope: cloneScope(scope),
      worker: undefined,
      pending: undefined,
      error: undefined,
    };
    this.states.set(key, state);
    return state;
  }

  private startWorker(state: PreferenceWriteState): void {
    let resolveWorker: (() => void) | undefined;
    const worker = new Promise<void>((resolvePromise) => { resolveWorker = resolvePromise; });
    if (resolveWorker === undefined) throw new Error("Preference write worker was not initialized");
    const completeWorker = resolveWorker;

    state.worker = worker;
    void this.runWorker(state).then(
      () => { this.finishWorker(state, worker, completeWorker); },
      (error: unknown) => {
        state.error = String(error);
        this.finishWorker(state, worker, completeWorker);
      },
    );
  }

  private async runWorker(state: PreferenceWriteState): Promise<void> {
    while (state.pending !== undefined) {
      const pending = state.pending;
      state.pending = undefined;
      try {
        await this.deps.save(cloneScope(state.scope), pending.preference);
        state.error = undefined;
      } catch (error) {
        state.error = String(error);
      }
      for (const resolveCompletion of pending.completions) resolveCompletion();
      this.publish(state);
    }
  }

  private finishWorker(
    state: PreferenceWriteState,
    worker: Promise<void>,
    resolveWorker: () => void,
  ): void {
    if (state.worker === worker) {
      state.worker = undefined;
      if (state.pending !== undefined) this.startWorker(state);
      this.publish(state);
    }
    resolveWorker();
  }

  private publish(state: PreferenceWriteState): void {
    try {
      this.deps.onStateChange?.(cloneScope(state.scope), snapshotFor(state));
    } catch {
      // State reporting must not interrupt preference persistence.
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

function clonePreference(
  preference: StarterModelPolicyPreference,
): StarterModelPolicyPreference {
  return {
    mode: preference.mode,
    ...(preference.tier === undefined ? {} : { tier: preference.tier }),
  };
}

function snapshotFor(state: PreferenceWriteState): StarterModelPolicyPreferenceWriteSnapshot {
  return {
    saving: state.worker !== undefined,
    ...(state.error === undefined ? {} : { error: state.error }),
  };
}
