import { describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createSpeechInputSettingsService, type SpeechInputSettingsService } from "./speechInputSettingsService";
import { registerSpeechInputSettingsRoutes } from "./speechInputSettingsRoutes";
import { SPEECH_INPUT_TEST_REVISION, createInMemorySpeechInputConfigCoordinator, testSpeechInputRevision } from "./speechInputSettingsService.testSupport";

const DEFAULT_CLOUD = { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe" };

function validUpdate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    expectedRevision: SPEECH_INPUT_TEST_REVISION,
    settings: { provider: "auto", cloud: DEFAULT_CLOUD },
    credential: { action: "preserve" },
    ...overrides,
  };
}

async function buildRouteApp(service: SpeechInputSettingsService): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerSpeechInputSettingsRoutes(app, service);
  return app;
}

describe("speech input settings routes", () => {
  it("serves the redacted settings snapshot", async () => {
    const coordinator = createInMemorySpeechInputConfigCoordinator({
      config: { speechInput: { provider: "cloud", cloud: { ...DEFAULT_CLOUD, apiKey: "sk-secret" } } },
    });
    const app = await buildRouteApp(createSpeechInputSettingsService({ coordinator }));

    try {
      const response = await app.inject({ method: "GET", url: "/api/speech-input/settings" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        contractVersion: 1,
        revision: SPEECH_INPUT_TEST_REVISION,
        settings: { provider: "cloud", cloud: DEFAULT_CLOUD },
        credential: { configured: true, source: "literal", resolution: "resolved" },
      });
      expect(response.body).not.toContain("sk-secret");
    } finally {
      await app.close();
    }
  });

  it("applies a valid update and returns the rotated revision", async () => {
    const coordinator = createInMemorySpeechInputConfigCoordinator({});
    const app = await buildRouteApp(createSpeechInputSettingsService({ coordinator }));

    try {
      const update = await app.inject({
        method: "PUT",
        url: "/api/speech-input/settings",
        payload: validUpdate({
          settings: { provider: "browser", language: "pt-BR", cloud: { baseUrl: "https://gateway.example.test/v1", model: "whisper-1" } },
        }),
      });

      expect(update.statusCode).toBe(200);
      expect(update.json()).toEqual({
        contractVersion: 1,
        revision: testSpeechInputRevision(2),
        settings: {
          provider: "browser",
          language: "pt-BR",
          cloud: { baseUrl: "https://gateway.example.test/v1", model: "whisper-1" },
        },
        credential: { configured: false, resolution: "missing" },
      });

      const reread = await app.inject({ method: "GET", url: "/api/speech-input/settings" });
      expect(reread.json()).toMatchObject({ revision: testSpeechInputRevision(2) });
    } finally {
      await app.close();
    }
  });

  it("rejects malformed updates with a strict 400", async () => {
    const coordinator = createInMemorySpeechInputConfigCoordinator({});
    const app = await buildRouteApp(createSpeechInputSettingsService({ coordinator }));

    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/speech-input/settings",
        payload: validUpdate({ settings: { provider: "local", cloud: DEFAULT_CLOUD } }),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "Speech input settings provider must be auto, browser, or cloud" });
    } finally {
      await app.close();
    }
  });

  it("rejects a preserved-credential endpoint change with the exact 400 message", async () => {
    const coordinator = createInMemorySpeechInputConfigCoordinator({
      config: { speechInput: { cloud: { apiKey: "sk-secret" } } },
    });
    const app = await buildRouteApp(createSpeechInputSettingsService({ coordinator }));

    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/speech-input/settings",
        payload: validUpdate({ settings: { provider: "auto", cloud: { baseUrl: "https://evil.example.test/v1", model: "gpt-4o-mini-transcribe" } } }),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "Re-enter the API key source when changing the cloud base URL." });
      expect(response.body).not.toContain("sk-secret");
    } finally {
      await app.close();
    }
  });

  it("maps the typed revision conflict to the exact 409 without leaking state", async () => {
    const coordinator = createInMemorySpeechInputConfigCoordinator({});
    const app = await buildRouteApp(createSpeechInputSettingsService({ coordinator }));

    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/speech-input/settings",
        payload: validUpdate({ expectedRevision: testSpeechInputRevision(9) }),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: "Speech input settings changed. Reload and try again." });
      expect(response.body).not.toContain(SPEECH_INPUT_TEST_REVISION);
    } finally {
      await app.close();
    }
  });

  it("maps typed coordinator contention to the exact 503", async () => {
    const coordinator = createInMemorySpeechInputConfigCoordinator({});
    coordinator.setBusy(true);
    const app = await buildRouteApp(createSpeechInputSettingsService({ coordinator }));

    try {
      const read = await app.inject({ method: "GET", url: "/api/speech-input/settings" });
      expect(read.statusCode).toBe(503);
      expect(read.json()).toEqual({ error: "PI WEBUI config is busy. Try again." });

      const update = await app.inject({ method: "PUT", url: "/api/speech-input/settings", payload: validUpdate() });
      expect(update.statusCode).toBe(503);
      expect(update.json()).toEqual({ error: "PI WEBUI config is busy. Try again." });
    } finally {
      await app.close();
    }
  });

  it("maps unexpected failures to a safe 500 without leaking details", async () => {
    const failing: SpeechInputSettingsService = {
      read: () => Promise.reject(new Error("secret sk-detail for GET")),
      update: () => Promise.reject(new Error("secret sk-detail for PUT")),
    };
    const app = await buildRouteApp(failing);

    try {
      const read = await app.inject({ method: "GET", url: "/api/speech-input/settings" });
      expect(read.statusCode).toBe(500);
      expect(read.json()).toEqual({ error: "Speech input settings request failed." });
      expect(read.body).not.toContain("sk-detail");

      const update = await app.inject({ method: "PUT", url: "/api/speech-input/settings", payload: validUpdate() });
      expect(update.statusCode).toBe(500);
      expect(update.json()).toEqual({ error: "Speech input settings request failed." });
      expect(update.body).not.toContain("sk-detail");
    } finally {
      await app.close();
    }
  });

  it("answers 404 for the selected-machine alias", async () => {
    const coordinator = createInMemorySpeechInputConfigCoordinator({});
    const app = await buildRouteApp(createSpeechInputSettingsService({ coordinator }));

    try {
      const get = await app.inject({ method: "GET", url: "/api/machines/local/speech-input/settings" });
      expect(get.statusCode).toBe(404);

      const update = await app.inject({ method: "PUT", url: "/api/machines/local/speech-input/settings", payload: validUpdate() });
      expect(update.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
