import type { SpeechInputTranscribeResponse } from "../../../shared/apiTypes";
import {
  parseSpeechInputAudioMimeType,
  SPEECH_INPUT_MAX_AUDIO_BYTES,
  type SpeechInputAudioMimeType,
} from "../../../shared/speechInputAudio";
import { HttpRequestError, speechInputApi } from "../api";
import {
  chooseSpeechInputAudioMimeType,
  type SpeechInputAvailability,
} from "./speechInputCore";
import type {
  SpeechInputProviderAdapter,
  SpeechInputProviderCallbacks,
  SpeechInputProviderError,
  SpeechInputProviderRun,
} from "./speechInputProvider";

const TIMESLICE_MS = 1000;
const INSECURE_CONTEXT_REASON = "Speech input requires a secure browser context";
const NO_ACCEPTED_FORMAT_REASON = "No accepted recorder format";

const PERMISSION_DENIED_ERROR: SpeechInputProviderError = {
  code: "permission-denied",
  message: "Microphone permission denied",
};
const MICROPHONE_UNAVAILABLE_ERROR: SpeechInputProviderError = {
  code: "microphone-unavailable",
  message: "Microphone is unavailable",
};
const NO_SPEECH_ERROR: SpeechInputProviderError = {
  code: "no-speech",
  message: "No speech detected",
};
const UNSUPPORTED_FORMAT_ERROR: SpeechInputProviderError = {
  code: "unsupported",
  message: NO_ACCEPTED_FORMAT_REASON,
};
const RECORDING_LIMIT_ERROR: SpeechInputProviderError = {
  code: "recording-limit",
  message: "Speech recording exceeded the 20 MiB limit",
};
const TRANSCRIPTION_BUSY_ERROR: SpeechInputProviderError = {
  code: "provider",
  message: "Speech transcription is busy. Try again.",
};
const TRANSCRIPTION_UNAVAILABLE_ERROR: SpeechInputProviderError = {
  code: "provider",
  message: "Speech transcription is unavailable.",
};
const TRANSCRIPTION_TIMEOUT_ERROR: SpeechInputProviderError = {
  code: "provider",
  message: "Speech transcription timed out.",
};
const TRANSCRIPTION_NETWORK_ERROR: SpeechInputProviderError = {
  code: "network",
  message: "Speech transcription network error",
};
const TRANSCRIPTION_FAILED_ERROR: SpeechInputProviderError = {
  code: "provider",
  message: "Speech transcription failed",
};

export interface SpeechMediaTrack {
  stop(): void;
}

export interface SpeechMediaStream {
  getTracks(): readonly SpeechMediaTrack[];
}

export interface SpeechMediaRecorder {
  readonly mimeType: string;
  onStart(listener: () => void): () => void;
  onData(listener: (data: Blob) => void): () => void;
  onStop(listener: () => void): () => void;
  onError(listener: (error: unknown) => void): () => void;
  start(timesliceMs: number): void;
  stop(): void;
}

export interface SpeechMediaHost {
  secureContext: boolean;
  getUserMedia(): Promise<SpeechMediaStream>;
  isTypeSupported(type: string): boolean;
  createRecorder(stream: SpeechMediaStream, mimeType: SpeechInputAudioMimeType): SpeechMediaRecorder;
  transcribe(audio: Blob, mimeType: SpeechInputAudioMimeType, signal: AbortSignal): Promise<SpeechInputTranscribeResponse>;
}

/** Maps the native recorder's event API to the small structural adapter seam. */
class BrowserSpeechMediaRecorder implements SpeechMediaRecorder {
  readonly mimeType: string;

  constructor(private readonly recorder: MediaRecorder) {
    this.mimeType = recorder.mimeType;
  }

  onStart(listener: () => void): () => void {
    const handler = (): void => {
      listener();
    };
    this.recorder.addEventListener("start", handler);
    return () => {
      this.recorder.removeEventListener("start", handler);
    };
  }

  onData(listener: (data: Blob) => void): () => void {
    const handler = (event: BlobEvent): void => {
      listener(event.data);
    };
    this.recorder.addEventListener("dataavailable", handler);
    return () => {
      this.recorder.removeEventListener("dataavailable", handler);
    };
  }

  onStop(listener: () => void): () => void {
    const handler = (): void => {
      listener();
    };
    this.recorder.addEventListener("stop", handler);
    return () => {
      this.recorder.removeEventListener("stop", handler);
    };
  }

  onError(listener: (error: unknown) => void): () => void {
    const handler = (event: Event): void => {
      listener(event);
    };
    this.recorder.addEventListener("error", handler);
    return () => {
      this.recorder.removeEventListener("error", handler);
    };
  }

  start(timesliceMs: number): void {
    this.recorder.start(timesliceMs);
  }

  stop(): void {
    this.recorder.stop();
  }
}

/** Retains the native stream without widening the injected structural seam. */
class BrowserSpeechMediaStream implements SpeechMediaStream {
  constructor(readonly nativeStream: MediaStream) {}

  getTracks(): readonly SpeechMediaTrack[] {
    return this.nativeStream.getTracks();
  }
}

function hasBrowserMediaDevices(value: unknown): value is Pick<MediaDevices, "getUserMedia"> {
  return typeof value === "object"
    && value !== null
    && typeof Reflect.get(value, "getUserMedia") === "function";
}

function browserMediaDevices(): Pick<MediaDevices, "getUserMedia"> | undefined {
  const browserNavigator: unknown = Reflect.get(globalThis, "navigator");
  if (typeof browserNavigator !== "object" || browserNavigator === null) return undefined;
  const mediaDevices: unknown = Reflect.get(browserNavigator, "mediaDevices");
  return hasBrowserMediaDevices(mediaDevices) ? mediaDevices : undefined;
}

function browserMediaApisAvailable(): boolean {
  return browserMediaDevices() !== undefined && typeof MediaRecorder !== "undefined";
}

function createDefaultHost(): SpeechMediaHost {
  return {
    secureContext: globalThis.isSecureContext,
    getUserMedia: async () => {
      const mediaDevices = browserMediaDevices();
      if (mediaDevices === undefined) throw new Error("Browser microphone capture is unavailable");
      return new BrowserSpeechMediaStream(await mediaDevices.getUserMedia({ audio: true }));
    },
    isTypeSupported: (type) => {
      if (!browserMediaApisAvailable()) return false;
      try {
        return MediaRecorder.isTypeSupported(type);
      } catch {
        return false;
      }
    },
    createRecorder: (stream, mimeType) => {
      if (!(stream instanceof BrowserSpeechMediaStream)) throw new Error("Expected browser media stream");
      const recorder = new MediaRecorder(stream.nativeStream, { mimeType });
      return new BrowserSpeechMediaRecorder(recorder);
    },
    transcribe: (audio, mimeType, signal) => speechInputApi.transcribe(audio, mimeType, signal),
  };
}

function selectedMimeType(host: SpeechMediaHost): SpeechInputAudioMimeType | undefined {
  try {
    return chooseSpeechInputAudioMimeType((type) => host.isTypeSupported(type));
  } catch {
    return undefined;
  }
}

function isPermissionDenied(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name: unknown = Reflect.get(error, "name");
  return name === "NotAllowedError" || name === "PermissionDeniedError";
}

function normalizeUploadError(error: unknown): SpeechInputProviderError {
  if (error instanceof HttpRequestError) {
    switch (error.status) {
      case 413:
        return RECORDING_LIMIT_ERROR;
      case 429:
        return TRANSCRIPTION_BUSY_ERROR;
      case 503:
        return TRANSCRIPTION_UNAVAILABLE_ERROR;
      case 504:
        return TRANSCRIPTION_TIMEOUT_ERROR;
      default:
        return TRANSCRIPTION_FAILED_ERROR;
    }
  }
  return TRANSCRIPTION_NETWORK_ERROR;
}

function transcriptText(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const text: unknown = Reflect.get(response, "text");
  return typeof text === "string" ? text : undefined;
}

function stopTracks(stream: SpeechMediaStream | undefined): void {
  if (stream === undefined) return;
  const stopped = new Set<SpeechMediaTrack>();
  for (const track of stream.getTracks()) {
    if (stopped.has(track)) continue;
    stopped.add(track);
    try {
      track.stop();
    } catch {
      // Track cleanup remains best-effort if a browser has already ended it.
    }
  }
}

/** A no-op run used after synchronous unavailability before any media is requested. */
const SILENT_RUN: SpeechInputProviderRun = {
  stop: () => undefined,
  cancel: () => undefined,
};

export class MediaRecorderAdapter implements SpeechInputProviderAdapter {
  readonly id = "cloud" as const;

  private readonly host: SpeechMediaHost;

  constructor(host: SpeechMediaHost = createDefaultHost()) {
    this.host = host;
  }

  availability(): SpeechInputAvailability {
    if (!this.host.secureContext) {
      return { available: false, reason: INSECURE_CONTEXT_REASON };
    }
    return selectedMimeType(this.host) === undefined
      ? { available: false, reason: NO_ACCEPTED_FORMAT_REASON }
      : { available: true };
  }

  start(input: { language?: string; callbacks: SpeechInputProviderCallbacks }): SpeechInputProviderRun {
    const callbacks = input.callbacks;
    if (!this.host.secureContext) {
      callbacks.onError({ code: "unsupported", message: INSECURE_CONTEXT_REASON });
      return SILENT_RUN;
    }

    const requestedMimeType = selectedMimeType(this.host);
    if (requestedMimeType === undefined) {
      callbacks.onError(UNSUPPORTED_FORMAT_ERROR);
      return SILENT_RUN;
    }

    let terminal = false;
    let stopRequested = false;
    let recorderStopCalled = false;
    let recorderStopObserved = false;
    let transcribing = false;
    let uploadStarted = false;
    let stream: SpeechMediaStream | undefined;
    let recorder: SpeechMediaRecorder | undefined;
    let mimeType: SpeechInputAudioMimeType | undefined;
    let retainedBytes = 0;
    let chunks: Blob[] = [];
    let audio: Blob | undefined;
    let uploadController: AbortController | undefined;
    const unsubscribes: (() => void)[] = [];

    const finish = (options: { abortUpload?: boolean } = {}): boolean => {
      if (terminal) return false;
      terminal = true;

      const listeners = unsubscribes.splice(0);
      for (const unsubscribe of listeners) {
        try {
          unsubscribe();
        } catch {
          // One defective browser listener must not retain the other handles.
        }
      }

      const controller = uploadController;
      uploadController = undefined;
      if (options.abortUpload === true) {
        try {
          controller?.abort();
        } catch {
          // AbortController.abort() is synchronous, but cleanup stays best-effort.
        }
      }

      const activeRecorder = recorder;
      recorder = undefined;
      if (activeRecorder !== undefined && !recorderStopCalled && !recorderStopObserved) {
        recorderStopCalled = true;
        try {
          activeRecorder.stop();
        } catch {
          // The terminal result is already fixed before best-effort recorder cleanup.
        }
      }

      const activeStream = stream;
      stream = undefined;
      stopTracks(activeStream);
      chunks = [];
      retainedBytes = 0;
      audio = undefined;
      mimeType = undefined;
      return true;
    };

    const settleError = (error: SpeechInputProviderError): void => {
      if (!finish({ abortUpload: true })) return;
      callbacks.onError(error);
    };

    const settleComplete = (text: string): void => {
      if (!finish()) return;
      callbacks.onComplete(text);
    };

    const announceTranscribing = (): void => {
      if (terminal || transcribing) return;
      transcribing = true;
      callbacks.onTranscribing();
    };

    const invokeRecorderStop = (): void => {
      if (terminal || recorderStopCalled) return;
      const activeRecorder = recorder;
      if (activeRecorder === undefined) return;
      recorderStopCalled = true;
      try {
        activeRecorder.stop();
      } catch {
        settleError(MICROPHONE_UNAVAILABLE_ERROR);
      }
    };

    const requestStop = (): void => {
      if (terminal || stopRequested || recorderStopObserved) return;
      stopRequested = true;
      if (recorder === undefined) return;
      // This must precede recorder.stop() so the controller watchdog covers
      // recorder finalization as well as the subsequent network request.
      announceTranscribing();
      invokeRecorderStop();
    };

    const beginUpload = (): void => {
      if (terminal || uploadStarted) return;
      uploadStarted = true;
      const uploadMimeType = mimeType;
      if (uploadMimeType === undefined) {
        settleError(UNSUPPORTED_FORMAT_ERROR);
        return;
      }
      if (retainedBytes === 0 || chunks.length === 0) {
        settleError(NO_SPEECH_ERROR);
        return;
      }

      audio = new Blob(chunks, { type: uploadMimeType });
      const currentAudio = audio;
      const controller = new AbortController();
      uploadController = controller;
      let upload: Promise<SpeechInputTranscribeResponse>;
      try {
        upload = this.host.transcribe(currentAudio, uploadMimeType, controller.signal);
      } catch (error) {
        settleError(normalizeUploadError(error));
        return;
      }
      Promise.resolve(upload).then(
        (response) => {
          if (terminal || controller.signal.aborted) return;
          const text = transcriptText(response);
          if (text === undefined) {
            settleError(TRANSCRIPTION_FAILED_ERROR);
          } else if (text.trim() === "") {
            settleError(NO_SPEECH_ERROR);
          } else {
            settleComplete(text);
          }
        },
        (error: unknown) => {
          if (terminal || controller.signal.aborted) return;
          settleError(normalizeUploadError(error));
        },
      );
    };

    const onRecorderStart = (): void => {
      if (!terminal && !stopRequested) callbacks.onListening();
    };
    const onRecorderData = (data: Blob): void => {
      if (terminal || data.size === 0) return;
      const prospectiveBytes = retainedBytes + data.size;
      if (prospectiveBytes > SPEECH_INPUT_MAX_AUDIO_BYTES) {
        chunks = [];
        retainedBytes = 0;
        audio = undefined;
        settleError(RECORDING_LIMIT_ERROR);
        return;
      }
      chunks.push(data);
      retainedBytes = prospectiveBytes;
      if (retainedBytes === SPEECH_INPUT_MAX_AUDIO_BYTES) requestStop();
    };
    const onRecorderStop = (): void => {
      if (terminal) return;
      recorderStopObserved = true;
      // A source stream can end without an explicit user Stop; it still has a
      // valid final capture and must put the controller into its upload phase.
      announceTranscribing();
      beginUpload();
    };
    const onRecorderError = (): void => {
      if (!terminal) settleError(MICROPHONE_UNAVAILABLE_ERROR);
    };

    const setupRecorder = (resolvedStream: SpeechMediaStream): void => {
      if (terminal) {
        stopTracks(resolvedStream);
        return;
      }
      stream = resolvedStream;

      let createdRecorder: SpeechMediaRecorder;
      try {
        createdRecorder = this.host.createRecorder(resolvedStream, requestedMimeType);
      } catch {
        settleError(MICROPHONE_UNAVAILABLE_ERROR);
        return;
      }
      recorder = createdRecorder;

      const actualMimeType = parseSpeechInputAudioMimeType(createdRecorder.mimeType);
      if (actualMimeType === undefined) {
        settleError(UNSUPPORTED_FORMAT_ERROR);
        return;
      }
      mimeType = actualMimeType;

      try {
        unsubscribes.push(createdRecorder.onStart(onRecorderStart));
        unsubscribes.push(createdRecorder.onData(onRecorderData));
        unsubscribes.push(createdRecorder.onStop(onRecorderStop));
        unsubscribes.push(createdRecorder.onError(onRecorderError));
        createdRecorder.start(TIMESLICE_MS);
      } catch {
        settleError(MICROPHONE_UNAVAILABLE_ERROR);
        return;
      }
      if (stopRequested) {
        announceTranscribing();
        invokeRecorderStop();
      }
    };

    let permission: Promise<SpeechMediaStream>;
    try {
      permission = this.host.getUserMedia();
    } catch (error) {
      settleError(isPermissionDenied(error) ? PERMISSION_DENIED_ERROR : MICROPHONE_UNAVAILABLE_ERROR);
      return {
        stop: requestStop,
        cancel: () => undefined,
      };
    }
    Promise.resolve(permission).then(
      setupRecorder,
      (error: unknown) => {
        if (terminal) return;
        settleError(isPermissionDenied(error) ? PERMISSION_DENIED_ERROR : MICROPHONE_UNAVAILABLE_ERROR);
      },
    );

    return {
      stop: requestStop,
      cancel: () => {
        if (!finish({ abortUpload: true })) return;
      },
    };
  }
}
