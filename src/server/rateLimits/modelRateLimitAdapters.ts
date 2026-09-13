import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ModelsSimpleStreamOptions,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ModelRateLimitIdentity } from "./modelRateLimitConfig.js";
import {
  MODEL_RATE_LIMITS_BLOCKED_MESSAGE,
  type ModelRateLimitOwner,
} from "./modelRateLimitOwner.js";

const MODEL_RATE_LIMIT_WRAPPED = Symbol("pi-webui.modelRateLimitWrapped");

/** A `StreamFn` that always returns its event stream synchronously. */
type ModelStreamFunction = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** Pi's direct completion surface, e.g. `ModelRuntime.completeSimple`. */
export type ModelCompletionFunction = (
  model: Model<Api>,
  context: Context,
  options?: ModelsSimpleStreamOptions,
) => Promise<AssistantMessage>;

const wrappedStreamFns = new WeakMap<ModelRateLimitOwner, WeakMap<StreamFn, ModelStreamFunction>>();
const wrappedCompletionFns = new WeakMap<ModelRateLimitOwner, WeakMap<ModelCompletionFunction, ModelCompletionFunction>>();

/** Wraps Pi's stream function with admission and terminal accounting. */
export function wrapModelStream(
  owner: ModelRateLimitOwner,
  delegate: StreamFn,
): ModelStreamFunction {
  if (isWrappedModelStreamFunction(delegate)) return delegate;
  const wrappers = streamWrappersFor(owner);
  const existing = wrappers.get(delegate);
  if (existing !== undefined) return existing;
  const wrapped: ModelStreamFunction = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void pumpModelStream(owner, delegate, stream, identityFor(model), model, context, options);
    return stream;
  };
  markWrapped(wrapped);
  wrappers.set(delegate, wrapped);
  return wrapped;
}

/** Wraps a direct completion function with admission and terminal accounting. */
export function wrapModelCompletion(
  owner: ModelRateLimitOwner,
  delegate: ModelCompletionFunction,
): ModelCompletionFunction {
  if (isWrapped(delegate)) return delegate;
  const wrappers = completionWrappersFor(owner);
  const existing = wrappers.get(delegate);
  if (existing !== undefined) return existing;
  const wrapped: ModelCompletionFunction = async (model, context, options) => {
    const identity = identityFor(model);
    const admission = await owner.acquire(identity, options?.signal);
    if (admission.status === "blocked") {
      return synthesizedTerminal(model, "error", blockedMessage(admission.error));
    }
    if (admission.status === "aborted") {
      return synthesizedTerminal(model, "aborted", "Request was aborted");
    }
    try {
      const message = await delegate(model, context, options);
      owner.completeCall(identity, message.usage);
      return message;
    } catch (error) {
      owner.completeCall(identity, undefined);
      throw error;
    }
  };
  markWrapped(wrapped);
  wrappers.set(delegate, wrapped);
  return wrapped;
}

async function pumpModelStream(
  owner: ModelRateLimitOwner,
  delegate: StreamFn,
  stream: AssistantMessageEventStream,
  identity: ModelRateLimitIdentity,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
): Promise<void> {
  let settled = false;

  const settle = (): boolean => {
    if (settled) return false;
    settled = true;
    return true;
  };

  /** Admission was never granted, so the dispatch unit is not spent. */
  const settleWithoutDispatch = (reason: "error" | "aborted", errorMessage: string): void => {
    if (!settle()) return;
    const message = synthesizedTerminal(model, reason, errorMessage);
    stream.push({ type: "error", reason, error: message });
    stream.end(message);
  };

  /** A dispatch happened; release the admission even without terminal usage. */
  const settleDispatchedFailure = (errorMessage: string): void => {
    if (!settle()) return;
    owner.completeCall(identity, undefined);
    const message = synthesizedTerminal(model, "error", errorMessage);
    stream.push({ type: "error", reason: "error", error: message });
    stream.end(message);
  };

  const admission = await owner.acquire(identity, options?.signal);
  if (admission.status === "blocked") {
    settleWithoutDispatch("error", blockedMessage(admission.error));
    return;
  }
  if (admission.status === "aborted") {
    settleWithoutDispatch("aborted", "Request was aborted");
    return;
  }

  try {
    const returned = delegate(model, context, options);
    const delegateStream = returned instanceof Promise ? await returned : returned;
    for await (const event of delegateStream) {
      if (event.type !== "done" && event.type !== "error") {
        stream.push(event);
        continue;
      }
      const terminal = event.type === "done" ? event.message : event.error;
      // Account the terminal inside the first-`settle()` branch so exactly-once
      // does not rest on the post-terminal `return` alone.
      if (settle()) {
        owner.completeCall(identity, terminal.usage);
        stream.push(event);
        stream.end(terminal);
      }
      return;
    }
    settleDispatchedFailure("Model stream ended without a final result.");
  } catch (error) {
    settleDispatchedFailure(error instanceof Error ? error.message : String(error));
  }
}

function streamWrappersFor(owner: ModelRateLimitOwner): WeakMap<StreamFn, ModelStreamFunction> {
  let wrappers = wrappedStreamFns.get(owner);
  if (wrappers === undefined) {
    wrappers = new WeakMap();
    wrappedStreamFns.set(owner, wrappers);
  }
  return wrappers;
}

function completionWrappersFor(
  owner: ModelRateLimitOwner,
): WeakMap<ModelCompletionFunction, ModelCompletionFunction> {
  let wrappers = wrappedCompletionFns.get(owner);
  if (wrappers === undefined) {
    wrappers = new WeakMap();
    wrappedCompletionFns.set(owner, wrappers);
  }
  return wrappers;
}

function markWrapped(wrapped: object): void {
  Object.defineProperty(wrapped, MODEL_RATE_LIMIT_WRAPPED, { value: true, enumerable: false });
}

function isWrapped(delegate: object): boolean {
  return Reflect.get(delegate, MODEL_RATE_LIMIT_WRAPPED) === true;
}

/** Only this module's wrappers carry the tag, and they always return synchronously. */
function isWrappedModelStreamFunction(delegate: StreamFn): delegate is ModelStreamFunction {
  return isWrapped(delegate);
}

function identityFor(model: Model<Api>): ModelRateLimitIdentity {
  return { provider: model.provider, modelId: model.id };
}

function blockedMessage(error: string): string {
  return `${MODEL_RATE_LIMITS_BLOCKED_MESSAGE} ${error}`;
}

function synthesizedTerminal(
  model: Model<Api>,
  stopReason: "error" | "aborted",
  errorMessage: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}
