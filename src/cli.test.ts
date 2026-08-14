import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentCommandForChecks,
  commandWithVersionCheck,
  doctorExitCode,
  isCliEntrypoint,
  launchdRuntimeDetails,
  nativeServiceConfigEnvironment,
  nativeServiceInstallCandidate,
  nodeVersionCheck,
  regularFileExists,
  serviceBackendForPlatform,
} from "./cli.js";
import {
  createDevelopmentNativeServicePlan,
  resolveProductionNativeServicePlan,
  type NativeServiceAuthoritativeProbe,
} from "./nativeServices/servicePlan.js";

const originalShell = process.env["SHELL"];
const originalPiWebUiConfig = process.env["PI_WEBUI_CONFIG"];
const originalPiWebUiAgentCommand = process.env["PI_WEBUI_AGENT_COMMAND"];
const originalPiWebUiDataDir = process.env["PI_WEBUI_DATA_DIR"];

const systemdBackend = { kind: "systemd", label: "systemd user services" } as const;

afterEach(() => {
  if (originalShell === undefined) {
    delete process.env["SHELL"];
  } else {
    process.env["SHELL"] = originalShell;
  }
  if (originalPiWebUiConfig === undefined) {
    delete process.env["PI_WEBUI_CONFIG"];
  } else {
    process.env["PI_WEBUI_CONFIG"] = originalPiWebUiConfig;
  }
  if (originalPiWebUiAgentCommand === undefined) {
    delete process.env["PI_WEBUI_AGENT_COMMAND"];
  } else {
    process.env["PI_WEBUI_AGENT_COMMAND"] = originalPiWebUiAgentCommand;
  }
  if (originalPiWebUiDataDir === undefined) {
    delete process.env["PI_WEBUI_DATA_DIR"];
  } else {
    process.env["PI_WEBUI_DATA_DIR"] = originalPiWebUiDataDir;
  }
});

describe("commandWithVersionCheck", () => {
  it("emits a POSIX subshell group for bash", () => {
    process.env["SHELL"] = "/bin/bash";
    expect(commandWithVersionCheck("npm")).toBe("command -v 'npm' && ('npm' --version 2>&1 || true)");
  });

  it("emits a POSIX subshell group for zsh", () => {
    process.env["SHELL"] = "/bin/zsh";
    expect(commandWithVersionCheck("pi")).toBe("command -v 'pi' && ('pi' --version 2>&1 || true)");
  });

  it("uses fish begin/end grouping instead of a POSIX subshell", () => {
    process.env["SHELL"] = "/usr/local/bin/fish";
    const command = commandWithVersionCheck("npm");
    expect(command).toBe("command -v 'npm' && begin; 'npm' --version 2>&1 || true; end");
    expect(command).not.toContain("(");
  });

  it("shell-quotes command words", () => {
    process.env["SHELL"] = "/bin/bash";
    expect(commandWithVersionCheck("/tmp/agent's/acme-agent")).toBe("command -v '/tmp/agent'\\''s/acme-agent' && ('/tmp/agent'\\''s/acme-agent' --version 2>&1 || true)");
  });
});

describe("nodeVersionCheck", () => {
  it("checks the complete supported Node version with the resolved executable", () => {
    process.env["SHELL"] = "/bin/bash";

    const command = nodeVersionCheck();

    expect(command).toContain("22.19.0");
    expect(command).toContain("process.versions.node");
    expect(command).toContain("\"$pi_webui_probe_executable\"");
  });
});

describe("agentCommandForChecks", () => {
  it("reads the configured agent command for doctor checks", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-webui-cli-test-"));
    try {
      const configPath = join(dir, "config.json");
      writeFileSync(configPath, `${JSON.stringify({ agent: { command: "acme-agent", dir: "/opt/acme-agent/state" } })}\n`);
      process.env["PI_WEBUI_CONFIG"] = configPath;
      delete process.env["PI_WEBUI_AGENT_COMMAND"];

      expect(agentCommandForChecks()).toBe("acme-agent");
      expect(agentCommandForChecks({
        PI_WEBUI_CONFIG: configPath,
        PI_WEBUI_AGENT_COMMAND: "environment-agent",
        PI_WEBUI_AGENT_DIR: join(dir, "environment-agent-state"),
      })).toBe("environment-agent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nativeServiceConfigEnvironment", () => {
  it("pins a custom config path and resolves a relative managed data directory", () => {
    const environment = nativeServiceConfigEnvironment("/tmp/pi-webui/config.json", { PI_WEBUI_DATA_DIR: "managed-data" }, "/srv/pi-webui");

    expect(environment).toEqual({
      PI_WEBUI_CONFIG: "/tmp/pi-webui/config.json",
      PI_WEBUI_DATA_DIR: "/srv/pi-webui/managed-data",
    });
    expect(Object.isFrozen(environment)).toBe(true);
  });

  it("pins only the resolved data directory when no config path is configured", () => {
    expect(nativeServiceConfigEnvironment(undefined, { PI_WEBUI_DATA_DIR: "data" }, "/work")).toEqual({
      PI_WEBUI_DATA_DIR: resolve("/work", "data"),
    });
  });

  it("adds no overrides for missing or empty inputs and leaves the default data directory alone", () => {
    expect(nativeServiceConfigEnvironment(undefined, {}, "/work")).toEqual({});
    expect(nativeServiceConfigEnvironment(undefined, { PI_WEBUI_DATA_DIR: "" }, "/work")).toEqual({});
    expect(nativeServiceConfigEnvironment(undefined, { PI_WEBUI_DATA_DIR: "   " }, "/work")).toEqual({});
  });

  it("feeds byte-identical environment maps to every native-service process owner", async () => {
    process.env["SHELL"] = "/bin/bash";
    const dir = mkdtempSync(join(tmpdir(), "pi-webui-cli-env-test-"));
    try {
      process.env["PI_WEBUI_DATA_DIR"] = "managed-data";
      const configPath = join(dir, "config.json");
      const environment = nativeServiceConfigEnvironment(configPath, process.env, process.cwd());

      const development = nativeServiceInstallCandidate(
        { host: "127.0.0.1", port: "8809", mode: "dev", config: configPath },
        systemdBackend,
        configPath,
        dir,
      );
      expect(development.mode).toBe("development");
      if (development.mode === "development") {
        expect(development.input.environment).toEqual(environment);
        const plan = createDevelopmentNativeServicePlan(development.input);
        expect(plan.services.map((service) => service.environment)).toEqual([environment, environment]);
      }

      const production = nativeServiceInstallCandidate(
        { host: "127.0.0.1", port: "8808", mode: "production", config: configPath },
        systemdBackend,
        configPath,
        undefined,
      );
      expect(production.mode).toBe("production");
      if (production.mode === "production") {
        expect(production.input.environment).toEqual(environment);
        const resolution = await resolveProductionNativeServicePlan(production.input, {
          probe: completedProbe(),
          fileExists: () => false,
        });
        expect(resolution.ok).toBe(true);
        if (resolution.ok) {
          expect(resolution.plan.services.map((service) => service.environment)).toEqual([environment, environment]);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function completedProbe(): NativeServiceAuthoritativeProbe {
  return {
    run: (request) => Promise.resolve({
      kind: "completed",
      outcomes: request.prerequisites.map((prerequisite) => ({ prerequisiteId: prerequisite.id, status: "satisfied" as const, detail: null })),
    }),
  };
}

describe("native-service doctor CLI contracts", () => {
  it("uses native services only on supported platforms", () => {
    expect(serviceBackendForPlatform("linux")).toEqual({ kind: "systemd", label: "systemd user services" });
    expect(serviceBackendForPlatform("darwin")).toEqual({ kind: "launchd", label: "LaunchAgents" });
    expect(serviceBackendForPlatform("win32")).toBeUndefined();
  });

  it("fails doctor for general, native-plan, or node-pty failures", () => {
    expect(doctorExitCode(true, true, true)).toBe(0);
    expect(doctorExitCode(false, true, true)).toBe(1);
    expect(doctorExitCode(true, false, true)).toBe(1);
    expect(doctorExitCode(true, true, false)).toBe(1);
  });

  it("accepts only regular files as bundled entrypoints", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-webui-entrypoint-test-"));
    try {
      const file = join(dir, "entrypoint.js");
      writeFileSync(file, "export {};\n");
      expect(regularFileExists(file)).toBe(true);
      expect(regularFileExists(dir)).toBe(false);
      expect(regularFileExists(join(dir, "missing.js"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces launchd last exit code 127 in service status", () => {
    expect(launchdRuntimeDetails("state = exited\nlast exit code = 127\n")).toEqual({
      state: "exited",
      detail: "exited (last exit code 127)",
      pid: undefined,
    });
  });
});

describe("isCliEntrypoint", () => {
  it("matches direct execution paths", () => {
    expect(isCliEntrypoint("/tmp/pi-webui-cli.js", "/tmp/pi-webui-cli.js")).toBe(true);
  });

  it("matches npm-style symlinked bin entrypoints", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-webui-cli-test-"));
    try {
      const target = join(dir, "dist", "cli.js");
      const symlink = join(dir, "bin", "pi-webui");
      mkdirSync(join(dir, "dist"));
      mkdirSync(join(dir, "bin"));
      writeFileSync(target, "#!/usr/bin/env node\n", { mode: 0o755 });
      symlinkSync(target, symlink);

      expect(isCliEntrypoint(symlink, target)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not match unrelated paths", () => {
    expect(isCliEntrypoint("/tmp/pi-webui", "/tmp/other-pi-webui")).toBe(false);
  });
});
