import { mkdir, realpath, stat } from "node:fs/promises";
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
