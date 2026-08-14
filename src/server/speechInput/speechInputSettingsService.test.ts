import { describe, expect, it, vi } from "vitest";
import { PiWebUiConfigMutationBusyError } from "../../configMutationCoordinator.js";
import type { ModelTierLadder, UtilityModelSettings } from "../../shared/apiTypes.js";
import {
  SpeechInputSettingsConflictError,
  SpeechInputSettingsValidationError,
  createSpeechInputSettingsService,
} from "./speechInputSettingsService";
import {
  SPEECH_INPUT_TEST_REVISION,
  createInMemorySpeechInputConfigCoordinator,
  testSpeechInputRevision,
} from "./speechInputSettingsService.testSupport";

const DEFAULT_CLOUD = { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe" };

function validUpdate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    expectedRevision: SPEECH_INPUT_TEST_REVISION,
    settings: { provider: "cloud", cloud: DEFAULT_CLOUD },
    credential: { action: "preserve" },
    ...overrides,
  };
}

function settledError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error);
}

function validModelTiers(): ModelTierLadder {
  return {
    economy: { model: { provider: "acme", id: "economy" }, thinkingLevel: "off" },
    fast: { model: { provider: "acme", id: "fast" }, thinkingLevel: "low" },
    standard: { model: { provider: "acme", id: "standard" }, thinkingLevel: "medium" },
    advanced: { model: { provider: "acme", id: "advanced" }, thinkingLevel: "high" },
    capable: { model: { provider: "acme", id: "capable" }, thinkingLevel: "xhigh" },
    frontier: { model: { provider: "acme", id: "frontier" }, thinkingLevel: "max" },
  };
}

function validUtilityModels(): UtilityModelSettings {
  return {
    lightweight: { provider: "acme", id: "tiny" },
    context: { provider: "acme", id: "big" },
  };
}

describe("SpeechInputSettingsService reads", () => {
  it("projects the coordinator's opaque revision and defaults without a credential", async () => {
    const coordinator = createInMemorySpeechInputConfigCoordinator({});
    const service = createSpeechInputSettingsService({ coordinator });

    await expect(service.read()).resolves.toEqual({
      contractVersion: 1,
      revision: SPEECH_INPUT_TEST_REVISION,
      settings: { provider: "auto", cloud: DEFAULT_CLOUD },
      credential: { configured: false, resolution: "missing" },
    });
  });

  it("classifies literal, environment, and command sources and never returns source text", async () => {
    const cases = [
      [{ apiKey: "sk-live-secret" }, { configured: true, source: "literal", resolution: "resolved" }],
      [{ apiKey: "$OPENAI_API_KEY" }, { configured: true, source: "environment", resolution: "resolved" }],
      [{ apiKey: "$MISSING_SPEECH_KEY" }, { configured: true, source: "environment", resolution: "unresolved" }],
      [{ apiKey: "!get-cloud-key" }, { configured: true, source: "command", resolution: "unchecked" }],
    ] as const;

    for (const [cloud, credential] of cases) {
      const coordinator = createInMemorySpeechInputConfigCoordinator({
        config: { speechInput: { provider: "cloud", cloud: { ...cloud } } },
      });
      const service = createSpeechInputSettingsService({ coordinator, env: { OPENAI_API_KEY: "resolved-value" } });

      const response = await service.read();

      expect(response.credential).toEqual(credential);
      expect(JSON.stringify(response)).not.toContain("sk-live-secret");
      expect(JSON.stringify(response)).not.toContain("OPENAI_API_KEY");
      expect(JSON.stringify(response)).not.toContain("resolved-value");
      expect(JSON.stringify(response)).not.toContain("get-cloud-key");
    }
  });
});

describe("SpeechInputSettingsService preserve updates", () => {
  it("applies provider, language, and model changes without changing the raw credential source", async () => {
    const coordinator = createInMemorySpeechInputConfigCoordinator({
      config: {
        speechInput: {
          provider: "auto",
          cloud: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe", apiKey: "sk-secret" },
        },
      },
    });
    const onCommitted = vi.fn();
    const service = createSpeechInputSettingsService({ coordinator, onCommitted });

    const response = await service.update(validUpdate({
      settings: {
        provider: "browser",
        language: "en-us",
        cloud: { baseUrl: "https://API.OpenAI.com:443/v1/", model: "whisper-1" },
      },
    }));

    expect(response).toEqual({
      contractVersion: 1,
      revision: testSpeechInputRevision(2),
      settings: {
        provider: "browser",
        language: "en-US",
        cloud: { baseUrl: "https://API.OpenAI.com:443/v1/", model: "whisper-1" },
      },
      credential: { configured: true, source: "literal", resolution: "resolved" },
    });
    expect(coordinator.current().loaded.config.speechInput).toEqual({
      provider: "browser",
      language: "en-US",
      cloud: { baseUrl: "https://API.OpenAI.com:443/v1/", model: "whisper-1", apiKey: "sk-secret" },
    });
    expect(onCommitted).toHaveBeenCalledOnce();
  });

  it("rejects a changed cloud base URL for a preserved credential with the exact safe message", async () => {
    const coordinator = createInMemorySpeechInputConfigCoordinator({
      config: { speechInput: { cloud: { apiKey: "sk-secret" } } },
    });
    const onCommitted = vi.fn();
    const service = createSpeechInputSettingsService({ coordinator, onCommitted });

    const error = await settledError(service.update(validUpdate({
      settings: { provider: "auto", cloud: { baseUrl: "https://evil.example.test/v1", model: "gpt-4o-mini-transcribe" } },
    })));

    expect(error).toBeInstanceOf(SpeechInputSettingsValidationError);
    expect(error instanceof Error ? error.message : "").toBe("Re-enter the API key source when changing the cloud base URL.");
    expect(coordinator.current().loaded.config).toEqual({ speechInput: { cloud: { apiKey: "sk-secret" } } });
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it("allows a changed cloud base URL when no credential source is configured", async () => {
    const coordinator = createInMemorySpeechInputConfigCoordinator({ config: { speechInput: { provider: "auto" } } });
    const service = createSpeechInputSettingsService({ coordinator });

    const response = await service.update(validUpdate({
      settings: { provider: "cloud", cloud: { baseUrl: "https://other.example.test/v1", model: "whisper-1" } },
    }));

    expect(response.settings).toEqual({
      provider: "cloud",
      cloud: { baseUrl: "https://other.example.test/v1", model: "whisper-1" },
    });
  });
});

describe("SpeechInputSettingsService replace updates", () => {
  it("stores the exact nonblank source and returns only the redacted status", async () => {
    const source = "  $OPENAI_API_KEY ";
    const coordinator = createInMemorySpeechInputConfigCoordinator({});
    const service = createSpeechInputSettingsService({ coordinator, env: { OPENAI_API_KEY: "resolved-value" } });

    const response = await service.update(validUpdate({ credential: { action: "replace", value: source } }));

    expect(coordinator.current().loaded.config.speechInput?.cloud?.apiKey).toBe(source);
    expect(response.credential).toEqual({ configured: true, source: "environment", resolution: "resolved" });
    expect(JSON.stringify(response)).not.toContain("OPENAI_API_KEY");
    expect(JSON.stringify(response)).not.toContain("resolved-value");
    expect(response.revision).toBe(testSpeechInputRevision(2));
  });
});

describe("SpeechInputSettingsService clear updates", () => {
  it("removes only the apiKey, applies no submitted nonsecret fields, and keeps unrelated keys", async () => {
    const coordinator = createInMemorySpeechInputConfigCoordinator({
      config: {
        spawnSessions: true,
        tts: { voice: "Ada" },
        speechInput: {
          provider: "browser",
          language: "en-US",
          cloud: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe", apiKey: "sk-secret" },
        },
      },
    });
    const onCommitted = vi.fn();
    const service = createSpeechInputSettingsService({ coordinator, onCommitted });

    const response = await service.update(validUpdate({
      settings: { provider: "auto", cloud: { baseUrl: "https://ignored.example.test/", model: "ignored-model" } },
      credential: { action: "clear" },
    }));

    expect(coordinator.current().loaded.config).toEqual({
      spawnSessions: true,
      tts: { voice: "Ada" },
      speechInput: {
        provider: "browser",
        language: "en-US",
        cloud: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe" },
      },
    });
    expect(response.settings).toEqual({
      provider: "browser",
      language: "en-US",
      cloud: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe" },
    });
    expect(response.credential).toEqual({ configured: false, resolution: "missing" });
    expect(response.revision).toBe(testSpeechInputRevision(2));
    expect(onCommitted).toHaveBeenCalledOnce();
  });

  it("does not materialize defaults and handles missing or credential-only subtrees", async () => {
    const noSpeech = createInMemorySpeechInputConfigCoordinator({ config: { spawnSessions: true } });
    await createSpeechInputSettingsService({ coordinator: noSpeech }).update(validUpdate({ credential: { action: "clear" } }));
    expect(noSpeech.current().loaded.config).toEqual({ spawnSessions: true });

    const credentialOnly = createInMemorySpeechInputConfigCoordinator({
      config: { speechInput: { cloud: { apiKey: "sk-secret" } } },
    });
    await createSpeechInputSettingsService({ coordinator: credentialOnly }).update(validUpdate({ credential: { action: "clear" } }));
    expect(credentialOnly.current().loaded.config).toEqual({ speechInput: { cloud: {} } });
  });
});

describe("SpeechInputSettingsService conflicts and failures", () => {
  it.each(["preserve", "replace", "clear"] as const)("rejects a stale expected revision for %s with a typed conflict before mutation", async (action) => {
    const coordinator = createInMemorySpeechInputConfigCoordinator({
      config: { speechInput: { provider: "cloud", cloud: { ...DEFAULT_CLOUD, apiKey: "sk-secret" } } },
    });
    const onCommitted = vi.fn();
    const service = createSpeechInputSettingsService({ coordinator, onCommitted });
    const before = coordinator.current();

    const credential = action === "preserve"
      ? { action: "preserve" }
      : action === "replace" ? { action: "replace", value: "sk-new" } : { action: "clear" };
    const error = await settledError(service.update(validUpdate({
      expectedRevision: testSpeechInputRevision(9),
      credential,
    })));

    expect(error).toBeInstanceOf(SpeechInputSettingsConflictError);
    expect(error instanceof Error ? error.message : "").toBe("Speech input settings changed. Reload and try again.");
    expect(coordinator.current()).toEqual(before);
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it("propagates typed coordinator contention without calling onCommitted", async () => {
    const coordinator = createInMemorySpeechInputConfigCoordinator({});
    coordinator.setBusy(true);
    const onCommitted = vi.fn();
    const service = createSpeechInputSettingsService({ coordinator, onCommitted });

    await expect(service.read()).rejects.toBeInstanceOf(PiWebUiConfigMutationBusyError);
    await expect(service.update(validUpdate())).rejects.toBeInstanceOf(PiWebUiConfigMutationBusyError);
    expect(onCommitted).not.toHaveBeenCalled();
  });
});

describe("SpeechInputSettingsService update validation", () => {
  it("rejects unknown fields and malformed values before any coordinator mutation", async () => {
    const coordinator = createInMemorySpeechInputConfigCoordinator({});
    const service = createSpeechInputSettingsService({ coordinator });

    const payloads: unknown[] = [
      null,
      [],
      "not an object",
      {},
      { expectedRevision: SPEECH_INPUT_TEST_REVISION },
      { settings: validUpdate()["settings"], credential: { action: "preserve" } },
      validUpdate({ extra: true }),
      validUpdate({ contractVersion: 1 }),
      validUpdate({ expectedRevision: 42 }),
      validUpdate({ expectedRevision: "not-a-uuid" }),
      validUpdate({ expectedRevision: "01234567-89ab-4cde-8f01-23456789abcd".toUpperCase() }),
      validUpdate({ expectedRevision: "00000000-0000-4000-8000-00000000000" }),
      validUpdate({ settings: null }),
      validUpdate({ settings: { cloud: DEFAULT_CLOUD } }),
      validUpdate({ settings: { provider: "local", cloud: DEFAULT_CLOUD } }),
      validUpdate({ settings: { provider: "cloud", language: "", cloud: DEFAULT_CLOUD } }),
      validUpdate({ settings: { provider: "cloud", language: "auto", cloud: DEFAULT_CLOUD } }),
      validUpdate({ settings: { provider: "cloud", language: "not a tag", cloud: DEFAULT_CLOUD } }),
      validUpdate({ settings: { provider: "cloud", language: "x".repeat(129), cloud: DEFAULT_CLOUD } }),
      validUpdate({ settings: { provider: "cloud", language: 7, cloud: DEFAULT_CLOUD } }),
      validUpdate({ settings: { provider: "cloud", cloud: DEFAULT_CLOUD, extra: true } }),
      validUpdate({ settings: { provider: "cloud", cloud: {} } }),
      validUpdate({ settings: { provider: "cloud", cloud: { ...DEFAULT_CLOUD, model: "" } } }),
      validUpdate({ settings: { provider: "cloud", cloud: { ...DEFAULT_CLOUD, model: "m".repeat(257) } } }),
      validUpdate({ settings: { provider: "cloud", cloud: { ...DEFAULT_CLOUD, model: 42 } } }),
      validUpdate({ settings: { provider: "cloud", cloud: { ...DEFAULT_CLOUD, baseUrl: "" } } }),
      validUpdate({ settings: { provider: "cloud", cloud: { ...DEFAULT_CLOUD, baseUrl: "http://api.openai.com/v1" } } }),
      validUpdate({ settings: { provider: "cloud", cloud: { ...DEFAULT_CLOUD, baseUrl: "https://user@api.openai.com/v1" } } }),
      validUpdate({ settings: { provider: "cloud", cloud: { ...DEFAULT_CLOUD, baseUrl: "https://api.openai.com/v1?key=x" } } }),
      validUpdate({ settings: { provider: "cloud", cloud: { ...DEFAULT_CLOUD, baseUrl: "https://api.openai.com/v1#frag" } } }),
      validUpdate({ settings: { provider: "cloud", cloud: { ...DEFAULT_CLOUD, baseUrl: "b".repeat(2049) } } }),
      validUpdate({ settings: { provider: "cloud", cloud: { ...DEFAULT_CLOUD, baseUrl: 42 } } }),
      validUpdate({ settings: { provider: "cloud", cloud: { ...DEFAULT_CLOUD, apiKey: "sk-wire-leak" } } }),
      validUpdate({ settings: { provider: "cloud", cloud: null } }),
      validUpdate({ credential: null }),
      validUpdate({ credential: {} }),
      validUpdate({ credential: { action: "reset" } }),
      validUpdate({ credential: { action: "preserve", value: "sk-x" } }),
      validUpdate({ credential: { action: "clear", value: "sk-x" } }),
      validUpdate({ credential: { action: "replace" } }),
      validUpdate({ credential: { action: "replace", value: "   " } }),
      validUpdate({ credential: { action: "replace", value: 42 } }),
      validUpdate({ credential: { action: "replace", value: "x".repeat(8 * 1024 + 1) } }),
      validUpdate({ credential: { action: "replace", value: "sk-x", extra: true } }),
    ];

    for (const payload of payloads) {
      await expect(service.update(payload), JSON.stringify(payload)).rejects.toBeInstanceOf(SpeechInputSettingsValidationError);
    }
    expect(coordinator.mutateCalls()).toBe(0);
    expect(coordinator.current().loaded.config).toEqual({});
  });

  it("rejects blank and oversized replacement sources without echoing them", async () => {
    const coordinator = createInMemorySpeechInputConfigCoordinator({});
    const service = createSpeechInputSettingsService({ coordinator });

    const cases: { source: string; message: string }[] = [
      { source: "", message: "Speech input settings credential replace value must be a nonblank string" },
      { source: "   ", message: "Speech input settings credential replace value must be a nonblank string" },
      { source: "x".repeat(8 * 1024 + 1), message: "Speech input settings credential replace value must be at most 8 KiB of UTF-8 text" },
    ];

    for (const { source, message } of cases) {
      const error = await settledError(service.update(validUpdate({ credential: { action: "replace", value: source } })));
      expect(error).toBeInstanceOf(SpeechInputSettingsValidationError);
      expect(error instanceof Error ? error.message : "").toBe(message);
    }
    expect(coordinator.mutateCalls()).toBe(0);
  });
});

describe("SpeechInputSettingsService coordinated interleaving", () => {
  it("preserves speech settings through generic, selected-machine, model-tier, and utility-model writes and vice versa", async () => {
    const unrelated = {
      spawnSessions: false,
      subsessions: false,
      tts: { voice: "Ada" },
      plugins: { info: { enabled: true, settings: { note: "kept" } } },
    };
    const speechSettings = {
      provider: "browser",
      language: "pt-BR",
      cloud: { baseUrl: "https://gateway.example.test/v1", model: "whisper-1" },
    };
    const credential = { action: "replace", value: "sk-new" };

    // Speech first: the generic write must keep the committed speech subtree and revision.
    const speechFirst = createInMemorySpeechInputConfigCoordinator({ config: { ...unrelated } });
    const speechFirstService = createSpeechInputSettingsService({ coordinator: speechFirst });
    const firstSpeechResponse = await speechFirstService.update(validUpdate({ settings: speechSettings, credential }));
    const genericAfter = await speechFirst.mutate((current) => ({
      ...current.loaded.config,
      spawnSessions: true,
      modelTiers: validModelTiers(),
      utilityModels: validUtilityModels(),
      plugins: { info: { enabled: false } },
    }));

    expect(genericAfter.loaded.config.speechInput).toEqual({ ...speechSettings, cloud: { ...speechSettings.cloud, apiKey: "sk-new" } });
    expect(genericAfter.loaded.config.spawnSessions).toBe(true);
    expect(genericAfter.loaded.config.modelTiers).toEqual(validModelTiers());
    expect(genericAfter.loaded.config.utilityModels).toEqual(validUtilityModels());
    expect(genericAfter.loaded.config.plugins).toEqual({ info: { enabled: false } });
    expect(genericAfter.loaded.config.tts).toEqual({ voice: "Ada" });
    expect(genericAfter.speechInputRevision).toBe(firstSpeechResponse.revision);

    // Generic first: the speech write must keep the coordinated unrelated fields.
    const genericFirst = createInMemorySpeechInputConfigCoordinator({ config: { ...unrelated } });
    const genericFirstService = createSpeechInputSettingsService({ coordinator: genericFirst });
    const coordinated = await genericFirst.mutate((current) => ({
      ...current.loaded.config,
      modelTiers: validModelTiers(),
      utilityModels: validUtilityModels(),
      spawnSessions: true,
    }));
    expect(coordinated.speechInputRevision).toBe(SPEECH_INPUT_TEST_REVISION);

    const secondSpeechResponse = await genericFirstService.update(validUpdate({ settings: speechSettings, credential }));
    const committed = genericFirst.current();
    expect(committed.loaded.config.speechInput).toEqual({ ...speechSettings, cloud: { ...speechSettings.cloud, apiKey: "sk-new" } });
    expect(committed.loaded.config.modelTiers).toEqual(validModelTiers());
    expect(committed.loaded.config.utilityModels).toEqual(validUtilityModels());
    expect(committed.loaded.config.spawnSessions).toBe(true);
    expect(committed.loaded.config.plugins).toEqual({ info: { enabled: true, settings: { note: "kept" } } });
    expect(committed.speechInputRevision).toBe(secondSpeechResponse.revision);
  });

  it("commits concurrent speech and unrelated mutations without losing either", async () => {
    const coordinator = createInMemorySpeechInputConfigCoordinator({ config: { spawnSessions: false } });
    const service = createSpeechInputSettingsService({ coordinator });

    const [speechResponse] = await Promise.all([
      service.update(validUpdate({ credential: { action: "replace", value: "sk-new" } })),
      coordinator.mutate((current) => ({ ...current.loaded.config, subsessions: true })),
    ]);

    const committed = coordinator.current();
    expect(committed.loaded.config.subsessions).toBe(true);
    expect(committed.loaded.config.speechInput?.cloud?.apiKey).toBe("sk-new");
    expect(committed.speechInputRevision).toBe(speechResponse.revision);
  });
});
