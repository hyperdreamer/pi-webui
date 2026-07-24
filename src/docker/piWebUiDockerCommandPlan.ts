export type PiWebUiDockerMode = "runtime" | "dev";
export type PiWebUiDockerCommand =
  | "install"
  | "start"
  | "stop"
  | "restart"
  | "restart-web"
  | "restart-sessiond"
  | "update"
  | "status"
  | "logs"
  | "shell"
  | "doctor"
  | "cli"
  | "help";

export type PiWebUiDockerLogsTarget = "web" | "sessiond" | "data-init";
export type PiWebUiDockerShellTarget = "web" | "sessiond";

export interface PiWebUiDockerCommandPlan {
  mode: PiWebUiDockerMode;
  command: PiWebUiDockerCommand;
  allowRoot: boolean;
  args: string[];
  target?: PiWebUiDockerLogsTarget | PiWebUiDockerShellTarget;
}

export type PiWebUiDockerParseResult =
  | { ok: true; plan: PiWebUiDockerCommandPlan }
  | { ok: false; errors: string[] };

export const PI_WEBUI_DOCKER_USER_COMMANDS = [
  "install",
  "start",
  "stop",
  "restart",
  "restart-web",
  "restart-sessiond",
  "update",
  "status",
  "logs",
  "shell",
  "doctor",
  "cli",
] as const satisfies readonly Exclude<PiWebUiDockerCommand, "help">[];

export type PiWebUiDockerRuntimeHostPlan =
  | { kind: "installer"; action: "install" | "update"; args: string[]; useRuntimeRootAsInstallDir: boolean }
  | { kind: "compose"; args: string[] }
  | { kind: "diagnostics" }
  | { kind: "usage" };

export interface PiWebUiDockerComposeStep {
  args: string[];
}

export type PiWebUiDockerDevHostPlan =
  | { kind: "compose"; args: string[]; usesGeneratedEnv: true }
  | { kind: "composeSequence"; steps: PiWebUiDockerComposeStep[]; usesGeneratedEnv: true }
  | { kind: "diagnostics"; usesGeneratedEnv: true }
  | { kind: "usage" };

const noArgumentCommands = new Set<PiWebUiDockerCommand>([
  "start",
  "stop",
  "restart",
  "restart-web",
  "restart-sessiond",
  "update",
  "status",
  "doctor",
  "help",
]);

const commands: ReadonlySet<string> = new Set([...PI_WEBUI_DOCKER_USER_COMMANDS, "help"]);

const logsTargets: ReadonlySet<string> = new Set(["web", "sessiond", "data-init"]);
const shellTargets: ReadonlySet<string> = new Set(["web", "sessiond"]);

export function piWebUiDockerCommandPrefix(mode: PiWebUiDockerMode | undefined): string {
  return mode === "dev" ? "pi-webui-docker --dev" : "pi-webui-docker";
}

export function piWebUiDockerCommand(mode: PiWebUiDockerMode | undefined, command: Exclude<PiWebUiDockerCommand, "help">): string {
  return `${piWebUiDockerCommandPrefix(mode)} ${command}`;
}

export function planPiWebUiDockerRuntimeHostCommand(plan: PiWebUiDockerCommandPlan): PiWebUiDockerRuntimeHostPlan | undefined {
  if (plan.mode !== "runtime") return undefined;

  switch (plan.command) {
    case "install":
      return { kind: "installer", action: "install", args: [...plan.args], useRuntimeRootAsInstallDir: false };
    case "update":
      return { kind: "installer", action: "update", args: [], useRuntimeRootAsInstallDir: true };
    case "start":
      return composeHostPlan("up", "-d");
    case "stop":
      return composeHostPlan("down");
    case "restart":
      return composeHostPlan("restart", "web", "sessiond");
    case "restart-web":
      return composeHostPlan("restart", "web");
    case "restart-sessiond":
      return composeHostPlan("restart", "sessiond");
    case "status":
      return composeHostPlan("ps");
    case "logs":
      return plan.target === undefined ? composeHostPlan("logs", "-f") : composeHostPlan("logs", "-f", plan.target);
    case "shell":
      return composeHostPlan("exec", plan.target ?? "web", "bash");
    case "cli":
      return { kind: "compose", args: ["exec", "web", "pi-webui", ...plan.args] };
    case "doctor":
      return { kind: "diagnostics" };
    case "help":
      return { kind: "usage" };
  }
}

export function planPiWebUiDockerDevHostCommand(plan: PiWebUiDockerCommandPlan): PiWebUiDockerDevHostPlan | undefined {
  if (plan.mode !== "dev") return undefined;

  switch (plan.command) {
    case "install":
      return undefined;
    case "start":
      return devComposeHostPlan("up", "-d", "--build");
    case "stop":
      return devComposeHostPlan("down");
    case "restart":
      return devComposeHostPlan("restart", "web", "sessiond");
    case "restart-web":
      return devComposeHostPlan("restart", "web");
    case "restart-sessiond":
      return devComposeHostPlan("restart", "sessiond");
    case "update":
      return {
        kind: "composeSequence",
        usesGeneratedEnv: true,
        steps: [
          { args: ["build", "--pull"] },
          { args: ["up", "-d", "--force-recreate", "--remove-orphans"] },
        ],
      };
    case "status":
      return devComposeHostPlan("ps");
    case "logs":
      return plan.target === undefined ? devComposeHostPlan("logs", "-f") : devComposeHostPlan("logs", "-f", plan.target);
    case "shell":
      return devComposeHostPlan("exec", plan.target ?? "web", "bash");
    case "cli":
      return { kind: "compose", args: ["exec", "web", "pi-webui", ...plan.args], usesGeneratedEnv: true };
    case "doctor":
      return { kind: "diagnostics", usesGeneratedEnv: true };
    case "help":
      return { kind: "usage" };
  }
}

export function validatePiWebUiDockerDevRootSafety(plan: PiWebUiDockerCommandPlan, uid: number): string | undefined {
  if (plan.mode !== "dev" || plan.allowRoot || plan.command === "help" || uid !== 0) return undefined;
  return "refusing to run Docker development mode as root; retry with --allow-root if this is intentional";
}

export function parsePiWebUiDockerArgs(argv: readonly string[]): PiWebUiDockerParseResult {
  let mode: PiWebUiDockerMode = "runtime";
  let allowRoot = false;
  let index = 0;

  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) break;
    if (arg === "--") {
      index += 1;
      break;
    }
    if (arg === "--dev") {
      mode = "dev";
      continue;
    }
    if (arg === "--allow-root") {
      allowRoot = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ok: true, plan: { mode, command: "help", allowRoot, args: [] } };
    }
    if (arg.startsWith("-")) {
      return { ok: false, errors: [`Unknown global option: ${arg}`] };
    }
    break;
  }

  const commandValue = argv[index];
  if (commandValue === undefined) return { ok: false, errors: ["Missing command"] };
  if (!isPiWebUiDockerCommand(commandValue)) return { ok: false, errors: [`Unknown command: ${commandValue}`] };

  const args = argv.slice(index + 1);
  const plan: PiWebUiDockerCommandPlan = { mode, command: commandValue, allowRoot, args };
  return validatePlan(withDefaultTarget(plan));
}

function composeHostPlan(...args: string[]): PiWebUiDockerRuntimeHostPlan {
  return { kind: "compose", args };
}

function devComposeHostPlan(...args: string[]): PiWebUiDockerDevHostPlan {
  return { kind: "compose", args, usesGeneratedEnv: true };
}

function withDefaultTarget(plan: PiWebUiDockerCommandPlan): PiWebUiDockerCommandPlan {
  if (plan.command === "shell" && plan.target === undefined && plan.args.length === 0) return { ...plan, target: "web" };
  return plan;
}

function validatePlan(plan: PiWebUiDockerCommandPlan): PiWebUiDockerParseResult {
  const errors: string[] = [];

  if (plan.command === "install" && plan.mode === "dev") {
    errors.push("install is only available in runtime mode");
  }

  if (noArgumentCommands.has(plan.command) && plan.args.length > 0) {
    errors.push(`${plan.command} does not accept positional arguments`);
  }

  if (plan.command === "logs") {
    validateOptionalTarget(plan.args, isLogsTarget, "logs", errors);
    if (plan.args[0] === "data-init" && plan.mode !== "dev") errors.push("logs data-init is only available in development mode");
  }

  if (plan.command === "shell") {
    validateOptionalTarget(plan.args, isShellTarget, "shell", errors);
  }

  if (plan.command === "cli" && plan.args.length === 0) {
    errors.push("cli requires pi-webui arguments");
  }

  if (errors.length > 0) return { ok: false, errors };

  const target = targetFrom(plan.command, plan.args);
  return { ok: true, plan: target === undefined ? plan : { ...plan, target } };
}

function validateOptionalTarget(args: readonly string[], isAllowed: (value: string) => boolean, command: string, errors: string[]): void {
  if (args.length > 1) {
    errors.push(`${command} accepts at most one target`);
    return;
  }
  const [target] = args;
  if (target !== undefined && !isAllowed(target)) errors.push(`Invalid ${command} target: ${target}`);
}

function targetFrom(command: PiWebUiDockerCommand, args: readonly string[]): PiWebUiDockerCommandPlan["target"] | undefined {
  const [target] = args;
  if (target === undefined) return command === "shell" ? "web" : undefined;
  if (command === "logs" && isLogsTarget(target)) return target;
  if (command === "shell" && isShellTarget(target)) return target;
  return undefined;
}

function isPiWebUiDockerCommand(value: string): value is PiWebUiDockerCommand {
  return commands.has(value);
}

function isLogsTarget(value: string): value is PiWebUiDockerLogsTarget {
  return logsTargets.has(value);
}

function isShellTarget(value: string): value is PiWebUiDockerShellTarget {
  return shellTargets.has(value);
}
