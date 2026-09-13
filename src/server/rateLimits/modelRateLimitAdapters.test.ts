import {
  createAssistantMessageEventStream,
  isRetryableAssistantError,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { wrapModelCompletion, wrapModelStream } from "./modelRateLimitAdapters";
import {
  MODEL_RATE_LIMITS_BLOCKED_MESSAGE,
  createModelRateLimitOwner,
  type ModelRateLimitOwner,
} from "./modelRateLimitOwner";
import {
  createControllableStream,
  createFakeModelRateLimitClock,
  fixtureIdentity,
  fixtureLimits,
  fixtureSnapshot,
  fixtureTerminalMessage,
} from "./modelRateLimit.testSupport";

const identity = fixtureIdentity("anthropic", "demo-model");

function fixtureModel(): Model<Api> {
  return {
    id: "demo-model",
    name: "Demo Model",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
  };
}

const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 0 }] };

function createOwner(tpm?: number, prm?: number) {
  const clock = createFakeModelRateLimitClock();
  const owner = createModelRateLimitOwner({ clock });
  owner.applySnapshot(fixtureSnapshot({ anthropic: { "demo-model": fixtureLimits(tpm, prm) } }), "accepted-document");
  return { clock, owner };
}

function terminalWithInput(input: number): AssistantMessage {
  const base = fixtureTerminalMessage();
  return fixtureTerminalMessage({ usage: { ...base.usage, input, totalTokens: input } });
}

interface DuplicateTerminalProbe {
  stream: AssistantMessageEventStream;
  push(event: AssistantMessageEvent): void;
  nextCallCount(): number;
  returnCallCount(): number;
}

/**
 * Counts how the pump consumes the delegate and replays a duplicate terminal on
 * the second `next()`. Pi's `EventStream` drops pushes after a terminal event,
 * so without this probe a pump that keeps consuming past the terminal is
 * invisible to accounting assertions.
 */
function createDuplicateTerminalProbe(duplicate: AssistantMessage): DuplicateTerminalProbe {
  const stream = createAssistantMessageEventStream();
  const delegateIterator = stream[Symbol.asyncIterator]();
  let nextCalls = 0;
  let returnCalls = 0;
  const iterator: AsyncIterator<AssistantMessageEvent> = {
    next: () => {
      nextCalls += 1;
      if (nextCalls === 1) return delegateIterator.next();
      if (nextCalls === 2) {
        return Promise.resolve({ value: { type: "done", reason: "stop", message: duplicate }, done: false });
      }
      return Promise.resolve({ value: undefined, done: true });
    },
    return: (value?: unknown) => {
      returnCalls += 1;
      return delegateIterator.return === undefined
        ? Promise.resolve({ value: undefined, done: true })
        : delegateIterator.return(value);
    },
  };
  Object.defineProperty(stream, Symbol.asyncIterator, {
    value: (): AsyncIterator<AssistantMessageEvent> => iterator,
    configurable: true,
  });
  return {
    stream,
    push: (event: AssistantMessageEvent): void => { stream.push(event); },
    nextCallCount: () => nextCalls,
    returnCallCount: () => returnCalls,
  };
}

describe("model rate limit stream adapter", () => {
  it("forwards delegate events in order and records usage before the terminal event", async () => {
    const { owner } = createOwner(5);
    const delegate = createControllableStream();
    const streamFn = vi.fn<StreamFn>(() => delegate.stream);
    const wrapped = wrapModelStream(owner, streamFn);
    const message = terminalWithInput(5);
    const events: string[] = [];

    const consumed = (async () => {
      for await (const event of wrapped(fixtureModel(), context, {})) {
        events.push(event.type);
        if (event.type === "done") {
          const followUp = owner.acquire(identity);
          expect(owner.pendingWaiterCount(identity)).toBe(1);
          owner.dispose();
          await expect(followUp).resolves.toEqual({ status: "aborted" });
        }
      }
    })();

    delegate.push({ type: "start", partial: message });
    delegate.push({ type: "text_delta", contentIndex: 0, delta: "o", partial: message });
    delegate.end(message);
    await consumed;

    expect(events).toEqual(["start", "text_delta", "done"]);
    expect(owner.inFlightCount(identity)).toBe(0);
  });

  it("serves a .result()-only consumer that never iterates the wrapper", async () => {
    const { owner } = createOwner(5);
    const delegate = createControllableStream();
    const wrapped = wrapModelStream(owner, vi.fn<StreamFn>(() => delegate.stream));
    const message = terminalWithInput(5);

    const result = wrapped(fixtureModel(), context, {}).result();
    delegate.push({ type: "start", partial: message });
    delegate.end(message);

    await expect(result).resolves.toEqual(message);
    const followUp = owner.acquire(identity);
    expect(owner.pendingWaiterCount(identity)).toBe(1);
    owner.dispose();
    await expect(followUp).resolves.toEqual({ status: "aborted" });
  });

  it("accounts duplicate terminal events once and stops consuming the delegate", async () => {
    const { owner } = createOwner(10);
    const first = terminalWithInput(5);
    const probe = createDuplicateTerminalProbe(terminalWithInput(5));
    const wrapped = wrapModelStream(owner, vi.fn<StreamFn>(() => probe.stream));

    const result = wrapped(fixtureModel(), context, {}).result();
    probe.push({ type: "done", reason: "stop", message: first });

    await expect(result).resolves.toEqual(first);
    // A pump that keeps consuming past the terminal would call next() again.
    expect(probe.nextCallCount()).toBe(1);
    expect(probe.returnCallCount()).toBe(1);

    // Exactly one 5-token charge is retained, so the follow-up is admitted.
    // A second charge would retain 10 and queue this acquire instead.
    const followUp = owner.acquire(identity);
    expect(owner.pendingWaiterCount(identity)).toBe(0);
    await expect(followUp).resolves.toEqual({ status: "granted" });
    owner.completeCall(identity, undefined);
    expect(owner.inFlightCount(identity)).toBe(0);
  });

  it("settles synthesized errors for a synchronous throw and a rejected delegate", async () => {
    const sync = createOwner();
    const throwing = wrapModelStream(sync.owner, () => { throw new Error("sync boom"); });
    await expect(throwing(fixtureModel(), context, {}).result()).resolves.toMatchObject({ stopReason: "error", errorMessage: "sync boom" });
    expect(sync.owner.inFlightCount(identity)).toBe(0);

    const asyncOwner = createOwner();
    const rejecting = wrapModelStream(asyncOwner.owner, () => Promise.reject(new Error("async boom")));
    await expect(rejecting(fixtureModel(), context, {}).result()).resolves.toMatchObject({ stopReason: "error", errorMessage: "async boom" });
    expect(asyncOwner.owner.inFlightCount(identity)).toBe(0);
  });

  it("settles an error when the delegate stream ends without a terminal event", async () => {
    const { owner } = createOwner();
    const delegate = createControllableStream();
    const wrapped = wrapModelStream(owner, vi.fn<StreamFn>(() => delegate.stream));

    const result = wrapped(fixtureModel(), context, {}).result();
    delegate.stream.end();

    await expect(result).resolves.toMatchObject({ stopReason: "error", errorMessage: "Model stream ended without a final result." });
    expect(owner.inFlightCount(identity)).toBe(0);
  });

  it("never calls the delegate for a pre-dispatch abort and spends no prm unit", async () => {
    const { owner } = createOwner(undefined, 1);
    const controller = new AbortController();
    const streamFn = vi.fn<StreamFn>(() => { throw new Error("delegate must not run"); });
    const wrapped = wrapModelStream(owner, streamFn);

    controller.abort();
    await expect(wrapped(fixtureModel(), context, { signal: controller.signal }).result())
      .resolves.toMatchObject({ stopReason: "aborted", errorMessage: "Request was aborted" });
    expect(streamFn).not.toHaveBeenCalled();
    expect(owner.pendingWaiterCount(identity)).toBe(0);

    await owner.acquire(identity);
    const waiting = new AbortController();
    const queued = wrapped(fixtureModel(), context, { signal: waiting.signal }).result();
    expect(owner.pendingWaiterCount(identity)).toBe(1);
    waiting.abort();
    await expect(queued).resolves.toMatchObject({ stopReason: "aborted", errorMessage: "Request was aborted" });
    expect(streamFn).not.toHaveBeenCalled();
    expect(owner.pendingWaiterCount(identity)).toBe(0);
    // The granted call still in flight is untouched: a pre-dispatch abort never completes.
    expect(owner.inFlightCount(identity)).toBe(1);
  });

  it("produces a blocked terminal that Pi does not classify as retryable", async () => {
    const owner = createModelRateLimitOwner({ clock: createFakeModelRateLimitClock() });
    owner.reportLoadFailure("models.json could not be parsed: bad");
    const streamFn = vi.fn<StreamFn>(() => { throw new Error("delegate must not run"); });

    const message = await wrapModelStream(owner, streamFn)(fixtureModel(), context, {}).result();

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe(`${MODEL_RATE_LIMITS_BLOCKED_MESSAGE} models.json could not be parsed: bad`);
    expect(isRetryableAssistantError(message)).toBe(false);
    expect(streamFn).not.toHaveBeenCalled();
  });

  it("forwards delegate options unchanged and guards against double wrapping", async () => {
    const { owner } = createOwner();
    const delegate = createControllableStream();
    const streamFn = vi.fn<StreamFn>(() => delegate.stream);
    const wrapped = wrapModelStream(owner, streamFn);
    const options = { maxTokens: 7, reasoning: "low" as const, signal: new AbortController().signal };
    const model = {
      id: "demo-model",
      name: "Demo Model",
      api: "anthropic-messages" as const,
      provider: "anthropic",
      baseUrl: "https://example.test",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000,
      maxTokens: 100,
    };

    const stream = wrapped(model, context, options);
    delegate.end(fixtureTerminalMessage());

    await expect(stream.result()).resolves.toEqual(fixtureTerminalMessage());
    expect(streamFn).toHaveBeenCalledWith(model, context, options);
    expect(wrapModelStream(owner, wrapped)).toBe(wrapped);
    expect(wrapModelStream(owner, wrapModelStream(owner, streamFn))).toBe(wrapModelStream(owner, streamFn));
  });
});

describe("model rate limit completion adapter", () => {
  it("resolves the delegate message after recording usage once", async () => {
    const { owner } = createOwner(10);
    const message = terminalWithInput(5);
    const delegate = vi.fn(() => Promise.resolve(message));
    const complete = wrapModelCompletion(owner, delegate);

    await expect(complete(fixtureModel(), context)).resolves.toEqual(message);
    // Exactly one 5-token charge is retained, so the follow-up is admitted.
    // A duplicated charge would retain 10 and queue this acquire instead.
    const followUp = owner.acquire(identity);
    expect(owner.pendingWaiterCount(identity)).toBe(0);
    await expect(followUp).resolves.toEqual({ status: "granted" });
    owner.completeCall(identity, undefined);
    expect(owner.inFlightCount(identity)).toBe(0);
  });

  it("resolves aborted and blocked terminals without calling the delegate", async () => {
    const abortedOwner = createOwner().owner;
    const controller = new AbortController();
    controller.abort();
    const delegate = vi.fn(() => Promise.resolve(terminalWithInput(0)));

    await expect(wrapModelCompletion(abortedOwner, delegate)(fixtureModel(), context, { signal: controller.signal }))
      .resolves.toMatchObject({ stopReason: "aborted", errorMessage: "Request was aborted" });
    expect(delegate).not.toHaveBeenCalled();

    const blockedOwner: ModelRateLimitOwner = createModelRateLimitOwner({ clock: createFakeModelRateLimitClock() });
    blockedOwner.reportLoadFailure("bad file");
    await expect(wrapModelCompletion(blockedOwner, delegate)(fixtureModel(), context))
      .resolves.toMatchObject({ stopReason: "error", errorMessage: `${MODEL_RATE_LIMITS_BLOCKED_MESSAGE} bad file` });
    expect(delegate).not.toHaveBeenCalled();
  });

  it("rejects a delegate failure after one completion", async () => {
    const { owner } = createOwner();
    const failure = new Error("delegate failed");
    const delegate = vi.fn(() => Promise.reject(failure));

    await expect(wrapModelCompletion(owner, delegate)(fixtureModel(), context)).rejects.toBe(failure);
    expect(owner.inFlightCount(identity)).toBe(0);
  });
});
