import { describe, expect, it, vi } from "vitest";
import {
  SPEECH_INPUT_MAX_TRANSCRIPT_BYTES,
} from "../../shared/speechInputAudio.js";
import {
  OpenAiCompatibleTranscriptionProvider,
  SpeechInputProviderError,
  SpeechInputProviderTimeoutError,
  SpeechInputTranscriptionAbortedError,
  type SpeechInputFetch,
  type SpeechInputFetchResponse,
  type SpeechInputResponseReader,
  type OpenAiCompatibleTranscriptionRequest,
} from "./openAiCompatibleTranscriptionProvider.js";

type FetchLike = SpeechInputFetch;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface ControlledDeadline {
  delayMs: number;
  cancelled: boolean;
  callback: () => void;
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

function controlledDeadlines() {
  const deadlines: ControlledDeadline[] = [];
  return {
    deadlines,
    scheduleDeadline: (callback: () => void, delayMs: number): (() => void) => {
      const deadline = { callback, delayMs, cancelled: false };
      deadlines.push(deadline);
      return () => { deadline.cancelled = true; };
    },
    fire: (index = 0): void => {
      const deadline = deadlines[index];
      if (deadline === undefined) throw new Error("Missing deadline");
      deadline.callback();
    },
  };
}

function request(overrides: Partial<OpenAiCompatibleTranscriptionRequest> = {}): OpenAiCompatibleTranscriptionRequest {
  return {
    audio: Buffer.from("opus audio"),
    mimeType: "audio/webm;codecs=opus",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-transcribe",
    apiKey: "secret-api-key",
    language: "en",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function jsonResponse(value: unknown): SpeechInputFetchResponse {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function encodedTranscription(textByteLength: number): Uint8Array {
  const prefix = '{"text":"';
  const suffix = '"}';
  const text = "x".repeat(textByteLength - Buffer.byteLength(prefix) - Buffer.byteLength(suffix));
  return Buffer.from(`${prefix}${text}${suffix}`);
}

describe("OpenAiCompatibleTranscriptionProvider", () => {
  it("uses the configured OpenAI-compatible endpoint and exact multipart contract", async () => {
    const deadlines = controlledDeadlines();
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(jsonResponse({ text: "transcript" })));
    const provider = new OpenAiCompatibleTranscriptionProvider({ fetch, now: () => 0, scheduleDeadline: deadlines.scheduleDeadline });

    await expect(provider.transcribe(request())).resolves.toBe("transcript");

    expect(fetch).toHaveBeenCalledOnce();
    const [endpoint, init] = fetch.mock.calls[0] ?? [];
    expect(endpoint).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-api-key");
    const body = init?.body;
    expect(body).toBeInstanceOf(FormData);
    const form = requireFormData(body);
    expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(form.get("language")).toBe("en");
    const file = form.get("file");
    expect(file).toBeInstanceOf(Blob);
    const audioFile = requireAudioFile(file);
    expect(audioFile.name).toBe("speech.webm");
    expect(audioFile.type).toBe("audio/webm;codecs=opus");
    expect(Buffer.from(await audioFile.arrayBuffer())).toEqual(Buffer.from("opus audio"));
    expect(deadlines.deadlines).toEqual([expect.objectContaining({ delayMs: 120_000, cancelled: true })]);
  });

  it.each([
    ["audio/ogg;codecs=opus", "speech.ogg"],
    ["audio/mp4;codecs=mp4a.40.2", "speech.m4a"],
    ["audio/mp4", "speech.m4a"],
  ] as const)("uses the MIME-derived filename for %s", async (mimeType, filename) => {
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(jsonResponse({ text: "transcript" })));
    const provider = new OpenAiCompatibleTranscriptionProvider({ fetch });

    await provider.transcribe(request({ mimeType }));

    const form = requireFormData(fetch.mock.calls[0]?.[1]?.body);
    expect(requireAudioFile(form.get("file")).name).toBe(filename);
  });

  it("omits language for Auto", async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(jsonResponse({ text: "transcript" })));
    const provider = new OpenAiCompatibleTranscriptionProvider({ fetch });

    const automaticRequest = request();
    delete automaticRequest.language;
    await provider.transcribe(automaticRequest);

    const form = requireFormData(fetch.mock.calls[0]?.[1]?.body);
    expect(form.has("language")).toBe(false);
  });

  it("settles promptly on caller cancellation and cancels a late abort-ignoring fetch response", async () => {
    const fetchResult = deferred<SpeechInputFetchResponse>();
    const deadlines = controlledDeadlines();
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    const fetch = vi.fn<FetchLike>(() => {
      markFetchStarted?.();
      return fetchResult.promise;
    });
    const provider = new OpenAiCompatibleTranscriptionProvider({ fetch, scheduleDeadline: deadlines.scheduleDeadline });
    const controller = new AbortController();
    const completion = provider.transcribe(request({ signal: controller.signal }));

    await fetchStarted;
    controller.abort();
    await expect(completion).rejects.toBeInstanceOf(SpeechInputTranscriptionAbortedError);

    let cancellations = 0;
    let markCancelled: (() => void) | undefined;
    const cancelled = new Promise<void>((resolve) => { markCancelled = resolve; });
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancellations += 1;
        markCancelled?.();
      },
    }), { status: 200 });
    fetchResult.resolve(response);
    await cancelled;

    expect(cancellations).toBe(1);
    expect(deadlines.deadlines[0]?.cancelled).toBe(true);
  });

  it("settles promptly when the shared provider deadline expires before an abort-ignoring fetch settles", async () => {
    const fetchResult = deferred<SpeechInputFetchResponse>();
    const deadlines = controlledDeadlines();
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    const fetch = vi.fn<FetchLike>(() => {
      markFetchStarted?.();
      return fetchResult.promise;
    });
    const provider = new OpenAiCompatibleTranscriptionProvider({ fetch, scheduleDeadline: deadlines.scheduleDeadline });
    const completion = provider.transcribe(request());

    await fetchStarted;
    deadlines.fire();
    await expect(completion).rejects.toBeInstanceOf(SpeechInputProviderTimeoutError);

    let cancellations = 0;
    let markCancelled: (() => void) | undefined;
    const cancelled = new Promise<void>((resolve) => { markCancelled = resolve; });
    fetchResult.resolve(new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancellations += 1;
        markCancelled?.();
      },
    }), { status: 200 }));
    await cancelled;

    expect(cancellations).toBe(1);
  });

  it("cancels and releases an abort-ignoring active response reader after cancellation", async () => {
    const deferredRead = deferred<ReadableStreamReadResult<Uint8Array>>();
    let cancels = 0;
    let releases = 0;
    const reader: SpeechInputResponseReader = {
      read: () => deferredRead.promise,
      cancel: () => {
        cancels += 1;
        return Promise.resolve();
      },
      releaseLock: () => { releases += 1; },
    };
    const response = {
      status: 200,
      body: {
        getReader: () => reader,
        cancel: () => Promise.resolve(),
      },
    } satisfies SpeechInputFetchResponse;
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(response));
    const provider = new OpenAiCompatibleTranscriptionProvider({ fetch });
    const controller = new AbortController();
    const completion = provider.transcribe(request({ signal: controller.signal }));
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledOnce(); });

    controller.abort();
    await expect(completion).rejects.toBeInstanceOf(SpeechInputTranscriptionAbortedError);
    deferredRead.resolve({ done: true, value: undefined });
    await Promise.resolve();
    await Promise.resolve();

    expect(cancels).toBe(1);
    expect(releases).toBe(1);
  });

  it("rejects redirects and upstream failures without reading or leaking response bodies", async () => {
    const providerBody = "provider body with secret-api-key and transcript";
    let cancellations = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from(providerBody)); },
      cancel() { cancellations += 1; },
    }), { status: 302 });
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(response));
    const provider = new OpenAiCompatibleTranscriptionProvider({ fetch });

    const error = await provider.transcribe(request()).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SpeechInputProviderError);
    if (!(error instanceof Error)) throw new Error("Expected provider error");
    expect(error.message).not.toContain(providerBody);
    expect(error.message).not.toContain("secret-api-key");
    expect(cancellations).toBe(1);
  });

  it("accepts exactly one MiB of response bytes and cancels an over-limit reader before decoding", async () => {
    const exact = encodedTranscription(SPEECH_INPUT_MAX_TRANSCRIPT_BYTES);
    const provider = new OpenAiCompatibleTranscriptionProvider({
      fetch: () => Promise.resolve(new Response(copyBytesToArrayBuffer(exact), { status: 200 })),
    });

    await expect(provider.transcribe(request())).resolves.toHaveLength(SPEECH_INPUT_MAX_TRANSCRIPT_BYTES - Buffer.byteLength('{"text":"') - Buffer.byteLength('"}'));

    let cancellations = 0;
    const overLimit = encodedTranscription(SPEECH_INPUT_MAX_TRANSCRIPT_BYTES + 1);
    const rejected = new OpenAiCompatibleTranscriptionProvider({
      fetch: () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(overLimit); },
        cancel() { cancellations += 1; },
      }), { status: 200 })),
    });

    await expect(rejected.transcribe(request())).rejects.toBeInstanceOf(SpeechInputProviderError);
    expect(cancellations).toBe(1);
  });

  it.each([
    "not json",
    "[]",
    "{}",
    '{"text":"   "}',
    JSON.stringify({ text: "x".repeat(SPEECH_INPUT_MAX_TRANSCRIPT_BYTES + 1) }),
  ])("rejects malformed or invalid transcript payloads", async (body) => {
    const provider = new OpenAiCompatibleTranscriptionProvider({
      fetch: () => Promise.resolve(new Response(body, { status: 200 })),
    });

    await expect(provider.transcribe(request())).rejects.toBeInstanceOf(SpeechInputProviderError);
  });
});

function copyBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function requireFormData(value: BodyInit | null | undefined): FormData {
  if (!(value instanceof FormData)) throw new Error("Expected multipart form data");
  return value;
}

function requireAudioFile(value: FormDataEntryValue | null): Blob & { name: string } {
  if (!(value instanceof Blob) || !("name" in value) || typeof value.name !== "string") {
    throw new Error("Expected multipart audio file");
  }
  return value;
}
