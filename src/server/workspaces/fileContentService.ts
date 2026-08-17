import { lstat, mkdir, open, readlink, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DeleteWorkspaceFileResponse, FileContentResponse, MoveWorkspaceFileOptions, MoveWorkspaceFileResponse, PiWebUiPathAccessConfig, WriteWorkspaceFileOptions, WriteWorkspaceFileResponse } from "../../shared/apiTypes.js";
import { MAX_WORKSPACE_FILE_BYTES } from "../../shared/workspaceFiles.js";
import { imageMimeTypeForPath } from "./imagePreviewService.js";
import { resolveWorkspacePathAccessTarget } from "./pathAccessPolicy.js";
import { ensureInside, isNodeErrorWithCode, normalizeRelativePath, resolveInsideWorkspace, resolveParentInsideWorkspace } from "./pathSafety.js";

export async function readWorkspaceFile(rootPath: string, path: string | undefined, pathAccess?: PiWebUiPathAccessConfig): Promise<FileContentResponse> {
  if (path === undefined || path === "") throw new Error("path query parameter is required");
  const { target, displayPath } = await resolveWorkspacePathAccessTarget(rootPath, path, pathAccess);
  const s = await stat(target);
  if (!s.isFile()) throw new Error("Path is not a file");
  const bytesToRead = Math.min(s.size, MAX_WORKSPACE_FILE_BYTES);
  const buffer = await readFilePrefix(target, bytesToRead);
  const media = mediaForPath(displayPath);
  const binary = media.mediaType === "image" || isProbablyBinary(buffer);
  return {
    path: displayPath,
    ...languageForPath(displayPath),
    ...media,
    encoding: "utf8",
    size: s.size,
    modifiedAt: s.mtime.toISOString(),
    content: binary ? "" : buffer.toString("utf8"),
    truncated: s.size > MAX_WORKSPACE_FILE_BYTES,
    binary,
  };
}

/**
 * Read a complete workspace file as bytes while requiring valid UTF-8. This
 * is intentionally separate from the explorer preview, whose contract keeps
 * truncation and replacement-character decoding for arbitrary files.
 */
export async function readWorkspaceFileRaw(rootPath: string, path: string | undefined, pathAccess?: PiWebUiPathAccessConfig): Promise<Buffer> {
  if (path === undefined || path === "") throw new Error("path query parameter is required");

  let target: string;
  if (path.startsWith("/") || path.startsWith("~")) {
    ({ target } = await resolveWorkspacePathAccessTarget(rootPath, path, pathAccess));
  } else {
    const resolved = await resolveParentInsideWorkspace(rootPath, path);
    const realParent = await realpath(dirname(resolved.target));
    target = join(realParent, basename(resolved.target));
    ensureInside(resolved.root, target);
    const entry = await lstat(target);
    if (entry.isSymbolicLink()) throw new Error("Workspace file must not be a symbolic link");
  }

  return readWorkspaceFileBytesFromTarget(target);
}

export interface WorkspaceFileRawReadHandle {
  read(buffer: Buffer, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface WorkspaceFileRawReadOperations {
  stat(path: string): Promise<{ isFile(): boolean; size: number }>;
  open(path: string): Promise<WorkspaceFileRawReadHandle>;
}

export async function readWorkspaceFileBytesFromTarget(
  target: string,
  operations: WorkspaceFileRawReadOperations = { stat, open: (path) => open(path, "r") },
): Promise<Buffer> {
  const metadata = await operations.stat(target);
  if (!metadata.isFile()) throw new Error("Path is not a file");
  if (metadata.size > MAX_WORKSPACE_FILE_BYTES) {
    throw new Error(`Workspace file exceeds ${String(MAX_WORKSPACE_FILE_BYTES)} bytes`);
  }

  const buffer = Buffer.alloc(MAX_WORKSPACE_FILE_BYTES + 1);
  const handle = await operations.open(target);
  let bytesRead = 0;
  try {
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
  } finally {
    await handle.close();
  }

  if (bytesRead > MAX_WORKSPACE_FILE_BYTES) {
    throw new Error(`Workspace file exceeds ${String(MAX_WORKSPACE_FILE_BYTES)} bytes`);
  }
  const bytes = buffer.subarray(0, bytesRead);
  if (bytes.includes(0)) throw new Error("Workspace file is binary");
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return bytes;
}

async function readFilePrefix(target: string, bytesToRead: number): Promise<Buffer> {
  if (bytesToRead === 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(bytesToRead);
  const handle = await open(target, "r");
  try {
    const result = await handle.read(buffer, 0, bytesToRead, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

export interface WorkspaceFileMutationPath {
  normalizedPath: string;
  resolvedPaths: readonly string[];
}

export interface WorkspaceFileMutationPathOptions {
  /** Stop before following a fixed target's final entry so its no-follow owner can inspect it. */
  stopAt?: (relativePath: string) => boolean;
}

/**
 * Resolve existing aliases before a route decides whether a fixed-file owner
 * owns a mutation. A caller can stop at its fixed target to preserve that
 * owner's final-entry no-follow checks.
 */
export async function resolveWorkspaceFileMutationPath(
  rootPath: string,
  path: string | undefined,
  options: WorkspaceFileMutationPathOptions = {},
): Promise<WorkspaceFileMutationPath> {
  const { root, relativePath } = await resolveParentInsideWorkspace(rootPath, path ?? "");
  const resolvedPaths = new Set<string>([relativePath]);
  if (options.stopAt?.(relativePath) === true) {
    return { normalizedPath: relativePath, resolvedPaths: [...resolvedPaths] };
  }

  let current = root;
  let remaining = relativePath === "" ? [] : relativePath.split("/");
  let resolvedLinks = 0;
  while (remaining.length > 0) {
    const part = remaining.shift();
    if (part === undefined) break;
    const target = join(current, part);
    ensureInside(root, target);

    let entry;
    try {
      entry = await lstat(target);
    } catch (error) {
      if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
      const unresolvedTarget = join(target, ...remaining);
      ensureInside(root, unresolvedTarget);
      const unresolvedPath = normalizeRelativePath(relative(root, unresolvedTarget));
      resolvedPaths.add(unresolvedPath);
      return { normalizedPath: relativePath, resolvedPaths: [...resolvedPaths] };
    }

    if (!entry.isSymbolicLink()) {
      current = target;
      continue;
    }

    resolvedLinks += 1;
    if (resolvedLinks > 40) throw new Error("Too many symbolic links in workspace mutation path");
    const link = await readlink(target);
    const linkTarget = isAbsolute(link) ? link : resolve(dirname(target), link);
    ensureInside(root, linkTarget);
    const linkPath = normalizeRelativePath(relative(root, linkTarget));
    remaining = [...(linkPath === "" ? [] : linkPath.split("/")), ...remaining];
    const resolvedPath = remaining.join("/");
    resolvedPaths.add(resolvedPath);
    if (options.stopAt?.(resolvedPath) === true) {
      return { normalizedPath: relativePath, resolvedPaths: [...resolvedPaths] };
    }
    current = root;
  }

  return { normalizedPath: relativePath, resolvedPaths: [...resolvedPaths] };
}

export async function writeWorkspaceFile(rootPath: string, path: string | undefined, content: Buffer, options: WriteWorkspaceFileOptions = {}): Promise<WriteWorkspaceFileResponse> {
  if (path === undefined || path === "") throw new Error("path query parameter is required");

  const createDirs = options.createDirs ?? true;
  const overwrite = options.overwrite ?? true;

  let exists = false;
  try {
    const { target, relativePath } = await resolveInsideWorkspace(rootPath, path);
    const s = await stat(target);
    if (!s.isFile()) throw new Error("Path is not a file");
    if (!overwrite) throw new Error(`File already exists: ${relativePath}`);
    exists = true;
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("File already exists")) throw error;
    if (isNodeErrorWithCode(error, "ENOENT")) { /* expected for creation — continue */ }
    else if (error instanceof Error && error.message === "Path does not exist") { /* expected for creation — continue */ }
    else throw error; // re-throw permission errors, "not a file", traversal errors, etc.
  }

  // Use resolveParentInsideWorkspace for the actual write since the target may not exist yet
  const { root, target, relativePath } = await resolveParentInsideWorkspace(rootPath, path);

  if (createDirs) await mkdir(dirname(target), { recursive: true });

  // Resolve symlinks in the parent path to prevent escape via symlink
  const realParent = await realpath(dirname(target));
  const realTarget = join(realParent, basename(target));
  ensureInside(root, realTarget);
  await writeFile(realTarget, content);

  const s = await stat(realTarget);
  return {
    path: relativePath,
    size: s.size,
    modifiedAt: s.mtime.toISOString(),
    created: !exists,
  };
}

export async function deleteWorkspaceFile(rootPath: string, path: string | undefined): Promise<DeleteWorkspaceFileResponse> {
  if (path === undefined || path === "") throw new Error("path query parameter is required");
  // Use resolveParentInsideWorkspace + lstat so that deleting a symlink
  // deletes the symlink itself, not the target it points to.
  // resolveInsideWorkspace would call realpath on the target, following
  // symlinks and resolving the symlink's destination instead.
  const { root, target, relativePath } = await resolveParentInsideWorkspace(rootPath, path);
  try {
    // Resolve symlinks in the parent path to prevent escape via a symlinked
    // parent directory. The final path component is intentionally NOT resolved
    // so that lstat/unlink act on the entry itself (deleting a symlink rather
    // than the file it points to).
    const realParent = await realpath(dirname(target));
    const realTarget = join(realParent, basename(target));
    ensureInside(root, realTarget);
    const s = await lstat(realTarget);
    // Allow deleting regular files and symlinks, but not directories
    if (s.isDirectory()) throw new Error("Path is a directory, use directory deletion instead");
    await unlink(realTarget);
    return { path: relativePath, existed: true };
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) return { path: relativePath, existed: false };
    if (error instanceof Error && error.message === "Path does not exist") return { path: relativePath, existed: false };
    throw error;
  }
}

export async function moveWorkspaceFile(rootPath: string, fromPath: string | undefined, toPath: string | undefined, options: MoveWorkspaceFileOptions = {}): Promise<MoveWorkspaceFileResponse> {
  if (fromPath === undefined || fromPath === "") throw new Error("fromPath query parameter is required");
  if (toPath === undefined || toPath === "") throw new Error("toPath query parameter is required");

  const createDirs = options.createDirs ?? true;
  const overwrite = options.overwrite ?? false;

  // Source: must exist and be a file (uses realpath via resolveInsideWorkspace)
  const { target: source, relativePath: fromRelative } = await resolveInsideWorkspace(rootPath, fromPath);
  const sourceStat = await stat(source);
  if (!sourceStat.isFile()) throw new Error("Source path is not a file");

  // Target: uses resolveParentInsideWorkspace + realpath(dirname) pattern (same as writeFile)
  const { root, target: dest, relativePath: destRelative } = await resolveParentInsideWorkspace(rootPath, toPath);

  if (createDirs) await mkdir(dirname(dest), { recursive: true });

  // Resolve symlinks in the parent path to prevent escape via symlink
  const realParent = await realpath(dirname(dest));
  const realDest = join(realParent, basename(dest));
  ensureInside(root, realDest);

  if (!overwrite) {
    try {
      const destStat = await stat(realDest);
      if (destStat.isFile()) throw new Error(`File already exists: ${destRelative}`);
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) { /* expected — target doesn't exist */ }
      else if (error instanceof Error && error.message.startsWith("File already exists")) throw error;
      else throw error;
    }
  }

  await rename(source, realDest);
  const finalStat = await stat(realDest);
  return { fromPath: fromRelative, toPath: destRelative, size: finalStat.size, modifiedAt: finalStat.mtime.toISOString() };
}

function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

function languageForPath(path: string): { language?: string } {
  const ext = path.split(".").pop()?.toLowerCase();
  const languages: Record<string, string | undefined> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    py: "python",
    rs: "rust",
    go: "go",
    sh: "shell",
    yml: "yaml",
    yaml: "yaml",
  };
  const language = ext === undefined ? undefined : languages[ext];
  return language === undefined ? {} : { language };
}

function mediaForPath(path: string): { mediaType?: "image"; mimeType?: string } {
  const mimeType = imageMimeTypeForPath(path);
  return mimeType === undefined ? {} : { mediaType: "image", mimeType };
}
