import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_UPLOAD_BYTES, DEFAULT_UPLOADS_FOLDER, agentDirEnvSource, agentSessionDirEnvKeys, effectiveAgentConfig, effectivePiWebUiConfig, examplePiWebUiConfig, hasAgentDirEnvOverride, hasAgentSessionDirEnvOverride, loadPiWebUiConfig, maxUploadBytes, savePiWebUiConfig, spawnSessionsEnabled, subsessionsEnabled } from "./config.js";
import type { ModelTierLadder } from "./server/sessions/modelTierRegistry.js";

let tempDir: string;
let configPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-webui-config-test-"));
  configPath = join(tempDir, "config.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("PI WEBUI config persistence", () => {
  it("writes and reads the configured PI WEBUI config path", () => {
    const requestedConfig = {
      host: "0.0.0.0",
      port: 9000,
      allowedHosts: ["example.local"],
      shortcuts: { "core:view.chat": "mod+1", "core:session.stop": null },
      plugins: { "workspace-tasks": { enabled: false, settings: { configPath: ".pi-webui/tasks.json" } } },
      pathAccess: { allowedPaths: ["/tmp", "~/SDKs"] },
      uploads: { defaultFolder: "manual\\incoming" },
    };
    const normalizedConfig = {
      ...requestedConfig,
      uploads: { defaultFolder: "manual/incoming" },
    };

    const saved = savePiWebUiConfig(requestedConfig, testOptions());

    expect(saved).toEqual({ path: configPath, exists: true, config: normalizedConfig });
    expect(loadPiWebUiConfig(testOptions())).toEqual(saved);
  });

  it("preserves unrelated config keys while replacing managed keys", async () => {
    await writeFile(configPath, `${JSON.stringify({ host: "old", port: 8808, allowedHosts: true, plugins: { info: { enabled: false } }, pathAccess: { allowedPaths: ["/old"] }, uploads: { defaultFolder: "old" }, future: { enabled: true } }, null, 2)}\n`, "utf8");

    savePiWebUiConfig({ port: 9000, allowedHosts: [], pathAccess: { allowedPaths: ["/new"] }, uploads: { defaultFolder: "new" } }, testOptions());

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ future: { enabled: true }, port: 9000, allowedHosts: [], pathAccess: { allowedPaths: ["/new"] }, uploads: { defaultFolder: "new" } });
  });

  it("rejects invalid plugin config", async () => {
    await writeFile(configPath, `${JSON.stringify({ plugins: { info: { enabled: "no" } } }, null, 2)}\n`, "utf8");

    expect(() => loadPiWebUiConfig(testOptions())).toThrow("PI WEBUI config plugin enabled values must be booleans");
  });

  it("rejects invalid path access config", async () => {
    await writeFile(configPath, `${JSON.stringify({ pathAccess: { allowedPaths: [""] } }, null, 2)}\n`, "utf8");

    expect(() => loadPiWebUiConfig(testOptions())).toThrow("PI WEBUI config pathAccess.allowedPaths must be an array of non-empty strings");
  });

  it("persists and reads maxUploadBytes", () => {
    savePiWebUiConfig({ maxUploadBytes: 1234 }, testOptions());
    expect(loadPiWebUiConfig(testOptions()).config.maxUploadBytes).toBe(1234);
  });

  it("persists and reads the complete model tier ladder", () => {
    const modelTiers = validModelTiers();
    savePiWebUiConfig({ modelTiers }, testOptions());

    expect(loadPiWebUiConfig(testOptions()).config.modelTiers).toEqual(modelTiers);
  });

  it("preserves unrelated keys while replacing the model tier ladder", async () => {
    await writeFile(configPath, `${JSON.stringify({ future: { enabled: true }, modelTiers: { stale: true } }, null, 2)}\n`, "utf8");

    const modelTiers = validModelTiers();
    savePiWebUiConfig({ modelTiers }, testOptions());

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ future: { enabled: true }, modelTiers });
  });

  it("reports an externally invalid model tier ladder without crashing or defaulting", async () => {
    const invalid = { economy: validModelTiers().economy };
    await writeFile(configPath, `${JSON.stringify({ modelTiers: invalid }, null, 2)}\n`, "utf8");

    const loaded = loadPiWebUiConfig(testOptions());

    expect(loaded.config.modelTiers).toBeUndefined();
    expect(loaded.modelTiersError).toContain("six canonical tiers");
  });

  it("retains an invalid external ladder when saving an unrelated config update", async () => {
    const invalid = { economy: validModelTiers().economy };
    await writeFile(configPath, `${JSON.stringify({ modelTiers: invalid, future: { enabled: true } }, null, 2)}\n`, "utf8");

    savePiWebUiConfig({ port: 9000 }, testOptions());

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ modelTiers: invalid, future: { enabled: true }, port: 9000 });
  });

  it("persists and reads custom agent runtime settings", () => {
    savePiWebUiConfig({ agent: { command: "acme-agent", dir: "/opt/acme-agent/state" } }, testOptions());

    expect(loadPiWebUiConfig(testOptions()).config.agent).toEqual({ command: "acme-agent", dir: "/opt/acme-agent/state" });
  });

  it("defaults to the Pi agent directory only for canonical Pi companion names", () => {
    for (const command of ["pi", "pi.cmd"]) {
      expect(effectiveAgentConfig({ HOME: join(tempDir, ".home") }, { agent: { command } })).toMatchObject({
        command,
        dir: join(tempDir, ".home", ".pi", "agent"),
        sessionDirEnvKeys: ["PI_WEBUI_AGENT_SESSION_DIR", "PI_CODING_AGENT_SESSION_DIR"],
      });
    }
  });

  it("requires explicit state for alternate names and absolute Pi launchers", () => {
    const absolutePiCommand = join(tempDir, "bin", "pi");
    for (const command of ["acme-agent", absolutePiCommand]) {
      expect(() => effectiveAgentConfig({}, { agent: { command } })).toThrow(`PI WEBUI config agent.dir or PI_WEBUI_AGENT_DIR is required when agent.command is ${JSON.stringify(command)}`);
      expect(() => savePiWebUiConfig({ agent: { command } }, testOptions())).toThrow(`PI WEBUI config agent.dir or PI_WEBUI_AGENT_DIR is required when agent.command is ${JSON.stringify(command)}`);
    }
  });

  it("accepts safe bare executable names and host-absolute executable paths", () => {
    const absoluteCommand = join(tempDir, "bin", "acme-agent");
    const agentDir = join(tempDir, "state", "acme");

    expect(effectiveAgentConfig({}, { agent: { command: "acme-agent", dir: agentDir } })).toMatchObject({ command: "acme-agent", dir: agentDir });
    expect(effectiveAgentConfig({}, { agent: { command: absoluteCommand, dir: agentDir } })).toMatchObject({ command: absoluteCommand, dir: agentDir });
  });

  it.each(["./acme-agent", "bin/acme-agent", "../acme-agent", "node acme-agent.js", "acme-agent;other", "-acme-agent"])("rejects unsafe or workspace-relative agent command %j", (command) => {
    expect(() => savePiWebUiConfig({ agent: { command, dir: join(tempDir, "agent") } }, testOptions())).toThrow("safe bare executable name or host-absolute executable path");
  });

  it.skipIf(process.platform === "win32")("rejects foreign-platform absolute agent command and state paths", () => {
    expect(() => effectiveAgentConfig({}, { agent: { command: "C:\\tools\\acme-agent.exe", dir: join(tempDir, "agent") } })).toThrow("safe bare executable name or host-absolute executable path");
    expect(() => effectiveAgentConfig({}, { agent: { command: "acme-agent", dir: "C:\\profiles\\acme" } })).toThrow("agent.dir must be a host-absolute path");
  });

  it("rejects home expansion that would create a workspace-relative agent directory", () => {
    expect(() => effectiveAgentConfig({ HOME: "relative-home" })).toThrow("agent.dir must be a host-absolute path");
  });

  it("resolves explicit alternate agent command and state directory settings", () => {
    expect(effectiveAgentConfig({ HOME: join(tempDir, ".home") }, { agent: { command: "acme-agent", dir: "~/agent-profiles/acme" } })).toMatchObject({
      command: "acme-agent",
      dir: join(tempDir, ".home", "agent-profiles", "acme"),
      sessionDirEnvKeys: ["PI_WEBUI_AGENT_SESSION_DIR"],
    });
  });

  it("ignores empty agent environment overrides", () => {
    const env = {
      HOME: join(tempDir, ".home"),
      PI_WEBUI_AGENT_COMMAND: "",
      PI_WEBUI_AGENT_DIR: "",
      PI_WEBUI_AGENT_SESSION_DIR: "",
      PI_CODING_AGENT_DIR: "",
      PI_CODING_AGENT_SESSION_DIR: "",
    };

    expect(effectiveAgentConfig(env, { agent: { command: "acme-agent", dir: "~/agent-profiles/acme" } })).toMatchObject({
      command: "acme-agent",
      dir: join(tempDir, ".home", "agent-profiles", "acme"),
    });
    expect(hasAgentDirEnvOverride(env, "acme-agent")).toBe(false);
    expect(hasAgentSessionDirEnvOverride(env, "acme-agent")).toBe(false);
  });

  it("uses explicit PI WEBUI agent directory env precedence", () => {
    const env = {
      PI_WEBUI_AGENT_COMMAND: "acme-agent",
      PI_WEBUI_AGENT_DIR: join(tempDir, "web-env-agent"),
      PI_CODING_AGENT_DIR: join(tempDir, "pi-env-agent"),
    };
    expect(effectiveAgentConfig(env, { agent: { command: "pi", dir: join(tempDir, "config-agent") } })).toMatchObject({
      command: "acme-agent",
      dir: join(tempDir, "web-env-agent"),
    });
    expect(agentDirEnvSource(env)).toBe("pi-webui");
  });

  it("keeps legacy Pi env directory overrides scoped to the canonical Pi command", () => {
    const legacyDir = join(tempDir, "pi-env-agent");
    const alternateDir = join(tempDir, "alternate-agent");
    const env = { PI_CODING_AGENT_DIR: legacyDir };
    expect(effectiveAgentConfig(env, { agent: { dir: join(tempDir, "config-agent") } })).toMatchObject({ dir: legacyDir });
    expect(effectiveAgentConfig(env, { agent: { command: "acme-agent", dir: alternateDir } })).toMatchObject({ command: "acme-agent", dir: alternateDir });
    expect(agentDirEnvSource(env)).toBe("pi-compatibility");
    expect(hasAgentDirEnvOverride(env, "pi")).toBe(true);
    expect(hasAgentDirEnvOverride(env, "acme-agent")).toBe(false);

    for (const command of ["acme-agent", join(tempDir, "bin", "pi")]) {
      expect(() => effectiveAgentConfig(env, { agent: { command } }))
        .toThrow(`PI WEBUI config agent.dir or PI_WEBUI_AGENT_DIR is required when agent.command is ${JSON.stringify(command)}`);
    }
  });

  it("uses only explicit session directory env keys", () => {
    expect(agentSessionDirEnvKeys()).toEqual(["PI_WEBUI_AGENT_SESSION_DIR", "PI_CODING_AGENT_SESSION_DIR"]);
    expect(effectiveAgentConfig({ HOME: join(tempDir, ".home"), PI_WEBUI_AGENT_COMMAND: "acme-agent", PI_WEBUI_AGENT_DIR: join(tempDir, "agent") }).sessionDirEnvKeys).toEqual(["PI_WEBUI_AGENT_SESSION_DIR"]);
    expect(agentSessionDirEnvKeys(join(tempDir, "bin", "pi"))).toEqual(["PI_WEBUI_AGENT_SESSION_DIR"]);
  });

  it("rejects unknown nested agent keys instead of erasing them", async () => {
    const original = { agent: { command: "acme-agent", dir: join(tempDir, "agent"), futureSetting: true } };
    await writeFile(configPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");

    expect(() => loadPiWebUiConfig(testOptions())).toThrow('PI WEBUI config agent contains unknown key "futureSetting"');
    expect(() => savePiWebUiConfig({ port: 9000 }, testOptions())).toThrow('PI WEBUI config agent contains unknown key "futureSetting"');
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(original);
  });

  it("exposes the default upload folder in the effective config", () => {
    expect(effectivePiWebUiConfig(testOptions()).config.uploads).toEqual({ defaultFolder: DEFAULT_UPLOADS_FOLDER });
  });

  it("rejects upload defaults that are not workspace-relative", async () => {
    await writeFile(configPath, `${JSON.stringify({ uploads: { defaultFolder: "../outside" } }, null, 2)}\n`, "utf8");

    expect(() => loadPiWebUiConfig(testOptions())).toThrow("PI WEBUI config uploads.defaultFolder must not contain path traversal");
  });
});

describe("PI WEBUI default port", () => {
  it("uses port 8808 in generated configuration examples", () => {
    expect(JSON.parse(examplePiWebUiConfig())).toMatchObject({ host: "127.0.0.1", port: 8808 });
  });
});

describe("maxUploadBytes", () => {
  it("defaults when nothing is configured", () => {
    expect(maxUploadBytes({}, {})).toBe(DEFAULT_MAX_UPLOAD_BYTES);
  });

  it("prefers the env override over config", () => {
    expect(maxUploadBytes({ PI_WEBUI_MAX_UPLOAD_BYTES: "2048" }, { maxUploadBytes: 99 })).toBe(2048);
  });

  it("falls back to config when env is unset or invalid", () => {
    expect(maxUploadBytes({ PI_WEBUI_MAX_UPLOAD_BYTES: "not-a-number" }, { maxUploadBytes: 555 })).toBe(555);
  });
});

describe("spawnSessionsEnabled", () => {
  it("is on by default when nothing is configured", () => {
    expect(spawnSessionsEnabled({}, {})).toBe(true);
  });

  it("honors an explicit config opt-out", () => {
    expect(spawnSessionsEnabled({}, { spawnSessions: false })).toBe(false);
  });

  it("lets the env var override the config in both directions", () => {
    expect(spawnSessionsEnabled({ PI_WEBUI_SPAWN_SESSIONS: "0" }, { spawnSessions: true })).toBe(false);
    expect(spawnSessionsEnabled({ PI_WEBUI_SPAWN_SESSIONS: "1" }, { spawnSessions: false })).toBe(true);
  });
});

describe("subsessionsEnabled", () => {
  it("is off by default while the capability is in beta", () => {
    expect(subsessionsEnabled({}, {})).toBe(false);
  });

  it("honors an explicit config opt-in", () => {
    expect(subsessionsEnabled({}, { subsessions: true })).toBe(true);
  });

  it("lets the env var override the config in both directions", () => {
    expect(subsessionsEnabled({ PI_WEBUI_SUBSESSIONS: "1" }, { subsessions: false })).toBe(true);
    expect(subsessionsEnabled({ PI_WEBUI_SUBSESSIONS: "0" }, { subsessions: true })).toBe(false);
  });
});

function validModelTiers(): ModelTierLadder {
  return {
    economy: { model: { provider: "acme", id: "economy" }, thinkingLevel: "off" },
    fast: { model: { provider: "acme", id: "fast" }, thinkingLevel: "low" },
    standard: { model: { provider: "acme", id: "standard" }, thinkingLevel: "medium" },
    advanced: { model: { provider: "acme", id: "advanced" }, thinkingLevel: "high" },
    capable: { model: { provider: "acme", id: "capable" }, thinkingLevel: "xhigh" },
    frontier: { model: { provider: "acme", id: "frontier" }, thinkingLevel: "max" },
  };
}

function testOptions(): { env: NodeJS.ProcessEnv } {
  return { env: { PI_WEBUI_CONFIG: configPath } };
}
