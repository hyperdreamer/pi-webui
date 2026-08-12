import { mkdir, realpath, stat } from "node:fs/promises";
import type { RecentProjectEntry } from "../../shared/apiTypes.js";
import type { ProjectStore } from "../storage/projectStore.js";
import type { Project } from "../types.js";
import { expandUserPath } from "./directorySuggestions.js";

/** Thrown when a project id does not resolve, so routes can answer 404 without swallowing real failures. */
export class ProjectNotFoundError extends Error {
  constructor() {
    super("Project not found");
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectService {
  constructor(private readonly store: ProjectStore) {}

  list(): Promise<Project[]> {
    return this.store.list();
  }

  async add(input: { name?: string; path: string; create?: boolean }): Promise<Project> {
    const requestedPath = expandUserPath(input.path);
    if (input.create === true) await mkdir(requestedPath, { recursive: true });
    const resolved = await realpath(requestedPath);
    const s = await stat(resolved);
    if (!s.isDirectory()) throw new Error("Project path must be a directory");
    return this.store.add(input.name === undefined ? { path: resolved } : { name: input.name, path: resolved });
  }

  async close(id: string): Promise<void> {
    if (!(await this.store.remove(id))) throw new ProjectNotFoundError();
  }

  /** Close a project and its registered descendants. The store owns the removal set. */
  async closeTree(id: string): Promise<{ closedProjectIds: string[] }> {
    const closedProjectIds = await this.store.removeTree(id);
    if (closedProjectIds === undefined) throw new ProjectNotFoundError();
    return { closedProjectIds };
  }

  listRecent(): Promise<RecentProjectEntry[]> {
    return this.store.listRecent();
  }

  /** Record meaningful user work. The store resolves the project and owns ordering. */
  async recordRecent(projectId: string): Promise<RecentProjectEntry[]> {
    const entries = await this.store.touchRecent(projectId);
    if (entries === undefined) throw new ProjectNotFoundError();
    return entries;
  }

  async removeRecent(entryId: string): Promise<RecentProjectEntry[]> {
    const removal = await this.store.removeRecent(entryId);
    if (removal.kind === "not-found") throw new ProjectNotFoundError();
    return removal.entries;
  }

  async requireProject(id: string): Promise<Project> {
    const project = await this.store.get(id);
    if (!project) throw new ProjectNotFoundError();
    return project;
  }

  async pin(id: string): Promise<Project[]> {
    return await this.setPinned(id, true);
  }

  async unpin(id: string): Promise<Project[]> {
    return await this.setPinned(id, false);
  }

  private async setPinned(id: string, pinned: boolean): Promise<Project[]> {
    const projects = await this.store.setPinned(id, pinned);
    if (projects === undefined) throw new ProjectNotFoundError();
    return projects;
  }
}
