import { constants, type ReadStream, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { PiWebUiPathAccessConfig } from "../../shared/apiTypes.js";
import { fileViewKindForPath, MAX_FILE_VIEW_BYTES, type FileViewKind } from "../../shared/fileViewTypes.js";
import { imageMimeTypeForPath } from "./imagePreviewService.js";
import { PathAccessRootError, PathAccessTargetNotFoundError, resolveWorkspacePathAccessTarget } from "./pathAccessPolicy.js";

/**
 * Pre-stream failure contract for the file-view service. `status` and
 * `message` are what the HTTP boundary sends as a plain-text page; unexpected
 * infrastructure errors stay ordinary errors for the route's generic 500.
 */
export class FileViewError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 413 | 415, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FileViewError";
  }
}

export interface WorkspaceFileView {
  /** Policy display path, not the canonical target. */
  path: string;
  kind: FileViewKind;
  mediaType: string;
  /** fstat byte count, also the stream's exact expected count. */
  size: number;
  /** fstat.mtime.toISOString(). */
  modifiedAt: string;
  stream: ReadStream;
}

export type WorkspaceFileViewOpener = (
  rootPath: string,
  path: string | undefined,
  pathAccess?: PiWebUiPathAccessConfig,
) => Promise<WorkspaceFileView>;

export type FileViewStat = Pick<Stats, "dev" | "ino" | "size" | "mtime" | "isFile">;
export type FileViewLstat = FileViewStat & Pick<Stats, "isSymbolicLink">;

export interface FileViewHandle {
  readonly fd: number;
  stat(): Promise<FileViewStat>;
  createReadStream(options: { start: number; end: number; autoClose: true }): ReadStream;
  close(): Promise<void>;
}

export interface FileViewDependencies {
  platform: NodeJS.Platform;
  authorize: typeof resolveWorkspacePathAccessTarget;
  open(path: string, flags: number): Promise<FileViewHandle>;
  lstat(path: string): Promise<FileViewLstat>;
  realpath(path: string): Promise<string>;
}

const DENIED = "PI WEBUI is not allowed to read this path. Add its root under Settings → General → External path access.";
const UNSUPPORTED = "This file type cannot be previewed in PI WEBUI.";

function errno(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function forbidden(error?: unknown): FileViewError {
  return new FileViewError(403, DENIED, error === undefined ? undefined : { cause: error });
}

function unsupported(error?: unknown): FileViewError {
  return new FileViewError(415, UNSUPPORTED, error === undefined ? undefined : { cause: error });
}

function mapOpenError(error: unknown, path: string): never {
  const code = errno(error);
  if (code === "ENOENT" || code === "ENOTDIR") throw new FileViewError(404, `File not found: ${path}`, { cause: error });
  if (code === "ENXIO" || code === "EOPNOTSUPP") throw unsupported(error);
  if (code === "ELOOP" || code === "EACCES" || code === "EPERM") throw forbidden(error);
  throw error;
}

const DENIAL_MESSAGES = ["Absolute paths are not allowed", "Path traversal is not allowed", "Path escapes workspace", "Path is outside allowed paths"];

function mapAuthorizationError(error: unknown, path: string): never {
  // Root-stage failures take precedence: they are infrastructure errors even
  // when the same errno would mean a target denial one stage later.
  if (error instanceof PathAccessRootError) throw error;
  if (error instanceof PathAccessTargetNotFoundError) throw new FileViewError(404, `File not found: ${path}`, { cause: error });
  const message = error instanceof Error ? error.message : "";
  const code = errno(error) ?? "";
  if (
    DENIAL_MESSAGES.includes(message)
    || message.startsWith("Absolute path is not valid on this host:")
    || message.startsWith("Path is not absolute:")
    || code === "EACCES"
    || code === "EPERM"
    || code === "ELOOP"
  ) {
    throw forbidden(error);
  }
  throw error;
}

function identityMatches(before: FileViewLstat, after: FileViewStat): boolean {
  const devs = [before.dev, after.dev];
  const inos = [before.ino, after.ino];
  return devs.every((value) => Number.isSafeInteger(value) && value >= 0)
    && inos.every((value) => Number.isSafeInteger(value) && value > 0)
    && before.dev === after.dev
    && before.ino === after.ino;
}

function mediaType(path: string, kind: FileViewKind): string {
  if (kind === "document") return /\.svg$/iu.test(path) ? "image/svg+xml" : "text/html; charset=utf-8";
  if (kind === "pdf") return "application/pdf";
  if (kind === "text") return "text/plain; charset=utf-8";
  const mime = imageMimeTypeForPath(path);
  if (mime === undefined) throw unsupported();
  return mime;
}

/**
 * Release every resource the opener still owns before the view is handed over.
 * A constructed stream owns its handle through auto-close, so it is destroyed
 * and observed instead of closing the handle underneath a live stream.
 */
async function releaseOwnedResources(handle: FileViewHandle, constructed: ReadStream | undefined): Promise<void> {
  if (constructed === undefined) {
    await handle.close();
    return;
  }
  if (constructed.closed) return;
  const observed = new Promise<void>((resolve) => {
    // Observe late stream errors so cleanup cannot create an unhandled event;
    // close still settles the wait.
    constructed.once("error", () => undefined);
    constructed.once("close", () => { resolve(); });
  });
  constructed.destroy();
  await observed;
}

export function createWorkspaceFileViewOpener(overrides: Partial<FileViewDependencies> = {}): WorkspaceFileViewOpener {
  const deps: FileViewDependencies = { platform: process.platform, authorize: resolveWorkspacePathAccessTarget, open, lstat, realpath, ...overrides };
  return async (rootPath, path, pathAccess) => {
    if (path === undefined || path === "") throw new FileViewError(400, "path query parameter is required");
    if (path.includes("\0")) throw new FileViewError(400, "path query parameter must not contain NUL bytes");

    const target = await deps.authorize(rootPath, path, pathAccess).catch((error: unknown) => mapAuthorizationError(error, path));

    let before: FileViewLstat | undefined;
    if (deps.platform === "win32") {
      before = await deps.lstat(target.target).catch((error: unknown) => mapOpenError(error, path));
      if (before.isSymbolicLink()) throw forbidden();
      if (!before.isFile()) throw unsupported();
    }

    const flags = deps.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const handle = await deps.open(target.target, flags).catch((error: unknown) => mapOpenError(error, path));

    let transferred = false;
    let constructed: ReadStream | undefined;
    try {
      const measured = await handle.stat();
      if (!measured.isFile()) throw unsupported();
      if (!Number.isSafeInteger(measured.size) || measured.size < 0) throw forbidden();
      if (measured.size > MAX_FILE_VIEW_BYTES) throw new FileViewError(413, "File is too large to preview (limit 64 MB).");
      if (before !== undefined && !identityMatches(before, measured)) throw forbidden();

      if (deps.platform === "linux") {
        let openedPath: string;
        try {
          openedPath = await deps.realpath(`/proc/self/fd/${String(handle.fd)}`);
        } catch (error) {
          throw forbidden(error);
        }
        const rel = relative(target.root, openedPath);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw forbidden();
      }

      const kind = fileViewKindForPath(target.displayPath);
      if (kind === undefined) throw unsupported();
      const type = mediaType(target.displayPath, kind);
      const modifiedAt = measured.mtime.toISOString();
      constructed = handle.createReadStream({
        start: 0,
        end: measured.size === 0 ? 0 : Math.min(measured.size, MAX_FILE_VIEW_BYTES) - 1,
        autoClose: true,
      });
      if (measured.size === 0) constructed.push(null);
      const view: WorkspaceFileView = { path: target.displayPath, kind, mediaType: type, size: measured.size, modifiedAt, stream: constructed };
      transferred = true;
      return view;
    } catch (error) {
      // Ownership has not moved to the view yet: close or destroy everything
      // that is still owned. A cleanup failure is recorded as the cause rather
      // than replacing the primary rejection, and it never reports success.
      if (!transferred) {
        try {
          await releaseOwnedResources(handle, constructed);
        } catch (cleanup) {
          if (error instanceof Error) {
            Object.defineProperty(error, "cause", {
              configurable: true,
              value: new AggregateError([error.cause, cleanup].filter((value) => value !== undefined), "File-view cleanup failed"),
            });
          } else {
            throw cleanup;
          }
        }
      }
      throw error;
    }
  };
}

const defaultOpener = createWorkspaceFileViewOpener();

export async function openWorkspaceFileView(rootPath: string, path: string | undefined, pathAccess?: PiWebUiPathAccessConfig): Promise<WorkspaceFileView> {
  return defaultOpener(rootPath, path, pathAccess);
}
