import { isAbsolute, resolve } from "node:path";

/**
 * Working-directory normalization boundaries.
 *
 * Cwd strings reach the server from three kinds of sources with different trust:
 *
 * 1. HTTP requests (web UI, federation proxies): normalize strictly with
 *    `normalizeRequestCwd` at route parsing. Relative paths are rejected instead
 *    of being silently resolved against the daemon's own working directory.
 * 2. Data pi-webui writes itself (archive store records): canonicalized on write
 *    and on load with `canonicalizeStoredCwd`, so internal `===` comparisons are
 *    safe by construction.
 * 3. Data other writers own (Pi session file headers via the SDK): canonicalized
 *    on read at the gateway, and compared tolerantly with `cwdPathsEqual` where a
 *    raw value can still appear (e.g. runtime cwd of sessions opened from files).
 *
 * Inside these boundaries, plain string equality on cwd values is safe.
 */

/**
 * Strictly normalize a client-supplied working directory at an HTTP boundary.
 * Throws for non-string, empty, or relative input; returns the resolved
 * (separator- and trailing-slash-normalized) absolute path otherwise.
 */
export function normalizeRequestCwd(cwd: unknown): string {
  if (typeof cwd !== "string" || cwd === "") throw new Error("cwd is required");
  if (!isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
  return resolve(cwd);
}

/**
 * Leniently canonicalize a working directory loaded from stored data.
 * Absolute paths are resolved to canonical form; anything else (legacy empty or
 * relative values) is preserved as-is so a single bad record cannot fail a whole
 * load, and never silently resolves against this process's working directory.
 */
export function canonicalizeStoredCwd(cwd: string): string {
  return isAbsolute(cwd) ? resolve(cwd) : cwd;
}

/** Compare two working-directory paths, tolerating separator and normalization differences (e.g. Windows backslash vs forward slash). */
export function cwdPathsEqual(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}
