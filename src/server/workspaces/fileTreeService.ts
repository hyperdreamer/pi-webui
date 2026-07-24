import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";
import type { FileTreeEntry, FileTreeResponse, PiWebUiPathAccessConfig } from "../../shared/apiTypes.js";
import { resolveWorkspacePathAccessTarget } from "./pathAccessPolicy.js";

const MAX_ENTRIES = 1000;

export async function listWorkspaceTree(rootPath: string, path: string | undefined, pathAccess?: PiWebUiPathAccessConfig): Promise<FileTreeResponse> {
  const { target, displayPath } = await resolveWorkspacePathAccessTarget(rootPath, path, pathAccess);
  const stat = await lstat(target);
  if (!stat.isDirectory()) throw new Error("Path is not a directory");

  const dirents = await readdir(target, { withFileTypes: true });
  const sorted = dirents.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const selected = sorted.slice(0, MAX_ENTRIES);
  const entries = await Promise.all(selected.map(async (entry): Promise<FileTreeEntry> => {
    const absolute = join(target, entry.name);
    const childPath = appendRequestPath(displayPath, entry.name);
    const childStat = await lstat(absolute);
    const type: FileTreeEntry["type"] = entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file";
    return { name: entry.name, path: childPath, type, size: childStat.size, modifiedAt: childStat.mtime.toISOString() };
  }));

  return { path: displayPath, entries, scannedAt: new Date().toISOString(), truncated: sorted.length > selected.length };
}

function appendRequestPath(base: string, name: string): string {
  if (base === "") return name;
  if (isAbsolute(base) || win32.isAbsolute(base)) return join(base, name);
  if (base.endsWith("/") || base.endsWith("\\")) return `${base}${name}`;
  return `${base}/${name}`;
}
