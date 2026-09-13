import {
  MODEL_RATE_LIMIT_WINDOW_MS,
  sumModelTerminalTokens,
  type ModelRateLimitValues,
} from "../../shared/modelRateLimits.js";
import {
  modelRateLimitValuesFor,
  type ModelRateLimitIdentity,
  type ModelRateLimitSnapshot,
} from "./modelRateLimitConfig.js";

export interface ModelRateLimitTimerHandle {
  cancel(): void;
}

export interface ModelRateLimitClock {
  /** Monotonic milliseconds. Never wall-clock time. */
  now(): number;
  schedule(delayMs: number, callback: () => void): ModelRateLimitTimerHandle;
}

export const modelRateLimitDefaultClock: ModelRateLimitClock = {
  now: () => performance.now(),
  schedule: (delayMs, callback) => {
    const handle = setTimeout(callback, Math.max(0, delayMs));
    return { cancel: () => { clearTimeout(handle); } };
  },
};

export interface ModelRateLimitOwnerLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

export const MODEL_RATE_LIMITS_BLOCKED_CODE = "MODEL_RATE_LIMITS_BLOCKED";
export const MODEL_RATE_LIMITS_BLOCKED_MESSAGE =
  "Model requests are blocked because the model configuration is invalid.";

export interface ModelTerminalUsage {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  /** Accepted but never charged; `totalTokens` is not a terminal counter. */
  totalTokens?: unknown;
}

export type ModelAdmission =
  | { readonly status: "granted" }
  | { readonly status: "aborted" }
  | {
      readonly status: "blocked";
      readonly code: typeof MODEL_RATE_LIMITS_BLOCKED_CODE;
      readonly error: string;
    };

export interface ModelRateLimitOwnerStatus {
  revision: number;
  admission: "ready" | "blocked";
  source: "none" | "missing-file" | "accepted-document" | "last-known-good";
  error?: string;
}

export interface ModelRateLimitOwner {
  acquire(identity: ModelRateLimitIdentity, signal?: AbortSignal): Promise<ModelAdmission>;
  completeCall(identity: ModelRateLimitIdentity, usage: ModelTerminalUsage | undefined): void;
  applySnapshot(snapshot: ModelRateLimitSnapshot, source: "missing-file" | "accepted-document"): number;
  reportLoadFailure(error: string): void;
  readStatus(): ModelRateLimitOwnerStatus;
  dispose(): void;
  /** Diagnostics and tests only. */
  pendingWaiterCount(identity?: ModelRateLimitIdentity): number;
  activeTimerCount(): number;
}

/** Diagnostics and tests only; not part of the limiter policy contract. */
export interface ModelRateLimitDiagnostics {
  activeIdentityCount(): number;
  inFlightCount(identity?: ModelRateLimitIdentity): number;
}

export interface ModelRateLimitOwnerOptions {
  clock?: ModelRateLimitClock;
  logger?: ModelRateLimitOwnerLogger;
}

interface ModelCallWaiter {
  resolve(result: ModelAdmission): void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  settled: boolean;
}

interface ModelCallBudgetState {
  limits: ModelRateLimitValues;
  requestTimestamps: number[];
  tokenUsages: { at: number; tokens: number }[];
  queue: ModelCallWaiter[];
  timer: ModelRateLimitTimerHandle | undefined;
  inFlight: number;
  queuedLogged: boolean;
}

export function createModelRateLimitOwner(
  options: ModelRateLimitOwnerOptions = {},
): ModelRateLimitOwner & ModelRateLimitDiagnostics {
  return new ModelRateLimitOwnerImpl(options.clock ?? modelRateLimitDefaultClock, options.logger);
}

class ModelRateLimitOwnerImpl implements ModelRateLimitOwner, ModelRateLimitDiagnostics {
  private readonly states = new Map<string, Map<string, ModelCallBudgetState>>();
  private revision = 0;
  private admission: "ready" | "blocked" = "ready";
  private source: ModelRateLimitOwnerStatus["source"] = "none";
  private error: string | undefined;
  private disposed = false;

  constructor(
    private readonly clock: ModelRateLimitClock,
    private readonly logger: ModelRateLimitOwnerLogger | undefined,
  ) {}

  async acquire(identity: ModelRateLimitIdentity, signal?: AbortSignal): Promise<ModelAdmission> {
    if (this.disposed || signal?.aborted === true) return { status: "aborted" };
    if (this.admission === "blocked") {
      const error = this.error ?? MODEL_RATE_LIMITS_BLOCKED_MESSAGE;
      this.logger?.warn(
        { provider: identity.provider, modelId: identity.modelId, error },
        "model request blocked by invalid models configuration",
      );
      return { status: "blocked", code: MODEL_RATE_LIMITS_BLOCKED_CODE, error };
    }

    const state = this.stateFor(identity);
    const now = this.clock.now();
    this.prune(state, now);
    if (state.queue.length === 0 && this.canAdmit(state)) {
      state.requestTimestamps.push(now);
      state.inFlight += 1;
      return { status: "granted" };
    }

    let settle: ((result: ModelAdmission) => void) | undefined;
    const waiter: ModelCallWaiter = {
      resolve: (result) => { settle?.(result); },
      signal,
      onAbort: undefined,
      settled: false,
    };
    const result = new Promise<ModelAdmission>((resolve) => { settle = resolve; });
    state.queue.push(waiter);
    if (signal !== undefined) {
      waiter.onAbort = () => { this.abortWaiter(state, waiter); };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    if (!state.queuedLogged) {
      state.queuedLogged = true;
      this.logger?.warn(
        { provider: identity.provider, modelId: identity.modelId, dimension: this.exhaustedDimension(state) },
        "model request queued for rate limit",
      );
    }
    this.drain(state);
    this.schedule(state);
    return await result;
  }

  completeCall(identity: ModelRateLimitIdentity, usage: ModelTerminalUsage | undefined): void {
    if (this.disposed) return;
    const state = this.find(identity);
    if (state === undefined) return;
    if (state.inFlight > 0) state.inFlight -= 1;
    const tokens = sumModelTerminalTokens(usage);
    const now = this.clock.now();
    if (tokens > 0) state.tokenUsages.push({ at: now, tokens });
    this.prune(state, now);
    if (state.queue.length > 0) {
      this.drain(state);
      this.schedule(state);
    }
    this.pruneIdleState(identity, state);
  }

  applySnapshot(snapshot: ModelRateLimitSnapshot, source: "missing-file" | "accepted-document"): number {
    if (this.disposed) return this.revision;
    for (const [provider, models] of snapshot.limits) {
      for (const [modelId, limits] of models) {
        this.stateFor({ provider, modelId }).limits = { ...limits };
      }
    }
    for (const [provider, providerStates] of this.states) {
      for (const [modelId, state] of providerStates) {
        if (modelRateLimitValuesFor(snapshot, { provider, modelId }) === undefined) state.limits = {};
      }
    }
    for (const providerStates of this.states.values()) {
      for (const state of providerStates.values()) {
        if (state.queue.length === 0) continue;
        this.drain(state);
        this.schedule(state);
      }
    }
    this.revision += 1;
    this.admission = "ready";
    this.source = source;
    this.error = undefined;
    this.pruneIdleStates();
    return this.revision;
  }

  reportLoadFailure(error: string): void {
    this.error = error;
    if (this.revision > 0) {
      this.source = "last-known-good";
      return;
    }
    this.admission = "blocked";
  }

  readStatus(): ModelRateLimitOwnerStatus {
    return {
      revision: this.revision,
      admission: this.admission,
      source: this.source,
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const providerStates of this.states.values()) {
      for (const state of providerStates.values()) {
        this.cancelTimer(state);
        for (const waiter of state.queue) {
          this.removeAbortListener(waiter);
          this.settleWaiter(waiter, { status: "aborted" });
        }
        state.queue.length = 0;
        state.requestTimestamps.length = 0;
        state.tokenUsages.length = 0;
        state.inFlight = 0;
      }
    }
    this.states.clear();
  }

  pendingWaiterCount(identity?: ModelRateLimitIdentity): number {
    if (identity !== undefined) return this.find(identity)?.queue.length ?? 0;
    let count = 0;
    for (const providerStates of this.states.values()) {
      for (const state of providerStates.values()) count += state.queue.length;
    }
    return count;
  }

  activeTimerCount(): number {
    let count = 0;
    for (const providerStates of this.states.values()) {
      for (const state of providerStates.values()) {
        if (state.timer !== undefined) count += 1;
      }
    }
    return count;
  }

  activeIdentityCount(): number {
    let count = 0;
    for (const providerStates of this.states.values()) count += providerStates.size;
    return count;
  }

  inFlightCount(identity?: ModelRateLimitIdentity): number {
    if (identity !== undefined) return this.find(identity)?.inFlight ?? 0;
    let count = 0;
    for (const providerStates of this.states.values()) {
      for (const state of providerStates.values()) count += state.inFlight;
    }
    return count;
  }

  private stateFor(identity: ModelRateLimitIdentity): ModelCallBudgetState {
    let providerStates = this.states.get(identity.provider);
    if (providerStates === undefined) {
      providerStates = new Map();
      this.states.set(identity.provider, providerStates);
    }
    let state = providerStates.get(identity.modelId);
    if (state === undefined) {
      state = {
        limits: {},
        requestTimestamps: [],
        tokenUsages: [],
        queue: [],
        timer: undefined,
        inFlight: 0,
        queuedLogged: false,
      };
      providerStates.set(identity.modelId, state);
    }
    return state;
  }

  private find(identity: ModelRateLimitIdentity): ModelCallBudgetState | undefined {
    return this.states.get(identity.provider)?.get(identity.modelId);
  }

  private prune(state: ModelCallBudgetState, now: number): void {
    const cutoff = now - MODEL_RATE_LIMIT_WINDOW_MS;
    while (state.requestTimestamps.length > 0 && (state.requestTimestamps[0] ?? Number.POSITIVE_INFINITY) <= cutoff) {
      state.requestTimestamps.shift();
    }
    while (state.tokenUsages.length > 0 && (state.tokenUsages[0]?.at ?? Number.POSITIVE_INFINITY) <= cutoff) {
      state.tokenUsages.shift();
    }
  }

  private retainedTokenSum(state: ModelCallBudgetState): number {
    let sum = 0;
    for (const usage of state.tokenUsages) sum += usage.tokens;
    return sum;
  }

  private canAdmit(state: ModelCallBudgetState): boolean {
    if (state.limits.prm !== undefined && state.requestTimestamps.length >= state.limits.prm) return false;
    return state.limits.tpm === undefined || this.retainedTokenSum(state) < state.limits.tpm;
  }

  private exhaustedDimension(state: ModelCallBudgetState): "tpm" | "prm" | "tpm+prm" | undefined {
    const prmExhausted = state.limits.prm !== undefined && state.requestTimestamps.length >= state.limits.prm;
    const tpmExhausted = state.limits.tpm !== undefined && this.retainedTokenSum(state) >= state.limits.tpm;
    if (prmExhausted && tpmExhausted) return "tpm+prm";
    if (prmExhausted) return "prm";
    if (tpmExhausted) return "tpm";
    return undefined;
  }

  private drain(state: ModelCallBudgetState): void {
    const now = this.clock.now();
    this.prune(state, now);
    while (state.queue.length > 0) {
      const head = state.queue[0];
      if (head === undefined) break;
      if (head.signal?.aborted === true) {
        state.queue.shift();
        this.removeAbortListener(head);
        this.settleWaiter(head, { status: "aborted" });
        continue;
      }
      if (!this.canAdmit(state)) break;
      state.queue.shift();
      this.removeAbortListener(head);
      state.requestTimestamps.push(now);
      state.inFlight += 1;
      this.settleWaiter(head, { status: "granted" });
    }
    if (state.queue.length === 0) {
      this.cancelTimer(state);
      state.queuedLogged = false;
    } else {
      this.schedule(state);
    }
  }

  private schedule(state: ModelCallBudgetState): void {
    if (state.queue.length === 0 || (state.requestTimestamps.length === 0 && state.tokenUsages.length === 0)) {
      this.cancelTimer(state);
      return;
    }
    const now = this.clock.now();
    const requestHead = state.requestTimestamps[0];
    const tokenHead = state.tokenUsages[0];
    const earliest = Math.min(requestHead ?? Number.POSITIVE_INFINITY, tokenHead?.at ?? Number.POSITIVE_INFINITY);
    if (!Number.isFinite(earliest)) {
      this.cancelTimer(state);
      return;
    }
    const delay = Math.max(0, earliest + MODEL_RATE_LIMIT_WINDOW_MS - now);
    this.cancelTimer(state);
    state.timer = this.clock.schedule(delay, () => {
      state.timer = undefined;
      this.prune(state, this.clock.now());
      this.drain(state);
      this.schedule(state);
    });
  }

  private abortWaiter(state: ModelCallBudgetState, waiter: ModelCallWaiter): void {
    if (waiter.settled) return;
    const index = state.queue.indexOf(waiter);
    if (index === -1) return;
    const wasHead = index === 0;
    state.queue.splice(index, 1);
    this.removeAbortListener(waiter);
    this.settleWaiter(waiter, { status: "aborted" });
    if (wasHead) this.drain(state);
    this.schedule(state);
    if (state.queue.length === 0) state.queuedLogged = false;
  }

  private settleWaiter(waiter: ModelCallWaiter, result: ModelAdmission): void {
    if (waiter.settled) return;
    waiter.settled = true;
    waiter.resolve(result);
  }

  private removeAbortListener(waiter: ModelCallWaiter): void {
    if (waiter.signal === undefined || waiter.onAbort === undefined) return;
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.onAbort = undefined;
  }

  private cancelTimer(state: ModelCallBudgetState): void {
    state.timer?.cancel();
    state.timer = undefined;
  }

  private pruneIdleState(identity: ModelRateLimitIdentity, state: ModelCallBudgetState): void {
    if (
      state.queue.length > 0 ||
      state.inFlight > 0 ||
      state.requestTimestamps.length > 0 ||
      state.tokenUsages.length > 0 ||
      hasEnabledLimit(state.limits)
    ) return;
    const providerStates = this.states.get(identity.provider);
    providerStates?.delete(identity.modelId);
    if (providerStates?.size === 0) this.states.delete(identity.provider);
  }

  private pruneIdleStates(): void {
    for (const [provider, providerStates] of [...this.states]) {
      for (const [modelId, state] of [...providerStates]) {
        this.pruneIdleState({ provider, modelId }, state);
      }
    }
  }
}

function hasEnabledLimit(limits: ModelRateLimitValues): boolean {
  return limits.tpm !== undefined || limits.prm !== undefined;
}
