import { describe, expect, it } from "vitest";
import { resolveAppUrl, resolveAppWebSocketUrl, type AppUrlContext } from "./appUrl";

const rootHttpContext: AppUrlContext = {
  viteBaseUrl: "/",
  documentBaseUrl: "http://pi.example.test/",
};

const nestedHttpsContext: AppUrlContext = {
  viteBaseUrl: "./",
  documentBaseUrl: "https://pi.example.test/test/ai/",
};

describe("application URLs", () => {
  it("resolves app-owned paths at an HTTP root deployment", () => {
    expect(resolveAppUrl("api/pi-webui/status", rootHttpContext)).toBe("http://pi.example.test/api/pi-webui/status");
    expect(resolveAppUrl("/pi-webui-plugins/manifest.json", rootHttpContext)).toBe("http://pi.example.test/pi-webui-plugins/manifest.json");
  });

  it("resolves paths within a canonical nested HTTPS deployment", () => {
    expect(resolveAppUrl("api/pi-webui/status", nestedHttpsContext)).toBe("https://pi.example.test/test/ai/api/pi-webui/status");
    expect(resolveAppUrl("/pi-webui-plugins/manifest.json", nestedHttpsContext)).toBe("https://pi.example.test/test/ai/pi-webui-plugins/manifest.json");
  });

  it("preserves encoded path segments and query parameters", () => {
    expect(resolveAppUrl("api/machines/remote%20a/sessions/s%2F1/events?cwd=%2Frepo+one&before=10", nestedHttpsContext))
      .toBe("https://pi.example.test/test/ai/api/machines/remote%20a/sessions/s%2F1/events?cwd=%2Frepo+one&before=10");
  });
});

describe("application WebSocket URLs", () => {
  it("maps root HTTP URLs to absolute ws URLs", () => {
    expect(resolveAppWebSocketUrl("api/machines/local/events", rootHttpContext)).toBe("ws://pi.example.test/api/machines/local/events");
  });

  it("maps nested HTTPS URLs to absolute wss URLs without losing path or query data", () => {
    expect(resolveAppWebSocketUrl("api/machines/remote%20a/sessions/s%2F1/events?cwd=%2Frepo+one", nestedHttpsContext))
      .toBe("wss://pi.example.test/test/ai/api/machines/remote%20a/sessions/s%2F1/events?cwd=%2Frepo+one");
  });
});
