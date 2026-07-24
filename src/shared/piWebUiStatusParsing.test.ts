import { describe, expect, it } from "vitest";
import { PI_WEBUI_CAPABILITIES } from "./capabilities";
import { parsePiWebUiComponentStatus, parsePiWebUiInstallationInfo, parsePiWebUiRuntimeResponse, parsePiWebUiVersionResponse } from "./piWebUiStatusParsing";

describe("PI WEBUI status parsing", () => {
  it("parses known top-level and component capabilities while ignoring unknown strings", () => {
    expect(parsePiWebUiRuntimeResponse({
      packageName: "@hyperdreamer/pi-webui",
      generatedAt: "now",
      components: {
        web: { component: "web", label: "Web/UI", runtimeVersion: "1.0.0", available: true, capabilities: [PI_WEBUI_CAPABILITIES.piPackagesManage, PI_WEBUI_CAPABILITIES.selectedMachineSettings, PI_WEBUI_CAPABILITIES.agentProfileConfig, "future.capability"] },
        sessiond: { component: "sessiond", label: "Session daemon", runtimeVersion: "1.0.0", available: true, capabilities: ["future.sessiondCapability"] },
      },
      capabilities: [PI_WEBUI_CAPABILITIES.piPackagesManage, PI_WEBUI_CAPABILITIES.selectedMachineSettings, PI_WEBUI_CAPABILITIES.agentProfileConfig, "future.capability"],
    })).toMatchObject({
      components: {
        web: { capabilities: [PI_WEBUI_CAPABILITIES.piPackagesManage, PI_WEBUI_CAPABILITIES.selectedMachineSettings, PI_WEBUI_CAPABILITIES.agentProfileConfig] },
        sessiond: { capabilities: [] },
      },
      capabilities: [PI_WEBUI_CAPABILITIES.piPackagesManage, PI_WEBUI_CAPABILITIES.selectedMachineSettings, PI_WEBUI_CAPABILITIES.agentProfileConfig],
    });
  });

  it("rejects runtime responses with malformed component capability arrays", () => {
    expect(parsePiWebUiRuntimeResponse({
      packageName: "@hyperdreamer/pi-webui",
      generatedAt: "now",
      components: {
        web: { component: "web", label: "Web/UI", available: true, capabilities: [PI_WEBUI_CAPABILITIES.piPackagesManage, 1] },
        sessiond: { component: "sessiond", label: "Session daemon", available: true, capabilities: [] },
      },
      capabilities: [PI_WEBUI_CAPABILITIES.piPackagesManage],
    })).toBeUndefined();
  });

  it("parses and freezes a session daemon active agent profile", () => {
    const parsed = parsePiWebUiRuntimeResponse({
      packageName: "@hyperdreamer/pi-webui",
      generatedAt: "now",
      components: {
        web: { component: "web", label: "Web/UI", available: true, capabilities: [] },
        sessiond: {
          component: "sessiond",
          label: "Session daemon",
          available: true,
          capabilities: [],
          activeAgentProfile: {
            schemaVersion: 1,
            revision: `sha256:${"a".repeat(64)}`,
            command: "acme-agent",
            dir: "/opt/acme-agent/state",
            sessionDirEnvKeys: ["PI_WEBUI_AGENT_SESSION_DIR"],
          },
        },
      },
      capabilities: [],
    });

    expect(parsed?.components.sessiond.activeAgentProfile).toMatchObject({ command: "acme-agent", dir: "/opt/acme-agent/state" });
    expect(Object.isFrozen(parsed?.components.sessiond.activeAgentProfile)).toBe(true);
    expect(Object.isFrozen(parsed?.components.sessiond.activeAgentProfile?.sessionDirEnvKeys)).toBe(true);
  });

  it("rejects malformed, secret-bearing, or web-owned active profile descriptors", () => {
    const profile = {
      schemaVersion: 1,
      revision: `sha256:${"a".repeat(64)}`,
      command: "acme-agent",
      dir: "/opt/acme-agent/state",
      sessionDirEnvKeys: ["PI_WEBUI_AGENT_SESSION_DIR"],
    };
    const responseFor = (webProfile: unknown, sessiondProfile: unknown) => ({
      packageName: "@hyperdreamer/pi-webui",
      generatedAt: "now",
      components: {
        web: { component: "web", label: "Web/UI", available: true, capabilities: [], ...(webProfile === undefined ? {} : { activeAgentProfile: webProfile }) },
        sessiond: { component: "sessiond", label: "Session daemon", available: true, capabilities: [], ...(sessiondProfile === undefined ? {} : { activeAgentProfile: sessiondProfile }) },
      },
      capabilities: [],
    });

    expect(parsePiWebUiRuntimeResponse(responseFor(undefined, { ...profile, token: "secret" }))).toBeUndefined();
    expect(parsePiWebUiRuntimeResponse(responseFor(undefined, { ...profile, command: "./acme-agent" }))).toBeUndefined();
    expect(parsePiWebUiRuntimeResponse(responseFor(undefined, { ...profile, dir: "relative/state" }))).toBeUndefined();
    expect(parsePiWebUiRuntimeResponse(responseFor(undefined, { ...profile, sessionDirEnvKeys: ["ARBITRARY_AGENT_SESSION_DIR"] }))).toBeUndefined();
    expect(parsePiWebUiRuntimeResponse(responseFor(profile, undefined))).toBeUndefined();
  });

  it("parses Docker installation metadata", () => {
    expect(parsePiWebUiInstallationInfo({ kind: "docker", path: "/srv/pi-webui-docker", dockerMode: "runtime" })).toEqual({
      kind: "docker",
      path: "/srv/pi-webui-docker",
      dockerMode: "runtime",
    });
    expect(parsePiWebUiInstallationInfo({ kind: "docker", path: "/workspace/pi-webui", dockerMode: "dev" })).toEqual({
      kind: "docker",
      path: "/workspace/pi-webui",
      dockerMode: "dev",
    });
  });

  it("ignores invalid optional Docker modes without rejecting component status", () => {
    expect(parsePiWebUiComponentStatus({
      component: "web",
      label: "Web/UI",
      runtimeVersion: "1.0.0",
      stale: false,
      available: true,
      installation: { kind: "docker", path: "/workspace/pi-webui", dockerMode: "hidden" },
    })?.installation).toEqual({ kind: "docker", path: "/workspace/pi-webui" });
  });

  it("parses version responses that include Docker runtime and development components", () => {
    const parsed = parsePiWebUiVersionResponse({
      packageName: "@hyperdreamer/pi-webui",
      generatedAt: "now",
      components: {
        web: { component: "web", label: "Web/UI", runtimeVersion: "1.0.0", stale: false, available: true, installation: { kind: "docker", path: "/srv/pi-webui-docker", dockerMode: "runtime" } },
        sessiond: { component: "sessiond", label: "Session daemon", runtimeVersion: "1.0.0", stale: false, available: true, installation: { kind: "docker", path: "/workspace/pi-webui", dockerMode: "dev" } },
      },
    });

    expect(parsed?.components.web.installation).toEqual({ kind: "docker", path: "/srv/pi-webui-docker", dockerMode: "runtime" });
    expect(parsed?.components.sessiond.installation).toEqual({ kind: "docker", path: "/workspace/pi-webui", dockerMode: "dev" });
  });
});
