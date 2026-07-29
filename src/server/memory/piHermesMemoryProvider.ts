import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseMemoryFile } from "./memoryFileParser.js";
import type { MemoryProvider, MemoryProviderInput, MemoryProviderResult } from "./memoryProvider.js";

const PROJECT_UNAVAILABLE_MESSAGE = "Project-specific memory could not be loaded.";

interface MemoryFileAccess {
  readFile(path: string): Promise<string>;
  isDirectory(path: string): Promise<boolean>;
}

const nodeFileAccess: MemoryFileAccess = {
  readFile: (path) => readFile(path, "utf-8"),
  isDirectory: async (path) => (await stat(path)).isDirectory(),
};

export class PiHermesMemoryProvider implements MemoryProvider {
  readonly id = "pi-hermes-memory";

  constructor(
    private readonly agentDir: string,
    private readonly fileAccess: MemoryFileAccess = nodeFileAccess,
  ) {}

  async read(input: MemoryProviderInput): Promise<MemoryProviderResult> {
    const globalRootAvailable = await this.directoryExists(join(this.agentDir, "pi-hermes-memory"));
    const project = await this.projectScope(input.projectPath);

    if (!globalRootAvailable && !project.rootAvailable && project.unavailableMessage === undefined) {
      return { kind: "unavailable" };
    }

    const globalEntries = await this.globalEntries();
    if (input.projectPath === undefined) return { kind: "data", globalEntries, projectEntries: [] };

    if (project.unavailableMessage !== undefined || project.memoryFilePath === undefined) {
      return {
        kind: "data",
        globalEntries,
        projectEntries: [],
        projectUnavailableMessage: project.unavailableMessage ?? PROJECT_UNAVAILABLE_MESSAGE,
      };
    }

    try {
      return {
        kind: "data",
        globalEntries,
        projectEntries: await this.readOptionalEntries(project.memoryFilePath),
      };
    } catch {
      return {
        kind: "data",
        globalEntries,
        projectEntries: [],
        projectUnavailableMessage: PROJECT_UNAVAILABLE_MESSAGE,
      };
    }
  }

  private async globalEntries() {
    const memoryPath = join(this.agentDir, "pi-hermes-memory", "MEMORY.md");
    const failuresPath = join(this.agentDir, "pi-hermes-memory", "failures.md");
    return [...await this.readOptionalEntries(memoryPath), ...await this.readOptionalEntries(failuresPath)];
  }

  private async projectScope(projectPath: string | undefined): Promise<ProjectScope> {
    if (projectPath === undefined) return { rootAvailable: false };

    const projectName = basename(projectPath);
    if (isUnsafeProjectName(projectName)) {
      return { rootAvailable: false, unavailableMessage: PROJECT_UNAVAILABLE_MESSAGE };
    }

    const rootPath = join(this.agentDir, "projects-memory", projectName);
    try {
      return {
        rootAvailable: await this.directoryExists(rootPath),
        memoryFilePath: join(rootPath, "MEMORY.md"),
      };
    } catch {
      return { rootAvailable: false, unavailableMessage: PROJECT_UNAVAILABLE_MESSAGE };
    }
  }

  private async directoryExists(path: string): Promise<boolean> {
    try {
      return await this.fileAccess.isDirectory(path);
    } catch (error: unknown) {
      if (isEnoent(error)) return false;
      throw error;
    }
  }

  private async readOptionalEntries(path: string) {
    try {
      return parseMemoryFile(await this.fileAccess.readFile(path));
    } catch (error: unknown) {
      if (isEnoent(error)) return [];
      throw error;
    }
  }
}

interface ProjectScope {
  readonly rootAvailable: boolean;
  readonly memoryFilePath?: string;
  readonly unavailableMessage?: string;
}

function isUnsafeProjectName(name: string): boolean {
  return name === "." || name === ".." || name.includes("/") || name.includes("\\");
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
