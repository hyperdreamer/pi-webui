import { posix as posixPath } from "node:path";
import {
  createDevelopmentNativeServicePlan,
  nativeServicePrerequisiteNeedsPathAdvice,
  resolveProductionNativeServicePlan,
  validateNativeServicePlan,
  type DevelopmentNativeServicePlanInput,
  type NativeServiceBackend,
  type NativeServiceId,
  type NativeServicePlan,
  type NativeServicePlanDependencies,
  type NativeServicePlanFailure,
  type NativeServicePlanValidationFailure,
  type NativeServicePrerequisite,
  type NativeServiceShell,
  type ProductionNativeServicePlanInput,
} from "./servicePlan.js";

export type InstalledNativeServiceMode = "none" | "production" | "development" | "ambiguous";

export interface InstalledNativeServiceDefinition {
  id: NativeServiceId;
  contents: string;
}

export interface InstalledNativeServiceContext {
  shell: NativeServiceShell;
  environment: Readonly<Record<string, string>>;
}

export type InstalledNativeServiceInspection<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export type NativeServiceDoctorTarget =
  | {
      kind: "installed-development";
      input: DevelopmentNativeServicePlanInput;
    }
  | {
      kind: "prospective-production";
      input: ProductionNativeServicePlanInput;
      reason: string;
    }
  | {
      kind: "inspection-failure";
      message: string;
    };

interface NativeServiceDoctorScope {
  kind: "installed-development" | "prospective-production";
  reason: string | null;
  shell: NativeServiceShell;
}

export type NativeServiceDoctorResult =
  | {
      kind: "inspection-failure";
      message: string;
    }
  | {
      kind: "plan-resolution-failure";
      scope: NativeServiceDoctorScope;
      failures: readonly NativeServicePlanFailure[];
    }
  | {
      kind: "plan-validation";
      scope: NativeServiceDoctorScope;
      plan: NativeServicePlan;
      validation: { ok: true } | { ok: false; failures: readonly NativeServicePlanValidationFailure[] };
    };

export interface NativeServiceDoctorReport {
  ok: boolean;
  failureKind: "none" | "requirements" | "infrastructure" | "inspection";
  lines: readonly string[];
  plan: NativeServicePlan | null;
  adviceShell: NativeServiceShell | null;
  pathAdviceRecommended: boolean;
  failedPrerequisites: readonly NativeServicePrerequisite[];
}

interface ParsedServiceDefinition {
  id: NativeServiceId;
  shell: NativeServiceShell;
  environment: Readonly<Record<string, string>>;
  workingDirectory: string | null;
  shellCommand: string;
}

export function inferInstalledNativeServiceMode(serviceIds: ReadonlySet<NativeServiceId>): InstalledNativeServiceMode {
  if (serviceIds.size === 0) return "none";
  const hasProductionWeb = serviceIds.has("web");
  const hasDevelopmentUi = serviceIds.has("uiDev");
  if (hasProductionWeb && !hasDevelopmentUi) return "production";
  if (hasDevelopmentUi && !hasProductionWeb) return "development";
  return "ambiguous";
}

export function inspectInstalledProductionServiceContext(
  backend: NativeServiceBackend,
  definitions: readonly InstalledNativeServiceDefinition[],
): InstalledNativeServiceInspection<InstalledNativeServiceContext> {
  const parsed = parseConsistentDefinitions(backend, definitions);
  if (!parsed.ok) return parsed;
  const withWorkingDirectory = parsed.value.find((definition) => definition.workingDirectory !== null);
  if (withWorkingDirectory !== undefined) {
    return {
      ok: false,
      message: `Installed production service ${withWorkingDirectory.id} unexpectedly has working directory ${withWorkingDirectory.workingDirectory ?? ""}.`,
    };
  }
  return {
    ok: true,
    value: {
      shell: parsed.value[0]?.shell ?? impossibleMissingDefinition(),
      environment: parsed.value[0]?.environment ?? impossibleMissingDefinition(),
    },
  };
}

export function inspectInstalledDevelopmentServiceInput(
  backend: NativeServiceBackend,
  definitions: readonly InstalledNativeServiceDefinition[],
): InstalledNativeServiceInspection<DevelopmentNativeServicePlanInput> {
  const parsed = parseConsistentDefinitions(backend, definitions);
  if (!parsed.ok) return parsed;
  const first = parsed.value[0] ?? impossibleMissingDefinition();
  if (first.workingDirectory === null) {
    return { ok: false, message: "Installed development services do not declare a working directory." };
  }

  const input: DevelopmentNativeServicePlanInput = {
    backend,
    shell: first.shell,
    environment: first.environment,
    workingDirectory: first.workingDirectory,
    packageJsonPath: posixPath.join(first.workingDirectory, "package.json"),
  };
  const expectedPlan = createDevelopmentNativeServicePlan(input);
  for (const definition of parsed.value) {
    const expected = expectedPlan.services.find((service) => service.id === definition.id);
    if (expected?.shellCommand !== definition.shellCommand) {
      return {
        ok: false,
        message: `Installed ${definition.id} service command does not match the canonical development plan.`,
      };
    }
  }
  return { ok: true, value: input };
}

export async function runNativeServiceDoctor(
  target: NativeServiceDoctorTarget,
  dependencies: NativeServicePlanDependencies,
): Promise<NativeServiceDoctorResult> {
  if (target.kind === "inspection-failure") return target;

  const scope: NativeServiceDoctorScope = target.kind === "installed-development"
    ? { kind: target.kind, reason: null, shell: target.input.shell }
    : { kind: target.kind, reason: target.reason, shell: target.input.shell };
  let plan: NativeServicePlan;
  if (target.kind === "installed-development") {
    plan = createDevelopmentNativeServicePlan(target.input);
  } else {
    const resolution = await resolveProductionNativeServicePlan(target.input, dependencies);
    if (!resolution.ok) {
      return { kind: "plan-resolution-failure", scope, failures: resolution.failures };
    }
    plan = resolution.plan;
  }

  const validation = await validateNativeServicePlan(plan, dependencies.probe);
  return { kind: "plan-validation", scope, plan, validation };
}

export function formatNativeServiceDoctorResult(result: NativeServiceDoctorResult): NativeServiceDoctorReport {
  if (result.kind === "inspection-failure") {
    return {
      ok: false,
      failureKind: "inspection",
      lines: [
        `✗ Installed native-service plan could not be inspected: ${result.message}`,
        "  Run `pi-webui install` or `pi-webui install --dev` to replace mixed, partial, or outdated service definitions.",
      ],
      plan: null,
      adviceShell: null,
      pathAdviceRecommended: false,
      failedPrerequisites: [],
    };
  }

  const lines = [scopeHeading(result.scope)];
  if (result.kind === "plan-resolution-failure") {
    let infrastructure = false;
    for (const failure of result.failures) {
      if (failure.kind === "probe-infrastructure") {
        infrastructure = true;
        lines.push(`✗ Native service probe infrastructure failure (${failure.reason}): ${failure.message}`);
      } else if (failure.kind === "entrypoint-inspection-failure") {
        infrastructure = true;
        lines.push(`✗ Could not inspect bundled ${failure.serviceId} entrypoint ${failure.entrypointPath}: ${failure.message}`);
      } else {
        lines.push(`✗ ${failure.namedCommand} is unavailable to the native service manager, and bundled entrypoint ${failure.bundledEntrypointPath} is missing.`);
        if (failure.namedCommandFailure !== null) lines.push(`  ${failure.namedCommandFailure}`);
      }
    }
    if (infrastructure) lines.push("  This infrastructure failure is not proof of a PATH mismatch.");
    return {
      ok: false,
      failureKind: infrastructure ? "infrastructure" : "requirements",
      lines,
      plan: null,
      adviceShell: result.scope.shell,
      pathAdviceRecommended: !infrastructure
        && result.failures.some((failure) => failure.kind === "executable-unavailable"),
      failedPrerequisites: [],
    };
  }

  const configuredOverrides = result.plan.services.filter((service) => service.strategy.kind === "configured-override");
  for (const service of configuredOverrides) {
    lines.push(`! ${service.description} uses a configured command override; doctor does not execute arbitrary configured commands.`);
  }
  if (result.validation.ok) {
    lines.push("✓ All verifiable native-service plan requirements are satisfied in the service-manager context.");
    return {
      ok: true,
      failureKind: "none",
      lines,
      plan: result.plan,
      adviceShell: result.plan.shell,
      pathAdviceRecommended: false,
      failedPrerequisites: [],
    };
  }

  const failedPrerequisites: NativeServicePrerequisite[] = [];
  let infrastructure = false;
  for (const failure of result.validation.failures) {
    if (failure.kind === "probe-infrastructure") {
      infrastructure = true;
      lines.push(`✗ Native service probe infrastructure failure (${failure.reason}): ${failure.message}`);
    } else {
      failedPrerequisites.push(failure.prerequisite);
      lines.push(`✗ Native service requirement failed: ${failure.prerequisite.description}`);
      if (failure.detail !== null && failure.detail !== failure.prerequisite.description) lines.push(`  ${failure.detail}`);
    }
  }
  if (infrastructure) lines.push("  This infrastructure failure is not proof of a PATH mismatch.");
  return {
    ok: false,
    failureKind: infrastructure ? "infrastructure" : "requirements",
    lines,
    plan: result.plan,
    adviceShell: result.plan.shell,
    pathAdviceRecommended: !infrastructure
      && failedPrerequisites.some(nativeServicePrerequisiteNeedsPathAdvice),
    failedPrerequisites,
  };
}

function scopeHeading(scope: NativeServiceDoctorScope): string {
  if (scope.kind === "installed-development") return "Installed development native-service plan:";
  return `Prospective production native-service plan (${scope.reason ?? "installed strategy is unknown"}):`;
}

function parseConsistentDefinitions(
  backend: NativeServiceBackend,
  definitions: readonly InstalledNativeServiceDefinition[],
): InstalledNativeServiceInspection<readonly ParsedServiceDefinition[]> {
  if (definitions.length === 0) return { ok: false, message: "No installed service definitions were provided." };

  const parsed: ParsedServiceDefinition[] = [];
  for (const definition of definitions) {
    const result = backend.kind === "systemd"
      ? parseSystemdDefinition(definition)
      : parseLaunchdDefinition(definition);
    if (!result.ok) return result;
    parsed.push(result.value);
  }

  const first = parsed[0] ?? impossibleMissingDefinition();
  for (const definition of parsed.slice(1)) {
    if (definition.shell.executable !== first.shell.executable) {
      return { ok: false, message: "Installed service definitions use different login shells." };
    }
    if (!recordsEqual(definition.environment, first.environment)) {
      return { ok: false, message: "Installed service definitions use different environments." };
    }
    if (definition.workingDirectory !== first.workingDirectory) {
      return { ok: false, message: "Installed service definitions use different working directories." };
    }
  }
  return { ok: true, value: parsed };
}

interface ParsedSystemdDirective {
  name: string;
  value: string;
}

function systemdServiceDirectives(contents: string): ParsedSystemdDirective[] | undefined {
  const allowed = new Set(["Type", "WorkingDirectory", "Environment", "ExecStart", "Restart", "RestartSec"]);
  const directives: ParsedSystemdDirective[] = [];
  let inServiceSection = false;
  let foundServiceSection = false;
  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]$/u.test(trimmed)) {
      inServiceSection = trimmed === "[Service]";
      foundServiceSection ||= inServiceSection;
      continue;
    }
    if (!inServiceSection || trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const match = /^\s*([A-Za-z][A-Za-z0-9]*)=(.*)$/u.exec(line);
    const name = match?.[1];
    const value = match?.[2];
    if (name === undefined || value === undefined || !allowed.has(name)) return undefined;
    directives.push({ name, value });
  }
  return foundServiceSection ? directives : undefined;
}

function parseSystemdDefinition(
  definition: InstalledNativeServiceDefinition,
): InstalledNativeServiceInspection<ParsedServiceDefinition> {
  const directives = systemdServiceDirectives(definition.contents);
  if (directives === undefined) {
    return { ok: false, message: `Installed ${definition.id} systemd unit has unrecognized service directives.` };
  }
  const execStarts = directives.filter((directive) => directive.name === "ExecStart");
  const execStart = execStarts.length === 1
    ? /^(?:\/usr\/bin\/env )?(.+?) -lc (.+)$/u.exec(execStarts[0]?.value ?? "")
    : null;
  if (execStart?.[1] === undefined || execStart[2] === undefined) {
    return { ok: false, message: `Installed ${definition.id} systemd unit must have exactly one recognized ExecStart.` };
  }
  const shellExecutable = parseSystemdExecArgument(execStart[1]);
  if (shellExecutable === undefined) {
    return { ok: false, message: `Installed ${definition.id} systemd unit has an unrecognized login shell argument.` };
  }
  const shell = installedShell(shellExecutable);
  if (!shell.ok) return shell;
  const shellCommand = parseSystemdShellCommand(shell.value.name, execStart[2]);
  if (shellCommand === undefined) {
    return { ok: false, message: `Installed ${definition.id} systemd unit has an unrecognized shell command.` };
  }

  const environment: Record<string, string> = {};
  for (const directive of directives.filter((item) => item.name === "Environment")) {
    const rawValue = directive.value;
    if (!/^"(?:\\.|[^"])*"$/u.test(rawValue)) {
      return { ok: false, message: `Installed ${definition.id} systemd unit has an unrecognized environment entry.` };
    }
    const assignment = parseSystemdDirectiveValue(rawValue);
    const separator = assignment?.indexOf("=") ?? -1;
    const key = assignment?.slice(0, separator) ?? "";
    if (separator <= 0 || Object.hasOwn(environment, key)) {
      return { ok: false, message: `Installed ${definition.id} systemd unit has a malformed environment entry.` };
    }
    environment[key] = assignment?.slice(separator + 1) ?? "";
  }

  const workingDirectories = directives.filter((directive) => directive.name === "WorkingDirectory");
  if (workingDirectories.length > 1) {
    return { ok: false, message: `Installed ${definition.id} systemd unit has duplicate working directories.` };
  }
  const rawWorkingDirectory = workingDirectories[0]?.value;
  if (rawWorkingDirectory?.startsWith('"') === true || rawWorkingDirectory?.startsWith("'") === true) {
    return { ok: false, message: `Installed ${definition.id} systemd unit has an invalid quoted working directory.` };
  }
  const workingDirectory = rawWorkingDirectory === undefined
    ? null
    : parseSystemdDirectiveValue(rawWorkingDirectory);
  if (workingDirectories.length === 1 && workingDirectory === undefined) {
    return { ok: false, message: `Installed ${definition.id} systemd unit has a malformed working directory.` };
  }

  return {
    ok: true,
    value: { id: definition.id, shell: shell.value, environment, workingDirectory: workingDirectory ?? null, shellCommand },
  };
}

function parseLaunchdDefinition(
  definition: InstalledNativeServiceDefinition,
): InstalledNativeServiceInspection<ParsedServiceDefinition> {
  const argumentsMatches = [...definition.contents.matchAll(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/gu)];
  const arguments_ = argumentsMatches.length === 1
    ? parseXmlStringSequence(argumentsMatches[0]?.[1] ?? "")
    : undefined;
  if (arguments_?.length !== 4 || arguments_[0] !== "/usr/bin/env" || arguments_[2] !== "-lc") {
    return { ok: false, message: `Installed ${definition.id} LaunchAgent has unrecognized ProgramArguments.` };
  }
  const shell = installedShell(arguments_[1] ?? "");
  if (!shell.ok) return shell;

  const environmentMatches = [...definition.contents.matchAll(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/gu)];
  const environmentKeyCount = [...definition.contents.matchAll(/<key>EnvironmentVariables<\/key>/gu)].length;
  if (environmentMatches.length > 1 || environmentKeyCount !== environmentMatches.length) {
    return { ok: false, message: `Installed ${definition.id} LaunchAgent has a malformed environment dictionary.` };
  }
  const environment = environmentMatches.length === 0
    ? {}
    : parseXmlStringDictionary(environmentMatches[0]?.[1] ?? "");
  if (environment === undefined) {
    return { ok: false, message: `Installed ${definition.id} LaunchAgent has a malformed environment dictionary.` };
  }

  const contentsWithoutEnvironment = environmentMatches[0]?.[0] === undefined
    ? definition.contents
    : definition.contents.replace(environmentMatches[0][0], "");
  const workingDirectoryMatches = [...contentsWithoutEnvironment.matchAll(/<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/gu)];
  const workingDirectoryKeyCount = [...contentsWithoutEnvironment.matchAll(/<key>WorkingDirectory<\/key>/gu)].length;
  if (workingDirectoryMatches.length > 1 || workingDirectoryKeyCount !== workingDirectoryMatches.length) {
    return { ok: false, message: `Installed ${definition.id} LaunchAgent has a malformed working directory.` };
  }
  const workingDirectory = workingDirectoryMatches[0]?.[1] === undefined
    ? null
    : xmlUnescapeStrict(workingDirectoryMatches[0][1]);
  if (workingDirectoryMatches.length === 1 && workingDirectory === undefined) {
    return { ok: false, message: `Installed ${definition.id} LaunchAgent has a malformed working directory.` };
  }

  return {
    ok: true,
    value: {
      id: definition.id,
      shell: shell.value,
      environment,
      workingDirectory: workingDirectory ?? null,
      shellCommand: arguments_[3] ?? "",
    },
  };
}

function installedShell(executable: string): InstalledNativeServiceInspection<NativeServiceShell> {
  const name = posixPath.basename(executable).replace(/^-/, "");
  if (name !== "bash" && name !== "zsh" && name !== "fish") {
    return { ok: false, message: `Installed service definition uses unsupported login shell ${executable}.` };
  }
  return {
    ok: true,
    value: { name, executable, source: "detected", detectedExecutable: executable },
  };
}

function parseSystemdExecArgument(value: string): string | undefined {
  const decoded = parseSystemdEscapedValue(value);
  return decoded === undefined ? undefined : decodeSystemdSubstitutions(decoded, true);
}

function parseSystemdDirectiveValue(value: string): string | undefined {
  const decoded = parseSystemdEscapedValue(value);
  return decoded === undefined ? undefined : decodeSystemdSubstitutions(decoded, false);
}

function parseSystemdEscapedValue(value: string): string | undefined {
  const quoted = value.startsWith('"') || value.endsWith('"');
  if (quoted && (!value.startsWith('"') || !value.endsWith('"'))) return undefined;
  return systemdUnescape(quoted ? value.slice(1, -1) : value);
}

function systemdUnescape(value: string): string | undefined {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      result += character ?? "";
      continue;
    }

    const escape = value[index + 1];
    if (escape === undefined) return undefined;
    const simpleEscapes: Readonly<Record<string, string>> = {
      "\\": "\\",
      '"': '"',
      "'": "'",
      a: "\u0007",
      b: "\b",
      e: "\u001b",
      f: "\f",
      n: "\n",
      r: "\r",
      s: " ",
      t: "\t",
      v: "\v",
    };
    const simple = simpleEscapes[escape];
    if (simple !== undefined) {
      result += simple;
      index += 1;
      continue;
    }

    const length = escape === "x" ? 2 : escape === "u" ? 4 : escape === "U" ? 8 : 0;
    if (length === 0) return undefined;
    const encoded = value.slice(index + 2, index + 2 + length);
    if (encoded.length !== length || !new RegExp(`^[0-9a-fA-F]{${String(length)}}$`, "u").test(encoded)) return undefined;
    const codePoint = Number.parseInt(encoded, 16);
    if (codePoint === 0 || codePoint > 0x10ffff) return undefined;
    result += String.fromCodePoint(codePoint);
    index += length + 1;
  }
  return result;
}

function decodeSystemdSubstitutions(value: string, decodeDollars: boolean): string | undefined {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "%" && !(decodeDollars && character === "$")) {
      result += character ?? "";
      continue;
    }
    if (value[index + 1] !== character) return undefined;
    result += character;
    index += 1;
  }
  return result;
}

function parseSystemdShellCommand(shell: NativeServiceShell["name"], value: string): string | undefined {
  if (value.startsWith('"') || value.endsWith('"')) return parseSystemdExecArgument(value);
  if (!value.startsWith("'") || !value.endsWith("'")) return undefined;
  const inner = value.slice(1, -1);
  const unquoted = shell === "fish" ? fishSingleQuoteUnescape(inner) : inner.replaceAll("'\\''", "'");
  return decodeSystemdSubstitutions(unquoted, true);
}

function fishSingleQuoteUnescape(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\" && index + 1 < value.length) {
      result += value[index + 1] ?? "";
      index += 1;
    } else {
      result += character ?? "";
    }
  }
  return result;
}

function parseXmlStringSequence(contents: string): string[] | undefined {
  const values: string[] = [];
  let cursor = 0;
  for (const match of contents.matchAll(/<string>([\s\S]*?)<\/string>/gu)) {
    if (contents.slice(cursor, match.index).trim() !== "") return undefined;
    const value = xmlUnescapeStrict(match[1] ?? "");
    if (value === undefined) return undefined;
    values.push(value);
    cursor = match.index + match[0].length;
  }
  return contents.slice(cursor).trim() === "" ? values : undefined;
}

function parseXmlStringDictionary(contents: string): Record<string, string> | undefined {
  const values: Record<string, string> = {};
  let cursor = 0;
  for (const match of contents.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/gu)) {
    if (contents.slice(cursor, match.index).trim() !== "") return undefined;
    const key = xmlUnescapeStrict(match[1] ?? "");
    const value = xmlUnescapeStrict(match[2] ?? "");
    if (key === undefined || value === undefined || Object.hasOwn(values, key)) return undefined;
    values[key] = value;
    cursor = match.index + match[0].length;
  }
  return contents.slice(cursor).trim() === "" ? values : undefined;
}

function xmlUnescapeStrict(value: string): string | undefined {
  if (/[<>]/u.test(value) || /&(?!(?:apos|quot|gt|lt|amp);)/u.test(value)) return undefined;
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function recordsEqual(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftEntries = Object.entries(left);
  return leftEntries.length === Object.keys(right).length
    && leftEntries.every(([key, value]) => right[key] === value);
}

function impossibleMissingDefinition(): never {
  throw new Error("Expected at least one installed native service definition");
}
