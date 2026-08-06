import { chmod, lstat, mkdir, readFile, readlink, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { piWebUiDataDir } from "../../config.js";
import { randomUUID } from "node:crypto";
import type { Project } from "../types.js";

interface ProjectFile {
  projects: Project[];
}

interface ResolvedWriteTarget {
  path: string;
  mode?: number;
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
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
  return { projects: value["projects"].map(parseProject) };
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

export class ProjectStore {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = projectStorePath()) {}

  async list(): Promise<Project[]> {
    return (await this.read()).projects;
  }

  async add(input: { name?: string; path: string }): Promise<Project> {
    return await this.exclusive(async () => {
      const data = await this.read();
      const path = input.path;
      const existing = data.projects.find((p) => p.path === path);
      if (existing) return existing;

      const trimmedName = input.name?.trim();
      const leafName = path.split("/").filter((part) => part !== "").at(-1);
      const project: Project = {
        id: randomUUID(),
        name: trimmedName !== undefined && trimmedName !== "" ? trimmedName : leafName ?? path,
        path,
        createdAt: new Date().toISOString(),
      };
      data.projects.push(project);
      await this.write(data);
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
      await this.write({ projects });
      return true;
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
      await this.write({ projects });
      return projects;
    });
  }

  private async read(): Promise<ProjectFile> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return parseProjectFile(value);
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) return { projects: [] };
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
    try {
      const content = `${JSON.stringify(data, null, 2)}\n`;
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
