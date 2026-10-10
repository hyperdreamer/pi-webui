import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPiWebUiConfig } from "../config.js";
import { sessiondHttpUrl } from "./config.js";
import { sessiondListenerConfig } from "./listenerConfig.js";
import { SessionDaemonClient } from "./sessionDaemonClient.js";

let tempDir: string;
let configPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-webui-sessiond-config-test-"));
  configPath = join(tempDir, "config.json");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(tempDir, { recursive: true, force: true });
});

async function writeConfig(value: unknown): Promise<void> {
  await writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("sessiondHttpUrl", () => {
  it("resolves the file url", async () => {
    await writeConfig({ sessiond: { url: "http://127.0.0.1:8810" } });

    expect(sessiondHttpUrl({ env: { PI_WEBUI_CONFIG: configPath } })).toBe("http://127.0.0.1:8810");
  });

  it("prefers and trims the environment url", async () => {
    await writeConfig({ sessiond: { url: "http://file:1" } });

    expect(sessiondHttpUrl({ env: { PI_WEBUI_CONFIG: configPath, PI_WEBUI_SESSIOND_URL: "  http://env:2  " } })).toBe("http://env:2");
  });

  it("falls back to the file url for a blank environment value", async () => {
    await writeConfig({ sessiond: { url: "http://file:1" } });

    for (const value of ["   ", ""]) {
      expect(sessiondHttpUrl({ env: { PI_WEBUI_CONFIG: configPath, PI_WEBUI_SESSIOND_URL: value } })).toBe("http://file:1");
    }
  });

  it("accepts valid url forms", async () => {
    for (const value of ["https://host", "http://127.0.0.1:8810/"]) {
      await writeConfig({ sessiond: { url: value } });
      expect(sessiondHttpUrl({ env: { PI_WEBUI_CONFIG: configPath } })).toBe(value);
    }
  });

  it("rejects invalid url forms with the pinned messages", async () => {
    const cases: readonly { value: string; message: string }[] = [
      { value: "127.0.0.1:8810", message: "must be an absolute http or https URL" },
      { value: "ftp://host", message: "must be an absolute http or https URL" },
      { value: "http://user:pass@host", message: "must not contain credentials" },
      { value: "http://host/?a=1", message: "must not contain a query string" },
      { value: "http://host/#x", message: "must not contain a fragment" },
      { value: "http://host/prefix", message: "must not contain a path" },
    ];
    for (const testCase of cases) {
      await writeConfig({ sessiond: { url: testCase.value } });
      expect(() => sessiondHttpUrl({ env: { PI_WEBUI_CONFIG: configPath } })).toThrow(`PI WEBUI config sessiond.url ${testCase.message}: ${configPath}`);
    }
  });

  it("fails the web/API connect resolution only for a malformed environment value", async () => {
    await writeConfig({ sessiond: { port: 8810 } });
    const options = { env: { PI_WEBUI_CONFIG: configPath, PI_WEBUI_SESSIOND_URL: "ftp://host" } };

    expect(() => sessiondHttpUrl(options)).toThrow(`PI WEBUI config sessiond.url must be an absolute http or https URL: ${configPath}`);
    expect(sessiondListenerConfig(loadPiWebUiConfig(options).config.sessiond, { PI_WEBUI_SESSIOND_URL: "ftp://host" })).toEqual({ kind: "tcp", host: "127.0.0.1", port: 8810, hostSource: "default", portSource: "config" });
  });

  it("fails the web/API connect resolution only for a malformed file value", async () => {
    await writeConfig({ sessiond: { url: "ftp://host", port: 8810 } });
    const options = { env: { PI_WEBUI_CONFIG: configPath } };

    expect(() => sessiondHttpUrl(options)).toThrow(`PI WEBUI config sessiond.url must be an absolute http or https URL: ${configPath}`);
    expect(sessiondListenerConfig(loadPiWebUiConfig(options).config.sessiond, {})).toEqual({ kind: "tcp", host: "127.0.0.1", port: 8810, hostSource: "default", portSource: "config" });
  });

  it("pins the resolved transport for the client lifetime", async () => {
    await writeConfig({ sessiond: { url: "http://127.0.0.1:43123" } });
    const client = new SessionDaemonClient({ env: { PI_WEBUI_CONFIG: configPath, PI_WEBUI_SESSIOND_URL: "http://127.0.0.1:43123" } });
    vi.stubEnv("PI_WEBUI_SESSIOND_URL", "http://127.0.0.1:65530");
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);

    await client.request("GET", "/runtime");

    expect(fetchMock).toHaveBeenCalledWith(new URL("/runtime", "http://127.0.0.1:43123"), expect.objectContaining({ method: "GET" }));
  });
});
