import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SkillInfo, SkillInstallInfo, SkillInstallScope } from "../../shared/apiTypes.js";

interface SkillLockEntry {
  source?: unknown;
  sourceType?: unknown;
  skillPath?: unknown;
  ref?: unknown;
  skillFolderHash?: unknown;
  computedHash?: unknown;
}

interface GlobalLockPathOptions {
  homeDir?: string;
  xdgStateHome?: string | undefined;
}

export interface AnnotateSkillOptions {
  cwd: string;
  agentDir: string;
  globalLockPath?: string;
  projectLockPath?: string;
}

/** Resolve the lock location written by the `skills` CLI for global installs. */
export function getGlobalSkillsLockPath({
  homeDir = homedir(),
  xdgStateHome = process.env["XDG_STATE_HOME"],
}: GlobalLockPathOptions = {}): string {
  return xdgStateHome !== undefined && xdgStateHome !== ""
    ? join(xdgStateHome, "skills", ".skill-lock.json")
    : join(homeDir, ".agents", ".skill-lock.json");
}

function readSkillLock(path: string): Record<string, SkillLockEntry> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const skills = isRecord(parsed) ? parsed["skills"] : undefined;
    return parseSkillLockEntries(skills);
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSkillLockEntries(value: unknown): Record<string, SkillLockEntry> {
  if (!isRecord(value)) return {};

  const entries: Record<string, SkillLockEntry> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (isSkillLockEntry(entry)) entries[name] = entry;
  }
  return entries;
}

function isSkillLockEntry(value: unknown): value is SkillLockEntry {
  return isRecord(value);
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function findLockEntry(entries: Record<string, SkillLockEntry>, skillName: string): SkillLockEntry | undefined {
  if (entries[skillName] !== undefined) return entries[skillName];
  const normalizedName = skillName.toLowerCase();
  const key = Object.keys(entries).find((name) => name.toLowerCase() === normalizedName);
  return key === undefined ? undefined : entries[key];
}

function normalizeSource(source: string, sourceType?: string): string {
  if (sourceType !== "github") return source.replace(/\/$/u, "");
  return source
    .replace(/^git\+/u, "")
    .replace(/^https?:\/\/github\.com\//u, "")
    .replace(/^git@github\.com:/u, "")
    .replace(/\.git$/u, "")
    .replace(/\/$/u, "");
}

function buildSkillsShUrl(source: string, skillName: string): string | undefined {
  if (source === "" || source.includes("://") || source.startsWith("git@")) return undefined;
  const sourcePath = source
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return sourcePath === "" ? undefined : `https://skills.sh/${sourcePath}/${encodeURIComponent(skillName)}`;
}

function getInstallInfo(
  entries: Record<string, SkillLockEntry>,
  skillName: string,
  scope: SkillInstallScope,
): SkillInstallInfo | undefined {
  const entry = findLockEntry(entries, skillName);
  if (entry === undefined || typeof entry.source !== "string" || entry.source.trim() === "") return undefined;

  const sourceType = typeof entry.sourceType === "string" ? entry.sourceType : undefined;
  const source = normalizeSource(entry.source.trim(), sourceType);
  if (source === "") return undefined;

  const skillPath = typeof entry.skillPath === "string" && entry.skillPath !== "" ? entry.skillPath : undefined;
  const ref = typeof entry.ref === "string" && entry.ref !== "" ? entry.ref : undefined;
  const rawVersionHash = scope === "global" ? entry.skillFolderHash : entry.computedHash;
  const versionHash = typeof rawVersionHash === "string" && rawVersionHash !== "" ? rawVersionHash : undefined;
  const skillsShUrl = sourceType === "local" ? undefined : buildSkillsShUrl(source, skillName);
  const isGitHubSource = sourceType === "github" && /^[\w.-]+\/[\w.-]+$/u.test(source);
  const hasComparableVersion = scope === "global" || ref === undefined;

  return {
    package: `${source}@${skillName}`,
    scope,
    source,
    ...(sourceType === undefined ? {} : { sourceType }),
    ...(skillsShUrl === undefined ? {} : { skillsShUrl }),
    ...(skillPath === undefined ? {} : { skillPath }),
    ...(ref === undefined ? {} : { ref }),
    ...(versionHash === undefined ? {} : { versionHash }),
    canCheckForUpdates: isGitHubSource && skillPath !== undefined && versionHash !== undefined && hasComparableVersion,
  };
}

/**
 * Adds `skills` CLI provenance only to live skills in the global or project
 * directories the CLI owns. Manually loaded and package-provided skills remain
 * visible but deliberately have no install/update controls.
 */
export function annotateSkillsWithInstallInfo(
  skills: readonly SkillInfo[],
  {
    cwd,
    agentDir,
    globalLockPath = getGlobalSkillsLockPath(),
    projectLockPath = join(cwd, "skills-lock.json"),
  }: AnnotateSkillOptions,
): SkillInfo[] {
  const globalEntries = readSkillLock(globalLockPath);
  const projectEntries = readSkillLock(projectLockPath);
  const globalSkillsRoot = join(agentDir, "skills");
  const projectSkillsRoot = join(cwd, ".pi", "skills");

  return skills.map((skill) => {
    if (!existsSync(skill.filePath)) return skill;
    const install = isWithin(skill.filePath, globalSkillsRoot)
      ? getInstallInfo(globalEntries, skill.name, "global")
      : isWithin(skill.filePath, projectSkillsRoot)
        ? getInstallInfo(projectEntries, skill.name, "project")
        : undefined;
    return install === undefined ? skill : { ...skill, install };
  });
}
