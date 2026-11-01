import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLoadCancellation, LoadCancelledError } from "./cancellableLoadScope";
import { runBackgroundRead, type ReadIntent } from "./backgroundRead";

const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
const nativeAny = AbortSignal.any.bind(AbortSignal);
const timeoutDelays: number[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  timeoutDelays.length = 0;
  installNativeTimeout();
});

afterEach(() => {
  vi.useRealTimers();
  restoreStatic("timeout", nativeTimeout);
  restoreStatic("any", nativeAny);
  vi.restoreAllMocks();
});

describe("runBackgroundRead", () => {
  it("normalizes a native timeout source to LoadCancelledError", async () => {
    const read = deferredRead();
    const pending = rejection(runBackgroundRead("remote-lab", read.fn));

    expect(timeoutDelays).toEqual([20_000]);
    await vi.advanceTimersByTimeAsync(20_000);

    const failure = await pending;
    expect(isLoadCancellation(failure)).toBe(true);
    expect(failure).toMatchObject({ name: "LoadCancelledError", message: "Background read exceeded 20000 milliseconds" });
    expect(failure).not.toMatchObject({ name: "TimeoutError" });
  });

  it("bows out with the same marker when AbortSignal timeout is unavailable", async () => {
    withoutNativeTimeout();
    const read = deferredRead();
    const pending = rejection(runBackgroundRead("remote-lab", read.fn));

    await vi.advanceTimersByTimeAsync(19_999);
    expect(read.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const failure = await pending;
    expect(isLoadCancellation(failure)).toBe(true);
    expect(failure).toMatchObject({ name: "LoadCancelledError", message: "Background read exceeded 20000 milliseconds" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the fallback deadline when the read settles first", async () => {
    withoutNativeTimeout();
    const read = deferredRead();
    const pending = runBackgroundRead("remote-lab", read.fn);

    await vi.advanceTimersByTimeAsync(5_000);
    read.resolve("done");

    await expect(pending).resolves.toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])("combines supersession with AbortSignal any available: %s", async (useAny) => {
    if (!useAny) withoutNativeAny();
    const parent = new AbortController();
    const listeners = trackAbortListeners(parent.signal);
    const read = deferredRead();
    const pending = rejection(runBackgroundRead("remote-lab", read.fn, parent.signal));

    parent.abort(new LoadCancelledError("superseded"));

    const failure = await pending;
    expect(failure).toMatchObject({ name: "LoadCancelledError", message: "superseded" });
    expect(read.listenerCount).toBe(0);
    expect(listeners.activeCount()).toBe(0);
  });

  it("does not start a read for a pre-aborted parent", async () => {
    const pre = new AbortController();
    pre.abort(new LoadCancelledError("pre-aborted"));
    const read = vi.fn();

    await expect(runBackgroundRead("remote-lab", read, pre.signal)).rejects.toThrow("pre-aborted");
    expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves local and foreground reads untimed", async () => {
    const local = deferredRead();
    const localPending = runBackgroundRead("local", local.fn);
    await vi.advanceTimersByTimeAsync(20_001);
    local.resolve("local");
    await expect(localPending).resolves.toBe("local");
    expect(local.signal).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);

    const foreground = deferredRead();
    const foregroundIntent: ReadIntent = "foreground";
    const foregroundPending = runBackgroundRead("remote-lab", foreground.fn, undefined, foregroundIntent);
    await vi.advanceTimersByTimeAsync(20_001);
    foreground.resolve("foreground");
    await expect(foregroundPending).resolves.toBe("foreground");
    expect(foreground.signal).toBeUndefined();
    expect(foreground.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not disguise a genuine read failure as cancellation", async () => {
    withoutNativeAny();
    const parent = new AbortController();
    const listeners = trackAbortListeners(parent.signal);
    const error = new Error("real read failure");

    await expect(runBackgroundRead("remote-lab", () => Promise.reject(error), parent.signal)).rejects.toBe(error);
    expect(listeners.activeCount()).toBe(0);
  });
});

describe("LoadCancelledError message", () => {
  it("keeps the existing default when no message is given", () => {
    expect(new LoadCancelledError().message).toBe("Load cancelled because the selection changed");
  });
});

interface DeferredRead {
  fn: (signal?: AbortSignal) => Promise<string>;
  readonly signal: AbortSignal | undefined;
  readonly listenerCount: number;
  resolve(value: string): void;
}

function deferredRead(): DeferredRead {
  let settle!: (value: string) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  let captured: AbortSignal | undefined;
  let listenerCount = 0;
  return {
    fn: (signal?: AbortSignal) => {
      captured = signal;
      if (signal !== undefined) {
        listenerCount += 1;
        signal.addEventListener("abort", () => {
          listenerCount -= 1;
          fail(signal.reason);
        }, { once: true });
      }
      return promise;
    },
    get signal() {
      return captured;
    },
    get listenerCount() {
      return listenerCount;
    },
    resolve: (value: string) => {
      settle(value);
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("Expected the promise to reject");
}

function installNativeTimeout(): void {
  restoreStatic("timeout", (delayMs: number): AbortSignal => {
    timeoutDelays.push(delayMs);
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
    }, delayMs);
    return controller.signal;
  });
}

function withoutNativeTimeout(): void {
  restoreStatic("timeout", undefined);
}

function withoutNativeAny(): void {
  restoreStatic("any", undefined);
}

function restoreStatic(name: "timeout" | "any", value: unknown): void {
  Object.defineProperty(AbortSignal, name, { configurable: true, writable: true, value });
}

function trackAbortListeners(signal: AbortSignal): { activeCount(): number } {
  const proxies = new Map<EventListenerOrEventListenerObject, EventListener>();
  const active = new Set<EventListener>();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  Object.defineProperty(signal, "addEventListener", {
    configurable: true,
    writable: true,
    value: (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void => {
      if (type !== "abort" || listener === null) {
        if (listener !== null) add(type, listener, options);
        return;
      }
      const proxy: EventListener = (event: Event) => {
        active.delete(proxy);
        proxies.delete(listener);
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      };
      proxies.set(listener, proxy);
      active.add(proxy);
      add(type, proxy, options);
    },
  });
  Object.defineProperty(signal, "removeEventListener", {
    configurable: true,
    writable: true,
    value: (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void => {
      const proxy = listener === null ? undefined : proxies.get(listener);
      if (type !== "abort" || listener === null || proxy === undefined) {
        if (listener !== null) remove(type, listener, options);
        return;
      }
      active.delete(proxy);
      proxies.delete(listener);
      remove(type, proxy, options);
    },
  });
  return { activeCount: () => active.size };
}
