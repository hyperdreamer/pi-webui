import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type {
  DeleteWorkspaceFileResponse,
  MoveWorkspaceFileResponse,
  WorkspaceCatalogAddress,
  WriteWorkspaceFileOptions,
  WriteWorkspaceFileResponse,
} from "../../shared/apiTypes.js";
import { MAX_WORKSPACE_FILE_BYTES } from "../../shared/workspaceFiles.js";
import { TASKS_CONFIG_PATH } from "../../shared/workspaceTasks.js";
import { readWorkspaceFileBytesFromTarget, type WorkspaceFileRawReadHandle } from "../workspaces/fileContentService.js";
import { ensureInside, isNodeErrorWithCode, normalizeRelativePath } from "../workspaces/pathSafety.js";
import { resolveWorkspaceContext } from "../workspaces/workspaceContext.js";
import type { ProjectService } from "../projects/projectService.js";
import type { WorkspaceService } from "../workspaces/workspaceService.js";

export type WorkspaceTasksWorkspaceFileRead =
  | { kind: "missing"; revision: string }
  | { kind: "present"; bytes: Buffer; revision: string };

export interface WorkspaceTasksWorkspaceFilePublicationHooks {
  onPublicationAttempt?: () => void;
  onPublished?: () => void;
}

export interface WorkspaceTasksNormalizedFileMove {
  fromPath: string;
  toPath: string;
  createDirs?: boolean;
  overwrite?: boolean;
}

export interface WorkspaceTasksWorkspaceFileSystem {
  lstat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  open(path: string): Promise<WorkspaceFileRawReadHandle>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, bytes: Uint8Array, options?: { flag?: string; mode?: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<Stats>;
}

export interface WorkspaceTasksWorkspaceFileResolver {
  readCatalog(address: WorkspaceCatalogAddress): Promise<WorkspaceTasksWorkspaceFileRead>;
  publishCatalog(
    address: WorkspaceCatalogAddress,
    bytes: Uint8Array,
    hooks?: WorkspaceTasksWorkspaceFilePublicationHooks,
  ): Promise<void>;
  writeExplorerTaskFile(
    address: WorkspaceCatalogAddress,
    body: Uint8Array,
    options?: WriteWorkspaceFileOptions,
  ): Promise<WriteWorkspaceFileResponse>;
  deleteExplorerTaskFile(address: WorkspaceCatalogAddress): Promise<DeleteWorkspaceFileResponse>;
  moveExplorerTaskFile(
    address: WorkspaceCatalogAddress,
    normalizedMove: WorkspaceTasksNormalizedFileMove,
  ): Promise<MoveWorkspaceFileResponse>;
}

export interface WorkspaceTasksWorkspaceFileResolverOptions {
  projects: ProjectService;
  workspaces: WorkspaceService;
  fileSystem?: Partial<WorkspaceTasksWorkspaceFileSystem>;
  resolveContext?: typeof resolveWorkspaceContext;
}

type FixedTaskPath =
  | { root: string; parent: string; target: string; final: Stats | undefined }
  | { root: string; parentMissing: true };

const defaultFileSystem: WorkspaceTasksWorkspaceFileSystem = {
  lstat: (path) => lstat(path),
  realpath: (path) => realpath(path),
  mkdir: (path, options) => mkdir(path, options),
  open: (path) => open(path, "r"),
  readFile: (path) => readFile(path),
  writeFile: (path, bytes, options) => writeFile(path, bytes, options),
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
  stat: (path) => stat(path),
};

export function createWorkspaceTasksWorkspaceFileResolver(
  options: WorkspaceTasksWorkspaceFileResolverOptions,
): WorkspaceTasksWorkspaceFileResolver {
  const fileSystem = { ...defaultFileSystem, ...(options.fileSystem ?? {}) };
  const resolveContext = options.resolveContext ?? resolveWorkspaceContext;

  async function workspaceRoot(address: WorkspaceCatalogAddress): Promise<string> {
    const context = await resolveContext(options.projects, options.workspaces, address.projectId, address.workspaceId);
    const root = await fileSystem.realpath(context.root);
    const metadata = await fileSystem.lstat(root);
    if (!metadata.isDirectory()) throw new Error("Workspace path must be a directory");
    return root;
  }

  async function resolveFixedTaskPath(
    address: WorkspaceCatalogAddress,
    createParent: boolean,
  ): Promise<FixedTaskPath> {
    const root = await workspaceRoot(address);
    const parentPath = join(root, ".pi-webui");
    let parent: string;
    try {
      parent = await resolveSafeDirectory(root, parentPath, createParent);
    } catch (error) {
      if (!createParent && isNodeErrorWithCode(error, "ENOENT")) return { root, parentMissing: true };
      throw error;
    }
    const target = join(parent, "tasks.json");
    const final = await inspectFinalEntry(target);
    if (final?.isSymbolicLink() === true) throw new Error("Workspace task file must not be a symbolic link");
    return { root, parent, target, final };
  }

  async function readCatalog(address: WorkspaceCatalogAddress): Promise<WorkspaceTasksWorkspaceFileRead> {
    const resolved = await resolveFixedTaskPath(address, false);
    if ("parentMissing" in resolved || resolved.final === undefined) return { kind: "missing", revision: revisionForMissing() };
    if (!resolved.final.isFile()) throw new Error("Workspace task file must be a regular file");
    if (resolved.final.size > MAX_WORKSPACE_FILE_BYTES) {
      throw new Error(`Workspace task file exceeds ${String(MAX_WORKSPACE_FILE_BYTES)} bytes`);
    }

    let bytes: Buffer;
    try {
      bytes = await readWorkspaceFileBytesFromTarget(resolved.target, {
        stat: fileSystem.stat,
        open: fileSystem.open,
      });
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) return { kind: "missing", revision: revisionForMissing() };
      throw error;
    }
    return { kind: "present", bytes, revision: revisionForBytes(bytes) };
  }

  async function publishCatalog(
    address: WorkspaceCatalogAddress,
    bytes: Uint8Array,
    hooks: WorkspaceTasksWorkspaceFilePublicationHooks = {},
  ): Promise<void> {
    const resolved = await resolveFixedTaskPath(address, true);
    if ("parentMissing" in resolved) throw new Error("Workspace task parent could not be created");
    await publishBytes(resolved.parent, resolved.target, Buffer.from(bytes), hooks);
  }

  async function writeExplorerTaskFile(
    address: WorkspaceCatalogAddress,
    body: Uint8Array,
    writeOptions: WriteWorkspaceFileOptions = {},
  ): Promise<WriteWorkspaceFileResponse> {
    const resolved = await resolveFixedTaskPath(address, writeOptions.createDirs ?? true);
    if ("parentMissing" in resolved) throw new Error("Path does not exist");
    const exists = resolved.final !== undefined;
    if (resolved.final !== undefined && !resolved.final.isFile()) throw new Error("Path is not a file");
    if (exists && writeOptions.overwrite === false) throw new Error(`File already exists: ${TASKS_CONFIG_PATH}`);

    await publishBytes(resolved.parent, resolved.target, Buffer.from(body));
    const metadata = await fileSystem.stat(resolved.target);
    return {
      path: TASKS_CONFIG_PATH,
      size: metadata.size,
      modifiedAt: metadata.mtime.toISOString(),
      created: !exists,
    };
  }

  async function deleteExplorerTaskFile(address: WorkspaceCatalogAddress): Promise<DeleteWorkspaceFileResponse> {
    const resolved = await resolveFixedTaskPath(address, false);
    if ("parentMissing" in resolved || resolved.final === undefined) return { path: TASKS_CONFIG_PATH, existed: false };
    if (!resolved.final.isFile()) throw new Error("Path is not a file");
    try {
      await fileSystem.unlink(resolved.target);
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) return { path: TASKS_CONFIG_PATH, existed: false };
      throw error;
    }
    return { path: TASKS_CONFIG_PATH, existed: true };
  }

  async function moveExplorerTaskFile(
    address: WorkspaceCatalogAddress,
    normalizedMove: WorkspaceTasksNormalizedFileMove,
  ): Promise<MoveWorkspaceFileResponse> {
    const root = await workspaceRoot(address);
    const from = normalizeRelativePath(normalizedMove.fromPath);
    const to = normalizeRelativePath(normalizedMove.toPath);
    if (from === "" || to === "") throw new Error("File move paths are required");

    const source = await resolveExplorerEntry(root, from, false);
    if (source.final === undefined) throw new Error("Path does not exist");
    if (source.final.isSymbolicLink()) throw new Error("Workspace task file must not be a symbolic link");
    if (!source.final.isFile()) throw new Error("Source path is not a file");

    const destination = await resolveExplorerEntry(root, to, normalizedMove.createDirs ?? true);
    if (destination.final !== undefined && normalizedMove.overwrite !== true) {
      throw new Error(`File already exists: ${to}`);
    }
    if (destination.final !== undefined && destination.final.isSymbolicLink() && isTaskPath(to)) {
      throw new Error("Workspace task file must not be a symbolic link");
    }

    await fileSystem.rename(source.target, destination.target);
    const finalMetadata = await fileSystem.stat(destination.target);
    return {
      fromPath: from,
      toPath: to,
      size: finalMetadata.size,
      modifiedAt: finalMetadata.mtime.toISOString(),
    };
  }

  return { readCatalog, publishCatalog, writeExplorerTaskFile, deleteExplorerTaskFile, moveExplorerTaskFile };

  async function publishBytes(
    parent: string,
    target: string,
    bytes: Buffer,
    hooks: WorkspaceTasksWorkspaceFilePublicationHooks = {},
  ): Promise<void> {
    const temporary = join(parent, `.${basename(target)}.${randomUUID()}.tmp`);
    let temporaryCreated = true;
    try {
      await fileSystem.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      hooks.onPublicationAttempt?.();
      await fileSystem.rename(temporary, target);
      temporaryCreated = false;
      hooks.onPublished?.();
    } finally {
      if (temporaryCreated) {
        try {
          await fileSystem.unlink(temporary);
        } catch {
          // The publication error is authoritative; cleanup is best effort.
        }
      }
    }
  }

  async function resolveExplorerEntry(
    root: string,
    relativePath: string,
    createParent: boolean,
  ): Promise<{ target: string; final: Stats | undefined }> {
    const requested = normalizeRelativePath(relativePath);
    const targetPath = join(root, requested);
    ensureInside(root, targetPath);
    const parent = await resolveSafeDirectory(root, dirname(targetPath), createParent);
    const target = join(parent, basename(targetPath));
    return { target, final: await inspectFinalEntry(target) };
  }

  async function resolveSafeDirectory(root: string, directory: string, createMissing: boolean): Promise<string> {
    const relativeDirectory = normalizeRelativePath(relative(root, directory));
    let current = root;
    for (const part of relativeDirectory === "" ? [] : relativeDirectory.split("/")) {
      const next = join(current, part);
      let metadata: Stats | undefined;
      try {
        metadata = await fileSystem.lstat(next);
      } catch (error) {
        if (!isNodeErrorWithCode(error, "ENOENT") || !createMissing) throw error;
        await fileSystem.mkdir(next, { recursive: false });
        metadata = await fileSystem.lstat(next);
      }
      if (metadata.isSymbolicLink()) throw new Error("Workspace task parent must not be a symbolic link");
      if (!metadata.isDirectory()) throw new Error("Workspace task parent must be a directory");
      const canonical = await fileSystem.realpath(next);
      ensureInside(root, canonical);
      current = canonical;
    }
    return current;
  }

  async function inspectFinalEntry(path: string): Promise<Stats | undefined> {
    try {
      return await fileSystem.lstat(path);
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }
}

function revisionForMissing(): string {
  const hash = createHash("sha256");
  hash.update("workspace-task-file:missing\0", "utf8");
  return hash.digest("hex");
}

function revisionForBytes(bytes: Buffer): string {
  const hash = createHash("sha256");
  hash.update("workspace-task-file:present\0", "utf8");
  hash.update(bytes);
  return hash.digest("hex");
}

function isTaskPath(path: string): boolean {
  return isWorkspaceTasksPath(path);
}

export function normalizeWorkspaceTasksPath(path: string | undefined): string {
  return normalizeRelativePath(path);
}

export function isWorkspaceTasksPath(path: string | undefined): boolean {
  return normalizeWorkspaceTasksPath(path) === TASKS_CONFIG_PATH;
}
