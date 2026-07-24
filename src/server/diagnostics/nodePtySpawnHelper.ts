import { accessSync, constants, existsSync, statSync, type Stats } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const PI_WEBUI_SPAWN_HELPER_ISSUE_URL = "https://github.com/hyperdreamer/pi-webui/issues/4";
export const NODE_PTY_SPAWN_HELPER_UPSTREAM_ISSUE_URL = "https://github.com/microsoft/node-pty/issues/850";

const doctorLabel = "node-pty macOS spawn-helper executable";
const requireFromHere = createRequire(import.meta.url);

type FileExists = (path: string) => boolean;
type FileStat = (path: string) => Stats;
type FileAccess = (path: string, mode: number) => void;

export interface NodePtyDarwinSpawnHelperCheckOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  nodePtyPackageJsonPath?: string;
  resolveNodePtyPackageJson?: () => string;
  exists?: FileExists;
  stat?: FileStat;
  access?: FileAccess;
}

export type NodePtyDarwinSpawnHelperCheck =
  | { status: "skipped"; reason: "not-macos" }
  | { status: "ok"; helperPath: string; nodePtyRoot: string }
  | { status: "node-pty-not-found"; message: string }
  | { status: "native-module-not-found"; nodePtyRoot: string; expectedHelperPath: string }
  | { status: "spawn-helper-missing"; helperPath: string; nodePtyRoot: string }
  | { status: "spawn-helper-not-file"; helperPath: string; nodePtyRoot: string }
  | { status: "spawn-helper-stat-error"; helperPath: string; nodePtyRoot: string; message: string }
  | { status: "spawn-helper-not-executable"; helperPath: string; nodePtyRoot: string; fixCommand: string };

export interface FormattedNodePtyDarwinSpawnHelperCheck {
  ok: boolean;
  lines: string[];
}

export function checkNodePtyDarwinSpawnHelper(options: NodePtyDarwinSpawnHelperCheckOptions = {}): NodePtyDarwinSpawnHelperCheck {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return { status: "skipped", reason: "not-macos" };

  const arch = options.arch ?? process.arch;
  const exists = options.exists ?? existsSync;
  const stat = options.stat ?? statSync;
  const access = options.access ?? accessSync;

  let nodePtyPackageJsonPath: string;
  try {
    nodePtyPackageJsonPath = options.nodePtyPackageJsonPath ?? (options.resolveNodePtyPackageJson ?? resolveNodePtyPackageJson)();
  } catch (error) {
    return { status: "node-pty-not-found", message: errorMessage(error) };
  }

  const nodePtyRoot = dirname(nodePtyPackageJsonPath);
  const nativeDir = findNodePtyNativeDir(nodePtyRoot, platform, arch, exists);
  if (nativeDir === undefined) {
    return {
      status: "native-module-not-found",
      nodePtyRoot,
      expectedHelperPath: join(nodePtyRoot, "prebuilds", `${platform}-${arch}`, "spawn-helper"),
    };
  }

  const helperPath = join(nativeDir, "spawn-helper");
  try {
    if (!stat(helperPath).isFile()) return { status: "spawn-helper-not-file", helperPath, nodePtyRoot };
  } catch (error) {
    if (isFileNotFoundError(error)) return { status: "spawn-helper-missing", helperPath, nodePtyRoot };
    return { status: "spawn-helper-stat-error", helperPath, nodePtyRoot, message: errorMessage(error) };
  }

  try {
    access(helperPath, constants.X_OK);
    return { status: "ok", helperPath, nodePtyRoot };
  } catch {
    return { status: "spawn-helper-not-executable", helperPath, nodePtyRoot, fixCommand: chmodFixCommand(helperPath) };
  }
}

export function formatNodePtyDarwinSpawnHelperCheck(check: NodePtyDarwinSpawnHelperCheck): FormattedNodePtyDarwinSpawnHelperCheck {
  if (check.status === "skipped") return { ok: true, lines: [] };
  if (check.status === "ok") {
    return {
      ok: true,
      lines: [`✓ ${doctorLabel}`, `  ${check.helperPath}`],
    };
  }

  if (check.status === "spawn-helper-not-executable") {
    return {
      ok: false,
      lines: [
        `✗ ${doctorLabel}`,
        `  ${check.helperPath} exists but is not executable.`,
        `  Known upstream node-pty packaging issue: ${NODE_PTY_SPAWN_HELPER_UPSTREAM_ISSUE_URL}`,
        `  PI WEBUI tracking issue: ${PI_WEBUI_SPAWN_HELPER_ISSUE_URL}`,
        "  Proposed workaround:",
        `    ${check.fixCommand}`,
        "  Then run `pi-webui doctor` again and retry opening a terminal.",
      ],
    };
  }

  return {
    ok: false,
    lines: [`✗ ${doctorLabel}`, ...failureDetails(check)],
  };
}

function resolveNodePtyPackageJson(): string {
  return requireFromHere.resolve("node-pty/package.json");
}

function findNodePtyNativeDir(nodePtyRoot: string, platform: NodeJS.Platform, arch: string, exists: FileExists): string | undefined {
  for (const dir of nodePtyNativeDirs(nodePtyRoot, platform, arch)) {
    if (exists(join(dir, "pty.node"))) return dir;
  }
  return undefined;
}

function nodePtyNativeDirs(nodePtyRoot: string, platform: NodeJS.Platform, arch: string): string[] {
  const dirs = ["build/Release", "build/Debug", `prebuilds/${platform}-${arch}`];
  return dirs.flatMap((dir) => [join(nodePtyRoot, dir), join(nodePtyRoot, "lib", dir)]);
}

function failureDetails(check: Exclude<NodePtyDarwinSpawnHelperCheck, { status: "ok" | "skipped" | "spawn-helper-not-executable" }>): string[] {
  if (check.status === "node-pty-not-found") {
    return [
      `  Could not resolve node-pty from PI WEBUI: ${check.message}`,
      "  Reinstall or update PI WEBUI, then run `pi-webui doctor` again.",
    ];
  }
  if (check.status === "native-module-not-found") {
    return [
      `  Could not find node-pty's native pty.node module under ${check.nodePtyRoot}.`,
      `  Expected macOS helper location: ${check.expectedHelperPath}`,
      "  Reinstall or update PI WEBUI, then run `pi-webui doctor` again.",
    ];
  }
  if (check.status === "spawn-helper-missing") {
    return [
      `  Expected helper is missing: ${check.helperPath}`,
      "  Reinstall or update PI WEBUI, then run `pi-webui doctor` again.",
    ];
  }
  if (check.status === "spawn-helper-not-file") {
    return [
      `  Expected helper is not a regular file: ${check.helperPath}`,
      "  Reinstall or update PI WEBUI, then run `pi-webui doctor` again.",
    ];
  }
  return [
    `  Could not inspect ${check.helperPath}: ${check.message}`,
    "  Check the file permissions, then run `pi-webui doctor` again.",
  ];
}

function chmodFixCommand(path: string): string {
  return `chmod +x ${shellSingleQuote(path)}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
