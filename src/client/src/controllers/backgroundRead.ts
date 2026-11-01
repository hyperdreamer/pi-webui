import { REMOTE_BACKGROUND_REQUEST_TIMEOUT_MS } from "../../../shared/machineRequestTimeout";
import { LoadCancelledError } from "./cancellableLoadScope";

/**
 * Why a read is running.
 *
 * Only background reads are allowed to bow out after the remote browser
 * deadline. Foreground work (selection loads, explicit refreshes, accepted
 * mutation reconciliation) keeps the gateway budget, so callers carry the
 * intent and only background branches take the bounded helper path.
 */
export type ReadIntent = "background" | "foreground";

const BACKGROUND_TIMEOUT_MESSAGE = `Background read exceeded ${String(REMOTE_BACKGROUND_REQUEST_TIMEOUT_MS)} milliseconds`;

interface DeadlineScope {
  readonly signal: AbortSignal;
  dispose(): void;
}

interface CombinedScope {
  readonly signal: AbortSignal;
  dispose(): void;
}

/**
 * Bound one remote background read to the browser budget.
 *
 * The local machine and foreground intent delegate directly: there is no
 * background bow-out to apply. Remote background reads get a marker-bearing
 * deadline that covers fetch and body consumption until the read settles,
 * combined with the caller's supersession signal. Native `AbortSignal.timeout`
 * never reaches the read, so a platform `TimeoutError` cannot masquerade as a
 * genuine load failure.
 */
export async function runBackgroundRead<T>(
  machineId: string,
  read: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  intent: ReadIntent = "background",
): Promise<T> {
  if (intent === "foreground" || machineId === "local") return read(signal);
  if (signal?.aborted === true) throw abortReason(signal);

  const deadline = createDeadlineScope();
  const combined = combineWithSupersession(deadline.signal, signal);
  let removeAbortListener: (() => void) | undefined;
  try {
    if (isAborted(combined.signal)) throw abortReason(combined.signal);
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => {
        reject(abortReason(combined.signal));
      };
      combined.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => {
        combined.signal.removeEventListener("abort", onAbort);
      };
    });
    // The abort path can settle the race while the read keeps running; the
    // race handles the read's own rejection, and this keeps the abandoned
    // promise from being reported as unhandled if the read never settles.
    void aborted.catch(() => undefined);

    const result = await Promise.race([invokeRead(read, combined.signal), aborted]);
    if (isAborted(combined.signal)) throw abortReason(combined.signal);
    return result;
  } catch (error) {
    if (isAborted(combined.signal)) throw abortReason(combined.signal);
    throw error;
  } finally {
    removeAbortListener?.();
    combined.dispose();
    deadline.dispose();
  }
}

function invokeRead<T>(read: (signal?: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return read(signal);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

function createDeadlineScope(): DeadlineScope {
  // The marker-bearing controller is the only deadline signal read consumers
  // can observe; a native timeout source is translated into it.
  const deadline = new AbortController();
  const expire = (): void => {
    deadline.abort(new LoadCancelledError(BACKGROUND_TIMEOUT_MESSAGE));
  };
  const timeout = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout.bind(AbortSignal) : undefined;
  if (timeout !== undefined) {
    const source = timeout(REMOTE_BACKGROUND_REQUEST_TIMEOUT_MS);
    const onAbort = (): void => {
      expire();
    };
    source.addEventListener("abort", onAbort, { once: true });
    if (source.aborted) expire();
    return {
      signal: deadline.signal,
      dispose: () => {
        source.removeEventListener("abort", onAbort);
      },
    };
  }
  const timer = setTimeout(expire, REMOTE_BACKGROUND_REQUEST_TIMEOUT_MS);
  return {
    signal: deadline.signal,
    dispose: () => {
      clearTimeout(timer);
    },
  };
}

function combineWithSupersession(deadline: AbortSignal, supersession: AbortSignal | undefined): CombinedScope {
  const sources = supersession === undefined ? [deadline] : [deadline, supersession];
  const any = typeof AbortSignal.any === "function" ? AbortSignal.any.bind(AbortSignal) : undefined;
  if (any !== undefined) {
    return { signal: any(sources), dispose: () => undefined };
  }
  const controller = new AbortController();
  const disposers = sources.map((source) => forwardAbort(source, controller));
  return {
    signal: controller.signal,
    dispose: () => {
      for (const dispose of disposers) dispose();
    },
  };
}

function forwardAbort(source: AbortSignal, target: AbortController): () => void {
  const forward = (): void => {
    target.abort(abortReason(source));
  };
  if (isAborted(source)) {
    forward();
    return () => undefined;
  }
  source.addEventListener("abort", forward, { once: true });
  // Close the attach/check race: a source that aborted between the check and
  // the listener attach must still forward its first reason.
  if (isAborted(source)) forward();
  return () => {
    source.removeEventListener("abort", forward);
  };
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("The operation was aborted", "AbortError");
}
