import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Hermes project identity resolution, ported from pi-hermes-memory's
 * `src/project.ts` project detection. Every linked worktree resolves to the
 * shared repository root's basename so worktree memory is not stranded under
 * the worktree directory name (upstream issue #120). Future upstream changes
 * to project detection should be repaired at this adapter boundary.
 */

export type PiHermesPathKind = "directory" | "file" | "missing";

export interface PiHermesProjectIdentityAccess {
  pathKind(path: string): Promise<PiHermesPathKind>;
  readFile(path: string): Promise<string>;
}

export interface PiHermesProjectIdentityInput {
  agentDir: string;
  projectPath: string;
  homeDir?: string;
}

export type PiHermesProjectNameResolver = (projectPath: string) => Promise<string | undefined>;

const nodeProjectIdentityAccess: PiHermesProjectIdentityAccess = {
  pathKind: async (path) => {
    try {
      const info = await stat(path);
      if (info.isDirectory()) return "directory";
      if (info.isFile()) return "file";
      return "missing";
    } catch (error) {
      if (isEnoentOrEnotdir(error)) return "missing";
      throw error;
    }
  },
  readFile: (path) => readFile(path, "utf-8"),
};

export async function resolvePiHermesProjectName(
  input: PiHermesProjectIdentityInput,
  access: PiHermesProjectIdentityAccess = nodeProjectIdentityAccess,
): Promise<string | undefined> {
  const rawBasename = basename(input.projectPath);
  if (!rawBasename || rawBasename === "." || rawBasename === "..") return undefined;

  const resolved = resolve(input.projectPath);
  const resolvedHome = resolve(input.homeDir ?? homedir());
  if (resolved === resolvedHome || resolved === "/" || resolved === resolvedHome + "/") return undefined;

  const cwdName = basename(resolved);
  if (!cwdName || cwdName === "." || cwdName === "..") return undefined;

  const repoRoot = await findGitRepoRoot(resolved, access);
  if (repoRoot === null || repoRoot === resolved || repoRoot === resolvedHome) return cwdName;

  const repoName = basename(repoRoot);
  if (!repoName || repoName === cwdName) return cwdName;

  const projectsRoot = join(input.agentDir, "projects-memory");
  const [repoStore, cwdStore] = await Promise.all([
    access.pathKind(join(projectsRoot, repoName)),
    access.pathKind(join(projectsRoot, cwdName)),
  ]);

  // Migration bridge: a store already written under the old cwd-basename
  // identity keeps working. Only fresh directories adopt the repository name.
  if (repoStore === "missing" && cwdStore !== "missing") return cwdName;

  return repoName;
}

async function findGitRepoRoot(projectPath: string, access: PiHermesProjectIdentityAccess): Promise<string | null> {
  let current = resolve(projectPath);

  for (;;) {
    const dotGit = join(current, ".git");
    const kind = await access.pathKind(dotGit);

    if (kind === "directory") return current;

    if (kind === "file") {
      const commonDir = await resolveWorktreeCommonDir(current, dotGit, access);
      if (commonDir === null) return current;
      return basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
    }

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function resolveWorktreeCommonDir(
  worktreeRoot: string,
  dotGitFile: string,
  access: PiHermesProjectIdentityAccess,
): Promise<string | null> {
  let pointer: string;
  try {
    pointer = await access.readFile(dotGitFile);
  } catch (error) {
    if (isEnoentOrEnotdir(error)) return null;
    throw error;
  }

  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!match) return null;

  const gitDir = resolve(worktreeRoot, match[1] ?? "");
  try {
    const commonDir = (await access.readFile(join(gitDir, "commondir"))).trim();
    if (commonDir) return resolve(gitDir, commonDir);
  } catch (error) {
    if (!isEnoentOrEnotdir(error)) throw error;
    // Not a linked worktree, or an older layout without `commondir`.
  }

  // `<main>/.git/worktrees/<name>` — two levels up is the shared git dir.
  const parent = dirname(gitDir);
  return basename(parent) === "worktrees" ? dirname(parent) : null;
}

function isEnoentOrEnotdir(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
