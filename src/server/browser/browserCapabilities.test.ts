import { describe, expect, it } from "vitest";
import { evaluateBrowserRemoteCapability, type BrowserPrincipal } from "./browserCapabilities.js";
import type { BrowserRuntimeReadiness } from "./browserRuntime.js";

const browserUser: BrowserPrincipal = { subject: "user-1", permissions: ["browser.use"] };

function readyRuntime(): BrowserRuntimeReadiness {
  return {
    controlChannel: "authenticated-private",
    chromiumSandbox: "enforced",
    profileIsolation: "ephemeral-per-principal",
    hostIsolation: "enforced",
    debuggingTransport: "pipe-private",
    egress: { state: "enforced", mode: "domain-allowlist", privateNetworksBlocked: true },
    protocolVersions: [1],
    limits: { maxTabsPerSession: 10, maxSessionsPerPrincipal: 2 },
  };
}

describe("remote-browser capability policy", () => {
  it("requires a trusted principal before reporting browser availability", () => {
    expect(evaluateBrowserRemoteCapability(undefined, readyRuntime())).toEqual({
      available: false,
      code: "BROWSER_AUTH_REQUIRED",
      retryable: false,
    });
  });

  it("requires the browser.use permission", () => {
    expect(evaluateBrowserRemoteCapability({ subject: "user-1", permissions: [] }, readyRuntime())).toEqual({
      available: false,
      code: "BROWSER_FORBIDDEN",
      retryable: false,
    });
  });

  it.each([
    ["private control channel", { controlChannel: "unavailable" }],
    ["Chromium sandbox", { chromiumSandbox: "unavailable" }],
    ["ephemeral profile isolation", { profileIsolation: "unavailable" }],
    ["egress enforcement", { egress: { state: "unavailable", mode: "domain-allowlist", privateNetworksBlocked: false } }],
  ] as const)("fails closed when %s is unavailable", (_name, unsafeRuntime) => {
    expect(evaluateBrowserRemoteCapability(browserUser, { ...readyRuntime(), ...unsafeRuntime })).toEqual({
      available: false,
      code: "BROWSER_UNAVAILABLE",
      retryable: true,
    });
  });

  it("fails closed when runtime host isolation or debug transport is unavailable", () => {
    const missingHostIsolation = { ...readyRuntime() };
    Reflect.set(missingHostIsolation, "hostIsolation", "unavailable");
    const missingDebugPipe = { ...readyRuntime() };
    Reflect.set(missingDebugPipe, "debuggingTransport", "unavailable");

    expect(evaluateBrowserRemoteCapability(browserUser, missingHostIsolation)).toMatchObject({
      available: false,
      code: "BROWSER_UNAVAILABLE",
    });
    expect(evaluateBrowserRemoteCapability(browserUser, missingDebugPipe)).toMatchObject({
      available: false,
      code: "BROWSER_UNAVAILABLE",
    });
  });

  it("fails closed for malformed principal and runtime readiness values", () => {
    const malformedPrincipal = { ...browserUser };
    Reflect.set(malformedPrincipal, "permissions", "browser.use");
    const malformedRuntime = { ...readyRuntime() };
    Reflect.deleteProperty(malformedRuntime, "limits");

    expect(evaluateBrowserRemoteCapability(malformedPrincipal, readyRuntime())).toEqual({
      available: false,
      code: "BROWSER_AUTH_REQUIRED",
      retryable: false,
    });
    expect(evaluateBrowserRemoteCapability(browserUser, malformedRuntime)).toEqual({
      available: false,
      code: "BROWSER_UNAVAILABLE",
      retryable: true,
    });
  });

  it("publishes only the safe capability projection after every prerequisite passes", () => {
    expect(evaluateBrowserRemoteCapability(browserUser, readyRuntime())).toEqual({
      available: true,
      protocolVersions: [1],
      profileModes: ["ephemeral"],
      limits: { maxTabsPerSession: 10, maxSessionsPerPrincipal: 2 },
      egress: { mode: "domain-allowlist", privateNetworksBlocked: true },
    });
  });

  it("fails closed when runtime limits exceed the initial isolation budget", () => {
    expect(evaluateBrowserRemoteCapability(browserUser, {
      ...readyRuntime(),
      limits: { maxTabsPerSession: 11, maxSessionsPerPrincipal: 2 },
    })).toEqual({
      available: false,
      code: "BROWSER_UNAVAILABLE",
      retryable: true,
    });
  });
});
