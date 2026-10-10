import { describe, expect, it } from "vitest";
import { sessiondListenerConfig, sessiondListenOptions } from "./listenerConfig.js";

describe("sessiondListenerConfig", () => {
  it("resolves env and file port and host with provenance", () => {
    expect(sessiondListenerConfig(undefined, { PI_WEBUI_SESSIOND_PORT: "8810" })).toEqual({ kind: "tcp", host: "127.0.0.1", port: 8810, hostSource: "default", portSource: "env" });
    expect(sessiondListenerConfig({ host: "0.0.0.0", port: 8810 }, {})).toEqual({ kind: "tcp", host: "0.0.0.0", port: 8810, hostSource: "config", portSource: "config" });
    expect(sessiondListenerConfig({ host: "0.0.0.0", port: 8810 }, { PI_WEBUI_SESSIOND_HOST: "::1" })).toEqual({ kind: "tcp", host: "::1", port: 8810, hostSource: "env", portSource: "config" });
    expect(sessiondListenerConfig({ host: "0.0.0.0", port: 8810 }, { PI_WEBUI_SESSIOND_PORT: "9000" })).toEqual({ kind: "tcp", host: "0.0.0.0", port: 9000, hostSource: "config", portSource: "env" });
  });

  it("binds the socket when no port comes from the file or environment", () => {
    expect(sessiondListenerConfig(undefined, {})).toEqual({ kind: "socket" });
    expect(sessiondListenerConfig({ host: "0.0.0.0" }, {})).toEqual({ kind: "socket" });
  });

  it("treats a blank environment port as absent", () => {
    for (const value of ["", "   "]) {
      expect(sessiondListenerConfig({ port: 8810 }, { PI_WEBUI_SESSIOND_PORT: value })).toEqual({ kind: "tcp", host: "127.0.0.1", port: 8810, hostSource: "default", portSource: "config" });
      expect(sessiondListenerConfig(undefined, { PI_WEBUI_SESSIOND_PORT: value })).toEqual({ kind: "socket" });
    }
  });

  it("treats a blank environment host as absent", () => {
    for (const value of ["", "   "]) {
      expect(sessiondListenerConfig({ host: "0.0.0.0", port: 8810 }, { PI_WEBUI_SESSIOND_HOST: value })).toEqual({ kind: "tcp", host: "0.0.0.0", port: 8810, hostSource: "config", portSource: "config" });
      expect(sessiondListenerConfig({ port: 8810 }, { PI_WEBUI_SESSIOND_HOST: value })).toEqual({ kind: "tcp", host: "127.0.0.1", port: 8810, hostSource: "default", portSource: "config" });
    }
  });

  it("rejects an unparseable environment port", () => {
    for (const value of ["abc", "0", "65536", "8810.5"]) {
      expect(() => sessiondListenerConfig(undefined, { PI_WEBUI_SESSIOND_PORT: value }))
        .toThrow("PI WEBUI config PI_WEBUI_SESSIOND_PORT must be an integer from 1 to 65535: environment");
    }
  });

  it("ignores the url subtree entirely", () => {
    expect(sessiondListenerConfig({ url: "ftp://host", port: 8810 }, {})).toEqual({ kind: "tcp", host: "127.0.0.1", port: 8810, hostSource: "default", portSource: "config" });
  });
});

describe("sessiondListenOptions", () => {
  it("maps TCP listeners to port and host and ignores the socket path", () => {
    const listener = { kind: "tcp" as const, host: "0.0.0.0", port: 8810, hostSource: "config" as const, portSource: "config" as const };
    const first = sessiondListenOptions(listener, "/tmp/unused-a.sock");
    const second = sessiondListenOptions(listener, "/tmp/unused-b.sock");

    expect(first).toEqual({ port: 8810, host: "0.0.0.0" });
    expect(second).toEqual({ port: 8810, host: "0.0.0.0" });
    expect("path" in first).toBe(false);
  });

  it("maps a socket listener to the supplied path", () => {
    expect(sessiondListenOptions({ kind: "socket" }, "/run/user/1000/pi-webui/sessiond.sock")).toEqual({ path: "/run/user/1000/pi-webui/sessiond.sock" });
  });
});
