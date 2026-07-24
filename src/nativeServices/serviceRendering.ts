import { posix as posixPath } from "node:path";
import type {
  NativeServiceId,
  NativeServicePlan,
  NativeServicePlanService,
} from "./servicePlan.js";

export function renderSystemdUnit(
  plan: NativeServicePlan,
  service: NativeServicePlanService,
): string {
  assertPlanService(plan, service);
  assertBackend(plan, "systemd");
  const workingDirectory = service.workingDirectory === null
    ? ""
    : `WorkingDirectory=${systemdPathValue(service.workingDirectory)}\n`;
  const restart = service.restart === "on-failure"
    ? "Restart=on-failure\nRestartSec=2\n"
    : "Restart=no\n";
  return `[Unit]
Description=${service.description}
${systemdDependencyLine(plan, "After", service.after)}${systemdDependencyLine(plan, "Wants", service.wants)}[Service]
Type=simple
${workingDirectory}${systemdEnvironmentLines(service.environment)}ExecStart=/usr/bin/env ${systemdExecArgument(plan.shell.executable)} -lc ${systemdExecArgument(service.shellCommand)}
${restart}
[Install]
WantedBy=default.target
`;
}

export function renderLaunchdPlist(
  plan: NativeServicePlan,
  service: NativeServicePlanService,
  logDirectory: string,
): string {
  assertPlanService(plan, service);
  assertBackend(plan, "launchd");
  const programArguments = ["/usr/bin/env", plan.shell.executable, "-lc", service.shellCommand];
  const workingDirectory = service.workingDirectory === null
    ? ""
    : plistString("WorkingDirectory", service.workingDirectory);
  const keepAlive = service.restart === "on-failure"
    ? "  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>\n"
    : "";
  const logPath = posixPath.join(logDirectory, service.manager.logName);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${plistString("Label", service.manager.launchdLabel)}${plistProgramArguments(programArguments)}${workingDirectory}${plistEnvironment(service.environment)}  <key>RunAtLoad</key>
  <true/>
${keepAlive}${plistString("StandardOutPath", logPath)}${plistString("StandardErrorPath", logPath)}</dict>
</plist>
`;
}

function assertPlanService(plan: NativeServicePlan, service: NativeServicePlanService): void {
  if (!plan.services.includes(service)) {
    throw new Error(`Cannot render ${service.id}; it is not a member of the supplied native service plan.`);
  }
}

function assertBackend(plan: NativeServicePlan, expected: "systemd" | "launchd"): void {
  if (plan.backend.kind !== expected) {
    throw new Error(`Cannot render ${expected} service from a ${plan.backend.kind} native service plan.`);
  }
}

function systemdDependencyLine(
  plan: NativeServicePlan,
  name: "After" | "Wants",
  ids: readonly NativeServiceId[],
): string {
  if (ids.length === 0) return "";
  const names = ids.map((id) => {
    const dependency = plan.services.find((service) => service.id === id);
    if (dependency === undefined) throw new Error(`Service ${id} is not present in the native service plan.`);
    return dependency.manager.systemdName;
  });
  return `${name}=${names.join(" ")}\n`;
}

function systemdEnvironmentLines(environment: Readonly<Record<string, string>>): string {
  return Object.entries(environment)
    .map(([key, value]) => `Environment=${systemdQuotedDirectiveValue(`${key}=${value}`)}\n`)
    .join("");
}

function systemdExecArgument(value: string): string {
  return `"${systemdEscape(value.replaceAll("%", "%%").replaceAll("$", () => "$$"), false)}"`;
}

function systemdQuotedDirectiveValue(value: string): string {
  return `"${systemdEscape(value.replaceAll("%", "%%"), false)}"`;
}

function systemdPathValue(value: string): string {
  return systemdEscape(value.replaceAll("%", "%%"), true);
}

function systemdEscape(value: string, escapeSpaces: boolean): string {
  let escaped = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\\") escaped += "\\\\";
    else if (character === '"') escaped += escapeSpaces ? "\\x22" : '\\"';
    else if (character === "'" && escapeSpaces) escaped += "\\x27";
    else if (character === " " && escapeSpaces) escaped += "\\x20";
    else if (character === "\n") escaped += "\\n";
    else if (character === "\r") escaped += "\\r";
    else if (character === "\t") escaped += "\\t";
    else if (code < 0x20 || code === 0x7f) escaped += `\\x${code.toString(16).padStart(2, "0")}`;
    else escaped += character;
  }
  return escaped;
}

function plistProgramArguments(arguments_: readonly string[]): string {
  return `  <key>ProgramArguments</key>\n  <array>\n${arguments_.map((argument) => `    <string>${xmlEscape(argument)}</string>`).join("\n")}\n  </array>\n`;
}

function plistEnvironment(environment: Readonly<Record<string, string>>): string {
  const entries = Object.entries(environment);
  if (entries.length === 0) return "";
  return `  <key>EnvironmentVariables</key>\n  <dict>\n${entries.map(([key, value]) => plistString(key, value, "    ")).join("")}  </dict>\n`;
}

function plistString(key: string, value: string, indent = "  "): string {
  return `${indent}<key>${xmlEscape(key)}</key>\n${indent}<string>${xmlEscape(value)}</string>\n`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
