import { describe, expect, it } from "vitest";
import type { ActiveAgentProfileDescriptor, PiWebUiConfigResponse, PiWebUiConfigValues } from "../../api";
import { agentDirFieldOverridden, agentProfileActivationState, mergeSelectedMachineSessiondConfig, spawnSessionsConfigPatch, subsessionsConfigPatch } from "./settingsSessiondConfig";

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
      },
    });
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
