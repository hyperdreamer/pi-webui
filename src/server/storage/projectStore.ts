import { chmod, lstat, mkdir, readFile, readlink, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { piWebUiDataDir } from "../../config.js";
import { randomUUID } from "node:crypto";
import { projectDescendantIds } from "../../shared/projectAncestry.js";
import { RECENT_PROJECT_LIMIT, type RecentProjectEntry } from "../../shared/apiTypes.js";
import type { Project } from "../types.js";

interface ProjectFile {
  projects: Project[];
  /** Parsed history, empty when the stored value was absent or malformed. */
  recentProjects: RecentProjectEntry[];
  /**
   * The raw stored history when it could not be parsed. Preserved verbatim on
   * every write so a parser defect cannot destroy a user's history, and used to
   * fail `listRecent` loudly instead of reporting an empty list.
   */
  invalidRecentProjects?: unknown;
}

interface ResolvedWriteTarget {
  path: string;
  mode?: number;
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * A trailing separator marks a directory reference, never a file leaf.
 * `sep` gives the native separator; `/` is additionally accepted on every
 * platform so Windows-target paths behave like POSIX ones, while backslash
 * stays a plain filename character on POSIX.
 */
function hasTerminalPathSeparator(candidate: string): boolean {
  return candidate.endsWith(sep) || candidate.endsWith("/");
}

async function resolveWriteTarget(filePath: string): Promise<ResolvedWriteTarget> {
  try {
    const effectivePath = await realpath(filePath);
    const metadata = await stat(effectivePath);
    return {
      path: effectivePath,
      ...(process.platform === "win32" ? {} : { mode: metadata.mode & 0o777 }),
    };
  } catch (error: unknown) {
    if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
    return await resolveMissingWriteTarget(filePath);
  }
}

async function resolveMissingWriteTarget(filePath: string): Promise<ResolvedWriteTarget> {
  let candidate = filePath;
  const visited = new Set<string>();

  for (;;) {
    let metadata;
    try {
      metadata = await lstat(candidate);
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        if (hasTerminalPathSeparator(candidate)) {
          const directoryTarget: NodeJS.ErrnoException = Object.assign(new Error(`Project registry path must resolve to a file: ${filePath}`), {
            code: "EISDIR",
            syscall: "open",
            path: filePath,
          });
          throw directoryTarget;
        }
        const physicalParent = await realpath(dirname(candidate));
        return { path: join(physicalParent, basename(candidate)) };
      }
      throw error;
    }

    if (!metadata.isSymbolicLink()) {
      return {
        path: await realpath(candidate),
        ...(process.platform === "win32" ? {} : { mode: metadata.mode & 0o777 }),
      };
    }

    const physicalParent = await realpath(dirname(candidate));
    const physicalCandidate = join(physicalParent, basename(candidate));
    if (visited.has(physicalCandidate)) throw new Error("Cannot resolve project registry path because of a symbolic-link cycle");
    visited.add(physicalCandidate);

    const target = await readlink(physicalCandidate);
    // Preserve component order until the filesystem has traversed any symlink
    // before `..`; path.join/resolve would collapse those components too soon.
    candidate = isAbsolute(target) ? target : `${physicalParent}${physicalParent.endsWith(sep) ? "" : sep}${target}`;
  }
}

function parseProjectFile(value: unknown): ProjectFile {
  if (!isRecord(value) || !Array.isArray(value["projects"])) throw new Error("Invalid project file");
  // Registered projects are parsed independently of history so a corrupt
  // optional history can never fail or hide a registry read.
  const projects = value["projects"].map(parseProject);
  const storedRecent = value["recentProjects"];
  if (storedRecent === undefined) return { projects, recentProjects: [] };
  try {
    return { projects, recentProjects: parseRecentProjects(storedRecent) };
  } catch {
    return { projects, recentProjects: [], invalidRecentProjects: storedRecent };
  }
}

function parseRecentProjects(value: unknown): RecentProjectEntry[] {
  if (!Array.isArray(value)) throw new Error("Invalid recent projects");
  if (value.length > RECENT_PROJECT_LIMIT) throw new Error("Recent project history exceeds its limit");
  const entries = value.map((entry) => {
    if (!isRecord(entry)) throw new Error("Invalid recent project");
    const id = entry["id"];
    const name = entry["name"];
    const path = entry["path"];
    const lastUsedAt = entry["lastUsedAt"];
    if (typeof id !== "string" || typeof name !== "string" || typeof path !== "string" || typeof lastUsedAt !== "string") throw new Error("Invalid recent project");
    const lastUsedDate = new Date(lastUsedAt);
    if (!Number.isFinite(lastUsedDate.getTime()) || lastUsedDate.toISOString() !== lastUsedAt) throw new Error("Invalid recent project timestamp");
    return { id, name, path, lastUsedAt };
  });
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error("Duplicate recent project id");
    if (paths.has(entry.path)) throw new Error("Duplicate recent project path");
    ids.add(entry.id);
    paths.add(entry.path);
  }
  return entries;
}

function parseProject(value: unknown): Project {
  if (!isRecord(value)) throw new Error("Invalid project");
  const id = value["id"];
  const name = value["name"];
  const path = value["path"];
  const createdAt = value["createdAt"];
  const pinned = value["pinned"];
  if (typeof id !== "string" || typeof name !== "string" || typeof path !== "string" || typeof createdAt !== "string") throw new Error("Invalid project");
  if (pinned !== undefined && typeof pinned !== "boolean") throw new Error("Invalid project");
  return { id, name, path, createdAt, ...(pinned === true ? { pinned: true } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function defaultProjectStorePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return join(piWebUiDataDir(env, cwd), "projects.json");
}

export function projectStorePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const configured = env["PI_WEBUI_PROJECTS_FILE"];
  if (configured === undefined || configured === "") return defaultProjectStorePath(env, cwd);
  return resolve(cwd, configured);
}

export type RecentRemoval =
  | { kind: "removed"; entries: RecentProjectEntry[] }
  | { kind: "not-found" };

export class ProjectStore {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = projectStorePath(), private readonly now: () => Date = () => new Date()) {}

  async list(): Promise<Project[]> {
    return (await this.read()).projects;
  }

  async listRecent(): Promise<RecentProjectEntry[]> {
    const data = await this.read();
    if (data.invalidRecentProjects !== undefined) throw new Error("Stored recent projects are malformed");
    return data.recentProjects;
  }

  /**
   * Record meaningful work on a registered project. Path identity comes from the
   * registry itself, so history can never disagree with registration dedupe.
   */
  async touchRecent(projectId: string): Promise<RecentProjectEntry[] | undefined> {
    return await this.exclusive(async () => {
      const data = await this.read();
      if (data.invalidRecentProjects !== undefined) throw new Error("Stored recent projects are malformed");
      const project = data.projects.find((candidate) => candidate.id === projectId);
      if (project === undefined) return undefined;
      const recentProjects = this.promote(data.recentProjects, project);
      await this.write({ ...data, recentProjects });
      return recentProjects;
    });
  }

  async removeRecent(entryId: string): Promise<RecentRemoval> {
    return await this.exclusive(async () => {
      const data = await this.read();
      if (data.invalidRecentProjects !== undefined) throw new Error("Stored recent projects are malformed");
      const target = data.recentProjects.find((entry) => entry.id === entryId);
      if (target === undefined) return { kind: "not-found" };
      const recentProjects = data.recentProjects.filter((entry) => entry.id !== entryId);
      await this.write({ ...data, recentProjects });
      return { kind: "removed", entries: recentProjects };
    });
  }

  /** Move `project` to the front of history, reusing any entry for the same registry path. */
  private promote(entries: readonly RecentProjectEntry[], project: Project): RecentProjectEntry[] {
    const existing = entries.find((entry) => entry.path === project.path);
    const promoted: RecentProjectEntry = {
      id: existing?.id ?? randomUUID(),
      name: project.name,
      path: project.path,
      lastUsedAt: this.now().toISOString(),
    };
    return [promoted, ...entries.filter((entry) => entry.path !== project.path)].slice(0, RECENT_PROJECT_LIMIT);
  }

  async add(input: { name?: string; path: string }): Promise<Project> {
    return await this.exclusive(async () => {
      const data = await this.read();
      const path = input.path;
      const existing = data.projects.find((p) => p.path === path);
      if (existing) {
        await this.write({ ...data, recentProjects: this.promote(data.recentProjects, existing) });
        return existing;
      }

      const trimmedName = input.name?.trim();
      const leafName = path.split("/").filter((part) => part !== "").at(-1);
      const project: Project = {
        id: randomUUID(),
        name: trimmedName !== undefined && trimmedName !== "" ? trimmedName : leafName ?? path,
        path,
        createdAt: this.now().toISOString(),
      };
      data.projects.push(project);
      await this.write({ ...data, recentProjects: this.promote(data.recentProjects, project) });
      return project;
    });
  }

  async get(id: string): Promise<Project | undefined> {
    return (await this.list()).find((p) => p.id === id);
  }

  async remove(id: string): Promise<boolean> {
    return await this.exclusive(async () => {
      const data = await this.read();
      const projects = data.projects.filter((p) => p.id !== id);
      if (projects.length === data.projects.length) return false;
      await this.write({ ...data, projects });
      return true;
    });
  }

  /**
   * Remove a project together with every registered descendant in a single
   * write. The snapshot is read, the removal set computed, and the result
   * written inside one exclusive turn, so a concurrent add or pin cannot make
   * the removal set stale or lose an update.
   */
  async removeTree(id: string): Promise<string[] | undefined> {
    return await this.exclusive(async () => {
      const data = await this.read();
      if (!data.projects.some((project) => project.id === id)) return undefined;
      const removedIds = [id, ...projectDescendantIds(data.projects, id)];
      const removedIdSet = new Set(removedIds);
      await this.write({ ...data, projects: data.projects.filter((project) => !removedIdSet.has(project.id)) });
      return removedIds;
    });
  }

  /**
   * Set pin state and move the project to the front of the list in one write.
   * Front-of-array placement is what makes a pinned or unpinned project appear
   * at the top of its display group, so ordering needs no separate order field.
   */
  async setPinned(id: string, pinned: boolean): Promise<Project[] | undefined> {
    return await this.exclusive(async () => {
      const data = await this.read();
      const target = data.projects.find((p) => p.id === id);
      if (target === undefined) return undefined;
      const updated: Project = {
        id: target.id,
        name: target.name,
        path: target.path,
        createdAt: target.createdAt,
        ...(pinned ? { pinned: true } : {}),
      };
      const projects = [updated, ...data.projects.filter((p) => p.id !== id)];
      await this.write({ ...data, projects });
      return projects;
    });
  }

  private async read(): Promise<ProjectFile> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return parseProjectFile(value);
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) return { projects: [], recentProjects: [] };
      throw error;
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release = (): void => undefined;
    this.operationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async write(data: ProjectFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const target = await resolveWriteTarget(this.filePath);
    // Keep the temp file beside the effective target so rename is atomic even
    // when the configured path is a symlink. The `exclusive` queue remains
    // necessary because it prevents lost updates rather than torn files.
    const tempPath = join(dirname(target.path), `.${basename(target.path)}.${String(process.pid)}.${Date.now().toString()}.${randomUUID()}.tmp`);
    // A quarantined history is written back verbatim: a parser defect must never
    // silently replace a user's history with an empty list.
    const recentProjects = data.invalidRecentProjects !== undefined
      ? data.invalidRecentProjects
      : data.recentProjects;
    const document = data.invalidRecentProjects === undefined && data.recentProjects.length === 0
      ? { projects: data.projects }
      : { projects: data.projects, recentProjects };
    try {
      const content = `${JSON.stringify(document, null, 2)}\n`;
      if (target.mode === undefined) {
        await writeFile(tempPath, content, "utf8");
      } else {
        await writeFile(tempPath, content, { encoding: "utf8", mode: target.mode });
        await chmod(tempPath, target.mode);
      }
      await rename(tempPath, target.path);
    } catch (error: unknown) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
}
