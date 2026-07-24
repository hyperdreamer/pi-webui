import { describe, expect, it } from "vitest";
import {
  PI_WEBUI_DOCKER_USER_COMMANDS,
  parsePiWebUiDockerArgs,
  piWebUiDockerCommand,
  piWebUiDockerCommandPrefix,
  planPiWebUiDockerDevHostCommand,
  planPiWebUiDockerRuntimeHostCommand,
  validatePiWebUiDockerDevRootSafety,
} from "./piWebUiDockerCommandPlan.js";

describe("pi-webui-docker command planning", () => {
  it("plans runtime commands by default", () => {
    expect(parsePiWebUiDockerArgs(["status"])).toEqual({
      ok: true,
      plan: { mode: "runtime", command: "status", allowRoot: false, args: [] },
    });
  });

  it("emits runtime commands by default and development commands explicitly", () => {
    expect(parsePiWebUiDockerArgs(["--dev", "restart-sessiond"])).toEqual({
      ok: true,
      plan: { mode: "dev", command: "restart-sessiond", allowRoot: false, args: [] },
    });
    expect(piWebUiDockerCommandPrefix(undefined)).toBe("pi-webui-docker");
    expect(piWebUiDockerCommandPrefix("runtime")).toBe("pi-webui-docker");
    expect(piWebUiDockerCommandPrefix("dev")).toBe("pi-webui-docker --dev");
    expect(piWebUiDockerCommand(undefined, "status")).toBe("pi-webui-docker status");
    expect(piWebUiDockerCommand("runtime", "update")).toBe("pi-webui-docker update");
    expect(piWebUiDockerCommand("dev", "status")).toBe("pi-webui-docker --dev status");
  });

  it("keeps production install out of development mode", () => {
    expect(parsePiWebUiDockerArgs(["install", "--install-dir", "/srv/pi-webui-docker"])).toEqual({
      ok: true,
      plan: { mode: "runtime", command: "install", allowRoot: false, args: ["--install-dir", "/srv/pi-webui-docker"] },
    });
    expect(parsePiWebUiDockerArgs(["--dev", "install"])).toEqual({
      ok: false,
      errors: ["install is only available in runtime mode"],
    });
  });

  it("validates logs and shell targets", () => {
    expect(parsePiWebUiDockerArgs(["--dev", "logs", "data-init"])).toEqual({
      ok: true,
      plan: { mode: "dev", command: "logs", allowRoot: false, args: ["data-init"], target: "data-init" },
    });
    expect(parsePiWebUiDockerArgs(["logs", "data-init"])).toEqual({
      ok: false,
      errors: ["logs data-init is only available in development mode"],
    });
    expect(parsePiWebUiDockerArgs(["shell"])).toEqual({
      ok: true,
      plan: { mode: "runtime", command: "shell", allowRoot: false, args: [], target: "web" },
    });
    expect(parsePiWebUiDockerArgs(["shell", "data-init"])).toEqual({
      ok: false,
      errors: ["Invalid shell target: data-init"],
    });
  });

  it("treats cli as the pi-webui escape hatch", () => {
    expect(parsePiWebUiDockerArgs(["cli", "config", "show"])).toEqual({
      ok: true,
      plan: { mode: "runtime", command: "cli", allowRoot: false, args: ["config", "show"] },
    });
    expect(parsePiWebUiDockerArgs(["cli"])).toEqual({ ok: false, errors: ["cli requires pi-webui arguments"] });
  });

  it("keeps the canonical user command surface parseable", () => {
    const sampleArgs = new Map<string, string[]>([
      ["install", ["--asset-ref", "release"]],
      ["logs", ["web"]],
      ["shell", ["sessiond"]],
      ["cli", ["config", "show"]],
    ]);

    for (const command of PI_WEBUI_DOCKER_USER_COMMANDS) {
      const parsed = parsePiWebUiDockerArgs([command, ...(sampleArgs.get(command) ?? [])]);
      expect(parsed).toMatchObject({ ok: true });
    }
  });

  it("rejects unknown options and unexpected positional arguments", () => {
    expect(parsePiWebUiDockerArgs(["--prod", "status"])).toEqual({ ok: false, errors: ["Unknown global option: --prod"] });
    expect(parsePiWebUiDockerArgs(["status", "web"])).toEqual({ ok: false, errors: ["status does not accept positional arguments"] });
    expect(parsePiWebUiDockerArgs(["restart-sessiond", "web"])).toEqual({ ok: false, errors: ["restart-sessiond does not accept positional arguments"] });
    expect(parsePiWebUiDockerArgs([])).toEqual({ ok: false, errors: ["Missing command"] });
  });

  it("parses root override as an explicit global option", () => {
    expect(parsePiWebUiDockerArgs(["--dev", "--allow-root", "status"])).toEqual({
      ok: true,
      plan: { mode: "dev", command: "status", allowRoot: true, args: [] },
    });
  });

  it("plans production host commands through installer or Compose actions", () => {
    expect(runtimeHostPlan(["install", "--asset-ref", "release"])).toEqual({
      kind: "installer",
      action: "install",
      args: ["--asset-ref", "release"],
      useRuntimeRootAsInstallDir: false,
    });
    expect(runtimeHostPlan(["update"])).toEqual({ kind: "installer", action: "update", args: [], useRuntimeRootAsInstallDir: true });
    expect(runtimeHostPlan(["start"])).toEqual({ kind: "compose", args: ["up", "-d"] });
    expect(runtimeHostPlan(["stop"])).toEqual({ kind: "compose", args: ["down"] });
    expect(runtimeHostPlan(["restart"])).toEqual({ kind: "compose", args: ["restart", "web", "sessiond"] });
    expect(runtimeHostPlan(["status"])).toEqual({ kind: "compose", args: ["ps"] });
    expect(runtimeHostPlan(["logs", "web"])).toEqual({ kind: "compose", args: ["logs", "-f", "web"] });
    expect(runtimeHostPlan(["shell"])).toEqual({ kind: "compose", args: ["exec", "web", "bash"] });
    expect(runtimeHostPlan(["cli", "config", "show"])).toEqual({ kind: "compose", args: ["exec", "web", "pi-webui", "config", "show"] });
  });

  it("plans development host commands through the generated dev Compose environment", () => {
    expect(devHostPlan(["--dev", "start"])).toEqual({ kind: "compose", args: ["up", "-d", "--build"], usesGeneratedEnv: true });
    expect(devHostPlan(["--dev", "status"])).toEqual({ kind: "compose", args: ["ps"], usesGeneratedEnv: true });
    expect(devHostPlan(["--dev", "logs", "data-init"])).toEqual({ kind: "compose", args: ["logs", "-f", "data-init"], usesGeneratedEnv: true });
    expect(devHostPlan(["--dev", "shell"])).toEqual({ kind: "compose", args: ["exec", "web", "bash"], usesGeneratedEnv: true });
    expect(devHostPlan(["--dev", "cli", "config", "show"])).toEqual({ kind: "compose", args: ["exec", "web", "pi-webui", "config", "show"], usesGeneratedEnv: true });
    expect(devHostPlan(["--dev", "update"])).toEqual({
      kind: "composeSequence",
      usesGeneratedEnv: true,
      steps: [
        { args: ["build", "--pull"] },
        { args: ["up", "-d", "--force-recreate", "--remove-orphans"] },
      ],
    });
  });

  it("keeps development root safety explicit in command planning", () => {
    const parsed = parsePiWebUiDockerArgs(["--dev", "status"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    expect(validatePiWebUiDockerDevRootSafety(parsed.plan, 0)).toBe("refusing to run Docker development mode as root; retry with --allow-root if this is intentional");
    expect(validatePiWebUiDockerDevRootSafety({ ...parsed.plan, allowRoot: true }, 0)).toBeUndefined();
    expect(validatePiWebUiDockerDevRootSafety(parsed.plan, 500)).toBeUndefined();
  });

  it("does not apply production host planning to development mode", () => {
    const parsed = parsePiWebUiDockerArgs(["--dev", "status"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(planPiWebUiDockerRuntimeHostCommand(parsed.plan)).toBeUndefined();
  });

  it("does not apply development host planning to production mode", () => {
    const parsed = parsePiWebUiDockerArgs(["status"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(planPiWebUiDockerDevHostCommand(parsed.plan)).toBeUndefined();
  });
});

function runtimeHostPlan(argv: string[]) {
  const parsed = parsePiWebUiDockerArgs(argv);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return planPiWebUiDockerRuntimeHostCommand(parsed.plan);
}

function devHostPlan(argv: string[]) {
  const parsed = parsePiWebUiDockerArgs(argv);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return planPiWebUiDockerDevHostCommand(parsed.plan);
}
