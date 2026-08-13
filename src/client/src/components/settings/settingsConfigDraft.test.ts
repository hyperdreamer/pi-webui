import { describe, expect, it } from "vitest";
import {
  agentProfileConfigPatchFromDraft,
  agentProfileDraftFromConfig,
  agentProfileDraftMatchesConfig,
  emptyHostSpeechConfigDraft,
  gatewayServerConfigFromDraft,
  gatewayServerDraftFromConfig,
  hostSpeechConfigFromDraft,
  hostSpeechDraftFromConfig,
  hostSpeechDraftMatchesConfig,
  machineAccessConfigPatchFromDraft,
  machineAccessDraftFromConfig,
} from "./settingsConfigDraft";

describe("settings config drafts", () => {
  it("splits gateway server and selected-machine access drafts", () => {
    const config = {
      host: "0.0.0.0",
      port: 8808,
      allowedHosts: ["example.local", "192.168.1.20"],
      pathAccess: { allowedPaths: ["/tmp", "~/SDKs"] },
      uploads: { defaultFolder: "manual/uploads" },
    };

    expect(gatewayServerDraftFromConfig(config)).toEqual({
      host: "0.0.0.0",
      port: "8808",
      allowedHostsMode: "list",
      allowedHostsText: "example.local\n192.168.1.20",
    });
    expect(machineAccessDraftFromConfig(config)).toEqual({
      allowedPathsText: "/tmp\n~/SDKs",
      uploadDefaultFolder: "manual/uploads",
    });
    expect(gatewayServerDraftFromConfig({ allowedHosts: true }).allowedHostsMode).toBe("all");
  });

  it("builds one atomic agent profile patch from both draft fields", () => {
    expect(agentProfileDraftFromConfig({ agent: { command: "agent-lab", dir: "/srv/agent-lab" } })).toEqual({
      command: "agent-lab",
      dir: "/srv/agent-lab",
    });
    expect(agentProfileConfigPatchFromDraft({ command: " alternate-agent ", dir: " /srv/alternate-agent " })).toEqual({
      agent: { command: "alternate-agent", dir: "/srv/alternate-agent" },
    });
    expect(agentProfileConfigPatchFromDraft({ command: " ", dir: " " })).toEqual({ agent: {} });
    expect(agentProfileConfigPatchFromDraft({ command: " C:\\tools\\pi.exe ", dir: " C:\\agent-profiles\\work " })).toEqual({
      agent: { command: "C:\\tools\\pi.exe", dir: "C:\\agent-profiles\\work" },
    });
    expect(agentProfileDraftMatchesConfig({ command: " agent-lab ", dir: " /srv/agent-lab " }, { agent: { command: "agent-lab", dir: "/srv/agent-lab" } })).toBe(true);
    expect(agentProfileDraftMatchesConfig({ command: "agent-lab", dir: "/draft" }, { agent: { command: "agent-lab", dir: "/saved" } })).toBe(false);
  });

  it("builds gateway server saves without dropping preserved config values", () => {
    expect(gatewayServerConfigFromDraft({
      host: " gateway.local ",
      port: "9000",
      allowedHostsMode: "all",
      allowedHostsText: "ignored.local",
    }, {
      shortcuts: { "core:view.chat": "mod+1" },
      plugins: { info: { enabled: false } },
      pathAccess: { allowedPaths: ["/old"] },
      uploads: { defaultFolder: "old/uploads" },
      maxUploadBytes: 1234,
      spawnSessions: true,
      subsessions: false,
      agent: { command: "agent-lab", dir: "~/agent-profiles/lab" },
      tts: { voice: "en-US-Test", rate: 20 },
    })).toEqual({
      host: "gateway.local",
      port: 9000,
      allowedHosts: true,
      shortcuts: { "core:view.chat": "mod+1" },
      plugins: { info: { enabled: false } },
      pathAccess: { allowedPaths: ["/old"] },
      uploads: { defaultFolder: "old/uploads" },
      maxUploadBytes: 1234,
      spawnSessions: true,
      subsessions: false,
      agent: { command: "agent-lab", dir: "~/agent-profiles/lab" },
      tts: { voice: "en-US-Test", rate: 20 },
    });

    expect(gatewayServerConfigFromDraft({
      host: "",
      port: "",
      allowedHostsMode: "list",
      allowedHostsText: "example.local, 192.168.1.20\n",
    })).toEqual({ allowedHosts: ["example.local", "192.168.1.20"] });
  });

  it("builds selected-machine access/upload patches only from selected-machine-safe fields", () => {
    const patch = machineAccessConfigPatchFromDraft({
      allowedPathsText: "/tmp\n~/SDKs\n",
      uploadDefaultFolder: " manual\\uploads/. ",
    });

    expect(Object.keys(patch)).toEqual(["pathAccess", "uploads"]);
    expect(patch).toEqual({
      pathAccess: { allowedPaths: ["/tmp", "~/SDKs"] },
      uploads: { defaultFolder: "manual/uploads" },
    });
  });

  it("clears selected-machine access/upload settings with safe default patches", () => {
    expect(machineAccessConfigPatchFromDraft({ allowedPathsText: "", uploadDefaultFolder: "" })).toEqual({
      pathAccess: { allowedPaths: [] },
      uploads: {},
    });
  });

  it("rejects invalid selected-machine upload default folders before saving", () => {
    expect(() => machineAccessConfigPatchFromDraft({ allowedPathsText: "", uploadDefaultFolder: "/tmp/uploads" })).toThrow("Upload default folder must be workspace-relative.");
    expect(() => machineAccessConfigPatchFromDraft({ allowedPathsText: "", uploadDefaultFolder: "../secret" })).toThrow("Upload default folder must not contain path traversal.");
  });

  it("rejects relative external paths before saving selected-machine access", () => {
    expect(() => machineAccessConfigPatchFromDraft({
      allowedPathsText: "relative/path",
      uploadDefaultFolder: "",
    })).toThrow("Allowed external paths must be absolute paths or start with ~");
  });

  it("round-trips host speech defaults, configured values, and stale configured voices", () => {
    expect(emptyHostSpeechConfigDraft()).toEqual({ voice: "", rate: "" });
    expect(hostSpeechDraftFromConfig({})).toEqual({ voice: "", rate: "0" });
    expect(hostSpeechDraftFromConfig({ tts: { voice: "Ada", rate: 25 } })).toEqual({ voice: "Ada", rate: "25" });
    expect(hostSpeechDraftFromConfig({ tts: { voice: "Retired system voice" } })).toEqual({ voice: "Retired system voice", rate: "0" });
  });

  it("builds complete host speech gateway saves, including an explicit all-default reset", () => {
    expect(hostSpeechConfigFromDraft({ voice: " Ada ", rate: " -15 " }, {
      host: "127.0.0.1",
      shortcuts: { "core:view.chat": "mod+1" },
      modelTiers: {
        economy: { model: { provider: "openai", id: "gpt-economy" }, thinkingLevel: "low" },
        fast: { model: { provider: "openai", id: "gpt-fast" }, thinkingLevel: "low" },
        standard: { model: { provider: "openai", id: "gpt-standard" }, thinkingLevel: "medium" },
        advanced: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" },
        capable: { model: { provider: "openai", id: "gpt-capable" }, thinkingLevel: "high" },
        frontier: { model: { provider: "openai", id: "gpt-frontier" }, thinkingLevel: "high" },
      },
      tts: { voice: "Old", rate: 20 },
    })).toEqual({
      host: "127.0.0.1",
      shortcuts: { "core:view.chat": "mod+1" },
      modelTiers: {
        economy: { model: { provider: "openai", id: "gpt-economy" }, thinkingLevel: "low" },
        fast: { model: { provider: "openai", id: "gpt-fast" }, thinkingLevel: "low" },
        standard: { model: { provider: "openai", id: "gpt-standard" }, thinkingLevel: "medium" },
        advanced: { model: { provider: "openai", id: "gpt-advanced" }, thinkingLevel: "high" },
        capable: { model: { provider: "openai", id: "gpt-capable" }, thinkingLevel: "high" },
        frontier: { model: { provider: "openai", id: "gpt-frontier" }, thinkingLevel: "high" },
      },
      tts: { voice: "Ada", rate: -15 },
    });
    expect(hostSpeechConfigFromDraft({ voice: " ", rate: "0" }, { tts: { voice: "Old", rate: 20 } })).toEqual({ tts: {} });
  });

  it("rejects invalid host speech rates and compares normalized drafts", () => {
    expect(() => hostSpeechConfigFromDraft({ voice: "Ada", rate: "2.5" })).toThrow("Speech rate must be an integer from -100 to 100.");
    expect(() => hostSpeechConfigFromDraft({ voice: "Ada", rate: "101" })).toThrow("Speech rate must be an integer from -100 to 100.");
    expect(hostSpeechDraftMatchesConfig({ voice: " Ada ", rate: "0" }, { tts: { voice: "Ada" } })).toBe(true);
    expect(hostSpeechDraftMatchesConfig({ voice: "Ada", rate: "10" }, { tts: { voice: "Ada", rate: 20 } })).toBe(false);
  });
});
