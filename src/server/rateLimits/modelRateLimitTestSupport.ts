import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { ModelRateLimitValues } from "../../shared/modelRateLimits.js";
import type { ModelRateLimitIdentity, ModelRateLimitSnapshot } from "./modelRateLimitConfig.js";
import type { ModelRateLimitClock, ModelRateLimitTimerHandle } from "./modelRateLimitOwner.js";

export interface FakeModelRateLimitClock extends ModelRateLimitClock {
  advance(ms: number): void;
  pendingTimerCount(): number;
}

/** Deterministic monotonic clock; never touches real timers. */
export function createFakeModelRateLimitClock(start = 0): FakeModelRateLimitClock {
  let current = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();

  const earliest = (): { id: number; at: number; callback: () => void } | undefined => {
    let found: { id: number; at: number; callback: () => void } | undefined;
    for (const [id, timer] of timers) {
      if (found === undefined || timer.at < found.at || (timer.at === found.at && id < found.id)) {
        found = { id, at: timer.at, callback: timer.callback };
      }
    }
    return found;
  };

  return {
    now: () => current,
    schedule: (delayMs: number, callback: () => void): ModelRateLimitTimerHandle => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: current + Math.max(0, delayMs), callback });
      return { cancel: () => { timers.delete(id); } };
    },
    advance: (ms: number): void => {
      const target = current + Math.max(0, ms);
      for (;;) {
        const next = earliest();
        if (next === undefined || next.at > target) break;
        timers.delete(next.id);
        current = next.at;
        next.callback();
      }
      current = target;
    },
    pendingTimerCount: () => timers.size,
  };
}

export function fixtureTerminalMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "demo-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

export interface ControllableStream {
  stream: AssistantMessageEventStream;
  push(event: AssistantMessageEvent): void;
  end(message: AssistantMessage): void;
  error(message: AssistantMessage): void;
}

/** A delegate stream a test drives event by event. */
export function createControllableStream(): ControllableStream {
  const stream = createAssistantMessageEventStream();
  return {
    stream,
    push: (event) => { stream.push(event); },
    end: (message) => {
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    },
    error: (message) => {
      stream.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
      stream.end(message);
    },
  };
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

export function fixtureLimits(tpm?: number, prm?: number): ModelRateLimitValues {
  return { ...(tpm === undefined ? {} : { tpm }), ...(prm === undefined ? {} : { prm }) };
}

export function fixtureIdentity(provider: string, modelId: string): ModelRateLimitIdentity {
  return { provider, modelId };
}

export function fixtureSnapshot(entries: Record<string, Record<string, ModelRateLimitValues>>): ModelRateLimitSnapshot {
  const limits = new Map<string, Map<string, ModelRateLimitValues>>();
  for (const [provider, models] of Object.entries(entries)) {
    const providerLimits = new Map<string, ModelRateLimitValues>();
    for (const [modelId, values] of Object.entries(models)) providerLimits.set(modelId, values);
    limits.set(provider, providerLimits);
  }
  return { limits };
}
