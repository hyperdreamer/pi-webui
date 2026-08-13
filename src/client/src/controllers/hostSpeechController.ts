import type {
  HostSpeechSpeakRequest,
  HostSpeechStatus,
  HostSpeechStopResponse,
  HostSpeechTerminalResult,
  PiWebUiTtsConfig,
} from "../../../shared/apiTypes";
import { effectivePiWebUiTtsConfig, truncateHostSpeechText } from "../../../shared/hostSpeech";
import { HttpRequestError, ttsApi as defaultApi } from "../api";

const CHECKING_STATUS: HostSpeechStatus = {
  available: false,
  reason: "Checking OS speech availability.",
  voices: [],
};
const ERROR_CLEAR_DELAY_MS = 5_000;

export interface HostSpeechSelection {
  machineId: string;
  sessionId: string;
}

export interface HostSpeechMessageTarget {
  machineId: string;
  sessionId: string;
  messageKey: string;
  text: string;
}

export interface HostSpeechControllerSnapshot {
  status: HostSpeechStatus;
  loadingStatus: boolean;
  active?: { runId: string; sessionId: string; messageKey: string };
  error?: string;
}

export interface HostSpeechClientApi {
  status(): Promise<HostSpeechStatus>;
  speak(input: HostSpeechSpeakRequest, signal?: AbortSignal): Promise<HostSpeechTerminalResult>;
  stop(runId: string): Promise<HostSpeechStopResponse>;
}

export interface HostSpeechControllerOptions {
  api?: HostSpeechClientApi;
  createRunId?: () => string;
  onStateChange?: () => void;
  scheduleErrorClear?: (callback: () => void, delayMs: number) => () => void;
}

interface ActiveRun {
  runId: string;
  machineId: string;
  sessionId: string;
  messageKey: string;
  text: string;
  controller: AbortController;
  requestClosed: boolean;
}

/** Owns local host-speech request lifecycle without coupling it to application state or rendering. */
export class HostSpeechController {
  private readonly api: HostSpeechClientApi;
  private readonly createRunId: () => string;
  private readonly onStateChange: () => void;
  private readonly scheduleErrorClear: (callback: () => void, delayMs: number) => () => void;
  private statusValue = cloneStatus(CHECKING_STATUS);
  private loadingStatusValue = false;
  private selection: HostSpeechSelection | undefined;
  private config: ReturnType<typeof effectivePiWebUiTtsConfig> = effectivePiWebUiTtsConfig(undefined);
  private active: ActiveRun | undefined;
  private errorValue: string | undefined;
  private clearError: (() => void) | undefined;
  private errorClearSequence = 0;
  private statusRequestSequence = 0;
  private disposed = false;

  constructor(options: HostSpeechControllerOptions = {}) {
    this.api = options.api ?? defaultApi;
    this.createRunId = options.createRunId ?? defaultRunId;
    this.onStateChange = options.onStateChange ?? (() => undefined);
    this.scheduleErrorClear = options.scheduleErrorClear ?? defaultScheduleErrorClear;
  }

  get snapshot(): HostSpeechControllerSnapshot {
    return {
      status: cloneStatus(this.statusValue),
      loadingStatus: this.loadingStatusValue,
      ...(this.active === undefined ? {} : {
        active: {
          runId: this.active.runId,
          sessionId: this.active.sessionId,
          messageKey: this.active.messageKey,
        },
      }),
      ...(this.errorValue === undefined ? {} : { error: this.errorValue }),
    };
  }

  configure(config: PiWebUiTtsConfig | undefined): void {
    if (this.disposed) return;
    this.config = effectivePiWebUiTtsConfig(config);
  }

  async refreshStatus(): Promise<void> {
    if (this.disposed) return;
    const sequence = ++this.statusRequestSequence;
    this.loadingStatusValue = true;
    this.publish();
    try {
      const status = await this.api.status();
      if (!this.isCurrentStatusRequest(sequence)) return;
      this.statusValue = cloneStatus(status);
    } catch (error) {
      if (!this.isCurrentStatusRequest(sequence)) return;
      this.statusValue = unavailableStatus(errorMessage(error));
    } finally {
      if (this.isCurrentStatusRequest(sequence)) {
        this.loadingStatusValue = false;
        this.publish();
      }
    }
  }

  select(selection: HostSpeechSelection | undefined): void {
    if (this.disposed || selectionsEqual(this.selection, selection)) return;
    this.selection = selection === undefined ? undefined : { ...selection };
    const active = this.clearActive();
    if (active === undefined) return;
    active.controller.abort();
    this.publish();
    void this.stopAbandoned(active);
  }

  async startManual(target: HostSpeechMessageTarget): Promise<void> {
    if (this.disposed || !this.canStart(target)) return;
    const text = truncateHostSpeechText(target.text);
    if (text === "") return;
    const previous = this.clearActive();
    if (previous !== undefined) {
      previous.controller.abort();
      void this.stopAbandoned(previous);
    }

    const runId = this.createRunId();
    const active: ActiveRun = {
      runId,
      machineId: target.machineId,
      sessionId: target.sessionId,
      messageKey: target.messageKey,
      text,
      controller: new AbortController(),
      requestClosed: false,
    };
    this.active = active;
    this.clearRetryableError();
    this.publish();

    const voice = this.config.voice;
    const input: HostSpeechSpeakRequest = {
      runId,
      text,
      ...(voice !== undefined && this.statusValue.voices.some((candidate) => candidate.name === voice) ? { voice } : {}),
      rate: this.config.rate,
    };
    try {
      const result = await this.api.speak(input, active.controller.signal);
      active.requestClosed = true;
      if (!this.isActive(active) || result.runId !== active.runId) return;
      this.active = undefined;
      this.publish();
    } catch (error) {
      active.requestClosed = true;
      if (!this.isActive(active)) return;
      if (isAbortError(error)) {
        this.active = undefined;
        this.publish();
        return;
      }
      this.active = undefined;
      if (error instanceof HttpRequestError && error.status === 503) {
        this.statusValue = unavailableStatus(error.message);
        this.clearRetryableError();
        this.publish();
        return;
      }
      this.applyRetryableError(errorMessage(error));
      this.publish();
      if (error instanceof HttpRequestError && error.status === 500) void this.refreshStatus();
    }
  }

  matchesActiveSource(identity: { sessionId: string; messageKey: string; text: string }): boolean {
    const active = this.active;
    return active?.sessionId === identity.sessionId
      && active.messageKey === identity.messageKey
      && active.text === identity.text;
  }

  async stop(): Promise<void> {
    if (this.disposed) return;
    const active = this.clearActive();
    if (active === undefined) return;
    active.controller.abort();
    this.publish();
    await this.stopActive(active);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.statusRequestSequence += 1;
    this.clearError?.();
    this.clearError = undefined;
    const active = this.clearActive();
    if (active === undefined) return;
    active.controller.abort();
    void Promise.resolve().then(() => this.api.stop(active.runId)).catch(() => undefined);
  }

  private canStart(target: HostSpeechMessageTarget): boolean {
    const selection = this.selection;
    return selection?.machineId === "local"
      && selection.machineId === target.machineId
      && selection.sessionId === target.sessionId
      && this.statusValue.available;
  }

  private clearActive(): ActiveRun | undefined {
    const active = this.active;
    this.active = undefined;
    return active;
  }

  private isActive(active: ActiveRun): boolean {
    return !this.disposed && this.active === active;
  }

  private isCurrentStatusRequest(sequence: number): boolean {
    return !this.disposed && sequence === this.statusRequestSequence;
  }

  private async stopAbandoned(active: ActiveRun): Promise<void> {
    try {
      await this.api.stop(active.runId);
    } catch {
      // Selection replacement deliberately abandons the prior run; it must not
      // surface a stale stop failure over the replacement selection.
    }
  }

  private async stopActive(active: ActiveRun): Promise<void> {
    try {
      await this.api.stop(active.runId);
    } catch (error) {
      // Abort rejects Speak on a microtask in browsers and Node. Let that handler
      // record closure before deciding whether this Stop failure is actionable.
      await Promise.resolve();
      if (this.disposed || active.requestClosed) return;
      this.applyRetryableError(errorMessage(error));
      this.publish();
    }
  }

  private applyRetryableError(message: string): void {
    this.clearError?.();
    this.errorValue = message;
    const sequence = ++this.errorClearSequence;
    this.clearError = this.scheduleErrorClear(() => {
      if (this.disposed || sequence !== this.errorClearSequence) return;
      this.errorValue = undefined;
      this.clearError = undefined;
      this.publish();
    }, ERROR_CLEAR_DELAY_MS);
  }

  private clearRetryableError(): void {
    this.clearError?.();
    this.errorClearSequence += 1;
    this.clearError = undefined;
    this.errorValue = undefined;
  }

  private publish(): void {
    if (!this.disposed) this.onStateChange();
  }
}

function unavailableStatus(reason: string): HostSpeechStatus {
  return { available: false, reason: reason.trim() === "" ? "Host speech is unavailable." : reason, voices: [] };
}

function cloneStatus(status: HostSpeechStatus): HostSpeechStatus {
  return {
    available: status.available,
    ...(status.reason === undefined ? {} : { reason: status.reason }),
    voices: status.voices.map((voice) => ({ ...voice })),
  };
}

function selectionsEqual(left: HostSpeechSelection | undefined, right: HostSpeechSelection | undefined): boolean {
  return left?.machineId === right?.machineId && left?.sessionId === right?.sessionId;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultScheduleErrorClear(callback: () => void, delayMs: number): () => void {
  const timer = globalThis.setTimeout(callback, delayMs);
  return () => { globalThis.clearTimeout(timer); };
}

function defaultRunId(): string {
  const browserCrypto = globalThis.crypto;
  if (typeof browserCrypto.randomUUID === "function") return browserCrypto.randomUUID();
  const bytes = browserCrypto.getRandomValues(new Uint8Array(16));
  return `r${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
