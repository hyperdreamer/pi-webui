import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import type { PiWebUiPathAccessConfig } from "../../shared/apiTypes.js";
import { normalizeRelativePath } from "./pathSafety.js";

export interface AllowedPathRoot {
  /** Raw config value for diagnostics. */
  source: string;
  /** Host-absolute path after expanding ~ and normalizing syntax. */
  path: string;
  /** Canonical directory root used for containment checks. */
  realPath: string;
}

export interface PathAccessPolicy {
  workspaceRoot: string;
  allowedRoots: AllowedPathRoot[];
}

export type PathAccessTargetKind = "workspace" | "allowed";

export interface ResolvedPathAccessTarget {
  kind: PathAccessTargetKind;
  /** Canonical root that granted access: workspace root or allowed root. */
  root: string;
  /** Canonical existing target path. */
  target: string;
  /** Requestable path returned to clients and used to build child paths. */
  displayPath: string;
}

export interface PathAccessPolicyOptions {
  homeDir?: string;
}

export async function createPathAccessPolicy(workspaceRootPath: string, pathAccess: PiWebUiPathAccessConfig | undefined, options: PathAccessPolicyOptions = {}): Promise<PathAccessPolicy> {
  return {
    workspaceRoot: await canonicalDirectory(workspaceRootPath, "Workspace path"),
    allowedRoots: await resolveAllowedRoots(pathAccess?.allowedPaths ?? [], options),
  };
}

export async function resolveWorkspacePathAccessTarget(rootPath: string, requestedPath: string | undefined, pathAccess?: PiWebUiPathAccessConfig, options: PathAccessPolicyOptions = {}): Promise<ResolvedPathAccessTarget> {
  const request = requestedPath ?? "";
  const workspaceRoot = await canonicalDirectory(rootPath, "Workspace path");
  const allowedRoots = isAbsoluteishPath(request) ? await resolveAllowedRoots(pathAccess?.allowedPaths ?? [], options) : [];
  return resolvePathAccessTarget({ workspaceRoot, allowedRoots }, requestedPath, options);
}

export async function resolvePathAccessTarget(policy: PathAccessPolicy, requestedPath: string | undefined, options: PathAccessPolicyOptions = {}): Promise<ResolvedPathAccessTarget> {
  const request = requestedPath ?? "";
  if (isAbsoluteishPath(request)) return resolveAllowedTarget(policy, request, options);

  const displayPath = normalizeRelativePath(request);
  const target = await canonicalExistingPath(resolve(policy.workspaceRoot, displayPath));
  ensureInside(policy.workspaceRoot, target, "Path escapes workspace");
  return { kind: "workspace", root: policy.workspaceRoot, target, displayPath };
}

export function isAbsoluteishPath(path: string): boolean {
  return path === "~" || path.startsWith("~/") || path.startsWith("~\\") || isAbsolute(path) || win32.isAbsolute(path);
}

async function resolveAllowedRoots(allowedPaths: readonly string[], options: PathAccessPolicyOptions): Promise<AllowedPathRoot[]> {
  const roots: AllowedPathRoot[] = [];
  for (const source of allowedPaths) {
    const expanded = expandAbsoluteishPath(source, options, `Allowed path must be absolute or start with ~: ${source}`);
    const realPath = await canonicalDirectory(expanded, `Allowed path ${source}`);
    if (roots.some((root) => root.realPath === realPath)) continue;
    roots.push({ source, path: expanded, realPath });
  }
  return roots;
}

async function resolveAllowedTarget(policy: PathAccessPolicy, request: string, options: PathAccessPolicyOptions): Promise<ResolvedPathAccessTarget> {
  if (policy.allowedRoots.length === 0) throw new Error("Absolute paths are not allowed");

  const displayPath = expandAbsoluteishPath(request, options, `Path is not absolute: ${request}`);
  const target = await canonicalExistingPath(displayPath);
  const root = policy.allowedRoots.find((allowedRoot) => isInsideOrSame(allowedRoot.realPath, target));
  if (root === undefined) throw new Error("Path is outside allowed paths");
  return { kind: "allowed", root: root.realPath, target, displayPath };
}

function expandAbsoluteishPath(path: string, options: PathAccessPolicyOptions, relativeMessage: string): string {
  const home = options.homeDir ?? homedir();
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(home, path.slice(2));
  if (isAbsolute(path)) return resolve(path);
  if (win32.isAbsolute(path)) throw new Error(`Absolute path is not valid on this host: ${path}`);
  throw new Error(relativeMessage);
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const canonical = await canonicalExistingPath(path, `${label} does not exist`);
  const result = await stat(canonical);
  if (!result.isDirectory()) throw new Error(`${label} must be a directory`);
  return canonical;
}

async function canonicalExistingPath(path: string, missingMessage = "Path does not exist"): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) throw new Error(missingMessage, { cause: error });
    throw error;
  }
}

function ensureInside(root: string, target: string, message: string): void {
  if (!isInsideOrSame(root, target)) throw new Error(message);
}

function isInsideOrSame(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
