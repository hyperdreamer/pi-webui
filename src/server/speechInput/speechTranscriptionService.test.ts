import { describe, expect, it, vi } from "vitest";
import { PiWebUiConfigMutationBusyError } from "../../configMutationCoordinator.js";
import type { PiWebUiConfigMutationCoordinator } from "../../configMutationCoordinator.js";
import { createInMemorySpeechInputConfigCoordinator } from "./speechInputSettingsService.testSupport.js";
import {
  SpeechInputCredentialUnavailableError,
  SpeechTranscriptionService,
} from "./speechTranscriptionService.js";
import {
  SpeechInputProviderTimeoutError,
  SpeechInputTranscriptionAbortedError,
  type OpenAiCompatibleTranscriptionRequest,
} from "./openAiCompatibleTranscriptionProvider.js";
import type { ResolveCredentialOptions } from "./piCompatibleCredentialResolver.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function configuredCoordinator(apiKey = "captured-source") {
  return createInMemorySpeechInputConfigCoordinator({
    config: {
      speechInput: {
        language: "en-US",
        cloud: {
          baseUrl: "https://captured.example.test/v1",
          model: "captured-model",
          apiKey,
        },
      },
    },
  });
}

function transcriptionRequest(signal = new AbortController().signal) {
  return {
    audio: Buffer.from("audio"),
    mimeType: "audio/webm;codecs=opus" as const,
    signal,
  };
}

describe("SpeechTranscriptionService", () => {
  it("captures one private config snapshot and releases it before resolving credentials or calling the provider", async () => {
    const inner = configuredCoordinator();
    let reads = 0;
    let readFinished = false;
    const coordinator: PiWebUiConfigMutationCoordinator = {
      ...inner,
      async read() {
        reads += 1;
        const snapshot = await inner.read();
        readFinished = true;
        return snapshot;
      },
    };
    const credential = deferred<string>();
    const resolveCredential = vi.fn(async (source: string | undefined) => {
      expect(readFinished).toBe(true);
      expect(source).toBe("captured-source");
      return credential.promise;
    });
    const provider = { transcribe: vi.fn<((value: OpenAiCompatibleTranscriptionRequest) => Promise<string>)>() };
    provider.transcribe.mockResolvedValue("transcript");
    const service = new SpeechTranscriptionService({ coordinator, resolveCredential, provider });

    const completion = service.transcribe(transcriptionRequest());
    await vi.waitFor(() => { expect(resolveCredential).toHaveBeenCalledOnce(); });

    await inner.mutate((current) => ({
      ...current.loaded.config,
      speechInput: {
        language: "de-DE",
        cloud: { baseUrl: "https://new.example.test/v9", model: "new-model", apiKey: "new-source" },
      },
    }));
    credential.resolve("resolved-key");

    await expect(completion).resolves.toBe("transcript");
    expect(reads).toBe(1);
    expect(provider.transcribe).toHaveBeenCalledOnce();
    expect(provider.transcribe).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: "https://captured.example.test/v1",
      model: "captured-model",
      language: "en",
      apiKey: "resolved-key",
    }));
  });

  it("passes the request-close signal unchanged to credential resolution and the provider", async () => {
    const coordinator = configuredCoordinator("!trusted-command");
    const resolveCredential = vi.fn<(source: string | undefined, options: ResolveCredentialOptions) => Promise<string>>(() => Promise.resolve("resolved-key"));
    const provider = { transcribe: vi.fn<(value: OpenAiCompatibleTranscriptionRequest) => Promise<string>>(() => Promise.resolve("transcript")) };
    const controller = new AbortController();
    const service = new SpeechTranscriptionService({ coordinator, resolveCredential, provider });

    await service.transcribe(transcriptionRequest(controller.signal));

    expect(resolveCredential).toHaveBeenCalledOnce();
    expect(resolveCredential.mock.calls[0]?.[0]).toBe("!trusted-command");
    expect(resolveCredential.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(provider.transcribe.mock.calls[0]?.[0]?.signal).toBe(controller.signal);
  });

  it("rejects absent, unresolved, and empty credentials before calling the provider", async () => {
    const missing = new SpeechTranscriptionService({
      coordinator: configuredCoordinator(""),
      provider: { transcribe: vi.fn(() => Promise.resolve("unexpected")) },
    });
    await expect(missing.transcribe(transcriptionRequest())).rejects.toBeInstanceOf(SpeechInputCredentialUnavailableError);

    const unresolvedProvider = { transcribe: vi.fn(() => Promise.resolve("unexpected")) };
    const unresolved = new SpeechTranscriptionService({
      coordinator: configuredCoordinator(),
      provider: unresolvedProvider,
      resolveCredential: () => Promise.reject(new Error("secret resolver failure")),
    });
    await expect(unresolved.transcribe(transcriptionRequest())).rejects.toBeInstanceOf(SpeechInputCredentialUnavailableError);
    expect(unresolvedProvider.transcribe).not.toHaveBeenCalled();

    const emptyProvider = { transcribe: vi.fn(() => Promise.resolve("unexpected")) };
    const empty = new SpeechTranscriptionService({
      coordinator: configuredCoordinator(),
      provider: emptyProvider,
      resolveCredential: () => Promise.resolve("  "),
    });
    await expect(empty.transcribe(transcriptionRequest())).rejects.toBeInstanceOf(SpeechInputCredentialUnavailableError);
    expect(emptyProvider.transcribe).not.toHaveBeenCalled();
  });

  it("does not invoke the provider after a deferred credential resolution settles behind cancellation", async () => {
    const credential = deferred<string>();
    const resolveCredential = vi.fn(() => credential.promise);
    const provider = { transcribe: vi.fn(() => Promise.resolve("unexpected")) };
    const service = new SpeechTranscriptionService({ coordinator: configuredCoordinator(), resolveCredential, provider });
    const controller = new AbortController();
    const completion = service.transcribe(transcriptionRequest(controller.signal));
    await vi.waitFor(() => { expect(resolveCredential).toHaveBeenCalledOnce(); });

    controller.abort();
    credential.resolve("resolved-key");

    await expect(completion).rejects.toBeInstanceOf(SpeechInputTranscriptionAbortedError);
    expect(provider.transcribe).not.toHaveBeenCalled();
  });

  it("preserves typed coordinator and provider timeout ownership for route mapping", async () => {
    const busy: PiWebUiConfigMutationCoordinator = {
      read: () => Promise.reject(new PiWebUiConfigMutationBusyError()),
      mutate: () => Promise.reject(new PiWebUiConfigMutationBusyError()),
    };
    const busyService = new SpeechTranscriptionService({
      coordinator: busy,
      provider: { transcribe: vi.fn(() => Promise.resolve("unexpected")) },
    });
    await expect(busyService.transcribe(transcriptionRequest())).rejects.toBeInstanceOf(PiWebUiConfigMutationBusyError);

    const timeout = new SpeechTranscriptionService({
      coordinator: configuredCoordinator(),
      resolveCredential: () => Promise.resolve("resolved-key"),
      provider: { transcribe: () => Promise.reject(new SpeechInputProviderTimeoutError()) },
    });
    await expect(timeout.transcribe(transcriptionRequest())).rejects.toBeInstanceOf(SpeechInputProviderTimeoutError);
  });
});
