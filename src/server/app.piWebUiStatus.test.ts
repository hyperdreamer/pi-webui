import { describe, expect, it, vi } from "vitest";
import type { PiWebUiStatusResponse } from "../shared/apiTypes.js";
import { buildApp } from "./app.js";

describe("PI WEBUI status routes", () => {
  it("forces a fresh status load when refresh is requested", async () => {
    const get = vi.fn(() => Promise.resolve(status("cached")));
    const refresh = vi.fn(() => Promise.resolve(status("forced")));
    const invalidate = vi.fn();
    const app = await buildApp({ piWebUiStatusCache: { get, refresh, invalidate }, clientDist: false, logger: false });

    try {
      const cachedResponse = await app.inject({ method: "GET", url: "/api/pi-webui/status" });
      const forcedResponse = await app.inject({ method: "GET", url: "/api/pi-webui/status?refresh=1" });

      expect(cachedResponse.json<PiWebUiStatusResponse>().generatedAt).toBe("cached");
      expect(forcedResponse.json<PiWebUiStatusResponse>().generatedAt).toBe("forced");
      expect(get).toHaveBeenCalledOnce();
      expect(refresh).toHaveBeenCalledOnce();
      expect(refresh).toHaveBeenCalledWith({ force: true });
    } finally {
      await app.close();
    }
  });
});

function status(generatedAt: string): PiWebUiStatusResponse {
  return {
    packageName: "@hyperdreamer/pi-webui",
    generatedAt,
    components: {
      web: { component: "web", label: "Web/UI", stale: false, available: true },
      sessiond: { component: "sessiond", label: "Session daemon", stale: false, available: true },
    },
    release: { packageName: "@hyperdreamer/pi-webui", updateAvailable: false },
    commands: {},
    messages: [],
  };
}
