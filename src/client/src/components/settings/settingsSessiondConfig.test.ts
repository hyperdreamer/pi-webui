import { describe, expect, it } from "vitest";
import type { ActiveAgentProfileDescriptor, PiWebUiConfigResponse, PiWebUiConfigValues, PiWebUiSessiondListenerDescriptor } from "../../api";
import { agentProfileConfigPatchFromDraft } from "./settingsConfigDraft";
import { activationState, agentDirFieldOverridden, agentProfileActivationState, coherenceWarning, coherenceWarningMessage, mergeSelectedMachineSessiondConfig, spawnSessionsConfigPatch, subsessionsConfigPatch } from "./settingsSessiondConfig";

describe("session daemon settings config helpers", () => {
  it("builds daemon-only save patches for the sessiond toggles", () => {
    expect(spawnSessionsConfigPatch(false)).toEqual({ spawnSessions: false });
    expect(subsessionsConfigPatch(true)).toEqual({ subsessions: true });
  });

  it("compares the desired effective profile with the daemon-owned active profile", () => {
    const config = configResponse(
      { agent: { command: "configured-agent", dir: "/configured" } },
      {},
      { agent: { command: "effective-agent", dir: "/effective" } },
    );

    expect(agentProfileActivationState(config, activeProfile("effective-agent", "/effective"))).toBe("active");
    expect(agentProfileActivationState(config, activeProfile("other-agent", "/effective"))).toBe("restart-required");
    expect(agentProfileActivationState(config, activeProfile("effective-agent", "/other"))).toBe("restart-required");
    expect(agentProfileActivationState(configResponse({}, {}, { agent: { command: "pi", dir: "/effective" } }), activeProfile("pi", "/effective"))).toBe("restart-required");
    expect(agentProfileActivationState(configResponse({}, {}, { agent: { command: "pi", dir: "/effective" } }), activeProfile("pi", "/effective", ["PI_WEBUI_AGENT_SESSION_DIR", "PI_CODING_AGENT_SESSION_DIR"]))).toBe("active");
    expect(agentProfileActivationState(config, undefined)).toBe("unavailable");
    expect(agentProfileActivationState(undefined, activeProfile("effective-agent", "/effective"))).toBe("unavailable");
  });

  it("releases only Pi's compatibility directory override when the draft selects an alternate command", () => {
    const baseOverrides = configResponse({}).envOverrides;

    expect(agentDirFieldOverridden({ ...baseOverrides, agentDir: true, agentDirSource: "pi-compatibility" }, "pi")).toBe(true);
    expect(agentDirFieldOverridden({ ...baseOverrides, agentDir: true, agentDirSource: "pi-compatibility" }, "pi.exe")).toBe(true);
    expect(agentDirFieldOverridden({ ...baseOverrides, agentDir: true, agentDirSource: "pi-compatibility" }, "alternate-agent")).toBe(false);
    expect(agentDirFieldOverridden({ ...baseOverrides, agentDir: true, agentDirSource: "pi-webui" }, "alternate-agent")).toBe(true);
    expect(agentDirFieldOverridden({ ...baseOverrides, agentDir: true }, "alternate-agent")).toBe(true);
  });

  it("does not leak the gateway agent directory source into a selected-machine response", () => {
    const gateway = configResponse({}, { agentDir: true, agentDirSource: "pi-webui" });
    const selectedMachine = configResponse({}, { agentDir: false });

    expect(mergeSelectedMachineSessiondConfig(gateway, selectedMachine).envOverrides.agentDirSource).toBeUndefined();
  });

  it("merges local selected-machine daemon config into gateway config without dropping gateway-only values", () => {
    const gateway = configResponse({
      host: "127.0.0.1",
      port: 8808,
      allowedHosts: ["gateway.local"],
      shortcuts: { "core:view.chat": "mod+1" },
      plugins: { info: { enabled: true } },
      spawnSessions: false,
      subsessions: false,
      agent: { command: "gateway-agent", dir: "/srv/gateway-agent" },
    });
    const selectedMachine = configResponse(
      { spawnSessions: true, subsessions: true, agent: { command: "machine-agent", dir: "/srv/machine-agent" } },
      { spawnSessions: true, subsessions: false, agentCommand: true, agentDir: false, agentDirSource: "pi-compatibility", agentSessionDir: true },
      { spawnSessions: true, subsessions: true, agent: { command: "env-agent", dir: "/srv/machine-agent" } },
    );

    expect(mergeSelectedMachineSessiondConfig(gateway, selectedMachine)).toEqual({
      ...gateway,
      config: {
        host: "127.0.0.1",
        port: 8808,
        allowedHosts: ["gateway.local"],
        shortcuts: { "core:view.chat": "mod+1" },
        plugins: { info: { enabled: true } },
        spawnSessions: true,
        subsessions: true,
        agent: { command: "machine-agent", dir: "/srv/machine-agent" },
      },
      effectiveConfig: {
        host: "127.0.0.1",
        port: 8808,
        allowedHosts: ["gateway.local"],
        shortcuts: { "core:view.chat": "mod+1" },
        plugins: { info: { enabled: true } },
        spawnSessions: true,
        subsessions: true,
        agent: { command: "env-agent", dir: "/srv/machine-agent" },
      },
      envOverrides: {
        host: false,
        port: false,
        allowedHosts: false,
        spawnSessions: true,
        subsessions: false,
        agentCommand: true,
        agentDir: false,
        agentDirSource: "pi-compatibility",
        agentSessionDir: true,
        sessiondUrl: false,
      },
    });
  });

  it("merges the selected machine listener subtree and override flag", () => {
    const gateway = configResponse({ spawnSessions: false }, { host: true });
    const selectedMachine = configResponse(
      { sessiond: { host: "0.0.0.0", port: 8810, url: "http://127.0.0.1:8810" } },
      { sessiondUrl: true },
      { sessiond: { host: "0.0.0.0", port: 8810 } },
    );

    const merged = mergeSelectedMachineSessiondConfig(gateway, selectedMachine);

    expect(merged.config.sessiond).toEqual({ host: "0.0.0.0", port: 8810, url: "http://127.0.0.1:8810" });
    expect(merged.effectiveConfig.sessiond).toEqual({ host: "0.0.0.0", port: 8810 });
    expect(merged.envOverrides.sessiondUrl).toBe(true);
    expect(merged.envOverrides.host).toBe(true);
  });
});

describe("session daemon coherence warning", () => {
  function tcp(hostSource: "env" | "config" | "default", portSource: "env" | "config"): PiWebUiSessiondListenerDescriptor {
    return { kind: "tcp", host: "127.0.0.1", port: 8810, hostSource, portSource };
  }

  it("warns about exactly one configured half of the listener pair", () => {
    expect(coherenceWarning({ port: 8810 }, false, undefined)).toBe("missing-dial-target");
    expect(coherenceWarning({ port: 8810 }, true, undefined)).toBeUndefined();
    expect(coherenceWarning({ url: "http://127.0.0.1:8810" }, false, undefined)).toBe("missing-bind-port");
    expect(coherenceWarning({ url: "http://127.0.0.1:8810" }, false, tcp("config", "env"))).toBeUndefined();
    expect(coherenceWarning({ url: "http://127.0.0.1:8810" }, false, tcp("env", "config"))).toBe("missing-bind-port");
    expect(coherenceWarning({ url: "http://127.0.0.1:8810" }, false, { kind: "socket" })).toBe("missing-bind-port");
    expect(coherenceWarning({ port: 8810, url: "http://127.0.0.1:8810" }, false, undefined)).toBeUndefined();
    expect(coherenceWarning({ port: 8810, url: "http://127.0.0.1:8810" }, true, undefined)).toBeUndefined();
    expect(coherenceWarning(undefined, true, undefined)).toBeUndefined();
    expect(coherenceWarning({ port: 8810 }, false, tcp("config", "config"))).toBe("missing-dial-target");
  });

  it("shows the bind half until the daemon reports an environment port", () => {
    const fileSessiond = { url: "http://127.0.0.1:8810" };

    expect(coherenceWarning(fileSessiond, false, tcp("env", "config"))).toBe("missing-bind-port");
    expect(coherenceWarning(fileSessiond, false, tcp("env", "env"))).toBeUndefined();
  });

  it("returns the pinned coherence messages", () => {
    expect(coherenceWarningMessage("missing-dial-target")).toBe("sessiond.port is configured, but no sessiond.url is set and PI_WEBUI_SESSIOND_URL is not set on that machine, so the web/API will dial the session daemon socket while the daemon listens on TCP. Add sessiond.url or remove sessiond.port.");
    expect(coherenceWarningMessage("missing-bind-port")).toBe("sessiond.url is configured, but no sessiond.port is set and PI_WEBUI_SESSIOND_PORT is not set on that machine, so the daemon will listen on the session daemon socket. Add sessiond.port or remove sessiond.url.");
  });
});

describe("session daemon activation state", () => {
  function tcp(host: string, port: number, hostSource: "env" | "config" | "default", portSource: "env" | "config"): PiWebUiSessiondListenerDescriptor {
    return { kind: "tcp", host, port, hostSource, portSource };
  }

  it("resolves every verdict pairing", () => {
    expect(activationState({ host: "0.0.0.0", port: 8810 }, tcp("0.0.0.0", 8810, "env", "env"))).toBe("active");
    expect(activationState({ host: "0.0.0.0", port: 8810 }, tcp("127.0.0.1", 8810, "env", "config"))).toBe("overridden");
    expect(activationState({ host: "0.0.0.0", port: 8810 }, tcp("0.0.0.0", 9000, "config", "env"))).toBe("overridden");
    expect(activationState({ host: "0.0.0.0", port: 8810 }, tcp("127.0.0.1", 9000, "env", "config"))).toBe("overridden");
    expect(activationState({ host: "0.0.0.0", port: 8810 }, tcp("127.0.0.1", 9000, "config", "env"))).toBe("overridden");
    expect(activationState({ host: "0.0.0.0", port: 8810 }, tcp("127.0.0.1", 9000, "config", "config"))).toBe("restart-required");
    expect(activationState({ host: "0.0.0.0", port: 8810 }, { kind: "socket" })).toBe("restart-required");
    expect(activationState({}, { kind: "socket" })).toBe("active");
    expect(activationState({}, tcp("127.0.0.1", 8810, "default", "env"))).toBe("overridden");
    expect(activationState({}, tcp("0.0.0.0", 8810, "env", "config"))).toBe("restart-required");
    expect(activationState({ port: 8810 }, tcp("127.0.0.1", 8810, "default", "config"))).toBe("active");
    expect(activationState(undefined, undefined)).toBe("unavailable");
  });

  it("normalizes a whitespace-padded or blank file host before comparison", () => {
    expect(activationState({ host: "  0.0.0.0  ", port: 8810 }, tcp("0.0.0.0", 8810, "config", "config"))).toBe("active");
    expect(activationState({ host: "   ", port: 8810 }, tcp("127.0.0.1", 8810, "default", "config"))).toBe("active");
    expect(activationState({ host: "  0.0.0.0  ", port: 8810 }, tcp("127.0.0.1", 8810, "config", "config"))).toBe("restart-required");
  });

  it("scopes environment influence to the differing value only", () => {
    expect(activationState({ host: "0.0.0.0", port: 8810 }, tcp("127.0.0.1", 8810, "default", "env"))).toBe("restart-required");
    expect(activationState({ host: "0.0.0.0", port: 8810 }, tcp("0.0.0.0", 9000, "env", "config"))).toBe("restart-required");
    expect(activationState({}, tcp("127.0.0.1", 8810, "env", "config"))).toBe("restart-required");
  });

  it("keeps the listener block out of every save draft builder", () => {
    expect(spawnSessionsConfigPatch(false)).toEqual({ spawnSessions: false });
    expect(subsessionsConfigPatch(true)).toEqual({ subsessions: true });
    expect(agentProfileConfigPatchFromDraft({ command: "pi", dir: "/srv/pi" })).toEqual({ agent: { command: "pi", dir: "/srv/pi" } });
    for (const patch of [spawnSessionsConfigPatch(false), subsessionsConfigPatch(true), agentProfileConfigPatchFromDraft({ command: "pi", dir: "/srv/pi" })]) {
      expect(patch).not.toHaveProperty("sessiond");
      expect(patch).not.toHaveProperty("sessiondListener");
    }
  });
});

function activeProfile(command: string, dir: string, sessionDirEnvKeys: readonly string[] = ["PI_WEBUI_AGENT_SESSION_DIR"]): ActiveAgentProfileDescriptor {
  return {
    schemaVersion: 1,
    revision: `sha256:${"a".repeat(64)}`,
    command,
    dir,
    sessionDirEnvKeys,
  };
}

function configResponse(
  config: PiWebUiConfigValues,
  overrides: Partial<PiWebUiConfigResponse["envOverrides"]> = {},
  effectiveConfig: PiWebUiConfigValues = config,
): PiWebUiConfigResponse {
  return {
    path: "/tmp/pi-webui/config.json",
    exists: true,
    config,
    effectiveConfig,
    envOverrides: {
      host: false,
      port: false,
      allowedHosts: false,
      spawnSessions: false,
      subsessions: false,
      agentCommand: false,
      agentDir: false,
      agentSessionDir: false,
      ...overrides,
    },
  };
}
