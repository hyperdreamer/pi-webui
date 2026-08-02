/**
 * Filesystem side of installing the opt-in skills.
 *
 * Every boundary is injected so the plan can be exercised without touching a
 * real home directory. `installOptionalSkills` performs no I/O of its own beyond
 * the injected operations, and reports what it did so the CLI can print a
 * restore path.
 */

import {
  OPTIONAL_SKILLS,
  pruneSkillLock,
  rewriteSkillNames,
} from "./optionalSkillInstall.js";
import type {
  OptionalSkillSpec,
  SkillLockDocument,
} from "./optionalSkillInstall.js";

/** Files whose bytes are rewritten during install. Anything else is copied verbatim. */
const REWRITABLE_EXTENSIONS = Object.freeze([".md", ".mjs", ".json"]);

/**
 * Helper scripts the controller composes with but deliberately does not reimplement.
 *
 * `plan-contract.md` names `task-brief` and `review-package` as the writers of
 * task briefs and review packages. They ship with the upstream skill, so replacing
 * that skill without carrying them forward leaves the controller unable to produce
 * those artifacts.
 */
export const INHERITED_SCRIPTS = Object.freeze([
  "sdd-workspace",
  "task-brief",
  "review-package",
]);

/**
 * Directories that exist only to develop the skills, never to run them.
 *
 * The published tarball already excludes these, but installing from a repository
 * checkout would otherwise copy them into the user's skill directory, where they
 * are dead weight and misleading.
 */
const DEVELOPMENT_DIRECTORIES = Object.freeze(["evals/", "tests/"]);

function isDevelopmentOnly(relativePath: string): boolean {
  return DEVELOPMENT_DIRECTORIES.some((dir) => relativePath.startsWith(dir));
}

export interface InstallerIo {
  readonly exists: (path: string) => boolean;
  readonly listFiles: (dir: string) => readonly string[];
  readonly readFile: (path: string) => string;
  readonly writeFile: (path: string, content: string) => void;
  readonly copyFile: (from: string, to: string) => void;
  readonly makeDir: (path: string) => void;
  readonly movePath: (from: string, to: string) => void;
  readonly removePath: (path: string) => void;
  readonly regenerateManifest: (skillDir: string) => void;
}

export interface InstallRequest {
  readonly sourceRoot: string;
  readonly skillsRoot: string;
  readonly backupRoot: string;
  readonly lockPath: string;
  readonly skills?: readonly OptionalSkillSpec[];
  readonly dryRun?: boolean;
}

export interface InstallReport {
  readonly backupRoot: string;
  readonly installed: readonly string[];
  readonly backedUp: readonly string[];
  readonly lockEntriesRemoved: readonly string[];
  readonly dryRun: boolean;
}

function joinPath(...parts: readonly string[]): string {
  return parts.join("/");
}

function isRewritable(relativePath: string): boolean {
  return REWRITABLE_EXTENSIONS.some((extension) =>
    relativePath.endsWith(extension)
  );
}

/**
 * Backs up, replaces, and rewrites the opt-in skills, then prunes stale lock entries.
 *
 * Ordering matters: the backup completes before anything is removed, so a failure
 * mid-install leaves a recoverable copy. The manifest is regenerated last, after
 * the rewrite, because the skill name lives inside hashed runtime files.
 */
export function installOptionalSkills(
  io: InstallerIo,
  request: InstallRequest
): InstallReport {
  const skills = request.skills ?? OPTIONAL_SKILLS;
  const dryRun = request.dryRun ?? false;
  const backedUp: string[] = [];
  const installed: string[] = [];

  for (const skill of skills) {
    const sourceDir = joinPath(request.sourceRoot, skill.sourceName);
    if (!io.exists(sourceDir)) {
      throw new Error(
        `optional skill source is missing: ${sourceDir}. This build does not ship optional skills.`
      );
    }
  }

  if (!dryRun) io.makeDir(request.backupRoot);

  for (const skill of skills) {
    const target = joinPath(request.skillsRoot, skill.installName);
    if (!io.exists(target)) continue;
    backedUp.push(skill.installName);
    if (dryRun) continue;
    io.movePath(target, joinPath(request.backupRoot, skill.installName));
  }

  if (io.exists(request.lockPath)) {
    if (!dryRun)
      io.copyFile(
        request.lockPath,
        joinPath(request.backupRoot, "skill-lock.json")
      );
    backedUp.push("skill-lock.json");
  }

  for (const skill of skills) {
    const sourceDir = joinPath(request.sourceRoot, skill.sourceName);
    const targetDir = joinPath(request.skillsRoot, skill.installName);
    installed.push(skill.installName);
    if (dryRun) continue;

    for (const relativePath of io.listFiles(sourceDir)) {
      if (isDevelopmentOnly(relativePath)) continue;
      const from = joinPath(sourceDir, relativePath);
      const to = joinPath(targetDir, relativePath);
      const parent = to.slice(0, to.lastIndexOf("/"));
      io.makeDir(parent);
      // Rewrite against every known skill, not just the ones being installed: the
      // authoring skill cites the controller's directory as a sibling path, so a
      // partial install must still produce a resolvable reference.
      if (isRewritable(relativePath))
        io.writeFile(to, rewriteSkillNames(io.readFile(from)));
      else io.copyFile(from, to);
    }

    carryInheritedScripts(
      io,
      joinPath(request.backupRoot, skill.installName),
      targetDir
    );
    io.regenerateManifest(targetDir);
  }

  const lockEntriesRemoved = pruneLock(io, request, skills, dryRun);

  return {
    backupRoot: request.backupRoot,
    installed,
    backedUp,
    lockEntriesRemoved,
    dryRun,
  };
}

/**
 * Copies inherited helper scripts from the backed-up skill into the new install.
 *
 * Silent when the previous skill did not have them: a fresh install alongside no
 * upstream skill is legitimate, and the controller only needs them once a run
 * reaches the brief or review stage.
 */
function carryInheritedScripts(
  io: InstallerIo,
  backupDir: string,
  targetDir: string
): void {
  for (const script of INHERITED_SCRIPTS) {
    const from = joinPath(backupDir, "scripts", script);
    if (!io.exists(from)) continue;
    io.copyFile(from, joinPath(targetDir, "scripts", script));
  }
}

/** Narrows parsed JSON to the lock document shape without a type assertion. */
function isLockDocument(value: unknown): value is SkillLockDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pruneLock(
  io: InstallerIo,
  request: InstallRequest,
  skills: readonly OptionalSkillSpec[],
  dryRun: boolean
): readonly string[] {
  if (!io.exists(request.lockPath)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(io.readFile(request.lockPath));
  } catch {
    throw new Error(`skill lock file is not valid JSON: ${request.lockPath}`);
  }
  if (!isLockDocument(parsed)) {
    throw new Error(`skill lock file is not an object: ${request.lockPath}`);
  }
  const document = parsed;

  const { document: pruned, removed } = pruneSkillLock(document, skills);
  if (removed.length > 0 && !dryRun) {
    io.writeFile(request.lockPath, `${JSON.stringify(pruned, null, 2)}\n`);
  }
  return removed;
}
