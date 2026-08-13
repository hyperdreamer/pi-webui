import { describe, expect, it } from "vitest";
import type { HostSpeechStatus } from "../../shared/apiTypes.js";
import {
  HostSpeechUnavailableError,
  type HostSpeechProvider,
  type HostSpeechProviderSpeakRequest,
  type HostSpeechProviderTerminalOutcome,
  type HostSpeechProviderUtterance,
} from "./hostSpeech.js";
import { HostSpeechService } from "./hostSpeechService.js";

describe("HostSpeechService", () => {
  it("passes status through and truncates text before enqueueing", async () => {
    const provider = new FakeHostSpeechProvider();
    const service = new HostSpeechService(provider);

    await expect(service.status()).resolves.toEqual(provider.statusValue);

    const spoken = service.speak({ runId: "run-1", text: `hello\r\nworld\u0000${"x".repeat(4_000)}`, voice: "Ada", rate: 25 });
    await provider.waitForEnqueueCount(1);

    expect(provider.enqueued).toEqual([{ text: `hello\nworld${"x".repeat(3_989)}`, voice: "Ada", rate: 25 }]);
    provider.end(1);
    await expect(spoken).resolves.toEqual({ runId: "run-1", outcome: "ended" });
  });

  it("resolves a normal provider terminal event for its own run", async () => {
    const provider = new FakeHostSpeechProvider();
    const service = new HostSpeechService(provider);

    const spoken = service.speak({ runId: "run-1", text: "hello", rate: 0 });
    await provider.waitForEnqueueCount(1);
    provider.end(1);

    await expect(spoken).resolves.toEqual({ runId: "run-1", outcome: "ended" });
  });

  it("cancels the prior provider work before enqueueing a replacement without waiting for its terminal", async () => {
    const provider = new FakeHostSpeechProvider();
    const service = new HostSpeechService(provider);

    const first = service.speak({ runId: "run-1", text: "first", rate: 0 });
    await provider.waitForEnqueueCount(1);

    const second = service.speak({ runId: "run-2", text: "second", rate: 0 });
    await provider.waitForCancelCount(1);
    await provider.waitForEnqueueCount(2);

    provider.end(2);
    await expect(second).resolves.toEqual({ runId: "run-2", outcome: "ended" });
    provider.cancel(1);
    await expect(first).resolves.toEqual({ runId: "run-1", outcome: "canceled" });
  });

  it("returns a cancellation for a stop that arrives before its speak and leaves an unrelated active run alone", async () => {
    const provider = new FakeHostSpeechProvider();
    const service = new HostSpeechService(provider);

    await expect(service.stop("stopped-before-speak")).resolves.toBeUndefined();
    await expect(service.speak({ runId: "stopped-before-speak", text: "ignored", rate: 0 }))
      .resolves.toEqual({ runId: "stopped-before-speak", outcome: "canceled" });
    expect(provider.enqueued).toHaveLength(0);

    const active = service.speak({ runId: "active", text: "active", rate: 0 });
    await provider.waitForEnqueueCount(1);
    await expect(service.stop("stale-stop")).resolves.toBeUndefined();
    expect(provider.cancelCalls).toBe(0);

    provider.end(1);
    await expect(active).resolves.toEqual({ runId: "active", outcome: "ended" });
  });

  it("lets a matching stop cancel an enqueue that is still awaiting acceptance", async () => {
    const provider = new FakeHostSpeechProvider();
    provider.deferNextEnqueue();
    const service = new HostSpeechService(provider);

    const spoken = service.speak({ runId: "pending", text: "pending", rate: 0 });
    await provider.waitForEnqueueCount(1);
    const stopped = service.stop("pending");
    await flushMicrotasks();

    expect(provider.cancelCalls).toBe(1);
    await expect(stopped).resolves.toEqual({ runId: "pending", outcome: "canceled" });
    provider.acceptNextEnqueue();
    provider.cancel(1);
    await expect(spoken).resolves.toEqual({ runId: "pending", outcome: "canceled" });
  });

  it("retains canceled run IDs in FIFO order up to its configured bound", async () => {
    const provider = new FakeHostSpeechProvider();
    const service = new HostSpeechService(provider, { canceledRunLimit: 2 });

    await service.stop("oldest");
    await service.stop("middle");
    await service.stop("newest");

    const oldest = service.speak({ runId: "oldest", text: "oldest", rate: 0 });
    await provider.waitForEnqueueCount(1);
    provider.end(1);
    await expect(oldest).resolves.toEqual({ runId: "oldest", outcome: "ended" });
    await expect(service.speak({ runId: "middle", text: "middle", rate: 0 }))
      .resolves.toEqual({ runId: "middle", outcome: "canceled" });
    await expect(service.speak({ runId: "newest", text: "newest", rate: 0 }))
      .resolves.toEqual({ runId: "newest", outcome: "canceled" });
    await expect(service.speak({ runId: "middle", text: "middle", rate: 0 }))
      .resolves.toEqual({ runId: "middle", outcome: "canceled" });
  });

  it("uses a default tombstone bound of 64 runs", async () => {
    const provider = new FakeHostSpeechProvider();
    const service = new HostSpeechService(provider);

    for (let index = 1; index <= 65; index += 1) await service.stop(`run-${String(index)}`);

    const evicted = service.speak({ runId: "run-1", text: "evicted", rate: 0 });
    await provider.waitForEnqueueCount(1);
    provider.end(1);
    await expect(evicted).resolves.toEqual({ runId: "run-1", outcome: "ended" });
    await expect(service.speak({ runId: "run-2", text: "retained", rate: 0 }))
      .resolves.toEqual({ runId: "run-2", outcome: "canceled" });
  });

  it("does not let a late canceled terminal clear a newer active run", async () => {
    const provider = new FakeHostSpeechProvider([4, 11, 12]);
    const service = new HostSpeechService(provider);

    const first = service.speak({ runId: "first", text: "first", rate: 0 });
    await provider.waitForEnqueueCount(1);
    const second = service.speak({ runId: "second", text: "second", rate: 0 });
    await provider.waitForEnqueueCount(2);

    provider.cancel(4);
    await expect(first).resolves.toEqual({ runId: "first", outcome: "canceled" });

    const third = service.speak({ runId: "third", text: "third", rate: 0 });
    await provider.waitForEnqueueCount(3);
    expect(provider.cancelCalls).toBe(2);

    provider.cancel(11);
    provider.end(12);
    await expect(second).resolves.toEqual({ runId: "second", outcome: "canceled" });
    await expect(third).resolves.toEqual({ runId: "third", outcome: "ended" });
  });

  it("does not let a stale stop cancel a replacement", async () => {
    const provider = new FakeHostSpeechProvider([1, 2]);
    const service = new HostSpeechService(provider);

    const first = service.speak({ runId: "first", text: "first", rate: 0 });
    await provider.waitForEnqueueCount(1);
    const second = service.speak({ runId: "second", text: "second", rate: 0 });
    await provider.waitForEnqueueCount(2);

    await expect(service.stop("first")).resolves.toBeUndefined();
    expect(provider.cancelCalls).toBe(1);
    provider.cancel(1);
    await expect(first).resolves.toEqual({ runId: "first", outcome: "canceled" });

    let secondSettled = false;
    void second.then(() => { secondSettled = true; });
    await expect(service.stop("second")).resolves.toEqual({ runId: "second", outcome: "canceled" });
    expect(provider.cancelCalls).toBe(2);
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    provider.cancel(2);
    await expect(second).resolves.toEqual({ runId: "second", outcome: "canceled" });
  });

  it("rejects only the provider run that fails and remains usable afterward", async () => {
    const provider = new FakeHostSpeechProvider();
    const service = new HostSpeechService(provider);

    provider.rejectNextEnqueue(new HostSpeechUnavailableError("unavailable"));
    await expect(service.speak({ runId: "failed-enqueue", text: "hello", rate: 0 })).rejects.toThrow("unavailable");

    const failedTerminal = service.speak({ runId: "failed-terminal", text: "hello", rate: 0 });
    await provider.waitForEnqueueCount(1);
    provider.fail(1, new HostSpeechUnavailableError("dropped"));
    await expect(failedTerminal).rejects.toThrow("dropped");

    const next = service.speak({ runId: "next", text: "next", rate: 0 });
    await provider.waitForEnqueueCount(2);
    provider.end(2);
    await expect(next).resolves.toEqual({ runId: "next", outcome: "ended" });
  });

  it("closes idempotently, settles active work, and makes later status unavailable", async () => {
    const provider = new FakeHostSpeechProvider();
    const service = new HostSpeechService(provider);

    const active = service.speak({ runId: "active", text: "hello", rate: 0 });
    await provider.waitForEnqueueCount(1);

    await Promise.all([service.close(), service.close()]);
    await expect(active).resolves.toEqual({ runId: "active", outcome: "canceled" });
    expect(provider.cancelCalls).toBe(1);
    expect(provider.closeCalls).toBe(1);
    await expect(service.status()).resolves.toEqual({ available: false, reason: "Host speech is closed.", voices: [] });
    await expect(service.speak({ runId: "later", text: "later", rate: 0 })).rejects.toThrow(HostSpeechUnavailableError);
  });

  it("closes the provider after a cancellation acknowledgment failure", async () => {
    const provider = new FakeHostSpeechProvider();
    const service = new HostSpeechService(provider);
    const active = service.speak({ runId: "active", text: "hello", rate: 0 });
    await provider.waitForEnqueueCount(1);
    provider.rejectNextCancel(new HostSpeechUnavailableError("cancel failed"));

    await expect(service.close()).rejects.toThrow("cancel failed");
    await expect(active).resolves.toEqual({ runId: "active", outcome: "canceled" });
    expect(provider.closeCalls).toBe(1);
  });

  it("settles active work and rejects later speaks before a delayed close cancellation acknowledgment", async () => {
    const provider = new FakeHostSpeechProvider();
    const service = new HostSpeechService(provider);
    const active = service.speak({ runId: "active", text: "hello", rate: 0 });
    await provider.waitForEnqueueCount(1);
    provider.deferNextCancel();

    const closing = service.close();
    await flushMicrotasks();
    expect(provider.cancelCalls).toBe(1);

    let activeResult: { runId: string; outcome: "ended" | "canceled" } | undefined;
    void active.then((result) => { activeResult = result; });
    await flushMicrotasks();
    expect(activeResult).toEqual({ runId: "active", outcome: "canceled" });
    await expect(service.speak({ runId: "later", text: "later", rate: 0 })).rejects.toThrow(HostSpeechUnavailableError);

    provider.resolveNextCancel();
    await expect(closing).resolves.toBeUndefined();
  });
});

class FakeHostSpeechProvider implements HostSpeechProvider {
  readonly enqueued: HostSpeechProviderSpeakRequest[] = [];
  readonly statusValue: HostSpeechStatus = {
    available: true,
    voices: [{ name: "Ada", language: "en-US" }],
  };
  cancelCalls = 0;
  closeCalls = 0;
  private readonly utterances = new Map<number, DeferredUtterance>();
  private readonly enqueueWaiters = new Map<number, (() => void)[]>();
  private readonly cancelWaiters = new Map<number, (() => void)[]>();
  private readonly pendingEnqueues: { utterance: HostSpeechProviderUtterance; resolve: (utterance: HostSpeechProviderUtterance) => void }[] = [];
  private readonly pendingCancels: (() => void)[] = [];
  private readonly messageIds: number[];
  private nextMessageId = 1;
  private nextEnqueueError: Error | undefined;
  private nextCancelError: Error | undefined;
  private deferEnqueueResult = false;
  private deferCancelResult = false;

  constructor(messageIds: number[] = []) {
    this.messageIds = [...messageIds];
  }

  status(): Promise<HostSpeechStatus> {
    return Promise.resolve(this.statusValue);
  }

  enqueue(input: HostSpeechProviderSpeakRequest): Promise<HostSpeechProviderUtterance> {
    if (this.nextEnqueueError !== undefined) {
      const error = this.nextEnqueueError;
      this.nextEnqueueError = undefined;
      return Promise.reject(error);
    }
    const messageId = this.messageIds.shift() ?? this.nextMessageId++;
    const utterance = deferredUtterance(messageId);
    this.utterances.set(messageId, utterance);
    this.enqueued.push(input);
    this.resolveWaiters(this.enqueueWaiters, this.enqueued.length);
    if (this.deferEnqueueResult) {
      this.deferEnqueueResult = false;
      return new Promise((resolve) => {
        this.pendingEnqueues.push({ utterance, resolve });
      });
    }
    return Promise.resolve(utterance);
  }

  cancelSelf(): Promise<void> {
    this.cancelCalls += 1;
    this.resolveWaiters(this.cancelWaiters, this.cancelCalls);
    if (this.nextCancelError !== undefined) {
      const error = this.nextCancelError;
      this.nextCancelError = undefined;
      return Promise.reject(error);
    }
    if (this.deferCancelResult) {
      this.deferCancelResult = false;
      return new Promise((resolve) => { this.pendingCancels.push(resolve); });
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    return Promise.resolve();
  }

  rejectNextEnqueue(error: Error): void {
    this.nextEnqueueError = error;
  }

  deferNextEnqueue(): void {
    this.deferEnqueueResult = true;
  }

  acceptNextEnqueue(): void {
    const pending = this.pendingEnqueues.shift();
    if (pending === undefined) throw new Error("No pending enqueue");
    pending.resolve(pending.utterance);
  }

  rejectNextCancel(error: Error): void {
    this.nextCancelError = error;
  }

  deferNextCancel(): void {
    this.deferCancelResult = true;
  }

  resolveNextCancel(): void {
    const resolve = this.pendingCancels.shift();
    if (resolve === undefined) throw new Error("No pending cancellation");
    resolve();
  }

  end(messageId: number): void {
    this.utterance(messageId).resolve("ended");
  }

  cancel(messageId: number): void {
    this.utterance(messageId).resolve("canceled");
  }

  fail(messageId: number, error: Error): void {
    this.utterance(messageId).reject(error);
  }

  waitForEnqueueCount(count: number): Promise<void> {
    return this.waitForCount(this.enqueueWaiters, this.enqueued.length, count);
  }

  waitForCancelCount(count: number): Promise<void> {
    return this.waitForCount(this.cancelWaiters, this.cancelCalls, count);
  }

  private utterance(messageId: number): DeferredUtterance {
    const utterance = this.utterances.get(messageId);
    if (utterance === undefined) throw new Error(`No utterance for message ${String(messageId)}`);
    return utterance;
  }

  private waitForCount(waiters: Map<number, (() => void)[]>, current: number, count: number): Promise<void> {
    if (current >= count) return Promise.resolve();
    return new Promise((resolve) => {
      const callbacks = waiters.get(count) ?? [];
      callbacks.push(resolve);
      waiters.set(count, callbacks);
    });
  }

  private resolveWaiters(waiters: Map<number, (() => void)[]>, current: number): void {
    for (const [count, callbacks] of waiters) {
      if (count > current) continue;
      waiters.delete(count);
      for (const resolve of callbacks) resolve();
    }
  }
}

interface DeferredUtterance extends HostSpeechProviderUtterance {
  resolve(outcome: HostSpeechProviderTerminalOutcome): void;
  reject(error: Error): void;
}

function deferredUtterance(messageId: number): DeferredUtterance {
  let resolve!: (outcome: HostSpeechProviderTerminalOutcome) => void;
  let reject!: (error: Error) => void;
  const terminal = new Promise<HostSpeechProviderTerminalOutcome>((resolveTerminal, rejectTerminal) => {
    resolve = resolveTerminal;
    reject = rejectTerminal;
  });
  return { messageId, terminal, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
