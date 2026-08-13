import type {
  HostSpeechSpeakRequest,
  HostSpeechStatus,
  HostSpeechTerminalResult,
} from "../../shared/apiTypes.js";
import { truncateHostSpeechText } from "../../shared/hostSpeech.js";
import {
  HostSpeechUnavailableError,
  type HostSpeech,
  type HostSpeechProvider,
  type HostSpeechProviderTerminalOutcome,
} from "./hostSpeech.js";

const DEFAULT_CANCELED_RUN_LIMIT = 64;
const CLOSED_REASON = "Host speech is closed.";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface ActiveSpeech {
  request: HostSpeechSpeakRequest;
  messageId?: number;
  result: Deferred<HostSpeechTerminalResult>;
}

export interface HostSpeechServiceOptions {
  canceledRunLimit?: number;
}

export class HostSpeechService implements HostSpeech {
  private readonly canceledRunLimit: number;
  private readonly canceledRuns = new Set<string>();
  private control: Promise<void> = Promise.resolve();
  private active: ActiveSpeech | undefined;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly provider: HostSpeechProvider,
    options: HostSpeechServiceOptions = {},
  ) {
    const canceledRunLimit = options.canceledRunLimit ?? DEFAULT_CANCELED_RUN_LIMIT;
    if (!Number.isSafeInteger(canceledRunLimit) || canceledRunLimit < 0) {
      throw new RangeError("canceledRunLimit must be a non-negative safe integer");
    }
    this.canceledRunLimit = canceledRunLimit;
  }

  status(): Promise<HostSpeechStatus> {
    if (this.closed) return Promise.resolve(unavailableStatus());
    return this.provider.status();
  }

  speak(input: HostSpeechSpeakRequest): Promise<HostSpeechTerminalResult> {
    if (this.closed) return Promise.reject(unavailableError());
    const result = deferred<HostSpeechTerminalResult>();
    void this.serializeControl(async () => {
      if (this.closed) {
        result.reject(unavailableError());
        return;
      }
      if (this.canceledRuns.has(input.runId)) {
        result.resolve(canceledResult(input.runId));
        return;
      }

      const previous = this.active;
      if (previous !== undefined) await this.provider.cancelSelf();

      if (this.isClosed()) {
        result.reject(unavailableError());
        return;
      }

      const active: ActiveSpeech = { request: input, result };
      this.active = active;
      this.enqueue(active);
    }).catch((error: unknown) => {
      result.reject(error);
    });
    return result.promise;
  }

  stop(runId: string): Promise<HostSpeechTerminalResult | undefined> {
    return this.serializeControl(async () => {
      this.rememberCanceledRun(runId);
      const active = this.active;
      if (active?.request.runId !== runId) return undefined;

      await this.provider.cancelSelf();
      return canceledResult(runId);
    });
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.closePromise = this.serializeControl(async () => {
      const active = this.active;
      try {
        if (active !== undefined) {
          try {
            const cancellation = this.provider.cancelSelf();
            this.settleCanceled(active);
            await cancellation;
          } finally {
            this.settleCanceled(active);
          }
        }
      } finally {
        await this.provider.close();
      }
    });
    return this.closePromise;
  }

  private serializeControl<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.control.then(operation, operation);
    this.control = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private isClosed(): boolean {
    return this.closed;
  }

  private enqueue(active: ActiveSpeech): void {
    let pending;
    try {
      pending = this.provider.enqueue({
        text: truncateHostSpeechText(active.request.text),
        ...(active.request.voice === undefined ? {} : { voice: active.request.voice }),
        rate: active.request.rate,
      });
    } catch (error) {
      this.handleFailure(active, error);
      return;
    }
    void pending.then(
      (utterance) => {
        active.messageId = utterance.messageId;
        void utterance.terminal.then(
          (outcome) => {
            this.handleTerminal(active, outcome);
          },
          (error: unknown) => {
            this.handleFailure(active, error);
          },
        );
      },
      (error: unknown) => {
        this.handleFailure(active, error);
      },
    );
  }

  private rememberCanceledRun(runId: string): void {
    if (this.canceledRunLimit === 0 || this.canceledRuns.has(runId)) return;
    this.canceledRuns.add(runId);
    if (this.canceledRuns.size <= this.canceledRunLimit) return;
    const oldest = this.canceledRuns.values().next().value;
    if (oldest !== undefined) this.canceledRuns.delete(oldest);
  }

  private handleTerminal(active: ActiveSpeech, outcome: HostSpeechProviderTerminalOutcome): void {
    if (this.active === active) this.active = undefined;
    active.result.resolve({ runId: active.request.runId, outcome });
  }

  private handleFailure(active: ActiveSpeech, error: unknown): void {
    if (this.active === active) this.active = undefined;
    active.result.reject(error);
  }

  private settleCanceled(active: ActiveSpeech): void {
    if (this.active === active) this.active = undefined;
    active.result.resolve(canceledResult(active.request.runId));
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function canceledResult(runId: string): HostSpeechTerminalResult {
  return { runId, outcome: "canceled" };
}

function unavailableStatus(): HostSpeechStatus {
  return { available: false, reason: CLOSED_REASON, voices: [] };
}

function unavailableError(): HostSpeechUnavailableError {
  return new HostSpeechUnavailableError(CLOSED_REASON);
}
