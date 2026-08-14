import { describe, expect, it, vi } from "vitest";
import type { SpeechInputSettingsResponse } from "../shared/apiTypes.js";
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
