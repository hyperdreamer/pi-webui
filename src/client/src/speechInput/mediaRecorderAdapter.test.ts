import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpeechInputTranscribeResponse } from "../../../shared/apiTypes";
import { SPEECH_INPUT_MAX_AUDIO_BYTES, type SpeechInputAudioMimeType } from "../../../shared/speechInputAudio";
import { HttpRequestError } from "../api/http";
import {
  MediaRecorderAdapter,
  type SpeechMediaHost,
  type SpeechMediaRecorder,
  type SpeechMediaStream,
  type SpeechMediaTrack,
} from "./mediaRecorderAdapter";
import type {
  SpeechInputProviderCallbacks,
  SpeechInputProviderError,
  SpeechInputProviderRun,
} from "./speechInputProvider";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      const resolve = resolvePromise;
      if (resolve === undefined) throw new Error("missing deferred resolver");
      resolve(value);
    },
    reject(error) {
      const reject = rejectPromise;
      if (reject === undefined) throw new Error("missing deferred rejecter");
      reject(error);
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

class FakeTrack implements SpeechMediaTrack {
  stops = 0;

  stop(): void {
    this.stops += 1;
  }
}

class FakeStream implements SpeechMediaStream {
  constructor(readonly tracks: readonly FakeTrack[]) {}

  getTracks(): readonly SpeechMediaTrack[] {
    return this.tracks;
  }
}

/** A structural MediaRecorder fake whose handlers can be emitted after cleanup. */
class FakeRecorder implements SpeechMediaRecorder {
  readonly startCalls: number[] = [];
  stopCalls = 0;
  startFailure: Error | undefined;
  stopFailure: Error | undefined;
  stopOrder: string[] | undefined;
  startUnsubscribes = 0;
  dataUnsubscribes = 0;
  stopUnsubscribes = 0;
  errorUnsubscribes = 0;
  private readonly startListeners = new Set<() => void>();
  private readonly dataListeners = new Set<(data: Blob) => void>();
  private readonly stopListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: unknown) => void>();

  constructor(readonly mimeType: string) {}

  onStart(listener: () => void): () => void {
    this.startListeners.add(listener);
    return () => {
      this.startUnsubscribes += 1;
      this.startListeners.delete(listener);
    };
  }

  onData(listener: (data: Blob) => void): () => void {
    this.dataListeners.add(listener);
    return () => {
      this.dataUnsubscribes += 1;
      this.dataListeners.delete(listener);
    };
  }

  onStop(listener: () => void): () => void {
    this.stopListeners.add(listener);
    return () => {
      this.stopUnsubscribes += 1;
      this.stopListeners.delete(listener);
    };
  }

  onError(listener: (error: unknown) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorUnsubscribes += 1;
      this.errorListeners.delete(listener);
    };
  }

  start(timesliceMs: number): void {
    this.startCalls.push(timesliceMs);
    if (this.startFailure !== undefined) throw this.startFailure;
  }

  stop(): void {
    this.stopCalls += 1;
    this.stopOrder?.push("recorder-stop");
    if (this.stopFailure !== undefined) throw this.stopFailure;
  }

  emitStart(): void {
    for (const listener of this.startListeners) listener();
  }

  emitData(data: Blob): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitStop(): void {
    for (const listener of this.stopListeners) listener();
  }

  emitError(error: unknown): void {
    for (const listener of this.errorListeners) listener(error);
  }

  listenerCount(): number {
    return this.startListeners.size + this.dataListeners.size + this.stopListeners.size + this.errorListeners.size;
  }
}

interface TranscribeCall {
  audio: Blob;
  mimeType: SpeechInputAudioMimeType;
  signal: AbortSignal;
}

class FakeHost implements SpeechMediaHost {
  secureContext = true;
  readonly permission = deferred<SpeechMediaStream>();
  readonly transcription = deferred<SpeechInputTranscribeResponse>();
  readonly supportedMimeTypes = new Set<string>();
  readonly requestedMimeTypes: string[] = [];
  readonly createRecorderCalls: { stream: SpeechMediaStream; mimeType: SpeechInputAudioMimeType }[] = [];
  readonly transcribeCalls: TranscribeCall[] = [];
  getUserMediaCalls = 0;
  getUserMediaFailure: Error | undefined;
  createRecorderFailure: Error | undefined;
  transcribeImplementation:
    | ((audio: Blob, mimeType: SpeechInputAudioMimeType, signal: AbortSignal) => Promise<SpeechInputTranscribeResponse>)
    | undefined;
  createdRecorder: SpeechMediaRecorder | undefined;

  constructor(readonly recorder: SpeechMediaRecorder) {}

  getUserMedia(): Promise<SpeechMediaStream> {
    this.getUserMediaCalls += 1;
    if (this.getUserMediaFailure !== undefined) throw this.getUserMediaFailure;
    return this.permission.promise;
  }

  isTypeSupported(type: string): boolean {
    this.requestedMimeTypes.push(type);
    return this.supportedMimeTypes.has(type);
  }

  createRecorder(stream: SpeechMediaStream, mimeType: SpeechInputAudioMimeType): SpeechMediaRecorder {
    this.createRecorderCalls.push({ stream, mimeType });
    if (this.createRecorderFailure !== undefined) throw this.createRecorderFailure;
    this.createdRecorder = this.recorder;
    return this.recorder;
  }

  transcribe(audio: Blob, mimeType: SpeechInputAudioMimeType, signal: AbortSignal): Promise<SpeechInputTranscribeResponse> {
    this.transcribeCalls.push({ audio, mimeType, signal });
    return this.transcribeImplementation?.(audio, mimeType, signal) ?? this.transcription.promise;
  }
}

interface CallbackLog {
  listening: number;
  interim: string[];
  transcribing: number;
  completed: string[];
  errors: SpeechInputProviderError[];
}

function recordCallbacks(order?: string[]): { callbacks: SpeechInputProviderCallbacks; log: CallbackLog } {
  const log: CallbackLog = { listening: 0, interim: [], transcribing: 0, completed: [], errors: [] };
  return {
    callbacks: {
      onListening: () => {
        log.listening += 1;
      },
      onInterim: (text) => {
        log.interim.push(text);
      },
      onTranscribing: () => {
        log.transcribing += 1;
        order?.push("transcribing");
      },
      onComplete: (text) => {
        log.completed.push(text);
      },
      onError: (error) => {
        log.errors.push(error);
      },
    },
    log,
  };
}

interface Harness {
  adapter: MediaRecorderAdapter;
  host: FakeHost;
  stream: FakeStream;
  tracks: readonly FakeTrack[];
  recorder: FakeRecorder;
}

function createHarness(options: {
  actualMimeType?: string;
  secureContext?: boolean;
  supportedMimeTypes?: readonly string[];
} = {}): Harness {
  const tracks = [new FakeTrack(), new FakeTrack()];
  const stream = new FakeStream(tracks);
  const recorder = new FakeRecorder(options.actualMimeType ?? "audio/webm;codecs=opus");
  const host = new FakeHost(recorder);
  host.secureContext = options.secureContext ?? true;
  for (const mimeType of options.supportedMimeTypes ?? ["audio/webm;codecs=opus"]) {
    host.supportedMimeTypes.add(mimeType);
  }
  return { adapter: new MediaRecorderAdapter(host), host, stream, tracks, recorder };
}

function startRun(harness: Harness, order?: string[]): { run: SpeechInputProviderRun; log: CallbackLog } {
  const { callbacks, log } = recordCallbacks(order);
  return { run: harness.adapter.start({ callbacks }), log };
}

async function grantPermission(harness: Harness): Promise<void> {
  harness.host.permission.resolve(harness.stream);
  await flushMicrotasks();
}

function expectTracksStoppedOnce(tracks: readonly FakeTrack[]): void {
  for (const track of tracks) expect(track.stops).toBe(1);
}

function expectRecorderReleased(recorder: FakeRecorder, tracks: readonly FakeTrack[]): void {
  expect(recorder.listenerCount()).toBe(0);
  expect(recorder.startUnsubscribes).toBe(1);
  expect(recorder.dataUnsubscribes).toBe(1);
  expect(recorder.stopUnsubscribes).toBe(1);
  expect(recorder.errorUnsubscribes).toBe(1);
  expectTracksStoppedOnce(tracks);
}

class DefaultHostNativeRecorder {
  static readonly instances: DefaultHostNativeRecorder[] = [];
  static supportedMimeType = "audio/webm;codecs=opus";
  readonly startCalls: number[] = [];
  stopCalls = 0;
  readonly mimeType: string;
  readonly options: { mimeType?: string };
  private readonly listeners = new Map<string, Set<(event: { data?: Blob }) => void>>();

  static isTypeSupported(type: string): boolean {
    return type === DefaultHostNativeRecorder.supportedMimeType;
  }

  constructor(readonly stream: unknown, options: { mimeType?: string } = {}) {
    this.options = options;
    this.mimeType = options.mimeType ?? "";
    DefaultHostNativeRecorder.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: Blob }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: { data?: Blob }) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: { data?: Blob }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  start(timesliceMs: number): void {
    this.startCalls.push(timesliceMs);
  }

  stop(): void {
    this.stopCalls += 1;
  }

  emit(type: string, data?: Blob): void {
    const event = data === undefined ? {} : { data };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("MediaRecorderAdapter availability", () => {
  it("reports an insecure context before probing recorder formats", () => {
    const harness = createHarness({ secureContext: false });

    expect(harness.adapter.availability()).toEqual({
      available: false,
      reason: "Speech input requires a secure browser context",
    });
    expect(harness.host.requestedMimeTypes).toEqual([]);
  });

  it("requires one accepted recorder format", () => {
    const harness = createHarness({ supportedMimeTypes: [] });

    expect(harness.adapter.availability()).toEqual({ available: false, reason: "No accepted recorder format" });
    expect(harness.host.requestedMimeTypes).toEqual([
      "audio/webm;codecs=opus",
      "audio/ogg;codecs=opus",
      "audio/mp4;codecs=mp4a.40.2",
      "audio/mp4",
    ]);
  });
});

describe("default browser host", () => {
  it("reports unavailable when navigator has no mediaDevices API", () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("MediaRecorder", DefaultHostNativeRecorder);
    const adapter = new MediaRecorderAdapter();

    expect(adapter.availability()).toEqual({ available: false, reason: "No accepted recorder format" });
  });

  it("requests exact audio, passes the selected MIME, starts at one-second intervals, and waits for recorder start", async () => {
    DefaultHostNativeRecorder.instances.length = 0;
    const tracks = [new FakeTrack()];
    const stream = new FakeStream(tracks);
    const getUserMedia = vi.fn(() => Promise.resolve(stream));
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("MediaRecorder", DefaultHostNativeRecorder);
    const adapter = new MediaRecorderAdapter();
    const { callbacks, log } = recordCallbacks();

    const run = adapter.start({ callbacks });
    await flushMicrotasks();
    const recorder = DefaultHostNativeRecorder.instances[0];
    if (recorder === undefined) throw new Error("expected native recorder");

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(recorder.options).toEqual({ mimeType: "audio/webm;codecs=opus" });
    expect(recorder.startCalls).toEqual([1000]);
    expect(log.listening).toBe(0);
    recorder.emit("start");
    expect(log.listening).toBe(1);

    run.cancel();
    expectTracksStoppedOnce(tracks);
  });
});

describe("permission and recorder setup", () => {
  it("normalizes permission denial and never constructs a recorder", async () => {
    const harness = createHarness();
    const { log } = startRun(harness);

    harness.host.permission.reject({ name: "NotAllowedError" });
    await flushMicrotasks();

    expect(log.errors).toEqual([{ code: "permission-denied", message: "Microphone permission denied" }]);
    expect(harness.host.createRecorderCalls).toEqual([]);
    expect(harness.recorder.listenerCount()).toBe(0);
    expect(harness.recorder.startUnsubscribes).toBe(0);
    expect(harness.tracks.map((track) => track.stops)).toEqual([0, 0]);
  });

  it("cancels pending permission and stops every late track without callbacks or recorder construction", async () => {
    const harness = createHarness();
    const { run, log } = startRun(harness);

    run.cancel();
    harness.host.permission.resolve(harness.stream);
    await flushMicrotasks();

    expect(harness.host.createRecorderCalls).toEqual([]);
    expect(log).toEqual({ listening: 0, interim: [], transcribing: 0, completed: [], errors: [] });
    expectTracksStoppedOnce(harness.tracks);
    expect(harness.recorder.listenerCount()).toBe(0);
    expect(harness.recorder.startUnsubscribes).toBe(0);
    expect(harness.recorder.dataUnsubscribes).toBe(0);
    expect(harness.recorder.stopUnsubscribes).toBe(0);
    expect(harness.recorder.errorUnsubscribes).toBe(0);
  });

  it("normalizes and revalidates the recorder's actual MIME before recording", async () => {
    const harness = createHarness({ actualMimeType: " AUDIO/MP4 " });
    const { run, log } = startRun(harness);
    await grantPermission(harness);
    harness.recorder.emitStart();
    harness.recorder.emitData(new Blob(["audio"]));
    run.stop();
    harness.recorder.emitStop();

    expect(harness.host.transcribeCalls).toHaveLength(1);
    expect(harness.host.transcribeCalls[0]?.mimeType).toBe("audio/mp4");
    harness.host.transcription.resolve({ text: "transcript" });
    await flushMicrotasks();
    expect(log.completed).toEqual(["transcript"]);
  });

  it("rejects an unsupported actual recorder MIME before recording and releases tracks", async () => {
    const harness = createHarness({ actualMimeType: "audio/webm;codecs=vorbis" });
    const { log } = startRun(harness);
    await grantPermission(harness);

    expect(log.errors).toEqual([{ code: "unsupported", message: "No accepted recorder format" }]);
    expect(harness.recorder.startCalls).toEqual([]);
    expect(harness.recorder.listenerCount()).toBe(0);
    expect(harness.recorder.startUnsubscribes).toBe(0);
    expect(harness.recorder.dataUnsubscribes).toBe(0);
    expect(harness.recorder.stopUnsubscribes).toBe(0);
    expect(harness.recorder.errorUnsubscribes).toBe(0);
    expectTracksStoppedOnce(harness.tracks);
  });

  it("cleans up listener registrations and tracks when recorder start throws", async () => {
    const harness = createHarness();
    harness.recorder.startFailure = new Error("start failed");
    const { log } = startRun(harness);
    await grantPermission(harness);

    expect(log.errors).toEqual([{ code: "microphone-unavailable", message: "Microphone is unavailable" }]);
    expectRecorderReleased(harness.recorder, harness.tracks);
  });

  it("fails construction safely before listeners are registered", async () => {
    const harness = createHarness();
    harness.host.createRecorderFailure = new Error("constructor failed");
    const { log } = startRun(harness);
    await grantPermission(harness);

    expect(log.errors).toEqual([{ code: "microphone-unavailable", message: "Microphone is unavailable" }]);
    expect(harness.recorder.listenerCount()).toBe(0);
    expect(harness.recorder.startUnsubscribes).toBe(0);
    expect(harness.recorder.dataUnsubscribes).toBe(0);
    expect(harness.recorder.stopUnsubscribes).toBe(0);
    expect(harness.recorder.errorUnsubscribes).toBe(0);
    expectTracksStoppedOnce(harness.tracks);
  });
});

describe("recording lifecycle", () => {
  it("emits Transcribing synchronously before a single recorder stop and uploads final data", async () => {
    const harness = createHarness();
    const order: string[] = [];
    harness.recorder.stopOrder = order;
    const { run, log } = startRun(harness, order);
    await grantPermission(harness);
    harness.recorder.emitStart();
    harness.recorder.emitData(new Blob(["final audio"], { type: "audio/webm;codecs=opus" }));

    run.stop();
    run.stop();
    expect(order).toEqual(["transcribing", "recorder-stop"]);
    expect(log.transcribing).toBe(1);
    expect(harness.recorder.stopCalls).toBe(1);
    expect(harness.host.transcribeCalls).toEqual([]);

    harness.recorder.emitStop();
    expect(harness.host.transcribeCalls).toHaveLength(1);
    const call = harness.host.transcribeCalls[0];
    if (call === undefined) throw new Error("missing transcription call");
    expect(call.audio.size).toBe(11);
    expect(call.audio.type).toBe("audio/webm;codecs=opus");
    expect(call.mimeType).toBe("audio/webm;codecs=opus");
    expect(call.signal.aborted).toBe(false);

    harness.host.transcription.resolve({ text: "exact transcript" });
    await flushMicrotasks();
    expect(log.completed).toEqual(["exact transcript"]);
    expect(log.errors).toEqual([]);
    expectRecorderReleased(harness.recorder, harness.tracks);
  });

  it("ignores Stop after recorder finalization while transcription is pending", async () => {
    const harness = createHarness();
    const { run, log } = startRun(harness);
    await grantPermission(harness);
    harness.recorder.emitData(new Blob(["audio"]));
    harness.recorder.emitStop();
    const call = harness.host.transcribeCalls[0];
    if (call === undefined) throw new Error("missing transcription call");
    harness.recorder.stopFailure = new Error("recorder is inactive");

    run.stop();

    expect.soft(harness.recorder.stopCalls).toBe(0);
    expect.soft(call.signal.aborted).toBe(false);
    expect.soft(log.errors).toEqual([]);
    harness.host.transcription.resolve({ text: "natural finalization transcript" });
    await flushMicrotasks();
    expect(log.completed).toEqual(["natural finalization transcript"]);
    expectRecorderReleased(harness.recorder, harness.tracks);
  });

  it("retains final data emitted after Stop but before recorder stop, then starts one upload", async () => {
    const harness = createHarness();
    const { run, log } = startRun(harness);
    await grantPermission(harness);
    harness.recorder.emitData(new Blob(["first "]));

    run.stop();
    harness.recorder.emitData(new Blob(["final"]));
    harness.recorder.emitStop();
    harness.recorder.emitStop();

    expect(harness.host.transcribeCalls).toHaveLength(1);
    const call = harness.host.transcribeCalls[0];
    if (call === undefined) throw new Error("missing transcription call");
    expect(await call.audio.text()).toBe("first final");
    harness.host.transcription.resolve({ text: "result" });
    await flushMicrotasks();
    expect(log.completed).toEqual(["result"]);
  });

  it("reports no speech when the final recording has no retained bytes", async () => {
    const harness = createHarness();
    const { run, log } = startRun(harness);
    await grantPermission(harness);
    run.stop();
    harness.recorder.emitStop();

    expect(harness.host.transcribeCalls).toEqual([]);
    expect(log.completed).toEqual([]);
    expect(log.errors).toEqual([{ code: "no-speech", message: "No speech detected" }]);
    expectRecorderReleased(harness.recorder, harness.tracks);
  });

  it("reports microphone unavailable once when stop throws synchronously", async () => {
    const harness = createHarness();
    harness.recorder.stopFailure = new Error("stop failed");
    const { run, log } = startRun(harness);
    await grantPermission(harness);

    run.stop();
    run.stop();
    expect(log.transcribing).toBe(1);
    expect(log.errors).toEqual([{ code: "microphone-unavailable", message: "Microphone is unavailable" }]);
    expect(harness.recorder.stopCalls).toBe(1);
    expectRecorderReleased(harness.recorder, harness.tracks);
  });

  it("normalizes an asynchronous recorder error and ignores late events", async () => {
    const harness = createHarness();
    const { log } = startRun(harness);
    await grantPermission(harness);
    harness.recorder.emitError(new Error("device disconnected"));
    harness.recorder.emitStart();
    harness.recorder.emitData(new Blob(["ignored"]));
    harness.recorder.emitStop();

    expect(log.errors).toEqual([{ code: "microphone-unavailable", message: "Microphone is unavailable" }]);
    expect(log.listening).toBe(0);
    expect(harness.host.transcribeCalls).toEqual([]);
    expectRecorderReleased(harness.recorder, harness.tracks);
  });

  it("stops exactly at 20 MiB and uploads the intact recording", async () => {
    const harness = createHarness();
    const { log } = startRun(harness);
    await grantPermission(harness);
    const exactLimit = new Blob([new Uint8Array(SPEECH_INPUT_MAX_AUDIO_BYTES)], { type: "audio/webm;codecs=opus" });

    harness.recorder.emitData(exactLimit);
    expect(log.transcribing).toBe(1);
    expect(harness.recorder.stopCalls).toBe(1);
    harness.recorder.emitStop();
    const call = harness.host.transcribeCalls[0];
    if (call === undefined) throw new Error("missing transcription call");
    expect(call.audio.size).toBe(SPEECH_INPUT_MAX_AUDIO_BYTES);
    harness.host.transcription.resolve({ text: "full capture" });
    await flushMicrotasks();
    expect(log.completed).toEqual(["full capture"]);
  });

  it("discards every chunk and reports recording-limit when a final chunk crosses 20 MiB", async () => {
    const harness = createHarness();
    const createObjectURL = vi.fn();
    const storageSetItem = vi.fn();
    vi.stubGlobal("URL", { createObjectURL });
    vi.stubGlobal("localStorage", { setItem: storageSetItem });
    const { log } = startRun(harness);
    await grantPermission(harness);
    harness.recorder.emitData(new Blob([new Uint8Array(SPEECH_INPUT_MAX_AUDIO_BYTES)]));
    harness.recorder.emitData(new Blob([new Uint8Array(1)]));
    harness.recorder.emitStop();

    expect(log.errors).toEqual([{ code: "recording-limit", message: "Speech recording exceeded the 20 MiB limit" }]);
    expect(harness.host.transcribeCalls).toEqual([]);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(storageSetItem).not.toHaveBeenCalled();
    expectRecorderReleased(harness.recorder, harness.tracks);
  });
});

describe("cancellation", () => {
  it("cancels active recording silently, releases all resources once, and suppresses late recorder events", async () => {
    const harness = createHarness();
    const { run, log } = startRun(harness);
    await grantPermission(harness);
    harness.recorder.emitStart();

    run.cancel();
    run.cancel();
    harness.recorder.emitData(new Blob(["ignored"]));
    harness.recorder.emitStop();
    harness.recorder.emitError(new Error("ignored"));
    harness.recorder.emitStart();

    expect(log).toEqual({ listening: 1, interim: [], transcribing: 0, completed: [], errors: [] });
    expect(harness.host.transcribeCalls).toEqual([]);
    expect(harness.recorder.stopCalls).toBe(1);
    expectRecorderReleased(harness.recorder, harness.tracks);
  });

  it("aborts an in-flight upload and suppresses a late completion", async () => {
    const harness = createHarness();
    const { run, log } = startRun(harness);
    await grantPermission(harness);
    harness.recorder.emitData(new Blob(["audio"]));
    run.stop();
    harness.recorder.emitStop();
    const call = harness.host.transcribeCalls[0];
    if (call === undefined) throw new Error("missing transcription call");

    run.cancel();
    run.cancel();
    expect(call.signal.aborted).toBe(true);
    harness.host.transcription.resolve({ text: "late transcript" });
    await flushMicrotasks();

    expect(log.completed).toEqual([]);
    expect(log.errors).toEqual([]);
    expectRecorderReleased(harness.recorder, harness.tracks);
  });

  it("cancels a stalled recorder finalization, clears captured data, and suppresses every later event", async () => {
    const harness = createHarness();
    const { run, log } = startRun(harness);
    await grantPermission(harness);
    harness.recorder.emitData(new Blob(["captured"]));
    run.stop();

    run.cancel();
    harness.recorder.emitData(new Blob(["late"]));
    harness.recorder.emitStop();
    harness.recorder.emitError(new Error("late error"));

    expect(harness.host.transcribeCalls).toEqual([]);
    expect(log.completed).toEqual([]);
    expect(log.errors).toEqual([]);
    expectRecorderReleased(harness.recorder, harness.tracks);
  });
});

describe("upload failures", () => {
  const httpFailures: readonly [number, HttpRequestError, SpeechInputProviderError["code"], string][] = [
    [413, new HttpRequestError("secret gateway message", 413), "recording-limit", "Speech recording exceeded the 20 MiB limit"],
    [429, new HttpRequestError("secret gateway message", 429), "provider", "Speech transcription is busy. Try again."],
    [503, new HttpRequestError("secret gateway message", 503), "provider", "Speech transcription is unavailable."],
    [504, new HttpRequestError("secret gateway message", 504), "provider", "Speech transcription timed out."],
  ];

  it.each(httpFailures)("normalizes HTTP %i without forwarding the gateway message", async (_status, failure, code, message) => {
    const harness = createHarness();
    const { run, log } = startRun(harness);
    await grantPermission(harness);
    harness.recorder.emitData(new Blob(["audio"]));
    run.stop();
    harness.recorder.emitStop();
    harness.host.transcription.reject(failure);
    await flushMicrotasks();

    expect(log.errors).toEqual([{ code, message }]);
    expect(log.errors[0]?.message).not.toContain("secret gateway message");
    expectRecorderReleased(harness.recorder, harness.tracks);
  });

  it("normalizes socket closures and does not forward an injected secret-bearing error", async () => {
    const harness = createHarness();
    const { run, log } = startRun(harness);
    await grantPermission(harness);
    harness.recorder.emitData(new Blob(["audio"]));
    run.stop();
    harness.recorder.emitStop();
    harness.host.transcription.reject(new Error("upload timeout socket closed: api-key=secret"));
    await flushMicrotasks();

    expect(log.errors).toEqual([{ code: "network", message: "Speech transcription network error" }]);
    expect(log.errors[0]?.message).not.toContain("api-key=secret");
  });

  it("treats malformed transcription responses as a safe provider error", async () => {
    const harness = createHarness();
    harness.host.transcribeImplementation = () => Promise.resolve(JSON.parse('{"text":42}'));
    const { run, log } = startRun(harness);
    await grantPermission(harness);
    harness.recorder.emitData(new Blob(["audio"]));
    run.stop();
    harness.recorder.emitStop();
    await flushMicrotasks();

    expect(log.errors).toEqual([{ code: "provider", message: "Speech transcription failed" }]);
    expectRecorderReleased(harness.recorder, harness.tracks);
  });

  it("reports no-speech when the gateway result is blank", async () => {
    const harness = createHarness();
    harness.host.transcribeImplementation = () => Promise.resolve(JSON.parse('{"text":"   "}'));
    const { run, log } = startRun(harness);
    await grantPermission(harness);
    harness.recorder.emitData(new Blob(["audio"]));
    run.stop();
    harness.recorder.emitStop();
    await flushMicrotasks();

    expect(log.errors).toEqual([{ code: "no-speech", message: "No speech detected" }]);
  });
});
