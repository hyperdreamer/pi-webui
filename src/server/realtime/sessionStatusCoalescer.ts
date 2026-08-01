import type { SessionActivity, SessionStatus } from "../../shared/apiTypes.js";

/**
 * Minimum gap between forwarded status/activity snapshots for one key. The
 * session service produces fresh snapshots for provider events; keeping the
 * newest snapshot and sending it at the trailing edge bounds fan-out without
 * losing the latest state.
 */
export const STATUS_COALESCE_INTERVAL_MS = 100;

export interface SessionStatusCoalescerOptions {
  intervalMs?: number;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

type TimerHandle = ReturnType<typeof setTimeout>;

interface TimerState {
  handle: TimerHandle;
  token: object;
}

interface PendingEvent<T> {
  event: T;
  send: (event: T) => void;
}

interface KeyState<T> {
  lastSentAt: number;
  lastSent: T;
  pending: PendingEvent<T> | undefined;
  timer: TimerState | undefined;
}

/**
 * Schedules the latest event for each key while allowing urgent transitions to
 * pass through immediately. The scheduler is deliberately transport-agnostic;
 * callers own the actual send side effect.
 */
export class SessionStatusCoalescer<T> {
  private readonly states = new Map<string, KeyState<T>>();
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;

  constructor(
    private readonly isImmediate: (previous: T, next: T) => boolean,
    options: SessionStatusCoalescerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? STATUS_COALESCE_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimeout ?? ((handle) => {
      clearTimeout(handle);
    });
  }

  publish(key: string, event: T, send: (event: T) => void): void {
    const timestamp = this.now();
    let state = this.states.get(key);
    if (state === undefined) {
      state = {
        lastSentAt: timestamp,
        lastSent: event,
        pending: undefined,
        timer: undefined,
      };
      this.states.set(key, state);
      send(event);
      return;
    }

    if (this.isImmediate(state.lastSent, event)) {
      this.cancelTimer(state);
      state.pending = undefined;
      state.lastSent = event;
      state.lastSentAt = timestamp;
      send(event);
      return;
    }

    const elapsed = timestamp - state.lastSentAt;
    if (elapsed >= this.intervalMs) {
      this.cancelTimer(state);
      state.pending = undefined;
      state.lastSent = event;
      state.lastSentAt = timestamp;
      send(event);
      return;
    }

    state.pending = { event, send };
    this.scheduleTimer(key, state, Math.max(0, this.intervalMs - elapsed));
  }

  clear(key: string): void {
    const state = this.states.get(key);
    if (state === undefined) return;
    this.cancelTimer(state);
    this.states.delete(key);
  }

  clearAll(): void {
    for (const state of this.states.values()) this.cancelTimer(state);
    this.states.clear();
  }

  private scheduleTimer(key: string, state: KeyState<T>, delayMs: number): void {
    if (state.timer !== undefined) return;

    const token = {};
    const handle = this.setTimer(() => {
      const current = this.states.get(key);
      if (current !== state || current.timer?.token !== token) return;
      current.timer = undefined;
      const pending = current.pending;
      if (pending === undefined) return;

      const timestamp = this.now();
      const remaining = this.intervalMs - (timestamp - current.lastSentAt);
      if (remaining > 0) {
        this.scheduleTimer(key, current, remaining);
        return;
      }

      current.pending = undefined;
      current.lastSent = pending.event;
      current.lastSentAt = timestamp;
      pending.send(pending.event);
    }, delayMs);
    state.timer = { handle, token };
  }

  private cancelTimer(state: KeyState<T>): void {
    if (state.timer === undefined) return;
    this.clearTimer(state.timer.handle);
    state.timer = undefined;
  }
}

export function isImmediateStatusUpdate(previous: SessionStatus, next: SessionStatus): boolean {
  return previous.isStreaming !== next.isStreaming
    || previous.isCompacting !== next.isCompacting
    || previous.isBashRunning !== next.isBashRunning
    || previous.pendingMessageCount !== next.pendingMessageCount
    || !structurallyEqual(previous.queuedMessages, next.queuedMessages)
    || !structurallyEqual(previous.model, next.model)
    || previous.thinkingLevel !== next.thinkingLevel
    || previous.persisted !== next.persisted
    || !structurallyEqual(previous.warnings, next.warnings);
}

export function isImmediateActivityUpdate(previous: SessionActivity, next: SessionActivity): boolean {
  return previous.phase !== next.phase || previous.label !== next.label || previous.detail !== next.detail;
}

export function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => structurallyEqual(value, right[index]));
  }

  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && structurallyEqual(left[key], right[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
