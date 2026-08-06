import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { LearnedSkill } from "../../shared/apiTypes.js";
import {
  resolvePiHermesProjectName,
  type PiHermesProjectNameResolver,
} from "../piHermes/projectIdentity.js";
import type {
  LearnedSkillProvider,
  LearnedSkillProviderInput,
  LearnedSkillProviderResult,
} from "./learnedSkillProvider.js";
import { parseLearnedSkillDocument } from "./skillDocumentParser.js";

const PROJECT_UNAVAILABLE_MESSAGE = "Project-specific learned skills could not be loaded.";

export interface PiHermesLearnedSkillFileAccess {
  isDirectory(path: string): Promise<boolean>;
  listDirectories(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
}

export interface PiHermesLearnedSkillProviderDependencies {
  fileAccess?: PiHermesLearnedSkillFileAccess;
  resolveProjectName?: PiHermesProjectNameResolver;
}

const nodeFileAccess: PiHermesLearnedSkillFileAccess = {
  readFile: (path) => readFile(path, "utf-8"),
  isDirectory: async (path) => (await stat(path)).isDirectory(),
  listDirectories: async (path) => {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  },
};

export class PiHermesLearnedSkillProvider implements LearnedSkillProvider {
  readonly id = "pi-hermes-memory";

  private readonly fileAccess: PiHermesLearnedSkillFileAccess;
  private readonly resolveProjectName: PiHermesProjectNameResolver;

  constructor(
    private readonly agentDir: string,
    dependencies: PiHermesLearnedSkillProviderDependencies = {},
  ) {
    this.fileAccess = dependencies.fileAccess ?? nodeFileAccess;
    this.resolveProjectName =
      dependencies.resolveProjectName ??
      ((projectPath) => resolvePiHermesProjectName({ agentDir, projectPath }));
  }

  async read(input: LearnedSkillProviderInput): Promise<LearnedSkillProviderResult> {
    const globalSkillsRoot = join(this.agentDir, "pi-hermes-memory", "skills");
    const project = await this.projectScope(input.projectPath);
    const globalRootAvailable = await this.directoryExists(globalSkillsRoot);

    if (!globalRootAvailable && !project.rootAvailable) {
      if (project.probeError !== undefined) throw project.probeError;
      return { kind: "unavailable" };
    }

    const globalSkills = globalRootAvailable ? await this.listSkills(globalSkillsRoot) : [];
    if (input.projectPath === undefined) return { kind: "data", globalSkills, projectSkills: [] };

    if (project.unavailableMessage !== undefined) {
      return {
        kind: "data",
        globalSkills,
        projectSkills: [],
        projectUnavailableMessage: project.unavailableMessage,
      };
    }

    if (!project.rootAvailable || project.skillsRoot === undefined) {
      return { kind: "data", globalSkills, projectSkills: [] };
    }

    try {
      return {
        kind: "data",
        globalSkills,
        projectSkills: await this.listSkills(project.skillsRoot),
      };
    } catch {
      return {
        kind: "data",
        globalSkills,
        projectSkills: [],
        projectUnavailableMessage: PROJECT_UNAVAILABLE_MESSAGE,
      };
    }
  }

  private async projectScope(projectPath: string | undefined): Promise<ProjectScope> {
    if (projectPath === undefined) return { rootAvailable: false };

    try {
      const projectName = await this.resolveProjectName(projectPath);
      if (projectName === undefined || isUnsafeProjectName(projectName)) {
        return { rootAvailable: false, unavailableMessage: PROJECT_UNAVAILABLE_MESSAGE };
      }

      const skillsRoot = join(this.agentDir, "projects-memory", projectName, "skills");
      return {
        rootAvailable: await this.directoryExists(skillsRoot),
        skillsRoot,
      };
    } catch (error) {
      return {
        rootAvailable: false,
        unavailableMessage: PROJECT_UNAVAILABLE_MESSAGE,
        probeError: toError(error),
      };
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

  private async listSkills(rootPath: string): Promise<LearnedSkill[]> {
    const slugs = await this.fileAccess.listDirectories(rootPath);
    const skills = await Promise.all(
      slugs.map(async (slug) => {
        const skillPath = join(rootPath, slug, "SKILL.md");
        try {
          return parseLearnedSkillDocument({
            id: slug,
            filePath: skillPath,
            content: await this.fileAccess.readFile(skillPath),
          });
        } catch {
          return undefined;
        }
      }),
    );
    return skills.filter((skill): skill is LearnedSkill => skill !== undefined);
  }
}

interface ProjectScope {
  readonly rootAvailable: boolean;
  readonly skillsRoot?: string;
  readonly unavailableMessage?: string;
  readonly probeError?: Error;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isUnsafeProjectName(name: string): boolean {
  return name === "." || name === ".." || name.includes("/") || name.includes("\\");
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
