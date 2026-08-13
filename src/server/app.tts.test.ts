import { describe, expect, it } from "vitest";
import type { HostSpeechStatus, HostSpeechStopResponse, HostSpeechTerminalResult } from "../shared/apiTypes.js";
import { FEDERATED_HTTP_ROUTES, FEDERATED_WEBSOCKET_ROUTES } from "../shared/federatedRoutes.js";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();

describe("buildApp gateway TTS routes", () => {
  it("serves gateway host speech status, speak, and stop routes", async () => {
    const statusResponse = await appTestContext.app.inject({ method: "GET", url: "/api/tts" });
    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json<HostSpeechStatus>()).toEqual(appTestContext.hostSpeech.statusValue);

    const speakResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/tts/speak",
      payload: { runId: "run-1", text: "Hello there", voice: "default", rate: 10 },
    });
    expect(speakResponse.statusCode).toBe(200);
    expect(speakResponse.json<HostSpeechTerminalResult>()).toEqual({ runId: "run-1", outcome: "ended" });
    expect(appTestContext.hostSpeech.speakCalls).toEqual([{ runId: "run-1", text: "Hello there", voice: "default", rate: 10 }]);

    const stopResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/tts/stop",
      payload: { runId: "run-1" },
    });
    expect(stopResponse.statusCode).toBe(200);
    expect(stopResponse.json<HostSpeechStopResponse>()).toEqual({ runId: "run-1", stopped: true });
    expect(appTestContext.hostSpeech.stopCalls).toEqual(["run-1"]);
  });

  it("answers 404 for selected-machine and remote TTS paths", async () => {
    const paths = [
      "/api/machines/local/tts",
      "/api/machines/local/tts/speak",
      "/api/machines/local/tts/stop",
      "/api/machines/remote/tts",
    ];

    for (const path of paths) {
      const response = await appTestContext.app.inject({ method: "POST", url: path });
      expect(response.statusCode).toBe(404);
    }
  });

  it("keeps TTS out of the federated route lists", () => {
    const ttsHttpPaths = FEDERATED_HTTP_ROUTES
      .map((spec) => spec.path)
      .filter((path) => path.startsWith("/tts"));
    const ttsSocketPaths = FEDERATED_WEBSOCKET_ROUTES.filter((path) => path.startsWith("/tts"));

    expect(ttsHttpPaths).toEqual([]);
    expect(ttsSocketPaths).toEqual([]);
  });

  it("closes host speech exactly once with the app", async () => {
    expect(appTestContext.hostSpeech.closeCalls).toBe(0);

    await appTestContext.app.close();

    expect(appTestContext.hostSpeech.closeCalls).toBe(1);

    await appTestContext.app.close();

    expect(appTestContext.hostSpeech.closeCalls).toBe(1);
  });
});
