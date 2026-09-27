import type { SessionInfo } from "../api";
import type { StarterModelPolicyPreference } from "../../../shared/apiTypes";
import type {
  StarterModelPolicyPreferenceWriteScope,
  StarterModelPolicyPreferenceWriteSnapshot,
} from "./starterModelPolicyPreferenceWriter";

export type {
  StarterModelPolicyPreferenceWriteScope,
  StarterModelPolicyPreferenceWriteSnapshot,
} from "./starterModelPolicyPreferenceWriter";

export type ConfirmedPreferenceWriteContext =
  | { reason: "creation"; requestedPolicy: StarterModelPolicyPreference }
  | { reason: "policy-save" };

export interface ConfirmedStarterModelPolicyPreferenceWriterDependencies {
  remember(
    scope: StarterModelPolicyPreferenceWriteScope,
    session: SessionInfo,
  ): Promise<StarterModelPolicyPreference>;
  onRemembered?: (
    scope: StarterModelPolicyPreferenceWriteScope,
    preference: StarterModelPolicyPreference,
    context: ConfirmedPreferenceWriteContext,
  ) => void;
  onStateChange?: (
    scope: StarterModelPolicyPreferenceWriteScope,
    snapshot: StarterModelPolicyPreferenceWriteSnapshot,
  ) => void;
}

interface PendingConfirmedPreferenceWrite {
  session: SessionInfo;
  context: ConfirmedPreferenceWriteContext;
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

  write(
    scope: StarterModelPolicyPreferenceWriteScope,
    session: SessionInfo,
    context: ConfirmedPreferenceWriteContext,
  ): Promise<void> {
    const state = this.stateFor(scope);
    let resolveCompletion: (() => void) | undefined;
    const completion = new Promise<void>((resolvePromise) => { resolveCompletion = resolvePromise; });
    if (resolveCompletion === undefined) {
      throw new Error("Confirmed preference write completion was not initialized");
    }

    if (state.pending === undefined) {
      state.pending = { session: cloneSession(session), context: cloneContext(context), completions: [resolveCompletion] };
    } else {
      state.pending.session = cloneSession(session);
      state.pending.context = cloneContext(context);
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
        const remembered = await this.deps.remember(cloneScope(state.scope), pending.session);
        state.error = undefined;
        this.reportRemembered(state, remembered, pending.context);
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

  private reportRemembered(
    state: ConfirmedPreferenceWriteState,
    preference: StarterModelPolicyPreference,
    context: ConfirmedPreferenceWriteContext,
  ): void {
    try {
      this.deps.onRemembered?.(cloneScope(state.scope), preference, context);
    } catch {
      // Observation must not interrupt confirmed preference persistence.
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

function cloneContext(context: ConfirmedPreferenceWriteContext): ConfirmedPreferenceWriteContext {
  return context.reason === "creation"
    ? { reason: "creation", requestedPolicy: clonePreference(context.requestedPolicy) }
    : { reason: "policy-save" };
}

function clonePreference(preference: StarterModelPolicyPreference): StarterModelPolicyPreference {
  return {
    mode: preference.mode,
    exact: {
      model: { ...preference.exact.model },
      thinkingLevel: preference.exact.thinkingLevel,
    },
    ...(preference.tier === undefined ? {} : { tier: preference.tier }),
  };
}

function snapshotFor(
  state: ConfirmedPreferenceWriteState,
): StarterModelPolicyPreferenceWriteSnapshot {
  return {
    saving: state.worker !== undefined,
    ...(state.error === undefined ? {} : { error: state.error }),
  };
}
