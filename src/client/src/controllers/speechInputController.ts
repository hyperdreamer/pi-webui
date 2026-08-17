import type { SpeechInputSettingsResponse } from "../../../shared/apiTypes";
import { MediaRecorderAdapter } from "../speechInput/mediaRecorderAdapter";
import {
  resolveSpeechInputProvider,
  type SpeechInputAvailability,
  type SpeechInputAvailabilityMap,
  type SpeechInputProviderId,
  type SpeechInputTargetSnapshot,
} from "../speechInput/speechInputCore";
import {
  SpeechRecognitionAdapter,
} from "../speechInput/speechRecognitionAdapter";
import type {
  SpeechInputProviderAdapter,
  SpeechInputProviderCallbacks,
  SpeechInputProviderError,
  SpeechInputProviderRun,
} from "../speechInput/speechInputProvider";

const CAPTURE_LIMIT_MS = 10 * 60 * 1_000;
const TRANSCRIPTION_LIMIT_MS = 130 * 1_000;
const ELAPSED_UPDATE_MS = 1_000;
const ERROR_CLEAR_DELAY_MS = 5_000;
const SETTINGS_LOADING_REASON = "Speech settings are still loading.";
const EMPTY_TRANSCRIPT_ERROR = "No speech detected";
const CHANGED_DRAFT_ERROR = "Dictation was canceled because the draft changed.";
const TOO_LARGE_TRANSCRIPT_ERROR = "Dictated speech is too large.";
const TRANSCRIPTION_TIMEOUT_ERROR = "Speech transcription timed out.";
const CONTROLLER_FAILURE_ERROR = "Speech input failed.";
const ADAPTER_UNAVAILABLE_REASON = "Speech input is unavailable.";

export type SpeechInputControllerState =
  | { kind: "idle"; provider?: SpeechInputProviderId; unavailableReason?: string; error?: string }
  | { kind: "requesting-permission"; runId: string; provider: SpeechInputProviderId }
  | { kind: "listening"; runId: string; provider: SpeechInputProviderId; elapsedMs: number; interimText?: string }
  | { kind: "transcribing"; runId: string; provider: "cloud"; elapsedMs: number };

export interface SpeechInputControllerCallbacks {
  onStateChange(state: SpeechInputControllerState): void;
  onInterim(target: SpeechInputTargetSnapshot, text: string): void;
  onFinal(target: SpeechInputTargetSnapshot, text: string): "inserted" | "empty" | "changed" | "too-large";
  onClearInterim(): void;
}

export interface SpeechInputControllerOptions {
  browser: SpeechInputProviderAdapter;
  cloud: SpeechInputProviderAdapter;
  callbacks: SpeechInputControllerCallbacks;
  createRunId?: () => string;
  now?: () => number;
  scheduleInterval?: (callback: () => void, delayMs: number) => () => void;
  scheduleDeadline?: (callback: () => void, delayMs: number) => () => void;
}

interface ActiveSpeechInputRun {
  generation: number;
  runId: string;
  provider: SpeechInputProviderId;
  adapter: SpeechInputProviderAdapter;
  target: SpeechInputTargetSnapshot;
  language: string | undefined;
  run: SpeechInputProviderRun | undefined;
  captureStartedAt: number | undefined;
  captureDeadlineCancel: (() => void) | undefined;
  elapsedIntervalCancel: (() => void) | undefined;
  transcriptionDeadlineCancel: (() => void) | undefined;
  stopRequested: boolean;
  transcribing: boolean;
  interimText: string | undefined;
}

interface TerminalOptions {
  error?: string;
  finalText?: string;
  cancelAdapter?: boolean;
  publish?: boolean;
}

/** Owns one mounted composer's provider-neutral speech-input lifecycle. */
export class SpeechInputController {
  private readonly browser: SpeechInputProviderAdapter;
  private readonly cloud: SpeechInputProviderAdapter;
  private readonly callbacks: SpeechInputControllerCallbacks;
  private readonly createRunId: () => string;
  private readonly now: () => number;
  private readonly scheduleInterval: (callback: () => void, delayMs: number) => () => void;
  private readonly scheduleDeadline: (callback: () => void, delayMs: number) => () => void;
  private settingsValue: SpeechInputSettingsResponse | undefined;
  private stateValue: SpeechInputControllerState = { kind: "idle", unavailableReason: SETTINGS_LOADING_REASON };
  private active: ActiveSpeechInputRun | undefined;
  private errorClearCancel: (() => void) | undefined;
  private errorClearSequence = 0;
  private nextGeneration = 0;
  private disposed = false;

  constructor(options: SpeechInputControllerOptions) {
    this.browser = options.browser;
    this.cloud = options.cloud;
    this.callbacks = options.callbacks;
    this.createRunId = options.createRunId ?? defaultRunId;
    this.now = options.now ?? defaultNow;
    this.scheduleInterval = options.scheduleInterval ?? defaultScheduleInterval;
    this.scheduleDeadline = options.scheduleDeadline ?? defaultScheduleDeadline;
  }

  get state(): SpeechInputControllerState {
    return { ...this.stateValue };
  }

  /** Stores a new settings snapshot; active runs retain their captured provider and language. */
  configure(settings: SpeechInputSettingsResponse | undefined): void {
    if (this.disposed) return;
    this.settingsValue = settings === undefined ? undefined : cloneSettings(settings);
    if (this.active !== undefined) return;
    this.publishIdle(this.stateValue.kind === "idle" ? this.stateValue.error : undefined);
  }

  /** Resolves one provider for this run and begins its permission/capture lifecycle. */
  start(target: SpeechInputTargetSnapshot): void {
    if (this.disposed || this.active !== undefined) return;

    const settings = this.settingsValue;
    if (settings === undefined) {
      this.publishIdle(this.stateValue.kind === "idle" ? this.stateValue.error : undefined);
      return;
    }

    const resolution = resolveSpeechInputProvider(settings, this.availability());
    if (!resolution.available) {
      this.publishIdle(this.stateValue.kind === "idle" ? this.stateValue.error : undefined);
      return;
    }

    const provider = resolution.provider;
    this.clearErrorClear();
    const active: ActiveSpeechInputRun = {
      generation: ++this.nextGeneration,
      runId: this.createRunId(),
      provider,
      adapter: provider === "browser" ? this.browser : this.cloud,
      target: cloneTarget(target),
      language: settings.settings.language,
      run: undefined,
      captureStartedAt: undefined,
      captureDeadlineCancel: undefined,
      elapsedIntervalCancel: undefined,
      transcriptionDeadlineCancel: undefined,
      stopRequested: false,
      transcribing: false,
      interimText: undefined,
    };
    this.active = active;
    this.publish({ kind: "requesting-permission", runId: active.runId, provider });
    if (!this.isCurrent(active)) return;

    const callbacks = this.providerCallbacks(active);
    let run: SpeechInputProviderRun;
    try {
      run = provider === "browser"
        ? active.adapter.start({
          ...(active.language === undefined ? {} : { language: active.language }),
          callbacks,
        })
        : active.adapter.start({ callbacks });
    } catch {
      if (this.isCurrent(active)) this.settleTerminal(active, { error: CONTROLLER_FAILURE_ERROR });
      return;
    }

    // Adapters may synchronously emit any terminal callback inside start(). A
    // returned handle for such a now-stale run must still be best-effort canceled.
    if (!this.isCurrent(active)) {
      this.cancelRun(run);
      return;
    }

    active.run = run;
    if (active.stopRequested) this.stopRun(active);
  }

  /** Implements the microphone control's phase-specific primary action. */
  stop(): void {
    if (this.disposed) return;
    const active = this.active;
    if (active === undefined) return;
    if (this.stateValue.kind !== "listening") {
      this.cancel();
      return;
    }
    this.requestStop(active);
  }

  /** Discards any active run and suppresses every late provider result. */
  cancel(): boolean {
    if (this.disposed) return false;
    const active = this.active;
    if (active === undefined) return false;
    this.settleTerminal(active, { cancelAdapter: true });
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearErrorClear();
    const active = this.active;
    if (active === undefined) return;
    this.settleTerminal(active, { cancelAdapter: true, publish: false });
  }

  private providerCallbacks(active: ActiveSpeechInputRun): SpeechInputProviderCallbacks {
    const generation = active.generation;
    return {
      onListening: () => {
        this.handleListening(generation);
      },
      onInterim: (text) => {
        this.handleInterim(generation, text);
      },
      onTranscribing: () => {
        this.handleTranscribing(generation);
      },
      onComplete: (text) => {
        this.handleComplete(generation, text);
      },
      onError: (error) => {
        this.handleError(generation, error);
      },
    };
  }

  private handleListening(generation: number): void {
    const active = this.currentForGeneration(generation);
    if (active === undefined || active.transcribing || active.captureStartedAt !== undefined) return;

    active.captureStartedAt = this.monotonicNow();
    this.publish({
      kind: "listening",
      runId: active.runId,
      provider: active.provider,
      elapsedMs: 0,
    });
    if (!this.isCurrent(active)) return;

    this.armElapsedInterval(active);
    if (!this.isCurrent(active)) return;
    this.armCaptureDeadline(active);
  }

  private handleInterim(generation: number, text: string): void {
    const active = this.currentForGeneration(generation);
    if (active === undefined || this.stateValue.kind !== "listening") return;

    active.interimText = text;
    try {
      this.callbacks.onInterim(cloneTarget(active.target), text);
    } catch {
      if (this.isCurrent(active)) this.settleTerminal(active, { error: CONTROLLER_FAILURE_ERROR, cancelAdapter: true });
      return;
    }
    if (!this.isCurrent(active)) return;

    this.publish({
      kind: "listening",
      runId: active.runId,
      provider: active.provider,
      elapsedMs: this.elapsed(active),
      ...(text === "" ? {} : { interimText: text }),
    });
  }

  private handleTranscribing(generation: number): void {
    const active = this.currentForGeneration(generation);
    if (active === undefined) return;
    if (active.provider !== "cloud" || active.transcribing) return;

    active.transcribing = true;
    this.clearCaptureTimers(active);
    const elapsedMs = this.elapsed(active);
    if (!this.armTranscriptionDeadline(active)) return;
    if (!this.isCurrent(active)) return;

    this.publish({ kind: "transcribing", runId: active.runId, provider: "cloud", elapsedMs });
  }

  private handleComplete(generation: number, text: string): void {
    const active = this.currentForGeneration(generation);
    if (active === undefined) return;
    this.settleTerminal(active, { finalText: text });
  }

  private handleError(generation: number, error: SpeechInputProviderError): void {
    const active = this.currentForGeneration(generation);
    if (active === undefined) return;
    this.settleTerminal(active, { error: normalizedProviderError(error) });
  }

  private armElapsedInterval(active: ActiveSpeechInputRun): void {
    let cancel: (() => void) | undefined;
    try {
      cancel = this.scheduleInterval(() => {
        if (!this.isCurrent(active) || this.stateValue.kind !== "listening") return;
        this.publish({
          kind: "listening",
          runId: active.runId,
          provider: active.provider,
          elapsedMs: this.elapsed(active),
          ...(active.interimText === undefined || active.interimText === "" ? {} : { interimText: active.interimText }),
        });
      }, ELAPSED_UPDATE_MS);
    } catch {
      if (this.isCurrent(active)) this.settleTerminal(active, { error: CONTROLLER_FAILURE_ERROR, cancelAdapter: true });
      return;
    }
    if (!this.isCurrent(active) || this.stateValue.kind !== "listening") {
      cancel();
      return;
    }
    active.elapsedIntervalCancel = cancel;
  }

  private armCaptureDeadline(active: ActiveSpeechInputRun): void {
    let cancel: (() => void) | undefined;
    try {
      cancel = this.scheduleDeadline(() => {
        if (!this.isCurrent(active) || this.stateValue.kind !== "listening") return;
        this.requestStop(active);
      }, CAPTURE_LIMIT_MS);
    } catch {
      if (this.isCurrent(active)) this.settleTerminal(active, { error: CONTROLLER_FAILURE_ERROR, cancelAdapter: true });
      return;
    }
    if (!this.isCurrent(active) || this.stateValue.kind !== "listening") {
      cancel();
      return;
    }
    active.captureDeadlineCancel = cancel;
  }

  private armTranscriptionDeadline(active: ActiveSpeechInputRun): boolean {
    let cancel: (() => void) | undefined;
    try {
      cancel = this.scheduleDeadline(() => {
        if (!this.isCurrent(active) || !active.transcribing) return;
        // Settle first so an abort that synchronously fires a provider callback
        // cannot override the user's timeout error or commit a transcript.
        this.settleTerminal(active, { error: TRANSCRIPTION_TIMEOUT_ERROR, cancelAdapter: true });
      }, TRANSCRIPTION_LIMIT_MS);
    } catch {
      if (this.isCurrent(active)) this.settleTerminal(active, { error: CONTROLLER_FAILURE_ERROR, cancelAdapter: true });
      return false;
    }
    if (!this.isCurrent(active) || !active.transcribing) {
      cancel();
      return false;
    }
    active.transcriptionDeadlineCancel = cancel;
    return true;
  }

  private requestStop(active: ActiveSpeechInputRun): void {
    if (!this.isCurrent(active) || active.stopRequested || active.transcribing) return;
    active.stopRequested = true;
    this.stopRun(active);
  }

  private stopRun(active: ActiveSpeechInputRun): void {
    if (!this.isCurrent(active)) return;
    const run = active.run;
    if (run === undefined) return;
    try {
      run.stop();
    } catch {
      if (this.isCurrent(active)) {
        this.settleTerminal(active, { error: CONTROLLER_FAILURE_ERROR, cancelAdapter: true });
      }
    }
  }

  /** Invalidates first, then clears UI/timers, publishes, and only then aborts if requested. */
  private settleTerminal(active: ActiveSpeechInputRun, options: TerminalOptions): void {
    if (this.active !== active) return;

    this.active = undefined;
    this.clearAllTimers(active);
    this.clearInterim();

    let error = options.error;
    if (options.finalText !== undefined) {
      try {
        error = finalOutcomeError(this.callbacks.onFinal(cloneTarget(active.target), options.finalText));
      } catch {
        error = CONTROLLER_FAILURE_ERROR;
      }
    }

    if (options.publish !== false && !this.disposed && !this.hasActiveRun()) {
      this.publishTerminalIdle(error);
    } else if (options.publish === false && !this.hasActiveRun()) {
      this.stateValue = this.idleState(error);
    }

    if (options.cancelAdapter === true) this.cancelRun(active.run);
  }

  private clearAllTimers(active: ActiveSpeechInputRun): void {
    this.clearCaptureTimers(active);
    const cancel = active.transcriptionDeadlineCancel;
    active.transcriptionDeadlineCancel = undefined;
    cancel?.();
  }

  private clearCaptureTimers(active: ActiveSpeechInputRun): void {
    const intervalCancel = active.elapsedIntervalCancel;
    active.elapsedIntervalCancel = undefined;
    intervalCancel?.();
    const deadlineCancel = active.captureDeadlineCancel;
    active.captureDeadlineCancel = undefined;
    deadlineCancel?.();
  }

  private clearInterim(): void {
    try {
      this.callbacks.onClearInterim();
    } catch {
      // A failed decoration cleanup must not leave provider capture active.
    }
  }

  private cancelRun(run: SpeechInputProviderRun | undefined): void {
    if (run === undefined) return;
    try {
      run.cancel();
    } catch {
      // User cancellation remains silent even if a browser API throws while aborting.
    }
  }

  private currentForGeneration(generation: number): ActiveSpeechInputRun | undefined {
    const active = this.active;
    return !this.disposed && active?.generation === generation ? active : undefined;
  }

  private isCurrent(active: ActiveSpeechInputRun): boolean {
    return !this.disposed && this.active === active;
  }

  private hasActiveRun(): boolean {
    return this.active !== undefined;
  }

  private elapsed(active: ActiveSpeechInputRun): number {
    const startedAt = active.captureStartedAt;
    if (startedAt === undefined) return 0;
    return Math.max(0, this.monotonicNow() - startedAt);
  }

  private monotonicNow(): number {
    try {
      const value = this.now();
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  private availability(): SpeechInputAvailabilityMap {
    return {
      browser: this.adapterAvailability(this.browser),
      cloud: this.adapterAvailability(this.cloud),
    };
  }

  private adapterAvailability(adapter: SpeechInputProviderAdapter): SpeechInputAvailability {
    try {
      const availability = adapter.availability();
      if (availability.available) return { available: true };
      return {
        available: false,
        reason: normalizedAvailabilityReason(availability.reason),
      };
    } catch {
      return { available: false, reason: ADAPTER_UNAVAILABLE_REASON };
    }
  }

  private idleState(error: string | undefined): SpeechInputControllerState {
    const settings = this.settingsValue;
    if (settings === undefined) {
      return {
        kind: "idle",
        unavailableReason: SETTINGS_LOADING_REASON,
        ...(error === undefined ? {} : { error }),
      };
    }

    const resolution = resolveSpeechInputProvider(settings, this.availability());
    return resolution.available
      ? { kind: "idle", provider: resolution.provider, ...(error === undefined ? {} : { error }) }
      : {
        kind: "idle",
        unavailableReason: resolution.reason,
        ...(error === undefined ? {} : { error }),
      };
  }

  private publishIdle(error: string | undefined): void {
    this.publish(this.idleState(error));
  }

  private clearErrorClear(): void {
    const cancel = this.errorClearCancel;
    this.errorClearCancel = undefined;
    this.errorClearSequence += 1;
    try {
      cancel?.();
    } catch {
      // A timer canceler is best effort; sequence invalidation still blocks it.
    }
  }

  private armErrorClear(): void {
    const sequence = ++this.errorClearSequence;
    let cancel: (() => void) | undefined;
    try {
      cancel = this.scheduleDeadline(() => {
        if (
          this.disposed
          || sequence !== this.errorClearSequence
          || this.active !== undefined
          || this.stateValue.kind !== "idle"
          || this.stateValue.error === undefined
        ) return;
        this.errorClearCancel = undefined;
        this.errorClearSequence += 1;
        this.publishIdle(undefined);
      }, ERROR_CLEAR_DELAY_MS);
    } catch {
      return;
    }
    if (
      this.disposed
      || sequence !== this.errorClearSequence
      || this.active !== undefined
      || this.stateValue.kind !== "idle"
      || this.stateValue.error === undefined
    ) {
      try {
        cancel();
      } catch {
        // The callback is already invalidated by the sequence guard.
      }
      return;
    }
    this.errorClearCancel = cancel;
  }

  private publishTerminalIdle(error: string | undefined): void {
    this.clearErrorClear();
    this.publishIdle(error);
    if (
      error !== undefined
      && this.active === undefined
      && this.stateValue.kind === "idle"
      && this.stateValue.error === error
    ) this.armErrorClear();
  }

  private publish(state: SpeechInputControllerState): void {
    this.stateValue = state;
    if (!this.disposed) this.callbacks.onStateChange(this.state);
  }
}

/** Production-only assembly for browser recognition and gateway-backed recording. */
export function createDefaultSpeechInputController(callbacks: SpeechInputControllerCallbacks): SpeechInputController {
  return new SpeechInputController({
    browser: new SpeechRecognitionAdapter({ isSecureContext: globalThis.isSecureContext }),
    cloud: new MediaRecorderAdapter(),
    callbacks,
  });
}

function cloneSettings(settings: SpeechInputSettingsResponse): SpeechInputSettingsResponse {
  return {
    contractVersion: settings.contractVersion,
    revision: settings.revision,
    settings: {
      provider: settings.settings.provider,
      ...(settings.settings.language === undefined ? {} : { language: settings.settings.language }),
      cloud: { ...settings.settings.cloud },
    },
    credential: { ...settings.credential },
  };
}

function cloneTarget(target: SpeechInputTargetSnapshot): SpeechInputTargetSnapshot {
  return {
    identity: { ...target.identity },
    text: target.text,
    from: target.from,
    to: target.to,
  };
}

function normalizedProviderError(error: SpeechInputProviderError): string {
  const message = error.message.trim();
  return message === "" ? CONTROLLER_FAILURE_ERROR : message;
}

function normalizedAvailabilityReason(reason: string): string {
  const normalized = reason.trim();
  return normalized === "" ? ADAPTER_UNAVAILABLE_REASON : normalized;
}

function finalOutcomeError(outcome: ReturnType<SpeechInputControllerCallbacks["onFinal"]>): string | undefined {
  switch (outcome) {
    case "inserted":
      return undefined;
    case "empty":
      return EMPTY_TRANSCRIPT_ERROR;
    case "changed":
      return CHANGED_DRAFT_ERROR;
    case "too-large":
      return TOO_LARGE_TRANSCRIPT_ERROR;
  }
}

function defaultNow(): number {
  return globalThis.performance.now();
}

function defaultScheduleInterval(callback: () => void, delayMs: number): () => void {
  const timer = globalThis.setInterval(callback, delayMs);
  return () => {
    globalThis.clearInterval(timer);
  };
}

function defaultScheduleDeadline(callback: () => void, delayMs: number): () => void {
  const timer = globalThis.setTimeout(callback, delayMs);
  return () => {
    globalThis.clearTimeout(timer);
  };
}

function defaultRunId(): string {
  const browserCrypto = globalThis.crypto;
  if (typeof browserCrypto.randomUUID === "function") return browserCrypto.randomUUID();
  const bytes = browserCrypto.getRandomValues(new Uint8Array(16));
  return `r${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
