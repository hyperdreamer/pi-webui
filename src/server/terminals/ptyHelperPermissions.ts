import { accessSync, closeSync, constants, fchmodSync, fstatSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";

const require = createRequire(import.meta.url);

/** node-pty must already be loaded: use its loaded addon, not a guessed prebuild. */
export function ensurePtyHelperExecutable(): void {
  if (process.platform !== "darwin") return;
  const packageRoot = dirname(require.resolve("node-pty/package.json"));
  const addons = Object.keys(require.cache).filter((path) => path.startsWith(`${packageRoot}${sep}`) && path.endsWith(`${sep}pty.node`));
  // Do not guess a path if a future node-pty version changes its loading layout.
  const addon = addons[0];
  if (addons.length !== 1 || addon === undefined) return;
  repairPtyHelperPermissions(join(dirname(addon), "spawn-helper"));
}

export function repairPtyHelperPermissions(helperPath: string): void {
  try {
    accessSync(helperPath, constants.X_OK);
    return;
  } catch {
    // Some node-pty macOS prebuilds ship spawn-helper as 0644. Repair only this
    // file, without following a symlink or broadening group/other permissions.
  }
  let fd: number | undefined;
  try {
    // A malformed FIFO must reach the type check instead of blocking sessiond.
    fd = openSync(helperPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("spawn-helper is not a regular file");
    if ((stat.mode & 0o7000) !== 0) throw new Error("spawn-helper has unexpected special permission bits");
    fchmodSync(fd, (stat.mode & 0o777) | 0o100);
    accessSync(helperPath, constants.X_OK);
  } catch (cause) {
    throw new Error(`Cannot make node-pty spawn-helper executable at ${helperPath}. Repair its execute permission as the installation owner or reinstall node-pty.`, { cause });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
