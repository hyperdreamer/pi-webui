import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { PiWebUiConfigResponse, SpeechInputSettingsResponse } from "../shared/apiTypes.js";
import type { PiWebUiConfigMutationCoordinator } from "../configMutationCoordinator.js";
import { buildApp, createGatewayConfigComposition, sharedConfigMutationCoordinator } from "./app.js";
import { SPEECH_INPUT_TEST_REVISION } from "./speechInput/speechInputSettingsService.testSupport.js";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();

describe("buildApp gateway speech input settings routes", () => {
  it("serves the redacted gateway settings snapshot", async () => {
    const response = await appTestContext.app.inject({ method: "GET", url: "/api/speech-input/settings" });

    expect(response.statusCode).toBe(200);
    expect(response.json<SpeechInputSettingsResponse>()).toEqual({
      contractVersion: 1,
      revision: SPEECH_INPUT_TEST_REVISION,
      settings: { provider: "auto", cloud: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe" } },
      credential: { configured: false, resolution: "missing" },
    });
  });

  it("answers 404 for the selected-machine speech settings alias", async () => {
    const get = await appTestContext.app.inject({ method: "GET", url: "/api/machines/local/speech-input/settings" });
    expect(get.statusCode).toBe(404);

    const update = await appTestContext.app.inject({ method: "PUT", url: "/api/machines/local/speech-input/settings", payload: {} });
    expect(update.statusCode).toBe(404);
  });

  it("invalidates the PI WEBUI status cache exactly once after a successful speech settings update", async () => {
    const invalidate = vi.spyOn(appTestContext.piWebUiStatusCache, "invalidate");

    // Prime the status cache so a post-invalidation reload is observable.
    const firstStatus = await appTestContext.app.inject({ method: "GET", url: "/api/pi-webui/status" });
    expect(firstStatus.statusCode).toBe(200);
    const runtimeLoadsBefore = appTestContext.sessionDaemonRequests.filter((request) => request.path === "/runtime").length;

    const current = await appTestContext.app.inject({ method: "GET", url: "/api/speech-input/settings" });
    const { revision } = current.json<SpeechInputSettingsResponse>();

    const update = await appTestContext.app.inject({
      method: "PUT",
      url: "/api/speech-input/settings",
      payload: {
        expectedRevision: revision,
        settings: { provider: "auto", cloud: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe" } },
        credential: { action: "preserve" },
      },
    });
    expect(update.statusCode).toBe(200);
    expect(invalidate).toHaveBeenCalledTimes(1);

    const secondStatus = await appTestContext.app.inject({ method: "GET", url: "/api/pi-webui/status" });
    expect(secondStatus.statusCode).toBe(200);
    const runtimeLoadsAfter = appTestContext.sessionDaemonRequests.filter((request) => request.path === "/runtime").length;
    expect(runtimeLoadsAfter).toBe(runtimeLoadsBefore + 1);
  });

  it("does not invalidate the status cache when a speech update fails validation, conflicts, or hits a busy coordinator", async () => {
    const invalidate = vi.spyOn(appTestContext.piWebUiStatusCache, "invalidate");
    await appTestContext.app.inject({ method: "GET", url: "/api/pi-webui/status" });

    const current = await appTestContext.app.inject({ method: "GET", url: "/api/speech-input/settings" });
    const { revision } = current.json<SpeechInputSettingsResponse>();
    const settings = { provider: "auto", cloud: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe" } };

    const invalid = await appTestContext.app.inject({
      method: "PUT",
      url: "/api/speech-input/settings",
      payload: { expectedRevision: revision, settings: { provider: "local", cloud: settings.cloud }, credential: { action: "preserve" } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalidate).not.toHaveBeenCalled();

    const conflict = await appTestContext.app.inject({
      method: "PUT",
      url: "/api/speech-input/settings",
      payload: { expectedRevision: "00000000-0000-4000-8000-000000000000", settings, credential: { action: "preserve" } },
    });
    expect(conflict.statusCode).toBe(409);
    expect(invalidate).not.toHaveBeenCalled();

    appTestContext.speechInputCoordinator.setBusy(true);
    const busy = await appTestContext.app.inject({
      method: "PUT",
      url: "/api/speech-input/settings",
      payload: { expectedRevision: revision, settings, credential: { action: "preserve" } },
    });
    expect(busy.statusCode).toBe(503);
    expect(invalidate).not.toHaveBeenCalled();
  });
});

/**
 * Production composition regression: generic config writes and speech
 * settings writes must flow through the exact same coordinator instance.
 * `src/server/index.ts` previously built the file config service with an
 * internal coordinator while `buildApp` lazily created a second one for
 * speech settings, so a speech mutation never passed through the same
 * authority as a generic write.
 */
describe("production gateway config composition shares one mutation authority", () => {
  it("routes generic and speech mutations through the exact same coordinator and preserves each other's fields", async () => {
    const tempDir = await realpath(await mkdtemp(join(tmpdir(), "pi-webui-speech-composition-")));
    const configPath = join(tempDir, "config.json");
    const dataDir = join(tempDir, "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = Object.freeze({
      ...process.env,
      PI_WEBUI_CONFIG: configPath,
      PI_WEBUI_DATA_DIR: dataDir,
    });

    const tracked = trackCoordinator(sharedConfigMutationCoordinator(undefined, env));
    const composition = createGatewayConfigComposition(env, tracked);
    // The production helper hands back the exact injected authority.
    expect(composition.coordinator).toBe(tracked);

    const app = await buildApp({
      config: composition.config,
      configMutationCoordinator: composition.coordinator,
      clientDist: false,
      logger: false,
    });

    try {
      const initial = await app.inject({ method: "GET", url: "/api/speech-input/settings" });
      expect(initial.statusCode).toBe(200);
      const initialBody = initial.json<SpeechInputSettingsResponse>();
      expect(initialBody).toMatchObject({
        contractVersion: 1,
        settings: { provider: "auto", cloud: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe" } },
        credential: { configured: false, resolution: "missing" },
      });
      expect(tracked.reads).toBeGreaterThanOrEqual(1);

      // Speech write 1: replace stores the literal credential and rotates.
      const replace = await app.inject({
        method: "PUT",
        url: "/api/speech-input/settings",
        payload: {
          expectedRevision: initialBody.revision,
          settings: { provider: "cloud", cloud: { baseUrl: "https://api.openai.com/v1", model: "whisper-model" } },
          credential: { action: "replace", value: "sk-test-literal-123" },
        },
      });
      expect(replace.statusCode).toBe(200);
      const replaced = replace.json<SpeechInputSettingsResponse>();
      expect(replaced.revision).not.toBe(initialBody.revision);
      expect(replaced.settings).toEqual({ provider: "cloud", cloud: { baseUrl: "https://api.openai.com/v1", model: "whisper-model" } });
      expect(replaced.credential).toEqual({ configured: true, source: "literal", resolution: "resolved" });
      expect(tracked.mutations).toBe(1);

      // Generic write 2: goes through the same tracked coordinator and
      // preserves the committed speech subtree (and its revision).
      const generic = await app.inject({ method: "PUT", url: "/api/config", payload: { config: { spawnSessions: true } } });
      expect(generic.statusCode).toBe(200);
      const genericBody = generic.json<PiWebUiConfigResponse>();
      expect(genericBody.config.spawnSessions).toBe(true);
      expect("speechInput" in genericBody.config).toBe(false);
      expect(tracked.mutations).toBe(2);

      const afterGeneric = await app.inject({ method: "GET", url: "/api/speech-input/settings" });
      expect(afterGeneric.statusCode).toBe(200);
      const afterGenericBody = afterGeneric.json<SpeechInputSettingsResponse>();
      expect(afterGenericBody.revision).toBe(replaced.revision);
      expect(afterGenericBody.settings).toEqual({ provider: "cloud", cloud: { baseUrl: "https://api.openai.com/v1", model: "whisper-model" } });
      expect(afterGenericBody.credential).toEqual({ configured: true, source: "literal", resolution: "resolved" });

      // Speech write 3: preserve with the same endpoint succeeds and keeps
      // the generic field.
      const preserve = await app.inject({
        method: "PUT",
        url: "/api/speech-input/settings",
        payload: {
          expectedRevision: afterGenericBody.revision,
          settings: { provider: "cloud", cloud: { baseUrl: "https://api.openai.com/v1", model: "whisper-model" } },
          credential: { action: "preserve" },
        },
      });
      expect(preserve.statusCode).toBe(200);
      expect(tracked.mutations).toBe(3);

      const finalConfig = await app.inject({ method: "GET", url: "/api/config" });
      expect(finalConfig.statusCode).toBe(200);
      expect(finalConfig.json<PiWebUiConfigResponse>().config.spawnSessions).toBe(true);

      // Both authorities' committed fields live in one on-disk file.
      const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      expect(raw).toMatchObject({
        spawnSessions: true,
        speechInput: {
          provider: "cloud",
          cloud: { baseUrl: "https://api.openai.com/v1", model: "whisper-model", apiKey: "sk-test-literal-123" },
        },
      });
    } finally {
      await app.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

interface TrackedCoordinator extends PiWebUiConfigMutationCoordinator {
  reads: number;
  mutations: number;
}

function trackCoordinator(inner: PiWebUiConfigMutationCoordinator): TrackedCoordinator {
  const tracked: TrackedCoordinator = {
    reads: 0,
    mutations: 0,
    async read() {
      tracked.reads += 1;
      return inner.read();
    },
    async mutate(mutate, mutationOptions) {
      tracked.mutations += 1;
      return inner.mutate(mutate, mutationOptions);
    },
  };
  return tracked;
}
